# Publish · Billing · Tax · Interface-DX Roadmap

Consolidates everything surfaced and decided while dogfooding the interface
publish flow (2026-06-21): the deploy-pipeline bugs we fixed, the developer-DX
gaps, the tab-bar dropdown polish, and the billing / sales-tax / Stripe-Connect
redesign for going live.

**Status legend:** ✅ done & shipped · 🟡 in progress · ⬜ not started · 🔒 blocked on a business decision

---

## Snapshot — where we are (2026-06-21)

| Track | State |
|---|---|
| **A. Interface deploy pipeline** | ✅ A1–A9 done. A6 smoke-CI + A8 guard + A9 dollars shipped; CLI bumped v2.1.0. Owner actions: add `ULTRALIGHT_TOKEN` secret, dispatch npm publish |
| **B. Interface tab-bar UX** | ✅ **shipped & verified live** (`711b3f1`, on `app-exbg0f`) |
| **C. Buyer billing foundation** | ✅ **shipped** — C1 label (`711b3f1`) + C2 address capture (`4729d66`, API+web) |
| **D. Per-transaction sales tax** | ✅ **shipped** (manual rate table; D0–D3). Inert until the business adds its real nexus rates to `SALES_TAX_RATE_TABLE` |
| **E. Seller Connect publish gate** | decided, not started |

Three real bugs were found and fixed this session by actually trying to ship an
interface agent — all blocking the documented happy-path while `test:full`
stayed green. A live private demo interface agent exists for FE verification
(`ultralightagent.com/agents/app-e47q9p`).

---

## Decisions locked (this session)

1. **Seller publish gate = Stripe Connect (`payouts_enabled`)**, not a self-entered billing address. A self-entered address is unverifiable/gameable and doesn't even serve seller tax (Stripe handles 1099-K for Connect accounts). Connect aligns the gate with the seller's own need to get paid.
2. **`unlisted` = minimum-balance only** (covers infra/compute). **Drop the publisher billing-address requirement entirely.** Only **public/published** requires Connect.
3. **Buyer sales tax = per-transaction, at consumption** (per agent-call receipt), in **fractional Light** — no sub-cent floor, so the accrual/batch hack is unnecessary. Replace it.
4. **Capture the buyer tax location at top-up** via PaymentElement address collection (Stripe Link autofills). The top-up is the **universal capture point**: nobody can have spendable/earning activity without having topped up at least once (earning requires deploying, which requires min-balance, bootstrapped by a deposit).
5. **Pay button = neutral label** ("Pay by card"); Stripe Link stays enabled in the backend (`automatic_payment_methods` = card + Link).
6. **Never rely on silent Stripe API address pulls** — Stripe only exposes data collected through the right flow (Connect onboarding for sellers; address-collection at payment for buyers).

## Open business decisions (🔒 — gate going *live*, not building)

- **Tax nexus + rate source:** where are we registered to collect, and Stripe Tax registrations vs. a manual rate table. Plumbing is buildable now; the *live rate* waits on this. (Today everything is `tax_status: not_collecting`, so no urgency.)
- **Connect country coverage:** Stripe Connect Express isn't available everywhere; sellers in unsupported countries can't go public — accept, message, or manual-review fallback.
- **Grandfathering:** existing public agents must not be retro-unpublished when the gate changes (store is ~empty, so low risk).

---

## Track A — Interface deploy pipeline & DX

### A1 ✅ CLI: include `.html` in the upload bundle
`collectFiles` whitelisted extensions and omitted `.html`, silently dropping
`interfaces/*.html` — every interface upload via the CLI lost its entry file.
- **Files:** `cli/mod.ts` (`collectFiles` allowedExtensions)
- **Shipped:** commit `05bd12b`. (Repo only — see A7 for the published package.)

### A2 ✅ Server: polyfill `__filename` before loading the TS compiler
The parser lazy-imports `typescript`, which references Node's `__filename`;
when the parse ran before the bundler (which had the polyfill), every TS-agent
upload crashed with "__filename is not defined."
- **Files:** `api/services/parser.ts` (`loadTs`)
- **Shipped:** deployed to prod API.

### A3 ✅ CLI: surface the server's error body
`callTool` threw a bare `API error: 400` and discarded the JSON-RPC error body,
making failures undiagnosable.
- **Files:** `cli/api.ts`
- **Shipped:** committed.

### A4 ✅ Server: stamp interfaces on the version-update path
`executeUpload`'s existing-app branch uploaded inline via the pipeline and never
ran `prepareInterfaceArtifacts`, so re-versioning persisted an unstamped manifest
and the facade dropped the interface for all viewers.
- **Files:** `api/handlers/platform-mcp.ts` (`executeUpload` update branch) — mirror `handleUploadFiles` stamping
- **Shipped:** commit `9d108f1`, deployed; verified by the smoke (RED→GREEN).

### A5 ✅ E2E deploy+render smoke
Nothing previously deployed an interface agent and asserted it renders.
- **Files:** `scripts/smoke/interface-deploy-smoke.mjs`
- **Asserts:** `.html` bundled → `ul.upload` succeeds → launch facade returns the interface (url+functions) → worker serves the artifact (200/text-html) → **interface survives re-version**.
- **Shipped:** committed `a523c9e`; validated green against prod.

### A6 ✅ Wire the smoke into CI
Shipped `.github/workflows/interface-smoke.yml`: runs the deploy+render smoke on
a daily schedule and on `api/**` / `cli/**` / `shared/**` / smoke-script changes.
Idempotent via `ULTRALIGHT_SMOKE_APP_ID` (re-versions one fixed private app); the
agent never goes live. **Inert until the owner adds the `ULTRALIGHT_TOKEN` repo
secret** (upload-scoped test account) — the job no-ops with a warning instead of
failing, so it's safe to land first.
- **Owner action:** add repo secret `ULTRALIGHT_TOKEN` (+ optional `ULTRALIGHT_SMOKE_APP_ID`).

### A7 ✅/⬜ Republish the `ultralightagent` npm CLI
Bumped `cli` to **v2.1.0** (package.json + `mod.ts` VERSION synced — the
`.html` upload fix + error-body surfacing + the new A8 interface-entry guard).
- **Owner action (publish itself):** dispatch `npm-publish.yml` with `mode=publish`
  (needs the granular automation token on the `ultralightagent` npm account).
- **Acceptance:** `npx ultralightagent@latest upload <interface agent>` succeeds.

### A8 ✅ Upload guard: fail loudly on a missing interface entry file
Added `assertInterfaceEntriesPresent` in `cli/mod.ts`, called in `upload` and
`draft` after `collectFiles`. Reads `manifest.json`, and for each
`interfaces[].entry` not in the collected files throws a clear error naming the
file + listing what was collected (mirrors the server-side check in
`interface-artifacts.ts`). Guards the original silent `.html` drop.

### A9 ✅ Format money in user-facing errors (kill `✦` Light leak)
Added `formatDollarsFromLight()` (shared/types) and swapped the internal `✦`/Light
unit for dollars in user-facing money strings: the publish-balance gate
(`tier-enforcement.ts`), the call-cost insufficient messages
(`execution-settlement.ts` — also used by the tax-preflight rejection), and the
paid-content paywall pages (`app.ts`). Tests updated to the dollar strings.
- **Out of A9 scope (left intentionally):** marketplace ask/bid price displays
  and the developer's `default_price_light` validation (a light-denominated API
  field), and internal/admin debug strings — none are buyer balance/cost errors.

---

## Track B — Interface tab-bar UX (approved: "fix dropdowns + align")

### B1 ✅ Functions/Interface dropdown alignment + clarity
Shipped (commit `711b3f1`). Replaced the verbose `FunctionMenu` with a compact
`TabSelectMenu` (name + price, check on the selected row — no per-row
description wall). Interface is now a matching tab-bar dropdown when
`tool.interfaces.length > 1` (selection lifted out of `AgentInterfacePanel`'s
in-panel pills); a single interface stays a plain tab. Dropdown triggers are
`inline-flex` so the caret centres next to the label; opening one menu closes
the other; outside-click/Escape close both.
- **Verified:** live on `app-exbg0f` (Story Builder, 7 functions) — compact
  220px menu renders name+price with a check on the selected function.

---

## Track C — Buyer billing foundation

### C1 ✅ Neutral pay-button label (FE only)
Shipped (commit `711b3f1`). The method button now reads "Pay by card / Card or
Link"; removed the green `LinkMark` SVG + dead `.method-link` CSS.
`automatic_payment_methods` (card + Link) unchanged — Link still surfaces inside
the PaymentElement and autofills for returning users.

### C2 ✅ Capture buyer tax location at top-up
Shipped (commit `4729d66`; API + launch-web).
- **FE:** added a Stripe **AddressElement** (billing mode) below the
  PaymentElement in the top-up flow (`foundation-pages.tsx`,
  `addressElementRef`). In the same Elements group, Stripe attaches its address
  to the payment method's `billing_details` on `confirmPayment` — no confirm
  change needed. Link autofills it; new card buyers fill it once; phone
  suppressed.
- **BE:** after `finalizeLightDeposit`, the webhook retrieves the funding charge
  (`captureFundingBillingAddressFromCharge` in `api/services/stripe-customers.ts`
  — the PaymentIntent only references `latest_charge` by id) and upserts
  `billing_details.address` into `user_billing_addresses` as
  `source: "wallet_funding"`. Best-effort (never fails the deposit) +
  idempotent (skips when the address matches the stored current one).
- **Acceptance:** after a top-up, the user has a current billing address from
  Stripe; works for Link and card. **Prerequisite for D — now satisfied.**
- **Note:** chosen over PaymentElement `fields.billingDetails.address` because
  that option can only *hide* fields, not force full-address collection; the
  AddressElement is the documented way to collect (and Link-autofill) a complete
  billing address.

---

## Track D — Per-transaction sales tax (consumption-time) ✅ SHIPPED

### D0 ✅ Rate source = manual rate table (business decision)
Decided: **manual rate table**, not Stripe Tax. Lives in `api/services/sales-tax.ts`
(`SALES_TAX_RATE_TABLE`, basis points, per-country with optional per-subdivision
overrides). **Ships empty → 0 everywhere → `not_collecting`**, so deploying is
inert: `isSalesTaxConfigured()` is false, the settlement hot path never reads the
buyer's address or debits anything, and no behavior changes. Adding one non-zero
entry (e.g. `US: { states: { CA: 825 } }`) is the single switch that turns on
collection for that jurisdiction — **the business must fill in its real nexus +
rates before any tax is collected.**

### D1 ✅ Per-receipt tax (replaced the dead accrual model)
- `sales-tax.ts` rewritten: removed `decideSalesTaxCharge` / `SalesTaxAccrualState` / the 20%-balance trigger (was only ever referenced by its own test). New pure API: `resolveSalesTaxRateBps(location)`, `computeSalesTaxLight(taxable, bps)`, `isSalesTaxConfigured()`.
- Buyer location resolved (and cached, 10-min TTL) from the C2 billing address in `sales-tax-location.ts` — **not** a Stripe call per agent-call.
- Wired into `settleAppCall` (`execution-settlement.ts`): after the app charge transfers, tax = `appChargeLight × rate` is debited from the buyer via the proven `debit_light` RPC (reason `sales_tax`, idempotent, best-effort — never fails an already-paid call). Threaded onto the settlement → log entry → receipt (`tax_status` / `taxable_amount_light` / `tax_amount_light` / `buyer_billing_address_*`).
- **Tested:** unit tests for the math/gate + two settlement tests exercising the actual debit (collected vs. unconfigured-location). All 14 settlement tests green.

### D2 ✅ Tax on the launch receipt summary
- Added `tax: LaunchMoneyAmount` to `LaunchWalletReceiptSummary` (`shared/contracts/launch.ts`), the handler mapping, and the OpenAPI schema (`api/handlers/launch.ts`). `CallReceipt` already folded tax into `total_light`.

### D3 ✅ "Sales tax" line in the receipt detail
- `WalletMergedRow` detail (`foundation-pages.tsx`) renders a "Sales tax" `QuoteLine` (between Platform fee and Developer earns) **when `tax > 0`** — so it stays hidden until a rate is configured.

**Status:** mechanism fully live; collects nothing until the manual rate table is populated with the business's registered jurisdictions.

---

## Track E — Seller Connect publish gate ✅ SHIPPED (commit 52ef7a2)

### E1 ✅ Split the publish gate by visibility
`checkPublisherPublishReadiness(userId, {visibility, appConnectGateExempt})`:
dropped the billing-address requirement; `public`/`published` require
`users.stripe_connect_payouts_enabled` (new block reason
`connect_payouts_required`); `unlisted` needs only the min-balance. Threaded
through all 7 call sites + 3 wrappers (apps.ts, platform-mcp.ts, upload.ts;
executeSetVisibility readiness moved AFTER resolveApp to read the app row).

### E2 ✅ Extend Connect status read
`getAccountStatus` reads `requirements.currently_due/past_due/disabled_reason`,
`individual/company.verification.status` + `address`; GET `/api/user/connect/status`
surfaces them (live, no new columns).

### E3 ✅ Website "Set up payouts to publish" flow
FE `PayoutsBanner` (Earnings tab) fetches connect status and shows a real CTA →
`POST /api/user/connect/onboard` → Stripe hosted onboarding. **Fixed the onboard
return URL** (was `BASE_URL` = the API origin, which 404s on the FE) →
`LAUNCH_WEB_BASE_URL/account?tab=earnings&connect=complete`. Admin `save()`
surfaces the gate message. Added `api.ts` `connectStatus`/`startConnectOnboarding`.

### E4 ✅ Grandfather existing public agents
Explicit `apps.connect_gate_exempt` boolean (migration
`20260622120000_connect_gate_grandfather.sql` adds it + backfills
`WHERE visibility='public'`). Chosen over a publish-date cutoff — a date can't
tell an existing public app from a new one created the same day. Every
currently-public app is exempt; every app made public afterwards must connect.
**DEPLOY ORDER: apply this migration BEFORE the API deploy.**

**Also folded sales tax into the preflight reservation:** `preflightRuntimeCloudHold`
now requires the buyer to afford appCharge + tax up front (releases the infra
hold + rejects if not), eliminating best-effort under-collection.

---

## Suggested sequencing

1. **Close the interface loop:** A6 (CI) → A7 (republish CLI). A8/A9 anytime.
2. **B1 dropdown** — independent FE; demo agent is ready.
3. **Buyer track:** C1 (label) + C2 (address capture) → D1–D3 (tax plumbing, rate behind D0).
4. **Seller track (parallel):** E1 + E2 + E3, then E4.

Buyer (C→D) and Seller (E) tracks are independent and can run in parallel.
Within buyer, D depends on C2.
