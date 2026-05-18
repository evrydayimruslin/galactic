-- Apply publisher fee waivers to creator-revenue settlements.
--
-- Referral grants waive the full platform fee for active payer -> publisher
-- windows. Publisher fee-waiver credit can then cover some or all of the fee
-- when no active referral grant applies. The payer's gross charge is unchanged.

ALTER TABLE public.platform_billing_config
  ALTER COLUMN platform_fee_rate SET DEFAULT 0.15;

UPDATE public.platform_billing_config
SET platform_fee_rate = 0.15
WHERE id = 'singleton'
  AND platform_fee_rate = 0.10;

DROP FUNCTION IF EXISTS public.transfer_light(
  uuid,
  uuid,
  double precision,
  text,
  uuid,
  text,
  uuid,
  jsonb
);

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
  transfer_id uuid,
  fee_would_have_been double precision,
  fee_waived double precision,
  waiver_source text,
  waiver_event_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
DECLARE
  v_fee_rate double precision := 0.15;
  v_fee_would_have_been double precision;
  v_fee_waived double precision := 0;
  v_platform_fee_charged double precision;
  v_net double precision;
  v_from_available double precision;
  v_debit RECORD;
  v_credit RECORD;
  v_transfer_id uuid;
  v_metadata jsonb;
  v_transaction_kind text;
  v_waiver_source text;
  v_waiver_grant_id uuid;
  v_fee_credit_available double precision := 0;
  v_fee_credit_locked boolean := false;
  v_fee_credit_balance_after double precision;
  v_fee_credit_ledger_id uuid;
  v_waiver_event_id uuid;
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

  SELECT COALESCE(platform_fee_rate, 0.15) INTO v_fee_rate
  FROM public.platform_billing_config
  WHERE id = 'singleton';

  v_fee_would_have_been := p_amount_light * COALESCE(v_fee_rate, 0.15);

  v_transaction_kind := CASE
    WHEN p_reason = 'gpu_call' THEN 'gpu_developer_fee'
    WHEN p_reason IN ('tool_call', 'tool_call_suspended') THEN 'tool_call'
    ELSE NULL
  END;

  IF v_transaction_kind IS NOT NULL AND v_fee_would_have_been > 0 THEN
    SELECT id INTO v_waiver_grant_id
    FROM public.publisher_fee_waiver_grants
    WHERE user_id = p_from_user
      AND publisher_user_id = p_to_user
      AND source = 'referral'
      AND starts_at <= now()
      AND expires_at > now()
    ORDER BY starts_at ASC
    LIMIT 1;

    IF v_waiver_grant_id IS NOT NULL THEN
      v_fee_waived := v_fee_would_have_been;
      v_waiver_source := 'referral_grant';
    ELSE
      SELECT COALESCE(balance_light, 0) INTO v_fee_credit_available
      FROM public.publisher_fee_credit_accounts
      WHERE publisher_user_id = p_to_user
      FOR UPDATE;
      v_fee_credit_locked := FOUND;

      IF v_fee_credit_locked AND v_fee_credit_available > 0 THEN
        v_fee_waived := LEAST(v_fee_would_have_been, v_fee_credit_available);
        v_waiver_source := 'publisher_fee_credit';
      END IF;
    END IF;
  END IF;

  v_platform_fee_charged := v_fee_would_have_been - v_fee_waived;
  v_net := p_amount_light - v_platform_fee_charged;

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

  IF v_waiver_source = 'publisher_fee_credit' AND v_fee_waived > 0 THEN
    UPDATE public.publisher_fee_credit_accounts
    SET balance_light = balance_light - v_fee_waived,
        lifetime_spent_light = lifetime_spent_light + v_fee_waived,
        updated_at = now()
    WHERE publisher_user_id = p_to_user
    RETURNING balance_light INTO v_fee_credit_balance_after;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Fee credit account disappeared during transfer settlement';
    END IF;

    INSERT INTO public.publisher_fee_credit_ledger (
      publisher_user_id,
      amount_light,
      balance_after_light,
      kind,
      reason,
      reference_table,
      reference_id,
      metadata
    )
    VALUES (
      p_to_user,
      -v_fee_waived,
      v_fee_credit_balance_after,
      'spend',
      'platform_fee_waiver',
      'transfers',
      v_transfer_id,
      jsonb_build_object(
        'payer_user_id', p_from_user,
        'gross_light', p_amount_light,
        'fee_would_have_been_light', v_fee_would_have_been,
        'platform_fee_charged_light', v_platform_fee_charged,
        'reason', p_reason
      )
    )
    RETURNING id INTO v_fee_credit_ledger_id;
  END IF;

  v_metadata := COALESCE(p_metadata, '{}'::jsonb)
    || jsonb_build_object(
      'gross_light', p_amount_light,
      'net_light', v_net,
      'platform_fee_light', v_platform_fee_charged,
      'fee_would_have_been_light', v_fee_would_have_been,
      'fee_waived_light', v_fee_waived,
      'waiver_source', v_waiver_source,
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
    v_platform_fee_charged,
    'transfers',
    v_transfer_id,
    v_metadata
  );

  IF v_waiver_source IS NOT NULL AND v_fee_waived > 0 THEN
    INSERT INTO public.platform_fee_waiver_events (
      payer_user_id,
      publisher_user_id,
      app_id,
      transaction_kind,
      transaction_reference_table,
      transaction_reference_id,
      gross_light,
      fee_rate,
      fee_would_have_been_light,
      fee_waived_light,
      platform_fee_charged_light,
      waiver_source,
      waiver_grant_id,
      fee_credit_ledger_id,
      metadata
    )
    VALUES (
      p_from_user,
      p_to_user,
      p_app_id,
      v_transaction_kind,
      'transfers',
      v_transfer_id,
      p_amount_light,
      COALESCE(v_fee_rate, 0.15),
      v_fee_would_have_been,
      v_fee_waived,
      v_platform_fee_charged,
      v_waiver_source,
      v_waiver_grant_id,
      v_fee_credit_ledger_id,
      v_metadata || jsonb_build_object('reason', p_reason)
    )
    RETURNING id INTO v_waiver_event_id;
  END IF;

  RETURN QUERY SELECT
    v_debit.new_balance,
    v_credit.new_balance,
    v_platform_fee_charged,
    v_transfer_id,
    v_fee_would_have_been,
    v_fee_waived,
    v_waiver_source,
    v_waiver_event_id;
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
  v_fee_rate double precision := 0.15;
  v_fee_would_have_been double precision;
  v_fee_waived double precision := 0;
  v_platform_fee_charged double precision;
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
  v_waiver_source text;
  v_waiver_grant_id uuid;
  v_fee_credit_available double precision := 0;
  v_fee_credit_locked boolean := false;
  v_fee_credit_balance_after double precision;
  v_fee_credit_ledger_id uuid;
  v_waiver_event_id uuid;
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

  SELECT COALESCE(platform_fee_rate, 0.15) INTO v_fee_rate
  FROM public.platform_billing_config
  WHERE id = 'singleton';

  v_fee_would_have_been := p_sale_price_light * COALESCE(v_fee_rate, 0.15);

  IF v_fee_would_have_been > 0 THEN
    SELECT id INTO v_waiver_grant_id
    FROM public.publisher_fee_waiver_grants
    WHERE user_id = p_buyer_id
      AND publisher_user_id = p_seller_id
      AND source = 'referral'
      AND starts_at <= now()
      AND expires_at > now()
    ORDER BY starts_at ASC
    LIMIT 1;

    IF v_waiver_grant_id IS NOT NULL THEN
      v_fee_waived := v_fee_would_have_been;
      v_waiver_source := 'referral_grant';
    ELSE
      SELECT COALESCE(balance_light, 0) INTO v_fee_credit_available
      FROM public.publisher_fee_credit_accounts
      WHERE publisher_user_id = p_seller_id
      FOR UPDATE;
      v_fee_credit_locked := FOUND;

      IF v_fee_credit_locked AND v_fee_credit_available > 0 THEN
        v_fee_waived := LEAST(v_fee_would_have_been, v_fee_credit_available);
        v_waiver_source := 'publisher_fee_credit';
      END IF;
    END IF;
  END IF;

  v_platform_fee_charged := v_fee_would_have_been - v_fee_waived;
  v_payout := p_sale_price_light - v_platform_fee_charged;

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

  UPDATE public.publisher_referral_links
  SET status = 'disabled',
      disabled_at = now()
  WHERE app_id = v_app.id
    AND status = 'active';

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
    round(v_platform_fee_charged)::integer,
    round(v_payout)::integer,
    p_sale_price_light,
    v_platform_fee_charged,
    v_payout,
    p_bid_id
  )
  RETURNING id INTO v_sale_id;

  IF v_waiver_source = 'publisher_fee_credit' AND v_fee_waived > 0 THEN
    UPDATE public.publisher_fee_credit_accounts
    SET balance_light = balance_light - v_fee_waived,
        lifetime_spent_light = lifetime_spent_light + v_fee_waived,
        updated_at = now()
    WHERE publisher_user_id = p_seller_id
    RETURNING balance_light INTO v_fee_credit_balance_after;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Fee credit account disappeared during marketplace settlement';
    END IF;

    INSERT INTO public.publisher_fee_credit_ledger (
      publisher_user_id,
      amount_light,
      balance_after_light,
      kind,
      reason,
      reference_table,
      reference_id,
      metadata
    )
    VALUES (
      p_seller_id,
      -v_fee_waived,
      v_fee_credit_balance_after,
      'spend',
      'platform_fee_waiver',
      'app_sales',
      v_sale_id,
      jsonb_build_object(
        'payer_user_id', p_buyer_id,
        'gross_light', p_sale_price_light,
        'fee_would_have_been_light', v_fee_would_have_been,
        'platform_fee_charged_light', v_platform_fee_charged,
        'sale_method', p_sale_method
      )
    )
    RETURNING id INTO v_fee_credit_ledger_id;
  END IF;

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
    'platform_fee_light', v_platform_fee_charged,
    'fee_would_have_been_light', v_fee_would_have_been,
    'fee_waived_light', v_fee_waived,
    'waiver_source', v_waiver_source,
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
  PERFORM public.record_light_ledger_entry(NULL, p_buyer_id, v_app.id, 'platform', 'platform_fee', v_platform_fee_charged, 'app_sales', v_sale_id);

  IF v_waiver_source IS NOT NULL AND v_fee_waived > 0 THEN
    INSERT INTO public.platform_fee_waiver_events (
      payer_user_id,
      publisher_user_id,
      app_id,
      transaction_kind,
      transaction_reference_table,
      transaction_reference_id,
      gross_light,
      fee_rate,
      fee_would_have_been_light,
      fee_waived_light,
      platform_fee_charged_light,
      waiver_source,
      waiver_grant_id,
      fee_credit_ledger_id,
      metadata
    )
    VALUES (
      p_buyer_id,
      p_seller_id,
      v_app.id,
      'marketplace_sale',
      'app_sales',
      v_sale_id,
      p_sale_price_light,
      COALESCE(v_fee_rate, 0.15),
      v_fee_would_have_been,
      v_fee_waived,
      v_platform_fee_charged,
      v_waiver_source,
      v_waiver_grant_id,
      v_fee_credit_ledger_id,
      v_metadata
    )
    RETURNING id INTO v_waiver_event_id;
  END IF;

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'app_id', v_app.id,
    'seller_id', p_seller_id,
    'buyer_id', p_buyer_id,
    'sale_price_light', p_sale_price_light,
    'platform_fee_light', v_platform_fee_charged,
    'seller_payout_light', v_payout,
    'fee_would_have_been_light', v_fee_would_have_been,
    'fee_waived_light', v_fee_waived,
    'waiver_source', v_waiver_source,
    'waiver_event_id', v_waiver_event_id,
    'seller_auto_converted', v_credit.auto_converted,
    'seller_conversion_id', v_credit.conversion_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_light(
  uuid,
  uuid,
  double precision,
  text,
  uuid,
  text,
  uuid,
  jsonb
) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.transfer_light(
  uuid,
  uuid,
  double precision,
  text,
  uuid,
  text,
  uuid,
  jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.complete_marketplace_sale(uuid, uuid, uuid, double precision, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.complete_marketplace_sale(uuid, uuid, uuid, double precision, uuid, text, text)
  TO service_role;
