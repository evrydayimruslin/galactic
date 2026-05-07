BEGIN;

SELECT plan(33);

CREATE TEMP TABLE cloud_usage_test_state (
  debit_event_id uuid,
  hold_id uuid,
  settle_event_id uuid,
  release_hold_id uuid,
  release_amount double precision,
  fallback_hold_id uuid,
  fallback_payer_user_id uuid,
  fallback_sponsor_user_id uuid,
  fallback_free_call boolean,
  fallback_app_charge_light double precision
);

INSERT INTO cloud_usage_test_state DEFAULT VALUES;

INSERT INTO public.users (
  id,
  email,
  display_name,
  balance_light,
  escrow_light,
  total_earned_light
) VALUES
  (
    '00000000-0000-0000-0000-000000006101',
    'cloud-payer@example.test',
    'Cloud Payer',
    1,
    0,
    0
  ),
  (
    '00000000-0000-0000-0000-000000006102',
    'cloud-owner@example.test',
    'Cloud Owner',
    0,
    0,
    0
  ),
  (
    '00000000-0000-0000-0000-000000006103',
    'cloud-caller@example.test',
    'Cloud Caller',
    1,
    0,
    0
  ),
  (
    '00000000-0000-0000-0000-000000006104',
    'cloud-empty-caller@example.test',
    'Cloud Empty Caller',
    0,
    0,
    0
  );

INSERT INTO public.apps (
  id,
  owner_id,
  slug,
  name,
  storage_key,
  visibility,
  had_external_db
) VALUES (
  '00000000-0000-0000-0000-000000006201',
  '00000000-0000-0000-0000-000000006102',
  'cloud-usage-ledger-app',
  'Cloud Usage Ledger App',
  'apps/cloud-usage-ledger-app.zip',
  'public',
  false
);

SELECT throws_like(
  $$
    SELECT *
    FROM public.debit_cloud_usage(
      '00000000-0000-0000-0000-000000006101'::uuid,
      'mcp',
      'worker_execution',
      1,
      1,
      1.001,
      NULL,
      '00000000-0000-0000-0000-000000006103'::uuid,
      '00000000-0000-0000-0000-000000006102'::uuid,
      '00000000-0000-0000-0000-000000006201'::uuid,
      'run',
      'cloud-too-large',
      1,
      '{}'::jsonb
    )
  $$,
  'Insufficient available balance%',
  'debit_cloud_usage refuses partial cloud usage debit'
);

SELECT is(
  (SELECT count(*)::integer FROM public.cloud_usage_events WHERE receipt_id = 'cloud-too-large'),
  0,
  'failed cloud usage debit records no usage event'
);

UPDATE cloud_usage_test_state
SET debit_event_id = d.event_id
FROM public.debit_cloud_usage(
  '00000000-0000-0000-0000-000000006101'::uuid,
  'mcp',
  'worker_execution',
  1,
  1,
  0.001,
  NULL,
  '00000000-0000-0000-0000-000000006103'::uuid,
  '00000000-0000-0000-0000-000000006102'::uuid,
  '00000000-0000-0000-0000-000000006201'::uuid,
  'run',
  'cloud-debit',
  1,
  '{"trace_id":"cloud-debit"}'::jsonb
) AS d;

SELECT ok(
  (SELECT debit_event_id IS NOT NULL FROM cloud_usage_test_state),
  'debit_cloud_usage returns an event id'
);

SELECT is(
  (SELECT round(balance_light::numeric, 3) FROM public.users WHERE id = '00000000-0000-0000-0000-000000006101'),
  0.999::numeric,
  'cloud usage debit subtracts exact fractional Light'
);

SELECT is(
  (SELECT amount_light::numeric FROM public.cloud_usage_events WHERE id = (SELECT debit_event_id FROM cloud_usage_test_state)),
  0.001::numeric,
  'cloud usage event records fractional debit amount'
);

SELECT is(
  (SELECT receipt_id FROM public.cloud_usage_events WHERE id = (SELECT debit_event_id FROM cloud_usage_test_state)),
  'cloud-debit',
  'cloud usage event stores receipt id'
);

SELECT is(
  (
    SELECT amount_light::numeric
    FROM public.light_ledger_entries
    WHERE reference_table = 'cloud_usage_events'
      AND reference_id = (SELECT debit_event_id FROM cloud_usage_test_state)
      AND bucket = 'deposit'
  ),
  -0.001::numeric,
  'cloud usage debit writes a matching Light ledger entry'
);

SELECT is(
  (
    SELECT round(amount_light::numeric, 3)
    FROM public.cloud_usage_rollups
    WHERE payer_user_id = '00000000-0000-0000-0000-000000006101'
      AND app_id = '00000000-0000-0000-0000-000000006201'
      AND resource = 'worker_execution'
  ),
  0.001::numeric,
  'cloud usage debit updates rollups'
);

UPDATE cloud_usage_test_state
SET hold_id = h.hold_id
FROM public.create_cloud_usage_hold(
  '00000000-0000-0000-0000-000000006101'::uuid,
  'mcp',
  'worker_execution',
  500,
  500,
  0.5,
  NULL,
  '00000000-0000-0000-0000-000000006103'::uuid,
  '00000000-0000-0000-0000-000000006102'::uuid,
  '00000000-0000-0000-0000-000000006201'::uuid,
  'run',
  'cloud-hold',
  now() + interval '5 minutes',
  1,
  '{"trace_id":"cloud-hold"}'::jsonb
) AS h;

SELECT ok(
  (SELECT hold_id IS NOT NULL FROM cloud_usage_test_state),
  'create_cloud_usage_hold returns a hold id'
);

SELECT is(
  (SELECT round(balance_light::numeric, 3) FROM public.users WHERE id = '00000000-0000-0000-0000-000000006101'),
  0.499::numeric,
  'cloud usage hold reserves spendable Light'
);

SELECT is(
  (SELECT held_amount_light::numeric FROM public.cloud_usage_holds WHERE id = (SELECT hold_id FROM cloud_usage_test_state)),
  0.5::numeric,
  'cloud usage hold stores held amount'
);

SELECT is(
  (
    SELECT amount_light::numeric
    FROM public.light_ledger_entries
    WHERE reference_table = 'cloud_usage_holds'
      AND reference_id = (SELECT hold_id FROM cloud_usage_test_state)
      AND bucket = 'deposit'
      AND kind = 'cloud_usage_hold'
  ),
  -0.5::numeric,
  'cloud usage hold writes a reservation ledger entry'
);

UPDATE cloud_usage_test_state
SET
  settle_event_id = s.event_id,
  release_amount = s.released_amount_light
FROM public.settle_cloud_usage_hold(
  (SELECT hold_id FROM cloud_usage_test_state),
  200,
  200,
  0.2,
  '{"status":"ok"}'::jsonb
) AS s;

SELECT ok(
  (SELECT settle_event_id IS NOT NULL FROM cloud_usage_test_state),
  'settle_cloud_usage_hold returns a settlement event id'
);

SELECT is(
  (SELECT round(release_amount::numeric, 3) FROM cloud_usage_test_state),
  0.3::numeric,
  'settling below held amount releases unused Light'
);

SELECT is(
  (SELECT round(balance_light::numeric, 3) FROM public.users WHERE id = '00000000-0000-0000-0000-000000006101'),
  0.799::numeric,
  'hold settlement refunds unused Light'
);

SELECT is(
  (SELECT status FROM public.cloud_usage_holds WHERE id = (SELECT hold_id FROM cloud_usage_test_state)),
  'settled',
  'settled cloud usage hold is closed'
);

SELECT is(
  (SELECT hold_id FROM public.cloud_usage_events WHERE id = (SELECT settle_event_id FROM cloud_usage_test_state)),
  (SELECT hold_id FROM cloud_usage_test_state),
  'settlement event links back to the hold'
);

SELECT is(
  (
    SELECT round(amount_light::numeric, 3)
    FROM public.cloud_usage_rollups
    WHERE payer_user_id = '00000000-0000-0000-0000-000000006101'
      AND app_id = '00000000-0000-0000-0000-000000006201'
      AND resource = 'worker_execution'
  ),
  0.201::numeric,
  'hold settlement updates the same cloud usage rollup'
);

UPDATE cloud_usage_test_state
SET release_hold_id = h.hold_id
FROM public.create_cloud_usage_hold(
  '00000000-0000-0000-0000-000000006101'::uuid,
  'mcp',
  'worker_execution',
  100,
  100,
  0.1,
  NULL,
  '00000000-0000-0000-0000-000000006103'::uuid,
  '00000000-0000-0000-0000-000000006102'::uuid,
  '00000000-0000-0000-0000-000000006201'::uuid,
  'run',
  'cloud-release',
  now() + interval '5 minutes',
  1,
  '{"trace_id":"cloud-release"}'::jsonb
) AS h;

SELECT ok(
  (SELECT release_hold_id IS NOT NULL FROM cloud_usage_test_state),
  'second cloud usage hold can be created for release path'
);

SELECT is(
  (SELECT round(balance_light::numeric, 3) FROM public.users WHERE id = '00000000-0000-0000-0000-000000006101'),
  0.699::numeric,
  'second cloud usage hold reserves Light before release'
);

UPDATE cloud_usage_test_state
SET release_amount = r.released_amount_light
FROM public.release_cloud_usage_hold(
  (SELECT release_hold_id FROM cloud_usage_test_state),
  '{"reason":"abort"}'::jsonb
) AS r;

SELECT is(
  (SELECT round(release_amount::numeric, 3) FROM cloud_usage_test_state),
  0.1::numeric,
  'release_cloud_usage_hold returns the held amount'
);

SELECT is(
  (SELECT round(balance_light::numeric, 3) FROM public.users WHERE id = '00000000-0000-0000-0000-000000006101'),
  0.799::numeric,
  'release_cloud_usage_hold refunds the full hold'
);

SELECT is(
  (SELECT status FROM public.cloud_usage_holds WHERE id = (SELECT release_hold_id FROM cloud_usage_test_state)),
  'released',
  'released cloud usage hold is closed'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.light_ledger_entries
    WHERE reference_table = 'cloud_usage_holds'
      AND reference_id = (SELECT release_hold_id FROM cloud_usage_test_state)
      AND kind = 'cloud_usage_hold_release'
  ),
  1,
  'released cloud usage hold writes a release ledger entry'
);

UPDATE cloud_usage_test_state
SET
  fallback_hold_id = h.hold_id,
  fallback_payer_user_id = h.payer_user_id,
  fallback_sponsor_user_id = h.sponsor_user_id,
  fallback_free_call = h.free_call,
  fallback_app_charge_light = h.app_charge_light
FROM public.create_app_call_runtime_cloud_hold(
  '00000000-0000-0000-0000-000000006103'::uuid,
  '00000000-0000-0000-0000-000000006102'::uuid,
  '00000000-0000-0000-0000-000000006201'::uuid,
  'run',
  'cloud-runtime-caller-fallback',
  'tools/call',
  120,
  120,
  0.12,
  0,
  0,
  NULL,
  now() + interval '5 minutes',
  1,
  '{"trace_id":"cloud-runtime-caller-fallback"}'::jsonb
) AS h;

SELECT ok(
  (SELECT fallback_hold_id IS NOT NULL FROM cloud_usage_test_state),
  'runtime cloud hold falls back to caller when owner sponsor has no Light'
);

SELECT is(
  (SELECT fallback_payer_user_id FROM cloud_usage_test_state),
  '00000000-0000-0000-0000-000000006103'::uuid,
  'caller-funded fallback charges the caller'
);

SELECT is(
  (SELECT fallback_sponsor_user_id FROM cloud_usage_test_state),
  NULL::uuid,
  'caller-funded fallback clears owner sponsor id'
);

SELECT is(
  (SELECT fallback_free_call FROM cloud_usage_test_state),
  true,
  'caller-funded fallback keeps the app call free'
);

SELECT is(
  (SELECT fallback_app_charge_light::numeric FROM cloud_usage_test_state),
  0::numeric,
  'caller-funded fallback keeps app charge at zero'
);

SELECT is(
  (
    SELECT round(balance_light::numeric, 3)
    FROM public.users
    WHERE id = '00000000-0000-0000-0000-000000006103'
  ),
  0.88::numeric,
  'caller-funded fallback reserves caller Light for infra'
);

SELECT is(
  (
    SELECT metadata->>'caller_infra_fallback'
    FROM public.cloud_usage_holds
    WHERE id = (SELECT fallback_hold_id FROM cloud_usage_test_state)
  ),
  'true',
  'caller-funded fallback stores metadata flag'
);

SELECT is(
  (
    SELECT metadata->>'payer_role'
    FROM public.cloud_usage_holds
    WHERE id = (SELECT fallback_hold_id FROM cloud_usage_test_state)
  ),
  'caller_infra_fallback',
  'caller-funded fallback stores payer role'
);

SELECT throws_like(
  $$
    SELECT *
    FROM public.create_app_call_runtime_cloud_hold(
      '00000000-0000-0000-0000-000000006104'::uuid,
      '00000000-0000-0000-0000-000000006102'::uuid,
      '00000000-0000-0000-0000-000000006201'::uuid,
      'run',
      'cloud-runtime-caller-fallback-empty',
      'tools/call',
      120,
      120,
      0.12,
      0,
      0,
      NULL,
      now() + interval '5 minutes',
      1,
      '{"trace_id":"cloud-runtime-caller-fallback-empty"}'::jsonb
    )
  $$,
  'caller_infra_fallback_light_required:%',
  'runtime cloud hold gates when owner and caller both lack Light'
);

SELECT * FROM finish();

ROLLBACK;
