BEGIN;

SELECT plan(18);

INSERT INTO public.users (
  id,
  email,
  display_name,
  balance_light,
  escrow_light,
  total_earned_light
) VALUES
  (
    '00000000-0000-0000-0000-000000001301',
    'operator-item-owner-a@example.test',
    'Operator Item Owner A',
    1000,
    0,
    0
  ),
  (
    '00000000-0000-0000-0000-000000001302',
    'operator-item-owner-b@example.test',
    'Operator Item Owner B',
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
  created_at
) VALUES
  (
    '00000000-0000-0000-0000-000000001401',
    '00000000-0000-0000-0000-000000001301',
    'operator-item-a',
    'Operator Item A',
    'First affected Agent.',
    'apps/operator-item-a.zip',
    'private',
    '1.0.0',
    ARRAY['1.0.0']::text[],
    '[]'::jsonb,
    '2026-01-01T00:00:00Z'
  ),
  (
    '00000000-0000-0000-0000-000000001402',
    '00000000-0000-0000-0000-000000001301',
    'operator-item-b',
    'Operator Item B',
    'Second affected Agent.',
    'apps/operator-item-b.zip',
    'private',
    '1.0.0',
    ARRAY['1.0.0']::text[],
    '[]'::jsonb,
    '2026-01-02T00:00:00Z'
  ),
  (
    '00000000-0000-0000-0000-000000001403',
    '00000000-0000-0000-0000-000000001302',
    'operator-item-other',
    'Operator Item Other',
    'Other owner Agent.',
    'apps/operator-item-other.zip',
    'private',
    '1.0.0',
    ARRAY['1.0.0']::text[],
    '[]'::jsonb,
    '2026-01-03T00:00:00Z'
  );

CREATE TEMP TABLE operator_item_test_payloads AS
SELECT jsonb_build_object(
  'contractVersion', '2026-07-24.operator-issues.1',
  'conditionKey', 'account:byok',
  'itemClass', 'issue',
  'scope', jsonb_build_object('kind', 'account'),
  'severity', 'warning',
  'diagnosis', jsonb_build_object(
    'code', 'ACCOUNT_BYOK_MISSING',
    'causeCode', NULL,
    'summary', 'Configure an inference provider',
    'detail', 'At least one Agent needs an account provider API key.',
    'provenance', 'platform',
    'evidence', '[]'::jsonb
  ),
  'affectedAgents', jsonb_build_array(
    jsonb_build_object(
      'agentId', '00000000-0000-0000-0000-000000001401',
      'blocking', true
    ),
    jsonb_build_object(
      'agentId', '00000000-0000-0000-0000-000000001402',
      'blocking', true
    )
  ),
  'remediations', jsonb_build_array(jsonb_build_object(
    'id', 'account:byok:remediation:configure_provider',
    'key', 'configure_provider',
    'label', 'Configure provider',
    'description', 'Add a provider API key once.',
    'presentation', 'inline',
    'requiredAuthority', 'account_session',
    'sideEffect', 'configuration_write',
    'target', jsonb_build_object(
      'kind', 'account_provider',
      'provider', NULL
    )
  )),
  'requiresAction', true,
  'requiresDecision', false,
  'ordering', jsonb_build_object(
    'sourceOrdinal', 0,
    'dependsOnConditionKeys', '[]'::jsonb
  ),
  'recovery', jsonb_build_object(
    'mode', 'revalidate_condition',
    'mayRecoverAutomatically', true,
    'resumesScheduledWork', false
  ),
  'detectedAt', '2026-07-24T17:59:00Z',
  'definitionHash', repeat('a', 64)
) AS payload;

SELECT is(
  (
    SELECT result->>'insertedCount'
    FROM (
      SELECT public.reconcile_operator_items(
        '00000000-0000-0000-0000-000000001301',
        'agent_setup_reconciler',
        jsonb_build_array(payload),
        '2026-07-24T18:00:00Z',
        true,
        repeat('1', 64)
      ) AS result
      FROM operator_item_test_payloads
    ) AS inserted
  ),
  '1',
  'the first complete observation creates one canonical account issue'
);

SELECT is(
  (
    SELECT count(*)::text
    FROM public.operator_items
    WHERE user_id = '00000000-0000-0000-0000-000000001301'
      AND condition_key = 'account:byok'
      AND lifecycle_state = 'active'
  ),
  '1',
  'only one active episode owns an owner condition key'
);

SELECT is(
  (
    SELECT count(*)::text
    FROM public.operator_item_affected_agents
    WHERE user_id = '00000000-0000-0000-0000-000000001301'
  ),
  '2',
  'one account blocker fans out to both affected Agents'
);

SELECT is(
  (
    SELECT state || ':' || (read_at IS NULL)::text
    FROM public.operator_item_attention_states
    WHERE user_id = '00000000-0000-0000-0000-000000001301'
  ),
  'open:true',
  'a new issue receives independent unread open Attention state'
);

UPDATE operator_item_test_payloads
SET payload = jsonb_set(
  jsonb_set(
    payload,
    '{affectedAgents}',
    jsonb_build_array(jsonb_build_object(
      'agentId', '00000000-0000-0000-0000-000000001401',
      'blocking', true
    ))
  ),
  '{definitionHash}',
  to_jsonb(repeat('b', 64))
);

SELECT is(
  (
    SELECT result->>'updatedCount'
    FROM (
      SELECT public.reconcile_operator_items(
        '00000000-0000-0000-0000-000000001301',
        'agent_setup_reconciler',
        jsonb_build_array(payload),
        '2026-07-24T18:01:00Z',
        true,
        repeat('2', 64)
      ) AS result
      FROM operator_item_test_payloads
    ) AS updated
  ),
  '1',
  'a repeated observation updates the active episode'
);

SELECT is(
  (
    SELECT count(*)::text
    FROM public.operator_item_affected_agents
    WHERE user_id = '00000000-0000-0000-0000-000000001301'
  ),
  '1',
  'reconciliation replaces exact affected-Agent membership'
);

SELECT is(
  (
    SELECT result->>'recoveredCount'
    FROM (
      SELECT public.reconcile_operator_items(
        '00000000-0000-0000-0000-000000001301',
        'agent_setup_reconciler',
        '[]'::jsonb,
        '2026-07-24T18:02:00Z',
        true,
        repeat('3', 64)
      ) AS result
    ) AS recovered
  ),
  '1',
  'a complete empty snapshot recovers the absent condition'
);

SELECT is(
  (
    SELECT lifecycle_state || ':' || recovery_reason
    FROM public.operator_items
    WHERE user_id = '00000000-0000-0000-0000-000000001301'
      AND condition_key = 'account:byok'
  ),
  'recovered:condition_not_observed',
  'trusted reconciliation owns recovery state'
);

SELECT is(
  (
    SELECT result->>'insertedCount'
    FROM (
      SELECT public.reconcile_operator_items(
        '00000000-0000-0000-0000-000000001301',
        'agent_setup_reconciler',
        jsonb_build_array(payload),
        '2026-07-24T18:03:00Z',
        true,
        repeat('4', 64)
      ) AS result
      FROM operator_item_test_payloads
    ) AS recurrent
  ),
  '1',
  'a recurrent condition creates a new active episode'
);

SELECT is(
  (
    SELECT
      count(*)::text || ':' ||
      count(*) FILTER (WHERE lifecycle_state = 'active')::text
    FROM public.operator_items
    WHERE user_id = '00000000-0000-0000-0000-000000001301'
      AND condition_key = 'account:byok'
  ),
  '2:1',
  'recovered history is retained beside exactly one active recurrence'
);

SELECT lives_ok(
  $$
    SELECT *
    FROM public.apply_operator_item_attention_action(
      '00000000-0000-0000-0000-000000001301',
      (
        SELECT id
        FROM public.operator_items
        WHERE user_id = '00000000-0000-0000-0000-000000001301'
          AND condition_key = 'account:byok'
          AND lifecycle_state = 'active'
      ),
      'dismiss',
      NULL
    )
  $$,
  'the owner can dismiss the active presentation'
);

SELECT is(
  (
    SELECT states.state || ':' || items.lifecycle_state
    FROM public.operator_item_attention_states AS states
    JOIN public.operator_items AS items ON items.id = states.item_id
    WHERE states.user_id = '00000000-0000-0000-0000-000000001301'
      AND items.condition_key = 'account:byok'
      AND items.lifecycle_state = 'active'
  ),
  'dismissed:active',
  'dismissal does not recover the underlying condition'
);

SELECT throws_ok(
  $$
    SELECT public.reconcile_operator_items(
      '00000000-0000-0000-0000-000000001301',
      'agent_setup_reconciler',
      '[]'::jsonb,
      '2026-07-24T18:02:30Z',
      true,
      repeat('5', 64)
    )
  $$,
  'P0001',
  'stale_operator_item_observation',
  'an out-of-order source snapshot cannot regress condition state'
);

SELECT throws_ok(
  $$
    SELECT public.reconcile_operator_items(
      '00000000-0000-0000-0000-000000001301',
      'agent_setup_reconciler',
      '[]'::jsonb,
      '2026-07-24T18:03:00Z',
      true,
      repeat('5', 64)
    )
  $$,
  'P0001',
  'conflicting_operator_item_observation',
  'one source timestamp cannot represent two different snapshots'
);

SELECT throws_ok(
  $$
    SELECT public.reconcile_operator_items(
      '00000000-0000-0000-0000-000000001301',
      'other_source',
      jsonb_build_array(
        jsonb_set(
          (SELECT payload FROM operator_item_test_payloads),
          '{affectedAgents,0,agentId}',
          '"00000000-0000-0000-0000-000000001403"'::jsonb
        )
      ),
      '2026-07-24T18:04:00Z',
      false,
      repeat('6', 64)
    )
  $$,
  '23503',
  'operator_item_agent_owner_mismatch',
  'another owner Agent cannot enter affected-Agent fanout'
);

SELECT is(
  public.is_valid_operator_remediations(
    'account:byok',
    jsonb_build_array(
      jsonb_set(
        (SELECT payload->'remediations'->0 FROM operator_item_test_payloads),
        '{requiredAuthority}',
        '"agent_operate"'::jsonb
      )
    )
  ),
  false,
  'database validation rejects remediation authority widening'
);

SELECT is(
  has_table_privilege(
    'authenticated',
    'public.operator_items',
    'SELECT'
  ),
  false,
  'authenticated clients cannot read canonical operator items directly'
);

SELECT is(
  has_function_privilege(
    'authenticated',
    'public.reconcile_operator_items(uuid,text,jsonb,timestamptz,boolean,text)',
    'EXECUTE'
  ),
  false,
  'authenticated clients cannot invoke canonical reconciliation'
);

SELECT * FROM finish();

ROLLBACK;
