BEGIN;

SELECT plan(14);

INSERT INTO public.users (
  id,
  email,
  display_name,
  balance_light,
  escrow_light,
  total_earned_light
) VALUES
  (
    '00000000-0000-0000-0000-000000007101',
    'tax-buyer@example.test',
    'Tax Buyer',
    1000,
    0,
    0
  ),
  (
    '00000000-0000-0000-0000-000000007102',
    'tax-seller@example.test',
    'Tax Seller',
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
  '00000000-0000-0000-0000-000000007201',
  '00000000-0000-0000-0000-000000007102',
  'tax-test-app',
  'Tax Test App',
  'apps/tax-test-app',
  'public',
  false
);

SELECT is(
  (SELECT publish_deposit_enabled FROM public.platform_billing_config WHERE id = 'singleton'),
  true,
  'PR27 enables the publish Light balance gate'
);

SELECT ok(
  ((
    SELECT column_default::text
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'platform_billing_config'
      AND column_name = 'publish_deposit_enabled'
  ) LIKE '%true%'),
  'publish Light balance gate defaults to enabled'
);

SELECT ok(
  (
    public.upsert_current_user_billing_address(
      '00000000-0000-0000-0000-000000007101',
      'Tax Buyer',
      '123 Compute Way',
      NULL,
      'New York',
      'NY',
      '10001',
      'us',
      'wallet_funding',
      'cus_tax_buyer'
    )
  ).id IS NOT NULL,
  'upsert_current_user_billing_address creates a billing address'
);

SELECT is(
  (SELECT version FROM public.user_billing_addresses WHERE user_id = '00000000-0000-0000-0000-000000007101' AND is_current),
  1,
  'first billing address version is current version 1'
);

SELECT is(
  (SELECT country FROM public.user_billing_addresses WHERE user_id = '00000000-0000-0000-0000-000000007101' AND is_current),
  'US',
  'billing address country is normalized to uppercase'
);

SELECT lives_ok(
  $$
    SELECT public.upsert_current_user_billing_address(
      '00000000-0000-0000-0000-000000007101',
      'Tax Buyer',
      '123 Compute Way',
      NULL,
      'New York',
      'NY',
      '10001',
      'US',
      'wire_funding',
      'cus_tax_buyer'
    )
  $$,
  'upserting identical address reuses the current version'
);

SELECT is(
  (SELECT count(*)::integer FROM public.user_billing_addresses WHERE user_id = '00000000-0000-0000-0000-000000007101'),
  1,
  'identical billing address does not create a new version'
);

SELECT lives_ok(
  $$
    SELECT public.upsert_current_user_billing_address(
      '00000000-0000-0000-0000-000000007101',
      'Tax Buyer',
      '456 Ledger Lane',
      NULL,
      'New York',
      'NY',
      '10001',
      'US',
      'manual',
      'cus_tax_buyer'
    )
  $$,
  'changed billing address creates a new current version'
);

SELECT is(
  (SELECT version FROM public.user_billing_addresses WHERE user_id = '00000000-0000-0000-0000-000000007101' AND is_current),
  2,
  'changed billing address advances the current version'
);

INSERT INTO public.mcp_call_logs (
  id,
  user_id,
  app_id,
  function_name,
  method,
  success,
  app_price_light,
  app_charge_light
) VALUES (
  '00000000-0000-0000-0000-000000007301',
  '00000000-0000-0000-0000-000000007101',
  '00000000-0000-0000-0000-000000007201',
  'run',
  'tools/call',
  true,
  10,
  10
);

SELECT is(
  (SELECT buyer_billing_address_version FROM public.mcp_call_logs WHERE id = '00000000-0000-0000-0000-000000007301'),
  2,
  'call receipts snapshot the buyer billing address version'
);

INSERT INTO public.light_deposits (
  user_id,
  status,
  funding_method,
  requested_amount_cents,
  requested_light,
  stripe_payment_intent_id
) VALUES (
  '00000000-0000-0000-0000-000000007101',
  'pending',
  'wallet_express_checkout',
  2500,
  2375,
  'pi_tax_test'
);

SELECT is(
  (SELECT buyer_billing_address_version FROM public.light_deposits WHERE stripe_payment_intent_id = 'pi_tax_test'),
  2,
  'Light deposits snapshot the buyer billing address version'
);

INSERT INTO public.app_sales (
  app_id,
  seller_id,
  buyer_id,
  sale_price_cents,
  platform_fee_cents,
  seller_payout_cents,
  sale_price_light,
  platform_fee_light,
  seller_payout_light
) VALUES (
  '00000000-0000-0000-0000-000000007201',
  '00000000-0000-0000-0000-000000007102',
  '00000000-0000-0000-0000-000000007101',
  100,
  15,
  85,
  100,
  15,
  85
);

SELECT is(
  (
    SELECT buyer_billing_address_version
    FROM public.app_sales
    WHERE app_id = '00000000-0000-0000-0000-000000007201'
  ),
  2,
  'marketplace sale receipts snapshot the buyer billing address version'
);

SELECT is(
  (
    SELECT tax_status
    FROM public.mcp_call_logs
    WHERE id = '00000000-0000-0000-0000-000000007301'
  ),
  'not_collecting',
  'new receipts default to tax not_collecting'
);

SELECT throws_like(
  $$
    SELECT public.upsert_current_user_billing_address(
      '00000000-0000-0000-0000-000000007101',
      'Tax Buyer',
      '789 Missing State Ave',
      NULL,
      'New York',
      NULL,
      '10001',
      'US',
      'manual',
      NULL
    )
  $$,
  '%state is required%',
  'US billing addresses require state'
);

SELECT * FROM finish();

ROLLBACK;
