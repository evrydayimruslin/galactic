BEGIN;

SELECT plan(85);

INSERT INTO public.users (
  id,
  email,
  display_name,
  balance_light,
  escrow_light,
  total_earned_light
) VALUES
  (
    '00000000-0000-0000-0000-000000001101',
    'operator-home-owner-a@example.test',
    'Operator Home Owner A',
    1000,
    0,
    0
  ),
  (
    '00000000-0000-0000-0000-000000001102',
    'operator-home-owner-b@example.test',
    'Operator Home Owner B',
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
    '00000000-0000-0000-0000-000000001201',
    '00000000-0000-0000-0000-000000001101',
    'operator-ready',
    'Operator Ready',
    'Own the primary operator workflow.',
    'apps/operator-ready.zip',
    'private',
    '1.0.0',
    ARRAY['1.0.0']::text[],
    '["notify:owner"]'::jsonb,
    '2026-01-01T00:00:00Z'
  ),
  (
    '00000000-0000-0000-0000-000000001202',
    '00000000-0000-0000-0000-000000001101',
    'operator-paused',
    'Operator Paused',
    'A deliberately paused Agent.',
    'apps/operator-paused.zip',
    'private',
    '1.0.0',
    ARRAY['1.0.0']::text[],
    '["notify:owner"]'::jsonb,
    '2026-01-02T00:00:00Z'
  ),
  (
    '00000000-0000-0000-0000-000000001203',
    '00000000-0000-0000-0000-000000001102',
    'operator-other-owner',
    'Operator Other Owner',
    'Tenant-isolation fixture.',
    'apps/operator-other-owner.zip',
    'private',
    '1.0.0',
    ARRAY['1.0.0']::text[],
    '["notify:owner"]'::jsonb,
    '2026-01-03T00:00:00Z'
  );

SELECT is(
  (
    SELECT array_agg(fleet_position ORDER BY fleet_position)
    FROM public.user_agent_preferences
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
  ),
  ARRAY[0, 1]::integer[],
  'new private Agents receive contiguous zero-based Fleet positions'
);

SELECT is(
  (
    SELECT
      (SELECT revision::text
       FROM public.user_fleet_preferences
       WHERE user_id = '00000000-0000-0000-0000-000000001101')
      || ':' ||
      (SELECT revision::text
       FROM public.user_fleet_preferences
       WHERE user_id = '00000000-0000-0000-0000-000000001102')
  ),
  '3:2',
  'each Agent addition advances exactly its owner Fleet revision'
);

UPDATE public.apps
SET deleted_at = now()
WHERE id = '00000000-0000-0000-0000-000000001201';

SELECT is(
  (
    SELECT
      revision::text || ':' ||
      ordered_agent_ids::text || ':' ||
      ordered_fleet_positions::text
    FROM public.get_user_fleet_preferences_snapshot(
      '00000000-0000-0000-0000-000000001101'
    )
  ),
  '4:{00000000-0000-0000-0000-000000001202}:{0}',
  'Agent removal advances the Fleet revision once and compacts stored positions'
);

UPDATE public.apps
SET deleted_at = NULL
WHERE id = '00000000-0000-0000-0000-000000001201';

SELECT is(
  (
    SELECT
      revision::text || ':' ||
      ordered_agent_ids::text || ':' ||
      ordered_fleet_positions::text
    FROM public.get_user_fleet_preferences_snapshot(
      '00000000-0000-0000-0000-000000001101'
    )
  ),
  '5:{00000000-0000-0000-0000-000000001202,00000000-0000-0000-0000-000000001201}:{0,1}',
  'Agent restoration advances the Fleet revision once and appends compactly'
);

SELECT is(
  (
    SELECT ordered_fleet_positions
    FROM public.get_user_fleet_preferences_snapshot(
      '00000000-0000-0000-0000-000000001101'
    )
  ),
  ARRAY[0, 1]::integer[],
  'Fleet preference snapshots expose the exact compact stored positions'
);

SELECT is(
  (
    SELECT new_revision
    FROM public.replace_user_fleet_order(
      '00000000-0000-0000-0000-000000001101',
      ARRAY[
        '00000000-0000-0000-0000-000000001201',
        '00000000-0000-0000-0000-000000001202'
      ]::uuid[],
      5
    )
  ),
  6::bigint,
  'Fleet reorder advances the owner-scoped revision'
);

SELECT is(
  (
    SELECT array_agg(agent_id ORDER BY fleet_position)
    FROM public.user_agent_preferences
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
  ),
  ARRAY[
    '00000000-0000-0000-0000-000000001201',
    '00000000-0000-0000-0000-000000001202'
  ]::uuid[],
  'Fleet reorder persists the requested order at positions zero and one'
);

SELECT throws_ok(
  $$
    SELECT * FROM public.replace_user_fleet_order(
      '00000000-0000-0000-0000-000000001101',
      ARRAY[
        '00000000-0000-0000-0000-000000001201',
        '00000000-0000-0000-0000-000000001202'
      ]::uuid[],
      1
    )
  $$,
  'P0001',
  'fleet_preference_revision_conflict',
  'a stale Fleet revision is rejected'
);

SELECT is(
  (
    SELECT
      new_revision::text || ':' || shortcuts_enabled::text || ':' ||
        (shortcut_map->>'search')
    FROM public.replace_user_fleet_shortcuts(
      '00000000-0000-0000-0000-000000001101',
      false,
      '{"search":"/","alerts":"a","settings":"s"}'::jsonb,
      6
    )
  ),
  '7:false:/',
  'keyboard shortcut preferences persist through the Fleet revision CAS'
);

SELECT ok(
  public.is_valid_agent_shortcut_map(
    '{"search":"k","alerts":null,"agent-1":"1","dismiss":"Escape"}'::jsonb
  ),
  'shortcut validation accepts canonical sparse overrides and disabled actions'
);

SELECT is(
  public.is_valid_agent_shortcut_map('[]'::jsonb),
  false,
  'shortcut validation rejects non-object JSON without evaluating object iterators'
);

SELECT is(
  public.is_valid_agent_shortcut_map(
    '{"search":"k","alerts":"k"}'::jsonb
  ),
  false,
  'shortcut validation rejects duplicate active key bindings'
);

SELECT is(
  public.is_valid_agent_shortcut_map('{"search":"a"}'::jsonb),
  false,
  'shortcut validation rejects sparse overrides that collide with an effective default binding'
);

SELECT ok(
  (
    SELECT
      favorite_interface_ids = ARRAY['inbox']::text[]
      AND explicit_choice = false
    FROM public.initialize_user_agent_interface_favorites(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001201',
      ARRAY['inbox', 'report']::text[]
    )
  ),
  'first contact favorites exactly the first stable manifest Interface'
);

SELECT is(
  (
    SELECT position
    FROM public.user_agent_interface_preferences
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
      AND agent_id = '00000000-0000-0000-0000-000000001201'
      AND interface_id = 'inbox'
  ),
  0,
  'the first Interface favorite uses zero-based position zero'
);

SELECT is(
  (
    SELECT new_revision
    FROM public.replace_user_agent_interface_favorites(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001201',
      ARRAY[]::text[],
      2
    )
  ),
  3::bigint,
  'an explicit empty Favorites replacement advances the Agent revision'
);

SELECT ok(
  (
    SELECT
      favorite_interface_ids = ARRAY[]::text[]
      AND explicit_choice = true
      AND initialized_now = false
    FROM public.initialize_user_agent_interface_favorites(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001201',
      ARRAY['inbox', 'report']::text[]
    )
  ),
  'an explicitly empty Favorites list is never silently repopulated'
);

SELECT throws_ok(
  $$
    SELECT * FROM public.replace_user_agent_interface_favorites(
      '00000000-0000-0000-0000-000000001102',
      '00000000-0000-0000-0000-000000001201',
      ARRAY['inbox']::text[],
      1
    )
  $$,
  'P0001',
  'agent_not_found',
  'an owner cannot mutate another owner''s Interface Favorites'
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
  next_run_at,
  metadata
) VALUES
  (
    '00000000-0000-0000-0000-000000001301',
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001201',
    'operator-ready',
    'operator-ready-primary',
    'Check inbox',
    'Check for new operator mail.',
    'Own inbound triage and surface decisions.',
    'check_inbox',
    'active',
    now() + interval '10 minutes',
    '{"launch_managed":"true","launch_primary":"true"}'::jsonb
  ),
  (
    '00000000-0000-0000-0000-000000001302',
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001202',
    'operator-paused',
    'operator-paused-primary',
    'Paused check',
    'A paused scheduled task.',
    'Remain paused for the readiness test.',
    'paused_check',
    'paused',
    NULL,
    '{"launch_managed":"true","launch_primary":"true"}'::jsonb
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
  dedupe_key
) VALUES
  (
    '00000000-0000-0000-0000-000000001501',
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001201',
    'agent_report',
    'info',
    'Inbox report',
    'Three messages were reviewed.',
    'routine',
    '00000000-0000-0000-0000-000000001301',
    '/agents/operator-ready?pane=alerts',
    'operator-home-report'
  ),
  (
    '00000000-0000-0000-0000-000000001502',
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001201',
    'routine_paused',
    'warning',
    'Inbox check paused',
    'A required setting is missing.',
    'routine',
    '00000000-0000-0000-0000-000000001301',
    '/agents/operator-ready?pane=access',
    'operator-home-incident'
  );

SELECT is(
  (
    SELECT item_class || ':' || lifecycle_state || ':' ||
      requires_action::text
    FROM public.user_notifications
    WHERE id = '00000000-0000-0000-0000-000000001501'
  ),
  'report:open:false',
  'informational Agent output is classified as an open report'
);

SELECT is(
  (
    SELECT item_class || ':' || lifecycle_state || ':' ||
      requires_action::text
    FROM public.user_notifications
    WHERE id = '00000000-0000-0000-0000-000000001502'
  ),
  'incident:open:true',
  'an operational failure is classified as an actionable incident'
);

SELECT is(
  (
    SELECT open_count
    FROM public.get_owner_attention_snapshot(
      '00000000-0000-0000-0000-000000001101',
      now(),
      200
    )
  ),
  2::bigint,
  'owner Attention snapshot returns an exact active count'
);

SELECT is(
  (
    SELECT requires_decision_count
    FROM public.get_owner_attention_snapshot(
      '00000000-0000-0000-0000-000000001101',
      now(),
      200
    )
  ),
  1::bigint,
  'owner Attention snapshot counts active incidents independently'
);

SELECT is(
  (
    SELECT notifications->0->>'id'
    FROM public.get_owner_attention_snapshot(
      '00000000-0000-0000-0000-000000001101',
      now(),
      1
    )
  ),
  '00000000-0000-0000-0000-000000001501',
  'owner Attention snapshot bounds one global newest-first page with a stable id tie-break'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.get_owner_attention_snapshot(
      '00000000-0000-0000-0000-000000001101',
      now(),
      200
    ) AS snapshot
    CROSS JOIN LATERAL jsonb_array_elements(
      snapshot.notifications
    ) AS notification(value)
    LEFT JOIN public.apps AS agent
      ON agent.id = (notification.value->>'agent_id')::uuid
    WHERE agent.owner_id IS DISTINCT FROM
      '00000000-0000-0000-0000-000000001101'::uuid
      OR agent.visibility IS DISTINCT FROM 'private'
      OR agent.deleted_at IS NOT NULL
  ),
  'owner Attention snapshot contains only live private Agents owned by the requested user'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.operator_projection_jobs
    WHERE job_kind = 'notification_brief'
      AND source_type = 'notification'
      AND source_id IN (
        '00000000-0000-0000-0000-000000001501',
        '00000000-0000-0000-0000-000000001502'
      )
  ),
  2,
  'each raw notification queues one reference-only brief projection'
);

SELECT is(
  (
    SELECT attention_count
    FROM public.get_launch_fleet_snapshot(
      '00000000-0000-0000-0000-000000001101',
      true
    )
    WHERE agent_id = '00000000-0000-0000-0000-000000001201'
  ),
  2::bigint,
  'unread reports and open incidents both contribute to Attention'
);

SELECT ok(
  (
    SELECT
      lifecycle_state = 'open'
      AND read_at IS NOT NULL
    FROM public.transition_user_notification(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001502',
      'read'
    )
  ),
  'reading an incident does not resolve it'
);

SELECT is(
  public.resolve_notification_incident_by_dedupe(
    '00000000-0000-0000-0000-000000001102',
    'operator-home-incident',
    'Wrong owner must not resolve this incident'
  ),
  0,
  'incident recovery cannot cross owner scope even with an exact dedupe key'
);

SELECT is(
  public.resolve_notification_incident_by_dedupe(
    '00000000-0000-0000-0000-000000001101',
    'operator-home-incident',
    'Configuration restored'
  ),
  1,
  'incident recovery resolves one exact owner-scoped dedupe key'
);

SELECT ok(
  (
    SELECT lifecycle_state = 'resolved' AND read_at IS NOT NULL
    FROM public.user_notifications
    WHERE id = '00000000-0000-0000-0000-000000001502'
  ),
  'incident recovery leaves the independent read state untouched'
);

SELECT is(
  (
    SELECT lifecycle_state
    FROM public.transition_user_notification(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001501',
      'archive'
    )
  ),
  'archived',
  'reports archive through read/archive semantics'
);

SELECT throws_ok(
  $$
    UPDATE public.user_notifications
    SET title = 'Rewritten evidence'
    WHERE id = '00000000-0000-0000-0000-000000001501'
  $$,
  'P0001',
  'notification_raw_evidence_immutable',
  'raw notification evidence cannot be rewritten by enrichment code'
);

SELECT is(
  (
    SELECT attention_count
    FROM public.get_launch_fleet_snapshot(
      '00000000-0000-0000-0000-000000001101',
      true
    )
    WHERE agent_id = '00000000-0000-0000-0000-000000001201'
  ),
  0::bigint,
  'resolved incidents and archived reports leave active Attention'
);

INSERT INTO public.user_notifications (
  id,
  user_id,
  agent_id,
  kind,
  severity,
  title,
  dedupe_key
) VALUES
  (
    '00000000-0000-0000-0000-000000001506',
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001201',
    'routine_report',
    'info',
    'Routine report',
    'operator-home-routine-report'
  ),
  (
    '00000000-0000-0000-0000-000000001507',
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001201',
    'routine_summary',
    'info',
    'Routine summary',
    'operator-home-routine-summary'
  ),
  (
    '00000000-0000-0000-0000-000000001508',
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001201',
    'routine_budget_exhausted',
    'warning',
    'Routine budget exhausted',
    'operator-home-budget-wall'
  );

SELECT is(
  (
    SELECT string_agg(kind || ':' || item_class, ',' ORDER BY kind)
    FROM public.user_notifications
    WHERE id IN (
      '00000000-0000-0000-0000-000000001506',
      '00000000-0000-0000-0000-000000001507',
      '00000000-0000-0000-0000-000000001508'
    )
  ),
  'routine_budget_exhausted:incident,routine_report:report,routine_summary:report',
  'SQL classification exactly matches canonical report kinds and keeps a budget wall actionable'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.create_user_notification_episode(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001201',
      'routine_paused',
      'warning',
      'Recurring condition, first episode',
      'First immutable evidence',
      'routine',
      '00000000-0000-0000-0000-000000001301',
      '/agents/operator-ready?pane=alerts',
      'operator-home-recurring-incident'
    )
  ),
  1,
  'the atomic notification writer creates the first incident episode'
);

SELECT is(
  public.resolve_notification_incident_by_dedupe(
    '00000000-0000-0000-0000-000000001101',
    'operator-home-recurring-incident',
    'The first episode recovered'
  ),
  1,
  'the first recurring episode becomes terminal without changing its evidence'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.create_user_notification_episode(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001201',
      'routine_paused',
      'critical',
      'Recurring condition, second episode',
      'Second immutable evidence',
      'routine',
      '00000000-0000-0000-0000-000000001301',
      '/agents/operator-ready?pane=alerts',
      'operator-home-recurring-incident'
    )
  ),
  1,
  'a recurrence after resolution creates a fresh episode under the stable key'
);

SELECT ok(
  (
    SELECT
      count(*) = 2
      AND count(*) FILTER (WHERE lifecycle_state = 'resolved') = 1
      AND count(*) FILTER (WHERE lifecycle_state = 'open') = 1
      AND min(title) = 'Recurring condition, first episode'
      AND max(title) = 'Recurring condition, second episode'
    FROM public.user_notifications
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
      AND dedupe_key = 'operator-home-recurring-incident'
  ),
  'recurrence preserves the resolved evidence and exposes exactly one active episode'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.create_user_notification_episode(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001201',
      'routine_paused',
      'critical',
      'Recurring condition, second episode',
      'Second immutable evidence',
      'routine',
      '00000000-0000-0000-0000-000000001301',
      '/agents/operator-ready?pane=alerts',
      'operator-home-recurring-incident'
    )
  ),
  0,
  'a delivery retry of the active episode is an atomic no-op'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.create_user_notification_episode(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001201',
      'agent_missing_setting',
      'warning',
      'Snoozed recurring condition',
      'Initial setting evidence',
      'setting',
      'MAIL_TOKEN',
      '/agents/operator-ready?pane=access',
      'operator-home-snoozed-recurrence'
    )
  ),
  1,
  'a snooze recurrence fixture starts with one incident episode'
);

SELECT is(
  (
    SELECT lifecycle_state
    FROM public.transition_user_notification(
      '00000000-0000-0000-0000-000000001101',
      (
        SELECT id
        FROM public.user_notifications
        WHERE user_id = '00000000-0000-0000-0000-000000001101'
          AND dedupe_key = 'operator-home-snoozed-recurrence'
          AND lifecycle_state = 'open'
      ),
      'snooze',
      now() + interval '1 day'
    )
  ),
  'snoozed',
  'an owner can snooze the active incident episode'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.create_user_notification_episode(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001201',
      'agent_missing_setting',
      'warning',
      'Snoozed recurring condition returned',
      'Fresh setting evidence',
      'setting',
      'MAIL_TOKEN',
      '/agents/operator-ready?pane=access',
      'operator-home-snoozed-recurrence'
    )
  ),
  0,
  're-detection during snooze is a retry no-op and cannot bypass the owner'
);

SELECT ok(
  (
    SELECT
      count(*) = 1
      AND count(*) FILTER (WHERE lifecycle_state = 'snoozed') = 1
      AND min(title) = 'Snoozed recurring condition'
    FROM public.user_notifications
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
      AND dedupe_key = 'operator-home-snoozed-recurrence'
  ),
  'the snoozed episode and its immutable evidence remain the sole active condition'
);

SELECT throws_ok(
  $$
    INSERT INTO public.user_notifications (
      user_id,
      agent_id,
      kind,
      severity,
      title,
      dedupe_key
    ) VALUES (
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001201',
      'agent_missing_setting',
      'warning',
      'Concurrent duplicate',
      'operator-home-snoozed-recurrence'
    )
  $$,
  '23505',
  'duplicate key value violates unique constraint "user_notifications_user_active_incident_dedupe_key"',
  'the partial unique index is the final concurrency guard for one active episode'
);

SELECT ok(
  (
    SELECT count(*) >= 4
    FROM public.operator_projection_jobs
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
      AND agent_id = '00000000-0000-0000-0000-000000001201'
      AND job_kind = 'search_document'
      AND source_type = 'notification'
      AND source_id IN (
        SELECT id
        FROM public.user_notifications
        WHERE dedupe_key IN (
          'operator-home-report',
          'operator-home-incident',
          'operator-home-recurring-incident',
          'operator-home-snoozed-recurrence'
        )
      )
  ),
  'read and lifecycle transitions enqueue Attention search reconciliation'
);

SELECT is(
  (
    SELECT working_ready
    FROM public.get_launch_fleet_snapshot(
      '00000000-0000-0000-0000-000000001101',
      true
    )
    WHERE agent_id = '00000000-0000-0000-0000-000000001201'
  ),
  true,
  'a live configured Agent with an active routine is working-ready'
);

SELECT is(
  (
    SELECT working_ready::text || ':' || working_exclusion_reason
    FROM public.get_launch_fleet_snapshot(
      '00000000-0000-0000-0000-000000001101',
      true
    )
    WHERE agent_id = '00000000-0000-0000-0000-000000001202'
  ),
  'false:paused',
  'an actively paused Agent is excluded from the working count'
);

SELECT is(
  public.get_launch_working_agent_count(
    '00000000-0000-0000-0000-000000001101'
  ),
  1::bigint,
  'the Fleet hero count includes only genuinely working-ready Agents'
);

INSERT INTO public.routine_runs (
  id,
  routine_id,
  user_id,
  status,
  trigger,
  summary,
  started_at,
  completed_at,
  created_at
) VALUES
  (
    '00000000-0000-0000-0000-000000001401',
    '00000000-0000-0000-0000-000000001301',
    '00000000-0000-0000-0000-000000001101',
    'succeeded',
    'scheduled',
    'Reviewed first batch.',
    now() - interval '8 minutes',
    now() - interval '7 minutes',
    now() - interval '8 minutes'
  ),
  (
    '00000000-0000-0000-0000-000000001402',
    '00000000-0000-0000-0000-000000001301',
    '00000000-0000-0000-0000-000000001101',
    'succeeded',
    'scheduled',
    'Reviewed second batch.',
    now() - interval '6 minutes',
    now() - interval '5 minutes',
    now() - interval '6 minutes'
  ),
  (
    '00000000-0000-0000-0000-000000001403',
    '00000000-0000-0000-0000-000000001301',
    '00000000-0000-0000-0000-000000001101',
    'succeeded',
    'scheduled',
    'Reviewed third batch.',
    now() - interval '4 minutes',
    now() - interval '3 minutes',
    now() - interval '4 minutes'
  ),
  (
    '00000000-0000-0000-0000-000000001404',
    '00000000-0000-0000-0000-000000001301',
    '00000000-0000-0000-0000-000000001101',
    'succeeded',
    'scheduled',
    'Reviewed fourth batch.',
    now() - interval '2 minutes',
    now() - interval '1 minute',
    now() - interval '2 minutes'
  );

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.operator_projection_jobs
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
      AND agent_id = '00000000-0000-0000-0000-000000001201'
      AND job_kind = 'search_document'
      AND source_type = 'routine_run'
      AND source_id IN (
        '00000000-0000-0000-0000-000000001401',
        '00000000-0000-0000-0000-000000001402',
        '00000000-0000-0000-0000-000000001403',
        '00000000-0000-0000-0000-000000001404'
      )
  ),
  4,
  'routine lifecycle writes enqueue reference-only run search projections'
);

SELECT throws_ok(
  $$
    INSERT INTO public.operator_projection_jobs (
      user_id,
      agent_id,
      job_kind,
      source_type,
      source_id,
      source_version
    ) VALUES (
      '00000000-0000-0000-0000-000000001102',
      '00000000-0000-0000-0000-000000001203',
      'search_document',
      'routine_run',
      '00000000-0000-0000-0000-000000001401',
      repeat('f', 64)
    )
  $$,
  '23503',
  'operator_projection_source_owner_mismatch',
  'a run projection cannot cross run, user, routine, and Agent ownership'
);

INSERT INTO public.operator_projection_jobs (
  user_id,
  agent_id,
  job_kind,
  source_type,
  source_id,
  source_version
) VALUES
  (
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001201',
    'search_document',
    'agent',
    '00000000-0000-0000-0000-000000001201',
    repeat('c', 64)
  ),
  (
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001201',
    'search_document',
    'agent',
    '00000000-0000-0000-0000-000000001201',
    repeat('d', 64)
  ),
  (
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001201',
    'search_document',
    'agent',
    '00000000-0000-0000-0000-000000001201',
    repeat('c', 64)
  );

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.operator_projection_jobs
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
      AND agent_id = '00000000-0000-0000-0000-000000001201'
      AND job_kind = 'search_document'
      AND source_type = 'agent'
      AND source_id = '00000000-0000-0000-0000-000000001201'
      AND source_version IN (repeat('c', 64), repeat('d', 64))
  ),
  3,
  'database generations preserve an A-to-B-to-A event sequence without content-hash dedupe loss'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.get_launch_agent_activity(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001201',
      3,
      NULL,
      NULL,
      false
    )
  ),
  3,
  'the default Overview history projection is bounded to three recent items'
);

SELECT throws_ok(
  $$
    INSERT INTO public.notification_briefs (
      notification_id,
      user_id,
      agent_id,
      revision,
      source_hash
    ) VALUES (
      '00000000-0000-0000-0000-000000001501',
      '00000000-0000-0000-0000-000000001102',
      '00000000-0000-0000-0000-000000001203',
      1,
      repeat('0', 64)
    )
  $$,
  '23503',
  'notification_brief_owner_mismatch',
  'a brief cannot cross notification, user, and Agent ownership'
);

INSERT INTO public.agent_search_source_revisions (
  user_id,
  agent_id,
  source_type,
  source_id,
  enqueue_generation,
  source_version
) VALUES (
  '00000000-0000-0000-0000-000000001101',
  '00000000-0000-0000-0000-000000001201',
  'agent',
  '00000000-0000-0000-0000-000000001201',
  100000,
  'manual-agent-source:100000'
)
ON CONFLICT (user_id, agent_id, source_type, source_id) DO UPDATE
SET
  enqueue_generation = EXCLUDED.enqueue_generation,
  source_version = EXCLUDED.source_version;

SELECT ok(
  (
    public.upsert_agent_search_document(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001201',
      'interface',
      'inbox',
      'Inbox',
      'Operator Ready / Interfaces',
      'Review mailbox decisions and draft replies.',
      '/agents/operator-ready?pane=interfaces&item=inbox',
      ARRAY['mail', 'triage']::text[],
      'interface-inbox-v1:100000',
      'agent',
      '00000000-0000-0000-0000-000000001201',
      100000
    )
  ).id IS NOT NULL,
  'a trusted worker can upsert a safe owner-private navigation document'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.search_agent_documents(
      '00000000-0000-0000-0000-000000001101',
      'mailbox'
    )
    WHERE subject_type = 'interface' AND subject_id = 'inbox'
  ),
  1,
  'lexical navigation search returns the owner''s matching Interface'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.search_agent_documents(
      '00000000-0000-0000-0000-000000001102',
      'mailbox'
    )
  ),
  0,
  'navigation search never returns another owner''s documents'
);

SELECT throws_ok(
  $$
    SELECT public.upsert_agent_search_document(
      '00000000-0000-0000-0000-000000001102',
      '00000000-0000-0000-0000-000000001201',
      'interface',
      'stolen-inbox',
      'Stolen inbox',
      'Wrong owner',
      NULL,
      '/agents/operator-ready?pane=interfaces&item=stolen-inbox',
      ARRAY[]::text[],
      'wrong-owner-v1:100001',
      'agent',
      '00000000-0000-0000-0000-000000001201',
      100001
    )
  $$,
  'P0001',
  'agent_not_found',
  'a search-document write cannot cross Agent ownership'
);

UPDATE public.agent_search_source_revisions
SET
  enqueue_generation = 100002,
  source_version = 'manual-agent-source:100002'
WHERE user_id = '00000000-0000-0000-0000-000000001101'
  AND agent_id = '00000000-0000-0000-0000-000000001201'
  AND source_type = 'agent'
  AND source_id = '00000000-0000-0000-0000-000000001201';

SELECT is(
  public.tombstone_agent_search_document(
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001201',
    'interface',
    'inbox',
    'interface-inbox-deleted:100002',
    'agent',
    '00000000-0000-0000-0000-000000001201',
    100002
  ),
  true,
  'removed navigation subjects are tombstoned'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.search_agent_documents(
      '00000000-0000-0000-0000-000000001101',
      'mailbox'
    )
  ),
  0,
  'tombstoned navigation subjects disappear from search immediately'
);

SELECT is(
  (
    public.upsert_agent_search_document(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001201',
      'interface',
      'inbox',
      'Stale Inbox',
      'Operator Ready / Interfaces',
      'This stale in-flight write must not return.',
      '/agents/operator-ready?pane=interfaces&item=inbox',
      ARRAY['mail']::text[],
      'interface-inbox-v1:100001',
      'agent',
      '00000000-0000-0000-0000-000000001201',
      100001
    )
  ).id,
  NULL::uuid,
  'an older in-flight upsert cannot overtake a durable tombstone'
);

SELECT ok(
  (
    SELECT deleted_at IS NOT NULL
      AND source_revision = 'interface-inbox-deleted:100002'
    FROM public.agent_search_documents
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
      AND agent_id = '00000000-0000-0000-0000-000000001201'
      AND subject_type = 'interface'
      AND subject_id = 'inbox'
  ),
  'the stale upsert leaves the tombstoned document unchanged'
);

SELECT is(
  (
    public.upsert_agent_search_document(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001201',
      'interface',
      'removed-before-materialized',
      'Removed Interface',
      'Operator Ready / Interfaces',
      'This Interface disappeared before its older worker wrote it.',
      '/agents/operator-ready?pane=interfaces&item=removed-before-materialized',
      ARRAY['interface']::text[],
      'older-agent-source:100001',
      'agent',
      '00000000-0000-0000-0000-000000001201',
      100001
    )
  ).id,
  NULL::uuid,
  'source high-water rejects an old in-flight write for a subject that never had a document or tombstone'
);

UPDATE public.agent_search_source_revisions
SET
  enqueue_generation = 100003,
  source_version = 'manual-agent-source:100003'
WHERE user_id = '00000000-0000-0000-0000-000000001101'
  AND agent_id = '00000000-0000-0000-0000-000000001201'
  AND source_type = 'agent'
  AND source_id = '00000000-0000-0000-0000-000000001201';

SELECT ok(
  (
    public.upsert_agent_search_document(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001201',
      'interface',
      'inbox',
      'Inbox',
      'Operator Ready / Interfaces',
      'The same safe content may legitimately return after an intervening event.',
      '/agents/operator-ready?pane=interfaces&item=inbox',
      ARRAY['mail']::text[],
      'interface-inbox-v1:100003',
      'agent',
      '00000000-0000-0000-0000-000000001201',
      100003
    )
  ).deleted_at IS NULL,
  'a newer A-after-B-after-A generation restores the subject without dedupe loss'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.operator_projection_jobs
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
      AND agent_id = '00000000-0000-0000-0000-000000001201'
      AND job_kind = 'search_document'
      AND source_type = 'agent'
      AND source_id = '00000000-0000-0000-0000-000000001201'
      AND source_version NOT IN (repeat('c', 64), repeat('d', 64))
  ),
  3,
  'Agent insert, removal, and restoration enqueue distinct navigation-search projection generations'
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
  declared_permissions
) VALUES
  (
    '00000000-0000-0000-0000-000000001204',
    '00000000-0000-0000-0000-000000001101',
    'operator-delete-fixture',
    'Operator Delete Fixture',
    'Projection cascade regression fixture.',
    'apps/operator-delete-fixture.zip',
    'private',
    '1.0.0',
    ARRAY['1.0.0']::text[],
    '["notify:owner"]'::jsonb
  ),
  (
    '00000000-0000-0000-0000-000000001205',
    '00000000-0000-0000-0000-000000001101',
    'operator-transfer-fixture',
    'Operator Transfer Fixture',
    'Projection ownership-transfer regression fixture.',
    'apps/operator-transfer-fixture.zip',
    'private',
    '1.0.0',
    ARRAY['1.0.0']::text[],
    '["notify:owner"]'::jsonb
  ),
	  (
	    '00000000-0000-0000-0000-000000001206',
    '00000000-0000-0000-0000-000000001101',
    'operator-evidence-fixture',
    'Operator Evidence Fixture',
    'Immutable notification attribution regression fixture.',
    'apps/operator-evidence-fixture.zip',
    'private',
    '1.0.0',
	    ARRAY['1.0.0']::text[],
	    '["notify:owner"]'::jsonb
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
  next_run_at,
  metadata
) VALUES (
  '00000000-0000-0000-0000-000000001303',
  '00000000-0000-0000-0000-000000001101',
  '00000000-0000-0000-0000-000000001205',
  'operator-transfer-fixture',
  'operator-transfer-primary',
  'Transfer fixture routine',
  'Retained source for ownership-transfer regression coverage.',
  'Remain mutable without rebuilding projections for a former owner.',
  'transfer_fixture',
  'active',
  now() + interval '30 minutes',
  '{"launch_managed":"true","launch_primary":"true"}'::jsonb
);

INSERT INTO public.routine_runs (
  id,
  routine_id,
  user_id,
  status,
  trigger,
  summary,
  started_at,
  completed_at,
  created_at
) VALUES (
  '00000000-0000-0000-0000-000000001405',
  '00000000-0000-0000-0000-000000001303',
  '00000000-0000-0000-0000-000000001101',
  'succeeded',
  'scheduled',
  'Retained Routine run ownership fixture.',
  now() - interval '6 minutes',
  now() - interval '5 minutes',
  now() - interval '6 minutes'
);

INSERT INTO public.compute_runs (
  id,
  user_id,
  agent_id,
  caller_function,
  directive_hash,
  idempotency_key,
  request_hash,
  environment_digest,
  execution_request,
  manifest_ceiling,
  policy_limits_snapshot,
  authority_epoch,
  state,
  state_version,
  expires_at,
  started_at,
  finished_at,
  capacity_agent_id
) VALUES (
  '00000000-0000-0000-0000-000000001601',
  '00000000-0000-0000-0000-000000001101',
  '00000000-0000-0000-0000-000000001205',
  'transfer_fixture',
  repeat('a', 64),
  '00000000-0000-0000-0000-000000001701',
  repeat('b', 64),
  'sha256:' || repeat('c', 64),
  '{
    "argv":["true"],
    "tools":[],
    "secretBindingIds":[],
    "cwd":".",
    "stdin":{"kind":"none"},
    "capturePaths":[],
    "inputArtifacts":[],
    "timeoutMs":1000
  }'::jsonb,
  '{"allowedTools":[],"maxTimeoutMs":1000,"revision":"1"}'::jsonb,
  '{}'::jsonb,
  1,
  'succeeded',
  2,
  now() + interval '1 hour',
  now() - interval '4 minutes',
  now() - interval '3 minutes',
  '00000000-0000-0000-0000-000000001205'
);

INSERT INTO public.user_notifications (
  id,
  user_id,
  agent_id,
  kind,
  severity,
  title,
  body,
  action_url,
  dedupe_key
) VALUES
  (
    '00000000-0000-0000-0000-000000001503',
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001206',
    'agent_report',
    'info',
    'Delete fixture report',
    'Projection lifecycle fixture.',
    '/agents/operator-evidence-fixture?pane=alerts',
    'operator-home-evidence-fixture'
  ),
  (
    '00000000-0000-0000-0000-000000001504',
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001205',
    'agent_report',
    'info',
    'Transfer fixture report',
    'Projection ownership fixture.',
    '/agents/operator-transfer-fixture?pane=alerts',
    'operator-home-transfer-fixture'
  );

INSERT INTO public.notification_briefs (
  notification_id,
  user_id,
  agent_id,
  revision,
  source_hash
) VALUES
  (
    '00000000-0000-0000-0000-000000001504',
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001205',
    1,
    repeat('2', 64)
  );

INSERT INTO public.agent_search_source_revisions (
  user_id,
  agent_id,
  source_type,
  source_id,
  enqueue_generation,
  source_version
) VALUES
  (
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001204',
    'agent',
    '00000000-0000-0000-0000-000000001204',
    100100,
    'fixture-agent-source:100100'
  ),
  (
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001205',
    'agent',
    '00000000-0000-0000-0000-000000001205',
    100101,
    'fixture-agent-source:100101'
  )
ON CONFLICT (user_id, agent_id, source_type, source_id) DO UPDATE
SET
  enqueue_generation = EXCLUDED.enqueue_generation,
  source_version = EXCLUDED.source_version;

SELECT public.upsert_agent_search_document(
  '00000000-0000-0000-0000-000000001101',
  fixture.agent_id,
  'interface',
  'fixture',
  'Fixture Interface',
  fixture.breadcrumb,
  'Owner-private projection fixture.',
  fixture.route,
  ARRAY['fixture']::text[],
  'fixture-v1:' || fixture.generation::text,
  'agent',
  fixture.agent_id,
  fixture.generation
)
FROM (
  VALUES
    (
      '00000000-0000-0000-0000-000000001204'::uuid,
      'Operator Delete Fixture / Interfaces',
      '/agents/operator-delete-fixture?pane=interfaces&item=fixture',
      100100::bigint
    ),
    (
      '00000000-0000-0000-0000-000000001205'::uuid,
      'Operator Transfer Fixture / Interfaces',
      '/agents/operator-transfer-fixture?pane=interfaces&item=fixture',
      100101::bigint
    )
) AS fixture(agent_id, breadcrumb, route, generation);

SELECT lives_ok(
  $$
    DELETE FROM public.apps
    WHERE id = '00000000-0000-0000-0000-000000001204'
  $$,
  'hard Agent deletion succeeds when only rebuildable projections exist'
);

SELECT is(
  (
    SELECT
      (SELECT count(*) FROM public.notification_briefs
       WHERE agent_id = '00000000-0000-0000-0000-000000001204')
      + (SELECT count(*) FROM public.operator_projection_jobs
         WHERE agent_id = '00000000-0000-0000-0000-000000001204')
      + (SELECT count(*) FROM public.agent_search_documents
         WHERE agent_id = '00000000-0000-0000-0000-000000001204')
      + (SELECT count(*) FROM public.agent_search_subject_revisions
         WHERE agent_id = '00000000-0000-0000-0000-000000001204')
      + (SELECT count(*) FROM public.agent_search_source_revisions
         WHERE agent_id = '00000000-0000-0000-0000-000000001204')
  ),
  0::bigint,
  'hard Agent deletion cascades every rebuildable operator projection'
);

SELECT throws_like(
  $$
    DELETE FROM public.apps
    WHERE id = '00000000-0000-0000-0000-000000001206'
  $$,
  '%user_notifications_agent_id_fkey%',
  'hard Agent deletion is blocked while immutable notification evidence retains its attribution'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.apps
    WHERE id = '00000000-0000-0000-0000-000000001206'
  )
  AND EXISTS (
    SELECT 1 FROM public.user_notifications
    WHERE id = '00000000-0000-0000-0000-000000001503'
      AND agent_id = '00000000-0000-0000-0000-000000001206'
  ),
  'a rejected hard delete preserves both the Agent and its raw evidence attribution'
);

CREATE TEMP TABLE operator_transfer_fleet_revisions AS
SELECT
  (
    SELECT revision
    FROM public.user_fleet_preferences
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
  ) AS old_owner_revision,
  (
    SELECT revision
    FROM public.user_fleet_preferences
    WHERE user_id = '00000000-0000-0000-0000-000000001102'
  ) AS new_owner_revision;

SELECT lives_ok(
  $$
    UPDATE public.apps
    SET owner_id = '00000000-0000-0000-0000-000000001102'
    WHERE id = '00000000-0000-0000-0000-000000001205'
  $$,
  'Agent ownership transfer succeeds when old-owner projections exist'
);

SELECT ok(
  (
    SELECT
      old_fleet.revision = before.old_owner_revision + 1
      AND new_fleet.revision = before.new_owner_revision + 1
    FROM operator_transfer_fleet_revisions AS before
    JOIN public.user_fleet_preferences AS old_fleet
      ON old_fleet.user_id =
        '00000000-0000-0000-0000-000000001101'::uuid
    JOIN public.user_fleet_preferences AS new_fleet
      ON new_fleet.user_id =
        '00000000-0000-0000-0000-000000001102'::uuid
  ),
  'ownership transfer advances each affected owner Fleet revision exactly once'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.notification_briefs
    WHERE agent_id = '00000000-0000-0000-0000-000000001205'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.agent_search_documents
    WHERE agent_id = '00000000-0000-0000-0000-000000001205'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.operator_projection_jobs
    WHERE agent_id = '00000000-0000-0000-0000-000000001205'
      AND user_id = '00000000-0000-0000-0000-000000001101'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.agent_search_subject_revisions
    WHERE agent_id = '00000000-0000-0000-0000-000000001205'
      AND user_id = '00000000-0000-0000-0000-000000001101'
  ),
  'ownership transfer removes every old-owner rebuildable projection'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.operator_projection_jobs
    WHERE user_id = '00000000-0000-0000-0000-000000001102'
      AND agent_id = '00000000-0000-0000-0000-000000001205'
      AND job_kind = 'search_document'
      AND source_type = 'agent'
      AND source_id = '00000000-0000-0000-0000-000000001205'
  )
  AND EXISTS (
    SELECT 1 FROM public.user_agent_preferences
    WHERE user_id = '00000000-0000-0000-0000-000000001102'
      AND agent_id = '00000000-0000-0000-0000-000000001205'
  )
  AND EXISTS (
    SELECT 1 FROM public.agent_search_source_revisions
    WHERE user_id = '00000000-0000-0000-0000-000000001102'
      AND agent_id = '00000000-0000-0000-0000-000000001205'
      AND source_type = 'agent'
      AND source_id = '00000000-0000-0000-0000-000000001205'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.user_agent_preferences
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
      AND agent_id = '00000000-0000-0000-0000-000000001205'
  ),
  'ownership transfer seeds the new owner projection and Fleet membership'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.create_user_notification_episode(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001205',
      'routine_failed',
      'warning',
      'Former owner episode',
      'A former owner cannot create fresh Agent-attributed evidence.',
      'app',
      '00000000-0000-0000-0000-000000001205',
      '/agents/operator-transfer-fixture?pane=alerts',
      'operator-home-former-owner-episode'
    )
  $$,
  '23503',
  'notification_agent_owner_mismatch',
  'notification episode creation rejects attribution to another owner''s Agent'
);

SELECT lives_ok(
  $$
    SELECT *
    FROM public.transition_user_notification(
      '00000000-0000-0000-0000-000000001101',
      '00000000-0000-0000-0000-000000001504',
      'read',
      NULL,
      NULL
    )
  $$,
  'retained old-owner notification lifecycle changes skip projection enqueue'
);

SELECT lives_ok(
  $$
    DELETE FROM public.user_notifications
    WHERE id = '00000000-0000-0000-0000-000000001504'
  $$,
  'retained old-owner notification deletion skips projection tombstone enqueue'
);

SELECT lives_ok(
  $$
    UPDATE public.user_routines
    SET
      description = 'Mutated safely after the Agent transfer.',
      updated_at = now()
    WHERE id = '00000000-0000-0000-0000-000000001303'
  $$,
  'retained old-owner Routine mutation skips projection enqueue'
);

SELECT lives_ok(
  $$
    UPDATE public.routine_runs
    SET started_at = started_at + interval '1 second'
    WHERE id = '00000000-0000-0000-0000-000000001405'
  $$,
  'retained old-owner Routine run mutation skips projection enqueue'
);

SELECT lives_ok(
  $$
    UPDATE public.compute_runs
    SET updated_at = updated_at + interval '1 second'
    WHERE id = '00000000-0000-0000-0000-000000001601'
  $$,
  'retained old-owner Compute run mutation skips projection enqueue'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.operator_projection_jobs
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
      AND agent_id = '00000000-0000-0000-0000-000000001205'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.agent_search_source_revisions
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
      AND agent_id = '00000000-0000-0000-0000-000000001205'
  )
  AND EXISTS (
    SELECT 1
    FROM public.user_routines
    WHERE id = '00000000-0000-0000-0000-000000001303'
      AND description = 'Mutated safely after the Agent transfer.'
  )
  AND EXISTS (
    SELECT 1
    FROM public.routine_runs
    WHERE id = '00000000-0000-0000-0000-000000001405'
  )
  AND EXISTS (
    SELECT 1
    FROM public.compute_runs
    WHERE id = '00000000-0000-0000-0000-000000001601'
  ),
  'former-owner source mutations leave no cross-owner jobs or revision ledgers'
);

INSERT INTO public.user_notifications (
  id,
  user_id,
  agent_id,
  kind,
  severity,
  title,
  body,
  action_url,
  dedupe_key
) VALUES (
  '00000000-0000-0000-0000-000000001505',
  '00000000-0000-0000-0000-000000001101',
  '00000000-0000-0000-0000-000000001201',
  'agent_report',
  'info',
  'Disposable report',
  'Deletion must tombstone its Attention projection.',
  '/agents/operator-ready?pane=alerts',
  'operator-home-disposable-report'
);

DELETE FROM public.user_notifications
WHERE id = '00000000-0000-0000-0000-000000001505';

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.operator_projection_jobs
    WHERE user_id = '00000000-0000-0000-0000-000000001101'
      AND agent_id = '00000000-0000-0000-0000-000000001201'
      AND job_kind = 'search_document'
      AND source_type = 'notification'
      AND source_id = '00000000-0000-0000-0000-000000001505'
  ),
  1,
  'notification deletion captures one deterministic Attention tombstone event'
);

UPDATE public.user_routines
SET deleted_at = now()
WHERE id = '00000000-0000-0000-0000-000000001301';

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('00000000-0000-0000-0000-000000001401'::uuid),
        ('00000000-0000-0000-0000-000000001402'::uuid),
        ('00000000-0000-0000-0000-000000001403'::uuid),
        ('00000000-0000-0000-0000-000000001404'::uuid)
    ) AS expected(run_id)
    WHERE (
      SELECT count(*)
      FROM public.operator_projection_jobs
      WHERE job_kind = 'search_document'
        AND source_type = 'routine_run'
        AND source_id = expected.run_id
    ) < 2
  ),
  'soft Routine deletion captures tombstone generations for every existing run'
);

DELETE FROM public.user_routines
WHERE id = '00000000-0000-0000-0000-000000001301';

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.user_routines
    WHERE id = '00000000-0000-0000-0000-000000001301'
  )
  AND EXISTS (
    SELECT 1 FROM public.operator_projection_jobs
    WHERE job_kind = 'search_document'
      AND source_type = 'routine'
      AND source_id = '00000000-0000-0000-0000-000000001301'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('00000000-0000-0000-0000-000000001401'::uuid),
        ('00000000-0000-0000-0000-000000001402'::uuid),
        ('00000000-0000-0000-0000-000000001403'::uuid),
        ('00000000-0000-0000-0000-000000001404'::uuid)
    ) AS expected(run_id)
    WHERE (
      SELECT count(*)
      FROM public.operator_projection_jobs
      WHERE job_kind = 'search_document'
        AND source_type = 'routine_run'
        AND source_id = expected.run_id
    ) < 3
  ),
  'hard Routine deletion retains routine and run tombstone events after source cascades'
);

INSERT INTO public.user_notifications (
  user_id,
  agent_id,
  kind,
  severity,
  title,
  body,
  action_url,
  dedupe_key,
  created_at
)
SELECT
  '00000000-0000-0000-0000-000000001102',
  '00000000-0000-0000-0000-000000001203',
  CASE WHEN series_number % 4 = 0 THEN 'routine_failed' ELSE 'agent_report' END,
  CASE WHEN series_number % 4 = 0 THEN 'warning' ELSE 'info' END,
  'Bounded Attention fixture ' || series_number::text,
  'A real database row proving exact counts beyond the response page.',
  '/agents/operator-other-owner?pane=alerts',
  'operator-home-pagination-' || lpad(series_number::text, 3, '0'),
  '2026-07-23T12:00:00Z'::timestamptz
    + series_number * interval '1 second'
FROM generate_series(1, 205) AS series_number;

SELECT is(
  (
    SELECT jsonb_array_length(notifications)
    FROM public.get_owner_attention_snapshot(
      '00000000-0000-0000-0000-000000001102',
      '2027-01-01T00:00:00Z',
      200
    )
  ),
  200,
  'owner Attention snapshot bounds a real greater-than-200 result page at 200 rows'
);

SELECT is(
  (
    SELECT open_count::text || ':' || requires_decision_count::text
    FROM public.get_owner_attention_snapshot(
      '00000000-0000-0000-0000-000000001102',
      '2027-01-01T00:00:00Z',
      200
    )
  ),
  '205:51',
  'owner Attention snapshot counts all active rows and decisions beyond its bounded page'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.get_owner_attention_snapshot(
      '00000000-0000-0000-0000-000000001102',
      '2027-01-01T00:00:00Z',
      200
    ) AS snapshot
    CROSS JOIN LATERAL jsonb_array_elements(snapshot.notifications)
      WITH ORDINALITY AS page(notification, ordinal)
    WHERE page.notification->>'dedupe_key' <>
      'operator-home-pagination-' ||
        lpad((206 - page.ordinal)::text, 3, '0')
  ),
  'owner Attention snapshot returns the complete bounded page in stable newest-first order'
);

SELECT * FROM finish();
ROLLBACK;
