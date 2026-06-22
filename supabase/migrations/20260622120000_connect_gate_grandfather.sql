-- Stripe Connect publish gate (Track E): grandfather existing public agents.
--
-- The gate requires a seller to have Stripe Connect payouts enabled before an
-- agent can be published PUBLICLY. Agents that were already public before the
-- gate shipped must keep publishing new versions without being retro-blocked.
--
-- We mark them with an explicit, auditable boolean rather than a publish-date
-- cutoff: a date heuristic can't distinguish an EXISTING public app created
-- "today" from a NEW public app created "today", so it would either retro-block
-- legacy sellers or let new public apps bypass Connect. A flag backfilled once,
-- at gate launch, is unambiguous: every currently-public app is exempt; every
-- app made public afterwards defaults to non-exempt and must connect.

ALTER TABLE public.apps
  ADD COLUMN IF NOT EXISTS connect_gate_exempt boolean NOT NULL DEFAULT false;

-- Backfill: every app that is public RIGHT NOW predates the gate -> exempt.
-- Unlisted apps are intentionally NOT exempted: they never required Connect,
-- and if one is later made public that is a NEW public listing which must
-- connect like any other.
UPDATE public.apps
SET connect_gate_exempt = true
WHERE visibility = 'public'
  AND deleted_at IS NULL;
