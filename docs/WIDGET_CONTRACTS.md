# Widget Contracts

Last reviewed: `2026-05-27`

This document is the canonical contract for desktop/home-screen widgets in
Ultralight. The goal is to keep widget discovery predictable and make Wave 4
legacy removal reviewable.

## Canonical Contract

For a widget with id `email_inbox`, the canonical contract is:

- manifest declaration:
  - `id: "email_inbox"`
  - `label: "Email Approvals"`
  - optional `ui_function: "widget_email_inbox_ui"`
  - optional `data_function: "widget_email_inbox_data"`
  - optional `data_tool: "widget_email_inbox_data"`
  - optional `cards: [...]` for native Command dashboard cards
- exported UI function:
  - `widget_email_inbox_ui`
  - returns a
    [WidgetAppResponse](../shared/contracts/widget.ts)
    with `meta`, `app_html`, and optional `version`
- exported data function:
  - `widget_email_inbox_data`
  - returns the widget-owned JSON payload used by the UI
  - includes `meta.title`, `meta.icon`, and `meta.badge_count` so desktop can
    poll badge state without re-fetching the HTML shell

`app_html` belongs only in the UI function response. Desktop caches that HTML
locally by app version after first load; recurring widget refresh should use
the data function and avoid returning static shell bytes.

Desktop discovery should treat `_widget_*_ui` / `_widget_*_data` as the only
canonical contract for new work.

When `widgets[].data_tool` is present, it must match the canonical
`widget_<id>_data` name. Older manifests may omit `data_tool`, but new or
updated manifests should prefer the explicit canonical value for clarity.

## Command Cards

Widgets may expose one or more native Command dashboard cards:

```json
{
  "widgets": [
    {
      "id": "email_inbox",
      "label": "Email Approvals",
      "data_function": "widget_email_inbox_data",
      "cards": [
        {
          "id": "inbox_volume",
          "label": "Inbox Volume",
          "size": "2x1",
          "render": "native",
          "kind": "metric",
          "data_view": "inbox_volume",
          "refresh_interval_s": 300,
          "dependencies": [
            { "app": "email-ops-app-id", "functions": ["list_drafts"], "access": "read" }
          ]
        }
      ]
    }
  ]
}
```

Each card has exactly one fixed `size`. Command cards are read-only in v1 and
must use `render: "native"` when the field is present. Card body data comes from
the widget's backend data function. The desktop card pull should pass
`{ "card_id": "...", "data_view": "..." }` into that data function; custom
per-card `data_function` is available only when the shared data function is not
optimal.

`dependencies` declare the read-only app/function calls a card or widget data
function may make through `ultralight.call(...)`. A matching dependency grants
only that source app permission to attempt that target function; the target app
still enforces the installed user's auth, settings, visibility, and permission
rows. Broad `permissions: ["app:call"]` remains available for older/general MCPs
but should not be used for command cards.

## Command Setup Primitive

Agents should use the shared platform primitive instead of inventing their own
dashboard setup flow:

```js
ul.command({ action: "inventory", query: "work", surfaces: ["command_card"] })
ul.command({ action: "blueprint", prompt: "email, calendar, GitHub, and expenses", title: "Work" })
ul.command({ action: "save", blueprint })
```

`inventory` reads installed widget/card surfaces from the same function index
that powers codemode. `blueprint` creates a proposed server-synced layout but
does not save. `save` persists only a confirmed layout into
`user_command_dashboard_layouts`.

Tool Dealer can also ask discovery for cards:

```js
ul.discover({ scope: "library", query: "health dashboard", surfaces: ["widget", "command_card"] })
ul.discover({ scope: "appstore", query: "fitness tracker", surfaces: ["command_card"] })
```

Those surfaces come from the same manifest `widgets[].cards[]` declarations as
the backend runtime, so the later desktop UI veneer can render from one
contract.

## Agentic Widgets

Widgets can optionally expose semantic state, read context, and actions to the
composer/agent loop. This is a progressive enhancement: widgets remain arbitrary
clickable HTML/JS surfaces, and existing widgets do not need to adopt the
agentic contract.

The first contract layer is manifest metadata:

```json
{
  "context_sources": [
    {
      "id": "email_conversations",
      "label": "Email conversations",
      "type": "function",
      "access": "read",
      "searchable": true,
      "function": "search_conversations_context",
      "default_for_widgets": ["email_inbox"]
    }
  ],
  "widgets": [
    {
      "id": "email_inbox",
      "label": "Email Approvals",
      "agentic": true,
      "context_function": "widget_email_inbox_context",
      "actions_function": "widget_email_inbox_actions",
      "context_sources": ["email_conversations"],
      "agent_actions": [
        {
          "id": "send_selected_draft",
          "label": "Send selected draft",
          "mode": "write",
          "confirmation": "user",
          "mcp": {
            "function": "conversation_act",
            "args_template": { "action": "send" }
          },
          "expected_result": "The selected draft is sent and the widget refreshes."
        },
        {
          "id": "show_draft_editor",
          "label": "Show draft editor",
          "mode": "ui",
          "confirmation": "none",
          "ui": {
            "command": "focus",
            "component_id": "draft_response"
          },
          "expected_result": "The draft editor is visible and focused."
        }
      ]
    }
  ]
}
```

`context_sources[]` are read-only grounding sources for the context index. They
may point at D1 tables, SELECT-only D1 queries, or app functions. They do not
create a write path. Widget writes should still flow through MCP functions or
widget-declared semantic actions.

D1 context sources are permissioned by installation/library scope and by the
manifest declaration itself. `d1_table` sources must list simple table names;
the platform adds `user_id = :user_id` isolation and row/character budgets.
`d1_query` sources must be a single SELECT/WITH statement, must include
`:user_id`, and may use `:query` and `:limit` named placeholders. The platform
also wraps declared queries in an outer row limit. Positional `?` placeholders
and write/DDL statements are rejected. `redactions[]` are applied before rows
are added to Flash context.

Function-backed context sources are indexed for discovery and UI affordances.
The PR5 executable read path is D1 table/query magnification; function-backed
execution should be added only through an audited, read-only MCP invocation path.

`agent_actions[]` describe actions that are safe to show to an agent. Each
action has an id, label, mode (`read`, `write`, or `ui`), optional JSON schema,
confirmation policy (`none`, `user`, or `high_risk`), and optional MCP binding.
Write-mode actions should declare an explicit confirmation policy.

The second layer is runtime state, reported by the widget bridge as an active
widget context. Runtime snapshots should be compact and semantic: current view,
visible components, selected entities, pending edits, enabled actions, errors,
and recent event summaries. The platform should not rely on raw DOM selectors as
the agentic control contract.

Widget composers send `activeWidgetContexts[]` with orchestration requests. The
server formats those snapshots into an `Active Widget Context` prompt block for
Flash read/write routing, prompt construction, and capture telemetry. This is
read/context plumbing only: clickable widgets keep working as-is, and widget
action execution remains an explicit semantic action path rather than direct DOM
automation.

MCP-backed semantic actions run through the live widget bridge. The composer
dispatches a `WidgetActionInvocation` with a `turn_id`, the widget handler calls
its normal MCP functions with `_widget_surface_id`, `_widget_id`,
`_widget_action_id`, and `_widget_turn_id` metadata, and the bridge reports a
`WidgetActionResult` back into the surface event history. Write actions must
still declare and pass a confirmation policy before the composer invokes them.

UI-only actions use the same bridge and result path but do not need an MCP
binding. A widget may declare `mode: "ui"` with `ui.command`,
`ui.component_id`, and optional `ui.args_template` to describe actions like
changing tabs, opening panels, focusing fields, or prefilling prompts. These
actions are progressive enhancement over the clickable UI: the handler mutates
the live widget view, calls `ulWidget.reportState`/`refreshContext`, and returns
an ordinary `WidgetActionResult` snapshot.

Each active widget surface keeps a bounded local event ring buffer. The bridge
normalizes events with `id`, `surface_id`, `widget_id`, `turn_id` when present,
and `created_at`, then the active widget context sends both the recent events
and a compact `recentEventSummary`/`recentEventCount` pair into orchestration.
The prompt path should use the summary for continuity and avoid expanding
unbounded history into model context.

MCP-backed widget actions are auditable through `mcp_call_logs` widget columns:
`widget_action`, `widget_surface_id`, `widget_id`, `widget_action_id`, and
`widget_turn_id`. These fields come from the same `_widget_*` metadata passed by
the widget handler, while the app function receives only clean business
arguments.

## Generated Agentic Interfaces

Generated interfaces are Command-owned workspaces described by
[`AgenticInterfaceSpec`](../shared/contracts/agentic-interface.ts). They are the
next layer above agentic widgets: a planner can combine installed command cards,
declared D1 context sources, MCP read functions, semantic actions, and embedded
widgets into a temporary, saveable interface.

The contract is intentionally typed and renderer-owned. A model may propose
components such as `metric`, `table`, `detail`, `form`, `action_bar`,
`card_ref`, and `widget_embed`; it may not return arbitrary HTML, CSS, React, or
DOM selectors. The platform verifies the spec before rendering it.

The first supported data binding sources are:

- `command_card` - calls an existing widget data function for a declared card
- `context_source` - reads a permissioned manifest `context_sources[]` entry
- `mcp_read_function` - calls an allowed read function through MCP
- `literal` - static planner-provided display data

The first supported action bindings are:

- `mcp_function` - invokes an app-owned MCP function
- `widget_action` - invokes a declared semantic action on an active widget
- `open_widget` - opens or embeds an existing widget
- `refresh_binding` - refreshes one or more data bindings
- `select_entity` - updates selection state inside the generated surface

Generated writes must go through MCP functions or widget semantic actions, never
raw D1 writes. The shared validator rejects unknown component kinds, missing
required ids, unsupported data binding sources, and write actions that declare
`confirmation: "none"`.

`ul.command({ action: "interface", prompt })` is the first backend planner API
for these specs. It reads the user's installed Command card/widget inventory,
typed MCP function index, declared context sources, and saved Command dashboard
summaries, then returns a draft spec plus rationale and warnings. It can include
small safe D1 previews when `include_data_preview: true`, but it does not
persist the generated interface.

Useful generated interfaces can be persisted separately from Command dashboard
layouts with `ul.command({ action: "save_interface", spec })`. The server stores
only normalized, verified specs in `user_agentic_interfaces` with metadata such
as `interface_key`, title, description, icon, source prompt, status, and
timestamps. `list_interfaces`, `get_interface`, and `delete_interface` operate
on that catalog. Loading a saved interface re-verifies the stored spec against
the user's current installed cards, widgets, context sources, and MCP functions;
missing capabilities are surfaced as warnings or dropped items instead of
breaking the UI.

Widget, command card, context source, semantic action, and MCP function
declarations may include optional `generation_hints` metadata. Hints are indexed
with the function index and command surface inventory, then passed into the
interface planner context. Existing manifests remain valid without hints.

Supported hint fields are:

- `tags` - searchable terms that may not appear in labels
- `preferred_component` - one of the typed generated component kinds
- `entity_types` - records produced or acted on, such as `conversation`,
  `draft`, `lesson`, or `approval`
- `action_group` - a logical group for related generated actions
- `safe_default_filters` - read-side defaults such as status and limit
- `suggested_components` - companion generated components like details, tables,
  timelines, text, or action bars
- `prompt_examples` - natural-language requests the declaration should match

These hints are planner guidance, not a rendering escape hatch: generated
interfaces still use typed `AgenticInterfaceSpec` components and verified MCP,
widget, and context-source bindings.

## Deprecated Legacy Contract

The deprecated contract is a single exported function such as
`widget_approval_queue` that acts as both discovery and data surface.

That shape is still inventoried for migration, but it is not the canonical
widget contract anymore. New manifests should not declare it in `widgets[]`.

## First-Party Inventory

As of `2026-04-21`, the only first-party widget manifest that still declared a
legacy widget contract was
[apps/mcps/email-ops/manifest.json](../apps/mcps/email-ops/manifest.json).
That manifest is now migrated to the canonical declaration:

- `id: "email_inbox"`
- `data_tool: "widget_email_inbox_data"`

The app still exports `widget_approval_queue` as a compatibility alias for
older clients, but it is no longer the declared widget contract.

## External-App Inventory

Desktop now records any legacy single-function widget contract discovered from
the user's library into local storage under:

- `ul_widget_contract_inventory_v1`

Each entry stores:

- app UUID
- app name
- app slug
- widget name
- legacy function name
- first seen timestamp
- last seen timestamp
- seen count

That inventory is intentionally local-only because the discovery happens in the
desktop shell. It is the evidence we should use before deleting the remaining
fallback path completely.
