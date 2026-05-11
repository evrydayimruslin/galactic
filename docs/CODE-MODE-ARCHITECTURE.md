# Code Mode Architecture

## Overview

Code Mode replaces verbose tool-call-per-function with a two-tool architecture inspired by Cloudflare's Dynamic Workers: `search()` discovers tools dynamically, `codemode()` runs JS recipes that chain multiple MCP calls in a single sandbox invocation.

An agent becomes: `personality.md + search() + codemode() + model choice`

## Core Tools

### ul.search (discovery)

Agent writes JS that queries the user's app library, shared apps, or marketplace. Returns structured JSON with matching functions and widgets — only the relevant subset enters the context window.

```javascript
// Agent writes this code for the search tool:
const apps = spec.filter(a => a.name.includes("email") || a.description.includes("approval"));
return apps.flatMap(a => a.functions.map(f => ({
  app_id: a.id, fn: f.name, description: f.description, params: f.parameters
})));
```

Scopes (searched in order):
1. Library (user's own + saved apps) — free, instant
2. Shared (apps granted access to) — free, permissioned
3. Market (all published apps) — discovery free, use may cost

### ul.codemode (recipe execution)

Agent writes JS that chains MCP calls, transforms data, and returns a composed response. Runs in a Cloudflare Dynamic Worker isolate (or Deno sandbox as fallback).

```javascript
// Agent writes this recipe:
const pending = await ul.call(appId, "approvals_list", { status: "pending" });
const highPriority = pending.filter(p => p.priority === "high");
return {
  text: `You have ${pending.length} pending emails (${highPriority.length} high priority).`,
  widget: { name: "email_inbox", app_id: appId }
};
```

Inside the sandbox:
- `ul.call(app_id, function_name, args)` — calls any MCP function (local function call, no HTTP)
- `ul.discover(scope, query?)` — queries app catalog (same data as search tool)
- No filesystem, no env vars, no raw network access
- Outbound fetch disabled by default

## Agent Identity: personality.md

Each agent's identity is a markdown file:

```markdown
# Front Desk Staff

## Role
You manage guest communications and room operations.

## Preferred Tools
Search for tools in these apps first:
- resort-manager: rooms, billing, guest services
- email-ops: email drafts and approvals

## Widgets
When showing email drafts, use {{widget:email_inbox:APP_ID}}

## Behavior
- Always check room availability before confirming bookings
- Respond to Japanese guests in Japanese
```

Default agents are just default markdown files.

## Execution Pipeline

```
User prompt
    → Agent reads personality.md context
    → search(): discovers relevant functions + widgets from library
    → execute(): writes & runs JS recipe in Dynamic Worker
    → Returns { text, widget? }
    → Desktop renders text + inline widget(s)
    → User interacts with widget → ulAction() → MCP handles mutations
```

## Manifest: Functions vs Widgets

```json
{
  "functions": {
    "approvals_list": { "description": "List pending approvals", "parameters": [...] },
    "approvals_act": { "description": "Approve/reject a draft", "parameters": [...] }
  },
  "widgets": {
    "email_inbox": {
      "label": "Email Approvals",
      "description": "Interactive dashboard for browsing and acting on email drafts",
      "ui_function": "widget_email_inbox_ui",
      "data_function": "widget_email_inbox_data"
    }
  }
}
```

Functions are callable. Widgets are renderable via `{{widget:name:app_id}}`. Widget internal functions never appear in the agent's tool list.

## Client Compatibility

| Client | Mode |
|---|---|
| Ultralight desktop (Sonnet/Opus) | Code mode: search() + execute() |
| Ultralight desktop (small models) | Traditional: direct ul_call per function |
| External MCP clients (OpenClaw, etc.) | Standard MCP: tools/list + tools/call |
| API/webhook callers | Direct HTTP: POST /mcp/{appId} |

Code mode is a platform optimization layer. MCP endpoints don't change.

## Migration Phases

1. **ul.codemode tool** — new platform tool, runs JS in sandbox with ul.call binding
2. **Compact API mode** — system prompt uses search()/execute() instead of verbose schemas
3. **personality.md** — agent creation becomes markdown-first
4. **Remove connected apps** — agents discover tools dynamically

## Token Economics

| Mode | System prompt | Per tool call | Total for 5-call task |
|---|---|---|---|
| Traditional (15 functions) | ~3000 tokens | ~500 tokens/call | ~5500 tokens |
| Code mode | ~500 tokens | ~200 tokens (recipe) | ~700 tokens |

~87% reduction in token usage.
