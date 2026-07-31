-- Membership-gated immutable Builder deployment and runtime enforcement.
--
-- Lock order for the RPCs below is:
--   users -> account_entitlements -> builder_handoff_sessions
--   -> builder_handoff_deployments -> apps -> app_releases
--   -> user_routines (UUID order) -> routine_runs.
--
-- External storage, D1, and KV writes are intentionally fenced as a durable
-- saga. PostgreSQL is the authority for membership, candidate lineage,
-- idempotency, release generation, and the final setup_required commit.

ALTER TABLE public.builder_handoff_sessions
  ADD COLUMN IF NOT EXISTS base_release_generation bigint;

ALTER TABLE public.builder_handoff_sessions
  DROP CONSTRAINT IF EXISTS builder_handoff_session_base_generation_check;
ALTER TABLE public.builder_handoff_sessions
  ADD CONSTRAINT builder_handoff_session_base_generation_check CHECK (
    (
      intent IN ('interface', 'function', 'routine')
      AND (
        base_release_generation IS NULL
        OR base_release_generation >= 0
      )
    )
    OR (
      intent IN ('agent', 'connect')
      AND base_release_generation IS NULL
    )
  );

COMMENT ON COLUMN public.builder_handoff_sessions.base_release_generation IS
  'Exact apps.release_generation captured for an extension handoff. NULL on pre-M7 extension sessions makes them ineligible for deployment and forces a fresh handoff.';

ALTER TABLE public.apps
  ADD COLUMN IF NOT EXISTS deployment_state text DEFAULT 'legacy' NOT NULL,
  ADD COLUMN IF NOT EXISTS release_generation bigint DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS active_release_id uuid,
  ADD COLUMN IF NOT EXISTS active_release_digest text,
  ADD COLUMN IF NOT EXISTS active_archive_digest text,
  ADD COLUMN IF NOT EXISTS materializing_deployment_id uuid,
  ADD COLUMN IF NOT EXISTS setup_required_at timestamptz;

ALTER TABLE public.apps
  DROP CONSTRAINT IF EXISTS apps_deployment_state_check;
ALTER TABLE public.apps
  ADD CONSTRAINT apps_deployment_state_check CHECK (
    deployment_state IN (
      'legacy',
      'materializing',
      'setup_required',
      'ready',
      'disabled'
    )
  );

ALTER TABLE public.apps
  DROP CONSTRAINT IF EXISTS apps_release_generation_check;
ALTER TABLE public.apps
  ADD CONSTRAINT apps_release_generation_check CHECK (
    release_generation >= 0
  );

ALTER TABLE public.apps
  DROP CONSTRAINT IF EXISTS apps_active_release_digest_check;
ALTER TABLE public.apps
  ADD CONSTRAINT apps_active_release_digest_check CHECK (
    active_release_digest IS NULL
    OR active_release_digest ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE public.apps
  DROP CONSTRAINT IF EXISTS apps_active_archive_digest_check;
ALTER TABLE public.apps
  ADD CONSTRAINT apps_active_archive_digest_check CHECK (
    active_archive_digest IS NULL
    OR active_archive_digest ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE public.apps
  DROP CONSTRAINT IF EXISTS apps_deployment_provenance_shape_check;
ALTER TABLE public.apps
  ADD CONSTRAINT apps_deployment_provenance_shape_check CHECK (
    (
      deployment_state = 'materializing'
      AND materializing_deployment_id IS NOT NULL
      AND visibility = 'private'
      AND hosting_suspended = true
      AND http_enabled = false
    )
    OR (
      deployment_state = 'setup_required'
      AND materializing_deployment_id IS NULL
      AND active_release_id IS NOT NULL
      AND active_release_digest IS NOT NULL
      AND active_archive_digest IS NOT NULL
      AND release_generation >= 1
      AND setup_required_at IS NOT NULL
      AND visibility = 'private'
    )
    OR deployment_state IN ('legacy', 'ready', 'disabled')
  ) NOT VALID;

CREATE TABLE public.builder_handoff_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL UNIQUE
    REFERENCES public.builder_handoff_sessions(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  target_app_id uuid NOT NULL,
  intent text NOT NULL,
  version text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  request_payload jsonb NOT NULL,
  review_revision text NOT NULL,
  candidate_archive_digest text NOT NULL,
  release_digest text NOT NULL,
  source_hash text NOT NULL,
  attestation_id text NOT NULL,
  attestation_digest text NOT NULL,
  document_digest text NOT NULL,
  report_digest text NOT NULL,
  base_version text,
  base_source_hash text,
  base_release_digest text,
  base_state_digest text,
  base_release_generation bigint,
  base_snapshot jsonb,
  prior_app_state jsonb,
  claimed_release_generation bigint NOT NULL,
  status text NOT NULL DEFAULT 'in_progress',
  phase text NOT NULL DEFAULT 'claimed',
  phase_rank smallint NOT NULL DEFAULT 0,
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 1,
  reconciliation_count integer NOT NULL DEFAULT 0,
  side_effect_started_at timestamptz,
  base_verified_at timestamptz,
  commit_fingerprint text,
  release_id uuid,
  response jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT builder_handoff_deployments_intent_check CHECK (
    intent IN ('agent', 'interface', 'function', 'routine')
  ),
  CONSTRAINT builder_handoff_deployments_version_check CHECK (
    version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
  ),
  CONSTRAINT builder_handoff_deployments_idempotency_check CHECK (
    length(idempotency_key) BETWEEN 1 AND 200
    AND idempotency_key = btrim(idempotency_key)
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT builder_handoff_deployments_fingerprint_check CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
    AND (
      commit_fingerprint IS NULL
      OR commit_fingerprint ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT builder_handoff_deployments_review_revision_check CHECK (
    length(review_revision) BETWEEN 1 AND 128
    AND review_revision = btrim(review_revision)
    AND review_revision !~ '[[:cntrl:]]'
  ),
  CONSTRAINT builder_handoff_deployments_digest_check CHECK (
    candidate_archive_digest ~ '^[0-9a-f]{64}$'
    AND release_digest ~ '^[0-9a-f]{64}$'
    AND source_hash ~ '^[0-9a-f]{64}$'
    AND attestation_digest ~ '^[0-9a-f]{64}$'
    AND document_digest ~ '^[0-9a-f]{64}$'
    AND report_digest ~ '^[0-9a-f]{64}$'
    AND (
      base_source_hash IS NULL
      OR base_source_hash ~ '^[0-9a-f]{64}$'
    )
    AND (
      base_release_digest IS NULL
      OR base_release_digest ~ '^[0-9a-f]{64}$'
    )
    AND (
      base_state_digest IS NULL
      OR base_state_digest ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT builder_handoff_deployments_status_check CHECK (
    status IN (
      'in_progress',
      'completed',
      'failed',
      'stale',
      'repair_required'
    )
  ),
  CONSTRAINT builder_handoff_deployments_phase_check CHECK (
    phase IN (
      'claimed',
      'archive_verified',
      'artifacts_started',
      'artifacts_verified',
      'migrations_started',
      'migrations_verified',
      'live_bundle_started',
      'live_bundle_verified',
      'committed'
    )
  ),
  CONSTRAINT builder_handoff_deployments_phase_rank_check CHECK (
    phase_rank BETWEEN 0 AND 8
  ),
  CONSTRAINT builder_handoff_deployments_lineage_check CHECK (
    (
      intent = 'agent'
      AND base_version IS NULL
      AND base_source_hash IS NULL
      AND base_release_digest IS NULL
      AND base_state_digest IS NULL
      AND base_release_generation IS NULL
      AND base_snapshot IS NULL
      AND prior_app_state IS NULL
      AND claimed_release_generation = 1
    )
    OR (
      intent IN ('interface', 'function', 'routine')
      AND base_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
      AND base_state_digest IS NOT NULL
      AND base_release_generation IS NOT NULL
      AND base_release_generation >= 0
      AND jsonb_typeof(base_snapshot) = 'object'
      AND jsonb_typeof(prior_app_state) = 'object'
      AND claimed_release_generation = base_release_generation + 1
    )
  ),
  CONSTRAINT builder_handoff_deployments_terminal_check CHECK (
    (
      status = 'completed'
      AND phase = 'committed'
      AND phase_rank = 8
      AND release_id IS NOT NULL
      AND response IS NOT NULL
      AND completed_at IS NOT NULL
    )
    OR status <> 'completed'
  ),
  CONSTRAINT builder_handoff_deployments_timing_check CHECK (
    updated_at >= created_at
    AND lease_expires_at > created_at
    AND (
      side_effect_started_at IS NULL
      OR side_effect_started_at >= created_at
    )
    AND (base_verified_at IS NULL OR base_verified_at >= created_at)
    AND (completed_at IS NULL OR completed_at >= created_at)
  ),
  CONSTRAINT builder_handoff_deployments_owner_idempotency_unique
    UNIQUE (owner_id, idempotency_key)
);

CREATE UNIQUE INDEX builder_handoff_deployments_active_target_idx
  ON public.builder_handoff_deployments(target_app_id)
  WHERE status = 'in_progress';

CREATE INDEX builder_handoff_deployments_owner_created_idx
  ON public.builder_handoff_deployments(owner_id, created_at DESC);

CREATE TABLE public.app_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL UNIQUE
    REFERENCES public.builder_handoff_deployments(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL UNIQUE
    REFERENCES public.builder_handoff_sessions(id) ON DELETE RESTRICT,
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  version text NOT NULL,
  release_generation bigint NOT NULL,
  archive_digest text NOT NULL,
  release_digest text NOT NULL,
  source_hash text NOT NULL,
  attestation_id text NOT NULL,
  attestation_digest text NOT NULL,
  document_digest text NOT NULL,
  report_digest text NOT NULL,
  storage_key text NOT NULL,
  executable_key text NOT NULL,
  storage_bytes bigint NOT NULL,
  exports jsonb NOT NULL,
  manifest text NOT NULL,
  env_schema jsonb NOT NULL,
  version_metadata jsonb NOT NULL,
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_releases_version_check CHECK (
    version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
  ),
  CONSTRAINT app_releases_generation_check CHECK (release_generation >= 1),
  CONSTRAINT app_releases_digest_check CHECK (
    archive_digest ~ '^[0-9a-f]{64}$'
    AND release_digest ~ '^[0-9a-f]{64}$'
    AND source_hash ~ '^[0-9a-f]{64}$'
    AND attestation_digest ~ '^[0-9a-f]{64}$'
    AND document_digest ~ '^[0-9a-f]{64}$'
    AND report_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT app_releases_storage_check CHECK (
    storage_bytes >= 0
    AND length(storage_key) BETWEEN 1 AND 2048
    AND length(executable_key) BETWEEN 1 AND 2048
  ),
  CONSTRAINT app_releases_json_shape_check CHECK (
    jsonb_typeof(exports) = 'array'
    AND jsonb_typeof(env_schema) = 'object'
    AND jsonb_typeof(version_metadata) = 'object'
    AND jsonb_typeof(provenance) = 'object'
  ),
  CONSTRAINT app_releases_app_version_unique UNIQUE (app_id, version),
  CONSTRAINT app_releases_app_generation_unique
    UNIQUE (app_id, release_generation)
);

ALTER TABLE public.builder_handoff_deployments
  ADD CONSTRAINT builder_handoff_deployments_release_fkey
  FOREIGN KEY (release_id) REFERENCES public.app_releases(id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.apps
  ADD CONSTRAINT apps_active_release_fkey
  FOREIGN KEY (active_release_id) REFERENCES public.app_releases(id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.apps
  ADD CONSTRAINT apps_materializing_deployment_fkey
  FOREIGN KEY (materializing_deployment_id)
  REFERENCES public.builder_handoff_deployments(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX apps_materializing_deployment_idx
  ON public.apps(materializing_deployment_id)
  WHERE materializing_deployment_id IS NOT NULL;

CREATE INDEX app_releases_owner_created_idx
  ON public.app_releases(owner_id, created_at DESC);

CREATE TABLE public.subscription_checkout_attempts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  plan_code text NOT NULL DEFAULT 'pro',
  request_fingerprint text NOT NULL,
  return_url text NOT NULL,
  status text NOT NULL DEFAULT 'creating',
  stripe_checkout_session_id text UNIQUE,
  checkout_url text,
  stripe_customer_id text,
  stripe_subscription_id text,
  last_event_id text,
  last_event_created_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  bound_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT subscription_checkout_attempts_owner_idempotency_unique
    UNIQUE (owner_id, idempotency_key),
  CONSTRAINT subscription_checkout_attempts_fingerprint_check CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT subscription_checkout_attempts_plan_check CHECK (
    plan_code = 'pro'
  ),
  CONSTRAINT subscription_checkout_attempts_return_url_check CHECK (
    length(return_url) BETWEEN 1 AND 2048
    AND left(return_url, 8) = 'https://'
    AND return_url !~ '[[:cntrl:]]'
  ),
  CONSTRAINT subscription_checkout_attempts_status_check CHECK (
    status IN (
      'creating', 'pending', 'active', 'cancelled', 'failed', 'expired'
    )
  ),
  CONSTRAINT subscription_checkout_attempts_stripe_text_check CHECK (
    (
      stripe_checkout_session_id IS NULL
      OR (
        length(stripe_checkout_session_id) BETWEEN 1 AND 255
        AND stripe_checkout_session_id !~ '[[:cntrl:]]'
      )
    )
    AND (
      stripe_customer_id IS NULL
      OR (
        length(stripe_customer_id) BETWEEN 1 AND 255
        AND stripe_customer_id !~ '[[:cntrl:]]'
      )
    )
    AND (
      stripe_subscription_id IS NULL
      OR (
        length(stripe_subscription_id) BETWEEN 1 AND 255
        AND stripe_subscription_id !~ '[[:cntrl:]]'
      )
    )
  ),
  CONSTRAINT subscription_checkout_attempts_checkout_url_check CHECK (
    checkout_url IS NULL
    OR (
      length(checkout_url) BETWEEN 1 AND 4096
      AND left(checkout_url, 8) = 'https://'
      AND checkout_url !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT subscription_checkout_attempts_time_check CHECK (
    expires_at > created_at
    AND updated_at >= created_at
    AND (bound_at IS NULL OR bound_at >= created_at)
    AND (completed_at IS NULL OR completed_at >= created_at)
    AND (
      last_event_created_at IS NULL
      OR last_event_created_at >= created_at - interval '30 days'
    )
    AND (
      (last_event_id IS NULL AND last_event_created_at IS NULL)
      OR (last_event_id IS NOT NULL AND last_event_created_at IS NOT NULL)
    )
  ),
  CONSTRAINT subscription_checkout_attempts_terminal_check CHECK (
    (status IN ('creating', 'pending') AND completed_at IS NULL)
    OR (
      status IN ('active', 'cancelled', 'failed', 'expired')
      AND completed_at IS NOT NULL
    )
  ),
  CONSTRAINT subscription_checkout_attempts_binding_check CHECK (
    status <> 'pending'
    OR (
      stripe_checkout_session_id IS NOT NULL
      AND checkout_url IS NOT NULL
      AND bound_at IS NOT NULL
    )
  )
);

CREATE INDEX subscription_checkout_attempts_owner_created_idx
  ON public.subscription_checkout_attempts(owner_id, created_at DESC);

-- At most one Stripe checkout may be live for an account. The claim RPC
-- serializes on users first and expires stale rows before inserting; this
-- partial unique index is the final race-proof invariant.
CREATE UNIQUE INDEX subscription_checkout_attempts_owner_live_idx
  ON public.subscription_checkout_attempts(owner_id)
  WHERE status IN ('creating', 'pending');

ALTER TABLE public.builder_handoff_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_checkout_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.builder_handoff_deployments
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.app_releases
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.subscription_checkout_attempts
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.builder_handoff_deployments TO service_role;
GRANT SELECT ON TABLE public.app_releases TO service_role;
GRANT SELECT ON TABLE public.subscription_checkout_attempts TO service_role;

-- Client roles retain owner/public reads, but cannot mint Agents, rewrite a
-- release, or activate a routine with direct PostgREST writes.
REVOKE ALL ON TABLE public.apps FROM anon, authenticated;
GRANT SELECT ON TABLE public.apps TO anon, authenticated;
REVOKE ALL ON TABLE public.user_routines FROM anon, authenticated;
GRANT SELECT ON TABLE public.user_routines TO authenticated;
REVOKE ALL ON TABLE public.routine_capabilities FROM anon, authenticated;
GRANT SELECT ON TABLE public.routine_capabilities TO authenticated;
REVOKE ALL ON TABLE public.routine_runs FROM anon, authenticated;
GRANT SELECT ON TABLE public.routine_runs TO authenticated;
REVOKE ALL ON TABLE public.routine_run_steps FROM anon, authenticated;
GRANT SELECT ON TABLE public.routine_run_steps TO authenticated;
REVOKE ALL ON TABLE public.routine_dashboard_bindings
  FROM anon, authenticated;
GRANT SELECT ON TABLE public.routine_dashboard_bindings TO authenticated;

DROP POLICY IF EXISTS "apps_owner" ON public.apps;
DROP POLICY IF EXISTS "apps_public_read" ON public.apps;
CREATE POLICY apps_owner_select
  ON public.apps
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = owner_id
    AND deleted_at IS NULL
    AND deployment_state <> 'materializing'
  );
CREATE POLICY apps_public_select
  ON public.apps
  FOR SELECT
  TO anon, authenticated
  USING (
    visibility = 'public'
    AND deleted_at IS NULL
    AND deployment_state <> 'materializing'
  );

DROP POLICY IF EXISTS "user_routines_own" ON public.user_routines;
CREATE POLICY user_routines_owner_select
  ON public.user_routines
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Storage accounting is a server-owned release invariant. These historical
-- SECURITY DEFINER functions previously let authenticated owners lower their
-- billable app bytes directly.
REVOKE ALL ON FUNCTION public.set_app_storage_bytes(uuid, uuid, bigint)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_upload_storage(uuid, uuid, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_app_storage_bytes(uuid, uuid, bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_upload_storage(uuid, uuid, text, bigint)
  TO service_role;

CREATE OR REPLACE FUNCTION public.builder_handoff_deployment_phase_rank(
  p_phase text
) RETURNS smallint
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_phase
    WHEN 'claimed' THEN 0
    WHEN 'archive_verified' THEN 1
    WHEN 'artifacts_started' THEN 2
    WHEN 'artifacts_verified' THEN 3
    WHEN 'migrations_started' THEN 4
    WHEN 'migrations_verified' THEN 5
    WHEN 'live_bundle_started' THEN 6
    WHEN 'live_bundle_verified' THEN 7
    WHEN 'committed' THEN 8
    ELSE NULL
  END::smallint;
$$;

CREATE OR REPLACE FUNCTION public.builder_handoff_normalized_manifest(
  p_manifest text
) RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_manifest IS NULL THEN
    RETURN 'null'::jsonb;
  END IF;
  BEGIN
    RETURN p_manifest::jsonb;
  EXCEPTION
    WHEN OTHERS THEN
      RETURN to_jsonb(p_manifest);
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_handoff_app_base_snapshot(
  p_app_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app public.apps%ROWTYPE;
  v_metadata jsonb;
  v_source_hash text;
  v_release_digest text;
BEGIN
  SELECT app.*
    INTO v_app
  FROM public.apps AS app
  WHERE app.id = p_app_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT entry.value
    INTO v_metadata
  FROM jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(v_app.version_metadata) = 'array'
        THEN v_app.version_metadata
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS entry(value, position)
  WHERE entry.value->>'version' = v_app.current_version
  ORDER BY entry.position DESC
  LIMIT 1;

  v_source_hash := CASE
    WHEN v_metadata->>'source_hash' ~ '^[0-9a-f]{64}$'
      THEN v_metadata->>'source_hash'
    ELSE NULL
  END;
  v_release_digest := CASE
    WHEN v_app.active_release_digest ~ '^[0-9a-f]{64}$'
      THEN v_app.active_release_digest
    WHEN v_metadata #>> '{test_attestation,qualification,release_digest}'
      ~ '^[0-9a-f]{64}$'
      THEN v_metadata #>> '{test_attestation,qualification,release_digest}'
    ELSE NULL
  END;

  RETURN jsonb_build_object(
    'app_id', v_app.id,
    'current_version', v_app.current_version,
    'source_hash', v_source_hash,
    'release_digest', v_release_digest,
    'manifest', public.builder_handoff_normalized_manifest(v_app.manifest)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_app_release_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'app_release_is_immutable',
    DETAIL = jsonb_build_object(
      'code', 'APP_RELEASE_IMMUTABLE',
      'releaseId', OLD.id
    )::text;
END;
$$;

DROP TRIGGER IF EXISTS prevent_app_release_mutation ON public.app_releases;
CREATE TRIGGER prevent_app_release_mutation
  BEFORE UPDATE OR DELETE ON public.app_releases
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_app_release_mutation();

CREATE OR REPLACE FUNCTION public.is_service_role_request()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    public.try_parse_agent_home_jsonb(
      NULLIF(current_setting('request.jwt.claims', true), '')
    )->>'role'
  ) = 'service_role';
$$;

-- Replace the historical conditional promotion guard with a permanent guard.
-- Legacy Agent Home promotion is recognized only for legacy rows and only
-- when its existing fenced transaction-local request identity is live.
CREATE OR REPLACE FUNCTION public.guard_agent_home_promotion_release_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_setting text;
BEGIN
  IF ROW(
    OLD.current_version,
    OLD.versions,
    OLD.version_metadata,
    OLD.storage_key,
    OLD.exports,
    OLD.manifest,
    OLD.env_schema,
    OLD.deployment_state,
    OLD.release_generation,
    OLD.active_release_id,
    OLD.active_release_digest,
    OLD.active_archive_digest,
    OLD.materializing_deployment_id,
    OLD.setup_required_at
  ) IS NOT DISTINCT FROM ROW(
    NEW.current_version,
    NEW.versions,
    NEW.version_metadata,
    NEW.storage_key,
    NEW.exports,
    NEW.manifest,
    NEW.env_schema,
    NEW.deployment_state,
    NEW.release_generation,
    NEW.active_release_id,
    NEW.active_release_digest,
    NEW.active_archive_digest,
    NEW.materializing_deployment_id,
    NEW.setup_required_at
  ) THEN
    RETURN NEW;
  END IF;

  -- Preserve the existing paid gx.upload / draft-publish lane. Only the
  -- trusted service-role API may rewrite legacy release fields, only while
  -- the owner is actively Pro, and it may not mint or alter M7 provenance.
  IF OLD.deployment_state = 'legacy'
    AND NEW.deployment_state = 'legacy'
    AND public.is_service_role_request()
    AND ROW(
      OLD.release_generation,
      OLD.active_release_id,
      OLD.active_release_digest,
      OLD.active_archive_digest,
      OLD.materializing_deployment_id,
      OLD.setup_required_at
    ) IS NOT DISTINCT FROM ROW(
      NEW.release_generation,
      NEW.active_release_id,
      NEW.active_release_digest,
      NEW.active_archive_digest,
      NEW.materializing_deployment_id,
      NEW.setup_required_at
    )
    AND EXISTS (
      SELECT 1
      FROM public.account_entitlements AS entitlement
      WHERE entitlement.user_id = OLD.owner_id
        AND entitlement.plan_code = 'pro'
        AND entitlement.subscription_status = 'active'
    ) THEN
    RETURN NEW;
  END IF;

  v_setting := current_setting(
    'galactic.builder_handoff_deployment', true
  );
  IF v_setting ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1
      FROM public.builder_handoff_deployments AS deployment
      WHERE deployment.id = v_setting::uuid
        AND deployment.target_app_id = OLD.id
        AND deployment.status = 'in_progress'
        AND deployment.phase = 'live_bundle_verified'
        AND deployment.lease_expires_at > now()
    ) THEN
    RETURN NEW;
  END IF;

  -- Claiming an extension suspends its currently executable release before
  -- any D1/R2/KV side effect. Release pointers and provenance cannot change.
  IF v_setting ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NEW.deployment_state = 'materializing'
    AND NEW.materializing_deployment_id = v_setting::uuid
    AND NEW.visibility = 'private'
    AND NEW.hosting_suspended = true
    AND NEW.http_enabled = false
    AND ROW(
      OLD.current_version, OLD.versions, OLD.version_metadata,
      OLD.storage_key, OLD.exports, OLD.manifest, OLD.env_schema,
      OLD.release_generation, OLD.active_release_id,
      OLD.active_release_digest, OLD.active_archive_digest,
      OLD.setup_required_at
    ) IS NOT DISTINCT FROM ROW(
      NEW.current_version, NEW.versions, NEW.version_metadata,
      NEW.storage_key, NEW.exports, NEW.manifest, NEW.env_schema,
      NEW.release_generation, NEW.active_release_id,
      NEW.active_release_digest, NEW.active_archive_digest,
      NEW.setup_required_at
    )
    AND EXISTS (
      SELECT 1
      FROM public.builder_handoff_deployments AS deployment
      WHERE deployment.id = v_setting::uuid
        AND deployment.target_app_id = OLD.id
        AND deployment.status = 'in_progress'
        AND deployment.phase = 'claimed'
        AND deployment.side_effect_started_at IS NULL
        AND deployment.lease_expires_at > now()
    ) THEN
    RETURN NEW;
  END IF;

  -- Before the first irreversible side effect, a failed extension claim may
  -- restore precisely the runtime state captured by that deployment.
  IF v_setting ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND OLD.deployment_state = 'materializing'
    AND OLD.materializing_deployment_id = v_setting::uuid
    AND ROW(
      OLD.current_version, OLD.versions, OLD.version_metadata,
      OLD.storage_key, OLD.exports, OLD.manifest, OLD.env_schema,
      OLD.release_generation, OLD.active_release_id,
      OLD.active_release_digest, OLD.active_archive_digest
    ) IS NOT DISTINCT FROM ROW(
      NEW.current_version, NEW.versions, NEW.version_metadata,
      NEW.storage_key, NEW.exports, NEW.manifest, NEW.env_schema,
      NEW.release_generation, NEW.active_release_id,
      NEW.active_release_digest, NEW.active_archive_digest
    )
    AND EXISTS (
      SELECT 1
      FROM public.builder_handoff_deployments AS deployment
      WHERE deployment.id = v_setting::uuid
        AND deployment.target_app_id = OLD.id
        AND deployment.status = 'in_progress'
        AND deployment.phase_rank <= 1
        AND deployment.side_effect_started_at IS NULL
        AND NEW.deployment_state =
          deployment.prior_app_state->>'deployment_state'
        AND NEW.visibility =
          deployment.prior_app_state->>'visibility'
        AND NEW.hosting_suspended = COALESCE(
          (deployment.prior_app_state->>'hosting_suspended')::boolean,
          false
        )
        AND NEW.http_enabled = COALESCE(
          (deployment.prior_app_state->>'http_enabled')::boolean,
          true
        )
        AND NEW.materializing_deployment_id IS NOT DISTINCT FROM
          NULLIF(
            deployment.prior_app_state->>'materializing_deployment_id',
            ''
          )::uuid
        AND NEW.setup_required_at IS NOT DISTINCT FROM
          NULLIF(
            deployment.prior_app_state->>'setup_required_at',
            ''
          )::timestamptz
    ) THEN
    RETURN NEW;
  END IF;

  -- The setup boundary is crossed only by the membership activation RPC.
  -- Release identity is immutable here: activation makes the already
  -- materialized release runnable, it never substitutes new executable bytes.
  v_setting := current_setting(
    'galactic.member_agent_activation', true
  );
  IF v_setting = OLD.id::text
    AND OLD.deployment_state = 'setup_required'
    AND NEW.deployment_state = 'ready'
    AND NEW.materializing_deployment_id IS NULL
    AND NEW.setup_required_at IS NULL
    AND ROW(
      OLD.current_version, OLD.versions, OLD.version_metadata,
      OLD.storage_key, OLD.exports, OLD.manifest, OLD.env_schema,
      OLD.release_generation, OLD.active_release_id,
      OLD.active_release_digest, OLD.active_archive_digest
    ) IS NOT DISTINCT FROM ROW(
      NEW.current_version, NEW.versions, NEW.version_metadata,
      NEW.storage_key, NEW.exports, NEW.manifest, NEW.env_schema,
      NEW.release_generation, NEW.active_release_id,
      NEW.active_release_digest, NEW.active_archive_digest
    )
    AND EXISTS (
      SELECT 1
      FROM public.account_entitlements AS entitlement
      WHERE entitlement.user_id = OLD.owner_id
        AND entitlement.plan_code = 'pro'
        AND entitlement.subscription_status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM public.app_releases AS release
      WHERE release.id = OLD.active_release_id
        AND release.app_id = OLD.id
        AND release.owner_id = OLD.owner_id
        AND release.release_generation = OLD.release_generation
        AND release.release_digest = OLD.active_release_digest
        AND release.archive_digest = OLD.active_archive_digest
    ) THEN
    RETURN NEW;
  END IF;

  v_setting := current_setting(
    'galactic.agent_home_promotion_request', true
  );
  IF OLD.deployment_state = 'legacy'
    AND v_setting ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1
      FROM public.agent_home_action_requests AS request
      WHERE request.id = v_setting::uuid
        AND request.app_id = OLD.id
        AND request.action = 'promote_candidate'
        AND request.status = 'in_progress'
        AND request.side_effect_started_at IS NOT NULL
        AND request.lease_expires_at > now()
    ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'app_release_write_not_authorized',
    DETAIL = jsonb_build_object(
      'code', 'APP_RELEASE_WRITE_NOT_AUTHORIZED',
      'appId', OLD.id
    )::text;
END;
$$;

DROP TRIGGER IF EXISTS guard_agent_home_promotion_release_write ON public.apps;
CREATE TRIGGER guard_agent_home_promotion_release_write
  BEFORE UPDATE OF
    current_version,
    versions,
    version_metadata,
    storage_key,
    exports,
    manifest,
    env_schema,
    deployment_state,
    release_generation,
    active_release_id,
    active_release_digest,
    active_archive_digest,
    materializing_deployment_id,
    setup_required_at
  ON public.apps
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_agent_home_promotion_release_write();

CREATE OR REPLACE FUNCTION public.guard_app_membership_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_setting text;
BEGIN
  -- Migration fixtures and direct administrative repair run as the physical
  -- postgres session. PostgREST requests retain session_user=authenticator,
  -- including SECURITY DEFINER calls, and therefore cannot use this escape.
  IF session_user = 'postgres' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_setting := current_setting(
      'galactic.builder_handoff_deployment', true
    );
    IF NEW.deployment_state = 'materializing'
      AND NEW.visibility = 'private'
      AND NEW.hosting_suspended = true
      AND NEW.http_enabled = false
      AND NEW.materializing_deployment_id IS NOT NULL
      AND v_setting = NEW.materializing_deployment_id::text
      AND EXISTS (
        SELECT 1
        FROM public.builder_handoff_deployments AS deployment
        WHERE deployment.id = NEW.materializing_deployment_id
          AND deployment.owner_id = NEW.owner_id
          AND deployment.target_app_id = NEW.id
          AND deployment.status = 'in_progress'
          AND deployment.phase = 'claimed'
          AND deployment.side_effect_started_at IS NULL
          AND deployment.lease_expires_at > now()
      ) THEN
      RETURN NEW;
    END IF;

    IF NEW.deployment_state = 'legacy'
      AND NEW.owner_id IS NOT NULL
      AND public.is_service_role_request() THEN
      PERFORM 1
      FROM public.account_entitlements AS entitlement
      WHERE entitlement.user_id = NEW.owner_id
        AND entitlement.plan_code = 'pro'
        AND entitlement.subscription_status = 'active'
      FOR UPDATE;
      IF FOUND THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'pro_subscription_required',
        DETAIL = '{"code":"PRO_SUBSCRIPTION_REQUIRED"}';
    END IF;

    IF NEW.owner_id IS NULL
      OR NEW.visibility IS DISTINCT FROM 'private' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'app_deployment_not_authorized',
        DETAIL = '{"code":"PRO_SUBSCRIPTION_REQUIRED"}';
    END IF;
    PERFORM 1
    FROM public.account_entitlements AS entitlement
    WHERE entitlement.user_id = NEW.owner_id
      AND entitlement.plan_code = 'pro'
      AND entitlement.subscription_status = 'active'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'pro_subscription_required',
        DETAIL = '{"code":"PRO_SUBSCRIPTION_REQUIRED"}';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.visibility IS NOT DISTINCT FROM OLD.visibility
    OR NEW.visibility = 'private' THEN
    RETURN NEW;
  END IF;

  IF OLD.deployment_state = 'legacy'
    AND NEW.deployment_state = 'legacy'
    AND public.is_service_role_request()
    AND EXISTS (
      SELECT 1
      FROM public.account_entitlements AS entitlement
      WHERE entitlement.user_id = NEW.owner_id
        AND entitlement.plan_code = 'pro'
        AND entitlement.subscription_status = 'active'
    ) THEN
    RETURN NEW;
  END IF;

  IF NEW.deployment_state <> 'ready'
    OR NEW.active_release_id IS NULL
    OR NEW.active_release_digest IS NULL
    OR NEW.active_archive_digest IS NULL
    OR NEW.release_generation < 1
    OR NEW.hosting_suspended = true THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'app_publication_not_ready',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_HOME_INVALID_MUTATION',
        'field', 'visibility',
        'reason', 'deployed_agent_not_ready'
      )::text;
  END IF;

  PERFORM 1
  FROM public.account_entitlements AS entitlement
  WHERE entitlement.user_id = NEW.owner_id
    AND entitlement.plan_code = 'pro'
    AND entitlement.subscription_status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'pro_subscription_required',
      DETAIL = '{"code":"PRO_SUBSCRIPTION_REQUIRED"}';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_app_membership_lifecycle ON public.apps;
CREATE TRIGGER guard_app_membership_lifecycle
  BEFORE INSERT OR UPDATE OF visibility
  ON public.apps
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_app_membership_lifecycle();

CREATE OR REPLACE FUNCTION public.guard_builder_handoff_session_promotion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_setting text;
BEGIN
  IF OLD.status IS DISTINCT FROM 'uploaded'
    OR NEW.status IS DISTINCT FROM 'promoted' THEN
    RETURN NEW;
  END IF;

  v_setting := current_setting(
    'galactic.builder_handoff_deployment', true
  );
  IF v_setting ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1
      FROM public.builder_handoff_deployments AS deployment
      WHERE deployment.id = v_setting::uuid
        AND deployment.session_id = OLD.id
        AND deployment.owner_id = OLD.owner_id
        AND deployment.status = 'in_progress'
        AND deployment.phase = 'live_bundle_verified'
        AND deployment.lease_expires_at > now()
    ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'builder_handoff_promotion_not_authorized',
    DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_PROMOTION_NOT_AUTHORIZED',
      'sessionId', OLD.id
    )::text;
END;
$$;

DROP TRIGGER IF EXISTS guard_builder_handoff_session_promotion
  ON public.builder_handoff_sessions;
CREATE TRIGGER guard_builder_handoff_session_promotion
  BEFORE UPDATE OF status ON public.builder_handoff_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_builder_handoff_session_promotion();

CREATE OR REPLACE FUNCTION public.enforce_active_routine_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app public.apps%ROWTYPE;
BEGIN
  IF NEW.status <> 'active' OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- This lock makes a direct service-role activation serialize with a Stripe
  -- downgrade. Legitimate activation RPCs already take this lock before the
  -- routine row and therefore preserve the global lock order.
  PERFORM 1
  FROM public.account_entitlements AS entitlement
  WHERE entitlement.user_id = NEW.user_id
    AND entitlement.plan_code = 'pro'
    AND entitlement.subscription_status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'pro_subscription_required',
      DETAIL = jsonb_build_object(
        'code', 'PRO_SUBSCRIPTION_REQUIRED',
        'userId', NEW.user_id
      )::text;
  END IF;

  SELECT app.*
    INTO v_app
  FROM public.apps AS app
  WHERE app.id = NEW.composer_app_id
    AND app.owner_id = NEW.user_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_app.deleted_at IS NOT NULL
    OR v_app.hosting_suspended = true
    OR v_app.deployment_state NOT IN ('legacy', 'ready') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_deployment_not_runnable',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_DEPLOYMENT_NOT_RUNNABLE',
        'appId', NEW.composer_app_id,
        'deploymentState', v_app.deployment_state
      )::text;
  END IF;
  RETURN NEW;
END;
$$;

-- Existing non-member active rows are unsafe once executor claims become
-- membership-aware. Pause all of them, not only launch-tagged routines.
UPDATE public.user_routines AS routine
SET status = 'paused',
    next_run_at = NULL,
    lease_id = NULL,
    lease_expires_at = NULL,
    metadata = COALESCE(routine.metadata, '{}'::jsonb) || jsonb_build_object(
      'membership_pause',
      jsonb_build_object(
        'code', 'pro_subscription_required',
        'at', now()
      )
    ),
    updated_at = now()
WHERE routine.status = 'active'
  AND routine.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.account_entitlements AS entitlement
    WHERE entitlement.user_id = routine.user_id
      AND entitlement.plan_code = 'pro'
      AND entitlement.subscription_status = 'active'
  );

DROP TRIGGER IF EXISTS enforce_active_routine_membership
  ON public.user_routines;
CREATE TRIGGER enforce_active_routine_membership
  BEFORE INSERT OR UPDATE OF status, user_id, deleted_at
  ON public.user_routines
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_active_routine_membership();

-- Generation-aware creation overload. The historical signature remains
-- callable internally for migration compatibility, but service_role is moved
-- to this overload. A pre-existing extension session with no generation is
-- deliberately not retrofitted: it must be recreated from a fresh snapshot.
CREATE OR REPLACE FUNCTION public.create_builder_handoff_session(
  p_owner_id uuid,
  p_session_id uuid,
  p_candidate_set_id uuid,
  p_intent text,
  p_target_app_id uuid,
  p_base_version text,
  p_base_source_hash text,
  p_base_release_digest text,
  p_base_state_digest text,
  p_base_release_generation bigint,
  p_token_prefix text,
  p_token_hash text,
  p_token_salt text,
  p_description_sha256 text,
  p_now timestamptz
) RETURNS SETOF public.builder_handoff_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existed boolean;
  v_session public.builder_handoff_sessions%ROWTYPE;
BEGIN
  IF (
    p_intent IN ('interface', 'function', 'routine')
    AND (
      p_base_release_generation IS NULL
      OR p_base_release_generation < 0
    )
  ) OR (
    p_intent IN ('agent', 'connect')
    AND p_base_release_generation IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'builder_handoff_base_generation_invalid',
      DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_CREATE_INVALID',
        'field', 'baseReleaseGeneration'
      )::text;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.builder_handoff_sessions AS existing
    WHERE existing.id = p_session_id
  ) INTO v_existed;

  SELECT created.*
    INTO v_session
  FROM public.create_builder_handoff_session(
    p_owner_id,
    p_session_id,
    p_candidate_set_id,
    p_intent,
    p_target_app_id,
    p_base_version,
    p_base_source_hash,
    p_base_release_digest,
    p_base_state_digest,
    p_token_prefix,
    p_token_hash,
    p_token_salt,
    p_description_sha256,
    p_now
  ) AS created;

  IF v_existed THEN
    IF v_session.base_release_generation
      IS DISTINCT FROM p_base_release_generation THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'builder_handoff_base_generation_conflict',
        DETAIL = jsonb_build_object(
          'code', 'BUILDER_HANDOFF_CREATE_CONFLICT',
          'field', 'baseReleaseGeneration'
        )::text;
    END IF;
  ELSE
    UPDATE public.builder_handoff_sessions AS session
    SET base_release_generation = p_base_release_generation
    WHERE session.id = p_session_id
      AND session.owner_id = p_owner_id
      AND session.base_release_generation IS NULL
    RETURNING session.* INTO v_session;
    IF NOT FOUND THEN
      SELECT session.*
        INTO v_session
      FROM public.builder_handoff_sessions AS session
      WHERE session.id = p_session_id
        AND session.owner_id = p_owner_id;
      IF NOT FOUND OR v_session.base_release_generation
        IS DISTINCT FROM p_base_release_generation THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'builder_handoff_base_generation_conflict',
          DETAIL = jsonb_build_object(
            'code', 'BUILDER_HANDOFF_CREATE_CONFLICT',
            'field', 'baseReleaseGeneration'
          )::text;
      END IF;
    END IF;
  END IF;

  RETURN NEXT v_session;
END;
$$;

REVOKE ALL ON FUNCTION public.create_builder_handoff_session(
  uuid, uuid, uuid, text, uuid, text, text, text, text, text, text, text, text,
  timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_builder_handoff_session(
  uuid, uuid, uuid, text, uuid, text, text, text, text, bigint, text, text,
  text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_builder_handoff_session(
  uuid, uuid, uuid, text, uuid, text, text, text, text, bigint, text, text,
  text, text, timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_handoff_deployment_result(
  p_deployment public.builder_handoff_deployments,
  p_code text,
  p_replayed boolean DEFAULT false,
  p_requires_reconciliation boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'code', p_code,
    'deployment_id', p_deployment.id,
    'status', p_deployment.status,
    'phase', p_deployment.phase,
    'lease_expires_at', p_deployment.lease_expires_at,
    'app_id', p_deployment.target_app_id,
    'version', p_deployment.version,
    'replayed', p_replayed,
    'requires_reconciliation', p_requires_reconciliation,
    'base_snapshot', p_deployment.base_snapshot,
    'base_state_digest', p_deployment.base_state_digest,
    'release_generation', p_deployment.claimed_release_generation,
    'release_id', p_deployment.release_id
  );
$$;

CREATE OR REPLACE FUNCTION public.claim_builder_handoff_deployment(
  p_request jsonb,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid;
  v_session_id uuid;
  v_target_app_id uuid;
  v_lease_token uuid;
  v_idempotency_key text;
  v_request_fingerprint text;
  v_archive_digest text;
  v_release_digest text;
  v_version text;
  v_base_state_digest text;
  v_base_release_generation bigint;
  v_review_revision text;
  v_bound_payload jsonb;
  v_session public.builder_handoff_sessions%ROWTYPE;
  v_deployment public.builder_handoff_deployments%ROWTYPE;
  v_app public.apps%ROWTYPE;
  v_base_snapshot jsonb;
  v_prior_app_state jsonb;
  v_lease_expires_at timestamptz;
BEGIN
  IF jsonb_typeof(p_request) <> 'object' OR p_now IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'builder_handoff_deployment_invalid',
      DETAIL = '{"code":"BUILDER_HANDOFF_DEPLOYMENT_INVALID"}';
  END IF;

  BEGIN
    v_owner_id := (p_request->>'owner_id')::uuid;
    v_session_id := (p_request->>'session_id')::uuid;
    v_target_app_id := (p_request->>'target_app_id')::uuid;
    v_lease_token := (p_request->>'lease_token')::uuid;
    v_base_release_generation :=
      NULLIF(p_request->>'base_release_generation', '')::bigint;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'builder_handoff_deployment_invalid',
        DETAIL = '{"code":"BUILDER_HANDOFF_DEPLOYMENT_INVALID"}';
  END;

  v_idempotency_key := p_request->>'idempotency_key';
  v_request_fingerprint := p_request->>'request_fingerprint';
  v_archive_digest := p_request->>'candidate_archive_digest';
  v_release_digest := p_request->>'release_digest';
  v_version := p_request->>'version';
  v_base_state_digest := NULLIF(p_request->>'base_state_digest', '');
  v_review_revision := p_request->>'review_revision';

  IF v_owner_id IS NULL
    OR v_session_id IS NULL
    OR v_target_app_id IS NULL
    OR v_lease_token IS NULL
    OR v_idempotency_key IS NULL
    OR length(v_idempotency_key) NOT BETWEEN 1 AND 200
    OR v_idempotency_key <> btrim(v_idempotency_key)
    OR v_idempotency_key ~ '[[:cntrl:]]'
    OR v_request_fingerprint !~ '^[0-9a-f]{64}$'
    OR v_archive_digest !~ '^[0-9a-f]{64}$'
    OR v_release_digest !~ '^[0-9a-f]{64}$'
    OR v_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    OR v_review_revision IS NULL
    OR length(v_review_revision) NOT BETWEEN 1 AND 128
    OR v_review_revision <> btrim(v_review_revision)
    OR v_review_revision ~ '[[:cntrl:]]'
    OR (
      v_base_state_digest IS NOT NULL
      AND v_base_state_digest !~ '^[0-9a-f]{64}$'
    )
    OR (
      v_base_release_generation IS NOT NULL
      AND v_base_release_generation < 0
    ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'builder_handoff_deployment_invalid',
      DETAIL = '{"code":"BUILDER_HANDOFF_DEPLOYMENT_INVALID"}';
  END IF;

  v_bound_payload := jsonb_build_object(
    'owner_id', v_owner_id,
    'session_id', v_session_id,
    'target_app_id', v_target_app_id,
    'idempotency_key', v_idempotency_key,
    'request_fingerprint', v_request_fingerprint,
    'candidate_archive_digest', v_archive_digest,
    'release_digest', v_release_digest,
    'version', v_version,
    'base_state_digest', v_base_state_digest,
    'base_release_generation', v_base_release_generation,
    'review_revision', v_review_revision
  );
  v_lease_expires_at := p_now + interval '5 minutes';

  PERFORM 1
  FROM public.users AS owner
  WHERE owner.id = v_owner_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'code', 'owner_not_found',
      'replayed', false
    );
  END IF;

  PERFORM 1
  FROM public.account_entitlements AS entitlement
  WHERE entitlement.user_id = v_owner_id
    AND entitlement.plan_code = 'pro'
    AND entitlement.subscription_status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'code', 'pro_subscription_required',
      'replayed', false
    );
  END IF;

  SELECT session.*
    INTO v_session
  FROM public.builder_handoff_sessions AS session
  WHERE session.id = v_session_id
    AND session.owner_id = v_owner_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'code', 'candidate_not_found',
      'replayed', false
    );
  END IF;

  SELECT deployment.*
    INTO v_deployment
  FROM public.builder_handoff_deployments AS deployment
  WHERE deployment.owner_id = v_owner_id
    AND deployment.idempotency_key = v_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_deployment.request_payload IS DISTINCT FROM v_bound_payload THEN
      RETURN jsonb_build_object(
        'code', 'idempotency_mismatch',
        'deployment_id', v_deployment.id,
        'status', v_deployment.status,
        'phase', v_deployment.phase,
        'app_id', v_deployment.target_app_id,
        'version', v_deployment.version,
        'replayed', true
      );
    END IF;
    IF v_deployment.status = 'completed' THEN
      RETURN public.builder_handoff_deployment_result(
        v_deployment,
        'already_completed',
        true,
        false
      ) || COALESCE(v_deployment.response, '{}'::jsonb);
    END IF;
    IF v_deployment.status <> 'in_progress' THEN
      RETURN public.builder_handoff_deployment_result(
        v_deployment,
        v_deployment.status,
        true,
        v_deployment.status = 'repair_required'
      );
    END IF;
    IF v_deployment.lease_expires_at > p_now
      AND v_deployment.lease_token IS DISTINCT FROM v_lease_token THEN
      RETURN public.builder_handoff_deployment_result(
        v_deployment,
        'in_progress',
        true,
        false
      );
    END IF;
    IF v_deployment.lease_expires_at <= p_now
      AND v_deployment.side_effect_started_at IS NOT NULL THEN
      RETURN public.builder_handoff_deployment_result(
        v_deployment,
        'reconciliation_required',
        true,
        true
      );
    END IF;

    UPDATE public.builder_handoff_deployments AS deployment
    SET lease_token = v_lease_token,
        lease_expires_at = v_lease_expires_at,
        attempt_count = deployment.attempt_count + 1,
        updated_at = p_now
    WHERE deployment.id = v_deployment.id
    RETURNING deployment.* INTO v_deployment;

    RETURN public.builder_handoff_deployment_result(
      v_deployment,
      'reclaimed',
      true,
      false
    );
  END IF;

  IF v_session.status <> 'uploaded'
    OR v_session.intent = 'connect'
    OR v_session.target_app_id IS DISTINCT FROM v_target_app_id
    OR v_session.uploaded_app_id IS DISTINCT FROM v_target_app_id
    OR v_session.uploaded_version IS DISTINCT FROM v_version
    OR v_session.candidate_archive_digest IS DISTINCT FROM v_archive_digest
    OR v_session.release_digest IS DISTINCT FROM v_release_digest
    OR v_session.source_hash IS NULL
    OR v_session.attestation_id IS NULL
    OR v_session.attestation_digest IS NULL
    OR v_session.document_digest IS NULL
    OR v_session.report_digest IS NULL THEN
    RETURN jsonb_build_object(
      'code', 'candidate_lineage_conflict',
      'replayed', false
    );
  END IF;

  IF v_session.intent = 'agent' THEN
    IF v_base_state_digest IS NOT NULL
      OR v_base_release_generation IS NOT NULL
      OR v_session.base_release_generation IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM public.apps AS app
        WHERE app.id = v_target_app_id
      ) THEN
      RETURN jsonb_build_object(
        'code', 'target_conflict',
        'replayed', false
      );
    END IF;
    v_base_snapshot := NULL;
    v_prior_app_state := NULL;
  ELSE
    IF v_session.base_release_generation IS NULL THEN
      RETURN jsonb_build_object(
        'code', 'base_generation_missing_recreate',
        'replayed', false
      );
    END IF;
    IF v_session.base_state_digest IS DISTINCT FROM v_base_state_digest
      OR v_session.base_release_generation
        IS DISTINCT FROM v_base_release_generation THEN
      RETURN jsonb_build_object(
        'code', 'base_lineage_conflict',
        'replayed', false
      );
    END IF;

    SELECT app.*
      INTO v_app
    FROM public.apps AS app
    WHERE app.id = v_target_app_id
      AND app.owner_id = v_owner_id
      AND app.deleted_at IS NULL
      AND app.deployment_state <> 'materializing'
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'code', 'target_not_found',
        'replayed', false
      );
    END IF;

    v_base_snapshot :=
      public.builder_handoff_app_base_snapshot(v_target_app_id);
    IF v_app.current_version IS DISTINCT FROM v_session.base_version
      OR v_app.release_generation
        IS DISTINCT FROM v_session.base_release_generation
      OR v_base_snapshot->>'source_hash'
        IS DISTINCT FROM v_session.base_source_hash
      OR v_base_snapshot->>'release_digest'
        IS DISTINCT FROM v_session.base_release_digest THEN
      RETURN jsonb_build_object(
        'code', 'base_lineage_stale',
        'replayed', false,
        'base_snapshot', v_base_snapshot
      );
    END IF;
    -- Reject a reused semantic version while the target app and candidate are
    -- still locked and before any deployment row, app state, or external
    -- artifact can be mutated.
    IF v_version = ANY(COALESCE(v_app.versions, ARRAY[]::text[]))
      OR EXISTS (
        SELECT 1
        FROM public.app_releases AS release
        WHERE release.app_id = v_target_app_id
          AND release.version = v_version
      ) THEN
      RETURN jsonb_build_object(
        'code', 'target_version_conflict',
        'app_id', v_target_app_id,
        'version', v_version,
        'replayed', false
      );
    END IF;
    v_prior_app_state := jsonb_build_object(
      'deployment_state', v_app.deployment_state,
      'visibility', v_app.visibility,
      'hosting_suspended', v_app.hosting_suspended,
      'http_enabled', v_app.http_enabled,
      'materializing_deployment_id', v_app.materializing_deployment_id,
      'setup_required_at', v_app.setup_required_at
    );
  END IF;

  INSERT INTO public.builder_handoff_deployments (
    session_id,
    owner_id,
    target_app_id,
    intent,
    version,
    idempotency_key,
    request_fingerprint,
    request_payload,
    review_revision,
    candidate_archive_digest,
    release_digest,
    source_hash,
    attestation_id,
    attestation_digest,
    document_digest,
    report_digest,
    base_version,
    base_source_hash,
    base_release_digest,
    base_state_digest,
    base_release_generation,
    base_snapshot,
    prior_app_state,
    claimed_release_generation,
    status,
    phase,
    phase_rank,
    lease_token,
    lease_expires_at,
    created_at,
    updated_at
  ) VALUES (
    v_session.id,
    v_session.owner_id,
    v_session.target_app_id,
    v_session.intent,
    v_session.uploaded_version,
    v_idempotency_key,
    v_request_fingerprint,
    v_bound_payload,
    v_review_revision,
    v_session.candidate_archive_digest,
    v_session.release_digest,
    v_session.source_hash,
    v_session.attestation_id,
    v_session.attestation_digest,
    v_session.document_digest,
    v_session.report_digest,
    v_session.base_version,
    v_session.base_source_hash,
    v_session.base_release_digest,
    v_session.base_state_digest,
    v_session.base_release_generation,
    v_base_snapshot,
    v_prior_app_state,
    COALESCE(v_session.base_release_generation + 1, 1),
    'in_progress',
    'claimed',
    0,
    v_lease_token,
    v_lease_expires_at,
    p_now,
    p_now
  )
  RETURNING * INTO v_deployment;

  IF v_session.intent = 'agent' THEN
    PERFORM set_config(
      'galactic.builder_handoff_deployment',
      v_deployment.id::text,
      true
    );
    INSERT INTO public.apps (
      id,
      owner_id,
      slug,
      name,
      visibility,
      storage_key,
      storage_bytes,
      exports,
      current_version,
      versions,
      version_metadata,
      env_schema,
      manifest,
      had_external_db,
      hosting_suspended,
      http_enabled,
      deployment_state,
      release_generation,
      materializing_deployment_id,
      created_at,
      updated_at
    ) VALUES (
      v_target_app_id,
      v_owner_id,
      'materializing-' || replace(v_target_app_id::text, '-', ''),
      'Agent materializing',
      'private',
      'materializing/' || v_deployment.id::text,
      0,
      '[]'::jsonb,
      '0.0.0',
      ARRAY[]::text[],
      '[]'::jsonb,
      '{}'::jsonb,
      NULL,
      false,
      true,
      false,
      'materializing',
      0,
      v_deployment.id,
      p_now,
      p_now
    );
  ELSE
    PERFORM set_config(
      'galactic.builder_handoff_deployment',
      v_deployment.id::text,
      true
    );
    UPDATE public.apps AS app
    SET deployment_state = 'materializing',
        visibility = 'private',
        hosting_suspended = true,
        http_enabled = false,
        materializing_deployment_id = v_deployment.id,
        updated_at = p_now
    WHERE app.id = v_target_app_id
      AND app.owner_id = v_owner_id
      AND app.release_generation = v_session.base_release_generation;
  END IF;

  RETURN public.builder_handoff_deployment_result(
    v_deployment,
    'claimed',
    false,
    false
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'code', 'deployment_conflict',
      'replayed', false
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_handoff_deployment_base_is_current(
  p_deployment_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deployment public.builder_handoff_deployments%ROWTYPE;
  v_app public.apps%ROWTYPE;
BEGIN
  SELECT deployment.*
    INTO v_deployment
  FROM public.builder_handoff_deployments AS deployment
  WHERE deployment.id = p_deployment_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT app.*
    INTO v_app
  FROM public.apps AS app
  WHERE app.id = v_deployment.target_app_id
    AND app.owner_id = v_deployment.owner_id
    AND app.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_deployment.intent = 'agent' THEN
    RETURN v_app.deployment_state = 'materializing'
      AND v_app.materializing_deployment_id = v_deployment.id
      AND v_app.release_generation = 0
      AND v_app.active_release_id IS NULL;
  END IF;

  RETURN v_app.deployment_state = 'materializing'
    AND v_app.materializing_deployment_id = v_deployment.id
    AND v_app.current_version = v_deployment.base_version
    AND v_app.release_generation = v_deployment.base_release_generation
    AND public.builder_handoff_app_base_snapshot(v_app.id)
      = v_deployment.base_snapshot;
END;
$$;

CREATE OR REPLACE FUNCTION public.fence_builder_handoff_deployment(
  p_request jsonb,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid;
  v_deployment_id uuid;
  v_lease_token uuid;
  v_phase text;
  v_verified_base_state_digest text;
  v_phase_rank smallint;
  v_previous_phase_rank smallint;
  v_deployment public.builder_handoff_deployments%ROWTYPE;
BEGIN
  BEGIN
    v_owner_id := (p_request->>'owner_id')::uuid;
    v_deployment_id := (p_request->>'deployment_id')::uuid;
    v_lease_token := (p_request->>'lease_token')::uuid;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'builder_handoff_deployment_fence_invalid',
        DETAIL = '{"code":"BUILDER_HANDOFF_DEPLOYMENT_INVALID"}';
  END;
  v_phase := p_request->>'phase';
  v_verified_base_state_digest :=
    NULLIF(p_request->>'verified_base_state_digest', '');
  v_phase_rank :=
    public.builder_handoff_deployment_phase_rank(v_phase);

  IF p_now IS NULL
    OR v_owner_id IS NULL
    OR v_deployment_id IS NULL
    OR v_lease_token IS NULL
    OR v_phase_rank IS NULL
    OR v_phase_rank NOT BETWEEN 1 AND 7
    OR (
      v_verified_base_state_digest IS NOT NULL
      AND v_verified_base_state_digest !~ '^[0-9a-f]{64}$'
    ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'builder_handoff_deployment_fence_invalid',
      DETAIL = '{"code":"BUILDER_HANDOFF_DEPLOYMENT_INVALID"}';
  END IF;

  PERFORM 1 FROM public.users
  WHERE id = v_owner_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'owner_not_found');
  END IF;

  SELECT deployment.*
    INTO v_deployment
  FROM public.builder_handoff_deployments AS deployment
  WHERE deployment.id = v_deployment_id
    AND deployment.owner_id = v_owner_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'deployment_not_found');
  END IF;

  PERFORM 1
  FROM public.account_entitlements AS entitlement
  WHERE entitlement.user_id = v_owner_id
    AND entitlement.plan_code = 'pro'
    AND entitlement.subscription_status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    SELECT deployment.*
      INTO v_deployment
    FROM public.builder_handoff_deployments AS deployment
    WHERE deployment.id = v_deployment_id
      AND deployment.owner_id = v_owner_id
    FOR UPDATE;
    IF FOUND AND v_deployment.status = 'in_progress'
      AND v_deployment.side_effect_started_at IS NOT NULL THEN
      UPDATE public.builder_handoff_deployments AS deployment
      SET status = 'repair_required',
          error_code = 'pro_subscription_required',
          error_message =
            'Membership ended after deployment side effects began.',
          updated_at = p_now
      WHERE deployment.id = v_deployment.id
      RETURNING deployment.* INTO v_deployment;
      RETURN public.builder_handoff_deployment_result(
        v_deployment, 'repair_required', false, true
      );
    END IF;
    RETURN jsonb_build_object('code', 'pro_subscription_required');
  END IF;

  PERFORM 1
  FROM public.builder_handoff_sessions AS session
  WHERE session.id = v_deployment.session_id
    AND session.owner_id = v_owner_id
    AND session.status = 'uploaded'
    AND session.candidate_archive_digest =
      v_deployment.candidate_archive_digest
    AND session.release_digest = v_deployment.release_digest
    AND session.uploaded_version = v_deployment.version
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'code', 'candidate_lineage_conflict',
      'deployment_id', v_deployment.id
    );
  END IF;

  SELECT deployment.*
    INTO v_deployment
  FROM public.builder_handoff_deployments AS deployment
  WHERE deployment.id = v_deployment_id
    AND deployment.owner_id = v_owner_id
  FOR UPDATE;

  PERFORM 1
  FROM public.apps AS app
  WHERE app.id = v_deployment.target_app_id
    AND app.owner_id = v_owner_id
  FOR UPDATE;

  IF v_deployment.status <> 'in_progress' THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment,
      v_deployment.status,
      true,
      v_deployment.status = 'repair_required'
    );
  END IF;
  IF v_deployment.lease_token IS DISTINCT FROM v_lease_token THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment, 'lease_lost', false, false
    );
  END IF;
  IF v_deployment.lease_expires_at <= p_now THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment,
      CASE
        WHEN v_deployment.side_effect_started_at IS NULL
          THEN 'lease_expired'
        ELSE 'reconciliation_required'
      END,
      false,
      v_deployment.side_effect_started_at IS NOT NULL
    );
  END IF;

  IF NOT public.builder_handoff_deployment_base_is_current(
    v_deployment.id
  ) THEN
    UPDATE public.builder_handoff_deployments AS deployment
    SET status = CASE
          WHEN deployment.side_effect_started_at IS NULL
            THEN 'stale'
          ELSE 'repair_required'
        END,
        error_code = 'base_lineage_stale',
        error_message =
          'The target Agent changed after this candidate was built.',
        updated_at = p_now
    WHERE deployment.id = v_deployment.id
    RETURNING deployment.* INTO v_deployment;
    RETURN public.builder_handoff_deployment_result(
      v_deployment,
      v_deployment.status,
      false,
      v_deployment.status = 'repair_required'
    );
  END IF;

  IF v_deployment.intent <> 'agent'
    AND v_verified_base_state_digest
      IS DISTINCT FROM v_deployment.base_state_digest THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment, 'base_state_unverified', false, false
    );
  END IF;
  IF v_deployment.intent = 'agent'
    AND v_verified_base_state_digest IS NOT NULL THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment, 'base_state_unexpected', false, false
    );
  END IF;
  IF v_phase_rank > v_deployment.phase_rank + 1 THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment, 'phase_out_of_order', false, false
    );
  END IF;
  IF v_phase_rank < v_deployment.phase_rank THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment, 'phase_regression', false, false
    );
  END IF;

  v_previous_phase_rank := v_deployment.phase_rank;
  UPDATE public.builder_handoff_deployments AS deployment
  SET phase = CASE
        WHEN v_phase_rank > deployment.phase_rank THEN v_phase
        ELSE deployment.phase
      END,
      phase_rank = GREATEST(deployment.phase_rank, v_phase_rank),
      base_verified_at = CASE
        WHEN v_phase_rank >= 1
          THEN COALESCE(deployment.base_verified_at, p_now)
        ELSE deployment.base_verified_at
      END,
      side_effect_started_at = CASE
        WHEN v_phase_rank >= 2
          THEN COALESCE(deployment.side_effect_started_at, p_now)
        ELSE deployment.side_effect_started_at
      END,
      lease_expires_at = p_now + interval '5 minutes',
      updated_at = p_now
  WHERE deployment.id = v_deployment.id
  RETURNING deployment.* INTO v_deployment;

  RETURN public.builder_handoff_deployment_result(
    v_deployment,
    CASE
      WHEN v_phase_rank > v_previous_phase_rank THEN 'fenced'
      ELSE 'replayed'
    END,
    v_phase_rank = v_previous_phase_rank,
    false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_builder_handoff_deployment_lease(
  p_request jsonb,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid;
  v_deployment_id uuid;
  v_new_lease_token uuid;
  v_request_fingerprint text;
  v_observed_phase text;
  v_deployment public.builder_handoff_deployments%ROWTYPE;
BEGIN
  BEGIN
    v_owner_id := (p_request->>'owner_id')::uuid;
    v_deployment_id := (p_request->>'deployment_id')::uuid;
    v_new_lease_token := (p_request->>'new_lease_token')::uuid;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        DETAIL = '{"code":"BUILDER_HANDOFF_DEPLOYMENT_INVALID"}';
  END;
  v_request_fingerprint := p_request->>'request_fingerprint';
  v_observed_phase := p_request->>'observed_phase';

  IF p_now IS NULL
    OR v_request_fingerprint !~ '^[0-9a-f]{64}$'
    OR public.builder_handoff_deployment_phase_rank(v_observed_phase) IS NULL
    OR p_request->>'external_state_verified' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      DETAIL = '{"code":"BUILDER_HANDOFF_DEPLOYMENT_INVALID"}';
  END IF;

  PERFORM 1 FROM public.users
  WHERE id = v_owner_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'owner_not_found');
  END IF;
  PERFORM 1
  FROM public.account_entitlements AS entitlement
  WHERE entitlement.user_id = v_owner_id
    AND entitlement.plan_code = 'pro'
    AND entitlement.subscription_status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'pro_subscription_required');
  END IF;

  SELECT deployment.*
    INTO v_deployment
  FROM public.builder_handoff_deployments AS deployment
  WHERE deployment.id = v_deployment_id
    AND deployment.owner_id = v_owner_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'deployment_not_found');
  END IF;

  PERFORM 1
  FROM public.builder_handoff_sessions AS session
  WHERE session.id = v_deployment.session_id
    AND session.owner_id = v_owner_id
    AND session.status = 'uploaded'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment, 'candidate_lineage_conflict', false, true
    );
  END IF;
  SELECT deployment.*
    INTO v_deployment
  FROM public.builder_handoff_deployments AS deployment
  WHERE deployment.id = v_deployment_id
    AND deployment.owner_id = v_owner_id
  FOR UPDATE;
  PERFORM 1
  FROM public.apps AS app
  WHERE app.id = v_deployment.target_app_id
    AND app.owner_id = v_owner_id
  FOR UPDATE;

  IF v_deployment.status NOT IN ('in_progress', 'repair_required')
    OR v_deployment.side_effect_started_at IS NULL
    OR v_deployment.request_fingerprint IS DISTINCT FROM v_request_fingerprint
    OR v_deployment.phase IS DISTINCT FROM v_observed_phase
    OR (
      v_deployment.status = 'in_progress'
      AND v_deployment.lease_expires_at > p_now
    )
    OR NOT public.builder_handoff_deployment_base_is_current(
      v_deployment.id
    ) THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment, 'reconciliation_conflict', false, true
    );
  END IF;

  UPDATE public.builder_handoff_deployments AS deployment
  SET status = 'in_progress',
      lease_token = v_new_lease_token,
      lease_expires_at = p_now + interval '5 minutes',
      reconciliation_count = deployment.reconciliation_count + 1,
      error_code = NULL,
      error_message = NULL,
      updated_at = p_now
  WHERE deployment.id = v_deployment.id
  RETURNING deployment.* INTO v_deployment;

  RETURN public.builder_handoff_deployment_result(
    v_deployment, 'reconciled', false, false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_builder_handoff_deployment(
  p_request jsonb,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid;
  v_deployment_id uuid;
  v_lease_token uuid;
  v_status text;
  v_error_code text;
  v_error_message text;
  v_deployment public.builder_handoff_deployments%ROWTYPE;
BEGIN
  BEGIN
    v_owner_id := (p_request->>'owner_id')::uuid;
    v_deployment_id := (p_request->>'deployment_id')::uuid;
    v_lease_token := (p_request->>'lease_token')::uuid;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        DETAIL = '{"code":"BUILDER_HANDOFF_DEPLOYMENT_INVALID"}';
  END;
  v_status := p_request->>'status';
  v_error_code := p_request->>'error_code';
  v_error_message := p_request->>'error_message';
  IF p_now IS NULL
    OR v_status NOT IN ('failed', 'stale', 'repair_required')
    OR v_error_code IS NULL
    OR length(v_error_code) NOT BETWEEN 1 AND 128
    OR v_error_code !~ '^[a-z0-9_]+$'
    OR v_error_message IS NULL
    OR length(v_error_message) NOT BETWEEN 1 AND 1000
    OR v_error_message ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      DETAIL = '{"code":"BUILDER_HANDOFF_DEPLOYMENT_INVALID"}';
  END IF;

  SELECT deployment.*
    INTO v_deployment
  FROM public.builder_handoff_deployments AS deployment
  WHERE deployment.id = v_deployment_id
    AND deployment.owner_id = v_owner_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'deployment_not_found');
  END IF;
  IF v_deployment.status <> 'in_progress' THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment, v_deployment.status, true,
      v_deployment.status = 'repair_required'
    );
  END IF;
  IF v_deployment.lease_token IS DISTINCT FROM v_lease_token THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment, 'lease_lost', false, false
    );
  END IF;
  IF v_deployment.side_effect_started_at IS NOT NULL
    AND v_status <> 'repair_required' THEN
    v_status := 'repair_required';
  END IF;

  IF v_deployment.side_effect_started_at IS NULL
    AND v_deployment.phase_rank <= 1
    AND v_status IN ('failed', 'stale') THEN
    PERFORM 1
    FROM public.apps AS app
    WHERE app.id = v_deployment.target_app_id
      AND app.owner_id = v_owner_id
      AND app.deployment_state = 'materializing'
      AND app.materializing_deployment_id = v_deployment.id
    FOR UPDATE;

    IF v_deployment.intent = 'agent' THEN
      DELETE FROM public.apps AS app
      WHERE app.id = v_deployment.target_app_id
        AND app.owner_id = v_owner_id
        AND app.deployment_state = 'materializing'
        AND app.materializing_deployment_id = v_deployment.id
        AND app.active_release_id IS NULL
        AND app.release_generation = 0;
    ELSE
      PERFORM set_config(
        'galactic.builder_handoff_deployment',
        v_deployment.id::text,
        true
      );
      UPDATE public.apps AS app
      SET deployment_state =
            v_deployment.prior_app_state->>'deployment_state',
          visibility = v_deployment.prior_app_state->>'visibility',
          hosting_suspended = COALESCE(
            (v_deployment.prior_app_state->>'hosting_suspended')::boolean,
            false
          ),
          http_enabled = COALESCE(
            (v_deployment.prior_app_state->>'http_enabled')::boolean,
            true
          ),
          materializing_deployment_id = NULLIF(
            v_deployment.prior_app_state->>'materializing_deployment_id',
            ''
          )::uuid,
          setup_required_at = NULLIF(
            v_deployment.prior_app_state->>'setup_required_at',
            ''
          )::timestamptz,
          updated_at = p_now
      WHERE app.id = v_deployment.target_app_id
        AND app.owner_id = v_owner_id
        AND app.deployment_state = 'materializing'
        AND app.materializing_deployment_id = v_deployment.id;
    END IF;
  END IF;

  UPDATE public.builder_handoff_deployments AS deployment
  SET status = v_status,
      error_code = v_error_code,
      error_message = v_error_message,
      updated_at = p_now
  WHERE deployment.id = v_deployment.id
  RETURNING deployment.* INTO v_deployment;

  RETURN public.builder_handoff_deployment_result(
    v_deployment,
    v_deployment.status,
    false,
    v_deployment.status = 'repair_required'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_builder_handoff_deployment(
  p_request jsonb,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid;
  v_deployment_id uuid;
  v_lease_token uuid;
  v_commit_fingerprint text;
  v_app_payload jsonb;
  v_version_metadata jsonb;
  v_provenance jsonb;
  v_setup_routines jsonb;
  v_slug text;
  v_name text;
  v_description text;
  v_storage_key text;
  v_executable_key text;
  v_storage_bytes bigint;
  v_exports jsonb;
  v_manifest text;
  v_env_schema jsonb;
  v_skills_md text;
  v_session public.builder_handoff_sessions%ROWTYPE;
  v_deployment public.builder_handoff_deployments%ROWTYPE;
  v_app public.apps%ROWTYPE;
  v_release_id uuid;
  v_previous_storage_bytes bigint;
  v_storage_delta bigint;
  v_response jsonb;
  v_routine jsonb;
  v_routine_id uuid;
  v_routine_index integer := 0;
  v_capability jsonb;
  v_capability_index integer;
  v_capability_app_id uuid;
BEGIN
  IF jsonb_typeof(p_request) <> 'object' OR p_now IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      DETAIL = '{"code":"BUILDER_HANDOFF_DEPLOYMENT_INVALID"}';
  END IF;
  BEGIN
    v_owner_id := (p_request->>'owner_id')::uuid;
    v_deployment_id := (p_request->>'deployment_id')::uuid;
    v_lease_token := (p_request->>'lease_token')::uuid;
    v_storage_bytes := (p_request#>>'{app,storage_bytes}')::bigint;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        DETAIL = '{"code":"BUILDER_HANDOFF_DEPLOYMENT_INVALID"}';
  END;

  v_commit_fingerprint := p_request->>'commit_fingerprint';
  v_app_payload := p_request->'app';
  v_version_metadata := p_request->'version_metadata';
  v_provenance := p_request->'release_provenance';
  v_setup_routines := COALESCE(
    p_request #> '{setup,routines}',
    '[]'::jsonb
  );
  v_slug := v_app_payload->>'slug';
  v_name := v_app_payload->>'name';
  v_description := v_app_payload->>'description';
  v_storage_key := v_app_payload->>'storage_key';
  v_executable_key := v_app_payload->>'executable_key';
  v_exports := v_app_payload->'exports';
  v_manifest := v_app_payload->>'manifest';
  v_env_schema := v_app_payload->'env_schema';
  v_skills_md := v_app_payload->>'skills_md';

  IF v_owner_id IS NULL
    OR v_deployment_id IS NULL
    OR v_lease_token IS NULL
    OR v_commit_fingerprint !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(v_app_payload) <> 'object'
    OR v_slug IS NULL
    OR length(v_slug) NOT BETWEEN 1 AND 200
    OR v_slug <> btrim(v_slug)
    OR v_slug ~ '[[:cntrl:]]'
    OR v_name IS NULL
    OR length(v_name) NOT BETWEEN 1 AND 300
    OR v_name <> btrim(v_name)
    OR v_name ~ '[[:cntrl:]]'
    OR (v_description IS NOT NULL AND length(v_description) > 4000)
    OR v_storage_key IS NULL
    OR length(v_storage_key) NOT BETWEEN 1 AND 2048
    OR v_storage_key ~ '[[:cntrl:]]'
    OR v_executable_key IS NULL
    OR length(v_executable_key) NOT BETWEEN 1 AND 2048
    OR v_executable_key ~ '[[:cntrl:]]'
    OR v_storage_bytes < 0
    OR jsonb_typeof(v_exports) <> 'array'
    OR v_manifest IS NULL
    OR length(v_manifest) NOT BETWEEN 2 AND 1048576
    OR jsonb_typeof(v_env_schema) <> 'object'
    OR jsonb_typeof(v_version_metadata) <> 'object'
    OR jsonb_typeof(v_provenance) <> 'object'
    OR jsonb_typeof(v_setup_routines) <> 'array'
    OR jsonb_array_length(v_setup_routines) > 50 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      DETAIL = '{"code":"BUILDER_HANDOFF_DEPLOYMENT_INVALID"}';
  END IF;

  PERFORM 1 FROM public.users
  WHERE id = v_owner_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'owner_not_found');
  END IF;
  PERFORM 1
  FROM public.account_entitlements AS entitlement
  WHERE entitlement.user_id = v_owner_id
    AND entitlement.plan_code = 'pro'
    AND entitlement.subscription_status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'pro_subscription_required');
  END IF;

  SELECT deployment.*
    INTO v_deployment
  FROM public.builder_handoff_deployments AS deployment
  WHERE deployment.id = v_deployment_id
    AND deployment.owner_id = v_owner_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'deployment_not_found');
  END IF;

  SELECT session.*
    INTO v_session
  FROM public.builder_handoff_sessions AS session
  WHERE session.id = v_deployment.session_id
    AND session.owner_id = v_owner_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'candidate_not_found');
  END IF;

  SELECT deployment.*
    INTO v_deployment
  FROM public.builder_handoff_deployments AS deployment
  WHERE deployment.id = v_deployment_id
    AND deployment.owner_id = v_owner_id
  FOR UPDATE;

  IF v_deployment.status = 'completed' THEN
    IF v_deployment.commit_fingerprint
      IS DISTINCT FROM v_commit_fingerprint THEN
      RETURN public.builder_handoff_deployment_result(
        v_deployment, 'commit_idempotency_mismatch', true, false
      );
    END IF;
    RETURN public.builder_handoff_deployment_result(
      v_deployment, 'already_committed', true, false
    ) || COALESCE(v_deployment.response, '{}'::jsonb);
  END IF;
  IF v_deployment.status <> 'in_progress'
    OR v_deployment.phase <> 'live_bundle_verified'
    OR v_deployment.phase_rank <> 7 THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment,
      CASE
        WHEN v_deployment.status = 'in_progress'
          THEN 'deployment_not_ready'
        ELSE v_deployment.status
      END,
      false,
      v_deployment.status = 'repair_required'
    );
  END IF;
  IF v_deployment.lease_token IS DISTINCT FROM v_lease_token
    OR v_deployment.lease_expires_at <= p_now THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment,
      CASE
        WHEN v_deployment.lease_token IS DISTINCT FROM v_lease_token
          THEN 'lease_lost'
        ELSE 'reconciliation_required'
      END,
      false,
      v_deployment.lease_expires_at <= p_now
    );
  END IF;
  IF v_session.status <> 'uploaded'
    OR v_session.candidate_archive_digest IS DISTINCT FROM
      v_deployment.candidate_archive_digest
    OR v_session.release_digest IS DISTINCT FROM v_deployment.release_digest
    OR v_session.uploaded_version IS DISTINCT FROM v_deployment.version THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment, 'candidate_lineage_conflict', false, true
    );
  END IF;

  SELECT app.*
    INTO v_app
  FROM public.apps AS app
  WHERE app.id = v_deployment.target_app_id
    AND app.owner_id = v_owner_id
    AND app.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment, 'target_not_found', false, true
    );
  END IF;
  IF NOT public.builder_handoff_deployment_base_is_current(
    v_deployment.id
  ) THEN
    UPDATE public.builder_handoff_deployments AS deployment
    SET status = 'repair_required',
        error_code = 'base_lineage_stale',
        error_message =
          'The target Agent changed after deployment side effects began.',
        updated_at = p_now
    WHERE deployment.id = v_deployment.id
    RETURNING deployment.* INTO v_deployment;
    RETURN public.builder_handoff_deployment_result(
      v_deployment, 'repair_required', false, true
    );
  END IF;

  IF v_version_metadata->>'version'
      IS DISTINCT FROM v_deployment.version
    OR v_version_metadata->>'source_hash'
      IS DISTINCT FROM v_deployment.source_hash
    OR v_version_metadata #>> '{test_attestation,attestation_id}'
      IS DISTINCT FROM v_deployment.attestation_id
    OR v_version_metadata #>> '{test_attestation,qualification,release_digest}'
      IS DISTINCT FROM v_deployment.release_digest
    OR v_version_metadata #>> '{test_attestation,qualification,document_digest}'
      IS DISTINCT FROM v_deployment.document_digest
    OR v_version_metadata #>> '{test_attestation,qualification,report_digest}'
      IS DISTINCT FROM v_deployment.report_digest
    OR v_version_metadata #>> '{trust,test_attestation_digest}'
      IS DISTINCT FROM v_deployment.attestation_digest
    OR v_provenance->>'archive_digest'
      IS DISTINCT FROM v_deployment.candidate_archive_digest
    OR v_provenance->>'release_digest'
      IS DISTINCT FROM v_deployment.release_digest
    OR v_provenance->>'source_hash'
      IS DISTINCT FROM v_deployment.source_hash
    OR v_provenance->>'attestation_id'
      IS DISTINCT FROM v_deployment.attestation_id
    OR v_provenance->>'attestation_digest'
      IS DISTINCT FROM v_deployment.attestation_digest
    OR v_provenance->>'document_digest'
      IS DISTINCT FROM v_deployment.document_digest
    OR v_provenance->>'report_digest'
      IS DISTINCT FROM v_deployment.report_digest THEN
    RETURN public.builder_handoff_deployment_result(
      v_deployment, 'release_provenance_mismatch', false, true
    );
  END IF;

  v_release_id := gen_random_uuid();
  INSERT INTO public.app_releases (
    id,
    deployment_id,
    session_id,
    app_id,
    owner_id,
    version,
    release_generation,
    archive_digest,
    release_digest,
    source_hash,
    attestation_id,
    attestation_digest,
    document_digest,
    report_digest,
    storage_key,
    executable_key,
    storage_bytes,
    exports,
    manifest,
    env_schema,
    version_metadata,
    provenance,
    created_at
  ) VALUES (
    v_release_id,
    v_deployment.id,
    v_deployment.session_id,
    v_deployment.target_app_id,
    v_owner_id,
    v_deployment.version,
    v_deployment.claimed_release_generation,
    v_deployment.candidate_archive_digest,
    v_deployment.release_digest,
    v_deployment.source_hash,
    v_deployment.attestation_id,
    v_deployment.attestation_digest,
    v_deployment.document_digest,
    v_deployment.report_digest,
    v_storage_key,
    v_executable_key,
    v_storage_bytes,
    v_exports,
    v_manifest,
    v_env_schema,
    v_version_metadata,
    v_provenance,
    p_now
  );

  v_previous_storage_bytes := COALESCE(v_app.storage_bytes, 0);
  v_storage_delta := v_storage_bytes - v_previous_storage_bytes;

  PERFORM set_config(
    'galactic.builder_handoff_deployment',
    v_deployment.id::text,
    true
  );
  UPDATE public.apps AS app
  SET slug = v_slug,
      name = v_name,
      description = v_description,
      visibility = 'private',
      storage_key = v_storage_key,
      storage_bytes = v_storage_bytes,
      exports = v_exports,
      current_version = v_deployment.version,
      versions = CASE
        WHEN v_deployment.version = ANY(COALESCE(app.versions, ARRAY[]::text[]))
          THEN app.versions
        ELSE array_append(
          COALESCE(app.versions, ARRAY[]::text[]),
          v_deployment.version
        )
      END,
      version_metadata = (
        CASE
          WHEN jsonb_typeof(app.version_metadata) = 'array'
            THEN app.version_metadata
          ELSE '[]'::jsonb
        END
      ) || jsonb_build_array(v_version_metadata),
      manifest = v_manifest,
      env_schema = v_env_schema,
      skills_md = v_skills_md,
      hosting_suspended = true,
      http_enabled = false,
      last_build_at = p_now,
      last_build_success = true,
      last_build_error = NULL,
      deployment_state = 'setup_required',
      release_generation = v_deployment.claimed_release_generation,
      active_release_id = v_release_id,
      active_release_digest = v_deployment.release_digest,
      active_archive_digest = v_deployment.candidate_archive_digest,
      materializing_deployment_id = NULL,
      setup_required_at = p_now,
      updated_at = p_now
  WHERE app.id = v_deployment.target_app_id
    AND app.owner_id = v_owner_id;

  -- A release fully replaces the app's prior behavior. Every prior routine is
  -- soft-retired in the same transaction so activation can never revive a
  -- stale schedule or capability set from a superseded release.
  UPDATE public.user_routines AS routine
  SET status = 'deleted',
      next_run_at = NULL,
      lease_id = NULL,
      lease_expires_at = NULL,
      deleted_at = p_now,
      metadata = COALESCE(routine.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'superseded_by_release_id', v_release_id,
          'superseded_by_deployment_id', v_deployment.id,
          'superseded_at', p_now
        ),
      updated_at = p_now
  WHERE routine.user_id = v_owner_id
    AND routine.composer_app_id = v_deployment.target_app_id
    AND routine.deleted_at IS NULL;

  UPDATE public.users AS owner
  SET storage_used_bytes = GREATEST(
        0::bigint,
        COALESCE(owner.storage_used_bytes, 0) + v_storage_delta
      ),
      updated_at = p_now
  WHERE owner.id = v_owner_id;

  FOR v_routine IN
    SELECT value
    FROM jsonb_array_elements(v_setup_routines)
  LOOP
    v_routine_index := v_routine_index + 1;
    BEGIN
      v_routine_id := (v_routine->>'id')::uuid;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'builder_handoff_setup_invalid',
          DETAIL = jsonb_build_object(
            'code', 'BUILDER_HANDOFF_SETUP_INVALID',
            'routineIndex', v_routine_index
          )::text;
    END;
    IF jsonb_typeof(v_routine) <> 'object'
      OR v_routine->>'template_id' IS NULL
      OR length(v_routine->>'template_id') NOT BETWEEN 1 AND 200
      OR v_routine->>'name' IS NULL
      OR length(v_routine->>'name') NOT BETWEEN 1 AND 300
      OR v_routine->>'handler_function' IS NULL
      OR length(v_routine->>'handler_function') NOT BETWEEN 1 AND 300
      OR jsonb_typeof(COALESCE(v_routine->'schedule', '{}'::jsonb))
        <> 'object'
      OR jsonb_typeof(COALESCE(v_routine->'config', '{}'::jsonb))
        <> 'object'
      OR jsonb_typeof(COALESCE(v_routine->'budget_policy', '{}'::jsonb))
        <> 'object'
      OR jsonb_typeof(COALESCE(v_routine->'approval_policy', '{}'::jsonb))
        <> 'object'
      OR jsonb_typeof(COALESCE(v_routine->'metadata', '{}'::jsonb))
        <> 'object'
      OR jsonb_typeof(COALESCE(v_routine->'capabilities', '[]'::jsonb))
        <> 'array'
      OR jsonb_array_length(
        COALESCE(v_routine->'capabilities', '[]'::jsonb)
      ) > 100 THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'builder_handoff_setup_invalid',
        DETAIL = jsonb_build_object(
          'code', 'BUILDER_HANDOFF_SETUP_INVALID',
          'routineIndex', v_routine_index
        )::text;
    END IF;

    INSERT INTO public.user_routines (
      id,
      user_id,
      composer_app_id,
      composer_app_slug,
      template_id,
      template_version,
      name,
      description,
      intent,
      handler_function,
      status,
      schedule,
      config,
      budget_policy,
      approval_policy,
      max_concurrency,
      next_run_at,
      metadata,
      created_at,
      updated_at
    ) VALUES (
      v_routine_id,
      v_owner_id,
      v_deployment.target_app_id,
      v_slug,
      v_routine->>'template_id',
      v_routine->>'template_version',
      v_routine->>'name',
      v_routine->>'description',
      v_routine->>'intent',
      v_routine->>'handler_function',
      'paused',
      COALESCE(v_routine->'schedule', '{}'::jsonb),
      COALESCE(v_routine->'config', '{}'::jsonb),
      COALESCE(v_routine->'budget_policy', '{}'::jsonb),
      COALESCE(v_routine->'approval_policy', '{}'::jsonb)
        || '{"approved":false}'::jsonb,
      1,
      NULL,
      COALESCE(v_routine->'metadata', '{}'::jsonb)
        || jsonb_build_object(
          'launch_managed', true,
          'setup_required', true,
          'builder_handoff_deployment_id', v_deployment.id
        ),
      p_now,
      p_now
    );

    v_capability_index := 0;
    FOR v_capability IN
      SELECT value
      FROM jsonb_array_elements(
        COALESCE(v_routine->'capabilities', '[]'::jsonb)
      )
    LOOP
      v_capability_index := v_capability_index + 1;
      BEGIN
        v_capability_app_id := CASE
          WHEN NULLIF(v_capability->>'app_id', '') IS NULL THEN NULL
          ELSE (v_capability->>'app_id')::uuid
        END;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'builder_handoff_setup_invalid',
            DETAIL = jsonb_build_object(
              'code', 'BUILDER_HANDOFF_SETUP_INVALID',
              'routineIndex', v_routine_index,
              'capabilityIndex', v_capability_index
            )::text;
      END;
      IF jsonb_typeof(v_capability) <> 'object'
        OR v_capability->>'app_ref' IS NULL
        OR length(v_capability->>'app_ref') NOT BETWEEN 1 AND 300
        OR v_capability->>'app_ref' ~ '[[:cntrl:]]'
        OR v_capability->>'function_name' IS NULL
        OR length(v_capability->>'function_name') NOT BETWEEN 1 AND 300
        OR v_capability->>'function_name' ~ '[[:cntrl:]]'
        OR COALESCE(v_capability->>'access', 'read')
          NOT IN ('read', 'write')
        OR (
          v_capability->>'required' IS NOT NULL
          AND jsonb_typeof(v_capability->'required') <> 'boolean'
        )
        OR (
          v_capability->>'purpose' IS NOT NULL
          AND length(v_capability->>'purpose') > 1000
        ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'builder_handoff_setup_invalid',
          DETAIL = jsonb_build_object(
            'code', 'BUILDER_HANDOFF_SETUP_INVALID',
            'routineIndex', v_routine_index,
            'capabilityIndex', v_capability_index
          )::text;
      END IF;

      INSERT INTO public.routine_capabilities (
        routine_id,
        user_id,
        app_id,
        app_ref,
        function_name,
        access,
        required,
        purpose,
        approved,
        approved_at,
        approved_by_user_id,
        pricing_snapshot,
        constraints,
        metadata,
        created_at,
        updated_at
      ) VALUES (
        v_routine_id,
        v_owner_id,
        v_capability_app_id,
        v_capability->>'app_ref',
        v_capability->>'function_name',
        COALESCE(v_capability->>'access', 'read'),
        COALESCE((v_capability->>'required')::boolean, true),
        v_capability->>'purpose',
        false,
        NULL,
        NULL,
        COALESCE(v_capability->'pricing_snapshot', '{}'::jsonb),
        COALESCE(v_capability->'constraints', '{}'::jsonb),
        COALESCE(v_capability->'metadata', '{}'::jsonb)
          || jsonb_build_object(
            'setup_required', true,
            'builder_handoff_deployment_id', v_deployment.id
          ),
        p_now,
        p_now
      );
    END LOOP;
  END LOOP;

  UPDATE public.builder_handoff_sessions AS session
  SET status = 'promoted',
      status_version = session.status_version + 1,
      promoted_at = p_now,
      updated_at = p_now
  WHERE session.id = v_session.id
    AND session.owner_id = v_owner_id
    AND session.status = 'uploaded'
  RETURNING session.* INTO v_session;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      DETAIL = '{"code":"BUILDER_HANDOFF_TRANSITION_CONFLICT"}';
  END IF;

  DELETE FROM public.user_api_tokens AS token
  WHERE token.id = v_session.token_id;

  INSERT INTO public.builder_handoff_session_events (
    session_id,
    owner_id,
    event,
    status,
    status_version,
    lineage_revision,
    occurred_at
  ) VALUES (
    v_session.id,
    v_session.owner_id,
    'promoted',
    v_session.status,
    v_session.status_version,
    v_session.lineage_revision,
    p_now
  );

  v_response := jsonb_build_object(
    'code', 'committed',
    'deployment_id', v_deployment.id,
    'status', 'completed',
    'phase', 'committed',
    'app_id', v_deployment.target_app_id,
    'app_slug', v_slug,
    'app_name', v_name,
    'version', v_deployment.version,
    'setup_required', true,
    'release_id', v_release_id,
    'release_generation', v_deployment.claimed_release_generation,
    'replayed', false,
    'requires_reconciliation', false
  );

  UPDATE public.builder_handoff_deployments AS deployment
  SET status = 'completed',
      phase = 'committed',
      phase_rank = 8,
      commit_fingerprint = v_commit_fingerprint,
      release_id = v_release_id,
      response = v_response,
      error_code = NULL,
      error_message = NULL,
      completed_at = p_now,
      updated_at = p_now
  WHERE deployment.id = v_deployment.id
  RETURNING deployment.* INTO v_deployment;

  RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_checkout_attempt_result(
  p_attempt public.subscription_checkout_attempts,
  p_code text,
  p_replayed boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'code', p_code,
    'attempt_id', p_attempt.id,
    'owner_id', p_attempt.owner_id,
    'status', p_attempt.status,
    'return_url', p_attempt.return_url,
    'stripe_checkout_session_id', p_attempt.stripe_checkout_session_id,
    'checkout_url', CASE
      WHEN p_attempt.status IN ('creating', 'pending')
        THEN p_attempt.checkout_url
      ELSE NULL
    END,
    'stripe_subscription_id', p_attempt.stripe_subscription_id,
    'created_at', p_attempt.created_at,
    'updated_at', p_attempt.updated_at,
    'expires_at', p_attempt.expires_at,
    'completed_at', p_attempt.completed_at,
    'error_code', p_attempt.error_code,
    'replayed', p_replayed
  );
$$;

CREATE OR REPLACE FUNCTION public.claim_subscription_checkout_attempt(
  p_request jsonb,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid;
  v_attempt_id uuid;
  v_idempotency_key uuid;
  v_plan_code text;
  v_request_fingerprint text;
  v_return_url text;
  v_expires_at timestamptz;
  v_attempt public.subscription_checkout_attempts%ROWTYPE;
BEGIN
  BEGIN
    v_owner_id := (p_request->>'owner_id')::uuid;
    v_attempt_id := (p_request->>'attempt_id')::uuid;
    v_idempotency_key := (p_request->>'idempotency_key')::uuid;
    v_expires_at := (p_request->>'expires_at')::timestamptz;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        DETAIL = '{"code":"CHECKOUT_ATTEMPT_INVALID"}';
  END;
  v_plan_code := p_request->>'plan_code';
  v_request_fingerprint := p_request->>'request_fingerprint';
  v_return_url := p_request->>'return_url';
  IF p_now IS NULL
    OR v_plan_code <> 'pro'
    OR v_request_fingerprint !~ '^[0-9a-f]{64}$'
    OR v_return_url IS NULL
    OR length(v_return_url) NOT BETWEEN 1 AND 2048
    OR left(v_return_url, 8) <> 'https://'
    OR v_return_url ~ '[[:cntrl:]]'
    OR v_expires_at <= p_now + interval '5 minutes'
    OR v_expires_at > p_now + interval '24 hours' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      DETAIL = '{"code":"CHECKOUT_ATTEMPT_INVALID"}';
  END IF;

  PERFORM 1 FROM public.users
  WHERE id = v_owner_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'owner_not_found');
  END IF;

  SELECT attempt.*
    INTO v_attempt
  FROM public.subscription_checkout_attempts AS attempt
  WHERE attempt.owner_id = v_owner_id
    AND attempt.idempotency_key = v_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    -- A browser retry generates a fresh attempt UUID and expiry. Durable
    -- identity is owner + idempotency key + the canonical request itself.
    IF v_attempt.request_fingerprint
        IS DISTINCT FROM v_request_fingerprint
      OR v_attempt.plan_code IS DISTINCT FROM v_plan_code
      OR v_attempt.return_url IS DISTINCT FROM v_return_url THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'checkout_idempotency_conflict',
        DETAIL = '{"code":"CHECKOUT_IDEMPOTENCY_CONFLICT"}';
    END IF;
    IF v_attempt.status IN ('creating', 'pending')
      AND v_attempt.expires_at <= p_now THEN
      UPDATE public.subscription_checkout_attempts AS attempt
      SET status = 'expired',
          error_code = 'checkout_attempt_expired',
          completed_at = p_now,
          updated_at = p_now
      WHERE attempt.id = v_attempt.id
      RETURNING attempt.* INTO v_attempt;
      RETURN public.subscription_checkout_attempt_result(
        v_attempt, 'expired', true
      );
    END IF;
    RETURN public.subscription_checkout_attempt_result(
      v_attempt, v_attempt.status, true
    );
  END IF;

  -- A user row lock above makes this check-and-create sequence serial for the
  -- account. Do not create a second Stripe subscription for an existing live
  -- or still-recoverable subscription state.
  PERFORM 1
  FROM public.account_subscriptions AS subscription
  WHERE subscription.user_id = v_owner_id
    AND subscription.status IN (
      'incomplete', 'trialing', 'active', 'past_due'
    );
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'checkout_subscription_exists',
      DETAIL = '{"code":"CHECKOUT_SUBSCRIPTION_EXISTS"}';
  END IF;

  -- Reclaim the single-live-attempt slot when a request died before Stripe
  -- completion. Terminal rows remain immutable and may be followed by a fresh
  -- idempotency key.
  UPDATE public.subscription_checkout_attempts AS attempt
  SET status = 'expired',
      error_code = 'checkout_attempt_expired',
      completed_at = p_now,
      updated_at = p_now
  WHERE attempt.owner_id = v_owner_id
    AND attempt.status IN ('creating', 'pending')
    AND attempt.expires_at <= p_now;

  PERFORM 1
  FROM public.subscription_checkout_attempts AS attempt
  WHERE attempt.owner_id = v_owner_id
    AND attempt.status IN ('creating', 'pending')
    AND attempt.expires_at > p_now;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'checkout_attempt_in_progress',
      DETAIL = '{"code":"CHECKOUT_ATTEMPT_IN_PROGRESS"}';
  END IF;

  INSERT INTO public.subscription_checkout_attempts (
    id,
    owner_id,
    idempotency_key,
    plan_code,
    request_fingerprint,
    return_url,
    status,
    created_at,
    updated_at,
    expires_at
  ) VALUES (
    v_attempt_id,
    v_owner_id,
    v_idempotency_key,
    v_plan_code,
    v_request_fingerprint,
    v_return_url,
    'creating',
    p_now,
    p_now,
    v_expires_at
  )
  RETURNING * INTO v_attempt;

  RETURN public.subscription_checkout_attempt_result(
    v_attempt, 'creating', false
  );
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'checkout_attempt_conflict',
      DETAIL = '{"code":"CHECKOUT_ATTEMPT_CONFLICT"}';
END;
$$;

CREATE OR REPLACE FUNCTION public.bind_subscription_checkout_attempt(
  p_request jsonb,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid;
  v_attempt_id uuid;
  v_checkout_session_id text;
  v_checkout_url text;
  v_customer_id text;
  v_subscription_id text;
  v_attempt public.subscription_checkout_attempts%ROWTYPE;
BEGIN
  BEGIN
    v_owner_id := (p_request->>'owner_id')::uuid;
    v_attempt_id := (p_request->>'attempt_id')::uuid;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        DETAIL = '{"code":"CHECKOUT_ATTEMPT_INVALID"}';
  END;
  v_checkout_session_id := p_request->>'stripe_checkout_session_id';
  v_checkout_url := p_request->>'checkout_url';
  v_customer_id := NULLIF(p_request->>'stripe_customer_id', '');
  v_subscription_id := NULLIF(p_request->>'stripe_subscription_id', '');
  IF p_now IS NULL
    OR v_checkout_session_id IS NULL
    OR length(v_checkout_session_id) NOT BETWEEN 1 AND 255
    OR v_checkout_session_id ~ '[[:cntrl:]]'
    OR v_checkout_url IS NULL
    OR length(v_checkout_url) NOT BETWEEN 1 AND 4096
    OR left(v_checkout_url, 8) <> 'https://'
    OR v_checkout_url ~ '[[:cntrl:]]'
    OR (v_customer_id IS NOT NULL AND length(v_customer_id) > 255)
    OR (v_subscription_id IS NOT NULL AND length(v_subscription_id) > 255)
    OR COALESCE(v_customer_id, '') ~ '[[:cntrl:]]'
    OR COALESCE(v_subscription_id, '') ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      DETAIL = '{"code":"CHECKOUT_ATTEMPT_INVALID"}';
  END IF;

  SELECT attempt.*
    INTO v_attempt
  FROM public.subscription_checkout_attempts AS attempt
  WHERE attempt.id = v_attempt_id
    AND attempt.owner_id = v_owner_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'checkout_attempt_not_found');
  END IF;
  IF v_attempt.status NOT IN ('creating', 'pending') THEN
    RETURN public.subscription_checkout_attempt_result(
      v_attempt, v_attempt.status, true
    );
  END IF;
  IF v_attempt.expires_at <= p_now THEN
    UPDATE public.subscription_checkout_attempts AS attempt
    SET status = 'expired',
        completed_at = p_now,
        updated_at = p_now
    WHERE attempt.id = v_attempt.id
    RETURNING attempt.* INTO v_attempt;
    RETURN public.subscription_checkout_attempt_result(
      v_attempt, 'expired', false
    );
  END IF;
  IF v_attempt.status = 'pending' THEN
    IF v_attempt.stripe_checkout_session_id
        IS DISTINCT FROM v_checkout_session_id
      OR v_attempt.checkout_url IS DISTINCT FROM v_checkout_url
      OR (
        v_customer_id IS NOT NULL
        AND v_attempt.stripe_customer_id IS NOT NULL
        AND v_attempt.stripe_customer_id IS DISTINCT FROM v_customer_id
      )
      OR (
        v_subscription_id IS NOT NULL
        AND v_attempt.stripe_subscription_id IS NOT NULL
        AND v_attempt.stripe_subscription_id
          IS DISTINCT FROM v_subscription_id
      ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'checkout_stripe_identity_conflict',
        DETAIL = '{"code":"CHECKOUT_STRIPE_IDENTITY_CONFLICT"}';
    END IF;
    RETURN public.subscription_checkout_attempt_result(
      v_attempt, 'pending', true
    );
  END IF;
  IF v_attempt.stripe_checkout_session_id IS NOT NULL
    AND v_attempt.stripe_checkout_session_id
      IS DISTINCT FROM v_checkout_session_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'checkout_stripe_identity_conflict',
      DETAIL = '{"code":"CHECKOUT_STRIPE_IDENTITY_CONFLICT"}';
  END IF;

  UPDATE public.subscription_checkout_attempts AS attempt
  SET status = 'pending',
      stripe_checkout_session_id = v_checkout_session_id,
      checkout_url = v_checkout_url,
      stripe_customer_id = COALESCE(
        attempt.stripe_customer_id, v_customer_id
      ),
      stripe_subscription_id = COALESCE(
        attempt.stripe_subscription_id, v_subscription_id
      ),
      bound_at = p_now,
      updated_at = p_now
  WHERE attempt.id = v_attempt.id
  RETURNING attempt.* INTO v_attempt;

  RETURN public.subscription_checkout_attempt_result(
    v_attempt, 'pending', false
  );
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'checkout_stripe_session_conflict',
      DETAIL = '{"code":"CHECKOUT_STRIPE_IDENTITY_CONFLICT"}';
END;
$$;

CREATE OR REPLACE FUNCTION public.project_subscription_checkout_attempt(
  p_request jsonb,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid;
  v_attempt_id uuid;
  v_status text;
  v_checkout_session_id text;
  v_customer_id text;
  v_subscription_id text;
  v_event_id text;
  v_event_created_at timestamptz;
  v_error_code text;
  v_attempt public.subscription_checkout_attempts%ROWTYPE;
  v_subscription public.account_subscriptions%ROWTYPE;
BEGIN
  BEGIN
    v_owner_id := (p_request->>'owner_id')::uuid;
    v_attempt_id := (p_request->>'attempt_id')::uuid;
    v_event_created_at := CASE
      WHEN NULLIF(p_request->>'event_created_at', '') IS NULL THEN NULL
      ELSE (p_request->>'event_created_at')::timestamptz
    END;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        DETAIL = '{"code":"CHECKOUT_ATTEMPT_INVALID"}';
  END;
  v_status := p_request->>'status';
  v_checkout_session_id := p_request->>'stripe_checkout_session_id';
  v_customer_id := NULLIF(p_request->>'stripe_customer_id', '');
  v_subscription_id := NULLIF(p_request->>'stripe_subscription_id', '');
  v_event_id := NULLIF(p_request->>'event_id', '');
  v_error_code := NULLIF(
    COALESCE(p_request->>'reason', p_request->>'error_code'), ''
  );
  IF p_now IS NULL
    OR v_status NOT IN (
      'pending', 'active', 'cancelled', 'failed', 'expired'
    )
    OR (
      v_status = 'pending'
      AND v_checkout_session_id IS NULL
    )
    OR (
      v_checkout_session_id IS NOT NULL
      AND (
        length(v_checkout_session_id) NOT BETWEEN 1 AND 255
        OR v_checkout_session_id ~ '[[:cntrl:]]'
      )
    )
    OR (
      v_customer_id IS NOT NULL
      AND (
        length(v_customer_id) NOT BETWEEN 1 AND 255
        OR v_customer_id ~ '[[:cntrl:]]'
      )
    )
    OR (
      v_subscription_id IS NOT NULL
      AND (
        length(v_subscription_id) NOT BETWEEN 1 AND 255
        OR v_subscription_id ~ '[[:cntrl:]]'
      )
    )
    OR (
      (v_event_id IS NULL) IS DISTINCT FROM
        (v_event_created_at IS NULL)
    )
    OR (
      v_event_id IS NOT NULL
      AND (
        length(v_event_id) NOT BETWEEN 1 AND 255
        OR v_event_id ~ '[[:cntrl:]]'
      )
    )
    OR (v_error_code IS NOT NULL AND (
      length(v_error_code) > 128 OR v_error_code !~ '^[a-z0-9_]+$'
    )) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      DETAIL = '{"code":"CHECKOUT_ATTEMPT_INVALID"}';
  END IF;

  -- Pre-read only to discover the owner. For activation, lock subscription
  -- truth before entitlement and the checkout attempt.
  SELECT attempt.*
    INTO v_attempt
  FROM public.subscription_checkout_attempts AS attempt
  WHERE attempt.id = v_attempt_id
    AND attempt.owner_id = v_owner_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'checkout_attempt_not_found');
  END IF;

  IF v_status = 'active' THEN
    SELECT subscription.*
      INTO v_subscription
    FROM public.account_subscriptions AS subscription
    WHERE subscription.user_id = v_attempt.owner_id
    FOR UPDATE;
    IF NOT FOUND
      OR v_subscription.plan_code <> 'pro'
      OR v_subscription.status <> 'active'
      OR (
        v_subscription_id IS NOT NULL
        AND v_subscription.stripe_subscription_id
          IS DISTINCT FROM v_subscription_id
      )
      OR (
        v_customer_id IS NOT NULL
        AND v_subscription.stripe_customer_id
          IS DISTINCT FROM v_customer_id
      ) THEN
      RETURN public.subscription_checkout_attempt_result(
        v_attempt, 'membership_not_active', false
      );
    END IF;

    PERFORM 1
    FROM public.account_entitlements AS entitlement
    WHERE entitlement.user_id = v_attempt.owner_id
      AND entitlement.plan_code = 'pro'
      AND entitlement.subscription_status = 'active'
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN public.subscription_checkout_attempt_result(
        v_attempt, 'membership_not_active', false
      );
    END IF;
  END IF;

  SELECT attempt.*
    INTO v_attempt
  FROM public.subscription_checkout_attempts AS attempt
  WHERE attempt.id = v_attempt_id
    AND attempt.owner_id = v_owner_id
  FOR UPDATE;

  IF (
      v_checkout_session_id IS NOT NULL
      AND v_attempt.stripe_checkout_session_id IS NOT NULL
      AND v_attempt.stripe_checkout_session_id
        IS DISTINCT FROM v_checkout_session_id
    )
    OR (
      v_customer_id IS NOT NULL
      AND
      v_attempt.stripe_customer_id IS NOT NULL
      AND v_attempt.stripe_customer_id IS DISTINCT FROM v_customer_id
    )
    OR (
      v_subscription_id IS NOT NULL
      AND
      v_attempt.stripe_subscription_id IS NOT NULL
      AND v_attempt.stripe_subscription_id
        IS DISTINCT FROM v_subscription_id
    ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'checkout_stripe_identity_conflict',
      DETAIL = '{"code":"CHECKOUT_STRIPE_IDENTITY_CONFLICT"}';
  END IF;

  IF v_event_created_at IS NOT NULL
    AND v_attempt.last_event_created_at IS NOT NULL
    AND (
      v_event_created_at < v_attempt.last_event_created_at
      OR (
        v_event_created_at = v_attempt.last_event_created_at
        AND v_event_id = v_attempt.last_event_id
      )
    ) THEN
    RETURN public.subscription_checkout_attempt_result(
      v_attempt, 'stale_or_replayed_event',
      true
    );
  END IF;

  IF v_attempt.status IN (
    'active', 'cancelled', 'failed', 'expired'
  ) THEN
    RETURN public.subscription_checkout_attempt_result(
      v_attempt,
      CASE WHEN v_attempt.status = v_status
        THEN v_attempt.status
        ELSE 'terminal_state_conflict'
      END,
      true
    );
  END IF;

  IF v_attempt.expires_at <= p_now AND v_status = 'pending' THEN
    UPDATE public.subscription_checkout_attempts AS attempt
    SET status = 'expired',
        stripe_checkout_session_id = COALESCE(
          attempt.stripe_checkout_session_id, v_checkout_session_id
        ),
        stripe_subscription_id = COALESCE(
          attempt.stripe_subscription_id, v_subscription_id
        ),
        last_event_id = v_event_id,
        last_event_created_at = v_event_created_at,
        error_code = 'checkout_attempt_expired',
        completed_at = p_now,
        updated_at = p_now
    WHERE attempt.id = v_attempt.id
    RETURNING attempt.* INTO v_attempt;
    RETURN public.subscription_checkout_attempt_result(
      v_attempt, 'expired', false
    );
  END IF;

  -- Checkout completion is only payment evidence. Membership remains pending
  -- until the separately projected Stripe subscription is active. If this
  -- webhook races the API bind, record identity/evidence but remain creating;
  -- bind will atomically supply the durable checkout URL and move to pending.
  IF v_status = 'pending' THEN
    UPDATE public.subscription_checkout_attempts AS attempt
    SET stripe_checkout_session_id = COALESCE(
          attempt.stripe_checkout_session_id, v_checkout_session_id
        ),
        stripe_customer_id = COALESCE(
          attempt.stripe_customer_id, v_customer_id
        ),
        stripe_subscription_id = COALESCE(
          attempt.stripe_subscription_id, v_subscription_id
        ),
        last_event_id = v_event_id,
        last_event_created_at = v_event_created_at,
        updated_at = p_now
    WHERE attempt.id = v_attempt.id
    RETURNING attempt.* INTO v_attempt;
    RETURN public.subscription_checkout_attempt_result(
      v_attempt, v_attempt.status, false
    );
  END IF;

  UPDATE public.subscription_checkout_attempts AS attempt
  SET status = v_status,
      stripe_checkout_session_id = COALESCE(
        attempt.stripe_checkout_session_id, v_checkout_session_id
      ),
      stripe_customer_id = COALESCE(
        attempt.stripe_customer_id, v_customer_id
      ),
      stripe_subscription_id = COALESCE(
        attempt.stripe_subscription_id,
        v_subscription_id,
        CASE WHEN v_status = 'active'
          THEN v_subscription.stripe_subscription_id
          ELSE NULL
        END
      ),
      last_event_id = v_event_id,
      last_event_created_at = v_event_created_at,
      error_code = CASE WHEN v_status = 'failed' THEN v_error_code ELSE NULL END,
      completed_at = p_now,
      updated_at = p_now
  WHERE attempt.id = v_attempt.id
  RETURNING attempt.* INTO v_attempt;

  RETURN public.subscription_checkout_attempt_result(
    v_attempt, v_status, false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_subscription_checkout_attempt(
  p_request jsonb,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid;
  v_attempt_id uuid;
  v_attempt public.subscription_checkout_attempts%ROWTYPE;
BEGIN
  BEGIN
    v_owner_id := (p_request->>'owner_id')::uuid;
    v_attempt_id := (p_request->>'attempt_id')::uuid;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        DETAIL = '{"code":"CHECKOUT_ATTEMPT_INVALID"}';
  END;
  SELECT attempt.*
    INTO v_attempt
  FROM public.subscription_checkout_attempts AS attempt
  WHERE attempt.id = v_attempt_id
    AND attempt.owner_id = v_owner_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'checkout_attempt_not_found');
  END IF;
  IF v_attempt.status IN ('creating', 'pending')
    AND v_attempt.expires_at <= p_now THEN
    UPDATE public.subscription_checkout_attempts AS attempt
    SET status = 'expired',
        error_code = 'checkout_attempt_expired',
        completed_at = p_now,
        updated_at = p_now
    WHERE attempt.id = v_attempt.id
    RETURNING attempt.* INTO v_attempt;
  END IF;
  RETURN public.subscription_checkout_attempt_result(
    v_attempt, v_attempt.status, false
  );
END;
$$;

-- One transaction crosses the only runnable boundary for a member deployment.
-- The owner action itself is the explicit setup review; this function does not
-- trust the API's preflight and independently rechecks every durable fact.
CREATE OR REPLACE FUNCTION public.activate_member_deployed_agent(
  p_request jsonb,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_owner_id uuid;
  v_app_id uuid;
  v_routine_id uuid;
  v_expected_generation bigint;
  v_expected_revision bigint;
  v_entitlement public.account_entitlements%ROWTYPE;
  v_app public.apps%ROWTYPE;
  v_release public.app_releases%ROWTYPE;
  v_routine public.user_routines%ROWTYPE;
  v_manifest jsonb;
  v_schema jsonb;
  v_key text;
  v_entry jsonb;
  v_scope text;
  v_schedule_type text;
  v_run double precision;
  v_day double precision;
  v_month double precision;
  v_calls double precision;
  v_revision bigint;
  v_replayed boolean := false;
BEGIN
  IF p_now IS NULL
    OR jsonb_typeof(COALESCE(p_request, 'null'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'agent_home_invalid_activation',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION"}';
  END IF;
  BEGIN
    v_owner_id := (p_request->>'owner_id')::uuid;
    v_app_id := (p_request->>'app_id')::uuid;
    v_expected_generation :=
      NULLIF(p_request->>'expected_release_generation', '')::bigint;
    v_expected_revision :=
      NULLIF(p_request->>'expected_agent_home_revision', '')::bigint;
    v_routine_id := CASE
      WHEN NULLIF(p_request->>'routine_id', '') IS NULL THEN NULL
      ELSE (p_request->>'routine_id')::uuid
    END;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'agent_home_invalid_activation',
        DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION"}';
  END;
  IF v_expected_generation IS NULL OR v_expected_generation < 1
    OR v_expected_revision IS NULL OR v_expected_revision < 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'agent_home_invalid_activation',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION"}';
  END IF;

  -- Global lock order is entitlement -> Agent -> routine/capabilities.
  SELECT entitlement.*
    INTO v_entitlement
  FROM public.account_entitlements AS entitlement
  WHERE entitlement.user_id = v_owner_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_entitlement.plan_code <> 'pro'
    OR v_entitlement.subscription_status <> 'active' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'pro_subscription_required',
      DETAIL = '{"code":"PRO_SUBSCRIPTION_REQUIRED"}';
  END IF;

  PERFORM public.assert_agent_home_revision(
    v_app_id, v_owner_id, v_expected_revision
  );
  SELECT app.*
    INTO v_app
  FROM public.apps AS app
  WHERE app.id = v_app_id
    AND app.owner_id = v_owner_id
    AND app.deleted_at IS NULL
  FOR UPDATE;

  IF v_app.release_generation <> v_expected_generation THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_home_release_conflict',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_HOME_RELEASE_CONFLICT',
        'expectedReleaseGeneration', v_expected_generation::text,
        'actualReleaseGeneration', v_app.release_generation::text
      )::text;
  END IF;
  IF v_app.deployment_state NOT IN ('setup_required', 'ready')
    OR v_app.active_release_id IS NULL
    OR v_app.active_release_digest IS NULL
    OR v_app.active_archive_digest IS NULL
    OR v_app.materializing_deployment_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_home_deployment_not_activatable',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_HOME_INVALID_MUTATION',
        'field', 'deployment',
        'reason', COALESCE(v_app.deployment_state, 'unknown')
      )::text;
  END IF;

  SELECT release.*
    INTO v_release
  FROM public.app_releases AS release
  WHERE release.id = v_app.active_release_id
    AND release.app_id = v_app.id
    AND release.owner_id = v_owner_id
    AND release.release_generation = v_app.release_generation
    AND release.release_digest = v_app.active_release_digest
    AND release.archive_digest = v_app.active_archive_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_home_release_unverified',
      DETAIL =
        '{"code":"AGENT_HOME_INVALID_MUTATION","field":"deployment","reason":"release_evidence_mismatch"}';
  END IF;

  -- Use the exact same source precedence as Agent Home settings: a non-empty
  -- stored schema wins; otherwise env_vars entries override legacy env ones.
  v_manifest := public.try_parse_agent_home_jsonb(v_app.manifest);
  IF jsonb_typeof(v_app.env_schema) = 'object'
    AND v_app.env_schema <> '{}'::jsonb THEN
    v_schema := v_app.env_schema;
  ELSIF jsonb_typeof(v_manifest) = 'object' THEN
    v_schema := CASE
      WHEN jsonb_typeof(v_manifest->'env') = 'object'
        THEN v_manifest->'env'
      ELSE '{}'::jsonb
    END || CASE
      WHEN jsonb_typeof(v_manifest->'env_vars') = 'object'
        THEN v_manifest->'env_vars'
      ELSE '{}'::jsonb
    END;
  ELSE
    v_schema := '{}'::jsonb;
  END IF;
  IF jsonb_typeof(v_schema) <> 'object'
    OR jsonb_typeof(COALESCE(v_app.env_vars, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_home_settings_state_invalid',
      DETAIL = '{"code":"AGENT_HOME_SERVICE_UNAVAILABLE"}';
  END IF;

  FOR v_key, v_entry IN SELECT key, value FROM jsonb_each(v_schema)
  LOOP
    IF jsonb_typeof(v_entry) = 'object'
      AND jsonb_typeof(v_entry->'required') = 'boolean'
      AND (v_entry->>'required')::boolean THEN
      v_scope := COALESCE(v_entry->>'scope', v_entry->>'type');
      IF v_scope = 'per_user' THEN
        PERFORM 1
        FROM public.user_app_secrets AS secret
        WHERE secret.user_id = v_owner_id
          AND secret.app_id = v_app_id
          AND secret.key = v_key
          AND secret.value_encrypted <> '';
      ELSE
        PERFORM 1
        WHERE v_app.env_vars ? v_key
          AND jsonb_typeof(v_app.env_vars->v_key) = 'string'
          AND (v_app.env_vars->>v_key) <> '';
      END IF;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'agent_home_required_setting_missing',
          DETAIL = jsonb_build_object(
            'code', 'AGENT_HOME_INVALID_MUTATION',
            'field', v_key,
            'reason', 'required_setting_missing'
          )::text;
      END IF;
    END IF;
  END LOOP;

  IF v_routine_id IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.user_routines AS routine
      WHERE routine.user_id = v_owner_id
        AND routine.composer_app_id = v_app_id
        AND routine.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'agent_home_routine_required',
        DETAIL =
          '{"code":"AGENT_HOME_INVALID_MUTATION","field":"routineId","reason":"routine_selection_required"}';
    END IF;
  ELSE
    SELECT routine.*
      INTO v_routine
    FROM public.user_routines AS routine
    WHERE routine.id = v_routine_id
      AND routine.user_id = v_owner_id
      AND routine.composer_app_id = v_app_id
      AND routine.deleted_at IS NULL
      AND (
        routine.metadata->>'launch_primary' = 'true'
        OR routine.metadata->>'launch_managed' = 'true'
      )
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'agent_home_routine_not_found',
        DETAIL = '{"code":"AGENT_HOME_ROUTINE_NOT_FOUND"}';
    END IF;
    IF v_routine.status NOT IN ('paused', 'error', 'active') THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'agent_home_routine_disabled',
        DETAIL = '{"code":"AGENT_HOME_ROUTINE_DISABLED"}';
    END IF;
    IF v_routine.max_concurrency <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'agent_home_invalid_max_concurrency',
        DETAIL =
          '{"code":"AGENT_HOME_INVALID_MUTATION","field":"maxConcurrency"}';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.routine_capabilities AS capability
      WHERE capability.routine_id = v_routine.id
        AND capability.user_id = v_owner_id
        AND capability.required = true
        AND (
          capability.approved = false
          OR capability.approved_by_user_id IS DISTINCT FROM v_owner_id
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'agent_home_capabilities_unapproved',
        DETAIL =
          '{"code":"AGENT_HOME_INVALID_MUTATION","field":"capabilities","reason":"required_capability_unapproved"}';
    END IF;

    IF jsonb_typeof(v_routine.schedule) <> 'object'
      OR jsonb_typeof(v_routine.schedule->'type') <> 'string' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'agent_home_invalid_schedule',
        DETAIL =
          '{"code":"AGENT_HOME_INVALID_MUTATION","field":"schedule"}';
    END IF;
    v_schedule_type := v_routine.schedule->>'type';
    IF v_schedule_type = 'interval' THEN
      IF NOT (v_routine.schedule ?& ARRAY['type', 'every_seconds'])
        OR (
          SELECT count(*) FROM jsonb_object_keys(v_routine.schedule)
        ) <> 2
        OR jsonb_typeof(v_routine.schedule->'every_seconds') <> 'number'
        OR NOT COALESCE(
          (v_routine.schedule->>'every_seconds') ~ '^[0-9]+$', false
        )
        OR (v_routine.schedule->>'every_seconds')::numeric < 60
        OR (v_routine.schedule->>'every_seconds')::numeric >
          9007199254740991 THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'agent_home_invalid_interval_schedule',
          DETAIL =
            '{"code":"AGENT_HOME_INVALID_MUTATION","field":"schedule"}';
      END IF;
    ELSIF v_schedule_type = 'cron' THEN
      IF NOT (v_routine.schedule ?& ARRAY['type', 'cron', 'timezone'])
        OR (
          SELECT count(*) FROM jsonb_object_keys(v_routine.schedule)
        ) <> 3
        OR jsonb_typeof(v_routine.schedule->'cron') <> 'string'
        OR jsonb_typeof(v_routine.schedule->'timezone') <> 'string'
        OR v_routine.schedule->>'cron' IS DISTINCT FROM
          btrim(v_routine.schedule->>'cron')
        OR v_routine.schedule->>'cron' = ''
        OR char_length(v_routine.schedule->>'cron') > 200
        OR array_length(
          regexp_split_to_array(
            v_routine.schedule->>'cron', '[[:space:]]+'
          ), 1
        ) <> 5
        OR v_routine.schedule->>'timezone' IS DISTINCT FROM
          btrim(v_routine.schedule->>'timezone')
        OR v_routine.schedule->>'timezone' = ''
        OR char_length(v_routine.schedule->>'timezone') > 100 THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'agent_home_invalid_cron_schedule',
          DETAIL =
            '{"code":"AGENT_HOME_INVALID_MUTATION","field":"schedule"}';
      END IF;
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'agent_home_invalid_schedule_type',
        DETAIL =
          '{"code":"AGENT_HOME_INVALID_MUTATION","field":"schedule"}';
    END IF;

    IF jsonb_typeof(v_routine.budget_policy) <> 'object'
      OR NOT (v_routine.budget_policy ?& ARRAY[
        'max_light_per_run', 'max_light_per_day',
        'max_light_per_month', 'max_calls_per_run'
      ])
      OR (
        SELECT count(*) FROM jsonb_object_keys(v_routine.budget_policy)
      ) <> 4
      OR EXISTS (
        SELECT 1
        FROM jsonb_each(v_routine.budget_policy) AS entry
        WHERE jsonb_typeof(entry.value) <> 'number'
      ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'agent_home_invalid_budget',
        DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"budgets"}';
    END IF;
    v_run :=
      (v_routine.budget_policy->>'max_light_per_run')::double precision;
    v_day :=
      (v_routine.budget_policy->>'max_light_per_day')::double precision;
    v_month :=
      (v_routine.budget_policy->>'max_light_per_month')::double precision;
    v_calls :=
      (v_routine.budget_policy->>'max_calls_per_run')::double precision;
    IF v_run < 0 OR v_day < v_run OR v_month < v_day
      OR v_calls < 1 OR v_calls <> trunc(v_calls)
      OR v_run::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_day::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_month::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_calls::text IN ('NaN', 'Infinity', '-Infinity') THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'agent_home_invalid_budget',
        DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"budgets"}';
    END IF;
  END IF;

  IF v_app.deployment_state = 'ready' THEN
    IF v_routine_id IS NOT NULL AND v_routine.status <> 'active' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'agent_home_activation_replay_conflict',
        DETAIL =
          '{"code":"AGENT_HOME_INVALID_MUTATION","field":"routineId","reason":"agent_ready_routine_not_active"}';
    END IF;
    v_replayed := true;
  ELSE
    PERFORM set_config(
      'galactic.member_agent_activation', v_app.id::text, true
    );
    UPDATE public.apps AS app
    SET deployment_state = 'ready',
        setup_required_at = NULL,
        hosting_suspended = false,
        http_enabled = true,
        updated_at = p_now
    WHERE app.id = v_app.id
      AND app.owner_id = v_owner_id;

    IF v_routine_id IS NOT NULL THEN
      UPDATE public.user_routines AS routine
      SET status = 'active',
          next_run_at = p_now,
          approval_policy = COALESCE(
            routine.approval_policy, '{}'::jsonb
          ) || jsonb_build_object(
            'approved', true,
            'approved_at', p_now,
            'approved_by_user_id', v_owner_id
          ),
          metadata = (
            COALESCE(routine.metadata, '{}'::jsonb) - 'setup_required'
          ) || jsonb_build_object(
            'approval_confirmed', true,
            'approved_at', p_now,
            'approved_by_user_id', v_owner_id
          ),
          updated_at = p_now
      WHERE routine.id = v_routine.id
        AND routine.user_id = v_owner_id
        AND routine.composer_app_id = v_app_id
        AND routine.deleted_at IS NULL;

      UPDATE public.routine_capabilities AS capability
      SET metadata = (
            COALESCE(capability.metadata, '{}'::jsonb) - 'setup_required'
          ) || jsonb_build_object('activated_at', p_now),
          updated_at = p_now
      WHERE capability.routine_id = v_routine.id
        AND capability.user_id = v_owner_id;
    END IF;
    PERFORM set_config('galactic.member_agent_activation', '', true);
  END IF;

  SELECT app.agent_home_revision
    INTO v_revision
  FROM public.apps AS app
  WHERE app.id = v_app_id
    AND app.owner_id = v_owner_id;

  RETURN jsonb_build_object(
    'code', CASE WHEN v_replayed THEN 'already_active' ELSE 'activated' END,
    'app_id', v_app_id,
    'deployment_state', 'ready',
    'release_generation', v_expected_generation::text,
    'agent_home_revision', v_revision::text,
    'routine_id', v_routine_id,
    'routine_status', CASE
      WHEN v_routine_id IS NULL THEN NULL
      ELSE 'active'
    END,
    'replayed', v_replayed
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_member_routine_execution(
  p_routine_id uuid,
  p_lease_id text,
  p_now timestamptz,
  p_lease_expires_at timestamptz
) RETURNS SETOF public.user_routines
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_app_id uuid;
  v_entitlement public.account_entitlements%ROWTYPE;
  v_entitlement_found boolean;
  v_app public.apps%ROWTYPE;
  v_app_found boolean;
  v_routine public.user_routines%ROWTYPE;
  v_active_count integer;
BEGIN
  IF p_routine_id IS NULL
    OR p_lease_id IS NULL
    OR length(p_lease_id) NOT BETWEEN 1 AND 200
    OR p_lease_id ~ '[[:cntrl:]]'
    OR p_now IS NULL
    OR p_lease_expires_at <= p_now
    OR p_lease_expires_at > p_now + interval '15 minutes' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      DETAIL = '{"code":"ROUTINE_CLAIM_INVALID"}';
  END IF;

  SELECT routine.user_id, routine.composer_app_id
    INTO v_user_id, v_app_id
  FROM public.user_routines AS routine
  WHERE routine.id = p_routine_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT entitlement.*
    INTO v_entitlement
  FROM public.account_entitlements AS entitlement
  WHERE entitlement.user_id = v_user_id
  FOR UPDATE;
  v_entitlement_found := FOUND;

  SELECT app.*
    INTO v_app
  FROM public.apps AS app
  WHERE app.id = v_app_id
    AND app.owner_id = v_user_id
  FOR UPDATE;
  v_app_found := FOUND;

  SELECT routine.*
    INTO v_routine
  FROM public.user_routines AS routine
  WHERE routine.id = p_routine_id
    AND routine.user_id = v_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT v_entitlement_found
    OR v_entitlement.plan_code <> 'pro'
    OR v_entitlement.subscription_status <> 'active' THEN
    IF v_routine.status = 'active' AND v_routine.deleted_at IS NULL THEN
      UPDATE public.user_routines AS routine
      SET status = 'paused',
          next_run_at = NULL,
          lease_id = NULL,
          lease_expires_at = NULL,
          metadata = COALESCE(routine.metadata, '{}'::jsonb)
            || jsonb_build_object(
              'membership_pause',
              jsonb_build_object(
                'code', 'pro_subscription_required',
                'at', p_now
              )
            ),
          updated_at = p_now
      WHERE routine.id = v_routine.id;
    END IF;
    RETURN;
  END IF;

  IF NOT v_app_found
    OR v_app.deleted_at IS NOT NULL
    OR v_app.hosting_suspended = true
    OR v_app.deployment_state NOT IN ('legacy', 'ready') THEN
    IF v_routine.status = 'active' AND v_routine.deleted_at IS NULL THEN
      UPDATE public.user_routines AS routine
      SET status = 'paused',
          next_run_at = NULL,
          lease_id = NULL,
          lease_expires_at = NULL,
          metadata = COALESCE(routine.metadata, '{}'::jsonb)
            || jsonb_build_object(
              'deployment_pause',
              jsonb_build_object(
                'code', 'agent_deployment_not_runnable',
                'deployment_state', v_app.deployment_state,
                'at', p_now
              )
            ),
          updated_at = p_now
      WHERE routine.id = v_routine.id;
    END IF;
    RETURN;
  END IF;

  IF v_routine.status <> 'active'
    OR v_routine.deleted_at IS NOT NULL
    OR (
      v_routine.next_run_at IS NOT NULL
      AND v_routine.next_run_at > p_now
    )
    OR (
      v_routine.lease_id IS NOT NULL
      AND (
        v_routine.lease_expires_at IS NULL
        OR v_routine.lease_expires_at > p_now
      )
    ) THEN
    RETURN;
  END IF;

  SELECT count(*)::integer
    INTO v_active_count
  FROM public.routine_runs AS run
  WHERE run.routine_id = v_routine.id
    AND run.status IN ('queued', 'running');
  IF v_active_count >= v_routine.max_concurrency THEN
    RETURN;
  END IF;

  UPDATE public.user_routines AS routine
  SET lease_id = p_lease_id,
      lease_expires_at = p_lease_expires_at,
      updated_at = p_now
  WHERE routine.id = v_routine.id
  RETURNING routine.* INTO v_routine;

  RETURN NEXT v_routine;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_member_routine_run_execution(
  p_run_id uuid,
  p_lease_id text,
  p_trace_id uuid,
  p_now timestamptz,
  p_lease_expires_at timestamptz
) RETURNS SETOF public.routine_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_routine_id uuid;
  v_app_id uuid;
  v_entitlement public.account_entitlements%ROWTYPE;
  v_entitlement_found boolean;
  v_app public.apps%ROWTYPE;
  v_app_found boolean;
  v_routine public.user_routines%ROWTYPE;
  v_run public.routine_runs%ROWTYPE;
  v_operator_run_once boolean;
BEGIN
  IF p_run_id IS NULL
    OR p_lease_id IS NULL
    OR length(p_lease_id) NOT BETWEEN 1 AND 200
    OR p_lease_id ~ '[[:cntrl:]]'
    OR p_trace_id IS NULL
    OR p_now IS NULL
    OR p_lease_expires_at <= p_now
    OR p_lease_expires_at > p_now + interval '15 minutes' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      DETAIL = '{"code":"ROUTINE_RUN_CLAIM_INVALID"}';
  END IF;

  SELECT run.user_id, run.routine_id
    INTO v_user_id, v_routine_id
  FROM public.routine_runs AS run
  WHERE run.id = p_run_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT entitlement.*
    INTO v_entitlement
  FROM public.account_entitlements AS entitlement
  WHERE entitlement.user_id = v_user_id
  FOR UPDATE;
  v_entitlement_found := FOUND;

  SELECT routine.composer_app_id
    INTO v_app_id
  FROM public.user_routines AS routine
  WHERE routine.id = v_routine_id
    AND routine.user_id = v_user_id;

  SELECT app.*
    INTO v_app
  FROM public.apps AS app
  WHERE app.id = v_app_id
    AND app.owner_id = v_user_id
  FOR UPDATE;
  v_app_found := FOUND;

  SELECT routine.*
    INTO v_routine
  FROM public.user_routines AS routine
  WHERE routine.id = v_routine_id
    AND routine.user_id = v_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT run.*
    INTO v_run
  FROM public.routine_runs AS run
  WHERE run.id = p_run_id
    AND run.routine_id = v_routine.id
    AND run.user_id = v_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_run.status <> 'queued' THEN
    RETURN;
  END IF;

  IF NOT v_entitlement_found
    OR v_entitlement.plan_code <> 'pro'
    OR v_entitlement.subscription_status <> 'active' THEN
    IF v_routine.status = 'active' AND v_routine.deleted_at IS NULL THEN
      UPDATE public.user_routines AS routine
      SET status = 'paused',
          next_run_at = NULL,
          lease_id = NULL,
          lease_expires_at = NULL,
          metadata = COALESCE(routine.metadata, '{}'::jsonb)
            || jsonb_build_object(
              'membership_pause',
              jsonb_build_object(
                'code', 'pro_subscription_required',
                'at', p_now
              )
            ),
          updated_at = p_now
      WHERE routine.id = v_routine.id;
    END IF;
    UPDATE public.routine_runs AS run
    SET status = 'skipped',
        summary = 'Active Galactic membership is required to run this Agent.',
        error = '{"code":"pro_subscription_required"}'::jsonb,
        completed_at = p_now,
        lease_id = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL
    WHERE run.id = v_run.id;
    RETURN;
  END IF;

  IF NOT v_app_found
    OR v_app.deleted_at IS NOT NULL
    OR v_app.hosting_suspended = true
    OR v_app.deployment_state NOT IN ('legacy', 'ready') THEN
    IF v_routine.status = 'active' AND v_routine.deleted_at IS NULL THEN
      UPDATE public.user_routines AS routine
      SET status = 'paused',
          next_run_at = NULL,
          lease_id = NULL,
          lease_expires_at = NULL,
          metadata = COALESCE(routine.metadata, '{}'::jsonb)
            || jsonb_build_object(
              'deployment_pause',
              jsonb_build_object(
                'code', 'agent_deployment_not_runnable',
                'deployment_state', v_app.deployment_state,
                'at', p_now
              )
            ),
          updated_at = p_now
      WHERE routine.id = v_routine.id;
    END IF;
    UPDATE public.routine_runs AS run
    SET status = 'skipped',
        summary = 'The deployed Agent is not runnable.',
        error = '{"code":"agent_deployment_not_runnable"}'::jsonb,
        completed_at = p_now,
        lease_id = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL
    WHERE run.id = v_run.id;
    RETURN;
  END IF;

  v_operator_run_once :=
    v_run.metadata->>'source' = 'operator_item.run_once'
    AND v_run.agent_home_action_request_id IS NOT NULL;
  IF v_routine.deleted_at IS NOT NULL
    OR (
      v_routine.status <> 'active'
      AND NOT (v_operator_run_once AND v_routine.status = 'paused')
    ) THEN
    UPDATE public.routine_runs AS run
    SET status = 'skipped',
        summary = 'The routine is no longer eligible to run.',
        error = '{"code":"routine_not_active"}'::jsonb,
        completed_at = p_now,
        lease_id = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL
    WHERE run.id = v_run.id;
    RETURN;
  END IF;

  IF v_run.attempt_count >= v_run.max_attempts THEN
    UPDATE public.routine_runs AS run
    SET status = 'failed',
        summary = 'Routine run exhausted retry attempts before claim.',
        error = '{"code":"retry_attempts_exhausted"}'::jsonb,
        completed_at = p_now,
        lease_id = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL
    WHERE run.id = v_run.id;
    RETURN;
  END IF;

  UPDATE public.routine_runs AS run
  SET status = 'running',
      trace_id = COALESCE(run.trace_id, p_trace_id),
      started_at = COALESCE(run.started_at, p_now),
      lease_id = p_lease_id,
      lease_expires_at = p_lease_expires_at,
      attempt_count = run.attempt_count + 1,
      next_attempt_at = NULL
  WHERE run.id = v_run.id
  RETURNING run.* INTO v_run;

  RETURN NEXT v_run;
END;
$$;

REVOKE ALL ON FUNCTION
  public.builder_handoff_deployment_phase_rank(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.builder_handoff_normalized_manifest(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.builder_handoff_app_base_snapshot(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.is_service_role_request()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.prevent_app_release_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.guard_agent_home_promotion_release_write()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.guard_builder_handoff_session_promotion()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.enforce_active_routine_membership()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.guard_app_membership_lifecycle()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.builder_handoff_deployment_result(
  public.builder_handoff_deployments, text, boolean, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.builder_handoff_deployment_base_is_current(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.claim_builder_handoff_deployment(jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.fence_builder_handoff_deployment(jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.reconcile_builder_handoff_deployment_lease(jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.fail_builder_handoff_deployment(jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.commit_builder_handoff_deployment(jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.subscription_checkout_attempt_result(
  public.subscription_checkout_attempts, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.claim_subscription_checkout_attempt(jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.bind_subscription_checkout_attempt(jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.project_subscription_checkout_attempt(jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.get_subscription_checkout_attempt(jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.activate_member_deployed_agent(jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.claim_member_routine_execution(
    uuid, text, timestamptz, timestamptz
  )
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.claim_member_routine_run_execution(
    uuid, text, uuid, timestamptz, timestamptz
  )
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.claim_builder_handoff_deployment(jsonb, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.fence_builder_handoff_deployment(jsonb, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.reconcile_builder_handoff_deployment_lease(jsonb, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.fail_builder_handoff_deployment(jsonb, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.commit_builder_handoff_deployment(jsonb, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.claim_subscription_checkout_attempt(jsonb, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.bind_subscription_checkout_attempt(jsonb, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.project_subscription_checkout_attempt(jsonb, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.get_subscription_checkout_attempt(jsonb, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.activate_member_deployed_agent(jsonb, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.claim_member_routine_execution(
    uuid, text, timestamptz, timestamptz
  )
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.claim_member_routine_run_execution(
    uuid, text, uuid, timestamptz, timestamptz
  )
  TO service_role;

COMMENT ON TABLE public.app_releases IS
  'Append-only evidence and materialization identity for an exact deployed Agent release.';
COMMENT ON TABLE public.builder_handoff_deployments IS
  'Membership-gated, leased, idempotent saga for an immutable Builder candidate deployment.';
COMMENT ON TABLE public.subscription_checkout_attempts IS
  'Server-only durable Stripe checkout identity and return reconciliation state.';
COMMENT ON COLUMN public.apps.deployment_state IS
  'legacy, hidden materializing, private setup_required, ready, or disabled.';
COMMENT ON COLUMN public.apps.release_generation IS
  'Monotonic canonical release CAS generation. Builder extension handoffs bind this value.';
