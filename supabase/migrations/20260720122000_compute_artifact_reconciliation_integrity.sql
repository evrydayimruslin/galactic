-- Galactic Compute artifact integrity and bounded storage reconciliation.
--
-- Output bytes follow reserve -> checksum-bound R2 put -> immutable ready CAS.
-- The sweeper may only tombstone an old pending reservation after its run has
-- a durable stop fence or terminal receipt path. R2 deletion is performed by
-- the API Worker only after these functions return an exact safe disposition.

-- Commit-time metadata is the metadata reserved before R2 receives bytes.
-- New output reservations may never defer their digest or size until commit.
  -- An interrupted earlier candidate rollout may have created legacy NULL
  -- reservations before registration began requiring exact metadata.
-- Fail rather than mutating any live pending upload; incomplete stopped/deleted
-- metadata is safe to remove so the R2 reconciler can delete its exact orphan.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.compute_artifacts AS artifact
    JOIN public.compute_runs AS run ON run.id = artifact.run_id
    WHERE artifact.direction = 'output'
      AND (artifact.sha256 IS NULL OR artifact.size_bytes IS NULL)
      AND artifact.state = 'pending'
      AND run.state IN ('admitted', 'queued', 'provisioning', 'running')
      AND run.stop_requested_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_MIGRATION_BLOCKED',
      'message', 'Stop legacy pending output reservations before applying artifact integrity.'
    )::text;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.compute_artifacts AS artifact
    JOIN public.compute_artifacts AS input_alias
      ON input_alias.source_artifact_id = artifact.id
    WHERE artifact.direction = 'output'
      AND (artifact.sha256 IS NULL OR artifact.size_bytes IS NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_MIGRATION_BLOCKED',
      'message', 'A legacy invalid output is still referenced by an input alias.'
    )::text;
  END IF;
  DELETE FROM public.compute_artifacts AS artifact
  USING public.compute_runs AS run
  WHERE artifact.run_id = run.id
    AND artifact.direction = 'output'
    AND (artifact.sha256 IS NULL OR artifact.size_bytes IS NULL)
    AND (
      artifact.state = 'deleted'
      OR run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
      OR run.stop_requested_at IS NOT NULL
    );
END;
$$;

ALTER TABLE public.compute_artifacts
  ADD CONSTRAINT compute_artifacts_output_reservation_shape_check CHECK (
    direction <> 'output' OR (sha256 IS NOT NULL AND size_bytes IS NOT NULL)
  ) NOT VALID;
ALTER TABLE public.compute_artifacts
  VALIDATE CONSTRAINT compute_artifacts_output_reservation_shape_check;

CREATE OR REPLACE FUNCTION public.enforce_compute_artifact_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.source_artifact_id IS DISTINCT FROM OLD.source_artifact_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.mount_path IS DISTINCT FROM OLD.mount_path
     OR NEW.logical_name IS DISTINCT FROM OLD.logical_name
     OR NEW.media_type IS DISTINCT FROM OLD.media_type
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_IDENTITY_IMMUTABLE',
      'message', 'Reserved Compute artifact identity metadata is immutable.'
    )::text;
  END IF;

  IF NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_INTEGRITY_IMMUTABLE',
      'message', 'A Compute artifact commit cannot change its reserved digest or size.'
    )::text;
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state = 'pending' AND NEW.state IN ('ready', 'deleted'))
      OR (OLD.state = 'ready' AND NEW.state = 'deleted')
    ) OR NEW.state_version IS DISTINCT FROM OLD.state_version + 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_ARTIFACT_TRANSITION_INVALID',
        'message', 'Compute artifact state transitions require the exact next version.'
      )::text;
    END IF;
  ELSIF NEW.state_version IS DISTINCT FROM OLD.state_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_VERSION_INVALID',
      'message', 'Compute artifact versions advance only with a state transition.'
    )::text;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER compute_artifact_immutability
BEFORE UPDATE ON public.compute_artifacts
FOR EACH ROW
EXECUTE FUNCTION public.enforce_compute_artifact_immutability();

-- Replace the original transition implementation so the SQL contract itself,
-- not only the trigger, states that ready metadata must equal the reservation.
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
    OR v_artifact.sha256 IS DISTINCT FROM p_sha256
    OR v_artifact.size_bytes IS DISTINCT FROM p_size_bytes
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_RESERVATION_MISMATCH',
      'message', 'Ready digest and size must exactly match the reservation.'
    )::text;
  END IF;
  IF p_to_state = 'ready' THEN
    SELECT count(*) + 1,
      COALESCE(sum(COALESCE(size_bytes, 0)), 0) + v_artifact.size_bytes
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
      updated_at = now()
  WHERE artifact.id = p_artifact_id RETURNING * INTO v_artifact;
  RETURN NEXT v_artifact;
END;
$$;

-- Persist the owner of the DLQ stop fence independently from the human-readable
-- reason. Other stop flows remain NULL and are therefore foreign to the DLQ.
ALTER TABLE public.compute_runs
  ADD COLUMN stop_fence_owner text;
ALTER TABLE public.compute_runs
  ADD CONSTRAINT compute_runs_stop_fence_owner_check CHECK (
    stop_fence_owner IS NULL
    OR (
      stop_requested_at IS NOT NULL
      AND stop_fence_owner ~ '^[a-z][a-z0-9_]{0,63}$'
    )
  );

-- Preserve a fence taken immediately before this migration without treating an
-- arbitrary user-provided prefix as platform authority.
UPDATE public.compute_runs
SET stop_fence_owner = 'dispatch_dlq'
WHERE stop_fence_owner IS NULL
  AND stop_requested_at IS NOT NULL
  AND stop_reason IN ('compute_dispatch_dlq', 'compute_dispatch_dlq_exhausted');

UPDATE public.compute_runs
SET stop_fence_owner = 'stale_reconciler'
WHERE stop_fence_owner IS NULL
  AND stop_requested_at IS NOT NULL
  AND stop_reason = 'compute_lease_expired';

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
  IF p_run_id IS NULL OR p_reason IS NULL
     OR length(p_reason) NOT BETWEEN 1 AND 1024
     OR p_reason ~ '[[:cntrl:]]' THEN
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
     AND v_run.stop_fence_owner IS DISTINCT FROM 'dispatch_dlq' THEN
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
      stop_reason = left(p_reason, 1024),
      stop_fence_owner = 'dispatch_dlq',
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
     OR v_run.stop_fence_owner IS DISTINCT FROM 'dispatch_dlq' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_CONFLICT',
      'message', 'DLQ fence owner or state version does not match.'
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

-- A stale-run pass may resume only its own fence. Owner cancellation, policy
-- revocation, emergency stop, and DLQ settlement each retain their original
-- outcome/reason and must never be stolen merely because the claim also aged.
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
      (
        run.state IN ('admitted', 'queued')
        AND run.expires_at <= p_now
      ) OR (
        run.state IN ('provisioning', 'running')
        AND (run.claim_expires_at <= p_now OR run.expires_at <= p_now)
      )
    )
      AND (
        run.stop_requested_at IS NULL
        OR run.stop_fence_owner = 'stale_reconciler'
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
  IF v_run.stop_requested_at IS NOT NULL
     AND v_run.stop_fence_owner IS DISTINCT FROM 'stale_reconciler' THEN
    RETURN to_jsonb(v_run) || jsonb_build_object(
      'receipt', NULL,
      'requires_body_destroy', false,
      'skipped', true,
      'skip_reason', 'foreign_stop_fence',
      'replayed', true
    );
  END IF;
  IF v_run.stop_requested_at IS NOT NULL THEN
    RETURN to_jsonb(v_run) || jsonb_build_object(
      'requires_body_destroy', v_run.state IN ('provisioning', 'running'),
      'skipped', false,
      'replayed', true
    );
  END IF;
  UPDATE public.compute_runs AS run
  SET stop_requested_at = p_now,
      stop_reason = 'compute_lease_expired',
      stop_fence_owner = 'stale_reconciler',
      state_version = run.state_version + 1,
      updated_at = now()
  WHERE run.id = p_run_id RETURNING * INTO v_run;
  RETURN to_jsonb(v_run) || jsonb_build_object(
    'requires_body_destroy', v_run.state IN ('provisioning', 'running'),
    'skipped', false,
    'replayed', false
  );
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
     OR v_run.state_version IS DISTINCT FROM p_expected_state_version
     OR v_run.stop_requested_at IS NULL
     OR v_run.stop_fence_owner IS DISTINCT FROM 'stale_reconciler' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_CONFLICT',
      'message', 'Stale-run fence owner or state version does not match.'
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
    v_run.id, 'expired', v_run.stop_reason
  );
END;
$$;

-- Partial indexes match the minute-cron predicates and keep terminal history
-- out of operational scans.
CREATE INDEX compute_runs_unclaimed_expiry_idx
  ON public.compute_runs (expires_at, created_at, id)
  WHERE state IN ('admitted', 'queued');
CREATE INDEX compute_runs_claim_expiry_idx
  ON public.compute_runs (claim_expires_at, created_at, id)
  WHERE state IN ('provisioning', 'running');
CREATE INDEX compute_runs_claim_absolute_expiry_idx
  ON public.compute_runs (expires_at, created_at, id)
  WHERE state IN ('provisioning', 'running');
CREATE INDEX compute_runs_stopped_active_idx
  ON public.compute_runs (stop_requested_at, created_at, id)
  WHERE state IN ('admitted', 'queued', 'provisioning', 'running')
    AND stop_requested_at IS NOT NULL;
CREATE INDEX compute_job_tokens_active_expiry_idx
  ON public.compute_job_tokens (expires_at, run_id)
  WHERE status = 'active';
CREATE INDEX compute_budget_reserved_expiry_idx
  ON public.compute_run_budget_reservations (expires_at, run_id)
  WHERE status = 'reserved';
CREATE INDEX compute_artifacts_pending_output_age_idx
  ON public.compute_artifacts (updated_at, id)
  WHERE direction = 'output' AND state = 'pending';

CREATE TABLE public.compute_artifact_reconciliation_cursors (
  scope text PRIMARY KEY,
  cursor text,
  state_version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compute_artifact_reconciliation_scope_check
    CHECK (scope = 'compute-v1/'),
  CONSTRAINT compute_artifact_reconciliation_cursor_check CHECK (
    cursor IS NULL OR (
      length(cursor) BETWEEN 1 AND 8192 AND cursor !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT compute_artifact_reconciliation_version_check
    CHECK (state_version >= 1)
);

INSERT INTO public.compute_artifact_reconciliation_cursors (scope)
VALUES ('compute-v1/');

ALTER TABLE public.compute_artifact_reconciliation_cursors
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.compute_artifact_reconciliation_cursors
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.compute_artifact_reconciliation_cursors
  TO service_role;

CREATE OR REPLACE FUNCTION public.get_compute_artifact_reconciliation_cursor()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT to_jsonb(cursor_row)
  FROM public.compute_artifact_reconciliation_cursors AS cursor_row
  WHERE cursor_row.scope = 'compute-v1/';
$$;

CREATE OR REPLACE FUNCTION public.advance_compute_artifact_reconciliation_cursor(
  p_expected_state_version bigint,
  p_cursor text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_cursor public.compute_artifact_reconciliation_cursors%ROWTYPE;
BEGIN
  IF p_expected_state_version IS NULL OR p_expected_state_version < 1
     OR (p_cursor IS NOT NULL AND (
       length(p_cursor) NOT BETWEEN 1 AND 8192
       OR p_cursor ~ '[[:cntrl:]]'
     )) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RECONCILIATION_CURSOR_INVALID',
      'message', 'Artifact reconciliation cursor input is invalid.'
    )::text;
  END IF;
  SELECT cursor_row.* INTO v_cursor
  FROM public.compute_artifact_reconciliation_cursors AS cursor_row
  WHERE cursor_row.scope = 'compute-v1/' FOR UPDATE;
  IF NOT FOUND
     OR v_cursor.state_version IS DISTINCT FROM p_expected_state_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RECONCILIATION_CURSOR_CONFLICT',
      'message', 'Artifact reconciliation cursor CAS failed.'
    )::text;
  END IF;
  UPDATE public.compute_artifact_reconciliation_cursors AS cursor_row
  SET cursor = p_cursor,
      state_version = cursor_row.state_version + 1,
      updated_at = now()
  WHERE cursor_row.scope = 'compute-v1/'
  RETURNING * INTO v_cursor;
  RETURN to_jsonb(v_cursor);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_stale_pending_compute_artifacts(
  p_now timestamptz,
  p_cutoff timestamptz,
  p_limit integer DEFAULT 100
) RETURNS TABLE (
  artifact_id uuid,
  run_id uuid,
  user_id uuid,
  agent_id uuid,
  caller_function text,
  storage_key text,
  sha256 text,
  size_bytes bigint,
  state_version bigint,
  artifact_updated_at timestamptz,
  run_state text,
  stop_requested_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  IF p_now IS NULL OR p_cutoff IS NULL OR p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 500
     OR p_cutoff > p_now - interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid pending artifact reconciliation inputs';
  END IF;
  RETURN QUERY
    SELECT artifact.id, artifact.run_id, artifact.user_id, run.agent_id,
      run.caller_function, artifact.storage_key, artifact.sha256,
      artifact.size_bytes, artifact.state_version, artifact.updated_at,
      run.state, run.stop_requested_at
    FROM public.compute_artifacts AS artifact
    JOIN public.compute_runs AS run ON run.id = artifact.run_id
    WHERE artifact.direction = 'output'
      AND artifact.state = 'pending'
      AND artifact.updated_at <= p_cutoff
      AND (
        run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
        OR run.stop_requested_at IS NOT NULL
      )
    ORDER BY artifact.updated_at, artifact.id
    LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.tombstone_stale_pending_compute_artifact(
  p_artifact_id uuid,
  p_expected_state_version bigint,
  p_now timestamptz,
  p_cutoff timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid;
  v_run public.compute_runs%ROWTYPE;
  v_artifact public.compute_artifacts%ROWTYPE;
BEGIN
  IF p_artifact_id IS NULL OR p_expected_state_version IS NULL
     OR p_expected_state_version < 1 OR p_now IS NULL OR p_cutoff IS NULL
     OR p_cutoff > p_now - interval '5 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_RECONCILIATION_INVALID',
      'message', 'Pending artifact reconciliation requires an exact old candidate.'
    )::text;
  END IF;
  SELECT artifact.run_id INTO v_run_id
  FROM public.compute_artifacts AS artifact
  WHERE artifact.id = p_artifact_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', true, 'skip_reason', 'not_found');
  END IF;
  SELECT run.* INTO v_run FROM public.compute_runs AS run
  WHERE run.id = v_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', true, 'skip_reason', 'run_not_found');
  END IF;
  SELECT artifact.* INTO v_artifact
  FROM public.compute_artifacts AS artifact
  WHERE artifact.id = p_artifact_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', true, 'skip_reason', 'not_found');
  END IF;
  IF v_artifact.state = 'deleted' THEN
    RETURN to_jsonb(v_artifact) || jsonb_build_object('replayed', true);
  END IF;
  IF v_artifact.direction IS DISTINCT FROM 'output'
     OR v_artifact.state IS DISTINCT FROM 'pending'
     OR v_artifact.state_version IS DISTINCT FROM p_expected_state_version THEN
    RETURN to_jsonb(v_artifact) || jsonb_build_object(
      'skipped', true, 'skip_reason', 'candidate_changed'
    );
  END IF;
  IF v_artifact.updated_at > p_cutoff OR NOT (
    v_run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
    OR v_run.stop_requested_at IS NOT NULL
  ) THEN
    RETURN to_jsonb(v_artifact) || jsonb_build_object(
      'skipped', true, 'skip_reason', 'candidate_not_stale'
    );
  END IF;
  UPDATE public.compute_artifacts AS artifact
  SET state = 'deleted', state_version = artifact.state_version + 1,
      updated_at = p_now
  WHERE artifact.id = p_artifact_id
    AND artifact.state = 'pending'
    AND artifact.state_version = p_expected_state_version
  RETURNING * INTO v_artifact;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', true, 'skip_reason', 'cas_lost');
  END IF;
  RETURN to_jsonb(v_artifact) || jsonb_build_object('replayed', false);
END;
$$;

-- Classify an old R2 object using database truth. The API still applies the R2
-- uploaded-at cutoff. A deleted source object remains protected while any
-- ready input alias references it.
CREATE OR REPLACE FUNCTION public.classify_compute_artifact_object(
  p_storage_key text,
  p_run_id uuid,
  p_user_id uuid,
  p_agent_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_artifact public.compute_artifacts%ROWTYPE;
  v_run public.compute_runs%ROWTYPE;
  v_prefix text;
  v_has_ready_input_reference boolean := false;
BEGIN
  IF p_storage_key IS NULL OR p_run_id IS NULL OR p_user_id IS NULL
     OR p_agent_id IS NULL OR length(p_storage_key) NOT BETWEEN 1 AND 2048
     OR p_storage_key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid Compute artifact object identity';
  END IF;
  v_prefix := 'compute-v1/' || p_user_id::text || '/' || p_agent_id::text ||
    '/' || p_run_id::text || '/outputs/';
  IF left(p_storage_key, length(v_prefix)) IS DISTINCT FROM v_prefix
     OR substring(p_storage_key FROM length(v_prefix) + 1) = ''
     OR p_storage_key ~ '(^|/)(\.|\.\.)(/|$)' THEN
    RETURN jsonb_build_object(
      'disposition', 'keep', 'reason', 'scope_mismatch'
    );
  END IF;

  SELECT artifact.* INTO v_artifact
  FROM public.compute_artifacts AS artifact
  WHERE artifact.storage_key = p_storage_key
    AND artifact.direction = 'output';
  IF FOUND THEN
    IF v_artifact.run_id IS DISTINCT FROM p_run_id
       OR v_artifact.user_id IS DISTINCT FROM p_user_id THEN
      RETURN jsonb_build_object(
        'disposition', 'keep', 'reason', 'database_scope_mismatch'
      );
    END IF;
    SELECT run.* INTO v_run FROM public.compute_runs AS run
    WHERE run.id = v_artifact.run_id;
    IF NOT FOUND OR v_run.agent_id IS DISTINCT FROM p_agent_id THEN
      RETURN jsonb_build_object(
        'disposition', 'keep', 'reason', 'database_scope_mismatch'
      );
    END IF;
    IF v_artifact.state = 'ready' THEN
      RETURN jsonb_build_object(
        'disposition', 'keep', 'reason', 'ready_artifact',
        'artifact_id', v_artifact.id
      );
    END IF;
    IF v_artifact.state = 'deleted' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.compute_artifacts AS input_alias
        WHERE input_alias.source_artifact_id = v_artifact.id
          AND input_alias.direction = 'input'
          AND input_alias.state = 'ready'
      ) INTO v_has_ready_input_reference;
      IF v_has_ready_input_reference THEN
        RETURN jsonb_build_object(
          'disposition', 'keep', 'reason', 'ready_input_reference',
          'artifact_id', v_artifact.id
        );
      END IF;
      RETURN jsonb_build_object(
        'disposition', 'delete', 'reason', 'artifact_tombstoned',
        'artifact_id', v_artifact.id
      );
    END IF;
    IF v_artifact.state = 'pending' AND (
      v_run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
      OR v_run.stop_requested_at IS NOT NULL
    ) THEN
      RETURN jsonb_build_object(
        'disposition', 'tombstone', 'reason', 'pending_run_stopped',
        'artifact_id', v_artifact.id,
        'state_version', v_artifact.state_version,
        'artifact_updated_at', v_artifact.updated_at
      );
    END IF;
    RETURN jsonb_build_object(
      'disposition', 'keep', 'reason', 'active_pending_artifact',
      'artifact_id', v_artifact.id
    );
  END IF;

  SELECT run.* INTO v_run FROM public.compute_runs AS run
  WHERE run.id = p_run_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'disposition', 'delete', 'reason', 'run_missing'
    );
  END IF;
  IF v_run.user_id IS DISTINCT FROM p_user_id
     OR v_run.agent_id IS DISTINCT FROM p_agent_id THEN
    RETURN jsonb_build_object(
      'disposition', 'keep', 'reason', 'run_scope_mismatch'
    );
  END IF;
  IF v_run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
     OR v_run.stop_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'disposition', 'delete', 'reason', 'unreferenced_stopped_run'
    );
  END IF;
  RETURN jsonb_build_object(
    'disposition', 'keep', 'reason', 'unreferenced_active_run'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_compute_artifact_immutability()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_compute_artifact(
  uuid, uuid, uuid, uuid, text, text, bigint, text, text, bigint
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fence_compute_dlq_run(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.terminalize_compute_dlq_run(uuid, bigint, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_compute_artifact_reconciliation_cursor()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.advance_compute_artifact_reconciliation_cursor(bigint, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_stale_pending_compute_artifacts(
  timestamptz, timestamptz, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tombstone_stale_pending_compute_artifact(
  uuid, bigint, timestamptz, timestamptz
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.classify_compute_artifact_object(text, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.transition_compute_artifact(
  uuid, uuid, uuid, uuid, text, text, bigint, text, text, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.fence_compute_dlq_run(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.terminalize_compute_dlq_run(uuid, bigint, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_compute_artifact_reconciliation_cursor()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.advance_compute_artifact_reconciliation_cursor(bigint, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.list_stale_pending_compute_artifacts(
  timestamptz, timestamptz, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.tombstone_stale_pending_compute_artifact(
  uuid, bigint, timestamptz, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.classify_compute_artifact_object(text, uuid, uuid, uuid)
  TO service_role;
