-- PR11: storage thresholds are soft billing caps, not product hard quotas.
-- Keep the existing RPC shape for API compatibility, but always allow writes.

CREATE OR REPLACE FUNCTION "public"."check_data_storage_quota"(
  "p_user_id" "uuid",
  "p_additional_bytes" bigint
) RETURNS TABLE(
  "allowed" boolean,
  "source_used_bytes" bigint,
  "data_used_bytes" bigint,
  "combined_used_bytes" bigint,
  "limit_bytes" bigint,
  "remaining_bytes" bigint,
  "has_hosting_balance" boolean
)
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public, extensions'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    TRUE AS allowed,
    u.storage_used_bytes AS source_used_bytes,
    u.data_storage_used_bytes AS data_used_bytes,
    (u.storage_used_bytes + u.data_storage_used_bytes) AS combined_used_bytes,
    u.storage_limit_bytes AS limit_bytes,
    GREATEST(0::BIGINT, u.storage_limit_bytes - u.storage_used_bytes - u.data_storage_used_bytes) AS remaining_bytes,
    (COALESCE(u.balance_light, 0) > 0) AS has_hosting_balance
  FROM public.users u
  WHERE u.id = p_user_id;
END;
$$;
