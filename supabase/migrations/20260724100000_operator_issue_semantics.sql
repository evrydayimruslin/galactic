-- Operator issue semantics foundation.
--
-- Usage exhaustion is an informational report that recovers at reset, not an
-- owner decision. This migration updates the canonical database classifier
-- and converts only active legacy budget incidents. Resolved historical rows
-- retain their original classification as immutable episode history.

CREATE OR REPLACE FUNCTION public.classify_user_notification_attention()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.item_class := CASE
    WHEN NEW.kind IN (
      'agent_report',
      'routine_budget_exhausted',
      'routine_report',
      'routine_summary'
    )
      THEN 'report'
    ELSE 'incident'
  END;
  NEW.requires_action := NEW.item_class = 'incident';
  IF NEW.lifecycle_state IS NULL THEN
    NEW.lifecycle_state := 'open';
  END IF;
  IF NEW.state_changed_at IS NULL THEN
    NEW.state_changed_at := coalesce(NEW.created_at, now());
  END IF;
  RETURN NEW;
END;
$$;

-- If a previous compatibility writer somehow created both representations for
-- the same dedupe key, preserve both immutable episodes and make the incident
-- terminal before converting the remaining active rows.
UPDATE public.user_notifications AS incident
SET
  lifecycle_state = 'resolved',
  snoozed_until = NULL,
  resolved_at = coalesce(incident.resolved_at, now()),
  resolution_reason = coalesce(
    incident.resolution_reason,
    'reclassified_as_report'
  ),
  state_changed_at = now()
WHERE incident.kind = 'routine_budget_exhausted'
  AND incident.item_class = 'incident'
  AND incident.lifecycle_state IN ('open', 'snoozed')
  AND EXISTS (
    SELECT 1
    FROM public.user_notifications AS report
    WHERE report.user_id = incident.user_id
      AND report.dedupe_key = incident.dedupe_key
      AND report.item_class = 'report'
      AND report.id <> incident.id
  );

UPDATE public.user_notifications
SET
  item_class = 'report',
  requires_action = false,
  lifecycle_state = 'open',
  snoozed_until = NULL,
  resolved_at = NULL,
  resolution_reason = NULL,
  archived_at = NULL,
  state_changed_at = now()
WHERE kind = 'routine_budget_exhausted'
  AND item_class = 'incident'
  AND lifecycle_state IN ('open', 'snoozed');

-- Atomically insert one notification episode. The function repeats the exact
-- classifier because dedupe behavior differs for reports and incidents.
CREATE OR REPLACE FUNCTION public.create_user_notification_episode(
  p_user_id uuid,
  p_agent_id uuid,
  p_kind text,
  p_severity text,
  p_title text,
  p_body text,
  p_entity_type text,
  p_entity_id text,
  p_action_url text,
  p_dedupe_key text
) RETURNS SETOF public.user_notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.user_notifications%ROWTYPE;
  v_inserted public.user_notifications%ROWTYPE;
  v_item_class text := CASE
    WHEN p_kind IN (
      'agent_report',
      'routine_budget_exhausted',
      'routine_report',
      'routine_summary'
    )
      THEN 'report'
    ELSE 'incident'
  END;
BEGIN
  IF p_user_id IS NULL
     OR nullif(btrim(p_kind), '') IS NULL
     OR nullif(btrim(p_title), '') IS NULL
     OR nullif(btrim(p_dedupe_key), '') IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_notification_episode';
  END IF;

  -- Attribution is an owner boundary, not just a foreign-key relationship.
  IF p_agent_id IS NOT NULL THEN
    PERFORM 1
    FROM public.apps AS apps
    WHERE apps.id = p_agent_id
      AND apps.owner_id = p_user_id
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'notification_agent_owner_mismatch';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_user_id::text || E'\x1f' || btrim(p_dedupe_key),
      0
    )
  );

  SELECT * INTO v_existing
  FROM public.user_notifications
  WHERE user_id = p_user_id
    AND dedupe_key = btrim(p_dedupe_key)
    AND (
      (
        v_item_class = 'report'
        AND (
          item_class = 'report'
          OR lifecycle_state IN ('open', 'snoozed')
        )
      )
      OR (
        v_item_class = 'incident'
        AND lifecycle_state IN ('open', 'snoozed')
      )
    )
  ORDER BY
    (lifecycle_state IN ('open', 'snoozed')) DESC,
    created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.item_class = v_item_class
       OR v_existing.item_class = 'incident' THEN
      RETURN;
    END IF;

    IF v_item_class = 'incident'
       AND v_existing.item_class = 'report' THEN
      UPDATE public.user_notifications
      SET
        lifecycle_state = 'archived',
        archived_at = now(),
        read_at = coalesce(read_at, now()),
        state_changed_at = now()
      WHERE id = v_existing.id;
    ELSE
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.user_notifications (
    user_id,
    agent_id,
    kind,
    severity,
    title,
    body,
    entity_type,
    entity_id,
    action_url,
    dedupe_key
  ) VALUES (
    p_user_id,
    p_agent_id,
    btrim(p_kind),
    coalesce(nullif(btrim(p_severity), ''), 'info'),
    btrim(p_title),
    p_body,
    p_entity_type,
    p_entity_id,
    p_action_url,
    btrim(p_dedupe_key)
  )
  RETURNING * INTO v_inserted;

  RETURN NEXT v_inserted;
END;
$$;

COMMENT ON COLUMN public.user_notifications.item_class IS
  'report = informational output or an auto-recovering usage condition; incident = a condition requiring operator remediation.';
