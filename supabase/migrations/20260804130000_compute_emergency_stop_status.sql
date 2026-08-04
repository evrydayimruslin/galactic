-- Minimal, service-role-only emergency-stop latch projection for rollout
-- preflights and reviewed release. It identifies the exact unreleased
-- operation and its aggregate progress while deliberately excluding operator
-- references, reasons, request hashes, target identities, and errors.

CREATE OR REPLACE FUNCTION public.get_compute_emergency_stop_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'schema_version', 1,
    'latch_state', COALESCE(operation.status, 'clear'),
    'operation_id', operation.id,
    'cutoff_at', operation.cutoff_at,
    'target_count', operation.target_count,
    'terminalized_count', operation.terminalized_count,
    'pending_target_count',
      operation.target_count - operation.terminalized_count,
    'created_at', operation.created_at,
    'updated_at', operation.updated_at,
    'completed_at', operation.completed_at
  )
  FROM (VALUES (true)) AS singleton(one)
  LEFT JOIN LATERAL (
      SELECT operation.id, operation.status, operation.cutoff_at,
             operation.target_count, operation.terminalized_count,
             operation.created_at, operation.updated_at,
             operation.completed_at
      FROM public.compute_emergency_stop_operations AS operation
      WHERE operation.status IN ('active', 'completed')
      LIMIT 1
  ) AS operation ON singleton.one;
$$;

REVOKE ALL ON FUNCTION public.get_compute_emergency_stop_status()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_compute_emergency_stop_status()
  TO service_role;

COMMENT ON FUNCTION public.get_compute_emergency_stop_status() IS
  'Returns sanitized global Compute emergency-stop latch identity and progress.';

-- The endpoint is needed immediately by rollout preflights after this
-- migration commits; do not depend on eventual PostgREST cache refresh.
NOTIFY pgrst, 'reload schema';
