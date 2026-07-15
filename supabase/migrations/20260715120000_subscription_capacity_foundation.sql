-- P2.1: subscription entitlements, shared account capacity, and coalesced wakes.
--
-- Light remains the private weighted-work denomination so the hardened cloud
-- metering and routine budget ledgers do not need a destructive rewrite. None
-- of the raw limits in this migration are exposed by the launch API for Free.

CREATE TABLE IF NOT EXISTS public.billing_plans (
  code text PRIMARY KEY,
  display_name text NOT NULL,
  price_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  interval text NOT NULL DEFAULT 'month',
  stripe_price_id text,
  active_agent_limit integer,
  burst_window_seconds integer NOT NULL DEFAULT 18000,
  burst_limit_light double precision NOT NULL,
  weekly_window_seconds integer NOT NULL DEFAULT 604800,
  weekly_limit_light double precision NOT NULL,
  policy_version integer NOT NULL DEFAULT 1,
  purchasable boolean NOT NULL DEFAULT false,
  limits_public boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT billing_plans_code_check CHECK (
    code IN ('free', 'pro', 'max_5x', 'max_10x')
  ),
  CONSTRAINT billing_plans_amount_check CHECK (
    price_cents >= 0
    AND (active_agent_limit IS NULL OR active_agent_limit > 0)
    AND burst_window_seconds > 0
    AND weekly_window_seconds > burst_window_seconds
    AND burst_limit_light > 0
    AND weekly_limit_light >= burst_limit_light
    AND policy_version > 0
  )
);

INSERT INTO public.billing_plans (
  code,
  display_name,
  price_cents,
  active_agent_limit,
  burst_limit_light,
  weekly_limit_light,
  purchasable,
  limits_public
) VALUES
  ('free', 'Free', 0, 1, 1, 20, false, false),
  ('pro', 'Pro', 2000, NULL, 5, 100, true, false),
  ('max_5x', 'Max 5x', 10000, NULL, 25, 500, false, false),
  ('max_10x', 'Max 10x', 20000, NULL, 50, 1000, false, false)
ON CONFLICT (code) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_plans_stripe_price
  ON public.billing_plans(stripe_price_id)
  WHERE stripe_price_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.account_subscriptions (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  plan_code text NOT NULL REFERENCES public.billing_plans(code),
  status text NOT NULL DEFAULT 'inactive',
  current_period_start timestamp with time zone,
  current_period_end timestamp with time zone,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamp with time zone,
  ended_at timestamp with time zone,
  last_stripe_event_id text REFERENCES public.stripe_events(id) ON DELETE SET NULL,
  last_stripe_event_created_at timestamp with time zone,
  stripe_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT account_subscriptions_status_check CHECK (
    status IN (
      'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due',
      'canceled', 'unpaid', 'paused', 'inactive'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_subscriptions_stripe_subscription
  ON public.account_subscriptions(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_account_subscriptions_stripe_customer
  ON public.account_subscriptions(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.account_entitlements (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  plan_code text NOT NULL DEFAULT 'free' REFERENCES public.billing_plans(code),
  source text NOT NULL DEFAULT 'default',
  capacity_anchor_at timestamp with time zone NOT NULL DEFAULT now(),
  free_agent_id uuid REFERENCES public.apps(id) ON DELETE SET NULL,
  subscription_status text NOT NULL DEFAULT 'inactive',
  subscription_period_end timestamp with time zone,
  policy_version integer NOT NULL DEFAULT 1,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT account_entitlements_source_check CHECK (
    source IN ('default', 'stripe', 'admin', 'grandfathered')
  )
);

INSERT INTO public.account_entitlements (user_id, capacity_anchor_at)
SELECT id, COALESCE(created_at, now())
FROM public.users
ON CONFLICT (user_id) DO NOTHING;

-- Normalize only canonical launch-primary routines. Historical/internal
-- routines retain their existing lifecycle and economics; Free starts with the
-- most recently active persistent Agent and pauses any additional ones.
WITH ranked AS (
  SELECT
    routines.user_id,
    routines.composer_app_id,
    row_number() OVER (
      PARTITION BY routines.user_id
      ORDER BY routines.last_run_at DESC NULLS LAST, routines.updated_at DESC, routines.id DESC
    ) AS position
  FROM public.user_routines AS routines
  WHERE routines.deleted_at IS NULL
    AND routines.status = 'active'
    AND routines.composer_app_id IS NOT NULL
    AND routines.metadata->>'launch_primary' = 'true'
), selected AS (
  SELECT user_id, composer_app_id FROM ranked WHERE position = 1
)
UPDATE public.account_entitlements AS entitlements
SET free_agent_id = selected.composer_app_id
FROM selected
WHERE entitlements.user_id = selected.user_id
  AND entitlements.plan_code = 'free';

WITH ranked AS (
  SELECT
    routines.id,
    row_number() OVER (
      PARTITION BY routines.user_id
      ORDER BY routines.last_run_at DESC NULLS LAST, routines.updated_at DESC, routines.id DESC
    ) AS position
  FROM public.user_routines AS routines
  JOIN public.account_entitlements AS entitlements
    ON entitlements.user_id = routines.user_id AND entitlements.plan_code = 'free'
  WHERE routines.deleted_at IS NULL
    AND routines.status = 'active'
    AND routines.composer_app_id IS NOT NULL
    AND routines.metadata->>'launch_primary' = 'true'
)
UPDATE public.user_routines AS routines
SET status = 'paused', next_run_at = NULL,
    metadata = COALESCE(routines.metadata, '{}'::jsonb) || jsonb_build_object(
      'auto_pause', jsonb_build_object(
        'code', 'free_active_agent_limit',
        'message', 'Paused when subscription capacity enabled the one active Agent Free plan.',
        'at', now()
      )
    )
FROM ranked
WHERE routines.id = ranked.id AND ranked.position > 1;

CREATE TABLE IF NOT EXISTS public.account_capacity_windows (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  plan_code text NOT NULL REFERENCES public.billing_plans(code),
  policy_version integer NOT NULL,
  window_kind text NOT NULL,
  window_started_at timestamp with time zone NOT NULL,
  window_ends_at timestamp with time zone NOT NULL,
  used_light double precision NOT NULL DEFAULT 0,
  reserved_light double precision NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, window_kind, window_started_at),
  CONSTRAINT account_capacity_window_kind_check CHECK (
    window_kind IN ('burst', 'weekly')
  ),
  CONSTRAINT account_capacity_window_amount_check CHECK (
    used_light >= 0 AND reserved_light >= 0 AND window_ends_at > window_started_at
  )
);

CREATE INDEX IF NOT EXISTS idx_account_capacity_windows_expiry
  ON public.account_capacity_windows(window_ends_at);

CREATE TABLE IF NOT EXISTS public.account_capacity_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  plan_code text NOT NULL REFERENCES public.billing_plans(code),
  policy_version integer NOT NULL,
  reserved_light double precision NOT NULL,
  actual_light double precision,
  burst_window_started_at timestamp with time zone NOT NULL,
  weekly_window_started_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  settled_at timestamp with time zone,
  released_at timestamp with time zone,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CONSTRAINT account_capacity_reservation_status_check CHECK (
    status IN ('reserved', 'settled', 'released', 'expired')
  ),
  CONSTRAINT account_capacity_reservation_amount_check CHECK (
    reserved_light >= 0 AND (actual_light IS NULL OR actual_light >= 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_account_capacity_reservations_expiry
  ON public.account_capacity_reservations(status, expires_at)
  WHERE status = 'reserved';

CREATE TABLE IF NOT EXISTS public.deferred_routine_wakes (
  routine_id uuid PRIMARY KEY REFERENCES public.user_routines(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  first_deferred_at timestamp with time zone NOT NULL,
  latest_deferred_at timestamp with time zone NOT NULL,
  deferred_wake_count bigint NOT NULL DEFAULT 1,
  next_eligible_at timestamp with time zone NOT NULL,
  manual_requested boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT deferred_routine_wakes_count_check CHECK (deferred_wake_count > 0)
);

CREATE INDEX IF NOT EXISTS idx_deferred_routine_wakes_due
  ON public.deferred_routine_wakes(next_eligible_at, updated_at);

CREATE OR REPLACE FUNCTION public.touch_p21_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS touch_billing_plans_updated_at ON public.billing_plans;
CREATE TRIGGER touch_billing_plans_updated_at
BEFORE UPDATE ON public.billing_plans
FOR EACH ROW EXECUTE FUNCTION public.touch_p21_updated_at();

DROP TRIGGER IF EXISTS touch_account_subscriptions_updated_at ON public.account_subscriptions;
CREATE TRIGGER touch_account_subscriptions_updated_at
BEFORE UPDATE ON public.account_subscriptions
FOR EACH ROW EXECUTE FUNCTION public.touch_p21_updated_at();

DROP TRIGGER IF EXISTS touch_account_entitlements_updated_at ON public.account_entitlements;
CREATE TRIGGER touch_account_entitlements_updated_at
BEFORE UPDATE ON public.account_entitlements
FOR EACH ROW EXECUTE FUNCTION public.touch_p21_updated_at();

DROP TRIGGER IF EXISTS touch_account_capacity_windows_updated_at ON public.account_capacity_windows;
CREATE TRIGGER touch_account_capacity_windows_updated_at
BEFORE UPDATE ON public.account_capacity_windows
FOR EACH ROW EXECUTE FUNCTION public.touch_p21_updated_at();

DROP TRIGGER IF EXISTS touch_account_capacity_reservations_updated_at ON public.account_capacity_reservations;
CREATE TRIGGER touch_account_capacity_reservations_updated_at
BEFORE UPDATE ON public.account_capacity_reservations
FOR EACH ROW EXECUTE FUNCTION public.touch_p21_updated_at();

DROP TRIGGER IF EXISTS touch_deferred_routine_wakes_updated_at ON public.deferred_routine_wakes;
CREATE TRIGGER touch_deferred_routine_wakes_updated_at
BEFORE UPDATE ON public.deferred_routine_wakes
FOR EACH ROW EXECUTE FUNCTION public.touch_p21_updated_at();

CREATE OR REPLACE FUNCTION public.capacity_window_start(
  p_anchor timestamp with time zone,
  p_window_seconds integer,
  p_at timestamp with time zone
)
RETURNS timestamp with time zone
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT p_anchor +
    floor(extract(epoch FROM (p_at - p_anchor)) / p_window_seconds) *
      p_window_seconds * interval '1 second'
$$;

CREATE OR REPLACE FUNCTION public.ensure_account_entitlement(p_user_id uuid)
RETURNS public.account_entitlements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.account_entitlements;
BEGIN
  INSERT INTO public.account_entitlements (user_id, capacity_anchor_at)
  SELECT u.id, COALESCE(u.created_at, now())
  FROM public.users u
  WHERE u.id = p_user_id
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_row
  FROM public.account_entitlements
  WHERE user_id = p_user_id;

  IF v_row.user_id IS NULL THEN
    RAISE EXCEPTION 'Account entitlement user not found';
  END IF;
  RETURN v_row;
END;
$$;

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
  FOR v_res IN
    SELECT *
    FROM public.account_capacity_reservations
    WHERE user_id = p_user_id AND status = 'reserved' AND expires_at <= p_now
    ORDER BY id
    FOR UPDATE
  LOOP
    UPDATE public.account_capacity_windows
    SET reserved_light = GREATEST(0, reserved_light - v_res.reserved_light)
    WHERE user_id = p_user_id
      AND (
        (window_kind = 'burst' AND window_started_at = v_res.burst_window_started_at)
        OR (window_kind = 'weekly' AND window_started_at = v_res.weekly_window_started_at)
      );
    UPDATE public.account_capacity_reservations
    SET status = 'expired', released_at = p_now
    WHERE id = v_res.id;
    v_reaped := v_reaped + 1;
  END LOOP;
  RETURN v_reaped;
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_account_capacity(
  p_user_id uuid,
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
  weekly_remaining_light double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ent public.account_entitlements;
  v_plan public.billing_plans;
  v_existing public.account_capacity_reservations;
  v_burst_start timestamp with time zone;
  v_week_start timestamp with time zone;
  v_burst_end timestamp with time zone;
  v_week_end timestamp with time zone;
  v_burst public.account_capacity_windows;
  v_week public.account_capacity_windows;
  v_burst_remaining double precision;
  v_week_remaining double precision;
  v_next timestamp with time zone;
  v_state text;
  v_reservation_id uuid;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'idempotency key is required';
  END IF;
  IF p_reserve_light IS NULL OR p_reserve_light < 0 OR p_reserve_light IN (
    'NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision
  ) THEN
    RAISE EXCEPTION 'reserve amount must be finite and non-negative';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= p_now THEN
    RAISE EXCEPTION 'reservation expiry must be in the future';
  END IF;

  PERFORM public.reap_expired_account_capacity(p_user_id, p_now);

  SELECT * INTO v_existing
  FROM public.account_capacity_reservations
  WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF v_existing.id IS NOT NULL THEN
    SELECT w.window_ends_at,
      GREATEST(0, bp.burst_limit_light - w.used_light - w.reserved_light)
    INTO v_burst_end, v_burst_remaining
    FROM public.account_capacity_windows w
    JOIN public.billing_plans bp ON bp.code = v_existing.plan_code
    WHERE w.user_id = p_user_id
      AND w.window_kind = 'burst'
      AND w.window_started_at = v_existing.burst_window_started_at;
    SELECT w.window_ends_at,
      GREATEST(0, bp.weekly_limit_light - w.used_light - w.reserved_light)
    INTO v_week_end, v_week_remaining
    FROM public.account_capacity_windows w
    JOIN public.billing_plans bp ON bp.code = v_existing.plan_code
    WHERE w.user_id = p_user_id
      AND w.window_kind = 'weekly'
      AND w.window_started_at = v_existing.weekly_window_started_at;
    RETURN QUERY SELECT
      v_existing.status IN ('reserved', 'settled'),
      CASE WHEN v_existing.status IN ('reserved', 'settled') THEN 'ok' ELSE v_existing.status END,
      v_existing.id,
      v_existing.plan_code,
      CASE WHEN v_existing.status IN ('reserved', 'settled') THEN 'available' ELSE 'waiting' END,
      CASE WHEN v_existing.status IN ('reserved', 'settled') THEN 'available' ELSE 'waiting' END,
      CASE WHEN v_existing.status IN ('reserved', 'settled') THEN 'available' ELSE 'waiting' END,
      v_burst_end,
      v_week_end,
      NULL::timestamp with time zone,
      COALESCE(v_burst_remaining, 0),
      COALESCE(v_week_remaining, 0);
    RETURN;
  END IF;

  v_ent := public.ensure_account_entitlement(p_user_id);
  SELECT * INTO v_plan FROM public.billing_plans AS plans WHERE plans.code = v_ent.plan_code;
  IF v_plan.code IS NULL THEN RAISE EXCEPTION 'Account plan is unavailable'; END IF;

  v_burst_start := public.capacity_window_start(
    v_ent.capacity_anchor_at, v_plan.burst_window_seconds, p_now
  );
  v_week_start := public.capacity_window_start(
    v_ent.capacity_anchor_at, v_plan.weekly_window_seconds, p_now
  );
  v_burst_end := v_burst_start + v_plan.burst_window_seconds * interval '1 second';
  v_week_end := v_week_start + v_plan.weekly_window_seconds * interval '1 second';

  INSERT INTO public.account_capacity_windows (
    user_id, plan_code, policy_version, window_kind, window_started_at, window_ends_at
  ) VALUES
    (p_user_id, v_plan.code, v_plan.policy_version, 'burst', v_burst_start, v_burst_end),
    (p_user_id, v_plan.code, v_plan.policy_version, 'weekly', v_week_start, v_week_end)
  ON CONFLICT (user_id, window_kind, window_started_at) DO NOTHING;

  SELECT * INTO v_burst
  FROM public.account_capacity_windows
  WHERE user_id = p_user_id AND window_kind = 'burst'
    AND window_started_at = v_burst_start
  FOR UPDATE;
  SELECT * INTO v_week
  FROM public.account_capacity_windows
  WHERE user_id = p_user_id AND window_kind = 'weekly'
    AND window_started_at = v_week_start
  FOR UPDATE;

  v_burst_remaining := GREATEST(
    0, v_plan.burst_limit_light - v_burst.used_light - v_burst.reserved_light
  );
  v_week_remaining := GREATEST(
    0, v_plan.weekly_limit_light - v_week.used_light - v_week.reserved_light
  );

  IF p_reserve_light > v_burst_remaining OR p_reserve_light > v_week_remaining THEN
    v_next := CASE
      WHEN p_reserve_light > v_burst_remaining AND p_reserve_light > v_week_remaining
        THEN GREATEST(v_burst_end, v_week_end)
      WHEN p_reserve_light > v_burst_remaining THEN v_burst_end
      ELSE v_week_end
    END;
    RETURN QUERY SELECT false, 'capacity_waiting', NULL::uuid, v_plan.code,
      'waiting',
      CASE WHEN p_reserve_light > v_burst_remaining THEN 'waiting' ELSE 'available' END,
      CASE WHEN p_reserve_light > v_week_remaining THEN 'waiting' ELSE 'available' END,
      v_burst_end, v_week_end, v_next,
      v_burst_remaining, v_week_remaining;
    RETURN;
  END IF;

  INSERT INTO public.account_capacity_reservations (
    user_id, idempotency_key, plan_code, policy_version, reserved_light,
    burst_window_started_at, weekly_window_started_at, expires_at, metadata
  ) VALUES (
    p_user_id, p_idempotency_key, v_plan.code, v_plan.policy_version,
    p_reserve_light, v_burst_start, v_week_start, p_expires_at,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_reservation_id;

  -- A concurrent request can win the same idempotency key after our initial
  -- read but before this insert. It owns the reservation; return its durable
  -- decision without incrementing either capacity window a second time.
  IF v_reservation_id IS NULL THEN
    SELECT * INTO v_existing
    FROM public.account_capacity_reservations
    WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key
    FOR UPDATE;
    RETURN QUERY SELECT
      v_existing.status IN ('reserved', 'settled'),
      CASE WHEN v_existing.status IN ('reserved', 'settled') THEN 'ok' ELSE v_existing.status END,
      v_existing.id,
      v_existing.plan_code,
      CASE WHEN v_existing.status IN ('reserved', 'settled') THEN 'available' ELSE 'waiting' END,
      CASE WHEN v_existing.status IN ('reserved', 'settled') THEN 'available' ELSE 'waiting' END,
      CASE WHEN v_existing.status IN ('reserved', 'settled') THEN 'available' ELSE 'waiting' END,
      v_burst_end,
      v_week_end,
      NULL::timestamp with time zone,
      v_burst_remaining,
      v_week_remaining;
    RETURN;
  END IF;

  UPDATE public.account_capacity_windows
  SET reserved_light = reserved_light + p_reserve_light
  WHERE user_id = p_user_id
    AND (
      (window_kind = 'burst' AND window_started_at = v_burst_start)
      OR (window_kind = 'weekly' AND window_started_at = v_week_start)
    );

  v_burst_remaining := v_burst_remaining - p_reserve_light;
  v_week_remaining := v_week_remaining - p_reserve_light;
  v_state := CASE
    WHEN v_burst_remaining <= v_plan.burst_limit_light * 0.2
      OR v_week_remaining <= v_plan.weekly_limit_light * 0.2
      THEN 'low'
    ELSE 'available'
  END;

  RETURN QUERY SELECT true, 'ok', v_reservation_id, v_plan.code, v_state,
    CASE
      WHEN v_burst_remaining <= v_plan.burst_limit_light * 0.2 THEN 'low'
      ELSE 'available'
    END,
    CASE
      WHEN v_week_remaining <= v_plan.weekly_limit_light * 0.2 THEN 'low'
      ELSE 'available'
    END,
    v_burst_end, v_week_end, NULL::timestamp with time zone,
    v_burst_remaining, v_week_remaining;
END;
$$;

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
  v_actual double precision;
BEGIN
  IF p_actual_light IS NULL OR p_actual_light < 0 OR p_actual_light IN (
    'NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision
  ) THEN
    RAISE EXCEPTION 'actual amount must be finite and non-negative';
  END IF;
  SELECT * INTO v_res
  FROM public.account_capacity_reservations
  WHERE id = p_reservation_id AND user_id = p_user_id
  FOR UPDATE;
  IF v_res.id IS NULL THEN RAISE EXCEPTION 'Capacity reservation not found'; END IF;
  IF v_res.status = 'settled' THEN RETURN true; END IF;
  IF v_res.status <> 'reserved' THEN RETURN false; END IF;

  -- Post-execution D1/KV/R2 work can slightly exceed the conservative runtime
  -- hold. Persist the full actual amount so subsequent admission waits rather
  -- than silently losing real infrastructure usage.
  v_actual := p_actual_light;
  UPDATE public.account_capacity_windows
  SET reserved_light = GREATEST(0, reserved_light - v_res.reserved_light),
      used_light = used_light + v_actual
  WHERE user_id = p_user_id
    AND (
      (window_kind = 'burst' AND window_started_at = v_res.burst_window_started_at)
      OR (window_kind = 'weekly' AND window_started_at = v_res.weekly_window_started_at)
    );
  UPDATE public.account_capacity_reservations
  SET status = 'settled', actual_light = v_actual, settled_at = now()
  WHERE id = v_res.id;
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
  SELECT * INTO v_res
  FROM public.account_capacity_reservations
  WHERE id = p_reservation_id AND user_id = p_user_id
  FOR UPDATE;
  IF v_res.id IS NULL THEN RETURN false; END IF;
  IF v_res.status <> 'reserved' THEN RETURN v_res.status IN ('released', 'expired'); END IF;

  UPDATE public.account_capacity_windows
  SET reserved_light = GREATEST(0, reserved_light - v_res.reserved_light)
  WHERE user_id = p_user_id
    AND (
      (window_kind = 'burst' AND window_started_at = v_res.burst_window_started_at)
      OR (window_kind = 'weekly' AND window_started_at = v_res.weekly_window_started_at)
    );
  UPDATE public.account_capacity_reservations
  SET status = CASE WHEN p_expired THEN 'expired' ELSE 'released' END,
      released_at = now()
  WHERE id = v_res.id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_account_capacity_status(
  p_user_id uuid,
  p_now timestamp with time zone DEFAULT now()
)
RETURNS TABLE (
  plan_code text,
  limits_public boolean,
  active_agent_limit integer,
  capacity_state text,
  burst_state text,
  weekly_state text,
  burst_resets_at timestamp with time zone,
  weekly_resets_at timestamp with time zone,
  next_eligible_at timestamp with time zone,
  burst_limit_light double precision,
  burst_used_light double precision,
  weekly_limit_light double precision,
  weekly_used_light double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ent public.account_entitlements;
  v_plan public.billing_plans;
  v_burst_start timestamp with time zone;
  v_week_start timestamp with time zone;
  v_burst_end timestamp with time zone;
  v_week_end timestamp with time zone;
  v_burst_used double precision;
  v_week_used double precision;
  v_state text;
  v_next timestamp with time zone;
BEGIN
  PERFORM public.reap_expired_account_capacity(p_user_id, p_now);
  v_ent := public.ensure_account_entitlement(p_user_id);
  SELECT * INTO v_plan FROM public.billing_plans WHERE code = v_ent.plan_code;
  v_burst_start := public.capacity_window_start(
    v_ent.capacity_anchor_at, v_plan.burst_window_seconds, p_now
  );
  v_week_start := public.capacity_window_start(
    v_ent.capacity_anchor_at, v_plan.weekly_window_seconds, p_now
  );
  v_burst_end := v_burst_start + v_plan.burst_window_seconds * interval '1 second';
  v_week_end := v_week_start + v_plan.weekly_window_seconds * interval '1 second';
  SELECT COALESCE(used_light + reserved_light, 0) INTO v_burst_used
  FROM public.account_capacity_windows
  WHERE user_id = p_user_id AND window_kind = 'burst'
    AND window_started_at = v_burst_start;
  SELECT COALESCE(used_light + reserved_light, 0) INTO v_week_used
  FROM public.account_capacity_windows
  WHERE user_id = p_user_id AND window_kind = 'weekly'
    AND window_started_at = v_week_start;
  v_burst_used := COALESCE(v_burst_used, 0);
  v_week_used := COALESCE(v_week_used, 0);
  IF v_burst_used >= v_plan.burst_limit_light OR v_week_used >= v_plan.weekly_limit_light THEN
    v_state := 'waiting';
    v_next := CASE
      WHEN v_burst_used >= v_plan.burst_limit_light AND v_week_used >= v_plan.weekly_limit_light
        THEN GREATEST(v_burst_end, v_week_end)
      WHEN v_burst_used >= v_plan.burst_limit_light THEN v_burst_end
      ELSE v_week_end
    END;
  ELSIF v_burst_used >= v_plan.burst_limit_light * 0.8
    OR v_week_used >= v_plan.weekly_limit_light * 0.8 THEN
    v_state := 'low';
    v_next := NULL;
  ELSE
    v_state := 'available';
    v_next := NULL;
  END IF;
  RETURN QUERY SELECT v_plan.code, v_plan.limits_public, v_plan.active_agent_limit,
    v_state,
    CASE
      WHEN v_burst_used >= v_plan.burst_limit_light THEN 'waiting'
      WHEN v_burst_used >= v_plan.burst_limit_light * 0.8 THEN 'low'
      ELSE 'available'
    END,
    CASE
      WHEN v_week_used >= v_plan.weekly_limit_light THEN 'waiting'
      WHEN v_week_used >= v_plan.weekly_limit_light * 0.8 THEN 'low'
      ELSE 'available'
    END,
    v_burst_end, v_week_end, v_next,
    v_plan.burst_limit_light, v_burst_used,
    v_plan.weekly_limit_light, v_week_used;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_agent_activation_slot(
  p_user_id uuid,
  p_app_id uuid
)
RETURNS TABLE (allowed boolean, code text, active_agent_limit integer, occupied_by uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ent public.account_entitlements;
  v_limit integer;
BEGIN
  v_ent := public.ensure_account_entitlement(p_user_id);
  SELECT bp.active_agent_limit INTO v_limit
  FROM public.billing_plans bp WHERE bp.code = v_ent.plan_code;
  SELECT * INTO v_ent FROM public.account_entitlements
  WHERE user_id = p_user_id FOR UPDATE;
  IF v_limit IS NULL THEN
    RETURN QUERY SELECT true, 'ok', NULL::integer, NULL::uuid;
    RETURN;
  END IF;
  IF v_ent.free_agent_id IS NULL OR v_ent.free_agent_id = p_app_id THEN
    UPDATE public.account_entitlements SET free_agent_id = p_app_id
    WHERE user_id = p_user_id;
    RETURN QUERY SELECT true, 'ok', v_limit, p_app_id;
  ELSE
    RETURN QUERY SELECT false, 'active_agent_limit', v_limit, v_ent.free_agent_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.project_account_subscription(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_plan_code text,
  p_status text,
  p_current_period_start timestamp with time zone,
  p_current_period_end timestamp with time zone,
  p_cancel_at_period_end boolean,
  p_canceled_at timestamp with time zone,
  p_ended_at timestamp with time zone,
  p_event_id text,
  p_event_created_at timestamp with time zone,
  p_snapshot jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_created_at timestamp with time zone;
  v_effective_plan text;
  v_free_agent_id uuid;
BEGIN
  SELECT last_stripe_event_created_at INTO v_existing_created_at
  FROM public.account_subscriptions
  WHERE user_id = p_user_id
  FOR UPDATE;
  IF v_existing_created_at IS NOT NULL AND p_event_created_at < v_existing_created_at THEN
    RETURN false;
  END IF;

  INSERT INTO public.account_subscriptions (
    user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
    plan_code, status, current_period_start, current_period_end,
    cancel_at_period_end, canceled_at, ended_at, last_stripe_event_id,
    last_stripe_event_created_at, stripe_snapshot
  ) VALUES (
    p_user_id, p_stripe_customer_id, p_stripe_subscription_id, p_stripe_price_id,
    p_plan_code, p_status, p_current_period_start, p_current_period_end,
    COALESCE(p_cancel_at_period_end, false), p_canceled_at, p_ended_at,
    p_event_id, p_event_created_at, COALESCE(p_snapshot, '{}'::jsonb)
  )
  ON CONFLICT (user_id) DO UPDATE SET
    stripe_customer_id = EXCLUDED.stripe_customer_id,
    stripe_subscription_id = EXCLUDED.stripe_subscription_id,
    stripe_price_id = EXCLUDED.stripe_price_id,
    plan_code = EXCLUDED.plan_code,
    status = EXCLUDED.status,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end = EXCLUDED.current_period_end,
    cancel_at_period_end = EXCLUDED.cancel_at_period_end,
    canceled_at = EXCLUDED.canceled_at,
    ended_at = EXCLUDED.ended_at,
    last_stripe_event_id = EXCLUDED.last_stripe_event_id,
    last_stripe_event_created_at = EXCLUDED.last_stripe_event_created_at,
    stripe_snapshot = EXCLUDED.stripe_snapshot;

  v_effective_plan := CASE
    WHEN p_status IN ('active', 'trialing', 'past_due') THEN p_plan_code
    ELSE 'free'
  END;

  IF v_effective_plan = 'free' THEN
    SELECT composer_app_id INTO v_free_agent_id
    FROM public.user_routines
    WHERE user_id = p_user_id AND deleted_at IS NULL AND status = 'active'
      AND composer_app_id IS NOT NULL
      AND metadata->>'launch_primary' = 'true'
    ORDER BY last_run_at DESC NULLS LAST, updated_at DESC
    LIMIT 1;
  END IF;

  INSERT INTO public.account_entitlements (
    user_id, plan_code, source, capacity_anchor_at, free_agent_id,
    subscription_status, subscription_period_end
  ) VALUES (
    p_user_id, v_effective_plan, 'stripe',
    COALESCE(p_current_period_start, now()), v_free_agent_id,
    p_status, p_current_period_end
  )
  ON CONFLICT (user_id) DO UPDATE SET
    plan_code = EXCLUDED.plan_code,
    source = 'stripe',
    capacity_anchor_at = CASE
      WHEN public.account_entitlements.plan_code IS DISTINCT FROM EXCLUDED.plan_code
        THEN EXCLUDED.capacity_anchor_at
      ELSE public.account_entitlements.capacity_anchor_at
    END,
    free_agent_id = CASE
      WHEN EXCLUDED.plan_code = 'free'
        THEN EXCLUDED.free_agent_id
      ELSE NULL
    END,
    subscription_status = EXCLUDED.subscription_status,
    subscription_period_end = EXCLUDED.subscription_period_end;

  IF v_effective_plan = 'free' THEN
    UPDATE public.user_routines
    SET status = 'paused', next_run_at = NULL,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'auto_pause', jsonb_build_object(
            'code', 'free_active_agent_limit',
            'message', 'Paused when the account returned to its one active Agent Free plan.',
            'at', now()
          )
        )
    WHERE user_id = p_user_id AND deleted_at IS NULL AND status = 'active'
      AND metadata->>'launch_primary' = 'true'
      AND (v_free_agent_id IS NULL OR composer_app_id IS DISTINCT FROM v_free_agent_id);
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_agent_activation_slot(
  p_user_id uuid,
  p_app_id uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.account_entitlements
  SET free_agent_id = NULL
  WHERE user_id = p_user_id AND free_agent_id = p_app_id
  RETURNING true
$$;

CREATE OR REPLACE FUNCTION public.record_deferred_routine_wake(
  p_routine_id uuid,
  p_user_id uuid,
  p_scheduled_at timestamp with time zone,
  p_next_eligible_at timestamp with time zone,
  p_manual_requested boolean DEFAULT false
)
RETURNS public.deferred_routine_wakes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.deferred_routine_wakes;
BEGIN
  INSERT INTO public.deferred_routine_wakes (
    routine_id, user_id, first_deferred_at, latest_deferred_at,
    next_eligible_at, manual_requested
  ) VALUES (
    p_routine_id, p_user_id, p_scheduled_at, p_scheduled_at,
    p_next_eligible_at, p_manual_requested
  )
  ON CONFLICT (routine_id) DO UPDATE SET
    latest_deferred_at = GREATEST(
      public.deferred_routine_wakes.latest_deferred_at, EXCLUDED.latest_deferred_at
    ),
    deferred_wake_count = public.deferred_routine_wakes.deferred_wake_count + 1,
    next_eligible_at = GREATEST(
      public.deferred_routine_wakes.next_eligible_at, EXCLUDED.next_eligible_at
    ),
    manual_requested = public.deferred_routine_wakes.manual_requested
      OR EXCLUDED.manual_requested
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_deferred_routine_wake(
  p_routine_id uuid,
  p_user_id uuid
)
RETURNS SETOF public.deferred_routine_wakes
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.deferred_routine_wakes
  WHERE routine_id = p_routine_id AND user_id = p_user_id
  RETURNING *
$$;

CREATE OR REPLACE FUNCTION public.attach_deferred_wake_to_run(
  p_routine_id uuid,
  p_user_id uuid,
  p_run_id uuid
)
RETURNS SETOF public.deferred_routine_wakes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wake public.deferred_routine_wakes;
BEGIN
  DELETE FROM public.deferred_routine_wakes
  WHERE routine_id = p_routine_id AND user_id = p_user_id
  RETURNING * INTO v_wake;
  IF v_wake.routine_id IS NULL THEN RETURN; END IF;
  UPDATE public.routine_runs
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'capacity_catch_up', true,
    'deferred_wake_count', v_wake.deferred_wake_count,
    'first_deferred_at', v_wake.first_deferred_at,
    'latest_deferred_at', v_wake.latest_deferred_at,
    'manual_requested', v_wake.manual_requested
  )
  WHERE id = p_run_id AND routine_id = p_routine_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    INSERT INTO public.deferred_routine_wakes SELECT v_wake.*;
    RAISE EXCEPTION 'Routine run not found while attaching deferred wake';
  END IF;
  RETURN NEXT v_wake;
END;
$$;

ALTER TABLE public.billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_capacity_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_capacity_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deferred_routine_wakes ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_subscriptions_owner_read
  ON public.account_subscriptions FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY account_entitlements_owner_read
  ON public.account_entitlements FOR SELECT TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON FUNCTION public.ensure_account_entitlement(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reap_expired_account_capacity(uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_account_capacity(uuid, text, double precision, timestamp with time zone, jsonb, timestamp with time zone) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_account_capacity(uuid, uuid, double precision) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_account_capacity(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_account_capacity_status(uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_agent_activation_slot(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_agent_activation_slot(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_account_subscription(uuid, text, text, text, text, text, timestamp with time zone, timestamp with time zone, boolean, timestamp with time zone, timestamp with time zone, text, timestamp with time zone, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_deferred_routine_wake(uuid, uuid, timestamp with time zone, timestamp with time zone, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_deferred_routine_wake(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attach_deferred_wake_to_run(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ensure_account_entitlement(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reap_expired_account_capacity(uuid, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_account_capacity(uuid, text, double precision, timestamp with time zone, jsonb, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_account_capacity(uuid, uuid, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_account_capacity(uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_account_capacity_status(uuid, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_agent_activation_slot(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_agent_activation_slot(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_account_subscription(uuid, text, text, text, text, text, timestamp with time zone, timestamp with time zone, boolean, timestamp with time zone, timestamp with time zone, text, timestamp with time zone, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_deferred_routine_wake(uuid, uuid, timestamp with time zone, timestamp with time zone, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_deferred_routine_wake(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.attach_deferred_wake_to_run(uuid, uuid, uuid) TO service_role;
