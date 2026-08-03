-- Pillar P4 (docs/POLICY_PILLAR_ARCHITECTURE.md §5, §6): compiled policy
-- versions. The owner's sentences compile (on THEIR model — I8, recorded)
-- into a schema-validated artifact of deterministic predicates; the owner
-- approves a code-rendered readback; the pair persists here immutably.
-- Rollback is forward re-approval of a prior artifact as a new version.
-- Readback is never stored — it re-renders deterministically from the
-- artifact, so it can never drift from what executes.

CREATE TABLE public.agent_policy_sets (
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  source jsonb NOT NULL DEFAULT '[]'::jsonb,
  artifact jsonb NOT NULL,
  compile_model text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, version)
);

CREATE INDEX agent_policy_sets_owner_idx
  ON public.agent_policy_sets (user_id, app_id, version DESC);

ALTER TABLE public.agent_policy_sets ENABLE ROW LEVEL SECURITY;

-- Immutability, precedent: prevent_app_release_mutation.
CREATE OR REPLACE FUNCTION public.prevent_policy_set_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'policy_set_is_immutable',
    DETAIL = jsonb_build_object(
      'code', 'POLICY_SET_IMMUTABLE',
      'appId', OLD.app_id,
      'version', OLD.version
    )::text;
END;
$$;

DROP TRIGGER IF EXISTS prevent_policy_set_mutation ON public.agent_policy_sets;
CREATE TRIGGER prevent_policy_set_mutation
  BEFORE UPDATE OR DELETE ON public.agent_policy_sets
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_policy_set_mutation();
