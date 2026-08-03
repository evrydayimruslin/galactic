-- Pillar P1 (docs/POLICY_PILLAR_ARCHITECTURE.md §5): async_jobs becomes the
-- invocation ledger. Additive columns only; the queue consumer's optimistic
-- status='queued' claim filter keeps the new dormant states ('held' at P3,
-- 'denied' at P2) inert until the gate populates them. No CHECK constraint
-- exists on status (verified against the baseline) — states are governed by
-- code paths, and the gate is the only writer of the new ones.

ALTER TABLE public.async_jobs
  ADD COLUMN IF NOT EXISTS trigger text
    CHECK (trigger IS NULL OR trigger IN (
      'interface', 'schedule', 'manual', 'event', 'retry'
    )),
  ADD COLUMN IF NOT EXISTS release_id uuid,
  ADD COLUMN IF NOT EXISTS policy_version integer,
  ADD COLUMN IF NOT EXISTS held_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

-- The pillar's vocabulary over the same rows: one ledger, two names.
CREATE OR REPLACE VIEW public.agent_invocations AS
  SELECT
    id,
    app_id,
    user_id,
    owner_id,
    function_name,
    status,
    trigger,
    client_invocation_id,
    release_id,
    policy_version,
    execution_id,
    caller_app_id,
    caller_grant_id,
    hop,
    created_at,
    started_at,
    held_at,
    resolved_at,
    completed_at
  FROM public.async_jobs;

-- Gate lookups: held work per app (P3's Approvals projection reads this).
CREATE INDEX IF NOT EXISTS async_jobs_held_idx
  ON public.async_jobs (app_id, created_at DESC)
  WHERE status = 'held';
