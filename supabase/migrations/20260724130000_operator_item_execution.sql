-- M7: canonical operator-item execution.
--
-- A paused routine is executable only when an active, owner-scoped canonical
-- issue contains the exact server-registered Run once remediation. The durable
-- Agent Home action request supplies idempotency; this migration keeps the
-- item, routine, revision, lease, concurrency, and queue insert checks inside
-- one transaction.

CREATE OR REPLACE FUNCTION public.resolve_operator_item_routine_run_once(
  p_user_id uuid,
  p_item_id uuid,
  p_remediation_id text
) RETURNS TABLE (
  app_id uuid,
  routine_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_item public.operator_items%ROWTYPE;
  v_remediation jsonb;
BEGIN
  IF p_user_id IS NULL OR p_item_id IS NULL OR
     p_remediation_id IS NULL OR
     char_length(btrim(p_remediation_id)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'operator_item_action_invalid',
      DETAIL = '{"code":"OPERATOR_ITEM_ACTION_INVALID"}';
  END IF;

  SELECT * INTO v_item
  FROM public.operator_items
  WHERE id = p_item_id
    AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'operator_item_not_active',
      DETAIL = '{"code":"OPERATOR_ITEM_NOT_ACTIVE"}';
  END IF;

  SELECT candidate.remediation INTO v_remediation
  FROM jsonb_array_elements(v_item.remediations)
    AS candidate(remediation)
  WHERE candidate.remediation->>'id' = btrim(p_remediation_id)
  LIMIT 1;

  IF v_item.item_class <> 'issue' OR
     v_item.scope_kind <> 'routine' OR
     v_item.source_key <> 'routine.health:' || v_item.scope_routine_id::text OR
     v_item.diagnosis->>'code' <> 'ROUTINE_PAUSED_AFTER_FAILURES' OR
     v_item.recovery_mode <> 'successful_verification' OR
     v_remediation IS NULL OR
     v_remediation->>'key' <> 'run_once' OR
     v_remediation->>'presentation' <> 'execute' OR
     v_remediation->>'requiredAuthority' <> 'agent_operate' OR
     v_remediation->>'sideEffect' <> 'routine_execution' OR
     v_remediation->'target'->>'kind' <> 'routine' OR
     v_remediation->'target'->>'agentId' IS DISTINCT FROM
       v_item.scope_agent_id::text OR
     v_remediation->'target'->>'routineId' IS DISTINCT FROM
       v_item.scope_routine_id::text THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'operator_item_action_not_available',
      DETAIL = '{"code":"OPERATOR_ITEM_ACTION_NOT_AVAILABLE"}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.operator_item_affected_agents AS affected
    WHERE affected.user_id = p_user_id
      AND affected.item_id = p_item_id
      AND affected.agent_id = v_item.scope_agent_id
      AND affected.blocking
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'operator_item_action_not_available',
      DETAIL = '{"code":"OPERATOR_ITEM_ACTION_NOT_AVAILABLE"}';
  END IF;

  RETURN QUERY SELECT v_item.scope_agent_id, v_item.scope_routine_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_operator_item_routine_run_once(
  p_request_id uuid,
  p_app_id uuid,
  p_user_id uuid,
  p_routine_id uuid,
  p_item_id uuid,
  p_remediation_id text,
  p_lease_token uuid,
  p_expected_revision bigint
) RETURNS TABLE (
  run_id uuid,
  is_new boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_revision bigint;
  v_existing public.agent_home_action_requests%ROWTYPE;
  v_item public.operator_items%ROWTYPE;
  v_remediation jsonb;
  v_run_id uuid;
  v_max_concurrency integer;
  v_active_runs integer;
  v_expected_payload jsonb;
BEGIN
  IF p_request_id IS NULL OR p_app_id IS NULL OR p_user_id IS NULL OR
     p_routine_id IS NULL OR p_item_id IS NULL OR p_lease_token IS NULL OR
     p_expected_revision IS NULL OR p_expected_revision < 1 OR
     p_remediation_id IS NULL OR
     char_length(btrim(p_remediation_id)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'operator_item_action_invalid',
      DETAIL = '{"code":"OPERATOR_ITEM_ACTION_INVALID"}';
  END IF;

  SELECT agent_home_revision INTO v_revision
  FROM public.apps
  WHERE id = p_app_id
    AND owner_id = p_user_id
    AND visibility = 'private'
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_not_found',
      DETAIL = '{"code":"AGENT_HOME_NOT_FOUND"}';
  END IF;

  SELECT * INTO v_existing
  FROM public.agent_home_action_requests
  WHERE id = p_request_id
    AND user_id = p_user_id
    AND app_id = p_app_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_action_not_found',
      DETAIL = '{"code":"AGENT_HOME_ACTION_NOT_FOUND"}';
  END IF;

  v_expected_payload := jsonb_build_object(
    'action', 'operator_run_once',
    'capabilityIds', '[]'::jsonb,
    'version', NULL,
    'routineId', p_routine_id::text,
    'operatorItemId', p_item_id::text,
    'remediationId', btrim(p_remediation_id)
  );
  IF v_existing.status <> 'in_progress' OR
     v_existing.action <> 'operator_run_once' OR
     v_existing.request_payload IS DISTINCT FROM v_expected_payload OR
     v_existing.expected_revision <> p_expected_revision OR
     v_existing.lease_token IS DISTINCT FROM p_lease_token OR
     v_existing.lease_expires_at <= now() THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_action_lease_lost',
      DETAIL = '{"code":"AGENT_HOME_ACTION_IN_PROGRESS"}';
  END IF;

  SELECT runs.id INTO v_run_id
  FROM public.routine_runs AS runs
  WHERE runs.agent_home_action_request_id = p_request_id
    AND runs.user_id = p_user_id
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_run_id, false;
    RETURN;
  END IF;

  IF v_revision <> p_expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_revision_conflict',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_HOME_REVISION_CONFLICT',
        'expectedRevision', p_expected_revision::text,
        'actualRevision', v_revision::text
      )::text;
  END IF;

  SELECT * INTO v_item
  FROM public.operator_items
  WHERE id = p_item_id
    AND user_id = p_user_id
    AND lifecycle_state = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'operator_item_not_active',
      DETAIL = '{"code":"OPERATOR_ITEM_NOT_ACTIVE"}';
  END IF;

  SELECT candidate.remediation INTO v_remediation
  FROM jsonb_array_elements(v_item.remediations)
    AS candidate(remediation)
  WHERE candidate.remediation->>'id' = btrim(p_remediation_id)
  LIMIT 1;
  IF v_item.item_class <> 'issue' OR
     v_item.scope_kind <> 'routine' OR
     v_item.scope_agent_id IS DISTINCT FROM p_app_id OR
     v_item.scope_routine_id IS DISTINCT FROM p_routine_id OR
     v_item.source_key <> 'routine.health:' || p_routine_id::text OR
     v_item.diagnosis->>'code' <> 'ROUTINE_PAUSED_AFTER_FAILURES' OR
     v_item.recovery_mode <> 'successful_verification' OR
     v_remediation IS NULL OR
     v_remediation->>'key' <> 'run_once' OR
     v_remediation->>'presentation' <> 'execute' OR
     v_remediation->>'requiredAuthority' <> 'agent_operate' OR
     v_remediation->>'sideEffect' <> 'routine_execution' OR
     v_remediation->'target' <> jsonb_build_object(
       'kind', 'routine',
       'agentId', p_app_id::text,
       'routineId', p_routine_id::text
     ) OR NOT EXISTS (
       SELECT 1
       FROM public.operator_item_affected_agents AS affected
       WHERE affected.user_id = p_user_id
         AND affected.item_id = p_item_id
         AND affected.agent_id = p_app_id
         AND affected.blocking
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'operator_item_action_not_available',
      DETAIL = '{"code":"OPERATOR_ITEM_ACTION_NOT_AVAILABLE"}';
  END IF;

  SELECT max_concurrency INTO v_max_concurrency
  FROM public.user_routines
  WHERE id = p_routine_id
    AND user_id = p_user_id
    AND composer_app_id = p_app_id
    AND deleted_at IS NULL
    AND status = 'paused'
    AND metadata->>'launch_primary' = 'true'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'operator_item_routine_not_paused',
      DETAIL = '{"code":"OPERATOR_ITEM_ROUTINE_NOT_PAUSED"}';
  END IF;
  IF v_max_concurrency <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'operator_item_routine_not_canonical',
      DETAIL = '{"code":"OPERATOR_ITEM_ACTION_NOT_AVAILABLE"}';
  END IF;

  SELECT count(*)::integer INTO v_active_runs
  FROM public.routine_runs
  WHERE routine_id = p_routine_id
    AND user_id = p_user_id
    AND status IN ('queued', 'running');
  IF v_active_runs >= v_max_concurrency THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_run_concurrency_limit',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_HOME_RUN_CONCURRENCY_LIMIT',
        'activeRuns', v_active_runs,
        'maxConcurrency', v_max_concurrency
      )::text;
  END IF;

  INSERT INTO public.routine_runs (
    routine_id,
    user_id,
    status,
    trigger,
    trace_id,
    run_config,
    metadata,
    max_attempts,
    agent_home_action_request_id
  ) VALUES (
    p_routine_id,
    p_user_id,
    'queued',
    'manual',
    gen_random_uuid(),
    '{}'::jsonb,
    jsonb_build_object(
      'source', 'operator_item.run_once',
      'operator_item_id', p_item_id::text,
      'operator_remediation_id', btrim(p_remediation_id)
    ),
    1,
    p_request_id
  ) RETURNING id INTO v_run_id;

  UPDATE public.agent_home_action_requests
  SET lease_expires_at = now() + interval '30 minutes',
      updated_at = now()
  WHERE id = p_request_id;

  RETURN QUERY SELECT v_run_id, true;
END;
$$;

-- Classifies the durable action link at execution time. Returning
-- is_operator_run_once=true, authorized=false lets the executor reject a stale
-- or tampered operator run instead of accidentally treating it as ordinary
-- active work.
CREATE OR REPLACE FUNCTION public.authorize_operator_item_routine_run_once(
  p_user_id uuid,
  p_run_id uuid,
  p_routine_id uuid,
  p_action_request_id uuid
) RETURNS TABLE (
  is_operator_run_once boolean,
  authorized boolean,
  item_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO public, extensions
AS $$
DECLARE
  v_request public.agent_home_action_requests%ROWTYPE;
  v_item public.operator_items%ROWTYPE;
  v_remediation_id text;
  v_remediation jsonb;
BEGIN
  SELECT * INTO v_request
  FROM public.agent_home_action_requests
  WHERE id = p_action_request_id
    AND user_id = p_user_id;
  IF NOT FOUND OR v_request.action <> 'operator_run_once' THEN
    RETURN QUERY SELECT false, false, NULL::uuid;
    RETURN;
  END IF;

  BEGIN
    v_remediation_id := v_request.request_payload->>'remediationId';
    SELECT * INTO v_item
    FROM public.operator_items
    WHERE id = (v_request.request_payload->>'operatorItemId')::uuid
      AND user_id = p_user_id
      AND lifecycle_state = 'active';
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN QUERY SELECT true, false, NULL::uuid;
    RETURN;
  END;

  IF NOT FOUND THEN
    RETURN QUERY SELECT true, false, NULL::uuid;
    RETURN;
  END IF;

  SELECT candidate.remediation INTO v_remediation
  FROM jsonb_array_elements(v_item.remediations)
    AS candidate(remediation)
  WHERE candidate.remediation->>'id' = v_remediation_id
  LIMIT 1;

  RETURN QUERY SELECT
    true,
    COALESCE(
      v_request.status IN ('in_progress', 'completed')
      AND v_request.app_id = v_item.scope_agent_id
      AND v_request.request_payload->>'routineId' = p_routine_id::text
      AND v_item.item_class = 'issue'
      AND v_item.scope_routine_id = p_routine_id
      AND v_item.source_key = 'routine.health:' || p_routine_id::text
      AND v_item.diagnosis->>'code' = 'ROUTINE_PAUSED_AFTER_FAILURES'
      AND v_item.recovery_mode = 'successful_verification'
      AND v_remediation->>'key' = 'run_once'
      AND v_remediation->>'presentation' = 'execute'
      AND v_remediation->>'requiredAuthority' = 'agent_operate'
      AND v_remediation->>'sideEffect' = 'routine_execution'
      AND v_remediation->'target' = jsonb_build_object(
        'kind', 'routine',
        'agentId', v_item.scope_agent_id::text,
        'routineId', p_routine_id::text
      )
      AND EXISTS (
        SELECT 1
        FROM public.routine_runs AS runs
        WHERE runs.id = p_run_id
          AND runs.user_id = p_user_id
          AND runs.routine_id = p_routine_id
          AND runs.agent_home_action_request_id = p_action_request_id
          AND runs.max_attempts = 1
      )
      AND EXISTS (
        SELECT 1
        FROM public.operator_item_affected_agents AS affected
        WHERE affected.user_id = p_user_id
          AND affected.item_id = v_item.id
          AND affected.agent_id = v_item.scope_agent_id
          AND affected.blocking
      ),
      false
    ),
    v_item.id;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_operator_item_routine_run_once(
  uuid, uuid, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.queue_operator_item_routine_run_once(
  uuid, uuid, uuid, uuid, uuid, text, uuid, bigint
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.authorize_operator_item_routine_run_once(
  uuid, uuid, uuid, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.resolve_operator_item_routine_run_once(
  uuid, uuid, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.queue_operator_item_routine_run_once(
  uuid, uuid, uuid, uuid, uuid, text, uuid, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.authorize_operator_item_routine_run_once(
  uuid, uuid, uuid, uuid
) TO service_role;

COMMENT ON FUNCTION public.queue_operator_item_routine_run_once(
  uuid, uuid, uuid, uuid, uuid, text, uuid, bigint
) IS
  'Queues one real, non-retrying verification run for an active canonical paused-routine issue; never resumes its schedule.';
