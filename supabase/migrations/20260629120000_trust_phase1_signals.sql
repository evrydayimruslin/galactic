-- Phase 1 trust signals: per-app binary health windows + Stripe Connect identity.

-- ── Health: paid, non-self call success over 1h / 24h / 7d / 30d windows ──
-- Excludes owner/self calls (a.owner_id <> l.user_id) and free / zero-charge
-- calls (call_charge_light > 0). It ALSO records the number of DISTINCT paying
-- identities per window (payers_*): a window only earns "green" once enough
-- distinct non-owner payers exist, which raises the cost of the second-account
-- self-funded "fake green" sybil (a single sock-puppet payer no longer suffices).
-- Raw counts are withheld from public roles (granted to service_role only); the
-- binary green / red / no_data verdict is derived in the read layer so the
-- thresholds + floors are tunable without a re-refresh.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.app_health_windows AS
SELECT
  l.app_id,
  count(*) FILTER (WHERE l.created_at > now() - interval '1 hour')   AS calls_1h,
  count(*) FILTER (WHERE l.created_at > now() - interval '1 hour'   AND l.success = true) AS ok_1h,
  count(DISTINCT l.user_id) FILTER (WHERE l.created_at > now() - interval '1 hour')   AS payers_1h,
  count(*) FILTER (WHERE l.created_at > now() - interval '24 hours') AS calls_24h,
  count(*) FILTER (WHERE l.created_at > now() - interval '24 hours' AND l.success = true) AS ok_24h,
  count(DISTINCT l.user_id) FILTER (WHERE l.created_at > now() - interval '24 hours') AS payers_24h,
  count(*) FILTER (WHERE l.created_at > now() - interval '7 days')   AS calls_7d,
  count(*) FILTER (WHERE l.created_at > now() - interval '7 days'   AND l.success = true) AS ok_7d,
  count(DISTINCT l.user_id) FILTER (WHERE l.created_at > now() - interval '7 days')   AS payers_7d,
  count(*) FILTER (WHERE l.created_at > now() - interval '30 days')  AS calls_30d,
  count(*) FILTER (WHERE l.created_at > now() - interval '30 days'  AND l.success = true) AS ok_30d,
  count(DISTINCT l.user_id) FILTER (WHERE l.created_at > now() - interval '30 days')  AS payers_30d
FROM public.mcp_call_logs l
JOIN public.apps a ON a.id = l.app_id AND a.owner_id <> l.user_id
WHERE l.created_at > now() - interval '30 days'
  AND l.success IS NOT NULL
  AND coalesce(l.call_charge_light, 0) > 0
GROUP BY l.app_id
WITH NO DATA;

-- Required for REFRESH ... CONCURRENTLY (the cron path).
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_health_windows_app
  ON public.app_health_windows (app_id);

-- Refresh entry point. The view is created WITH NO DATA and is intentionally NOT
-- populated inside this migration — a non-concurrent 30-day scan inside the
-- db-push transaction risks a statement/lock timeout that aborts the whole
-- deploy. Instead the cron-invoked RPC populates it: CONCURRENTLY requires an
-- already-populated view, so the FIRST call (still empty) does a plain refresh
-- and every subsequent call refreshes CONCURRENTLY. Until the first refresh
-- lands the read layer simply sees no rows and degrades to "no_data".
CREATE OR REPLACE FUNCTION public.refresh_app_health() RETURNS void
  LANGUAGE plpgsql
  SET search_path TO 'public, extensions'
  AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_matviews
    WHERE schemaname = 'public'
      AND matviewname = 'app_health_windows'
      AND ispopulated
  ) THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.app_health_windows;
  ELSE
    REFRESH MATERIALIZED VIEW public.app_health_windows;
  END IF;
END;
$$;

-- Explicit ownership for parity with the proven refresh_gpu_reliability pattern:
-- REFRESH MATERIALIZED VIEW requires the executing context to own the matview.
-- On db push (run as postgres) both are implicitly postgres-owned, but pinning
-- it keeps the privilege assumption correct under any apply role.
ALTER MATERIALIZED VIEW public.app_health_windows OWNER TO postgres;
ALTER FUNCTION public.refresh_app_health() OWNER TO postgres;

GRANT ALL ON FUNCTION public.refresh_app_health() TO service_role;
GRANT SELECT ON public.app_health_windows TO service_role;

-- ── Identity: store the FULL Stripe Connect snapshot (internal) + a strict,
-- derived, PUBLIC verification boolean ──
-- stripe_connect_snapshot keeps the maximum Connect data (requirements,
-- verification, capabilities, business_profile, …) for internal use — NEVER
-- serialized to a public trust card. stripe_connect_verified is the ONLY
-- identity signal that leaves the backend: true iff payouts are enabled AND the
-- account has no outstanding/overdue requirements and no disabled_reason — i.e.
-- payable AND in good standing, not merely nominally payouts-enabled.
-- stripe_connect_synced_at lets the read layer fail closed (unverified) on a
-- stale snapshot; an hourly reconcile cron keeps it fresh for connected sellers.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS stripe_connect_snapshot jsonb;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS stripe_connect_synced_at timestamptz;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS stripe_connect_verified boolean NOT NULL DEFAULT false;

-- The account.updated webhook and the reconcile cron both filter users by their
-- Connect account id; without this index each write is a sequential scan that
-- grows with the users table (and now also rewrites a large jsonb snapshot).
CREATE INDEX IF NOT EXISTS idx_users_stripe_connect_account_id
  ON public.users (stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;
