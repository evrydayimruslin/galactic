# Agent Studio — Launch Work Orders

**Status:** Draft for owner review · **Baseline:** `main @ af196cc` (2026-08-01, post PR #189)
**Builder:** Claude Code sessions, one branch/PR per work order
**Companions:** `docs/AGENT_STUDIO_BACKEND_REQUIREMENTS.md` (the ledger), `docs/POLICY_PILLAR_ARCHITECTURE.md` (post-launch pillar)

This document is a living plan. Each landed PR updates the status table and, where
implementation diverged, the order itself. Line references are anchors verified at
the baseline commit; re-locate by symbol, not line number.

---

## Status

| WO | Title | Depends on | Est. | Status |
|----|-------|-----------|------|--------|
| WO-1 | Interface invocation idempotency | — | 1 PR | **landed** (`feat(wo-1)`) |
| WO-2 | Agent-wide Pause / Resume | — | 1 PR | **landed** (`feat(wo-2)`) |
| WO-3 | Activity run detail (thin slice) | — | 1 PR | **landed** (`feat(wo-3)`) |
| WO-4 | Release history (read-only) | — | 1 PR | **landed** (`feat(wo-4)`) |
| WO-5 | Knowledge-lite + open questions + alert wiring | WO-3 helpful, not required | 2 PRs | **landed** — PR A (store/API/pane/alerts) + PR B (sandbox `galactic.knowledge.ask/facts` binding, gated on declared database authority; gx.test stub; template v26) |
| WO-6 | Concept graph v1 — brackets, glossary, `about()`/`suggest()` | WO-5 (store + binding patterns) | 3 PRs | **authored** — pending build |

Recommended order: **WO-1 → WO-2 → WO-3 → WO-4 → WO-5.** WO-1 first because it is
the cornerstone of the pillar's invocation ledger (P1) — everything else is
order-independent.

Out of scope for launch, by decision (2026-08-01): Approvals pane stays hidden;
rollback (fix-forward only); per-agent USD; collaborators; compute admission;
email-ops changes of any kind; handoff TTL stays 60 minutes.

---

## Repository conventions (verified at baseline)

- **API tests:** Deno std asserts (`https://deno.land/std@0.224.0/assert/mod.ts`),
  colocated `*.test.ts` next to services/handlers.
- **Web tests:** vitest (`apps/launch-web`, `"test": "vitest run"`).
- **Migrations:** `supabase/migrations/YYYYMMDDHHMMSS_snake_case.sql`. New tables
  enable RLS and are service-role-only unless user-visible via PostgREST
  (precedent: `20260730120000_builder_handoff_sessions.sql`).
- **Routes:** regex table in `api/handlers/launch.ts` (see `/home/activity` at
  ~L1229) + OpenAPI registration in the same file (`publicSpec.paths[...]`,
  see ~L4814). Every new route registers its spec entry in the same PR.
- **Reserved args:** `_`-prefixed args on function-run requests are platform
  routing, never function input; they are stripped before invocation
  (precedent: `_async`, `api/handlers/mcp.ts` ~L2772).
- **Contracts:** all owner-facing types in `shared/contracts/launch.ts`. Additive
  changes only; never repurpose an existing field.
- **Verification gate per PR:** API typecheck, targeted `deno test` suites for
  touched services/handlers, `vitest run` when web touched, `git diff --check`.
  State results plainly in the PR body (counts, not adjectives).

---

## WO-1 — Interface invocation idempotency

**Problem.** `LaunchFunctionRunRequest` is `{ args? }` only. If dispatch fails
ambiguously (network error after the request left the client), the caller cannot
know whether a durable job exists, and must not blind-retry — the bridge already
fails closed and says so (`apps/launch-web/src/lib/interface-bridge.ts`, the
catch around `runAgentFunction`: "rejected before a durable job id was
returned"). This is AS-BE-017's minimal slice and the pillar's first brick.

**Design.** Client-generated invocation identity via a reserved arg, symmetrical
with `_async`:

- Bridge generates `_invocation_id = crypto.randomUUID()` once per *logical*
  call and reuses it across dispatch retries.
- Server strips it (like `_async`), persists it on the job row, and enforces
  uniqueness per app. A duplicate POST returns the **existing** job envelope
  (`{_async: true, job_id}`) instead of creating a second job. Recovery from
  ambiguity is therefore just "re-POST with the same id" — **no new lookup
  endpoint needed.**

**Schema.** New migration `supabase/migrations/<ts>_async_jobs_client_invocation.sql`:

```sql
ALTER TABLE public.async_jobs
  ADD COLUMN IF NOT EXISTS client_invocation_id text
    CHECK (client_invocation_id IS NULL
           OR char_length(client_invocation_id) BETWEEN 8 AND 128);

CREATE UNIQUE INDEX IF NOT EXISTS async_jobs_client_invocation_idx
  ON public.async_jobs (app_id, client_invocation_id)
  WHERE client_invocation_id IS NOT NULL;
```

Insert path handles the race: attempt insert; on unique violation (23505),
select the surviving row by `(app_id, client_invocation_id)` and return it.
Consumer (`api/services/async-exec-consumer.ts`) is untouched.

**Touchpoints.**
- `api/handlers/mcp.ts` — strip `_invocation_id` beside `_async` (~L2772);
  thread it into job creation. It must never reach function args (assert in test).
- `api/services/async-jobs.ts` — creation accepts `clientInvocationId?`;
  duplicate → return existing row; document that "existing" may be in any
  status (accepted/running/completed) and that is correct.
- `shared/contracts/launch.ts` — document the reserved arg on
  `LaunchFunctionRunRequest` (JSDoc; keep wire shape as args to avoid a
  contract fork), and add the constant name for the reserved key.
- `apps/launch-web/src/lib/interface-bridge.ts` — generate + reuse the id;
  reclassify ambiguous dispatch failures as retryable (bounded retries with
  the same id); keep the existing "never create a second job" invariant, which
  this change finally makes fully true.
- OpenAPI: update the run-function path description to document the reserved arg.

**Tests.**
- `async-jobs.test.ts`: duplicate create returns same job id; concurrent
  duplicate (simulated 23505) returns the surviving row; absent id → old behavior.
- handler test: POST twice with same `_invocation_id` → same `job_id`; function
  input never contains the reserved key.
- `interface-bridge` tests: network `TypeError` during dispatch now retries with
  the same id and succeeds when the first POST actually landed.

**Acceptance.** Same-id duplicate POSTs are single-execution with a stable
job id; no behavior change when the arg is absent; reserved key never leaks
into tenant code.

**Guardrails.** Do not rename `async_jobs`, do not add status values, do not
touch expiry — the pillar's P1 does ledger unification deliberately.

---

## WO-2 — Agent-wide Pause / Resume

**Problem.** `/api/launch/agents/{id}/home/pause` exists but pauses the primary
routine only (`pauseAgentHomeRoutineEmergency`, `api/services/agent-home-revision.ts`;
call sites `api/handlers/launch.ts` ~L10166, ~L10646). AS-BE-012 is "Partial".
An owner needs one switch that stops the whole agent.

**Design.** Extend, don't replace:

- `POST /home/pause` body gains `{ "scope": "primary" | "agent" }`, default
  `"primary"` (backward compatible).
- `scope: "agent"`: pause every routine with status `active`
  (`updateRoutine(... {status: "paused"})` per `api/services/routines.ts` ~L1021),
  stamping each with `metadata.agent_pause_batch = <ISO timestamp>`.
- New `POST /home/resume` `{ "scope": "agent" }`: flip back **only** routines
  carrying the latest batch stamp, then clear the stamp. Routines the owner had
  individually paused before the agent-pause are never resurrected — this is the
  correctness detail that justifies the stamp.
- Semantics documented in the response and UI copy: in-flight runs finish;
  already-queued jobs execute (they are accepted work); no **new** wakes fire.
- Idempotent: agent-pause with nothing active succeeds with `pausedRoutineIds: []`.

**Touchpoints.**
- `api/services/routines.ts` — `pauseAllAgentRoutines(userId, appId)`,
  `resumeAgentPauseBatch(userId, appId)` (query by metadata stamp).
- `api/handlers/launch.ts` — extend pause route, add resume route, extend the
  OpenAPI entries (~L2825 region, currently "Primary routine is paused").
- `shared/contracts/launch.ts` — `LaunchAgentPauseRequest/Response`,
  `LaunchAgentResumeResponse` (list of affected routine ids + operating summary).
- `apps/launch-web` — Overview pane: operating chip + Pause/Resume control;
  `operatingSummary` already carries paused counts (contract ~L1490);
  client method in `src/lib/api.ts`.

**Tests.** Service: mixed statuses → only `active` paused, stamp round-trip,
individually-paused routine untouched by resume; double-pause/double-resume
idempotence. Handler: scope default stays primary-only (regression),
agent scope response shape. Web: overview control state machine (vitest).

**Acceptance.** One click stops all future wakes; resume restores exactly what
pause stopped; the pre-existing emergency path is byte-for-byte unchanged when
`scope` is omitted.

---

## WO-3 — Activity run detail (thin slice)

**Discovery that shrank this order:** the owner-safe run-detail service is
already implemented **and routed** — `readOperatorRoutineRunDetail`
(`api/services/operator-run-inspection.ts`) is called from
`api/handlers/launch.ts` ~L7079. Steps are selected as
`id, step_index, function_name, status, duration_ms, cost_light, receipt_id,
error, started_at, completed_at` (args/result previews deliberately excluded —
owner-safe by design; do not add them). Flight-recorder AI exchanges already
appear as steps named `galactic.ai`.

**Scope.** Almost entirely web:

- Activity pane (`apps/launch-web/src/components/agent-studio/agent-studio-screens.tsx`):
  expandable run cards. Expansion lazy-fetches run detail through a new client
  method in `src/lib/api.ts` targeting the existing route (locate exact path by
  the `readOperatorRoutineRunDetail` call site; register nothing new if the
  route already serves it).
- Render: "What it called, in order" table (step_index asc) with function name,
  status, duration, Light cost; `galactic.ai` rows labeled as AI calls; error
  rows surfaced; log-receipt count shown. Keep the existing honest footer note —
  it now covers only effects/non-actions, which land with pillar P0/P3.
- Stream linkage: ensure run items in `/home/activity` carry a `destination`
  that opens the drawer (`api/services/agent-activity.ts`,
  `buildAgentActivityPreview` ~L154 — small service change only if the
  destination is currently null for runs).

**Tests.** Vitest: activity model (expand → fetch → render states; error and
empty-step runs). API: only if `agent-activity.ts` changes (destination shape).

**Acceptance.** From Activity, any routine run expands to its ordered step
table with durations and cost, including AI-call rows, with zero new privacy
surface (no argument/result content anywhere).

---

## WO-4 — Release history (read-only)

**Problem.** Every release is immutably stored (`app_releases`,
`supabase/migrations/20260730130000_membership_deployment_enforcement.sql` ~L271,
mutation-proof via trigger ~L629) but only live + newest candidate are projected.
The Settings "History" list renders runs, not releases.

**Design.**
- `GET /api/launch/agents/{id}/releases` → owner-only, newest-first list:
  `{ id, version, releaseGeneration, createdAt, storageBytes, live }`, limit 50.
  `live` computed by comparing against the agent's current live release id
  (source of truth: the home/deployment projection — locate the field in
  `agent-home.ts` during implementation; do not duplicate state).
- New `api/services/app-releases-projection.ts` using the PostgREST `rows<T>`
  helper pattern (precedent: `operator-run-inspection.ts`), filtered
  `app_id = eq.X AND owner_id = eq.user`, `order=release_generation.desc`.
  Table is service-role-only; the explicit owner filter is the authorization.
- `shared/contracts/launch.ts` — `LaunchAgentReleaseSummary` + response type.
- Web: Releases list in the Settings surface (`nebula-fleet.tsx` Collapsible
  region near the existing History block ~L5470, or `settings-studio-panel.tsx`
  if Settings Studio owns this pane now — decide by where the live-release row
  renders today). LIVE badge on the current release. **No rollback affordance.**
- OpenAPI entry + handler wiring in `launch.ts`.

**Tests.** Service: owner filter, ordering, limit. Handler: non-owner → 404
(match the repo's existing not-found-over-forbidden convention — verify at the
neighboring agent routes and mirror it). Web: list renders generations + badge.

**Acceptance.** Owner sees every release ever cut, newest first, live one
badged; nothing is mutable from this surface.

---

## WO-5 — Knowledge-lite: facts, open questions, alert wiring

**Problem.** Studio's Knowledge pane is a boundary placeholder; the platform has
no facts/questions store (verified: no adapter surface exists). Decision: ship
probabilistic Knowledge at platform level; email-ops untouched.

**Evidence-adjusted design note.** The platform does not assemble wake prompts —
handler code builds its own prompts. Therefore "facts present every wake" is
delivered as: (a) **SDK pull** `galactic.knowledge.facts()` (launch), and
(b) optional auto-prepend of a facts block into `galactic.ai()` system context
behind an env-gated allowlist (`KNOWLEDGE_AI_INJECT`) as a stretch goal —
implemented at the runtime-AI chokepoint if attempted, OFF by default.
Scaffold templates and docs teach pattern (a).

**PR A — storage, SDK, API.**

Migration `<ts>_agent_knowledge.sql` (RLS on, service-role only):

```sql
CREATE TABLE public.agent_knowledge_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  title text,
  content text NOT NULL CHECK (char_length(content) <= 2000),
  source text NOT NULL CHECK (source IN ('owner','agent')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, slug)
);

CREATE TABLE public.agent_knowledge_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  question text NOT NULL CHECK (char_length(question) <= 500),
  context text CHECK (context IS NULL OR char_length(context) <= 1000),
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
  ask_count integer NOT NULL DEFAULT 1,
  blocking boolean NOT NULL DEFAULT false,
  first_asked_at timestamptz NOT NULL DEFAULT now(),
  last_asked_at timestamptz NOT NULL DEFAULT now(),
  answered_fact_id uuid REFERENCES public.agent_knowledge_facts(id),
  UNIQUE (app_id, content_hash)
);
```

Service `api/services/agent-knowledge.ts`:
- `askQuestion({appId, userId, question, context?, blocking?})` — dedupe on
  `sha256(lowercase(trim(question)))`; existing row → increment `ask_count`,
  bump `last_asked_at`, OR `blocking`; `blocking` transition false→true mints
  the attention item (below). Idempotent by construction.
- `listKnowledge`, `upsertFactBySlug` (owner Teach; bumps `revision`),
  `answerQuestion` (creates/updates fact, sets `answered`, links
  `answered_fact_id`, resolves attention), `dismissQuestion`.
- Attention wiring: use the existing attention/alert mint + resolve helpers in
  `api/services/agent-attention.ts` (locate exported constructors during
  implementation; follow whatever kind/severity vocabulary exists — do not
  invent a parallel one). Deep-link destination: Studio knowledge pane +
  question id. **Auto-resolve on answer/dismiss** — the summons dies with its
  cause; alerts are pointers, never residences.

Sandbox SDK (`api/runtime/sandbox.ts`, the namespace assembly where
`globalThis.galactic = ultralight` ~L2746):
- `galactic.knowledge.ask({question, context?, blocking?}) → {questionId, deduped}`
- `galactic.knowledge.facts() → [{slug, title, content, source, updatedAt}]`
  (active only, injectable-format helper included: each fact renders as
  `[fact:slug] content` so outputs can cite fact ids — the future citation hook).
Host bridging follows the existing host-call pattern used by `galactic.embed`
(~L2265) — same timeout class, same error envelope style.

Routes + OpenAPI (`launch.ts`):
- `GET  /api/launch/agents/{id}/knowledge`
- `POST /api/launch/agents/{id}/knowledge/facts`            (Teach / edit)
- `POST /api/launch/agents/{id}/knowledge/questions/{qid}/answer`
- `POST /api/launch/agents/{id}/knowledge/questions/{qid}/dismiss`

Contracts: `LaunchAgentKnowledgeFact`, `LaunchAgentKnowledgeQuestion`,
projection + request/response types.

**PR B — Studio pane.**
- Replace the knowledge `AgentStudioContractBoundary`
  (`agent-studio.tsx` ~L769) with the live pane: open questions (question,
  context line, ask-count, answer input + "Teach it") and facts table
  (fact, content, source badge: "you wrote this" / "learned from the agent",
  edit affordance). "Add a fact" flow. No cited-count column at launch.
- Nav badge = open question count (mirror the alerts count pattern —
  `alert-count-cache.ts` precedent; extend the batched home/state fetch rather
  than adding a poll).
- Copy stays honest about what's absent (citations, contradictions —
  pillar P6 territory).

**Tests.** Service: dedupe increments not duplicates; blocking transition mints
exactly one attention item; answer resolves it; slug validation; revision bump.
Sandbox: `knowledge.ask` bridges, reserved shapes stripped, facts() returns
active-only. Handler: route auth (owner-only), payload validation. Web: pane
states (empty/questions/facts), teach flow, badge count (vitest).

**Acceptance.** An agent can `ask` mid-run (idempotently); the owner sees the
question in Studio, teaches an answer, the fact exists with a stable slug, a
blocking question raised an alert that auto-resolved on answering, and
`facts()` returns the taught fact on the next wake.

---

## WO-6 — Concept graph v1: brackets, glossary, `about()` / `suggest()`

**Baseline for this order:** `main @ a2f776c` (2026-08-02, post PR #191).
Design record: `docs/POLICY_PILLAR_ARCHITECTURE.md` §13 (the concept-graph
design note) — decisions there are LOCKED; this order is their file-level
projection.

**Problem.** Knowledge-lite gives the agent facts; nothing connects facts,
policies, schema fields, memory, and runtime data into retrievable
neighborhoods. The concept graph adds that connective tissue with one
writing-native notation, and pre-builds the substrate the pillar's P5
scoping layer and P4 compiler will consume (they arrive to a populated
graph, not an empty one).

**Design (locked, summarized).**

- Creation channels: **declared** (`concept: true | "slug"` on a manifest
  schema field), **mentioned** (`[[slug]]` in any parsed prose — unknown
  slugs auto-create `provisional` concepts), **authored** (Studio/MCP).
- Structure declares identity; prose declares association. Brackets never
  appear in identifiers; `concept:` never appears in prose.
- Field-description **seeding**: `concept: true` copies the field's
  description onto the concept page **only if the page is blank** — one
  time, never overwriting; the page is canonical thereafter. First writer
  seeds on multi-field collisions.
- Mentions are **derived**: recomputed per (surface, id) on write —
  edit text, re-index, stale edges vanish. Block = the surface's natural
  unit (fact, question, policy statement, function/schema description
  string, run summary; memory + mission split by paragraph/bullet) and the
  block is also the embedding chunk.
- Slugs immutable (fact-slug charset), titles mutable, merges = aliases.
- Embeddings: owner's BYOK route, **inline on the concept row** with
  provider/model/text-hash columns (mirror `agent_search_documents`);
  compare only within one model space; "re-embed all" is explicit.
- D1 tier 1 only: manifest-declared text columns parsed at the platform's
  metered database write path; no scanning, no background jobs.
- Agent-scoped. NOT in v1: gate scoping (P5), case-law writes (P3),
  unlinked-references view (v1.5), semantic D1 sweep, typed edges,
  `x-concept`, cross-agent graphs, auto-injection into `ai()`.

**Schema.** New migration `supabase/migrations/<ts>_agent_concepts.sql`
(precedents: `20260723103000_agent_search_documents.sql` for pgvector +
embedding metadata; `20260801170000_agent_knowledge.sql` for RLS posture):

```sql
CREATE TABLE public.agent_concepts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$'),
  title text CHECK (title IS NULL OR char_length(title) <= 120),
  description text CHECK (description IS NULL OR char_length(description) <= 4000),
  status text NOT NULL DEFAULT 'provisional'
    CHECK (status IN ('provisional', 'active', 'retired')),
  created_by text NOT NULL DEFAULT 'mention'
    CHECK (created_by IN ('owner', 'agent', 'schema', 'mention')),
  aliases text[] NOT NULL DEFAULT ARRAY[]::text[],
  embedding public.vector(1536),
  embedding_status text NOT NULL DEFAULT 'none',
  embedding_provider text,
  embedding_model text,
  embedding_text_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, slug)
);

CREATE TABLE public.agent_concept_mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  concept_id uuid NOT NULL REFERENCES public.agent_concepts(id) ON DELETE CASCADE,
  surface_type text NOT NULL CHECK (surface_type IN (
    'fact', 'question', 'mission', 'memory', 'activity_summary',
    'function_description', 'schema_field', 'concept_page', 'd1'
  )),
  surface_id text NOT NULL CHECK (char_length(surface_id) BETWEEN 1 AND 240),
  block_id text NOT NULL CHECK (char_length(block_id) BETWEEN 1 AND 240),
  block_text text NOT NULL CHECK (char_length(block_text) <= 2000),
  -- Identity edges (concept: true|"slug") vs prose mentions ([[slug]]).
  identity boolean NOT NULL DEFAULT false,
  -- Schema-origin provenance: which release asserted this, which arg path.
  release_id uuid,
  field_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, concept_id, surface_type, surface_id, block_id)
);

CREATE INDEX agent_concept_mentions_surface_idx
  ON public.agent_concept_mentions (app_id, surface_type, surface_id);
CREATE INDEX agent_concept_mentions_concept_idx
  ON public.agent_concept_mentions (app_id, concept_id, created_at DESC);

ALTER TABLE public.agent_concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_concept_mentions ENABLE ROW LEVEL SECURITY;
```

Re-index contract: `DELETE WHERE (app_id, surface_type, surface_id)` then
insert the fresh parse — mentions are a pure function of current text.
`block_text` is capped at 2000 chars (facts already are; long prose blocks
truncate with an ellipsis marker — `about()` links back to the source for
the rest).

---

### PR A — data plane: store, parser, indexer, routes

**New `api/services/concept-mentions.ts`** — the pure parser. Exports:
- `extractConceptMentions(text, { blockSplit }) → [{slug, blockId, blockText}]`
  — reuses the fact-slug regex (export `SLUG_PATTERN` from
  `agent-knowledge.ts` instead of duplicating); skips fenced code blocks;
  paragraph/bullet splitter for freeform surfaces; whole-string block for
  row-shaped surfaces.
- `slugifyIdentifier(fieldName)` — underscores→hyphens, lowercase (shared
  with the promotion parser).
Pure functions, no fetch — fully unit-testable.

**New `api/services/agent-concepts.ts`** — store + retrieval:
- `ensureConcept(userId, appId, slug, {createdBy})` — auto-create
  `provisional` on first mention; idempotent (409 → return existing, the
  WO-1/WO-5 dedupe pattern).
- `reindexSurface(userId, appId, surfaceType, surfaceId, blocks)` —
  delete + insert per the re-index contract; ensures concepts for unknown
  slugs.
- `describeConcept(userId, appId, slug, {title?, description?, aliases?,
  status?, author})` — description edit re-embeds via the owner's BYOK
  inference route (same resolution path as `galactic.embed`); on embed
  failure store `embedding_status: 'pending'` and the text hash — never
  fail the write because embedding hiccuped (mirror
  `agent_search_documents` status discipline).
- `aboutConcept(userId, appId, slug)` — concept row + mentions grouped by
  surface_type (identity edges first, newest-first within groups, bounded
  per group) + `relatedConcepts` (co-mention counts). Aliases resolve.
- `suggestConcepts(userId, appId, text, {limit})` — verbatim/alias match
  (deterministic, ranked first) + embedding similarity vs concept vectors
  **within the same embedding model only**; returns
  `[{slug, score, basis: 'verbatim' | 'alias' | 'semantic'}]`.

**Hook sites (each is 2–4 lines calling `reindexSurface`):**
- `api/services/agent-knowledge.ts` — after fact upsert (surface `fact`,
  block = content) and question ask (surface `question`).
- `api/services/routines.ts` `updateRoutine` — mission/intent changes
  (surface `mission`, paragraph split).
- `api/src/bindings/memory-binding.ts` — memory writes (surface `memory`,
  markdown block split; hook host-side where the write lands, not in
  sandbox code).
- `api/services/routines.ts` `updateRoutineRun` — run summary writes
  (surface `activity_summary`).
- `api/services/agent-concepts.ts` itself — description edits re-index the
  concept page (surface `concept_page`) so concept↔concept prose links work.

**Promotion parsing** — in `api/services/builder-handoff-deployments.ts`
where the exports snapshot is persisted (`exports: [...snapshot.exports]`,
~L2113): walk each function's arg schema; for every property read
`description` (prose mentions → surface `schema_field`, field_path set,
release_id set) and the `concept` key: `true` → identity edge to
`slugifyIdentifier(propertyName)`; string → identity edge to that slug
(validate against SLUG_PATTERN; invalid = candidate validation warning,
never a silent drop). Seeding: if the target concept's description is
blank, copy the field description (one-time; `created_by: 'schema'`).
Function descriptions parse the same way (surface `function_description`).
Removing `concept:` in a later release stops asserting the edge for new
releases; prior releases' mentions remain with their release_id — never
cascade-delete a concept from a manifest change.

**D1 tier 1** — manifest opt-in (e.g. `concepts_index: ["notes",
"conversation_summary"]` alongside the database declaration; exact key
location per GALACTIC_YAML conventions, documented in the same PR): at the
platform's metered database write path (locate via
`api/services/d1-data.ts` / `d1-metering.ts` — the host-mediated write the
flight recorder already tallies), when a written value is a string in a
declared column, parse and re-index (surface `d1`,
surface_id = `table.rowid`, best-effort — a parse failure never fails the
tenant write).

**Routes + OpenAPI (`api/handlers/launch.ts`, the WO-4/WO-5 pattern:
owner-only, `resolveOwnerPrivateRoutineAgent`):**
- `GET  /api/launch/agents/{id}/concepts` — glossary (slug, title, status,
  mention counts, description first line).
- `GET  /api/launch/agents/{id}/concepts/{slug}` — `aboutConcept`.
- `POST /api/launch/agents/{id}/concepts/{slug}` — owner describe/edit
  (title, description, aliases, status; author = 'owner').
- `POST /api/launch/agents/{id}/concepts/suggest` — `suggestConcepts`.
Contracts in `shared/contracts/launch.ts`:
`LaunchAgentConcept`, `LaunchAgentConceptMentionGroup`,
`LaunchAgentConceptAbout`, `LaunchAgentConceptSuggestion` + request types.

**Tests (PR A):** parser unit suite (brackets, fences, blocks, slugify,
`[[]]`-is-not-a-mention — empty brackets are a no-op everywhere now);
concepts service (ensure-idempotency, reindex delete+insert, seeding
only-if-blank, alias resolution, suggest basis ordering, model-space
guard); promotion parsing (identity edges, string form, invalid slug
warning, seeding, release provenance); hook-site tests extend the existing
suites (`agent-knowledge.test.ts`, `routines.test.ts`).

---

### PR B — agent plane: binding, MCP tools, skill docs

**New `api/src/bindings/concepts-binding.ts`** — stamp
`knowledge-binding.ts` exactly: `WorkerEntrypoint` with frozen
`{appId, userId, requireExecCtx}` props; `assertExecutionContext` on every
method; authority rides the release's declared database effect
(`database.read` for `about`/`suggest`, `database.write` for `describe`) —
the never-widen invariant with zero manifest-vocabulary changes, exactly as
PR #191 established. Methods: `about(slug)`, `suggest(text, limit?)`,
`describe(slug, {title?, description?, aliases?})` (author = 'agent',
attributed).

Wiring checklist (mirror PR #191 file-for-file):
- `api/src/worker-entry.ts` — export the binding beside `KnowledgeBinding`.
- `api/src/bindings/test-runtime-bindings.ts` — `TestConceptsBinding` stub
  (gx.test containment).
- `api/runtime/runtime-contract.ts` — bump
  `GALACTIC_SANDBOX_TEMPLATE_VERSION` (next: `…concepts-binding.v27`) and
  add the `galactic.concepts` surface to the runtime contract.
- `api/runtime/dynamic-sandbox.ts` — expose `galactic.concepts.*`;
  `api/runtime/dynamic-sandbox-concepts.test.ts` (crib
  `dynamic-sandbox-knowledge.test.ts`).

**Platform MCP** (`api/handlers/platform-mcp.ts`): `gx.concepts_about`,
`gx.concepts_suggest`, `gx.concepts_describe` following the existing gx
tool pattern, and — the actual launch vehicle — extend `buildPlatformDocs()`
with the notation contract: `[[slug]]` = association in any prose;
`concept: true | "slug"` = identity on schema fields; unknown slugs
auto-create; write brackets into declared D1 text columns. Scaffold
template guidance updates ride the same PR so newly built agents write
brackets from day one.

**Docs:** `docs/GALACTIC_YAML_V1ALPHA1.md` — the `concept:` field key
(bool | string), seeding semantics, `concepts_index` D1 opt-in.

**Tests (PR B):** binding tests (scope freeze, authority gating, exec-ctx
assertion — crib the PR #191 suite), template-version test update, MCP tool
registration + docs snapshot tests (`platform-skills-doc.test.ts` pattern).

---

### PR C — Studio plane: glossary in the Knowledge pane

`apps/launch-web/src/components/agent-studio/agent-studio-knowledge.tsx`
gains the Concepts section (the pane's "second act"):
- Glossary list: slug, title, status chip (`provisional` distinct), mention
  count; orphans (provisional, single mention, no description) grouped for
  housekeeping visibility.
- Concept page view: description (owner-editable), aliases, backlinks
  grouped by surface (schema identities first with release + field path;
  then facts, policies/mission, memory, activity, D1) — each backlink
  renders its block text with a source label.
- "Add a concept" mirrors the Add-a-fact flow.
Client methods in `apps/launch-web/src/lib/api.ts`
(`agentConcepts`, `agentConceptAbout`, `describeAgentConcept`,
`suggestAgentConcepts`); vitest via the `initialProjection`-style DI seam
already used by the knowledge pane tests.

**Acceptance (whole order).** A dev's coding agent reads the skill docs,
writes `concept: true` on `refund_window` and `[[refund-window]]` in a
fact; after promotion the glossary shows the concept seeded from the field
description with an identity backlink carrying release + arg path; the
agent's runtime `about("refund-window")` returns the fact block, the schema
identity, and (with a declared D1 column) the conversation rows that
mentioned it; `suggest("I want my money back")` ranks `refund-window`
first once the description mentions paraphrases; editing the description
re-embeds under the owner's BYOK model with provider/model recorded;
deleting the bracket from the fact and re-saving removes that mention on
re-index. Nothing routes to Approvals — no gate exists yet, by design.

**Guardrails.** Do not touch the gate/policy contracts (P2–P5 territory);
do not auto-inject concepts into `ai()` calls; do not parse undeclared D1
columns; do not implement unlinked-references or typed edges; embedding
failures degrade to `pending`, never block writes; the reserved-args and
never-widen invariants apply unchanged.

---

## Cross-cutting

- **Additive-only:** every WO is backward compatible; no flags required except
  the WO-5 injection stretch. No release-policy interaction; Compute admission
  untouched (`preserve_off`).
- **Docs hygiene:** each landing updates the status table here and, where a
  contract was added, one line in `AGENT_STUDIO_BACKEND_REQUIREMENTS.md`'s
  ledger (AS-BE-017 → Partial after WO-1; AS-BE-012 → Implemented after WO-2;
  AS-BE-005 stays Partial with a note after WO-3).
- **Non-goals policing:** if implementation pressure suggests adding rollback
  buttons, USD figures, approval surfaces, or preview content in run detail —
  stop and re-read the decision register in `POLICY_PILLAR_ARCHITECTURE.md`.
