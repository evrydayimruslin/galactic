-- Additive multi-routine Agent Home CAS. The historical
-- update_agent_home_routine RPC remains unchanged for compatibility; new
-- routine-detail routes use this RPC for any explicitly launch-managed sibling.

CREATE OR REPLACE FUNCTION public.update_agent_home_managed_routine(
  p_app_id uuid,
  p_user_id uuid,
  p_routine_id uuid,
  p_expected_revision bigint,
  p_set_name boolean DEFAULT false,
  p_name text DEFAULT NULL,
  p_set_description boolean DEFAULT false,
  p_description text DEFAULT NULL,
  p_set_mission boolean DEFAULT false,
  p_mission text DEFAULT NULL,
  p_set_schedule boolean DEFAULT false,
  p_schedule jsonb DEFAULT NULL,
  p_active_next_run_at timestamp with time zone DEFAULT NULL,
  p_set_budget boolean DEFAULT false,
  p_budget_policy jsonb DEFAULT NULL
) RETURNS TABLE (new_revision text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_routine public.user_routines%ROWTYPE;
  v_run double precision;
  v_day double precision;
  v_month double precision;
  v_calls double precision;
  v_schedule_type text;
BEGIN
  -- Locks the owned, non-deleted, private Agent and verifies the exact revision
  -- that the owner reviewed before any routine row is read or changed.
  PERFORM public.assert_agent_home_revision(
    p_app_id, p_user_id, p_expected_revision
  );
  PERFORM public.assert_no_started_agent_home_promotion(p_app_id, p_user_id);

  SELECT routines.*
    INTO v_routine
  FROM public.user_routines AS routines
  WHERE routines.id = p_routine_id
    AND routines.user_id = p_user_id
    AND routines.composer_app_id = p_app_id
    AND routines.deleted_at IS NULL
    AND (
      -- Compatibility rows created before explicit launch roles remain managed.
      routines.metadata->>'launch_primary' = 'true'
      -- The protected managed marker, not an open-ended display role, is the
      -- lifecycle authority. Unknown future/corrupt roles stay fail-protected
      -- and mutable as ordinary managed siblings, matching launchRoutineRole.
      OR routines.metadata->>'launch_managed' = 'true'
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_routine_not_found',
      DETAIL = '{"code":"AGENT_HOME_ROUTINE_NOT_FOUND"}';
  END IF;

  IF NOT COALESCE(p_set_name, false)
     AND NOT COALESCE(p_set_description, false)
     AND NOT COALESCE(p_set_mission, false)
     AND NOT COALESCE(p_set_schedule, false)
     AND NOT COALESCE(p_set_budget, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_no_managed_routine_fields',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION"}';
  END IF;

  IF COALESCE(p_set_name, false) AND
     (p_name IS NULL OR btrim(p_name) = '' OR
      char_length(btrim(p_name)) > 120) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_routine_name',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"name"}';
  END IF;
  IF COALESCE(p_set_description, false) AND p_description IS NOT NULL AND
     char_length(btrim(p_description)) > 500 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_routine_description',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"description"}';
  END IF;
  IF COALESCE(p_set_mission, false) AND p_mission IS NOT NULL AND
     char_length(btrim(p_mission)) > 1000 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_mission',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"mission"}';
  END IF;

  IF COALESCE(p_set_schedule, false) THEN
    IF p_schedule IS NULL OR jsonb_typeof(p_schedule) <> 'object' OR
       NOT (p_schedule ? 'type') OR
       jsonb_typeof(p_schedule->'type') <> 'string' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_schedule',
        DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"schedule"}';
    END IF;
    v_schedule_type := p_schedule->>'type';
    IF v_schedule_type = 'interval' THEN
      IF NOT (p_schedule ?& ARRAY['type', 'every_seconds']) OR
         (SELECT count(*) FROM jsonb_object_keys(p_schedule)) <> 2 OR
         jsonb_typeof(p_schedule->'every_seconds') <> 'number' OR
         NOT COALESCE((p_schedule->>'every_seconds') ~ '^[0-9]+$', false) OR
         (p_schedule->>'every_seconds')::numeric < 60 OR
         (p_schedule->>'every_seconds')::numeric > 9007199254740991 THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_interval_schedule',
          DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"schedule"}';
      END IF;
    ELSIF v_schedule_type = 'cron' THEN
      IF NOT (p_schedule ?& ARRAY['type', 'cron', 'timezone']) OR
         (SELECT count(*) FROM jsonb_object_keys(p_schedule)) <> 3 OR
         jsonb_typeof(p_schedule->'cron') <> 'string' OR
         jsonb_typeof(p_schedule->'timezone') <> 'string' OR
         p_schedule->>'cron' IS DISTINCT FROM btrim(p_schedule->>'cron') OR
         p_schedule->>'cron' = '' OR
         char_length(p_schedule->>'cron') > 200 OR
         array_length(
           regexp_split_to_array(p_schedule->>'cron', '[[:space:]]+'), 1
         ) <> 5 OR
         p_schedule->>'timezone' IS DISTINCT FROM
           btrim(p_schedule->>'timezone') OR
         p_schedule->>'timezone' = '' OR
         char_length(p_schedule->>'timezone') > 100 THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_cron_schedule',
          DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"schedule"}';
      END IF;
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_schedule_type',
        DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"schedule"}';
    END IF;

    -- Cron/timezone interpretation belongs to the trusted TypeScript schedule
    -- engine. The database only applies its precomputed next instant.
    IF v_routine.status = 'active' AND p_active_next_run_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_active_next_run_required',
        DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"activeNextRunAt"}';
    END IF;
    IF v_routine.status <> 'active' AND p_active_next_run_at IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_inactive_next_run_forbidden',
        DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"activeNextRunAt"}';
    END IF;
  ELSIF p_active_next_run_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_next_run_without_schedule',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"activeNextRunAt"}';
  END IF;

  IF COALESCE(p_set_budget, false) THEN
    IF p_budget_policy IS NULL OR jsonb_typeof(p_budget_policy) <> 'object' OR
       NOT (p_budget_policy ?& ARRAY[
         'max_light_per_run', 'max_light_per_day',
         'max_light_per_month', 'max_calls_per_run'
       ]) OR
       (SELECT count(*) FROM jsonb_object_keys(p_budget_policy)) <> 4 OR
       EXISTS (
         SELECT 1 FROM jsonb_each(p_budget_policy) AS entry
         WHERE jsonb_typeof(entry.value) <> 'number'
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_budget',
        DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"budgets"}';
    END IF;
    v_run := (p_budget_policy->>'max_light_per_run')::double precision;
    v_day := (p_budget_policy->>'max_light_per_day')::double precision;
    v_month := (p_budget_policy->>'max_light_per_month')::double precision;
    v_calls := (p_budget_policy->>'max_calls_per_run')::double precision;
    IF v_run < 0 OR v_day < v_run OR v_month < v_day OR v_calls < 1 OR
       v_calls <> trunc(v_calls) OR
       v_run::text IN ('NaN', 'Infinity', '-Infinity') OR
       v_day::text IN ('NaN', 'Infinity', '-Infinity') OR
       v_month::text IN ('NaN', 'Infinity', '-Infinity') OR
       v_calls::text IN ('NaN', 'Infinity', '-Infinity') THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_budget',
        DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"budgets"}';
    END IF;
  END IF;

  UPDATE public.user_routines AS routines
  SET name = CASE
        WHEN p_set_name THEN btrim(p_name) ELSE routines.name END,
      description = CASE
        WHEN p_set_description THEN NULLIF(btrim(p_description), '')
        ELSE routines.description END,
      intent = CASE
        WHEN p_set_mission THEN NULLIF(btrim(p_mission), '')
        ELSE routines.intent END,
      schedule = CASE
        WHEN p_set_schedule THEN p_schedule ELSE routines.schedule END,
      next_run_at = CASE
        WHEN p_set_schedule AND routines.status = 'active'
          THEN p_active_next_run_at
        WHEN p_set_schedule THEN NULL
        ELSE routines.next_run_at
      END,
      budget_policy = CASE
        WHEN p_set_budget THEN p_budget_policy ELSE routines.budget_policy END,
      updated_at = now()
  WHERE routines.id = p_routine_id
    AND routines.user_id = p_user_id
    AND routines.composer_app_id = p_app_id
    AND routines.deleted_at IS NULL;

  -- The existing user_routines configuration trigger bumps this while the
  -- Agent lock is still held, so update + revision advancement are atomic.
  RETURN QUERY
  SELECT apps.agent_home_revision::text
  FROM public.apps AS apps
  WHERE apps.id = p_app_id AND apps.owner_id = p_user_id;
END;
$$;

-- Status CAS takes the entitlement lock before the Agent/routine locks. That
-- ordering matches the existing atomic activation RPC and makes slot claim or
-- release part of the same transaction as the lifecycle transition.
CREATE OR REPLACE FUNCTION public.update_agent_home_managed_routine_status(
  p_app_id uuid,
  p_user_id uuid,
  p_routine_id uuid,
  p_expected_revision bigint,
  p_status text,
  p_next_run_at timestamp with time zone DEFAULT NULL
) RETURNS TABLE (new_revision text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_routine public.user_routines%ROWTYPE;
  v_entitlement public.account_entitlements%ROWTYPE;
  v_active_agent_limit integer;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('active', 'paused') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_routine_status',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"status"}';
  END IF;
  IF p_status = 'active' AND p_next_run_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_active_next_run_required',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"nextRunAt"}';
  END IF;
  IF p_status = 'paused' AND p_next_run_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_paused_next_run_forbidden',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"nextRunAt"}';
  END IF;

  v_entitlement := public.ensure_account_entitlement(p_user_id);
  SELECT entitlements.*
    INTO v_entitlement
  FROM public.account_entitlements AS entitlements
  WHERE entitlements.user_id = p_user_id
  FOR UPDATE;

  PERFORM public.assert_agent_home_revision(
    p_app_id, p_user_id, p_expected_revision
  );
  PERFORM public.assert_no_started_agent_home_promotion(p_app_id, p_user_id);

  SELECT routines.*
    INTO v_routine
  FROM public.user_routines AS routines
  WHERE routines.id = p_routine_id
    AND routines.user_id = p_user_id
    AND routines.composer_app_id = p_app_id
    AND routines.deleted_at IS NULL
    AND (
      routines.metadata->>'launch_primary' = 'true'
      OR routines.metadata->>'launch_managed' = 'true'
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_routine_not_found',
      DETAIL = '{"code":"AGENT_HOME_ROUTINE_NOT_FOUND"}';
  END IF;
  IF v_routine.status NOT IN ('active', 'paused', 'error') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_routine_disabled',
      DETAIL = '{"code":"AGENT_HOME_ROUTINE_DISABLED"}';
  END IF;
  IF p_status = 'active' AND v_routine.max_concurrency <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_max_concurrency',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"maxConcurrency"}';
  END IF;

  SELECT plans.active_agent_limit
    INTO v_active_agent_limit
  FROM public.billing_plans AS plans
  WHERE plans.code = v_entitlement.plan_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_entitlement_plan_not_found',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"plan"}';
  END IF;

  IF p_status = 'active' THEN
    IF v_active_agent_limit IS NOT NULL
       AND v_entitlement.free_agent_id IS NOT NULL
       AND v_entitlement.free_agent_id IS DISTINCT FROM p_app_id THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_active_agent_limit',
        DETAIL = jsonb_build_object(
          'code', 'AGENT_HOME_ACTIVE_AGENT_LIMIT',
          'occupiedBy', v_entitlement.free_agent_id
        )::text;
    END IF;
    IF v_active_agent_limit IS NOT NULL THEN
      UPDATE public.account_entitlements AS entitlements
      SET free_agent_id = p_app_id,
          updated_at = now()
      WHERE entitlements.user_id = p_user_id;
    END IF;

    UPDATE public.user_routines AS routines
    SET status = 'active',
        next_run_at = p_next_run_at,
        updated_at = now()
    WHERE routines.id = p_routine_id
      AND routines.user_id = p_user_id
      AND routines.composer_app_id = p_app_id
      AND routines.deleted_at IS NULL;
  ELSE
    UPDATE public.user_routines AS routines
    SET status = 'paused',
        next_run_at = NULL,
        updated_at = now()
    WHERE routines.id = p_routine_id
      AND routines.user_id = p_user_id
      AND routines.composer_app_id = p_app_id
      AND routines.deleted_at IS NULL;

    -- The entitlement row remains locked from above, so no other Agent can
    -- claim or release this Free slot between the sibling check and update.
    IF v_entitlement.free_agent_id = p_app_id AND NOT EXISTS (
      SELECT 1
      FROM public.user_routines AS siblings
      WHERE siblings.user_id = p_user_id
        AND siblings.composer_app_id = p_app_id
        AND siblings.deleted_at IS NULL
        AND siblings.status = 'active'
        AND (
          siblings.metadata->>'launch_primary' = 'true'
          OR siblings.metadata->>'launch_managed' = 'true'
        )
    ) THEN
      UPDATE public.account_entitlements AS entitlements
      SET free_agent_id = NULL,
          updated_at = now()
      WHERE entitlements.user_id = p_user_id
        AND entitlements.free_agent_id = p_app_id;
    END IF;
  END IF;

  RETURN QUERY
  SELECT apps.agent_home_revision::text
  FROM public.apps AS apps
  WHERE apps.id = p_app_id AND apps.owner_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_agent_home_managed_routine(
  uuid, uuid, uuid, bigint, boolean, text, boolean, text, boolean, text,
  boolean, jsonb, timestamp with time zone, boolean, jsonb
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.update_agent_home_managed_routine_status(
  uuid, uuid, uuid, bigint, text, timestamp with time zone
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.update_agent_home_managed_routine(
  uuid, uuid, uuid, bigint, boolean, text, boolean, text, boolean, text,
  boolean, jsonb, timestamp with time zone, boolean, jsonb
) TO service_role;

GRANT EXECUTE ON FUNCTION public.update_agent_home_managed_routine_status(
  uuid, uuid, uuid, bigint, text, timestamp with time zone
) TO service_role;
