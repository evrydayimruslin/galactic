-- Database-owned retention for Galactic Compute artifacts.
--
-- R2 object age is never authority. Ready outputs receive an explicit 30-day
-- expiry when they commit. Admission creates a ready input alias only while
-- the source output is unexpired; that alias pins the backing object until the
-- dependent run is terminal. Owner downloads take a bounded one-hour deletion
-- lease. The minute reconciler first tombstones terminal input aliases, then
-- tombstones unreferenced expired outputs before deleting their R2 objects.

-- An input alias must point directly at a ready output. Fail the upgrade rather
-- than silently blessing an alias chain or metadata mismatch that the sweeper
-- could not protect safely.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.compute_artifacts AS input_alias
    LEFT JOIN public.compute_artifacts AS source
      ON source.id = input_alias.source_artifact_id
    WHERE input_alias.direction = 'input'
      AND input_alias.state = 'ready'
      AND (
        source.id IS NULL
        OR source.direction IS DISTINCT FROM 'output'
        OR source.state IS DISTINCT FROM 'ready'
        OR source.user_id IS DISTINCT FROM input_alias.user_id
        OR source.storage_key IS DISTINCT FROM input_alias.storage_key
        OR source.sha256 IS DISTINCT FROM input_alias.sha256
        OR source.size_bytes IS DISTINCT FROM input_alias.size_bytes
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_RETENTION_MIGRATION_BLOCKED',
      'message', 'Every ready input alias must directly and exactly reference a ready output.'
    )::text;
  END IF;
END;
$$;

ALTER TABLE public.compute_artifacts
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN retention_protected_until timestamptz,
  ADD COLUMN object_deleted_at timestamptz;

-- Start every pre-existing ready output with a full retention window. This is
-- deliberately based on migration time, not historical object age, so an
-- upgrade cannot immediately erase a previously promised artifact.
UPDATE public.compute_artifacts
SET expires_at = transaction_timestamp() + interval '30 days'
WHERE direction = 'output' AND state = 'ready';

-- Input aliases are not independent retained objects. Their timestamp is an
-- absolute safety bound beyond the run lease; terminal-state cleanup remains
-- the actual release condition.
UPDATE public.compute_artifacts AS input_alias
SET expires_at = GREATEST(
  run.expires_at + interval '1 hour',
  transaction_timestamp() + interval '1 hour'
)
FROM public.compute_runs AS run
WHERE input_alias.run_id = run.id
  AND input_alias.direction = 'input'
  AND input_alias.state = 'ready';

ALTER TABLE public.compute_artifacts
  ADD CONSTRAINT compute_artifacts_ready_expiry_check CHECK (
    state <> 'ready' OR expires_at IS NOT NULL
  ) NOT VALID,
  ADD CONSTRAINT compute_artifacts_retention_protection_check CHECK (
    retention_protected_until IS NULL OR direction = 'output'
  ) NOT VALID,
  ADD CONSTRAINT compute_artifacts_object_deletion_check CHECK (
    object_deleted_at IS NULL OR (direction = 'output' AND state = 'deleted')
  ) NOT VALID,
  ADD CONSTRAINT compute_artifacts_expiry_order_check CHECK (
    expires_at IS NULL OR expires_at >= created_at
  ) NOT VALID;

ALTER TABLE public.compute_artifacts
  VALIDATE CONSTRAINT compute_artifacts_ready_expiry_check;
ALTER TABLE public.compute_artifacts
  VALIDATE CONSTRAINT compute_artifacts_retention_protection_check;
ALTER TABLE public.compute_artifacts
  VALIDATE CONSTRAINT compute_artifacts_object_deletion_check;
ALTER TABLE public.compute_artifacts
  VALIDATE CONSTRAINT compute_artifacts_expiry_order_check;

CREATE INDEX compute_artifacts_ready_expiry_idx
  ON public.compute_artifacts (expires_at, id)
  WHERE state = 'ready';
CREATE INDEX compute_artifacts_ready_source_refs_idx
  ON public.compute_artifacts (source_artifact_id, id)
  WHERE direction = 'input' AND state = 'ready';
CREATE INDEX compute_artifacts_unpurged_owner_quota_idx
  ON public.compute_artifacts (user_id, size_bytes, id)
  WHERE direction = 'output' AND object_deleted_at IS NULL;
CREATE INDEX compute_artifacts_unpurged_deleted_idx
  ON public.compute_artifacts (updated_at, id)
  WHERE direction = 'output' AND state = 'deleted'
    AND object_deleted_at IS NULL;

-- This row is a per-owner serialization point. Counts and bytes are derived
-- from artifact rows under the lock, so there is no counter that can drift.
CREATE TABLE public.compute_artifact_owner_storage_quotas (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  max_object_count integer NOT NULL DEFAULT 10000,
  max_bytes bigint NOT NULL DEFAULT 10737418240,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compute_artifact_owner_storage_v1_count_check
    CHECK (max_object_count = 10000),
  CONSTRAINT compute_artifact_owner_storage_v1_bytes_check
    CHECK (max_bytes = 10737418240)
);

INSERT INTO public.compute_artifact_owner_storage_quotas (user_id)
SELECT DISTINCT artifact.user_id
FROM public.compute_artifacts AS artifact
WHERE artifact.direction = 'output';

DO $$
BEGIN
  IF EXISTS (
    SELECT artifact.user_id
    FROM public.compute_artifacts AS artifact
    WHERE artifact.direction = 'output'
      AND artifact.object_deleted_at IS NULL
    GROUP BY artifact.user_id
    HAVING count(*) > 10000
      OR COALESCE(sum(artifact.size_bytes), 0) > 10737418240
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_RETENTION_MIGRATION_BLOCKED',
      'message', 'Existing physical Compute outputs exceed the v1 per-owner retention quota.'
    )::text;
  END IF;
END;
$$;

ALTER TABLE public.compute_artifact_owner_storage_quotas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.compute_artifact_owner_storage_quotas
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.compute_artifact_owner_storage_quotas TO service_role;

CREATE OR REPLACE FUNCTION public.apply_compute_artifact_retention()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_source public.compute_artifacts%ROWTYPE;
  v_run public.compute_runs%ROWTYPE;
BEGIN
  IF NEW.direction = 'input' AND TG_OP = 'INSERT' THEN
    SELECT run.* INTO v_run
    FROM public.compute_runs AS run
    WHERE run.id = NEW.run_id;
    IF NOT FOUND OR v_run.user_id IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_INPUT_ARTIFACT_INVALID',
        'message', 'The input alias run scope is invalid.'
      )::text;
    END IF;

    SELECT source.* INTO v_source
    FROM public.compute_artifacts AS source
    WHERE source.id = NEW.source_artifact_id
    FOR SHARE;
    IF NOT FOUND
       OR v_source.direction IS DISTINCT FROM 'output'
       OR v_source.state IS DISTINCT FROM 'ready'
       OR v_source.user_id IS DISTINCT FROM NEW.user_id
       OR v_source.object_deleted_at IS NOT NULL
       OR v_source.expires_at IS NULL
       OR v_source.expires_at <= clock_timestamp()
       OR v_source.storage_key IS DISTINCT FROM NEW.storage_key
       OR v_source.sha256 IS DISTINCT FROM NEW.sha256
       OR v_source.size_bytes IS DISTINCT FROM NEW.size_bytes THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_INPUT_ARTIFACT_EXPIRED',
        'message', 'Input artifacts must directly reference an exact, ready, unexpired output.'
      )::text;
    END IF;
    NEW.expires_at := v_run.expires_at + interval '1 hour';
    NEW.retention_protected_until := NULL;
  ELSIF NEW.direction = 'output' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.state = 'ready' THEN
        NEW.expires_at := clock_timestamp() + interval '30 days';
      END IF;
    ELSIF NEW.state = 'ready' AND OLD.state IS DISTINCT FROM 'ready' THEN
      NEW.expires_at := clock_timestamp() + interval '30 days';
    END IF;
    IF NEW.state = 'pending' THEN
      NEW.expires_at := NULL;
      NEW.retention_protected_until := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER compute_artifact_apply_retention
BEFORE INSERT OR UPDATE ON public.compute_artifacts
FOR EACH ROW
EXECUTE FUNCTION public.apply_compute_artifact_retention();

CREATE OR REPLACE FUNCTION public.enforce_compute_artifact_owner_storage_quota()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_quota public.compute_artifact_owner_storage_quotas%ROWTYPE;
  v_object_count bigint;
  v_bytes bigint;
BEGIN
  IF NEW.direction <> 'output' THEN RETURN NEW; END IF;
  IF NEW.size_bytes IS NULL OR NEW.size_bytes < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_ARTIFACT',
      'message', 'A physical output reservation requires an exact byte size.'
    )::text;
  END IF;

  INSERT INTO public.compute_artifact_owner_storage_quotas (user_id)
  VALUES (NEW.user_id)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT quota.* INTO v_quota
  FROM public.compute_artifact_owner_storage_quotas AS quota
  WHERE quota.user_id = NEW.user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Compute artifact owner quota row is unavailable';
  END IF;

  SELECT count(*), COALESCE(sum(artifact.size_bytes), 0)
  INTO v_object_count, v_bytes
  FROM public.compute_artifacts AS artifact
  WHERE artifact.user_id = NEW.user_id
    AND artifact.direction = 'output'
    AND artifact.object_deleted_at IS NULL;
  IF v_object_count + 1 > v_quota.max_object_count
     OR v_bytes + NEW.size_bytes > v_quota.max_bytes THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_STORAGE_QUOTA_EXCEEDED',
      'message', 'The owner retained-output quota is exhausted; wait for expiry and confirmed deletion.'
    )::text;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER compute_artifact_enforce_owner_storage_quota
BEFORE INSERT ON public.compute_artifacts
FOR EACH ROW
EXECUTE FUNCTION public.enforce_compute_artifact_owner_storage_quota();

-- Preserve identity and digest immutability while making the two retention
-- mutations explicit: expiry is assigned exactly once on ready commit, and a
-- ready output's download protection may only move forward.
CREATE OR REPLACE FUNCTION public.enforce_compute_artifact_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.source_artifact_id IS DISTINCT FROM OLD.source_artifact_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.mount_path IS DISTINCT FROM OLD.mount_path
     OR NEW.logical_name IS DISTINCT FROM OLD.logical_name
     OR NEW.media_type IS DISTINCT FROM OLD.media_type
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_IDENTITY_IMMUTABLE',
      'message', 'Reserved Compute artifact identity metadata is immutable.'
    )::text;
  END IF;

  IF NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_INTEGRITY_IMMUTABLE',
      'message', 'A Compute artifact commit cannot change its reserved digest or size.'
    )::text;
  END IF;

  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at AND NOT (
    OLD.expires_at IS NULL
    AND NEW.expires_at IS NOT NULL
    AND OLD.state = 'pending'
    AND NEW.state = 'ready'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_EXPIRY_IMMUTABLE',
      'message', 'Artifact expiry is assigned exactly once when bytes become ready.'
    )::text;
  END IF;

  IF NEW.retention_protected_until IS DISTINCT FROM OLD.retention_protected_until
     AND (
       NEW.direction <> 'output'
       OR NEW.state <> 'ready'
       OR NEW.retention_protected_until IS NULL
       OR (
         OLD.retention_protected_until IS NOT NULL
         AND NEW.retention_protected_until < OLD.retention_protected_until
       )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_RETENTION_PROTECTION_INVALID',
      'message', 'A ready output download lease may only extend its protection.'
    )::text;
  END IF;

  IF NEW.object_deleted_at IS DISTINCT FROM OLD.object_deleted_at AND NOT (
    OLD.object_deleted_at IS NULL
    AND NEW.object_deleted_at IS NOT NULL
    AND NEW.direction = 'output'
    AND NEW.state = 'deleted'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_OBJECT_DELETION_INVALID',
      'message', 'Physical deletion can only be confirmed once for a tombstoned output.'
    )::text;
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state = 'pending' AND NEW.state IN ('ready', 'deleted'))
      OR (OLD.state = 'ready' AND NEW.state = 'deleted')
    ) OR NEW.state_version IS DISTINCT FROM OLD.state_version + 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_ARTIFACT_TRANSITION_INVALID',
        'message', 'Compute artifact state transitions require the exact next version.'
      )::text;
    END IF;
  ELSIF NEW.state_version IS DISTINCT FROM OLD.state_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_VERSION_INVALID',
      'message', 'Compute artifact versions advance only with a state transition.'
    )::text;
  END IF;
  RETURN NEW;
END;
$$;

-- Release physical quota only after the API has successfully issued the exact
-- R2 delete. An uncertain response is retried by the bounded unpurged scan.
CREATE OR REPLACE FUNCTION public.confirm_compute_artifact_object_deleted(
  p_artifact_id uuid,
  p_storage_key text,
  p_deleted_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_artifact public.compute_artifacts%ROWTYPE;
BEGIN
  IF p_artifact_id IS NULL OR p_storage_key IS NULL OR p_deleted_at IS NULL
     OR length(p_storage_key) NOT BETWEEN 1 AND 2048
     OR p_storage_key ~ '[[:cntrl:]]'
     OR p_deleted_at NOT BETWEEN
       clock_timestamp() - interval '5 minutes'
       AND clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid Compute object deletion confirmation';
  END IF;
  SELECT artifact.* INTO v_artifact
  FROM public.compute_artifacts AS artifact
  WHERE artifact.id = p_artifact_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', true, 'skip_reason', 'not_found');
  END IF;
  IF v_artifact.direction <> 'output'
     OR v_artifact.state <> 'deleted'
     OR v_artifact.storage_key IS DISTINCT FROM p_storage_key THEN
    RETURN to_jsonb(v_artifact) || jsonb_build_object(
      'skipped', true, 'skip_reason', 'artifact_mismatch'
    );
  END IF;
  IF v_artifact.object_deleted_at IS NOT NULL THEN
    RETURN to_jsonb(v_artifact) || jsonb_build_object('replayed', true);
  END IF;
  UPDATE public.compute_artifacts AS artifact
  SET object_deleted_at = p_deleted_at
  WHERE artifact.id = v_artifact.id
  RETURNING * INTO v_artifact;
  RETURN to_jsonb(v_artifact) || jsonb_build_object('replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_unpurged_compute_artifacts(
  p_now timestamptz,
  p_cutoff timestamptz,
  p_limit integer DEFAULT 100
) RETURNS TABLE (
  artifact_id uuid,
  storage_key text,
  state_version bigint,
  artifact_updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  IF p_now IS NULL OR p_cutoff IS NULL OR p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 500
     OR p_cutoff > p_now - interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid unpurged Compute artifact inputs';
  END IF;
  RETURN QUERY
    SELECT artifact.id, artifact.storage_key, artifact.state_version,
      artifact.updated_at
    FROM public.compute_artifacts AS artifact
    WHERE artifact.direction = 'output'
      AND artifact.state = 'deleted'
      AND artifact.object_deleted_at IS NULL
      AND artifact.updated_at <= p_cutoff
      AND NOT EXISTS (
        SELECT 1
        FROM public.compute_artifacts AS input_alias
        WHERE input_alias.source_artifact_id = artifact.id
          AND input_alias.direction = 'input'
          AND input_alias.state = 'ready'
      )
    ORDER BY artifact.updated_at, artifact.id
    LIMIT p_limit;
END;
$$;

-- Owner download authorization and retention protection are one row lock. The
-- API never reads an unleased storage key and an already-expired output is not
-- revived by a late download.
CREATE OR REPLACE FUNCTION public.lease_compute_artifact_owner_download(
  p_artifact_id uuid,
  p_run_id uuid,
  p_user_id uuid,
  p_agent_id uuid,
  p_caller_function text
) RETURNS SETOF public.compute_artifacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_run public.compute_runs%ROWTYPE;
  v_artifact public.compute_artifacts%ROWTYPE;
BEGIN
  IF p_artifact_id IS NULL OR p_run_id IS NULL OR p_user_id IS NULL
     OR p_agent_id IS NULL OR p_caller_function IS NULL THEN
    RAISE EXCEPTION 'invalid Compute artifact download identity';
  END IF;
  SELECT run.* INTO v_run
  FROM public.compute_runs AS run
  WHERE run.id = p_run_id
    AND run.user_id = p_user_id
    AND run.agent_id = p_agent_id
    AND run.caller_function = p_caller_function
  FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT artifact.* INTO v_artifact
  FROM public.compute_artifacts AS artifact
  WHERE artifact.id = p_artifact_id
    AND artifact.run_id = p_run_id
    AND artifact.user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_artifact.direction <> 'output'
     OR v_artifact.state <> 'ready'
     OR v_artifact.sha256 IS NULL
     OR v_artifact.size_bytes IS NULL
     OR v_artifact.expires_at IS NULL
     OR v_artifact.expires_at <= v_now THEN
    RETURN;
  END IF;

  UPDATE public.compute_artifacts AS artifact
  SET retention_protected_until = GREATEST(
    COALESCE(artifact.retention_protected_until, v_now),
    v_now + interval '1 hour'
  )
  WHERE artifact.id = v_artifact.id
  RETURNING * INTO v_artifact;
  RETURN NEXT v_artifact;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_expired_compute_artifacts(
  p_now timestamptz,
  p_cutoff timestamptz,
  p_limit integer DEFAULT 100
) RETURNS TABLE (
  artifact_id uuid,
  run_id uuid,
  user_id uuid,
  agent_id uuid,
  caller_function text,
  storage_key text,
  direction text,
  state_version bigint,
  expires_at timestamptz,
  retention_protected_until timestamptz,
  run_state text,
  run_finished_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  IF p_now IS NULL OR p_cutoff IS NULL OR p_limit IS NULL
     OR p_limit NOT BETWEEN 2 AND 500
     OR p_cutoff > p_now - interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid Compute artifact retention inputs';
  END IF;
  RETURN QUERY
    WITH eligible AS (
      SELECT artifact.id, artifact.run_id, artifact.user_id, run.agent_id,
        run.caller_function, artifact.storage_key, artifact.direction,
        artifact.state_version, artifact.expires_at,
        artifact.retention_protected_until, run.state,
        COALESCE(run.finished_at, run.updated_at) AS run_finished_at,
        CASE artifact.direction
          WHEN 'input' THEN COALESCE(run.finished_at, run.updated_at)
          ELSE artifact.expires_at
        END AS eligible_at
      FROM public.compute_artifacts AS artifact
      JOIN public.compute_runs AS run ON run.id = artifact.run_id
      WHERE artifact.state = 'ready'
        AND run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
        AND (
          (
            artifact.direction = 'input'
            AND COALESCE(run.finished_at, run.updated_at) <= p_cutoff
          )
          OR (
            artifact.direction = 'output'
            AND artifact.expires_at <= p_now
            AND COALESCE(artifact.retention_protected_until, '-infinity'::timestamptz) <= p_now
            AND NOT EXISTS (
              SELECT 1
              FROM public.compute_artifacts AS input_alias
              WHERE input_alias.source_artifact_id = artifact.id
                AND input_alias.direction = 'input'
                AND input_alias.state = 'ready'
            )
          )
        )
    ), ranked AS (
      -- Interleave the oldest terminal aliases and unpinned outputs. Ordering
      -- every alias ahead of every output can starve physical quota release
      -- forever under sustained alias churn; per-direction rank guarantees
      -- both categories make progress while still releasing an alias before
      -- any source it currently pins becomes eligible on a later sweep.
      SELECT eligible.*,
        row_number() OVER (
          PARTITION BY eligible.direction
          ORDER BY eligible.eligible_at, eligible.id
        ) AS direction_rank
      FROM eligible
    )
    SELECT ranked.id, ranked.run_id, ranked.user_id, ranked.agent_id,
      ranked.caller_function, ranked.storage_key, ranked.direction,
      ranked.state_version, ranked.expires_at,
      ranked.retention_protected_until, ranked.state,
      ranked.run_finished_at
    FROM ranked
    ORDER BY ranked.direction_rank,
      CASE ranked.direction WHEN 'input' THEN 0 ELSE 1 END
    LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.tombstone_expired_compute_artifact(
  p_artifact_id uuid,
  p_expected_state_version bigint,
  p_now timestamptz,
  p_cutoff timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid;
  v_run public.compute_runs%ROWTYPE;
  v_artifact public.compute_artifacts%ROWTYPE;
  v_has_ready_reference boolean := false;
BEGIN
  IF p_artifact_id IS NULL OR p_expected_state_version IS NULL
     OR p_expected_state_version < 1 OR p_now IS NULL OR p_cutoff IS NULL
     OR p_cutoff > p_now - interval '5 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ARTIFACT_RETENTION_INVALID',
      'message', 'Artifact retention requires an exact old candidate.'
    )::text;
  END IF;
  SELECT artifact.run_id INTO v_run_id
  FROM public.compute_artifacts AS artifact
  WHERE artifact.id = p_artifact_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', true, 'skip_reason', 'not_found');
  END IF;

  SELECT run.* INTO v_run
  FROM public.compute_runs AS run
  WHERE run.id = v_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', true, 'skip_reason', 'run_not_found');
  END IF;
  SELECT artifact.* INTO v_artifact
  FROM public.compute_artifacts AS artifact
  WHERE artifact.id = p_artifact_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', true, 'skip_reason', 'not_found');
  END IF;
  IF v_artifact.state = 'deleted' THEN
    RETURN to_jsonb(v_artifact) || jsonb_build_object(
      'delete_object', v_artifact.direction = 'output',
      'replayed', true
    );
  END IF;
  IF v_artifact.state IS DISTINCT FROM 'ready'
     OR v_artifact.state_version IS DISTINCT FROM p_expected_state_version
     OR v_run.state NOT IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked') THEN
    RETURN to_jsonb(v_artifact) || jsonb_build_object(
      'skipped', true, 'skip_reason', 'candidate_changed'
    );
  END IF;

  IF v_artifact.direction = 'input' THEN
    IF COALESCE(v_run.finished_at, v_run.updated_at) > p_cutoff THEN
      RETURN to_jsonb(v_artifact) || jsonb_build_object(
        'skipped', true, 'skip_reason', 'terminal_grace_active'
      );
    END IF;
  ELSIF v_artifact.direction = 'output' THEN
    IF v_artifact.expires_at IS NULL OR v_artifact.expires_at > p_now
       OR COALESCE(
         v_artifact.retention_protected_until,
         '-infinity'::timestamptz
       ) > p_now THEN
      RETURN to_jsonb(v_artifact) || jsonb_build_object(
        'skipped', true, 'skip_reason', 'retention_active'
      );
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM public.compute_artifacts AS input_alias
      WHERE input_alias.source_artifact_id = v_artifact.id
        AND input_alias.direction = 'input'
        AND input_alias.state = 'ready'
    ) INTO v_has_ready_reference;
    IF v_has_ready_reference THEN
      RETURN to_jsonb(v_artifact) || jsonb_build_object(
        'skipped', true, 'skip_reason', 'ready_input_reference'
      );
    END IF;
  ELSE
    RETURN to_jsonb(v_artifact) || jsonb_build_object(
      'skipped', true, 'skip_reason', 'invalid_direction'
    );
  END IF;

  UPDATE public.compute_artifacts AS artifact
  SET state = 'deleted',
      state_version = artifact.state_version + 1,
      updated_at = p_now
  WHERE artifact.id = v_artifact.id
    AND artifact.state = 'ready'
    AND artifact.state_version = p_expected_state_version
  RETURNING * INTO v_artifact;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', true, 'skip_reason', 'cas_lost');
  END IF;
  RETURN to_jsonb(v_artifact) || jsonb_build_object(
    'delete_object', v_artifact.direction = 'output',
    'replayed', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_compute_artifact_retention()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_compute_artifact_owner_storage_quota()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_compute_artifact_object_deleted(
  uuid, text, timestamptz
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_unpurged_compute_artifacts(
  timestamptz, timestamptz, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lease_compute_artifact_owner_download(
  uuid, uuid, uuid, uuid, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_expired_compute_artifacts(
  timestamptz, timestamptz, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tombstone_expired_compute_artifact(
  uuid, bigint, timestamptz, timestamptz
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.confirm_compute_artifact_object_deleted(
  uuid, text, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_unpurged_compute_artifacts(
  timestamptz, timestamptz, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.lease_compute_artifact_owner_download(
  uuid, uuid, uuid, uuid, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_expired_compute_artifacts(
  timestamptz, timestamptz, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.tombstone_expired_compute_artifact(
  uuid, bigint, timestamptz, timestamptz
) TO service_role;
