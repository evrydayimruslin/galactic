-- Per-user notification inbox (loop-engineering Tier 2A).
-- A general primitive any subsystem can write to; the first writer is the
-- routine executor (auto-pause + budget-exhausted events), so an owner learns
-- their full-time agent stopped without polling the routine monitor. Future
-- writers: auto-heal, Connect, payouts, publish gates.

CREATE TABLE IF NOT EXISTS public.user_notifications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL,
  severity text DEFAULT 'info'::text NOT NULL,
  title text NOT NULL,
  body text,
  entity_type text,
  entity_id text,
  action_url text,
  -- Idempotency: unique per (user_id, dedupe_key) so a retried / re-claimed run
  -- never double-notifies. The writer builds a key that identifies the EVENT
  -- (e.g. one pause, one budget-reset window), not the tick.
  dedupe_key text NOT NULL,
  -- jsonb array of channels already fired (e.g. ["in_app","email"]); in-app is
  -- implicitly the row itself. Email (v2) stamps here so it fires at most once.
  delivered_channels jsonb DEFAULT '[]'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  read_at timestamp with time zone,
  CONSTRAINT user_notifications_severity_check CHECK (
    severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])
  )
);

ALTER TABLE public.user_notifications OWNER TO postgres;

ALTER TABLE ONLY public.user_notifications
  ADD CONSTRAINT user_notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_notifications
  ADD CONSTRAINT user_notifications_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- The idempotency guard for createNotification's on-conflict-do-nothing.
ALTER TABLE ONLY public.user_notifications
  ADD CONSTRAINT user_notifications_user_dedupe_key
  UNIQUE (user_id, dedupe_key);

-- Inbox read: newest-first, with a cheap unread filter.
CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created
  ON public.user_notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_unread
  ON public.user_notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

-- Retention sweep target (90-day; hourly cron).
CREATE INDEX IF NOT EXISTS idx_user_notifications_created
  ON public.user_notifications (created_at);
