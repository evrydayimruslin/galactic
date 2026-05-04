-- PR12: live app storage is authoritative and user storage moves by delta.
-- apps.storage_bytes represents the current live version only. Historical
-- non-live versions remain in R2/version metadata, but do not drive hourly
-- hosting billing until activated.

CREATE OR REPLACE FUNCTION "public"."set_app_storage_bytes"(
  "p_user_id" "uuid",
  "p_app_id" "uuid",
  "p_size_bytes" bigint
) RETURNS TABLE(
  "previous_bytes" bigint,
  "new_bytes" bigint,
  "delta_bytes" bigint,
  "user_storage_used_bytes" bigint
)
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public, extensions'
AS $$
DECLARE
  v_owner_id UUID;
BEGIN
  SELECT owner_id, COALESCE(storage_bytes, 0)
  INTO v_owner_id, previous_bytes
  FROM public.apps
  WHERE id = p_app_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'App % not found', p_app_id;
  END IF;

  IF v_owner_id <> p_user_id THEN
    RAISE EXCEPTION 'User % does not own app %', p_user_id, p_app_id;
  END IF;

  new_bytes := GREATEST(0::BIGINT, COALESCE(p_size_bytes, 0));
  delta_bytes := new_bytes - previous_bytes;

  UPDATE public.apps
  SET storage_bytes = new_bytes,
      updated_at = NOW()
  WHERE id = p_app_id;

  UPDATE public.users
  SET storage_used_bytes = GREATEST(0::BIGINT, COALESCE(storage_used_bytes, 0) + delta_bytes),
      updated_at = NOW()
  WHERE id = p_user_id
  RETURNING storage_used_bytes INTO user_storage_used_bytes;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User % not found', p_user_id;
  END IF;

  RETURN NEXT;
END;
$$;

ALTER FUNCTION "public"."set_app_storage_bytes"("p_user_id" "uuid", "p_app_id" "uuid", "p_size_bytes" bigint) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."record_upload_storage"(
  "p_user_id" "uuid",
  "p_app_id" "uuid",
  "p_version" "text",
  "p_size_bytes" bigint
) RETURNS "void"
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public, extensions'
AS $$
BEGIN
  PERFORM 1
  FROM public.set_app_storage_bytes(p_user_id, p_app_id, p_size_bytes);
END;
$$;

ALTER FUNCTION "public"."record_upload_storage"("p_user_id" "uuid", "p_app_id" "uuid", "p_version" "text", "p_size_bytes" bigint) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."reclaim_app_storage"(
  "p_user_id" "uuid",
  "p_app_id" "uuid"
) RETURNS bigint
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public, extensions'
AS $$
DECLARE
  v_owner_id UUID;
  v_reclaimed_bytes BIGINT;
BEGIN
  SELECT owner_id, COALESCE(storage_bytes, 0)
  INTO v_owner_id, v_reclaimed_bytes
  FROM public.apps
  WHERE id = p_app_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'App % not found', p_app_id;
  END IF;

  IF v_owner_id <> p_user_id THEN
    RAISE EXCEPTION 'User % does not own app %', p_user_id, p_app_id;
  END IF;

  UPDATE public.apps
  SET storage_bytes = 0,
      updated_at = NOW()
  WHERE id = p_app_id;

  UPDATE public.users
  SET storage_used_bytes = GREATEST(0::BIGINT, COALESCE(storage_used_bytes, 0) - v_reclaimed_bytes),
      updated_at = NOW()
  WHERE id = p_user_id;

  RETURN v_reclaimed_bytes;
END;
$$;

ALTER FUNCTION "public"."reclaim_app_storage"("p_user_id" "uuid", "p_app_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."reclaim_version_storage"(
  "p_user_id" "uuid",
  "p_app_id" "uuid",
  "p_version" "text"
) RETURNS bigint
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public, extensions'
AS $$
DECLARE
  v_current_version TEXT;
BEGIN
  SELECT current_version
  INTO v_current_version
  FROM public.apps
  WHERE id = p_app_id
    AND owner_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'App % not found for user %', p_app_id, p_user_id;
  END IF;

  IF v_current_version = p_version THEN
    RETURN public.reclaim_app_storage(p_user_id, p_app_id);
  END IF;

  RETURN 0;
END;
$$;

ALTER FUNCTION "public"."reclaim_version_storage"("p_user_id" "uuid", "p_app_id" "uuid", "p_version" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."reconcile_user_storage_bytes"(
  "p_user_id" "uuid"
) RETURNS bigint
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public, extensions'
AS $$
DECLARE
  v_total_bytes BIGINT;
BEGIN
  SELECT COALESCE(SUM(COALESCE(storage_bytes, 0)), 0)
  INTO v_total_bytes
  FROM public.apps
  WHERE owner_id = p_user_id
    AND deleted_at IS NULL;

  UPDATE public.users
  SET storage_used_bytes = v_total_bytes,
      updated_at = NOW()
  WHERE id = p_user_id;

  RETURN v_total_bytes;
END;
$$;

ALTER FUNCTION "public"."reconcile_user_storage_bytes"("p_user_id" "uuid") OWNER TO "postgres";

-- Normalize existing rows after the old additive upload accounting. Prefer
-- current-version metadata when present; otherwise keep the existing app size.
WITH current_version_sizes AS (
  SELECT
    a.id AS app_id,
    COALESCE(
      (
        SELECT CASE
          WHEN metadata.entry ->> 'size_bytes' ~ '^[0-9]+$'
            THEN (metadata.entry ->> 'size_bytes')::BIGINT
          ELSE 0::BIGINT
        END
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(a.version_metadata) = 'array' THEN a.version_metadata
            ELSE '[]'::JSONB
          END
        ) WITH ORDINALITY AS metadata(entry, ord)
        WHERE metadata.entry ->> 'version' = a.current_version
        ORDER BY metadata.ord DESC
        LIMIT 1
      ),
      COALESCE(a.storage_bytes, 0)
    ) AS size_bytes
  FROM public.apps a
)
UPDATE public.apps a
SET storage_bytes = GREATEST(0::BIGINT, current_version_sizes.size_bytes)
FROM current_version_sizes
WHERE a.id = current_version_sizes.app_id
  AND COALESCE(a.storage_bytes, 0) IS DISTINCT FROM GREATEST(0::BIGINT, current_version_sizes.size_bytes);

WITH reconciled_users AS (
  SELECT
    u.id AS user_id,
    COALESCE(SUM(COALESCE(a.storage_bytes, 0)), 0) AS total_storage_bytes
  FROM public.users u
  LEFT JOIN public.apps a
    ON a.owner_id = u.id
   AND a.deleted_at IS NULL
  GROUP BY u.id
)
UPDATE public.users u
SET storage_used_bytes = reconciled_users.total_storage_bytes
FROM reconciled_users
WHERE u.id = reconciled_users.user_id
  AND COALESCE(u.storage_used_bytes, 0) IS DISTINCT FROM reconciled_users.total_storage_bytes;

GRANT ALL ON FUNCTION "public"."set_app_storage_bytes"("p_user_id" "uuid", "p_app_id" "uuid", "p_size_bytes" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."set_app_storage_bytes"("p_user_id" "uuid", "p_app_id" "uuid", "p_size_bytes" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_app_storage_bytes"("p_user_id" "uuid", "p_app_id" "uuid", "p_size_bytes" bigint) TO "service_role";

GRANT ALL ON FUNCTION "public"."reclaim_app_storage"("p_user_id" "uuid", "p_app_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."reclaim_app_storage"("p_user_id" "uuid", "p_app_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reclaim_app_storage"("p_user_id" "uuid", "p_app_id" "uuid") TO "service_role";

GRANT ALL ON FUNCTION "public"."reclaim_version_storage"("p_user_id" "uuid", "p_app_id" "uuid", "p_version" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."reclaim_version_storage"("p_user_id" "uuid", "p_app_id" "uuid", "p_version" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reclaim_version_storage"("p_user_id" "uuid", "p_app_id" "uuid", "p_version" "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."reconcile_user_storage_bytes"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."reconcile_user_storage_bytes"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reconcile_user_storage_bytes"("p_user_id" "uuid") TO "service_role";
