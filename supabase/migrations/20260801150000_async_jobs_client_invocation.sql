-- WO-1 (docs/AGENT_STUDIO_LAUNCH_WORK_ORDERS.md): caller-generated invocation
-- identity for durable jobs. A duplicate dispatch with the same
-- (app_id, client_invocation_id) must resolve to the EXISTING row instead of
-- creating a second execution — the unique index is the guard; the insert
-- path handles 23505 by returning the surviving row. Additive only; the
-- queue consumer never reads this column.

ALTER TABLE public.async_jobs
  ADD COLUMN IF NOT EXISTS client_invocation_id text
    CHECK (
      client_invocation_id IS NULL
      OR char_length(client_invocation_id) BETWEEN 8 AND 128
    );

CREATE UNIQUE INDEX IF NOT EXISTS async_jobs_client_invocation_idx
  ON public.async_jobs (app_id, client_invocation_id)
  WHERE client_invocation_id IS NOT NULL;
