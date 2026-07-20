-- Galactic Compute Agent ownership and deletion lifecycle.
--
-- Lock order is intentional. Public RPC wrappers first lock the initiating
-- app row and owner row, and agents.call configuration also locks each target
-- app, before entering the original implementation that takes the owner+Agent
-- advisory lock. App and user lifecycle changes therefore cannot invert their
-- row locks with later policy/FK work inside the implementation. Owner locks
-- are NOWAIT because legacy user-delete cascades can themselves bump app rows;
-- fail-fast retry is safer than waiting while the wrapper owns the app row.

ALTER FUNCTION public.admit_compute_run(
  uuid, text, uuid, uuid, text, text, text, text, text, jsonb, jsonb,
  timestamptz, jsonb
) RENAME TO admit_compute_run_lifecycle_impl;

ALTER FUNCTION public.put_compute_agent_policy_settings(
  uuid, uuid, boolean, text[], integer, integer, bigint, integer,
  timestamptz, bigint
) RENAME TO put_compute_agent_policy_settings_lifecycle_impl;

ALTER FUNCTION public.put_compute_agent_authority_rule(
  uuid, uuid, text, text, text, text, uuid, text, jsonb, bigint
) RENAME TO put_compute_agent_authority_rule_lifecycle_impl;

ALTER FUNCTION public.set_compute_agent_policy_state(
  uuid, uuid, text, bigint
) RENAME TO set_compute_agent_policy_state_lifecycle_impl;

ALTER FUNCTION public.put_compute_agent_secret_binding(
  uuid, uuid, uuid, text, text, text, text, text, text, timestamptz, bigint
) RENAME TO put_compute_agent_secret_binding_lifecycle_impl;

ALTER FUNCTION public.revoke_compute_agent_secret_binding(
  uuid, uuid, uuid, text, bigint
) RENAME TO revoke_compute_agent_secret_binding_lifecycle_impl;

ALTER FUNCTION public.replace_compute_agent_configuration(
  uuid, uuid, boolean, text[], integer, integer, bigint, integer,
  timestamptz, text[], jsonb, jsonb, bigint, bigint
) RENAME TO replace_compute_agent_configuration_lifecycle_impl;

ALTER FUNCTION public.claim_compute_run(uuid)
RENAME TO claim_compute_run_lifecycle_impl;

ALTER FUNCTION public.prepare_compute_run_lease(
  uuid, text, uuid, uuid, text, text, jsonb, boolean
) RENAME TO prepare_compute_run_lease_lifecycle_impl;

-- Admission takes a SHARE row lock before its existing advisory lock. SHARE
-- conflicts with both soft deletion and ownership transfer, and also protects
-- the app FK insert later in admission from forming an inverse lock cycle.
CREATE OR REPLACE FUNCTION public.admit_compute_run(
  p_idempotency_key uuid,
  p_request_hash text,
  p_user_id uuid,
  p_agent_id uuid,
  p_caller_function text,
  p_execution_id text,
  p_directive_hash text,
  p_profile text,
  p_environment_digest text,
  p_execution_request jsonb,
  p_manifest_ceiling jsonb,
  p_expires_at timestamptz,
  p_authorities jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_source_locked boolean := false;
  v_target_agent_id uuid;
BEGIN
  IF p_user_id IS NOT NULL AND p_agent_id IS NOT NULL THEN
    PERFORM 1
    FROM public.apps AS app
    WHERE app.id = p_agent_id AND app.owner_id = p_user_id
      AND app.deleted_at IS NULL
    FOR SHARE;
    v_source_locked := FOUND;
  END IF;

  -- Admission snapshots agents.call rules inside the implementation. Lock the
  -- live targets first so target ownership transfer cannot hold the target app
  -- while waiting on a source policy/rule already locked by this admission.
  IF v_source_locked AND p_authorities IS NOT NULL
     AND jsonb_typeof(p_authorities) = 'array'
     AND jsonb_array_length(p_authorities) <= 256 THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_authorities) AS requested(authority)
      WHERE jsonb_typeof(requested.authority) = 'object'
        AND requested.authority->>'action' = 'agents.call'
        AND (
          jsonb_typeof(requested.authority->'target_agent_id') IS DISTINCT FROM 'string'
          OR (requested.authority->>'target_agent_id') !~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_INVALID_AUTHORITY',
        'message', 'An agents.call authority requires one exact target Agent.'
      )::text;
    END IF;

    FOR v_target_agent_id IN
      SELECT DISTINCT (requested.authority->>'target_agent_id')::uuid
      FROM jsonb_array_elements(p_authorities) AS requested(authority)
      WHERE jsonb_typeof(requested.authority) = 'object'
        AND requested.authority->>'action' = 'agents.call'
      ORDER BY 1
    LOOP
      PERFORM 1
      FROM public.apps AS target
      WHERE target.id = v_target_agent_id
        AND target.owner_id = p_user_id
        AND target.deleted_at IS NULL
      FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
          'code', 'COMPUTE_TARGET_NOT_OWNED',
          'message', 'agents.call may target only a live Agent owned by the same user.'
        )::text;
      END IF;
    END LOOP;
  END IF;

  -- App locks always precede the owner lock. User deletion owns the user row
  -- first, so NOWAIT turns that lifecycle race into a retry instead of waiting
  -- while holding an app row that user cleanup may need.
  IF v_source_locked THEN
    PERFORM 1
    FROM public.users AS owner
    WHERE owner.id = p_user_id
    FOR KEY SHARE NOWAIT;
  END IF;
  RETURN public.admit_compute_run_lifecycle_impl(
    p_idempotency_key, p_request_hash, p_user_id, p_agent_id,
    p_caller_function, p_execution_id, p_directive_hash, p_profile,
    p_environment_digest, p_execution_request, p_manifest_ceiling,
    p_expires_at, p_authorities
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.put_compute_agent_policy_settings(
  p_user_id uuid,
  p_agent_id uuid,
  p_enabled boolean,
  p_allowed_tools text[],
  p_max_timeout_ms integer,
  p_max_concurrency integer,
  p_max_artifact_bytes bigint,
  p_max_artifacts integer,
  p_owner_confirmed_at timestamptz,
  p_expected_revision bigint
) RETURNS SETOF public.compute_agent_policies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_user_id IS NOT NULL AND p_agent_id IS NOT NULL THEN
    PERFORM 1
    FROM public.apps AS app
    WHERE app.id = p_agent_id AND app.owner_id = p_user_id
      AND app.deleted_at IS NULL
    FOR SHARE;
    PERFORM 1
    FROM public.users AS owner
    WHERE owner.id = p_user_id
    FOR KEY SHARE NOWAIT;
  END IF;
  RETURN QUERY
  SELECT *
  FROM public.put_compute_agent_policy_settings_lifecycle_impl(
    p_user_id, p_agent_id, p_enabled, p_allowed_tools, p_max_timeout_ms,
    p_max_concurrency, p_max_artifact_bytes, p_max_artifacts,
    p_owner_confirmed_at, p_expected_revision
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.put_compute_agent_authority_rule(
  p_user_id uuid,
  p_agent_id uuid,
  p_caller_function text,
  p_decision text,
  p_action text,
  p_resource_kind text,
  p_target_agent_id uuid,
  p_target_function text,
  p_constraints jsonb,
  p_expected_authority_epoch bigint DEFAULT NULL
) RETURNS TABLE (
  id uuid,
  user_id uuid,
  agent_id uuid,
  caller_function text,
  action text,
  resource_kind text,
  target_agent_id uuid,
  target_function text,
  decision text,
  constraints jsonb,
  status text,
  rule_version bigint,
  authority_epoch bigint,
  expires_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_source_locked boolean := false;
BEGIN
  IF p_user_id IS NOT NULL AND p_agent_id IS NOT NULL THEN
    PERFORM 1
    FROM public.apps AS app
    WHERE app.id = p_agent_id AND app.owner_id = p_user_id
      AND app.deleted_at IS NULL
    FOR SHARE;
    v_source_locked := FOUND;
  END IF;

  -- This is deliberately before the implementation's source-policy advisory
  -- and row locks. Ownership transfer changes a key column and therefore
  -- conflicts with this target KEY SHARE lock.
  IF v_source_locked AND p_target_agent_id IS NOT NULL
     AND public.compute_authority_shape_valid(
       p_action, p_resource_kind, p_target_agent_id, p_target_function
     ) THEN
    PERFORM 1
    FROM public.apps AS target
    WHERE target.id = p_target_agent_id AND target.owner_id = p_user_id
      AND target.deleted_at IS NULL
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_TARGET_NOT_OWNED',
        'message', 'agents.call may target only an Agent owned by the same user.'
      )::text;
    END IF;
  END IF;

  IF v_source_locked THEN
    PERFORM 1
    FROM public.users AS owner
    WHERE owner.id = p_user_id
    FOR KEY SHARE NOWAIT;
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.put_compute_agent_authority_rule_lifecycle_impl(
    p_user_id, p_agent_id, p_caller_function, p_decision, p_action,
    p_resource_kind, p_target_agent_id, p_target_function, p_constraints,
    p_expected_authority_epoch
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_compute_agent_policy_state(
  p_user_id uuid,
  p_agent_id uuid,
  p_state text,
  p_expected_authority_epoch bigint
) RETURNS TABLE (state text, authority_epoch bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_user_id IS NOT NULL AND p_agent_id IS NOT NULL THEN
    PERFORM 1
    FROM public.apps AS app
    WHERE app.id = p_agent_id AND app.owner_id = p_user_id
      AND app.deleted_at IS NULL
    FOR SHARE;
    PERFORM 1
    FROM public.users AS owner
    WHERE owner.id = p_user_id
    FOR KEY SHARE NOWAIT;
  END IF;
  RETURN QUERY
  SELECT *
  FROM public.set_compute_agent_policy_state_lifecycle_impl(
    p_user_id, p_agent_id, p_state, p_expected_authority_epoch
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.put_compute_agent_secret_binding(
  p_binding_id uuid,
  p_user_id uuid,
  p_agent_id uuid,
  p_caller_function text,
  p_name text,
  p_variable_name text,
  p_delivery text,
  p_env_name text,
  p_file_name text,
  p_expires_at timestamptz,
  p_expected_authority_epoch bigint DEFAULT NULL
) RETURNS SETOF public.compute_agent_secret_bindings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_user_id IS NOT NULL AND p_agent_id IS NOT NULL THEN
    PERFORM 1
    FROM public.apps AS app
    WHERE app.id = p_agent_id AND app.owner_id = p_user_id
      AND app.deleted_at IS NULL
    FOR SHARE;
    PERFORM 1
    FROM public.users AS owner
    WHERE owner.id = p_user_id
    FOR KEY SHARE NOWAIT;
  END IF;
  RETURN QUERY
  SELECT *
  FROM public.put_compute_agent_secret_binding_lifecycle_impl(
    p_binding_id, p_user_id, p_agent_id, p_caller_function, p_name,
    p_variable_name, p_delivery, p_env_name, p_file_name, p_expires_at,
    p_expected_authority_epoch
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_compute_agent_secret_binding(
  p_binding_id uuid,
  p_user_id uuid,
  p_agent_id uuid,
  p_caller_function text,
  p_expected_binding_version bigint
) RETURNS SETOF public.compute_agent_secret_bindings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_user_id IS NOT NULL AND p_agent_id IS NOT NULL THEN
    PERFORM 1
    FROM public.apps AS app
    WHERE app.id = p_agent_id AND app.owner_id = p_user_id
      AND app.deleted_at IS NULL
    FOR SHARE;
    PERFORM 1
    FROM public.users AS owner
    WHERE owner.id = p_user_id
    FOR KEY SHARE NOWAIT;
  END IF;
  RETURN QUERY
  SELECT *
  FROM public.revoke_compute_agent_secret_binding_lifecycle_impl(
    p_binding_id, p_user_id, p_agent_id, p_caller_function,
    p_expected_binding_version
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.replace_compute_agent_configuration(
  p_user_id uuid,
  p_agent_id uuid,
  p_enabled boolean,
  p_allowed_tools text[],
  p_max_timeout_ms integer,
  p_max_concurrency integer,
  p_max_artifact_bytes bigint,
  p_max_artifacts integer,
  p_owner_confirmed_at timestamptz,
  p_caller_functions text[],
  p_authority_rules jsonb,
  p_secret_bindings jsonb,
  p_expected_revision bigint,
  p_expected_authority_epoch bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_source_locked boolean := false;
  v_target_agent_id uuid;
BEGIN
  IF p_user_id IS NOT NULL AND p_agent_id IS NOT NULL THEN
    PERFORM 1
    FROM public.apps AS app
    WHERE app.id = p_agent_id AND app.owner_id = p_user_id
      AND app.deleted_at IS NULL
    FOR SHARE;
    v_source_locked := FOUND;
  END IF;

  -- Lock distinct, syntactically valid agents.call targets in a deterministic
  -- order. The implementation remains responsible for all canonical shape
  -- validation; these locks only close the ownership-transfer race.
  IF v_source_locked AND p_authority_rules IS NOT NULL
     AND jsonb_typeof(p_authority_rules) = 'array' THEN
    FOR v_target_agent_id IN
      SELECT DISTINCT (requested.rule->>'target_agent_id')::uuid
      FROM jsonb_array_elements(p_authority_rules) AS requested(rule)
      WHERE jsonb_typeof(requested.rule) = 'object'
        AND requested.rule->>'action' = 'agents.call'
        AND jsonb_typeof(requested.rule->'target_agent_id') = 'string'
        AND (requested.rule->>'target_agent_id') ~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ORDER BY 1
    LOOP
      PERFORM 1
      FROM public.apps AS target
      WHERE target.id = v_target_agent_id AND target.owner_id = p_user_id
        AND target.deleted_at IS NULL
      FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
          'code', 'COMPUTE_TARGET_NOT_OWNED',
          'message', 'agents.call may target only an Agent owned by the same user.'
        )::text;
      END IF;
    END LOOP;
  END IF;

  IF v_source_locked THEN
    PERFORM 1
    FROM public.users AS owner
    WHERE owner.id = p_user_id
    FOR KEY SHARE NOWAIT;
  END IF;

  RETURN public.replace_compute_agent_configuration_lifecycle_impl(
    p_user_id, p_agent_id, p_enabled, p_allowed_tools, p_max_timeout_ms,
    p_max_concurrency, p_max_artifact_bytes, p_max_artifacts,
    p_owner_confirmed_at, p_caller_functions, p_authority_rules,
    p_secret_bindings, p_expected_revision, p_expected_authority_epoch
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_compute_run(
  p_run_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_run_id IS NOT NULL THEN
    PERFORM 1
    FROM public.compute_runs AS run
    JOIN public.apps AS app ON app.id = run.agent_id
    WHERE run.id = p_run_id
    FOR SHARE OF app;
    PERFORM 1
    FROM public.compute_runs AS run
    JOIN public.users AS owner ON owner.id = run.user_id
    WHERE run.id = p_run_id
    FOR KEY SHARE OF owner NOWAIT;
  END IF;
  RETURN public.claim_compute_run_lifecycle_impl(p_run_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_compute_run_lease(
  p_run_id uuid,
  p_container_id text,
  p_token_id uuid,
  p_token_lookup_id uuid,
  p_token_digest text,
  p_token_audience text,
  p_expected_secret_bindings jsonb,
  p_replace_existing_token boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_run_id IS NOT NULL THEN
    PERFORM 1
    FROM public.compute_runs AS run
    JOIN public.apps AS app ON app.id = run.agent_id
    WHERE run.id = p_run_id
    FOR SHARE OF app;
    PERFORM 1
    FROM public.compute_runs AS run
    JOIN public.users AS owner ON owner.id = run.user_id
    WHERE run.id = p_run_id
    FOR KEY SHARE OF owner NOWAIT;
  END IF;
  RETURN public.prepare_compute_run_lease_lifecycle_impl(
    p_run_id, p_container_id, p_token_id, p_token_lookup_id, p_token_digest,
    p_token_audience, p_expected_secret_bindings, p_replace_existing_token
  );
END;
$$;

-- Revoke all authority/configuration that belongs to the previous owner. For
-- rules on other source Agents that target the transferred/deleted Agent, only
-- revision is incremented: the live target-owner check below denies stale
-- running snapshots without authority-epoch fencing unrelated Compute bodies.
CREATE OR REPLACE FUNCTION public.revoke_compute_agent_lifecycle_configuration(
  p_user_id uuid,
  p_agent_id uuid,
  p_delete_policy boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Two Agents can target one another and be transferred concurrently. Lock
  -- the union of own and incoming configuration in a deterministic order
  -- before changing any row. We intentionally do not take source-Agent
  -- advisory locks: target row locks already serialize configuration writes,
  -- while cross-taking source advisories would deadlock reciprocal transfers.
  PERFORM policy.agent_id
  FROM public.compute_agent_policies AS policy
  WHERE (policy.user_id = p_user_id AND policy.agent_id = p_agent_id)
     OR EXISTS (
       SELECT 1
       FROM public.compute_agent_authority_rules AS incoming
       WHERE incoming.action = 'agents.call'
         AND incoming.target_agent_id = p_agent_id
         AND incoming.user_id = policy.user_id
         AND incoming.agent_id = policy.agent_id
     )
  ORDER BY policy.agent_id, policy.user_id
  FOR UPDATE;

  PERFORM rule.id
  FROM public.compute_agent_authority_rules AS rule
  WHERE (rule.user_id = p_user_id AND rule.agent_id = p_agent_id)
     OR (rule.action = 'agents.call' AND rule.target_agent_id = p_agent_id)
  ORDER BY rule.id
  FOR UPDATE;

  PERFORM binding.id
  FROM public.compute_agent_secret_bindings AS binding
  WHERE binding.user_id = p_user_id AND binding.agent_id = p_agent_id
  ORDER BY binding.id
  FOR UPDATE;

  WITH revoked_incoming AS (
    UPDATE public.compute_agent_authority_rules AS rule
    SET status = 'revoked',
        rule_version = rule.rule_version + 1,
        updated_at = now()
    WHERE rule.action = 'agents.call'
      AND rule.target_agent_id = p_agent_id
      AND rule.status = 'active'
    RETURNING rule.user_id, rule.agent_id
  )
  UPDATE public.compute_agent_policies AS policy
  SET revision = policy.revision + 1,
      updated_at = now()
  WHERE EXISTS (
    SELECT 1
    FROM revoked_incoming AS source
    WHERE source.user_id = policy.user_id
      AND source.agent_id = policy.agent_id
  );

  UPDATE public.compute_agent_secret_bindings AS binding
  SET status = 'revoked',
      binding_version = binding.binding_version + 1,
      updated_at = now()
  WHERE binding.user_id = p_user_id AND binding.agent_id = p_agent_id
    AND binding.status = 'active';

  UPDATE public.compute_agent_authority_rules AS rule
  SET status = 'revoked',
      rule_version = rule.rule_version + 1,
      updated_at = now()
  WHERE rule.user_id = p_user_id AND rule.agent_id = p_agent_id
    AND rule.status = 'active';

  IF p_delete_policy THEN
    DELETE FROM public.compute_agent_policies AS policy
    WHERE policy.user_id = p_user_id AND policy.agent_id = p_agent_id;
  ELSE
    UPDATE public.compute_agent_policies AS policy
    SET enabled = false,
        state = 'revoked',
        owner_confirmed_at = NULL,
        authority_epoch = policy.authority_epoch + 1,
        revision = policy.revision + 1,
        updated_at = now()
    WHERE policy.user_id = p_user_id AND policy.agent_id = p_agent_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_compute_agent_app_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_owner_transfer boolean := OLD.owner_id IS DISTINCT FROM NEW.owner_id;
  v_soft_delete boolean := OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL;
BEGIN
  IF NOT v_owner_transfer AND NOT v_soft_delete THEN
    RETURN NEW;
  END IF;

  -- apps.owner_id is nullable historically, but Compute ownership is not. A
  -- row with Compute state and no old owner cannot be safely transferred.
  IF OLD.owner_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.compute_agent_policies AS policy
      WHERE policy.agent_id = OLD.id
    ) OR EXISTS (
      SELECT 1 FROM public.compute_runs AS run WHERE run.agent_id = OLD.id
    ) OR EXISTS (
      SELECT 1 FROM public.compute_agent_secret_bindings AS binding
      WHERE binding.agent_id = OLD.id
    ) OR EXISTS (
      SELECT 1 FROM public.compute_agent_authority_rules AS rule
      WHERE rule.agent_id = OLD.id OR rule.target_agent_id = OLD.id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_AGENT_OWNER_INVARIANT',
        'message', 'Compute state without an old Agent owner blocks this lifecycle change.'
      )::text;
    END IF;
    RETURN NEW;
  END IF;

  -- This is the exact per-owner+Agent lock used by admission, claim, prepare,
  -- and policy mutation. The RPC wrappers above establish row-before-advisory
  -- lock order before any FK/policy row can be mutated.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'compute-agent:' || OLD.owner_id::text || ':' || OLD.id::text, 0
  ));

  IF EXISTS (
    SELECT 1
    FROM public.compute_runs AS run
    WHERE run.agent_id = OLD.id
      AND run.state IN ('admitted', 'queued', 'provisioning', 'running')
  ) OR EXISTS (
    SELECT 1
    FROM public.compute_run_budget_reservations AS budget
    JOIN public.compute_runs AS run ON run.id = budget.run_id
    WHERE run.agent_id = OLD.id AND budget.status = 'reserved'
  ) OR EXISTS (
    SELECT 1
    FROM public.compute_job_tokens AS token
    JOIN public.compute_runs AS run ON run.id = token.run_id
    WHERE run.agent_id = OLD.id AND token.status = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_AGENT_LIFECYCLE_BLOCKED',
      'message', 'Destroy and settle all Compute work before transferring or deleting this Agent.'
    )::text;
  END IF;

  PERFORM public.revoke_compute_agent_lifecycle_configuration(
    OLD.owner_id, OLD.id, v_owner_transfer
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_compute_agent_app_update ON public.apps;
CREATE TRIGGER guard_compute_agent_app_update
BEFORE UPDATE OF owner_id, deleted_at ON public.apps
FOR EACH ROW
EXECUTE FUNCTION public.guard_compute_agent_app_update();

-- Compute runs, receipts, wallet reservations, and snapshotted call targets
-- are retained history. Reject hard deletion with a canonical lifecycle error
-- before a retained-history FK or a current incoming authority is encountered.
CREATE OR REPLACE FUNCTION public.guard_compute_agent_app_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF OLD.owner_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'compute-agent:' || OLD.owner_id::text || ':' || OLD.id::text, 0
    ));
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.compute_runs AS run WHERE run.agent_id = OLD.id
  ) OR EXISTS (
    SELECT 1
    FROM public.compute_run_authorities AS authority
    WHERE authority.target_agent_id = OLD.id
  ) OR EXISTS (
    SELECT 1
    FROM public.compute_agent_authority_rules AS rule
    WHERE rule.target_agent_id = OLD.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_AGENT_HISTORY_RETAINED',
      'message', 'An Agent with Compute run history or authority references cannot be hard deleted.'
    )::text;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_compute_agent_app_hard_delete ON public.apps;
CREATE TRIGGER guard_compute_agent_app_hard_delete
BEFORE DELETE ON public.apps
FOR EACH ROW
EXECUTE FUNCTION public.guard_compute_agent_app_hard_delete();

-- A snapshotted agents.call authority is useful only while its exact target
-- remains a live app owned by the job-token principal.
CREATE OR REPLACE FUNCTION public.authorize_compute_job_token(
  p_lookup_id uuid,
  p_token_digest text,
  p_audience text,
  p_container_id text,
  p_action text,
  p_resource_kind text,
  p_target_agent_id uuid,
  p_target_function text,
  p_constraints jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (
  allowed boolean,
  code text,
  run_id uuid,
  agent_id uuid,
  user_id uuid,
  caller_function text,
  authority_id uuid,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_principal record;
  v_authority public.compute_run_authorities%ROWTYPE;
BEGIN
  SELECT * INTO v_principal FROM public.introspect_compute_job_token(
    p_lookup_id, p_token_digest, p_audience, p_container_id
  );
  IF NOT v_principal.allowed THEN
    RETURN QUERY SELECT v_principal.allowed, v_principal.code,
      v_principal.run_id, v_principal.agent_id, v_principal.user_id,
      v_principal.caller_function, NULL::uuid, v_principal.expires_at;
    RETURN;
  END IF;
  IF p_constraints IS NULL OR jsonb_typeof(p_constraints) <> 'object'
     OR NOT public.compute_authority_shape_valid(
       p_action, p_resource_kind, p_target_agent_id, p_target_function
     ) THEN
    RETURN QUERY SELECT false, 'authority_denied', v_principal.run_id,
      v_principal.agent_id, v_principal.user_id, v_principal.caller_function,
      NULL::uuid, v_principal.expires_at;
    RETURN;
  END IF;
  IF p_action = 'agents.call' AND NOT EXISTS (
    SELECT 1
    FROM public.apps AS target
    WHERE target.id = p_target_agent_id
      AND target.owner_id = v_principal.user_id
      AND target.deleted_at IS NULL
  ) THEN
    RETURN QUERY SELECT false, 'target_agent_not_active', v_principal.run_id,
      v_principal.agent_id, v_principal.user_id, v_principal.caller_function,
      NULL::uuid, v_principal.expires_at;
    RETURN;
  END IF;
  SELECT authority.* INTO v_authority
  FROM public.compute_run_authorities AS authority
  WHERE authority.run_id = v_principal.run_id
    AND authority.action = p_action
    AND authority.resource_kind = p_resource_kind
    AND authority.target_agent_id IS NOT DISTINCT FROM p_target_agent_id
    AND authority.target_function IS NOT DISTINCT FROM p_target_function
    AND authority.constraints = p_constraints;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'authority_denied', v_principal.run_id,
      v_principal.agent_id, v_principal.user_id, v_principal.caller_function,
      NULL::uuid, v_principal.expires_at;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, 'ok', v_principal.run_id, v_principal.agent_id,
    v_principal.user_id, v_principal.caller_function, v_authority.id,
    v_principal.expires_at;
END;
$$;

-- Defensive worker wall: normal API deletion destroys the body before the app
-- transition. If ownership nevertheless disappears, heartbeat fences the body
-- and revokes its live job token instead of extending the lease.
CREATE OR REPLACE FUNCTION public.heartbeat_compute_run(
  p_run_id uuid,
  p_lease_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_run public.compute_runs%ROWTYPE;
BEGIN
  SELECT run.* INTO v_run FROM public.compute_runs AS run
  WHERE run.id = p_run_id AND run.lease_id = p_lease_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_HEARTBEAT_REJECTED',
      'message', 'The running lease heartbeat was rejected.'
    )::text;
  END IF;
  IF v_run.state <> 'running' OR v_run.stop_requested_at IS NOT NULL THEN
    RETURN to_jsonb(v_run);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.apps AS app
    WHERE app.id = v_run.agent_id AND app.owner_id = v_run.user_id
      AND app.deleted_at IS NULL
  ) THEN
    UPDATE public.compute_runs AS run
    SET stop_requested_at = now(),
        stop_reason = 'agent_not_active',
        state_version = run.state_version + 1,
        updated_at = now()
    WHERE run.id = p_run_id
    RETURNING * INTO v_run;
    UPDATE public.compute_job_tokens AS token
    SET status = 'revoked', revoked_at = now()
    WHERE token.run_id = p_run_id AND token.status = 'active';
    RETURN to_jsonb(v_run);
  END IF;
  UPDATE public.compute_runs AS run
  SET heartbeat_at = now(),
      claim_expires_at = LEAST(now() + interval '5 minutes', run.expires_at),
      updated_at = now()
  WHERE run.id = p_run_id RETURNING * INTO v_run;
  RETURN to_jsonb(v_run);
END;
$$;

-- The renamed implementations are callable only by their owner. Every public
-- lifecycle RPC remains service-role-only, as before this additive migration.
REVOKE ALL ON FUNCTION public.admit_compute_run_lifecycle_impl(
  uuid, text, uuid, uuid, text, text, text, text, text, jsonb, jsonb,
  timestamptz, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.put_compute_agent_policy_settings_lifecycle_impl(
  uuid, uuid, boolean, text[], integer, integer, bigint, integer,
  timestamptz, bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.put_compute_agent_authority_rule_lifecycle_impl(
  uuid, uuid, text, text, text, text, uuid, text, jsonb, bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_compute_agent_policy_state_lifecycle_impl(
  uuid, uuid, text, bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.put_compute_agent_secret_binding_lifecycle_impl(
  uuid, uuid, uuid, text, text, text, text, text, text, timestamptz, bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revoke_compute_agent_secret_binding_lifecycle_impl(
  uuid, uuid, uuid, text, bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.replace_compute_agent_configuration_lifecycle_impl(
  uuid, uuid, boolean, text[], integer, integer, bigint, integer,
  timestamptz, text[], jsonb, jsonb, bigint, bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_compute_run_lifecycle_impl(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_compute_run_lease_lifecycle_impl(
  uuid, text, uuid, uuid, text, text, jsonb, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revoke_compute_agent_lifecycle_configuration(
  uuid, uuid, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_compute_agent_app_update()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_compute_agent_app_hard_delete()
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.admit_compute_run(
  uuid, text, uuid, uuid, text, text, text, text, text, jsonb, jsonb,
  timestamptz, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.put_compute_agent_policy_settings(
  uuid, uuid, boolean, text[], integer, integer, bigint, integer,
  timestamptz, bigint
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.put_compute_agent_authority_rule(
  uuid, uuid, text, text, text, text, uuid, text, jsonb, bigint
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_compute_agent_policy_state(
  uuid, uuid, text, bigint
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.put_compute_agent_secret_binding(
  uuid, uuid, uuid, text, text, text, text, text, text, timestamptz, bigint
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_compute_agent_secret_binding(
  uuid, uuid, uuid, text, bigint
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.replace_compute_agent_configuration(
  uuid, uuid, boolean, text[], integer, integer, bigint, integer,
  timestamptz, text[], jsonb, jsonb, bigint, bigint
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_compute_run(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_compute_run_lease(
  uuid, text, uuid, uuid, text, text, jsonb, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.authorize_compute_job_token(
  uuid, text, text, text, text, text, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_compute_run(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admit_compute_run(
  uuid, text, uuid, uuid, text, text, text, text, text, jsonb, jsonb,
  timestamptz, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.put_compute_agent_policy_settings(
  uuid, uuid, boolean, text[], integer, integer, bigint, integer,
  timestamptz, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.put_compute_agent_authority_rule(
  uuid, uuid, text, text, text, text, uuid, text, jsonb, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_compute_agent_policy_state(
  uuid, uuid, text, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.put_compute_agent_secret_binding(
  uuid, uuid, uuid, text, text, text, text, text, text, timestamptz, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_compute_agent_secret_binding(
  uuid, uuid, uuid, text, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.replace_compute_agent_configuration(
  uuid, uuid, boolean, text[], integer, integer, bigint, integer,
  timestamptz, text[], jsonb, jsonb, bigint, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_compute_run(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_compute_run_lease(
  uuid, text, uuid, uuid, text, text, jsonb, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.authorize_compute_job_token(
  uuid, text, text, text, text, text, uuid, text, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_compute_run(uuid, uuid)
  TO service_role;
