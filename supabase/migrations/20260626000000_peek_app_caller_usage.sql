-- Free Mode Phase 3 (docs/FREE_MODE_DESIGN.md): read-only peek of a caller's
-- free-allowance counters for one app.
--
-- Discovery (tools/list + inspect) uses this to surface priced functions that
-- are *still free for this caller* — i.e. the developer's free-call allowance
-- has headroom left. Without it, discovery conservatively hides every priced
-- function (the Phase-2 behaviour), diverging from what the Phase-1 hold gate
-- would actually let the caller run for free. This aligns the two.
--
-- Strictly read-only: no INSERT/UPDATE, no side effects. STABLE so the planner
-- can treat it as side-effect-free. SECURITY DEFINER + a pinned search_path so
-- the service role can read the row regardless of RLS on app_caller_usage.
CREATE OR REPLACE FUNCTION public.peek_app_caller_usage(
  p_app_id uuid,
  p_user_id uuid
)
RETURNS TABLE (counter_key text, call_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
  SELECT u.counter_key, u.call_count
  FROM public.app_caller_usage AS u
  WHERE u.app_id = p_app_id
    AND u.user_id = p_user_id;
$$;

-- Callable only via the service role (the API's PostgREST client), never by
-- anon/authenticated end users directly.
REVOKE ALL ON FUNCTION public.peek_app_caller_usage(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.peek_app_caller_usage(uuid, uuid)
  TO service_role;
