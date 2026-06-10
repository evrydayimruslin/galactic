# Wave 4 Legacy Removal And Architecture Roadmap

Wave 4 is the convergence-and-deletion wave. Earlier waves made the platform
safer and more uniform; Wave 4 needs to remove the compatibility code,
non-canonical runtime stories, and historical artifacts that still make the
repo harder to reason about than the live product actually is.

This roadmap is intentionally high-resolution. The goal is not a vague
"cleanup legacy code" sweep. The goal is to remove legacy behavior in
reviewable slices: first make runtime and shim usage measurable, then migrate
live consumers onto the canonical paths, then delete or archive the old ones.

## Current State

As of April 21, 2026, the main Wave 4 legacy and architecture hotspots are:

- [api/src/worker-entry.ts](../api/src/worker-entry.ts)
  plus [api/wrangler.toml](../api/wrangler.toml)
  and [.github/workflows/api-deploy.yml](../.github/workflows/api-deploy.yml)
  define the current primary API runtime and deployment path.
- The former conflicting API deployment story has now been moved into
  [archive/legacy-runtime/](../archive/legacy-runtime),
  including
  [archive/legacy-runtime/api-main.ts](../archive/legacy-runtime/api-main.ts),
  [archive/legacy-runtime/Dockerfile](../archive/legacy-runtime/Dockerfile),
  and
  [archive/legacy-runtime/do-app.yaml](../archive/legacy-runtime/do-app.yaml).
  That path is now historical reference only rather than an active deployment
  story in the runtime tree.
- [worker/src/index.ts](../worker/src/index.ts)
  is not a dead file. It is still a distinct internal data-layer worker behind
  `WORKER_DATA_URL` / `WORKER_SECRET`, with active references in
  [api/handlers/mcp.ts](../api/handlers/mcp.ts),
  [api/handlers/app.ts](../api/handlers/app.ts),
  [docs/CF-WORKERS-SETUP.md](CF-WORKERS-SETUP.md),
  and [docs/P1-SCALING-PLAN.md](P1-SCALING-PLAN.md).
  Wave 4 needs an explicit decision: retain it as part of the canonical
  production architecture, or retire it.
- The old root `migration-*.sql` family has now been moved under
  [archive/root-migrations/](../archive/root-migrations),
  and
  [supabase/README.md](../supabase/README.md)
  plus the launch guardrail now treat `supabase/migrations/` as the only
  canonical schema path.
- `api/main.ts.bak`, `desktop/public/onboarding-preview.html`, and
  `test-parser.ts` have now been deleted as stray non-runtime artifacts.
- The runtime Supabase resolution path in
  [api/services/app-runtime-resources.ts](../api/services/app-runtime-resources.ts)
  now emits structured `app_supabase_resolution` log events and enforces
  canonical saved-config resolution on `run`, `http`, and `mcp` hot paths.
  Legacy app-level creds and platform-default resolution remain only as
  migration surfaces and audit inputs, not as silent runtime fallbacks.
- Manifest-first convergence is not actually complete. Hot paths in
  [api/handlers/mcp.ts](../api/handlers/mcp.ts),
  [api/handlers/app.ts](../api/handlers/app.ts),
  [api/handlers/apps.ts](../api/handlers/apps.ts),
  [api/services/function-index.ts](../api/services/function-index.ts),
  and [web/layout.ts](../web/layout.ts)
  still rely on `skills_parsed` and `exports` fallbacks.
- [api/handlers/platform-mcp.ts](../api/handlers/platform-mcp.ts)
  still dispatches 27 backward-compat tool aliases plus `ul.execute`.
  [desktop/src/lib/agentLoop.ts](../desktop/src/lib/agentLoop.ts)
  still recognizes both canonical and old codemode names.
- Widget discovery in
  [desktop/src/hooks/useWidgetInbox.ts](../desktop/src/hooks/useWidgetInbox.ts)
  now inventories legacy single-function widget contracts through
  [desktop/src/lib/widgetContracts.ts](../desktop/src/lib/widgetContracts.ts)
  and the local `ul_widget_contract_inventory_v1` key, but the fallback path is
  still active until final removal.
- Browser-side auth migration shims have now been removed from
  [web/layout.ts](../web/layout.ts),
  [api/handlers/developer.ts](../api/handlers/developer.ts),
  [api/handlers/app.ts](../api/handlers/app.ts),
  and [api/handlers/auth.ts](../api/handlers/auth.ts).
  The remaining desktop-side shim in
  [desktop/src/lib/storage.ts](../desktop/src/lib/storage.ts)
  is now fenced by a one-time `ul_auth_storage_migrated_v1` marker instead of
  staying as an unbounded import path forever.
- API token compatibility still depends on legacy schema/data branches in
  [api/services/tokens.ts](../api/services/tokens.ts),
  especially `token_salt` absence and `plaintext_token` column fallback.
- Secret/API-key encryption still supports legacy blob shapes in
  [api/services/envvars.ts](../api/services/envvars.ts),
  [api/services/api-key-crypto.ts](../api/services/api-key-crypto.ts),
  [api/services/openrouter-keys.ts](../api/services/openrouter-keys.ts),
  and [api/handlers/oauth.ts](../api/handlers/oauth.ts).

## Wave 4 Principles

- Runtime architecture should be obvious from the repo root. A new engineer
  should be able to answer "what actually runs in staging and production?"
  without reading four historical plans.
- Compatibility code should disappear in stages:
  telemetry first, migration second, deletion third.
- Launch-critical runtime paths should not depend on invisible fallback legs.
- Historical reference material is acceptable, but it should live in clearly
  archived locations instead of active runtime trees.
- Data-format compatibility branches should be removed only after explicit
  backfill, rotation, or environment proof.
- Wave 4 should reduce operational ambiguity, not just reduce file count.

## Scope Boundaries

Wave 4 includes:

- runtime architecture ratification and repo cleanup
- migration/archive of non-live deployment artifacts
- telemetry and removal plans for live compatibility shims
- Supabase config fallback removal
- manifest-first carry-over cleanup where `skills_parsed` remains in hot paths
- platform MCP alias retirement
- legacy widget contract retirement
- auth/token/secret compatibility bridge retirement
- fencing or archiving of historical migration files

Wave 4 does not include:

- broad UI polish and placeholder-text cleanup that belongs to Wave 5
- backup/restore drills, rollback rehearsal, or production signoff, which
  belong to Wave 6
- major product redesigns just to simplify legacy deletion
- deleting experimental or historical material without first deciding whether
  it is still part of the intended architecture

## Wave 4 PR Slices

### PR4.1 Runtime Architecture ADR And Inventory

Status: `implemented locally`

Purpose:

- ratify the canonical production architecture in one sentence
- classify every runtime/deployment path as canonical, secondary, transitional,
  experimental, archived, or dead
- make later removal PRs mechanically reviewable instead of philosophical

Expected files:

- `docs/WAVE4_LEGACY_ARCHITECTURE_ROADMAP.md`
- `docs/RUNTIME_ARCHITECTURE_DECISION.md` (new)
- [docs/RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md)
- [docs/LAUNCH_ROUTE_INVENTORY.md](LAUNCH_ROUTE_INVENTORY.md)

Acceptance:

- the repo has an explicit runtime classification table covering:
  - `api/src/worker-entry.ts`
  - `worker/src/index.ts`
  - `archive/legacy-runtime/api-main.ts`
  - `archive/legacy-runtime/do-app.yaml`
  - `archive/legacy-runtime/Dockerfile`
  - `archive/experimental/future-wfp/`
- one short canonical architecture statement is agreed and repeated in the
  release runbook
- every later Wave 4 PR can reference this decision instead of restating it

Verification:

- docs review
- cross-check against deploy workflow files and route inventory

Risks:

- if this decision is skipped, later PRs can archive something still considered
  "temporarily live" by another part of the repo

Implemented in this tranche:

- added
  [docs/RUNTIME_ARCHITECTURE_DECISION.md](RUNTIME_ARCHITECTURE_DECISION.md)
  with one canonical architecture statement, a runtime classification table,
  and explicit treatment of the API Worker, data worker, DO/Deno path, root
  migration family, and `_future-wfp/`
- updated
  [docs/RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md)
  so the operator flow now references the canonical runtime architecture instead
  of implying multiple current backend stories
- updated
  [docs/LAUNCH_ROUTE_INVENTORY.md](LAUNCH_ROUTE_INVENTORY.md)
  so the inventory clearly distinguishes the main API Worker from the separate
  internal data worker and from the non-canonical DO/Deno artifacts

### PR4.2 Non-Live API Runtime Archive

Status: `implemented locally`

Purpose:

- remove the false impression that the DigitalOcean + Deno process model is a
  first-class launch path
- either archive or delete the non-canonical runtime entry files and docs

Expected files:

- [archive/legacy-runtime/api-main.ts](../archive/legacy-runtime/api-main.ts)
- [archive/legacy-runtime/Dockerfile](../archive/legacy-runtime/Dockerfile)
- [archive/legacy-runtime/do-app.yaml](../archive/legacy-runtime/do-app.yaml)
- docs that still present DO as current

Acceptance:

- if the DO runtime is no longer supported, these files are moved to an
  explicit archive area or deleted
- if the DO runtime is intentionally kept as emergency fallback, the archive
  makes that status explicit and removes it from the active API tree
- no release/operator doc implies that the old Deno entrypoint is the current
  production entry point

Verification:

- `rg` for references to `archive/legacy-runtime/`, `api/main.ts`,
  `Dockerfile`, and `.do/app.yaml`
- release runbook review
- deploy docs review

Risks:

- if any emergency or local-dev process still depends on the old path, that
  dependency needs to be rehomed before deletion

Implemented in this tranche:

- moved the former DO/Deno runtime files out of the active tree into
  [archive/legacy-runtime/](../archive/legacy-runtime),
  with a small archive README describing their historical status
- removed the stale `deno.json` export and `api/knip.json` references that
  still treated `api/main.ts` as an active entrypoint
- updated active operator/runtime docs so they now point at the archive rather
  than implying the old path is still a supported deployment option

### PR4.3 Data Worker Decision And Boundary Cleanup

Status: `implemented locally (first-party migration tranche)`

Purpose:

- decide whether the separate data-layer worker is still part of the intended
  architecture or only a legacy split-plane optimization
- either promote it into an explicit supported secondary runtime or retire it

Expected files:

- [worker/src/index.ts](../worker/src/index.ts)
- [worker/wrangler.toml](../worker/wrangler.toml)
- [api/handlers/mcp.ts](../api/handlers/mcp.ts)
- [api/handlers/app.ts](../api/handlers/app.ts)
- [docs/CF-WORKERS-SETUP.md](CF-WORKERS-SETUP.md)
- [docs/P1-SCALING-PLAN.md](P1-SCALING-PLAN.md)

Acceptance:

- the architecture ADR states one of:
  - the data worker is canonical and remains supported
  - the data worker is transitional and has a removal path
  - the data worker is archived
- all callers and docs are updated to match that status
- feature-flag env vars like `WORKER_DATA_URL` and `WORKER_SECRET` are either
  documented as active or removed from the intended launch path

Verification:

- call-site search for `WORKER_DATA_URL` and `WORKER_SECRET`
- route inventory update for internal worker routes
- docs review

Risks:

- this is the easiest place for hidden architecture drift to survive because it
  looks "internal" while still being operationally significant

### PR4.4 Root Migration Family Archive And Canonical Schema Fence

Status: `implemented locally`

Purpose:

- stop the root `migration-*.sql` family from competing with
  `supabase/migrations/`
- preserve history without letting current launch-critical schema work land in
  the wrong place

Expected files:

- [archive/root-migrations/](../archive/root-migrations)
- [supabase/README.md](../supabase/README.md)
- optional archive README and index map
- launch guardrail workflow/scripts if a fence check is added

Acceptance:

- root migration files are moved into an explicit archive/history location or
  otherwise fenced off from active schema work
- a small README explains that these files are historical and points to the
  canonical baseline and follow-up migrations
- CI or a guardrail check fails if new launch-critical migrations are added at
  the repo root

Verification:

- `find . -maxdepth 1 -name 'migration-*.sql'`
- docs review
- guardrail dry run if added

Risks:

- if any root file contains the only copy of a required schema delta, the move
  must include an index or canonical migration backfill first

Implemented in this tranche:

- moved the legacy root `migration-*.sql` files into
  [archive/root-migrations/](../archive/root-migrations)
  and added a small archive README pointing future schema work at
  [supabase/migrations/](../supabase/migrations)
- updated
  [supabase/README.md](../supabase/README.md)
  so the canonical schema rule now points at the archive instead of treating
  the repo root as a still-present historical workspace
- added a launch guardrail that rejects new root-level `migration-*.sql` files
  and wired the workflow trigger so that guardrail runs if someone adds one

### PR4.5 Supabase Config Fallback Telemetry

Status: `implemented locally`

Purpose:

- make the runtime Supabase fallback chain measurable before removing legs
- identify which apps still rely on app-level creds or platform defaults

Expected files:

- [api/services/app-runtime-resources.ts](../api/services/app-runtime-resources.ts)
- [api/handlers/run.ts](../api/handlers/run.ts)
- [api/handlers/http.ts](../api/handlers/http.ts)
- [api/handlers/mcp.ts](../api/handlers/mcp.ts)
- optional docs/report output under `docs/`

Acceptance:

- every runtime resolution of Supabase config records which leg was used:
  - `config_id`
  - legacy app-level encrypted creds
  - platform default
  - none
- the telemetry is queryable enough to build an app migration list
- no behavior changes yet beyond measurement and operator visibility

Verification:

- unit tests around resolution telemetry
- local log/telemetry smoke
- docs/report generation if added

Risks:

- if telemetry is too ad hoc, removal timing will still be guesswork

Implemented in this tranche:

- added
  [api/services/app-runtime-telemetry.ts](../api/services/app-runtime-telemetry.ts)
  with a structured `app_supabase_resolution` log shape that records the
  runtime resolution source, whether migration is still required, and whether
  fallback was used
- updated
  [api/services/app-runtime-resources.ts](../api/services/app-runtime-resources.ts)
  so every Supabase runtime resolution now records one of:
  `saved_config`, `legacy_app_config`, `platform_default`, or `none`
- added focused verification in
  [api/services/app-runtime-resources.test.ts](../api/services/app-runtime-resources.test.ts)
  for canonical, fallback, and unresolved resolution paths

### PR4.6 Supabase Config Migration And Hot-Path Removal

Status: `implemented locally`

Purpose:

- migrate apps onto canonical saved `supabase_config_id` usage
- remove legacy app-level and platform-default Supabase resolution from
  execution hot paths

Expected files:

- [api/services/app-runtime-resources.ts](../api/services/app-runtime-resources.ts)
- [api/handlers/apps.ts](../api/handlers/apps.ts)
- [api/handlers/user.ts](../api/handlers/user.ts)
- possible migration/backfill scripts under `scripts/`
- docs/runbook updates

Acceptance:

- launch-critical execution paths only accept canonical config resolution
- app settings UI/API still expose enough information to migrate old apps
- legacy app-level credential fields become read-only migration surfaces or are
  removed entirely
- platform-default resolution no longer silently powers normal runtime calls

Verification:

- `api` typecheck/tests
- targeted runtime resource tests
- staged migration dry run against real app metadata

Risks:

- this can break real apps if the migration list is incomplete, so telemetry and
  backfill tooling must land first

Implemented in this tranche:

- updated
  [api/services/app-runtime-resources.ts](../api/services/app-runtime-resources.ts)
  so canonical saved-config resolution is now the only accepted runtime path on
  launch-critical execution surfaces; legacy app-level and platform-default
  resolution now raise explicit migration errors instead of silently powering
  execution
- added
  [scripts/supabase/audit-app-supabase-configs.mjs](../scripts/supabase/audit-app-supabase-configs.mjs)
  to build a real migration report from Supabase metadata before staging or
  production rollout
- updated
  [api/handlers/run.ts](../api/handlers/run.ts),
  [api/handlers/http.ts](../api/handlers/http.ts),
  and [api/handlers/mcp.ts](../api/handlers/mcp.ts)
  so app execution now fails explicitly with migration guidance when an app is
  still relying on a removed fallback leg
- updated
  [api/handlers/apps.ts](../api/handlers/apps.ts),
  [api/handlers/user.ts](../api/handlers/user.ts),
  and [api/handlers/platform-mcp.ts](../api/handlers/platform-mcp.ts)
  so assigning a saved Supabase config clears legacy app-level credential
  fields instead of leaving stale fallback state behind

### PR4.7 Manifest-First Runtime Convergence

Status: `implemented locally`

Purpose:

- close the biggest carry-over compatibility shim from earlier waves:
  `skills_parsed` and `exports` fallback in hot discovery/tooling paths
- make manifests the only canonical source for tool schemas in launch-critical
  flows

Expected files:

- [api/handlers/mcp.ts](../api/handlers/mcp.ts)
- [api/handlers/app.ts](../api/handlers/app.ts)
- [api/handlers/apps.ts](../api/handlers/apps.ts)
- [api/services/function-index.ts](../api/services/function-index.ts)
- [web/layout.ts](../web/layout.ts)
- [api/services/library.ts](../api/services/library.ts)

Acceptance:

- there is a manifest coverage report for stored apps
- new publish/update flows require manifest coverage at the level needed by the
  runtime and UI
- hot paths stop preferring `skills_parsed` or `exports` when manifest is
  absent; instead they use canonical manifest-backed contracts or explicit
  migration guidance
- `skills_parsed` can remain as historical/indexing data only if it is clearly
  non-canonical

Verification:

- typecheck/tests
- targeted MCP tools/list and app-shell smoke
- report showing fallback usage trending toward zero

Risks:

- some stored apps may still need automated manifest backfill before the hot
  path can stop tolerating old shapes

Implemented in this tranche:

- added
  [api/services/app-contracts.ts](../api/services/app-contracts.ts)
  plus
  [api/services/app-contracts.test.ts](../api/services/app-contracts.test.ts)
  so manifest-backed contracts, legacy `skills_parsed` metadata, and export
  fallbacks now resolve through one shared helper with structured
  `app_contract_resolution` telemetry
- updated
  [api/handlers/mcp.ts](../api/handlers/mcp.ts)
  so `tools/list` and `tools/call` now require manifest-backed contracts on the
  live MCP protocol path; legacy metadata is no longer silently used there
- updated
  [api/handlers/app.ts](../api/handlers/app.ts),
  [api/handlers/apps.ts](../api/handlers/apps.ts),
  [api/services/function-index.ts](../api/services/function-index.ts),
  and [web/layout.ts](../web/layout.ts)
  so owner-facing shells still expose legacy detections only as migration
  guidance instead of presenting them as canonical runtime contracts
- added
  [scripts/apps/audit-app-manifest-coverage.mjs](../scripts/apps/audit-app-manifest-coverage.mjs)
  so staging/production metadata can be audited before the remaining legacy UI
  fallback is removed
- added
  [api/services/app-manifest-generation.ts](../api/services/app-manifest-generation.ts)
  plus
  [api/services/app-manifest-generation.test.ts](../api/services/app-manifest-generation.test.ts)
  so source-derived manifest generation, rich uploaded manifest merging, stored
  draft manifest recovery, and `manifest.json` upload replacement now live in
  one shared lifecycle helper instead of being reimplemented piecemeal
- updated
  [api/services/upload-pipeline.ts](../api/services/upload-pipeline.ts),
  [api/handlers/upload.ts](../api/handlers/upload.ts),
  and the draft-upload surfaces so new uploads and drafts now preserve rich
  uploaded manifests when present, auto-generate manifest-backed contracts from
  source when needed, and always write a canonical `manifest.json` into stored
  app versions
- updated
  [api/handlers/apps.ts](../api/handlers/apps.ts)
  so draft publish now resolves manifest coverage from stored draft files,
  regenerates `manifest.json` when the draft only has source code, logs
  `app_contract_resolution` for the publish surface, and blocks publish when a
  draft still lacks manifest-backed contracts after recovery
- updated
  [api/services/library.ts](../api/services/library.ts)
  so artifact regeneration now shares the same manifest merge/generation logic
  as uploads and publishes instead of keeping a parallel implementation

### PR4.8 Platform MCP Alias Telemetry And Deprecation Map

Status: `implemented locally`

Purpose:

- make alias usage measurable before deleting it
- publish the canonical replacement for every backward-compat tool name

Expected files:

- [api/handlers/platform-mcp.ts](../api/handlers/platform-mcp.ts)
- [desktop/src/lib/agentLoop.ts](../desktop/src/lib/agentLoop.ts)
- new docs map under `docs/`

Acceptance:

- every alias dispatch increments a named counter or equivalent telemetry event
- a deprecation map lists:
  - old name
  - canonical replacement
  - removal wave or milestone
- first-party callers stop generating old names

Verification:

- alias hit tests if practical
- docs review
- call-site search for deprecated names

Risks:

- deleting aliases without measuring them is exactly the kind of launch-risky
  cleanup Wave 4 is meant to avoid

Implemented in this tranche:

- added
  [api/services/platform-alias-telemetry.ts](../api/services/platform-alias-telemetry.ts)
  plus
  [api/services/platform-alias-telemetry.test.ts](../api/services/platform-alias-telemetry.test.ts)
  so alias dispatch now emits structured `platform_mcp_alias` log events with
  the alias name, canonical replacement, and any known removal blocker
- updated
  [api/handlers/platform-mcp.ts](../api/handlers/platform-mcp.ts)
  so every backward-compat alias case routes through shared alias telemetry
  before dispatch
- added
  [docs/PLATFORM_MCP_ALIAS_DEPRECATION_MAP.md](PLATFORM_MCP_ALIAS_DEPRECATION_MAP.md)
  to document each deprecated tool name, its canonical replacement, and the
  blockers that still prevent removal

### PR4.9 Platform MCP Alias Removal

Status: `implemented locally (first-party migration tranche)`

Purpose:

- remove the 27 backward-compat aliases and `ul.execute` after telemetry and
  caller migration prove they are no longer needed

Expected files:

- [api/handlers/platform-mcp.ts](../api/handlers/platform-mcp.ts)
- [desktop/src/lib/agentLoop.ts](../desktop/src/lib/agentLoop.ts)
- any docs/prompts/examples still using old names

Acceptance:

- platform MCP only advertises and dispatches canonical tool names
- first-party desktop/orchestrator/client code uses canonical names only
- docs no longer teach alias names

Verification:

- typecheck/tests
- MCP tool listing smoke
- search for removed alias names across repo docs and app code

Risks:

- user-authored prompts or saved recipes may still reference old names, so
  telemetry and communication matter

Implemented in this tranche:

- updated first-party desktop and prompt surfaces such as
  [desktop/src/lib/systemAgents.ts](../desktop/src/lib/systemAgents.ts),
  [apps/mcps/sending/index.ts](../apps/mcps/sending/index.ts),
  and representative app manifests so they now teach canonical `ul.rate`,
  `ul.upload`, and `ul.set` usage instead of deprecated alias names
- migrated the first-party CLI in
  [cli/mod.ts](../cli/mod.ts) onto
  canonical `ul.download`, `ul.test`, `ul.discover`, `ul.set`, and
  `ul.permissions` calls, and aligned its response handling with the current
  canonical result shapes
- updated high-traffic first-party docs in
  [README.md](../README.md) and
  [apps/mcps/sending/manifest.json](../apps/mcps/sending/manifest.json)
  so the repo's main entry surfaces no longer teach alias names for scaffold,
  lint, discovery, settings, or permission flows
- added a dormant rollout control in
  [api/services/platform-alias-telemetry.ts](../api/services/platform-alias-telemetry.ts),
  [api/handlers/platform-mcp.ts](../api/handlers/platform-mcp.ts),
  and [api/wrangler.toml](../api/wrangler.toml)
  so staging or production can disable the removable alias set with
  `PLATFORM_MCP_DISABLED_ALIASES=removable` after telemetry review, without
  another code pass
- updated user-facing server hints in
  [api/handlers/platform-mcp.ts](../api/handlers/platform-mcp.ts)
  so upload, health-resolution, publish, and lint guidance now points at
  canonical `ul.set`, `ul.logs`, `ul.upload`, `ul.test`, and `ul.discover`
  shapes
- updated historical design docs such as
  [docs/CODE-MODE-ARCHITECTURE.md](CODE-MODE-ARCHITECTURE.md),
  [docs/CF-DYNAMIC-WORKERS-INTEGRATION.md](CF-DYNAMIC-WORKERS-INTEGRATION.md),
  and
  [docs/DEFAULT-AGENTS-DESIGN.md](DEFAULT-AGENTS-DESIGN.md)
  so the repo now teaches canonical tool names outside the explicit
  deprecation-map documents
- the remaining PR4.9 blocker is deliberate: server-side alias dispatch in
  [api/handlers/platform-mcp.ts](../api/handlers/platform-mcp.ts)
  still needs live `platform_mcp_alias` log review plus resolution of the alias
  surfaces that do not yet have a public canonical replacement; the new staged
  disable flag only covers the removable alias set

### PR4.10 Widget Contract Migration

Status: `implemented locally`

Purpose:

- migrate widget discovery and execution onto the canonical split
  `_widget_*_ui` / `_widget_*_data` model
- remove legacy single-function widget fallbacks

Expected files:

- [desktop/src/hooks/useWidgetInbox.ts](../desktop/src/hooks/useWidgetInbox.ts)
- widget-related MCP app implementations as needed
- docs or tooling that teach widget contracts

Acceptance:

- there is an inventory of apps still discovered only via legacy widget names
- those apps are migrated or flagged before fallback removal
- desktop widget discovery no longer needs the `LEGACY_WIDGET_FUNCTIONS` list
- the canonical widget contract is documented in one place

Verification:

- desktop widget tests if present
- targeted widget inbox discovery smoke
- repo search for `LEGACY_WIDGET_FUNCTIONS`

Risks:

- widgets are user-facing integration surfaces, so silent removal without an app
  inventory would create confusing inbox regressions

Implemented in this tranche:

- added
  [docs/WIDGET_CONTRACTS.md](WIDGET_CONTRACTS.md)
  as the canonical description of the split widget contract and the local
  legacy-inventory key used by desktop
- added
  [desktop/src/lib/widgetContracts.ts](../desktop/src/lib/widgetContracts.ts)
  plus
  [desktop/src/lib/widgetContracts.test.ts](../desktop/src/lib/widgetContracts.test.ts)
  so desktop widget discovery now detects canonical and legacy contracts by
  shape instead of a hardcoded legacy-name list
- updated
  [desktop/src/hooks/useWidgetInbox.ts](../desktop/src/hooks/useWidgetInbox.ts)
  to record local inventory for legacy single-function widgets under
  `ul_widget_contract_inventory_v1`
- updated
  [apps/mcps/email-ops/manifest.json](../apps/mcps/email-ops/manifest.json)
  so the first-party widget declaration now points at the canonical
  `email_inbox` / `widget_email_inbox_data` contract instead of the legacy
  `widget_approval_queue` declaration
- added `scripts/checks/check-widget-contracts.mjs` and wired it into
  [.github/workflows/api-ci.yml](../.github/workflows/api-ci.yml)
  so first-party manifests cannot silently drift back to legacy widget
  declarations (retired 2026-06-10 by the Phase 1 launch pivot — widgets
  left the launch scope; see
  [LAUNCH_PIVOT_DECISIONS.md](LAUNCH_PIVOT_DECISIONS.md))

### PR4.11 Browser And Desktop Auth Migration Cleanup

Status: `implemented locally (browser cleanup + desktop migration-marker tranche)`

Purpose:

- remove the remaining browser/desktop auth migration shims after version-floor
  and cookie-session confidence are established

Expected files:

- [web/layout.ts](../web/layout.ts)
- [api/handlers/auth.ts](../api/handlers/auth.ts)
- [api/handlers/developer.ts](../api/handlers/developer.ts)
- [desktop/src/lib/storage.ts](../desktop/src/lib/storage.ts)

Acceptance:

- browser shells no longer migrate `ultralight_token` /
  `ultralight_refresh_token` from localStorage into sessions
- the desktop auth token migration from localStorage to secure storage is
  removed after the version floor or migration marker is established
- developer portal auth bootstrap no longer contains legacy browser token
  bridges

Verification:

- focused auth bootstrap tests
- desktop storage tests
- repo search for `ultralight_token`, `ultralight_refresh_token`, and
  `ul_token` migration logic

Risks:

- removing these too early can strand old clients, so this PR depends on a
  minimum supported version decision and rollout evidence

Implemented in this tranche:

- removed legacy browser session bootstrap from
  [web/layout.ts](../web/layout.ts),
  [api/handlers/developer.ts](../api/handlers/developer.ts),
  and [api/handlers/app.ts](../api/handlers/app.ts)
  so the live shells now rely on HttpOnly cookie sessions, the desktop embed
  bridge, and the existing per-app sessionStorage token entry flow only
- deleted the dead browser JWT-refresh branch in
  [web/layout.ts](../web/layout.ts)
  that had still been reading and rewriting `ultralight_token` /
  `ultralight_refresh_token`
- removed old browser-token cleanup branches from the callback HTML in
  [api/handlers/auth.ts](../api/handlers/auth.ts)
  so auth callback pages stop teaching or depending on those legacy keys
- added a one-time desktop migration completion marker in
  [desktop/src/lib/storage.ts](../desktop/src/lib/storage.ts)
  and extended
  [desktop/src/lib/storage.test.ts](../desktop/src/lib/storage.test.ts)
  so legacy `ul_token` import now runs at most once per install before the
  marker locks future startups onto secure storage only
- the remaining PR4.11 follow-through is operational rather than code-heavy:
  set the minimum supported desktop version / rollout floor, then delete the
  last one-time `ul_token` import branch after release evidence says the marker
  has propagated

### PR4.12 API Token Schema Compatibility Removal

Status: `implemented locally (canonical runtime + audit tooling tranche)`

Purpose:

- remove legacy token-hash and `plaintext_token` schema fallbacks once schema
  and data are proven ready

Expected files:

- [api/services/tokens.ts](../api/services/tokens.ts)
- [api/handlers/user.ts](../api/handlers/user.ts)
- [web/layout.ts](../web/layout.ts)
- migration or audit tooling under `scripts/` if added

Acceptance:

- token validation no longer supports unsalted SHA-256 fallback
- token creation/query paths no longer special-case missing `plaintext_token`
  columns
- any first-party UI that shows or regenerates plaintext tokens does so against
  the canonical schema only
- old tokens are rotated, invalidated, or proven absent before removal

Verification:

- token service tests
- schema audit or migration script output
- typecheck/tests

Risks:

- this is an auth-breaking removal if old tokens still exist, so explicit audit
  and rotation steps are mandatory

Implemented in this tranche:

- removed the missing-column compatibility branches from
  [api/services/tokens.ts](../api/services/tokens.ts)
  so token creation and listing now require the canonical `plaintext_token`
  schema instead of retrying old query shapes
- removed unsalted SHA-256 token validation and revocation fallback from
  [api/services/tokens.ts](../api/services/tokens.ts);
  canonical salted hashes are now required for normal validation
- replaced the old unsalted-hash compatibility path with a narrower
  plaintext-assisted migration path in
  [api/services/tokens.ts](../api/services/tokens.ts):
  legacy rows that still retain `plaintext_token` can be backfilled to salted
  hashes on use, while unrecoverable rows no longer validate
- added focused token service coverage in
  [api/services/tokens.test.ts](../api/services/tokens.test.ts)
  for canonical rows, plaintext-assisted backfill, and unrecoverable legacy
  rows
- added
  [scripts/tokens/audit-api-token-compat.mjs](../scripts/tokens/audit-api-token-compat.mjs)
  so staging and production can audit legacy token rows, optionally backfill
  missing salts from stored plaintext, and optionally delete unrecoverable rows
- updated first-party token UI wording in
  [web/layout.ts](../web/layout.ts)
  so token regeneration is framed as canonical-schema recovery rather than a
  missing-column schema fallback
- the remaining PR4.12 closeout is operational: run the token audit against
  staging/production, apply backfill or revocation where needed, then remove the
  last plaintext-assisted migration branch once those rows are gone

### PR4.13 Secret Crypto Compatibility Removal

Status: `implemented locally`

Purpose:

- remove legacy v1/global-salt/plaintext secret decryption branches after data
  is backfilled to the canonical encrypted format

Expected files:

- [api/services/envvars.ts](../api/services/envvars.ts)
- [api/services/api-key-crypto.ts](../api/services/api-key-crypto.ts)
- [api/services/openrouter-keys.ts](../api/services/openrouter-keys.ts)
- [api/handlers/oauth.ts](../api/handlers/oauth.ts)

Acceptance:

- secret values are stored only in canonical per-record encrypted form
- decrypt paths no longer fall back to the legacy salt/blob format
- plaintext legacy rows are backfilled or invalidated before code removal
- error logging and runbooks reflect the new single-format assumption

Verification:

- crypto tests
- migration/backfill audit output
- typecheck/tests

Risks:

- secret-format cleanup is easy to underestimate because it often "works until
  one old row shows up in production"

Implemented in this tranche:

- removed runtime decrypt fallbacks from
  [api/services/api-key-crypto.ts](../api/services/api-key-crypto.ts),
  [api/services/envvars.ts](../api/services/envvars.ts),
  [api/services/openrouter-keys.ts](../api/services/openrouter-keys.ts),
  and [api/handlers/oauth.ts](../api/handlers/oauth.ts)
  so live code now assumes the canonical per-record encrypted format instead of
  trying legacy global-salt blobs or plaintext legacy rows
- added migration-only helpers plus focused crypto coverage in
  [api/services/api-key-crypto.test.ts](../api/services/api-key-crypto.test.ts),
  [api/services/envvars.test.ts](../api/services/envvars.test.ts),
  and
  [api/services/openrouter-keys.test.ts](../api/services/openrouter-keys.test.ts)
  so the repo now proves canonical decrypt rejects legacy blobs while the audit
  path can still recover them deliberately
- added
  [scripts/secrets/audit-secret-crypto-compat.mjs](../scripts/secrets/audit-secret-crypto-compat.mjs)
  to inventory and optionally backfill recoverable legacy secret rows across
  app secrets, saved Supabase configs, Supabase OAuth records, user/app legacy
  Supabase fields, desktop OAuth sessions, OAuth authorization codes, and
  BYOK/OpenRouter secret state
- the remaining PR4.13 closeout is operational: run the secret-crypto audit
  against staging/production, apply backfill where the report shows
  recoverable legacy rows, and rotate or delete any unreadable rows before
  calling the wave fully closed

### PR4.14 Experimental Runtime And Stray Artifact Archive

Status: `implemented locally`

Purpose:

- archive or remove clearly non-live experimental/runtime leftovers so the
  active tree reflects the real platform

Expected files:

- [archive/experimental/future-wfp/](../archive/experimental/future-wfp)
- [docs/CF-WORKERS-SETUP.md](CF-WORKERS-SETUP.md)
- [docs/P1-SCALING-PLAN.md](P1-SCALING-PLAN.md)
- any other confirmed scratch artifacts

Acceptance:

- `_future-wfp/` is archived under an explicit experimental/history location or
  documented as active experimental code outside the live runtime
- obvious stray files like `api/main.ts.bak`, `onboarding-preview.html`, and
  `test-parser.ts` are removed or rehomed
- docs no longer describe experimental runtime work as if it were a current
  launch dependency

Verification:

- file existence checks
- docs review
- guardrail/baseline update if archive checks are added

Risks:

- experimental work can contain useful reference material, so this PR should
  archive intentionally rather than delete blindly

Implemented in this tranche:

- deleted `desktop/public/onboarding-preview.html`, `test-parser.ts`, and the
  stale `api/main.ts.bak` artifact
- moved the historical DO/Deno runtime files into
  [archive/legacy-runtime/](../archive/legacy-runtime)
  so the active runtime tree no longer carries them as if they were live
- moved the future Workers-for-Platforms prototype tree into
  [archive/experimental/future-wfp/](../archive/experimental/future-wfp)
  and updated the remaining docs that reference it so the live `worker/` tree
  no longer implies that the sandbox prototype is part of the active runtime

## Recommended Execution Order

1. `PR4.1` runtime architecture ADR and inventory.
2. `PR4.5` Supabase fallback telemetry.
3. `PR4.8` alias telemetry and deprecation map.
4. `PR4.10` widget contract inventory/telemetry.
5. `PR4.7` manifest-first runtime convergence.
6. `PR4.6` Supabase config migration and hot-path removal.
7. `PR4.9` alias removal.
8. `PR4.11` browser and desktop auth migration cleanup.
9. `PR4.12` token schema compatibility removal.
10. `PR4.13` secret crypto compatibility removal.
11. `PR4.3` data worker decision and boundary cleanup.
12. `PR4.2`, `PR4.4`, and `PR4.14` archive/deletion PRs once the architecture
    decision and migrations are complete.

## Parallelization Guidance

- `PR4.5`, `PR4.8`, and `PR4.10` can run in parallel because they are primarily
  telemetry/inventory work on different surfaces.
- `PR4.7` should finish before broad alias or widget deletion if those flows
  still depend on manifest coverage gaps.
- `PR4.6` depends on the telemetry and migration list from `PR4.5`.
- `PR4.12` and `PR4.13` can overlap in planning, but they should not share a
  single code PR because they touch different high-risk data-migration surfaces.
- Archive/deletion PRs should come last so they are informed by the runtime ADR
  instead of pre-judging it.

## Manual Tasks To Consolidate At The End

Wave 4 should keep human-only steps clustered at the very end instead of
interrupting implementation. The expected manual tasks, after the code PRs
land, are:

- ratify the runtime architecture decision if it needs explicit founder/operator
  signoff
- run any one-time Supabase config backfill against real production metadata
- run `scripts/tokens/audit-api-token-compat.mjs` against staging/production,
  apply `--apply-backfill` for rows that still retain plaintext, and revoke or
  delete any unrecoverable legacy token rows
- run any one-time secret-format backfill or re-encryption job
- decide whether the data worker remains part of the supported production
  architecture
- push through the normal staging and production smoke flow for the affected
  runtime, auth, widget, and tool-dispatch surfaces

## Wave 4 Exit Criteria

- the repo has one explicit production architecture story
- non-live deployment/runtime paths are archived or deleted from active trees
- root historical migrations no longer compete with canonical Supabase
  migrations
- runtime hot paths no longer depend on legacy Supabase config fallback
- platform MCP alias dispatch is gone or explicitly deferred with telemetry and
  written rationale
- widget discovery no longer depends on legacy single-function contracts
- browser/desktop auth migration shims are removed or explicitly version-gated
- token and secret compatibility branches are removed after audit/backfill
- the remaining compatibility ledger entries are either Wave 5 items or have a
  written defer rationale
