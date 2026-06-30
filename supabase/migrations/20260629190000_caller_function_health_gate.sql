-- Health-gated connected-agent permission: an "always" policy can be set to
-- auto-allow ONLY when the target Agent is recently healthy (green). When the
-- target is unproven (no_data) or failing (red), an "always (health-gated)"
-- policy degrades to "ask" so an agent never silently auto-calls an Agent it
-- can't see working. Default ON, so the safe behaviour is the default once a
-- user turns a function's policy to "always".
-- Per-function gate is NULLABLE (default true): NULL means "inherit the user's
-- default_health_gate", and a nullable column keeps a heterogeneous upsert batch
-- (some rows set health_gate, some don't) from hitting a NOT NULL violation when
-- PostgREST unions the column set.
ALTER TABLE public.user_agent_function_permissions
  ADD COLUMN IF NOT EXISTS health_gate boolean DEFAULT true;

-- The per-user default is single-row, never batched, so keep it NOT NULL.
ALTER TABLE public.user_agent_permission_defaults
  ADD COLUMN IF NOT EXISTS default_health_gate boolean NOT NULL DEFAULT true;
