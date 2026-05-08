BEGIN;

SELECT plan(69);

CREATE TEMP TABLE marketplace_wave1_state (
  first_bid_id uuid,
  accepted_bid_id uuid,
  rival_bid_id uuid,
  conversion_id uuid,
  auto_transfer_id uuid,
  sale jsonb,
  instant_sale jsonb,
  payout_id uuid
);

CREATE TEMP TABLE marketplace_wave1_errors (
  message text
);

INSERT INTO marketplace_wave1_state DEFAULT VALUES;

INSERT INTO public.users (
  id,
  email,
  display_name,
  balance_light,
  escrow_light,
  total_earned_light,
  stripe_connect_account_id,
  stripe_connect_payouts_enabled
) VALUES
  (
    '00000000-0000-0000-0000-000000000101',
    'wave1-seller@example.test',
    'Wave 1 Seller',
    0,
    0,
    0,
    'acct_wave1_seller',
    true
  ),
  (
    '00000000-0000-0000-0000-000000000102',
    'wave1-buyer@example.test',
    'Wave 1 Buyer',
    10000,
    0,
    0,
    NULL,
    false
  ),
  (
    '00000000-0000-0000-0000-000000000103',
    'wave1-rival@example.test',
    'Wave 1 Rival',
    10000,
    0,
    0,
    NULL,
    false
  );

INSERT INTO public.users (
  id,
  email,
  display_name,
  balance_light,
  earned_balance_light,
  total_earned_light,
  auto_add_earnings_to_balance
) VALUES
  (
    '00000000-0000-0000-0000-000000000104',
    'wave1-earned-only@example.test',
    'Wave 1 Earned Only',
    0,
    2000,
    2000,
    false
  ),
  (
    '00000000-0000-0000-0000-000000000105',
    'wave1-auto-recipient@example.test',
    'Wave 1 Auto Recipient',
    0,
    0,
    0,
    true
  ),
  (
    '00000000-0000-0000-0000-000000000106',
    'wave1-auto-payer@example.test',
    'Wave 1 Auto Payer',
    1000,
    0,
    0,
    false
  );

INSERT INTO public.apps (
  id,
  owner_id,
  slug,
  name,
  storage_key,
  visibility,
  had_external_db
) VALUES
  (
    '00000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000101',
    'wave-one-app',
    'Wave One App',
    'apps/wave-one-app.zip',
    'public',
    false
  ),
  (
    '00000000-0000-0000-0000-000000000202',
    '00000000-0000-0000-0000-000000000101',
    'wave-two-app',
    'Wave Two App',
    'apps/wave-two-app.zip',
    'public',
    false
  ),
  (
    '00000000-0000-0000-0000-000000000203',
    '00000000-0000-0000-0000-000000000101',
    'wave-three-external-app',
    'Wave Three External App',
    'apps/wave-three-external-app.zip',
    'public',
    true
  );

INSERT INTO public.app_listings (
  app_id,
  owner_id,
  floor_price_light,
  show_metrics
) VALUES (
  '00000000-0000-0000-0000-000000000201',
  '00000000-0000-0000-0000-000000000101',
  1000,
  true
);

SELECT is(
  (SELECT show_metrics FROM public.app_listings WHERE app_id = '00000000-0000-0000-0000-000000000201'),
  true,
  'listings expose show_metrics for marketplace trust/metrics cards'
);

SELECT is(
  (SELECT balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000104'),
  0::numeric,
  'unconverted creator earnings do not count as spendable balance'
);

SELECT throws_like(
  $$
    SELECT *
    FROM public.debit_spendable_light(
      '00000000-0000-0000-0000-000000000104'::uuid,
      1,
      false
    )
  $$,
  'Insufficient available balance%',
  'unconverted creator earnings cannot fund spend'
);

UPDATE marketplace_wave1_state
SET conversion_id = c.conversion_id
FROM public.convert_earnings_to_deposit(
  '00000000-0000-0000-0000-000000000104'::uuid,
  250.5,
  'manual',
  'users',
  '00000000-0000-0000-0000-000000000104'::uuid,
  '{"source":"test"}'::jsonb
) AS c;

SELECT ok(
  (SELECT conversion_id IS NOT NULL FROM marketplace_wave1_state),
  'convert_earnings_to_deposit returns a conversion id'
);

SELECT is(
  (SELECT deposit_balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000104'),
  250.5::numeric,
  'earnings conversion credits spendable deposit bucket'
);

SELECT is(
  (SELECT balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000104'),
  250.5::numeric,
  'earnings conversion updates spendable balance'
);

SELECT is(
  (SELECT earned_balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000104'),
  1749.5::numeric,
  'earnings conversion debits unconverted earnings'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.light_ledger_entries
    WHERE reference_table = 'earnings_balance_conversions'
      AND reference_id = (SELECT conversion_id FROM marketplace_wave1_state)
  ),
  2,
  'earnings conversion writes balanced Light ledger entries'
);

UPDATE marketplace_wave1_state
SET auto_transfer_id = t.transfer_id
FROM public.transfer_light(
  '00000000-0000-0000-0000-000000000106'::uuid,
  '00000000-0000-0000-0000-000000000105'::uuid,
  1000,
  'tool_call'
) AS t;

SELECT ok(
  (SELECT auto_transfer_id IS NOT NULL FROM marketplace_wave1_state),
  'transfer_light returns a transfer id for auto-add recipient'
);

SELECT is(
  (SELECT balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000105'),
  850::numeric,
  'auto-add recipient receives net earnings as spendable balance'
);

SELECT is(
  (SELECT earned_balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000105'),
  0::numeric,
  'auto-add recipient has no unconverted earnings after transfer'
);

SELECT is(
  (SELECT total_earned_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000105'),
  850::numeric,
  'auto-add recipient still tracks lifetime earnings'
);

SELECT is(
  (
    SELECT source
    FROM public.earnings_balance_conversions
    WHERE user_id = '00000000-0000-0000-0000-000000000105'
    ORDER BY created_at DESC
    LIMIT 1
  ),
  'auto_earning',
  'auto-add records an automatic earnings conversion'
);

SELECT is(
  (SELECT balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000106'),
  0::numeric,
  'auto-add transfer still debits payer spendable balance'
);

UPDATE marketplace_wave1_state
SET first_bid_id = public.escrow_bid(
  '00000000-0000-0000-0000-000000000102',
  '00000000-0000-0000-0000-000000000201',
  4000,
  'Initial offer',
  NULL
);

SELECT ok(
  (SELECT first_bid_id IS NOT NULL FROM marketplace_wave1_state),
  'escrow_bid returns a bid id'
);

SELECT is(
  (SELECT balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  6000::numeric,
  'bidding moves Light out of spendable balance'
);

SELECT is(
  (SELECT escrow_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  4000::numeric,
  'bidding moves Light into escrow'
);

SELECT is(
  (SELECT deposit_balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  6000::numeric,
  'bidding debits purchased Light bucket first'
);

SELECT is(
  (SELECT escrow_deposit_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  4000::numeric,
  'bidding preserves purchased Light in escrow bucket'
);

SELECT is(
  (SELECT earned_balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  0::numeric,
  'bidding does not create withdrawable earnings for the bidder'
);

SELECT is(
  (SELECT amount_light::numeric FROM public.app_bids WHERE id = (SELECT first_bid_id FROM marketplace_wave1_state)),
  4000::numeric,
  'bid stores authoritative amount_light'
);

SELECT is(
  (SELECT amount_cents FROM public.app_bids WHERE id = (SELECT first_bid_id FROM marketplace_wave1_state)),
  4000,
  'bid keeps legacy amount_cents compatible'
);

SELECT public.cancel_bid(
  '00000000-0000-0000-0000-000000000102',
  (SELECT first_bid_id FROM marketplace_wave1_state)
);

SELECT is(
  (SELECT balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  10000::numeric,
  'cancel_bid returns escrow to spendable balance'
);

SELECT is(
  (SELECT escrow_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  0::numeric,
  'cancel_bid clears escrow'
);

SELECT is(
  (SELECT deposit_balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  10000::numeric,
  'cancel_bid returns escrow to purchased Light bucket'
);

SELECT is(
  (SELECT escrow_deposit_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  0::numeric,
  'cancel_bid clears purchased escrow bucket'
);

SELECT is(
  (SELECT status FROM public.app_bids WHERE id = (SELECT first_bid_id FROM marketplace_wave1_state)),
  'cancelled',
  'cancel_bid marks bid cancelled'
);

UPDATE marketplace_wave1_state
SET accepted_bid_id = public.escrow_bid(
  '00000000-0000-0000-0000-000000000102',
  '00000000-0000-0000-0000-000000000201',
  4000,
  'Accepted offer',
  NULL
);

UPDATE marketplace_wave1_state
SET rival_bid_id = public.escrow_bid(
  '00000000-0000-0000-0000-000000000103',
  '00000000-0000-0000-0000-000000000201',
  2500,
  'Competing offer',
  NULL
);

INSERT INTO public.user_app_permissions (
  app_id,
  granted_to_user_id,
  granted_by_user_id,
  function_name,
  allowed
) VALUES (
  '00000000-0000-0000-0000-000000000201',
  '00000000-0000-0000-0000-000000000103',
  '00000000-0000-0000-0000-000000000101',
  'run',
  true
);

INSERT INTO public.user_app_secrets (
  user_id,
  app_id,
  key,
  value_encrypted
) VALUES (
  '00000000-0000-0000-0000-000000000101',
  '00000000-0000-0000-0000-000000000201',
  'API_KEY',
  'encrypted'
);

UPDATE marketplace_wave1_state
SET sale = public.accept_bid(
  '00000000-0000-0000-0000-000000000101',
  (SELECT accepted_bid_id FROM marketplace_wave1_state)
);

SELECT ok(
  (SELECT sale->>'sale_id' IS NOT NULL FROM marketplace_wave1_state),
  'accept_bid returns a sale id'
);

SELECT is(
  (SELECT balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000101'),
  0::numeric,
  'accepted sale leaves seller payout unconverted from spendable balance'
);

SELECT is(
  (SELECT total_earned_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000101'),
  3400::numeric,
  'accepted sale tracks seller earned Light'
);

SELECT is(
  (SELECT earned_balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000101'),
  3400::numeric,
  'accepted sale credits seller withdrawable earned bucket'
);

SELECT is(
  (SELECT balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  6000::numeric,
  'accepted sale leaves buyer spendable balance debited'
);

SELECT is(
  (SELECT deposit_balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  6000::numeric,
  'accepted sale leaves buyer purchased bucket debited'
);

SELECT is(
  (SELECT escrow_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  0::numeric,
  'accepted sale releases buyer escrow'
);

SELECT is(
  (SELECT balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000103'),
  10000::numeric,
  'accepted sale refunds competing bidder balance'
);

SELECT is(
  (SELECT escrow_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000103'),
  0::numeric,
  'accepted sale clears competing bidder escrow'
);

SELECT is(
  (SELECT deposit_balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000103'),
  10000::numeric,
  'accepted sale returns competing bid to purchased bucket'
);

SELECT is(
  (SELECT owner_id::text FROM public.apps WHERE id = '00000000-0000-0000-0000-000000000201'),
  '00000000-0000-0000-0000-000000000102',
  'accepted sale transfers app ownership'
);

SELECT is(
  (SELECT status FROM public.app_bids WHERE id = (SELECT accepted_bid_id FROM marketplace_wave1_state)),
  'accepted',
  'accepted bid is marked accepted'
);

SELECT is(
  (SELECT status FROM public.app_bids WHERE id = (SELECT rival_bid_id FROM marketplace_wave1_state)),
  'rejected',
  'competing bid is marked rejected'
);

SELECT is(
  (SELECT COUNT(*)::integer FROM public.user_app_permissions WHERE app_id = '00000000-0000-0000-0000-000000000201'),
  0,
  'accepted sale clears app permission grants'
);

SELECT is(
  (SELECT COUNT(*)::integer FROM public.user_app_secrets WHERE app_id = '00000000-0000-0000-0000-000000000201'),
  0,
  'accepted sale clears app secrets'
);

SELECT is(
  (SELECT sale_price_light::numeric FROM public.app_sales WHERE id = ((SELECT sale FROM marketplace_wave1_state)->>'sale_id')::uuid),
  4000::numeric,
  'sale record stores Light sale price'
);

SELECT is(
  (SELECT sale_price_cents FROM public.app_sales WHERE id = ((SELECT sale FROM marketplace_wave1_state)->>'sale_id')::uuid),
  4000,
  'sale record keeps legacy sale_price_cents compatible'
);

SELECT is(
  (
    SELECT amount_light::numeric
    FROM public.transfers
    WHERE app_id = '00000000-0000-0000-0000-000000000201'
      AND reason = 'marketplace_sale'
  ),
  3400::numeric,
  'accepted sale logs seller payout transfer'
);

SELECT ok(
  (
    SELECT COUNT(*) > 0
    FROM public.light_ledger_entries
    WHERE user_id = '00000000-0000-0000-0000-000000000101'
      AND kind = 'marketplace_sale_earning'
      AND bucket = 'earned'
      AND amount_light = 3400
  ),
  'accepted sale logs immutable earned Light ledger entry'
);

SELECT is(
  (SELECT status FROM public.app_listings WHERE app_id = '00000000-0000-0000-0000-000000000201'),
  'sold',
  'accepted sale marks listing sold'
);

INSERT INTO public.app_listings (
  app_id,
  owner_id,
  ask_price_light,
  instant_buy
) VALUES (
  '00000000-0000-0000-0000-000000000202',
  '00000000-0000-0000-0000-000000000101',
  3000,
  true
);

UPDATE marketplace_wave1_state
SET instant_sale = public.buy_now(
  '00000000-0000-0000-0000-000000000102',
  '00000000-0000-0000-0000-000000000202'
);

SELECT ok(
  (SELECT instant_sale->>'sale_id' IS NOT NULL FROM marketplace_wave1_state),
  'buy_now returns a sale id'
);

SELECT is(
  (SELECT balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  3000::numeric,
  'buy_now debits buyer spendable balance without transient escrow'
);

SELECT is(
  (SELECT deposit_balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  3000::numeric,
  'buy_now debits buyer purchased bucket'
);

SELECT is(
  (SELECT escrow_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000102'),
  0::numeric,
  'buy_now leaves buyer escrow unchanged'
);

SELECT is(
  (SELECT balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000101'),
  0::numeric,
  'buy_now leaves seller payout unconverted from spendable balance'
);

SELECT is(
  (SELECT earned_balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000101'),
  5950::numeric,
  'buy_now credits seller earned bucket'
);

SELECT is(
  (SELECT owner_id::text FROM public.apps WHERE id = '00000000-0000-0000-0000-000000000202'),
  '00000000-0000-0000-0000-000000000102',
  'buy_now transfers app ownership'
);

SELECT is(
  (SELECT sale_price_light::numeric FROM public.app_sales WHERE id = ((SELECT instant_sale FROM marketplace_wave1_state)->>'sale_id')::uuid),
  3000::numeric,
  'buy_now records sale price'
);

DO $$
BEGIN
  PERFORM public.escrow_bid(
    '00000000-0000-0000-0000-000000000102',
    '00000000-0000-0000-0000-000000000203',
    1000,
    NULL,
    NULL
  );
EXCEPTION WHEN OTHERS THEN
  INSERT INTO marketplace_wave1_errors (message) VALUES (SQLERRM);
END;
$$;

SELECT ok(
  (SELECT message LIKE '%external database%' FROM marketplace_wave1_errors LIMIT 1),
  'external database apps cannot receive bids'
);

UPDATE public.users
SET escrow_light = 500
WHERE id = '00000000-0000-0000-0000-000000000101';

UPDATE marketplace_wave1_state
SET payout_id = public.create_payout_record(
  '00000000-0000-0000-0000-000000000101',
  5650,
  25,
  5625
);

SELECT ok(
  (SELECT payout_id IS NOT NULL FROM marketplace_wave1_state),
  'create_payout_record allows spendable balance even when escrow exists separately'
);

SELECT is(
  (SELECT balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000101'),
  0::numeric,
  'withdrawal leaves spendable balance unchanged'
);

SELECT is(
  (SELECT earned_balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000101'),
  300::numeric,
  'withdrawal debits earned bucket only'
);

SELECT is(
  (SELECT deposit_balance_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000101'),
  0::numeric,
  'withdrawal leaves purchased bucket unchanged'
);

SELECT is(
  (SELECT escrow_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000101'),
  500::numeric,
  'withdrawal leaves escrow bucket untouched'
);

SELECT is(
  (SELECT escrow_deposit_light::numeric FROM public.users WHERE id = '00000000-0000-0000-0000-000000000101'),
  500::numeric,
  'withdrawal leaves purchased escrow bucket untouched'
);

SELECT is(
  (SELECT amount_light::numeric FROM public.payouts WHERE id = (SELECT payout_id FROM marketplace_wave1_state)),
  5650::numeric,
  'payout record stores Light amount'
);

SELECT ok(
  (
    SELECT scheduled_payout_date IS NOT NULL AND payout_run_id IS NOT NULL
    FROM public.payouts
    WHERE id = (SELECT payout_id FROM marketplace_wave1_state)
  ),
  'payout record stores monthly run metadata'
);

SELECT ok(
  (
    SELECT release_at::date = scheduled_payout_date
    FROM public.payouts
    WHERE id = (SELECT payout_id FROM marketplace_wave1_state)
  ),
  'payout release timestamp matches the scheduled monthly run date'
);

SELECT is(
  (
    SELECT payout_cutoff_at
    FROM public.payouts
    WHERE id = (SELECT payout_id FROM marketplace_wave1_state)
  ),
  (
    SELECT release_at - interval '21 days'
    FROM public.payouts
    WHERE id = (SELECT payout_id FROM marketplace_wave1_state)
  ),
  'payout cutoff is 21 days before the scheduled run'
);

SELECT is(
  (SELECT payout_policy_version FROM public.payouts WHERE id = (SELECT payout_id FROM marketplace_wave1_state)),
  1,
  'payout record snapshots the monthly payout policy version'
);

SELECT is(
  (
    SELECT amount_light::numeric
    FROM public.transfers
    WHERE reason = 'withdrawal'
      AND from_user_id = '00000000-0000-0000-0000-000000000101'
    ORDER BY created_at DESC
    LIMIT 1
  ),
  5650::numeric,
  'withdrawal logs Light transfer'
);

DELETE FROM marketplace_wave1_errors;

DO $$
BEGIN
  PERFORM public.create_payout_record(
    '00000000-0000-0000-0000-000000000103',
    1000,
    25,
    975
  );
EXCEPTION WHEN OTHERS THEN
  INSERT INTO marketplace_wave1_errors (message) VALUES (SQLERRM);
END;
$$;

SELECT ok(
  (SELECT message LIKE '%Only earned funds%' FROM marketplace_wave1_errors LIMIT 1),
  'purchased Light cannot be withdrawn'
);

SELECT * FROM finish();

ROLLBACK;
