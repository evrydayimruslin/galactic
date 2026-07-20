-- Galactic Compute subscription-capacity conservation.
--
-- Billing attribution is immutable at admission. Wallet jobs retain the
-- existing cloud-usage hold path. Subscription jobs acquire an independent,
-- positive-Light account/root-Agent capacity reservation at lease start. The
-- independent reservation is intentional: a parent execution and its Compute
-- VM each consume a distributed capacity/concurrency lease, while the Compute
-- policy continues to impose its separate per-Agent body limit.

ALTER TABLE public.compute_runs
  ADD COLUMN billing_mode text NOT NULL DEFAULT 'wallet',
  ADD COLUMN capacity_agent_id uuid REFERENCES public.apps(id) ON DELETE RESTRICT,
  ADD COLUMN capacity_reservation_id uuid
    REFERENCES public.account_capacity_reservations(id) ON DELETE RESTRICT;

UPDATE public.compute_runs
SET capacity_agent_id = agent_id
WHERE capacity_agent_id IS NULL;

ALTER TABLE public.compute_runs
  ALTER COLUMN capacity_agent_id SET NOT NULL,
  ADD CONSTRAINT compute_runs_billing_mode_check
    CHECK (billing_mode IN ('wallet', 'subscription_capacity')),
  ADD CONSTRAINT compute_runs_billing_shape_check CHECK (
    (billing_mode = 'wallet' AND capacity_reservation_id IS NULL)
    OR (billing_mode = 'subscription_capacity' AND capacity_agent_id IS NOT NULL)
  );

CREATE UNIQUE INDEX compute_runs_capacity_reservation_unique
  ON public.compute_runs(capacity_reservation_id)
  WHERE capacity_reservation_id IS NOT NULL;

ALTER TABLE public.compute_run_budget_reservations
  ALTER COLUMN hold_id DROP NOT NULL,
  ADD COLUMN billing_mode text NOT NULL DEFAULT 'wallet',
  ADD COLUMN capacity_agent_id uuid REFERENCES public.apps(id) ON DELETE RESTRICT,
  ADD COLUMN capacity_reservation_id uuid
    REFERENCES public.account_capacity_reservations(id) ON DELETE RESTRICT;

UPDATE public.compute_run_budget_reservations AS budget
SET billing_mode = run.billing_mode,
    capacity_agent_id = run.capacity_agent_id,
    capacity_reservation_id = run.capacity_reservation_id
FROM public.compute_runs AS run
WHERE run.id = budget.run_id;

ALTER TABLE public.compute_run_budget_reservations
  ALTER COLUMN capacity_agent_id SET NOT NULL,
  DROP CONSTRAINT compute_budget_amount_check,
  DROP CONSTRAINT compute_budget_status_check,
  DROP CONSTRAINT compute_budget_settlement_shape_check,
  ADD CONSTRAINT compute_budget_billing_mode_check
    CHECK (billing_mode IN ('wallet', 'subscription_capacity')),
  ADD CONSTRAINT compute_budget_backing_check CHECK (
    (
      billing_mode = 'wallet'
      AND hold_id IS NOT NULL
      AND capacity_reservation_id IS NULL
    ) OR (
      billing_mode = 'subscription_capacity'
      AND hold_id IS NULL
      AND capacity_reservation_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT compute_budget_amount_check CHECK (
    reserved_light >= 0 AND actual_light >= 0 AND released_light >= 0
    AND released_light <= reserved_light
    AND (
      (billing_mode = 'wallet' AND actual_light <= reserved_light)
      OR (
        billing_mode = 'subscription_capacity'
        AND released_light = GREATEST(reserved_light - actual_light, 0)
      )
    )
  ),
  ADD CONSTRAINT compute_budget_status_check CHECK (
    status IN ('reserved', 'settlement_pending', 'settled', 'released')
    AND (billing_mode = 'subscription_capacity' OR status <> 'settlement_pending')
  ),
  ADD CONSTRAINT compute_budget_settlement_shape_check CHECK (
    (status IN ('reserved', 'settlement_pending') AND settled_at IS NULL)
    OR (status IN ('settled', 'released') AND settled_at IS NOT NULL)
  );

CREATE UNIQUE INDEX compute_budget_capacity_reservation_unique
  ON public.compute_run_budget_reservations(capacity_reservation_id)
  WHERE capacity_reservation_id IS NOT NULL;

ALTER TABLE public.compute_run_receipts
  ADD COLUMN billing_mode text NOT NULL DEFAULT 'wallet',
  ADD COLUMN capacity_agent_id uuid REFERENCES public.apps(id) ON DELETE RESTRICT,
  ADD COLUMN capacity_reservation_id uuid
    REFERENCES public.account_capacity_reservations(id) ON DELETE RESTRICT,
  ADD COLUMN capacity_settlement_status text NOT NULL DEFAULT 'not_applicable';

UPDATE public.compute_run_receipts AS receipt
SET billing_mode = run.billing_mode,
    capacity_agent_id = run.capacity_agent_id,
    capacity_reservation_id = run.capacity_reservation_id,
    capacity_settlement_status = CASE
      WHEN run.billing_mode = 'subscription_capacity'
        AND run.capacity_reservation_id IS NOT NULL THEN 'pending'
      ELSE 'not_applicable'
    END
FROM public.compute_runs AS run
WHERE run.id = receipt.run_id;

ALTER TABLE public.compute_run_receipts
  ALTER COLUMN capacity_agent_id SET NOT NULL,
  DROP CONSTRAINT compute_receipt_amount_check,
  ADD CONSTRAINT compute_receipt_billing_mode_check
    CHECK (billing_mode IN ('wallet', 'subscription_capacity')),
  ADD CONSTRAINT compute_receipt_capacity_status_check CHECK (
    capacity_settlement_status IN ('not_applicable', 'pending', 'settled')
  ),
  ADD CONSTRAINT compute_receipt_amount_check CHECK (
    reserved_light >= 0 AND actual_light >= 0 AND released_light >= 0
    AND released_light <= reserved_light
    AND (
      (
        billing_mode = 'wallet'
        AND actual_light <= reserved_light
        AND actual_light + released_light = reserved_light
      ) OR (
        billing_mode = 'subscription_capacity'
        AND released_light = GREATEST(reserved_light - actual_light, 0)
      )
    )
  ),
  ADD CONSTRAINT compute_receipt_billing_shape_check CHECK (
    (
      billing_mode = 'wallet'
      AND capacity_reservation_id IS NULL
      AND capacity_settlement_status = 'not_applicable'
    ) OR (
      billing_mode = 'subscription_capacity'
      AND hold_id IS NULL
      AND cloud_usage_event_id IS NULL
      AND (
        (capacity_reservation_id IS NULL
          AND capacity_settlement_status = 'not_applicable')
        OR (capacity_reservation_id IS NOT NULL
          AND capacity_settlement_status IN ('pending', 'settled'))
      )
    )
  );

CREATE OR REPLACE FUNCTION public.fill_compute_budget_billing_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_run public.compute_runs%ROWTYPE;
BEGIN
  SELECT run.* INTO v_run
  FROM public.compute_runs AS run
  WHERE run.id = NEW.run_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Compute run not found for budget'; END IF;
  NEW.billing_mode := v_run.billing_mode;
  NEW.capacity_agent_id := v_run.capacity_agent_id;
  NEW.capacity_reservation_id := v_run.capacity_reservation_id;
  IF v_run.billing_mode = 'subscription_capacity' THEN
    NEW.hold_id := NULL;
    IF NEW.capacity_reservation_id IS NULL THEN
      RAISE EXCEPTION 'Subscription Compute budget requires a capacity reservation';
    END IF;
  ELSIF NEW.hold_id IS NULL THEN
    RAISE EXCEPTION 'Wallet Compute budget requires a cloud usage hold';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fill_compute_budget_billing_context
BEFORE INSERT ON public.compute_run_budget_reservations
FOR EACH ROW EXECUTE FUNCTION public.fill_compute_budget_billing_context();

CREATE OR REPLACE FUNCTION public.fill_compute_receipt_billing_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.compute_runs%ROWTYPE;
  v_budget public.compute_run_budget_reservations%ROWTYPE;
BEGIN
  SELECT run.* INTO v_run
  FROM public.compute_runs AS run
  WHERE run.id = NEW.run_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Compute run not found for receipt'; END IF;
  SELECT budget.* INTO v_budget
  FROM public.compute_run_budget_reservations AS budget
  WHERE budget.run_id = NEW.run_id;

  NEW.billing_mode := v_run.billing_mode;
  NEW.capacity_agent_id := v_run.capacity_agent_id;
  NEW.capacity_reservation_id := v_run.capacity_reservation_id;
  IF v_run.billing_mode = 'subscription_capacity' THEN
    NEW.hold_id := NULL;
    NEW.cloud_usage_event_id := NULL;
    NEW.capacity_settlement_status := CASE
      WHEN v_run.capacity_reservation_id IS NULL THEN 'not_applicable'
      WHEN v_budget.status = 'settled' THEN 'settled'
      ELSE 'pending'
    END;
  ELSE
    NEW.capacity_settlement_status := 'not_applicable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fill_compute_receipt_billing_context
BEFORE INSERT ON public.compute_run_receipts
FOR EACH ROW EXECUTE FUNCTION public.fill_compute_receipt_billing_context();

-- Wrap the ownership-aware admission RPC. The old implementation remains
-- private; no caller can omit the trusted billing route.
ALTER FUNCTION public.admit_compute_run(
  uuid, text, uuid, uuid, text, text, text, text, text, jsonb, jsonb,
  timestamptz, jsonb
) RENAME TO admit_compute_run_capacity_impl;

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
  p_billing_mode text,
  p_capacity_agent_id uuid,
  p_authorities jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_result jsonb;
  v_run public.compute_runs%ROWTYPE;
  v_lock_id uuid;
  v_locked integer := 0;
  v_expected integer;
BEGIN
  IF p_billing_mode NOT IN ('wallet', 'subscription_capacity')
     OR p_capacity_agent_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_ADMISSION',
      'message', 'Compute billing attribution is invalid.'
    )::text;
  END IF;

  v_expected := CASE WHEN p_agent_id = p_capacity_agent_id THEN 1 ELSE 2 END;
  FOR v_lock_id IN
    SELECT app.id
    FROM public.apps AS app
    WHERE app.id = ANY (ARRAY[p_agent_id, p_capacity_agent_id])
      AND app.owner_id = p_user_id
      AND app.deleted_at IS NULL
    ORDER BY app.id
    FOR SHARE
  LOOP
    v_locked := v_locked + 1;
  END LOOP;
  IF v_locked <> v_expected THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_CAPACITY_ATTRIBUTION_INVALID',
      'message', 'The root capacity Agent is not owned and live.'
    )::text;
  END IF;

  v_result := public.admit_compute_run_capacity_impl(
    p_idempotency_key, p_request_hash, p_user_id, p_agent_id,
    p_caller_function, p_execution_id, p_directive_hash, p_profile,
    p_environment_digest, p_execution_request, p_manifest_ceiling,
    p_expires_at, p_authorities
  );
  SELECT run.* INTO v_run
  FROM public.compute_runs AS run
  WHERE run.id = (v_result->>'id')::uuid
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Compute admission returned no run'; END IF;

  IF COALESCE((v_result->>'replayed')::boolean, false) THEN
    IF v_run.billing_mode IS DISTINCT FROM p_billing_mode
       OR v_run.capacity_agent_id IS DISTINCT FROM p_capacity_agent_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_IDEMPOTENCY_CONFLICT',
        'message', 'The idempotency key was already used for different billing attribution.'
      )::text;
    END IF;
  ELSE
    UPDATE public.compute_runs AS run
    SET billing_mode = p_billing_mode,
        capacity_agent_id = p_capacity_agent_id,
        updated_at = now()
    WHERE run.id = v_run.id
    RETURNING * INTO v_run;
  END IF;
  RETURN to_jsonb(v_run) || jsonb_build_object(
    'replayed', COALESCE((v_result->>'replayed')::boolean, false)
  );
END;
$$;

-- Reserve subscription capacity in the same transaction as the budget row
-- and lease token. Any later validation failure rolls back all three.
ALTER FUNCTION public.prepare_compute_run_lease(
  uuid, text, uuid, uuid, text, text, jsonb, boolean
) RENAME TO prepare_compute_run_lease_capacity_impl;

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
  v_budget public.compute_run_budget_reservations%ROWTYPE;
  v_capacity record;
  v_timeout_ms bigint;
  v_reserved_wall_ms bigint;
  v_reserved_light numeric(28,12);
  v_lock_id uuid;
  v_locked integer := 0;
  v_expected integer;
BEGIN
  SELECT run.* INTO v_run
  FROM public.compute_runs AS run
  WHERE run.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_RUN_NOT_FOUND', 'message', 'Compute run not found.'
    )::text;
  END IF;
  IF v_run.billing_mode = 'wallet' THEN
    RETURN public.prepare_compute_run_lease_capacity_impl(
      p_run_id, p_container_id, p_token_id, p_token_lookup_id, p_token_digest,
      p_token_audience, p_expected_secret_bindings, p_replace_existing_token
    );
  END IF;
  IF v_run.billing_mode <> 'subscription_capacity'
     OR v_run.capacity_agent_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_LEASE',
      'message', 'Subscription Compute billing attribution is incomplete.'
    )::text;
  END IF;

  -- Source and root Agent locks are deterministic. The independent Compute
  -- reservation deliberately consumes another account/root-Agent concurrency
  -- slot even when the parent execution already owns a zero-Light lease.
  v_expected := CASE WHEN v_run.agent_id = v_run.capacity_agent_id THEN 1 ELSE 2 END;
  FOR v_lock_id IN
    SELECT app.id
    FROM public.apps AS app
    WHERE app.id = ANY (ARRAY[v_run.agent_id, v_run.capacity_agent_id])
      AND app.owner_id = v_run.user_id
      AND app.deleted_at IS NULL
    ORDER BY app.id
    FOR SHARE
  LOOP
    v_locked := v_locked + 1;
  END LOOP;
  IF v_locked <> v_expected THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_CAPACITY_ATTRIBUTION_INVALID',
      'message', 'The root capacity Agent is no longer owned and live.'
    )::text;
  END IF;
  PERFORM 1 FROM public.users AS owner
  WHERE owner.id = v_run.user_id
  FOR KEY SHARE NOWAIT;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'compute-agent:' || v_run.user_id::text || ':' || v_run.agent_id::text, 0
  ));
  SELECT run.* INTO v_run
  FROM public.compute_runs AS run
  WHERE run.id = p_run_id
  FOR UPDATE;

  v_timeout_ms := (v_run.execution_request->>'timeoutMs')::bigint;
  v_reserved_wall_ms := v_timeout_ms + 195000 + 15000;
  v_reserved_light :=
    (v_reserved_wall_ms * 0.000002056)::numeric(28,12);

  SELECT budget.* INTO v_budget
  FROM public.compute_run_budget_reservations AS budget
  WHERE budget.run_id = p_run_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_budget.billing_mode <> 'subscription_capacity'
       OR v_budget.capacity_agent_id IS DISTINCT FROM v_run.capacity_agent_id
       OR v_budget.capacity_reservation_id IS NULL
       OR v_run.capacity_reservation_id IS DISTINCT FROM
          v_budget.capacity_reservation_id
       OR v_budget.reserved_wall_ms IS DISTINCT FROM v_reserved_wall_ms
       OR v_budget.reserved_light IS DISTINCT FROM v_reserved_light THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_IDEMPOTENCY_CONFLICT',
        'message', 'The existing Compute capacity reservation does not match the lease.'
      )::text;
    END IF;
    RETURN public.prepare_compute_run_lease_capacity_impl(
      p_run_id, p_container_id, p_token_id, p_token_lookup_id, p_token_digest,
      p_token_audience, p_expected_secret_bindings, p_replace_existing_token
    );
  END IF;

  SELECT * INTO v_capacity
  FROM public.reserve_account_capacity_v3(
    v_run.user_id,
    v_run.capacity_agent_id,
    'galactic_compute:reserve:' || v_run.id::text,
    v_reserved_light::double precision,
    v_run.expires_at,
    false,
    NULL::uuid,
    NULL::uuid,
    jsonb_build_object(
      'surface', 'compute',
      'compute_run_id', v_run.id,
      'compute_receipt_id', v_run.receipt_id,
      'source_agent_id', v_run.agent_id,
      'capacity_agent_id', v_run.capacity_agent_id,
      'rate_version', 'compute-rate-v1',
      'reserved_wall_ms', v_reserved_wall_ms,
      'nested_concurrency', 'independent_compute_lease'
    ),
    now()
  );
  IF v_capacity.allowed IS DISTINCT FROM true
     OR v_capacity.reservation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', CASE WHEN v_capacity.code = 'concurrency_waiting'
        THEN 'COMPUTE_CONCURRENCY_LIMIT'
        ELSE 'COMPUTE_INSUFFICIENT_BUDGET' END,
      'message', 'The account or root Agent has insufficient capacity for this Compute lease.'
    )::text;
  END IF;

  UPDATE public.compute_runs AS run
  SET capacity_reservation_id = v_capacity.reservation_id,
      updated_at = now()
  WHERE run.id = v_run.id
    AND run.capacity_reservation_id IS NULL
  RETURNING * INTO v_run;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_IDEMPOTENCY_CONFLICT',
      'message', 'The Compute run already has a different capacity reservation.'
    )::text;
  END IF;

  INSERT INTO public.compute_run_budget_reservations (
    run_id, user_id, hold_id, rate_version, rate_light_per_ms,
    requested_timeout_ms, startup_allowance_ms, teardown_allowance_ms,
    reserved_wall_ms, reserved_light, expires_at
  ) VALUES (
    v_run.id, v_run.user_id, NULL, 'compute-rate-v1', 0.000002056,
    v_timeout_ms, 195000, 15000, v_reserved_wall_ms,
    v_reserved_light, v_run.expires_at
  ) RETURNING * INTO v_budget;

  RETURN public.prepare_compute_run_lease_capacity_impl(
    p_run_id, p_container_id, p_token_id, p_token_lookup_id, p_token_digest,
    p_token_audience, p_expected_secret_bindings, p_replace_existing_token
  );
END;
$$;

-- Exact true-up for the terminal Compute receipt. Lock order is always
-- Compute run -> account-capacity advisory -> reservation -> budget -> receipt,
-- matching lease preparation and Queue/minute-reconciler replay.
CREATE OR REPLACE FUNCTION public.settle_compute_capacity_reservation(
  p_run_id uuid,
  p_user_id uuid,
  p_receipt_id uuid,
  p_capacity_reservation_id uuid,
  p_actual_light numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.compute_runs%ROWTYPE;
  v_budget public.compute_run_budget_reservations%ROWTYPE;
  v_receipt public.compute_run_receipts%ROWTYPE;
  v_res public.account_capacity_reservations%ROWTYPE;
  v_reserved_release double precision := 0;
  v_actual numeric(28,12);
BEGIN
  IF p_run_id IS NULL OR p_user_id IS NULL OR p_receipt_id IS NULL
     OR p_capacity_reservation_id IS NULL OR p_actual_light IS NULL
     OR p_actual_light < 0
     OR p_actual_light::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Invalid Compute capacity settlement';
  END IF;
  v_actual := p_actual_light::numeric(28,12);

  SELECT run.* INTO v_run
  FROM public.compute_runs AS run
  WHERE run.id = p_run_id AND run.user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_run.billing_mode <> 'subscription_capacity'
     OR v_run.receipt_id IS DISTINCT FROM p_receipt_id
     OR v_run.capacity_reservation_id IS DISTINCT FROM
        p_capacity_reservation_id THEN
    RAISE EXCEPTION 'Compute capacity settlement run mismatch';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('account_capacity:' || p_user_id::text, 0)
  );
  SELECT reservations.* INTO v_res
  FROM public.account_capacity_reservations AS reservations
  WHERE reservations.id = p_capacity_reservation_id
    AND reservations.user_id = p_user_id
  FOR UPDATE;
  SELECT budget.* INTO v_budget
  FROM public.compute_run_budget_reservations AS budget
  WHERE budget.run_id = p_run_id
  FOR UPDATE;
  SELECT receipt.* INTO v_receipt
  FROM public.compute_run_receipts AS receipt
  WHERE receipt.run_id = p_run_id AND receipt.id = p_receipt_id
  FOR UPDATE;

  IF v_res.id IS NULL OR v_budget.id IS NULL OR v_receipt.id IS NULL
     OR v_res.capacity_agent_id IS DISTINCT FROM v_run.capacity_agent_id
     OR v_res.metadata->>'compute_run_id' IS DISTINCT FROM v_run.id::text
     OR v_budget.billing_mode <> 'subscription_capacity'
     OR v_budget.capacity_agent_id IS DISTINCT FROM v_run.capacity_agent_id
     OR v_budget.capacity_reservation_id IS DISTINCT FROM v_res.id
     OR v_receipt.billing_mode <> 'subscription_capacity'
     OR v_receipt.capacity_agent_id IS DISTINCT FROM v_run.capacity_agent_id
     OR v_receipt.capacity_reservation_id IS DISTINCT FROM v_res.id
     OR v_receipt.actual_light IS DISTINCT FROM v_actual
     OR v_budget.actual_light IS DISTINCT FROM v_actual
     OR v_res.reserved_light::numeric(28,12) IS DISTINCT FROM
        v_budget.reserved_light THEN
    RAISE EXCEPTION 'Compute capacity settlement economic facts mismatch';
  END IF;

  IF v_res.status = 'settled' THEN
    IF v_res.actual_light::numeric(28,12) IS DISTINCT FROM v_actual THEN
      RAISE EXCEPTION 'Compute capacity settlement replay mismatch';
    END IF;
    UPDATE public.compute_run_budget_reservations
    SET status = 'settled', settled_at = COALESCE(settled_at, now()),
        updated_at = now()
    WHERE id = v_budget.id;
    UPDATE public.compute_run_receipts
    SET capacity_settlement_status = 'settled'
    WHERE id = v_receipt.id;
    RETURN jsonb_build_object(
      'run_id', v_run.id,
      'receipt_id', v_receipt.id,
      'capacity_reservation_id', v_res.id,
      'capacity_settlement_status', 'settled',
      'replayed', true
    );
  END IF;
  IF v_res.status NOT IN ('reserved', 'expired') THEN
    RAISE EXCEPTION 'Compute capacity reservation is not settleable';
  END IF;

  v_reserved_release := CASE
    WHEN v_res.status = 'reserved' THEN v_res.reserved_light
    ELSE 0
  END;
  UPDATE public.account_capacity_windows AS windows
  SET reserved_light = GREATEST(0, windows.reserved_light - v_reserved_release),
      used_light = windows.used_light + v_actual::double precision
  WHERE windows.user_id = p_user_id
    AND (
      (windows.window_kind = 'burst'
        AND windows.window_started_at = v_res.burst_window_started_at)
      OR (windows.window_kind = 'weekly'
        AND windows.window_started_at = v_res.weekly_window_started_at)
    );
  UPDATE public.agent_capacity_windows AS windows
  SET reserved_light = GREATEST(0, windows.reserved_light - v_reserved_release),
      used_light = windows.used_light + v_actual::double precision
  WHERE windows.user_id = p_user_id
    AND windows.capacity_agent_id = v_run.capacity_agent_id
    AND (
      (windows.window_kind = 'burst'
        AND windows.window_started_at = v_res.burst_window_started_at)
      OR (windows.window_kind = 'weekly'
        AND windows.window_started_at = v_res.weekly_window_started_at)
    );
  UPDATE public.account_capacity_reservations AS reservations
  SET status = 'settled', actual_light = v_actual::double precision,
      settled_at = now(),
      metadata = COALESCE(reservations.metadata, '{}'::jsonb) ||
        jsonb_build_object(
          'capacity_meter', 'compute-rate-v1',
          'compute_receipt_id', v_receipt.id,
          'recovered_after_expiry', v_res.status = 'expired'
        )
  WHERE reservations.id = v_res.id;
  UPDATE public.compute_run_budget_reservations
  SET status = 'settled', settled_at = now(), updated_at = now()
  WHERE id = v_budget.id;
  UPDATE public.compute_run_receipts
  SET capacity_settlement_status = 'settled'
  WHERE id = v_receipt.id;

  RETURN jsonb_build_object(
    'run_id', v_run.id,
    'receipt_id', v_receipt.id,
    'capacity_reservation_id', v_res.id,
    'capacity_settlement_status', 'settled',
    'replayed', false
  );
END;
$$;

-- The terminal receipt is a durable recovery source even if the Queue reaches
-- its DLQ. The minute Compute reconciler reads this bounded service-only list.
CREATE OR REPLACE FUNCTION public.list_pending_compute_capacity_settlements(
  p_limit integer DEFAULT 100
) RETURNS TABLE (
  run_id uuid,
  user_id uuid,
  receipt_id uuid,
  capacity_reservation_id uuid,
  actual_light numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Compute capacity settlement limit must be 1-500';
  END IF;
  RETURN QUERY
  SELECT receipt.run_id, receipt.user_id, receipt.id,
    receipt.capacity_reservation_id, receipt.actual_light
  FROM public.compute_run_receipts AS receipt
  WHERE receipt.billing_mode = 'subscription_capacity'
    AND receipt.capacity_settlement_status = 'pending'
    AND receipt.capacity_reservation_id IS NOT NULL
  ORDER BY receipt.created_at, receipt.id
  LIMIT p_limit;
END;
$$;

-- Replace the shared terminal transition so every Worker, cancellation, DLQ,
-- stale-run, and emergency-stop path produces the same billing-aware receipt.
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
     OR (p_to_state IN ('succeeded', 'failed')
       AND p_expected_state IN ('provisioning', 'running')
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
    IF v_budget.billing_mode IS DISTINCT FROM v_run.billing_mode
       OR v_budget.capacity_agent_id IS DISTINCT FROM v_run.capacity_agent_id
       OR (
         v_run.billing_mode = 'wallet'
         AND (v_budget.hold_id IS NULL
           OR v_budget.capacity_reservation_id IS NOT NULL)
       ) OR (
         v_run.billing_mode = 'subscription_capacity'
         AND (v_budget.hold_id IS NOT NULL
           OR v_budget.capacity_reservation_id IS NULL
           OR v_budget.capacity_reservation_id IS DISTINCT FROM
              v_run.capacity_reservation_id)
       ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_BUDGET_MISMATCH',
        'message', 'The Compute billing reservation does not match the run.'
      )::text;
    END IF;

    IF p_worker_wall_ms IS NULL THEN
      v_billed_wall_ms := 0;
      v_actual_light := 0;
      v_released_light := v_budget.reserved_light;
      IF v_run.billing_mode = 'wallet' THEN
        SELECT * INTO v_release FROM public.release_cloud_usage_hold(
          v_budget.hold_id,
          jsonb_build_object(
            'run_id', p_run_id, 'outcome', p_to_state,
            'reason', 'compute_body_not_started'
          ),
          'galactic_compute:release:' || p_run_id::text
        );
        UPDATE public.compute_run_budget_reservations AS budget
        SET actual_wall_ms = NULL, actual_light = 0,
            released_light = v_released_light, status = 'released',
            settled_at = now(), updated_at = now()
        WHERE budget.id = v_budget.id RETURNING * INTO v_budget;
      ELSE
        -- Capacity release is an economic true-up to zero. It remains pending
        -- until the direct path or durable recovery Queue settles it.
        UPDATE public.compute_run_budget_reservations AS budget
        SET actual_wall_ms = NULL, actual_light = 0,
            released_light = v_released_light,
            status = 'settlement_pending', settled_at = NULL,
            updated_at = now()
        WHERE budget.id = v_budget.id RETURNING * INTO v_budget;
      END IF;
    ELSE
      -- Body wall is measured through destruction. Wallet mode remains bounded
      -- by its funded hold. Subscription capacity records the complete actual
      -- overrun so later admission conserves the authoritative parent pool.
      v_worker_wall_ceiling_ms := v_budget.reserved_wall_ms;
      v_overrun_wall_ms := GREATEST(
        p_worker_wall_ms - v_worker_wall_ceiling_ms,
        0
      );
      IF v_run.billing_mode = 'wallet' THEN
        v_billed_wall_ms := LEAST(
          p_worker_wall_ms,
          v_budget.reserved_wall_ms
        );
        v_actual_light := LEAST(
          v_budget.reserved_light,
          (v_billed_wall_ms * v_budget.rate_light_per_ms)::numeric(28,12)
        );
        v_released_light := v_budget.reserved_light - v_actual_light;
      ELSE
        v_billed_wall_ms := p_worker_wall_ms;
        v_actual_light :=
          (v_billed_wall_ms * v_budget.rate_light_per_ms)::numeric(28,12);
        v_released_light := GREATEST(
          v_budget.reserved_light - v_actual_light,
          0
        );
      END IF;
      IF v_run.billing_mode = 'wallet' THEN
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
        SET actual_wall_ms = p_worker_wall_ms,
            actual_light = v_actual_light,
            released_light = v_released_light, status = 'settled',
            settled_at = now(), updated_at = now()
        WHERE budget.id = v_budget.id RETURNING * INTO v_budget;
      ELSE
        UPDATE public.compute_run_budget_reservations AS budget
        SET actual_wall_ms = p_worker_wall_ms,
            actual_light = v_actual_light,
            released_light = v_released_light,
            status = 'settlement_pending', settled_at = NULL,
            updated_at = now()
        WHERE budget.id = v_budget.id RETURNING * INTO v_budget;
      END IF;
    END IF;
  ELSE
    IF p_expected_state = 'running' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_BUDGET_MISSING',
        'message', 'A running Compute lease has no billing-backed reservation.'
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
         ) OR (v_output->>'artifactId') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
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
           OR v_existing_output.size_bytes IS DISTINCT FROM
              (v_output->>'sizeBytes')::bigint
           OR v_existing_output.media_type IS DISTINCT FROM
              lower(v_output->>'mediaType') THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
            'code', 'COMPUTE_OUTPUT_ARTIFACT_CONFLICT',
            'message', 'A pre-registered output does not match completion metadata.'
          )::text;
        END IF;
        CONTINUE;
      END IF;
      v_output_bytes := v_output_bytes + (v_output->>'sizeBytes')::bigint;
      v_output_count := v_output_count + 1;
      IF v_output_count >
           (v_run.policy_limits_snapshot->>'maxArtifacts')::integer
         OR v_output_bytes >
           (v_run.policy_limits_snapshot->>'maxArtifactBytes')::bigint THEN
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
      stdout = CASE WHEN p_to_state = 'succeeded'
        THEN p_result->>'stdout' ELSE NULL END,
      stderr = CASE WHEN p_to_state = 'succeeded'
        THEN p_result->>'stderr' ELSE NULL END,
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

REVOKE ALL ON FUNCTION public.fill_compute_budget_billing_context()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fill_compute_receipt_billing_context()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admit_compute_run_capacity_impl(
  uuid, text, uuid, uuid, text, text, text, text, text, jsonb, jsonb,
  timestamptz, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_compute_run_lease_capacity_impl(
  uuid, text, uuid, uuid, text, text, jsonb, boolean
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.admit_compute_run(
  uuid, text, uuid, uuid, text, text, text, text, text, jsonb, jsonb,
  timestamptz, text, uuid, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_compute_run_lease(
  uuid, text, uuid, uuid, text, text, jsonb, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_compute_run(
  uuid, uuid, uuid, text, uuid, text, bigint, text, bigint, text, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_compute_capacity_reservation(
  uuid, uuid, uuid, uuid, numeric
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_pending_compute_capacity_settlements(integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admit_compute_run(
  uuid, text, uuid, uuid, text, text, text, text, text, jsonb, jsonb,
  timestamptz, text, uuid, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_compute_run_lease(
  uuid, text, uuid, uuid, text, text, jsonb, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_compute_run(
  uuid, uuid, uuid, text, uuid, text, bigint, text, bigint, text, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_compute_capacity_reservation(
  uuid, uuid, uuid, uuid, numeric
) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_pending_compute_capacity_settlements(integer)
  TO service_role;
