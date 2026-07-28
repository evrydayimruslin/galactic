-- Make paid Pro the only customer-facing usage tier and the weekly allowance
-- the only effective capacity limit. Legacy plan rows remain as non-purchasable
-- compatibility/sentinel records so the rollout does not break historical
-- foreign keys or require an unsafe destructive data migration.

UPDATE public.billing_plans
SET burst_limit_light = weekly_limit_light,
    active_agent_limit = NULL,
    price_cents = CASE WHEN code = 'pro' THEN 2000 ELSE price_cents END,
    purchasable = (code = 'pro'),
    updated_at = now()
WHERE burst_limit_light IS DISTINCT FROM weekly_limit_light
   OR active_agent_limit IS NOT NULL
   OR (code = 'pro' AND price_cents IS DISTINCT FROM 2000)
   OR purchasable IS DISTINCT FROM (code = 'pro');

-- Historical Max subscriptions were paid subscriptions. Collapse their
-- Galactic entitlement to Pro without rewriting the Stripe subscription or
-- price that remains authoritative for billing.
UPDATE public.account_subscriptions
SET plan_code = 'pro',
    updated_at = now()
WHERE plan_code IN ('max_5x', 'max_10x');

-- Only an active paid subscription receives the Pro entitlement. "free" is
-- retained solely as the internal no-access sentinel for signed-in accounts.
UPDATE public.account_entitlements AS entitlements
SET plan_code = CASE
      WHEN subscriptions.status = 'active' THEN 'pro'
      ELSE 'free'
    END,
    free_agent_id = NULL,
    subscription_status = COALESCE(subscriptions.status, 'inactive'),
    subscription_period_end = subscriptions.current_period_end,
    updated_at = now()
FROM (
  SELECT users.id AS user_id,
         account_subscriptions.status,
         account_subscriptions.current_period_end
  FROM public.users AS users
  LEFT JOIN public.account_subscriptions
    ON account_subscriptions.user_id = users.id
) AS subscriptions
WHERE subscriptions.user_id = entitlements.user_id;

UPDATE public.user_routines AS routines
SET status = 'paused',
    next_run_at = NULL,
    updated_at = now(),
    metadata = COALESCE(routines.metadata, '{}'::jsonb) ||
      jsonb_build_object(
        'auto_pause', jsonb_build_object(
          'code', 'pro_subscription_required',
          'message', 'Paused because an active Galactic Pro subscription is required.',
          'at', now()
        )
      )
FROM public.account_entitlements AS entitlements
WHERE entitlements.user_id = routines.user_id
  AND NOT (
    entitlements.plan_code = 'pro'
    AND entitlements.subscription_status = 'active'
  )
  AND routines.deleted_at IS NULL
  AND routines.status = 'active'
  AND (
    routines.metadata->>'launch_managed' = 'true'
    OR routines.metadata->>'launch_primary' = 'true'
  );

-- Capacity history does not confer access. Normalizing its display plan keeps
-- the compatibility burst non-binding and avoids exposing retired plan names.
UPDATE public.account_capacity_windows
SET plan_code = 'pro',
    updated_at = now()
WHERE plan_code IS DISTINCT FROM 'pro';

UPDATE public.account_capacity_reservations
SET plan_code = 'pro',
    updated_at = now()
WHERE plan_code IS DISTINCT FROM 'pro';

UPDATE public.agent_capacity_windows
SET plan_code = 'pro',
    updated_at = now()
WHERE plan_code IS DISTINCT FROM 'pro';

CREATE OR REPLACE FUNCTION public.ensure_account_entitlement(p_user_id uuid)
RETURNS public.account_entitlements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.account_entitlements;
BEGIN
  INSERT INTO public.account_entitlements (
    user_id,
    plan_code,
    capacity_anchor_at
  )
  SELECT u.id, 'free', COALESCE(u.created_at, now())
  FROM public.users AS u
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
BEGIN
  IF p_plan_code IS DISTINCT FROM 'pro' THEN
    RAISE EXCEPTION 'Only the Pro subscription plan is supported';
  END IF;

  SELECT subscriptions.last_stripe_event_created_at
    INTO v_existing_created_at
  FROM public.account_subscriptions AS subscriptions
  WHERE subscriptions.user_id = p_user_id
  FOR UPDATE;

  IF v_existing_created_at IS NOT NULL
    AND p_event_created_at < v_existing_created_at THEN
    RETURN false;
  END IF;

  INSERT INTO public.account_subscriptions (
    user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
    plan_code, status, current_period_start, current_period_end,
    cancel_at_period_end, canceled_at, ended_at, last_stripe_event_id,
    last_stripe_event_created_at, stripe_snapshot
  ) VALUES (
    p_user_id, p_stripe_customer_id, p_stripe_subscription_id, p_stripe_price_id,
    'pro', p_status, p_current_period_start, p_current_period_end,
    COALESCE(p_cancel_at_period_end, false), p_canceled_at, p_ended_at,
    p_event_id, p_event_created_at, COALESCE(p_snapshot, '{}'::jsonb)
  )
  ON CONFLICT (user_id) DO UPDATE SET
    stripe_customer_id = EXCLUDED.stripe_customer_id,
    stripe_subscription_id = EXCLUDED.stripe_subscription_id,
    stripe_price_id = EXCLUDED.stripe_price_id,
    plan_code = 'pro',
    status = EXCLUDED.status,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end = EXCLUDED.current_period_end,
    cancel_at_period_end = EXCLUDED.cancel_at_period_end,
    canceled_at = EXCLUDED.canceled_at,
    ended_at = EXCLUDED.ended_at,
    last_stripe_event_id = EXCLUDED.last_stripe_event_id,
    last_stripe_event_created_at = EXCLUDED.last_stripe_event_created_at,
    stripe_snapshot = EXCLUDED.stripe_snapshot;

  v_effective_plan := CASE WHEN p_status = 'active' THEN 'pro' ELSE 'free' END;

  PERFORM public.ensure_account_entitlement(p_user_id);
  UPDATE public.account_entitlements
  SET plan_code = v_effective_plan,
      source = 'stripe',
      capacity_anchor_at = CASE
        WHEN plan_code IS DISTINCT FROM v_effective_plan
          THEN COALESCE(p_current_period_start, now())
        ELSE capacity_anchor_at
      END,
      free_agent_id = NULL,
      subscription_status = p_status,
      subscription_period_end = p_current_period_end,
      updated_at = now()
  WHERE user_id = p_user_id;

  IF v_effective_plan = 'free' THEN
    UPDATE public.user_routines AS routines
    SET status = 'paused',
        next_run_at = NULL,
        updated_at = now(),
        metadata = COALESCE(routines.metadata, '{}'::jsonb) ||
          jsonb_build_object(
            'auto_pause', jsonb_build_object(
              'code', 'pro_subscription_required',
              'message', 'Paused because an active Galactic Pro subscription is required.',
              'at', now()
            )
          )
    WHERE routines.user_id = p_user_id
      AND routines.deleted_at IS NULL
      AND routines.status = 'active'
      AND (
        routines.metadata->>'launch_managed' = 'true'
        OR routines.metadata->>'launch_primary' = 'true'
      );
  END IF;

  RETURN true;
END;
$$;
