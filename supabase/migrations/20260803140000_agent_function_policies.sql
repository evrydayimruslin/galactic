-- Pillar P2 (docs/POLICY_PILLAR_ARCHITECTURE.md §5): the owner's autonomous
-- policy overlay. No row = 'free' (the launch posture — introducing the
-- table changes nothing until an owner flips a switch). 'off' denies the
-- agent's own autonomous calls with a structured non-action; 'ask' is
-- storable but dormant until P3 activates holds. Policies can only NARROW
-- the release's declared authority (I1) — the gate consults this overlay
-- AFTER the release ceiling, never instead of it. declaration_hash is the
-- carry-forward key: a changed declaration resets the conversation.

CREATE TABLE public.agent_function_policies (
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  function_name text NOT NULL CHECK (char_length(function_name) BETWEEN 1 AND 128),
  policy text NOT NULL CHECK (policy IN ('off', 'ask', 'free')),
  declaration_hash text,
  -- CAS token: every write mints a fresh revision; mutations must present
  -- the one they read (I5's optimistic-concurrency discipline).
  revision text NOT NULL,
  set_by jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, function_name)
);

CREATE INDEX agent_function_policies_user_idx
  ON public.agent_function_policies (user_id, app_id);

ALTER TABLE public.agent_function_policies ENABLE ROW LEVEL SECURITY;
