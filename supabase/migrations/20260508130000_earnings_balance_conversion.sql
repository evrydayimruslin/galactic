-- PR28: Creator earnings must be converted before they become spendable balance.
-- balance_light is redefined as spendable deposit/converted Light only.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auto_add_earnings_to_balance boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.earnings_balance_conversions (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  amount_light double precision NOT NULL CHECK (amount_light > 0),
  source text NOT NULL DEFAULT 'manual',
  reference_table text,
  reference_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT earnings_balance_conversions_source_check CHECK (
    source IN ('manual', 'auto_earning', 'admin')
  )
);

CREATE INDEX IF NOT EXISTS earnings_balance_conversions_user_created_idx
  ON public.earnings_balance_conversions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS earnings_balance_conversions_reference_idx
  ON public.earnings_balance_conversions(reference_table, reference_id);

ALTER TABLE public.earnings_balance_conversions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earnings_balance_conversions FROM anon, authenticated;
GRANT SELECT ON TABLE public.earnings_balance_conversions TO authenticated;
GRANT ALL ON TABLE public.earnings_balance_conversions TO service_role;

DROP POLICY IF EXISTS earnings_balance_conversions_own_select
  ON public.earnings_balance_conversions;
CREATE POLICY earnings_balance_conversions_own_select
  ON public.earnings_balance_conversions
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.prevent_earnings_balance_conversions_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'earnings_balance_conversions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS prevent_earnings_balance_conversions_update
  ON public.earnings_balance_conversions;
CREATE TRIGGER prevent_earnings_balance_conversions_update
BEFORE UPDATE OR DELETE ON public.earnings_balance_conversions
FOR EACH ROW EXECUTE FUNCTION public.prevent_earnings_balance_conversions_mutation();

CREATE OR REPLACE FUNCTION public.sync_user_light_buckets()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance_delta double precision;
  v_escrow_delta double precision;
  v_remaining double precision;
  v_from_deposit double precision;
  v_bucket_changed boolean;
  v_escrow_bucket_changed boolean;
BEGIN
  NEW.deposit_balance_light := GREATEST(COALESCE(NEW.deposit_balance_light, 0), 0);
  NEW.earned_balance_light := GREATEST(COALESCE(NEW.earned_balance_light, 0), 0);
  NEW.escrow_deposit_light := GREATEST(COALESCE(NEW.escrow_deposit_light, 0), 0);
  NEW.escrow_earned_light := GREATEST(COALESCE(NEW.escrow_earned_light, 0), 0);
  NEW.balance_light := GREATEST(COALESCE(NEW.balance_light, 0), 0);
  NEW.escrow_light := GREATEST(COALESCE(NEW.escrow_light, 0), 0);

  IF TG_OP = 'INSERT' THEN
    IF NEW.deposit_balance_light + NEW.earned_balance_light = 0 AND NEW.balance_light > 0 THEN
      NEW.deposit_balance_light := NEW.balance_light;
      NEW.earned_balance_light := 0;
    END IF;

    IF NEW.escrow_deposit_light + NEW.escrow_earned_light = 0 AND NEW.escrow_light > 0 THEN
      NEW.escrow_deposit_light := NEW.escrow_light;
      NEW.escrow_earned_light := 0;
    END IF;

    NEW.balance_light := NEW.deposit_balance_light;
    NEW.escrow_light := NEW.escrow_deposit_light + NEW.escrow_earned_light;
    RETURN NEW;
  END IF;

  v_bucket_changed :=
    NEW.deposit_balance_light IS DISTINCT FROM OLD.deposit_balance_light
    OR NEW.earned_balance_light IS DISTINCT FROM OLD.earned_balance_light;

  IF NOT v_bucket_changed THEN
    NEW.deposit_balance_light := GREATEST(COALESCE(OLD.deposit_balance_light, 0), 0);
    NEW.earned_balance_light := GREATEST(COALESCE(OLD.earned_balance_light, 0), 0);
    v_balance_delta := NEW.balance_light - GREATEST(COALESCE(OLD.balance_light, 0), 0);

    IF v_balance_delta <> 0 THEN
      NEW.deposit_balance_light := GREATEST(NEW.deposit_balance_light + v_balance_delta, 0);
    END IF;
  END IF;

  v_escrow_bucket_changed :=
    NEW.escrow_deposit_light IS DISTINCT FROM OLD.escrow_deposit_light
    OR NEW.escrow_earned_light IS DISTINCT FROM OLD.escrow_earned_light;

  IF NOT v_escrow_bucket_changed THEN
    NEW.escrow_deposit_light := GREATEST(COALESCE(OLD.escrow_deposit_light, 0), 0);
    NEW.escrow_earned_light := GREATEST(COALESCE(OLD.escrow_earned_light, 0), 0);
    v_escrow_delta := NEW.escrow_light - GREATEST(COALESCE(OLD.escrow_light, 0), 0);

    IF v_escrow_delta > 0 THEN
      NEW.escrow_deposit_light := NEW.escrow_deposit_light + v_escrow_delta;
    ELSIF v_escrow_delta < 0 THEN
      v_remaining := ABS(v_escrow_delta);
      v_from_deposit := LEAST(NEW.escrow_deposit_light, v_remaining);
      NEW.escrow_deposit_light := NEW.escrow_deposit_light - v_from_deposit;
      v_remaining := v_remaining - v_from_deposit;
      NEW.escrow_earned_light := GREATEST(NEW.escrow_earned_light - v_remaining, 0);
    END IF;
  END IF;

  NEW.balance_light := NEW.deposit_balance_light;
  NEW.escrow_light := NEW.escrow_deposit_light + NEW.escrow_earned_light;
  RETURN NEW;
END;
$$;

UPDATE public.users
SET balance_light = GREATEST(COALESCE(deposit_balance_light, 0), 0);

CREATE OR REPLACE FUNCTION public.debit_spendable_light(
  p_user_id uuid,
  p_amount_light double precision,
  p_allow_partial boolean DEFAULT false
) RETURNS TABLE(
  deposit_debited double precision,
  earned_debited double precision,
  new_deposit_balance double precision,
  new_earned_balance double precision,
  new_balance double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
DECLARE
  v_user RECORD;
  v_amount_to_debit double precision;
  v_new_deposit double precision := 0;
BEGIN
  IF p_amount_light IS NULL OR p_amount_light <= 0 THEN
    RAISE EXCEPTION 'Debit amount must be positive';
  END IF;

  SELECT
    COALESCE(u.deposit_balance_light, 0) AS deposit_balance_light,
    COALESCE(u.earned_balance_light, 0) AS earned_balance_light
  INTO v_user
  FROM public.users u
  WHERE u.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  IF v_user.deposit_balance_light < p_amount_light THEN
    IF p_allow_partial THEN
      v_amount_to_debit := v_user.deposit_balance_light;
    ELSE
      RAISE EXCEPTION 'Insufficient available balance. Available: % Light, requested: %',
        v_user.deposit_balance_light, p_amount_light;
    END IF;
  ELSE
    v_amount_to_debit := p_amount_light;
  END IF;

  v_new_deposit := v_user.deposit_balance_light - v_amount_to_debit;

  UPDATE public.users
  SET
    deposit_balance_light = v_new_deposit,
    balance_light = v_new_deposit
  WHERE id = p_user_id;

  RETURN QUERY SELECT
    v_amount_to_debit,
    0::double precision,
    v_new_deposit,
    v_user.earned_balance_light,
    v_new_deposit;
END;
$$;

CREATE OR REPLACE FUNCTION public.credit_balance(
  p_user_id uuid,
  p_amount_light double precision
) RETURNS TABLE(old_balance double precision, new_balance double precision)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
DECLARE
  v_old_balance double precision;
  v_new_balance double precision;
BEGIN
  IF p_amount_light IS NULL OR p_amount_light <= 0 THEN
    RAISE EXCEPTION 'Credit amount must be positive';
  END IF;

  SELECT COALESCE(balance_light, 0) INTO v_old_balance
  FROM public.users
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  UPDATE public.users
  SET
    deposit_balance_light = deposit_balance_light + p_amount_light,
    balance_light = deposit_balance_light + p_amount_light
  WHERE id = p_user_id
  RETURNING balance_light INTO v_new_balance;

  PERFORM public.record_light_ledger_entry(
    p_user_id,
    NULL,
    NULL,
    'deposit',
    'deposit_credit',
    p_amount_light,
    'users',
    p_user_id,
    jsonb_build_object('source', 'credit_balance')
  );

  RETURN QUERY SELECT v_old_balance, v_new_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.convert_earnings_to_deposit(
  p_user_id uuid,
  p_amount_light double precision,
  p_source text DEFAULT 'manual',
  p_reference_table text DEFAULT NULL::text,
  p_reference_id uuid DEFAULT NULL::uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE(
  conversion_id uuid,
  converted_light double precision,
  deposit_balance_light double precision,
  earned_balance_light double precision,
  balance_light double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
DECLARE
  v_user RECORD;
  v_amount double precision;
  v_conversion_id uuid;
  v_deposit_balance double precision;
  v_earned_balance double precision;
  v_balance double precision;
  v_billing_version integer := 1;
BEGIN
  IF p_amount_light IS NULL OR p_amount_light <= 0 THEN
    RAISE EXCEPTION 'Conversion amount must be positive';
  END IF;

  IF COALESCE(p_source, '') NOT IN ('manual', 'auto_earning', 'admin') THEN
    RAISE EXCEPTION 'Invalid earnings conversion source';
  END IF;

  SELECT
    COALESCE(u.deposit_balance_light, 0) AS deposit_balance_light,
    COALESCE(u.earned_balance_light, 0) AS earned_balance_light
  INTO v_user
  FROM public.users AS u
  WHERE u.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  IF v_user.earned_balance_light + 0.000000001 < p_amount_light THEN
    RAISE EXCEPTION 'Conversion exceeds earnings. Convertible: % Light, requested: %',
      v_user.earned_balance_light, p_amount_light;
  END IF;

  v_amount := LEAST(p_amount_light, v_user.earned_balance_light);

  UPDATE public.users AS u
  SET
    earned_balance_light = u.earned_balance_light - v_amount,
    deposit_balance_light = u.deposit_balance_light + v_amount,
    balance_light = u.deposit_balance_light + v_amount
  WHERE u.id = p_user_id
  RETURNING
    u.deposit_balance_light,
    u.earned_balance_light,
    u.balance_light
  INTO v_deposit_balance, v_earned_balance, v_balance;

  INSERT INTO public.earnings_balance_conversions (
    user_id,
    amount_light,
    source,
    reference_table,
    reference_id,
    metadata
  ) VALUES (
    p_user_id,
    v_amount,
    COALESCE(p_source, 'manual'),
    p_reference_table,
    p_reference_id,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_conversion_id;

  PERFORM public.record_light_ledger_entry(
    p_user_id,
    NULL,
    NULL,
    'earned',
    'earnings_conversion',
    -v_amount,
    'earnings_balance_conversions',
    v_conversion_id,
    COALESCE(p_metadata, '{}'::jsonb)
      || jsonb_build_object('source', COALESCE(p_source, 'manual'))
  );

  PERFORM public.record_light_ledger_entry(
    p_user_id,
    NULL,
    NULL,
    'deposit',
    'earnings_conversion',
    v_amount,
    'earnings_balance_conversions',
    v_conversion_id,
    COALESCE(p_metadata, '{}'::jsonb)
      || jsonb_build_object('source', COALESCE(p_source, 'manual'))
  );

  SELECT COALESCE(version, 1) INTO v_billing_version
  FROM public.platform_billing_config
  WHERE id = 'singleton';

  INSERT INTO public.billing_transactions (
    user_id,
    type,
    category,
    description,
    amount_cents,
    amount_light,
    balance_after_light,
    billing_config_version,
    light_per_usd_snapshot,
    metadata
  ) VALUES (
    p_user_id,
    'credit',
    'earnings_conversion',
    'Creator earnings added to balance',
    0,
    v_amount,
    v_balance,
    COALESCE(v_billing_version, 1),
    100,
    jsonb_build_object(
      'earnings_balance_conversion_id', v_conversion_id,
      'source', COALESCE(p_source, 'manual'),
      'reference_table', p_reference_table,
      'reference_id', p_reference_id
    ) || COALESCE(p_metadata, '{}'::jsonb)
  );

  RETURN QUERY SELECT
    v_conversion_id,
    v_amount,
    v_deposit_balance,
    v_earned_balance,
    v_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.credit_creator_earning(
  p_user_id uuid,
  p_amount_light double precision,
  p_kind text,
  p_reference_table text DEFAULT NULL::text,
  p_reference_id uuid DEFAULT NULL::uuid,
  p_counterparty_user_id uuid DEFAULT NULL::uuid,
  p_app_id uuid DEFAULT NULL::uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE(
  new_balance double precision,
  new_deposit_balance double precision,
  new_earned_balance double precision,
  auto_converted boolean,
  conversion_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
DECLARE
  v_user RECORD;
  v_balance double precision;
  v_deposit_balance double precision;
  v_earned_balance double precision;
  v_conversion RECORD;
BEGIN
  IF p_amount_light IS NULL OR p_amount_light <= 0 THEN
    RAISE EXCEPTION 'Creator earning amount must be positive';
  END IF;

  IF p_kind IS NULL OR btrim(p_kind) = '' THEN
    RAISE EXCEPTION 'Creator earning ledger kind is required';
  END IF;

  SELECT COALESCE(auto_add_earnings_to_balance, false) AS auto_add
  INTO v_user
  FROM public.users
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  UPDATE public.users
  SET
    earned_balance_light = earned_balance_light + p_amount_light,
    total_earned_light = total_earned_light + p_amount_light,
    balance_light = deposit_balance_light
  WHERE id = p_user_id
  RETURNING
    public.users.balance_light,
    public.users.deposit_balance_light,
    public.users.earned_balance_light
  INTO v_balance, v_deposit_balance, v_earned_balance;

  PERFORM public.record_light_ledger_entry(
    p_user_id,
    p_counterparty_user_id,
    p_app_id,
    'earned',
    p_kind,
    p_amount_light,
    p_reference_table,
    p_reference_id,
    COALESCE(p_metadata, '{}'::jsonb)
      || jsonb_build_object('auto_add_earnings_to_balance', v_user.auto_add)
  );

  IF v_user.auto_add THEN
    SELECT * INTO v_conversion
    FROM public.convert_earnings_to_deposit(
      p_user_id,
      p_amount_light,
      'auto_earning',
      p_reference_table,
      p_reference_id,
      COALESCE(p_metadata, '{}'::jsonb)
        || jsonb_build_object('earning_kind', p_kind)
    );

    RETURN QUERY SELECT
      v_conversion.balance_light,
      v_conversion.deposit_balance_light,
      v_conversion.earned_balance_light,
      true,
      v_conversion.conversion_id;
  ELSE
    RETURN QUERY SELECT
      v_balance,
      v_deposit_balance,
      v_earned_balance,
      false,
      NULL::uuid;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.transfer_balance(
  p_from_user uuid,
  p_to_user uuid,
  p_amount_light double precision
) RETURNS TABLE(from_new_balance double precision, to_new_balance double precision, platform_fee double precision)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
  SELECT from_new_balance, to_new_balance, platform_fee
  FROM public.transfer_light(
    p_from_user,
    p_to_user,
    p_amount_light,
    'transfer',
    NULL::uuid,
    NULL::text,
    NULL::uuid,
    '{}'::jsonb
  );
$$;

CREATE OR REPLACE FUNCTION public.transfer_light(
  p_from_user uuid,
  p_to_user uuid,
  p_amount_light double precision,
  p_reason text,
  p_app_id uuid DEFAULT NULL::uuid,
  p_function_name text DEFAULT NULL::text,
  p_content_id uuid DEFAULT NULL::uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE(
  from_new_balance double precision,
  to_new_balance double precision,
  platform_fee double precision,
  transfer_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
DECLARE
  v_fee_rate double precision := 0.10;
  v_fee double precision;
  v_net double precision;
  v_from_available double precision;
  v_debit RECORD;
  v_credit RECORD;
  v_transfer_id uuid;
  v_metadata jsonb;
BEGIN
  IF p_amount_light IS NULL OR p_amount_light <= 0 THEN
    RAISE EXCEPTION 'Transfer amount must be positive';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Transfer reason is required';
  END IF;

  IF p_from_user = p_to_user THEN
    RAISE EXCEPTION 'Cannot transfer Light to the same account';
  END IF;

  SELECT COALESCE(balance_light, 0) INTO v_from_available
  FROM public.users
  WHERE id = p_from_user
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sender not found';
  END IF;

  IF v_from_available < p_amount_light THEN
    RETURN;
  END IF;

  SELECT COALESCE(platform_fee_rate, 0.10) INTO v_fee_rate
  FROM public.platform_billing_config
  WHERE id = 'singleton';

  v_fee := p_amount_light * COALESCE(v_fee_rate, 0.10);
  v_net := p_amount_light - v_fee;

  SELECT * INTO v_debit
  FROM public.debit_spendable_light(p_from_user, p_amount_light, false);

  INSERT INTO public.transfers (
    from_user_id,
    to_user_id,
    amount_cents,
    amount_light,
    reason,
    app_id,
    function_name,
    content_id
  )
  VALUES (
    p_from_user,
    p_to_user,
    round(v_net)::double precision,
    v_net,
    p_reason,
    p_app_id,
    p_function_name,
    p_content_id
  )
  RETURNING id INTO v_transfer_id;

  v_metadata := COALESCE(p_metadata, '{}'::jsonb)
    || jsonb_build_object(
      'gross_light', p_amount_light,
      'net_light', v_net,
      'platform_fee_light', v_fee,
      'function_name', p_function_name,
      'content_id', p_content_id
    );

  PERFORM public.record_light_ledger_entry(
    p_from_user,
    p_to_user,
    p_app_id,
    'deposit',
    p_reason || '_debit',
    -v_debit.deposit_debited,
    'transfers',
    v_transfer_id,
    v_metadata
  );
  PERFORM public.record_light_ledger_entry(
    p_from_user,
    p_to_user,
    p_app_id,
    'earned',
    p_reason || '_debit',
    -v_debit.earned_debited,
    'transfers',
    v_transfer_id,
    v_metadata
  );

  SELECT * INTO v_credit
  FROM public.credit_creator_earning(
    p_to_user,
    v_net,
    p_reason || '_earning',
    'transfers',
    v_transfer_id,
    p_from_user,
    p_app_id,
    v_metadata
  );

  PERFORM public.record_light_ledger_entry(
    NULL,
    p_from_user,
    p_app_id,
    'platform',
    'platform_fee',
    v_fee,
    'transfers',
    v_transfer_id,
    v_metadata
  );

  RETURN QUERY SELECT v_debit.new_balance, v_credit.new_balance, v_fee, v_transfer_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_marketplace_sale(
  p_seller_id uuid,
  p_buyer_id uuid,
  p_app_id uuid,
  p_sale_price_light double precision,
  p_bid_id uuid,
  p_sale_method text,
  p_debit_source text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
DECLARE
  v_app RECORD;
  v_seller_email text;
  v_fee_rate double precision := 0.10;
  v_fee double precision;
  v_payout double precision;
  v_sale_id uuid;
  v_slug_exists boolean;
  v_new_slug text;
  v_other_bid RECORD;
  v_provenance jsonb;
  v_sale_bid RECORD;
  v_buyer_deposit_used double precision := 0;
  v_buyer_earned_used double precision := 0;
  v_debit RECORD;
  v_refund_deposit double precision;
  v_refund_earned double precision;
  v_credit RECORD;
  v_metadata jsonb;
BEGIN
  IF p_sale_price_light IS NULL OR p_sale_price_light <= 0 THEN
    RAISE EXCEPTION 'Sale price must be positive';
  END IF;

  IF p_debit_source NOT IN ('balance', 'escrow') THEN
    RAISE EXCEPTION 'Invalid debit source';
  END IF;

  IF p_buyer_id = p_seller_id THEN
    RAISE EXCEPTION 'Cannot buy your own app';
  END IF;

  SELECT * INTO v_app
  FROM public.apps
  WHERE id = p_app_id
  FOR UPDATE;

  IF v_app IS NULL THEN
    RAISE EXCEPTION 'App not found';
  END IF;

  IF v_app.owner_id != p_seller_id THEN
    RAISE EXCEPTION 'Only the app owner can complete this sale';
  END IF;

  IF COALESCE(v_app.had_external_db, false) THEN
    RAISE EXCEPTION 'This app is permanently ineligible for trading because it has used an external database.';
  END IF;

  SELECT email INTO v_seller_email
  FROM public.users
  WHERE id = p_seller_id;

  IF v_seller_email IS NULL THEN
    RAISE EXCEPTION 'Seller not found';
  END IF;

  SELECT COALESCE(platform_fee_rate, 0.10) INTO v_fee_rate
  FROM public.platform_billing_config
  WHERE id = 'singleton';

  v_fee := p_sale_price_light * COALESCE(v_fee_rate, 0.10);
  v_payout := p_sale_price_light - v_fee;

  IF p_debit_source = 'escrow' THEN
    IF p_bid_id IS NULL THEN
      RAISE EXCEPTION 'Bid id required for escrow sale';
    END IF;

    SELECT * INTO v_sale_bid
    FROM public.app_bids
    WHERE id = p_bid_id
    FOR UPDATE;

    IF v_sale_bid IS NULL THEN
      RAISE EXCEPTION 'Bid not found';
    END IF;

    v_buyer_deposit_used := COALESCE(v_sale_bid.escrow_deposit_light, 0);
    v_buyer_earned_used := COALESCE(v_sale_bid.escrow_earned_light, 0);
    IF v_buyer_deposit_used + v_buyer_earned_used <= 0 THEN
      v_buyer_deposit_used := p_sale_price_light;
      v_buyer_earned_used := 0;
    END IF;

    IF ABS((v_buyer_deposit_used + v_buyer_earned_used) - p_sale_price_light) > 0.000001 THEN
      RAISE EXCEPTION 'Escrow source buckets do not match sale price';
    END IF;

    UPDATE public.users
    SET
      escrow_deposit_light = escrow_deposit_light - v_buyer_deposit_used,
      escrow_earned_light = escrow_earned_light - v_buyer_earned_used,
      escrow_light = escrow_deposit_light + escrow_earned_light - p_sale_price_light
    WHERE id = p_buyer_id
      AND escrow_deposit_light >= v_buyer_deposit_used
      AND escrow_earned_light >= v_buyer_earned_used;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Insufficient balance or escrow for purchase';
    END IF;
  ELSE
    SELECT * INTO v_debit
    FROM public.debit_spendable_light(p_buyer_id, p_sale_price_light, false);
    v_buyer_deposit_used := v_debit.deposit_debited;
    v_buyer_earned_used := v_debit.earned_debited;
  END IF;

  SELECT EXISTS(
    SELECT 1
    FROM public.apps
    WHERE owner_id = p_buyer_id
      AND slug = v_app.slug
      AND id != v_app.id
  ) INTO v_slug_exists;

  IF v_slug_exists THEN
    v_new_slug := v_app.slug || '-acquired';
    WHILE EXISTS(
      SELECT 1
      FROM public.apps
      WHERE owner_id = p_buyer_id
        AND slug = v_new_slug
        AND id != v_app.id
    ) LOOP
      v_new_slug := v_app.slug || '-acquired-' || substr(extensions.gen_random_uuid()::text, 1, 4);
    END LOOP;

    UPDATE public.apps
    SET owner_id = p_buyer_id,
        slug = v_new_slug,
        updated_at = now()
    WHERE id = v_app.id;
  ELSE
    UPDATE public.apps
    SET owner_id = p_buyer_id,
        updated_at = now()
    WHERE id = v_app.id;
  END IF;

  DELETE FROM public.user_app_permissions
  WHERE app_id = v_app.id;

  DELETE FROM public.user_app_secrets
  WHERE app_id = v_app.id;

  IF p_bid_id IS NOT NULL THEN
    UPDATE public.app_bids
    SET status = 'accepted',
        escrow_status = 'released',
        resolved_at = now()
    WHERE id = p_bid_id;
  END IF;

  FOR v_other_bid IN
    SELECT *
    FROM public.app_bids
    WHERE app_id = v_app.id
      AND status = 'active'
      AND (p_bid_id IS NULL OR id != p_bid_id)
    FOR UPDATE
  LOOP
    v_refund_deposit := COALESCE(v_other_bid.escrow_deposit_light, 0);
    v_refund_earned := COALESCE(v_other_bid.escrow_earned_light, 0);
    IF v_refund_deposit + v_refund_earned <= 0 THEN
      v_refund_deposit := COALESCE(v_other_bid.amount_light, v_other_bid.amount_cents::double precision);
      v_refund_earned := 0;
    END IF;

    UPDATE public.users
    SET
      deposit_balance_light = deposit_balance_light + v_refund_deposit,
      earned_balance_light = earned_balance_light + v_refund_earned,
      escrow_deposit_light = escrow_deposit_light - v_refund_deposit,
      escrow_earned_light = escrow_earned_light - v_refund_earned,
      balance_light = deposit_balance_light + v_refund_deposit,
      escrow_light = escrow_deposit_light + escrow_earned_light - v_refund_deposit - v_refund_earned
    WHERE id = v_other_bid.bidder_id
      AND escrow_deposit_light >= v_refund_deposit
      AND escrow_earned_light >= v_refund_earned;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Escrow invariant violation while refunding competing bid %', v_other_bid.id;
    END IF;

    UPDATE public.app_bids
    SET status = 'rejected',
        escrow_status = 'refunded',
        resolved_at = now()
    WHERE id = v_other_bid.id;

    PERFORM public.record_light_ledger_entry(v_other_bid.bidder_id, p_seller_id, v_app.id, 'escrow_deposit', 'escrow_refund', -v_refund_deposit, 'app_bids', v_other_bid.id);
    PERFORM public.record_light_ledger_entry(v_other_bid.bidder_id, p_seller_id, v_app.id, 'escrow_earned', 'escrow_refund', -v_refund_earned, 'app_bids', v_other_bid.id);
    PERFORM public.record_light_ledger_entry(v_other_bid.bidder_id, p_seller_id, v_app.id, 'deposit', 'escrow_refund', v_refund_deposit, 'app_bids', v_other_bid.id);
    PERFORM public.record_light_ledger_entry(v_other_bid.bidder_id, p_seller_id, v_app.id, 'earned', 'escrow_refund', v_refund_earned, 'app_bids', v_other_bid.id);
  END LOOP;

  INSERT INTO public.app_listings (app_id, owner_id, status, provenance)
  VALUES (v_app.id, p_seller_id, 'active', '[]'::jsonb)
  ON CONFLICT (app_id) DO NOTHING;

  SELECT COALESCE(provenance, '[]'::jsonb) INTO v_provenance
  FROM public.app_listings
  WHERE app_id = v_app.id
  FOR UPDATE;

  v_provenance := v_provenance || jsonb_build_array(jsonb_build_object(
    'owner_id', p_seller_id,
    'email', v_seller_email,
    'acquired_at', now(),
    'price_light', p_sale_price_light,
    'method', p_sale_method
  ));

  UPDATE public.app_listings
  SET owner_id = p_buyer_id,
      status = 'sold',
      provenance = v_provenance,
      updated_at = now()
  WHERE app_id = v_app.id;

  INSERT INTO public.app_sales (
    app_id,
    seller_id,
    buyer_id,
    sale_price_cents,
    platform_fee_cents,
    seller_payout_cents,
    sale_price_light,
    platform_fee_light,
    seller_payout_light,
    bid_id
  )
  VALUES (
    v_app.id,
    p_seller_id,
    p_buyer_id,
    round(p_sale_price_light)::integer,
    round(v_fee)::integer,
    round(v_payout)::integer,
    p_sale_price_light,
    v_fee,
    v_payout,
    p_bid_id
  )
  RETURNING id INTO v_sale_id;

  INSERT INTO public.transfers (
    from_user_id,
    to_user_id,
    amount_cents,
    amount_light,
    reason,
    app_id
  )
  VALUES (
    p_buyer_id,
    p_seller_id,
    round(v_payout)::double precision,
    v_payout,
    'marketplace_sale',
    v_app.id
  );

  v_metadata := jsonb_build_object(
    'sale_price_light', p_sale_price_light,
    'platform_fee_light', v_fee,
    'seller_payout_light', v_payout,
    'sale_method', p_sale_method,
    'debit_source', p_debit_source
  );

  SELECT * INTO v_credit
  FROM public.credit_creator_earning(
    p_seller_id,
    v_payout,
    'marketplace_sale_earning',
    'app_sales',
    v_sale_id,
    p_buyer_id,
    v_app.id,
    v_metadata
  );

  IF p_debit_source = 'escrow' THEN
    PERFORM public.record_light_ledger_entry(p_buyer_id, p_seller_id, v_app.id, 'escrow_deposit', 'marketplace_sale_debit', -v_buyer_deposit_used, 'app_sales', v_sale_id);
    PERFORM public.record_light_ledger_entry(p_buyer_id, p_seller_id, v_app.id, 'escrow_earned', 'marketplace_sale_debit', -v_buyer_earned_used, 'app_sales', v_sale_id);
  ELSE
    PERFORM public.record_light_ledger_entry(p_buyer_id, p_seller_id, v_app.id, 'deposit', 'marketplace_sale_debit', -v_buyer_deposit_used, 'app_sales', v_sale_id);
    PERFORM public.record_light_ledger_entry(p_buyer_id, p_seller_id, v_app.id, 'earned', 'marketplace_sale_debit', -v_buyer_earned_used, 'app_sales', v_sale_id);
  END IF;
  PERFORM public.record_light_ledger_entry(NULL, p_buyer_id, v_app.id, 'platform', 'platform_fee', v_fee, 'app_sales', v_sale_id);

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'app_id', v_app.id,
    'seller_id', p_seller_id,
    'buyer_id', p_buyer_id,
    'sale_price_light', p_sale_price_light,
    'platform_fee_light', v_fee,
    'seller_payout_light', v_payout,
    'seller_auto_converted', v_credit.auto_converted,
    'seller_conversion_id', v_credit.conversion_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_payout_refund(
  p_payout_id uuid,
  p_failure_reason text DEFAULT NULL::text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
DECLARE
  v_payout RECORD;
BEGIN
  SELECT * INTO v_payout
  FROM public.payouts
  WHERE id = p_payout_id
  FOR UPDATE;

  IF v_payout IS NULL THEN
    RAISE EXCEPTION 'Payout not found';
  END IF;

  IF v_payout.status NOT IN ('held', 'pending', 'processing') THEN
    RAISE EXCEPTION 'Payout already finalized with status: %', v_payout.status;
  END IF;

  UPDATE public.users
  SET
    earned_balance_light = earned_balance_light + v_payout.amount_light,
    balance_light = deposit_balance_light
  WHERE id = v_payout.user_id;

  UPDATE public.payouts
  SET
    status = 'failed',
    failure_reason = p_failure_reason,
    completed_at = now(),
    processor_claimed_at = NULL,
    stripe_transfer_status = CASE
      WHEN stripe_transfer_id IS NULL THEN 'failed'
      ELSE COALESCE(stripe_transfer_status, 'succeeded')
    END,
    stripe_payout_status = CASE
      WHEN stripe_payout_id IS NULL THEN COALESCE(stripe_payout_status, 'failed')
      ELSE 'failed'
    END,
    stripe_transfer_error = CASE
      WHEN stripe_transfer_id IS NULL
        THEN jsonb_build_object('reason', COALESCE(p_failure_reason, 'payout_failed'))
      ELSE stripe_transfer_error
    END,
    stripe_payout_error = jsonb_build_object('reason', COALESCE(p_failure_reason, 'payout_failed'))
  WHERE id = p_payout_id;

  INSERT INTO public.transfers (
    id,
    from_user_id,
    to_user_id,
    amount_cents,
    amount_light,
    reason,
    created_at
  )
  VALUES (
    extensions.gen_random_uuid(),
    v_payout.user_id,
    v_payout.user_id,
    round(v_payout.amount_light)::double precision,
    v_payout.amount_light,
    'withdrawal_refund',
    now()
  );

  PERFORM public.record_light_ledger_entry(
    v_payout.user_id,
    NULL,
    NULL,
    'earned',
    'payout_refund',
    v_payout.amount_light,
    'payouts',
    p_payout_id,
    jsonb_build_object('failure_reason', p_failure_reason)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.convert_earnings_to_deposit(
  uuid,
  double precision,
  text,
  text,
  uuid,
  jsonb
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.credit_creator_earning(
  uuid,
  double precision,
  text,
  text,
  uuid,
  uuid,
  uuid,
  jsonb
) FROM PUBLIC, anon, authenticated;

GRANT ALL ON FUNCTION public.convert_earnings_to_deposit(
  uuid,
  double precision,
  text,
  text,
  uuid,
  jsonb
) TO service_role;

GRANT ALL ON FUNCTION public.credit_creator_earning(
  uuid,
  double precision,
  text,
  text,
  uuid,
  uuid,
  uuid,
  jsonb
) TO service_role;
