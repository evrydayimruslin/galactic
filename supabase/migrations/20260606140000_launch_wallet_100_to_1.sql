-- Launch wallet funding now credits all user top-ups at the canonical
-- 100 Light / $1 rate. Stripe processing fees are passed through separately
-- by the launch PaymentIntent gross-up metadata.

ALTER TABLE public.platform_billing_config
  ALTER COLUMN wallet_light_per_usd SET DEFAULT 100,
  ALTER COLUMN wire_light_per_usd SET DEFAULT 100;

UPDATE public.platform_billing_config
SET
  canonical_light_per_usd = 100,
  wallet_light_per_usd = 100,
  wire_light_per_usd = 100,
  payout_light_per_usd = 100,
  updated_at = now()
WHERE id = 'singleton';

ALTER TABLE public.light_deposits
  ALTER COLUMN light_per_usd_snapshot SET DEFAULT 100;
