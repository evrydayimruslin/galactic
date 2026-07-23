-- Reopen expired incident snoozes on the worker cadence so Attention search
-- cannot remain stale merely because no source row changed after the deadline.
--
-- The lifecycle update deliberately goes through the canonical notification
-- row. The existing reconciliation trigger then emits an owner-validated,
-- identifier-only search projection job; no notification content or secret
-- values are copied into this maintenance RPC or the outbox.

CREATE OR REPLACE FUNCTION public.reopen_expired_attention_snoozes(
  p_limit integer DEFAULT 100
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reopened integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_expired_attention_snooze_limit';
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT notifications.id
    FROM public.user_notifications AS notifications
    WHERE notifications.item_class = 'incident'
      AND notifications.lifecycle_state = 'snoozed'
      AND notifications.snoozed_until IS NOT NULL
      AND notifications.snoozed_until <= now()
    ORDER BY notifications.snoozed_until, notifications.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  reopened AS (
    UPDATE public.user_notifications AS notifications
    SET
      lifecycle_state = 'open',
      snoozed_until = NULL,
      resolved_at = NULL,
      resolution_reason = NULL,
      state_changed_at = now()
    FROM candidates
    WHERE notifications.id = candidates.id
      AND notifications.item_class = 'incident'
      AND notifications.lifecycle_state = 'snoozed'
      AND notifications.snoozed_until IS NOT NULL
      AND notifications.snoozed_until <= now()
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_reopened FROM reopened;

  RETURN v_reopened;
END;
$$;

COMMENT ON FUNCTION public.reopen_expired_attention_snoozes(integer) IS
  'Boundedly and idempotently reopens due incident snoozes so lifecycle triggers reconcile active Attention search; service-role only.';

REVOKE ALL ON FUNCTION public.reopen_expired_attention_snoozes(integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reopen_expired_attention_snoozes(integer)
  TO service_role;
