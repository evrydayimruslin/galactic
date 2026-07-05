-- Append-only audit log for the disclosed support data-read (PR 5).
--
-- Every time an app owner reads OTHER users' rows via the disclosed
-- `data:support_read` capability, one row is written here BEFORE the data is
-- returned (fail-closed). This is a compliance trail, so it is genuinely
-- append-only: a BEFORE UPDATE/DELETE trigger raises, because every service
-- write uses the service-role key which bypasses RLS.

CREATE TABLE IF NOT EXISTS "public"."support_data_access_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() PRIMARY KEY,
    -- The developer (app owner) who read the data.
    "accessor_user_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    -- 'support_read' today; reserved for future disclosed data actions.
    "action" "text" NOT NULL,
    "table_name" "text",
    "row_count" integer,
    "reason" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

-- Owner-facing "who read my data" and per-developer views both index on time.
CREATE INDEX IF NOT EXISTS "idx_support_data_access_log_app_created"
    ON "public"."support_data_access_log" ("app_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_support_data_access_log_accessor_created"
    ON "public"."support_data_access_log" ("accessor_user_id", "created_at" DESC);

-- Genuine append-only: block UPDATE and DELETE at the row level.
CREATE OR REPLACE FUNCTION "public"."support_data_access_log_append_only"()
RETURNS "trigger" LANGUAGE "plpgsql" AS $$
BEGIN
    RAISE EXCEPTION 'support_data_access_log is append-only';
END;
$$;

DROP TRIGGER IF EXISTS "support_data_access_log_no_mutate"
    ON "public"."support_data_access_log";
CREATE TRIGGER "support_data_access_log_no_mutate"
    BEFORE UPDATE OR DELETE ON "public"."support_data_access_log"
    FOR EACH ROW EXECUTE FUNCTION "public"."support_data_access_log_append_only"();

ALTER TABLE "public"."support_data_access_log" ENABLE ROW LEVEL SECURITY;
