# Launch Site Upgrades Implementation Roadmap

> **⚠️ SUPERSEDED (2026-06-10)** by
> [LAUNCH_PIVOT_DECISIONS.md](LAUNCH_PIVOT_DECISIONS.md). In particular, the
> "Monetized skills live at the same platform level as functions" product
> decision is reversed (skills fold into a functions convention, P3), and the
> Workstream 1 widget wiring is removed from launch scope (P2). Treat the
> remaining content as historical context only.

Last updated: 2026-06-08

This roadmap captures the next implementation sequence after the narrowed launch-scope backend pass. It focuses on turning the launch web surface into a live product UI, then filling the missing economics and deployment primitives behind it.

Active next-step PR stack: see [LAUNCH_NEXT_STEPS_PR_ROADMAP.md](LAUNCH_NEXT_STEPS_PR_ROADMAP.md). Future implementation should refer to that document's `PR NS-*` IDs and update it when scope changes.

## Product Decisions Captured

- Bring-your-own-customer attribution is permanent: customers a publisher brings through their own referral link generate 0% platform fee for that publisher forever.
- Platform-sourced customers generate the standard 15% platform fee.
- Storage remains a soft cap system. The first 100MB is included; after that, accounts need a minimum Light balance, initially 1000 Light, so storage charges have spendable balance to draw from.
- Sales tax will be calculated internally from Ultralight-owned jurisdiction/rate data.
- Cloudflare compute pass-through uses Ultralight's existing internal Cloud unit rates, not live Cloudflare invoice reconciliation.
- Monetized skills live at the same platform level as functions. They have semantic descriptions, permission and monetization policy, and can cost Light when an agent pulls the full skill/context into its context window. Skill pulls do not require Worker execution.
- External-agent prompt/response/reasoning telemetry is out of scope for this roadmap unless an agent explicitly sends that data through Ultralight.

## Workstream 1: Wire Launch FE To Launch API

Goal: convert `apps/launch-web` from fixture-perfect mockups to a live API-backed launch site without disturbing current visual polish.

### 1. Data Layer

- Extend `apps/launch-web/src/lib/api.ts` into the single launch API client boundary.
- Add auth-token resolution, common error envelopes, loading states, and status helpers.
- Keep route/page components presentational where possible so design handoffs can continue to land cleanly.
- Preserve static fixtures as local fallback/demo data only.

### 2. Route Wiring

- `/`
  - `GET /api/launch/status`
  - `GET /api/launch/install`
  - `GET /api/launch/platform-primitives`
- `/install`
  - `GET /api/launch/install`
  - `GET /api/launch/api-keys`
  - `POST /api/launch/api-keys`
- `/store`
  - `GET /api/launch/store`
  - `GET /api/launch/leaderboard`
- `/tools/:slug`
  - `GET /api/launch/tools/:id`
  - `GET /api/launch/tools/:id/widgets`
  - `GET /api/launch/tools/:id/functions`
  - `POST /api/launch/tools/:id/functions/:functionName/run`
  - `GET/PATCH /api/launch/tools/:id/agent-permissions`
- `/library`
  - `GET /api/launch/library`
- `/wallet`
  - `GET /api/launch/wallet`
  - paginated wallet detail endpoints
  - top-up quote and intent endpoints
- `/settings`
  - API key management
  - default/installed tool agent permission management
- `/admin/tools/:id`
  - owner admin summary
  - function run/test
  - agent permission configuration
  - referral/storage/tax/fee metadata as backend fields are added

### 3. Launch Contract Extensions

Additive contract fields expected by upcoming UI:

- Referral URL and attribution status on owned tool/admin surfaces.
- Storage usage, included bytes, overage bytes, next charge estimate, minimum required balance, and suspension risk.
- Tax profile status, jurisdiction summary, untaxed spend, accrued tax estimate, and last tax charge.
- Skill summaries on public/admin tool pages, including price and permission status.
- Cloud unit rate copy, free-call sponsorship state, and caller-fallback state.
- SEO metadata per public tool page.

### 4. Acceptance Criteria

- No primary launch route depends on hardcoded wallet/tool/API-key data.
- Existing mockup layout and visual density remain intact.
- Anonymous users can browse public store/tool/install surfaces.
- Authenticated users can install, inspect, run, fund, configure permissions, and view receipts.
- Local build/typecheck passes for `apps/launch-web`.

## Workstream 2: Permanent Customer Attribution

Goal: implement the new BYO-customer policy directly in settlement.

### Model

- Add or adapt a durable attribution table keyed by payer/customer user and publisher.
- Attribution source values:
  - `publisher_referral`
  - `platform_discovery`
  - `platform_marketplace`
  - `direct_internal`
  - `admin_override`
- A valid publisher referral link creates permanent publisher attribution for that payer/publisher pair.
- Internal search, recommendations, marketplace browsing, or direct platform navigation creates platform attribution when no publisher attribution exists.
- Attribution must be auditable: landing URL, tool, publisher, user, anonymous visitor, claim event, first transaction, and source.

### Settlement Rule

- Publisher-attributed payer to publisher revenue: 0% platform fee.
- Platform-attributed payer to publisher revenue: configured platform fee, currently 15%.
- Attribution affects internal platform fee only. End-user gross Light price remains unchanged.
- Existing publisher fee-credit functionality can remain as an admin/scrip override, but should not obscure attribution source.

### Acceptance Criteria

- Tool-call and marketplace-sale settlements apply permanent attribution.
- Receipts and fee-waiver events show attribution source.
- Launch admin surfaces can display referral URL and attribution impact.

## Workstream 3: Storage Soft Caps And Minimum Balance

Goal: keep soft-cap storage billing while making post-100MB behavior understandable and enforceable.

### Model

- Keep the first 100MB included across combined source/data/storage usage.
- Charge overage using existing storage Light-per-GB-month rates.
- Once over included storage, require a configurable minimum spendable Light balance, initially 1000 Light.
- If over included storage and below minimum balance:
  - block further storage-growing writes, and/or
  - suspend public hosting if the account cannot cover incurred charges.

### Launch UI Fields

- included storage bytes
- current storage bytes
- overage bytes
- minimum balance required
- spendable balance
- estimated next storage charge
- next billing timestamp
- blocked/suspended state

## Workstream 4: Internal Sales Tax

Goal: move from tax-location foundation to an internal calculation and Light deduction system.

### Model

- Add Ultralight-owned jurisdiction/rate tables with effective dates.
- Preserve versioned billing address snapshots already present on receipts.
- Classify taxable transaction types:
  - Light top-ups
  - tool calls
  - marketplace sales
  - storage
  - compute
  - skill pulls
- Track untaxed monetized spend per user since last tax charge.
- Track balance snapshot inputs needed for the 20% threshold.

### Charge Rule

- When a user's Light balance drops below 20% of untaxed monetized spend since the last tax charge, deduct calculated tax from Light balance.
- Record tax charge ledger entries and receipt metadata.
- Show tax status and accrual estimates in launch wallet.

## Workstream 5: Monetized Skill Calls

Goal: make skills peer-level monetizable primitives alongside functions.

### Product Semantics

- A skill is a semantically discoverable context primitive.
- A skill has:
  - stable ID and version
  - semantic title/description
  - full context body
  - short preview/summary
  - permission policy
  - monetization policy
  - publisher attribution
  - receipt metadata
- Agents can discover previews for free or at a configured discovery cost.
- Pulling the full skill into context can cost Light.
- Pulling a skill does not execute publisher Worker code.

### Contract Shape

- Extend tool manifests and generated app artifacts to include first-class `skills`.
- Add launch contracts for:
  - skill list
  - skill preview
  - skill pull
  - skill permission status
  - skill price/free-pull state
- Add MCP resources/tools for priced skill retrieval. The free `resources/list` surface should not leak paid full skill bodies.

### Billing And Permissions

- Reuse the programmable permission/monetization engine for both functions and skills.
- Skill pulls should preflight price and permission before returning full context.
- Receipts should distinguish `skill_pull` from `function_call`.
- Skill pulls should support free-pull quotas, publisher-sponsored pulls, and attribution-aware platform fees.

### Storage/Search

- Store skill summaries and embeddings for semantic discovery.
- Store full skill bodies behind the priced/permissioned retrieval path.
- Version skill embeddings with tool iterations.

## Workstream 6: Embedding Pass-Through Billing

Goal: charge publishers for platform-level embedding work performed on published tool iterations.

- Record embedding provider, model, token count, artifact path, app version, and owner.
- Charge publisher Light using internal embedding rates.
- Store usage/charge IDs beside `embedding.json` and `skills_embedding`.
- Show embedding generation cost in admin/publisher wallet history.

## Workstream 7: Programmable Permissions And Monetization

Goal: let tool code/config express dynamic policy while keeping platform preflight deterministic.

- Start with manifest-declared policy hooks or exported policy functions.
- Policy result must resolve before chargeable action:
  - allowed/denied/ask
  - price
  - free quota
  - payer
  - sponsor
  - attribution class
  - receipt labels
- Apply the same policy substrate to functions and monetized skills.
- Keep static manifest/database config as the default path.

## Workstream 8: Cloudflare Hosting And Public SEO

Goal: make the launch site a deployable Cloudflare product surface.

### Hosting

- Choose Cloudflare Pages or Worker assets for `apps/launch-web/dist`.
- Add staging and production deploy scripts/config.
- Configure API origin, CORS, custom domains, cache headers, and rollback instructions.
- Remove hardcoded fixture-era API origins from launch web.

### SEO

- Preserve legacy `/app/:id` public SEO while launch `/tools/:slug` matures.
- Add server-rendered or Worker-rendered metadata for public launch tool pages:
  - title
  - description
  - canonical
  - OpenGraph
  - Twitter card
  - robots
  - structured data
  - pricing/trust/install snippets
- Add an SEO maturity score for public tool pages instead of a binary optimized/not optimized flag.

### Verification

- Playwright smoke tests for anonymous and signed-in launch paths.
- Contract checks against `shared/contracts/launch.ts`.
- Production/staging smoke checklist covering Cloudflare bindings, secrets, API origin, custom domain, cache, and rollback.

## Features Explicitly Out Of Current Scope

- Robust prompt/response/reasoning telemetry from arbitrary external agents.
- Guaranteed identification of the exact external agent connected to a user session, unless we add explicit client registration or require per-agent tokens.
- Durable Objects for Light double-spend prevention, unless the architecture changes from current database-atomic debit/hold flows.
