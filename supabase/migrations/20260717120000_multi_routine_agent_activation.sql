-- P2.3: one owner-private Agent may run many Galactic-managed routines.
--
-- `launch_primary` remains a compatibility marker for rows created before
-- this migration. New code writes the explicit launch-managed lifecycle and
-- assigns at most one optional primary role per Agent.

UPDATE public.user_routines AS routines
SET metadata = COALESCE(routines.metadata, '{}'::jsonb) || jsonb_build_object(
      'launch_managed', true,
      'launch_role', 'primary'
    )
WHERE routines.metadata->>'launch_primary' = 'true'
  AND (
    routines.metadata->>'launch_managed' IS DISTINCT FROM 'true'
    OR routines.metadata->>'launch_role' IS DISTINCT FROM 'primary'
  );

DROP INDEX IF EXISTS public.idx_user_routines_one_launch_primary;
DROP INDEX IF EXISTS public.idx_user_routines_one_launch_primary_role;

CREATE UNIQUE INDEX idx_user_routines_one_launch_primary
  ON public.user_routines (user_id, composer_app_id)
  WHERE deleted_at IS NULL
    AND composer_app_id IS NOT NULL
    AND (
      metadata->>'launch_primary' = 'true'
      OR (
        metadata->>'launch_managed' = 'true'
        AND metadata->>'launch_role' = 'primary'
      )
    );

COMMENT ON INDEX public.idx_user_routines_one_launch_primary IS
  'At most one optional compatibility primary per owner Agent; other launch-managed routines are unrestricted.';

-- Keep lifecycle markers out of tenant-editable metadata. This replaces the
-- original merge function with the same signature and result contract.
CREATE OR REPLACE FUNCTION public.merge_routine_user_metadata(
  p_routine_id uuid,
  p_user_id uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS SETOF public.user_routines
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_safe jsonb;
BEGIN
  SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
    INTO v_safe
  FROM jsonb_each(COALESCE(p_metadata, '{}'::jsonb)) AS entry
  WHERE entry.key NOT IN (
      'budget_spend',
      'auto_pause',
      'source',
      'launch_managed',
      'launch_role',
      'launch_primary'
    )
    AND entry.key !~ '^(approval_|approved_)';

  RETURN QUERY
  UPDATE public.user_routines AS routines
  SET metadata = COALESCE(routines.metadata, '{}'::jsonb) || v_safe,
      updated_at = now()
  WHERE routines.id = p_routine_id
    AND routines.user_id = p_user_id
    AND routines.deleted_at IS NULL
  RETURNING routines.*;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_routine_user_metadata(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_routine_user_metadata(uuid, uuid, jsonb)
  TO service_role;

-- Repair Free entitlement projection by Agent, not by routine. Preserve a
-- currently selected Agent while it has an active managed routine; otherwise
-- select the most recently active Agent. Every sibling on that Agent remains
-- active and only routines belonging to other Agents are paused.
WITH managed_app_activity AS (
  SELECT
    routines.user_id,
    routines.composer_app_id,
    max(routines.last_run_at) AS last_run_at,
    max(routines.updated_at) AS updated_at
  FROM public.user_routines AS routines
  WHERE routines.deleted_at IS NULL
    AND routines.status = 'active'
    AND routines.composer_app_id IS NOT NULL
    AND (
      routines.metadata->>'launch_managed' = 'true'
      OR routines.metadata->>'launch_primary' = 'true'
    )
  GROUP BY routines.user_id, routines.composer_app_id
), ranked_apps AS (
  SELECT
    activity.*,
    row_number() OVER (
      PARTITION BY activity.user_id
      ORDER BY activity.last_run_at DESC NULLS LAST,
        activity.updated_at DESC,
        activity.composer_app_id DESC
    ) AS position
  FROM managed_app_activity AS activity
), resolved_free_agent AS (
  SELECT
    entitlements.user_id,
    CASE
      WHEN current_activity.composer_app_id IS NOT NULL
        THEN entitlements.free_agent_id
      ELSE fallback.composer_app_id
    END AS composer_app_id
  FROM public.account_entitlements AS entitlements
  LEFT JOIN managed_app_activity AS current_activity
    ON current_activity.user_id = entitlements.user_id
   AND current_activity.composer_app_id = entitlements.free_agent_id
  LEFT JOIN ranked_apps AS fallback
    ON fallback.user_id = entitlements.user_id
   AND fallback.position = 1
  WHERE entitlements.plan_code = 'free'
)
UPDATE public.account_entitlements AS entitlements
SET free_agent_id = resolved.composer_app_id,
    updated_at = now()
FROM resolved_free_agent AS resolved
WHERE entitlements.user_id = resolved.user_id
  AND entitlements.free_agent_id IS DISTINCT FROM resolved.composer_app_id;

UPDATE public.user_routines AS routines
SET status = 'paused',
    next_run_at = NULL,
    updated_at = now(),
    metadata = COALESCE(routines.metadata, '{}'::jsonb) || jsonb_build_object(
      'auto_pause', jsonb_build_object(
        'code', 'free_active_agent_limit',
        'message', 'Paused when multi-routine activation normalized the one active Agent Free plan.',
        'at', now()
      )
    )
FROM public.account_entitlements AS entitlements
WHERE entitlements.user_id = routines.user_id
  AND entitlements.plan_code = 'free'
  AND routines.deleted_at IS NULL
  AND routines.status = 'active'
  AND routines.composer_app_id IS NOT NULL
  AND (
    routines.metadata->>'launch_managed' = 'true'
    OR routines.metadata->>'launch_primary' = 'true'
  )
  AND routines.composer_app_id IS DISTINCT FROM entitlements.free_agent_id;

-- Claiming the Free Agent slot and activating a routine must be one database
-- transaction. The former claim-then-HTTP-PATCH sequence left a window where
-- a sibling pause could clear the slot and a different Agent could claim it
-- before the original routine became active.
CREATE OR REPLACE FUNCTION public.activate_managed_routine_with_slot(
  p_user_id uuid,
  p_routine_id uuid,
  p_budget_policy jsonb
)
RETURNS TABLE (
  allowed boolean,
  code text,
  active_agent_limit integer,
  occupied_by uuid,
  routine_record jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_routine public.user_routines;
  v_entitlement public.account_entitlements;
  v_app_id uuid;
  v_limit integer;
BEGIN
  -- Read the immutable ownership key before taking the account lock, then
  -- re-read the full routine under lock before applying lifecycle state.
  SELECT routines.composer_app_id
    INTO v_app_id
  FROM public.user_routines AS routines
  WHERE routines.id = p_routine_id
    AND routines.user_id = p_user_id
    AND routines.deleted_at IS NULL
    AND routines.composer_app_id IS NOT NULL
    AND (
      routines.metadata->>'launch_managed' = 'true'
      OR routines.metadata->>'launch_primary' = 'true'
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'managed_routine_not_found';
  END IF;

  v_entitlement := public.ensure_account_entitlement(p_user_id);
  SELECT entitlements.*
    INTO v_entitlement
  FROM public.account_entitlements AS entitlements
  WHERE entitlements.user_id = p_user_id
  FOR UPDATE;

  -- Agent Home configuration CAS locks the Agent before its routines. Match
  -- that order here (entitlement -> Agent -> routine) so an activation cannot
  -- hold the routine row and then deadlock in the revision-bump trigger while
  -- a concurrent settings mutation holds the Agent row. This also makes the
  -- SECURITY DEFINER boundary independently enforce the owner-private launch
  -- contract instead of trusting the caller's routine lookup.
  PERFORM 1
  FROM public.apps AS apps
  WHERE apps.id = v_app_id
    AND apps.owner_id = p_user_id
    AND apps.visibility = 'private'
    AND apps.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'managed_routine_not_found';
  END IF;

  SELECT plans.active_agent_limit
    INTO v_limit
  FROM public.billing_plans AS plans
  WHERE plans.code = v_entitlement.plan_code;

  SELECT routines.*
    INTO v_routine
  FROM public.user_routines AS routines
  WHERE routines.id = p_routine_id
    AND routines.user_id = p_user_id
    AND routines.deleted_at IS NULL
    AND routines.composer_app_id = v_app_id
    AND (
      routines.metadata->>'launch_managed' = 'true'
      OR routines.metadata->>'launch_primary' = 'true'
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'managed_routine_not_found';
  END IF;

  IF v_routine.status NOT IN ('paused', 'error', 'active') THEN
    RETURN QUERY SELECT
      false,
      'routine_not_activatable'::text,
      v_limit,
      v_entitlement.free_agent_id,
      to_jsonb(v_routine);
    RETURN;
  END IF;

  IF v_routine.max_concurrency <> 1 THEN
    RETURN QUERY SELECT
      false,
      'invalid_max_concurrency'::text,
      v_limit,
      v_entitlement.free_agent_id,
      to_jsonb(v_routine);
    RETURN;
  END IF;

  IF v_limit IS NOT NULL
    AND v_entitlement.free_agent_id IS NOT NULL
    AND v_entitlement.free_agent_id IS DISTINCT FROM v_app_id THEN
    RETURN QUERY SELECT
      false,
      'active_agent_limit'::text,
      v_limit,
      v_entitlement.free_agent_id,
      to_jsonb(v_routine);
    RETURN;
  END IF;

  IF v_limit IS NOT NULL THEN
    UPDATE public.account_entitlements AS entitlements
    SET free_agent_id = v_app_id,
        updated_at = now()
    WHERE entitlements.user_id = p_user_id;
  END IF;

  IF v_routine.status IN ('paused', 'error') THEN
    UPDATE public.user_routines AS routines
    SET status = 'active',
        budget_policy = p_budget_policy,
        updated_at = now()
    WHERE routines.id = p_routine_id
      AND routines.user_id = p_user_id
      AND routines.deleted_at IS NULL
    RETURNING routines.* INTO v_routine;
  END IF;

  RETURN QUERY SELECT
    true,
    'ok'::text,
    v_limit,
    CASE WHEN v_limit IS NULL THEN NULL::uuid ELSE v_app_id END,
    to_jsonb(v_routine);
END;
$$;

-- Release only after the last active managed sibling has stopped. The
-- entitlement lock serializes this decision with atomic routine activation.
CREATE OR REPLACE FUNCTION public.release_agent_activation_slot(
  p_user_id uuid,
  p_app_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_selected_app_id uuid;
BEGIN
  SELECT entitlements.free_agent_id
    INTO v_selected_app_id
  FROM public.account_entitlements AS entitlements
  WHERE entitlements.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND OR v_selected_app_id IS DISTINCT FROM p_app_id THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_routines AS routines
    WHERE routines.user_id = p_user_id
      AND routines.composer_app_id = p_app_id
      AND routines.deleted_at IS NULL
      AND routines.status = 'active'
      AND (
        routines.metadata->>'launch_managed' = 'true'
        OR routines.metadata->>'launch_primary' = 'true'
      )
  ) THEN
    RETURN false;
  END IF;

  UPDATE public.account_entitlements AS entitlements
  SET free_agent_id = NULL,
      updated_at = now()
  WHERE entitlements.user_id = p_user_id
    AND entitlements.free_agent_id = p_app_id;
  RETURN FOUND;
END;
$$;

-- Stripe downgrade projection must choose an Agent once and then preserve all
-- of that Agent's active managed routines. The remainder of the subscription
-- projection contract is intentionally unchanged.
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

  -- Serialize the downgrade candidate snapshot with every Agent activation
  -- and slot release. Without this lock, a routine could pause after being
  -- selected but before free_agent_id was projected, leaving Free pointed at
  -- an inactive Agent and blocking the next legitimate activation.
  PERFORM public.ensure_account_entitlement(p_user_id);
  PERFORM 1
  FROM public.account_entitlements AS entitlements
  WHERE entitlements.user_id = p_user_id
  FOR UPDATE;

  IF v_effective_plan = 'free' THEN
    SELECT grouped.composer_app_id
      INTO v_free_agent_id
    FROM (
      SELECT
        routines.composer_app_id,
        max(routines.last_run_at) AS last_run_at,
        max(routines.updated_at) AS updated_at
      FROM public.user_routines AS routines
      WHERE routines.user_id = p_user_id
        AND routines.deleted_at IS NULL
        AND routines.status = 'active'
        AND routines.composer_app_id IS NOT NULL
        AND (
          routines.metadata->>'launch_managed' = 'true'
          OR routines.metadata->>'launch_primary' = 'true'
        )
      GROUP BY routines.composer_app_id
    ) AS grouped
    ORDER BY grouped.last_run_at DESC NULLS LAST,
      grouped.updated_at DESC,
      grouped.composer_app_id DESC
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
      WHEN EXCLUDED.plan_code = 'free' THEN EXCLUDED.free_agent_id
      ELSE NULL
    END,
    subscription_status = EXCLUDED.subscription_status,
    subscription_period_end = EXCLUDED.subscription_period_end,
    updated_at = now();

  IF v_effective_plan = 'free' THEN
    -- Routine configuration updates lock Agent -> routine, and the routine
    -- revision trigger also writes the Agent. Lock every affected owned Agent
    -- first, in a deterministic order, before the bulk downgrade pause takes
    -- any routine locks. The entitlement row is already locked above.
    PERFORM apps.id
    FROM public.apps AS apps
    WHERE apps.owner_id = p_user_id
      AND apps.deleted_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM public.user_routines AS routines
        WHERE routines.user_id = p_user_id
          AND routines.composer_app_id = apps.id
          AND routines.deleted_at IS NULL
          AND routines.status = 'active'
          AND (
            routines.metadata->>'launch_managed' = 'true'
            OR routines.metadata->>'launch_primary' = 'true'
          )
          AND (
            v_free_agent_id IS NULL
            OR routines.composer_app_id IS DISTINCT FROM v_free_agent_id
          )
      )
    ORDER BY apps.id
    FOR UPDATE;

    UPDATE public.user_routines AS routines
    SET status = 'paused',
        next_run_at = NULL,
        updated_at = now(),
        metadata = COALESCE(routines.metadata, '{}'::jsonb) ||
          jsonb_build_object(
            'auto_pause', jsonb_build_object(
              'code', 'free_active_agent_limit',
              'message', 'Paused when the account returned to its one active Agent Free plan.',
              'at', now()
            )
          )
    WHERE routines.user_id = p_user_id
      AND routines.deleted_at IS NULL
      AND routines.status = 'active'
      AND (
        routines.metadata->>'launch_managed' = 'true'
        OR routines.metadata->>'launch_primary' = 'true'
      )
      AND (
        v_free_agent_id IS NULL
        OR routines.composer_app_id IS DISTINCT FROM v_free_agent_id
      );
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.release_agent_activation_slot(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.activate_managed_routine_with_slot(
  uuid, uuid, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_account_subscription(
  uuid, text, text, text, text, text, timestamp with time zone,
  timestamp with time zone, boolean, timestamp with time zone,
  timestamp with time zone, text, timestamp with time zone, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.release_agent_activation_slot(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_managed_routine_with_slot(
  uuid, uuid, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_account_subscription(
  uuid, text, text, text, text, text, timestamp with time zone,
  timestamp with time zone, boolean, timestamp with time zone,
  timestamp with time zone, text, timestamp with time zone, jsonb
) TO service_role;
