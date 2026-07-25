BEGIN;

SELECT plan(13);

INSERT INTO public.users (
  id,
  email,
  display_name,
  balance_light,
  escrow_light,
  total_earned_light
) VALUES
  (
    '00000000-0000-0000-0000-000000001501',
    'operator-read-owner-a@example.test',
    'Operator Read Owner A',
    1000,
    0,
    0
  ),
  (
    '00000000-0000-0000-0000-000000001502',
    'operator-read-owner-b@example.test',
    'Operator Read Owner B',
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
    '00000000-0000-0000-0000-000000001601',
    '00000000-0000-0000-0000-000000001501',
    'operator-read-a',
    'Operator Read A',
    'First affected Agent.',
    'apps/operator-read-a.zip',
    'private',
    '1.0.0',
    ARRAY['1.0.0']::text[],
    '[]'::jsonb,
    '2026-01-01T00:00:00Z'
  ),
  (
    '00000000-0000-0000-0000-000000001602',
    '00000000-0000-0000-0000-000000001501',
    'operator-read-b',
    'Operator Read B',
    'Second affected Agent.',
    'apps/operator-read-b.zip',
    'private',
    '1.0.0',
    ARRAY['1.0.0']::text[],
    '[]'::jsonb,
    '2026-01-02T00:00:00Z'
  );

CREATE TEMP TABLE operator_read_payloads AS
SELECT
  jsonb_build_object(
    'contractVersion', '2026-07-24.operator-issues.1',
    'conditionKey', 'account:byok',
    'itemClass', 'issue',
    'scope', jsonb_build_object('kind', 'account'),
    'severity', 'warning',
    'diagnosis', jsonb_build_object(
      'code', 'ACCOUNT_BYOK_MISSING',
      'causeCode', NULL,
      'summary', 'Configure an inference provider',
      'detail', 'Two Agents need the account provider.',
      'provenance', 'platform',
      'evidence', '[]'::jsonb
    ),
    'affectedAgents', jsonb_build_array(
      jsonb_build_object(
        'agentId', '00000000-0000-0000-0000-000000001601',
        'blocking', true
      ),
      jsonb_build_object(
        'agentId', '00000000-0000-0000-0000-000000001602',
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
  ) AS account_payload,
  jsonb_build_object(
    'contractVersion', '2026-07-24.operator-issues.1',
    'conditionKey',
      'agent:00000000-0000-0000-0000-000000001601:setting:IMAP_PASSWORD',
    'itemClass', 'issue',
    'scope', jsonb_build_object(
      'kind', 'agent',
      'agentId', '00000000-0000-0000-0000-000000001601'
    ),
    'severity', 'warning',
    'diagnosis', jsonb_build_object(
      'code', 'AGENT_SECRET_MISSING',
      'causeCode', NULL,
      'summary', 'Add IMAP password',
      'detail', 'This Agent needs one credential.',
      'provenance', 'platform',
      'evidence', '[]'::jsonb
    ),
    'affectedAgents', jsonb_build_array(jsonb_build_object(
      'agentId', '00000000-0000-0000-0000-000000001601',
      'blocking', true
    )),
    'remediations', jsonb_build_array(jsonb_build_object(
      'id',
        'agent:00000000-0000-0000-0000-000000001601:setting:IMAP_PASSWORD:remediation:configure_secret',
      'key', 'configure_secret',
      'label', 'Add credential',
      'description', 'Store this credential securely.',
      'presentation', 'inline',
      'requiredAuthority', 'account_session',
      'sideEffect', 'configuration_write',
      'target', jsonb_build_object(
        'kind', 'agent_setting',
        'agentId', '00000000-0000-0000-0000-000000001601',
        'settingKey', 'IMAP_PASSWORD',
        'settingScope', 'agent'
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
    'detectedAt', '2026-07-24T18:00:00Z',
    'definitionHash', repeat('b', 64)
  ) AS agent_payload;

SELECT lives_ok(
  $$
    SELECT public.reconcile_operator_items(
      '00000000-0000-0000-0000-000000001501',
      'setup.account',
      jsonb_build_array(
        (SELECT account_payload FROM operator_read_payloads)
      ),
      '2026-07-24T18:01:00Z',
      true,
      repeat('1', 64)
    )
  $$,
  'an account condition is available to the canonical reader'
);

SELECT lives_ok(
  $$
    SELECT public.reconcile_operator_items(
      '00000000-0000-0000-0000-000000001501',
      'setup.agent:00000000-0000-0000-0000-000000001601',
      jsonb_build_array(
        (SELECT agent_payload FROM operator_read_payloads)
      ),
      '2026-07-24T18:01:00Z',
      true,
      repeat('2', 64)
    )
  $$,
  'an Agent condition is available to the canonical reader'
);

SELECT is(
  (
    SELECT
      open_count::text || ':' ||
      requires_decision_count::text || ':' ||
      blocking_count::text
    FROM public.get_operator_attention_page(
      '00000000-0000-0000-0000-000000001501'
    )
  ),
  '2:0:2',
  'global canonical counts count unique conditions, not Agent fanout'
);

SELECT is(
  (
    SELECT count.value->>'open_count'
    FROM public.get_operator_attention_page(
      '00000000-0000-0000-0000-000000001501'
    ) AS snapshot
    CROSS JOIN LATERAL
      jsonb_array_elements(snapshot.per_agent_counts) AS count(value)
    WHERE count.value->>'agent_id' =
      '00000000-0000-0000-0000-000000001601'
  ),
  '2',
  'the first Agent count includes both relevant conditions'
);

SELECT is(
  (
    SELECT count.value->>'open_count'
    FROM public.get_operator_attention_page(
      '00000000-0000-0000-0000-000000001501'
    ) AS snapshot
    CROSS JOIN LATERAL
      jsonb_array_elements(snapshot.per_agent_counts) AS count(value)
    WHERE count.value->>'agent_id' =
      '00000000-0000-0000-0000-000000001602'
  ),
  '1',
  'the shared account condition contributes once to the second Agent'
);

SELECT is(
  (
    SELECT open_count::text
    FROM public.get_operator_attention_page(
      '00000000-0000-0000-0000-000000001501',
      '00000000-0000-0000-0000-000000001602'
    )
  ),
  '1',
  'an Agent page includes only conditions relevant to that Agent'
);

CREATE TEMP TABLE operator_read_first_page AS
SELECT *
FROM public.get_operator_attention_page(
  '00000000-0000-0000-0000-000000001501',
  NULL,
  now(),
  1
);

SELECT is(
  (
    SELECT
      jsonb_array_length(items)::text || ':' ||
      (next_id IS NOT NULL)::text
    FROM operator_read_first_page
  ),
  '1:true',
  'a bounded page returns an opaque continuation tuple'
);

SELECT is(
  (
    SELECT page.items->0->'item'->>'conditionKey'
    FROM operator_read_first_page AS first_page
    CROSS JOIN LATERAL public.get_operator_attention_page(
      '00000000-0000-0000-0000-000000001501',
      NULL,
      now(),
      1,
      first_page.next_source_key,
      first_page.next_source_ordinal,
      first_page.next_detected_at,
      first_page.next_id
    ) AS page
  ),
  'agent:00000000-0000-0000-0000-000000001601:setting:IMAP_PASSWORD',
  'the continuation tuple resumes after the exact trusted order key'
);

SELECT lives_ok(
  $$
    SELECT *
    FROM public.apply_operator_item_attention_action(
      '00000000-0000-0000-0000-000000001501',
      (
        SELECT id
        FROM public.operator_items
        WHERE user_id = '00000000-0000-0000-0000-000000001501'
          AND condition_key = 'account:byok'
          AND lifecycle_state = 'active'
      ),
      'snooze',
      now() + interval '1 hour'
    )
  $$,
  'the shared account condition can be snoozed independently'
);

SELECT is(
  (
    SELECT open_count::text
    FROM public.get_operator_attention_page(
      '00000000-0000-0000-0000-000000001501',
      NULL,
      now()
    )
  ),
  '1',
  'a future snooze hides the condition and all of its fanout'
);

SELECT is(
  (
    SELECT
      open_count::text || ':' ||
      (items->0->'attention'->>'state') || ':' ||
      ((items->0->'attention'->'snoozedUntil') = 'null'::jsonb)::text
    FROM public.get_operator_attention_page(
      '00000000-0000-0000-0000-000000001501',
      NULL,
      now() + interval '2 hours'
    )
  ),
  '2:open:true',
  'an expired snooze reappears as effective open without a state mutation'
);

SELECT is(
  (
    SELECT open_count::text
    FROM public.get_operator_attention_page(
      '00000000-0000-0000-0000-000000001502'
    )
  ),
  '0',
  'another owner cannot read canonical conditions through the service RPC'
);

SELECT is(
  has_function_privilege(
    'authenticated',
    'public.get_operator_attention_page(uuid,uuid,timestamptz,integer,text,integer,timestamptz,uuid)',
    'EXECUTE'
  ),
  false,
  'authenticated clients cannot invoke canonical Attention reads directly'
);

SELECT * FROM finish();

ROLLBACK;
