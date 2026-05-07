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
  p_metadata jsonb DEFAULT '{}'::jsonb
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
BEGIN
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

  v_metadata := COALESCE(p_metadata, '{}'::jsonb)
    || jsonb_build_object(
      'app_price_light', v_app_price_light,
      'app_charge_light', v_app_charge_light,
      'free_call', v_free_call,
      'free_call_count', v_free_call_count,
      'free_call_limit', v_free_call_limit,
      'caller_infra_fallback', false,
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
      v_metadata
    );
  EXCEPTION WHEN OTHERS THEN
    IF v_owner_sponsored AND SQLERRM ILIKE 'Insufficient available balance%' THEN
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
          v_metadata
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

REVOKE ALL ON FUNCTION public.create_app_call_runtime_cloud_hold(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  double precision,
  double precision,
  double precision,
  double precision,
  integer,
  text,
  timestamptz,
  integer,
  jsonb
) FROM PUBLIC, anon, authenticated;

GRANT ALL ON FUNCTION public.create_app_call_runtime_cloud_hold(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  double precision,
  double precision,
  double precision,
  double precision,
  integer,
  text,
  timestamptz,
  integer,
  jsonb
) TO service_role;
