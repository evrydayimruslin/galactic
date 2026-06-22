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
| **A. Interface deploy pipeline** | core **fixed & verified end-to-end**; CI wiring + CLI republish remain |
| **B. Interface tab-bar UX** | ✅ **shipped & verified live** (`711b3f1`, on `app-exbg0f`) |
| **C. Buyer billing foundation** | ✅ **shipped** — C1 label (`711b3f1`) + C2 address capture (`4729d66`, API+web) |
| **D. Per-transaction sales tax** | C2 dep satisfied; live rate 🔒 on a tax-registration decision |
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

### A6 ⬜ Wire the smoke into CI
- **Work:** add `ULTRALIGHT_TOKEN` repo secret (dedicated test account, small balance); run on a schedule + on `api/**` / `cli/**` / `shared/**` changes; cleanup strategy (delete the test app after, or a fixed `--app-id` now that re-version is fixed).
- **Acceptance:** CI run deploys the demo, asserts render, and tears down; red on any pipeline regression.
- **Deps:** A1–A5. **Owner action:** provision the test-account token secret.

### A7 ⬜ Republish the `ultralightagent` npm CLI
The published package predates A1/A3 — so `npx ultralightagent` still **can't
upload an interface agent** (live user-facing breakage).
- **Work:** confirm the npm bundle builds from `cli/`; bump version; publish via `npm-publish.yml` (needs the granular automation token on the `ultralightagent` npm account, 2FA-bypass); verify the published artifact contains the `.html` fix.
- **Acceptance:** `npx ultralightagent@latest upload <interface agent>` succeeds end-to-end.
- **Deps:** **gated on A6 green.**

### A8 ⬜ Upload guard: fail loudly on a missing interface entry file
The `.html` drop was *silent* ("Uploading 2 files"). Add a pre-upload guard.
- **Files:** `cli/mod.ts` (post-`collectFiles`) and/or `api/services/interface-artifacts.ts` (already errors server-side; mirror client-side).
- **Acceptance:** uploading a manifest whose `interfaces[].entry` isn't in the collected set fails with a clear message naming the file.

### A9 ⬜ Format money in user-facing errors (kill `✦` Light leak)
Errors surfaced internal Light units (`Current balance: ✦807.9K`) after all the
work to show dollars.
- **Files:** publish-gate + funding error strings (`api/services/tier-enforcement.ts`, `api/handlers/launch.ts`), wherever `light` values are interpolated into messages.
- **Acceptance:** no user-facing error string contains `✦` / raw `_light`; all money rendered as dollars.

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

## Track D — Per-transaction sales tax (consumption-time)

### D0 🔒 Tax registration / rate source (business decision)
Decide nexus + Stripe Tax registrations vs. manual rate table. Gates the *live*
rate only — D1–D3 plumbing is buildable now with the rate stubbed/off.

### D1 ⬜ Replace the accrual model with per-receipt tax
- **Files:** `api/services/sales-tax.ts` — remove `decideSalesTaxCharge` / `SalesTaxAccrualState` / the 20%-balance trigger; compute `taxAmountLight = taxableMonetizedLight × rate` per receipt. Resolve `taxRateBps` from the buyer's stored tax-location (cached per location/period — **not** a Stripe API call per agent-call). Write `tax_amount_light` / `tax_status` on the receipt (`api/services/call-receipts.ts`, `api/services/call-logger.ts` — columns already exist).
- **Acceptance:** each monetized agent-call receipt carries its own tax; no balance-trigger lumps.
- **Deps:** C2 (buyer location), D0 (live rate).

### D2 ⬜ Expose tax on the launch receipt summary
- **Files:** `shared/contracts/launch.ts` (`LaunchWalletReceiptSummary`), `api/handlers/launch.ts` (receipt mapping) — add the tax amount.
- **Acceptance:** the facade returns `tax` on each receipt.

### D3 ⬜ Show "Sales tax" in the receipt detail
- **Files:** `apps/launch-web/src/pages/foundation-pages.tsx` (`WalletMergedRow` expanded `.wallet-ledger-detail`) — add a `QuoteLine` "Sales tax" alongside App charge / Infrastructure / Platform fee / Developer earns, folded into Total.
- **Acceptance:** clicking a transaction in the Balance Ledger shows the per-transaction tax line.
- **Deps:** D2.

---

## Track E — Seller Connect publish gate (parallel)

### E1 ⬜ Split the publish gate by visibility
- **Files:** `api/services/tier-enforcement.ts` (`checkPublisherPublishReadiness`, ~`:210`) — `unlisted` → min-balance only; `public/published` → `payouts_enabled` from `users.stripe_connect_payouts_enabled`. Remove the `hasCurrentBillingAddress` requirement; add reason `stripe_connect_required`. Update enforcement at `requirePlatformPublishReadiness` (`api/handlers/platform-mcp.ts`), `api/handlers/upload.ts`, `api/handlers/apps.ts` (visibility change).
- **Acceptance:** unlisting needs only min-balance; publishing-public needs Connect payouts enabled; the old billing-address dead-end is gone.

### E2 ⬜ Extend Connect status read
- **Files:** `api/services/stripe-connect.ts` (`getAccountStatus`) — also read `individual/company.address`, `individual.verification.status`, `requirements.currently_due`.
- **Acceptance:** we capture the verified seller address and can surface pending onboarding requirements.

### E3 ⬜ Website "Set up payouts to publish" flow
The onboarding **endpoint already exists** (`POST /api/user/connect/onboard`,
`api/handlers/user.ts:3843`) — this completes the "website payout flow is coming."
- **Files:** `apps/launch-web` — Earnings/publish surface: CTA → onboard endpoint → Stripe hosted onboarding → return to `?connect=complete`; show `requirements.currently_due` while pending; gate the public toggle on `payouts_enabled`.
- **Acceptance:** a user can set up Connect from the site and then publish-public.

### E4 ⬜ Grandfather existing public agents
- **Acceptance:** the new gate doesn't retro-unpublish anything already public.

---

## Suggested sequencing

1. **Close the interface loop:** A6 (CI) → A7 (republish CLI). A8/A9 anytime.
2. **B1 dropdown** — independent FE; demo agent is ready.
3. **Buyer track:** C1 (label) + C2 (address capture) → D1–D3 (tax plumbing, rate behind D0).
4. **Seller track (parallel):** E1 + E2 + E3, then E4.

Buyer (C→D) and Seller (E) tracks are independent and can run in parallel.
Within buyer, D depends on C2.
