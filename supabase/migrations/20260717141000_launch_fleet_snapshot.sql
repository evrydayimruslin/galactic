-- One bounded, owner-only projection for the compact Fleet surface.
-- The API authenticates the account session and supplies p_user_id; only the
-- service role may execute this function. Heavy Agent Home integrity/settings
-- reads deliberately do not belong on every fleet card.

CREATE OR REPLACE FUNCTION public.get_launch_fleet_snapshot(
  p_user_id uuid
)
RETURNS TABLE (
  agent_id uuid,
  routine_count bigint,
  active_routine_count bigint,
  state text,
  health text,
  next_wake_at timestamp with time zone,
  last_run_at timestamp with time zone,
  deferred_wake_count bigint,
  unread_alert_count bigint,
  recent_activity jsonb,
  capacity_state text,
  capacity_burst_state text,
  capacity_weekly_state text,
  capacity_burst_resets_at timestamp with time zone,
  capacity_weekly_resets_at timestamp with time zone,
  capacity_next_eligible_at timestamp with time zone,
  capacity_cap_basis_points integer,
  capacity_burst_used_percent double precision,
  capacity_weekly_used_percent double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH owned_agents AS (
  SELECT apps.id, apps.created_at
  FROM public.apps
  WHERE apps.owner_id = p_user_id
    AND apps.visibility = 'private'
    AND apps.deleted_at IS NULL
),
account_context AS (
  SELECT
    plans.code AS plan_code,
    coalesce(
      entitlements.capacity_anchor_at,
      users.created_at,
      now()
    ) AS capacity_anchor_at,
    plans.burst_window_seconds,
    plans.burst_limit_light,
    plans.weekly_window_seconds,
    plans.weekly_limit_light
  FROM public.users AS users
  LEFT JOIN public.account_entitlements AS entitlements
    ON entitlements.user_id = users.id
  JOIN public.billing_plans AS plans
    ON plans.code = coalesce(entitlements.plan_code, 'free')
  WHERE users.id = p_user_id
),
capacity_clock AS (
  SELECT
    account_context.*,
    public.capacity_window_start(
      account_context.capacity_anchor_at,
      account_context.burst_window_seconds,
      now()
    ) AS burst_started_at,
    public.capacity_window_start(
      account_context.capacity_anchor_at,
      account_context.weekly_window_seconds,
      now()
    ) AS weekly_started_at
  FROM account_context
),
active_account_reservations AS (
  SELECT
    capacity_clock.burst_started_at,
    capacity_clock.weekly_started_at,
    coalesce(sum(reservations.reserved_light) FILTER (
      WHERE reservations.burst_window_started_at =
        capacity_clock.burst_started_at
    ), 0) AS burst_reserved,
    coalesce(sum(reservations.reserved_light) FILTER (
      WHERE reservations.weekly_window_started_at =
        capacity_clock.weekly_started_at
    ), 0) AS weekly_reserved
  FROM capacity_clock
  LEFT JOIN public.account_capacity_reservations AS reservations
    ON reservations.user_id = p_user_id
   AND reservations.status = 'reserved'
   AND reservations.expires_at > now()
   AND (
     reservations.burst_window_started_at = capacity_clock.burst_started_at
     OR reservations.weekly_window_started_at = capacity_clock.weekly_started_at
   )
  GROUP BY capacity_clock.burst_started_at,
    capacity_clock.weekly_started_at
),
active_agent_reservations AS (
  SELECT
    reservations.capacity_agent_id AS agent_id,
    coalesce(sum(reservations.reserved_light) FILTER (
      WHERE reservations.burst_window_started_at =
        capacity_clock.burst_started_at
    ), 0) AS burst_reserved,
    coalesce(sum(reservations.reserved_light) FILTER (
      WHERE reservations.weekly_window_started_at =
        capacity_clock.weekly_started_at
    ), 0) AS weekly_reserved
  FROM capacity_clock
  JOIN public.account_capacity_reservations AS reservations
    ON reservations.user_id = p_user_id
   AND reservations.capacity_agent_id IS NOT NULL
   AND reservations.status = 'reserved'
   AND reservations.expires_at > now()
   AND (
     reservations.burst_window_started_at = capacity_clock.burst_started_at
     OR reservations.weekly_window_started_at = capacity_clock.weekly_started_at
   )
  GROUP BY reservations.capacity_agent_id
),
account_capacity AS (
  SELECT
    capacity_clock.*,
    capacity_clock.burst_started_at +
      capacity_clock.burst_window_seconds * interval '1 second'
      AS burst_resets_at,
    capacity_clock.weekly_started_at +
      capacity_clock.weekly_window_seconds * interval '1 second'
      AS weekly_resets_at,
    coalesce(
      burst_window.used_light,
      0
    ) + active_account_reservations.burst_reserved AS account_burst_used,
    coalesce(
      weekly_window.used_light,
      0
    ) + active_account_reservations.weekly_reserved AS account_weekly_used
  FROM capacity_clock
  JOIN active_account_reservations
    ON active_account_reservations.burst_started_at =
      capacity_clock.burst_started_at
   AND active_account_reservations.weekly_started_at =
      capacity_clock.weekly_started_at
  LEFT JOIN public.account_capacity_windows AS burst_window
    ON burst_window.user_id = p_user_id
   AND burst_window.window_kind = 'burst'
   AND burst_window.window_started_at = capacity_clock.burst_started_at
  LEFT JOIN public.account_capacity_windows AS weekly_window
    ON weekly_window.user_id = p_user_id
   AND weekly_window.window_kind = 'weekly'
   AND weekly_window.window_started_at = capacity_clock.weekly_started_at
),
fleet_capacity_metrics AS (
  SELECT
    owned_agents.id AS agent_id,
    account_capacity.*,
    CASE
      WHEN account_capacity.plan_code = 'free' THEN 10000
      ELSE coalesce(policies.cap_basis_points, 10000)
    END AS cap_basis_points,
    coalesce(
      agent_burst.used_light,
      0
    ) + coalesce(agent_reservations.burst_reserved, 0)
      AS agent_burst_used,
    coalesce(
      agent_weekly.used_light,
      0
    ) + coalesce(agent_reservations.weekly_reserved, 0)
      AS agent_weekly_used
  FROM owned_agents
  CROSS JOIN account_capacity
  LEFT JOIN public.agent_capacity_policies AS policies
    ON policies.user_id = p_user_id
   AND policies.capacity_agent_id = owned_agents.id
  LEFT JOIN active_agent_reservations AS agent_reservations
    ON agent_reservations.agent_id = owned_agents.id
  LEFT JOIN public.agent_capacity_windows AS agent_burst
    ON agent_burst.user_id = p_user_id
   AND agent_burst.capacity_agent_id = owned_agents.id
   AND agent_burst.window_kind = 'burst'
   AND agent_burst.window_started_at = account_capacity.burst_started_at
  LEFT JOIN public.agent_capacity_windows AS agent_weekly
    ON agent_weekly.user_id = p_user_id
   AND agent_weekly.capacity_agent_id = owned_agents.id
   AND agent_weekly.window_kind = 'weekly'
   AND agent_weekly.window_started_at = account_capacity.weekly_started_at
),
fleet_capacity_states AS (
  SELECT
    fleet_capacity_metrics.*,
    CASE
      WHEN account_burst_used >= burst_limit_light
        OR agent_burst_used >=
          burst_limit_light * cap_basis_points / 10000.0
        THEN 'waiting'
      WHEN account_burst_used >= burst_limit_light * 0.8
        OR agent_burst_used >=
          burst_limit_light * cap_basis_points / 10000.0 * 0.8
        THEN 'low'
      ELSE 'available'
    END AS burst_state,
    CASE
      WHEN account_weekly_used >= weekly_limit_light
        OR agent_weekly_used >=
          weekly_limit_light * cap_basis_points / 10000.0
        THEN 'waiting'
      WHEN account_weekly_used >= weekly_limit_light * 0.8
        OR agent_weekly_used >=
          weekly_limit_light * cap_basis_points / 10000.0 * 0.8
        THEN 'low'
      ELSE 'available'
    END AS weekly_state
  FROM fleet_capacity_metrics
),
fleet_capacity AS (
  SELECT
    agent_id,
    CASE
      WHEN burst_state = 'waiting' OR weekly_state = 'waiting' THEN 'waiting'
      WHEN burst_state = 'low' OR weekly_state = 'low' THEN 'low'
      ELSE 'available'
    END AS capacity_state,
    burst_state,
    weekly_state,
    burst_resets_at,
    weekly_resets_at,
    CASE
      WHEN burst_state = 'waiting' AND weekly_state = 'waiting'
        THEN greatest(burst_resets_at, weekly_resets_at)
      WHEN burst_state = 'waiting' THEN burst_resets_at
      WHEN weekly_state = 'waiting' THEN weekly_resets_at
      ELSE NULL
    END AS next_eligible_at,
    CASE WHEN plan_code = 'free' THEN NULL ELSE cap_basis_points END
      AS public_cap_basis_points,
    CASE WHEN plan_code = 'free' THEN NULL
      ELSE agent_burst_used * 100.0 / nullif(burst_limit_light, 0) END
      AS burst_used_percent,
    CASE WHEN plan_code = 'free' THEN NULL
      ELSE agent_weekly_used * 100.0 / nullif(weekly_limit_light, 0) END
      AS weekly_used_percent
  FROM fleet_capacity_states
),
managed_routines AS (
  SELECT routines.*
  FROM public.user_routines AS routines
  JOIN owned_agents ON owned_agents.id = routines.composer_app_id
  WHERE routines.user_id = p_user_id
    AND routines.deleted_at IS NULL
    AND (
      routines.metadata->>'launch_managed' = 'true'
      OR routines.metadata->>'launch_primary' = 'true'
    )
),
routine_totals AS (
  SELECT
    owned_agents.id AS agent_id,
    owned_agents.created_at AS agent_created_at,
    count(managed_routines.id)::bigint AS routine_count,
    count(managed_routines.id) FILTER (
      WHERE managed_routines.status = 'active'
    )::bigint AS active_routine_count,
    CASE
      WHEN bool_or(managed_routines.status = 'error') THEN 'error'
      WHEN bool_or(managed_routines.status = 'active') THEN 'active'
      WHEN bool_or(managed_routines.status = 'paused') THEN 'paused'
      WHEN count(managed_routines.id) > 0 THEN 'idle'
      ELSE 'unconfigured'
    END AS state,
    CASE
      WHEN bool_or(managed_routines.status = 'error') THEN 'error'
      WHEN coalesce(sum(deferred.deferred_wake_count), 0) > 0 THEN 'waiting'
      WHEN bool_or(managed_routines.status = 'active') THEN 'healthy'
      WHEN bool_or(managed_routines.status = 'paused') THEN 'paused'
      ELSE 'idle'
    END AS health,
    min(managed_routines.next_run_at) FILTER (
      WHERE managed_routines.status = 'active'
    ) AS next_wake_at,
    max(managed_routines.last_run_at) AS last_run_at,
    coalesce(sum(deferred.deferred_wake_count), 0)::bigint AS deferred_wake_count
  FROM owned_agents
  LEFT JOIN managed_routines
    ON managed_routines.composer_app_id = owned_agents.id
  LEFT JOIN public.deferred_routine_wakes AS deferred
    ON deferred.routine_id = managed_routines.id
  GROUP BY owned_agents.id, owned_agents.created_at
),
alert_totals AS (
  SELECT
    notifications.agent_id,
    count(*) FILTER (WHERE notifications.read_at IS NULL)::bigint AS unread_alert_count
  FROM public.user_notifications AS notifications
  JOIN owned_agents ON owned_agents.id = notifications.agent_id
  WHERE notifications.user_id = p_user_id
  GROUP BY notifications.agent_id
),
run_activity AS (
  SELECT
    owned_agents.id AS agent_id,
    recent.*
  FROM owned_agents
  CROSS JOIN LATERAL (
    SELECT
      runs.id,
      'run'::text AS kind,
      routines.name AS title,
      coalesce(runs.summary, runs.error->>'message') AS summary,
      runs.status,
      runs.routine_id,
      runs.created_at
    FROM public.routine_runs AS runs
    JOIN managed_routines AS routines ON routines.id = runs.routine_id
    WHERE runs.user_id = p_user_id
      AND routines.composer_app_id = owned_agents.id
    ORDER BY runs.created_at DESC, runs.id DESC
    LIMIT 3
  ) AS recent
),
alert_activity AS (
  SELECT
    owned_agents.id AS agent_id,
    recent.*
  FROM owned_agents
  CROSS JOIN LATERAL (
    SELECT
      notifications.id,
      'alert'::text AS kind,
      notifications.title,
      notifications.body AS summary,
      notifications.severity AS status,
      CASE
        WHEN notifications.entity_type = 'routine'
          AND notifications.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN notifications.entity_id::uuid
        ELSE NULL
      END AS routine_id,
      notifications.created_at
    FROM public.user_notifications AS notifications
    WHERE notifications.user_id = p_user_id
      AND notifications.agent_id = owned_agents.id
    ORDER BY notifications.created_at DESC, notifications.id DESC
    LIMIT 3
  ) AS recent
),
activity_candidates AS (
  SELECT * FROM run_activity
  UNION ALL
  SELECT * FROM alert_activity
),
ranked_activity AS (
  SELECT
    activity_candidates.*,
    row_number() OVER (
      PARTITION BY activity_candidates.agent_id
      ORDER BY activity_candidates.created_at DESC, activity_candidates.id DESC
    ) AS position
  FROM activity_candidates
),
activity AS (
  SELECT
    ranked_activity.agent_id,
    jsonb_agg(
      jsonb_build_object(
        'id', ranked_activity.id,
        'kind', ranked_activity.kind,
        'title', ranked_activity.title,
        'summary', ranked_activity.summary,
        'status', ranked_activity.status,
        'routineId', ranked_activity.routine_id,
        'createdAt', ranked_activity.created_at
      )
      ORDER BY ranked_activity.created_at DESC, ranked_activity.id DESC
    ) AS recent_activity
  FROM ranked_activity
  WHERE ranked_activity.position <= 3
  GROUP BY ranked_activity.agent_id
)
SELECT
  routine_totals.agent_id,
  routine_totals.routine_count,
  routine_totals.active_routine_count,
  routine_totals.state,
  routine_totals.health,
  routine_totals.next_wake_at,
  routine_totals.last_run_at,
  routine_totals.deferred_wake_count,
  coalesce(alert_totals.unread_alert_count, 0)::bigint,
  coalesce(activity.recent_activity, '[]'::jsonb),
  fleet_capacity.capacity_state,
  fleet_capacity.burst_state,
  fleet_capacity.weekly_state,
  fleet_capacity.burst_resets_at,
  fleet_capacity.weekly_resets_at,
  fleet_capacity.next_eligible_at,
  fleet_capacity.public_cap_basis_points,
  fleet_capacity.burst_used_percent,
  fleet_capacity.weekly_used_percent
FROM routine_totals
LEFT JOIN alert_totals ON alert_totals.agent_id = routine_totals.agent_id
LEFT JOIN activity ON activity.agent_id = routine_totals.agent_id
LEFT JOIN fleet_capacity ON fleet_capacity.agent_id = routine_totals.agent_id
ORDER BY routine_totals.agent_created_at, routine_totals.agent_id;
$$;

REVOKE ALL ON FUNCTION public.get_launch_fleet_snapshot(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_launch_fleet_snapshot(uuid)
  TO service_role;
