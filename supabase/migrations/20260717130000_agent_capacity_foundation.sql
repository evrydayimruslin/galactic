-- P2.3: authoritative per-Agent subscription-capacity ceilings.
--
-- Rollout is deliberately additive. reserve_account_capacity remains the
-- rollback path while AGENT_CAPACITY_ENABLED is off; v2 atomically admits
-- against the existing account windows and the new root-Agent windows.

CREATE TABLE IF NOT EXISTS public.agent_capacity_policies (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  capacity_agent_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  cap_basis_points integer NOT NULL DEFAULT 10000,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capacity_agent_id),
  CONSTRAINT agent_capacity_policy_cap_check CHECK (
    cap_basis_points BETWEEN 1 AND 10000
  )
);

CREATE TABLE IF NOT EXISTS public.agent_capacity_windows (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  capacity_agent_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  plan_code text NOT NULL REFERENCES public.billing_plans(code),
  policy_version integer NOT NULL,
  cap_basis_points integer NOT NULL,
  window_kind text NOT NULL,
  window_started_at timestamp with time zone NOT NULL,
  window_ends_at timestamp with time zone NOT NULL,
  used_light double precision NOT NULL DEFAULT 0,
  reserved_light double precision NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (
    user_id, capacity_agent_id, window_kind, window_started_at
  ),
  CONSTRAINT agent_capacity_window_kind_check CHECK (
    window_kind IN ('burst', 'weekly')
  ),
  CONSTRAINT agent_capacity_window_cap_check CHECK (
    cap_basis_points BETWEEN 1 AND 10000
  ),
  CONSTRAINT agent_capacity_window_amount_check CHECK (
    used_light >= 0 AND reserved_light >= 0
    AND window_ends_at > window_started_at
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_capacity_windows_expiry
  ON public.agent_capacity_windows(window_ends_at);

ALTER TABLE public.account_capacity_reservations
  ADD COLUMN IF NOT EXISTS capacity_agent_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'account_capacity_reservations_capacity_agent_fk'
      AND conrelid = 'public.account_capacity_reservations'::regclass
  ) THEN
    ALTER TABLE public.account_capacity_reservations
      ADD CONSTRAINT account_capacity_reservations_capacity_agent_fk
      FOREIGN KEY (capacity_agent_id) REFERENCES public.apps(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_account_capacity_reservations_agent
  ON public.account_capacity_reservations(
    user_id, capacity_agent_id, status, created_at DESC
  )
  WHERE capacity_agent_id IS NOT NULL;

-- Reaping and the bounded Fleet projection both need to isolate one account's
-- currently-held reservations without scanning the global expiry queue.
CREATE INDEX IF NOT EXISTS idx_account_capacity_reservations_user_active
  ON public.account_capacity_reservations(user_id, expires_at)
  WHERE status = 'reserved';

DROP TRIGGER IF EXISTS touch_agent_capacity_policies_updated_at
  ON public.agent_capacity_policies;
CREATE TRIGGER touch_agent_capacity_policies_updated_at
BEFORE UPDATE ON public.agent_capacity_policies
FOR EACH ROW EXECUTE FUNCTION public.touch_p21_updated_at();

DROP TRIGGER IF EXISTS touch_agent_capacity_windows_updated_at
  ON public.agent_capacity_windows;
CREATE TRIGGER touch_agent_capacity_windows_updated_at
BEFORE UPDATE ON public.agent_capacity_windows
FOR EACH ROW EXECUTE FUNCTION public.touch_p21_updated_at();

-- Replaces the P2.1 implementation so expiry releases both ledgers. Legacy
-- reservations have capacity_agent_id NULL and retain their original behavior.
CREATE OR REPLACE FUNCTION public.reap_expired_account_capacity(
  p_user_id uuid,
  p_now timestamp with time zone DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res public.account_capacity_reservations;
  v_reaped integer := 0;
BEGIN
  -- All capacity mutations for one account share a short transaction-scoped
  -- mutex. This also serializes legacy v1 admission because it calls this
  -- reaper, and prevents reservation/window lock-order inversions during a
  -- mixed-worker rollout.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('account_capacity:' || p_user_id::text, 0)
  );
  FOR v_res IN
    SELECT reservations.*
    FROM public.account_capacity_reservations AS reservations
    WHERE reservations.user_id = p_user_id
      AND reservations.status = 'reserved'
      AND reservations.expires_at <= p_now
    ORDER BY reservations.id
    FOR UPDATE
  LOOP
    UPDATE public.account_capacity_windows AS windows
    SET reserved_light = GREATEST(0, windows.reserved_light - v_res.reserved_light)
    WHERE windows.user_id = p_user_id
      AND windows.window_kind = 'burst'
      AND windows.window_started_at = v_res.burst_window_started_at;
    UPDATE public.account_capacity_windows AS windows
    SET reserved_light = GREATEST(0, windows.reserved_light - v_res.reserved_light)
    WHERE windows.user_id = p_user_id
      AND windows.window_kind = 'weekly'
      AND windows.window_started_at = v_res.weekly_window_started_at;

    IF v_res.capacity_agent_id IS NOT NULL THEN
      UPDATE public.agent_capacity_windows AS windows
      SET reserved_light = GREATEST(0, windows.reserved_light - v_res.reserved_light)
      WHERE windows.user_id = p_user_id
        AND windows.capacity_agent_id = v_res.capacity_agent_id
        AND windows.window_kind = 'burst'
        AND windows.window_started_at = v_res.burst_window_started_at;
      UPDATE public.agent_capacity_windows AS windows
      SET reserved_light = GREATEST(0, windows.reserved_light - v_res.reserved_light)
      WHERE windows.user_id = p_user_id
        AND windows.capacity_agent_id = v_res.capacity_agent_id
        AND windows.window_kind = 'weekly'
        AND windows.window_started_at = v_res.weekly_window_started_at;
    END IF;

    UPDATE public.account_capacity_reservations AS reservations
    SET status = 'expired', released_at = p_now
    WHERE reservations.id = v_res.id;
    v_reaped := v_reaped + 1;
  END LOOP;
  RETURN v_reaped;
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_account_capacity_v2(
  p_user_id uuid,
  p_capacity_agent_id uuid,
  p_idempotency_key text,
  p_reserve_light double precision,
  p_expires_at timestamp with time zone,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_now timestamp with time zone DEFAULT now()
)
RETURNS TABLE (
  allowed boolean,
  code text,
  reservation_id uuid,
  plan_code text,
  capacity_state text,
  burst_state text,
  weekly_state text,
  burst_resets_at timestamp with time zone,
  weekly_resets_at timestamp with time zone,
  next_eligible_at timestamp with time zone,
  burst_remaining_light double precision,
  weekly_remaining_light double precision,
  capacity_agent_id uuid,
  agent_cap_basis_points integer,
  binding_constraint text,
  agent_burst_remaining_light double precision,
  agent_weekly_remaining_light double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ent public.account_entitlements;
  v_plan public.billing_plans;
  v_existing public.account_capacity_reservations;
  v_cap_basis_points integer;
  v_burst_start timestamp with time zone;
  v_week_start timestamp with time zone;
  v_burst_end timestamp with time zone;
  v_week_end timestamp with time zone;
  v_account_burst public.account_capacity_windows;
  v_account_week public.account_capacity_windows;
  v_agent_burst public.agent_capacity_windows;
  v_agent_week public.agent_capacity_windows;
  v_account_burst_remaining double precision;
  v_account_week_remaining double precision;
  v_agent_burst_limit double precision;
  v_agent_week_limit double precision;
  v_agent_burst_remaining double precision;
  v_agent_week_remaining double precision;
  v_burst_blocked boolean;
  v_week_blocked boolean;
  v_agent_blocked boolean;
  v_next timestamp with time zone;
  v_state text;
  v_reservation_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('account_capacity:' || p_user_id::text, 0)
  );
  IF p_capacity_agent_id IS NULL THEN
    RAISE EXCEPTION 'capacity Agent id is required';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'idempotency key is required';
  END IF;
  IF p_reserve_light IS NULL OR p_reserve_light < 0 OR p_reserve_light IN (
    'NaN'::double precision,
    'Infinity'::double precision,
    '-Infinity'::double precision
  ) THEN
    RAISE EXCEPTION 'reserve amount must be finite and non-negative';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= p_now THEN
    RAISE EXCEPTION 'reservation expiry must be in the future';
  END IF;

  -- A user may only assign capacity to one of their own live Agents. This is
  -- checked in the SECURITY DEFINER function rather than trusting metadata.
  PERFORM 1
  FROM public.apps AS apps
  WHERE apps.id = p_capacity_agent_id
    AND apps.owner_id = p_user_id
    AND apps.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Capacity Agent is not owned by the account';
  END IF;

  PERFORM public.reap_expired_account_capacity(p_user_id, p_now);

  SELECT reservations.* INTO v_existing
  FROM public.account_capacity_reservations AS reservations
  WHERE reservations.user_id = p_user_id
    AND reservations.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.capacity_agent_id IS DISTINCT FROM p_capacity_agent_id THEN
      RAISE EXCEPTION 'Capacity idempotency key attribution mismatch';
    END IF;
    SELECT plans.* INTO v_plan
    FROM public.billing_plans AS plans
    WHERE plans.code = v_existing.plan_code;
    SELECT COALESCE(policies.cap_basis_points, 10000)
      INTO v_cap_basis_points
    FROM (SELECT 1) AS seed
    LEFT JOIN public.agent_capacity_policies AS policies
      ON policies.user_id = p_user_id
      AND policies.capacity_agent_id = p_capacity_agent_id;
    v_cap_basis_points := COALESCE(v_cap_basis_points, 10000);
    IF v_plan.code = 'free' THEN v_cap_basis_points := 10000; END IF;
    v_agent_burst_limit := v_plan.burst_limit_light * v_cap_basis_points / 10000.0;
    v_agent_week_limit := v_plan.weekly_limit_light * v_cap_basis_points / 10000.0;

    SELECT windows.window_ends_at,
      GREATEST(0, v_plan.burst_limit_light - windows.used_light - windows.reserved_light)
      INTO v_burst_end, v_account_burst_remaining
    FROM public.account_capacity_windows AS windows
    WHERE windows.user_id = p_user_id
      AND windows.window_kind = 'burst'
      AND windows.window_started_at = v_existing.burst_window_started_at;
    SELECT windows.window_ends_at,
      GREATEST(0, v_plan.weekly_limit_light - windows.used_light - windows.reserved_light)
      INTO v_week_end, v_account_week_remaining
    FROM public.account_capacity_windows AS windows
    WHERE windows.user_id = p_user_id
      AND windows.window_kind = 'weekly'
      AND windows.window_started_at = v_existing.weekly_window_started_at;
    SELECT GREATEST(0, v_agent_burst_limit - windows.used_light - windows.reserved_light)
      INTO v_agent_burst_remaining
    FROM public.agent_capacity_windows AS windows
    WHERE windows.user_id = p_user_id
      AND windows.capacity_agent_id = p_capacity_agent_id
      AND windows.window_kind = 'burst'
      AND windows.window_started_at = v_existing.burst_window_started_at;
    SELECT GREATEST(0, v_agent_week_limit - windows.used_light - windows.reserved_light)
      INTO v_agent_week_remaining
    FROM public.agent_capacity_windows AS windows
    WHERE windows.user_id = p_user_id
      AND windows.capacity_agent_id = p_capacity_agent_id
      AND windows.window_kind = 'weekly'
      AND windows.window_started_at = v_existing.weekly_window_started_at;

    RETURN QUERY SELECT
      v_existing.status IN ('reserved', 'settled'),
      CASE WHEN v_existing.status IN ('reserved', 'settled')
        THEN 'ok' ELSE v_existing.status END,
      v_existing.id,
      v_existing.plan_code,
      CASE WHEN v_existing.status IN ('reserved', 'settled')
        THEN 'available' ELSE 'waiting' END,
      CASE WHEN v_existing.status IN ('reserved', 'settled')
        THEN 'available' ELSE 'waiting' END,
      CASE WHEN v_existing.status IN ('reserved', 'settled')
        THEN 'available' ELSE 'waiting' END,
      v_burst_end,
      v_week_end,
      NULL::timestamp with time zone,
      COALESCE(v_account_burst_remaining, 0),
      COALESCE(v_account_week_remaining, 0),
      p_capacity_agent_id,
      v_cap_basis_points,
      NULL::text,
      COALESCE(v_agent_burst_remaining, 0),
      COALESCE(v_agent_week_remaining, 0);
    RETURN;
  END IF;

  v_ent := public.ensure_account_entitlement(p_user_id);
  SELECT plans.* INTO v_plan
  FROM public.billing_plans AS plans
  WHERE plans.code = v_ent.plan_code;
  IF v_plan.code IS NULL THEN
    RAISE EXCEPTION 'Account plan is unavailable';
  END IF;

  SELECT COALESCE(policies.cap_basis_points, 10000)
    INTO v_cap_basis_points
  FROM (SELECT 1) AS seed
  LEFT JOIN public.agent_capacity_policies AS policies
    ON policies.user_id = p_user_id
    AND policies.capacity_agent_id = p_capacity_agent_id;
  v_cap_basis_points := COALESCE(v_cap_basis_points, 10000);
  IF v_plan.code = 'free' THEN v_cap_basis_points := 10000; END IF;

  v_burst_start := public.capacity_window_start(
    v_ent.capacity_anchor_at, v_plan.burst_window_seconds, p_now
  );
  v_week_start := public.capacity_window_start(
    v_ent.capacity_anchor_at, v_plan.weekly_window_seconds, p_now
  );
  v_burst_end := v_burst_start + v_plan.burst_window_seconds * interval '1 second';
  v_week_end := v_week_start + v_plan.weekly_window_seconds * interval '1 second';
  v_agent_burst_limit := v_plan.burst_limit_light * v_cap_basis_points / 10000.0;
  v_agent_week_limit := v_plan.weekly_limit_light * v_cap_basis_points / 10000.0;

  INSERT INTO public.account_capacity_windows (
    user_id, plan_code, policy_version, window_kind,
    window_started_at, window_ends_at
  ) VALUES
    (p_user_id, v_plan.code, v_plan.policy_version, 'burst', v_burst_start, v_burst_end),
    (p_user_id, v_plan.code, v_plan.policy_version, 'weekly', v_week_start, v_week_end)
  ON CONFLICT (user_id, window_kind, window_started_at) DO NOTHING;

  INSERT INTO public.agent_capacity_windows (
    user_id, capacity_agent_id, plan_code, policy_version, cap_basis_points,
    window_kind, window_started_at, window_ends_at
  ) VALUES
    (p_user_id, p_capacity_agent_id, v_plan.code, v_plan.policy_version,
      v_cap_basis_points, 'burst', v_burst_start, v_burst_end),
    (p_user_id, p_capacity_agent_id, v_plan.code, v_plan.policy_version,
      v_cap_basis_points, 'weekly', v_week_start, v_week_end)
  ON CONFLICT ON CONSTRAINT agent_capacity_windows_pkey
  DO NOTHING;

  -- Deterministic lock order: account burst/week, then Agent burst/week.
  SELECT windows.* INTO v_account_burst
  FROM public.account_capacity_windows AS windows
  WHERE windows.user_id = p_user_id
    AND windows.window_kind = 'burst'
    AND windows.window_started_at = v_burst_start
  FOR UPDATE;
  SELECT windows.* INTO v_account_week
  FROM public.account_capacity_windows AS windows
  WHERE windows.user_id = p_user_id
    AND windows.window_kind = 'weekly'
    AND windows.window_started_at = v_week_start
  FOR UPDATE;
  SELECT windows.* INTO v_agent_burst
  FROM public.agent_capacity_windows AS windows
  WHERE windows.user_id = p_user_id
    AND windows.capacity_agent_id = p_capacity_agent_id
    AND windows.window_kind = 'burst'
    AND windows.window_started_at = v_burst_start
  FOR UPDATE;
  SELECT windows.* INTO v_agent_week
  FROM public.agent_capacity_windows AS windows
  WHERE windows.user_id = p_user_id
    AND windows.capacity_agent_id = p_capacity_agent_id
    AND windows.window_kind = 'weekly'
    AND windows.window_started_at = v_week_start
  FOR UPDATE;

  -- Refresh the policy snapshot only after both account rows and both Agent
  -- rows are locked. Updating in the upsert above would lock an Agent row
  -- before the account rows and could deadlock with settlement/release.
  UPDATE public.agent_capacity_windows AS windows
  SET plan_code = v_plan.code,
      policy_version = v_plan.policy_version,
      cap_basis_points = v_cap_basis_points,
      window_ends_at = CASE
        WHEN windows.window_kind = 'burst' THEN v_burst_end
        ELSE v_week_end
      END
  WHERE windows.user_id = p_user_id
    AND windows.capacity_agent_id = p_capacity_agent_id
    AND (
      (windows.window_kind = 'burst' AND windows.window_started_at = v_burst_start)
      OR (windows.window_kind = 'weekly' AND windows.window_started_at = v_week_start)
    );

  v_account_burst_remaining := GREATEST(
    0, v_plan.burst_limit_light
      - v_account_burst.used_light - v_account_burst.reserved_light
  );
  v_account_week_remaining := GREATEST(
    0, v_plan.weekly_limit_light
      - v_account_week.used_light - v_account_week.reserved_light
  );
  v_agent_burst_remaining := GREATEST(
    0, v_agent_burst_limit
      - v_agent_burst.used_light - v_agent_burst.reserved_light
  );
  v_agent_week_remaining := GREATEST(
    0, v_agent_week_limit
      - v_agent_week.used_light - v_agent_week.reserved_light
  );

  -- A request larger than the Agent's entire window can never be helped by a
  -- reset. Report an actionable blocker instead of an infinite wait loop.
  IF v_cap_basis_points < 10000 AND (
    p_reserve_light > v_agent_burst_limit
    OR p_reserve_light > v_agent_week_limit
  ) THEN
    RETURN QUERY SELECT false, 'agent_cap_too_low_for_request', NULL::uuid,
      v_plan.code, 'waiting',
      CASE WHEN p_reserve_light > v_agent_burst_limit
        THEN 'waiting' ELSE 'available' END,
      CASE WHEN p_reserve_light > v_agent_week_limit
        THEN 'waiting' ELSE 'available' END,
      v_burst_end, v_week_end, NULL::timestamp with time zone,
      v_account_burst_remaining, v_account_week_remaining,
      p_capacity_agent_id, v_cap_basis_points, 'agent',
      v_agent_burst_remaining, v_agent_week_remaining;
    RETURN;
  END IF;

  -- A zero-Light scheduler probe still observes an already exhausted window.
  v_burst_blocked :=
    v_account_burst.used_light + v_account_burst.reserved_light
      >= v_plan.burst_limit_light
    OR v_agent_burst.used_light + v_agent_burst.reserved_light
      >= v_agent_burst_limit
    OR p_reserve_light > v_account_burst_remaining
    OR p_reserve_light > v_agent_burst_remaining;
  v_week_blocked :=
    v_account_week.used_light + v_account_week.reserved_light
      >= v_plan.weekly_limit_light
    OR v_agent_week.used_light + v_agent_week.reserved_light
      >= v_agent_week_limit
    OR p_reserve_light > v_account_week_remaining
    OR p_reserve_light > v_agent_week_remaining;
  v_agent_blocked := v_cap_basis_points < 10000 AND (
    v_agent_burst.used_light + v_agent_burst.reserved_light
      >= v_agent_burst_limit
    OR v_agent_week.used_light + v_agent_week.reserved_light
      >= v_agent_week_limit
    OR p_reserve_light > v_agent_burst_remaining
    OR p_reserve_light > v_agent_week_remaining
  );

  IF v_burst_blocked OR v_week_blocked THEN
    v_next := CASE
      WHEN v_burst_blocked AND v_week_blocked THEN GREATEST(v_burst_end, v_week_end)
      WHEN v_burst_blocked THEN v_burst_end
      ELSE v_week_end
    END;
    RETURN QUERY SELECT false,
      CASE WHEN v_agent_blocked THEN 'agent_cap_waiting'
        ELSE 'capacity_waiting' END,
      NULL::uuid, v_plan.code, 'waiting',
      CASE WHEN v_burst_blocked THEN 'waiting' ELSE 'available' END,
      CASE WHEN v_week_blocked THEN 'waiting' ELSE 'available' END,
      v_burst_end, v_week_end, v_next,
      v_account_burst_remaining, v_account_week_remaining,
      p_capacity_agent_id, v_cap_basis_points,
      CASE WHEN v_agent_blocked THEN 'agent' ELSE 'account' END,
      v_agent_burst_remaining, v_agent_week_remaining;
    RETURN;
  END IF;

  INSERT INTO public.account_capacity_reservations (
    user_id, capacity_agent_id, idempotency_key, plan_code, policy_version,
    reserved_light, burst_window_started_at, weekly_window_started_at,
    expires_at, metadata
  ) VALUES (
    p_user_id, p_capacity_agent_id, p_idempotency_key, v_plan.code,
    v_plan.policy_version, p_reserve_light, v_burst_start, v_week_start,
    p_expires_at,
    COALESCE(p_metadata, '{}'::jsonb) ||
      jsonb_build_object('capacity_agent_id', p_capacity_agent_id)
  )
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_reservation_id;

  IF v_reservation_id IS NULL THEN
    SELECT reservations.* INTO v_existing
    FROM public.account_capacity_reservations AS reservations
    WHERE reservations.user_id = p_user_id
      AND reservations.idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF v_existing.capacity_agent_id IS DISTINCT FROM p_capacity_agent_id THEN
      RAISE EXCEPTION 'Capacity idempotency key attribution mismatch';
    END IF;
    RETURN QUERY SELECT
      v_existing.status IN ('reserved', 'settled'),
      CASE WHEN v_existing.status IN ('reserved', 'settled')
        THEN 'ok' ELSE v_existing.status END,
      v_existing.id, v_existing.plan_code,
      CASE WHEN v_existing.status IN ('reserved', 'settled')
        THEN 'available' ELSE 'waiting' END,
      CASE WHEN v_existing.status IN ('reserved', 'settled')
        THEN 'available' ELSE 'waiting' END,
      CASE WHEN v_existing.status IN ('reserved', 'settled')
        THEN 'available' ELSE 'waiting' END,
      v_burst_end, v_week_end, NULL::timestamp with time zone,
      v_account_burst_remaining, v_account_week_remaining,
      p_capacity_agent_id, v_cap_basis_points, NULL::text,
      v_agent_burst_remaining, v_agent_week_remaining;
    RETURN;
  END IF;

  UPDATE public.account_capacity_windows AS windows
  SET reserved_light = windows.reserved_light + p_reserve_light
  WHERE windows.user_id = p_user_id
    AND (
      (windows.window_kind = 'burst' AND windows.window_started_at = v_burst_start)
      OR (windows.window_kind = 'weekly' AND windows.window_started_at = v_week_start)
    );
  UPDATE public.agent_capacity_windows AS windows
  SET reserved_light = windows.reserved_light + p_reserve_light
  WHERE windows.user_id = p_user_id
    AND windows.capacity_agent_id = p_capacity_agent_id
    AND (
      (windows.window_kind = 'burst' AND windows.window_started_at = v_burst_start)
      OR (windows.window_kind = 'weekly' AND windows.window_started_at = v_week_start)
    );

  v_account_burst_remaining := v_account_burst_remaining - p_reserve_light;
  v_account_week_remaining := v_account_week_remaining - p_reserve_light;
  v_agent_burst_remaining := v_agent_burst_remaining - p_reserve_light;
  v_agent_week_remaining := v_agent_week_remaining - p_reserve_light;
  v_state := CASE
    WHEN v_account_burst_remaining <= v_plan.burst_limit_light * 0.2
      OR v_account_week_remaining <= v_plan.weekly_limit_light * 0.2
      OR v_agent_burst_remaining <= v_agent_burst_limit * 0.2
      OR v_agent_week_remaining <= v_agent_week_limit * 0.2
      THEN 'low'
    ELSE 'available'
  END;

  RETURN QUERY SELECT true, 'ok', v_reservation_id, v_plan.code, v_state,
    CASE WHEN v_account_burst_remaining <= v_plan.burst_limit_light * 0.2
      OR v_agent_burst_remaining <= v_agent_burst_limit * 0.2
      THEN 'low' ELSE 'available' END,
    CASE WHEN v_account_week_remaining <= v_plan.weekly_limit_light * 0.2
      OR v_agent_week_remaining <= v_agent_week_limit * 0.2
      THEN 'low' ELSE 'available' END,
    v_burst_end, v_week_end, NULL::timestamp with time zone,
    v_account_burst_remaining, v_account_week_remaining,
    p_capacity_agent_id, v_cap_basis_points, NULL::text,
    v_agent_burst_remaining, v_agent_week_remaining;
END;
$$;

-- Admitted work finishes even if actual usage exceeds the predicted hold or a
-- cap is lowered mid-run. Full actual usage is recorded in both ledgers.
CREATE OR REPLACE FUNCTION public.settle_account_capacity(
  p_reservation_id uuid,
  p_user_id uuid,
  p_actual_light double precision
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res public.account_capacity_reservations;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('account_capacity:' || p_user_id::text, 0)
  );
  IF p_actual_light IS NULL OR p_actual_light < 0 OR p_actual_light IN (
    'NaN'::double precision,
    'Infinity'::double precision,
    '-Infinity'::double precision
  ) THEN
    RAISE EXCEPTION 'actual amount must be finite and non-negative';
  END IF;
  SELECT reservations.* INTO v_res
  FROM public.account_capacity_reservations AS reservations
  WHERE reservations.id = p_reservation_id
    AND reservations.user_id = p_user_id
  FOR UPDATE;
  IF v_res.id IS NULL THEN RAISE EXCEPTION 'Capacity reservation not found'; END IF;
  IF v_res.status = 'settled' THEN RETURN true; END IF;
  IF v_res.status <> 'reserved' THEN RETURN false; END IF;

  UPDATE public.account_capacity_windows AS windows
  SET reserved_light = GREATEST(0, windows.reserved_light - v_res.reserved_light),
      used_light = windows.used_light + p_actual_light
  WHERE windows.user_id = p_user_id
    AND windows.window_kind = 'burst'
    AND windows.window_started_at = v_res.burst_window_started_at;
  UPDATE public.account_capacity_windows AS windows
  SET reserved_light = GREATEST(0, windows.reserved_light - v_res.reserved_light),
      used_light = windows.used_light + p_actual_light
  WHERE windows.user_id = p_user_id
    AND windows.window_kind = 'weekly'
    AND windows.window_started_at = v_res.weekly_window_started_at;
  IF v_res.capacity_agent_id IS NOT NULL THEN
    UPDATE public.agent_capacity_windows AS windows
    SET reserved_light = GREATEST(0, windows.reserved_light - v_res.reserved_light),
        used_light = windows.used_light + p_actual_light
    WHERE windows.user_id = p_user_id
      AND windows.capacity_agent_id = v_res.capacity_agent_id
      AND windows.window_kind = 'burst'
      AND windows.window_started_at = v_res.burst_window_started_at;
    UPDATE public.agent_capacity_windows AS windows
    SET reserved_light = GREATEST(0, windows.reserved_light - v_res.reserved_light),
        used_light = windows.used_light + p_actual_light
    WHERE windows.user_id = p_user_id
      AND windows.capacity_agent_id = v_res.capacity_agent_id
      AND windows.window_kind = 'weekly'
      AND windows.window_started_at = v_res.weekly_window_started_at;
  END IF;
  UPDATE public.account_capacity_reservations AS reservations
  SET status = 'settled', actual_light = p_actual_light, settled_at = now()
  WHERE reservations.id = v_res.id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_account_capacity(
  p_reservation_id uuid,
  p_user_id uuid,
  p_expired boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res public.account_capacity_reservations;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('account_capacity:' || p_user_id::text, 0)
  );
  SELECT reservations.* INTO v_res
  FROM public.account_capacity_reservations AS reservations
  WHERE reservations.id = p_reservation_id
    AND reservations.user_id = p_user_id
  FOR UPDATE;
  IF v_res.id IS NULL THEN RETURN false; END IF;
  IF v_res.status <> 'reserved' THEN
    RETURN v_res.status IN ('released', 'expired');
  END IF;

  UPDATE public.account_capacity_windows AS windows
  SET reserved_light = GREATEST(0, windows.reserved_light - v_res.reserved_light)
  WHERE windows.user_id = p_user_id
    AND windows.window_kind = 'burst'
    AND windows.window_started_at = v_res.burst_window_started_at;
  UPDATE public.account_capacity_windows AS windows
  SET reserved_light = GREATEST(0, windows.reserved_light - v_res.reserved_light)
  WHERE windows.user_id = p_user_id
    AND windows.window_kind = 'weekly'
    AND windows.window_started_at = v_res.weekly_window_started_at;
  IF v_res.capacity_agent_id IS NOT NULL THEN
    UPDATE public.agent_capacity_windows AS windows
    SET reserved_light = GREATEST(0, windows.reserved_light - v_res.reserved_light)
    WHERE windows.user_id = p_user_id
      AND windows.capacity_agent_id = v_res.capacity_agent_id
      AND windows.window_kind = 'burst'
      AND windows.window_started_at = v_res.burst_window_started_at;
    UPDATE public.agent_capacity_windows AS windows
    SET reserved_light = GREATEST(0, windows.reserved_light - v_res.reserved_light)
    WHERE windows.user_id = p_user_id
      AND windows.capacity_agent_id = v_res.capacity_agent_id
      AND windows.window_kind = 'weekly'
      AND windows.window_started_at = v_res.weekly_window_started_at;
  END IF;
  UPDATE public.account_capacity_reservations AS reservations
  SET status = CASE WHEN p_expired THEN 'expired' ELSE 'released' END,
      released_at = now()
  WHERE reservations.id = v_res.id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_agent_capacity_policy(
  p_user_id uuid,
  p_capacity_agent_id uuid,
  p_cap_basis_points integer
)
RETURNS TABLE (capacity_agent_id uuid, agent_cap_basis_points integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ent public.account_entitlements;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('account_capacity:' || p_user_id::text, 0)
  );
  IF p_cap_basis_points IS NULL OR p_cap_basis_points NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Agent capacity cap must be between 1 and 10000 basis points';
  END IF;
  PERFORM 1 FROM public.apps AS apps
  WHERE apps.id = p_capacity_agent_id
    AND apps.owner_id = p_user_id
    AND apps.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Capacity Agent is not owned by the account'; END IF;
  v_ent := public.ensure_account_entitlement(p_user_id);
  IF v_ent.plan_code = 'free' THEN
    RAISE EXCEPTION 'Free Agent capacity is fixed at 100 percent';
  END IF;

  INSERT INTO public.agent_capacity_policies (
    user_id, capacity_agent_id, cap_basis_points
  ) VALUES (p_user_id, p_capacity_agent_id, p_cap_basis_points)
  ON CONFLICT ON CONSTRAINT agent_capacity_policies_pkey DO UPDATE
    SET cap_basis_points = EXCLUDED.cap_basis_points;
  RETURN QUERY SELECT p_capacity_agent_id, p_cap_basis_points;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_agent_capacity_status(
  p_user_id uuid,
  p_capacity_agent_id uuid,
  p_now timestamp with time zone DEFAULT now()
)
RETURNS TABLE (
  capacity_agent_id uuid,
  plan_code text,
  limits_public boolean,
  capacity_state text,
  burst_state text,
  weekly_state text,
  burst_resets_at timestamp with time zone,
  weekly_resets_at timestamp with time zone,
  next_eligible_at timestamp with time zone,
  agent_cap_basis_points integer,
  agent_burst_limit_light double precision,
  agent_burst_used_light double precision,
  agent_weekly_limit_light double precision,
  agent_weekly_used_light double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ent public.account_entitlements;
  v_plan public.billing_plans;
  v_cap_basis_points integer;
  v_burst_start timestamp with time zone;
  v_week_start timestamp with time zone;
  v_burst_end timestamp with time zone;
  v_week_end timestamp with time zone;
  v_burst_limit double precision;
  v_week_limit double precision;
  v_burst_used double precision;
  v_week_used double precision;
  v_state text;
  v_next timestamp with time zone;
BEGIN
  PERFORM 1 FROM public.apps AS apps
  WHERE apps.id = p_capacity_agent_id
    AND apps.owner_id = p_user_id
    AND apps.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Capacity Agent is not owned by the account'; END IF;
  PERFORM public.reap_expired_account_capacity(p_user_id, p_now);
  v_ent := public.ensure_account_entitlement(p_user_id);
  SELECT plans.* INTO v_plan FROM public.billing_plans AS plans
  WHERE plans.code = v_ent.plan_code;
  SELECT COALESCE(policies.cap_basis_points, 10000)
    INTO v_cap_basis_points
  FROM (SELECT 1) AS seed
  LEFT JOIN public.agent_capacity_policies AS policies
    ON policies.user_id = p_user_id
    AND policies.capacity_agent_id = p_capacity_agent_id;
  v_cap_basis_points := COALESCE(v_cap_basis_points, 10000);
  IF v_plan.code = 'free' THEN v_cap_basis_points := 10000; END IF;
  v_burst_start := public.capacity_window_start(
    v_ent.capacity_anchor_at, v_plan.burst_window_seconds, p_now
  );
  v_week_start := public.capacity_window_start(
    v_ent.capacity_anchor_at, v_plan.weekly_window_seconds, p_now
  );
  v_burst_end := v_burst_start + v_plan.burst_window_seconds * interval '1 second';
  v_week_end := v_week_start + v_plan.weekly_window_seconds * interval '1 second';
  v_burst_limit := v_plan.burst_limit_light * v_cap_basis_points / 10000.0;
  v_week_limit := v_plan.weekly_limit_light * v_cap_basis_points / 10000.0;
  SELECT COALESCE(windows.used_light + windows.reserved_light, 0)
    INTO v_burst_used
  FROM public.agent_capacity_windows AS windows
  WHERE windows.user_id = p_user_id
    AND windows.capacity_agent_id = p_capacity_agent_id
    AND windows.window_kind = 'burst'
    AND windows.window_started_at = v_burst_start;
  SELECT COALESCE(windows.used_light + windows.reserved_light, 0)
    INTO v_week_used
  FROM public.agent_capacity_windows AS windows
  WHERE windows.user_id = p_user_id
    AND windows.capacity_agent_id = p_capacity_agent_id
    AND windows.window_kind = 'weekly'
    AND windows.window_started_at = v_week_start;
  v_burst_used := COALESCE(v_burst_used, 0);
  v_week_used := COALESCE(v_week_used, 0);

  IF v_burst_used >= v_burst_limit OR v_week_used >= v_week_limit THEN
    v_state := 'waiting';
    v_next := CASE
      WHEN v_burst_used >= v_burst_limit AND v_week_used >= v_week_limit
        THEN GREATEST(v_burst_end, v_week_end)
      WHEN v_burst_used >= v_burst_limit THEN v_burst_end
      ELSE v_week_end
    END;
  ELSIF v_burst_used >= v_burst_limit * 0.8
    OR v_week_used >= v_week_limit * 0.8 THEN
    v_state := 'low';
    v_next := NULL;
  ELSE
    v_state := 'available';
    v_next := NULL;
  END IF;

  RETURN QUERY SELECT p_capacity_agent_id, v_plan.code, v_plan.limits_public,
    v_state,
    CASE WHEN v_burst_used >= v_burst_limit THEN 'waiting'
      WHEN v_burst_used >= v_burst_limit * 0.8 THEN 'low'
      ELSE 'available' END,
    CASE WHEN v_week_used >= v_week_limit THEN 'waiting'
      WHEN v_week_used >= v_week_limit * 0.8 THEN 'low'
      ELSE 'available' END,
    v_burst_end, v_week_end, v_next, v_cap_basis_points,
    v_burst_limit, v_burst_used, v_week_limit, v_week_used;
END;
$$;

ALTER TABLE public.agent_capacity_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_capacity_windows ENABLE ROW LEVEL SECURITY;

-- Capacity policy and metering rows are internal control-plane state. Keep
-- PostgREST roles out even if project-level default grants change; all access
-- is mediated by the owner-validating SECURITY DEFINER RPCs below.
REVOKE ALL ON TABLE public.agent_capacity_policies
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.agent_capacity_windows
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.agent_capacity_policies TO service_role;
GRANT ALL ON TABLE public.agent_capacity_windows TO service_role;

REVOKE ALL ON FUNCTION public.reserve_account_capacity_v2(
  uuid, uuid, text, double precision, timestamp with time zone, jsonb,
  timestamp with time zone
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_agent_capacity_policy(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_agent_capacity_status(
  uuid, uuid, timestamp with time zone
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_account_capacity_v2(
  uuid, uuid, text, double precision, timestamp with time zone, jsonb,
  timestamp with time zone
) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_agent_capacity_policy(uuid, uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_agent_capacity_status(
  uuid, uuid, timestamp with time zone
) TO service_role;
