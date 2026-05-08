-- Command dashboard runtime state.
-- Stores the user's pinned command-card layout independently from the desktop shell.

CREATE TABLE IF NOT EXISTS public.user_command_dashboard_layouts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  dashboard_key text DEFAULT 'command_home'::text NOT NULL,
  title text DEFAULT 'Command Home'::text NOT NULL,
  description text,
  icon text,
  sort_order integer DEFAULT 0 NOT NULL,
  is_default boolean DEFAULT false NOT NULL,
  layout jsonb DEFAULT '{"dashboard_key":"command_home","cards":[]}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone
);

ALTER TABLE public.user_command_dashboard_layouts OWNER TO postgres;

ALTER TABLE ONLY public.user_command_dashboard_layouts
  ADD CONSTRAINT user_command_dashboard_layouts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_command_dashboard_layouts
  ADD CONSTRAINT user_command_dashboard_layouts_user_key_unique UNIQUE (user_id, dashboard_key);

ALTER TABLE ONLY public.user_command_dashboard_layouts
  ADD CONSTRAINT user_command_dashboard_layouts_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_user_command_dashboard_layouts_user
  ON public.user_command_dashboard_layouts USING btree (user_id, dashboard_key);

CREATE INDEX IF NOT EXISTS idx_user_command_dashboard_layouts_catalog
  ON public.user_command_dashboard_layouts USING btree (user_id, deleted_at, sort_order, dashboard_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_command_dashboard_layouts_default
  ON public.user_command_dashboard_layouts USING btree (user_id)
  WHERE is_default AND deleted_at IS NULL;

ALTER TABLE public.user_command_dashboard_layouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_command_dashboard_layouts_own"
  ON public.user_command_dashboard_layouts
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT ALL ON TABLE public.user_command_dashboard_layouts TO anon;
GRANT ALL ON TABLE public.user_command_dashboard_layouts TO authenticated;
GRANT ALL ON TABLE public.user_command_dashboard_layouts TO service_role;
