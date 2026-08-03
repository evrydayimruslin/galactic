-- Pillar P3 (docs/POLICY_PILLAR_ARCHITECTURE.md §5): approval envelopes.
-- A run held by an 'ask' policy parks its full input on an async_jobs row
-- (status 'held' — service plane, never owner-visible) and files THIS row:
-- the durable, owner-safe envelope (I10 — sanitized source/proposal only;
-- raw args, model reasoning, and secrets never appear here). Approve flips
-- the job held->queued through the same CAS filter the consumer claims
-- through, so resumption is exactly-once (I9). Envelopes expire rather
-- than lurk; expiry is a terminal resolution like any other.

CREATE TABLE public.agent_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending', 'approved', 'rejected', 'resuming', 'completed',
      'expired', 'failed'
    )
  ),
  -- CAS token: resolutions must present the revision they read (I5).
  revision text NOT NULL,
  job_id uuid,
  release_id uuid,
  release_version text,
  function_name text NOT NULL,
  consequence text NOT NULL CHECK (
    consequence IN ('read', 'internal_write', 'external_side_effect', 'spend')
  ),
  input_hash text NOT NULL,
  trigger text,
  run_id uuid NOT NULL,
  routine_id uuid,
  routine_run_id uuid,
  trace_id text,
  policy_revision text NOT NULL,
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposal jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_by jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz
);

CREATE INDEX agent_approvals_pending_idx
  ON public.agent_approvals (app_id, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX agent_approvals_owner_idx
  ON public.agent_approvals (user_id, app_id, created_at DESC);

ALTER TABLE public.agent_approvals ENABLE ROW LEVEL SECURITY;
