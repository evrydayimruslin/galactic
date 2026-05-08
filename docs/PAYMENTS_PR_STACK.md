# Payments PR Stack

This stack moves Ultralight toward a closed-loop Light economy:

- External money enters only through Apple Pay / Google Pay wallet funding or Stripe bank-transfer/wire funding.
- Purchased Light is platform credit and is not cash-out eligible.
- Internal activity happens in Light.
- Creator earnings can be paid out through scheduled Stripe Connect payouts.
- There is no arbitrary user-to-user Light transfer route.

## PR 1: Billing Economics Config

Create a canonical, admin-controlled billing configuration for Light economics and payout policy copy.

Scope:

- Add a singleton billing config record with canonical Light/USD, wallet funding, wire funding, payout redemption, platform fee, minimum withdrawal, and payout-policy copy.
- Expose public read-only billing config for UI copy and calculations.
- Expose service-role admin read/update endpoints.
- Snapshot active rates on current payout/deposit records where those records exist today.
- Replace stale visible Light-ratio copy, especially the legacy `800:1` wording.

Acceptance:

- UI and API copy consistently use `100 Light = $1` as the canonical/payout reference.
- Wallet funding rate is `95 Light / $1`.
- Wire funding rate is `99 Light / $1`.
- Current payout records can carry a redemption-rate snapshot.

## PR 2: Clean Balance/Earnings Buckets

Make Roblox-style economics mechanically enforced.

Scope:

- Split purchased balance, earned balance, and escrowed holds.
- Add immutable Light ledger entries.
- Ensure deposits cannot be paid out.
- Ensure earnings can be added to spendable balance or paid out.
- Preserve escrow source buckets through bid cancellation/rejection/sale.

Acceptance:

- Purchased Light is spend-only.
- Earned Light is withdrawable subject to payout policy until it is converted into spendable balance.
- Marketplace sale converts buyer Light into seller earned Light.

## PR 3: Internal Light Movement Migration

Move all platform-mediated Light movement to bucket-aware RPCs.

Scope:

- Update hosting/storage debits.
- Update app-call settlement.
- Update GPU developer fee settlement.
- Update marketplace buy, bid, accept, cancel, and refund paths.
- Keep arbitrary P2P transfer unavailable.

Acceptance:

- Every Light mutation is ledger-backed.
- No external route can transfer Light directly between arbitrary users.

## PR 4: Durable Stripe Event and Deposit Ledger

Make Stripe money-in idempotent and auditable.

Scope:

- Add a durable `stripe_events` table keyed by Stripe event ID.
- Add a `light_deposits` table for pending/succeeded/failed funding.
- Replace in-memory webhook idempotency.
- Handle success, failure, partial funding, async bank-transfer events, refunds, and disputes.

Acceptance:

- Replaying a Stripe event cannot double-credit Light.
- Wire/bank-transfer deposits stay pending until Stripe confirms settlement.

## PR 5: Shared Payment Portal Shell

Create one wallet/payment portal mirrored by website and desktop app.

Scope:

- Build the canonical wallet route for balance, Add Light, earnings, payout setup, payout history, and policy copy.
- Embed the same route in desktop.
- Remove prompt/confirm payment flows.
- Remove stale auto-top-up and raw-card language.

Acceptance:

- Desktop and web show the same payment methods, rates, and payout policy.

## PR 6: Apple Pay / Google Pay Funding

Make wallet buttons the only card-like funding surface.

Scope:

- Use Stripe Express Checkout Element.
- Mount Apple Pay / Google Pay wallet buttons only.
- No raw card form and no Link fallback.
- Credit at `95 Light / $1` using the durable deposit finalizer.

Acceptance:

- Wallet funding works on eligible devices/browsers.
- If wallet buttons are unavailable, users are directed to wire transfer.

## PR 7: Stripe Wire / Bank Transfer Funding

Add Stripe customer-balance bank-transfer funding.

Scope:

- Create/retrieve Stripe bank-transfer funding instructions.
- Track pending funding records.
- Credit at `99 Light / $1` only after async success.
- Handle partial funding and failed/expired states.

Acceptance:

- Wire deposits never credit Light before settlement.

## PR 8: Monthly Payout Policy

Replace rolling 14-day payout release with the business policy.

Scope:

- Add payout runs, cutoff dates, scheduled release dates, and policy version snapshots.
- Process payouts on the first business day of each month.
- Include only requests made at least 21 days before the run.

Acceptance:

- Requests inside the 21-day cutoff roll to the next eligible month.
- User settings clearly explain the policy.

## PR 9: Payout Processor and Reconciliation Hardening

Make Stripe Connect payout operations inspectable and retryable.

Scope:

- Process by payout run.
- Track Stripe transfer and Stripe payout states separately.
- Add admin reconciliation for liabilities, held payouts, processing payouts, and Stripe balance.
- Lock global liability views behind service/admin access.

Acceptance:

- Transfer/payout failures are visible and retryable.

## PR 10: Policy Copy, Terms Hooks, and Launch QA

Make the economy understandable and launch-testable.

Scope:

- Add consistent copy for purchased Light, creator earnings, payouts, and no P2P transfers.
- Hook Terms/ToS copy into the wallet and payout flows.
- Add launch QA for wallet funding, wire funding, duplicate webhooks, marketplace earnings, and payout cutoff dates.

Acceptance:

- The product copy matches the closed-loop Light model.
