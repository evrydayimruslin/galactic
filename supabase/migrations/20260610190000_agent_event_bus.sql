-- Cross-Agent pub/sub event bus (Phase 4.5 / P5).
--
-- An Agent emits a topic; subscriber Agents' handler functions are invoked in
-- response IF the user wired a mode='subscribe' grant. Authorization rides the
-- existing agent_function_grants table (mode='subscribe'): caller_app_id = the
-- EMITTER, target_app_id/target_function = the SUBSCRIBER + handler, and a new
-- `topic` selector. Delivery is async (enqueue at emit, drain via cron), billed
-- to the user, and capped by the subscribe grant's monthly_cap_credits.

-- 1. Topic selector on the grant (NOT NULL DEFAULT '' sentinel, matching
--    caller_function/slot, so the bare-column unique index + PostgREST
--    on_conflict still work). Empty for call grants.
ALTER TABLE public.agent_function_grants
  ADD COLUMN IF NOT EXISTS topic text NOT NULL DEFAULT '';

-- Recreate the unique index to include topic so a subscriber can subscribe to
-- multiple topics from the same emitter→handler pair. on_conflict in
-- agent-grants.ts is updated to match this exact column set.
DROP INDEX IF EXISTS public.agent_function_grants_unique;
CREATE UNIQUE INDEX IF NOT EXISTS agent_function_grants_unique
  ON public.agent_function_grants (
    user_id,
    caller_app_id,
    caller_function,
    slot,
    target_app_id,
    target_function,
    topic,
    mode
  );

-- Subscriber resolution: active subscribe grants for (user, emitter, topic).
CREATE INDEX IF NOT EXISTS agent_function_grants_subscribe_idx
  ON public.agent_function_grants (user_id, caller_app_id, topic, status)
  WHERE mode = 'subscribe';

-- 2. The event queue. One row per emit; drained by the dispatch cron.
CREATE TABLE IF NOT EXISTS public.agent_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id uuid NOT NULL,
  emitter_app_id uuid NOT NULL,
  topic text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- pending -> delivering -> delivered | failed. A failed event has exhausted
  -- its dispatch attempts (subscriber resolution / fan-out level).
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  -- Cooperative lease so concurrent cron ticks don't double-dispatch.
  lease_until timestamptz,
  -- Call-chain depth at emit time; bounds reactive cascades.
  emit_hop integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  CONSTRAINT agent_events_status_check
    CHECK (status IN ('pending', 'delivering', 'delivered', 'failed'))
);

ALTER TABLE public.agent_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.agent_events TO service_role;

-- Dispatch scan: pending/expired-lease events oldest-first.
CREATE INDEX IF NOT EXISTS agent_events_dispatch_idx
  ON public.agent_events (status, created_at)
  WHERE status IN ('pending', 'delivering');

-- 3. Per-subscriber delivery tracking (idempotency + retry). One row per
--    (event, subscribe grant) — the unique index makes redelivery idempotent.
CREATE TABLE IF NOT EXISTS public.agent_event_deliveries (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES public.agent_events(id) ON DELETE CASCADE,
  grant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  subscriber_app_id uuid NOT NULL,
  target_function text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  receipt_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CONSTRAINT agent_event_deliveries_status_check
    CHECK (status IN ('pending', 'delivered', 'failed', 'denied'))
);

ALTER TABLE public.agent_event_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_event_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.agent_event_deliveries TO service_role;

-- Idempotent fan-out: never deliver the same event to the same grant twice.
CREATE UNIQUE INDEX IF NOT EXISTS agent_event_deliveries_unique
  ON public.agent_event_deliveries (event_id, grant_id);

CREATE INDEX IF NOT EXISTS agent_event_deliveries_subscriber_idx
  ON public.agent_event_deliveries (user_id, subscriber_app_id, created_at);
