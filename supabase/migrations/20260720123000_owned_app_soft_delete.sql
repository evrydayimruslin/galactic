-- Linearizable app deletion for service-role callers.
--
-- API authorization and Compute body destruction necessarily happen before
-- this transaction. Locking and re-checking the exact live owner here makes
-- this function the deletion linearization point, so an ownership transfer
-- cannot race a stale service-role PATCH. Storage accounting moves in the same
-- transaction and the Compute app lifecycle trigger remains the final wall.

CREATE OR REPLACE FUNCTION public.soft_delete_owned_app(
  p_user_id uuid,
  p_app_id uuid,
  p_deleted_at timestamptz DEFAULT now()
) RETURNS TABLE (
  deleted boolean,
  reclaimed_bytes bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_reclaimed_bytes bigint;
BEGIN
  IF p_user_id IS NULL OR p_app_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE =
      'p_user_id and p_app_id are required';
  END IF;

  SELECT COALESCE(app.storage_bytes, 0)
  INTO v_reclaimed_bytes
  FROM public.apps AS app
  WHERE app.id = p_app_id
    AND app.owner_id = p_user_id
    AND app.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0::bigint;
    RETURN;
  END IF;

  -- User deletion owns the user row first and some legacy CASCADE triggers
  -- bump app rows. We already own the app row, so never wait in the inverse
  -- direction: fail with a retryable serialization error and release the app.
  BEGIN
    PERFORM 1
    FROM public.users AS owner
    WHERE owner.id = p_user_id
    FOR NO KEY UPDATE NOWAIT;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE =
        'App owner no longer exists';
    END IF;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE =
      'App owner lifecycle is concurrent with soft deletion; retry';
  END;

  UPDATE public.apps AS app
  SET deleted_at = COALESCE(p_deleted_at, now()),
      storage_bytes = 0,
      updated_at = now()
  WHERE app.id = p_app_id
    AND app.owner_id = p_user_id
    AND app.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE =
      'App ownership changed during soft deletion';
  END IF;

  UPDATE public.users AS owner
  SET storage_used_bytes = GREATEST(
        0::bigint,
        COALESCE(owner.storage_used_bytes, 0) - v_reclaimed_bytes
      ),
      updated_at = now()
  WHERE owner.id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE =
      'App owner no longer exists';
  END IF;

  RETURN QUERY SELECT true, v_reclaimed_bytes;
END;
$$;

REVOKE ALL ON FUNCTION public.soft_delete_owned_app(
  uuid, uuid, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.soft_delete_owned_app(
  uuid, uuid, timestamptz
) TO service_role;
