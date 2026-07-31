BEGIN;

SELECT plan(64);

CREATE OR REPLACE FUNCTION pg_temp.m7_error(p_sql text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_state text;
  v_detail text;
  v_code text;
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION
  WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_state = RETURNED_SQLSTATE,
      v_detail = PG_EXCEPTION_DETAIL;
    IF v_detail LIKE '{%' THEN
      BEGIN
        v_code := v_detail::jsonb->>'code';
      EXCEPTION
        WHEN OTHERS THEN
          v_code := NULL;
      END;
    END IF;
    RETURN v_state || ':' || COALESCE(v_code, '');
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.insert_uploaded_session(
  p_id uuid,
  p_candidate_id uuid,
  p_owner_id uuid,
  p_intent text,
  p_target_app_id uuid,
  p_version text,
  p_hex text,
  p_base_version text DEFAULT NULL,
  p_base_state_digest text DEFAULT NULL,
  p_base_release_generation bigint DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_created_at timestamptz := '2099-07-30T12:00:00Z';
BEGIN
  INSERT INTO public.builder_handoff_sessions (
    id,
    token_id,
    owner_id,
    candidate_set_id,
    intent,
    target_app_id,
    base_version,
    base_source_hash,
    base_release_digest,
    base_state_digest,
    base_release_generation,
    status,
    status_version,
    lineage_revision,
    description_sha256,
    bundle_id,
    source_hash,
    attestation_id,
    attestation_digest,
    document_digest,
    report_digest,
    release_digest,
    candidate_archive_digest,
    candidate_archive_bytes,
    candidate_archive_objects,
    uploaded_app_id,
    uploaded_version,
    created_at,
    expires_at,
    updated_at,
    staged_at,
    tested_at,
    uploaded_at,
    credential_revoked_at
  ) VALUES (
    p_id,
    p_id,
    p_owner_id,
    p_candidate_id,
    p_intent,
    p_target_app_id,
    p_base_version,
    NULL,
    NULL,
    p_base_state_digest,
    p_base_release_generation,
    'uploaded',
    4,
    1,
    repeat(p_hex, 64),
    'gxb1_' || repeat(p_hex, 64),
    repeat(p_hex, 64),
    'attestation-' || p_hex,
    repeat(p_hex, 64),
    repeat(p_hex, 64),
    repeat(p_hex, 64),
    repeat(p_hex, 64),
    repeat(p_hex, 64),
    128,
    1,
    p_target_app_id,
    p_version,
    v_created_at,
    v_created_at + interval '1 hour',
    v_created_at + interval '5 minutes',
    v_created_at + interval '1 minute',
    v_created_at + interval '2 minutes',
    v_created_at + interval '3 minutes',
    v_created_at + interval '3 minutes'
  );
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.claim_request(
  p_owner_id uuid,
  p_session_id uuid,
  p_target_app_id uuid,
  p_version text,
  p_hex text,
  p_idempotency_key text,
  p_lease_token uuid,
  p_base_state_digest text DEFAULT NULL,
  p_base_release_generation bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'owner_id', p_owner_id,
    'session_id', p_session_id,
    'target_app_id', p_target_app_id,
    'lease_token', p_lease_token,
    'idempotency_key', p_idempotency_key,
    'request_fingerprint', repeat(p_hex, 64),
    'candidate_archive_digest', repeat(p_hex, 64),
    'release_digest', repeat(p_hex, 64),
    'version', p_version,
    'base_state_digest', p_base_state_digest,
    'base_release_generation', p_base_release_generation,
    'review_revision', 'gxr1:' || repeat(p_hex, 64)
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.fence_agent_deployment(
  p_owner_id uuid,
  p_deployment_id uuid,
  p_lease_token uuid
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_phase text;
  v_result jsonb;
  v_index integer := 0;
BEGIN
  FOREACH v_phase IN ARRAY ARRAY[
    'archive_verified',
    'artifacts_started',
    'artifacts_verified',
    'migrations_started',
    'migrations_verified',
    'live_bundle_started',
    'live_bundle_verified'
  ]::text[]
  LOOP
    v_index := v_index + 1;
    v_result := public.fence_builder_handoff_deployment(
      jsonb_build_object(
        'owner_id', p_owner_id,
        'deployment_id', p_deployment_id,
        'lease_token', p_lease_token,
        'phase', v_phase
      ),
      '2099-07-30T12:10:00Z'::timestamptz
        + make_interval(secs => v_index)
    );
    IF v_result->>'code' <> 'fenced' THEN
      RAISE EXCEPTION 'unexpected fence response: %', v_result;
    END IF;
  END LOOP;
  RETURN v_result->>'phase';
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.activation_error(
  p_owner_id uuid,
  p_app_id uuid,
  p_routine_id uuid
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_revision bigint;
  v_generation bigint;
  v_detail text;
  v_json jsonb;
BEGIN
  SELECT agent_home_revision, release_generation
    INTO v_revision, v_generation
  FROM public.apps
  WHERE id = p_app_id;
  PERFORM public.activate_member_deployed_agent(
    jsonb_build_object(
      'owner_id', p_owner_id,
      'app_id', p_app_id,
      'routine_id', p_routine_id,
      'expected_release_generation', v_generation,
      'expected_agent_home_revision', v_revision
    ),
    '2099-07-30T12:12:00Z'
  );
  RETURN 'ok';
EXCEPTION
  WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    BEGIN
      v_json := v_detail::jsonb;
    EXCEPTION
      WHEN OTHERS THEN
        RETURN 'unknown';
    END;
    RETURN concat_ws(
      ':',
      v_json->>'code',
      v_json->>'field',
      v_json->>'reason'
    );
END;
$$;

INSERT INTO public.users (id, email, display_name)
VALUES
  (
    '00000000-0000-0000-0000-00000000d701',
    'm7-member@example.test',
    'M7 Member'
  ),
  (
    '00000000-0000-0000-0000-00000000d702',
    'm7-nonmember@example.test',
    'M7 Nonmember'
  ),
  (
    '00000000-0000-0000-0000-00000000d703',
    'm7-checkout@example.test',
    'M7 Checkout'
  );

INSERT INTO public.account_entitlements (
  user_id,
  plan_code,
  source,
  capacity_anchor_at,
  subscription_status,
  updated_at
) VALUES (
  '00000000-0000-0000-0000-00000000d701',
  'pro',
  'admin',
  '2099-07-30T12:00:00Z',
  'active',
  '2099-07-30T12:00:00Z'
)
ON CONFLICT (user_id) DO UPDATE
SET plan_code = EXCLUDED.plan_code,
    source = EXCLUDED.source,
    subscription_status = EXCLUDED.subscription_status,
    updated_at = EXCLUDED.updated_at;

SELECT has_table(
  'public',
  'builder_handoff_deployments',
  'deployment sagas are durable'
);

SELECT has_table(
  'public',
  'app_releases',
  'immutable release evidence is durable'
);

SELECT has_table(
  'public',
  'subscription_checkout_attempts',
  'subscription checkout attempts are durable'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.activate_member_deployed_agent(jsonb,timestamp with time zone)',
    'EXECUTE'
  ),
  'authenticated clients cannot invoke the activation authority'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.activate_member_deployed_agent(jsonb,timestamp with time zone)',
    'EXECUTE'
  ),
  'the trusted API may invoke activation'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.cancel_subscription_checkout_attempt(jsonb,timestamp with time zone)',
    'EXECUTE'
  ),
  'authenticated clients cannot directly cancel checkout attempts'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.cancel_subscription_checkout_attempt(jsonb,timestamp with time zone)',
    'EXECUTE'
  ),
  'the trusted API may reconcile an owner checkout cancellation'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.apps', 'INSERT'),
  'authenticated clients cannot mint Agent rows directly'
);

SELECT ok(
  has_table_privilege('authenticated', 'public.apps', 'SELECT'),
  'authenticated clients retain policy-scoped Agent reads'
);

SELECT ok(
  NOT has_table_privilege(
    'authenticated',
    'public.app_releases',
    'SELECT'
  ),
  'immutable release evidence is not directly exposed to browsers'
);

INSERT INTO public.apps (
  id,
  owner_id,
  slug,
  name,
  storage_key,
  visibility,
  current_version,
  versions,
  deployment_state
) VALUES
  (
    '00000000-0000-0000-0000-00000000d801',
    '00000000-0000-0000-0000-00000000d701',
    'm7-extension-target',
    'M7 Extension Target',
    'apps/m7-extension-target.zip',
    'private',
    '1.0.0',
    ARRAY['1.0.0', '2.0.0']::text[],
    'legacy'
  ),
  (
    '00000000-0000-0000-0000-00000000d802',
    '00000000-0000-0000-0000-00000000d702',
    'm7-inactive-target',
    'M7 Inactive Target',
    'apps/m7-inactive-target.zip',
    'private',
    '1.0.0',
    ARRAY['1.0.0']::text[],
    'legacy'
  );

INSERT INTO public.apps (
  id,
  owner_id,
  slug,
  name,
  storage_key,
  visibility,
  current_version,
  versions,
  deployment_state,
  deleted_at
) VALUES
  (
    '00000000-0000-0000-0000-00000000d806',
    '00000000-0000-0000-0000-00000000d701',
    'm7-live-public',
    'M7 Live Public',
    'apps/m7-live-public.zip',
    'public',
    '1.0.0',
    ARRAY['1.0.0']::text[],
    'legacy',
    NULL
  ),
  (
    '00000000-0000-0000-0000-00000000d807',
    '00000000-0000-0000-0000-00000000d701',
    'm7-deleted-public',
    'M7 Deleted Public',
    'apps/m7-deleted-public.zip',
    'public',
    '1.0.0',
    ARRAY['1.0.0']::text[],
    'legacy',
    '2099-07-30T12:00:00Z'
  );

SET LOCAL ROLE anon;

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.apps
    WHERE id = '00000000-0000-0000-0000-00000000d806'
  ),
  1,
  'anonymous clients retain live public Agent reads'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.apps
    WHERE id = '00000000-0000-0000-0000-00000000d807'
  ),
  0,
  'anonymous clients cannot read soft-deleted public Agents'
);

RESET ROLE;
SET LOCAL request.jwt.claim.sub =
  '00000000-0000-0000-0000-00000000d702';
SET LOCAL ROLE authenticated;

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.apps
    WHERE id = '00000000-0000-0000-0000-00000000d806'
  ),
  1,
  'authenticated nonowners retain live public Agent reads'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.apps
    WHERE id = '00000000-0000-0000-0000-00000000d807'
  ),
  0,
  'authenticated nonowners cannot read soft-deleted public Agents'
);

RESET ROLE;
SET LOCAL request.jwt.claim.sub =
  '00000000-0000-0000-0000-00000000d701';
SET LOCAL ROLE authenticated;

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.apps
    WHERE id = '00000000-0000-0000-0000-00000000d807'
  ),
  0,
  'owners cannot read their soft-deleted Agents'
);

RESET ROLE;

SELECT is(
  pg_temp.m7_error($sql$
    INSERT INTO public.user_routines (
      id, user_id, composer_app_id, composer_app_slug, template_id,
      name, handler_function, status, schedule, budget_policy
    ) VALUES (
      '00000000-0000-0000-0000-00000000d901',
      '00000000-0000-0000-0000-00000000d702',
      '00000000-0000-0000-0000-00000000d802',
      'm7-inactive-target',
      'inactive-primary',
      'Must stay inactive',
      'run',
      'active',
      '{"type":"interval","every_seconds":300}'::jsonb,
      '{"max_light_per_run":1,"max_light_per_day":2,"max_light_per_month":3,"max_calls_per_run":1}'::jsonb
    )
  $sql$),
  'P0001:PRO_SUBSCRIPTION_REQUIRED',
  'nonmembers cannot create active routines'
);

SELECT lives_ok(
  $sql$
    INSERT INTO public.user_routines (
      id, user_id, composer_app_id, composer_app_slug, template_id,
      name, handler_function, status, schedule, budget_policy
    ) VALUES (
      '00000000-0000-0000-0000-00000000d902',
      '00000000-0000-0000-0000-00000000d701',
      '00000000-0000-0000-0000-00000000d801',
      'm7-extension-target',
      'member-primary',
      'Member routine',
      'run',
      'active',
      '{"type":"interval","every_seconds":300}'::jsonb,
      '{"max_light_per_run":1,"max_light_per_day":2,"max_light_per_month":3,"max_calls_per_run":1}'::jsonb
    )
  $sql$,
  'active Pro members may run legacy Agents'
);

SELECT pg_temp.insert_uploaded_session(
  '00000000-0000-0000-0000-00000000da01',
  '00000000-0000-0000-0000-00000000db01',
  '00000000-0000-0000-0000-00000000d701',
  'function',
  '00000000-0000-0000-0000-00000000d801',
  '2.0.0',
  'a',
  '1.0.0',
  repeat('a', 64),
  0
);

CREATE TEMP TABLE m7_duplicate_claim AS
SELECT public.claim_builder_handoff_deployment(
  pg_temp.claim_request(
    '00000000-0000-0000-0000-00000000d701',
    '00000000-0000-0000-0000-00000000da01',
    '00000000-0000-0000-0000-00000000d801',
    '2.0.0',
    'a',
    'm7-extension-duplicate',
    '00000000-0000-0000-0000-00000000dc01',
    repeat('a', 64),
    0
  ),
  '2099-07-30T12:10:00Z'
) AS result;

SELECT is(
  (SELECT result->>'code' FROM m7_duplicate_claim),
  'target_version_conflict',
  'an extension cannot reuse an already deployed semantic version'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.builder_handoff_deployments
    WHERE session_id = '00000000-0000-0000-0000-00000000da01'
  ),
  0,
  'duplicate-version rejection happens before a deployment saga exists'
);

SELECT is(
  (
    SELECT deployment_state || ':' || hosting_suspended::text
    FROM public.apps
    WHERE id = '00000000-0000-0000-0000-00000000d801'
  ),
  'legacy:false',
  'duplicate-version rejection does not suspend the live Agent'
);

SELECT pg_temp.insert_uploaded_session(
  '00000000-0000-0000-0000-00000000da02',
  '00000000-0000-0000-0000-00000000db02',
  '00000000-0000-0000-0000-00000000d702',
  'agent',
  '00000000-0000-0000-0000-00000000d803',
  '1.0.0',
  'b'
);

CREATE TEMP TABLE m7_inactive_claim AS
SELECT public.claim_builder_handoff_deployment(
  pg_temp.claim_request(
    '00000000-0000-0000-0000-00000000d702',
    '00000000-0000-0000-0000-00000000da02',
    '00000000-0000-0000-0000-00000000d803',
    '1.0.0',
    'b',
    'm7-inactive-claim',
    '00000000-0000-0000-0000-00000000dc02'
  ),
  '2099-07-30T12:10:00Z'
) AS result;

SELECT is(
  (SELECT result->>'code' FROM m7_inactive_claim),
  'pro_subscription_required',
  'staged and tested candidates still require membership to deploy'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.apps
    WHERE id = '00000000-0000-0000-0000-00000000d803'
  ),
  0,
  'membership rejection cannot materialize a reserved Agent'
);

SELECT pg_temp.insert_uploaded_session(
  '00000000-0000-0000-0000-00000000da03',
  '00000000-0000-0000-0000-00000000db03',
  '00000000-0000-0000-0000-00000000d701',
  'agent',
  '00000000-0000-0000-0000-00000000d804',
  '1.0.0',
  'c'
);

CREATE TEMP TABLE m7_failed_claim AS
SELECT public.claim_builder_handoff_deployment(
  pg_temp.claim_request(
    '00000000-0000-0000-0000-00000000d701',
    '00000000-0000-0000-0000-00000000da03',
    '00000000-0000-0000-0000-00000000d804',
    '1.0.0',
    'c',
    'm7-failed-claim',
    '00000000-0000-0000-0000-00000000dc03'
  ),
  '2099-07-30T12:10:00Z'
) AS result;

SELECT is(
  (SELECT result->>'code' FROM m7_failed_claim),
  'claimed',
  'a qualified member candidate starts a deployment saga'
);

SELECT is(
  (
    SELECT
      deployment_state || ':' || visibility || ':' ||
      hosting_suspended::text || ':' || http_enabled::text
    FROM public.apps
    WHERE id = '00000000-0000-0000-0000-00000000d804'
  ),
  'materializing:private:true:false',
  'a materializing Agent is private and non-runnable'
);

SELECT is(
  (
    SELECT public.fence_builder_handoff_deployment(
      jsonb_build_object(
        'owner_id', '00000000-0000-0000-0000-00000000d701',
        'deployment_id', result->>'deployment_id',
        'lease_token', '00000000-0000-0000-0000-00000000dc03',
        'phase', 'artifacts_started'
      ),
      '2099-07-30T12:10:01Z'
    )->>'code'
    FROM m7_failed_claim
  ),
  'phase_out_of_order',
  'deployment side-effect phases cannot skip their prior fence'
);

SELECT is(
  (
    SELECT public.fence_builder_handoff_deployment(
      jsonb_build_object(
        'owner_id', '00000000-0000-0000-0000-00000000d701',
        'deployment_id', result->>'deployment_id',
        'lease_token', '00000000-0000-0000-0000-00000000dc03',
        'phase', 'archive_verified'
      ),
      '2099-07-30T12:10:02Z'
    )->>'code'
    FROM m7_failed_claim
  ),
  'fenced',
  'the next exact deployment phase is accepted'
);

CREATE TEMP TABLE m7_failed_result AS
SELECT public.fail_builder_handoff_deployment(
  jsonb_build_object(
    'owner_id', '00000000-0000-0000-0000-00000000d701',
    'deployment_id', result->>'deployment_id',
    'lease_token', '00000000-0000-0000-0000-00000000dc03',
    'status', 'failed',
    'error_code', 'archive_invalid',
    'error_message', 'Archive verification failed.'
  ),
  '2099-07-30T12:10:03Z'
) AS result
FROM m7_failed_claim;

SELECT is(
  (SELECT result->>'code' FROM m7_failed_result),
  'failed',
  'a pre-side-effect failure reaches a terminal failed state'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.apps
    WHERE id = '00000000-0000-0000-0000-00000000d804'
  ),
  0,
  'a failed new-Agent claim leaves no materializing shell'
);

SELECT pg_temp.insert_uploaded_session(
  '00000000-0000-0000-0000-00000000da04',
  '00000000-0000-0000-0000-00000000db04',
  '00000000-0000-0000-0000-00000000d701',
  'agent',
  '00000000-0000-0000-0000-00000000d805',
  '1.0.0',
  'd'
);

CREATE TEMP TABLE m7_commit_claim AS
SELECT public.claim_builder_handoff_deployment(
  pg_temp.claim_request(
    '00000000-0000-0000-0000-00000000d701',
    '00000000-0000-0000-0000-00000000da04',
    '00000000-0000-0000-0000-00000000d805',
    '1.0.0',
    'd',
    'm7-commit-claim',
    '00000000-0000-0000-0000-00000000dc04'
  ),
  '2099-07-30T12:10:00Z'
) AS result;

SELECT is(
  (SELECT result->>'code' FROM m7_commit_claim),
  'claimed',
  'the commit fixture obtains an exact deployment lease'
);

INSERT INTO public.user_routines (
  id,
  user_id,
  composer_app_id,
  composer_app_slug,
  template_id,
  name,
  handler_function,
  status,
  schedule,
  budget_policy,
  metadata
) VALUES (
  '00000000-0000-0000-0000-00000000d903',
  '00000000-0000-0000-0000-00000000d701',
  '00000000-0000-0000-0000-00000000d805',
  'materializing',
  'stale-unmanaged-routine',
  'Stale unmanaged routine',
  'stale_handler',
  'paused',
  '{"type":"interval","every_seconds":300}'::jsonb,
  '{"max_light_per_run":1,"max_light_per_day":2,"max_light_per_month":3,"max_calls_per_run":1}'::jsonb,
  '{"custom":true}'::jsonb
);

SELECT is(
  (
    SELECT pg_temp.fence_agent_deployment(
      '00000000-0000-0000-0000-00000000d701',
      (result->>'deployment_id')::uuid,
      '00000000-0000-0000-0000-00000000dc04'
    )
    FROM m7_commit_claim
  ),
  'live_bundle_verified',
  'all materialization effects are monotonically fenced before commit'
);

CREATE TEMP TABLE m7_commit_result AS
SELECT public.commit_builder_handoff_deployment(
  jsonb_build_object(
    'owner_id', '00000000-0000-0000-0000-00000000d701',
    'deployment_id', result->>'deployment_id',
    'lease_token', '00000000-0000-0000-0000-00000000dc04',
    'commit_fingerprint', repeat('e', 64),
    'app', jsonb_build_object(
      'slug', 'm7-mail-agent',
      'name', 'M7 Mail Agent',
      'description', 'Membership deployment fixture.',
      'storage_key', 'releases/m7-mail-agent/1.0.0.zip',
      'executable_key', 'executables/m7-mail-agent/1.0.0.mjs',
      'storage_bytes', 256,
      'exports', jsonb_build_array('triage'),
      'manifest', '{"name":"M7 Mail Agent"}',
      'env_schema', jsonb_build_object(
        'EMAIL_TOKEN',
        jsonb_build_object('required', true, 'scope', 'per_user')
      ),
      'skills_md', '# M7 Mail Agent'
    ),
    'version_metadata', jsonb_build_object(
      'version', '1.0.0',
      'source_hash', repeat('d', 64),
      'test_attestation', jsonb_build_object(
        'attestation_id', 'attestation-d',
        'qualification', jsonb_build_object(
          'release_digest', repeat('d', 64),
          'document_digest', repeat('d', 64),
          'report_digest', repeat('d', 64)
        )
      ),
      'trust', jsonb_build_object(
        'test_attestation_digest', repeat('d', 64)
      )
    ),
    'release_provenance', jsonb_build_object(
      'archive_digest', repeat('d', 64),
      'release_digest', repeat('d', 64),
      'source_hash', repeat('d', 64),
      'attestation_id', 'attestation-d',
      'attestation_digest', repeat('d', 64),
      'document_digest', repeat('d', 64),
      'report_digest', repeat('d', 64)
    ),
    'setup', jsonb_build_object(
      'routines', jsonb_build_array(jsonb_build_object(
        'id', '00000000-0000-0000-0000-00000000d904',
        'template_id', 'm7-mail-primary',
        'template_version', '1',
        'name', 'Triage mail',
        'description', 'Review and label incoming mail.',
        'intent', 'Keep the inbox organized.',
        'handler_function', 'triage',
        'schedule', jsonb_build_object(
          'type', 'interval',
          'every_seconds', 300
        ),
        'config', '{}'::jsonb,
        'budget_policy', jsonb_build_object(
          'max_light_per_run', 1,
          'max_light_per_day', 10,
          'max_light_per_month', 100,
          'max_calls_per_run', 5
        ),
        'approval_policy', '{}'::jsonb,
        'metadata', jsonb_build_object('launch_primary', true),
        'capabilities', jsonb_build_array(jsonb_build_object(
          'app_ref', 'gmail',
          'function_name', 'messages.modify',
          'access', 'write',
          'required', true,
          'purpose', 'Apply inbox labels'
        ))
      ))
    )
  ),
  '2099-07-30T12:11:00Z'
) AS result
FROM m7_commit_claim;

SELECT is(
  (SELECT result->>'code' FROM m7_commit_result),
  'committed',
  'an exact fenced release commits once'
);

SELECT is(
  (
    SELECT
      ((result->>'deployment_id') IS NOT NULL)::text || ':' ||
      (result->>'app_id') || ':' ||
      (result->>'app_slug') || ':' ||
      (result->>'app_name') || ':' ||
      (result->>'version') || ':' ||
      (result->>'setup_required')
    FROM m7_commit_result
  ),
  'true:' ||
    '00000000-0000-0000-0000-00000000d805:' ||
    'm7-mail-agent:' ||
    'M7 Mail Agent:' ||
    '1.0.0:true',
  'commit persists the exact owner-safe setup recovery receipt'
);

SELECT is(
  (
    SELECT
      deployment_state || ':' || visibility || ':' ||
      hosting_suspended::text || ':' || http_enabled::text
    FROM public.apps
    WHERE id = '00000000-0000-0000-0000-00000000d805'
  ),
  'setup_required:private:true:false',
  'commit remains private, suspended, and setup-required'
);

SELECT is(
  (
    SELECT version || ':' || release_generation::text
    FROM public.app_releases
    WHERE app_id = '00000000-0000-0000-0000-00000000d805'
  ),
  '1.0.0:1',
  'commit binds immutable release identity and generation'
);

SELECT is(
  (
    SELECT status
    FROM public.builder_handoff_sessions
    WHERE id = '00000000-0000-0000-0000-00000000da04'
  ),
  'promoted',
  'commit atomically promotes the exact candidate'
);

SELECT is(
  (
    SELECT status || ':' || (deleted_at IS NOT NULL)::text
    FROM public.user_routines
    WHERE id = '00000000-0000-0000-0000-00000000d903'
  ),
  'deleted:true',
  'a full release retires every stale routine, regardless of metadata'
);

SELECT is(
  (
    SELECT status
    FROM public.user_routines
    WHERE id = '00000000-0000-0000-0000-00000000d904'
  ),
  'paused',
  'new release routines cannot run before setup'
);

SELECT is(
  (
    SELECT approved::text || ':' || required::text
    FROM public.routine_capabilities
    WHERE routine_id = '00000000-0000-0000-0000-00000000d904'
  ),
  'false:true',
  'required capabilities begin unapproved'
);

SELECT is(
  pg_temp.m7_error($sql$
    UPDATE public.app_releases
    SET provenance = provenance || '{"tampered":true}'::jsonb
    WHERE app_id = '00000000-0000-0000-0000-00000000d805'
  $sql$),
  'P0001:APP_RELEASE_IMMUTABLE',
  'release evidence cannot be mutated after commit'
);

SELECT is(
  pg_temp.activation_error(
    '00000000-0000-0000-0000-00000000d701',
    '00000000-0000-0000-0000-00000000d805',
    '00000000-0000-0000-0000-00000000d904'
  ),
  'AGENT_HOME_INVALID_MUTATION:EMAIL_TOKEN:required_setting_missing',
  'activation fails closed while a required per-user credential is missing'
);

INSERT INTO public.user_app_secrets (
  user_id,
  app_id,
  key,
  value_encrypted
) VALUES (
  '00000000-0000-0000-0000-00000000d701',
  '00000000-0000-0000-0000-00000000d805',
  'EMAIL_TOKEN',
  'encrypted-test-value'
);

SELECT is(
  pg_temp.activation_error(
    '00000000-0000-0000-0000-00000000d701',
    '00000000-0000-0000-0000-00000000d805',
    '00000000-0000-0000-0000-00000000d904'
  ),
  'AGENT_HOME_INVALID_MUTATION:capabilities:required_capability_unapproved',
  'credentials do not bypass explicit capability approval'
);

UPDATE public.routine_capabilities
SET approved = true,
    approved_at = '2099-07-30T12:11:30Z',
    approved_by_user_id = '00000000-0000-0000-0000-00000000d701'
WHERE routine_id = '00000000-0000-0000-0000-00000000d904';

CREATE TEMP TABLE m7_activation AS
SELECT public.activate_member_deployed_agent(
  jsonb_build_object(
    'owner_id', app.owner_id,
    'app_id', app.id,
    'routine_id', '00000000-0000-0000-0000-00000000d904',
    'expected_release_generation', app.release_generation,
    'expected_agent_home_revision', app.agent_home_revision
  ),
  '2099-07-30T12:12:00Z'
) AS result
FROM public.apps AS app
WHERE app.id = '00000000-0000-0000-0000-00000000d805';

SELECT is(
  (SELECT result->>'code' FROM m7_activation),
  'activated',
  'approved setup explicitly activates the exact release'
);

SELECT is(
  (
    SELECT
      deployment_state || ':' || hosting_suspended::text || ':' ||
      http_enabled::text
    FROM public.apps
    WHERE id = '00000000-0000-0000-0000-00000000d805'
  ),
  'ready:false:true',
  'activation is the only transition that makes the Agent runnable'
);

SELECT is(
  (
    SELECT status
    FROM public.user_routines
    WHERE id = '00000000-0000-0000-0000-00000000d904'
  ),
  'active',
  'activation starts the selected managed routine'
);

CREATE TEMP TABLE m7_activation_replay AS
SELECT public.activate_member_deployed_agent(
  jsonb_build_object(
    'owner_id', app.owner_id,
    'app_id', app.id,
    'routine_id', '00000000-0000-0000-0000-00000000d904',
    'expected_release_generation', app.release_generation,
    'expected_agent_home_revision', app.agent_home_revision
  ),
  '2099-07-30T12:12:01Z'
) AS result
FROM public.apps AS app
WHERE app.id = '00000000-0000-0000-0000-00000000d805';

SELECT is(
  (SELECT result->>'code' FROM m7_activation_replay),
  'already_active',
  'activation replay is idempotent for the exact active release'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.claim_member_routine_execution(
      '00000000-0000-0000-0000-00000000d904',
      'm7-runtime-lease',
      '2099-07-30T12:13:00Z',
      '2099-07-30T12:18:00Z'
    )
  ),
  1,
  'the runtime may claim an active member release'
);

UPDATE public.account_entitlements
SET plan_code = 'pro',
    subscription_status = 'inactive',
    updated_at = '2099-07-30T12:13:30Z'
WHERE user_id = '00000000-0000-0000-0000-00000000d701';

UPDATE public.user_routines
SET lease_id = NULL,
    lease_expires_at = NULL,
    next_run_at = '2099-07-30T12:13:30Z'
WHERE id = '00000000-0000-0000-0000-00000000d904';

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.claim_member_routine_execution(
      '00000000-0000-0000-0000-00000000d904',
      'm7-runtime-lease-after-downgrade',
      '2099-07-30T12:14:00Z',
      '2099-07-30T12:19:00Z'
    )
  ),
  0,
  'membership loss fails closed at the runtime claim boundary'
);

SELECT is(
  (
    SELECT status
    FROM public.user_routines
    WHERE id = '00000000-0000-0000-0000-00000000d904'
  ),
  'paused',
  'the runtime quarantines a routine after membership loss'
);

CREATE TEMP TABLE m7_checkout_claim AS
SELECT public.claim_subscription_checkout_attempt(
  jsonb_build_object(
    'owner_id', '00000000-0000-0000-0000-00000000d703',
    'attempt_id', '00000000-0000-0000-0000-00000000dd01',
    'idempotency_key', '00000000-0000-4000-8000-00000000de01',
    'plan_code', 'pro',
    'request_fingerprint', repeat('1', 64),
    'return_url', 'https://launch.example/agents',
    'expires_at', '2099-07-30T13:00:00Z'
  ),
  '2099-07-30T12:00:00Z'
) AS result;

SELECT is(
  (SELECT result->>'status' FROM m7_checkout_claim),
  'creating',
  'checkout first claims a durable creating attempt'
);

SELECT is(
  (
    SELECT public.claim_subscription_checkout_attempt(
      jsonb_build_object(
        'owner_id', '00000000-0000-0000-0000-00000000d703',
        'attempt_id', '00000000-0000-0000-0000-00000000dd09',
        'idempotency_key', '00000000-0000-4000-8000-00000000de01',
        'plan_code', 'pro',
        'request_fingerprint', repeat('1', 64),
        'return_url', 'https://launch.example/agents',
        'expires_at', '2099-07-30T13:30:00Z'
      ),
      '2099-07-30T12:00:01Z'
    )->>'attempt_id'
  ),
  '00000000-0000-0000-0000-00000000dd01',
  'the same idempotency key replays its durable attempt identity'
);

SELECT is(
  pg_temp.m7_error($sql$
    SELECT public.claim_subscription_checkout_attempt(
      jsonb_build_object(
        'owner_id', '00000000-0000-0000-0000-00000000d703',
        'attempt_id', '00000000-0000-0000-0000-00000000dd02',
        'idempotency_key', '00000000-0000-4000-8000-00000000de02',
        'plan_code', 'pro',
        'request_fingerprint', repeat('2', 64),
        'return_url', 'https://launch.example/agents',
        'expires_at', '2099-07-30T13:00:00Z'
      ),
      '2099-07-30T12:00:02Z'
    )
  $sql$),
  'P0001:CHECKOUT_ATTEMPT_IN_PROGRESS',
  'a second live checkout is rejected under the owner lock'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'subscription_checkout_attempts'
      AND indexname = 'subscription_checkout_attempts_owner_live_idx'
      AND indexdef LIKE '%UNIQUE%'
  ),
  'a partial unique index is the final one-live-checkout race fence'
);

CREATE TEMP TABLE m7_checkout_bind AS
SELECT public.bind_subscription_checkout_attempt(
  jsonb_build_object(
    'owner_id', '00000000-0000-0000-0000-00000000d703',
    'attempt_id', '00000000-0000-0000-0000-00000000dd01',
    'stripe_checkout_session_id', 'cs_m7_1',
    'checkout_url', 'https://checkout.stripe.example/m7-1'
  ),
  '2099-07-30T12:01:00Z'
) AS result;

SELECT is(
  (SELECT result->>'status' FROM m7_checkout_bind),
  'pending',
  'binding records one recoverable Stripe checkout URL'
);

SELECT public.claim_subscription_checkout_attempt(
  jsonb_build_object(
    'owner_id', '00000000-0000-0000-0000-00000000d702',
    'attempt_id', '00000000-0000-0000-0000-00000000ddf1',
    'idempotency_key', '00000000-0000-4000-8000-00000000def1',
    'plan_code', 'pro',
    'request_fingerprint', repeat('f', 64),
    'return_url', 'https://launch.example/agents',
    'expires_at', '2099-07-30T13:00:00Z'
  ),
  '2099-07-30T12:00:00Z'
);

SELECT public.bind_subscription_checkout_attempt(
  jsonb_build_object(
    'owner_id', '00000000-0000-0000-0000-00000000d702',
    'attempt_id', '00000000-0000-0000-0000-00000000ddf1',
    'stripe_checkout_session_id', 'cs_m8_cancel',
    'checkout_url', 'https://checkout.stripe.example/m8-cancel'
  ),
  '2099-07-30T12:01:00Z'
);

SELECT is(
  public.cancel_subscription_checkout_attempt(
    jsonb_build_object(
      'owner_id', '00000000-0000-0000-0000-00000000d701',
      'attempt_id', '00000000-0000-0000-0000-00000000ddf1'
    ),
    '2099-07-30T12:02:00Z'
  )->>'code',
  'checkout_attempt_not_found',
  'checkout cancellation does not disclose or mutate another owner attempt'
);

SELECT is(
  (
    SELECT status
    FROM public.subscription_checkout_attempts
    WHERE id = '00000000-0000-0000-0000-00000000ddf1'
  ),
  'pending',
  'a cross-owner cancellation leaves the live attempt unchanged'
);

CREATE TEMP TABLE m8_checkout_cancel AS
SELECT public.cancel_subscription_checkout_attempt(
  jsonb_build_object(
    'owner_id', '00000000-0000-0000-0000-00000000d702',
    'attempt_id', '00000000-0000-0000-0000-00000000ddf1'
  ),
  '2099-07-30T12:02:00Z'
) AS result;

SELECT is(
  (SELECT result->>'status' FROM m8_checkout_cancel),
  'cancelled',
  'the owner can atomically cancel a pending checkout attempt'
);

SELECT is(
  (
    SELECT completed_at
    FROM public.subscription_checkout_attempts
    WHERE id = '00000000-0000-0000-0000-00000000ddf1'
  ),
  '2099-07-30T12:02:00Z'::timestamptz,
  'checkout cancellation records its terminal completion time'
);

SELECT is(
  public.cancel_subscription_checkout_attempt(
    jsonb_build_object(
      'owner_id', '00000000-0000-0000-0000-00000000d702',
      'attempt_id', '00000000-0000-0000-0000-00000000ddf1'
    ),
    '2099-07-30T12:03:00Z'
  )->>'replayed',
  'true',
  'checkout cancellation is idempotent once the attempt is terminal'
);

SELECT is(
  public.claim_subscription_checkout_attempt(
    jsonb_build_object(
      'owner_id', '00000000-0000-0000-0000-00000000d702',
      'attempt_id', '00000000-0000-0000-0000-00000000ddf2',
      'idempotency_key', '00000000-0000-4000-8000-00000000def2',
      'plan_code', 'pro',
      'request_fingerprint', repeat('e', 64),
      'return_url', 'https://launch.example/agents',
      'expires_at', '2099-07-30T13:03:00Z'
    ),
    '2099-07-30T12:03:00Z'
  )->>'status',
  'creating',
  'a cancelled checkout releases the one-live-attempt fence for a fresh retry'
);

CREATE TEMP TABLE m7_checkout_failed AS
SELECT public.project_subscription_checkout_attempt(
  jsonb_build_object(
    'owner_id', '00000000-0000-0000-0000-00000000d703',
    'attempt_id', '00000000-0000-0000-0000-00000000dd01',
    'status', 'failed',
    'stripe_checkout_session_id', 'cs_m7_1',
    'reason', 'payment_failed',
    'event_id', 'evt_m7_failed',
    'event_created_at', '2099-07-30T12:02:00Z'
  ),
  '2099-07-30T12:02:00Z'
) AS result;

SELECT is(
  (SELECT result->>'checkout_url' FROM m7_checkout_failed),
  NULL::text,
  'terminal checkout responses redact the stored Stripe URL'
);

SELECT is(
  (
    SELECT checkout_url
    FROM public.subscription_checkout_attempts
    WHERE id = '00000000-0000-0000-0000-00000000dd01'
  ),
  'https://checkout.stripe.example/m7-1',
  'terminal projection keeps internal reconciliation evidence'
);

CREATE TEMP TABLE m7_checkout_retry AS
SELECT public.claim_subscription_checkout_attempt(
  jsonb_build_object(
    'owner_id', '00000000-0000-0000-0000-00000000d703',
    'attempt_id', '00000000-0000-0000-0000-00000000dd02',
    'idempotency_key', '00000000-0000-4000-8000-00000000de02',
    'plan_code', 'pro',
    'request_fingerprint', repeat('2', 64),
    'return_url', 'https://launch.example/agents',
    'expires_at', '2099-07-30T13:03:00Z'
  ),
  '2099-07-30T12:03:00Z'
) AS result;

SELECT is(
  (SELECT result->>'status' FROM m7_checkout_retry),
  'creating',
  'a terminal failed attempt permits an explicit fresh retry'
);

INSERT INTO public.account_subscriptions (
  user_id,
  stripe_customer_id,
  stripe_subscription_id,
  stripe_price_id,
  plan_code,
  status,
  created_at,
  updated_at
) VALUES (
  '00000000-0000-0000-0000-00000000d703',
  'cus_m7',
  'sub_m7',
  'price_m7',
  'pro',
  'active',
  '2099-07-30T12:03:30Z',
  '2099-07-30T12:03:30Z'
)
ON CONFLICT (user_id) DO UPDATE
SET stripe_customer_id = EXCLUDED.stripe_customer_id,
    stripe_subscription_id = EXCLUDED.stripe_subscription_id,
    stripe_price_id = EXCLUDED.stripe_price_id,
    plan_code = EXCLUDED.plan_code,
    status = EXCLUDED.status,
    updated_at = EXCLUDED.updated_at;

SELECT is(
  pg_temp.m7_error($sql$
    SELECT public.claim_subscription_checkout_attempt(
      jsonb_build_object(
        'owner_id', '00000000-0000-0000-0000-00000000d703',
        'attempt_id', '00000000-0000-0000-0000-00000000dd03',
        'idempotency_key', '00000000-0000-4000-8000-00000000de03',
        'plan_code', 'pro',
        'request_fingerprint', repeat('3', 64),
        'return_url', 'https://launch.example/agents',
        'expires_at', '2099-07-30T13:04:00Z'
      ),
      '2099-07-30T12:04:00Z'
    )
  $sql$),
  'P0001:CHECKOUT_SUBSCRIPTION_EXISTS',
  'an existing Stripe subscription blocks a second subscription checkout'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.subscription_checkout_attempts
    WHERE owner_id = '00000000-0000-0000-0000-00000000d703'
      AND status IN ('creating', 'pending')
  ),
  1,
  'the account retains at most one live checkout attempt'
);

SELECT * FROM finish();
ROLLBACK;
