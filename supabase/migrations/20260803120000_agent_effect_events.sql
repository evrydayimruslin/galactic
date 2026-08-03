-- Pillar P0 (docs/POLICY_PILLAR_ARCHITECTURE.md §5): the effect witness.
-- One typed, ordered stream of what an execution DID, recorded by the
-- platform at its own chokepoints and batch-persisted at settlement (the
-- flight-recorder pipeline — zero per-call write latency). The attestation
-- ladder is the honesty contract: attested = the platform witnessed the
-- channel itself; observed = the platform saw the request, not its meaning;
-- app_claimed = the app said so (galactic.evidence), rendered as its own
-- account, never as platform fact. Service-role only.

CREATE TABLE public.agent_effect_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  execution_id text NOT NULL,
  -- Routine lineage when the execution ran under a routine (the Studio
  -- Activity join); NULL for interface/direct calls.
  run_id uuid,
  receipt_id text,
  seq integer NOT NULL CHECK (seq >= 0),
  kind text NOT NULL CHECK (kind IN (
    'function_started', 'function_completed', 'function_failed',
    'ai_exchange', 'db_mutation', 'email_dispatch', 'notification',
    'event_emit', 'http_request', 'agent_call', 'non_action', 'evidence'
  )),
  channel text CHECK (channel IS NULL OR char_length(channel) <= 120),
  target_digest text
    CHECK (target_digest IS NULL OR char_length(target_digest) <= 200),
  outcome text CHECK (outcome IS NULL OR char_length(outcome) <= 200),
  attestation text NOT NULL
    CHECK (attestation IN ('attested', 'observed', 'app_claimed')),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_id, seq)
);

CREATE INDEX agent_effect_events_run_idx
  ON public.agent_effect_events (run_id, seq)
  WHERE run_id IS NOT NULL;
CREATE INDEX agent_effect_events_app_time_idx
  ON public.agent_effect_events (app_id, created_at DESC);

ALTER TABLE public.agent_effect_events ENABLE ROW LEVEL SECURITY;
