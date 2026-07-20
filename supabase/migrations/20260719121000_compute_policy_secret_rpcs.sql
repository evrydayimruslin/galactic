-- Owner-validated, CAS-aware policy and Agent Variable binding mutations.
-- All functions are service-role only; no secret value enters or leaves SQL.
-- Lock-order invariant: policy mutations and lifecycle admission/claim/prepare
-- take the same per-owner+Agent advisory transaction lock before row locks.

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
DECLARE
  v_policy public.compute_agent_policies%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_agent_id IS NULL OR p_enabled IS NULL
     OR p_max_timeout_ms IS NULL OR p_max_concurrency IS NULL
     OR p_max_artifact_bytes IS NULL OR p_max_artifacts IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_CONFIGURATION',
      'message', 'Compute settings require exact non-null policy inputs.'
    )::text;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'compute-agent:' || p_user_id::text || ':' || p_agent_id::text, 0
  ));
  PERFORM 1 FROM public.apps AS app
  WHERE app.id = p_agent_id AND app.owner_id = p_user_id
    AND app.deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_AGENT_NOT_OWNED',
      'message', 'Compute settings may be changed only for an owned Agent.'
    )::text;
  END IF;
  IF p_enabled AND EXISTS (
    SELECT 1 FROM public.users AS owner
    WHERE owner.id = p_user_id AND owner.provisional IS DISTINCT FROM false
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ACCOUNT_NOT_ELIGIBLE',
      'message', 'A provisional account must be claimed before enabling Compute.'
    )::text;
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_REVISION',
      'message', 'expectedRevision must be a non-negative integer.'
    )::text;
  END IF;
  IF p_allowed_tools IS NULL OR cardinality(p_allowed_tools) NOT BETWEEN 1 AND 64
     OR EXISTS (
       SELECT 1 FROM unnest(p_allowed_tools) AS tool
       WHERE NOT (tool = ANY (ARRAY[
         'shell', 'browser', 'office', 'media', 'pdf', 'ocr', 'data',
         'databases', 'transfer', 'git', 'coding.claude', 'coding.codex',
         'galactic'
       ]::text[]))
     ) OR cardinality(p_allowed_tools) <> (
       SELECT count(DISTINCT tool) FROM unnest(p_allowed_tools) AS tool
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_TOOLS',
      'message', 'allowedTools must contain 1-64 unique exact tool IDs.'
    )::text;
  END IF;
  IF p_max_timeout_ms NOT BETWEEN 1000 AND 480000
     OR p_max_concurrency NOT BETWEEN 1 AND 32
     OR p_max_artifact_bytes NOT BETWEEN 1 AND 1073741824
     OR p_max_artifacts NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_LIMITS',
      'message', 'One or more Compute limits are outside the v1 bounds.'
    )::text;
  END IF;
  IF p_enabled AND p_owner_confirmed_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_OWNER_CONFIRMATION_REQUIRED',
      'message', 'The owner must confirm settings before enabling Compute.'
    )::text;
  END IF;

  SELECT policy.* INTO v_policy
  FROM public.compute_agent_policies AS policy
  WHERE policy.agent_id = p_agent_id AND policy.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    IF p_expected_revision IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_POLICY_CONFLICT',
        'message', 'The Compute settings revision changed.',
        'actualRevision', 0,
        'expectedRevision', p_expected_revision
      )::text;
    END IF;
    INSERT INTO public.compute_agent_policies (
      agent_id, user_id, enabled, allowed_tools, max_timeout_ms,
      max_concurrency, max_artifact_bytes, max_artifacts, owner_confirmed_at
    ) VALUES (
      p_agent_id, p_user_id, p_enabled, p_allowed_tools, p_max_timeout_ms,
      p_max_concurrency, p_max_artifact_bytes, p_max_artifacts,
      p_owner_confirmed_at
    ) RETURNING * INTO v_policy;
  ELSE
    IF v_policy.revision IS DISTINCT FROM p_expected_revision THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_POLICY_CONFLICT',
        'message', 'The Compute settings revision changed.',
        'actualRevision', v_policy.revision,
        'expectedRevision', p_expected_revision
      )::text;
    END IF;
    IF v_policy.state = 'revoked' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_POLICY_REVOKED',
        'message', 'A revoked Compute policy cannot be re-enabled.'
      )::text;
    END IF;
    IF p_enabled AND v_policy.state <> 'active' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_POLICY_NOT_ACTIVE',
        'message', 'A paused Compute policy must be resumed before enabling it.'
      )::text;
    END IF;
    UPDATE public.compute_agent_policies AS policy
    SET enabled = p_enabled,
        allowed_tools = p_allowed_tools,
        max_timeout_ms = p_max_timeout_ms,
        max_concurrency = p_max_concurrency,
        max_artifact_bytes = p_max_artifact_bytes,
        max_artifacts = p_max_artifacts,
        owner_confirmed_at = p_owner_confirmed_at,
        authority_epoch = policy.authority_epoch + 1,
        revision = policy.revision + 1,
        updated_at = now()
    WHERE policy.agent_id = p_agent_id AND policy.user_id = p_user_id
    RETURNING * INTO v_policy;
  END IF;
  RETURN NEXT v_policy;
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
  v_policy public.compute_agent_policies%ROWTYPE;
  v_rule public.compute_agent_authority_rules%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_agent_id IS NULL OR p_caller_function IS NULL
     OR p_decision IS NULL OR p_action IS NULL OR p_resource_kind IS NULL
     OR p_caller_function !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_CALLER_FUNCTION',
      'message', 'callerFunction must be one exact Agent function name.'
    )::text;
  END IF;
  IF p_decision NOT IN ('always', 'never')
     OR p_constraints IS NULL OR jsonb_typeof(p_constraints) <> 'object'
     OR NOT public.compute_authority_shape_valid(
       p_action, p_resource_kind, p_target_agent_id, p_target_function
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_AUTHORITY',
      'message', 'The v1 authority decision or exact target is invalid.'
    )::text;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'compute-agent:' || p_user_id::text || ':' || p_agent_id::text, 0
  ));

  SELECT policy.* INTO v_policy
  FROM public.compute_agent_policies AS policy
  JOIN public.apps AS app ON app.id = policy.agent_id
  WHERE policy.agent_id = p_agent_id AND policy.user_id = p_user_id
    AND app.owner_id = p_user_id AND app.deleted_at IS NULL
  FOR UPDATE OF policy;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_POLICY_NOT_FOUND',
      'message', 'Configure the owned Agent Compute policy first.'
    )::text;
  END IF;
  IF p_expected_authority_epoch IS NOT NULL
     AND v_policy.authority_epoch IS DISTINCT FROM p_expected_authority_epoch THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_POLICY_CONFLICT',
      'message', 'The Compute authority epoch changed.',
      'actualAuthorityEpoch', v_policy.authority_epoch,
      'expectedAuthorityEpoch', p_expected_authority_epoch
    )::text;
  END IF;
  IF p_target_agent_id IS NOT NULL THEN
    PERFORM 1 FROM public.apps AS target
    WHERE target.id = p_target_agent_id AND target.owner_id = p_user_id
      AND target.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_TARGET_NOT_OWNED',
        'message', 'agents.call may target only an Agent owned by the same user.'
      )::text;
    END IF;
  END IF;

  SELECT rule.* INTO v_rule
  FROM public.compute_agent_authority_rules AS rule
  WHERE rule.user_id = p_user_id AND rule.agent_id = p_agent_id
    AND rule.caller_function = p_caller_function
    AND rule.action = p_action AND rule.resource_kind = p_resource_kind
    AND rule.target_agent_id IS NOT DISTINCT FROM p_target_agent_id
    AND rule.target_function IS NOT DISTINCT FROM p_target_function
  FOR UPDATE;
  IF FOUND THEN
    UPDATE public.compute_agent_authority_rules AS rule
    SET decision = p_decision, constraints = p_constraints, status = 'active',
        rule_version = rule.rule_version + 1, updated_at = now()
    WHERE rule.id = v_rule.id RETURNING * INTO v_rule;
  ELSE
    INSERT INTO public.compute_agent_authority_rules (
      user_id, agent_id, caller_function, action, resource_kind,
      target_agent_id, target_function, decision, constraints
    ) VALUES (
      p_user_id, p_agent_id, p_caller_function, p_action, p_resource_kind,
      p_target_agent_id, p_target_function, p_decision, p_constraints
    ) RETURNING * INTO v_rule;
  END IF;

  UPDATE public.compute_agent_policies AS policy
  SET authority_epoch = policy.authority_epoch + 1,
      revision = policy.revision + 1, updated_at = now()
  WHERE policy.agent_id = p_agent_id AND policy.user_id = p_user_id
  RETURNING * INTO v_policy;

  RETURN QUERY SELECT
    v_rule.id, v_rule.user_id, v_rule.agent_id, v_rule.caller_function,
    v_rule.action, v_rule.resource_kind, v_rule.target_agent_id,
    v_rule.target_function, v_rule.decision, v_rule.constraints,
    v_rule.status, v_rule.rule_version, v_policy.authority_epoch,
    v_rule.expires_at, v_rule.created_at, v_rule.updated_at;
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
DECLARE
  v_policy public.compute_agent_policies%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_agent_id IS NULL OR p_state IS NULL
     OR p_expected_authority_epoch IS NULL
     OR p_state NOT IN ('active', 'paused', 'revoked') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_POLICY_STATE', 'message', 'Invalid policy state.'
    )::text;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'compute-agent:' || p_user_id::text || ':' || p_agent_id::text, 0
  ));
  SELECT policy.* INTO v_policy
  FROM public.compute_agent_policies AS policy
  JOIN public.apps AS app ON app.id = policy.agent_id
  WHERE policy.agent_id = p_agent_id AND policy.user_id = p_user_id
    AND app.owner_id = p_user_id AND app.deleted_at IS NULL
  FOR UPDATE OF policy;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_POLICY_NOT_FOUND', 'message', 'Compute policy not found.'
    )::text;
  END IF;
  IF v_policy.state = 'revoked' AND p_state <> 'revoked' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_POLICY_REVOKED',
      'message', 'A revoked Compute policy cannot transition to another state.'
    )::text;
  END IF;
  IF v_policy.authority_epoch IS DISTINCT FROM p_expected_authority_epoch THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_POLICY_CONFLICT',
      'message', 'The Compute authority epoch changed.',
      'actualAuthorityEpoch', v_policy.authority_epoch
    )::text;
  END IF;
  UPDATE public.compute_agent_policies AS policy
  SET state = p_state,
      enabled = CASE WHEN p_state = 'active' THEN policy.enabled ELSE false END,
      authority_epoch = policy.authority_epoch + 1,
      revision = policy.revision + 1,
      updated_at = now()
  WHERE policy.agent_id = p_agent_id AND policy.user_id = p_user_id
  RETURNING * INTO v_policy;
  RETURN QUERY SELECT v_policy.state, v_policy.authority_epoch;
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
DECLARE
  v_policy public.compute_agent_policies%ROWTYPE;
  v_binding public.compute_agent_secret_bindings%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_agent_id IS NULL OR p_caller_function IS NULL
     OR p_name IS NULL OR p_variable_name IS NULL OR p_delivery IS NULL
     OR p_caller_function !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'
     OR length(btrim(p_name)) NOT BETWEEN 1 AND 128
     OR p_variable_name !~ '^[A-Z][A-Z0-9_]{0,63}$'
     OR public.compute_secret_env_name_reserved(p_variable_name) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_SECRET_BINDING',
      'message', 'The Agent Variable binding metadata is invalid.'
    )::text;
  END IF;
  IF NOT (
    (p_delivery = 'raw_env'
      AND p_env_name ~ '^[A-Z][A-Z0-9_]{0,63}$'
      AND NOT public.compute_secret_env_name_reserved(p_env_name)
      AND p_file_name IS NULL)
    OR (p_delivery = 'raw_file' AND p_env_name IS NULL
      AND p_file_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      AND p_file_name NOT IN ('.', '..')
      AND lower(p_file_name) NOT LIKE '%job-token%')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_SECRET_DELIVERY',
      'message', 'v1 secrets may be delivered only as safe env/file bindings.'
    )::text;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'compute-agent:' || p_user_id::text || ':' || p_agent_id::text, 0
  ));

  SELECT policy.* INTO v_policy
  FROM public.compute_agent_policies AS policy
  JOIN public.apps AS app ON app.id = policy.agent_id
  WHERE policy.agent_id = p_agent_id AND policy.user_id = p_user_id
    AND app.owner_id = p_user_id AND app.deleted_at IS NULL
    AND jsonb_typeof(COALESCE(app.env_vars, '{}'::jsonb)) = 'object'
    AND COALESCE(app.env_vars, '{}'::jsonb) ? p_variable_name
  FOR UPDATE OF policy;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_AGENT_VARIABLE_NOT_FOUND',
      'message', 'The exact Agent Variable is absent or the policy is not owned.'
    )::text;
  END IF;
  IF p_expected_authority_epoch IS NOT NULL
     AND v_policy.authority_epoch IS DISTINCT FROM p_expected_authority_epoch THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_POLICY_CONFLICT',
      'message', 'The Compute authority epoch changed.'
    )::text;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.compute_agent_secret_bindings AS binding
    WHERE binding.user_id = p_user_id AND binding.agent_id = p_agent_id
      AND binding.caller_function = p_caller_function
      AND binding.status = 'active'
      AND binding.variable_name = p_variable_name
      AND binding.name <> btrim(p_name)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_DUPLICATE_SECRET_VARIABLE',
      'message', 'One Agent Variable may back only one active binding per caller.'
    )::text;
  END IF;

  SELECT binding.* INTO v_binding
  FROM public.compute_agent_secret_bindings AS binding
  WHERE binding.user_id = p_user_id AND binding.agent_id = p_agent_id
    AND binding.caller_function = p_caller_function AND binding.name = btrim(p_name)
  FOR UPDATE;
  IF FOUND THEN
    IF p_binding_id IS NOT NULL AND p_binding_id IS DISTINCT FROM v_binding.id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_SECRET_BINDING_CONFLICT',
        'message', 'bindingId does not match the exact named binding.'
      )::text;
    END IF;
    UPDATE public.compute_agent_secret_bindings AS binding
    SET variable_name = p_variable_name, delivery = p_delivery,
        env_name = p_env_name, file_name = p_file_name,
        expires_at = p_expires_at, status = 'active',
        binding_version = binding.binding_version + 1, updated_at = now()
    WHERE binding.id = v_binding.id RETURNING * INTO v_binding;
  ELSE
    INSERT INTO public.compute_agent_secret_bindings (
      id, user_id, agent_id, caller_function, name, variable_name,
      delivery, env_name, file_name, expires_at
    ) VALUES (
      COALESCE(p_binding_id, gen_random_uuid()), p_user_id, p_agent_id,
      p_caller_function, btrim(p_name), p_variable_name, p_delivery,
      p_env_name, p_file_name, p_expires_at
    ) RETURNING * INTO v_binding;
  END IF;

  UPDATE public.compute_agent_policies AS policy
  SET authority_epoch = policy.authority_epoch + 1,
      revision = policy.revision + 1, updated_at = now()
  WHERE policy.agent_id = p_agent_id AND policy.user_id = p_user_id;
  RETURN NEXT v_binding;
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
DECLARE
  v_binding public.compute_agent_secret_bindings%ROWTYPE;
BEGIN
  IF p_binding_id IS NULL OR p_user_id IS NULL OR p_agent_id IS NULL
     OR p_caller_function IS NULL OR p_expected_binding_version IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_SECRET_BINDING_CONFLICT',
      'message', 'Secret revocation requires an exact non-null binding version.'
    )::text;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'compute-agent:' || p_user_id::text || ':' || p_agent_id::text, 0
  ));
  SELECT binding.* INTO v_binding
  FROM public.compute_agent_secret_bindings AS binding
  JOIN public.apps AS app ON app.id = binding.agent_id
  WHERE binding.id = p_binding_id AND binding.user_id = p_user_id
    AND binding.agent_id = p_agent_id
    AND binding.caller_function = p_caller_function
    AND app.owner_id = p_user_id AND app.deleted_at IS NULL
  FOR UPDATE OF binding;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_SECRET_BINDING_NOT_FOUND',
      'message', 'The exact Compute secret binding was not found.'
    )::text;
  END IF;
  IF v_binding.binding_version IS DISTINCT FROM p_expected_binding_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_SECRET_BINDING_CONFLICT',
      'message', 'The Compute secret binding changed.'
    )::text;
  END IF;
  UPDATE public.compute_agent_secret_bindings AS binding
  SET status = 'revoked', binding_version = binding.binding_version + 1,
      updated_at = now()
  WHERE binding.id = p_binding_id RETURNING * INTO v_binding;
  UPDATE public.compute_agent_policies AS policy
  SET authority_epoch = policy.authority_epoch + 1,
      revision = policy.revision + 1, updated_at = now()
  WHERE policy.agent_id = p_agent_id AND policy.user_id = p_user_id;
  RETURN NEXT v_binding;
END;
$$;

-- Replace-semantics owner PUT. Limits, exact grants, and Agent-wide secret
-- selections share one CAS and one authority-epoch increment. Omitted grants
-- and bindings are revoked in the same transaction, so stale authority cannot
-- survive a Launch settings replacement.
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
  v_policy public.compute_agent_policies%ROWTYPE;
  v_rule public.compute_agent_authority_rules%ROWTYPE;
  v_binding public.compute_agent_secret_bindings%ROWTYPE;
  v_rule_input jsonb;
  v_secret_input jsonb;
  v_caller text;
  v_target_agent_id uuid;
  v_target_function text;
  v_rule_key text;
  v_rule_keys text[] := ARRAY[]::text[];
  v_secret_names text[] := ARRAY[]::text[];
  v_secret_variables text[] := ARRAY[]::text[];
  v_secret_destinations text[] := ARRAY[]::text[];
  v_secret_destination text;
  v_rules_json jsonb;
  v_bindings_json jsonb;
BEGIN
  IF p_user_id IS NULL OR p_agent_id IS NULL OR p_enabled IS NULL
     OR p_max_timeout_ms IS NULL OR p_max_concurrency IS NULL
     OR p_max_artifact_bytes IS NULL OR p_max_artifacts IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_CONFIGURATION',
      'message', 'Compute replacement requires exact non-null policy inputs.'
    )::text;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'compute-agent:' || p_user_id::text || ':' || p_agent_id::text, 0
  ));
  PERFORM 1
  FROM public.apps AS app
  WHERE app.id = p_agent_id AND app.owner_id = p_user_id
    AND app.deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_AGENT_NOT_OWNED',
      'message', 'Compute settings may be changed only for an owned Agent.'
    )::text;
  END IF;
  IF p_enabled AND EXISTS (
    SELECT 1 FROM public.users AS owner
    WHERE owner.id = p_user_id AND owner.provisional IS DISTINCT FROM false
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_ACCOUNT_NOT_ELIGIBLE',
      'message', 'A provisional account must be claimed before enabling Compute.'
    )::text;
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_expected_authority_epoch IS NULL OR p_expected_authority_epoch < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_REVISION',
      'message', 'Expected revision and authority epoch must be non-negative.'
    )::text;
  END IF;
  IF p_allowed_tools IS NULL OR cardinality(p_allowed_tools) NOT BETWEEN 1 AND 64
     OR EXISTS (
       SELECT 1 FROM unnest(p_allowed_tools) AS tool
       WHERE NOT (tool = ANY (ARRAY[
         'shell', 'browser', 'office', 'media', 'pdf', 'ocr', 'data',
         'databases', 'transfer', 'git', 'coding.claude', 'coding.codex',
         'galactic'
       ]::text[]))
     ) OR cardinality(p_allowed_tools) <>
       (SELECT count(DISTINCT tool) FROM unnest(p_allowed_tools) AS tool)
     OR p_max_timeout_ms NOT BETWEEN 1000 AND 480000
     OR p_max_concurrency NOT BETWEEN 1 AND 32
     OR p_max_artifact_bytes NOT BETWEEN 1 AND 1073741824
     OR p_max_artifacts NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_CONFIGURATION',
      'message', 'Compute tools or limits are outside the developer-v1 bounds.'
    )::text;
  END IF;
  IF p_enabled AND p_owner_confirmed_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_OWNER_CONFIRMATION_REQUIRED',
      'message', 'The owner must confirm settings before enabling Compute.'
    )::text;
  END IF;
  IF p_caller_functions IS NULL OR cardinality(p_caller_functions) > 128
     OR EXISTS (
       SELECT 1 FROM unnest(p_caller_functions) AS caller
       WHERE caller !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'
     ) OR cardinality(p_caller_functions) <>
       (SELECT count(DISTINCT caller) FROM unnest(p_caller_functions) AS caller)
     OR (p_enabled AND cardinality(p_caller_functions) = 0) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_CALLER_FUNCTIONS',
      'message', 'callerFunctions must be unique exact live Compute callers.'
    )::text;
  END IF;
  IF p_authority_rules IS NULL OR jsonb_typeof(p_authority_rules) <> 'array'
     OR jsonb_array_length(p_authority_rules) > 256
     OR p_secret_bindings IS NULL OR jsonb_typeof(p_secret_bindings) <> 'array'
     OR jsonb_array_length(p_secret_bindings) > 50
     OR (cardinality(p_caller_functions) = 0 AND jsonb_array_length(p_secret_bindings) > 0) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'COMPUTE_INVALID_CONFIGURATION',
      'message', 'Authority rules or secret bindings exceed the replacement bounds.'
    )::text;
  END IF;

  FOR v_rule_input IN SELECT value FROM jsonb_array_elements(p_authority_rules) LOOP
    IF jsonb_typeof(v_rule_input) <> 'object'
       OR NOT v_rule_input ?& ARRAY[
         'caller_function', 'decision', 'action', 'resource_kind',
         'target_agent_id', 'target_function', 'constraints'
       ] OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(v_rule_input) AS key
         WHERE key <> ALL (ARRAY[
           'caller_function', 'decision', 'action', 'resource_kind',
           'target_agent_id', 'target_function', 'constraints'
         ])
       ) OR NOT ((v_rule_input->>'caller_function') = ANY(p_caller_functions))
       OR (v_rule_input->>'decision') NOT IN ('always', 'never')
       OR jsonb_typeof(v_rule_input->'constraints') <> 'object'
       OR (
         jsonb_typeof(v_rule_input->'target_agent_id') NOT IN ('null', 'string')
       ) OR (
         jsonb_typeof(v_rule_input->'target_agent_id') = 'string'
         AND (v_rule_input->>'target_agent_id') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       ) OR jsonb_typeof(v_rule_input->'target_function') NOT IN ('null', 'string') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_INVALID_AUTHORITY',
        'message', 'Every replacement authority must be one exact v1 target.'
      )::text;
    END IF;
    v_target_agent_id := NULLIF(v_rule_input->>'target_agent_id', '')::uuid;
    v_target_function := NULLIF(v_rule_input->>'target_function', '');
    IF NOT public.compute_authority_shape_valid(
      v_rule_input->>'action', v_rule_input->>'resource_kind',
      v_target_agent_id, v_target_function
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_INVALID_AUTHORITY',
        'message', 'Every replacement authority must be one exact v1 target.'
      )::text;
    END IF;
    IF v_target_agent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.apps AS target
      WHERE target.id = v_target_agent_id AND target.owner_id = p_user_id
        AND target.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_TARGET_NOT_OWNED',
        'message', 'agents.call may target only an Agent owned by the same user.'
      )::text;
    END IF;
    v_rule_key := concat_ws('|', v_rule_input->>'caller_function',
      v_rule_input->>'action', v_rule_input->>'resource_kind',
      COALESCE(v_target_agent_id::text, ''), COALESCE(v_target_function, ''));
    IF v_rule_key = ANY(v_rule_keys) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_DUPLICATE_AUTHORITY',
        'message', 'Replacement authority targets must be unique.'
      )::text;
    END IF;
    v_rule_keys := array_append(v_rule_keys, v_rule_key);
  END LOOP;

  FOR v_secret_input IN SELECT value FROM jsonb_array_elements(p_secret_bindings) LOOP
    IF jsonb_typeof(v_secret_input) <> 'object'
       OR NOT v_secret_input ?& ARRAY[
         'name', 'variable_name', 'delivery', 'env_name', 'file_name', 'expires_at'
       ] OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(v_secret_input) AS key
         WHERE key <> ALL (ARRAY[
           'name', 'variable_name', 'delivery', 'env_name', 'file_name', 'expires_at'
         ])
       ) OR length(btrim(v_secret_input->>'name')) NOT BETWEEN 1 AND 128
       OR (v_secret_input->>'name') ~ '[[:cntrl:]]'
       OR (v_secret_input->>'variable_name') !~ '^[A-Z][A-Z0-9_]{0,63}$'
       OR public.compute_secret_env_name_reserved(v_secret_input->>'variable_name')
       OR NOT (
         ((v_secret_input->>'delivery') = 'raw_env'
           AND (v_secret_input->>'env_name') ~ '^[A-Z][A-Z0-9_]{0,63}$'
           AND NOT public.compute_secret_env_name_reserved(v_secret_input->>'env_name')
           AND jsonb_typeof(v_secret_input->'file_name') = 'null')
         OR ((v_secret_input->>'delivery') = 'raw_file'
           AND jsonb_typeof(v_secret_input->'env_name') = 'null'
           AND (v_secret_input->>'file_name') ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
           AND (v_secret_input->>'file_name') NOT IN ('.', '..')
           AND lower(v_secret_input->>'file_name') NOT LIKE '%job-token%')
       ) OR (
         jsonb_typeof(v_secret_input->'expires_at') NOT IN ('null', 'string')
       ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_INVALID_SECRET_BINDING',
        'message', 'Replacement secret metadata is invalid.'
      )::text;
    END IF;
    IF jsonb_typeof(v_secret_input->'expires_at') = 'string' THEN
      PERFORM (v_secret_input->>'expires_at')::timestamptz;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.apps AS app
      WHERE app.id = p_agent_id AND app.owner_id = p_user_id
        AND jsonb_typeof(COALESCE(app.env_vars, '{}'::jsonb)) = 'object'
        AND COALESCE(app.env_vars, '{}'::jsonb) ? (v_secret_input->>'variable_name')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_AGENT_VARIABLE_NOT_FOUND',
        'message', 'A selected exact Agent Variable is absent.'
      )::text;
    END IF;
    IF (v_secret_input->>'name') = ANY(v_secret_names) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_DUPLICATE_SECRET_BINDING',
        'message', 'Agent-wide secret binding names must be unique.'
      )::text;
    END IF;
    v_secret_names := array_append(v_secret_names, v_secret_input->>'name');
    IF (v_secret_input->>'variable_name') = ANY(v_secret_variables) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_DUPLICATE_SECRET_VARIABLE',
        'message', 'Agent-wide secret bindings must select unique Agent Variables.'
      )::text;
    END IF;
    v_secret_variables := array_append(
      v_secret_variables, v_secret_input->>'variable_name'
    );
    v_secret_destination := CASE v_secret_input->>'delivery'
      WHEN 'raw_env' THEN 'env:' || (v_secret_input->>'env_name')
      ELSE 'file:' || (v_secret_input->>'file_name')
    END;
    IF v_secret_destination = ANY(v_secret_destinations) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_DUPLICATE_SECRET_DESTINATION',
        'message', 'Agent-wide secret destinations must be unique.'
      )::text;
    END IF;
    v_secret_destinations := array_append(v_secret_destinations, v_secret_destination);
  END LOOP;

  SELECT policy.* INTO v_policy
  FROM public.compute_agent_policies AS policy
  WHERE policy.agent_id = p_agent_id AND policy.user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_revision IS DISTINCT FROM 0
       OR p_expected_authority_epoch IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_POLICY_CONFLICT',
        'message', 'The Compute configuration changed.',
        'actualRevision', 0, 'actualAuthorityEpoch', 0
      )::text;
    END IF;
    INSERT INTO public.compute_agent_policies (
      agent_id, user_id, enabled, allowed_tools, max_timeout_ms,
      max_concurrency, max_artifact_bytes, max_artifacts, owner_confirmed_at
    ) VALUES (
      p_agent_id, p_user_id, p_enabled, p_allowed_tools, p_max_timeout_ms,
      p_max_concurrency, p_max_artifact_bytes, p_max_artifacts,
      p_owner_confirmed_at
    ) RETURNING * INTO v_policy;
  ELSE
    IF v_policy.revision IS DISTINCT FROM p_expected_revision
       OR v_policy.authority_epoch IS DISTINCT FROM p_expected_authority_epoch THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_POLICY_CONFLICT',
        'message', 'The Compute configuration changed.',
        'actualRevision', v_policy.revision,
        'actualAuthorityEpoch', v_policy.authority_epoch
      )::text;
    END IF;
    IF v_policy.state = 'revoked' OR (p_enabled AND v_policy.state <> 'active') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'COMPUTE_POLICY_NOT_ACTIVE',
        'message', 'A paused or revoked policy cannot be enabled by replacement.'
      )::text;
    END IF;
  END IF;

  UPDATE public.compute_agent_authority_rules AS existing
  SET status = 'revoked', rule_version = existing.rule_version + 1,
      updated_at = now()
  WHERE existing.user_id = p_user_id AND existing.agent_id = p_agent_id
    AND existing.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_authority_rules) AS requested
      WHERE requested->>'caller_function' = existing.caller_function
        AND requested->>'action' = existing.action
        AND requested->>'resource_kind' = existing.resource_kind
        AND NULLIF(requested->>'target_agent_id', '')::uuid
          IS NOT DISTINCT FROM existing.target_agent_id
        AND NULLIF(requested->>'target_function', '')
          IS NOT DISTINCT FROM existing.target_function
    );
  FOR v_rule_input IN SELECT value FROM jsonb_array_elements(p_authority_rules) LOOP
    v_target_agent_id := NULLIF(v_rule_input->>'target_agent_id', '')::uuid;
    v_target_function := NULLIF(v_rule_input->>'target_function', '');
    SELECT rule.* INTO v_rule
    FROM public.compute_agent_authority_rules AS rule
    WHERE rule.user_id = p_user_id AND rule.agent_id = p_agent_id
      AND rule.caller_function = v_rule_input->>'caller_function'
      AND rule.action = v_rule_input->>'action'
      AND rule.resource_kind = v_rule_input->>'resource_kind'
      AND rule.target_agent_id IS NOT DISTINCT FROM v_target_agent_id
      AND rule.target_function IS NOT DISTINCT FROM v_target_function
    FOR UPDATE;
    IF FOUND THEN
      UPDATE public.compute_agent_authority_rules AS rule
      SET decision = v_rule_input->>'decision',
          constraints = v_rule_input->'constraints', status = 'active',
          expires_at = NULL, rule_version = rule.rule_version + 1,
          updated_at = now()
      WHERE rule.id = v_rule.id;
    ELSE
      INSERT INTO public.compute_agent_authority_rules (
        user_id, agent_id, caller_function, action, resource_kind,
        target_agent_id, target_function, decision, constraints
      ) VALUES (
        p_user_id, p_agent_id, v_rule_input->>'caller_function',
        v_rule_input->>'action', v_rule_input->>'resource_kind',
        v_target_agent_id, v_target_function, v_rule_input->>'decision',
        v_rule_input->'constraints'
      );
    END IF;
  END LOOP;

  UPDATE public.compute_agent_secret_bindings AS existing
  SET status = 'revoked', binding_version = existing.binding_version + 1,
      updated_at = now()
  WHERE existing.user_id = p_user_id AND existing.agent_id = p_agent_id
    AND existing.status = 'active'
    AND (
      NOT (existing.caller_function = ANY(p_caller_functions))
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_secret_bindings) AS requested
        WHERE requested->>'name' = existing.name
      )
    );
  FOREACH v_caller IN ARRAY p_caller_functions LOOP
    FOR v_secret_input IN SELECT value FROM jsonb_array_elements(p_secret_bindings) LOOP
      SELECT binding.* INTO v_binding
      FROM public.compute_agent_secret_bindings AS binding
      WHERE binding.user_id = p_user_id AND binding.agent_id = p_agent_id
        AND binding.caller_function = v_caller
        AND binding.name = v_secret_input->>'name'
      FOR UPDATE;
      IF FOUND THEN
        UPDATE public.compute_agent_secret_bindings AS binding
        SET variable_name = v_secret_input->>'variable_name',
            delivery = v_secret_input->>'delivery',
            env_name = NULLIF(v_secret_input->>'env_name', ''),
            file_name = NULLIF(v_secret_input->>'file_name', ''),
            expires_at = CASE WHEN jsonb_typeof(v_secret_input->'expires_at') = 'null'
              THEN NULL ELSE (v_secret_input->>'expires_at')::timestamptz END,
            status = 'active', binding_version = binding.binding_version + 1,
            updated_at = now()
        WHERE binding.id = v_binding.id;
      ELSE
        INSERT INTO public.compute_agent_secret_bindings (
          user_id, agent_id, caller_function, name, variable_name, delivery,
          env_name, file_name, expires_at
        ) VALUES (
          p_user_id, p_agent_id, v_caller, v_secret_input->>'name',
          v_secret_input->>'variable_name', v_secret_input->>'delivery',
          NULLIF(v_secret_input->>'env_name', ''),
          NULLIF(v_secret_input->>'file_name', ''),
          CASE WHEN jsonb_typeof(v_secret_input->'expires_at') = 'null'
            THEN NULL ELSE (v_secret_input->>'expires_at')::timestamptz END
        );
      END IF;
    END LOOP;
  END LOOP;

  IF v_policy.revision = p_expected_revision AND p_expected_revision > 0 THEN
    UPDATE public.compute_agent_policies AS policy
    SET enabled = p_enabled, allowed_tools = p_allowed_tools,
        max_timeout_ms = p_max_timeout_ms, max_concurrency = p_max_concurrency,
        max_artifact_bytes = p_max_artifact_bytes, max_artifacts = p_max_artifacts,
        owner_confirmed_at = p_owner_confirmed_at,
        authority_epoch = policy.authority_epoch + 1,
        revision = policy.revision + 1, updated_at = now()
    WHERE policy.agent_id = p_agent_id AND policy.user_id = p_user_id
    RETURNING * INTO v_policy;
  END IF;

  SELECT COALESCE(jsonb_agg(
    to_jsonb(rule) || jsonb_build_object('authority_epoch', v_policy.authority_epoch)
    ORDER BY rule.caller_function, rule.action, rule.target_function
  ), '[]'::jsonb) INTO v_rules_json
  FROM public.compute_agent_authority_rules AS rule
  WHERE rule.user_id = p_user_id AND rule.agent_id = p_agent_id
    AND rule.status = 'active';
  SELECT COALESCE(jsonb_agg(to_jsonb(binding)
    ORDER BY binding.caller_function, binding.name), '[]'::jsonb)
  INTO v_bindings_json
  FROM public.compute_agent_secret_bindings AS binding
  WHERE binding.user_id = p_user_id AND binding.agent_id = p_agent_id
    AND binding.status = 'active';
  RETURN jsonb_build_object(
    'policy', to_jsonb(v_policy),
    'authority_rules', v_rules_json,
    'secret_bindings', v_bindings_json
  );
END;
$$;

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
