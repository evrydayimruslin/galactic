-- Operator-grade Agent Home: additive Fleet v2 and unified activity SQL.
--
-- The one-argument get_launch_fleet_snapshot(uuid) remains byte-for-byte
-- compatible. The API opts into appended operator fields by calling the
-- overload with p_include_operator_fields=true. This avoids a DROP/CREATE
-- return-type break while old and new Workers overlap during rollout.

CREATE OR REPLACE FUNCTION public.get_launch_fleet_snapshot(
  p_user_id uuid,
  p_include_operator_fields boolean
)
RETURNS TABLE (
  agent_id uuid,
  routine_count bigint,
  active_routine_count bigint,
  state text,
  health text,
  next_wake_at timestamptz,
  last_run_at timestamptz,
  deferred_wake_count bigint,
  unread_alert_count bigint,
  recent_activity jsonb,
  capacity_state text,
  capacity_burst_state text,
  capacity_weekly_state text,
  capacity_burst_resets_at timestamptz,
  capacity_weekly_resets_at timestamptz,
  capacity_next_eligible_at timestamptz,
  capacity_cap_basis_points integer,
  capacity_burst_used_percent double precision,
  capacity_weekly_used_percent double precision,
  working_ready boolean,
  working_exclusion_reason text,
  attention_count bigint,
  fleet_position integer,
  operating_summary jsonb,
  working_agent_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH base AS (
  SELECT *
  FROM public.get_launch_fleet_snapshot(p_user_id)
),
owned_agents AS (
  SELECT
    apps.id,
    apps.slug,
    apps.created_at,
    apps.current_version,
    apps.versions,
    apps.storage_key,
    apps.hosting_suspended,
    coalesce(apps.env_schema, '{}'::jsonb) AS env_schema,
    coalesce(apps.env_vars, '{}'::jsonb) AS env_vars,
    public.try_parse_agent_home_jsonb(apps.manifest) AS parsed_manifest,
    coalesce(apps.declared_permissions, '[]'::jsonb) AS declared_permissions
  FROM public.apps AS apps
  WHERE apps.owner_id = p_user_id
    AND apps.visibility = 'private'
    AND apps.deleted_at IS NULL
),
agent_schema AS (
  SELECT
    agents.*,
    CASE
      WHEN jsonb_typeof(agents.env_schema) = 'object'
        AND agents.env_schema <> '{}'::jsonb
        THEN agents.env_schema
      WHEN jsonb_typeof(agents.parsed_manifest) = 'object'
        THEN
          CASE
            WHEN jsonb_typeof(agents.parsed_manifest->'env') = 'object'
              THEN agents.parsed_manifest->'env'
              ELSE '{}'::jsonb
          END
          ||
          CASE
            WHEN jsonb_typeof(agents.parsed_manifest->'env_vars') = 'object'
              THEN agents.parsed_manifest->'env_vars'
              ELSE '{}'::jsonb
          END
      ELSE '{}'::jsonb
    END AS effective_env_schema
  FROM owned_agents AS agents
),
required_setting_totals AS (
  SELECT
    agents.id AS agent_id,
    count(*) FILTER (
      WHERE lower(coalesce(settings.value->>'required', 'false')) = 'true'
    )::bigint AS required_count,
    count(*) FILTER (
      WHERE lower(coalesce(settings.value->>'required', 'false')) = 'true'
        AND (
          CASE
            WHEN coalesce(
              settings.value->>'scope',
              settings.value->>'type',
              'universal'
            ) = 'per_user'
              THEN EXISTS (
                SELECT 1
                FROM public.user_app_secrets AS secrets
                WHERE secrets.user_id = p_user_id
                  AND secrets.app_id = agents.id
                  AND secrets.key = settings.key
              )
            ELSE
              jsonb_typeof(agents.env_vars) = 'object'
              AND agents.env_vars ? settings.key
          END
        )
    )::bigint AS configured_required_count
  FROM agent_schema AS agents
  LEFT JOIN LATERAL jsonb_each(
    CASE
      WHEN jsonb_typeof(agents.effective_env_schema) = 'object'
        THEN agents.effective_env_schema
      ELSE '{}'::jsonb
    END
  ) AS settings(key, value) ON true
  GROUP BY agents.id
),
permission_values AS (
  SELECT agents.id AS agent_id, permissions.value #>> '{}' AS permission
  FROM agent_schema AS agents
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(agents.declared_permissions) = 'array'
        THEN agents.declared_permissions
      ELSE '[]'::jsonb
    END
  ) AS permissions(value)
  UNION
  SELECT agents.id AS agent_id, permissions.value #>> '{}' AS permission
  FROM agent_schema AS agents
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(agents.parsed_manifest->'permissions') = 'array'
        THEN agents.parsed_manifest->'permissions'
      ELSE '[]'::jsonb
    END
  ) AS permissions(value)
),
permission_totals AS (
  SELECT
    agents.id AS agent_id,
    coalesce(bool_or(
      permission_values.permission IN ('ai:call', 'ai:embed')
    ), false) AS requires_byok,
    coalesce(bool_or(
      permission_values.permission = 'notify:owner'
    ), false) AS reporting_configured
  FROM agent_schema AS agents
  LEFT JOIN permission_values
    ON permission_values.agent_id = agents.id
  GROUP BY agents.id
),
managed_routines AS (
  SELECT routines.*
  FROM public.user_routines AS routines
  JOIN owned_agents AS agents ON agents.id = routines.composer_app_id
  WHERE routines.user_id = p_user_id
    AND routines.deleted_at IS NULL
    AND (
      routines.metadata->>'launch_managed' = 'true'
      OR routines.metadata->>'launch_primary' = 'true'
    )
),
routine_setup AS (
  SELECT
    agents.id AS agent_id,
    count(DISTINCT routines.id)::bigint AS managed_count,
    count(DISTINCT routines.id) FILTER (
      WHERE routines.status = 'active'
    )::bigint AS executable_count,
    count(DISTINCT routines.id) FILTER (
      WHERE routines.status = 'error'
    )::bigint AS error_count,
    count(DISTINCT routines.id) FILTER (
      WHERE routines.status = 'paused'
    )::bigint AS paused_count,
    count(capabilities.id) FILTER (
      WHERE capabilities.required AND NOT capabilities.approved
    )::bigint AS unapproved_required_capability_count
  FROM owned_agents AS agents
  LEFT JOIN managed_routines AS routines
    ON routines.composer_app_id = agents.id
  LEFT JOIN public.routine_capabilities AS capabilities
    ON capabilities.routine_id = routines.id
   AND capabilities.user_id = p_user_id
  GROUP BY agents.id
),
routine_grant_setup AS (
  SELECT
    agents.id AS agent_id,
    count(capabilities.id) FILTER (
      WHERE capabilities.required
        AND capabilities.approved
        AND NOT EXISTS (
          SELECT 1
          FROM public.agent_function_grants AS grants
          JOIN public.apps AS targets ON targets.id = grants.target_app_id
          WHERE grants.user_id = p_user_id
            AND grants.caller_app_id = agents.id
            AND grants.caller_function = ''
            AND grants.mode = 'call'
            AND grants.status = 'active'
            AND grants.target_function = capabilities.function_name
            AND (
              grants.monthly_cap_credits IS NULL
              OR date_trunc('month', grants.period_start AT TIME ZONE 'UTC')
                 < date_trunc('month', now() AT TIME ZONE 'UTC')
              OR grants.spent_credits_period < grants.monthly_cap_credits
            )
            AND (
              targets.id = capabilities.app_id
              OR (
                capabilities.app_id IS NULL
                AND (
                  targets.id::text = capabilities.app_ref
                  OR targets.slug = capabilities.app_ref
                )
              )
            )
        )
    )::bigint AS missing_required_grant_count
  FROM owned_agents AS agents
  LEFT JOIN managed_routines AS routines
    ON routines.composer_app_id = agents.id
  LEFT JOIN public.routine_capabilities AS capabilities
    ON capabilities.routine_id = routines.id
   AND capabilities.user_id = p_user_id
  GROUP BY agents.id
),
current_routine_runs AS (
  SELECT agents.id AS agent_id, current_run.*
  FROM owned_agents AS agents
  LEFT JOIN LATERAL (
    SELECT
      runs.id AS run_id,
      routines.id AS routine_id,
      routines.name AS routine_name,
      runs.status,
      coalesce(runs.started_at, runs.created_at) AS observed_at
    FROM public.routine_runs AS runs
    JOIN managed_routines AS routines ON routines.id = runs.routine_id
    WHERE runs.user_id = p_user_id
      AND routines.composer_app_id = agents.id
      AND runs.status IN ('queued', 'running')
    ORDER BY
      CASE WHEN runs.status = 'running' THEN 0 ELSE 1 END,
      coalesce(runs.started_at, runs.created_at) DESC,
      runs.id DESC
    LIMIT 1
  ) AS current_run ON true
),
next_routines AS (
  SELECT agents.id AS agent_id, next_routine.*
  FROM owned_agents AS agents
  LEFT JOIN LATERAL (
    SELECT
      routines.id AS routine_id,
      routines.name AS routine_name,
      routines.next_run_at
    FROM managed_routines AS routines
    WHERE routines.composer_app_id = agents.id
      AND routines.status = 'active'
      AND routines.next_run_at IS NOT NULL
    ORDER BY routines.next_run_at, routines.id
    LIMIT 1
  ) AS next_routine ON true
),
event_subscriptions AS (
  SELECT
    agents.id AS agent_id,
    bool_or(grants.id IS NOT NULL) AS has_active_subscription
  FROM owned_agents AS agents
  LEFT JOIN public.agent_function_grants AS grants
    ON grants.user_id = p_user_id
   AND grants.target_app_id = agents.id
   AND grants.mode = 'subscribe'
   AND grants.status = 'active'
  GROUP BY agents.id
),
attention_totals AS (
  SELECT
    agents.id AS agent_id,
    count(notifications.id) FILTER (
      WHERE (
        notifications.item_class = 'incident'
        AND (
          notifications.lifecycle_state = 'open'
          OR (
            notifications.lifecycle_state = 'snoozed'
            AND notifications.snoozed_until <= now()
          )
        )
      )
      OR (
        notifications.item_class = 'report'
        AND notifications.lifecycle_state = 'open'
        AND notifications.read_at IS NULL
      )
    )::bigint AS attention_count
  FROM owned_agents AS agents
  LEFT JOIN public.user_notifications AS notifications
    ON notifications.user_id = p_user_id
   AND notifications.agent_id = agents.id
  GROUP BY agents.id
),
readiness_inputs AS (
  SELECT
    base.*,
    agents.slug,
    agents.created_at AS agent_created_at,
    (
      agents.current_version IS NOT NULL
      AND nullif(btrim(agents.current_version), '') IS NOT NULL
      AND agents.current_version = ANY(coalesce(agents.versions, ARRAY[]::text[]))
      AND nullif(btrim(agents.storage_key), '') IS NOT NULL
      AND coalesce(agents.hosting_suspended, false) = false
    ) AS has_live_release,
    coalesce(settings.required_count, 0) AS required_setting_count,
    coalesce(settings.configured_required_count, 0)
      AS configured_required_setting_count,
    coalesce(permissions.requires_byok, false) AS requires_byok,
    (
      coalesce(users.byok_enabled, false)
      AND jsonb_typeof(coalesce(users.byok_keys, '{}'::jsonb)) = 'object'
      AND coalesce(users.byok_keys, '{}'::jsonb) <> '{}'::jsonb
    ) AS byok_configured,
    coalesce(permissions.reporting_configured, false) AS reporting_configured,
    coalesce(routines.managed_count, 0) AS managed_count,
    coalesce(routines.executable_count, 0) AS executable_count,
    coalesce(routines.error_count, 0) AS error_count,
    coalesce(routines.paused_count, 0) AS paused_count,
    coalesce(routines.unapproved_required_capability_count, 0)
      AS unapproved_required_capability_count,
    coalesce(grant_setup.missing_required_grant_count, 0)
      AS missing_required_grant_count,
    current_runs.run_id AS current_run_id,
    current_runs.routine_id AS current_routine_id,
    current_runs.routine_name AS current_routine_name,
    current_runs.status AS current_run_status,
    current_runs.observed_at AS current_run_observed_at,
    next_routines.routine_id AS next_routine_id,
    next_routines.routine_name AS next_routine_name,
    next_routines.next_run_at AS next_routine_at,
    coalesce(subscriptions.has_active_subscription, false)
      AS has_active_subscription,
    coalesce(attention.attention_count, 0)::bigint AS operator_attention_count,
    preferences.fleet_position AS stored_fleet_position
  FROM base
  JOIN agent_schema AS agents ON agents.id = base.agent_id
  LEFT JOIN public.users AS users ON users.id = p_user_id
  LEFT JOIN required_setting_totals AS settings
    ON settings.agent_id = agents.id
  LEFT JOIN permission_totals AS permissions
    ON permissions.agent_id = agents.id
  LEFT JOIN routine_setup AS routines ON routines.agent_id = agents.id
  LEFT JOIN routine_grant_setup AS grant_setup
    ON grant_setup.agent_id = agents.id
  LEFT JOIN current_routine_runs AS current_runs
    ON current_runs.agent_id = agents.id
  LEFT JOIN next_routines ON next_routines.agent_id = agents.id
  LEFT JOIN event_subscriptions AS subscriptions
    ON subscriptions.agent_id = agents.id
  LEFT JOIN attention_totals AS attention ON attention.agent_id = agents.id
  LEFT JOIN public.user_agent_preferences AS preferences
    ON preferences.user_id = p_user_id
   AND preferences.agent_id = agents.id
),
readiness AS (
  SELECT
    inputs.*,
    CASE
      WHEN NOT inputs.has_live_release THEN 'no_live_release'
      WHEN inputs.managed_count = 0 THEN 'no_enabled_routine'
      WHEN inputs.required_setting_count >
           inputs.configured_required_setting_count THEN 'setup_required'
      WHEN NOT inputs.reporting_configured THEN 'setup_required'
      WHEN inputs.requires_byok AND NOT inputs.byok_configured
        THEN 'setup_required'
      WHEN inputs.unapproved_required_capability_count > 0
        THEN 'setup_required'
      WHEN inputs.missing_required_grant_count > 0
        THEN 'setup_required'
      WHEN inputs.error_count > 0 THEN 'error'
      WHEN inputs.executable_count = 0 AND inputs.paused_count > 0
        THEN 'paused'
      WHEN inputs.executable_count = 0 THEN 'disabled'
      ELSE NULL
    END AS exclusion_reason
  FROM readiness_inputs AS inputs
),
positioned AS (
  SELECT
    readiness.*,
    row_number() OVER (
      ORDER BY
        readiness.stored_fleet_position NULLS LAST,
        readiness.agent_created_at,
        readiness.agent_id
    )::integer - 1 AS effective_fleet_position
  FROM readiness
),
projected AS (
  SELECT
    positioned.*,
    positioned.exclusion_reason IS NULL AS is_working_ready,
    jsonb_strip_nulls(jsonb_build_object(
      'mode', CASE
        WHEN positioned.exclusion_reason IS NOT NULL
          THEN positioned.exclusion_reason
        WHEN positioned.current_run_status = 'running' THEN 'running'
        WHEN positioned.current_run_status = 'queued' THEN 'queued'
        WHEN positioned.capacity_state = 'waiting'
          OR positioned.deferred_wake_count > 0 THEN 'capacity_waiting'
        WHEN positioned.next_routine_at IS NOT NULL THEN 'scheduled'
        WHEN positioned.has_active_subscription THEN 'event_waiting'
        ELSE 'standing_by'
      END,
      'label', CASE
        WHEN positioned.exclusion_reason = 'no_live_release'
          THEN 'Release required'
        WHEN positioned.exclusion_reason IN (
          'no_enabled_routine', 'setup_required'
        ) THEN 'Setup required'
        WHEN positioned.exclusion_reason = 'error' THEN 'Needs attention'
        WHEN positioned.exclusion_reason = 'paused' THEN 'Paused'
        WHEN positioned.exclusion_reason = 'disabled' THEN 'Disabled'
        WHEN positioned.current_run_status = 'running'
          THEN positioned.current_routine_name || ' running'
        WHEN positioned.current_run_status = 'queued'
          THEN positioned.current_routine_name || ' queued'
        WHEN positioned.capacity_state = 'waiting'
          OR positioned.deferred_wake_count > 0 THEN 'Waiting for capacity'
        WHEN positioned.next_routine_at IS NOT NULL
          THEN 'Next: ' || positioned.next_routine_name
        WHEN positioned.has_active_subscription THEN 'Waiting for an event'
        ELSE 'Standing by'
      END,
      'basis', CASE
        WHEN positioned.exclusion_reason IS NOT NULL THEN 'readiness'
        WHEN positioned.current_run_id IS NOT NULL THEN 'routine_run'
        WHEN positioned.capacity_state = 'waiting'
          OR positioned.deferred_wake_count > 0 THEN 'capacity'
        WHEN positioned.next_routine_at IS NOT NULL THEN 'next_wake'
        WHEN positioned.has_active_subscription THEN 'subscription'
        ELSE 'routine'
      END,
      'routineId', coalesce(
        positioned.current_routine_id,
        positioned.next_routine_id
      ),
      'routineName', coalesce(
        positioned.current_routine_name,
        positioned.next_routine_name
      ),
      'runId', positioned.current_run_id,
      'nextEventAt', coalesce(
        positioned.next_routine_at,
        positioned.capacity_next_eligible_at
      ),
      'lastObservedAt', coalesce(
        positioned.current_run_observed_at,
        positioned.last_run_at
      )
    )) AS operator_summary
  FROM positioned
)
SELECT
  projected.agent_id,
  projected.routine_count,
  projected.active_routine_count,
  projected.state,
  projected.health,
  projected.next_wake_at,
  projected.last_run_at,
  projected.deferred_wake_count,
  projected.unread_alert_count,
  projected.recent_activity,
  projected.capacity_state,
  projected.capacity_burst_state,
  projected.capacity_weekly_state,
  projected.capacity_burst_resets_at,
  projected.capacity_weekly_resets_at,
  projected.capacity_next_eligible_at,
  projected.capacity_cap_basis_points,
  projected.capacity_burst_used_percent,
  projected.capacity_weekly_used_percent,
  CASE WHEN p_include_operator_fields
    THEN projected.is_working_ready ELSE NULL END,
  CASE WHEN p_include_operator_fields
    THEN projected.exclusion_reason ELSE NULL END,
  CASE WHEN p_include_operator_fields
    THEN projected.operator_attention_count ELSE NULL END,
  CASE WHEN p_include_operator_fields
    THEN projected.effective_fleet_position ELSE NULL END,
  CASE WHEN p_include_operator_fields
    THEN projected.operator_summary ELSE NULL END,
  CASE WHEN p_include_operator_fields THEN
    count(*) FILTER (WHERE projected.is_working_ready) OVER ()
    ELSE NULL
  END::bigint
FROM projected
ORDER BY
  projected.effective_fleet_position,
  projected.agent_created_at,
  projected.agent_id;
$$;

CREATE OR REPLACE FUNCTION public.get_launch_working_agent_count(
  p_user_id uuid
) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::bigint
  FROM public.get_launch_fleet_snapshot(p_user_id, true) AS fleet
  WHERE fleet.working_ready;
$$;

-- One owner-scoped activity stream. The first page may include bounded future
-- and in-progress truth; cursor pages contain recent history only. Compute
-- output/arguments and secret-bearing payloads are deliberately excluded.
CREATE OR REPLACE FUNCTION public.get_launch_agent_activity(
  p_user_id uuid,
  p_agent_id uuid,
  p_recent_limit integer DEFAULT 3,
  p_cursor_at timestamptz DEFAULT NULL,
  p_cursor_key text DEFAULT NULL,
  p_include_upcoming boolean DEFAULT true
) RETURNS TABLE (
  item_key text,
  phase text,
  kind text,
  title text,
  summary text,
  status text,
  event_at timestamptz,
  routine_id uuid,
  source_id uuid,
  detail_url text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slug text;
BEGIN
  IF p_recent_limit NOT BETWEEN 1 AND 100
     OR ((p_cursor_at IS NULL) <> (p_cursor_key IS NULL))
     OR (
       p_cursor_key IS NOT NULL
       AND (
         char_length(p_cursor_key) NOT BETWEEN 1 AND 240
         OR p_cursor_key ~ '[[:cntrl:]]'
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_agent_activity_query';
  END IF;

  SELECT apps.slug INTO v_slug
  FROM public.apps AS apps
  WHERE apps.id = p_agent_id
    AND apps.owner_id = p_user_id
    AND apps.visibility = 'private'
    AND apps.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_not_found';
  END IF;

  RETURN QUERY
  WITH managed_routines AS (
    SELECT routines.*
    FROM public.user_routines AS routines
    WHERE routines.user_id = p_user_id
      AND routines.composer_app_id = p_agent_id
      AND routines.deleted_at IS NULL
      AND (
        routines.metadata->>'launch_managed' = 'true'
        OR routines.metadata->>'launch_primary' = 'true'
      )
  ),
  up_next_candidates AS (
    SELECT
      'scheduled:' || routines.id::text || ':' ||
        extract(epoch FROM routines.next_run_at)::bigint::text AS item_key,
      'up_next'::text AS phase,
      'scheduled_run'::text AS kind,
      routines.name AS title,
      routines.description AS summary,
      'scheduled'::text AS status,
      routines.next_run_at AS event_at,
      routines.id AS routine_id,
      routines.id AS source_id,
      '/agents/' || v_slug || '?pane=routines&item=' ||
        routines.id::text AS detail_url
    FROM managed_routines AS routines
    WHERE p_include_upcoming
      AND p_cursor_at IS NULL
      AND routines.status = 'active'
      AND routines.next_run_at IS NOT NULL
      AND routines.next_run_at >= now()
    ORDER BY routines.next_run_at, routines.id
    LIMIT 10
  ),
  routine_now_candidates AS (
    SELECT
      'run:' || runs.id::text AS item_key,
      'now'::text AS phase,
      'routine_run'::text AS kind,
      routines.name AS title,
      runs.summary,
      runs.status,
      coalesce(runs.started_at, runs.created_at) AS event_at,
      routines.id AS routine_id,
      runs.id AS source_id,
      '/agents/' || v_slug || '?pane=routines&item=' ||
        routines.id::text AS detail_url
    FROM public.routine_runs AS runs
    JOIN managed_routines AS routines ON routines.id = runs.routine_id
    WHERE p_include_upcoming
      AND p_cursor_at IS NULL
      AND runs.user_id = p_user_id
      AND runs.status IN ('queued', 'running')
    ORDER BY
      CASE WHEN runs.status = 'running' THEN 0 ELSE 1 END,
      coalesce(runs.started_at, runs.created_at) DESC,
      runs.id DESC
    LIMIT 10
  ),
  event_now_candidates AS (
    SELECT
      'event-delivery:' || deliveries.id::text AS item_key,
      'now'::text AS phase,
      'agent_event'::text AS kind,
      'Event · ' || deliveries.target_function AS title,
      NULL::text AS summary,
      deliveries.status,
      coalesce(deliveries.next_eligible_at, deliveries.created_at) AS event_at,
      NULL::uuid AS routine_id,
      deliveries.id AS source_id,
      '/agents/' || v_slug || '?pane=overview' AS detail_url
    FROM public.agent_event_deliveries AS deliveries
    WHERE p_include_upcoming
      AND p_cursor_at IS NULL
      AND deliveries.user_id = p_user_id
      AND deliveries.subscriber_app_id = p_agent_id
      AND deliveries.status IN ('pending', 'waiting')
    ORDER BY
      coalesce(deliveries.next_eligible_at, deliveries.created_at),
      deliveries.id
    LIMIT 10
  ),
  compute_now_candidates AS (
    SELECT
      'compute:' || runs.id::text AS item_key,
      'now'::text AS phase,
      'compute_run'::text AS kind,
      'Compute · ' || runs.caller_function AS title,
      NULL::text AS summary,
      runs.state AS status,
      coalesce(runs.started_at, runs.created_at) AS event_at,
      NULL::uuid AS routine_id,
      runs.id AS source_id,
      '/agents/' || v_slug || '?pane=compute&item=' ||
        runs.id::text AS detail_url
    FROM public.compute_runs AS runs
    WHERE p_include_upcoming
      AND p_cursor_at IS NULL
      AND runs.user_id = p_user_id
      AND runs.agent_id = p_agent_id
      AND runs.state IN ('admitted', 'queued', 'provisioning', 'running')
    ORDER BY coalesce(runs.started_at, runs.created_at) DESC, runs.id DESC
    LIMIT 10
  ),
  recent_candidates AS (
    SELECT
      'run:' || runs.id::text AS item_key,
      'recent'::text AS phase,
      'routine_run'::text AS kind,
      routines.name AS title,
      coalesce(runs.summary, runs.error->>'message') AS summary,
      runs.status,
      coalesce(runs.completed_at, runs.started_at, runs.created_at) AS event_at,
      routines.id AS routine_id,
      runs.id AS source_id,
      '/agents/' || v_slug || '?pane=routines&item=' ||
        routines.id::text AS detail_url
    FROM public.routine_runs AS runs
    JOIN managed_routines AS routines ON routines.id = runs.routine_id
    WHERE runs.user_id = p_user_id
      AND runs.status IN (
        'succeeded', 'failed', 'cancelled', 'skipped'
      )
    UNION ALL
    SELECT
      'notification:' || notifications.id::text,
      'recent',
      CASE
        WHEN notifications.item_class = 'incident'
          THEN 'incident'
        ELSE 'report'
      END,
      notifications.title,
      notifications.body,
      notifications.lifecycle_state,
      notifications.created_at,
      CASE
        WHEN notifications.entity_type = 'routine'
          AND notifications.entity_id ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN notifications.entity_id::uuid
        ELSE NULL
      END,
      notifications.id,
      '/agents/' || v_slug || '?pane=alerts&item=' ||
        notifications.id::text
    FROM public.user_notifications AS notifications
    WHERE notifications.user_id = p_user_id
      AND notifications.agent_id = p_agent_id
    UNION ALL
    SELECT
      'compute:' || runs.id::text,
      'recent',
      'compute_run',
      'Compute · ' || runs.caller_function,
      NULL,
      runs.state,
      coalesce(runs.finished_at, runs.started_at, runs.created_at),
      NULL,
      runs.id,
      '/agents/' || v_slug || '?pane=compute&item=' || runs.id::text
    FROM public.compute_runs AS runs
    WHERE runs.user_id = p_user_id
      AND runs.agent_id = p_agent_id
      AND runs.state IN (
        'succeeded', 'failed', 'cancelled', 'expired', 'revoked'
      )
  ),
  recent_page AS (
    SELECT recent.*
    FROM recent_candidates AS recent
    WHERE p_cursor_at IS NULL
       OR (recent.event_at, recent.item_key) < (p_cursor_at, p_cursor_key)
    ORDER BY recent.event_at DESC, recent.item_key DESC
    LIMIT p_recent_limit
  ),
  combined AS (
    SELECT * FROM up_next_candidates
    UNION ALL SELECT * FROM routine_now_candidates
    UNION ALL SELECT * FROM event_now_candidates
    UNION ALL SELECT * FROM compute_now_candidates
    UNION ALL SELECT * FROM recent_page
  )
  SELECT
    combined.item_key,
    combined.phase,
    combined.kind,
    combined.title,
    combined.summary,
    combined.status,
    combined.event_at,
    combined.routine_id,
    combined.source_id,
    combined.detail_url
  FROM combined
  ORDER BY
    CASE combined.phase
      WHEN 'up_next' THEN 1
      WHEN 'now' THEN 2
      ELSE 3
    END,
    CASE WHEN combined.phase = 'up_next' THEN combined.event_at END,
    CASE WHEN combined.phase <> 'up_next' THEN combined.event_at END DESC,
    combined.item_key;
END;
$$;

REVOKE ALL ON FUNCTION public.get_launch_fleet_snapshot(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_launch_working_agent_count(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_launch_agent_activity(
  uuid, uuid, integer, timestamptz, text, boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_launch_fleet_snapshot(uuid, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_launch_working_agent_count(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_launch_agent_activity(
  uuid, uuid, integer, timestamptz, text, boolean
) TO service_role;
