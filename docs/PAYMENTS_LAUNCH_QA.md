# Payments Launch QA

Use this checklist after the migration stack is applied in a disposable/staging database.

## Closed-Loop Copy

- Wallet Add Light states that external money enters only through Apple Pay / Google Pay or Stripe wire/bank transfer.
- Wallet Add Light states that purchased Light is spend-only platform credit.
- Wallet Earnings states that only unconverted creator earnings are payout eligible, and that earnings must be added to balance before spend.
- Wallet and MCP copy state that Light cannot be transferred directly between arbitrary accounts.
- All visible reference-rate copy uses `100 Light = $1` for the platform/payout reference, `95 Light / $1` for Apple Pay / Google Pay, and `99 Light / $1` for wire/bank transfer.
- Funding and payout actions show a Terms hook before the API request is made.

## Money In

- Apple Pay / Google Pay funding:
  - Confirm no raw-card form, Link fallback, PayPal, Klarna, or other wallet surfaces render.
  - Confirm the API rejects requests missing `terms_accepted=true`.
  - Create a $25 wallet PaymentIntent and confirm Stripe metadata includes `light_amount=2375`, `light_per_usd=95`, `funding_method=wallet_express_checkout`, and `terms_accepted=true`.
  - Replay the Stripe success event and confirm Light is credited only once.

- Wire/bank-transfer funding:
  - Confirm the API rejects requests missing `terms_accepted=true`.
  - Create a $500 wire PaymentIntent and confirm Stripe metadata includes `light_amount=49500`, `light_per_usd=99`, `funding_method=wire_transfer`, and `terms_accepted=true`.
  - Confirm the deposit remains pending before Stripe settlement.
  - Confirm partial funding updates pending state without crediting the full requested amount.
  - Confirm final settlement credits only the settled amount.

## Internal Light

- Spend purchased or converted Light on app calls, hosting, GPU, or marketplace actions and confirm it remains non-withdrawable.
- Confirm unconverted creator earnings cannot pay for app calls, cloud usage, hosting, GPU, or marketplace actions until converted.
- Complete a marketplace sale and confirm seller proceeds land in earned balance.
- Confirm direct arbitrary user-to-user Light transfer is not exposed through public, user, or MCP routes.

## Payouts

- Confirm payout request rejects missing `terms_accepted=true`.
- Confirm payout request rejects amounts above earned balance even when purchased balance is sufficient.
- Confirm a request made at least 21 days before the next first-business-day payout joins that run.
- Confirm a request inside the 21-day cutoff rolls to the following eligible run.
- Confirm payout processor records Stripe transfer state separately from Stripe payout state.
- Simulate transfer failure and payout failure; confirm both are visible in admin reconciliation and retryable.
- Confirm `GET /api/user/connect/liability` returns 403 and global liabilities are visible only through `GET /api/admin/payouts/reconciliation`.
