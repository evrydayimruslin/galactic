BEGIN;

SELECT plan(15);

INSERT INTO public.users (
  id,
  email,
  display_name,
  balance_light,
  escrow_light,
  total_earned_light
) VALUES (
  '00000000-0000-0000-0000-000000007101',
  'expired-snooze-owner@example.test',
  'Expired Snooze Owner',
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
) VALUES (
  '00000000-0000-0000-0000-000000007201',
  '00000000-0000-0000-0000-000000007101',
  'expired-snooze-agent',
  'Expired Snooze Agent',
  'Exercises time-based Attention reconciliation.',
  'apps/expired-snooze-agent.zip',
  'private',
  '1.0.0',
  ARRAY['1.0.0']::text[],
  '["notify:owner"]'::jsonb,
  now() - interval '1 day'
);

INSERT INTO public.user_notifications (
  id,
  user_id,
  agent_id,
  kind,
  severity,
  title,
  body,
  entity_type,
  entity_id,
  action_url,
  dedupe_key,
  lifecycle_state,
  state_changed_at,
  snoozed_until,
  created_at
) VALUES
  (
    '00000000-0000-0000-0000-000000007301',
    '00000000-0000-0000-0000-000000007101',
    '00000000-0000-0000-0000-000000007201',
    'routine_failed',
    'warning',
    'Oldest expired snooze',
    'Raw evidence remains on the notification row.',
    'routine',
    'oldest-due-routine',
    '/agents/expired-snooze-agent?pane=alerts',
    'expired-snooze-oldest',
    'snoozed',
    now() - interval '4 hours',
    now() - interval '3 hours',
    now() - interval '5 hours'
  ),
  (
    '00000000-0000-0000-0000-000000007302',
    '00000000-0000-0000-0000-000000007101',
    '00000000-0000-0000-0000-000000007201',
    'routine_failed',
    'warning',
    'Second expired snooze',
    'This body must not be copied into the projection outbox.',
    'routine',
    'second-due-routine',
    '/agents/expired-snooze-agent?pane=alerts',
    'expired-snooze-second',
    'snoozed',
    now() - interval '3 hours',
    now() - interval '2 hours',
    now() - interval '4 hours'
  ),
  (
    '00000000-0000-0000-0000-000000007303',
    '00000000-0000-0000-0000-000000007101',
    '00000000-0000-0000-0000-000000007201',
    'routine_failed',
    'warning',
    'Future snooze',
    'This incident is not due yet.',
    'routine',
    'future-routine',
    '/agents/expired-snooze-agent?pane=alerts',
    'expired-snooze-future',
    'snoozed',
    now(),
    now() + interval '1 hour',
    now() - interval '1 hour'
  );

-- Ignore insertion-time notification-brief work. This test observes only the
-- identifier-only Search jobs emitted by the lifecycle reconciliation trigger.
DELETE FROM public.operator_projection_jobs
WHERE source_type = 'notification'
  AND source_id IN (
    '00000000-0000-0000-0000-000000007301',
    '00000000-0000-0000-0000-000000007302',
    '00000000-0000-0000-0000-000000007303'
  );

SELECT is(
  public.reopen_expired_attention_snoozes(1),
  1,
  'the sweeper respects its bounded batch limit'
);

SELECT is(
  (
    SELECT lifecycle_state
    FROM public.user_notifications
    WHERE id = '00000000-0000-0000-0000-000000007301'
  ),
  'open',
  'the oldest due incident is reopened first'
);

SELECT is(
  (
    SELECT lifecycle_state
    FROM public.user_notifications
    WHERE id = '00000000-0000-0000-0000-000000007302'
  ),
  'snoozed',
  'a second due incident remains snoozed after the bounded first pass'
);

SELECT is(
  (
    SELECT lifecycle_state
    FROM public.user_notifications
    WHERE id = '00000000-0000-0000-0000-000000007303'
  ),
  'snoozed',
  'a future incident remains snoozed'
);

SELECT is(
  public.reopen_expired_attention_snoozes(100),
  1,
  'a later sweep reopens the remaining due incident'
);

SELECT is(
  (
    SELECT lifecycle_state
    FROM public.user_notifications
    WHERE id = '00000000-0000-0000-0000-000000007302'
  ),
  'open',
  'the remaining due incident is reopened'
);

SELECT is(
  public.reopen_expired_attention_snoozes(100),
  0,
  'reconciliation is idempotent after all due incidents are open'
);

SELECT is(
  (
    SELECT lifecycle_state
    FROM public.user_notifications
    WHERE id = '00000000-0000-0000-0000-000000007303'
  ),
  'snoozed',
  'repeated sweeps do not reopen a not-yet-due incident'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.operator_projection_jobs
    WHERE job_kind = 'search_document'
      AND source_type = 'notification'
      AND source_id IN (
        '00000000-0000-0000-0000-000000007301',
        '00000000-0000-0000-0000-000000007302',
        '00000000-0000-0000-0000-000000007303'
      )
  ),
  2::bigint,
  'each reopened incident enqueues exactly one Search reconciliation job'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.operator_projection_jobs
    WHERE job_kind = 'search_document'
      AND source_type = 'notification'
      AND source_id IN (
        '00000000-0000-0000-0000-000000007301',
        '00000000-0000-0000-0000-000000007302'
      )
      AND (
        user_id <> '00000000-0000-0000-0000-000000007101'
        OR agent_id IS DISTINCT FROM
          '00000000-0000-0000-0000-000000007201'
        OR source_version !~ '^[0-9a-f]{64}$'
      )
  ),
  'reconciliation jobs retain validated owner/source identifiers and hashes'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.agent_search_source_revisions
    WHERE user_id = '00000000-0000-0000-0000-000000007101'
      AND agent_id = '00000000-0000-0000-0000-000000007201'
      AND source_type = 'notification'
      AND source_id IN (
        '00000000-0000-0000-0000-000000007301',
        '00000000-0000-0000-0000-000000007302'
      )
  ),
  2::bigint,
  'Search source high-water marks are recorded for both reopened incidents'
);

SELECT throws_ok(
  $$ SELECT public.reopen_expired_attention_snoozes(0) $$,
  'P0001',
  'invalid_expired_attention_snooze_limit',
  'the sweeper rejects an unbounded zero-sized request'
);

SELECT throws_ok(
  $$ SELECT public.reopen_expired_attention_snoozes(NULL) $$,
  'P0001',
  'invalid_expired_attention_snooze_limit',
  'the sweeper rejects an explicit NULL that would remove the SQL limit'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.reopen_expired_attention_snoozes(integer)',
    'EXECUTE'
  ),
  'authenticated clients cannot invoke lifecycle maintenance'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.reopen_expired_attention_snoozes(integer)',
    'EXECUTE'
  ),
  'only the service worker receives lifecycle maintenance execution'
);

SELECT * FROM finish();

ROLLBACK;
