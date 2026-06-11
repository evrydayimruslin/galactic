# Launch Pivot Decisions

Decided: 2026-06-10
Status: ACTIVE — this document supersedes conflicting statements in
[LAUNCH_SITE_UPGRADES_IMPLEMENTATION_ROADMAP.md](LAUNCH_SITE_UPGRADES_IMPLEMENTATION_ROADMAP.md),
[LAUNCH_NEXT_STEPS_PR_ROADMAP.md](LAUNCH_NEXT_STEPS_PR_ROADMAP.md),
[LAUNCH_SCORECARD.md](LAUNCH_SCORECARD.md), and
[LAUNCH_ROUTE_INVENTORY.md](LAUNCH_ROUTE_INVENTORY.md).
The rewritten launch scope lives in [LAUNCH_MVP_SCOPE.md](LAUNCH_MVP_SCOPE.md).

## Strategic frame

The desktop app is scrapped. The launch surface is:

1. The platform MCP + API on Cloudflare Workers (`api/`), connectable to any
   agent (Claude Code, Cursor, Codex, OpenClaw, generic MCP clients).
2. The website on Cloudflare Pages (`apps/launch-web`) that supports those
   connections: install, discovery, public Agent pages, wallet, settings,
   owner admin.

Launch scope remains **curation, not isolation**: the launch facade
(`api/handlers/launch.ts`) and the website expose a curated slice over the
shared backend. Deferred capabilities stay dormant in the capability basin.

## The five changes (P1–P5)

- **P1 — Reintroduce BYOK + credit-denominated inference.** Both already run
  live in the API (`/api/user/byok`, `services/inference-route.ts`,
  `debit_light`); the work is launch-surface exposure (settings UI, facade
  endpoints, a pre-call balance gate) plus the credit rename below.
- **P2 — Remove Widgets from launch scope entirely.** Facade endpoints,
  contract types, FE widget runtime/iframe host, discovery subject rows, and
  `open_widget` next-actions are removed. Shared widget types, manifest
  validation, and billing paths stay dormant in the basin.
- **P3 — Fold Skills into Functions.** First-class monetized skills (manifest
  `skills{}`, skill pulls, `ultralight.getSkills`/`pullSkill`, launch skill
  endpoints) are removed in favor of a convention: an exported skills-index
  function returning skill descriptors plus a skill-reader function returning
  full text, priced through existing per-function pricing. Generated
  `skills.md` function docs remain (served free).
- **P4 — Rename Tools → Agents.** Presentation-layer rename only. The DB
  entity remains `apps` (per the handoff rule "Tools = apps"); MCP protocol
  vocabulary (`tools/list`, `tools/call`) is untouched.
- **P5 — Per-function cross-agent permissions.** Deploy/publish reads a
  manifest declaration of the external functions an Agent wants to call from
  other Agents; each Agent page shows which calling Agents have requested its
  functions, and the user grants/denies per function. Adds caller-agent
  identity propagation, credit-denominated monthly spend caps per function,
  and unified enforcement (including `ul.codemode` and website runs).

## Locked decisions

1. **Credit name: "Light" → "Credits" (generic).** Display, API responses,
   contracts, and OpenAPI copy say Credits. Database column/RPC names
   (`*_light`, `debit_light`, `transfer_light`, …) are internal and KEEP their
   names — a Postgres rename would churn dozens of SECURITY DEFINER RPCs, RLS
   policies, and indexes for zero data-model benefit. Wire-contract renames
   ship with aliases for one deprecation window.
2. **Vocabulary: "Agents" vs "connected agent."** Marketplace entities
   (deployed apps) are **Agents**. The user's external client (Claude Code,
   OpenClaw, Cursor) is their **connected agent**. The existing
   `agent-permissions` types/endpoints (which gate the connected agent) will
   be renamed to **caller-permissions** (lands with the Phase 3 rename sweep)
   to free the word "Agent" for the entity.
3. **P5 composition: the per-Agent grant is authoritative.** A user-granted
   `caller Agent → target Agent function` permission authorizes the call on
   its own — it does not additionally require the connected-agent policy on
   the target. Caller-agent identity must propagate on every cross-Agent hop,
   and every execution path (per-app MCP, `/api/run`, HTTP routes,
   `ul.codemode`, website runs) enforces the same grant model.
4. **Removal depth for P2/P3: delete from launch scope, keep the basin
   dormant.** Shared contract types, manifest validation, MCP billing paths,
   and DB CHECK-constraint enum values stay in place (writers stop emitting
   them). No hard deletes outside the launch surface, no destructive
   migrations.

## Phase plan

- **Phase 0 (this change):** decision records; scope-doc rewrite; launch web
  session refresh (`/auth/launch/refresh` + HttpOnly `SameSite=None` refresh
  cookie + silent client refresh) so write-heavy P1/P5 surfaces don't die at
  the ~1h JWT cliff; desktop decoupling of shared auth infra (embed-bridge
  audience now required; tauri CORS origins removed).
- **Phase 1:** P3 (skills → functions convention) + P2 (widget removal),
  together. Hard ordering constraint: design the P5 manifest
  `external_functions` declaration BEFORE deleting `widget.dependencies` —
  today it is the only manifest-level cross-app call mechanism. Retire
  `scripts/checks/check-widget-contracts.mjs` in the same PRs.
- **Phase 2:** P1 — BYOK settings surface over existing `/api/user/byok`,
  launch inference-options endpoint, pre-call balance gate on the runtime AI
  path, Credits rename across contract/facade/FE/OpenAPI/SDK/CLI copy.
- **Phase 3:** P4 — Tools → Agents rename (`/tools/:slug` → `/agents/:slug`
  with compatibility aliases, contract symbol renames, copy sweep). Includes
  the locked-decision-2 rename: `/api/launch/tools/:id/agent-permissions` →
  `/api/launch/agents/:id/caller-permissions` (deprecation-window alias),
  `LaunchAgentFunctionPermission*` contract symbols →
  `LaunchCallerFunctionPermission*`, and
  `services/agent-function-permissions.ts` → caller-permissions naming.
- **Phase 4:** P5 — manifest declaration + grant table/inbox/UI +
  caller-identity propagation + credit-denominated monthly caps + unified
  enforcement (closing the `ul.codemode` bypass). Shipped as sub-phases
  4a (grant spine: identity, enforcement, caps, hop protection), 4b (wiring
  read-models + facade + `ul.grants` + FE), 4c (unified enforcement across all
  call paths incl. codemode).
- **Phase 4.5:** P5 reactive layer — cross-Agent pub/sub event bus. An Agent
  emits a topic (`ultralight.emit` in-sandbox, or `ul.emit` manually as an
  owned Agent); the dispatch cron fans the event out to every Agent the user
  wired a `mode='subscribe'` grant for. Reuses the grant spine: a subscribe
  grant is `(caller=emitter, target=subscriber+handler, topic, mode='subscribe')`
  under the same delegation-not-expansion invariant. Emitting is unprivileged;
  receiving is grant-gated. Delivery is async (enqueue at emit → drain via
  cron), billed to the user, capped per subscribe grant, and bounded by the
  caller-context hop ceiling so reactive cascades terminate. New tables:
  `agent_events`, `agent_event_deliveries` (idempotent per event+grant);
  `agent_function_grants` gains a `topic` selector. Migration
  `20260610190000_agent_event_bus.sql` must be applied at deploy.
  - **Delivery semantics (deliberate):** AT-MOST-ONCE. The `(event, grant)`
    unique row means each subscriber is invoked at most once per event; a
    `failed` delivery is recorded on its row and rolled up to a `failed` event
    (with `last_error`), but is NOT auto-retried — the handler may have run and
    settled before erroring, so a blind retry could double-bill / double-act.
    A mid-fan-out crash still completes UN-attempted subscribers (lease expires
    → event re-scans → terminal delivery rows are skipped). Payload is bounded
    to 32 KB; per-execution emits to 50; fan-out to `MAX_EVENT_FANOUT`.
  - **Deferred hardening (post-launch followups):** (1) at-least-once delivery
    with idempotent settlement, so transient subscriber failures retry without
    double-billing (would retire the currently-dead `agent_event_deliveries.attempts`
    column); (2) a per-user/emitter enqueue rate limit + a global per-user
    monthly delivery ceiling, since uncapped subscribe grants
    (`monthly_cap_credits=null`) otherwise bound breadth only by credit balance;
    (3) an operator surface over `agent_event_deliveries.status='failed'/'denied'`.

## Known-state corrections this plan relies on (verified 2026-06-10)

- "Monthly spend caps per function" do NOT exist today:
  `user_app_permissions.budget_limit` is a call COUNT, and
  `getBudgetPeriodStart` (period reset) has no production callers — only its
  own tests. P5 builds real credit-denominated caps; nothing should be wired
  to the dormant columns as-is.
- Production `ul.codemode` executes library-app functions in-process with no
  permission gate, budget accounting, or receipts
  (`api/runtime/dynamic-executor.ts`, `platform-mcp.ts` codemode path). P5
  must gate it; until then it is a known launch-scope caveat.
- The connected-agent permission layer (migration `20260606150000`,
  now `services/caller-function-permissions.ts` after the Phase 3 rename)
  is live end-to-end and becomes the "caller-permissions" base for P5.
- BYOK silently activates for users who configured it pre-launch:
  `resolveInferenceRoute` prefers the primary BYOK key with no UI signal.
  P1 must surface billing mode explicitly.
- `app_type='skill'` standalone uploads violate the `apps_app_type_check`
  constraint (only `mcp|ui|hybrid` allowed; no migration relaxed it) — the
  standalone skill-app path is presumed broken in production, which lowers
  P3's removal cost.
