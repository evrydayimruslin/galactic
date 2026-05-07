# Light Cloud Economy Implementation Plan

Date: 2026-05-05

This document captures the finalized Light economy decisions and the concrete PR stack for implementing Cloudflare cost controls, no-debt runtime metering, widget pull billing, payout fee pass-through, and simplified publishing economics.

Use this as the handoff artifact for a new implementation session. Start from `main`, create a fresh branch such as `codex/cloud-cost-controls`, and begin with PR15.

## Business Model Decisions

Canonical Light math remains:

- 100 Light = 1 USD for internal cost reference, payouts, receipts, and UI copy.
- Apple Pay and Google Pay are the only card surface.
- Card funding credits 95 Light per 1 USD.
- Wire or bank transfer funding credits 99 Light per 1 USD.
- Card top-up minimum is 25 USD.
- Wire or bank transfer funding minimum is 25 USD.
- Payout conversion is 100 Light per 1 USD.
- Stripe Connect payout fees are deducted from payout proceeds operationally.
- Creator revenue/platform fee is 15%.

Cloud usage:

- Public cloud usage price: 1 Light per 1,000 cloud units.
- Cloud charges settle as exact fractional Light at 0.001 Light per cloud unit; the per-1,000 rate is the human-facing denomination, not a rounding floor.
- Worker execution: 1 cloud unit per started 250ms, minimum 1 unit.
- R2 operations: 1 operation = 1 cloud unit.
- KV operations: 1 operation = 1 cloud unit.
- D1 writes: 1 row written = 1 cloud unit.
- D1 reads: 100 rows read = 1 cloud unit.
- Widget pulls: 1 pull = 1 cloud unit.
- Storage: first 100MB included, then 100 Light per GB-month, prorated.

No cloud debt:

- The platform must not run infrastructure calls on credit.
- Runtime paths should preflight, hold, or fail closed before externally billable work when the selected payer cannot cover expected minimum cost.
- Exact usage should settle after execution.
- Partial debits are not acceptable for infra charges.
- Public `/http` calls require authentication. There should be no unauthenticated public `/http` execution.

Publishing:

- Remove publish deposit as the primary publishing gate.
- Remove published MB/hour hosting fee.
- Published apps remain economically protected by runtime cloud-unit metering and storage-at-rest metering.

Call settlement:

- Monetized calls: user pays app price plus infra.
- Platform keeps infra plus 15% of app price.
- Developer receives 85% of app price.
- Free calls: developer sponsors infra.
- If developer balance is zero, authenticated free-call callers can cover infra only; app price remains zero.
- If neither developer nor caller has enough Light for infra, the call is gated.
- Paid calls can continue normally when developer balance is zero because user-paid infra keeps the platform whole.
- Ownership never transfers.

Widgets:

- No silent default background polling.
- Users explicitly enable widget pulls.
- Users choose the interval.
- UI shows estimated pulls and Light cost.
- Widget HTML remains cached locally where possible.
- Data refreshes are metered widget pulls.

Storage ownership:

- Operations are paid by whoever triggers the call, except developer-sponsored free calls.
- Storage at rest is paid by whoever owns the bytes.
- User-owned storage includes user-attributed D1 rows, user R2 app data, memory, pages, and library content.
- Developer-owned storage includes app code, versions, builds, app-owned shared data, logs, and app-level system artifacts.
- Platform-only control-plane storage should still be recorded and attributed where possible, but the product promise is that app/runtime R2, KV, D1, and Worker usage is not silently unbounded.

## Current Reality Anchors

Billing config currently lives in:

- `api/services/billing-config.ts`
- `supabase/migrations/20260430120000_platform_billing_config.sql`

Light movement RPCs currently live in:

- `supabase/migrations/20260430140000_internal_light_movement_context.sql`
- `supabase/migrations/20260430130000_light_balance_earnings_buckets.sql`

MCP currently settles monetized app calls:

- `api/handlers/mcp.ts`
- `api/services/execution-settlement.ts`

HTTP and run currently log non-GPU execution but do not settle normal app pricing:

- `api/handlers/http.ts`
- `api/handlers/run.ts`

Dynamic Worker execution and RPC bindings:

- `api/runtime/dynamic-sandbox.ts`
- `api/runtime/dynamic-executor.ts`
- `api/src/bindings/appdata-binding.ts`
- `api/src/bindings/database-binding.ts`
- `api/src/bindings/memory-binding.ts`
- `api/src/bindings/ai-binding.ts`

R2 wrapper and app data:

- `api/services/storage.ts`
- `api/services/appdata.ts`
- `api/services/appdata-metered.ts`

D1 provisioning and current incomplete D1 usage sync:

- `api/services/d1-provisioning.ts`
- `api/services/d1-data.ts`
- `api/services/d1-billing.ts`
- `api/services/d1-metering.ts`

Widget polling:

- `desktop/src/hooks/useWidgetInbox.ts`
- `desktop/src/lib/widgetRuntime.ts`
- `desktop/src/components/WidgetWindow.tsx`
- `desktop/src/components/WidgetInbox.tsx`

Payment and payout points:

- `api/services/platform-request-validation.ts`
- `api/services/stripe-wallet-funding.ts`
- `api/services/stripe-wire-funding.ts`
- `api/handlers/user.ts`
- `api/services/stripe-connect.ts`
- `api/services/payout-processor.ts`

Publishing gates and current hosting/data storage billing:

- `api/services/tier-enforcement.ts`
- `api/services/hosting-billing.ts`
- `api/services/storage-quota.ts`
- `api/services/data-quota.ts`

## PR15: Billing Config And Policy Surface

Goal: make the new economics configurable and remove stale public policy values.

Files and areas:

- Extend `platform_billing_config`.
- Extend `BillingConfig` and `toPublicBillingConfig` in `api/services/billing-config.ts`.
- Extend admin request validation in `api/services/admin-request-validation.ts`.
- Update admin handler in `api/handlers/admin.ts`.
- Update QA and config tests.
- Update shared constants only where they are still useful as defaults.

Migration fields:

- `card_minimum_cents integer NOT NULL DEFAULT 2500`
- `wire_minimum_cents integer NOT NULL DEFAULT 2500`
- `cloud_unit_light_per_1k double precision NOT NULL DEFAULT 1`
- `worker_ms_per_cloud_unit integer NOT NULL DEFAULT 250`
- `d1_read_rows_per_cloud_unit integer NOT NULL DEFAULT 100`
- `d1_write_rows_per_cloud_unit integer NOT NULL DEFAULT 1`
- `r2_ops_per_cloud_unit integer NOT NULL DEFAULT 1`
- `kv_ops_per_cloud_unit integer NOT NULL DEFAULT 1`
- `widget_pulls_per_cloud_unit integer NOT NULL DEFAULT 1`
- `storage_free_bytes bigint NOT NULL DEFAULT 104857600`
- `storage_light_per_gb_month double precision NOT NULL DEFAULT 100`
- `publish_deposit_enabled boolean NOT NULL DEFAULT false`
- `published_hosting_meter_enabled boolean NOT NULL DEFAULT false`

Also update:

- Default `platform_fee_rate` from `0.10` to `0.15`.
- Public labels to say 1 Light per 1,000 cloud units and 100MB free storage.
- Remove old public labels for publish deposit and MB/hour hosting where possible.

Tests:

- `api/services/billing-config.test.ts`
- `api/services/admin-request-validation.test.ts`
- `api/services/payments-launch-qa.test.ts`

## PR16: Cloud Usage Ledger And Atomic Settlement RPCs

Goal: create the durable ledger and no-debt primitives before wiring runtime billing.

New tables:

- `cloud_usage_events`
- `cloud_usage_holds`
- `cloud_usage_rollups`

Suggested `cloud_usage_events` fields:

- `id uuid primary key`
- `created_at timestamptz`
- `payer_user_id uuid not null`
- `sponsor_user_id uuid`
- `caller_user_id uuid`
- `owner_user_id uuid`
- `app_id uuid`
- `function_name text`
- `receipt_id text`
- `source text not null`
- `resource text not null`
- `units double precision not null`
- `cloud_units double precision not null`
- `amount_light double precision not null`
- `billing_config_version integer`
- `metadata jsonb`

Resource values:

- `worker_execution`
- `r2_operation`
- `kv_operation`
- `d1_read`
- `d1_write`
- `widget_pull`
- `storage_at_rest`

RPCs:

- `create_cloud_usage_hold`
- `settle_cloud_usage_hold`
- `release_cloud_usage_hold`
- `record_cloud_usage_event`
- `debit_cloud_usage`

Rules:

- Infra debits use no partial debit.
- Every infra debit must record a cloud usage event.
- Holds are released or settled.
- No debt rows.

Tests:

- Add Supabase database tests for no partial debit and event recording.
- Add API service tests around the new RPC client.

## PR17: Unified App Call Settlement Across MCP, HTTP, And Run

Goal: make MCP, `/http`, and `/run` use the same call settlement model.

Current gap:

- MCP calls `settleCallerAppCharge`.
- `/http` and `/run` log execution without normal app pricing settlement.

Implementation:

- Replace or expand `api/services/execution-settlement.ts`.
- New function shape:
  - resolve app call price
  - resolve free-call sponsorship
  - resolve payer
  - calculate platform fee using billing config
  - settle app price transfer
  - settle infra charge separately
  - return receipt metadata

Rules:

- Monetized call:
  - caller pays app price plus infra.
  - platform keeps infra plus 15% of app price.
  - developer receives 85% of app price.
- Free call:
  - developer pays infra.
  - if developer has no balance, return a typed response saying caller may pay infra to continue.
- Owner calling their own app:
  - app price should not transfer to self.
  - infra still needs a payer. Default to owner/developer.

Affected files:

- `api/services/execution-settlement.ts`
- `api/handlers/mcp.ts`
- `api/handlers/http.ts`
- `api/handlers/run.ts`
- `api/services/gpu/billing.ts` for consistency checks, though GPU already has pass-through settlement.

Tests:

- `api/services/execution-settlement.test.ts`
- `api/handlers/wave3-e2e.test.ts`

## PR18: Worker Execution Metering And No-Debt Holds

Goal: meter Worker execution with 250ms units and prevent platform-negative calls.

Implementation:

- Add `api/services/cloud-usage.ts`.
- Add helpers:
  - `calcWorkerCloudUnits(durationMs, config)`
  - `calcCloudUsageLight(cloudUnits, config)`
  - `createRuntimeCloudHold`
  - `settleRuntimeCloudHold`
- Preflight runtime calls using either timeout-based hold or a conservative initial hold.
- Settle exact duration after execution.

Worker unit formula:

- `max(1, ceil(durationMs / worker_ms_per_cloud_unit))`

Suggested preflight:

- For 30s timeout: 120 units = 0.12 Light at 1 Light per 1,000 units.
- For 120s timeout: 480 units = 0.48 Light.
- This is small enough to hold before execution.

Affected files:

- `api/runtime/dynamic-sandbox.ts`
- `api/handlers/mcp.ts`
- `api/handlers/http.ts`
- `api/handlers/run.ts`
- `api/services/call-logger.ts`

Tests:

- `api/services/cloud-usage.test.ts`
- `api/runtime/sandbox.test.ts`
- `api/services/execution-settlement.test.ts`

## PR19: R2 And KV Operation Metering

Goal: every R2/KV operation has an attributed payer context.

Implementation:

- Introduce an operation metering context object:
  - payer user id
  - sponsor user id
  - caller user id
  - owner user id
  - app id
  - function name
  - receipt id
  - billing source
- Wrap R2 through `api/services/storage.ts`.
- Instrument direct bindings:
  - `api/src/bindings/appdata-binding.ts`
  - `api/src/bindings/memory-binding.ts`
- Instrument KV usage:
  - `CODE_CACHE`
  - `FN_INDEX`
  - plan gates
  - function indexes
  - conversation summaries

Rules:

- Runtime app data ops are charged to the runtime payer.
- Free-call runtime ops are charged to the developer sponsor.
- Upload/build/cache ops are charged to the developer.
- Platform-only control-plane ops should be recorded, and charged to user/developer when a clear owner exists.

Tests:

- `api/services/storage.test.ts` if added.
- Existing upload/app tests for metadata.
- Dynamic binding tests.

## PR20: D1 Runtime Metering

Goal: D1 reads/writes become accurate cloud-unit charges.

Current gap:

- New app D1 databases include `_usage`, and `d1-billing.ts` syncs `_usage`, but runtime query code does not reliably increment `_usage`.
- Existing D1 rates in `shared/types/index.ts` are stale and too weak.

Implementation:

- Instrument `api/src/bindings/database-binding.ts`.
- After each query, read returned `rows_read` and `rows_written`.
- Convert:
  - read cloud units = `ceil(rows_read / 100)`
  - write cloud units = `rows_written`
- Charge or consume from active call hold.
- Track user-attributed D1 storage where possible.
- Remove old D1 overage logic or convert it into reconciliation-only.

Affected files:

- `api/src/bindings/database-binding.ts`
- `api/services/d1-data.ts`
- `api/services/d1-billing.ts`
- `api/services/d1-metering.ts`
- `shared/types/index.ts`
- D1 tests.

Tests:

- `api/services/d1-billing.test.ts`
- `api/services/d1-metering.test.ts`
- Add database binding unit tests if test harness supports it.

## PR21: Storage At Rest Meter

Goal: replace old published hosting/storage rates with 100MB free plus 100 Light/GB-month.

Implementation:

- Rename or refactor `api/services/hosting-billing.ts` into storage billing.
- Stop charging published MB/hour hosting when config disables it.
- Charge combined storage:
  - app/source/version bytes
  - user R2 app data
  - D1 user-attributed storage
  - memory/pages/library
  - developer-owned logs/shared storage
- Keep 100MB free per account.
- Prorate by elapsed time.

Important:

- Current combined storage billing only uses `users.storage_used_bytes + users.data_storage_used_bytes`.
- D1 storage is not currently included in that calculation.

Affected files:

- `api/services/hosting-billing.ts`
- `api/services/storage-quota.ts`
- `api/services/data-quota.ts`
- storage migrations
- `api/handlers/user.ts`
- `api/handlers/platform-mcp.ts`

Tests:

- `api/services/storage-accounting.test.ts`
- `api/services/enforcement-policies.test.ts`
- Add storage billing tests.

## PR22: Remove Publish Deposit And Published MB-Hour Fee UX

Goal: simplify publishing while keeping cost safety through runtime/storage metering.

Implementation:

- Disable `checkPublishDeposit` or gate it behind billing config.
- Remove or rewrite copy that says publishing requires 500 Light.
- Remove old MB/hour hosting copy from wallet/platform status.
- Keep originality and visibility checks.

Affected files:

- `api/services/tier-enforcement.ts`
- `api/handlers/upload.ts`
- `api/handlers/platform-mcp.ts`
- `api/handlers/user.ts`
- desktop/web wallet surfaces where copy appears.

Tests:

- Upload tests.
- Payment launch QA tests.
- Platform MCP wallet/status tests if present.

## PR23: Widget Pull UX And Metering

Goal: make widget pulls explicit, user-controlled, and metered.

Implementation:

- Replace 30s automatic polling.
- Add local settings:
  - per-widget enabled flag
  - interval
  - monthly projected pulls
  - monthly projected Light cost
  - last pulled timestamp
  - pull count
- Add request metadata on widget calls:
  - `source: widget_pull`
  - `widget_name`
  - `widget_interval_ms`
- Backend classifies these as widget pull cloud usage.
- Avoid polling hidden/inactive UI.

Affected files:

- `desktop/src/hooks/useWidgetInbox.ts`
- `desktop/src/lib/widgetRuntime.ts`
- `desktop/src/components/WidgetInbox.tsx`
- `desktop/src/components/WidgetWindow.tsx`
- `desktop/src/lib/storage.ts`
- `desktop/src/lib/api.ts`

Tests:

- `desktop/src/lib/widgetRuntime.test.ts`
- `desktop/src/lib/widgetContracts.test.ts`
- Add hook/component tests if existing harness supports it.

## PR24: Stripe And Payout Economics

Goal: operationalize final funding and payout decisions.

Implementation:

- Raise minimum card funding amount to 25 USD.
- Ensure card minimum is config-driven.
- Ensure Stripe Connect fees are deducted from payout proceeds operationally.
- Payout records should store:
  - gross amount
  - fee estimate
  - actual transfer amount
  - actual payout amount
- Payout processor should transfer/payout net where appropriate instead of letting Ultralight eat the fee.

Affected files:

- `api/services/platform-request-validation.ts`
- `api/services/stripe-wallet-funding.ts`
- `api/services/stripe-wire-funding.ts`
- `api/handlers/user.ts`
- `api/services/stripe-connect.ts`
- `api/services/payout-processor.ts`

Tests:

- `api/services/platform-request-validation.test.ts`
- `api/services/stripe-wallet-funding.test.ts`
- `api/services/stripe-wire-funding.test.ts`
- `api/services/stripe-connect.test.ts`
- `api/services/payments-launch-qa.test.ts`

## PR25: Admin, Receipts, And User-Facing Copy

Goal: make the economics visible and auditable.

Implementation:

- Admin panel/API for cloud economics.
- Usage receipts for calls:
  - app price
  - infra Light
  - cloud units
  - Worker units
  - R2/KV ops
  - D1 read/write units
  - platform fee
  - developer net
- Wallet/status copy:
  - cloud units
  - storage policy
  - free-call sponsorship
  - users may pay infra to continue
- Remove stale 100:1 ambiguity and old publish fee references.

Affected files:

- `api/handlers/admin.ts`
- `api/services/call-logger.ts`
- `api/handlers/user.ts`
- `api/handlers/platform-mcp.ts`
- desktop wallet/settings surfaces via embedded web panel or API copy.

Tests:

- Admin handler tests.
- Billing config tests.
- Desktop snapshot/unit tests where copy is local.

## Suggested Implementation Start

In a new session:

1. `cd /Users/russellin/Desktop/ultralight-main`
2. `git checkout main`
3. `git pull --ff-only`
4. `git switch -c codex/cloud-cost-controls`
5. Open this file.
6. Begin PR15.

PR15 should be implemented first because every later PR should read economics from `platform_billing_config` instead of hardcoding the new numbers.

## Verification Pattern

Run targeted tests after each PR, then a full pass before merge:

- `npm test --prefix api`
- `npm test --prefix desktop`
- `scripts/deno-bin.sh task verify`
- `git diff --check`

For migration PRs, run Supabase migrations locally or through the project workflow before merging.
