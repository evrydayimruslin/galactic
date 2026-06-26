-- Per-(installer-user, app, function) inference override for galactic.ai().
-- The user who has an Agent can pin, per function, the provider (Galactic AI =
-- platform credits, or one of their own BYOK providers) and a model slug.
-- Absence of a row => no override => the ai-binding.ts fallback chain applies
-- (dev per-call model > user global platform model > deepseek-v4).

CREATE TABLE IF NOT EXISTS public.user_function_inference_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  function_name text NOT NULL,
  billing_mode text NOT NULL CHECK (billing_mode IN ('light', 'byok')),
  -- null for the Galactic-AI (light) case; a BYOK provider id otherwise.
  provider text NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (billing_mode <> 'byok' OR provider IS NOT NULL),
  UNIQUE (user_id, app_id, function_name)
);

CREATE INDEX IF NOT EXISTS idx_user_function_inference_overrides_user_app
  ON public.user_function_inference_overrides(user_id, app_id);

-- Reuse the touch-updated-at trigger fn shipped by the agent-function-permissions
-- migration (20260606150000); no need to redefine it.
DROP TRIGGER IF EXISTS touch_user_function_inference_overrides_updated_at
  ON public.user_function_inference_overrides;
CREATE TRIGGER touch_user_function_inference_overrides_updated_at
  BEFORE UPDATE ON public.user_function_inference_overrides
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_agent_function_permissions_updated_at();

ALTER TABLE public.user_function_inference_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own function inference overrides"
  ON public.user_function_inference_overrides;
CREATE POLICY "Users manage own function inference overrides"
  ON public.user_function_inference_overrides
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT ALL ON TABLE public.user_function_inference_overrides TO service_role;
