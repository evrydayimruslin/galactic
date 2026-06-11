-- Cross-Agent call attribution on receipts (Phase 4c / P5).
--
-- Records which Agent INITIATED a call (caller_app_id) and the call-chain
-- depth, so the wiring UI can answer "which Agents used my functions" and the
-- operator can audit cross-Agent activity from the receipt ledger. Nullable
-- and additive — direct user calls leave caller_app_id null.

ALTER TABLE public.mcp_call_logs
  ADD COLUMN IF NOT EXISTS caller_app_id uuid,
  ADD COLUMN IF NOT EXISTS call_chain_depth integer;

CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_caller_app_id
  ON public.mcp_call_logs (caller_app_id)
  WHERE caller_app_id IS NOT NULL;
