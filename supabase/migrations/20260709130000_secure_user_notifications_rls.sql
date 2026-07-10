-- Lock down user_notifications (created in 20260517150000 WITHOUT RLS or
-- REVOKE — the only internal table missing them). Under the schema's default
-- grants the owner's alert inbox was plausibly readable AND writable via
-- PostgREST with the anon key: readable = every user's notification titles
-- and bodies; writable = spam/phishing into a trusted UI surface, plus
-- mark-read tampering that could silently suppress critical alerts
-- (routine_paused is the fleet's dead-man's switch).
--
-- All legitimate access goes through the API Worker with the service role
-- (api/services/notifications.ts; GET/PATCH /api/launch/notifications), which
-- bypasses RLS — so this is a pure lockdown, zero code changes. Prerequisite
-- for making notifications an agent-writable reporting channel.

ALTER TABLE "public"."user_notifications" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."user_notifications" FROM "anon", "authenticated";

GRANT ALL ON TABLE "public"."user_notifications" TO "service_role";
