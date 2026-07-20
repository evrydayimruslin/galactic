-- Galactic Compute v1 durable control-plane schema.
--
-- The browser roles have no access to these tables. Job tokens are opaque and
-- only their HMAC digests are stored. Secret bindings contain metadata that
-- names an existing Agent Variable; this schema has no secret value column.

CREATE TABLE public.compute_agent_policies (
  agent_id uuid PRIMARY KEY REFERENCES public.apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  profile text NOT NULL DEFAULT 'developer-v1',
  state text NOT NULL DEFAULT 'active',
  allowed_tools text[] NOT NULL DEFAULT ARRAY[
    'shell', 'browser', 'office', 'media', 'pdf', 'ocr', 'data',
    'databases', 'transfer', 'git', 'coding.claude', 'coding.codex',
    'galactic'
  ]::text[],
  max_timeout_ms integer NOT NULL DEFAULT 300000,
  max_concurrency integer NOT NULL DEFAULT 1,
  max_artifact_bytes bigint NOT NULL DEFAULT 104857600,
  max_artifacts integer NOT NULL DEFAULT 64,
  authority_epoch bigint NOT NULL DEFAULT 1,
  revision bigint NOT NULL DEFAULT 1,
  owner_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compute_agent_policies_profile_check
    CHECK (profile = 'developer-v1'),
  CONSTRAINT compute_agent_policies_state_check
    CHECK (state IN ('active', 'paused', 'revoked')),
  CONSTRAINT compute_agent_policies_tool_check CHECK (
    cardinality(allowed_tools) BETWEEN 1 AND 64
    AND allowed_tools <@ ARRAY[
      'shell', 'browser', 'office', 'media', 'pdf', 'ocr', 'data',
      'databases', 'transfer', 'git', 'coding.claude', 'coding.codex',
      'galactic'
    ]::text[]
  ),
  CONSTRAINT compute_agent_policies_limits_check CHECK (
    max_timeout_ms BETWEEN 1000 AND 480000
    AND max_concurrency BETWEEN 1 AND 32
    AND max_artifact_bytes BETWEEN 1 AND 1073741824
    AND max_artifacts BETWEEN 1 AND 1000
  ),
  CONSTRAINT compute_agent_policies_epoch_check
    CHECK (authority_epoch >= 1 AND revision >= 1),
  CONSTRAINT compute_agent_policies_confirmation_check
    CHECK (NOT enabled OR (state = 'active' AND owner_confirmed_at IS NOT NULL)),
  CONSTRAINT compute_agent_policies_user_agent_unique UNIQUE (user_id, agent_id)
);

CREATE OR REPLACE FUNCTION public.compute_secret_env_name_reserved(p_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT p_name ~ '^(GX_|GALACTIC_|ULTRALIGHT_)'
    OR p_name = ANY (ARRAY[
      'PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS', 'PYTHONPATH', 'LD_PRELOAD',
      'LD_LIBRARY_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE',
      'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY',
      'CF_API_TOKEN', 'CLOUDFLARE_API_TOKEN'
    ]::text[]);
$$;

CREATE TABLE public.compute_agent_secret_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  caller_function text NOT NULL,
  name text NOT NULL,
  variable_name text NOT NULL,
  delivery text NOT NULL,
  env_name text,
  file_name text,
  status text NOT NULL DEFAULT 'active',
  binding_version bigint NOT NULL DEFAULT 1,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compute_secret_binding_caller_check
    CHECK (caller_function ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  CONSTRAINT compute_secret_binding_name_check CHECK (
    length(btrim(name)) BETWEEN 1 AND 128 AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT compute_secret_binding_variable_check CHECK (
    variable_name ~ '^[A-Z][A-Z0-9_]{0,63}$'
    AND NOT public.compute_secret_env_name_reserved(variable_name)
  ),
  CONSTRAINT compute_secret_binding_delivery_check CHECK (
    (
      delivery = 'raw_env'
      AND env_name ~ '^[A-Z][A-Z0-9_]{0,63}$'
      AND NOT public.compute_secret_env_name_reserved(env_name)
      AND file_name IS NULL
    )
    OR (
      delivery = 'raw_file'
      AND env_name IS NULL
      AND file_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
      AND file_name NOT IN ('.', '..')
      AND lower(file_name) NOT LIKE '%job-token%'
    )
  ),
  CONSTRAINT compute_secret_binding_status_check
    CHECK (status IN ('active', 'revoked')),
  CONSTRAINT compute_secret_binding_version_check CHECK (binding_version >= 1),
  CONSTRAINT compute_secret_binding_exact_unique
    UNIQUE (user_id, agent_id, caller_function, name)
);

CREATE INDEX compute_secret_bindings_runtime_idx
  ON public.compute_agent_secret_bindings
  (user_id, agent_id, caller_function, status, expires_at);

-- Exact v1 authority grammar. There are no credential/inference proxy actions,
-- wildcards, create/deploy/spawn primitives, or broad Agent resources.
CREATE OR REPLACE FUNCTION public.compute_authority_shape_valid(
  p_action text,
  p_resource_kind text,
  p_target_agent_id uuid,
  p_target_function text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_action = 'artifacts.read' THEN
      p_resource_kind = 'run_input'
      AND p_target_agent_id IS NULL AND p_target_function IS NULL
    WHEN p_action = 'artifacts.write' THEN
      p_resource_kind = 'run_output'
      AND p_target_agent_id IS NULL AND p_target_function IS NULL
    WHEN p_action IN ('budget.read', 'receipts.read') THEN
      p_resource_kind = 'run'
      AND p_target_agent_id IS NULL AND p_target_function IS NULL
    WHEN p_action = 'platform.call' THEN
      p_resource_kind = 'platform_function'
      AND p_target_agent_id IS NULL
      AND p_target_function ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'
      AND p_target_function !~ '\*'
    WHEN p_action = 'agents.call' THEN
      p_resource_kind = 'agent_function'
      AND p_target_agent_id IS NOT NULL
      AND p_target_function ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'
      AND p_target_function !~ '\*'
    ELSE false
  END;
$$;

CREATE TABLE public.compute_agent_authority_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  caller_function text NOT NULL,
  action text NOT NULL,
  resource_kind text NOT NULL,
  target_agent_id uuid REFERENCES public.apps(id) ON DELETE CASCADE,
  target_function text,
  decision text NOT NULL DEFAULT 'never',
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  rule_version bigint NOT NULL DEFAULT 1,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compute_authority_rule_caller_check
    CHECK (caller_function ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  CONSTRAINT compute_authority_rule_shape_check CHECK (
    public.compute_authority_shape_valid(
      action, resource_kind, target_agent_id, target_function
    )
  ),
  CONSTRAINT compute_authority_rule_decision_check
    CHECK (decision IN ('always', 'never')),
  CONSTRAINT compute_authority_rule_constraints_check
    CHECK (jsonb_typeof(constraints) = 'object'),
  CONSTRAINT compute_authority_rule_status_check
    CHECK (status IN ('active', 'revoked')),
  CONSTRAINT compute_authority_rule_version_check CHECK (rule_version >= 1)
);

CREATE UNIQUE INDEX compute_authority_rule_exact_unique
  ON public.compute_agent_authority_rules (
    user_id, agent_id, caller_function, action, resource_kind,
    COALESCE(target_agent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(target_function, '')
  );

CREATE INDEX compute_authority_rule_admission_idx
  ON public.compute_agent_authority_rules
  (user_id, agent_id, caller_function, status, decision, action);

CREATE OR REPLACE FUNCTION public.compute_execution_request_valid(
  p_request jsonb
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
  v_tool jsonb;
  v_stdin jsonb;
  v_timeout_text text;
  v_input jsonb;
BEGIN
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object' THEN
    RETURN false;
  END IF;
  IF NOT p_request ?& ARRAY[
    'argv', 'tools', 'secretBindingIds', 'cwd', 'stdin', 'capturePaths',
    'inputArtifacts', 'timeoutMs'
  ] OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_request) AS key
    WHERE key <> ALL (ARRAY[
      'argv', 'tools', 'secretBindingIds', 'cwd', 'stdin', 'capturePaths',
      'inputArtifacts', 'timeoutMs'
    ])
  ) THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_request->'argv') <> 'array'
     OR jsonb_array_length(p_request->'argv') NOT BETWEEN 1 AND 128
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_request->'argv') AS arg
       WHERE jsonb_typeof(arg) <> 'string'
          OR length(arg #>> '{}') NOT BETWEEN 1 AND 4096
     ) THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_request->'tools') <> 'array'
     OR jsonb_array_length(p_request->'tools') > 64
     OR (
       SELECT count(*) FROM jsonb_array_elements(p_request->'tools') AS tool
     ) <> (
       SELECT count(DISTINCT tool->>'id')
       FROM jsonb_array_elements(p_request->'tools') AS tool
     ) THEN
    RETURN false;
  END IF;
  FOR v_tool IN SELECT value FROM jsonb_array_elements(p_request->'tools') LOOP
    IF jsonb_typeof(v_tool) <> 'object'
       OR (v_tool->>'id') !~ '^[a-z][a-z0-9._-]{0,127}$'
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(v_tool) AS key
         WHERE key <> 'id'
       ) THEN
      RETURN false;
    END IF;
    IF NOT (v_tool->>'id' = ANY (ARRAY[
      'shell', 'browser', 'office', 'media', 'pdf', 'ocr', 'data',
      'databases', 'transfer', 'git', 'coding.claude', 'coding.codex',
      'galactic'
    ])) THEN
      RETURN false;
    END IF;
  END LOOP;

  IF jsonb_typeof(p_request->'secretBindingIds') <> 'array'
     OR jsonb_array_length(p_request->'secretBindingIds') > 50
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_request->'secretBindingIds') AS item
       WHERE jsonb_typeof(item) <> 'string'
          OR (item #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     ) OR (
       SELECT count(*) FROM jsonb_array_elements(p_request->'secretBindingIds')
     ) <> (
       SELECT count(DISTINCT item #>> '{}')
       FROM jsonb_array_elements(p_request->'secretBindingIds') AS item
     ) THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_request->'inputArtifacts') <> 'array'
     OR jsonb_array_length(p_request->'inputArtifacts') > 100
     OR (
       SELECT count(*) FROM jsonb_array_elements(p_request->'inputArtifacts')
     ) <> (
       SELECT count(DISTINCT item->>'artifactId')
       FROM jsonb_array_elements(p_request->'inputArtifacts') AS item
     ) OR (
       SELECT count(*) FROM jsonb_array_elements(p_request->'inputArtifacts')
     ) <> (
       SELECT count(DISTINCT item->>'mountPath')
       FROM jsonb_array_elements(p_request->'inputArtifacts') AS item
     ) THEN
    RETURN false;
  END IF;
  FOR v_input IN SELECT value FROM jsonb_array_elements(p_request->'inputArtifacts') LOOP
    IF jsonb_typeof(v_input) <> 'object'
       OR NOT v_input ?& ARRAY['artifactId', 'mountPath']
       OR (SELECT count(*) FROM jsonb_object_keys(v_input)) <> 2
       OR (v_input->>'artifactId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR length(v_input->>'mountPath') NOT BETWEEN 1 AND 1024
       OR (v_input->>'mountPath') ~ '(^/|\\|[[:cntrl:]])'
       OR (v_input->>'mountPath') ~ '(^|/)(\.|\.\.)(/|$)'
       OR (v_input->>'mountPath') ~ '//' THEN RETURN false; END IF;
  END LOOP;

  IF jsonb_typeof(p_request->'capturePaths') <> 'array'
     OR jsonb_array_length(p_request->'capturePaths') > 100
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_request->'capturePaths') AS item
       WHERE jsonb_typeof(item) <> 'string'
          OR length(item #>> '{}') NOT BETWEEN 1 AND 1024
          OR (item #>> '{}') ~ '(^/|\\|[[:cntrl:]])'
          OR (item #>> '{}') ~ '(^|/)(\.|\.\.)(/|$)'
          OR (item #>> '{}') ~ '//'
     ) OR (
       SELECT count(*) FROM jsonb_array_elements(p_request->'capturePaths')
     ) <> (
       SELECT count(DISTINCT item #>> '{}')
       FROM jsonb_array_elements(p_request->'capturePaths') AS item
     ) THEN RETURN false; END IF;

  IF jsonb_typeof(p_request->'cwd') <> 'string'
     OR NOT (
       p_request->>'cwd' = '.'
       OR (
         length(p_request->>'cwd') BETWEEN 1 AND 1024
         AND (p_request->>'cwd') !~ '(^/|\\|[[:cntrl:]]|//)'
         AND (p_request->>'cwd') !~ '(^|/)(\.|\.\.)(/|$)'
       )
     ) THEN
    RETURN false;
  END IF;

  v_stdin := p_request->'stdin';
  IF jsonb_typeof(v_stdin) <> 'object' THEN RETURN false; END IF;
  IF v_stdin->>'kind' = 'none' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(v_stdin)) <> 1 THEN RETURN false; END IF;
  ELSIF v_stdin->>'kind' = 'text' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(v_stdin)) <> 2
       OR jsonb_typeof(v_stdin->'text') <> 'string'
       OR octet_length(v_stdin->>'text') > 65536 THEN RETURN false; END IF;
  ELSE
    RETURN false;
  END IF;

  v_timeout_text := p_request->>'timeoutMs';
  IF jsonb_typeof(p_request->'timeoutMs') <> 'number'
     OR v_timeout_text !~ '^[0-9]+$'
     OR v_timeout_text::bigint NOT BETWEEN 1000 AND 480000 THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE TABLE public.compute_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  lease_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  -- Receipts and execution history are an immutable economic ledger. Account
  -- or Agent deletion must never cascade-delete it; lifecycle code must first
  -- apply an explicit retention/anonymization policy.
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE RESTRICT,
  caller_function text NOT NULL,
  execution_id text,
  directive_hash text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  profile text NOT NULL DEFAULT 'developer-v1',
  environment_digest text NOT NULL,
  execution_request jsonb NOT NULL,
  manifest_ceiling jsonb NOT NULL,
  policy_limits_snapshot jsonb NOT NULL,
  authority_epoch bigint NOT NULL,
  state text NOT NULL DEFAULT 'admitted',
  state_version bigint NOT NULL DEFAULT 1,
  claim_id uuid,
  container_id text,
  claim_expires_at timestamptz,
  heartbeat_at timestamptz,
  stop_requested_at timestamptz,
  stop_reason text,
  expires_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  terminal_reason text,
  exit_code smallint,
  stdout text,
  stderr text,
  stdout_bytes bigint,
  stderr_bytes bigint,
  stdout_truncated boolean,
  stderr_truncated boolean,
  execution_metrics jsonb,
  terminal_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compute_runs_idempotency_unique UNIQUE (user_id, idempotency_key),
  CONSTRAINT compute_runs_caller_check
    CHECK (caller_function ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  CONSTRAINT compute_runs_execution_id_check CHECK (
    execution_id IS NULL OR execution_id ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT compute_runs_directive_hash_check
    CHECK (directive_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT compute_runs_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT compute_runs_profile_check CHECK (profile = 'developer-v1'),
  CONSTRAINT compute_runs_environment_digest_check
    CHECK (environment_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT compute_runs_execution_request_check
    CHECK (public.compute_execution_request_valid(execution_request)),
  CONSTRAINT compute_runs_manifest_ceiling_check CHECK (
    jsonb_typeof(manifest_ceiling) = 'object'
    AND manifest_ceiling ?& ARRAY['allowedTools', 'maxTimeoutMs', 'revision']
  ),
  CONSTRAINT compute_runs_policy_limits_check
    CHECK (jsonb_typeof(policy_limits_snapshot) = 'object'),
  CONSTRAINT compute_runs_state_check CHECK (state IN (
    'admitted', 'queued', 'provisioning', 'running',
    'succeeded', 'failed', 'cancelled', 'expired', 'revoked'
  )),
  CONSTRAINT compute_runs_state_version_check CHECK (state_version >= 1),
  CONSTRAINT compute_runs_authority_epoch_check CHECK (authority_epoch >= 1),
  CONSTRAINT compute_runs_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT compute_runs_claim_shape_check CHECK (
    (claim_id IS NULL AND container_id IS NULL AND claim_expires_at IS NULL)
    OR (claim_id IS NOT NULL AND claim_expires_at IS NOT NULL)
  ),
  CONSTRAINT compute_runs_container_id_check CHECK (
    container_id IS NULL OR (
      length(container_id) BETWEEN 1 AND 256 AND container_id !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT compute_runs_stop_shape_check CHECK (
    (stop_requested_at IS NULL AND stop_reason IS NULL)
    OR (stop_requested_at IS NOT NULL
      AND length(stop_reason) BETWEEN 1 AND 1024
      AND stop_reason !~ '[[:cntrl:]]')
  ),
  CONSTRAINT compute_runs_terminal_shape_check CHECK (
    (state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked'))
      = (finished_at IS NOT NULL)
  ),
  CONSTRAINT compute_runs_result_check CHECK (
    (exit_code IS NULL OR exit_code BETWEEN 0 AND 255)
    AND (stdout IS NULL OR octet_length(stdout) <= 1048576)
    AND (stderr IS NULL OR octet_length(stderr) <= 1048576)
    AND (stdout_bytes IS NULL OR stdout_bytes >= 0)
    AND (stderr_bytes IS NULL OR stderr_bytes >= 0)
    AND (execution_metrics IS NULL OR jsonb_typeof(execution_metrics) = 'object')
    AND (terminal_error IS NULL OR length(terminal_error) <= 1024)
  )
);

CREATE INDEX compute_runs_dispatch_idx
  ON public.compute_runs (state, created_at)
  WHERE state IN ('admitted', 'queued');
CREATE INDEX compute_runs_owner_idx
  ON public.compute_runs (user_id, agent_id, caller_function, created_at DESC);
CREATE INDEX compute_runs_execution_admission_idx
  ON public.compute_runs (user_id, agent_id, execution_id)
  WHERE execution_id IS NOT NULL;
CREATE INDEX compute_runs_agent_pending_admission_idx
  ON public.compute_runs (user_id, agent_id, created_at)
  WHERE state IN ('admitted', 'queued');
CREATE INDEX compute_runs_agent_created_at_idx
  ON public.compute_runs (user_id, agent_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.fence_compute_runs_on_policy_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.authority_epoch IS DISTINCT FROM OLD.authority_epoch
     OR NEW.state IS DISTINCT FROM OLD.state
     OR NEW.enabled IS DISTINCT FROM OLD.enabled THEN
    -- Jobs with no body or wallet hold can be terminalized transactionally.
    WITH terminalized AS (
      UPDATE public.compute_runs AS run
      SET state = 'revoked', state_version = run.state_version + 1,
          finished_at = now(), terminal_reason = 'policy_changed_before_body',
          updated_at = now()
      WHERE run.user_id = NEW.user_id AND run.agent_id = NEW.agent_id
        AND run.state IN ('admitted', 'queued')
      RETURNING run.*
    )
    INSERT INTO public.compute_run_receipts (
      id, run_id, user_id, agent_id, outcome, rate_version,
      worker_wall_ms, teardown_allowance_ms, billed_wall_ms,
      reserved_light, actual_light, released_light
    )
    SELECT receipt_id, id, user_id, agent_id, 'revoked', 'compute-rate-v1',
      NULL, 0, 0, 0, 0, 0
    FROM terminalized
    ON CONFLICT (run_id) DO NOTHING;

    -- Claimed bodies require deterministic destroy before settlement.
    UPDATE public.compute_runs AS run
    SET stop_requested_at = COALESCE(run.stop_requested_at, now()),
        stop_reason = COALESCE(run.stop_reason, 'policy_changed'),
        state_version = CASE WHEN run.stop_requested_at IS NULL
          THEN run.state_version + 1 ELSE run.state_version END,
        updated_at = now()
    WHERE run.user_id = NEW.user_id AND run.agent_id = NEW.agent_id
      AND run.state IN ('provisioning', 'running');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE public.compute_run_authorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.compute_runs(id) ON DELETE CASCADE,
  action text NOT NULL,
  resource_kind text NOT NULL,
  target_agent_id uuid REFERENCES public.apps(id) ON DELETE RESTRICT,
  target_function text,
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_kind text NOT NULL,
  source_policy_rule_id uuid REFERENCES public.compute_agent_authority_rules(id)
    ON DELETE RESTRICT,
  source_policy_rule_version bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compute_run_authority_shape_check CHECK (
    public.compute_authority_shape_valid(
      action, resource_kind, target_agent_id, target_function
    )
  ),
  CONSTRAINT compute_run_authority_constraints_check
    CHECK (jsonb_typeof(constraints) = 'object'),
  CONSTRAINT compute_run_authority_source_check CHECK (
    (source_kind = 'builtin'
      AND source_policy_rule_id IS NULL
      AND source_policy_rule_version IS NULL)
    OR (source_kind = 'policy'
      AND source_policy_rule_id IS NOT NULL
      AND source_policy_rule_version IS NOT NULL)
  )
);

CREATE UNIQUE INDEX compute_run_authority_exact_unique
  ON public.compute_run_authorities (
    run_id, action, resource_kind,
    COALESCE(target_agent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(target_function, '')
  );
CREATE INDEX compute_run_authority_gateway_idx
  ON public.compute_run_authorities (run_id, action, resource_kind);

-- Plaintext token material is structurally absent.
CREATE TABLE public.compute_job_tokens (
  id uuid PRIMARY KEY,
  lookup_id uuid NOT NULL UNIQUE,
  token_digest text NOT NULL,
  run_id uuid NOT NULL REFERENCES public.compute_runs(id) ON DELETE CASCADE,
  lease_id uuid NOT NULL,
  audience text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  gateway_request_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compute_job_tokens_digest_check
    CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT compute_job_tokens_audience_check CHECK (audience = 'gx-private-v1'),
  CONSTRAINT compute_job_tokens_status_check
    CHECK (status IN ('active', 'revoked', 'expired')),
  CONSTRAINT compute_job_tokens_expiry_check CHECK (expires_at > issued_at),
  CONSTRAINT compute_job_tokens_gateway_count_check
    CHECK (gateway_request_count BETWEEN 0 AND 10000),
  CONSTRAINT compute_job_tokens_revocation_shape_check CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status IN ('revoked', 'expired') AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX compute_job_tokens_one_active_per_run
  ON public.compute_job_tokens (run_id) WHERE status = 'active';
CREATE INDEX compute_job_tokens_active_run_idx
  ON public.compute_job_tokens (run_id, status, expires_at);

CREATE TABLE public.compute_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.compute_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  source_artifact_id uuid REFERENCES public.compute_artifacts(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  direction text NOT NULL,
  mount_path text,
  logical_name text NOT NULL,
  media_type text NOT NULL,
  storage_key text NOT NULL,
  sha256 text,
  size_bytes bigint,
  state text NOT NULL DEFAULT 'pending',
  state_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compute_artifacts_idempotency_unique
    UNIQUE (run_id, direction, idempotency_key),
  CONSTRAINT compute_artifacts_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT compute_artifacts_direction_check
    CHECK (direction IN ('input', 'output')),
  CONSTRAINT compute_artifacts_source_shape_check CHECK (
    (direction = 'input' AND source_artifact_id IS NOT NULL)
    OR (direction = 'output' AND source_artifact_id IS NULL)
  ),
  CONSTRAINT compute_artifacts_mount_check CHECK (
    (direction = 'output' AND mount_path IS NULL)
    OR (direction = 'input' AND mount_path IS NOT NULL
      AND length(mount_path) BETWEEN 1 AND 1024
      AND mount_path !~ '(^|/)(\.|\.\.)(/|$)'
      AND mount_path !~ '(^/|\\|[[:cntrl:]])')
  ),
  CONSTRAINT compute_artifacts_name_check CHECK (
    length(btrim(logical_name)) BETWEEN 1 AND 512
    AND logical_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT compute_artifacts_media_type_check CHECK (
    length(media_type) BETWEEN 3 AND 255 AND media_type !~ '[[:cntrl:]]'
  ),
  CONSTRAINT compute_artifacts_storage_key_check CHECK (
    storage_key ~ '^compute-v1/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/(inputs|outputs)/[A-Za-z0-9._/-]+$'
    AND storage_key !~ '(^|/)(\.|\.\.)(/|$)'
  ),
  CONSTRAINT compute_artifacts_sha256_check
    CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT compute_artifacts_size_check
    CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT compute_artifacts_state_check
    CHECK (state IN ('pending', 'ready', 'deleted')),
  CONSTRAINT compute_artifacts_state_version_check CHECK (state_version >= 1),
  CONSTRAINT compute_artifacts_ready_shape_check
    CHECK (state <> 'ready' OR (sha256 IS NOT NULL AND size_bytes IS NOT NULL))
);

CREATE INDEX compute_artifacts_run_idx
  ON public.compute_artifacts (run_id, direction, state, created_at);
CREATE INDEX compute_artifacts_source_idx
  ON public.compute_artifacts (source_artifact_id)
  WHERE source_artifact_id IS NOT NULL;
CREATE UNIQUE INDEX compute_artifacts_output_storage_unique
  ON public.compute_artifacts (storage_key)
  WHERE direction = 'output';
CREATE UNIQUE INDEX compute_artifacts_input_mount_unique
  ON public.compute_artifacts (run_id, mount_path)
  WHERE direction = 'input';

CREATE TABLE public.compute_run_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL UNIQUE REFERENCES public.compute_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  hold_id uuid NOT NULL UNIQUE REFERENCES public.cloud_usage_holds(id) ON DELETE RESTRICT,
  rate_version text NOT NULL,
  rate_light_per_ms numeric(24,12) NOT NULL,
  requested_timeout_ms bigint NOT NULL,
  startup_allowance_ms bigint NOT NULL,
  teardown_allowance_ms bigint NOT NULL,
  reserved_wall_ms bigint NOT NULL,
  reserved_light numeric(28,12) NOT NULL,
  actual_wall_ms bigint,
  actual_light numeric(28,12) NOT NULL DEFAULT 0,
  released_light numeric(28,12) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'reserved',
  expires_at timestamptz NOT NULL,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compute_budget_rate_version_check
    CHECK (rate_version = 'compute-rate-v1'),
  CONSTRAINT compute_budget_rate_check
    CHECK (rate_light_per_ms = 0.000002056),
  CONSTRAINT compute_budget_allowance_check CHECK (
    requested_timeout_ms BETWEEN 1000 AND 480000
    AND startup_allowance_ms = 195000
    AND teardown_allowance_ms = 15000
    AND reserved_wall_ms = requested_timeout_ms + startup_allowance_ms + teardown_allowance_ms
  ),
  CONSTRAINT compute_budget_amount_check CHECK (
    reserved_light >= 0 AND actual_light >= 0 AND released_light >= 0
    AND actual_light <= reserved_light
    AND released_light <= reserved_light
  ),
  CONSTRAINT compute_budget_actual_wall_check
    CHECK (actual_wall_ms IS NULL OR actual_wall_ms >= 0),
  CONSTRAINT compute_budget_status_check
    CHECK (status IN ('reserved', 'settled', 'released')),
  CONSTRAINT compute_budget_settlement_shape_check CHECK (
    (status = 'reserved' AND settled_at IS NULL)
    OR (status IN ('settled', 'released') AND settled_at IS NOT NULL)
  )
);

CREATE TABLE public.compute_run_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL UNIQUE REFERENCES public.compute_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE RESTRICT,
  hold_id uuid REFERENCES public.cloud_usage_holds(id) ON DELETE RESTRICT,
  cloud_usage_event_id uuid REFERENCES public.cloud_usage_events(id) ON DELETE RESTRICT,
  outcome text NOT NULL,
  rate_version text NOT NULL,
  worker_wall_ms bigint,
  teardown_allowance_ms bigint NOT NULL,
  billed_wall_ms bigint NOT NULL,
  reserved_light numeric(28,12) NOT NULL,
  actual_light numeric(28,12) NOT NULL,
  released_light numeric(28,12) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compute_receipt_outcome_check
    CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')),
  CONSTRAINT compute_receipt_rate_check
    CHECK (rate_version = 'compute-rate-v1'),
  CONSTRAINT compute_receipt_wall_check CHECK (
    (worker_wall_ms IS NULL OR worker_wall_ms >= 0)
    AND teardown_allowance_ms >= 0 AND billed_wall_ms >= 0
  ),
  CONSTRAINT compute_receipt_amount_check CHECK (
    reserved_light >= 0 AND actual_light >= 0 AND released_light >= 0
    AND actual_light <= reserved_light
    AND actual_light + released_light = reserved_light
  )
);

-- Install only after the receipt relation referenced by the trigger function
-- exists. This also makes a fresh migration apply safe from concurrent policy
-- updates while the schema transaction is being assembled.
CREATE TRIGGER compute_policy_change_fences_runs
AFTER UPDATE OF authority_epoch, state, enabled
ON public.compute_agent_policies
FOR EACH ROW
EXECUTE FUNCTION public.fence_compute_runs_on_policy_change();

-- RLS is a second wall; there are deliberately no authenticated/anon policies.
ALTER TABLE public.compute_agent_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compute_agent_secret_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compute_agent_authority_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compute_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compute_run_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compute_job_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compute_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compute_run_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compute_run_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.compute_agent_policies FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.compute_agent_secret_bindings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.compute_agent_authority_rules FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.compute_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.compute_run_authorities FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.compute_job_tokens FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.compute_artifacts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.compute_run_budget_reservations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.compute_run_receipts FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.compute_agent_policies TO service_role;
GRANT ALL ON TABLE public.compute_agent_secret_bindings TO service_role;
GRANT ALL ON TABLE public.compute_agent_authority_rules TO service_role;
GRANT ALL ON TABLE public.compute_runs TO service_role;
GRANT ALL ON TABLE public.compute_run_authorities TO service_role;
GRANT ALL ON TABLE public.compute_job_tokens TO service_role;
GRANT ALL ON TABLE public.compute_artifacts TO service_role;
GRANT ALL ON TABLE public.compute_run_budget_reservations TO service_role;
GRANT ALL ON TABLE public.compute_run_receipts TO service_role;

REVOKE ALL ON FUNCTION public.compute_authority_shape_valid(text, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_authority_shape_valid(text, text, uuid, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.compute_secret_env_name_reserved(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_secret_env_name_reserved(text)
  TO service_role;
REVOKE ALL ON FUNCTION public.compute_execution_request_valid(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_execution_request_valid(jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fence_compute_runs_on_policy_change()
  FROM PUBLIC, anon, authenticated, service_role;
