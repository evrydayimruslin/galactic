-- Cursor-paged, atomic Attention snapshots for the launch operator UI.
--
-- Rows and exact counts deliberately come from the same materialized active
-- set. This prevents a lifecycle transition between independent reads from
-- producing an impossible page/count combination. Owner pages also return
-- exact per-Agent aggregates so a bounded global page never becomes the source
-- of truth for Agent badges.

CREATE OR REPLACE FUNCTION public.get_agent_attention_page(
  p_user_id uuid,
  p_agent_id uuid,
  p_now timestamptz DEFAULT now(),
  p_limit integer DEFAULT 200,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL
)
RETURNS TABLE (
  notifications jsonb,
  open_count bigint,
  requires_decision_count bigint,
  next_before_created_at timestamptz,
  next_before_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested AS (
    SELECT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 200)::integer AS page_limit
  ),
  active_notifications AS MATERIALIZED (
    SELECT notification.*
    FROM public.user_notifications AS notification
    JOIN public.apps AS agent
      ON agent.id = notification.agent_id
     AND agent.id = p_agent_id
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
  page_candidates AS MATERIALIZED (
    SELECT active.*
    FROM active_notifications AS active
    CROSS JOIN requested
    WHERE (
      p_before_created_at IS NULL
      AND p_before_id IS NULL
    )
    OR (
      p_before_created_at IS NOT NULL
      AND p_before_id IS NOT NULL
      AND (
        active.created_at < p_before_created_at
        OR (
          active.created_at = p_before_created_at
          AND active.id > p_before_id
        )
      )
    )
    ORDER BY active.created_at DESC, active.id ASC
    LIMIT (SELECT page_limit + 1 FROM requested)
  ),
  page AS MATERIALIZED (
    SELECT candidate.*
    FROM page_candidates AS candidate
    ORDER BY candidate.created_at DESC, candidate.id ASC
    LIMIT (SELECT page_limit FROM requested)
  ),
  page_json AS (
    SELECT COALESCE(
      jsonb_agg(to_jsonb(page) ORDER BY page.created_at DESC, page.id ASC),
      '[]'::jsonb
    ) AS notifications
    FROM page
  ),
  last_visible AS (
    SELECT page.created_at, page.id
    FROM page
    ORDER BY page.created_at ASC, page.id DESC
    LIMIT 1
  ),
  page_state AS (
    SELECT
      (SELECT count(*) FROM page_candidates) > requested.page_limit AS has_more
    FROM requested
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
    counts.requires_decision_count,
    CASE WHEN page_state.has_more THEN last_visible.created_at ELSE NULL END,
    CASE WHEN page_state.has_more THEN last_visible.id ELSE NULL END
  FROM page_json
  CROSS JOIN counts
  CROSS JOIN page_state
  LEFT JOIN last_visible ON true;
$$;

COMMENT ON FUNCTION public.get_agent_attention_page(
  uuid, uuid, timestamptz, integer, timestamptz, uuid
) IS
  'Returns one cursor page and exact active Attention counts from one owner- and Agent-scoped snapshot; service-role only.';

REVOKE ALL ON FUNCTION public.get_agent_attention_page(
  uuid, uuid, timestamptz, integer, timestamptz, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_agent_attention_page(
  uuid, uuid, timestamptz, integer, timestamptz, uuid
) TO service_role;

CREATE OR REPLACE FUNCTION public.get_owner_attention_page(
  p_user_id uuid,
  p_now timestamptz DEFAULT now(),
  p_limit integer DEFAULT 200,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL
)
RETURNS TABLE (
  notifications jsonb,
  per_agent_counts jsonb,
  open_count bigint,
  requires_decision_count bigint,
  next_before_created_at timestamptz,
  next_before_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested AS (
    SELECT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 200)::integer AS page_limit
  ),
  active_notifications AS MATERIALIZED (
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
  page_candidates AS MATERIALIZED (
    SELECT active.*
    FROM active_notifications AS active
    CROSS JOIN requested
    WHERE (
      p_before_created_at IS NULL
      AND p_before_id IS NULL
    )
    OR (
      p_before_created_at IS NOT NULL
      AND p_before_id IS NOT NULL
      AND (
        active.created_at < p_before_created_at
        OR (
          active.created_at = p_before_created_at
          AND active.id > p_before_id
        )
      )
    )
    ORDER BY active.created_at DESC, active.id ASC
    LIMIT (SELECT page_limit + 1 FROM requested)
  ),
  page AS MATERIALIZED (
    SELECT candidate.*
    FROM page_candidates AS candidate
    ORDER BY candidate.created_at DESC, candidate.id ASC
    LIMIT (SELECT page_limit FROM requested)
  ),
  page_json AS (
    SELECT COALESCE(
      jsonb_agg(to_jsonb(page) ORDER BY page.created_at DESC, page.id ASC),
      '[]'::jsonb
    ) AS notifications
    FROM page
  ),
  last_visible AS (
    SELECT page.created_at, page.id
    FROM page
    ORDER BY page.created_at ASC, page.id DESC
    LIMIT 1
  ),
  page_state AS (
    SELECT
      (SELECT count(*) FROM page_candidates) > requested.page_limit AS has_more
    FROM requested
  ),
  counts_by_agent AS (
    SELECT
      agent_id,
      count(*) AS open_count,
      count(*) FILTER (
        WHERE item_class = 'incident'
      ) AS requires_decision_count
    FROM active_notifications
    GROUP BY agent_id
  ),
  aggregate_json AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'agent_id', counts_by_agent.agent_id,
          'open_count', counts_by_agent.open_count,
          'requires_decision_count',
            counts_by_agent.requires_decision_count
        )
        ORDER BY counts_by_agent.agent_id
      ),
      '[]'::jsonb
    ) AS per_agent_counts
    FROM counts_by_agent
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
    aggregate_json.per_agent_counts,
    counts.open_count,
    counts.requires_decision_count,
    CASE WHEN page_state.has_more THEN last_visible.created_at ELSE NULL END,
    CASE WHEN page_state.has_more THEN last_visible.id ELSE NULL END
  FROM page_json
  CROSS JOIN aggregate_json
  CROSS JOIN counts
  CROSS JOIN page_state
  LEFT JOIN last_visible ON true;
$$;

COMMENT ON FUNCTION public.get_owner_attention_page(
  uuid, timestamptz, integer, timestamptz, uuid
) IS
  'Returns one cursor page, exact global totals, and exact per-Agent Attention counts from one owner-scoped snapshot; service-role only.';

REVOKE ALL ON FUNCTION public.get_owner_attention_page(
  uuid, timestamptz, integer, timestamptz, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_owner_attention_page(
  uuid, timestamptz, integer, timestamptz, uuid
) TO service_role;
