# P2.1 — BYOK Subscription Capacity (2026-07-15)

P2.1 replaces the customer-facing credits economy with a simple hosted-Agent
subscription contract while preserving the hardened internal work meters.

## Locked launch contract

- Inference is BYOK-only. Galactic never supplies a model key to hosted Agents.
- Free includes one active Agent indefinitely. The numerical Free allowance is
  private, but the UI always reports `available`, `low`, or `waiting`, plus reset
  timestamps.
- Pro is $20/month and permits unlimited Agents sharing one account capacity
  pool. Max 5x ($100) and Max 10x ($200) exist as dormant plan records but are
  not purchasable at launch.
- Capacity has an account-anchored five-hour burst window and weekly window.
- Capacity is cost-weighted using the existing private Light denomination for
  Worker time and KV/R2/D1 operations. Light is not presented as money, credit,
  or a customer balance.
- No processing fee, per-Agent fee, credits, overages, marketplace earnings, or
  payout UI is part of the launch surface.
- Scheduled wakes that encounter capacity are coalesced. The next successful
  run receives the number and time range of deferred wakes instead of replaying
  every missed execution.
- Direct calls fail with a structured capacity-waiting result and deterministic
  retry timestamp. Scheduled work resumes at the earlier of its next cadence or
  the next capacity opening.

## Sources of truth

- `billing_plans` stores private capacity calibration and Stripe price mapping.
- `account_subscriptions` stores the latest projected Stripe subscription.
- `account_entitlements` is the runtime plan and Free activation authority.
- `account_capacity_windows` and `account_capacity_reservations` provide atomic,
  idempotent admission and settlement.
- `deferred_routine_wakes` stores one coalesced wake per routine.

At migration time, only routines carrying the server-owned
`metadata.launch_primary=true` marker participate in the one-active-Agent
normalization. The most recently active persistent Agent remains active and
additional launch-primary Agents are paused; historical/internal routine rows
are left untouched.

The legacy wallet and marketplace tables remain intact for future use, but the
launch facade returns `410` for wallet/platform-inference routes and omits those
paths and schemas from launch OpenAPI.

## Deployment order

1. Configure the Stripe Pro recurring Price ID in `billing_plans.stripe_price_id`
   or as `STRIPE_PRO_PRICE_ID` in each Worker environment.
2. Apply `20260715120000_subscription_capacity_foundation.sql`.
3. Deploy the API Worker with `SUBSCRIPTION_CAPACITY_ENABLED=1`.
4. Deploy the launch web app.
5. In Stripe, confirm subscription webhooks deliver to `/api/webhooks/stripe`
   and the Billing Portal configuration permits cancellation and payment-method
   updates.

Do not enable the Worker flag before the migration is present. The launch Agent
Home can tolerate a transient capacity-status read failure, but execution and
activation admission deliberately fail closed.

## Release verification

- A new Free account can activate one Agent and cannot activate a second until
  the first is paused.
- An Agent with `ai:call` cannot activate or execute until a BYOK provider is
  configured.
- MCP, `/run`, HTTP, and routine execution all reserve and settle the same
  account pool.
- Exhausted direct work returns HTTP `429` or MCP JSON-RPC `-32010` with
  `retry_at`.
- Repeated scheduled wakes create no run storm; the next admitted run reports
  the coalesced count.
- Pro checkout upgrades the entitlement through the verified Stripe webhook,
  and cancellation/downgrade retains the most recently active Agent while
  pausing the others.
- Account and Agent Home show states/reset times and no credit balance, top-up,
  Galactic AI, earnings, or processing-fee controls.
