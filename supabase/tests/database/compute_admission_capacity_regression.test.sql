BEGIN;

SELECT plan(17);

INSERT INTO public.users (
  id,
  email,
  display_name,
  balance_light,
  escrow_light,
  total_earned_light
) VALUES
  (
    '00000000-0000-4000-8000-00000000ca01',
    'compute-capacity-owner@example.test',
    'Compute Capacity Owner',
    1000,
    0,
    0
  ),
  (
    '00000000-0000-4000-8000-00000000ca02',
    'compute-capacity-foreign-owner@example.test',
    'Compute Capacity Foreign Owner',
    1000,
    0,
    0
  );

INSERT INTO public.apps (
  id,
  owner_id,
  slug,
  name,
  storage_key,
  visibility
) VALUES
  (
    '00000000-0000-4000-8000-00000000cb01',
    '00000000-0000-4000-8000-00000000ca01',
    'compute-capacity-source',
    'Compute Capacity Source',
    'apps/compute-capacity-source.zip',
    'private'
  ),
  (
    '00000000-0000-4000-8000-00000000cb02',
    '00000000-0000-4000-8000-00000000ca01',
    'compute-capacity-root',
    'Compute Capacity Root',
    'apps/compute-capacity-root.zip',
    'private'
  ),
  (
    '00000000-0000-4000-8000-00000000cb03',
    '00000000-0000-4000-8000-00000000ca02',
    'compute-capacity-foreign-root',
    'Compute Capacity Foreign Root',
    'apps/compute-capacity-foreign-root.zip',
    'private'
  );

INSERT INTO public.compute_agent_policies (
  agent_id,
  user_id,
  enabled,
  profile,
  state,
  allowed_tools,
  max_timeout_ms,
  max_concurrency,
  max_artifact_bytes,
  max_artifacts,
  owner_confirmed_at
) VALUES (
  '00000000-0000-4000-8000-00000000cb01',
  '00000000-0000-4000-8000-00000000ca01',
  true,
  'developer-v1',
  'active',
  ARRAY['shell']::text[],
  30000,
  1,
  1048576,
  8,
  now()
);

CREATE TEMP TABLE compute_admission_capacity_test_state (
  wallet_result jsonb,
  subscription_self_result jsonb,
  subscription_cross_result jsonb,
  replay_result jsonb,
  invalid_root_detail text,
  mismatch_detail text
);

INSERT INTO compute_admission_capacity_test_state DEFAULT VALUES;

SELECT is(
  has_function_privilege(
    'service_role',
    'public.admit_compute_run_capacity_impl(uuid,text,uuid,uuid,text,text,text,text,text,jsonb,jsonb,timestamptz,jsonb)',
    'EXECUTE'
  ),
  false,
  'the legacy admission implementation remains private'
);

UPDATE compute_admission_capacity_test_state
SET wallet_result = public.admit_compute_run(
  p_idempotency_key => '10000000-0000-4000-8000-00000000cc01'::uuid,
  p_request_hash => repeat('1', 64),
  p_user_id => '00000000-0000-4000-8000-00000000ca01'::uuid,
  p_agent_id => '00000000-0000-4000-8000-00000000cb01'::uuid,
  p_caller_function => 'capacity_regression',
  p_execution_id => '20000000-0000-4000-8000-00000000cd01',
  p_directive_hash => repeat('a', 64),
  p_profile => 'developer-v1',
  p_environment_digest => 'sha256:' || repeat('b', 64),
  p_execution_request => '{
    "argv":["true"],
    "tools":[{"id":"shell"}],
    "secretBindingIds":[],
    "cwd":".",
    "stdin":{"kind":"none"},
    "capturePaths":[],
    "inputArtifacts":[],
    "timeoutMs":1000
  }'::jsonb,
  p_manifest_ceiling => '{
    "allowedTools":["shell"],
    "maxTimeoutMs":30000,
    "revision":"capacity-regression-v1"
  }'::jsonb,
  p_expires_at => now() + interval '1 hour',
  p_billing_mode => 'wallet',
  p_capacity_agent_id => '00000000-0000-4000-8000-00000000cb01'::uuid,
  p_authorities => '[]'::jsonb
);

SELECT is(
  (SELECT (wallet_result->>'replayed')::boolean
   FROM compute_admission_capacity_test_state),
  false,
  'wallet admission succeeds as a new Compute run'
);

SELECT is(
  (
    SELECT run.billing_mode || ':' || run.capacity_agent_id::text
    FROM public.compute_runs AS run
    WHERE run.id = (
      SELECT (wallet_result->>'id')::uuid
      FROM compute_admission_capacity_test_state
    )
  ),
  'wallet:00000000-0000-4000-8000-00000000cb01',
  'wallet admission stores self-attribution on the run'
);

UPDATE compute_admission_capacity_test_state
SET subscription_self_result = public.admit_compute_run(
  p_idempotency_key => '10000000-0000-4000-8000-00000000cc02'::uuid,
  p_request_hash => repeat('2', 64),
  p_user_id => '00000000-0000-4000-8000-00000000ca01'::uuid,
  p_agent_id => '00000000-0000-4000-8000-00000000cb01'::uuid,
  p_caller_function => 'capacity_regression',
  p_execution_id => '20000000-0000-4000-8000-00000000cd02',
  p_directive_hash => repeat('a', 64),
  p_profile => 'developer-v1',
  p_environment_digest => 'sha256:' || repeat('b', 64),
  p_execution_request => '{
    "argv":["true"],
    "tools":[{"id":"shell"}],
    "secretBindingIds":[],
    "cwd":".",
    "stdin":{"kind":"none"},
    "capturePaths":[],
    "inputArtifacts":[],
    "timeoutMs":1000
  }'::jsonb,
  p_manifest_ceiling => '{
    "allowedTools":["shell"],
    "maxTimeoutMs":30000,
    "revision":"capacity-regression-v1"
  }'::jsonb,
  p_expires_at => now() + interval '1 hour',
  p_billing_mode => 'subscription_capacity',
  p_capacity_agent_id => '00000000-0000-4000-8000-00000000cb01'::uuid,
  p_authorities => '[]'::jsonb
);

SELECT is(
  (SELECT (subscription_self_result->>'replayed')::boolean
   FROM compute_admission_capacity_test_state),
  false,
  'subscription admission succeeds when the source Agent is its capacity root'
);

SELECT is(
  (
    SELECT run.billing_mode || ':' || run.capacity_agent_id::text
    FROM public.compute_runs AS run
    WHERE run.id = (
      SELECT (subscription_self_result->>'id')::uuid
      FROM compute_admission_capacity_test_state
    )
  ),
  'subscription_capacity:00000000-0000-4000-8000-00000000cb01',
  'same-Agent subscription admission stores the requested billing tuple'
);

UPDATE compute_admission_capacity_test_state
SET subscription_cross_result = public.admit_compute_run(
  p_idempotency_key => '10000000-0000-4000-8000-00000000cc03'::uuid,
  p_request_hash => repeat('3', 64),
  p_user_id => '00000000-0000-4000-8000-00000000ca01'::uuid,
  p_agent_id => '00000000-0000-4000-8000-00000000cb01'::uuid,
  p_caller_function => 'capacity_regression',
  p_execution_id => '20000000-0000-4000-8000-00000000cd03',
  p_directive_hash => repeat('a', 64),
  p_profile => 'developer-v1',
  p_environment_digest => 'sha256:' || repeat('b', 64),
  p_execution_request => '{
    "argv":["true"],
    "tools":[{"id":"shell"}],
    "secretBindingIds":[],
    "cwd":".",
    "stdin":{"kind":"none"},
    "capturePaths":[],
    "inputArtifacts":[],
    "timeoutMs":1000
  }'::jsonb,
  p_manifest_ceiling => '{
    "allowedTools":["shell"],
    "maxTimeoutMs":30000,
    "revision":"capacity-regression-v1"
  }'::jsonb,
  p_expires_at => now() + interval '1 hour',
  p_billing_mode => 'subscription_capacity',
  p_capacity_agent_id => '00000000-0000-4000-8000-00000000cb02'::uuid,
  p_authorities => '[]'::jsonb
);

SELECT is(
  (SELECT (subscription_cross_result->>'replayed')::boolean
   FROM compute_admission_capacity_test_state),
  false,
  'subscription admission succeeds with a distinct owned capacity root'
);

SELECT is(
  (
    SELECT run.billing_mode || ':' || run.capacity_agent_id::text
    FROM public.compute_runs AS run
    WHERE run.id = (
      SELECT (subscription_cross_result->>'id')::uuid
      FROM compute_admission_capacity_test_state
    )
  ),
  'subscription_capacity:00000000-0000-4000-8000-00000000cb02',
  'cross-Agent subscription admission persists the requested capacity root'
);

SELECT is(
  (
    SELECT (subscription_cross_result->>'billing_mode') || ':' ||
      (subscription_cross_result->>'capacity_agent_id')
    FROM compute_admission_capacity_test_state
  ),
  'subscription_capacity:00000000-0000-4000-8000-00000000cb02',
  'cross-Agent subscription admission returns the requested capacity root'
);

DO $capture_invalid_root$
DECLARE
  v_detail text;
BEGIN
  BEGIN
    PERFORM public.admit_compute_run(
      p_idempotency_key => '10000000-0000-4000-8000-00000000cc04'::uuid,
      p_request_hash => repeat('4', 64),
      p_user_id => '00000000-0000-4000-8000-00000000ca01'::uuid,
      p_agent_id => '00000000-0000-4000-8000-00000000cb01'::uuid,
      p_caller_function => 'capacity_regression',
      p_execution_id => '20000000-0000-4000-8000-00000000cd04',
      p_directive_hash => repeat('a', 64),
      p_profile => 'developer-v1',
      p_environment_digest => 'sha256:' || repeat('b', 64),
      p_execution_request => '{
        "argv":["true"],
        "tools":[{"id":"shell"}],
        "secretBindingIds":[],
        "cwd":".",
        "stdin":{"kind":"none"},
        "capturePaths":[],
        "inputArtifacts":[],
        "timeoutMs":1000
      }'::jsonb,
      p_manifest_ceiling => '{
        "allowedTools":["shell"],
        "maxTimeoutMs":30000,
        "revision":"capacity-regression-v1"
      }'::jsonb,
      p_expires_at => now() + interval '1 hour',
      p_billing_mode => 'subscription_capacity',
      p_capacity_agent_id => '00000000-0000-4000-8000-00000000cb03'::uuid,
      p_authorities => '[]'::jsonb
    );
    UPDATE compute_admission_capacity_test_state
    SET invalid_root_detail = 'NO_ERROR';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    UPDATE compute_admission_capacity_test_state
    SET invalid_root_detail = COALESCE(v_detail, SQLERRM);
  END;
END;
$capture_invalid_root$;

SELECT is(
  (
    SELECT CASE
      WHEN invalid_root_detail LIKE '{%'
        THEN invalid_root_detail::jsonb->>'code'
      ELSE invalid_root_detail
    END
    FROM compute_admission_capacity_test_state
  ),
  'COMPUTE_CAPACITY_ATTRIBUTION_INVALID',
  'an unowned capacity root fails with the canonical admission code'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.compute_runs AS run
    WHERE run.user_id = '00000000-0000-4000-8000-00000000ca01'
      AND run.idempotency_key =
        '10000000-0000-4000-8000-00000000cc04'::uuid
  ),
  0,
  'failed capacity attribution leaves no Compute run'
);

UPDATE compute_admission_capacity_test_state
SET replay_result = public.admit_compute_run(
  p_idempotency_key => '10000000-0000-4000-8000-00000000cc03'::uuid,
  p_request_hash => repeat('3', 64),
  p_user_id => '00000000-0000-4000-8000-00000000ca01'::uuid,
  p_agent_id => '00000000-0000-4000-8000-00000000cb01'::uuid,
  p_caller_function => 'capacity_regression',
  p_execution_id => '20000000-0000-4000-8000-00000000cd03',
  p_directive_hash => repeat('a', 64),
  p_profile => 'developer-v1',
  p_environment_digest => 'sha256:' || repeat('b', 64),
  p_execution_request => '{
    "argv":["true"],
    "tools":[{"id":"shell"}],
    "secretBindingIds":[],
    "cwd":".",
    "stdin":{"kind":"none"},
    "capturePaths":[],
    "inputArtifacts":[],
    "timeoutMs":1000
  }'::jsonb,
  p_manifest_ceiling => '{
    "allowedTools":["shell"],
    "maxTimeoutMs":30000,
    "revision":"capacity-regression-v1"
  }'::jsonb,
  p_expires_at => now() + interval '1 hour',
  p_billing_mode => 'subscription_capacity',
  p_capacity_agent_id => '00000000-0000-4000-8000-00000000cb02'::uuid,
  p_authorities => '[]'::jsonb
);

SELECT is(
  (SELECT replay_result->>'id'
   FROM compute_admission_capacity_test_state),
  (SELECT subscription_cross_result->>'id'
   FROM compute_admission_capacity_test_state),
  'an exact admission replay returns the original Compute run'
);

SELECT is(
  (SELECT (replay_result->>'replayed')::boolean
   FROM compute_admission_capacity_test_state),
  true,
  'an exact admission replay is identified as replayed'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.compute_runs AS run
    WHERE run.user_id = '00000000-0000-4000-8000-00000000ca01'
      AND run.idempotency_key =
        '10000000-0000-4000-8000-00000000cc03'::uuid
  ),
  1,
  'an exact admission replay does not duplicate the run'
);

SELECT is(
  (
    SELECT run.billing_mode || ':' || run.capacity_agent_id::text
    FROM public.compute_runs AS run
    WHERE run.id = (
      SELECT (subscription_cross_result->>'id')::uuid
      FROM compute_admission_capacity_test_state
    )
  ),
  'subscription_capacity:00000000-0000-4000-8000-00000000cb02',
  'an exact replay preserves the original billing tuple'
);

DO $capture_tuple_mismatch$
DECLARE
  v_detail text;
BEGIN
  BEGIN
    PERFORM public.admit_compute_run(
      p_idempotency_key => '10000000-0000-4000-8000-00000000cc03'::uuid,
      p_request_hash => repeat('3', 64),
      p_user_id => '00000000-0000-4000-8000-00000000ca01'::uuid,
      p_agent_id => '00000000-0000-4000-8000-00000000cb01'::uuid,
      p_caller_function => 'capacity_regression',
      p_execution_id => '20000000-0000-4000-8000-00000000cd03',
      p_directive_hash => repeat('a', 64),
      p_profile => 'developer-v1',
      p_environment_digest => 'sha256:' || repeat('b', 64),
      p_execution_request => '{
        "argv":["true"],
        "tools":[{"id":"shell"}],
        "secretBindingIds":[],
        "cwd":".",
        "stdin":{"kind":"none"},
        "capturePaths":[],
        "inputArtifacts":[],
        "timeoutMs":1000
      }'::jsonb,
      p_manifest_ceiling => '{
        "allowedTools":["shell"],
        "maxTimeoutMs":30000,
        "revision":"capacity-regression-v1"
      }'::jsonb,
      p_expires_at => now() + interval '1 hour',
      p_billing_mode => 'subscription_capacity',
      p_capacity_agent_id => '00000000-0000-4000-8000-00000000cb01'::uuid,
      p_authorities => '[]'::jsonb
    );
    UPDATE compute_admission_capacity_test_state
    SET mismatch_detail = 'NO_ERROR';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    UPDATE compute_admission_capacity_test_state
    SET mismatch_detail = COALESCE(v_detail, SQLERRM);
  END;
END;
$capture_tuple_mismatch$;

SELECT is(
  (
    SELECT CASE
      WHEN mismatch_detail LIKE '{%'
        THEN mismatch_detail::jsonb->>'code'
      ELSE mismatch_detail
    END
    FROM compute_admission_capacity_test_state
  ),
  'COMPUTE_IDEMPOTENCY_CONFLICT',
  'an idempotency replay with different capacity attribution is rejected'
);

SELECT is(
  (
    SELECT run.billing_mode || ':' || run.capacity_agent_id::text
    FROM public.compute_runs AS run
    WHERE run.id = (
      SELECT (subscription_cross_result->>'id')::uuid
      FROM compute_admission_capacity_test_state
    )
  ),
  'subscription_capacity:00000000-0000-4000-8000-00000000cb02',
  'a rejected attribution mismatch cannot mutate the original billing tuple'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.compute_runs AS run
    WHERE run.user_id = '00000000-0000-4000-8000-00000000ca01'
      AND run.caller_function = 'capacity_regression'
  ),
  3,
  'only the three valid admissions persist inside the test transaction'
);

SELECT * FROM finish();

ROLLBACK;
