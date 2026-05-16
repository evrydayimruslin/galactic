-- Public HTTP safety rails: route-scoped durable rate limiting and audit fields.

ALTER TABLE public.http_requests
  ADD COLUMN IF NOT EXISTS function_name text,
  ADD COLUMN IF NOT EXISTS identity_hash text,
  ADD COLUMN IF NOT EXISTS origin text,
  ADD COLUMN IF NOT EXISTS auth_state text,
  ADD COLUMN IF NOT EXISTS rate_limited boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS receipt_id uuid;

CREATE INDEX IF NOT EXISTS idx_http_requests_app_function_created
  ON public.http_requests (app_id, function_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_http_requests_identity_created
  ON public.http_requests (identity_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS public.http_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  function_name text NOT NULL,
  identity_hash text NOT NULL,
  window_start timestamp with time zone NOT NULL,
  window_seconds integer NOT NULL DEFAULT 60,
  request_count integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT http_rate_limits_window_seconds_positive CHECK (window_seconds > 0),
  CONSTRAINT http_rate_limits_request_count_nonnegative CHECK (request_count >= 0),
  CONSTRAINT http_rate_limits_key UNIQUE (
    app_id,
    function_name,
    identity_hash,
    window_start,
    window_seconds
  )
);

CREATE INDEX IF NOT EXISTS idx_http_rate_limits_cleanup
  ON public.http_rate_limits (window_start);

ALTER TABLE public.http_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.check_http_route_rate_limit(
  p_app_id uuid,
  p_function_name text,
  p_identity_hash text,
  p_limit integer,
  p_window_seconds integer DEFAULT 60
) RETURNS TABLE(
  allowed boolean,
  current_count integer,
  limit_count integer,
  remaining integer,
  reset_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
DECLARE
  v_window_seconds integer;
  v_window_start timestamp with time zone;
  v_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'p_limit must be at least 1';
  END IF;

  v_window_seconds := GREATEST(COALESCE(p_window_seconds, 60), 1);
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / v_window_seconds) * v_window_seconds
  );

  INSERT INTO public.http_rate_limits (
    app_id,
    function_name,
    identity_hash,
    window_start,
    window_seconds,
    request_count
  )
  VALUES (
    p_app_id,
    COALESCE(NULLIF(p_function_name, ''), 'handler'),
    p_identity_hash,
    v_window_start,
    v_window_seconds,
    1
  )
  ON CONFLICT (
    app_id,
    function_name,
    identity_hash,
    window_start,
    window_seconds
  )
  DO UPDATE SET
    request_count = public.http_rate_limits.request_count + 1,
    updated_at = now()
  RETURNING request_count INTO v_count;

  RETURN QUERY SELECT
    v_count <= p_limit AS allowed,
    v_count AS current_count,
    p_limit AS limit_count,
    GREATEST(p_limit - v_count, 0) AS remaining,
    v_window_start + (v_window_seconds || ' seconds')::interval AS reset_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_http_rate_limits()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.http_rate_limits
  WHERE window_start < now() - interval '2 days';

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

GRANT ALL ON TABLE public.http_rate_limits TO service_role;
GRANT EXECUTE ON FUNCTION public.check_http_route_rate_limit(uuid, text, text, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_http_rate_limits()
  TO service_role;
