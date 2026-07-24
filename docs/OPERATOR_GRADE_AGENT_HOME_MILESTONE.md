# Operator-grade Agent Home milestone

Status: complete — released as `v0.4.51`
(`708b16c21e794f696cea07e62dfb8f2917352771`) on July 23, 2026

This document is the implementation and completion contract for the
Operator-grade Agent Home milestone. The milestone is complete only when every
requirement below has authoritative code, test, and released-runtime evidence.

## Product truth

Agent Home is the canonical owner-only operator projection. Fleet cards,
Overview, Alerts, Access, Search, and keyboard navigation consume that
projection or a projection built from the same backend normalizers. The browser
must not independently guess lifecycle, operating state, readiness, alert
meaning, or Agent ordering.

## Locked behavior

### Overview

Overview renders populated sections in this order:

1. Attention: open incidents and unread informational reports.
2. Favorite Interfaces.
3. Directive.
4. Activity: Up next, Now, and three Recent items with inline View all.
5. Material release or usage signals.

Directive is always present. Empty optional sections are omitted. Identity and
the connection endpoint live in Settings. Directive is owner-editable through
the existing revision-safe managed-routine mission mutation.

### Attention

- A report is routine informational output. It has independent read/archive
  state and can appear in Attention while unread.
- An incident represents setup, approval, failure, budget, release-review, or
  explicit operator-decision work.
- Read state never means resolved.
- Setup incidents resolve automatically when configuration becomes valid.
- Approval incidents resolve after approval or rejection.
- Failure incidents resolve after recovery or explicit resolution.
- The hero and per-Agent count is open incidents plus unread reports.
- Attention rows, exact totals, per-Agent aggregates, and cursors are
  owner-scoped database projections; a 200-row page is never treated as the
  total queue.
- Older active Attention remains operable through deterministic cursor
  pagination.
- Expired incident snoozes reopen through bounded worker maintenance and the
  canonical lifecycle trigger, so time-based state changes reconcile Search
  without waiting for another source mutation.
- Raw notifications remain canonical and usable if enrichment is absent.
- BYOK enrichment is asynchronous, never blocks Agent execution or Home reads,
  and has no platform-key fallback.
- Model-suggested actions are inert action keys until validated and resolved by
  a server allowlist. The model cannot generate an executable URL or invoke a
  mutation.

### Operating state and fleet count

Operating phrases and readiness derive from live release, setup requirements,
enabled routines, trigger/schedule state, next wake, current/recent runs,
capacity, and blockers. Agent name, description, tags, and browser regexes are
not evidence.

A working Agent has:

- complete setup;
- a live release;
- at least one enabled executable routine;
- no pause, setup block, hard failure, draft-only state, retirement, or
  disablement; and
- the ability to execute when triggered.

Waiting for a schedule, event, or capacity counts as working. Paused Agents do
not. The API returns the canonical working count and per-Agent exclusion reason.

### Activity

- Up next is scheduler/trigger truth, not inferred prose.
- Now is a genuinely queued/running routine or Compute run.
- Recent is a deduplicated, stable-ID chronology.
- Default Recent length is three.
- Full history is cursor-paginated.
- An unresolved Attention item is not duplicated as a generic Activity row on
  the default Overview.

### Access

Access appears under Manage and combines:

- endpoint-bound variables and secret configuration presence;
- general variables;
- effective network, function, Agent-to-Agent, AI, storage, and Compute
  authority; and
- explicitly known routine/function consumers.

Secret values never enter Agent Home projections, logs, evidence records,
enrichment prompts, Search documents, or embedding input. Allowlisted
Interface read models are private, authenticated-owner-scoped, and
session-bounded. Unknown consumers are omitted rather than inferred.

### Favorites and Agent positions

- Favorites and Agent order are per-user server state.
- The first stable manifest-ordered Interface is the initial favorite.
- An explicit empty favorite list persists across devices and future releases.
- Existing local favorites migrate once when the server has no explicit user
  choice.
- Agent positions are contiguous, rearrangeable, and used by card labels and
  numeric shortcuts.
- New Agents append.

### URLs, Search, and keyboard

- Panes and granular objects have stable URLs:
  `/agents/:slug?pane=:pane&item=:item`.
- The pane order is Overview, Interfaces, Alerts, then Access, Routines,
  Functions, Compute, and Settings.
- Back/Forward restores pane and selected item without refetching the entire
  Agent route or forcing scroll-to-top.
- Search is navigation-only in this milestone.
- Search covers owner-visible Agent, directive, Interface, Routine, Function
  and schema, Attention, run, release, setting metadata, and authority targets.
- Search never indexes secret values, encrypted values, raw third-party
  content, or raw run arguments/results.
- Exact and lexical search always work. Semantic ranking uses only the owner's
  BYOK and degrades to lexical search when unavailable.
- Bare shortcuts are K for Search, A for Alerts, S for Settings, 1-9 and 0 for
  Agent positions 1-10, ? for help, and Escape for back/close.
- There is no C shortcut.
- Bare shortcuts are disabled for editable focus, embedded Interfaces,
  composition/IME, modifier keys, repeats, and subsurface dialogs.
- Escape follows those same interaction guards and is remappable.
- Shortcuts are disableable/remappable and exposed with `aria-keyshortcuts`.

## Architecture invariants

- Agent Home remains backward-compatible for one web release.
- Volatile Activity, Attention, usage, and schedule data do not participate in
  the Agent Home mutation revision.
- Agent Home treats notifications and Compute as optional/degraded read
  sources; either subsystem may fail without blanking the shell.
- No inference runs synchronously in fleet or Agent Home request paths.
- Database reads and search apply owner scope before ranking or pagination.
- Preferences use revision-safe atomic replacement/reordering, and every read
  binds the returned ordered rows to its revision in one database snapshot.
- Agent membership changes advance the owner Fleet revision exactly once, and
  the snapshot returns the stored positions so compact ordering is verified
  rather than reconstructed.
- Canonical notification evidence is retained; derived projections are
  rebuildable; supported source deletion emits revision-guarded tombstones.
- An Agent ownership transfer removes old-owner derived state, and later
  lifecycle/retention writes to retained former-owner evidence cannot recreate
  it or block canonical cleanup.

## Completion evidence — satisfied

The milestone completed with:

- database tests for ownership, lifecycle, CAS ordering, explicit-empty
  favorites, projection correctness, and search isolation;
- service tests for strict readiness, multi-routine precedence, Activity
  ordering/deduplication, Access redaction, Attention fallback/enrichment, and
  server action allowlisting;
- tests proving exact Attention counts above the 200-row display bound and
  runtime-assembled credential redaction through inference, persistence,
  Search, and embeddings;
- projection tests for A→B→A replay, stale workers, source deletion, ownership
  transfer, and bounded pruning;
- handler tests for account-session authorization, stable pagination, deep
  destinations, and cross-owner denial;
- web tests for URL state, no route-wide refetch on pane changes, Overview
  ordering, shortcuts/focus guards, favorites, ordering, and search results;
- web tests for auth-session cache isolation, old in-flight completion,
  shared-CAS races, stale item targets, and Back/Forward reopening;
- successful API and launch-web typechecks/tests/builds;
- staging smoke evidence for direct URLs, Back/Forward, Stripe-return
  navigation, embedded Interface focus, stale-while-revalidate, and BYOK
  fallback; and
- a production deployment whose asset/API/schema versions are mutually
  compatible.

The immutable release, migration, workflow, exact-tag smoke, and signed-in
runtime evidence is recorded in the
[execution-plan release ledger](./OPERATOR_GRADE_AGENT_HOME_EXECUTION_PLAN.md#9-release-ledger).

## Explicitly outside this milestone

- Synthesized Search answers.
- Opt-in raw third-party content indexing.
- Explicit monetary spending controls beyond existing work-unit budgets.
- Inference-generated lifecycle/readiness truth.
- Destructive replacement of existing sample Agents.
