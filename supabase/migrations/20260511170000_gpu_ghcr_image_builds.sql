-- GPU GHCR image build metadata.
-- Tracks platform-built per-app GPU images and build costs.

ALTER TABLE public.apps
  ADD COLUMN IF NOT EXISTS gpu_image_ref text,
  ADD COLUMN IF NOT EXISTS gpu_image_digest text,
  ADD COLUMN IF NOT EXISTS gpu_base_profile text,
  ADD COLUMN IF NOT EXISTS gpu_build_provider text,
  ADD COLUMN IF NOT EXISTS gpu_build_run_id text,
  ADD COLUMN IF NOT EXISTS gpu_build_cost_light double precision,
  ADD COLUMN IF NOT EXISTS gpu_build_started_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS gpu_build_finished_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS gpu_build_error text,
  ADD COLUMN IF NOT EXISTS gpu_image_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS gpu_image_user_storage_bytes bigint;

ALTER TABLE public.gpu_endpoints
  ADD COLUMN IF NOT EXISTS image_ref text,
  ADD COLUMN IF NOT EXISTS image_digest text,
  ADD COLUMN IF NOT EXISTS base_profile text,
  ADD COLUMN IF NOT EXISTS build_provider text,
  ADD COLUMN IF NOT EXISTS build_run_id text,
  ADD COLUMN IF NOT EXISTS build_cost_light double precision,
  ADD COLUMN IF NOT EXISTS image_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS image_user_storage_bytes bigint;

CREATE TABLE IF NOT EXISTS public.gpu_build_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  version text NOT NULL,
  provider text NOT NULL DEFAULT 'github_actions',
  run_id text,
  stage text NOT NULL,
  status text NOT NULL,
  message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gpu_build_events_app_version
  ON public.gpu_build_events(app_id, version, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gpu_build_events_run
  ON public.gpu_build_events(provider, run_id);

ALTER TABLE public.gpu_build_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gpu_build_events_owner_read" ON public.gpu_build_events;
CREATE POLICY "gpu_build_events_owner_read"
  ON public.gpu_build_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.apps a
      WHERE a.id = gpu_build_events.app_id
        AND a.owner_id = auth.uid()
    )
  );

GRANT ALL ON TABLE public.gpu_build_events TO service_role;
GRANT SELECT ON TABLE public.gpu_build_events TO authenticated;
