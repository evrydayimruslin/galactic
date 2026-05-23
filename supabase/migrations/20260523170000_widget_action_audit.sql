ALTER TABLE public.mcp_call_logs
  ADD COLUMN IF NOT EXISTS widget_action boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS widget_surface_id text,
  ADD COLUMN IF NOT EXISTS widget_id text,
  ADD COLUMN IF NOT EXISTS widget_action_id text,
  ADD COLUMN IF NOT EXISTS widget_turn_id text;

CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_widget_action_time
  ON public.mcp_call_logs(widget_action_id, created_at DESC)
  WHERE widget_action = true;

CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_widget_turn
  ON public.mcp_call_logs(widget_turn_id)
  WHERE widget_turn_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_widget_surface_time
  ON public.mcp_call_logs(widget_surface_id, created_at DESC)
  WHERE widget_surface_id IS NOT NULL;
