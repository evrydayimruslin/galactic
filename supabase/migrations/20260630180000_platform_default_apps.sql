-- Platform default-install registry: the id-keyed set of Agents that NEW
-- accounts are seeded with at first sign-in. Replaces the name-matched
-- DEFAULT_APP_NAMES constant in api/services/request-auth.ts, which silently
-- seeded fewer apps whenever a name was renamed/missing and could match the
-- wrong row when display names collided.
--
-- FORWARD-ONLY model: this table governs only what FUTURE signups receive.
-- provisionDefaultApps reads it at account creation and writes user_app_library
-- rows (source='default'). Adding/removing a row changes future seeding only —
-- it never writes to existing users' libraries (there is no broadcast/backfill
-- primitive anywhere). Updating an already-installed default for everyone who
-- has it is ordinary app versioning (the live KV bundle), not a row here.
--
-- This is PLATFORM POLICY, not user data: service_role only (RLS on, no policy
-- for the public PostgREST roles). The owner curates it via the private
-- "Defaults Manager" agent -> /api/admin/internal/defaults (owner-actor gated).
CREATE TABLE IF NOT EXISTS "public"."platform_default_apps" (
  "app_id" "uuid" NOT NULL,
  -- Neutral provenance label shown on the seeded card (e.g. "Starter"). NOT a
  -- trust/verified signal — render it distinct from trust chips.
  "badge" "text",
  -- Display order of the seeded set (ascending).
  "position" integer NOT NULL DEFAULT 0,
  -- Disable without losing the row: stops FUTURE seeding; existing users keep
  -- theirs. removed_at is the soft-retire audit stamp.
  "enabled" boolean NOT NULL DEFAULT true,
  "removed_at" timestamp with time zone,
  -- Owner who added it (audit only).
  "added_by" "uuid",
  "added_at" timestamp with time zone NOT NULL DEFAULT "now"()
);

ALTER TABLE "public"."platform_default_apps" OWNER TO "postgres";

ALTER TABLE ONLY "public"."platform_default_apps"
  ADD CONSTRAINT "platform_default_apps_pkey" PRIMARY KEY ("app_id");

-- app_id is the stable identity (survives versions). If the underlying Agent is
-- hard-deleted, drop the registry row with it.
ALTER TABLE ONLY "public"."platform_default_apps"
  ADD CONSTRAINT "platform_default_apps_app_id_fkey"
  FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE CASCADE;

-- Seeding hot-path read: enabled, non-retired rows in display order.
CREATE INDEX IF NOT EXISTS "idx_platform_default_apps_active"
  ON "public"."platform_default_apps" ("position")
  WHERE "enabled" = true AND "removed_at" IS NULL;

-- Platform policy, not user data: lock the public PostgREST roles out entirely;
-- only service_role (which bypasses RLS) reads/writes it.
ALTER TABLE "public"."platform_default_apps" ENABLE ROW LEVEL SECURITY;
-- Defense in depth beyond RLS: explicitly strip the inherited baseline grants to
-- the public PostgREST roles, so a future permissive policy, an RLS-disable for a
-- backfill, or a view/matview over this table (matviews can't carry RLS) cannot
-- silently world-expose the curated set + added_by ids. Only service_role (which
-- bypasses RLS) reads/writes it.
REVOKE ALL ON TABLE "public"."platform_default_apps" FROM PUBLIC, "anon", "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."platform_default_apps" TO "service_role";

-- One-time bootstrap: seed the registry from the apps the legacy name-matched
-- constant targeted, resolved to ids HERE (once) so the runtime path is purely
-- id-keyed thereafter. Environment-tolerant: seeds whatever currently exists as
-- a live, installable (public/unlisted) Agent; if display names collide it picks
-- the most recent row per name; for a name with no qualifying app (e.g. an empty
-- staging DB) it simply seeds nothing — the migration never fails on absence.
INSERT INTO "public"."platform_default_apps" ("app_id", "position")
SELECT picked."id",
       array_position(
         ARRAY['Memory Wiki', 'email-ops', 'Private Tutor', 'Smart Budget', 'Recipe Box', 'Reading List'],
         picked."name"
       )
FROM (
  SELECT DISTINCT ON (a."name") a."id", a."name"
  FROM "public"."apps" a
  WHERE a."name" = ANY(
      ARRAY['Memory Wiki', 'email-ops', 'Private Tutor', 'Smart Budget', 'Recipe Box', 'Reading List']
    )
    AND a."deleted_at" IS NULL
    AND a."visibility" IN ('public', 'unlisted')
  ORDER BY a."name", a."created_at" DESC
) picked
ON CONFLICT ("app_id") DO NOTHING;
