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
| WO-1 | Interface invocation idempotency | — | 1 PR | pending |
| WO-2 | Agent-wide Pause / Resume | — | 1 PR | pending |
| WO-3 | Activity run detail (thin slice) | — | 1 PR | pending |
| WO-4 | Release history (read-only) | — | 1 PR | pending |
| WO-5 | Knowledge-lite + open questions + alert wiring | WO-3 helpful, not required | 2 PRs | pending |

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
