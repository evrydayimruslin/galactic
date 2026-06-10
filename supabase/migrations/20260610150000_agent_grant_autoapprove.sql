-- Per-user opt-in: allow the connected agent (an API-token caller) to APPROVE
-- cross-Agent grants via ul.grants, not just propose/revoke (Phase 4b / P5).
--
-- Secure floor: default false — approving a grant (which authorizes one of the
-- user's Agents to call another) requires an account-session (website) action,
-- because a connected agent can be prompt-injected. Setting this true raises
-- the ceiling for power operators who want full conversational control.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS agent_grant_autoapprove boolean NOT NULL DEFAULT false;
