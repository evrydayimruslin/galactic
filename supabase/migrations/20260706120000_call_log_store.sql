-- Call-log store: persist each call's captured console output (LogEntry[]) as
-- an R2 blob so developers can debug live incidents via gx.logs({ receipt_id }).
--
-- The receipt_id IS the mcp_call_logs row id, so the blob pointer rides the
-- existing per-call row. Blob bytes are debited against the app OWNER's
-- data-storage allowance via the existing adjust_data_storage RPC, and credited
-- back when the 7-day retention sweep deletes the blob — logs only ever occupy
-- a rolling window of the owner's allowance.

ALTER TABLE "public"."mcp_call_logs"
    ADD COLUMN IF NOT EXISTS "log_object_key" "text",
    ADD COLUMN IF NOT EXISTS "log_bytes" integer;

COMMENT ON COLUMN "public"."mcp_call_logs"."log_object_key" IS
    'R2 object key of the captured runtime console logs for this call (call-logs/{app_id}/{receipt_id}.json). NULL once swept or when nothing was captured.';
COMMENT ON COLUMN "public"."mcp_call_logs"."log_bytes" IS
    'Size of the stored log blob in bytes; debited against the app owner''s data-storage allowance while retained.';

-- The retention sweep scans only rows that still hold a blob.
CREATE INDEX IF NOT EXISTS "idx_mcp_call_logs_log_sweep"
    ON "public"."mcp_call_logs" ("created_at")
    WHERE "log_object_key" IS NOT NULL;
