-- Fix malformed function search_path across the public schema.
--
-- Many functions were created with `SET search_path TO 'public, extensions'`
-- — ONE quoted identifier containing a comma — instead of the two schemas
-- `public, extensions`. Under that config every UNQUALIFIED table reference
-- inside the function resolves against a schema literally named
-- "public, extensions" and fails with `relation ... does not exist`
-- (discovered via check_rate_limit, whose unqualified `rate_limits` insert
-- made every fail-closed usage gate report "Usage controls are temporarily
-- unavailable"). Functions that fully qualify their references worked by
-- accident.
--
-- Idempotent: re-altering an already-correct function is a no-op in effect.

DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proconfig::text LIKE '%public, extensions%'
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path = public, extensions',
      fn.signature
    );
  END LOOP;
END $$;
