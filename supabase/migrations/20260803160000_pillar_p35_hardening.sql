-- Pillar P3.5 hardening (rulings 2026-08-03):
-- 1. Envelopes record the declaration hash they were held under, so
--    approve-time revalidation can refuse to resume a run whose function
--    was redeclared since the hold (decision 5: fail closed).
-- 2. One envelope per held invocation, enforced (the doc's UNIQUE(run_id)
--    that P3 omitted).

ALTER TABLE public.agent_approvals
  ADD COLUMN IF NOT EXISTS declaration_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS agent_approvals_run_unique_idx
  ON public.agent_approvals (run_id);
