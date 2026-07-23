-- Canonical enriched-Attention actions and a bounded, owner-scoped account
-- Attention read. The latter avoids placing an owner's entire Agent-id set in
-- a PostgREST URL while preserving one global newest-first page and exact
-- counts.

-- Migrate the pre-release snake_case parameter spelling to the Launch API's
-- camelCase contract. Unknown parameters are intentionally discarded: action
-- destinations are reconstructed by the API, never trusted from storage.
UPDATE public.notification_briefs
SET action_parameters = CASE action_key
  WHEN 'open_access_setting' THEN jsonb_strip_nulls(jsonb_build_object(
    'agentId', COALESCE(action_parameters->'agentId',
                        action_parameters->'agent_id'),
    'settingKey', COALESCE(action_parameters->'settingKey',
                           action_parameters->'setting_key')
  ))
  WHEN 'open_release_review' THEN jsonb_strip_nulls(jsonb_build_object(
    'agentId', COALESCE(action_parameters->'agentId',
                        action_parameters->'agent_id'),
    'releaseId', COALESCE(action_parameters->'releaseId',
                          action_parameters->'release_id',
                          action_parameters->'version')
  ))
  WHEN 'open_routine' THEN jsonb_strip_nulls(jsonb_build_object(
    'agentId', COALESCE(action_parameters->'agentId',
                        action_parameters->'agent_id'),
    'routineId', COALESCE(action_parameters->'routineId',
                          action_parameters->'routine_id')
  ))
  WHEN 'approve_grant' THEN jsonb_strip_nulls(jsonb_build_object(
    'agentId', COALESCE(action_parameters->'agentId',
                        action_parameters->'agent_id'),
    'grantId', COALESCE(action_parameters->'grantId',
                        action_parameters->'grant_id')
  ))
  WHEN 'resume_agent' THEN jsonb_strip_nulls(jsonb_build_object(
    'agentId', COALESCE(action_parameters->'agentId',
                        action_parameters->'agent_id')
  ))
  ELSE '{}'::jsonb
END;

-- Any legacy row that cannot satisfy the canonical evidence-bound shape is
-- made inert rather than guessing at an executable/navigation target.
UPDATE public.notification_briefs
SET action_key = NULL,
    action_parameters = '{}'::jsonb
WHERE action_key IS NOT NULL
  AND NOT COALESCE((
    jsonb_typeof(action_parameters->'agentId') = 'string'
    AND (action_parameters->>'agentId') ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND (
      (
        action_key = 'open_access_setting'
        AND (
          NOT (action_parameters ? 'settingKey')
          OR (
            jsonb_typeof(action_parameters->'settingKey') = 'string'
            AND (action_parameters->>'settingKey') ~
              '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$'
          )
        )
      )
      OR (
        action_key = 'open_release_review'
        AND (
          NOT (action_parameters ? 'releaseId')
          OR (
            jsonb_typeof(action_parameters->'releaseId') = 'string'
            AND (action_parameters->>'releaseId') ~
              '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$'
          )
        )
      )
      OR (
        action_key = 'open_routine'
        AND jsonb_typeof(action_parameters->'routineId') = 'string'
        AND (action_parameters->>'routineId') ~
          '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$'
      )
      OR (
        action_key = 'approve_grant'
        AND jsonb_typeof(action_parameters->'grantId') = 'string'
        AND (action_parameters->>'grantId') ~
          '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$'
      )
      OR action_key = 'resume_agent'
    )
  ), false);

ALTER TABLE public.notification_briefs
  ADD CONSTRAINT notification_briefs_canonical_action_parameters_check
  CHECK (COALESCE((
    (
      action_key IS NULL
      AND action_parameters = '{}'::jsonb
    )
    OR (
      jsonb_typeof(action_parameters->'agentId') = 'string'
      AND (action_parameters->>'agentId') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND (
        (
          action_key = 'open_access_setting'
          AND action_parameters = jsonb_strip_nulls(jsonb_build_object(
            'agentId', action_parameters->'agentId',
            'settingKey', action_parameters->'settingKey'
          ))
          AND (
            NOT (action_parameters ? 'settingKey')
            OR (
              jsonb_typeof(action_parameters->'settingKey') = 'string'
              AND (action_parameters->>'settingKey') ~
                '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$'
            )
          )
        )
        OR (
          action_key = 'open_release_review'
          AND action_parameters = jsonb_strip_nulls(jsonb_build_object(
            'agentId', action_parameters->'agentId',
            'releaseId', action_parameters->'releaseId'
          ))
          AND (
            NOT (action_parameters ? 'releaseId')
            OR (
              jsonb_typeof(action_parameters->'releaseId') = 'string'
              AND (action_parameters->>'releaseId') ~
                '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$'
            )
          )
        )
        OR (
          action_key = 'open_routine'
          AND action_parameters = jsonb_build_object(
            'agentId', action_parameters->'agentId',
            'routineId', action_parameters->'routineId'
          )
          AND jsonb_typeof(action_parameters->'routineId') = 'string'
          AND (action_parameters->>'routineId') ~
            '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$'
        )
        OR (
          action_key = 'approve_grant'
          AND action_parameters = jsonb_build_object(
            'agentId', action_parameters->'agentId',
            'grantId', action_parameters->'grantId'
          )
          AND jsonb_typeof(action_parameters->'grantId') = 'string'
          AND (action_parameters->>'grantId') ~
            '^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$'
        )
        OR (
          action_key = 'resume_agent'
          AND action_parameters = jsonb_build_object(
            'agentId', action_parameters->'agentId'
          )
        )
      )
    )
  ), false));

CREATE OR REPLACE FUNCTION public.get_owner_attention_snapshot(
  p_user_id uuid,
  p_now timestamptz DEFAULT now(),
  p_limit integer DEFAULT 200
)
RETURNS TABLE (
  notifications jsonb,
  open_count bigint,
  requires_decision_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH active_notifications AS MATERIALIZED (
    SELECT notification.*
    FROM public.user_notifications AS notification
    JOIN public.apps AS agent
      ON agent.id = notification.agent_id
     AND agent.owner_id = p_user_id
     AND agent.visibility = 'private'
     AND agent.deleted_at IS NULL
    WHERE notification.user_id = p_user_id
      AND (
        (
          notification.item_class = 'report'
          AND notification.lifecycle_state = 'open'
          AND notification.read_at IS NULL
        )
        OR (
          notification.item_class = 'incident'
          AND notification.lifecycle_state = 'open'
        )
        OR (
          notification.item_class = 'incident'
          AND notification.lifecycle_state = 'snoozed'
          AND notification.snoozed_until IS NOT NULL
          AND notification.snoozed_until <= COALESCE(p_now, now())
        )
      )
  ),
  page AS (
    SELECT active.*
    FROM active_notifications AS active
    ORDER BY active.created_at DESC, active.id ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 200)
  ),
  page_json AS (
    SELECT COALESCE(
      jsonb_agg(to_jsonb(page) ORDER BY page.created_at DESC, page.id ASC),
      '[]'::jsonb
    ) AS notifications
    FROM page
  ),
  counts AS (
    SELECT
      count(*) AS open_count,
      count(*) FILTER (
        WHERE item_class = 'incident'
      ) AS requires_decision_count
    FROM active_notifications
  )
  SELECT
    page_json.notifications,
    counts.open_count,
    counts.requires_decision_count
  FROM page_json
  CROSS JOIN counts;
$$;

COMMENT ON FUNCTION public.get_owner_attention_snapshot(
  uuid, timestamptz, integer
) IS
  'Returns the newest 200 active Attention rows and exact counts across the caller-supplied owner''s live private Agents; service-role only.';

REVOKE ALL ON FUNCTION public.get_owner_attention_snapshot(
  uuid, timestamptz, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_owner_attention_snapshot(
  uuid, timestamptz, integer
) TO service_role;
