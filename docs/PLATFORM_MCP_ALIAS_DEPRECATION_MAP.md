# Platform MCP Alias Deprecation Map

Last reviewed: `2026-04-21`

This document is the Wave 4 alias map for
[api/handlers/platform-mcp.ts](../api/handlers/platform-mcp.ts).
It lists the still-supported backward-compat alias names, their intended
canonical replacement, and any blockers that must be resolved before the alias
can be removed.

Alias-hit telemetry now logs structured `platform_mcp_alias` events through
[api/services/platform-alias-telemetry.ts](../api/services/platform-alias-telemetry.ts).
The removable alias set can now also be disabled at runtime with
`PLATFORM_MCP_DISABLED_ALIASES=removable` or with a comma-separated list of
specific alias names once staging telemetry is quiet.

## Discover And Set Aliases

| Alias | Canonical replacement | Removal blocker |
| --- | --- | --- |
| `ul.discover.desk` | `ul.discover({ scope: "desk" })` | None once telemetry is quiet |
| `ul.discover.inspect` | `ul.discover({ scope: "inspect", app_id })` | None once telemetry is quiet |
| `ul.discover.library` | `ul.discover({ scope: "library", query? })` | None once telemetry is quiet |
| `ul.discover.appstore` | `ul.discover({ scope: "appstore", query?, task? })` | None once telemetry is quiet |
| `ul.set.version` | `ul.set({ app_id, version })` | None once telemetry is quiet |
| `ul.set.visibility` | `ul.set({ app_id, visibility })` | None once telemetry is quiet |
| `ul.set.download` | `ul.set({ app_id, download_access })` | None once telemetry is quiet |
| `ul.set.supabase` | `ul.set({ app_id, supabase_server })` | None once telemetry is quiet |
| `ul.set.ratelimit` | `ul.set({ app_id, calls_per_minute?, calls_per_day? })` | None once telemetry is quiet |
| `ul.set.pricing` | `ul.set({ app_id, default_price_light?, default_free_calls?, function_prices? })` | None once telemetry is quiet |

## Permissions, Connection, And Memory Aliases

| Alias | Canonical replacement | Removal blocker |
| --- | --- | --- |
| `ul.permissions.grant` | `ul.permissions({ app_id, action: "grant", ... })` | None once telemetry is quiet |
| `ul.permissions.revoke` | `ul.permissions({ app_id, action: "revoke", ... })` | None once telemetry is quiet |
| `ul.permissions.list` | `ul.permissions({ app_id, action: "list" })` | None once telemetry is quiet |
| `ul.permissions.export` | `ul.permissions({ app_id, action: "export", format?, since?, until?, limit? })` | None once telemetry is quiet |
| `ul.connect` | `ul.secrets({ app_id, secrets })` | None once telemetry is quiet |
| `ul.connections` | `ul.secrets({ app_id? })` | None once telemetry is quiet |
| `ul.memory.read` | `ul.memory({ action: "read", owner_email? })` | None once telemetry is quiet |
| `ul.memory.write` | `ul.memory({ action: "write", content, append? })` | None once telemetry is quiet |
| `ul.memory.append` | `ul.memory({ action: "write", content, append: true })` | None once telemetry is quiet |
| `ul.memory.recall` | `ul.memory({ action: "recall", key, value?, scope?, owner_email? })` | None once telemetry is quiet |
| `ul.memory.remember` | `ul.memory({ action: "recall", key, value, scope? })` | None once telemetry is quiet |
| `ul.memory.query` | `ul.memory({ action: "query", prefix?, limit?, owner_email? })` | None once telemetry is quiet |
| `ul.memory.forget` | `ul.memory({ action: "query", delete_key: key, scope? })` | None once telemetry is quiet |

## Rating, Page, And Utility Aliases

| Alias | Canonical replacement | Removal blocker |
| --- | --- | --- |
| `ul.markdown.publish` | `ul.upload({ type: "page", slug, content, title?, tags?, shared_with?, published? })` | None once callers are migrated |
| `ul.markdown.list` | No canonical replacement published yet | Page listing still depends on the legacy alias surface |
| `ul.markdown.share` | No canonical replacement published yet | Page and memory share actions still depend on the legacy alias surface |
| `ul.like` | `ul.rate({ app_id?, content_id?, rating: "like" })` | None once telemetry is quiet |
| `ul.dislike` | `ul.rate({ app_id?, content_id?, rating: "dislike" })` | None once telemetry is quiet |
| `ul.lint` | `ul.test({ files, lint_only: true, strict? })` | None once telemetry is quiet |
| `ul.scaffold` | `ul.download({ name, description, functions?, storage?, permissions? })` | None once telemetry is quiet |
| `ul.health` | No canonical replacement published yet | Health inspection still depends on the legacy alias surface |
| `ul.gaps` | No canonical replacement published yet | Gap review still depends on the legacy alias surface |
| `ul.shortcomings` | No canonical replacement published yet | Shortcoming review still depends on the legacy alias surface |
| `ul.execute` | `ul.codemode({ code })` | None once telemetry is quiet and old prompts are migrated |

## First-Party Compatibility Seams Still Tracked

These are not alias dispatch entries in `platform-mcp`, but they still matter
for eventual alias removal:

- [desktop/src/lib/agentLoop.ts](../desktop/src/lib/agentLoop.ts)
  still counts `ul_execute` and `ul.execute` as codemode calls for the desktop
  safety cap while the server-side alias remains live. That guard should be
  removed only when the alias is actually deleted from `platform-mcp`.
- [desktop/src/hooks/useMcp.ts](../desktop/src/hooks/useMcp.ts)
  still normalizes underscored chat-tool names like `ul_codemode` into dotted
  MCP names.
- local app/docs text, the first-party CLI, and the main repo README that used
  to suggest `ul.markdown.publish`, `ul.health`, `ul.shortcomings`,
  `ul.set.version`, or `ul.execute` have now been migrated to canonical
  `ul.upload`, `ul.logs`, `ul.rate`, `ul.set`, `ul.discover`, and
  `ul.codemode` surfaces. Remaining first-party cleanup is limited to
  intentional safety guards, historical documentation, and server-side alias
  dispatch.

## Wave 4 Follow-Up

The next PR after telemetry should:

- inspect `platform_mcp_alias` logs to see which aliases are still exercised
- stage `PLATFORM_MCP_DISABLED_ALIASES=removable` in staging once the
  removable alias set is quiet, then run smoke against legacy callers to
  confirm they now get clear canonical replacement errors
- migrate or replace the aliases that still have no canonical public surface
- delete alias dispatch only after those logs stay quiet for the removable set
