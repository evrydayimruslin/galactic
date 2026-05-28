-- Saved generated agentic interfaces.
-- Kept separate from card-only Command dashboard layouts so the dashboard
-- table remains strictly shaped around pinned command cards.

CREATE TABLE IF NOT EXISTS public.user_agentic_interfaces (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  interface_key text NOT NULL,
  title text NOT NULL,
  description text,
  icon text,
  spec jsonb NOT NULL,
  source_prompt text,
  mode text DEFAULT 'saved'::text NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone
);

ALTER TABLE public.user_agentic_interfaces OWNER TO postgres;

ALTER TABLE ONLY public.user_agentic_interfaces
  ADD CONSTRAINT user_agentic_interfaces_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_agentic_interfaces
  ADD CONSTRAINT user_agentic_interfaces_user_key_unique UNIQUE (user_id, interface_key);

ALTER TABLE ONLY public.user_agentic_interfaces
  ADD CONSTRAINT user_agentic_interfaces_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_agentic_interfaces
  ADD CONSTRAINT user_agentic_interfaces_mode_check
  CHECK (mode = 'saved');

ALTER TABLE ONLY public.user_agentic_interfaces
  ADD CONSTRAINT user_agentic_interfaces_status_check
  CHECK (status IN ('active', 'archived'));

CREATE INDEX IF NOT EXISTS idx_user_agentic_interfaces_user
  ON public.user_agentic_interfaces USING btree (user_id, interface_key);

CREATE INDEX IF NOT EXISTS idx_user_agentic_interfaces_catalog
  ON public.user_agentic_interfaces USING btree (user_id, deleted_at, updated_at DESC, interface_key);

ALTER TABLE public.user_agentic_interfaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_agentic_interfaces_own"
  ON public.user_agentic_interfaces
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT ALL ON TABLE public.user_agentic_interfaces TO anon;
GRANT ALL ON TABLE public.user_agentic_interfaces TO authenticated;
GRANT ALL ON TABLE public.user_agentic_interfaces TO service_role;
