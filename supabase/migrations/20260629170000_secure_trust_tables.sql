-- Lock the public PostgREST roles out of the trust signal tables shipped in the
-- two prior trust migrations. New postgres-owned public objects inherit
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon/authenticated (set in
-- the prod baseline), which — combined with the public schema being exposed over
-- PostgREST — would otherwise make these world-readable. Each carries per-actor
-- rows (user_id + outcome), so they must be backend-only, never a public API.

-- app_verifications (Phase 2): base table -> RLS + REVOKE.
ALTER TABLE public.app_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_verifications FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.app_verifications TO service_role;

-- app_health_windows (Phase 1): a materialized view. RLS is not supported on
-- matviews, so REVOKE is the lockout. Only the derived green/red/no_data ever
-- leaves the backend (via getAppHealth using the service key); the raw counts
-- must not be public.
REVOKE ALL ON public.app_health_windows FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.app_health_windows TO service_role;
