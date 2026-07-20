-- Private token gateway, artifact CAS, and reconciliation paths.

CREATE OR REPLACE FUNCTION public.introspect_compute_job_token(
  p_lookup_id uuid,
  p_token_digest text,
  p_audience text,
  p_container_id text
) RETURNS TABLE (
  allowed boolean,
  code text,
  run_id uuid,
  agent_id uuid,
  user_id uuid,
  caller_function text,
  authority_id uuid,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token public.compute_job_tokens%ROWTYPE;
  v_run public.compute_runs%ROWTYPE;
  v_policy public.compute_agent_policies%ROWTYPE;
BEGIN
  IF p_lookup_id IS NULL OR p_token_digest IS NULL
     OR p_audience IS NULL OR p_container_id IS NULL THEN
    RETURN QUERY SELECT false, 'token_invalid', NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT token.* INTO v_token FROM public.compute_job_tokens AS token
  WHERE token.lookup_id = p_lookup_id
  FOR UPDATE;
  IF NOT FOUND OR v_token.token_digest IS DISTINCT FROM p_token_digest THEN
    RETURN QUERY SELECT false, 'token_invalid', NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT run.* INTO v_run FROM public.compute_runs AS run
  WHERE run.id = v_token.run_id;
  IF v_token.audience IS DISTINCT FROM p_audience THEN
    RETURN QUERY SELECT false, 'audience_mismatch', v_run.id, v_run.agent_id,
      v_run.user_id, v_run.caller_function, NULL::uuid, v_token.expires_at;
    RETURN;
  END IF;
  IF v_token.status <> 'active' THEN
    RETURN QUERY SELECT false, 'token_revoked', v_run.id, v_run.agent_id,
      v_run.user_id, v_run.caller_function, NULL::uuid, v_token.expires_at;
    RETURN;
  END IF;
  IF v_token.gateway_request_count >= 10000 THEN
    RETURN QUERY SELECT false, 'lease_rate_limited', v_run.id, v_run.agent_id,
      v_run.user_id, v_run.caller_function, NULL::uuid, v_token.expires_at;
    RETURN;
  END IF;
  IF v_token.expires_at <= now() THEN
    UPDATE public.compute_job_tokens SET status = 'expired', revoked_at = now()
    WHERE id = v_token.id AND status = 'active';
    RETURN QUERY SELECT false, 'token_expired', v_run.id, v_run.agent_id,
      v_run.user_id, v_run.caller_function, NULL::uuid, v_token.expires_at;
    RETURN;
  END IF;
  IF v_run.container_id IS NULL
     OR v_run.container_id IS DISTINCT FROM p_container_id THEN
    RETURN QUERY SELECT false, 'container_mismatch', v_run.id, v_run.agent_id,
      v_run.user_id, v_run.caller_function, NULL::uuid, v_token.expires_at;
    RETURN;
  END IF;
  IF v_run.state <> 'running'
     OR v_run.lease_id IS DISTINCT FROM v_token.lease_id
     OR v_run.claim_expires_at IS NULL
     OR v_run.claim_expires_at <= now()
     OR v_run.stop_requested_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'run_not_active', v_run.id, v_run.agent_id,
      v_run.user_id, v_run.caller_function, NULL::uuid, v_token.expires_at;
    RETURN;
  END IF;
  -- A token is never sufficient evidence that its Agent still exists or is
  -- still owned by the snapshotted principal.
  IF NOT EXISTS (
    SELECT 1
    FROM public.apps AS app
    WHERE app.id = v_run.agent_id AND app.owner_id = v_run.user_id
      AND app.deleted_at IS NULL
  ) THEN
    RETURN QUERY SELECT false, 'agent_not_active', v_run.id, v_run.agent_id,
      v_run.user_id, v_run.caller_function, NULL::uuid, v_token.expires_at;
    RETURN;
  END IF;
  SELECT policy.* INTO v_policy FROM public.compute_agent_policies AS policy
  WHERE policy.agent_id = v_run.agent_id AND policy.user_id = v_run.user_id;
  IF NOT FOUND OR NOT v_policy.enabled OR v_policy.state <> 'active' THEN
    RETURN QUERY SELECT false, 'agent_not_active', v_run.id, v_run.agent_id,
      v_run.user_id, v_run.caller_function, NULL::uuid, v_token.expires_at;
    RETURN;
  END IF;
  IF v_policy.authority_epoch IS DISTINCT FROM v_run.authority_epoch THEN
    RETURN QUERY SELECT false, 'policy_changed', v_run.id, v_run.agent_id,
      v_run.user_id, v_run.caller_function, NULL::uuid, v_token.expires_at;
    RETURN;
  END IF;
  UPDATE public.compute_job_tokens
  SET gateway_request_count = gateway_request_count + 1,
      last_seen_at = CASE
        WHEN last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute'
          THEN now()
        ELSE last_seen_at
      END
  WHERE id = v_token.id;
  RETURN QUERY SELECT true, 'ok', v_run.id, v_run.agent_id, v_run.user_id,
    v_run.caller_function, NULL::uuid, v_token.expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.authorize_compute_job_token(
  p_lookup_id uuid,
  p_token_digest text,
  p_audience text,
  p_container_id text,
  p_action text,
  p_resource_kind text,
  p_target_agent_id uuid,
  p_target_function text,
  p_constraints jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (
  allowed boolean,
  code text,
  run_id uuid,
  agent_id uuid,
  user_id uuid,
  caller_function text,
  authority_id uuid,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_principal record;
  v_authority public.compute_run_authorities%ROWTYPE;
BEGIN
  SELECT * INTO v_principal FROM public.introspect_compute_job_token(
    p_lookup_id, p_token_digest, p_audience, p_container_id
  );
  IF NOT v_principal.allowed THEN
    RETURN QUERY SELECT v_principal.allowed, v_principal.code,
      v_principal.run_id, v_principal.agent_id, v_principal.user_id,
      v_principal.caller_function, NULL::uuid, v_principal.expires_at;
    RETURN;
  END IF;
  IF p_constraints IS NULL OR jsonb_typeof(p_constraints) <> 'object'
     OR NOT public.compute_authority_shape_valid(
       p_action, p_resource_kind, p_target_agent_id, p_target_function
     ) THEN
    RETURN QUERY SELECT false, 'authority_denied', v_principal.run_id,
      v_principal.agent_id, v_principal.user_id, v_principal.caller_function,
      NULL::uuid, v_principal.expires_at;
    RETURN;
  END IF;
  SELECT authority.* INTO v_authority
  FROM public.compute_run_authorities AS authority
  WHERE authority.run_id = v_principal.run_id
    AND authority.action = p_action
    AND authority.resource_kind = p_resource_kind
    AND authority.target_agent_id IS NOT DISTINCT FROM p_target_agent_id
    AND authority.target_function IS NOT DISTINCT FROM p_target_function
    AND authority.constraints = p_constraints;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'authority_denied', v_principal.run_id,
      v_principal.agent_id, v_principal.user_id, v_principal.caller_function,
      NULL::uuid, v_principal.expires_at;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, 'ok', v_principal.run_id, v_principal.agent_id,
    v_principal.user_id, v_principal.caller_function, v_authority.id,
    v_principal.expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_compute_job_token_authorities(
  p_lookup_id uuid,
  p_token_digest text,
  p_audience text,
  p_container_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_principal record; v_authorities jsonb;
BEGIN
  SELECT * INTO v_principal FROM public.introspect_compute_job_token(
    p_lookup_id, p_token_digest, p_audience, p_container_id
  );
  IF NOT v_principal.allowed THEN
    RETURN to_jsonb(v_principal) || jsonb_build_object('authorities', '[]'::jsonb);
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', authority.id,
    'action', authority.action,
    'resource_kind', authority.resource_kind,
    'target_agent_id', authority.target_agent_id,
    'target_function', authority.target_function,
    'constraints', authority.constraints
  ) ORDER BY authority.action, authority.target_function), '[]'::jsonb)
  INTO v_authorities
  FROM public.compute_run_authorities AS authority
  WHERE authority.run_id = v_principal.run_id;
  RETURN to_jsonb(v_principal) || jsonb_build_object('authorities', v_authorities);
END;
$$;

CREATE OR REPLACE FUNCTION public.register_compute_artifact(
  p_artifact_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_run_id uuid,
  p_user_id uuid,
  p_agent_id uuid,
  p_caller_function text,
  p_storage_key text,
  p_direction text,
  p_logical_name text,
  p_media_type text,
  p_sha256 text,
  p_size_bytes bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.compute_runs%ROWTYPE;
  v_existing public.compute_artifacts%ROWTYPE;
  v_artifact public.compute_artifacts%ROWTYPE;
  v_mount_path text;
  v_prefix text;
  v_output_count integer;
  v_output_bytes bigint;
BEGIN
  IF p_artifact_id IS NULL OR p_idempotency_key IS NULL
     OR p_request_hash IS NULL OR p_run_id IS NULL OR p_user_id IS NULL
     OR p_agent_id IS NULL OR p_caller_function IS NULL
     OR p_storage_key IS NULL OR p_direction IS NULL
     OR p_logical_name IS NULL OR p_media_type IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_ARTIFACT',
      'message', 'Artifact registration requires exact non-null metadata.'
    )::text;
  END IF;
  SELECT run.* INTO v_run FROM public.compute_runs AS run
  WHERE run.id = p_run_id AND run.user_id = p_user_id
    AND run.agent_id = p_agent_id AND run.caller_function = p_caller_function
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_NOT_FOUND', 'message', 'Compute run not found.'
    )::text;
  END IF;
  IF p_direction <> 'output' OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
     OR p_size_bytes IS NULL OR p_size_bytes < 0
     OR length(p_logical_name) NOT BETWEEN 1 AND 512
     OR p_logical_name ~ '(^/|\\|[[:cntrl:]]|//)'
     OR p_logical_name ~ '(^|/)(\.|\.\.)(/|$)' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_ARTIFACT', 'message', 'Artifact metadata is invalid.'
    )::text;
  END IF;

  SELECT artifact.* INTO v_existing FROM public.compute_artifacts AS artifact
  WHERE artifact.run_id = p_run_id AND artifact.direction = p_direction
    AND artifact.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_IDEMPOTENCY_CONFLICT',
        'message', 'Artifact idempotency key has different metadata.'
      )::text;
    END IF;
    RETURN to_jsonb(v_existing) || jsonb_build_object('replayed', true);
  END IF;

  IF v_run.state <> 'running' OR v_run.stop_requested_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_OUTPUTS_FROZEN',
      'message', 'gx artifact uploads require an active running lease.'
    )::text;
  END IF;
  v_mount_path := NULL;
  v_prefix := 'compute-v1/' || p_user_id::text || '/' || p_agent_id::text ||
    '/' || p_run_id::text || '/outputs/';
  IF left(p_storage_key, length(v_prefix)) <> v_prefix
     OR substring(p_storage_key FROM length(v_prefix) + 1) = ''
     OR p_storage_key ~ '(^|/)(\.|\.\.)(/|$)' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_SCOPE_VIOLATION',
      'message', 'Artifact object key escapes the exact tenant/run scope.'
    )::text;
  END IF;

  SELECT count(*), COALESCE(sum(COALESCE(size_bytes, 0)), 0)
  INTO v_output_count, v_output_bytes
  FROM public.compute_artifacts
  WHERE run_id = p_run_id AND state <> 'deleted';
  IF v_output_count + 1 > (v_run.policy_limits_snapshot->>'maxArtifacts')::integer
     OR v_output_bytes + COALESCE(p_size_bytes, 0) >
       (v_run.policy_limits_snapshot->>'maxArtifactBytes')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_LIMIT_EXCEEDED',
      'message', 'Aggregate input/output artifacts exceed the owner-confirmed limits.'
    )::text;
  END IF;
  -- Deleted attempts remain durable abuse accounting. Normal idempotent replay
  -- returned above and consumes no additional attempt.
  SELECT count(*), COALESCE(sum(COALESCE(size_bytes, 0)), 0)
  INTO v_output_count, v_output_bytes
  FROM public.compute_artifacts
  WHERE run_id = p_run_id AND direction = 'output';
  IF v_output_count + 1 >
       ((v_run.policy_limits_snapshot->>'maxArtifacts')::integer * 4 + 20)
     OR v_output_bytes + COALESCE(p_size_bytes, 0) >
       ((v_run.policy_limits_snapshot->>'maxArtifactBytes')::bigint * 4) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_ATTEMPT_LIMIT_EXCEEDED',
      'message', 'The lease exhausted its durable artifact upload-attempt budget.'
    )::text;
  END IF;

  INSERT INTO public.compute_artifacts (
    id, run_id, user_id, source_artifact_id, idempotency_key, request_hash, direction,
    mount_path, logical_name, media_type, storage_key, sha256, size_bytes
  ) VALUES (
    p_artifact_id, p_run_id, p_user_id, NULL, p_idempotency_key, p_request_hash,
    p_direction, v_mount_path, p_logical_name, lower(p_media_type),
    p_storage_key, p_sha256, p_size_bytes
  ) RETURNING * INTO v_artifact;
  RETURN to_jsonb(v_artifact) || jsonb_build_object('replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_compute_artifact(
  p_artifact_id uuid,
  p_run_id uuid,
  p_user_id uuid,
  p_agent_id uuid,
  p_caller_function text,
  p_expected_state text,
  p_expected_state_version bigint,
  p_to_state text,
  p_sha256 text,
  p_size_bytes bigint
) RETURNS SETOF public.compute_artifacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.compute_runs%ROWTYPE;
  v_artifact public.compute_artifacts%ROWTYPE;
  v_ready_count integer;
  v_ready_bytes bigint;
BEGIN
  IF p_artifact_id IS NULL OR p_run_id IS NULL OR p_user_id IS NULL
     OR p_agent_id IS NULL OR p_caller_function IS NULL
     OR p_expected_state IS NULL OR p_expected_state_version IS NULL
     OR p_to_state IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_CONFLICT',
      'message', 'Artifact transition requires an exact non-null CAS.'
    )::text;
  END IF;
  SELECT run.* INTO v_run FROM public.compute_runs AS run
  WHERE run.id = p_run_id AND run.user_id = p_user_id
    AND run.agent_id = p_agent_id AND run.caller_function = p_caller_function
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_NOT_FOUND', 'message', 'Compute run not found.'
    )::text;
  END IF;
  SELECT artifact.* INTO v_artifact FROM public.compute_artifacts AS artifact
  WHERE artifact.id = p_artifact_id AND artifact.run_id = p_run_id
    AND artifact.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR v_artifact.state IS DISTINCT FROM p_expected_state
     OR v_artifact.state_version IS DISTINCT FROM p_expected_state_version
     OR NOT (
       (p_expected_state = 'pending' AND p_to_state IN ('ready', 'deleted'))
       OR (p_expected_state = 'ready' AND p_to_state = 'deleted')
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_CONFLICT', 'message', 'Artifact CAS failed.'
    )::text;
  END IF;
  IF v_artifact.direction = 'output' AND p_to_state = 'ready'
     AND (v_run.state <> 'running' OR v_run.stop_requested_at IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_OUTPUTS_FROZEN',
      'message', 'Output artifact mutation requires an active running lease.'
    )::text;
  END IF;
  IF p_to_state = 'ready' AND (
    p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
    OR p_size_bytes IS NULL OR p_size_bytes < 0
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_ARTIFACT',
      'message', 'A ready artifact requires exact digest and size.'
    )::text;
  END IF;
  IF p_to_state = 'ready' THEN
    SELECT count(*) + 1,
      COALESCE(sum(COALESCE(size_bytes, 0)), 0) + p_size_bytes
    INTO v_ready_count, v_ready_bytes
    FROM public.compute_artifacts
    WHERE run_id = p_run_id AND state <> 'deleted'
      AND id <> p_artifact_id;
    IF v_ready_count > (v_run.policy_limits_snapshot->>'maxArtifacts')::integer
       OR v_ready_bytes > (v_run.policy_limits_snapshot->>'maxArtifactBytes')::bigint THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_ARTIFACT_LIMIT_EXCEEDED',
        'message', 'Aggregate input/output artifacts exceed the owner-confirmed limits.'
      )::text;
    END IF;
  END IF;
  UPDATE public.compute_artifacts AS artifact
  SET state = p_to_state, state_version = artifact.state_version + 1,
      sha256 = CASE WHEN p_to_state = 'ready' THEN p_sha256 ELSE artifact.sha256 END,
      size_bytes = CASE WHEN p_to_state = 'ready' THEN p_size_bytes ELSE artifact.size_bytes END,
      updated_at = now()
  WHERE artifact.id = p_artifact_id RETURNING * INTO v_artifact;
  RETURN NEXT v_artifact;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_compute_run_cancellation(
  p_run_id uuid,
  p_user_id uuid,
  p_agent_id uuid,
  p_caller_function text,
  p_reason text DEFAULT 'owner_cancelled'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_run public.compute_runs%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 1024
     OR p_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_STOP_REASON', 'message', 'Stop reason is invalid.'
    )::text;
  END IF;
  SELECT run.* INTO v_run
  FROM public.compute_runs AS run
  WHERE run.id = p_run_id AND run.user_id = p_user_id
    AND run.agent_id = p_agent_id AND run.caller_function = p_caller_function
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_NOT_FOUND', 'message', 'Compute run not found.'
    )::text;
  END IF;
  IF v_run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
     OR v_run.stop_requested_at IS NOT NULL THEN
    RETURN to_jsonb(v_run) || jsonb_build_object('replayed', true);
  END IF;
  UPDATE public.compute_runs AS run
  SET stop_requested_at = now(), stop_reason = p_reason,
      state_version = run.state_version + 1, updated_at = now()
  WHERE run.id = p_run_id RETURNING * INTO v_run;
  RETURN to_jsonb(v_run) || jsonb_build_object('replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.terminalize_compute_internal(
  p_run_id uuid,
  p_outcome text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.compute_runs%ROWTYPE;
  v_budget public.compute_run_budget_reservations%ROWTYPE;
  v_wall_ms bigint := NULL;
BEGIN
  SELECT run.* INTO v_run FROM public.compute_runs AS run
  WHERE run.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked') THEN
    RETURN to_jsonb(v_run) || jsonb_build_object(
      'receipt', (SELECT to_jsonb(receipt) FROM public.compute_run_receipts AS receipt
        WHERE receipt.run_id = v_run.id),
      'replayed', true
    );
  END IF;
  IF p_outcome IS NULL
     OR p_outcome NOT IN ('failed', 'cancelled', 'expired', 'revoked') THEN
    RAISE EXCEPTION 'invalid internal Compute outcome';
  END IF;
  IF v_run.state = 'running' THEN
    SELECT budget.* INTO v_budget FROM public.compute_run_budget_reservations AS budget
    WHERE budget.run_id = v_run.id;
    IF FOUND THEN
      -- No trustworthy metrics survived. Settle the complete wallet-backed
      -- hold, including the teardown allowance already represented by the
      -- worker-wall contract. Unknown metrics must never release reserve.
      v_wall_ms := v_budget.reserved_wall_ms;
    END IF;
  END IF;
  RETURN public.transition_compute_run(
    v_run.id, v_run.user_id, v_run.agent_id, v_run.caller_function,
    v_run.claim_id, v_run.state, v_run.state_version, p_outcome, v_wall_ms,
    left(p_reason, 1024), jsonb_build_object('error', left(p_reason, 1024))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.terminalize_compute_run_cancellation(
  p_run_id uuid,
  p_user_id uuid,
  p_agent_id uuid,
  p_caller_function text,
  p_expected_state_version bigint,
  p_body_destroyed boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_run public.compute_runs%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR p_user_id IS NULL OR p_agent_id IS NULL
     OR p_caller_function IS NULL OR p_expected_state_version IS NULL
     OR p_body_destroyed IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_CONFLICT',
      'message', 'Cancellation terminalization requires an exact non-null fence.'
    )::text;
  END IF;
  SELECT run.* INTO v_run
  FROM public.compute_runs AS run
  WHERE run.id = p_run_id AND run.user_id = p_user_id
    AND run.agent_id = p_agent_id AND run.caller_function = p_caller_function
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_NOT_FOUND', 'message', 'Compute run not found.'
    )::text;
  END IF;
  IF v_run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked') THEN
    RETURN to_jsonb(v_run) || jsonb_build_object(
      'receipt', (SELECT to_jsonb(receipt)
        FROM public.compute_run_receipts AS receipt
        WHERE receipt.run_id = v_run.id),
      'replayed', true
    );
  END IF;
  IF v_run.stop_requested_at IS NULL
     OR v_run.state_version IS DISTINCT FROM p_expected_state_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_CONFLICT',
      'message', 'Cancellation fence or state version does not match.'
    )::text;
  END IF;
  IF v_run.state IN ('provisioning', 'running')
     AND p_body_destroyed IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_BODY_DESTRUCTION_REQUIRED',
      'message', 'Destroy the deterministic Sandbox before cancellation settlement.'
    )::text;
  END IF;
  RETURN public.terminalize_compute_internal(
    v_run.id, 'cancelled', COALESCE(v_run.stop_reason, 'owner_cancelled')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.list_stale_compute_runs(
  p_now timestamptz DEFAULT now(),
  p_limit integer DEFAULT 100
) RETURNS TABLE (
  run_id uuid,
  user_id uuid,
  agent_id uuid,
  caller_function text,
  state text,
  state_version bigint,
  claim_id uuid,
  lease_id uuid,
  container_id text,
  expires_at timestamptz,
  claim_expires_at timestamptz,
  stop_requested_at timestamptz,
  stop_reason text,
  requires_body_destroy boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF p_now IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid reconcile inputs';
  END IF;
  RETURN QUERY
    SELECT run.id, run.user_id, run.agent_id, run.caller_function, run.state,
      run.state_version, run.claim_id, run.lease_id, run.container_id,
      run.expires_at, run.claim_expires_at, run.stop_requested_at,
      run.stop_reason,
      run.state IN ('provisioning', 'running')
    FROM public.compute_runs AS run
    WHERE (
      run.state IN ('admitted', 'queued') AND run.expires_at <= p_now
    ) OR (
      run.state IN ('provisioning', 'running')
      AND (run.claim_expires_at <= p_now OR run.expires_at <= p_now)
    )
    ORDER BY run.created_at
    LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.fence_stale_compute_run(
  p_run_id uuid,
  p_expected_state text,
  p_expected_state_version bigint,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_run public.compute_runs%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR p_expected_state IS NULL
     OR p_expected_state_version IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_CONFLICT',
      'message', 'Stale-run fencing requires an exact non-null candidate.'
    )::text;
  END IF;
  SELECT run.* INTO v_run
  FROM public.compute_runs AS run
  WHERE run.id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked') THEN
    RETURN to_jsonb(v_run) || jsonb_build_object(
      'receipt', (SELECT to_jsonb(receipt)
        FROM public.compute_run_receipts AS receipt
        WHERE receipt.run_id = v_run.id),
      'replayed', true
    );
  END IF;
  IF v_run.state IS DISTINCT FROM p_expected_state
     OR v_run.state_version IS DISTINCT FROM p_expected_state_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_CONFLICT',
      'message', 'The stale Compute candidate changed before fencing.'
    )::text;
  END IF;
  IF NOT (
    (v_run.state IN ('admitted', 'queued') AND v_run.expires_at <= p_now)
    OR (v_run.state IN ('provisioning', 'running')
      AND (v_run.claim_expires_at <= p_now OR v_run.expires_at <= p_now))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_NOT_STALE', 'message', 'The Compute run is no longer stale.'
    )::text;
  END IF;
  IF v_run.stop_requested_at IS NOT NULL THEN
    RETURN to_jsonb(v_run) || jsonb_build_object('replayed', true);
  END IF;
  UPDATE public.compute_runs AS run
  SET stop_requested_at = now(), stop_reason = 'compute_lease_expired',
      state_version = run.state_version + 1, updated_at = now()
  WHERE run.id = p_run_id RETURNING * INTO v_run;
  RETURN to_jsonb(v_run) || jsonb_build_object('replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.terminalize_stale_compute_run(
  p_run_id uuid,
  p_expected_state text,
  p_expected_state_version bigint,
  p_body_destroyed boolean,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_run public.compute_runs%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR p_expected_state IS NULL
     OR p_expected_state_version IS NULL OR p_body_destroyed IS NULL
     OR p_now IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_CONFLICT',
      'message', 'Stale-run terminalization requires an exact non-null fence.'
    )::text;
  END IF;
  SELECT run.* INTO v_run
  FROM public.compute_runs AS run
  WHERE run.id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked') THEN
    RETURN to_jsonb(v_run) || jsonb_build_object(
      'receipt', (SELECT to_jsonb(receipt)
        FROM public.compute_run_receipts AS receipt
        WHERE receipt.run_id = v_run.id),
      'replayed', true
    );
  END IF;
  IF v_run.state IS DISTINCT FROM p_expected_state
     OR v_run.state_version IS DISTINCT FROM p_expected_state_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_CONFLICT',
      'message', 'The stale Compute candidate changed before terminalization.'
    )::text;
  END IF;
  IF v_run.stop_requested_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_STOP_FENCE_REQUIRED',
      'message', 'Fence the stale Compute run before destroying its body.'
    )::text;
  END IF;
  IF NOT (
    (v_run.state IN ('admitted', 'queued') AND v_run.expires_at <= p_now)
    OR (v_run.state IN ('provisioning', 'running')
      AND (v_run.claim_expires_at <= p_now OR v_run.expires_at <= p_now))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_NOT_STALE',
      'message', 'The Compute run is no longer stale.'
    )::text;
  END IF;
  IF v_run.state IN ('provisioning', 'running')
     AND p_body_destroyed IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_BODY_DESTRUCTION_REQUIRED',
      'message', 'Destroy the deterministic Sandbox before settlement.'
    )::text;
  END IF;
  RETURN public.terminalize_compute_internal(
    v_run.id, 'expired', 'compute_lease_expired'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fence_compute_dlq_run(
  p_run_id uuid,
  p_reason text DEFAULT 'compute_dispatch_dlq'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_run public.compute_runs%ROWTYPE;
BEGIN
  IF length(p_reason) NOT BETWEEN 1 AND 1024 OR p_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_STOP_REASON', 'message', 'DLQ reason is invalid.'
    )::text;
  END IF;
  SELECT run.* INTO v_run FROM public.compute_runs AS run
  WHERE run.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked') THEN
    RETURN to_jsonb(v_run) || jsonb_build_object(
      'receipt', (SELECT to_jsonb(receipt)
        FROM public.compute_run_receipts AS receipt
        WHERE receipt.run_id = v_run.id),
      'requires_body_destroy', false,
      'replayed', true
    );
  END IF;
  IF v_run.stop_requested_at IS NOT NULL
     AND v_run.stop_reason NOT LIKE 'compute_dispatch_dlq%' THEN
    -- Another control-plane flow owns this stop fence. The DLQ consumer must
    -- acknowledge and leave destruction/settlement to that owner.
    RETURN to_jsonb(v_run) || jsonb_build_object(
      'receipt', NULL,
      'requires_body_destroy', false,
      'skipped', true,
      'skip_reason', 'foreign_stop_fence',
      'acknowledge', true,
      'replayed', true
    );
  END IF;
  IF v_run.stop_requested_at IS NOT NULL THEN
    RETURN to_jsonb(v_run) || jsonb_build_object(
      'receipt', NULL,
      'requires_body_destroy', v_run.state IN ('provisioning', 'running'),
      'skipped', false,
      'replayed', true
    );
  END IF;
  UPDATE public.compute_runs AS run
  SET stop_requested_at = now(),
      stop_reason = left(COALESCE(p_reason, 'compute_dispatch_dlq'), 1024),
      state_version = run.state_version + 1, updated_at = now()
  WHERE run.id = p_run_id RETURNING * INTO v_run;
  RETURN to_jsonb(v_run) || jsonb_build_object(
    'requires_body_destroy', v_run.state IN ('provisioning', 'running'),
    'skipped', false,
    'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.terminalize_compute_dlq_run(
  p_run_id uuid,
  p_expected_state_version bigint,
  p_body_destroyed boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_run public.compute_runs%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR p_expected_state_version IS NULL
     OR p_body_destroyed IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_CONFLICT',
      'message', 'DLQ terminalization requires an exact non-null fence.'
    )::text;
  END IF;
  SELECT run.* INTO v_run FROM public.compute_runs AS run
  WHERE run.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked') THEN
    RETURN to_jsonb(v_run) || jsonb_build_object(
      'receipt', (SELECT to_jsonb(receipt)
        FROM public.compute_run_receipts AS receipt
        WHERE receipt.run_id = v_run.id),
      'replayed', true
    );
  END IF;
  IF v_run.state_version IS DISTINCT FROM p_expected_state_version
     OR v_run.stop_requested_at IS NULL
     OR v_run.stop_reason NOT LIKE 'compute_dispatch_dlq%' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_CONFLICT',
      'message', 'DLQ fence or state version does not match.'
    )::text;
  END IF;
  IF v_run.state IN ('provisioning', 'running')
     AND p_body_destroyed IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_BODY_DESTRUCTION_REQUIRED',
      'message', 'Destroy the deterministic Sandbox before DLQ settlement.'
    )::text;
  END IF;
  RETURN public.terminalize_compute_internal(
    p_run_id, 'failed', v_run.stop_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.introspect_compute_job_token(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.authorize_compute_job_token(
  uuid, text, text, text, text, text, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_compute_job_token_authorities(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_compute_artifact(
  uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text, text, bigint
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_compute_artifact(
  uuid, uuid, uuid, uuid, text, text, bigint, text, text, bigint
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_compute_run_cancellation(
  uuid, uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.terminalize_compute_run_cancellation(
  uuid, uuid, uuid, text, bigint, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.terminalize_compute_internal(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_stale_compute_runs(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fence_stale_compute_run(uuid, text, bigint, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.terminalize_stale_compute_run(
  uuid, text, bigint, boolean, timestamptz
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fence_compute_dlq_run(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.terminalize_compute_dlq_run(uuid, bigint, boolean)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.introspect_compute_job_token(uuid, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.authorize_compute_job_token(
  uuid, text, text, text, text, text, uuid, text, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_compute_job_token_authorities(uuid, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.register_compute_artifact(
  uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, text, text, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_compute_artifact(
  uuid, uuid, uuid, uuid, text, text, bigint, text, text, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_compute_run_cancellation(
  uuid, uuid, uuid, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.terminalize_compute_run_cancellation(
  uuid, uuid, uuid, text, bigint, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_stale_compute_runs(timestamptz, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fence_stale_compute_run(uuid, text, bigint, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.terminalize_stale_compute_run(
  uuid, text, bigint, boolean, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.fence_compute_dlq_run(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.terminalize_compute_dlq_run(uuid, bigint, boolean)
  TO service_role;
