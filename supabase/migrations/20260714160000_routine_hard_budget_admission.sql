-- Hard, pre-execution budget admission for persistent Agent runs.
-- Reservations make call-count and Light ceilings concurrency-safe and keep
-- manual runs under the same run/day/month limits as scheduled wakes.

CREATE TABLE IF NOT EXISTS public.routine_run_budget_reservations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  routine_id uuid NOT NULL REFERENCES public.user_routines(id) ON DELETE CASCADE,
  routine_run_id uuid NOT NULL REFERENCES public.routine_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reservation_key text NOT NULL,
  kind text NOT NULL,
  status text DEFAULT 'reserved'::text NOT NULL,
  reserved_light double precision DEFAULT 0 NOT NULL,
  actual_light double precision DEFAULT 0 NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  settled_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT routine_budget_reservation_kind_check
    CHECK (kind IN ('app_call', 'ai_call')),
  CONSTRAINT routine_budget_reservation_status_check
    CHECK (status IN ('reserved', 'settled', 'released')),
  CONSTRAINT routine_budget_reservation_reserved_check
    CHECK (reserved_light >= 0 AND reserved_light::text NOT IN ('NaN', 'Infinity', '-Infinity')),
  CONSTRAINT routine_budget_reservation_actual_check
    CHECK (actual_light >= 0 AND actual_light::text NOT IN ('NaN', 'Infinity', '-Infinity')),
  CONSTRAINT routine_budget_reservation_key_unique
    UNIQUE (routine_run_id, reservation_key)
);

ALTER TABLE public.routine_run_budget_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.routine_run_budget_reservations FROM anon, authenticated;
GRANT ALL ON TABLE public.routine_run_budget_reservations TO service_role;

CREATE INDEX IF NOT EXISTS idx_routine_budget_reservations_active
  ON public.routine_run_budget_reservations (routine_run_id, status, expires_at);

-- Day/month admission sums active reservations across every run of a routine.
-- Keep that per-call authorization query on a matching routine-first index.
CREATE INDEX IF NOT EXISTS idx_routine_budget_reservations_routine_active
  ON public.routine_run_budget_reservations (routine_id, status, expires_at);

CREATE OR REPLACE FUNCTION public.reserve_routine_run_budget(
  p_routine_id uuid,
  p_routine_run_id uuid,
  p_user_id uuid,
  p_reservation_key text,
  p_kind text,
  p_reserve_light double precision,
  p_expires_at timestamp with time zone
) RETURNS TABLE (
  allowed boolean,
  code text,
  message text,
  reservation_id uuid,
  reservation_key text,
  reserved_light double precision,
  calls_used integer,
  calls_limit integer,
  light_used double precision,
  light_reserved double precision,
  light_limit double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_run public.routine_runs%ROWTYPE;
  v_routine public.user_routines%ROWTYPE;
  v_existing public.routine_run_budget_reservations%ROWTYPE;
  v_id uuid;
  v_calls_used integer;
  v_calls_limit integer;
  v_reserved double precision;
  v_global_reserved double precision;
  v_run_limit double precision;
  v_day_limit double precision;
  v_month_limit double precision;
  v_day_spent double precision := 0;
  v_month_spent double precision := 0;
  v_effective_limit double precision;
  v_day_start timestamp with time zone :=
    date_trunc('day', timezone('UTC', now())) AT TIME ZONE 'UTC';
  v_month_start timestamp with time zone :=
    date_trunc('month', timezone('UTC', now())) AT TIME ZONE 'UTC';
BEGIN
  IF p_kind NOT IN ('app_call', 'ai_call') THEN
    RAISE EXCEPTION 'Invalid routine budget reservation kind';
  END IF;
  IF COALESCE(p_reservation_key, '') = '' THEN
    RAISE EXCEPTION 'Reservation key is required';
  END IF;
  IF p_reserve_light IS NULL OR p_reserve_light < 0 OR
     p_reserve_light::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Reservation Light must be finite and non-negative';
  END IF;

  -- Every admission/mutation takes the routine lock first. This serializes
  -- spend-vs-reservation transitions across all runs and avoids observing a
  -- settlement halfway between releasing capacity and updating the run ledger.
  SELECT routines.* INTO v_routine
  FROM public.user_routines AS routines
  WHERE routines.id = p_routine_id
    AND routines.user_id = p_user_id
    AND routines.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Routine not found for user'; END IF;

  SELECT runs.* INTO v_run
  FROM public.routine_runs AS runs
  WHERE runs.id = p_routine_run_id
    AND runs.routine_id = p_routine_id
    AND runs.user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Routine run not found for user'; END IF;

  -- Expiry means the worker/provider may have completed side effects and then
  -- crashed before settlement. It is never evidence of zero spend. Finalize
  -- every ambiguous reservation for this routine at its conservative maximum
  -- and apply that amount to the authoritative run ledger. Only the explicit
  -- release RPC (called after a known pre-execution/zero-spend failure) may
  -- restore monetary capacity. Conservative overcount is safe; undercount can
  -- violate a hard ceiling.
  WITH expired AS (
    UPDATE public.routine_run_budget_reservations AS reservations
    SET status = 'settled',
        actual_light = reservations.reserved_light,
        settled_at = now(),
        updated_at = now()
    WHERE reservations.routine_id = p_routine_id
      AND reservations.status = 'reserved'
      AND reservations.expires_at <= now()
    RETURNING reservations.routine_run_id, reservations.reserved_light
  ), expired_by_run AS (
    SELECT routine_run_id, sum(reserved_light) AS finalized_light
    FROM expired
    GROUP BY routine_run_id
  )
  UPDATE public.routine_runs AS runs
  SET total_light = runs.total_light + expired_by_run.finalized_light
  FROM expired_by_run
  WHERE runs.id = expired_by_run.routine_run_id
    AND runs.routine_id = p_routine_id
    AND runs.user_id = p_user_id;

  -- Refresh the locked row after conservative expiry finalization so the
  -- current decision includes any amount just posted to this run.
  SELECT runs.* INTO v_run
  FROM public.routine_runs AS runs
  WHERE runs.id = p_routine_run_id
    AND runs.routine_id = p_routine_id
    AND runs.user_id = p_user_id;

  SELECT reservations.* INTO v_existing
  FROM public.routine_run_budget_reservations AS reservations
  WHERE reservations.routine_run_id = p_routine_run_id
    AND reservations.reservation_key = p_reservation_key;
  IF FOUND AND v_existing.status = 'reserved' THEN
    RETURN QUERY SELECT
      false, 'routine_budget_reservation_in_flight'::text,
      'This routine operation is already in flight; refusing duplicate execution.'::text,
      NULL::uuid, NULL::text, 0::double precision,
      0, 0, v_run.total_light, 0::double precision, 0::double precision;
    RETURN;
  END IF;
  IF FOUND THEN
    RETURN QUERY SELECT
      false, 'routine_budget_reservation_finalized'::text,
      'Routine budget reservation key was already finalized; refusing duplicate execution.'::text,
      NULL::uuid, NULL::text, 0::double precision, 0, 0,
      v_run.total_light, 0::double precision, 0::double precision;
    RETURN;
  END IF;

  IF v_run.status <> 'running' OR v_routine.status <> 'active' THEN
    RETURN QUERY SELECT
      false, 'routine_run_not_active'::text,
      'Routine run is not active.'::text, NULL::uuid, NULL::text,
      0::double precision, 0, 0, v_run.total_light,
      0::double precision, 0::double precision;
    RETURN;
  END IF;

  v_run_limit := NULLIF(v_routine.budget_policy->>'max_light_per_run', '')::double precision;
  v_day_limit := NULLIF(v_routine.budget_policy->>'max_light_per_day', '')::double precision;
  v_month_limit := NULLIF(v_routine.budget_policy->>'max_light_per_month', '')::double precision;
  v_calls_limit := NULLIF(v_routine.budget_policy->>'max_calls_per_run', '')::integer;
  IF v_run_limit IS NULL OR v_day_limit IS NULL OR v_month_limit IS NULL OR
     v_calls_limit IS NULL OR v_run_limit < 0 OR v_day_limit < v_run_limit OR
     v_month_limit < v_day_limit OR v_calls_limit < 1 OR
     v_run_limit::text IN ('NaN', 'Infinity', '-Infinity') OR
     v_day_limit::text IN ('NaN', 'Infinity', '-Infinity') OR
     v_month_limit::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RETURN QUERY SELECT
      false, 'routine_budget_policy_missing'::text,
      'Routine budget policy is incomplete.'::text, NULL::uuid, NULL::text,
      0::double precision, 0, COALESCE(v_calls_limit, 0), v_run.total_light,
      0::double precision, COALESCE(v_run_limit, 0);
    RETURN;
  END IF;

  -- Every admitted operation consumes a call slot permanently, including an
  -- attempted call that later fails and releases its monetary reservation.
  -- This prevents retry/failure loops from escaping max_calls_per_run.
  SELECT count(*)::integer,
         COALESCE(sum(CASE WHEN status = 'reserved' THEN reserved_light ELSE 0 END), 0)
    INTO v_calls_used, v_reserved
  FROM public.routine_run_budget_reservations
  WHERE routine_run_id = p_routine_run_id;

  IF v_calls_used >= v_calls_limit THEN
    RETURN QUERY SELECT
      false, 'routine_budget_calls_exhausted'::text,
      format('Routine call ceiling reached (%s/%s).', v_calls_used, v_calls_limit),
      NULL::uuid, NULL::text, 0::double precision, v_calls_used,
      v_calls_limit, v_run.total_light, v_reserved, v_run_limit;
    RETURN;
  END IF;

  -- Read the authoritative run ledger rather than the monitor rollup stored in
  -- routine metadata. This closes the terminal-run window between finishRun
  -- and its best-effort metadata update and prevents a metadata edit from ever
  -- resetting a hard ceiling.
  SELECT
    COALESCE(sum(total_light) FILTER (WHERE created_at >= v_day_start), 0),
    COALESCE(sum(total_light), 0)
    INTO v_day_spent, v_month_spent
  FROM public.routine_runs
  WHERE routine_id = p_routine_id
    AND created_at >= v_month_start;
  IF v_day_spent::text IN ('NaN', 'Infinity', '-Infinity') OR
     v_month_spent::text IN ('NaN', 'Infinity', '-Infinity') OR
     v_run.total_light::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Routine spend ledger contains a non-finite value';
  END IF;

  -- The routine row lock serializes admissions across every run of this
  -- routine. Every still-reserved row counts regardless of expires_at: expiry
  -- never restores capacity, and the reconciliation above finalizes rows that
  -- were already expired when this transaction acquired the routine lock.
  SELECT COALESCE(sum(reserved_light), 0) INTO v_global_reserved
  FROM public.routine_run_budget_reservations
  WHERE routine_id = p_routine_id AND status = 'reserved';

  v_effective_limit := LEAST(v_run_limit, v_day_limit, v_month_limit);
  IF v_run.total_light + v_reserved + p_reserve_light > v_run_limit OR
     v_day_spent + v_global_reserved + p_reserve_light > v_day_limit OR
     v_month_spent + v_global_reserved + p_reserve_light > v_month_limit THEN
    RETURN QUERY SELECT
      false, 'routine_budget_light_exhausted'::text,
      format('Routine Light ceiling would be exceeded (%s used + %s reserved + %s requested > %s).',
        v_run.total_light, v_reserved, p_reserve_light, v_effective_limit),
      NULL::uuid, NULL::text, 0::double precision, v_calls_used,
      v_calls_limit, v_run.total_light, v_reserved, v_effective_limit;
    RETURN;
  END IF;

  INSERT INTO public.routine_run_budget_reservations (
    routine_id, routine_run_id, user_id, reservation_key, kind,
    reserved_light, expires_at
  ) VALUES (
    p_routine_id, p_routine_run_id, p_user_id, p_reservation_key, p_kind,
    p_reserve_light, GREATEST(COALESCE(p_expires_at, now() + interval '15 minutes'), now() + interval '1 minute')
  ) RETURNING id INTO v_id;

  RETURN QUERY SELECT
    true, 'ok'::text, 'Routine budget reserved.'::text, v_id,
    p_reservation_key, p_reserve_light, v_calls_used + 1, v_calls_limit,
    v_run.total_light, v_reserved + p_reserve_light, v_effective_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_routine_run_budget_reservation(
  p_reservation_id uuid,
  p_user_id uuid,
  p_actual_light double precision DEFAULT 0,
  p_apply_spend boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_row public.routine_run_budget_reservations%ROWTYPE;
  v_routine_id uuid;
BEGIN
  IF p_actual_light IS NULL OR p_actual_light < 0 OR
     p_actual_light::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Actual Light must be finite and non-negative';
  END IF;
  SELECT routine_id INTO v_routine_id
  FROM public.routine_run_budget_reservations
  WHERE id = p_reservation_id AND user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Routine budget reservation not found'; END IF;

  -- Match reserve's lock order so run-ledger spend and released reservation
  -- capacity are one serializable routine-level decision.
  PERFORM 1 FROM public.user_routines
  WHERE id = v_routine_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Routine not found for user'; END IF;

  SELECT * INTO v_row FROM public.routine_run_budget_reservations
  WHERE id = p_reservation_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Routine budget reservation not found'; END IF;
  IF v_row.status = 'settled' THEN RETURN true; END IF;
  IF v_row.status <> 'reserved' THEN RAISE EXCEPTION 'Routine budget reservation is not active'; END IF;
  IF p_actual_light > v_row.reserved_light THEN
    RAISE EXCEPTION 'Actual Light exceeds the hard reservation';
  END IF;
  IF p_apply_spend AND p_actual_light > 0 THEN
    UPDATE public.routine_runs
    SET total_light = total_light + p_actual_light
    WHERE id = v_row.routine_run_id AND routine_id = v_row.routine_id AND user_id = p_user_id;
  END IF;
  UPDATE public.routine_run_budget_reservations
  SET status = 'settled', actual_light = p_actual_light,
      settled_at = now(), updated_at = now()
  WHERE id = p_reservation_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_routine_run_budget_reservation(
  p_reservation_id uuid,
  p_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_routine_id uuid;
BEGIN
  SELECT routine_id INTO v_routine_id
  FROM public.routine_run_budget_reservations
  WHERE id = p_reservation_id AND user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Routine budget reservation not found'; END IF;

  PERFORM 1 FROM public.user_routines
  WHERE id = v_routine_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Routine not found for user'; END IF;

  UPDATE public.routine_run_budget_reservations
  SET status = CASE WHEN status = 'reserved' THEN 'released' ELSE status END,
      updated_at = now()
  WHERE id = p_reservation_id AND user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Routine budget reservation not found'; END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_routine_run_budget(uuid, uuid, uuid, text, text, double precision, timestamp with time zone) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_routine_run_budget_reservation(uuid, uuid, double precision, boolean) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.release_routine_run_budget_reservation(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_routine_run_budget(uuid, uuid, uuid, text, text, double precision, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_routine_run_budget_reservation(uuid, uuid, double precision, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_routine_run_budget_reservation(uuid, uuid) TO service_role;
