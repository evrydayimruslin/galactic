# Operator-grade Agent Home: code-mapped execution plan

Status: implementation and independent release-hardening review complete;
immutable release and production smoke pending

Companion contract:
[`OPERATOR_GRADE_AGENT_HOME_MILESTONE.md`](./OPERATOR_GRADE_AGENT_HOME_MILESTONE.md)

This document maps each locked product decision to its authoritative data,
backend, contract, browser, test, and release surfaces. A capability is not
complete because one screen renders it; it is complete only when those layers
agree and the production release proves the agreement.

## 1. Delivery graph

The milestone ships in this dependency order:

1. Additive database truth and owner-scoped projections.
2. Secret-safe backend normalizers and lifecycle services.
3. Private API contracts and stable navigation destinations.
4. Browser surfaces that consume canonical projections without inventing
   state.
5. Focused, full-stack, migration, and browser validation.
6. One immutable tag whose database, API, worker, and web artifacts derive
   from the same commit.

The release must stop if a downstream layer is green against a different
upstream revision.

## 2. Capability traceability matrix

| Capability | Database truth | Backend and API | Browser | Primary evidence |
| --- | --- | --- | --- | --- |
| Working Agent count and operating phrase | `20260723102000_agent_operator_projections.sql` | `agent-operator-store.ts`, `agent-operating-state.ts`, `GET /api/launch/fleet` | `fleet-status.ts`, `nebula-fleet.tsx` | projection, store, handler, and Fleet UI tests |
| Conditional Overview | operator projections, notification lifecycle, preferences | `launch.ts`, `agent-activity.ts`, `agent-access.ts`, `agent-attention.ts` | `operator-overview-model.ts`, `operator-agent-overview.tsx` | section-order, service, and handler tests |
| Canonical Attention | `20260723101000_notification_attention_lifecycle.sql` | `agent-attention.ts`, `notification-recovery.ts`, `GET /api/launch/attention`, action endpoint | `operator-agent-alerts.tsx`, global Alerts in `nebula-fleet.tsx` | lifecycle, enrichment, expired-snooze, global/per-Agent parity tests |
| Unified Activity | activity RPCs in operator projections | `agent-activity.ts`, paginated Home activity route | Overview preview and inline expansion | stable-ID, ordering, dedupe, cursor, and no-Attention-duplication tests |
| Access | live manifest, settings metadata, grants, routines | `agent-access.ts`, Agent Home projection | `operator-agent-access.tsx`, Access pane item routing | redaction, consumer-binding, and deep-link tests |
| Favorites | `20260723100000_agent_operator_preferences.sql` | `agent-preferences.ts`, `agent-operator-store.ts`, preference routes | `interface-favorites.ts`, Interfaces stars, Overview Favorites | ownership, CAS, first-default, explicit-empty, and migration tests |
| Fleet order and shortcuts | same preferences migration | Fleet preference/order routes and shared revision | `fleet-order.ts`, `keyboard-shortcuts.ts`, cards and settings UI | permutation, collision, focus guard, remap, and numeric-routing tests |
| Stable pane/item URLs | canonical route strings in projections/search | route validation in search and Attention services | pane registry, route state, item resolvers, Compute target resolver | direct URL, stale target, Back/Forward, and unsafe-item tests |
| Navigation Search | search document migrations | `agent-search.ts`, `operator-projections.ts`, projection worker | `search-panel.tsx` | owner isolation, lexical fallback, BYOK-only semantic, producer/tombstone tests |
| Resilient loading/navigation | no database state | additive API contracts and independent degraded reads | `live-data.ts`, Interface SWR/warmup, cached fleet count, external-return revalidation | cache, stale-while-revalidate, Stripe return, and shell-stability tests |

## 3. Data and migration plan

### 3.1 Preferences and ordering

File:
`supabase/migrations/20260723100000_agent_operator_preferences.sql`

Responsibilities:

- Persist per-user Interface favorites and contiguous Fleet positions.
- Share an owner-scoped CAS revision across Fleet order and shortcut changes.
- Initialize exactly the first stable manifest-ordered Interface once.
- Distinguish automatic initialization from an explicit user choice with
  `favorites_explicit`.
- Preserve an explicit empty list forever unless the owner changes it.
- Keep service-role mutation and authenticated-owner read boundaries explicit.

Required checks:

- Cross-owner reads and writes fail.
- A stale revision cannot replace favorites, order, or shortcuts.
- The ordered rows and revision returned to a client come from one atomic
  database snapshot; independent REST reads must never be combined into a CAS
  token.
- A new Agent appends without renumbering existing Agents.
- Local favorites migrate only when no explicit server choice exists.

### 3.2 Attention lifecycle

File:
`supabase/migrations/20260723101000_notification_attention_lifecycle.sql`

Responsibilities:

- Classify reports and incidents deterministically.
- Keep read state independent from incident resolution.
- Persist open, snoozed, resolved, and archived lifecycle state.
- Store versioned, rebuildable BYOK briefs separately from raw notification
  truth.
- Queue enrichment asynchronously.
- Assign every queued projection write a monotonic `enqueue_generation`.
- Resolve known setup/failure incidents through exact recovery keys.
- Allow only owner-scoped lifecycle transitions.

Canonical active predicate:

- open incidents, including read incidents;
- expired snoozed incidents; and
- unread open reports.

The predicate must match Fleet SQL, per-Agent Attention, global Attention, and
the hero count.

### 3.3 Fleet, Activity, Access, and readiness projections

File:
`supabase/migrations/20260723102000_agent_operator_projections.sql`

Responsibilities:

- Produce strict working/exclusion truth.
- Produce evidence-backed operating summaries.
- Merge upcoming, current, and recent routine/Compute/notification events.
- Return stable detail destinations and cursor-sort keys.
- Keep owner filtering inside the database function.

### 3.4 Search documents and producers

Files:

- `supabase/migrations/20260723103000_agent_search_documents.sql`
- `supabase/migrations/20260723104000_agent_search_projection_producers.sql`

Responsibilities:

- Store only owner-visible, navigation-safe documents.
- Materialize Agent/directive, Interface, Routine, Function/schema, Attention,
  run, release, setting metadata, and authority targets.
- Never store secret values, ciphertext, raw third-party content, or raw run
  inputs/results.
- Enqueue revisioned upserts and tombstones from canonical source changes.
- Record an enqueue-time source high-water mark and separate subject/source
  revision ledgers so stale upserts and tombstones are rejected.
- Preserve A→B→A correctness even when worker jobs complete out of order.
- Tombstone deleted notification briefs, Routines, and their run documents.
- Purge projection state before an Agent ownership transfer, then seed only
  the new owner's documents.
- Allow retained immutable/canonical former-owner sources to be updated or
  pruned after transfer without recreating old-owner projections.
- Prune at most 1,000 terminal projection jobs older than 30 days per bounded
  maintenance pass.
- Keep exact/lexical retrieval available without inference.
- Treat semantic vectors as optional owner-BYOK enrichment.

### 3.5 Atomic, cursor-paged Attention

File:
`supabase/migrations/20260723106000_attention_pagination.sql`

Responsibilities:

- Return rows, exact open/decision counts, and the next cursor from one
  owner-scoped database snapshot.
- Bound every page to 200 while keeping exact totals across the full active
  set.
- Return exact per-Agent aggregates with the account-wide page so an Agent
  outside the newest page remains represented.
- Use deterministic `(created_at DESC, id ASC)` keyset pagination.

### 3.6 Expired-snooze reconciliation

File:
`supabase/migrations/20260723110000_expired_snooze_search_reconciliation.sql`

Responsibilities:

- Reopen due incident snoozes in a bounded, concurrent-safe worker sweep.
- Route every reopened incident through the canonical lifecycle trigger so
  Attention and Search cannot disagree after time alone changes active state.
- Keep the sweep idempotent, service-role-only, and identifier-only.
- Treat maintenance failure as degraded freshness rather than blocking queued
  projection work.

## 4. Backend execution map

### 4.1 Fleet and preferences

Files:

- `api/services/agent-operator-store.ts`
- `api/services/agent-preferences.ts`
- `api/services/agent-operating-state.ts`
- `api/handlers/launch.ts`
- `shared/contracts/launch.ts`

Implementation:

- Read the Fleet through the v2 owner-scoped snapshot.
- Return `workingSummary` and per-Agent `workingReadiness`.
- Return canonical `attentionCount`; retain the old unread field only as a
  compatibility fallback.
- Make all order/favorite/shortcut replacements atomic CAS operations.
- Read favorite rows plus their Agent revision, and Fleet order plus its Fleet
  revision, through single-statement snapshot RPCs.
- Return and validate the actual compact positions from the same ordered
  snapshot that supplied the response revision.
- Advance the owner Fleet revision exactly once when an Agent is added,
  removed, restored, or transferred; the same revision must never certify two
  membership sets.
- Keep Fleet and shortcut preference clients on the same returned revision
  through `apps/launch-web/src/lib/fleet-revision.ts`, including late GETs
  started before a successful write.

### 4.2 Overview

Files:

- `api/services/agent-activity.ts`
- `api/services/agent-access.ts`
- `api/services/agent-attention.ts`
- `api/handlers/launch.ts`

Implementation:

- Build Directive from managed routine mission and reporting configuration.
- Load unified Activity independently from the mutable Home revision.
- Remove exact open Attention sources from compact recent Activity.
- Degrade Activity, Attention, capacity, and preferences independently.
- Return Access metadata and configuration presence, never values.

### 4.3 Attention and recovery

Files:

- `api/services/agent-attention.ts`
- `api/services/notifications.ts`
- `api/services/notification-recovery.ts`
- `api/services/operator-projection-redaction.ts`
- `api/services/operator-projections.ts`
- `api/src/worker-entry.ts`
- `api/handlers/launch.ts`

Implementation:

- Serve per-Agent and global projections from the same normalizer.
- Derive rows, `openCount`, and `requiresDecisionCount` from one atomic,
  cursor-paged RPC; counts remain canonical when the displayed list exceeds a
  200-row page.
- Restrict global Attention to Agent IDs resolved from the current owner.
- Return exact per-Agent aggregates independently from the bounded global page.
- Keep raw rows usable while enrichment is pending, failed, or disabled.
- Generate briefs only in the worker with owner BYOK.
- Redact source evidence before inference, validate model evidence against that
  sanitized source, and redact the result again before persistence.
- Resolve model output into inert, allowlisted action descriptors.
- Execute lifecycle writes only through the typed owner-scoped endpoint.
- Auto-resolve exact setup incidents after configuration becomes valid.
- Reopen expired snoozes on the existing projection-worker cadence before
  claiming work, without making the sweep a prerequisite for processing the
  queue.

### 4.4 Search

Files:

- `api/services/agent-search.ts`
- `api/services/operator-projections.ts`
- `api/src/worker-entry.ts`
- `api/handlers/launch.ts`

Implementation:

- Claim mixed notification-brief and search-document jobs with bounded leases.
- Write lexical documents before attempting optional embedding.
- Redact every persisted Search field and embedding input defensively, even
  when an upstream producer has already sanitized it.
- Degrade provider failure to lexical retrieval.
- Reject unsafe destinations and cross-owner filters before ranking.
- Apply generation, source-high-water, subject-revision, and tombstone guards
  so an older job cannot resurrect stale data.
- Prune old terminal jobs with the bounded service-role maintenance RPC.

## 5. Browser execution map

### 5.1 Fleet shell

Files:

- `apps/launch-web/src/components/nebula-fleet.tsx`
- `apps/launch-web/src/lib/fleet-status.ts`
- `apps/launch-web/src/lib/fleet-count-cache.ts`
- `apps/launch-web/src/lib/fleet-order.ts`
- `apps/launch-web/src/lib/fleet-revision.ts`

Behavior:

- Hero count is backend working truth, cached only for first paint.
- Agent cards have one stable three-activity-line height.
- Attention badges use canonical count and do not change merely because an
  incident was read.
- Card numbers are server order and numeric shortcut order.

### 5.2 Agent Overview and focused panes

Files:

- `apps/launch-web/src/components/nebula/operator-agent-overview.tsx`
- `apps/launch-web/src/components/nebula/agent-overview-layout.tsx` (legacy
  compatibility fallback)
- `apps/launch-web/src/lib/operator-overview-model.ts`
- `apps/launch-web/src/lib/operator-activity-state.ts`
- `apps/launch-web/src/components/nebula/operator-agent-access.tsx`
- `apps/launch-web/src/components/nebula/operator-agent-alerts.tsx`

Behavior:

- Render only populated optional sections.
- Order Attention, Favorites, Directive, Activity, then material signals.
- Show three recent meaningful events and expand inline.
- Keep lifecycle actions and allowlisted recommended destinations in Alerts.
- Keep identity/connection/release/history configuration outside Directive.

### 5.3 Stable navigation

Files:

- `apps/launch-web/src/lib/agent-pane-registry.ts`
- `apps/launch-web/src/lib/agent-route-state.ts`
- `apps/launch-web/src/lib/operator-item-targets.ts`
- `apps/launch-web/src/lib/collapsible-state.ts`
- `apps/launch-web/src/lib/external-navigation.ts`
- `apps/launch-web/src/lib/navigation.ts`
- `apps/launch-web/src/components/agent-compute-pane.tsx`

Behavior:

- Preserve the current Agent path for query-only navigation.
- Resolve every supported pane/item pair deterministically.
- Focus a valid target and show a safe stale-target state otherwise.
- Restore targeted collapsibles through Back/Forward, including after a user
  manually closes one occurrence of the target.
- Revalidate after returning from external navigation such as Stripe.
- Use one canonical release-item convention while accepting legacy release
  links.
- Bound Compute run lookup to 500 recent owner-visible rows.
- Never interpolate an unvalidated item into a selector or request path.

### 5.4 Global Attention

Files:

- `apps/launch-web/src/lib/global-attention.ts`
- `apps/launch-web/src/components/nebula/operator-agent-alerts.tsx`
- `apps/launch-web/src/components/nebula-fleet.tsx`

Behavior:

- Fetch the global canonical projection once, not N Agent Home responses.
- Group enriched items by Agent while preserving server chronology.
- Preserve exact global and per-Agent totals above the page bound.
- Append older pages through the opaque server cursor without replacing
  lifecycle-updated local state.
- Search Agent identity plus enriched context.
- Reuse per-Agent lifecycle controls.
- Recalculate the hero count from lifecycle truth after every action.

### 5.5 Search and shortcuts

Files:

- `apps/launch-web/src/components/nebula/search-panel.tsx`
- `apps/launch-web/src/lib/keyboard-shortcuts.ts`
- `apps/launch-web/src/components/nebula-fleet.tsx`

Behavior:

- Search navigates; it does not synthesize answers.
- Every result has a validated local destination and grounded snippet.
- Bare shortcuts run only when there is no editable, embedded, composing,
  modified, repeated, or dialog-focused interaction.
- Escape uses the same focus, IME, repeat, modifier, remap, and dialog policy
  as every other bare shortcut.

### 5.6 Private Interface read cache

Files:

- `apps/launch-web/src/lib/auth.ts`
- `apps/launch-web/src/lib/auth-session.test.ts`
- `apps/launch-web/src/lib/interface-read-cache.ts`
- `apps/launch-web/src/lib/interface-warmup.ts`

Behavior:

- Scope every persistent cache key by authenticated owner subject and auth
  epoch; unauthenticated reads bypass persistence.
- Purge memory and session storage on logout, token rotation, and cross-tab
  auth changes.
- Reject completion from a prior-session in-flight request so it cannot
  repopulate the new session.
- Invalidate writes only for the affected owner and Agent.
- Cache only allowlisted Interface read models; never raw credentials.

The locked Agent pane order is Overview, Interfaces, Alerts, then Access,
Routines, Functions, Compute, and Settings.

## 6. Validation matrix

### Database

- Replay every migration twice from a clean local database.
- Run pgTAP ownership, lifecycle, CAS, projection, search, and redaction tests.
- Confirm all new functions have explicit grants/revokes and stable search
  paths.

### API and worker

- Deno formatting and lint for changed API/worker sources. Repository-wide
  legacy formatting/lint debt is not part of this release gate.
- Node and Deno typechecks.
- Focused service/handler suites for every row in the traceability matrix.
- Full API suite.
- Projection worker tests for claim, retry, lease loss, stale revisions,
  lexical degradation, A→B→A replay, source deletion, ownership transfer,
  pruning, and tombstones.
- Runtime-assembled credential tests that prove inference input, persisted
  briefs, Search RPC writes, and embedding input are redacted.
- Exact Attention-count tests above the 200 displayed-row limit.

### Web

- Typecheck.
- Focused URL, Overview, Attention, Access, favorites, ordering, shortcut,
  Search, Compute, SWR, and return-navigation tests.
- Full test suite.
- Production build and Pages asset/header verification.
- Confirm bundle-size warnings remain advisory, not correctness failures.
- Cover auth-session cache isolation and prior-session in-flight completion.
- Cover shared-CAS late-GET/write races, stale Alert/Settings/release targets,
  and Back/Forward reopening.

### Security and release audit

- `git diff --check`.
- Secret-pattern scan over tracked release inputs.
- Confirm generated examples and local package stores are not staged.
- Confirm migrations contain no production data mutation beyond additive
  backfill/projection work.
- Confirm one commit SHA is used for database, API, worker, and web.

## 7. Immutable release sequence

1. Commit only milestone sources, migrations, tests, contracts, and docs.
2. Push the exact commit to the protected release branch.
3. Wait for the same-SHA `Staging Launch Gate` to pass. The production gate
   requires that successful main-push run as mandatory release evidence.
4. Fetch remote tags and create the next unused `v*` tag on that SHA.
5. Push the tag.
6. Monitor the exact tag-triggered workflows:
   - `Supabase Production DB`;
   - `API Deploy`;
   - `Launch Web Deploy`; and
   - `Production Launch Gate`.
   The API workflow must fail closed if its Compute binding target cannot be
   verified; first-install bootstrap is never represented as a successful
   no-op release.
7. Verify:
   - API health and Launch status;
   - signed-in Fleet count and Attention parity;
   - direct pane/item URLs and Back/Forward;
   - global and per-Agent lifecycle actions;
   - Favorites/order/shortcuts after refresh and on a second session;
   - Search destinations and lexical fallback;
   - Stripe return and Interface SWR.

Rollback is forward-only for schema: deploy a compatibility correction rather
than removing columns/functions used by a web artifact that may still be
cached. Web/API rollback may select the prior immutable tag only when its
schema contract remains satisfied.

## 8. Completion rule

Update both milestone documents to `complete` only after the production tag is
green and the signed-in smoke matrix passes. Record the released commit, tag,
workflow runs, migration result, and smoke evidence in the final handoff.

## 9. Release ledger

| Evidence | Result |
| --- | --- |
| Release commit | Pending immutable commit |
| Release tag | Pending next unused remote `v*` tag |
| Clean migration replays | 2/2 passed from a clean local database |
| pgTAP | 252/252 passed on each replay |
| API tests | 2,115/2,115 passed |
| Web tests | 254/254 passed across 29 files |
| Typechecks | API, Deno, full TypeScript, targeted changed modules, and web passed |
| Production web build | Passed; 72 modules and Pages routing verified; 518.95 kB main-chunk advisory only |
| Auth/session isolation audit | Passed for owner changes, refresh/logout, cross-tab events, stale in-flight requests, and failed revalidation |
| Secret scan | Passed across 123 release inputs; only synthetic fixtures matched; `examples/fresh-agents/` excluded |
| Diff hygiene | `git diff --check` passed; generated examples and local package store excluded |
| Staging Launch Gate | Pending same-SHA main-push gate |
| Production workflows | Pending tag |
| Signed-in production smoke | Pending deployment |
