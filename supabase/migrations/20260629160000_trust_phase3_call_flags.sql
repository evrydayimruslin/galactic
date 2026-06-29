-- Phase 3 trust signal: receipt-verified post-call outcome flags.
--
-- gx.flag lets a caller report whether a call did what the function's description
-- promised, tied to the call's receipt_id (= mcp_call_logs.id). Proof-of-use: a
-- flag is only accepted for a REAL, recent call the flagger actually made and
-- does not own. One flag per receipt (UNIQUE) bounds the table and stops a single
-- caller double-counting. This is a RANKING signal only (Phase 4) — never shown
-- as a public, per-rater human review (FTC fake-review rule).
CREATE TABLE IF NOT EXISTS public.app_call_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The call receipt this flag attests to. UNIQUE => one outcome per call.
  receipt_id uuid NOT NULL UNIQUE,
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  -- Binary, not 5-star: did the function behave as described?
  status text NOT NULL CHECK (status IN ('positive', 'negative')),
  -- Optional short note — ranking signal only, never rendered as a review.
  note text,
  -- Tier weight (a paid caller's flag weighs more than a provisional one), so
  -- distinct-identity Sybil farming costs more.
  weight real NOT NULL DEFAULT 1,
  function_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_call_flags_app
  ON public.app_call_flags (app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_call_flags_app_status
  ON public.app_call_flags (app_id, status);

-- Internal table: only the backend (service_role) ever touches it. Lock out the
-- public PostgREST roles so per-rater rows (user_id, status, note) can never be
-- read through the anon/authenticated API — they are a ranking signal, NEVER a
-- public per-rater review (FTC fake-review rule).
ALTER TABLE public.app_call_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_call_flags FROM PUBLIC, anon, authenticated;
ALTER TABLE public.app_call_flags OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE ON TABLE public.app_call_flags TO service_role;
