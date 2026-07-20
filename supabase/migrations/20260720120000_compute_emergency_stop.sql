-- Audited, resumable operator emergency stop for Galactic Compute.
--
-- New admission remains controlled by COMPUTE_ENABLED in the API. This
-- migration adds the independent execution stop: one operation snapshots and
-- fences all nonterminal runs, then the API destroys each claimed Sandbox
-- before using the existing cancellation settlement coordinator. Every
-- operation and per-run outcome remains queryable, and the event ledger is
-- append-only even to the service role.

CREATE TABLE public.compute_emergency_stop_operations (
  id uuid PRIMARY KEY,
  request_hash text NOT NULL,
  operator_reference text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  cutoff_at timestamptz NOT NULL,
  target_count integer NOT NULL DEFAULT 0,
  terminalized_count integer NOT NULL DEFAULT 0,
  release_request_hash text,
  release_operator_reference text,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  released_at timestamptz,
  CONSTRAINT compute_emergency_stop_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT compute_emergency_stop_operator_check CHECK (
    length(btrim(operator_reference)) BETWEEN 1 AND 128
    AND operator_reference !~ '[[:cntrl:]]'
  ),
  CONSTRAINT compute_emergency_stop_reason_check CHECK (
    length(btrim(reason)) BETWEEN 1 AND 1024
    AND reason !~ '[[:cntrl:]]'
  ),
  CONSTRAINT compute_emergency_stop_status_check
    CHECK (status IN ('active', 'completed', 'released')),
  CONSTRAINT compute_emergency_stop_count_check CHECK (
    target_count >= 0 AND terminalized_count >= 0
    AND terminalized_count <= target_count
  ),
  CONSTRAINT compute_emergency_stop_completion_check CHECK (
    (status = 'active' AND completed_at IS NULL AND released_at IS NULL
      AND release_request_hash IS NULL
      AND release_operator_reference IS NULL AND release_reason IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL
      AND released_at IS NULL AND release_request_hash IS NULL
      AND release_operator_reference IS NULL AND release_reason IS NULL)
    OR (status = 'released' AND completed_at IS NOT NULL
      AND released_at IS NOT NULL
      AND release_request_hash IS NOT NULL
      AND release_operator_reference IS NOT NULL
      AND release_reason IS NOT NULL
      AND release_request_hash ~ '^[0-9a-f]{64}$'
      AND length(btrim(release_operator_reference)) BETWEEN 1 AND 128
      AND release_operator_reference !~ '[[:cntrl:]]'
      AND length(btrim(release_reason)) BETWEEN 1 AND 1024
      AND release_reason !~ '[[:cntrl:]]')
  )
);

-- Only one global emergency-stop coordinator may own nonterminal work. The
-- operation id itself is the idempotency key for retries of that coordinator.
CREATE UNIQUE INDEX compute_emergency_stop_one_active_idx
  ON public.compute_emergency_stop_operations ((true))
  WHERE status IN ('active', 'completed');

CREATE TABLE public.compute_emergency_stop_targets (
  operation_id uuid NOT NULL
    REFERENCES public.compute_emergency_stop_operations(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES public.compute_runs(id) ON DELETE RESTRICT,
  run_created_at timestamptz NOT NULL,
  fenced_state text NOT NULL,
  fenced_state_version bigint NOT NULL,
  requires_body_destroy boolean NOT NULL,
  status text NOT NULL DEFAULT 'fenced',
  attempt_count integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error_code text,
  body_destroyed_at timestamptz,
  outcome text,
  receipt_id uuid REFERENCES public.compute_run_receipts(id) ON DELETE RESTRICT,
  fenced_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (operation_id, run_id),
  CONSTRAINT compute_emergency_stop_target_state_check CHECK (
    fenced_state IN ('admitted', 'queued', 'provisioning', 'running')
  ),
  CONSTRAINT compute_emergency_stop_target_version_check
    CHECK (fenced_state_version >= 1),
  CONSTRAINT compute_emergency_stop_target_status_check
    CHECK (status IN ('fenced', 'terminalized')),
  CONSTRAINT compute_emergency_stop_target_attempt_check
    CHECK (attempt_count >= 0),
  CONSTRAINT compute_emergency_stop_target_error_check CHECK (
    last_error_code IS NULL OR (
      length(last_error_code) BETWEEN 1 AND 128
      AND last_error_code ~ '^[A-Z][A-Z0-9_]*$'
    )
  ),
  CONSTRAINT compute_emergency_stop_target_outcome_check CHECK (
    outcome IS NULL
    OR outcome IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
  ),
  CONSTRAINT compute_emergency_stop_target_completion_check CHECK (
    (status = 'fenced' AND completed_at IS NULL
      AND outcome IS NULL AND receipt_id IS NULL)
    OR (status = 'terminalized' AND completed_at IS NOT NULL
      AND outcome IS NOT NULL AND receipt_id IS NOT NULL)
  ),
  CONSTRAINT compute_emergency_stop_target_destroy_check CHECK (
    body_destroyed_at IS NULL OR requires_body_destroy
  )
);

CREATE INDEX compute_emergency_stop_targets_pending_idx
  ON public.compute_emergency_stop_targets
  (operation_id, status, run_created_at, run_id);

CREATE TABLE public.compute_emergency_stop_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL
    REFERENCES public.compute_emergency_stop_operations(id) ON DELETE RESTRICT,
  run_id uuid REFERENCES public.compute_runs(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compute_emergency_stop_event_type_check CHECK (
    event_type IN (
      'operation_requested', 'run_fenced', 'target_attempt_failed',
      'run_terminalized', 'operation_completed', 'operation_released'
    )
  ),
  CONSTRAINT compute_emergency_stop_event_details_check
    CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX compute_emergency_stop_events_operation_idx
  ON public.compute_emergency_stop_events (operation_id, created_at, id);

CREATE OR REPLACE FUNCTION public.compute_emergency_stop_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'compute_emergency_stop_events is append-only';
END;
$$;

CREATE TRIGGER compute_emergency_stop_events_no_mutate
BEFORE UPDATE OR DELETE ON public.compute_emergency_stop_events
FOR EACH ROW EXECUTE FUNCTION public.compute_emergency_stop_events_append_only();

-- Serialize run insertion with operation creation. Admissions and ordinary
-- state transitions take the shared side so they remain concurrent; the stop
-- operation takes the exclusive side. If an admission/claim started first,
-- the stop waits and includes it. If the stop started first, no direct or API
-- admission or queued claim can slip into the active operation window.
CREATE OR REPLACE FUNCTION public.block_compute_admission_during_emergency_stop()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('compute-emergency-stop', 0)
  );
  IF EXISTS (
    SELECT 1 FROM public.compute_emergency_stop_operations
    WHERE status IN ('active', 'completed')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_EMERGENCY_STOP_ACTIVE',
      'message', 'Compute admission is blocked by an active emergency stop.'
    )::text;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER compute_emergency_stop_blocks_admission
BEFORE INSERT ON public.compute_runs
FOR EACH ROW EXECUTE FUNCTION public.block_compute_admission_during_emergency_stop();

CREATE OR REPLACE FUNCTION public.interlock_compute_state_transition_with_emergency_stop()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('compute-emergency-stop', 0)
  );
  RETURN NULL;
END;
$$;

-- Statement-level acquisition happens before claim_compute_run takes a row
-- lock, preserving the emergency-stop lock order without serializing ordinary
-- transitions against one another.
CREATE TRIGGER compute_emergency_stop_state_transition_interlock
BEFORE UPDATE OF state ON public.compute_runs
FOR EACH STATEMENT
EXECUTE FUNCTION public.interlock_compute_state_transition_with_emergency_stop();

CREATE OR REPLACE FUNCTION public.block_compute_claim_during_emergency_stop()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (
       (OLD.state IN ('admitted', 'queued') AND NEW.state = 'provisioning')
       OR (OLD.state = 'provisioning' AND NEW.state = 'running')
     )
     AND EXISTS (
       SELECT 1 FROM public.compute_emergency_stop_operations
       WHERE status IN ('active', 'completed')
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_EMERGENCY_STOP_ACTIVE',
      'message', 'Compute claim or body start is blocked by an active emergency stop.'
    )::text;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER compute_emergency_stop_blocks_claim
BEFORE UPDATE OF state ON public.compute_runs
FOR EACH ROW
EXECUTE FUNCTION public.block_compute_claim_during_emergency_stop();

CREATE OR REPLACE FUNCTION public.fence_compute_emergency_stop_batch(
  p_operation_id uuid,
  p_request_hash text,
  p_operator_reference text,
  p_reason text,
  p_limit integer DEFAULT 25
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operation public.compute_emergency_stop_operations%ROWTYPE;
  v_run public.compute_runs%ROWTYPE;
  v_targets jsonb := '[]'::jsonb;
  v_replayed boolean := false;
  v_inserted integer := 0;
BEGIN
  IF p_operation_id IS NULL
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR length(btrim(COALESCE(p_operator_reference, ''))) NOT BETWEEN 1 AND 128
     OR p_operator_reference ~ '[[:cntrl:]]'
     OR length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 1 AND 1024
     OR p_reason ~ '[[:cntrl:]]'
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_EMERGENCY_STOP_INVALID',
      'message', 'The emergency-stop request is invalid.'
    )::text;
  END IF;

  SELECT operation.* INTO v_operation
  FROM public.compute_emergency_stop_operations AS operation
  WHERE operation.id = p_operation_id;

  IF NOT FOUND THEN
    -- Creating the latch takes the exclusive side of the admission/state
    -- interlock, but deliberately touches no run row in this transaction. A
    -- claimant that already holds a run row can therefore finish or observe
    -- the new latch without forming an advisory-lock/row-lock cycle.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('compute-emergency-stop', 0)
    );
    SELECT operation.* INTO v_operation
    FROM public.compute_emergency_stop_operations AS operation
    WHERE operation.id = p_operation_id
    FOR UPDATE;
    IF FOUND THEN
      v_replayed := true;
      IF v_operation.request_hash IS DISTINCT FROM p_request_hash
         OR v_operation.operator_reference IS DISTINCT FROM btrim(p_operator_reference)
         OR v_operation.reason IS DISTINCT FROM btrim(p_reason) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
          'code', 'COMPUTE_EMERGENCY_STOP_IDEMPOTENCY_CONFLICT',
          'message', 'The emergency-stop idempotency key was reused with a different request.'
        )::text;
      END IF;
      IF v_operation.status = 'released' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
          'code', 'COMPUTE_EMERGENCY_STOP_RELEASED',
          'message', 'The completed emergency-stop operation has been released.'
        )::text;
      END IF;
      RETURN jsonb_build_object(
        'operation_id', v_operation.id,
        'status', v_operation.status,
        'cutoff_at', v_operation.cutoff_at,
        'target_count', v_operation.target_count,
        'terminalized_count', v_operation.terminalized_count,
        'targets', '[]'::jsonb,
        'initializing', v_operation.status = 'active',
        'replayed', true
      );
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.compute_emergency_stop_operations
      WHERE status IN ('active', 'completed')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_EMERGENCY_STOP_ACTIVE',
        'message', 'Another emergency-stop operation is still active.'
      )::text;
    END IF;
    INSERT INTO public.compute_emergency_stop_operations (
      id, request_hash, operator_reference, reason, cutoff_at
    ) VALUES (
      p_operation_id, p_request_hash, btrim(p_operator_reference),
      btrim(p_reason), clock_timestamp()
    ) RETURNING * INTO v_operation;
    INSERT INTO public.compute_emergency_stop_events (
      operation_id, event_type, details
    ) VALUES (
      v_operation.id, 'operation_requested', jsonb_build_object(
        'operatorReference', v_operation.operator_reference,
        'reason', v_operation.reason,
        'cutoffAt', v_operation.cutoff_at
      )
    );
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'cutoff_at', v_operation.cutoff_at,
      'target_count', v_operation.target_count,
      'terminalized_count', v_operation.terminalized_count,
      'targets', '[]'::jsonb,
      'initializing', true,
      'replayed', false
    );
  END IF;

  SELECT operation.* INTO v_operation
  FROM public.compute_emergency_stop_operations AS operation
  WHERE operation.id = p_operation_id
  FOR UPDATE;
  v_replayed := true;
  IF v_operation.request_hash IS DISTINCT FROM p_request_hash
     OR v_operation.operator_reference IS DISTINCT FROM btrim(p_operator_reference)
     OR v_operation.reason IS DISTINCT FROM btrim(p_reason) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_EMERGENCY_STOP_IDEMPOTENCY_CONFLICT',
      'message', 'The emergency-stop idempotency key was reused with a different request.'
    )::text;
  END IF;

  IF v_operation.status = 'completed' THEN
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'cutoff_at', v_operation.cutoff_at,
      'target_count', v_operation.target_count,
      'terminalized_count', v_operation.terminalized_count,
      'targets', '[]'::jsonb,
      'initializing', false,
      'replayed', true
    );
  END IF;
  IF v_operation.status = 'released' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_EMERGENCY_STOP_RELEASED',
      'message', 'The completed emergency-stop operation has been released.'
    )::text;
  END IF;

  -- A retry always receives the oldest unresolved batch before any new runs
  -- are fenced. This makes partial destruction/settlement deterministic.
  SELECT COALESCE(jsonb_agg(target_row.payload ORDER BY target_row.run_created_at,
    target_row.run_id), '[]'::jsonb)
  INTO v_targets
  FROM (
    SELECT target.run_created_at, target.run_id, jsonb_build_object(
      'run_id', run.id,
      'user_id', run.user_id,
      'agent_id', run.agent_id,
      'caller_function', run.caller_function,
      'state', run.state,
      'state_version', run.state_version,
      'requires_body_destroy', target.requires_body_destroy,
      'attempt_count', target.attempt_count,
      'last_error_code', target.last_error_code
    ) AS payload
    FROM public.compute_emergency_stop_targets AS target
    JOIN public.compute_runs AS run ON run.id = target.run_id
    WHERE target.operation_id = v_operation.id AND target.status = 'fenced'
    ORDER BY target.run_created_at, target.run_id
    LIMIT p_limit
  ) AS target_row;
  IF jsonb_array_length(v_targets) > 0 THEN
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'cutoff_at', v_operation.cutoff_at,
      'target_count', v_operation.target_count,
      'terminalized_count', v_operation.terminalized_count,
      'targets', v_targets,
      'initializing', false,
      'replayed', true
    );
  END IF;

  FOR v_run IN
    SELECT run.*
    FROM public.compute_runs AS run
    WHERE run.created_at <= v_operation.cutoff_at
      AND run.state IN ('admitted', 'queued', 'provisioning', 'running')
      AND NOT EXISTS (
        SELECT 1 FROM public.compute_emergency_stop_targets AS target
        WHERE target.operation_id = v_operation.id AND target.run_id = run.id
      )
    ORDER BY run.created_at, run.id
    LIMIT p_limit
    FOR UPDATE OF run
  LOOP
    IF v_run.stop_requested_at IS NULL THEN
      UPDATE public.compute_runs AS run
      SET stop_requested_at = now(),
          stop_reason = 'operator_emergency_stop:' || v_operation.id::text,
          state_version = run.state_version + 1,
          updated_at = now()
      WHERE run.id = v_run.id
      RETURNING * INTO v_run;
    END IF;
    INSERT INTO public.compute_emergency_stop_targets (
      operation_id, run_id, run_created_at, fenced_state,
      fenced_state_version, requires_body_destroy
    ) VALUES (
      v_operation.id, v_run.id, v_run.created_at, v_run.state,
      v_run.state_version, v_run.state IN ('provisioning', 'running')
    );
    INSERT INTO public.compute_emergency_stop_events (
      operation_id, run_id, event_type, details
    ) VALUES (
      v_operation.id, v_run.id, 'run_fenced', jsonb_build_object(
        'state', v_run.state,
        'stateVersion', v_run.state_version,
        'requiresBodyDestroy', v_run.state IN ('provisioning', 'running'),
        'existingStopFence', v_run.stop_reason IS DISTINCT FROM
          ('operator_emergency_stop:' || v_operation.id::text)
      )
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  IF v_inserted > 0 THEN
    UPDATE public.compute_emergency_stop_operations AS operation
    SET target_count = operation.target_count + v_inserted,
        updated_at = now()
    WHERE operation.id = v_operation.id
    RETURNING * INTO v_operation;

    SELECT COALESCE(jsonb_agg(target_row.payload ORDER BY target_row.run_created_at,
      target_row.run_id), '[]'::jsonb)
    INTO v_targets
    FROM (
      SELECT target.run_created_at, target.run_id, jsonb_build_object(
        'run_id', run.id,
        'user_id', run.user_id,
        'agent_id', run.agent_id,
        'caller_function', run.caller_function,
        'state', run.state,
        'state_version', run.state_version,
        'requires_body_destroy', target.requires_body_destroy,
        'attempt_count', target.attempt_count,
        'last_error_code', target.last_error_code
      ) AS payload
      FROM public.compute_emergency_stop_targets AS target
      JOIN public.compute_runs AS run ON run.id = target.run_id
      WHERE target.operation_id = v_operation.id AND target.status = 'fenced'
      ORDER BY target.run_created_at, target.run_id
      LIMIT p_limit
    ) AS target_row;
  ELSE
    UPDATE public.compute_emergency_stop_operations AS operation
    SET status = 'completed', completed_at = now(), updated_at = now()
    WHERE operation.id = v_operation.id AND operation.status = 'active'
      AND operation.terminalized_count = operation.target_count
      AND NOT EXISTS (
        SELECT 1 FROM public.compute_runs AS run
        WHERE run.created_at <= operation.cutoff_at
          AND run.state IN ('admitted', 'queued', 'provisioning', 'running')
      )
    RETURNING * INTO v_operation;
    IF FOUND THEN
      INSERT INTO public.compute_emergency_stop_events (
        operation_id, event_type, details
      ) VALUES (
        v_operation.id, 'operation_completed', jsonb_build_object(
          'targetCount', v_operation.target_count,
          'terminalizedCount', v_operation.terminalized_count
        )
      );
    ELSE
      SELECT operation.* INTO v_operation
      FROM public.compute_emergency_stop_operations AS operation
      WHERE operation.id = p_operation_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'cutoff_at', v_operation.cutoff_at,
    'target_count', v_operation.target_count,
    'terminalized_count', v_operation.terminalized_count,
    'targets', v_targets,
    'initializing', false,
    'replayed', v_replayed
  );
END;
$$;

-- Called only after the API has used the existing cancellation terminalizer.
-- For a claimed target, the Compute Plane's deterministic destroy confirmation
-- is mandatory even if another actor made the run terminal in the meantime.
CREATE OR REPLACE FUNCTION public.complete_compute_emergency_stop_target(
  p_operation_id uuid,
  p_run_id uuid,
  p_body_destroyed boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operation public.compute_emergency_stop_operations%ROWTYPE;
  v_target public.compute_emergency_stop_targets%ROWTYPE;
  v_run public.compute_runs%ROWTYPE;
  v_receipt public.compute_run_receipts%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL OR p_run_id IS NULL
     OR p_body_destroyed IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_EMERGENCY_STOP_INVALID',
      'message', 'Body destruction confirmation is required.'
    )::text;
  END IF;
  SELECT operation.* INTO v_operation
  FROM public.compute_emergency_stop_operations AS operation
  WHERE operation.id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_EMERGENCY_STOP_NOT_FOUND',
      'message', 'Emergency-stop operation not found.'
    )::text;
  END IF;
  SELECT target.* INTO v_target
  FROM public.compute_emergency_stop_targets AS target
  WHERE target.operation_id = p_operation_id AND target.run_id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_EMERGENCY_STOP_TARGET_NOT_FOUND',
      'message', 'Emergency-stop target not found.'
    )::text;
  END IF;
  IF v_target.status = 'terminalized' THEN
    RETURN jsonb_build_object(
      'operation_id', v_operation.id,
      'run_id', v_target.run_id,
      'status', v_target.status,
      'receipt_id', v_target.receipt_id,
      'outcome', v_target.outcome,
      'replayed', true
    );
  END IF;
  IF v_target.requires_body_destroy
     AND p_body_destroyed IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_BODY_DESTRUCTION_REQUIRED',
      'message', 'Destroy the claimed Sandbox before recording emergency settlement.'
    )::text;
  END IF;
  SELECT run.* INTO v_run FROM public.compute_runs AS run
  WHERE run.id = p_run_id FOR UPDATE;
  IF v_run.state NOT IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_EMERGENCY_STOP_NOT_TERMINAL',
      'message', 'The emergency-stop target has not been settled.'
    )::text;
  END IF;
  SELECT receipt.* INTO v_receipt
  FROM public.compute_run_receipts AS receipt
  WHERE receipt.run_id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_EMERGENCY_STOP_RECEIPT_REQUIRED',
      'message', 'The terminal Compute run has no durable receipt.'
    )::text;
  END IF;

  UPDATE public.compute_emergency_stop_targets AS target
  SET status = 'terminalized',
      attempt_count = target.attempt_count + 1,
      last_attempt_at = now(), last_error_code = NULL,
      body_destroyed_at = CASE WHEN target.requires_body_destroy
        THEN now() ELSE NULL END,
      outcome = v_run.state, receipt_id = v_receipt.id,
      completed_at = now()
  WHERE target.operation_id = p_operation_id AND target.run_id = p_run_id
  RETURNING * INTO v_target;
  UPDATE public.compute_emergency_stop_operations AS operation
  SET terminalized_count = operation.terminalized_count + 1,
      updated_at = now()
  WHERE operation.id = p_operation_id
  RETURNING * INTO v_operation;
  INSERT INTO public.compute_emergency_stop_events (
    operation_id, run_id, event_type, details
  ) VALUES (
    p_operation_id, p_run_id, 'run_terminalized', jsonb_build_object(
      'outcome', v_target.outcome,
      'receiptId', v_target.receipt_id,
      'bodyDestroyed', v_target.body_destroyed_at IS NOT NULL
    )
  );
  RETURN jsonb_build_object(
    'operation_id', v_operation.id,
    'run_id', v_target.run_id,
    'status', v_target.status,
    'receipt_id', v_target.receipt_id,
    'outcome', v_target.outcome,
    'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_compute_emergency_stop_target_failure(
  p_operation_id uuid,
  p_run_id uuid,
  p_phase text,
  p_error_code text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operation public.compute_emergency_stop_operations%ROWTYPE;
  v_target public.compute_emergency_stop_targets%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL OR p_run_id IS NULL
     OR p_phase IS NULL OR p_phase NOT IN ('destroy', 'terminalize', 'audit')
     OR p_error_code IS NULL
     OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,127}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_EMERGENCY_STOP_INVALID_FAILURE',
      'message', 'Emergency-stop failure metadata is invalid.'
    )::text;
  END IF;
  -- Keep the same operation -> target order as completion. The event insert
  -- below acquires a parent FK lock, so updating the target first would invert
  -- that order and deadlock an overlapping successful completion.
  SELECT operation.* INTO v_operation
  FROM public.compute_emergency_stop_operations AS operation
  WHERE operation.id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', false, 'replayed', true);
  END IF;
  UPDATE public.compute_emergency_stop_targets AS target
  SET attempt_count = target.attempt_count + 1,
      last_attempt_at = now(), last_error_code = p_error_code
  WHERE target.operation_id = p_operation_id AND target.run_id = p_run_id
    AND target.status = 'fenced'
  RETURNING * INTO v_target;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', false, 'replayed', true);
  END IF;
  INSERT INTO public.compute_emergency_stop_events (
    operation_id, run_id, event_type, details
  ) VALUES (
    p_operation_id, p_run_id, 'target_attempt_failed', jsonb_build_object(
      'phase', p_phase, 'errorCode', p_error_code,
      'attempt', v_target.attempt_count
    )
  );
  RETURN jsonb_build_object('recorded', true, 'replayed', false);
END;
$$;

-- Release is deliberately separate from both draining and the API feature
-- flag. Operators release the durable database latch while admission is still
-- off, validate recovery, and only then re-enable COMPUTE_ENABLED.
CREATE OR REPLACE FUNCTION public.release_compute_emergency_stop(
  p_operation_id uuid,
  p_request_hash text,
  p_operator_reference text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_operation public.compute_emergency_stop_operations%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR length(btrim(COALESCE(p_operator_reference, ''))) NOT BETWEEN 1 AND 128
     OR p_operator_reference ~ '[[:cntrl:]]'
     OR length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 1 AND 1024
     OR p_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_EMERGENCY_STOP_RELEASE_INVALID',
      'message', 'The emergency-stop release request is invalid.'
    )::text;
  END IF;
  SELECT operation.* INTO v_operation
  FROM public.compute_emergency_stop_operations AS operation
  WHERE operation.id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_EMERGENCY_STOP_NOT_FOUND',
      'message', 'Emergency-stop operation not found.'
    )::text;
  END IF;
  IF v_operation.status = 'released' THEN
    IF v_operation.release_request_hash IS DISTINCT FROM p_request_hash
       OR v_operation.release_operator_reference IS DISTINCT FROM btrim(p_operator_reference)
       OR v_operation.release_reason IS DISTINCT FROM btrim(p_reason) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_EMERGENCY_STOP_RELEASE_CONFLICT',
        'message', 'The release idempotency key was reused with a different request.'
      )::text;
    END IF;
    RETURN to_jsonb(v_operation) || jsonb_build_object('replayed', true);
  END IF;
  IF v_operation.status IS DISTINCT FROM 'completed'
     OR v_operation.terminalized_count IS DISTINCT FROM v_operation.target_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_EMERGENCY_STOP_NOT_COMPLETE',
      'message', 'Only a fully settled emergency stop may be released.'
    )::text;
  END IF;
  -- Lock the operation row before taking the exclusive admission interlock.
  -- An active batch can never wait on this transaction while holding a run
  -- row, so an erroneous early release cannot deadlock run settlement.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('compute-emergency-stop', 0)
  );
  UPDATE public.compute_emergency_stop_operations AS operation
  SET status = 'released', release_request_hash = p_request_hash,
      release_operator_reference = btrim(p_operator_reference),
      release_reason = btrim(p_reason), released_at = now(), updated_at = now()
  WHERE operation.id = p_operation_id RETURNING * INTO v_operation;
  INSERT INTO public.compute_emergency_stop_events (
    operation_id, event_type, details
  ) VALUES (
    p_operation_id, 'operation_released', jsonb_build_object(
      'operatorReference', v_operation.release_operator_reference,
      'reason', v_operation.release_reason,
      'releasedAt', v_operation.released_at
    )
  );
  RETURN to_jsonb(v_operation) || jsonb_build_object('replayed', false);
END;
$$;

ALTER TABLE public.compute_emergency_stop_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compute_emergency_stop_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compute_emergency_stop_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.compute_emergency_stop_operations
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.compute_emergency_stop_targets
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.compute_emergency_stop_events
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.compute_emergency_stop_operations TO service_role;
GRANT SELECT ON TABLE public.compute_emergency_stop_targets TO service_role;
GRANT SELECT ON TABLE public.compute_emergency_stop_events TO service_role;

REVOKE ALL ON FUNCTION public.compute_emergency_stop_events_append_only()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_compute_admission_during_emergency_stop()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.interlock_compute_state_transition_with_emergency_stop()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_compute_claim_during_emergency_stop()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fence_compute_emergency_stop_batch(
  uuid, text, text, text, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_compute_emergency_stop_target(
  uuid, uuid, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_compute_emergency_stop_target_failure(
  uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_compute_emergency_stop(
  uuid, text, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fence_compute_emergency_stop_batch(
  uuid, text, text, text, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_compute_emergency_stop_target(
  uuid, uuid, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_compute_emergency_stop_target_failure(
  uuid, uuid, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_compute_emergency_stop(
  uuid, text, text, text
) TO service_role;
