-- Transactional/idempotent Compute admission and lease lifecycle.
-- Reservation calls the existing wallet-backed cloud usage hold primitive in
-- the same transaction; a Compute row can never claim a shadow reservation.
-- Lock-order invariant: before taking policy/run row locks, admission, claim,
-- and prepare use the same per-owner+Agent advisory lock as policy mutations.

CREATE OR REPLACE FUNCTION public.admit_compute_run(
  p_idempotency_key uuid,
  p_request_hash text,
  p_user_id uuid,
  p_agent_id uuid,
  p_caller_function text,
  p_execution_id text,
  p_directive_hash text,
  p_profile text,
  p_environment_digest text,
  p_execution_request jsonb,
  p_manifest_ceiling jsonb,
  p_expires_at timestamptz,
  p_authorities jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_policy public.compute_agent_policies%ROWTYPE;
  v_existing public.compute_runs%ROWTYPE;
  v_run public.compute_runs%ROWTYPE;
  v_authority jsonb;
  v_rule public.compute_agent_authority_rules%ROWTYPE;
  v_secret_id text;
  v_requested_input jsonb;
  v_source_artifact public.compute_artifacts%ROWTYPE;
  v_input_bytes bigint := 0;
  v_manifest_tools text[];
  v_manifest_timeout integer;
  v_manifest_revision text;
  v_execution_admissions bigint;
  v_pending_admissions bigint;
  v_recent_admissions bigint;
  c_max_runs_per_execution constant integer := 16;
  c_max_pending_runs_per_agent constant integer := 64;
  c_max_admissions_per_agent_minute constant integer := 60;
BEGIN
  IF p_idempotency_key IS NULL
     OR p_request_hash IS NULL
     OR p_user_id IS NULL
     OR p_agent_id IS NULL
     OR p_caller_function IS NULL
     OR p_directive_hash IS NULL
     OR p_profile IS NULL
     OR p_environment_digest IS NULL
     OR p_execution_request IS NULL
     OR p_expires_at IS NULL
     OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR p_directive_hash !~ '^[0-9a-f]{64}$'
     OR p_environment_digest !~ '^sha256:[0-9a-f]{64}$'
     OR p_profile <> 'developer-v1'
     OR p_caller_function !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'
     OR (p_execution_id IS NOT NULL AND p_execution_id !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
     OR NOT public.compute_execution_request_valid(p_execution_request)
     OR p_expires_at <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_ADMISSION',
      'message', 'The canonical developer-v1 admission request is invalid.'
    )::text;
  END IF;
  IF p_authorities IS NULL OR jsonb_typeof(p_authorities) <> 'array'
     OR jsonb_array_length(p_authorities) > 256 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_AUTHORITIES',
      'message', 'authorities must be an array with at most 256 exact entries.'
    )::text;
  END IF;
  IF p_manifest_ceiling IS NULL OR jsonb_typeof(p_manifest_ceiling) <> 'object'
     OR NOT p_manifest_ceiling ?& ARRAY['allowedTools', 'maxTimeoutMs', 'revision']
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_manifest_ceiling) AS key
       WHERE key <> ALL (ARRAY['allowedTools', 'maxTimeoutMs', 'revision'])
     ) OR jsonb_typeof(p_manifest_ceiling->'allowedTools') <> 'array'
     OR jsonb_typeof(p_manifest_ceiling->'maxTimeoutMs') NOT IN ('number', 'string')
     OR jsonb_typeof(p_manifest_ceiling->'revision') <> 'string'
     OR jsonb_array_length(p_manifest_ceiling->'allowedTools') NOT BETWEEN 1 AND 64
     OR jsonb_array_length(p_manifest_ceiling->'allowedTools') <> (
       SELECT count(DISTINCT tool)
       FROM jsonb_array_elements_text(p_manifest_ceiling->'allowedTools') AS tool
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(p_manifest_ceiling->'allowedTools') AS tool
       WHERE NOT (tool = ANY (ARRAY[
         'shell', 'browser', 'office', 'media', 'pdf', 'ocr', 'data',
         'databases', 'transfer', 'git', 'coding.claude', 'coding.codex',
         'galactic'
       ]::text[]))
     ) OR (p_manifest_ceiling->>'maxTimeoutMs') !~ '^[0-9]+$'
     OR (p_manifest_ceiling->>'maxTimeoutMs')::bigint NOT BETWEEN 1000 AND 480000
     OR length(btrim(p_manifest_ceiling->>'revision')) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_MANIFEST_CEILING',
      'message', 'The resolved manifest ceiling is invalid.'
    )::text;
  END IF;
  SELECT array_agg(value ORDER BY value)
  INTO v_manifest_tools
  FROM jsonb_array_elements_text(p_manifest_ceiling->'allowedTools');
  v_manifest_timeout := (p_manifest_ceiling->>'maxTimeoutMs')::integer;
  v_manifest_revision := btrim(p_manifest_ceiling->>'revision');

  -- Serialize one exact owner/idempotency key before the replay check. Without
  -- this, two concurrent first admissions can both observe absence and the
  -- loser surfaces a raw unique violation instead of the canonical replay.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  SELECT run.* INTO v_existing
  FROM public.compute_runs AS run
  WHERE run.user_id = p_user_id AND run.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_IDEMPOTENCY_CONFLICT',
        'message', 'The idempotency key was reused with a different request.'
      )::text;
    END IF;
    RETURN to_jsonb(v_existing) || jsonb_build_object('replayed', true);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'compute-agent:' || p_user_id::text || ':' || p_agent_id::text, 0
  ));

  SELECT policy.* INTO v_policy
  FROM public.compute_agent_policies AS policy
  JOIN public.apps AS app ON app.id = policy.agent_id
  JOIN public.users AS owner ON owner.id = policy.user_id
  WHERE policy.agent_id = p_agent_id AND policy.user_id = p_user_id
    AND app.owner_id = p_user_id AND app.deleted_at IS NULL
    AND owner.provisional IS NOT DISTINCT FROM false
  FOR UPDATE OF policy;
  IF NOT FOUND OR NOT v_policy.enabled OR v_policy.state <> 'active'
     OR v_policy.owner_confirmed_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_POLICY_NOT_ENABLED',
      'message', 'The owner-confirmed Compute policy is not active.'
    )::text;
  END IF;

  -- The owner+Agent advisory lock above makes these count-and-insert guards
  -- transactional across concurrent admissions. Exact idempotent replays have
  -- already returned, so only a genuinely new run consumes a slot.
  IF p_execution_id IS NOT NULL THEN
    SELECT count(*) INTO v_execution_admissions
    FROM public.compute_runs AS run
    WHERE run.user_id = p_user_id AND run.agent_id = p_agent_id
      AND run.execution_id = p_execution_id;
    IF v_execution_admissions >= c_max_runs_per_execution THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_EXECUTION_CALL_LIMIT',
        'message', 'This Agent execution has reached its Compute call limit.'
      )::text;
    END IF;
  END IF;

  SELECT count(*) INTO v_pending_admissions
  FROM public.compute_runs AS run
  WHERE run.user_id = p_user_id AND run.agent_id = p_agent_id
    AND run.state IN ('admitted', 'queued');
  IF v_pending_admissions >= c_max_pending_runs_per_agent THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ADMISSION_BACKLOG_LIMIT',
      'message', 'This Agent has too many Compute runs awaiting a lease.'
    )::text;
  END IF;

  SELECT count(*) INTO v_recent_admissions
  FROM public.compute_runs AS run
  WHERE run.user_id = p_user_id AND run.agent_id = p_agent_id
    AND run.created_at >= now() - interval '1 minute';
  IF v_recent_admissions >= c_max_admissions_per_agent_minute THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ADMISSION_RATE_LIMIT',
      'message', 'This Agent is admitting Compute runs too quickly.'
    )::text;
  END IF;

  IF (p_execution_request->>'timeoutMs')::integer > v_policy.max_timeout_ms
     OR (p_execution_request->>'timeoutMs')::integer > v_manifest_timeout
     OR jsonb_array_length(p_execution_request->'inputArtifacts')
        + jsonb_array_length(p_execution_request->'capturePaths')
        > v_policy.max_artifacts
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_execution_request->'tools') AS tool
       WHERE NOT ((tool->>'id') = ANY(v_policy.allowed_tools))
          OR NOT ((tool->>'id') = ANY(v_manifest_tools))
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_POLICY_LIMIT_EXCEEDED',
      'message', 'The request exceeds the owner policy or manifest ceiling.'
    )::text;
  END IF;

  FOR v_secret_id IN
    SELECT value FROM jsonb_array_elements_text(
      p_execution_request->'secretBindingIds'
    )
  LOOP
    PERFORM 1
    FROM public.compute_agent_secret_bindings AS binding
    JOIN public.apps AS app ON app.id = binding.agent_id
    WHERE binding.id = v_secret_id::uuid
      AND binding.user_id = p_user_id AND binding.agent_id = p_agent_id
      AND binding.caller_function = p_caller_function
      AND binding.status = 'active'
      AND (binding.expires_at IS NULL OR binding.expires_at > now())
      AND jsonb_typeof(COALESCE(app.env_vars, '{}'::jsonb)) = 'object'
      AND COALESCE(app.env_vars, '{}'::jsonb) ? binding.variable_name;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_SECRET_BINDING_NOT_USABLE',
        'message', 'A requested Agent Variable binding is absent or inactive.'
      )::text;
    END IF;
  END LOOP;

  INSERT INTO public.compute_runs (
    user_id, agent_id, caller_function, execution_id, directive_hash, idempotency_key,
    request_hash, profile, environment_digest, execution_request,
    manifest_ceiling, policy_limits_snapshot, authority_epoch, expires_at
  ) VALUES (
    p_user_id, p_agent_id, p_caller_function, p_execution_id, p_directive_hash,
    p_idempotency_key, p_request_hash, p_profile, p_environment_digest,
    p_execution_request,
    jsonb_build_object(
      'allowedTools', to_jsonb(v_manifest_tools),
      'maxTimeoutMs', v_manifest_timeout,
      'revision', v_manifest_revision
    ),
    jsonb_build_object(
      'allowedTools', to_jsonb(v_policy.allowed_tools),
      'maxTimeoutMs', v_policy.max_timeout_ms,
      'maxConcurrency', v_policy.max_concurrency,
      'maxArtifactBytes', v_policy.max_artifact_bytes::text,
      'maxArtifacts', v_policy.max_artifacts,
      'revision', v_policy.revision::text
    ),
    v_policy.authority_epoch, p_expires_at
  ) RETURNING * INTO v_run;

  -- Resolve every source artifact while admission still owns the transaction,
  -- then snapshot an immutable current-run input alias. A later source state or
  -- metadata change cannot retarget what the claimed body receives.
  FOR v_requested_input IN
    SELECT value FROM jsonb_array_elements(p_execution_request->'inputArtifacts')
  LOOP
    SELECT artifact.* INTO v_source_artifact
    FROM public.compute_artifacts AS artifact
    JOIN public.compute_runs AS source_run ON source_run.id = artifact.run_id
    WHERE artifact.id = (v_requested_input->>'artifactId')::uuid
      AND artifact.user_id = p_user_id
      AND source_run.user_id = p_user_id
      AND artifact.state = 'ready'
      AND artifact.sha256 IS NOT NULL
      AND artifact.size_bytes IS NOT NULL
    FOR SHARE OF artifact;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_INPUT_ARTIFACT_NOT_READY',
        'message', 'Every input artifact must be an exact ready artifact owned by the user.'
      )::text;
    END IF;
    v_input_bytes := v_input_bytes + v_source_artifact.size_bytes;
    IF v_input_bytes > v_policy.max_artifact_bytes THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_ARTIFACT_LIMIT_EXCEEDED',
        'message', 'Input artifacts exceed the owner-confirmed byte cap.'
      )::text;
    END IF;
    INSERT INTO public.compute_artifacts (
      run_id, user_id, source_artifact_id, idempotency_key, request_hash,
      direction, mount_path, logical_name, media_type, storage_key, sha256,
      size_bytes, state
    ) VALUES (
      v_run.id, p_user_id, v_source_artifact.id, gen_random_uuid(),
      p_request_hash, 'input', v_requested_input->>'mountPath',
      v_requested_input->>'mountPath', v_source_artifact.media_type,
      v_source_artifact.storage_key, v_source_artifact.sha256,
      v_source_artifact.size_bytes, 'ready'
    );
  END LOOP;

  INSERT INTO public.compute_run_authorities (
    run_id, action, resource_kind, constraints, source_kind
  ) VALUES
    (v_run.id, 'artifacts.read', 'run_input', '{}'::jsonb, 'builtin'),
    (v_run.id, 'artifacts.write', 'run_output', '{}'::jsonb, 'builtin'),
    (v_run.id, 'budget.read', 'run', '{}'::jsonb, 'builtin'),
    (v_run.id, 'receipts.read', 'run', '{}'::jsonb, 'builtin');

  FOR v_authority IN SELECT value FROM jsonb_array_elements(p_authorities) LOOP
    IF jsonb_typeof(v_authority) <> 'object'
       OR NOT public.compute_authority_shape_valid(
         v_authority->>'action', v_authority->>'resource_kind',
         NULLIF(v_authority->>'target_agent_id', '')::uuid,
         NULLIF(v_authority->>'target_function', '')
       ) OR jsonb_typeof(COALESCE(v_authority->'constraints', '{}'::jsonb)) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_INVALID_AUTHORITY',
        'message', 'A requested authority does not match the exact v1 grammar.'
      )::text;
    END IF;

    IF v_authority->>'action' IN (
      'artifacts.read', 'artifacts.write', 'budget.read', 'receipts.read'
    ) THEN
      CONTINUE;
    END IF;
    SELECT rule.* INTO v_rule
    FROM public.compute_agent_authority_rules AS rule
    WHERE rule.user_id = p_user_id AND rule.agent_id = p_agent_id
      AND rule.caller_function = p_caller_function
      AND rule.action = v_authority->>'action'
      AND rule.resource_kind = v_authority->>'resource_kind'
      AND rule.target_agent_id IS NOT DISTINCT FROM
        NULLIF(v_authority->>'target_agent_id', '')::uuid
      AND rule.target_function IS NOT DISTINCT FROM
        NULLIF(v_authority->>'target_function', '')
      AND rule.constraints = COALESCE(v_authority->'constraints', '{}'::jsonb)
      AND rule.status = 'active' AND rule.decision = 'always'
      AND (rule.expires_at IS NULL OR rule.expires_at > now())
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_AUTHORITY_DENIED',
        'message', 'The owner policy does not always-allow an exact authority.'
      )::text;
    END IF;
    INSERT INTO public.compute_run_authorities (
      run_id, action, resource_kind, target_agent_id, target_function,
      constraints, source_kind, source_policy_rule_id,
      source_policy_rule_version
    ) VALUES (
      v_run.id, v_rule.action, v_rule.resource_kind, v_rule.target_agent_id,
      v_rule.target_function, v_rule.constraints, 'policy', v_rule.id,
      v_rule.rule_version
    ) ON CONFLICT DO NOTHING;
  END LOOP;

  RETURN to_jsonb(v_run) || jsonb_build_object('replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_compute_run(
  p_run_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_run public.compute_runs%ROWTYPE;
  v_policy public.compute_agent_policies%ROWTYPE;
  v_active integer;
  v_input_artifacts jsonb;
  v_expected_inputs integer;
  v_ready_inputs integer;
  v_input_bytes bigint;
  v_lock_user_id uuid;
  v_lock_agent_id uuid;
BEGIN
  SELECT run.user_id, run.agent_id INTO v_lock_user_id, v_lock_agent_id
  FROM public.compute_runs AS run
  WHERE run.id = p_run_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'compute-agent:' || v_lock_user_id::text || ':' || v_lock_agent_id::text, 0
  ));
  SELECT run.* INTO v_run FROM public.compute_runs AS run
  WHERE run.id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  END IF;
  IF v_run.state IN ('cancelled', 'expired', 'revoked') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'cancelled');
  END IF;
  IF v_run.stop_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'cancelled');
  END IF;
  IF v_run.state NOT IN ('admitted', 'queued') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_claimed');
  END IF;

  SELECT policy.* INTO v_policy
  FROM public.compute_agent_policies AS policy
  WHERE policy.agent_id = v_run.agent_id AND policy.user_id = v_run.user_id
  FOR UPDATE;
  IF NOT FOUND OR NOT v_policy.enabled OR v_policy.state <> 'active'
     OR v_policy.authority_epoch IS DISTINCT FROM v_run.authority_epoch THEN
    UPDATE public.compute_runs AS run
    SET state = 'revoked', state_version = run.state_version + 1,
        finished_at = now(), terminal_reason = 'policy_changed_before_claim',
        updated_at = now()
    WHERE run.id = p_run_id RETURNING * INTO v_run;
    INSERT INTO public.compute_run_receipts (
      id, run_id, user_id, agent_id, outcome, rate_version,
      worker_wall_ms, teardown_allowance_ms, billed_wall_ms,
      reserved_light, actual_light, released_light
    ) VALUES (
      v_run.receipt_id, v_run.id, v_run.user_id, v_run.agent_id, 'revoked',
      'compute-rate-v1', NULL, 0, 0, 0, 0, 0
    ) ON CONFLICT (run_id) DO NOTHING;
    RETURN jsonb_build_object('claimed', false, 'reason', 'cancelled');
  END IF;
  SELECT count(*) INTO v_active FROM public.compute_runs AS active
  WHERE active.user_id = v_run.user_id AND active.agent_id = v_run.agent_id
    AND active.id <> p_run_id AND active.state IN ('provisioning', 'running');
  IF v_active >= v_policy.max_concurrency THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'busy');
  END IF;

  v_expected_inputs := jsonb_array_length(v_run.execution_request->'inputArtifacts');
  SELECT count(*), COALESCE(sum(artifact.size_bytes), 0),
    COALESCE(jsonb_agg(jsonb_build_object(
      'artifact_id', artifact.source_artifact_id,
      'storage_key', artifact.storage_key,
      'mount_path', artifact.mount_path,
      'sha256', artifact.sha256,
      'size_bytes', artifact.size_bytes,
      'media_type', artifact.media_type
    ) ORDER BY artifact.mount_path), '[]'::jsonb)
  INTO v_ready_inputs, v_input_bytes, v_input_artifacts
  FROM public.compute_artifacts AS artifact
  WHERE artifact.run_id = v_run.id
    AND artifact.user_id = v_run.user_id
    AND artifact.direction = 'input'
    AND artifact.source_artifact_id IS NOT NULL
    AND artifact.state = 'ready';
  IF v_ready_inputs IS DISTINCT FROM v_expected_inputs
     OR v_input_bytes > (v_run.policy_limits_snapshot->>'maxArtifactBytes')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INPUTS_NOT_READY',
      'message', 'Every exact input mapping must be ready and within the owner cap.'
    )::text;
  END IF;

  UPDATE public.compute_runs AS run
  SET state = 'provisioning', state_version = run.state_version + 1,
      claim_id = gen_random_uuid(), container_id = NULL,
      claim_expires_at = LEAST(now() + interval '5 minutes', run.expires_at),
      heartbeat_at = now(),
      updated_at = now()
  WHERE run.id = p_run_id RETURNING * INTO v_run;
  RETURN to_jsonb(v_run) || jsonb_build_object(
    'claimed', true,
    'input_artifacts', v_input_artifacts,
    'capture_paths', v_run.execution_request->'capturePaths'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_compute_run_secret_descriptors(
  p_run_id uuid,
  p_container_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.compute_runs%ROWTYPE;
  v_policy public.compute_agent_policies%ROWTYPE;
  v_secret_id text;
  v_binding public.compute_agent_secret_bindings%ROWTYPE;
  v_secret_bindings jsonb := '[]'::jsonb;
BEGIN
  IF p_run_id IS NULL OR p_container_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_CONTAINER_MISMATCH',
      'message', 'Secret materialization requires an exact claimed container.'
    )::text;
  END IF;
  SELECT run.* INTO v_run
  FROM public.compute_runs AS run
  WHERE run.id = p_run_id;
  IF NOT FOUND OR v_run.state NOT IN ('provisioning', 'running')
     OR v_run.stop_requested_at IS NOT NULL
     OR v_run.claim_id IS NULL OR v_run.claim_expires_at <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_NOT_PREPARABLE',
      'message', 'Compute secret descriptors require a live provisioning claim.'
    )::text;
  END IF;
  IF length(btrim(p_container_id)) NOT BETWEEN 1 AND 256
     OR p_container_id ~ '[[:cntrl:]]'
     OR (v_run.state = 'running'
       AND v_run.container_id IS DISTINCT FROM btrim(p_container_id)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_CONTAINER_MISMATCH',
      'message', 'Secret materialization is bound to the claimed container.'
    )::text;
  END IF;
  SELECT policy.* INTO v_policy
  FROM public.compute_agent_policies AS policy
  WHERE policy.agent_id = v_run.agent_id AND policy.user_id = v_run.user_id;
  IF NOT FOUND OR NOT v_policy.enabled OR v_policy.state <> 'active'
     OR v_policy.authority_epoch IS DISTINCT FROM v_run.authority_epoch THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_POLICY_CHANGED',
      'message', 'The Compute policy changed before secret materialization.'
    )::text;
  END IF;

  FOR v_secret_id IN
    SELECT value
    FROM jsonb_array_elements_text(v_run.execution_request->'secretBindingIds')
  LOOP
    SELECT binding.* INTO v_binding
    FROM public.compute_agent_secret_bindings AS binding
    JOIN public.apps AS app ON app.id = binding.agent_id
    WHERE binding.id = v_secret_id::uuid
      AND binding.user_id = v_run.user_id
      AND binding.agent_id = v_run.agent_id
      AND binding.caller_function = v_run.caller_function
      AND binding.status = 'active'
      AND (binding.expires_at IS NULL OR binding.expires_at > now())
      AND jsonb_typeof(COALESCE(app.env_vars, '{}'::jsonb)) = 'object'
      AND COALESCE(app.env_vars, '{}'::jsonb) ? binding.variable_name;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_SECRET_BINDING_CHANGED',
        'message', 'A requested Agent Variable binding changed before prepare.'
      )::text;
    END IF;
    v_secret_bindings := v_secret_bindings || jsonb_build_array(
      jsonb_build_object(
        'binding_id', v_binding.id,
        'binding_version', v_binding.binding_version,
        'name', v_binding.name,
        'variable_name', v_binding.variable_name,
        'delivery', v_binding.delivery,
        'env_name', v_binding.env_name,
        'file_name', v_binding.file_name
      )
    );
  END LOOP;
  RETURN to_jsonb(v_run) || jsonb_build_object(
    'secret_bindings', v_secret_bindings
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_compute_run_lease(
  p_run_id uuid,
  p_container_id text,
  p_token_id uuid,
  p_token_lookup_id uuid,
  p_token_digest text,
  p_token_audience text,
  p_expected_secret_bindings jsonb,
  p_replace_existing_token boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_run public.compute_runs%ROWTYPE;
  v_policy public.compute_agent_policies%ROWTYPE;
  v_existing_token public.compute_job_tokens%ROWTYPE;
  v_budget public.compute_run_budget_reservations%ROWTYPE;
  v_hold record;
  v_secret_id text;
  v_binding public.compute_agent_secret_bindings%ROWTYPE;
  v_secret_bindings jsonb := '[]'::jsonb;
  v_timeout_ms bigint;
  v_reserved_wall_ms bigint;
  v_reserved_light numeric(28,12);
  v_replayed boolean := false;
  v_lock_user_id uuid;
  v_lock_agent_id uuid;
BEGIN
  IF p_run_id IS NULL
     OR p_container_id IS NULL
     OR p_token_id IS NULL
     OR p_token_lookup_id IS NULL
     OR p_token_digest IS NULL
     OR p_token_audience IS NULL
     OR p_replace_existing_token IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_LEASE',
      'message', 'Compute lease material must include exact non-null identities.'
    )::text;
  END IF;
  SELECT run.user_id, run.agent_id INTO v_lock_user_id, v_lock_agent_id
  FROM public.compute_runs AS run
  WHERE run.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_NOT_FOUND', 'message', 'Compute run not found.'
    )::text;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'compute-agent:' || v_lock_user_id::text || ':' || v_lock_agent_id::text, 0
  ));
  SELECT run.* INTO v_run FROM public.compute_runs AS run
  WHERE run.id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_NOT_FOUND', 'message', 'Compute run not found.'
    )::text;
  END IF;
  SELECT policy.* INTO v_policy FROM public.compute_agent_policies AS policy
  WHERE policy.agent_id = v_run.agent_id AND policy.user_id = v_run.user_id
  FOR SHARE;
  IF NOT FOUND OR NOT v_policy.enabled OR v_policy.state <> 'active'
     OR v_policy.authority_epoch IS DISTINCT FROM v_run.authority_epoch THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_POLICY_CHANGED',
      'message', 'The Compute policy changed before lease preparation.'
    )::text;
  END IF;
  IF v_run.stop_requested_at IS NOT NULL
     OR v_run.claim_id IS NULL OR v_run.claim_expires_at <= now()
     OR length(btrim(p_container_id)) NOT BETWEEN 1 AND 256
     OR p_container_id ~ '[[:cntrl:]]'
     OR p_token_digest !~ '^[0-9a-f]{64}$'
     OR p_token_audience <> 'gx-private-v1' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_LEASE', 'message', 'Compute lease material is invalid.'
    )::text;
  END IF;

  FOR v_secret_id IN
    SELECT value FROM jsonb_array_elements_text(v_run.execution_request->'secretBindingIds')
  LOOP
    SELECT binding.* INTO v_binding
    FROM public.compute_agent_secret_bindings AS binding
    JOIN public.apps AS app ON app.id = binding.agent_id
    WHERE binding.id = v_secret_id::uuid
      AND binding.user_id = v_run.user_id AND binding.agent_id = v_run.agent_id
      AND binding.caller_function = v_run.caller_function
      AND binding.status = 'active'
      AND (binding.expires_at IS NULL OR binding.expires_at > now())
      AND jsonb_typeof(COALESCE(app.env_vars, '{}'::jsonb)) = 'object'
      AND COALESCE(app.env_vars, '{}'::jsonb) ? binding.variable_name
    FOR SHARE OF binding;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_SECRET_BINDING_CHANGED',
        'message', 'A requested Agent Variable binding changed before prepare.'
      )::text;
    END IF;
    v_secret_bindings := v_secret_bindings || jsonb_build_array(
      jsonb_build_object(
        'binding_id', v_binding.id,
        'binding_version', v_binding.binding_version,
        'name', v_binding.name,
        'variable_name', v_binding.variable_name,
        'delivery', v_binding.delivery,
        'env_name', v_binding.env_name,
        'file_name', v_binding.file_name
      )
    );
  END LOOP;
  IF p_expected_secret_bindings IS NULL
     OR jsonb_typeof(p_expected_secret_bindings) <> 'array'
     OR v_secret_bindings IS DISTINCT FROM p_expected_secret_bindings THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_SECRET_BINDING_CHANGED',
      'message', 'Secret bindings changed during private materialization.'
    )::text;
  END IF;

  SELECT token.* INTO v_existing_token
  FROM public.compute_job_tokens AS token
  WHERE token.run_id = p_run_id AND token.status = 'active'
  FOR UPDATE;
  IF v_run.state = 'running' AND FOUND AND NOT p_replace_existing_token THEN
    IF v_run.container_id IS DISTINCT FROM btrim(p_container_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_CONTAINER_MISMATCH',
        'message', 'Lease prepare is bound to a different container.'
      )::text;
    END IF;
    SELECT budget.* INTO v_budget
    FROM public.compute_run_budget_reservations AS budget
    WHERE budget.run_id = p_run_id;
    RETURN to_jsonb(v_run) || jsonb_build_object(
      'token_lookup_id', v_existing_token.lookup_id,
      'token_expires_at', v_existing_token.expires_at,
      'budget_reservation', to_jsonb(v_budget),
      'secret_bindings', v_secret_bindings,
      'replayed', true
    );
  END IF;
  IF v_run.state <> 'provisioning' AND NOT (
    v_run.state = 'running' AND p_replace_existing_token
    AND v_run.container_id IS NOT DISTINCT FROM btrim(p_container_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_CONFLICT', 'message', 'Lease prepare CAS failed.'
    )::text;
  END IF;

  v_timeout_ms := (v_run.execution_request->>'timeoutMs')::bigint;
  v_reserved_wall_ms := v_timeout_ms + 195000 + 15000;
  v_reserved_light := (v_reserved_wall_ms * 0.000002056)::numeric(28,12);

  SELECT budget.* INTO v_budget
  FROM public.compute_run_budget_reservations AS budget
  WHERE budget.run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    IF v_run.state = 'running' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_BUDGET_MISSING',
        'message', 'A running lease cannot rotate a token without its wallet hold.'
      )::text;
    END IF;
    SELECT * INTO v_hold FROM public.create_cloud_usage_hold(
      v_run.user_id,
      'galactic_compute',
      'worker_execution',
      v_reserved_wall_ms::double precision,
      v_reserved_wall_ms::double precision,
      v_reserved_light::double precision,
      NULL::uuid,
      v_run.user_id,
      v_run.user_id,
      v_run.agent_id,
      v_run.caller_function,
      'compute-run:' || p_run_id::text,
      v_run.expires_at,
      NULL::integer,
      jsonb_build_object(
        'run_id', p_run_id,
        'lease_id', v_run.lease_id,
        'rate_version', 'compute-rate-v1',
        'rate_light_per_ms', 0.000002056,
        'startup_allowance_ms', 195000,
        'teardown_allowance_ms', 15000
      ),
      'galactic_compute:reserve:' || p_run_id::text
    );
    INSERT INTO public.compute_run_budget_reservations (
      run_id, user_id, hold_id, rate_version, rate_light_per_ms,
      requested_timeout_ms, startup_allowance_ms, teardown_allowance_ms,
      reserved_wall_ms, reserved_light, expires_at
    ) VALUES (
      p_run_id, v_run.user_id, v_hold.hold_id, 'compute-rate-v1', 0.000002056,
      v_timeout_ms, 195000, 15000, v_reserved_wall_ms,
      v_hold.held_amount_light, v_run.expires_at
    ) RETURNING * INTO v_budget;
  END IF;

  IF v_existing_token.id IS NOT NULL THEN
    UPDATE public.compute_job_tokens
    SET status = 'revoked', revoked_at = now()
    WHERE id = v_existing_token.id;
  END IF;
  INSERT INTO public.compute_job_tokens (
    id, lookup_id, token_digest, run_id, lease_id, audience, expires_at
  ) VALUES (
    p_token_id, p_token_lookup_id, p_token_digest, p_run_id,
    v_run.lease_id, p_token_audience, v_run.expires_at
  );
  UPDATE public.compute_runs AS run
  SET state = 'running', state_version = run.state_version + 1,
      container_id = btrim(p_container_id),
      started_at = COALESCE(run.started_at, now()), heartbeat_at = now(),
      claim_expires_at = LEAST(now() + interval '5 minutes', run.expires_at),
      updated_at = now()
  WHERE run.id = p_run_id RETURNING * INTO v_run;

  RETURN to_jsonb(v_run) || jsonb_build_object(
    'token_lookup_id', p_token_lookup_id,
    'token_expires_at', v_run.expires_at,
    'budget_reservation', to_jsonb(v_budget),
    'secret_bindings', v_secret_bindings,
    'replayed', v_replayed
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.heartbeat_compute_run(
  p_run_id uuid,
  p_lease_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_run public.compute_runs%ROWTYPE;
BEGIN
  SELECT run.* INTO v_run FROM public.compute_runs AS run
  WHERE run.id = p_run_id AND run.lease_id = p_lease_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_HEARTBEAT_REJECTED',
      'message', 'The running lease heartbeat was rejected.'
    )::text;
  END IF;
  IF v_run.state <> 'running' OR v_run.stop_requested_at IS NOT NULL THEN
    RETURN to_jsonb(v_run);
  END IF;
  UPDATE public.compute_runs AS run
  SET heartbeat_at = now(),
      claim_expires_at = LEAST(now() + interval '5 minutes', run.expires_at),
      updated_at = now()
  WHERE run.id = p_run_id RETURNING * INTO v_run;
  RETURN to_jsonb(v_run);
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_compute_run(
  p_run_id uuid,
  p_user_id uuid,
  p_agent_id uuid,
  p_caller_function text,
  p_claim_id uuid,
  p_expected_state text,
  p_expected_state_version bigint,
  p_to_state text,
  p_worker_wall_ms bigint,
  p_terminal_reason text DEFAULT NULL,
  p_result jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_run public.compute_runs%ROWTYPE;
  v_budget public.compute_run_budget_reservations%ROWTYPE;
  v_receipt public.compute_run_receipts%ROWTYPE;
  v_settlement record;
  v_release record;
  v_billed_wall_ms bigint := 0;
  v_overrun_wall_ms bigint := 0;
  v_worker_wall_ceiling_ms bigint := 0;
  v_actual_light numeric(28,12) := 0;
  v_released_light numeric(28,12) := 0;
  v_event_id uuid := NULL;
  v_output jsonb;
  v_existing_output public.compute_artifacts%ROWTYPE;
  v_output_count integer := 0;
  v_output_bytes bigint := 0;
  v_output_path text;
  v_storage_key text;
  v_expected_prefix text;
BEGIN
  IF p_run_id IS NULL
     OR p_user_id IS NULL
     OR p_agent_id IS NULL
     OR p_caller_function IS NULL
     OR p_expected_state IS NULL
     OR p_expected_state_version IS NULL
     OR p_to_state IS NULL
     OR p_to_state NOT IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
     OR p_expected_state NOT IN ('admitted', 'queued', 'provisioning', 'running')
     OR p_worker_wall_ms < 0
     OR length(COALESCE(p_terminal_reason, '')) > 1024
     OR p_result IS NULL OR jsonb_typeof(p_result) <> 'object'
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_result) AS key
       WHERE key <> ALL (ARRAY[
         'exitCode', 'stdout', 'stderr', 'stdoutBytes', 'stderrBytes',
         'stdoutTruncated', 'stderrTruncated', 'metrics', 'error', 'outputs'
       ])
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_TRANSITION', 'message', 'Invalid terminal transition.'
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
  IF v_run.state = p_to_state THEN
    SELECT receipt.* INTO v_receipt FROM public.compute_run_receipts AS receipt
    WHERE receipt.run_id = p_run_id;
    IF FOUND THEN
      RETURN to_jsonb(v_run) || jsonb_build_object(
        'receipt', to_jsonb(v_receipt), 'replayed', true
      );
    END IF;
  END IF;
  IF v_run.state IS DISTINCT FROM p_expected_state
     OR v_run.state_version IS DISTINCT FROM p_expected_state_version
     OR (p_claim_id IS NOT NULL AND v_run.claim_id IS DISTINCT FROM p_claim_id)
     OR (p_to_state IN ('succeeded', 'failed') AND p_expected_state IN ('provisioning', 'running')
       AND (p_claim_id IS NULL OR v_run.claim_id IS DISTINCT FROM p_claim_id)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_CONFLICT', 'message', 'Terminal transition CAS failed.'
    )::text;
  END IF;

  IF v_run.state = 'running' AND p_worker_wall_ms IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_WORKER_WALL_REQUIRED',
      'message', 'A running Compute body requires measured worker wall time.'
    )::text;
  END IF;
  IF NOT (
    (p_expected_state IN ('admitted', 'queued')
      AND p_to_state IN ('failed', 'cancelled', 'expired', 'revoked'))
    OR (p_expected_state = 'provisioning'
      AND p_to_state IN ('failed', 'cancelled', 'expired', 'revoked'))
    OR (p_expected_state = 'running'
      AND p_to_state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_TRANSITION', 'message', 'State transition is not allowed.'
    )::text;
  END IF;

  IF p_to_state = 'succeeded' THEN
    IF NOT p_result ?& ARRAY[
         'exitCode', 'stdout', 'stderr', 'stdoutBytes', 'stderrBytes',
         'stdoutTruncated', 'stderrTruncated', 'metrics', 'outputs'
       ]
       OR (p_result->>'exitCode') !~ '^[0-9]+$'
       OR (p_result->>'exitCode')::integer NOT BETWEEN 0 AND 255
       OR jsonb_typeof(p_result->'stdout') <> 'string'
       OR jsonb_typeof(p_result->'stderr') <> 'string'
       OR octet_length(p_result->>'stdout') > 1048576
       OR octet_length(p_result->>'stderr') > 1048576
       OR (p_result->>'stdoutBytes') !~ '^[0-9]+$'
       OR (p_result->>'stderrBytes') !~ '^[0-9]+$'
       OR jsonb_typeof(p_result->'stdoutTruncated') <> 'boolean'
       OR jsonb_typeof(p_result->'stderrTruncated') <> 'boolean'
       OR jsonb_typeof(p_result->'metrics') <> 'object'
       OR jsonb_typeof(p_result->'outputs') <> 'array' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_INVALID_RESULT',
        'message', 'The bounded Compute completion result is invalid.'
      )::text;
    END IF;
  ELSIF p_result ? 'error' AND (
    jsonb_typeof(p_result->'error') <> 'string'
    OR length(p_result->>'error') > 1024
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_RESULT',
      'message', 'The sanitized terminal error is invalid.'
    )::text;
  END IF;

  SELECT budget.* INTO v_budget
  FROM public.compute_run_budget_reservations AS budget
  WHERE budget.run_id = p_run_id FOR UPDATE;
  IF FOUND THEN
    IF p_worker_wall_ms IS NULL THEN
      SELECT * INTO v_release FROM public.release_cloud_usage_hold(
        v_budget.hold_id,
        jsonb_build_object(
          'run_id', p_run_id, 'outcome', p_to_state,
          'reason', 'compute_body_not_started'
        ),
        'galactic_compute:release:' || p_run_id::text
      );
      v_billed_wall_ms := 0;
      v_actual_light := 0;
      v_released_light := v_budget.reserved_light;
      UPDATE public.compute_run_budget_reservations AS budget
      SET actual_wall_ms = NULL, actual_light = 0,
          released_light = v_released_light, status = 'released',
          settled_at = now(), updated_at = now()
      WHERE budget.id = v_budget.id RETURNING * INTO v_budget;
    ELSE
      -- A platform overrun must never prevent a terminal receipt. Bill no more
      -- than the wallet-backed reservation and preserve the raw worker wall on
      -- the budget/receipt plus structured terminal metrics for reconciliation.
      -- Worker wall is measured through final body destruction, so teardown is
      -- already included; never add the fixed allowance a second time.
      v_worker_wall_ceiling_ms := v_budget.reserved_wall_ms;
      IF p_worker_wall_ms > v_worker_wall_ceiling_ms THEN
        v_overrun_wall_ms := p_worker_wall_ms - v_worker_wall_ceiling_ms;
        v_billed_wall_ms := v_budget.reserved_wall_ms;
      ELSE
        v_billed_wall_ms := p_worker_wall_ms;
      END IF;
      v_actual_light := LEAST(
        v_budget.reserved_light,
        (v_billed_wall_ms * v_budget.rate_light_per_ms)::numeric(28,12)
      );
      v_released_light := v_budget.reserved_light - v_actual_light;
      SELECT * INTO v_settlement FROM public.settle_cloud_usage_hold(
        v_budget.hold_id,
        v_billed_wall_ms::double precision,
        v_billed_wall_ms::double precision,
        v_actual_light::double precision,
        jsonb_build_object(
          'run_id', p_run_id, 'outcome', p_to_state,
          'rate_version', v_budget.rate_version,
          'reservation_clamped', v_overrun_wall_ms > 0,
          'overrun_wall_ms', v_overrun_wall_ms
        ),
        'galactic_compute:settle:' || p_run_id::text
      );
      v_event_id := v_settlement.event_id;
      UPDATE public.compute_run_budget_reservations AS budget
      SET actual_wall_ms = p_worker_wall_ms, actual_light = v_actual_light,
          released_light = v_released_light, status = 'settled',
          settled_at = now(), updated_at = now()
      WHERE budget.id = v_budget.id RETURNING * INTO v_budget;
    END IF;
  ELSE
    IF p_expected_state = 'running' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_BUDGET_MISSING',
        'message', 'A running Compute lease has no wallet-backed hold.'
      )::text;
    END IF;
    v_billed_wall_ms := 0;
    v_actual_light := 0;
    v_released_light := 0;
  END IF;

  IF p_to_state = 'succeeded' THEN
    v_expected_prefix := 'compute-v1/' || v_run.user_id::text || '/' ||
      v_run.agent_id::text || '/' || v_run.id::text || '/outputs/';
    SELECT count(*), COALESCE(sum(size_bytes), 0)
    INTO v_output_count, v_output_bytes
    FROM public.compute_artifacts AS artifact
    WHERE artifact.run_id = v_run.id
      AND artifact.state <> 'deleted';
    FOR v_output IN SELECT value FROM jsonb_array_elements(p_result->'outputs') LOOP
      IF jsonb_typeof(v_output) <> 'object'
         OR NOT v_output ?& ARRAY[
           'artifactId', 'path', 'storageKey', 'sha256', 'sizeBytes',
           'mediaType', 'archive'
         ] OR EXISTS (
           SELECT 1 FROM jsonb_object_keys(v_output) AS key
           WHERE key <> ALL (ARRAY[
             'artifactId', 'path', 'storageKey', 'sha256', 'sizeBytes',
             'mediaType', 'archive'
           ])
         ) OR (v_output->>'artifactId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         OR (v_output->>'sha256') !~ '^[0-9a-f]{64}$'
         OR (v_output->>'sizeBytes') !~ '^[0-9]+$'
         OR (v_output->>'archive') NOT IN ('none', 'tar.gz')
         OR length(v_output->>'mediaType') NOT BETWEEN 3 AND 255 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
          'code', 'COMPUTE_INVALID_OUTPUT_ARTIFACT',
          'message', 'A Compute output artifact descriptor is invalid.'
        )::text;
      END IF;
      v_output_path := v_output->>'path';
      v_storage_key := v_output->>'storageKey';
      IF length(v_output_path) NOT BETWEEN 1 AND 1024
         OR v_output_path ~ '(^/|\\|[[:cntrl:]]|//)'
         OR v_output_path ~ '(^|/)(\.|\.\.)(/|$)'
         OR NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(
             v_run.execution_request->'capturePaths'
           ) AS capture(path) WHERE capture.path = v_output_path
         )
         OR left(v_storage_key, length(v_expected_prefix)) <> v_expected_prefix
         OR substring(v_storage_key FROM length(v_expected_prefix) + 1) = ''
         OR v_storage_key ~ '(^|/)(\.|\.\.)(/|$)' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
          'code', 'COMPUTE_OUTPUT_SCOPE_VIOLATION',
          'message', 'Output path or object key escapes the exact run scope.'
        )::text;
      END IF;
      SELECT artifact.* INTO v_existing_output
      FROM public.compute_artifacts AS artifact
      WHERE artifact.id = (v_output->>'artifactId')::uuid
        AND artifact.run_id = v_run.id
      FOR UPDATE;
      IF FOUND THEN
        IF v_existing_output.user_id IS DISTINCT FROM v_run.user_id
           OR v_existing_output.direction IS DISTINCT FROM 'output'
           OR v_existing_output.state IS DISTINCT FROM 'ready'
           OR v_existing_output.logical_name IS DISTINCT FROM v_output_path
           OR v_existing_output.storage_key IS DISTINCT FROM v_storage_key
           OR v_existing_output.sha256 IS DISTINCT FROM v_output->>'sha256'
           OR v_existing_output.size_bytes IS DISTINCT FROM (v_output->>'sizeBytes')::bigint
           OR v_existing_output.media_type IS DISTINCT FROM lower(v_output->>'mediaType') THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
            'code', 'COMPUTE_OUTPUT_ARTIFACT_CONFLICT',
            'message', 'A pre-registered output does not match completion metadata.'
          )::text;
        END IF;
        -- Worker capture reserves and commits before R2 upload/finalization.
        -- It and every ready input are already included in the aggregate
        -- v_output_count/v_output_bytes values above.
        CONTINUE;
      END IF;
      v_output_bytes := v_output_bytes + (v_output->>'sizeBytes')::bigint;
      v_output_count := v_output_count + 1;
      IF v_output_count > (v_run.policy_limits_snapshot->>'maxArtifacts')::integer
         OR v_output_bytes > (v_run.policy_limits_snapshot->>'maxArtifactBytes')::bigint THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
          'code', 'COMPUTE_ARTIFACT_LIMIT_EXCEEDED',
          'message', 'Aggregate input/output artifacts exceed the owner-confirmed limits.'
        )::text;
      END IF;
      INSERT INTO public.compute_artifacts (
        id, run_id, user_id, idempotency_key, request_hash, direction,
        mount_path, logical_name, media_type, storage_key, sha256, size_bytes,
        state
      ) VALUES (
        (v_output->>'artifactId')::uuid, v_run.id, v_run.user_id,
        (v_output->>'artifactId')::uuid, v_output->>'sha256', 'output',
        NULL, v_output_path, lower(v_output->>'mediaType'), v_storage_key,
        v_output->>'sha256', (v_output->>'sizeBytes')::bigint, 'ready'
      );
    END LOOP;
  END IF;

  UPDATE public.compute_job_tokens
  SET status = 'revoked', revoked_at = COALESCE(revoked_at, now())
  WHERE run_id = p_run_id AND status = 'active';
  UPDATE public.compute_runs AS run
  SET state = p_to_state, state_version = run.state_version + 1,
      finished_at = now(), terminal_reason = p_terminal_reason,
      exit_code = CASE WHEN p_to_state = 'succeeded'
        THEN (p_result->>'exitCode')::smallint ELSE NULL END,
      stdout = CASE WHEN p_to_state = 'succeeded' THEN p_result->>'stdout' ELSE NULL END,
      stderr = CASE WHEN p_to_state = 'succeeded' THEN p_result->>'stderr' ELSE NULL END,
      stdout_bytes = CASE WHEN p_to_state = 'succeeded'
        THEN (p_result->>'stdoutBytes')::bigint ELSE NULL END,
      stderr_bytes = CASE WHEN p_to_state = 'succeeded'
        THEN (p_result->>'stderrBytes')::bigint ELSE NULL END,
      stdout_truncated = CASE WHEN p_to_state = 'succeeded'
        THEN (p_result->>'stdoutTruncated')::boolean ELSE NULL END,
      stderr_truncated = CASE WHEN p_to_state = 'succeeded'
        THEN (p_result->>'stderrTruncated')::boolean ELSE NULL END,
      execution_metrics = CASE
        WHEN p_result ? 'metrics' OR v_overrun_wall_ms > 0 THEN
          COALESCE(p_result->'metrics', '{}'::jsonb) ||
          CASE WHEN v_overrun_wall_ms > 0 THEN jsonb_build_object(
            'billing', jsonb_build_object(
              'reservationClamped', true,
              'reportedWorkerWallMs', p_worker_wall_ms,
              'teardownAllowanceMs', v_budget.teardown_allowance_ms,
              'reservedWallMs', v_budget.reserved_wall_ms,
              'overrunWallMs', v_overrun_wall_ms
            )
          ) ELSE '{}'::jsonb END
        ELSE NULL
      END,
      terminal_error = NULLIF(p_result->>'error', ''),
      updated_at = now()
  WHERE run.id = p_run_id RETURNING * INTO v_run;
  INSERT INTO public.compute_run_receipts (
    id, run_id, user_id, agent_id, hold_id, cloud_usage_event_id, outcome,
    rate_version, worker_wall_ms, teardown_allowance_ms, billed_wall_ms,
    reserved_light, actual_light, released_light
  ) VALUES (
    v_run.receipt_id, p_run_id, p_user_id, p_agent_id,
    v_budget.hold_id, v_event_id, p_to_state,
    'compute-rate-v1', p_worker_wall_ms,
    COALESCE(v_budget.teardown_allowance_ms, 0), v_billed_wall_ms,
    COALESCE(v_budget.reserved_light, 0), v_actual_light, v_released_light
  ) RETURNING * INTO v_receipt;
  RETURN to_jsonb(v_run) || jsonb_build_object(
    'receipt', to_jsonb(v_receipt), 'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_compute_worker_run(
  p_run_id uuid,
  p_lease_id uuid,
  p_to_state text,
  p_worker_wall_ms bigint,
  p_terminal_reason text,
  p_result jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_run public.compute_runs%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR p_to_state IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_TRANSITION',
      'message', 'Worker finalization requires an exact run and terminal state.'
    )::text;
  END IF;
  SELECT run.* INTO v_run FROM public.compute_runs AS run
  WHERE run.id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_NOT_FOUND', 'message', 'Compute run not found.'
    )::text;
  END IF;
  IF v_run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked') THEN
    RETURN to_jsonb(v_run) || jsonb_build_object(
      'receipt', (SELECT to_jsonb(receipt) FROM public.compute_run_receipts AS receipt
        WHERE receipt.run_id = v_run.id),
      'replayed', true
    );
  END IF;
  IF v_run.stop_requested_at IS NOT NULL AND p_to_state <> 'cancelled' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_CONFLICT',
      'message', 'A stopped Compute run may only be cancelled by the Worker.'
    )::text;
  END IF;
  IF v_run.state = 'running'
     AND (p_lease_id IS NULL OR v_run.lease_id IS DISTINCT FROM p_lease_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_LEASE_MISMATCH',
      'message', 'Worker finalization lease does not match the run.'
    )::text;
  END IF;
  IF v_run.state = 'running' AND p_worker_wall_ms IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_WORKER_WALL_REQUIRED',
      'message', 'A running Compute body requires measured worker wall time.'
    )::text;
  END IF;
  IF v_run.state = 'provisioning' AND p_to_state NOT IN ('failed', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_TRANSITION',
      'message', 'A pre-lease run may only fail or cancel.'
    )::text;
  END IF;
  RETURN public.transition_compute_run(
    v_run.id, v_run.user_id, v_run.agent_id, v_run.caller_function,
    v_run.claim_id, v_run.state, v_run.state_version, p_to_state,
    p_worker_wall_ms, p_terminal_reason, p_result
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admit_compute_run(
  uuid, text, uuid, uuid, text, text, text, text, text, jsonb, jsonb,
  timestamptz, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_compute_run(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_compute_run_secret_descriptors(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_compute_run_lease(
  uuid, text, uuid, uuid, text, text, jsonb, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_compute_run(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_compute_run(
  uuid, uuid, uuid, text, uuid, text, bigint, text, bigint, text, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_compute_worker_run(
  uuid, uuid, text, bigint, text, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admit_compute_run(
  uuid, text, uuid, uuid, text, text, text, text, text, jsonb, jsonb,
  timestamptz, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_compute_run(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_compute_run_secret_descriptors(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_compute_run_lease(
  uuid, text, uuid, uuid, text, text, jsonb, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_compute_run(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_compute_run(
  uuid, uuid, uuid, text, uuid, text, bigint, text, bigint, text, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_compute_worker_run(
  uuid, uuid, text, bigint, text, jsonb
) TO service_role;
