-- PR20: per-function external-agent execution policy.
-- Account/manual website runs bypass this gate; API tokens and routine actors use it.

CREATE TABLE IF NOT EXISTS public.user_agent_permission_defaults (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  default_policy text NOT NULL DEFAULT 'ask'
    CHECK (default_policy IN ('always', 'ask', 'never')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_agent_function_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  function_name text NOT NULL,
  policy text NOT NULL CHECK (policy IN ('always', 'ask', 'never')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, app_id, function_name)
);

CREATE INDEX IF NOT EXISTS idx_user_agent_function_permissions_user_app
  ON public.user_agent_function_permissions(user_id, app_id);

CREATE OR REPLACE FUNCTION public.touch_agent_function_permissions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS touch_user_agent_permission_defaults_updated_at
  ON public.user_agent_permission_defaults;
CREATE TRIGGER touch_user_agent_permission_defaults_updated_at
  BEFORE UPDATE ON public.user_agent_permission_defaults
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_agent_function_permissions_updated_at();

DROP TRIGGER IF EXISTS touch_user_agent_function_permissions_updated_at
  ON public.user_agent_function_permissions;
CREATE TRIGGER touch_user_agent_function_permissions_updated_at
  BEFORE UPDATE ON public.user_agent_function_permissions
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_agent_function_permissions_updated_at();

ALTER TABLE public.user_agent_permission_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_agent_function_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own agent permission default"
  ON public.user_agent_permission_defaults;
CREATE POLICY "Users manage own agent permission default"
  ON public.user_agent_permission_defaults
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users manage own agent function permissions"
  ON public.user_agent_function_permissions;
CREATE POLICY "Users manage own agent function permissions"
  ON public.user_agent_function_permissions
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT ALL ON TABLE public.user_agent_permission_defaults TO service_role;
GRANT ALL ON TABLE public.user_agent_function_permissions TO service_role;
GRANT EXECUTE ON FUNCTION public.touch_agent_function_permissions_updated_at()
  TO service_role;
