-- Recover a live claim only through the private Compute Worker path.
--
-- Queue delivery and Worker/DO execution are at-least-once.  The original
-- lifecycle claim RPC deliberately rejected every non-queued state, but that
-- made a response lost after the claim/prepare commit indistinguishable from
-- an active duplicate.  The deterministic per-run coordinator serializes
-- active duplicates; therefore a new invocation reaching this RPC may safely
-- resume an unexpired provisioning/running claim.  Lease preparation still
-- revalidates policy, exact secret descriptors, budget, container identity,
-- and rotates the one-time job token.

CREATE OR REPLACE FUNCTION public.claim_compute_run(
  p_run_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_result jsonb;
  v_run public.compute_runs%ROWTYPE;
  v_input_artifacts jsonb;
  v_expected_inputs integer;
  v_ready_inputs integer;
  v_input_bytes bigint;
BEGIN
  -- Preserve the ownership/deletion serialization added by the lifecycle
  -- migration.  Its inner claim also takes the per-Agent advisory lock, which
  -- remains held for this transaction after the function returns.
  IF p_run_id IS NOT NULL THEN
    PERFORM 1
    FROM public.compute_runs AS run
    JOIN public.apps AS app ON app.id = run.agent_id
    WHERE run.id = p_run_id
    FOR SHARE OF app;
    PERFORM 1
    FROM public.compute_runs AS run
    JOIN public.users AS owner ON owner.id = run.user_id
    WHERE run.id = p_run_id
    FOR KEY SHARE OF owner NOWAIT;
  END IF;

  v_result := public.claim_compute_run_lifecycle_impl(p_run_id);
  IF v_result->>'reason' IS DISTINCT FROM 'already_claimed' THEN
    RETURN v_result || jsonb_build_object(
      'recovered', COALESCE((v_result->>'recovered')::boolean, false)
    );
  END IF;

  SELECT run.* INTO v_run
  FROM public.compute_runs AS run
  WHERE run.id = p_run_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_run.state NOT IN ('provisioning', 'running')
     OR v_run.stop_requested_at IS NOT NULL
     OR v_run.claim_id IS NULL
     OR v_run.claim_expires_at IS NULL
     OR v_run.claim_expires_at <= now()
     OR v_run.expires_at <= now() THEN
    RETURN v_result;
  END IF;

  -- Reconstruct the exact immutable execution snapshot.  Never resume with a
  -- partial input set if storage metadata changed after the original claim.
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
      'code', 'COMPUTE_RECOVERY_INPUTS_CHANGED',
      'message', 'A live Compute claim cannot resume with a changed input snapshot.'
    )::text;
  END IF;

  -- Fence any token from the abandoned invocation before handing recovery
  -- back to the execution plane, and renew the short claim window so bounded
  -- destruction plus token rotation cannot race the old five-minute lease.
  UPDATE public.compute_job_tokens AS token
  SET status = 'revoked', revoked_at = COALESCE(token.revoked_at, now())
  WHERE token.run_id = v_run.id AND token.status = 'active';
  UPDATE public.compute_runs AS run
  SET claim_id = gen_random_uuid(),
      claim_expires_at = LEAST(now() + interval '5 minutes', run.expires_at),
      heartbeat_at = now(),
      state_version = run.state_version + 1,
      updated_at = now()
  WHERE run.id = v_run.id
  RETURNING * INTO v_run;

  RETURN to_jsonb(v_run) || jsonb_build_object(
    'claimed', true,
    'recovered', true,
    'input_artifacts', v_input_artifacts,
    'capture_paths', v_run.execution_request->'capturePaths'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_compute_run(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_compute_run(uuid) TO service_role;
