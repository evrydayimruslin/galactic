# Capability Registry Migration — close-out & consolidation ledger

**Status:** PRs 0–6 landed. The registry is the single source of truth for the
migrated `gx.*` tools and projects them onto the three surfaces (MCP, CLI,
website). This document is the durable record of *what moved, why, and which
deliberately-deferred decisions were resolved vs. parked* — the "consolidate the
deferrals to the end" deliverable.

## Why a registry

Before, a platform capability was defined in up to three hand-maintained places:
the `PLATFORM_TOOLS` array + dispatch switch in `api/handlers/platform-mcp.ts`
(MCP), a hand-written CLI command, and a REST route. "Full surface-area parity"
(whatever the platform can do should be doable via MCP **and** CLI **and**
website) was a hope maintained by memory, not an invariant.

`api/services/capabilities/registry.ts` inverts that: a capability is declared
once (name, tier, branch, input schema, surfaces, handler binding) and each
surface is *projected* from it. The parity invariant is now a test
(`registry.test.ts`): a Tier-1 capability that fails to declare all three
surfaces fails CI.

Migration used the strangler-fig pattern: a capability listed in the registry
has **left** the legacy `PLATFORM_TOOLS` array / dispatch switch (and, where
applicable, the hand-written CLI command / REST route). Everything not yet listed
still flows through the legacy paths, which remain the fallback.

## What is registry-owned today (13 capabilities)

| advertised   | id          | branch      | tier | surfaces          |
|--------------|-------------|-------------|------|-------------------|
| `gx.discover`| discover    | agent_user  | 1    | mcp, cli, web     |
| `gx.download`| download    | ownership   | 1    | mcp, cli          |
| `gx.upload`  | upload      | ownership   | 1    | mcp, cli          |
| `gx.test`    | test        | ownership   | 1    | mcp, cli          |
| `gx.set`     | set         | ownership   | 1    | mcp, cli          |
| `gx.consent` | consent     | agent_user  | 1    | mcp, web          |
| `gx.secrets` | secrets     | agent_user  | 1    | mcp, web          |
| `gx.call`    | call        | agent_user  | 1    | mcp, cli, web     |
| `gx.codemode`| codemode    | agent_user  | 1    | mcp               |
| `gx.db`      | db_inspect  | ownership   | 1    | mcp, cli          |
| `gx.verify`  | verify      | agent_user  | 1    | mcp, cli, web     |
| `gx.job`     | job         | agent_user  | 1    | mcp, cli, web     |
| `gx.flag`    | flag        | agent_user  | 1    | mcp               |

**Parity targets** (must declare all three surfaces, enforced by
`registry.test.ts` → `PARITY_TARGETS`): `verify`, `job`, `discover`, `call`.
Agent-native signals (`flag`, `codemode`) are intentionally MCP-only. `consent`
and `secrets` are MCP + website by design (their sensitive writes live in the
website admin panel, not the CLI).

**Still on the legacy path** (unmigrated, working via `PLATFORM_TOOLS` +
dispatch): `ul.wallet`, `ul.logs`, `ul.memory` (core), `ul.grants` (core),
`ul.command`, `ul.rate`, `ul.marketplace`, `ul.routine`, `ul.auth.link`, and
the emit/page-publishing surfaces. These are not blockers; migrating each is
incremental cleanup that adds it to the single source of truth without changing
behavior.

## PR history

- **PR 0** — migrate exactly `verify`; prove the projection pattern end to end.
- **PR 1–2** — discover / download / upload / test / set; secrets folds in
  `ul.connect` + `ul.connections` as aliases.
- **PR 3** — the highest-risk gateways: `call` and `codemode`, extracted
  byte-faithfully as bound handlers so their native `ToolError` semantics are
  preserved. `runCapabilityForMcp` maps `CapabilityError → ToolError` and passes
  raw `ToolError` through unchanged.
- **PR 4** — `job` (poll), `flag`; `db_inspect` (owner-only schema/counts/rows)
  and app-level manifest `rate_limit` (dual-path config: manifest declarative +
  `gx.set` dashboard, `gx.set` wins per-field).
- **PR 5** — disclosed + audited cross-user data read: `db_inspect`
  `support_read` action gated on the `data:support_read` manifest permission,
  surfaced as `developer_can_read_user_data` on the trust card (single chokepoint
  `buildAppTrustCard`, so disclosure == enforcement), written to an append-only
  audit log **before** any row is returned (fail-closed).
- **PR 6** — retire / rename / consolidate (this document).

## PR 6 consolidation ledger

Every decision the earlier phases deliberately deferred "to the end," with its
resolution:

1. **balance → `gx.wallet`** — *Resolved, no code.* There is no separate
   `gx.balance` tool; the balance view is `gx.wallet`'s `status` action. The
   "single tool, don't proliferate a second one" decision was already satisfied.
   (`gx.wallet` itself remains on the legacy path — a demoted, MCP-only,
   sensitive-money tool that is not a Tier-1 parity target, so extracting its
   617-line body into the registry would be risk without behavior change. Left
   as optional future cleanup.)

2. **Rename `gx.permit` → `gx.consent`** — *Done.* The consent capability's
   advertised name is now `gx.consent`; `gx.permit` and `ul.permit` remain
   permanent aliases for a deprecation window, so existing callers keep working.
   Denial-message guidance updated ("call `gx.consent(...)`").

3. **Drop `command` / `memory` / `rate`** — *Resolved: do NOT drop.* Usage
   checks showed all three are live surfaces, not dead code: `ul.memory` is a
   **core** tool (persistent cross-session agent memory), `ul.command` is the
   Command-dashboards / generated-interfaces surface (tied to the interface
   relaunch direction), and `ul.rate` is app rating + platform issue reporting.
   Deleting working, merely-demoted features on a stale backlog note would be
   destructive; they stay (memory core; command/rate demoted).

4. **Parity test → CI-required** — *Done, and it fixed a real hole.* CI runs
   `npm run test:full`, whose Deno invocation globbed `services/*.test.ts` — a
   single-level glob that never descended into `services/capabilities/` or
   `services/gpu/`. Seven test files (the parity invariant, the db-inspect
   suite, and all five GPU billing/image-builder suites) were **never running on
   any PR**. Fixed by passing directories (`handlers services runtime`) to
   `deno test`, which recurses; the run went from ~1009 to 1274 collected tests.

5. **Regenerate platform docs** — *Resolved, nothing stale.* `buildPlatformDocs()`
   builds from canonical `gx.*` prose at runtime and does not enumerate the
   renamed tool by name; there is no committed docs artifact carrying `gx.permit`.

### Still deferred (intentionally, with rationale)

- **Retire legacy `ul.*` / `ultralight.*` aliases + wire the alias kill-switch.**
  The deprecation window is deliberately open; alias usage is measured
  (`platform-alias-telemetry`) and mapped
  (`docs/PLATFORM_MCP_ALIAS_DEPRECATION_MAP.md`). Retire only after external
  usage drops to ~zero.
- **Migrate `wallet` / `logs` / `memory` / `grants` / `command` / `rate` into
  the registry.** Behavior-preserving cleanup that grows the single source of
  truth; not required for launch. `logs` read is Tier-1-eligible; its
  `resolve_event_id` write stays website-admin-only when migrated.
- **`job` envelope unification** (website vs MCP shapes) — optional polish.
