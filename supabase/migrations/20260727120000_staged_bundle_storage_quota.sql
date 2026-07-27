-- Bounded, owner-scoped physical storage for Builder staged bundles.
--
-- R2 blobs are content-addressed and shared by an owner's manifests. Each
-- successful admission creates an opaque reservation claim over the immutable
-- objects it references. This lets a failed publisher release only its own
-- claim without shortening or deleting pre-existing/concurrent claims.

CREATE TABLE public.staged_bundle_storage_objects (
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  object_id text NOT NULL,
  size_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, object_id),
  CONSTRAINT staged_bundle_storage_object_id_check CHECK (
    object_id ~ '^(blob:[0-9a-f]{64}|manifest:gxb1_[0-9a-f]{64})$'
  ),
  CONSTRAINT staged_bundle_storage_size_check CHECK (size_bytes >= 0)
);

CREATE TABLE public.staged_bundle_storage_reservations (
  owner_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  object_id text NOT NULL,
  retained_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, reservation_id, object_id),
  CONSTRAINT staged_bundle_storage_reservation_object_fkey
    FOREIGN KEY (owner_id, object_id)
    REFERENCES public.staged_bundle_storage_objects(owner_id, object_id)
    ON DELETE CASCADE,
  CONSTRAINT staged_bundle_storage_reservation_retention_check CHECK (
    retained_until > created_at
  )
);

CREATE INDEX staged_bundle_storage_reservations_expiry_idx
  ON public.staged_bundle_storage_reservations (retained_until);
CREATE INDEX staged_bundle_storage_reservations_object_idx
  ON public.staged_bundle_storage_reservations (owner_id, object_id);

ALTER TABLE public.staged_bundle_storage_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staged_bundle_storage_reservations ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.reserve_staged_bundle_storage(
  p_owner_id uuid,
  p_reservation_id uuid,
  p_objects jsonb,
  p_retained_until timestamptz,
  p_limit_bytes bigint,
  p_limit_objects integer
) RETURNS TABLE (
  reservation_id uuid,
  allowed boolean,
  used_bytes bigint,
  reserved_bytes bigint,
  projected_bytes bigint,
  limit_bytes bigint,
  remaining_bytes bigint,
  used_objects bigint,
  reserved_objects bigint,
  projected_objects bigint,
  limit_objects integer,
  remaining_objects bigint,
  retained_until timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_object_count integer;
  v_distinct_count integer;
  v_used_bytes bigint;
  v_reserved_bytes bigint;
  v_projected_bytes bigint;
  v_used_objects bigint;
  v_reserved_objects bigint;
  v_projected_objects bigint;
BEGIN
  IF p_owner_id IS NULL
     OR p_reservation_id IS NULL
     OR p_objects IS NULL
     OR jsonb_typeof(p_objects) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'STAGED_BUNDLE_STORAGE_ADMISSION_INVALID',
      'message', 'Staged bundle storage admission is invalid.'
    )::text;
  END IF;
  IF jsonb_array_length(p_objects) NOT BETWEEN 2 AND 51
     OR p_retained_until IS NULL
     OR p_retained_until <= v_now
     OR p_retained_until > v_now + interval '9 days'
     OR p_limit_bytes IS NULL
     OR p_limit_bytes NOT BETWEEN 1 AND 1099511627776
     OR p_limit_objects IS NULL
     OR p_limit_objects NOT BETWEEN 1 AND 1000000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'STAGED_BUNDLE_STORAGE_ADMISSION_INVALID',
      'message', 'Staged bundle storage admission is invalid.'
    )::text;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_objects) AS requested(value)
    WHERE jsonb_typeof(requested.value) IS DISTINCT FROM 'object'
      OR jsonb_typeof(requested.value->'object_id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(requested.value->'size_bytes') IS DISTINCT FROM 'number'
      OR requested.value->>'object_id'
        !~ '^(blob:[0-9a-f]{64}|manifest:gxb1_[0-9a-f]{64})$'
      OR requested.value->>'size_bytes' !~ '^[0-9]+$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'STAGED_BUNDLE_STORAGE_OBJECT_INVALID',
      'message', 'Staged bundle storage objects are invalid.'
    )::text;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_objects) AS requested(value)
    WHERE (requested.value->>'size_bytes')::numeric > 1099511627776
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'STAGED_BUNDLE_STORAGE_OBJECT_INVALID',
      'message', 'Staged bundle storage object size is invalid.'
    )::text;
  END IF;

  SELECT count(*), count(DISTINCT requested.value->>'object_id')
  INTO v_object_count, v_distinct_count
  FROM jsonb_array_elements(p_objects) AS requested(value);
  IF v_object_count IS DISTINCT FROM v_distinct_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'STAGED_BUNDLE_STORAGE_OBJECT_DUPLICATE',
      'message', 'Staged bundle storage object identities must be unique.'
    )::text;
  END IF;

  -- Serialize reservation, release, and expiry mutation for one owner.
  PERFORM 1
  FROM public.users AS owner
  WHERE owner.id = p_owner_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', DETAIL = jsonb_build_object(
      'code', 'STAGED_BUNDLE_STORAGE_OWNER_NOT_FOUND',
      'message', 'Staged bundle owner was not found.'
    )::text;
  END IF;

  DELETE FROM public.staged_bundle_storage_reservations AS reservation
  WHERE reservation.owner_id = p_owner_id
    AND reservation.retained_until <= v_now;

  DELETE FROM public.staged_bundle_storage_objects AS stored
  WHERE stored.owner_id = p_owner_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.staged_bundle_storage_reservations AS reservation
      WHERE reservation.owner_id = stored.owner_id
        AND reservation.object_id = stored.object_id
    );

  -- A token may be retried after an ambiguous network response, but it may
  -- never be reused for a different set of immutable objects.
  IF EXISTS (
    SELECT 1
    FROM public.staged_bundle_storage_reservations AS reservation
    WHERE reservation.owner_id = p_owner_id
      AND reservation.reservation_id = p_reservation_id
  ) AND (
    (
      SELECT count(*)
      FROM public.staged_bundle_storage_reservations AS reservation
      WHERE reservation.owner_id = p_owner_id
        AND reservation.reservation_id = p_reservation_id
    ) IS DISTINCT FROM v_object_count
    OR EXISTS (
      SELECT 1
      FROM public.staged_bundle_storage_reservations AS reservation
      WHERE reservation.owner_id = p_owner_id
        AND reservation.reservation_id = p_reservation_id
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(p_objects) AS requested(value)
          WHERE requested.value->>'object_id' = reservation.object_id
        )
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'STAGED_BUNDLE_STORAGE_RESERVATION_CONFLICT',
      'message', 'A staged bundle reservation token was reused.'
    )::text;
  END IF;

  IF EXISTS (
    WITH requested AS (
      SELECT
        value->>'object_id' AS object_id,
        (value->>'size_bytes')::bigint AS size_bytes
      FROM jsonb_array_elements(p_objects)
    )
    SELECT 1
    FROM requested
    JOIN public.staged_bundle_storage_objects AS stored
      ON stored.owner_id = p_owner_id
     AND stored.object_id = requested.object_id
    WHERE stored.size_bytes IS DISTINCT FROM requested.size_bytes
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'STAGED_BUNDLE_STORAGE_IDENTITY_CONFLICT',
      'message', 'An immutable staged object changed size.'
    )::text;
  END IF;

  SELECT COALESCE(sum(stored.size_bytes), 0), count(*)
  INTO v_used_bytes, v_used_objects
  FROM public.staged_bundle_storage_objects AS stored
  WHERE stored.owner_id = p_owner_id;

  WITH requested AS (
    SELECT
      value->>'object_id' AS object_id,
      (value->>'size_bytes')::bigint AS size_bytes
    FROM jsonb_array_elements(p_objects)
  )
  SELECT COALESCE(sum(requested.size_bytes), 0), count(*)
  INTO v_reserved_bytes, v_reserved_objects
  FROM requested
  LEFT JOIN public.staged_bundle_storage_objects AS stored
    ON stored.owner_id = p_owner_id
   AND stored.object_id = requested.object_id
  WHERE stored.object_id IS NULL;

  v_projected_bytes := v_used_bytes + v_reserved_bytes;
  v_projected_objects := v_used_objects + v_reserved_objects;
  IF v_projected_bytes > p_limit_bytes
     OR v_projected_objects > p_limit_objects THEN
    RETURN QUERY SELECT
      p_reservation_id,
      false,
      v_used_bytes,
      v_reserved_bytes,
      v_projected_bytes,
      p_limit_bytes,
      GREATEST(0::bigint, p_limit_bytes - v_used_bytes),
      v_used_objects,
      v_reserved_objects,
      v_projected_objects,
      p_limit_objects,
      GREATEST(0::bigint, p_limit_objects::bigint - v_used_objects),
      p_retained_until;
    RETURN;
  END IF;

  INSERT INTO public.staged_bundle_storage_objects AS stored (
    owner_id,
    object_id,
    size_bytes,
    created_at,
    updated_at
  )
  SELECT
    p_owner_id,
    requested.value->>'object_id',
    (requested.value->>'size_bytes')::bigint,
    v_now,
    v_now
  FROM jsonb_array_elements(p_objects) AS requested(value)
  ON CONFLICT (owner_id, object_id) DO UPDATE
  SET updated_at = v_now;

  INSERT INTO public.staged_bundle_storage_reservations AS reservation (
    owner_id,
    reservation_id,
    object_id,
    retained_until,
    created_at
  )
  SELECT
    p_owner_id,
    p_reservation_id,
    requested.value->>'object_id',
    p_retained_until,
    v_now
  FROM jsonb_array_elements(p_objects) AS requested(value)
  ON CONFLICT (owner_id, reservation_id, object_id) DO UPDATE
  SET retained_until = GREATEST(
        reservation.retained_until,
        EXCLUDED.retained_until
      );

  RETURN QUERY SELECT
    p_reservation_id,
    true,
    v_used_bytes,
    v_reserved_bytes,
    v_projected_bytes,
    p_limit_bytes,
    p_limit_bytes - v_projected_bytes,
    v_used_objects,
    v_reserved_objects,
    v_projected_objects,
    p_limit_objects,
    p_limit_objects::bigint - v_projected_objects,
    p_retained_until;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_staged_bundle_storage_reservation(
  p_owner_id uuid,
  p_reservation_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_released integer;
BEGIN
  IF p_owner_id IS NULL OR p_reservation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'STAGED_BUNDLE_STORAGE_RELEASE_INVALID',
      'message', 'Staged bundle storage release is invalid.'
    )::text;
  END IF;

  PERFORM 1
  FROM public.users AS owner
  WHERE owner.id = p_owner_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  WITH released AS (
    DELETE FROM public.staged_bundle_storage_reservations AS reservation
    WHERE reservation.owner_id = p_owner_id
      AND reservation.reservation_id = p_reservation_id
    RETURNING 1
  )
  SELECT count(*) INTO v_released FROM released;

  DELETE FROM public.staged_bundle_storage_objects AS stored
  WHERE stored.owner_id = p_owner_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.staged_bundle_storage_reservations AS reservation
      WHERE reservation.owner_id = stored.owner_id
        AND reservation.object_id = stored.object_id
    );

  RETURN v_released;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_staged_bundle_storage_reservations(
  p_cutoff timestamptz DEFAULT clock_timestamp(),
  p_limit integer DEFAULT 10000
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_released integer;
  v_owner_ids uuid[];
BEGIN
  IF p_cutoff IS NULL OR p_limit NOT BETWEEN 1 AND 50000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'STAGED_BUNDLE_STORAGE_CLEANUP_INVALID',
      'message', 'Staged bundle storage cleanup parameters are invalid.'
    )::text;
  END IF;

  SELECT array_agg(DISTINCT candidate.owner_id)
  INTO v_owner_ids
  FROM (
    SELECT reservation.owner_id
    FROM public.staged_bundle_storage_reservations AS reservation
    WHERE reservation.retained_until <= p_cutoff
    ORDER BY reservation.retained_until, reservation.owner_id
    LIMIT p_limit
  ) AS candidate;
  IF COALESCE(cardinality(v_owner_ids), 0) = 0 THEN
    RETURN 0;
  END IF;

  -- Coordinate with admission/release before pruning the final claim for an
  -- object. Lock owners in deterministic order to avoid cross-owner deadlocks.
  PERFORM 1
  FROM public.users AS owner
  WHERE owner.id = ANY(v_owner_ids)
  ORDER BY owner.id
  FOR NO KEY UPDATE;

  WITH expired AS (
    SELECT
      reservation.owner_id,
      reservation.reservation_id,
      reservation.object_id
    FROM public.staged_bundle_storage_reservations AS reservation
    WHERE reservation.retained_until <= p_cutoff
      AND reservation.owner_id = ANY(v_owner_ids)
    ORDER BY
      reservation.retained_until,
      reservation.owner_id,
      reservation.reservation_id,
      reservation.object_id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  released AS (
    DELETE FROM public.staged_bundle_storage_reservations AS reservation
    USING expired
    WHERE reservation.owner_id = expired.owner_id
      AND reservation.reservation_id = expired.reservation_id
      AND reservation.object_id = expired.object_id
    RETURNING 1
  )
  SELECT count(*) INTO v_released FROM released;

  DELETE FROM public.staged_bundle_storage_objects AS stored
  WHERE stored.owner_id = ANY(v_owner_ids)
    AND NOT EXISTS (
    SELECT 1
    FROM public.staged_bundle_storage_reservations AS reservation
    WHERE reservation.owner_id = stored.owner_id
      AND reservation.object_id = stored.object_id
  );

  RETURN v_released;
END;
$$;

REVOKE ALL ON TABLE public.staged_bundle_storage_objects
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.staged_bundle_storage_reservations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.staged_bundle_storage_objects TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.staged_bundle_storage_reservations TO service_role;

REVOKE ALL ON FUNCTION public.reserve_staged_bundle_storage(
  uuid, uuid, jsonb, timestamptz, bigint, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_staged_bundle_storage(
  uuid, uuid, jsonb, timestamptz, bigint, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.release_staged_bundle_storage_reservation(
  uuid, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_staged_bundle_storage_reservation(
  uuid, uuid
) TO service_role;

REVOKE ALL ON FUNCTION public.cleanup_staged_bundle_storage_reservations(
  timestamptz, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_staged_bundle_storage_reservations(
  timestamptz, integer
) TO service_role;
