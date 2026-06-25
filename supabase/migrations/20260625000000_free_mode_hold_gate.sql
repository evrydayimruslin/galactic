-- Free Mode — Phase 1 paid-call gate (docs/FREE_MODE_DESIGN.md).
--
-- Adds p_free_mode to create_app_call_runtime_cloud_hold. When set, the hold
-- refuses BEFORE any debit if the call would charge the CALLER — i.e. a paid
-- call (over free quota, or no allowance) or an owner-sponsored call that would
-- fall back to charging the caller for infra. Self / free / within-quota /
-- owner-sponsored calls (payer = owner) are untouched (D6/D7). Default false =
-- no behavior change for existing callers.
--
-- Adding a parameter changes the signature, so the 16-arg version is dropped
-- first to avoid creating an overloaded function.

DROP FUNCTION IF EXISTS public.create_app_call_runtime_cloud_hold(
  uuid, uuid, uuid, text, text, text,
  double precision, double precision, double precision, double precision,
  integer, text, timestamptz, integer, jsonb, text
);

CREATE OR REPLACE FUNCTION public.create_app_call_runtime_cloud_hold(
  p_caller_user_id uuid,
  p_owner_user_id uuid,
  p_app_id uuid,
  p_function_name text,
  p_receipt_id text,
  p_source text,
  p_expected_units double precision,
  p_expected_cloud_units double precision,
  p_expected_amount_light double precision,
  p_app_price_light double precision DEFAULT 0,
  p_free_call_limit integer DEFAULT 0,
  p_free_call_counter_key text DEFAULT NULL::text,
  p_expires_at timestamptz DEFAULT NULL::timestamptz,
  p_billing_config_version integer DEFAULT NULL::integer,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_idempotency_key text DEFAULT NULL::text,
  p_free_mode boolean DEFAULT false
) RETURNS TABLE(
  hold_id uuid,
  payer_user_id uuid,
  sponsor_user_id uuid,
  app_price_light double precision,
  app_charge_light double precision,
  free_call boolean,
  free_call_count integer,
  free_call_limit integer,
  old_balance double precision,
  new_balance double precision,
  held_amount_light double precision,
  held_deposit_light double precision,
  held_earned_light double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
DECLARE
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_existing jsonb;
  v_payer_user_id uuid;
  v_sponsor_user_id uuid;
  v_app_price_light double precision := GREATEST(COALESCE(p_app_price_light, 0), 0);
  v_app_charge_light double precision := 0;
  v_free_call boolean := false;
  v_free_call_count integer := NULL;
  v_free_call_limit integer := GREATEST(COALESCE(p_free_call_limit, 0), 0);
  v_owner_sponsored boolean := false;
  v_hold RECORD;
  v_metadata jsonb;
  v_response jsonb;
BEGIN
  v_existing := public.begin_economic_idempotent_operation(v_key, 'create_app_call_runtime_cloud_hold');
  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT
      (v_existing->>'hold_id')::uuid,
      (v_existing->>'payer_user_id')::uuid,
      NULLIF(v_existing->>'sponsor_user_id', '')::uuid,
      (v_existing->>'app_price_light')::double precision,
      (v_existing->>'app_charge_light')::double precision,
      (v_existing->>'free_call')::boolean,
      NULLIF(v_existing->>'free_call_count', '')::integer,
      (v_existing->>'free_call_limit')::integer,
      (v_existing->>'old_balance')::double precision,
      (v_existing->>'new_balance')::double precision,
      (v_existing->>'held_amount_light')::double precision,
      (v_existing->>'held_deposit_light')::double precision,
      (v_existing->>'held_earned_light')::double precision;
    RETURN;
  END IF;

  IF p_caller_user_id IS NULL THEN
    RAISE EXCEPTION 'Caller user id is required';
  END IF;

  IF p_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'Owner user id is required';
  END IF;

  IF p_expected_amount_light IS NULL OR p_expected_amount_light <= 0 THEN
    RAISE EXCEPTION 'Runtime cloud hold amount must be positive';
  END IF;

  IF p_caller_user_id = p_owner_user_id THEN
    v_payer_user_id := p_owner_user_id;
    v_app_charge_light := 0;
  ELSIF v_app_price_light <= 0 THEN
    v_payer_user_id := p_owner_user_id;
    v_app_charge_light := 0;
    v_free_call := true;
  ELSIF v_free_call_limit > 0 THEN
    INSERT INTO public.app_caller_usage (
      app_id,
      user_id,
      counter_key,
      call_count,
      first_call_at,
      last_call_at
    ) VALUES (
      p_app_id,
      p_caller_user_id,
      COALESCE(NULLIF(p_free_call_counter_key, ''), p_function_name),
      1,
      now(),
      now()
    )
    ON CONFLICT (app_id, user_id, counter_key)
    DO UPDATE SET
      call_count = public.app_caller_usage.call_count + 1,
      last_call_at = now()
    RETURNING call_count INTO v_free_call_count;

    IF v_free_call_count <= v_free_call_limit THEN
      v_payer_user_id := p_owner_user_id;
      v_app_charge_light := 0;
      v_free_call := true;
    ELSE
      v_payer_user_id := p_caller_user_id;
      v_app_charge_light := v_app_price_light;
      v_free_call := false;
    END IF;
  ELSE
    v_payer_user_id := p_caller_user_id;
    v_app_charge_light := v_app_price_light;
  END IF;

  IF v_payer_user_id = p_owner_user_id AND p_caller_user_id <> p_owner_user_id THEN
    v_sponsor_user_id := p_owner_user_id;
    v_owner_sponsored := true;
  END IF;

  -- Free Mode gate (D6/D7): refuse before any debit if this call would charge
  -- the caller for the app. Self/free/within-quota/owner-sponsored calls resolve
  -- the payer to the owner and pass through; the RAISE rolls the whole hold
  -- back, including the free-quota counter increment above.
  IF p_free_mode
    AND v_payer_user_id = p_caller_user_id
    AND p_caller_user_id <> p_owner_user_id THEN
    RAISE EXCEPTION 'free_mode_blocked: paid call requires credits';
  END IF;

  v_metadata := COALESCE(p_metadata, '{}'::jsonb)
    || jsonb_build_object(
      'app_price_light', v_app_price_light,
      'app_charge_light', v_app_charge_light,
      'free_call', v_free_call,
      'free_call_count', v_free_call_count,
      'free_call_limit', v_free_call_limit,
      'caller_infra_fallback', false,
      'idempotency_key', v_key,
      'payer_role', CASE
        WHEN v_sponsor_user_id IS NOT NULL THEN 'owner_sponsor'
        WHEN v_payer_user_id = p_owner_user_id THEN 'owner'
        ELSE 'caller'
      END
    );

  BEGIN
    SELECT * INTO v_hold
    FROM public.create_cloud_usage_hold(
      v_payer_user_id,
      COALESCE(NULLIF(p_source, ''), 'runtime'),
      'worker_execution',
      p_expected_units,
      p_expected_cloud_units,
      p_expected_amount_light,
      v_sponsor_user_id,
      p_caller_user_id,
      p_owner_user_id,
      p_app_id,
      p_function_name,
      p_receipt_id,
      p_expires_at,
      p_billing_config_version,
      v_metadata,
      CASE WHEN v_key IS NULL THEN NULL ELSE v_key || ':hold' END
    );
  EXCEPTION WHEN OTHERS THEN
    IF v_owner_sponsored AND SQLERRM ILIKE 'Insufficient available balance%' THEN
      -- Free Mode: an owner-sponsored call must not fall back to charging the
      -- caller for infra. Refuse instead (the caller pays nothing in free mode).
      IF p_free_mode THEN
        RAISE EXCEPTION 'free_mode_blocked: sponsored call cannot fall back to the caller in free mode';
      END IF;

      v_payer_user_id := p_caller_user_id;
      v_sponsor_user_id := NULL;

      v_metadata := COALESCE(p_metadata, '{}'::jsonb)
        || jsonb_build_object(
          'app_price_light', v_app_price_light,
          'app_charge_light', v_app_charge_light,
          'free_call', v_free_call,
          'free_call_count', v_free_call_count,
          'free_call_limit', v_free_call_limit,
          'caller_infra_fallback', true,
          'fallback_from_sponsor_user_id', p_owner_user_id,
          'idempotency_key', v_key,
          'payer_role', 'caller_infra_fallback'
        );

      BEGIN
        SELECT * INTO v_hold
        FROM public.create_cloud_usage_hold(
          v_payer_user_id,
          COALESCE(NULLIF(p_source, ''), 'runtime'),
          'worker_execution',
          p_expected_units,
          p_expected_cloud_units,
          p_expected_amount_light,
          v_sponsor_user_id,
          p_caller_user_id,
          p_owner_user_id,
          p_app_id,
          p_function_name,
          p_receipt_id,
          p_expires_at,
          p_billing_config_version,
          v_metadata,
          CASE WHEN v_key IS NULL THEN NULL ELSE v_key || ':hold' END
        );
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM ILIKE 'Insufficient available balance%' THEN
          RAISE EXCEPTION 'caller_infra_fallback_light_required: %', SQLERRM;
        END IF;
        RAISE;
      END;
    ELSE
      RAISE;
    END IF;
  END;

  v_response := jsonb_build_object(
    'hold_id', v_hold.hold_id,
    'payer_user_id', v_payer_user_id,
    'sponsor_user_id', COALESCE(v_sponsor_user_id::text, ''),
    'app_price_light', v_app_price_light,
    'app_charge_light', v_app_charge_light,
    'free_call', v_free_call,
    'free_call_count', COALESCE(v_free_call_count::text, ''),
    'free_call_limit', v_free_call_limit,
    'old_balance', v_hold.old_balance,
    'new_balance', v_hold.new_balance,
    'held_amount_light', v_hold.held_amount_light,
    'held_deposit_light', v_hold.held_deposit_light,
    'held_earned_light', v_hold.held_earned_light
  );
  PERFORM public.finish_economic_idempotent_operation(
    v_key,
    v_response,
    'cloud_usage_holds',
    v_hold.hold_id
  );

  RETURN QUERY SELECT
    v_hold.hold_id,
    v_payer_user_id,
    v_sponsor_user_id,
    v_app_price_light,
    v_app_charge_light,
    v_free_call,
    v_free_call_count,
    v_free_call_limit,
    v_hold.old_balance,
    v_hold.new_balance,
    v_hold.held_amount_light,
    v_hold.held_deposit_light,
    v_hold.held_earned_light;
END;
$$;

-- Re-apply the original grants to the new 17-arg signature (DROP discarded the
-- ones attached to the 16-arg version): callable only via the service role.
REVOKE ALL ON FUNCTION public.create_app_call_runtime_cloud_hold(
  uuid, uuid, uuid, text, text, text,
  double precision, double precision, double precision, double precision,
  integer, text, timestamptz, integer, jsonb, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.create_app_call_runtime_cloud_hold(
  uuid, uuid, uuid, text, text, text,
  double precision, double precision, double precision, double precision,
  integer, text, timestamptz, integer, jsonb, text, boolean
) TO service_role;

