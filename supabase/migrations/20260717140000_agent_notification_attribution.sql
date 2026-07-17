-- Attribute every owner notification to the Agent responsible for it.
--
-- `entity_type`/`entity_id` remain the deep-link target (a routine, app, etc.).
-- `agent_id` is the stable filtering dimension used by the Fleet and Agent
-- Alert panes. Keeping these separate means routine deletion does not make old
-- reports impossible to find and avoids title/body parsing in the API.

ALTER TABLE public.user_notifications
  ADD COLUMN IF NOT EXISTS agent_id uuid;

UPDATE public.user_notifications AS notifications
SET agent_id = apps.id
FROM public.apps AS apps
WHERE notifications.agent_id IS NULL
  AND notifications.entity_type = 'app'
  AND notifications.entity_id = apps.id::text
  AND notifications.user_id = apps.owner_id;

UPDATE public.user_notifications AS notifications
SET agent_id = routines.composer_app_id
FROM public.user_routines AS routines
WHERE notifications.agent_id IS NULL
  AND notifications.entity_type = 'routine'
  AND notifications.entity_id = routines.id::text
  AND notifications.user_id = routines.user_id
  AND routines.composer_app_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.apps AS apps
    WHERE apps.id = routines.composer_app_id
      AND apps.owner_id = notifications.user_id
  );

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.user_notifications'::regclass
      AND conname = 'user_notifications_agent_id_fkey'
  ) THEN
    ALTER TABLE public.user_notifications
      ADD CONSTRAINT user_notifications_agent_id_fkey
      FOREIGN KEY (agent_id) REFERENCES public.apps(id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END;
$migration$;

-- NOT VALID avoids the high-lock table scan during ADD CONSTRAINT while still
-- enforcing every concurrent/new write. Validation uses the lighter lock and
-- is safe because both backfills only select existing tenant-matched Agents.
ALTER TABLE public.user_notifications
  VALIDATE CONSTRAINT user_notifications_agent_id_fkey;

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_agent_created
  ON public.user_notifications (user_id, agent_id, created_at DESC)
  WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_agent_unread
  ON public.user_notifications (user_id, agent_id, created_at DESC)
  WHERE agent_id IS NOT NULL AND read_at IS NULL;
