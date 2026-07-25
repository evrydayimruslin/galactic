BEGIN;

SELECT plan(31);

INSERT INTO public.users (
  id,
  email,
  display_name,
  balance_light,
  escrow_light,
  total_earned_light
) VALUES
  (
    '00000000-0000-0000-0000-000000001701',
    'operator-execution-owner-a@example.test',
    'Operator Execution Owner A',
    1000,
    0,
    0
  ),
  (
    '00000000-0000-0000-0000-000000001702',
    'operator-execution-owner-b@example.test',
    'Operator Execution Owner B',
    1000,
    0,
    0
  );

INSERT INTO public.apps (
  id,
  owner_id,
  slug,
  name,
  description,
  storage_key,
  visibility,
  current_version,
  versions,
  declared_permissions,
  agent_home_revision,
  created_at
) VALUES (
  '00000000-0000-0000-0000-000000001801',
  '00000000-0000-0000-0000-000000001701',
  'operator-execution',
  'Operator Execution',
  'Paused Agent used to verify canonical Run once execution.',
  'apps/operator-execution.zip',
  'private',
  '1.0.0',
  ARRAY['1.0.0']::text[],
  '[]'::jsonb,
  1,
  '2026-01-01T00:00:00Z'
);

INSERT INTO public.user_routines (
  id,
  user_id,
  composer_app_id,
  composer_app_slug,
  template_id,
  name,
  description,
  intent,
  handler_function,
  status,
  schedule,
  max_concurrency,
  next_run_at,
  metadata
) VALUES (
  '00000000-0000-0000-0000-000000001901',
  '00000000-0000-0000-0000-000000001701',
  '00000000-0000-0000-0000-000000001801',
  'operator-execution',
  'operator-execution-primary',
  'Verify recovery',
  'A paused routine with one canonical remediation.',
  'Verify the fix without resuming scheduled work.',
  'verify_recovery',
  'paused',
  '{"kind":"interval","every_seconds":3600}'::jsonb,
  1,
  '2026-07-25T12:00:00Z',
  '{"launch_managed":"true","launch_primary":"true"}'::jsonb
);

CREATE TEMP TABLE operator_execution_payload AS
SELECT jsonb_build_object(
  'contractVersion', '2026-07-24.operator-issues.1',
  'conditionKey',
    'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures',
  'itemClass', 'issue',
  'scope', jsonb_build_object(
    'kind', 'routine',
    'agentId', '00000000-0000-0000-0000-000000001801',
    'routineId', '00000000-0000-0000-0000-000000001901'
  ),
  'severity', 'critical',
  'diagnosis', jsonb_build_object(
    'code', 'ROUTINE_PAUSED_AFTER_FAILURES',
    'causeCode', 'UPSTREAM_TIMEOUT',
    'summary', 'Verify recovery paused after repeated failures',
    'detail', 'Review the failed run, apply the fix, and run once.',
    'provenance', 'combined',
    'evidence', '[]'::jsonb
  ),
  'affectedAgents', jsonb_build_array(jsonb_build_object(
    'agentId', '00000000-0000-0000-0000-000000001801',
    'blocking', true
  )),
  'remediations', jsonb_build_array(jsonb_build_object(
    'id',
      'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once',
    'key', 'run_once',
    'label', 'Run once',
    'description',
      'Runs real work and uses usage, but leaves scheduled execution paused.',
    'presentation', 'execute',
    'requiredAuthority', 'agent_operate',
    'sideEffect', 'routine_execution',
    'target', jsonb_build_object(
      'kind', 'routine',
      'agentId', '00000000-0000-0000-0000-000000001801',
      'routineId', '00000000-0000-0000-0000-000000001901'
    )
  )),
  'requiresAction', true,
  'requiresDecision', false,
  'ordering', jsonb_build_object(
    'sourceOrdinal', 0,
    'dependsOnConditionKeys', '[]'::jsonb
  ),
  'recovery', jsonb_build_object(
    'mode', 'successful_verification',
    'mayRecoverAutomatically', true,
    'resumesScheduledWork', false
  ),
  'detectedAt', '2026-07-25T03:00:00Z',
  'definitionHash', repeat('e', 64)
) AS payload;

SELECT public.reconcile_operator_items(
  '00000000-0000-0000-0000-000000001701',
  'routine.health:00000000-0000-0000-0000-000000001901',
  jsonb_build_array((SELECT payload FROM operator_execution_payload)),
  '2026-07-25T03:01:00Z',
  true,
  repeat('1', 64)
);

CREATE TEMP TABLE operator_execution_fixture AS
SELECT id AS item_id
FROM public.operator_items
WHERE user_id = '00000000-0000-0000-0000-000000001701'
  AND source_key =
    'routine.health:00000000-0000-0000-0000-000000001901'
  AND lifecycle_state = 'active';

SELECT is(
  (
    SELECT app_id::text || ':' || routine_id::text
    FROM public.resolve_operator_item_routine_run_once(
      '00000000-0000-0000-0000-000000001701',
      (SELECT item_id FROM operator_execution_fixture),
      'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once'
    )
  ),
  '00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901',
  'the exact active owner issue resolves to its canonical Agent and routine'
);

SELECT throws_ok(
  format(
    $test$
      SELECT * FROM public.resolve_operator_item_routine_run_once(
        '00000000-0000-0000-0000-000000001702',
        %L::uuid,
        'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once'
      )
    $test$,
    (SELECT item_id FROM operator_execution_fixture)
  ),
  'P0001',
  'operator_item_not_active',
  'another owner cannot resolve the issue'
);

SELECT throws_ok(
  format(
    $test$
      SELECT * FROM public.resolve_operator_item_routine_run_once(
        '00000000-0000-0000-0000-000000001701',
        %L::uuid,
        'operator-execution:wrong'
      )
    $test$,
    (SELECT item_id FROM operator_execution_fixture)
  ),
  'P0001',
  'operator_item_action_not_available',
  'a remediation ID not present on the issue fails closed'
);

SELECT is(
  has_function_privilege(
    'authenticated',
    'public.resolve_operator_item_routine_run_once(uuid,uuid,text)',
    'EXECUTE'
  ),
  false,
  'authenticated clients cannot invoke resolution directly'
);

SELECT is(
  has_function_privilege(
    'authenticated',
    'public.queue_operator_item_routine_run_once(uuid,uuid,uuid,uuid,uuid,text,uuid,bigint)',
    'EXECUTE'
  ),
  false,
  'authenticated clients cannot queue operator verification directly'
);

SELECT is(
  has_function_privilege(
    'authenticated',
    'public.authorize_operator_item_routine_run_once(uuid,uuid,uuid,uuid)',
    'EXECUTE'
  ),
  false,
  'authenticated clients cannot classify queued operator work directly'
);

SELECT is(
  has_function_privilege(
    'service_role',
    'public.queue_operator_item_routine_run_once(uuid,uuid,uuid,uuid,uuid,text,uuid,bigint)',
    'EXECUTE'
  ),
  true,
  'only the trusted service path receives queue authority'
);

SELECT is(
  has_function_privilege(
    'service_role',
    'public.resolve_operator_item_routine_run_once(uuid,uuid,text)',
    'EXECUTE'
  ),
  true,
  'the trusted service path can resolve canonical Run once targets'
);

SELECT is(
  has_function_privilege(
    'service_role',
    'public.authorize_operator_item_routine_run_once(uuid,uuid,uuid,uuid)',
    'EXECUTE'
  ),
  true,
  'the trusted executor can authorize canonical Run once work'
);

-- Routine creation advances the Agent from revision 1 to revision 2 through
-- the production trigger. Claim at that reviewed revision, advance it once,
-- and prove the queue transaction rejects the stale request.
CREATE TEMP TABLE operator_execution_stale_claim AS
SELECT *
FROM public.claim_agent_home_action(
  '00000000-0000-0000-0000-000000001801',
  '00000000-0000-0000-0000-000000001701',
  2,
  'operator-execution-stale-revision',
  'operator_run_once',
  jsonb_build_object(
    'action', 'operator_run_once',
    'capabilityIds', '[]'::jsonb,
    'version', NULL,
    'routineId', '00000000-0000-0000-0000-000000001901',
    'operatorItemId',
      (SELECT item_id::text FROM operator_execution_fixture),
    'remediationId',
      'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once'
  )
);

SELECT public.bump_agent_home_revision(
  '00000000-0000-0000-0000-000000001801',
  '00000000-0000-0000-0000-000000001701'
);

SELECT throws_ok(
  format(
    $test$
      SELECT * FROM public.queue_operator_item_routine_run_once(
        %L::uuid,
        '00000000-0000-0000-0000-000000001801',
        '00000000-0000-0000-0000-000000001701',
        '00000000-0000-0000-0000-000000001901',
        %L::uuid,
        'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once',
        %L::uuid,
        2
      )
    $test$,
    (SELECT request_id FROM operator_execution_stale_claim),
    (SELECT item_id FROM operator_execution_fixture),
    (SELECT request_lease_token FROM operator_execution_stale_claim)
  ),
  'P0001',
  'agent_home_revision_conflict',
  'a stale reviewed Agent revision cannot queue work'
);

DELETE FROM public.agent_home_action_requests
WHERE id = (SELECT request_id FROM operator_execution_stale_claim);

CREATE TEMP TABLE operator_execution_claim AS
SELECT *
FROM public.claim_agent_home_action(
  '00000000-0000-0000-0000-000000001801',
  '00000000-0000-0000-0000-000000001701',
  3,
  'operator-execution-idempotency-key',
  'operator_run_once',
  jsonb_build_object(
    'action', 'operator_run_once',
    'capabilityIds', '[]'::jsonb,
    'version', NULL,
    'routineId', '00000000-0000-0000-0000-000000001901',
    'operatorItemId',
      (SELECT item_id::text FROM operator_execution_fixture),
    'remediationId',
      'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once'
  )
);

SELECT throws_ok(
  format(
    $test$
      SELECT * FROM public.queue_operator_item_routine_run_once(
        %L::uuid,
        '00000000-0000-0000-0000-000000001801',
        '00000000-0000-0000-0000-000000001701',
        '00000000-0000-0000-0000-000000001901',
        %L::uuid,
        'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once',
        '00000000-0000-0000-0000-000000009999',
        3
      )
    $test$,
    (SELECT request_id FROM operator_execution_claim),
    (SELECT item_id FROM operator_execution_fixture)
  ),
  'P0001',
  'agent_home_action_lease_lost',
  'a forged lease token cannot queue work'
);

SELECT throws_ok(
  format(
    $test$
      SELECT * FROM public.queue_operator_item_routine_run_once(
        %L::uuid,
        '00000000-0000-0000-0000-000000001801',
        '00000000-0000-0000-0000-000000001702',
        '00000000-0000-0000-0000-000000001901',
        %L::uuid,
        'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once',
        %L::uuid,
        3
      )
    $test$,
    (SELECT request_id FROM operator_execution_claim),
    (SELECT item_id FROM operator_execution_fixture),
    (SELECT request_lease_token FROM operator_execution_claim)
  ),
  'P0001',
  'agent_home_not_found',
  'another owner cannot queue against the Agent'
);

UPDATE public.user_routines
SET status = 'active'
WHERE id = '00000000-0000-0000-0000-000000001901';

UPDATE public.agent_home_action_requests
SET expected_revision = 4
WHERE id = (SELECT request_id FROM operator_execution_claim);

SELECT throws_ok(
  format(
    $test$
      SELECT * FROM public.queue_operator_item_routine_run_once(
        %L::uuid,
        '00000000-0000-0000-0000-000000001801',
        '00000000-0000-0000-0000-000000001701',
        '00000000-0000-0000-0000-000000001901',
        %L::uuid,
        'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once',
        %L::uuid,
        4
      )
    $test$,
    (SELECT request_id FROM operator_execution_claim),
    (SELECT item_id FROM operator_execution_fixture),
    (SELECT request_lease_token FROM operator_execution_claim)
  ),
  'P0001',
  'operator_item_routine_not_paused',
  'Run once cannot execute an already active schedule'
);

UPDATE public.user_routines
SET status = 'paused', max_concurrency = 2
WHERE id = '00000000-0000-0000-0000-000000001901';

UPDATE public.agent_home_action_requests
SET expected_revision = 5
WHERE id = (SELECT request_id FROM operator_execution_claim);

SELECT throws_ok(
  format(
    $test$
      SELECT * FROM public.queue_operator_item_routine_run_once(
        %L::uuid,
        '00000000-0000-0000-0000-000000001801',
        '00000000-0000-0000-0000-000000001701',
        '00000000-0000-0000-0000-000000001901',
        %L::uuid,
        'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once',
        %L::uuid,
        5
      )
    $test$,
    (SELECT request_id FROM operator_execution_claim),
    (SELECT item_id FROM operator_execution_fixture),
    (SELECT request_lease_token FROM operator_execution_claim)
  ),
  'P0001',
  'operator_item_routine_not_canonical',
  'the canonical verifier rejects widened routine concurrency'
);

UPDATE public.user_routines
SET max_concurrency = 1
WHERE id = '00000000-0000-0000-0000-000000001901';

UPDATE public.agent_home_action_requests
SET expected_revision = 6
WHERE id = (SELECT request_id FROM operator_execution_claim);

INSERT INTO public.routine_runs (
  id,
  routine_id,
  user_id,
  status,
  trigger
) VALUES (
  '00000000-0000-0000-0000-000000001902',
  '00000000-0000-0000-0000-000000001901',
  '00000000-0000-0000-0000-000000001701',
  'running',
  'scheduled'
);

SELECT throws_ok(
  format(
    $test$
      SELECT * FROM public.queue_operator_item_routine_run_once(
        %L::uuid,
        '00000000-0000-0000-0000-000000001801',
        '00000000-0000-0000-0000-000000001701',
        '00000000-0000-0000-0000-000000001901',
        %L::uuid,
        'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once',
        %L::uuid,
        6
      )
    $test$,
    (SELECT request_id FROM operator_execution_claim),
    (SELECT item_id FROM operator_execution_fixture),
    (SELECT request_lease_token FROM operator_execution_claim)
  ),
  'P0001',
  'agent_home_run_concurrency_limit',
  'an active run fences duplicate routine execution'
);

DELETE FROM public.routine_runs
WHERE id = '00000000-0000-0000-0000-000000001902';

UPDATE public.operator_items
SET remediations = jsonb_set(
  remediations,
  '{0,target,routineId}',
  '"00000000-0000-0000-0000-000000009901"'::jsonb
)
WHERE id = (SELECT item_id FROM operator_execution_fixture);

SELECT throws_ok(
  format(
    $test$
      SELECT * FROM public.queue_operator_item_routine_run_once(
        %L::uuid,
        '00000000-0000-0000-0000-000000001801',
        '00000000-0000-0000-0000-000000001701',
        '00000000-0000-0000-0000-000000001901',
        %L::uuid,
        'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once',
        %L::uuid,
        6
      )
    $test$,
    (SELECT request_id FROM operator_execution_claim),
    (SELECT item_id FROM operator_execution_fixture),
    (SELECT request_lease_token FROM operator_execution_claim)
  ),
  'P0001',
  'operator_item_action_not_available',
  'a semantically tampered remediation target cannot queue work'
);

UPDATE public.operator_items
SET remediations = jsonb_set(
  remediations,
  '{0,target,routineId}',
  '"00000000-0000-0000-0000-000000001901"'::jsonb
)
WHERE id = (SELECT item_id FROM operator_execution_fixture);

CREATE TEMP TABLE operator_execution_run AS
SELECT *
FROM public.queue_operator_item_routine_run_once(
  (SELECT request_id FROM operator_execution_claim),
  '00000000-0000-0000-0000-000000001801',
  '00000000-0000-0000-0000-000000001701',
  '00000000-0000-0000-0000-000000001901',
  (SELECT item_id FROM operator_execution_fixture),
  'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once',
  (SELECT request_lease_token FROM operator_execution_claim),
  6
);

SELECT is(
  (SELECT is_new FROM operator_execution_run),
  true,
  'the first valid queue request creates one verification run'
);

SELECT ok(
  (
    SELECT user_id = '00000000-0000-0000-0000-000000001701'
      AND routine_id = '00000000-0000-0000-0000-000000001901'
      AND status = 'queued'
      AND trigger = 'manual'
      AND run_config = '{}'::jsonb
      AND max_attempts = 1
      AND agent_home_action_request_id =
        (SELECT request_id FROM operator_execution_claim)
      AND metadata = jsonb_build_object(
        'source', 'operator_item.run_once',
        'operator_item_id',
          (SELECT item_id::text FROM operator_execution_fixture),
        'operator_remediation_id',
          'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once'
      )
    FROM public.routine_runs
    WHERE id = (SELECT run_id FROM operator_execution_run)
  ),
  'the queued verification is owner-, routine-, request-, and provenance-bound'
);

SELECT is(
  (
    SELECT status || ':' || next_run_at::text
    FROM public.user_routines
    WHERE id = '00000000-0000-0000-0000-000000001901'
  ),
  'paused:2026-07-25 12:00:00+00',
  'queueing Run once leaves the paused schedule and next wake unchanged'
);

SELECT is(
  (
    SELECT is_new
    FROM public.queue_operator_item_routine_run_once(
      (SELECT request_id FROM operator_execution_claim),
      '00000000-0000-0000-0000-000000001801',
      '00000000-0000-0000-0000-000000001701',
      '00000000-0000-0000-0000-000000001901',
      (SELECT item_id FROM operator_execution_fixture),
      'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once',
      (SELECT request_lease_token FROM operator_execution_claim),
      6
    )
  ),
  false,
  'an exact replay reports the existing run instead of queueing again'
);

SELECT is(
  (
    SELECT run_id
    FROM public.queue_operator_item_routine_run_once(
      (SELECT request_id FROM operator_execution_claim),
      '00000000-0000-0000-0000-000000001801',
      '00000000-0000-0000-0000-000000001701',
      '00000000-0000-0000-0000-000000001901',
      (SELECT item_id FROM operator_execution_fixture),
      'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once',
      (SELECT request_lease_token FROM operator_execution_claim),
      6
    )
  ),
  (SELECT run_id FROM operator_execution_run),
  'an exact replay returns the original durable run ID'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.routine_runs
    WHERE agent_home_action_request_id =
      (SELECT request_id FROM operator_execution_claim)
  ),
  1::bigint,
  'exact replays leave one and only one linked verification run'
);

UPDATE public.routine_runs
SET trigger = 'scheduled'
WHERE id = (SELECT run_id FROM operator_execution_run);

SELECT throws_ok(
  format(
    $test$
      SELECT * FROM public.queue_operator_item_routine_run_once(
        %L::uuid,
        '00000000-0000-0000-0000-000000001801',
        '00000000-0000-0000-0000-000000001701',
        '00000000-0000-0000-0000-000000001901',
        %L::uuid,
        'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once',
        %L::uuid,
        6
      )
    $test$,
    (SELECT request_id FROM operator_execution_claim),
    (SELECT item_id FROM operator_execution_fixture),
    (SELECT request_lease_token FROM operator_execution_claim)
  ),
  'P0001',
  'agent_home_idempotency_mismatch',
  'a linked non-manual run cannot be acknowledged as an idempotent replay'
);

UPDATE public.routine_runs
SET trigger = 'manual'
WHERE id = (SELECT run_id FROM operator_execution_run);

UPDATE public.routine_runs
SET run_config = '{"tampered":true}'::jsonb
WHERE id = (SELECT run_id FROM operator_execution_run);

SELECT throws_ok(
  format(
    $test$
      SELECT * FROM public.queue_operator_item_routine_run_once(
        %L::uuid,
        '00000000-0000-0000-0000-000000001801',
        '00000000-0000-0000-0000-000000001701',
        '00000000-0000-0000-0000-000000001901',
        %L::uuid,
        'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once',
        %L::uuid,
        6
      )
    $test$,
    (SELECT request_id FROM operator_execution_claim),
    (SELECT item_id FROM operator_execution_fixture),
    (SELECT request_lease_token FROM operator_execution_claim)
  ),
  'P0001',
  'agent_home_idempotency_mismatch',
  'a linked run with altered configuration cannot replay'
);

UPDATE public.routine_runs
SET run_config = '{}'::jsonb
WHERE id = (SELECT run_id FROM operator_execution_run);

UPDATE public.routine_runs
SET metadata = jsonb_set(
  metadata,
  '{operator_remediation_id}',
  '"tampered-remediation"'::jsonb
)
WHERE id = (SELECT run_id FROM operator_execution_run);

SELECT throws_ok(
  format(
    $test$
      SELECT * FROM public.queue_operator_item_routine_run_once(
        %L::uuid,
        '00000000-0000-0000-0000-000000001801',
        '00000000-0000-0000-0000-000000001701',
        '00000000-0000-0000-0000-000000001901',
        %L::uuid,
        'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once',
        %L::uuid,
        6
      )
    $test$,
    (SELECT request_id FROM operator_execution_claim),
    (SELECT item_id FROM operator_execution_fixture),
    (SELECT request_lease_token FROM operator_execution_claim)
  ),
  'P0001',
  'agent_home_idempotency_mismatch',
  'a corrupt linked run cannot be acknowledged as an idempotent replay'
);

UPDATE public.routine_runs
SET metadata = jsonb_set(
  metadata,
  '{operator_remediation_id}',
  '"routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once"'::jsonb
)
WHERE id = (SELECT run_id FROM operator_execution_run);

SELECT ok(
  (
    SELECT is_operator_run_once
      AND authorized
      AND item_id = (SELECT item_id FROM operator_execution_fixture)
    FROM public.authorize_operator_item_routine_run_once(
      '00000000-0000-0000-0000-000000001701',
      (SELECT run_id FROM operator_execution_run),
      '00000000-0000-0000-0000-000000001901',
      (SELECT request_id FROM operator_execution_claim)
    )
  ),
  'the executor authorizes only the exact persisted run/request/item tuple'
);

UPDATE public.routine_runs
SET trigger = 'scheduled'
WHERE id = (SELECT run_id FROM operator_execution_run);

SELECT is(
  (
    SELECT authorized
    FROM public.authorize_operator_item_routine_run_once(
      '00000000-0000-0000-0000-000000001701',
      (SELECT run_id FROM operator_execution_run),
      '00000000-0000-0000-0000-000000001901',
      (SELECT request_id FROM operator_execution_claim)
    )
  ),
  false,
  'executor authorization rejects a tampered linked run'
);

UPDATE public.routine_runs
SET trigger = 'manual'
WHERE id = (SELECT run_id FROM operator_execution_run);

SELECT is(
  (
    SELECT
      is_operator_run_once::text || ':' || authorized::text || ':' ||
      (item_id IS NULL)::text
    FROM public.authorize_operator_item_routine_run_once(
      '00000000-0000-0000-0000-000000001701',
      (SELECT run_id FROM operator_execution_run),
      '00000000-0000-0000-0000-000000001901',
      '00000000-0000-0000-0000-000000009998'
    )
  ),
  'false:false:true',
  'an unrelated action request cannot impersonate operator work'
);

UPDATE public.agent_home_action_requests
SET request_payload = jsonb_set(
  request_payload,
  '{operatorItemId}',
  '"not-a-uuid"'::jsonb
)
WHERE id = (SELECT request_id FROM operator_execution_claim);

SELECT is(
  (
    SELECT
      is_operator_run_once::text || ':' || authorized::text || ':' ||
      (item_id IS NULL)::text
    FROM public.authorize_operator_item_routine_run_once(
      '00000000-0000-0000-0000-000000001701',
      (SELECT run_id FROM operator_execution_run),
      '00000000-0000-0000-0000-000000001901',
      (SELECT request_id FROM operator_execution_claim)
    )
  ),
  'true:false:true',
  'a malformed persisted operator item ID fails closed'
);

UPDATE public.agent_home_action_requests
SET request_payload = jsonb_set(
  request_payload,
  '{operatorItemId}',
  to_jsonb((SELECT item_id::text FROM operator_execution_fixture))
)
WHERE id = (SELECT request_id FROM operator_execution_claim);

UPDATE public.operator_items
SET lifecycle_state = 'recovered',
    recovered_at = now(),
    recovery_reason = 'test_recovery'
WHERE id = (SELECT item_id FROM operator_execution_fixture);

SELECT throws_ok(
  format(
    $test$
      SELECT * FROM public.resolve_operator_item_routine_run_once(
        '00000000-0000-0000-0000-000000001701',
        %L::uuid,
        'routine:00000000-0000-0000-0000-000000001801:00000000-0000-0000-0000-000000001901:paused_after_failures:remediation:run_once'
      )
    $test$,
    (SELECT item_id FROM operator_execution_fixture)
  ),
  'P0001',
  'operator_item_not_active',
  'a recovered issue cannot create a new durable action claim'
);

SELECT is(
  (
    SELECT is_operator_run_once::text || ':' || authorized::text
    FROM public.authorize_operator_item_routine_run_once(
      '00000000-0000-0000-0000-000000001701',
      (SELECT run_id FROM operator_execution_run),
      '00000000-0000-0000-0000-000000001901',
      (SELECT request_id FROM operator_execution_claim)
    )
  ),
  'true:false',
  'recovery invalidates execution authorization without reclassifying the run'
);

SELECT * FROM finish();

ROLLBACK;
