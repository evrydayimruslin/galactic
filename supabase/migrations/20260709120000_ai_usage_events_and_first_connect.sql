-- Telemetry foundation for the platform-admin agent fleet (fix set 1 of 4):
--
-- 1) ai_usage_events — usage metadata for AI calls that produce NO economic
--    row today (BYOK / unbilled routes leave literally no trace, so model
--    popularity and model-per-function stats are blind to them). Deliberately
--    on a NON-economic path: nothing here ever feeds debit_light — recording
--    a BYOK call must never be able to charge a BYOK user.
--
-- 2) users.first_connected_at — set-once stamp written at the first MCP
--    initialize, closing the unmeasurable "connect" stage of the
--    signup→connect→install→deploy→paid funnel.
--
-- Data never recorded is unrecoverable, so these land ahead of the admin
-- agents that will consume them.

CREATE TABLE IF NOT EXISTS "public"."ai_usage_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() PRIMARY KEY,
    "user_id" "uuid" NOT NULL,
    -- App + function attribution (NULL for surfaces with no app context).
    "app_id" "uuid",
    "function_name" "text",
    "execution_id" "text",
    -- Route identity: which key served the call and why it was not billed.
    -- billing_mode 'byok' = user's own provider key; 'unbilled' = any other
    -- zero-debit route.
    "billing_mode" "text" NOT NULL DEFAULT 'byok',
    "provider" "text",
    "upstream_provider" "text",
    "key_source" "text",
    -- Model actually served (response model), plus what was requested.
    "model" "text" NOT NULL,
    "requested_model" "text",
    "prompt_tokens" integer NOT NULL DEFAULT 0,
    "completion_tokens" integer NOT NULL DEFAULT 0,
    "total_tokens" integer NOT NULL DEFAULT 0,
    -- Emitting code path ('runtime_ai_binding' | 'runtime_ai').
    "source" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_usage_events_billing_mode_check" CHECK (
        "billing_mode" IN ('byok', 'unbilled')
    ),
    CONSTRAINT "ai_usage_events_tokens_check" CHECK (
        "prompt_tokens" >= 0
        AND "completion_tokens" >= 0
        AND "total_tokens" >= 0
    )
);

-- Rollup shapes the model-usage analyst reads: per-model per-day, and
-- per-(app, function) per-day.
CREATE INDEX IF NOT EXISTS "idx_ai_usage_events_model_created"
    ON "public"."ai_usage_events" ("model", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_ai_usage_events_app_fn_created"
    ON "public"."ai_usage_events" ("app_id", "function_name", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_ai_usage_events_created"
    ON "public"."ai_usage_events" ("created_at" DESC);

-- Service-role only (RLS on, no policies) — same posture as the other
-- internal telemetry tables.
ALTER TABLE "public"."ai_usage_events" ENABLE ROW LEVEL SECURITY;

-- First MCP connect stamp. Set once (writer filters first_connected_at IS
-- NULL), so it is the immutable funnel timestamp, not a last-seen clock
-- (users.last_active_at already covers recency).
ALTER TABLE "public"."users"
    ADD COLUMN IF NOT EXISTS "first_connected_at" timestamp with time zone;
