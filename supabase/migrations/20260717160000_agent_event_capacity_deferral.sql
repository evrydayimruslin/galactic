-- P2.3: durable, root-attributed capacity deferral for reactive Agent events.
--
-- Rollout is additive: historical events fall back to emitter_app_id in code,
-- while new events persist the immutable root/origin Agent. Only structured
-- pre-execution capacity denials enter `waiting`; tenant execution failures
-- stay terminal so reactive side effects are never blindly repeated.

ALTER TABLE public.agent_events
  ADD COLUMN IF NOT EXISTS capacity_agent_id uuid,
  ADD COLUMN IF NOT EXISTS next_eligible_at timestamp with time zone;

UPDATE public.agent_events AS events
SET capacity_agent_id = apps.id
FROM public.apps AS apps
WHERE events.capacity_agent_id IS NULL
  AND apps.id = events.emitter_app_id
  AND apps.owner_id = events.user_id;

-- Enforce new references without making legacy orphaned history block rollout.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_events_capacity_agent_id_fkey'
      AND conrelid = 'public.agent_events'::regclass
  ) THEN
    ALTER TABLE public.agent_events
      ADD CONSTRAINT agent_events_capacity_agent_id_fkey
      FOREIGN KEY (capacity_agent_id) REFERENCES public.apps(id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END;
$$;

ALTER TABLE public.agent_events
  DROP CONSTRAINT IF EXISTS agent_events_status_check;
ALTER TABLE public.agent_events
  ADD CONSTRAINT agent_events_status_check
  CHECK (status IN ('pending', 'delivering', 'waiting', 'delivered', 'failed'));

ALTER TABLE public.agent_events
  DROP CONSTRAINT IF EXISTS agent_events_waiting_reset_check;
ALTER TABLE public.agent_events
  ADD CONSTRAINT agent_events_waiting_reset_check
  CHECK (status <> 'waiting' OR next_eligible_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS agent_events_capacity_wait_idx
  ON public.agent_events (next_eligible_at, created_at)
  WHERE status = 'waiting';

ALTER TABLE public.agent_event_deliveries
  ADD COLUMN IF NOT EXISTS next_eligible_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS capacity_code text;

ALTER TABLE public.agent_event_deliveries
  DROP CONSTRAINT IF EXISTS agent_event_deliveries_status_check;
ALTER TABLE public.agent_event_deliveries
  ADD CONSTRAINT agent_event_deliveries_status_check
  CHECK (status IN ('pending', 'waiting', 'delivered', 'failed', 'denied'));

ALTER TABLE public.agent_event_deliveries
  DROP CONSTRAINT IF EXISTS agent_event_deliveries_waiting_reset_check;
ALTER TABLE public.agent_event_deliveries
  ADD CONSTRAINT agent_event_deliveries_waiting_reset_check
  CHECK (status <> 'waiting' OR next_eligible_at IS NOT NULL);

ALTER TABLE public.agent_event_deliveries
  DROP CONSTRAINT IF EXISTS agent_event_deliveries_capacity_code_check;
ALTER TABLE public.agent_event_deliveries
  ADD CONSTRAINT agent_event_deliveries_capacity_code_check
  CHECK (
    capacity_code IS NULL OR capacity_code IN (
      'capacity_waiting',
      'agent_cap_waiting',
      'agent_cap_too_low_for_request'
    )
  );

CREATE INDEX IF NOT EXISTS agent_event_deliveries_capacity_wait_idx
  ON public.agent_event_deliveries (event_id, next_eligible_at)
  WHERE status = 'waiting';
