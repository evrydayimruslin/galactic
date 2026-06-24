-- Consolidate in-app purchases (ultralight.charge) into the per-call fee + referral system.
--
-- Before this, ultralight.charge() transferred with reason 'in_app_purchase',
-- which transfer_light treated as un-kinded: it STILL charged the 15% platform
-- fee, but was EXCLUDED from the customer-attribution + referral-waiver path
-- (only tool_call / gpu_call / skill_pull ran it). So a developer-brought
-- customer making an in-app purchase still paid the 15% — neither feeless nor
-- waivable, and the purchase did not attribute the customer to the developer.
--
-- This makes 'in_app_purchase' a first-class monetization kind so it runs through
-- the SAME attribution + referral-waiver + fee-credit logic as per-call pricing:
-- 15% on every charge, waived to 0% when the buyer is the developer's own
-- attributed customer. One fee policy, one referral system, both surfaces.
--
-- Two coupled changes:
--   1. Extend platform_fee_waiver_events.transaction_kind to accept 'in_app_purchase'
--      (a waived in-app purchase inserts a waiver event with this kind, which the
--      existing CHECK would otherwise reject, failing the whole transfer).
--   2. Add 'in_app_purchase' to transfer_light's v_transaction_kind CASE.

ALTER TABLE public.platform_fee_waiver_events
  DROP CONSTRAINT IF EXISTS platform_fee_waiver_events_transaction_kind_check;

ALTER TABLE public.platform_fee_waiver_events
  ADD CONSTRAINT platform_fee_waiver_events_transaction_kind_check
    CHECK (transaction_kind IN ('tool_call', 'gpu_developer_fee', 'marketplace_sale', 'skill_pull', 'in_app_purchase'));

CREATE OR REPLACE FUNCTION public.transfer_light(
  p_from_user uuid,
  p_to_user uuid,
  p_amount_light double precision,
  p_reason text,
  p_app_id uuid DEFAULT NULL::uuid,
  p_function_name text DEFAULT NULL::text,
  p_content_id uuid DEFAULT NULL::uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_idempotency_key text DEFAULT NULL::text
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
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_existing jsonb;
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
  v_customer_attribution_id uuid;
  v_customer_attribution_source text;
  v_recorded_attribution_source text;
  v_waiver_event_id uuid;
  v_response jsonb;
BEGIN
  v_existing := public.begin_economic_idempotent_operation(v_key, 'transfer_light');
  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT
      (v_existing->>'from_new_balance')::double precision,
      (v_existing->>'to_new_balance')::double precision,
      (v_existing->>'platform_fee')::double precision,
      (v_existing->>'transfer_id')::uuid,
      (v_existing->>'fee_would_have_been')::double precision,
      (v_existing->>'fee_waived')::double precision,
      NULLIF(v_existing->>'waiver_source', ''),
      NULLIF(v_existing->>'waiver_event_id', '')::uuid;
    RETURN;
  END IF;

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
    PERFORM public.cancel_economic_idempotent_operation(v_key);
    RETURN;
  END IF;

  SELECT COALESCE(platform_fee_rate, 0.15) INTO v_fee_rate
  FROM public.platform_billing_config
  WHERE id = 'singleton';

  v_fee_would_have_been := p_amount_light * COALESCE(v_fee_rate, 0.15);

  v_transaction_kind := CASE
    WHEN p_reason = 'gpu_call' THEN 'gpu_developer_fee'
    WHEN p_reason IN ('tool_call', 'tool_call_suspended') THEN 'tool_call'
    WHEN p_reason = 'skill_pull' THEN 'skill_pull'
    WHEN p_reason = 'in_app_purchase' THEN 'in_app_purchase'
    ELSE NULL
  END;

  IF v_transaction_kind IS NOT NULL AND v_fee_would_have_been > 0 THEN
    v_recorded_attribution_source :=
      COALESCE(NULLIF(COALESCE(p_metadata, '{}'::jsonb)->>'customer_attribution_source', ''), 'platform_discovery');
    IF v_recorded_attribution_source NOT IN (
      'publisher_referral',
      'platform_discovery',
      'platform_marketplace',
      'direct_internal',
      'admin_override'
    ) THEN
      v_recorded_attribution_source := 'platform_discovery';
    END IF;

    PERFORM public.upsert_publisher_customer_attribution(
      p_from_user,
      p_to_user,
      v_recorded_attribution_source,
      NULL,
      NULL,
      p_app_id,
      jsonb_build_object(
        'reason', p_reason,
        'function_name', p_function_name,
        'content_id', p_content_id
      ) || COALESCE(p_metadata, '{}'::jsonb)
    );

    SELECT id, source INTO v_customer_attribution_id, v_customer_attribution_source
    FROM public.publisher_customer_attributions
    WHERE payer_user_id = p_from_user
      AND publisher_user_id = p_to_user
    FOR UPDATE;

    IF v_customer_attribution_source = 'publisher_referral' THEN
      v_fee_waived := v_fee_would_have_been;
      v_waiver_source := 'publisher_customer_attribution';
    ELSE
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
    content_id,
    idempotency_key
  )
  VALUES (
    p_from_user,
    p_to_user,
    round(v_net)::double precision,
    v_net,
    p_reason,
    p_app_id,
    p_function_name,
    p_content_id,
    v_key
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
        'reason', p_reason,
        'idempotency_key', v_key
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
      'customer_attribution_id', v_customer_attribution_id,
      'customer_attribution_source', v_customer_attribution_source,
      'function_name', p_function_name,
      'content_id', p_content_id,
      'idempotency_key', v_key
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
      customer_attribution_id,
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
      CASE WHEN v_waiver_source = 'publisher_customer_attribution' THEN v_customer_attribution_id ELSE NULL END,
      v_metadata || jsonb_build_object('reason', p_reason)
    )
    RETURNING id INTO v_waiver_event_id;
  END IF;

  v_response := jsonb_build_object(
    'from_new_balance', v_debit.new_balance,
    'to_new_balance', v_credit.new_balance,
    'platform_fee', v_platform_fee_charged,
    'transfer_id', v_transfer_id,
    'fee_would_have_been', v_fee_would_have_been,
    'fee_waived', v_fee_waived,
    'waiver_source', COALESCE(v_waiver_source, ''),
    'waiver_event_id', COALESCE(v_waiver_event_id::text, '')
  );

  PERFORM public.finish_economic_idempotent_operation(
    v_key,
    v_response,
    'transfers',
    v_transfer_id
  );

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


