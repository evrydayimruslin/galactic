-- WO-F5 PR A: unversioned policy drafts.
--
-- gx.policy lets a coding agent PROPOSE a natural-language boundary and
-- ATTACH the pre-compiled starter template, but ratification is the
-- owner's voice forever: immutable agent_policy_sets versions still mint
-- only through the owner readback-approve flow. Drafts are the parking
-- lane between an agent's proposal and that owner act — unversioned,
-- attributed, and free to discard.

CREATE TABLE public.agent_policy_drafts (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  sentence text NOT NULL CHECK (char_length(sentence) BETWEEN 1 AND 2000),
  -- Non-null when the draft records a starter-template attachment (the
  -- overlay rows it wrote are the enforcement; this row is the provenance).
  template text CHECK (template IS NULL OR char_length(template) <= 128),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Who proposed: auth source + surface, mirroring set_by discipline.
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'dismissed', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_policy_drafts_app_idx
  ON public.agent_policy_drafts (app_id, created_at DESC);
CREATE INDEX agent_policy_drafts_user_idx
  ON public.agent_policy_drafts (user_id, created_at DESC);

ALTER TABLE public.agent_policy_drafts ENABLE ROW LEVEL SECURITY;
-- Service-role only: reads/writes go through owned routes and gx.policy.
