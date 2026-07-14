-- Atomically merge tenant-editable routine metadata while preserving runtime
-- accounting, approval provenance, and launch-source markers owned by Galactic.

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_routines_one_launch_primary
  ON public.user_routines (user_id, composer_app_id)
  WHERE deleted_at IS NULL
    AND composer_app_id IS NOT NULL
    -- Index only rows stamped by the new server-owned launch path. Historical
    -- ul.routine rows may contain duplicates; indexing all of them would make
    -- this migration abort instead of preserving the existing data. The
    -- runtime precheck still treats every existing row for an Agent as a
    -- conflict, while this marker closes the concurrent-create race for new
    -- launch-primary rows.
    AND metadata->>'launch_primary' = 'true';

CREATE OR REPLACE FUNCTION public.merge_routine_user_metadata(
  p_routine_id uuid,
  p_user_id uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS SETOF public.user_routines
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_safe jsonb;
BEGIN
  SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
    INTO v_safe
  FROM jsonb_each(COALESCE(p_metadata, '{}'::jsonb)) AS entry
  WHERE entry.key NOT IN (
      'budget_spend',
      'auto_pause',
      'source',
      'launch_primary'
    )
    AND entry.key !~ '^(approval_|approved_)';

  RETURN QUERY
  UPDATE public.user_routines AS routines
  SET metadata = COALESCE(routines.metadata, '{}'::jsonb) || v_safe,
      updated_at = now()
  WHERE routines.id = p_routine_id
    AND routines.user_id = p_user_id
    AND routines.deleted_at IS NULL
  RETURNING routines.*;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_routine_user_metadata(uuid, uuid, jsonb)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_routine_user_metadata(uuid, uuid, jsonb)
  TO service_role;
