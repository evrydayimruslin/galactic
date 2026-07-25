-- Canonical operator-item Attention reads (M5).
--
-- One owner-scoped snapshot supplies the page, unique global counts, and exact
-- affected-Agent counts. The RPC is additive and service-role only; rollout
-- can return to legacy notification reads without deleting canonical history.

CREATE INDEX IF NOT EXISTS operator_items_owner_active_page
  ON public.operator_items (
    user_id,
    lifecycle_state,
    source_key,
    source_ordinal,
    detected_at,
    id
  );

CREATE OR REPLACE FUNCTION public.get_operator_attention_page(
  p_user_id uuid,
  p_agent_id uuid DEFAULT NULL,
  p_now timestamptz DEFAULT now(),
  p_limit integer DEFAULT 200,
  p_after_source_key text DEFAULT NULL,
  p_after_source_ordinal integer DEFAULT NULL,
  p_after_detected_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
)
RETURNS TABLE (
  items jsonb,
  per_agent_counts jsonb,
  open_count bigint,
  requires_decision_count bigint,
  blocking_count bigint,
  next_source_key text,
  next_source_ordinal integer,
  next_detected_at timestamptz,
  next_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested AS (
    SELECT
      LEAST(GREATEST(COALESCE(p_limit, 200), 1), 200)::integer
        AS page_limit,
      COALESCE(p_now, now()) AS observed_now
  ),
  valid_agents AS MATERIALIZED (
    SELECT agent.id
    FROM public.apps AS agent
    WHERE agent.owner_id = p_user_id
      AND agent.visibility = 'private'
      AND agent.deleted_at IS NULL
  ),
  valid_fanout AS MATERIALIZED (
    SELECT affected.item_id, affected.agent_id, affected.blocking,
      affected.source_ordinal
    FROM public.operator_item_affected_agents AS affected
    JOIN valid_agents AS agent ON agent.id = affected.agent_id
    WHERE affected.user_id = p_user_id
  ),
  visible_items AS MATERIALIZED (
    SELECT
      item.*,
      COALESCE(attention.read_at, NULL) AS attention_read_at,
      EXISTS (
        SELECT 1
        FROM valid_fanout AS affected
        WHERE affected.item_id = item.id
          AND (p_agent_id IS NULL OR affected.agent_id = p_agent_id)
          AND affected.blocking
      ) AS blocking
    FROM public.operator_items AS item
    CROSS JOIN requested
    LEFT JOIN public.operator_item_attention_states AS attention
      ON attention.item_id = item.id
     AND attention.user_id = p_user_id
    WHERE item.user_id = p_user_id
      AND item.lifecycle_state = 'active'
      AND EXISTS (
        SELECT 1
        FROM valid_fanout AS affected
        WHERE affected.item_id = item.id
          AND (p_agent_id IS NULL OR affected.agent_id = p_agent_id)
      )
      AND (
        attention.item_id IS NULL
        OR attention.state = 'open'
        OR (
          attention.state = 'snoozed'
          AND attention.snoozed_until <= requested.observed_now
        )
      )
  ),
  page_candidates AS MATERIALIZED (
    SELECT visible.*
    FROM visible_items AS visible
    CROSS JOIN requested
    WHERE (
      p_after_source_key IS NULL
      AND p_after_source_ordinal IS NULL
      AND p_after_detected_at IS NULL
      AND p_after_id IS NULL
    )
    OR (
      p_after_source_key IS NOT NULL
      AND p_after_source_ordinal IS NOT NULL
      AND p_after_detected_at IS NOT NULL
      AND p_after_id IS NOT NULL
      AND (
        visible.source_key,
        visible.source_ordinal,
        visible.detected_at,
        visible.id
      ) > (
        p_after_source_key,
        p_after_source_ordinal,
        p_after_detected_at,
        p_after_id
      )
    )
    ORDER BY
      visible.source_key ASC,
      visible.source_ordinal ASC,
      visible.detected_at ASC,
      visible.id ASC
    LIMIT (SELECT page_limit + 1 FROM requested)
  ),
  page AS MATERIALIZED (
    SELECT candidate.*
    FROM page_candidates AS candidate
    ORDER BY
      candidate.source_key ASC,
      candidate.source_ordinal ASC,
      candidate.detected_at ASC,
      candidate.id ASC
    LIMIT (SELECT page_limit FROM requested)
  ),
  page_fanout AS (
    SELECT
      affected.item_id,
      jsonb_agg(
        jsonb_build_object(
          'agentId', affected.agent_id,
          'blocking', affected.blocking
        )
        ORDER BY affected.source_ordinal ASC, affected.agent_id ASC
      ) AS affected_agents
    FROM valid_fanout AS affected
    JOIN page ON page.id = affected.item_id
    GROUP BY affected.item_id
  ),
  page_json AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'item', jsonb_build_object(
            'id', page.id,
            'conditionKey', page.condition_key,
            'itemClass', page.item_class,
            'scope', CASE page.scope_kind
              WHEN 'account' THEN
                jsonb_build_object('kind', 'account')
              WHEN 'agent' THEN
                jsonb_build_object(
                  'kind', 'agent',
                  'agentId', page.scope_agent_id
                )
              WHEN 'routine' THEN
                jsonb_build_object(
                  'kind', 'routine',
                  'agentId', page.scope_agent_id,
                  'routineId', page.scope_routine_id
                )
              ELSE
                jsonb_build_object(
                  'kind', 'run',
                  'agentId', page.scope_agent_id,
                  'routineId', page.scope_routine_id,
                  'runId', page.scope_run_id
                )
            END,
            'severity', page.severity,
            'diagnosis', page.diagnosis,
            'affectedAgents', COALESCE(
              page_fanout.affected_agents,
              '[]'::jsonb
            ),
            'remediations', page.remediations,
            'requiresAction', page.requires_action,
            'requiresDecision', page.requires_decision,
            'ordering', jsonb_build_object(
              'sourceOrdinal', page.source_ordinal,
              'dependsOnConditionKeys',
                to_jsonb(page.depends_on_condition_keys)
            ),
            'recovery', jsonb_build_object(
              'mode', page.recovery_mode,
              'mayRecoverAutomatically', page.recovery_may_automatic,
              'resumesScheduledWork', false
            ),
            'detectedAt', page.detected_at
          ),
          -- Expired snoozes become visible without mutating presentation state.
          'attention', jsonb_build_object(
            'state', 'open',
            'readAt', page.attention_read_at,
            'snoozedUntil', NULL,
            'dismissedAt', NULL
          )
        )
        ORDER BY
          page.source_key ASC,
          page.source_ordinal ASC,
          page.detected_at ASC,
          page.id ASC
      ),
      '[]'::jsonb
    ) AS items
    FROM page
    LEFT JOIN page_fanout ON page_fanout.item_id = page.id
  ),
  counts_by_agent AS (
    SELECT
      affected.agent_id,
      count(*) AS open_count,
      count(*) FILTER (
        WHERE visible.requires_decision
      ) AS requires_decision_count,
      count(*) FILTER (
        WHERE affected.blocking
      ) AS blocking_count
    FROM visible_items AS visible
    JOIN valid_fanout AS affected ON affected.item_id = visible.id
    WHERE p_agent_id IS NULL OR affected.agent_id = p_agent_id
    GROUP BY affected.agent_id
  ),
  aggregate_json AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'agent_id', counts_by_agent.agent_id,
          'open_count', counts_by_agent.open_count,
          'requires_decision_count',
            counts_by_agent.requires_decision_count,
          'blocking_count', counts_by_agent.blocking_count
        )
        ORDER BY counts_by_agent.agent_id ASC
      ),
      '[]'::jsonb
    ) AS per_agent_counts
    FROM counts_by_agent
  ),
  counts AS (
    SELECT
      count(*) AS open_count,
      count(*) FILTER (
        WHERE visible.requires_decision
      ) AS requires_decision_count,
      count(*) FILTER (
        WHERE visible.blocking
      ) AS blocking_count
    FROM visible_items AS visible
  ),
  last_visible AS (
    SELECT page.source_key, page.source_ordinal, page.detected_at, page.id
    FROM page
    ORDER BY
      page.source_key DESC,
      page.source_ordinal DESC,
      page.detected_at DESC,
      page.id DESC
    LIMIT 1
  ),
  page_state AS (
    SELECT
      (SELECT count(*) FROM page_candidates) > requested.page_limit AS has_more
    FROM requested
  )
  SELECT
    page_json.items,
    aggregate_json.per_agent_counts,
    counts.open_count,
    counts.requires_decision_count,
    counts.blocking_count,
    CASE WHEN page_state.has_more THEN last_visible.source_key ELSE NULL END,
    CASE
      WHEN page_state.has_more THEN last_visible.source_ordinal
      ELSE NULL
    END,
    CASE WHEN page_state.has_more THEN last_visible.detected_at ELSE NULL END,
    CASE WHEN page_state.has_more THEN last_visible.id ELSE NULL END
  FROM page_json
  CROSS JOIN aggregate_json
  CROSS JOIN counts
  CROSS JOIN page_state
  LEFT JOIN last_visible ON true;
$$;

COMMENT ON FUNCTION public.get_operator_attention_page(
  uuid, uuid, timestamptz, integer, text, integer, timestamptz, uuid
) IS
  'Returns one owner-scoped canonical operator-item page, unique totals, and exact affected-Agent counts from one snapshot; service-role only.';

REVOKE ALL ON FUNCTION public.get_operator_attention_page(
  uuid, uuid, timestamptz, integer, text, integer, timestamptz, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_operator_attention_page(
  uuid, uuid, timestamptz, integer, text, integer, timestamptz, uuid
) TO service_role;
