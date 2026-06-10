# Launch Next Steps PR Roadmap

> **⚠️ SUPERSEDED (2026-06-10)** by
> [LAUNCH_PIVOT_DECISIONS.md](LAUNCH_PIVOT_DECISIONS.md). All NS-1..NS-11 PRs
> landed and remain in place, but the locked decisions on first-class skills
> (NS-7..NS-10 scope) and widget discovery surfaces are reversed by the pivot
> (P2/P3). Do not start new work from this document.

Last updated: 2026-06-08

This is the active implementation roadmap for the next launch-upgrade sequence. When implementing, refer to the PR ID in this document in status updates, commits, tests, and handoff notes so scope does not drift.

## Locked Decisions

- Do not add Cloudflare Durable Objects for launch double-spend prevention yet.
- Money movement remains database-authoritative through atomic Supabase/Postgres RPCs.
- Durable Objects may be revisited later only as a thin per-user spend sequencer in front of the same DB RPCs, not as the financial source of truth.
- Cloudflare Pages is the recommended launch-web hosting target. The API remains the existing Cloudflare Worker.
- Accurate Cloudflare compute passthrough means Ultralight's configured internal Cloud unit rates, not live Cloudflare invoice reconciliation.
- Sales tax collection is deferred.
- Public `/tools/:slug` SEO optimization is deferred. Preserve existing legacy `/app/:id` SEO while this is deferred.
- Publisher minimum balance before publish is the first guardrail for embedding passthrough cost risk.
- Tool embeddings should live in a platform-owned semantic index/table keyed by app/version/subject, not in developer-owned app D1 by default.
- Platform docs skills should be refined so connected agents know when to link users to relevant Ultralight pages.

## Current Foundations

- Cloud usage holds, debits, events, rollups, and runtime settlement RPCs exist.
- Runtime calls already reserve expected Worker execution cost and settle actual cost.
- Function and skill programmable access policy is implemented.
- First-class skills, skill pulls, pricing, receipts, and policy evaluation are implemented.
- Embedding generation uses OpenRouter and records publisher embedding generation charges.
- Launch FE is wired to the Launch API and can use live data with fixture fallback.
- Platform MCP serves generated platform skills through initialize, `resources/read`, and `GET /api/skills`.

## PR NS-1 - Economic Integrity Inventory And Guardrails

Status: implemented 2026-06-08.

Goal: make every Light-moving path explicit before adding more production charging paths.

### Scope

- Inventory all direct writes to:
  - `users.balance_light`
  - `users.deposit_balance_light`
  - `users.earned_balance_light`
  - `billing_transactions`
  - `light_ledger_entries`
  - `transfers`
  - `cloud_usage_events`
  - `cloud_usage_holds`
  - `skill_pull_receipts`
  - `embedding_generation_charges`
- Document the approved mutation paths and prohibited direct writes.
- Add a lightweight guardrail check, test, or CI script that flags new direct balance mutations outside approved RPC migrations/services.
- Confirm each launch money path has a stable reference ID or idempotency key candidate.

### Expected Files

- `docs/ECONOMIC_INTEGRITY_GUARDRAILS.md`
- `docs/ENGINEERING_FAILURE_POLICY.md`
- `docs/LAUNCH_NEXT_STEPS_PR_ROADMAP.md`
- `scripts/checks/run-guardrail-checks.mjs`
- `scripts/checks/guardrail-baseline.json`

### Acceptance Criteria

- A reviewer can identify the sole authoritative mutation path for each Light-moving operation.
- New direct balance updates outside approved RPCs are caught by automated checks or explicit tests.
- No application handler directly mutates spendable balances.
- Existing economic tests still pass.

### Implementation Note

`PR NS-1` added economic guardrail checks to the existing launch guardrail
runner. The checks fail on new direct protected SQL mutations, protected REST
writes, and Light-moving RPC call sites unless they are reviewed and allowlisted
with the economic integrity document updated in the same PR.

### Out Of Scope

- Durable Objects.
- New pricing policy.
- Sales tax.

## PR NS-2 - Idempotent Economic Operations

Status: implemented 2026-06-08; local Supabase pgTAP validation is pending a running Docker daemon.

Goal: duplicate requests, retries, and network uncertainty cannot double debit.

### Scope

- Add or verify idempotency keys for:
  - function call runtime cloud holds
  - function call developer-fee transfers
  - skill pull receipts and transfers
  - embedding generation charges
  - storage/cloud usage debit events where replay is possible
- Add unique constraints for operation-level idempotency.
- Update RPCs to return the existing result for duplicate idempotency keys when safe.
- Thread idempotency keys from handlers/services into RPC calls.
- Normalize idempotency key construction using stable inputs such as receipt ID, app ID, version, subject ID, caller ID, and operation type.

### Expected Files

- `supabase/migrations/*_economic_idempotency.sql`
- `api/services/cloud-usage.ts`
- `api/services/execution-settlement.ts`
- `api/services/skill-pulls.ts`
- `api/services/embedding-billing.ts`
- `api/services/economic-idempotency.ts`
- `api/handlers/mcp.ts`
- `api/handlers/launch.ts`
- database tests under `supabase/tests/database/*`
- Deno service tests under `api/services/*`

### Acceptance Criteria

- Replaying the same function-call preflight/settlement path does not double reserve or double charge.
- Replaying the same skill pull does not double debit and returns the existing receipt.
- Replaying the same embedding-generation charge does not double debit.
- Duplicate events remain auditable instead of silently disappearing.
- Tests cover at least one duplicate-success and one duplicate-after-partial-failure case.

### Implementation Note

`PR NS-2` adds a central `economic_idempotency_keys` database table plus helper
RPCs that claim and finish economic operations. The authoritative RPCs now
return the original response on replay for `debit_light`, `transfer_light`,
cloud usage debit/hold/settle/release, runtime cloud hold preflight, skill pull
receipts, and embedding generation charges. Service callers thread stable
operation keys from receipt IDs, skill pull operation IDs, embedding app version
subjects, chat message IDs, GPU build/execution identifiers, and storage billing
windows.

The pgTAP replay test is in
`supabase/tests/database/economic_idempotency.test.sql`, but local execution is
blocked until Docker Desktop is running for `./scripts/supabase/validate-local.sh`.

### Decisions

- Exact idempotency retention period if we ever prune old keys.
- Whether duplicate response bodies must be byte-for-byte identical or only economically equivalent.

## PR NS-3 - Stale Hold Release And Reconciliation

Status: implemented 2026-06-08.

Goal: runtime/cloud holds cannot strand user Light indefinitely and operators can detect drift.

### Scope

- Add a scheduled job that releases expired `cloud_usage_holds` still in `held` state.
- Add operator-visible logging/metrics for:
  - holds created
  - holds settled
  - holds released
  - holds past expiry
  - settlement attempts that exceed held amount
- Add a reconciliation report comparing holds, events, ledger entries, and receipt metadata.
- Decide whether stale holds are released automatically, flagged first, or both.

### Implementation Note

`PR NS-3` adds `api/services/cloud-usage-reconciliation.ts` with two launch
operations:

- `releaseExpiredCloudUsageHolds()` scans expired `held` rows and releases them
  through the existing idempotent `release_cloud_usage_hold` RPC via
  `releaseCloudUsageHold()`.
- `getCloudUsageReconciliationReport()` returns a read-only drift report for
  stale holds, settled holds missing settlement events, events missing holds or
  call receipts, missing ledger references, and receipt/event infra mismatches.

The Worker minute cron now runs the stale-hold release job and logs degraded
cleanup runs. Admins can inspect the read-only report at
`GET /api/admin/cloud-usage/reconciliation?days=7&limit=100&scan_limit=10000`.
No migration was needed because `cloud_usage_holds_status_expires_idx` and the
idempotent hold-release RPC already exist.

### Expected Files

- `api/services/cloud-usage-reconciliation.ts` or similar
- `api/src/worker-entry.ts`
- `api/handlers/admin.ts` if an admin endpoint is added
- database/service tests

### Acceptance Criteria

- Expired held Cloud usage reservations are released by a scheduled path.
- Release writes ledger entries and updates hold status.
- Reconciliation can identify orphaned holds/events without mutating money by default.
- Cron failure is logged according to `docs/ENGINEERING_FAILURE_POLICY.md`.

### Closed Decisions

- Runtime execution holds use the existing `timeoutMs + 60s` expiry set by
  `api/services/execution-settlement.ts`; direct hold creators must continue to
  pass an expiry when they want scheduled release.
- Expired held rows are released automatically by cron and remain visible in the
  admin reconciliation report until release has succeeded.
- Reconciliation is both an admin endpoint and cron logging, not cron logging
  only.

## PR NS-4 - Publisher Minimum Balance Before Publish

Status: implemented 2026-06-08.

Goal: publisher-funded platform work, especially embeddings, has spendable Light available before publish.

### Scope

- Add a configurable publisher minimum spendable Light balance for publish/live version activation.
- Start with a value safely above expected embedding generation cost.
- Enforce the minimum before:
  - new public app publish
  - setting a version live
  - published update that regenerates embeddings
- Return actionable errors that tell publishers how much Light is required and current spendable balance.
- Surface the minimum-balance requirement in Launch admin/tool settings if the contract already supports it; otherwise add a small additive field.

### Expected Files

- `api/services/billing-config.ts`
- `shared/types/index.ts`
- `api/handlers/platform-mcp.ts`
- `api/handlers/apps.ts`
- `api/handlers/upload.ts`
- `api/handlers/launch.ts`
- `apps/launch-web/src/pages/foundation-pages.tsx`
- migration for billing config field if needed

### Acceptance Criteria

- A low-balance publisher cannot publish a paid/public tool iteration that requires platform embedding work.
- Private/test uploads remain possible unless explicitly publishing or activating live public versions.
- Error responses include required Light, available Light, and next action.
- Tests cover platform MCP upload/set and API upload/set paths.

### Implementation Note

`PR NS-4` replaces the legacy hard-coded publish balance gate with a
configurable `publisher_min_publish_balance_light` billing-config field,
defaulting to 1000 Light. The gate now returns structured readiness data
including `required_light`, `current_balance_light`, and `next_action`.

The readiness check is enforced before:

- programmatic non-private uploads through the API/MCP upload path;
- REST app visibility changes to non-private;
- REST live-version activation for already non-private apps;
- draft publish for non-private apps;
- Platform MCP `ul.set({ version })`;
- Platform MCP `ul.set({ visibility })`;
- Platform MCP upload-by-name auto-live updates for already non-private apps.

Launch wallet responses include an additive `publishRequirement` field, and the
launch-web wallet balance panel shows the publish minimum when the gate is
enabled.

### Closed Decisions

- Initial minimum balance is 1000 Light.
- The minimum applies to every non-private publish/live activation, including
  unlisted tools, because unlisted versions can still trigger platform-funded
  publishing and semantic work.

## PR NS-5 - Cloudflare Pages Launch Hosting

Status: implemented 2026-06-08.

Goal: deploy `apps/launch-web` as the public launch site while keeping the API on the existing Worker.

### Scope

- Add Cloudflare Pages build/deploy configuration for `apps/launch-web`.
- Add environment configuration for:
  - API base URL
  - staging Pages domain
  - production Pages domain
  - auth/cookie/CORS expectations
- Update API CORS allowlist for the Pages domains.
- Add SPA fallback routing for launch routes such as `/tools/:slug`, `/wallet`, and `/settings`.
- Add deploy and rollback instructions.
- Keep launch-web independent from the existing desktop asset Worker config.

### Expected Files

- `apps/launch-web/vite.config.ts`
- `apps/launch-web/package.json`
- Cloudflare Pages config if represented in repo
- `api/wrangler.toml`
- `docs/RELEASE_TOPOLOGY.md`
- `docs/ENVIRONMENT_ISOLATION_MATRIX.md`
- `docs/RELEASE_RUNBOOK.md`

### Acceptance Criteria

- `pnpm --dir apps/launch-web build` produces deployable Pages assets.
- Staging Pages can call staging API.
- Production Pages can call production API.
- Deep links load through SPA fallback.
- Rollback path is documented.

### Implementation Note

`PR NS-5` adds Cloudflare Pages hosting for `apps/launch-web` without moving the
API off the existing Worker. Launch web now has:

- Pages config in `apps/launch-web/wrangler.toml`;
- build modes in `.env.staging` and `.env.production` that point at the staging
  and production API Worker origins;
- `_redirects` SPA fallback for deep links such as `/tools/:slug`, `/wallet`,
  `/settings`, and `/admin/tools/:id`;
- `_headers` for security headers and immutable asset caching;
- a dedicated `Launch Web Deploy` workflow for staging Pages branch deploys on
  `main` and production Pages branch deploys on release tags.

The API Worker CORS allowlist now includes
`https://staging.ultralight-launch-web.pages.dev` for staging and
`https://ultralight-launch-web.pages.dev` for production. Release topology,
environment isolation, evidence, runbook, and launch-gate scripts now treat the
Pages site as a release-critical surface.

### Closed Decisions

- Initial Pages domains are `*.pages.dev`:
  `https://staging.ultralight-launch-web.pages.dev` and
  `https://ultralight-launch-web.pages.dev`. Owned custom domains remain a
  follow-up after DNS/control-plane ownership is confirmed.
- Shared parent-domain auth cookies are deferred. Launch web uses bearer-token
  API calls with explicit CORS allowlists for this phase.

## PR NS-6 - Internal Cloud Rate Consistency

Status: implemented 2026-06-08.

Goal: every Cloudflare/provider passthrough charge uses the same configured internal rate model and records the config version.

### Scope

- Audit all Cloud unit calculations and remove hardcoded rate fallbacks where runtime config should be used.
- Ensure these resources use `platform_billing_config` or normalized `DEFAULT_BILLING_CONFIG` consistently:
  - Worker execution
  - D1 read/write
  - R2 operations
  - KV operations
  - widget pulls
  - storage at rest
- Store `billing_config_version` in all cloud usage holds/events/receipts where relevant.
- Add launch/API response copy that describes configured internal rates as authoritative.

### Expected Files

- `api/services/billing-config.ts`
- `api/services/cloud-usage.ts`
- `api/services/execution-settlement.ts`
- `api/services/storage.ts`
- `api/services/hosting-billing.ts`
- `api/src/bindings/database-binding.ts`
- `api/src/bindings/appdata-binding.ts`
- `api/src/bindings/memory-binding.ts`
- `shared/contracts/launch.ts`
- launch tests

### Acceptance Criteria

- Every cloud usage event includes the config version used to calculate the charge when available.
- Tests prove configured rates override defaults in at least Worker, D1, R2/KV, and storage paths.
- Receipts can show app fee, infra fee, and billing config version.
- Free-call sponsorship uses the same internal rate model.

### Out Of Scope

- Cloudflare invoice import.
- Live provider rate lookup.

### Implementation Note

`PR NS-6` makes configured internal rates and their version visible across
cloud usage events, holds, receipts, and launch wallet summaries.

- Runtime Worker holds already reserve and settle with `billing_config_version`;
  settlement now carries that version into call receipt logs and metadata.
- Direct infra debits can carry a `billingConfigVersion`, and R2/D1/widget
  operation metering continues to use the same billing config snapshot supplied
  by runtime preflight.
- `mcp_call_logs.billing_config_version` is added with a best-effort backfill
  from unambiguous `cloud_usage_events` receipt rows.
- Call receipts now expose `billing_config_version` and
  `billing_config_versions`; launch wallet receipt summaries expose
  `billingConfigVersion` and `billingConfigVersions`.
- Public billing config copy now states that Ultralight's configured internal
  cloud-unit and GB-month rates are authoritative.
- Tests now prove configured-rate overrides for Worker execution, D1 reads and
  writes, R2 operations, widget pulls, and storage-at-rest billing.

### Closed Decisions

- Receipt summaries use `billingConfigVersion` only when exactly one rate
  version applies; `billingConfigVersions` preserves all versions when a receipt
  spans multiple cloud usage event versions.
- Cloudflare invoice imports and live provider rate lookup remain intentionally
  out of scope. The authoritative rates are the configured internal rates.

## PR NS-7 - Platform Tool Embedding Index Schema

Status: implemented 2026-06-08; local Supabase pgTAP validation is pending a running Docker daemon.

Goal: make semantic discovery robust by storing embeddings at the app/function/skill/widget level.

### Scope

- Add a platform-owned semantic embedding table.
- Recommended shape:
  - `id`
  - `app_id`
  - `app_version`
  - `subject_type`: `app`, `function`, `skill`, `widget`, `platform_primitive`
  - `subject_id`
  - `embedding`
  - `embedding_text`
  - `embedding_text_hash`
  - `model`
  - `provider`
  - `embedding_charge_id`
  - `status`
  - `metadata`
  - `created_at`
  - `updated_at`
- Add search RPCs that can filter by visibility, subject type, app version, and minimum similarity.
- Keep `apps.skills_embedding` as compatibility aggregate until consumers migrate.

### Expected Files

- `supabase/migrations/*_tool_semantic_embedding_index.sql`
- `shared/contracts/launch.ts`
- `api/services/embedding.ts`
- `api/services/apps.ts`
- `api/handlers/discover.ts`
- `api/handlers/launch.ts`
- database tests

### Acceptance Criteria

- App-level and subject-level embeddings can be inserted idempotently.
- Search can return function and skill matches, not only app matches.
- Existing app search continues to work.
- Rows are version-aware, so old tool versions do not silently overwrite current semantic data.

### Decisions

- Closed: platform primitives live in the same `tool_semantic_embeddings`
  table with nullable `app_id` and `subject_type = 'platform_primitive'`.
- Closed: embeddings remain 1536 dimensions for all subjects to match the
  existing OpenRouter/OpenAI aggregate app embedding path.

### Implementation Note

`PR NS-7` adds `tool_semantic_embeddings` with version-aware subject
idempotency, service-role-only RPCs for upsert/search, and pgTAP coverage for
duplicate upserts, version separation, function/skill search, visibility
filters, and legacy `apps.skills_embedding` compatibility. Launch discovery now
tries the subject-level index first and carries match subject metadata in
`relevance`; it falls back to the legacy aggregate `search_apps` RPC while the
new index is empty during rollout.

## PR NS-8 - Embedding Generation Pipeline Productionization

Status: implemented 2026-06-08; local Supabase pgTAP validation is pending a running Docker daemon.

Goal: make embedding generation charged, idempotent, retryable, and complete for app subjects.

### Scope

- Generate embeddings for:
  - app summary
  - each manifest function
  - each first-class skill
  - each public widget/action surface where useful
- Charge publisher using `record_embedding_generation_charge`.
- Link semantic index rows to embedding charge rows.
- Add idempotency by `app_id`, `app_version`, `subject_type`, `subject_id`, and text hash.
- Add retry/backfill path for missing or failed embeddings.
- Add admin/operator logs for insufficient balance, provider failure, and skipped embedding.

### Expected Files

- `api/services/library.ts`
- `api/services/embedding.ts`
- `api/services/embedding-billing.ts`
- `api/services/embedding-processor.ts`
- `supabase/migrations/*_tool_semantic_embedding_retry_state.sql`
- `api/handlers/platform-mcp.ts`
- `api/handlers/upload.ts`
- `api/handlers/apps.ts`
- service tests

### Acceptance Criteria

- Publishing a tool version writes semantic index rows for app/function/skill subjects.
- Duplicate publish/upload retries do not duplicate embedding charges.
- Insufficient balance is rare because of PR NS-4, but still logged and reported deterministically.
- Failed embeddings can be retried without corrupting existing successful rows.

### Decisions

- Closed: publish/upload allows partial semantic availability. Provider or
  billing failures mark the affected subject row `failed`, keep it out of
  search, and do not block the tool publish.
- Closed: subject embedding text is capped at 6,000 words before provider calls,
  matching the existing content embedding cap.

### Implementation Note

`PR NS-8` adds deterministic subject text builders and a production generation
pipeline for app, function, skill, and widget subjects. Each subject calls the
embedding provider, records publisher pass-through billing with a subject-level
idempotency key, links the semantic row to the charge, and stores the app
subject vector as the legacy aggregate `embedding.json`/`apps.skills_embedding`
compatibility path. Failed provider/billing states upsert non-searchable rows
for retry. `processToolSemanticEmbeddingBackfill()` is available as an
operator-triggered retry/backfill path for missing or failed app subjects.

## PR NS-9 - Semantic Discovery Consumer Migration

Goal: use the new embedding index in launch/API/platform-agent discovery paths.

Status: Implemented 2026-06-08.

### Scope

- Migrate launch store search to query the new semantic index.
- Migrate platform MCP appstore discovery to use subject-level results.
- Return why a result matched: app, function, skill, widget, or platform primitive.
- Preserve fallback to existing app aggregate embeddings while rollout is incomplete.
- Add user-facing/agent-facing fields that expose relevant function/skill summaries without leaking paid full skill bodies.

### Expected Files

- `api/handlers/launch.ts`
- `api/handlers/discover.ts`
- `api/handlers/platform-mcp.ts`
- `api/services/context-resolver.ts`
- `api/services/function-index.ts`
- `shared/contracts/launch.ts`
- launch/platform MCP tests

Actual implementation:

- `api/handlers/launch.ts` was already migrated in `PR NS-7` to prefer
  subject-level semantic results and expose launch `relevance.subjectType`,
  `subjectId`, `subjectLabel`, and fallback retrieval metadata.
- `api/handlers/discover.ts` now prefers `search_tool_semantic_embeddings`
  for public app search and marketplace app search, falls back to legacy
  aggregate `search_apps`, and returns safe `matched_subject` metadata with
  next-action hints for functions, skills, and widgets.
- `api/handlers/platform-mcp.ts` now uses the subject semantic index for
  `ul.discover({ scope: "appstore" })`, preserves aggregate embedding
  fallback, and serializes `matched_subject` so agents know whether to call a
  function, pull a skill, inspect the tool, or open a widget.
- `api/services/embedding.ts` semantic subject metadata now carries safe
  function/skill/widget preview fields from manifest declarations only; it
  does not include paid full skill bodies.
- `api/handlers/discover.test.ts` and
  `api/handlers/platform-mcp-discovery.test.ts` cover subject discovery,
  skill preview pull hints, platform MCP function call hints, and legacy
  fallback.

### Acceptance Criteria

- Search for a function-like query can surface a matching function even if the app name does not match.
- Search for a skill/context query can surface a matching skill preview without exposing the paid body.
- Platform MCP discovery responses tell agents what to call or pull next.
- Fallback behavior remains stable when the new index is empty.

## PR NS-10 - Platform Docs Skills Agent Guidance

Goal: improve the platform skills docs so connected agents can use and link Ultralight surfaces naturally.

Status: Implemented 2026-06-08.

### Scope

- Refine `buildPlatformDocs()` into compact, retrieval-friendly sections.
- Add explicit agent guidance for when to include URLs in responses:
  - install/connect: `/install`
  - manage wallet/balance: `/wallet`
  - manage API keys/preferences: `/settings`
  - manage tool permissions: `/admin/tools/:id`
  - inspect public tool UI: `/tools/:slug`
  - API/OpenAPI docs: `/api/launch/openapi.json`
  - platform skills: `/api/skills`
- Add guidance that agents should link only when the URL helps the current user action.
- Document first-class skills, skill pull pricing, and programmable policy examples concisely.
- Add snapshot/string tests for the most important agent instructions.

### Expected Files

- `api/handlers/platform-mcp.ts`
- `api/handlers/platform-mcp-scaffold.test.ts`
- new platform docs tests if useful
- `docs/PLATFORM-MCP-CLI-DESIGN.md` if still current

Actual implementation:

- `api/handlers/platform-mcp.ts` keeps `buildPlatformDocs()` as the shared
  source for initialize instructions, `resources/read` of
  `ultralight://platform/skills.md`, and `GET /api/skills`.
- Added compact sections for agent URL guidance, route selection, first-class
  skills, skill pull pricing, and programmable permissions/monetization.
- URL guidance now tells agents to link only when the URL helps the user's
  current action and names the preferred launch routes.
- Skill guidance now states that skills are semantic context beside functions;
  pulling a skill imports full context into the agent and may charge Light, but
  does not run a Worker function.
- Policy guidance now documents `ul.download({ policy: true })`,
  `access_policy`, the `planAccess` export, and the shared function/skill
  custom-coded permission and monetization contract.
- `api/handlers/platform-mcp-docs.test.ts` verifies initialize,
  `resources/read`, and `GET /api/skills` expose the same core guidance.

### Acceptance Criteria

- `initialize`, `resources/read`, and `GET /api/skills` agree on core guidance.
- Agents are told when to post Ultralight URLs and which routes to prefer.
- Docs mention skill pulls as context retrieval, not Worker execution.
- Docs mention `policy: true` scaffolding and the access-policy contract.

## PR NS-11 - Launch Hosting Smoke And Release Gate

Goal: make Pages plus API deploys repeatable and hard to accidentally ship broken.

Status: Implemented 2026-06-08.

### Scope

- Add a staging smoke checklist for launch Pages.
- Verify anonymous routes:
  - `/`
  - `/install`
  - `/store`
  - `/tools/:slug`
- Verify authenticated routes with a staging token:
  - `/library`
  - `/wallet`
  - `/settings`
  - `/admin/tools/:id`
- Verify CORS, deep-link fallback, API status, and OpenAPI.
- Add release evidence template entries for launch-web deploys.

### Expected Files

- `docs/SMOKE_CHECKLISTS.md`
- `docs/RELEASE_PACKET_TEMPLATE.md`
- `docs/RELEASE_RUNBOOK.md`
- optional Playwright/smoke script under `scripts/`

Actual implementation:

- Added `scripts/smoke/launch-web-pages-smoke.mjs` as the repeatable
  launch-web Pages smoke. It records exact Pages/API URLs, checks public
  routes, authenticated SPA routes, launch API status/OpenAPI/store data,
  CORS preflight from the Pages origin, and authenticated API probes when a
  token is supplied.
- `docs/SMOKE_CHECKLISTS.md` now uses the script for staging and production and
  names failure classes: `pages-routing`, `pages-spa-shell`, `api-status`,
  `api-openapi`, `api-data`, `api-cors`, `auth-api`, and `auth-data`.
- `docs/RELEASE_PACKET_TEMPLATE.md` now has launch-web Pages JSON/Markdown
  evidence rows and route-specific signoff rows.
- `docs/LAUNCH_EVIDENCE_REGISTRY.md` now lists
  `smoke/launch-web-pages.json` and `smoke/launch-web-pages.md` as required
  staging/production evidence.
- `docs/RELEASE_RUNBOOK.md` now calls the script in both staging and
  production release flows.

### Acceptance Criteria

- Release operators have one checklist for Pages + API.
- Smoke failures identify whether the issue is Pages, API, auth, CORS, or data.
- The checklist records exact staging/production URLs.

## Deferred Tracks

### Cloudflare Durable Objects

Deferred unless DB contention, latency, or operational evidence shows DB-only atomicity is insufficient. If revived, scope it as a per-user spend sequencer that calls the existing DB RPCs and relies on DB idempotency for truth.

### Sales Tax

Deferred. Existing foundation remains useful, but do not enable tax charging without rate data, taxable category decisions, reconciliation, and counsel/CPA review.

### Public Launch Tool SEO

Deferred. Legacy `/app/:id` SSR SEO remains the SEO-preserving public surface until `/tools/:slug` gets server-rendered metadata or prerendering.

## Implementation Rule

Before starting code for any item above:

- Name the active PR ID, for example `PR NS-2`.
- Confirm the locked decisions still apply.
- Keep edits scoped to that PR's acceptance criteria.
- Update this document if scope changes.
- In the final implementation summary, state which PR ID was advanced and which acceptance criteria were verified.
