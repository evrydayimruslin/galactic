# Agentic Interface Generation PR Roadmap

Last reviewed: `2026-05-27`

This roadmap is the follow-on layer after the Agentic Widgets PR stack. The
first stack made widgets visible to the agent loop: active state, visible
components, semantic actions, scoped D1 read context, event history, and voice
through the same composer path.

This stack teaches Command to generate a task-specific interface from installed
widgets, command cards, MCP functions, declared context sources, and live user
data. The product goal is the "make me a control room for this" moment: a
temporary, saveable, agent-aware interface that remains clickable and can also
be navigated or operated by the agent.

## Locked Decisions

- Generated interfaces are temporary by default and saveable after explicit user
  confirmation.
- Generated UI uses a typed `AgenticInterfaceSpec`, not arbitrary model-written
  HTML or React.
- The renderer is platform-native. It renders known primitives such as cards,
  tables, forms, action bars, detail panels, timelines, and embedded widgets.
- Reads can use command card data, MCP read functions, and permissioned declared
  D1 context sources.
- Writes never go directly to D1. They flow through MCP functions or declared
  semantic actions.
- Widget composer scope remains narrow by default. Global Command scope can
  inspect all installed widgets/cards/functions/context sources allowed for the
  user.
- The planner has a verifier/normalizer pass before any interface is shown.
- Generated interfaces become active context surfaces so future agent turns know
  what is visible, selected, stale, actionable, or recently changed.
- Start as `ul.command({ action: "interface", ... })`. Split into `ul.interface`
  later only if the surface grows beyond Command.

Simple explanation:

The model should not "draw a website." It should choose from trusted building
blocks and produce a structured plan. The platform checks the plan, renders it,
loads the data, and executes allowed actions through existing app contracts.

## Current Baseline

The current codebase already has most of the spine:

- Shared widget and command-card contracts:
  - `shared/contracts/widget.ts`
  - `shared/contracts/manifest.ts`
  - `shared/types/index.ts`
- Per-user capability index:
  - `api/services/function-index.ts`
  - `api/services/codemode-tools.ts`
- Command surface inventory and card dashboard blueprinting:
  - `api/services/command-surfaces.ts`
  - `api/services/command-dashboard.ts`
  - `api/handlers/platform-mcp.ts`
  - `api/handlers/user.ts`
  - `desktop/src/hooks/useMcp.ts`
  - `desktop/src/lib/api.ts`
- Active widget runtime and agent context bridge:
  - `desktop/src/lib/widgetRuntime.ts`
  - `desktop/src/lib/widgetSurfaceRegistry.ts`
  - `desktop/src/lib/widgetAgentTypes.ts`
  - `desktop/src/components/InChatWidget.tsx`
  - `desktop/src/components/WidgetWindow.tsx`
  - `desktop/src/components/widgets/WidgetComposer.tsx`
  - `desktop/src/components/widgets/WidgetEventLog.tsx`
- Flash/orchestration context path:
  - `api/handlers/chat.ts`
  - `api/services/orchestrator.ts`
  - `api/services/flash-broker.ts`
  - `api/services/chat-capture.ts`
  - `api/services/flash-finetune-metadata.ts`
- Permissioned read magnification:
  - `api/services/app-context-magnifier.ts`
  - `api/services/app-context-magnifier.test.ts`
- Reference agentic MCP apps:
  - `apps/mcps/email-ops/manifest.json`
  - `apps/mcps/email-ops/index.ts`
  - `apps/mcps/study-coach/manifest.json`
  - `apps/mcps/study-coach/index.ts`

The main gap is that Command can currently select and pack existing cards, but
it does not yet synthesize a new live component tree from all available
components, functions, actions, and relevant data.

## Target Architecture

```text
Global Command composer
  user asks: "make me an interface for X"
        |
        v
Interface planner
  reads function index
  reads command surface inventory
  reads declared context source metadata
  optionally magnifies small data previews
        |
        v
Verifier and normalizer
  drops hallucinated components
  checks data/action permissions
  normalizes component ids and bindings
  returns warnings
        |
        v
Desktop generated interface renderer
  renders platform-native components
  fetches live data through server bindings
  executes actions through MCP/action endpoints
        |
        v
Active surface registry
  reports visible components, data refs, selected entities,
  enabled actions, recent events, and latest payload
        |
        v
Future agent turns
  reason over the generated interface as active UI context
```

## Component Palette For V1

Start small and useful:

- `metric` - single value with label/status.
- `list` - compact ranked or filtered rows.
- `table` - structured rows with selectable records.
- `detail` - selected entity summary and fields.
- `form` - typed input fields that submit to one action.
- `action_bar` - buttons bound to MCP functions or semantic actions.
- `timeline` - events, call logs, routine history, or activity.
- `card_ref` - existing command card instance.
- `widget_embed` - open or embed an existing widget surface.
- `routine_panel` - existing routine monitor/status surface.
- `text` - short generated explanatory label or section heading.

Recommendation:

Avoid chart-heavy or freeform layout in the first pass. Tables, details, forms,
and action bars create the strongest Jarvis feel because they let the interface
be inspected, acted on, and updated.

## PR 11: Shared Agentic Interface Contracts

Purpose:

- Define the typed language the planner returns and the renderer consumes.
- Reuse widget/action/data-ref concepts where possible.
- Keep existing command dashboards and widgets compatible.

Simple explanation:

This PR creates the "JSON grammar" for generated interfaces. The model can say
"show a table bound to this source and an action button bound to this function,"
but it cannot invent arbitrary DOM.

Recommended scope:

- Add `AgenticInterfaceSpec` with:
  - `id`, `title`, `description`, `mode: "temporary" | "saved"`.
  - `intent`, `scope`, `layout`, `components`, `data_bindings`, `actions`.
  - `permissions`, `provenance`, `warnings`.
- Add component union types for the V1 palette.
- Add data binding types:
  - `command_card`
  - `context_source`
  - `mcp_read_function`
  - `literal`
- Add action binding types:
  - `widget_action`
  - `mcp_function`
  - `open_widget`
  - `refresh_binding`
  - `select_entity`
- Add `generated_interface` to active surface kind, or add a generic
  `AgenticSurfaceKind` wrapper while preserving widget compatibility.

Expected files:

- New: `shared/contracts/agentic-interface.ts`
- Modify: `shared/contracts/widget.ts`
- Modify: `shared/contracts/manifest.ts`
- Modify: `shared/types/index.ts`
- Modify: `desktop/src/lib/widgetAgentTypes.ts`
- Modify: `api/services/flash-finetune-metadata.ts`
- New or modify tests:
  - `api/services/agentic-interface-contract.test.ts`
  - `api/services/widget-agentic-manifest.test.ts`
- Docs:
  - `docs/WIDGET_CONTRACTS.md`
  - `docs/AGENTIC_WIDGET_AUTHORING.md`
  - this roadmap, if decisions shift

Acceptance:

- Existing widget manifests validate unchanged.
- Type exports are available to desktop and API code.
- A minimal generated interface spec can express a metric, table, action bar,
  and embedded widget.
- Contract validation rejects unknown component kinds, unsafe binding modes, and
  missing required ids.

Verification:

- `cd api && npm run typecheck`
- `cd desktop && npm run typecheck`
- Targeted Deno tests for the contract shape.

## PR 12: Command Interface Planner API

Purpose:

- Add the backend planner that turns a natural-language command into a draft
  `AgenticInterfaceSpec`.
- Feed the planner the installed widget/card/function/context inventory.
- Expose the operation through Command.

Simple explanation:

This is the first "make me an interface" API. It does not execute writes. It
plans a useful workspace from what the user already has installed.

Recommended scope:

- Extend `ul.command` with `action: "interface"`.
- Planner input:
  - prompt/query
  - optional app scope
  - optional desired mode: temporary/saveable
  - optional max components
  - optional include data preview flag
- Planner context:
  - command surface inventory
  - function index descriptors
  - context source inventory
  - existing saved dashboards
  - small D1 previews only when safe and budgeted
- Planner output:
  - raw draft spec
  - normalized spec if PR 13 lands in the same branch, otherwise a best-effort
    draft plus warnings
  - explanation/rationale for user confirmation

Expected files:

- New: `api/services/agentic-interface-planner.ts`
- New: `api/services/agentic-interface-prompts.ts`
- Modify: `api/services/command-surfaces.ts`
- Modify: `api/services/function-index.ts`
- Modify: `api/services/codemode-tools.ts`
- Modify: `api/services/app-context-magnifier.ts`
- Modify: `api/handlers/platform-mcp.ts`
- Modify: `desktop/src/hooks/useMcp.ts`
- Modify: `desktop/src/lib/api.ts`
- Tests:
  - `api/services/agentic-interface-planner.test.ts`
  - `api/services/command-surfaces.test.ts`

Acceptance:

- `ul.command({ action: "interface", prompt })` returns a draft interface spec.
- The planner can use installed command cards and MCP functions.
- The planner never returns raw HTML, React, CSS, or DOM selectors.
- The returned result includes rationale and warnings.
- No interface is persisted by this PR.

Verification:

- API typecheck.
- Unit test with fixture function index containing Email Ops and Study Coach.
- Manual MCP smoke: ask for an interface for "email approvals" and inspect the
  returned JSON.

## PR 13: Spec Verifier And Normalizer

Purpose:

- Make generated specs trustworthy before the desktop renders them.
- Remove hallucinated references and enforce permission boundaries.

Simple explanation:

The planner is allowed to be creative. The verifier is the bouncer. If an action,
data source, widget, card, or app does not really exist or is not allowed, it is
dropped or downgraded with a warning.

Recommended scope:

- Validate every component id is stable and unique.
- Validate every binding references installed/allowed capabilities.
- Require writes to use `mcp_function` or `widget_action`.
- Require write actions to carry a confirmation policy unless explicitly safe.
- Cap component count, data preview size, and action count.
- Normalize labels, component sizes, component ordering, and default selections.
- Return `warnings[]` and `dropped[]` with enough detail to explain what changed.

Expected files:

- New: `api/services/agentic-interface-validate.ts`
- New: `api/services/agentic-interface-normalize.ts` if kept separate
- Modify: `api/services/agentic-interface-planner.ts`
- Modify: `api/services/command-surfaces.ts`
- Modify: `api/handlers/platform-mcp.ts`
- Modify: `shared/contracts/agentic-interface.ts`
- Tests:
  - `api/services/agentic-interface-validate.test.ts`
  - `api/services/agentic-interface-planner.test.ts`

Acceptance:

- Invalid card/widget/function/context references are rejected or dropped.
- Read bindings cannot call write-like MCP functions.
- Write bindings require confirmation by default.
- The verifier produces a renderable spec or a clear no-op result.
- `ul.command action="interface"` always returns a verified spec, not the raw
  model draft.

Verification:

- API typecheck.
- Tests for hallucinated app ids, missing functions, unsafe write bindings,
  oversized specs, and context source permission failures.

## PR 14: Desktop Generated Interface Renderer

Purpose:

- Render verified `AgenticInterfaceSpec` objects as platform-native UI.
- Add the Command UI entry point for generating a temporary interface.

Simple explanation:

This PR is where the JSON plan becomes a usable workspace. The first renderer
should feel utilitarian: clear cards, tables, details, forms, and actions.

Recommended scope:

- Add a Command composer on the homescreen for "make an interface for...".
- Render generated specs in a dedicated Command workspace area.
- Implement V1 primitives:
  - metric
  - list
  - table
  - detail
  - form
  - action bar
  - timeline
  - existing command card reference
  - widget embed/open affordance
- Keep components clickable and keyboard accessible.
- Do not persist generated specs yet.
- Show verifier warnings in a compact inspectable panel, not as noisy hero copy.

Expected files:

- New: `desktop/src/components/command/CommandComposer.tsx`
- New: `desktop/src/components/agentic/GeneratedInterface.tsx`
- New: `desktop/src/components/agentic/AgenticInterfaceHost.tsx`
- New: `desktop/src/components/agentic/AgenticInterfaceMetric.tsx`
- New: `desktop/src/components/agentic/AgenticInterfaceList.tsx`
- New: `desktop/src/components/agentic/AgenticInterfaceTable.tsx`
- New: `desktop/src/components/agentic/AgenticInterfaceDetail.tsx`
- New: `desktop/src/components/agentic/AgenticInterfaceForm.tsx`
- New: `desktop/src/components/agentic/AgenticInterfaceActionBar.tsx`
- New: `desktop/src/components/agentic/AgenticInterfaceTimeline.tsx`
- New: `desktop/src/components/agentic/AgenticInterfaceCardRef.tsx`
- New: `desktop/src/components/agentic/AgenticInterfaceWidgetEmbed.tsx`
- Modify: `desktop/src/components/CommandHomescreen.tsx`
- Modify: `desktop/src/lib/api.ts`
- Modify: `desktop/src/types` if local type barrels exist
- Tests:
  - `desktop/src/components/agentic/GeneratedInterface.test.tsx`
  - `desktop/src/components/CommandHomescreen.test.tsx` if present or added

Acceptance:

- User can ask Command to generate a temporary interface.
- The UI renders at least one component from each supported primitive kind in
  fixture tests.
- Existing Command dashboard cards still work.
- Existing widget windows still work.
- No generated UI uses arbitrary model-supplied HTML.

Verification:

- `cd desktop && npm run typecheck`
- Desktop unit/component tests.
- Manual smoke: generate interfaces for Email Ops and Study Coach.

## PR 15: Generated Surface Registry Integration

Purpose:

- Make generated interfaces first-class active surfaces.
- Let the agent see and reason over the generated workspace after it is shown.

Simple explanation:

If the interface is visible but invisible to the agent, it is just a dashboard.
This PR makes it a live surface: selected rows, visible components, enabled
actions, and recent events flow back into active context.

Recommended scope:

- Extend the surface model beyond widget iframe assumptions.
- Prefer a small union:
  - widget surface source
  - generated interface surface source
- Reuse `ActiveWidgetContext` initially if that is the least disruptive, but
  name new code toward `ActiveAgenticSurface` so a later rename is easy.
- Generated renderer reports:
  - visible components
  - visible data refs
  - selected entities
  - pending form edits
  - enabled actions
  - stale/loading/errors
  - recent events
- Flash context formatter should describe generated interfaces clearly.

Expected files:

- Modify: `shared/contracts/widget.ts`
- Modify: `shared/contracts/agentic-interface.ts`
- Modify: `desktop/src/lib/widgetAgentTypes.ts`
- Modify: `desktop/src/lib/widgetSurfaceRegistry.ts`
- Modify: `desktop/src/lib/widgetSurfaceRegistry.test.ts`
- Modify: `desktop/src/components/agentic/AgenticInterfaceHost.tsx`
- Modify: `desktop/src/components/agentic/GeneratedInterface.tsx`
- Modify: `api/services/flash-broker.ts`
- Modify: `api/services/chat-capture.ts`
- Modify: `api/services/flash-finetune-metadata.ts`
- Tests:
  - `api/services/flash-broker-telemetry.test.ts`
  - `api/services/flash-finetune-metadata.test.ts`

Acceptance:

- A generated interface registers and unregisters as an active surface.
- Selecting a row updates active context.
- Editing a form updates pending edits.
- Running or failing an action appends a surface event.
- Widget surfaces still behave unchanged.

Verification:

- API and desktop typechecks.
- Widget surface registry tests cover both widget and generated surface sources.
- Manual smoke: generate a table interface, select a row, ask the composer about
  "this selected item," and confirm Flash receives the selected entity.

## PR 16: Data Binding And Refresh Runtime

Purpose:

- Load live data for generated interface components.
- Refresh data after actions or on demand.

Simple explanation:

The renderer should not directly know how to query D1 or MCPs. Components ask
for binding ids; the server resolves those bindings safely.

Recommended scope:

- Add a server data resolver for interface bindings.
- Supported V1 binding sources:
  - `command_card`: call existing widget data function with card id/data view.
  - `context_source`: run declared D1 table/query magnification with user scope.
  - `mcp_read_function`: call allowed read-like function.
  - `literal`: static planner-provided data for labels/help text only.
- Desktop hook fetches binding data by spec id/component id.
- Data resolver returns normalized rows/records/metrics where possible plus raw
  payload in a capped debug field.
- Refresh can target one binding or all bindings.

Expected files:

- New: `api/services/agentic-interface-data.ts`
- New: `api/services/agentic-interface-data.test.ts`
- Modify: `api/services/app-context-magnifier.ts`
- Modify: `api/services/command-surfaces.ts`
- Modify: `api/services/codemode-tools.ts`
- Modify: `api/handlers/user.ts`
- Modify: `api/handlers/platform-mcp.ts`
- Modify: `desktop/src/lib/api.ts`
- New: `desktop/src/components/agentic/useAgenticInterfaceData.ts`
- Modify: `desktop/src/components/agentic/GeneratedInterface.tsx`
- Modify: `desktop/src/components/agentic/AgenticInterfaceTable.tsx`
- Modify: `desktop/src/components/agentic/AgenticInterfaceDetail.tsx`
- Modify: `desktop/src/components/agentic/AgenticInterfaceMetric.tsx`
- Modify: `desktop/src/components/agentic/AgenticInterfaceList.tsx`

Acceptance:

- Generated components render live data from at least command cards and declared
  context sources.
- Refresh buttons reload only the relevant binding.
- Context source reads remain SELECT-only, user-scoped, row-capped, char-capped,
  and redacted.
- Data errors render in component-local error states and active context.

Verification:

- API typecheck and data resolver tests.
- Desktop typecheck.
- Manual smoke: generated Email Ops interface shows live queue data and refreshes.

## PR 17: Action Execution And Permission Gates

Purpose:

- Let generated forms/buttons execute allowed actions.
- Keep writes auditable, confirmable, and routed through app-owned logic.

Simple explanation:

This PR makes generated interfaces operational. The key safety rule stays simple:
buttons do not write to D1; they call MCP functions or semantic actions that the
app owns.

Recommended scope:

- Add an action executor for generated interface actions.
- Support:
  - `mcp_function`
  - `widget_action` when the target widget surface is active
  - `open_widget`
  - `refresh_binding`
  - `select_entity`
- Confirmation policy:
  - read/UI actions can be `none`
  - write actions default to `user`
  - high-risk actions use `high_risk`
- Add audit metadata for generated surfaces.
- Prefer additive generic audit fields rather than overloading widget-only names
  forever. Keep widget fields backward compatible.

Expected files:

- New: `api/services/agentic-interface-actions.ts`
- New: `api/services/agentic-interface-actions.test.ts`
- Modify: `api/handlers/user.ts`
- Modify: `api/handlers/platform-mcp.ts`
- Modify: `api/handlers/mcp.ts`
- Modify: `api/services/call-logger.ts`
- Modify: `api/services/call-logger.test.ts`
- Modify: `api/services/call-receipts.ts`
- Modify: `api/services/invocation-telemetry.ts`
- Modify: `api/services/invocation-telemetry.test.ts`
- New migration:
  - `supabase/migrations/*_agentic_surface_action_audit.sql`
- Modify: `desktop/src/lib/api.ts`
- Modify: `desktop/src/components/agentic/AgenticInterfaceActionBar.tsx`
- Modify: `desktop/src/components/agentic/AgenticInterfaceForm.tsx`
- Modify: `desktop/src/components/agentic/AgenticInterfaceHost.tsx`
- Modify: `desktop/src/lib/widgetSurfaceRegistry.ts`

Acceptance:

- Read/UI actions execute without unnecessary confirmation.
- Write actions require confirmation by default.
- MCP calls from generated interface actions include surface/action/turn metadata.
- Action results update the visible component state and event log.
- Failed actions are visible to the user and included in active context.

Verification:

- API typecheck and action executor tests.
- Desktop typecheck and action component tests.
- Manual safety smoke: try a generated send/delete/update action and confirm the
  prompt appears before execution.

## PR 18: Saveable Generated Interfaces

Purpose:

- Let users save useful generated interfaces as durable Command workspaces.
- Keep saved generated specs separate from existing card-only dashboard layouts
  until a later unification is warranted.

Simple explanation:

Temporary is the Jarvis feel. Saved is the product loop. This PR adds "keep
this" without breaking existing Command dashboard storage.

Recommendation:

Create a new `user_agentic_interfaces` table for generated specs. Do not force
`user_command_dashboard_layouts` to hold richer generated specs yet; that table
is cleanly card-layout shaped today.

Recommended scope:

- Save normalized verified specs only, never raw planner output.
- Store:
  - user id
  - interface key
  - title/description/icon
  - normalized spec JSON
  - source prompt
  - mode/status
  - created/updated/deleted timestamps
- Add list/get/create/update/delete endpoints.
- Add Command actions:
  - `save_interface`
  - `list_interfaces`
  - `get_interface`
  - `delete_interface`
- Desktop can load saved interfaces from Command.

Expected files:

- New migration:
  - `supabase/migrations/*_agentic_interface_storage.sql`
- New: `api/services/agentic-interface-storage.ts`
- New: `api/services/agentic-interface-storage.test.ts`
- Modify: `api/handlers/user.ts`
- Modify: `api/handlers/platform-mcp.ts`
- Modify: `desktop/src/lib/api.ts`
- New: `desktop/src/components/agentic/AgenticInterfaceLibrary.tsx`
- Modify: `desktop/src/components/agentic/AgenticInterfaceHost.tsx`
- Modify: `desktop/src/components/CommandHomescreen.tsx`
- Modify: `docs/WIDGET_CONTRACTS.md`

Acceptance:

- User can save a generated temporary interface.
- User can list and reopen saved interfaces.
- Saved spec is re-verified on load against current installed capabilities.
- Missing apps/functions render warnings instead of breaking the workspace.
- Existing command dashboard cards remain unaffected.

Verification:

- API typecheck and storage tests.
- Desktop typecheck.
- Manual smoke: generate, save, reload app, reopen saved interface.

## PR 19: Developer Generation Hints

Status: implemented in this session.

Purpose:

- Let MCP/widget authors improve generated interface quality without requiring
  fully custom generated views.

Simple explanation:

The baseline generator should work from existing metadata. Hints make it smarter:
"this action belongs near this table," "this card is useful for approval flows,"
or "this function is read-only and good for detail panels."

Recommended scope:

- Add optional manifest hints:
  - widget/card generation tags
  - preferred component kind
  - entity types produced
  - action grouping
  - safe default filters
  - suggested companion components
  - prompt examples
- Index hints into `FunctionIndex`.
- Include hints in planner context.
- Add reference hints to Email Ops and Study Coach.

Expected files:

- Modify: `shared/contracts/widget.ts`
- Modify: `shared/contracts/manifest.ts`
- Modify: `shared/types/index.ts`
- Modify: `api/services/codemode-tools.ts`
- Modify: `api/services/function-index.ts`
- Modify: `api/services/command-surfaces.ts`
- Modify: `api/services/agentic-interface-planner.ts`
- Modify: `api/services/agentic-interface-prompts.ts`
- Modify: `api/services/widget-agentic-manifest.test.ts`
- Modify: `api/services/app-manifest-generation.test.ts`
- Modify: `api/services/command-surfaces.test.ts`
- Modify: `api/services/agentic-interface-planner.test.ts`
- Modify: `apps/mcps/email-ops/manifest.json`
- Modify: `apps/mcps/study-coach/manifest.json`
- Modify: generated `packages/types` declarations
- Docs:
  - `docs/AGENTIC_WIDGET_AUTHORING.md`
  - `docs/WIDGET_CONTRACTS.md`

Acceptance:

- Existing manifests validate unchanged.
- Apps can add hints without making generated interfaces mandatory.
- Planner uses hints when present and falls back cleanly when absent.
- Reference apps produce better planner output with hints enabled.

Verification:

- API typecheck.
- Manifest validation tests.
- Planner fixture comparing hinted vs. unhinted inventory.

## PR 20: Evaluation And Smoke Harness

Status: implemented in this session.

Purpose:

- Make interface generation reliable enough to iterate on.
- Catch hallucinated references, unsafe actions, broken rendering, stale data
  bindings, and regressions across the widget spine.

Simple explanation:

This is the seatbelt PR. Once interfaces are generated, we need repeatable
questions that prove the result is valid and useful.

Recommended scope:

- Add fixture inventories for:
  - Email Ops only
  - Study Coach only
  - mixed Email Ops + Study Coach
  - no matching app
  - missing/uninstalled app after saved interface load
- Add expected assertions:
  - no unknown component kinds
  - no unknown app/function/card/context ids
  - no raw HTML
  - writes require confirmation
  - generated spec can render
  - generated surface creates active context
  - refresh and action events are logged
- Add a manual smoke checklist to docs.

Expected files:

- New: `api/services/agentic-interface-fixtures.test.ts`
- Modify: `api/services/agentic-interface-planner.test.ts`
- Modify: `api/services/agentic-interface-validate.test.ts`
- Modify: `api/services/agentic-interface-data.test.ts`
- Modify: `api/services/agentic-interface-actions.test.ts`
- Modify: `desktop/src/components/agentic/GeneratedInterface.test.tsx`
- Modify: `desktop/src/lib/widgetSurfaceRegistry.test.ts`
- New: `docs/AGENTIC_INTERFACE_SMOKE_TESTS.md`
- Optional new script:
  - `scripts/smoke-agentic-interface.ts`
  - Deferred; the automated fixture tests plus manual smoke checklist cover this
    PR's acceptance path.

Acceptance:

- Fixture prompts produce verified renderable specs.
- Saved specs can be re-verified against changed inventory.
- Desktop renderer does not crash on missing data/action bindings.
- Manual smoke checklist covers generate, inspect, refresh, act, save, reopen,
  and ask follow-up from active context.

Verification:

- `cd api && npm run test -- agentic-interface`
- `cd desktop && npm test -- GeneratedInterface widgetSurfaceRegistry`
- Manual smoke checklist.

## Cross-PR File Impact Map

Shared contracts:

- `shared/contracts/agentic-interface.ts` - new typed spec and component/action
  contracts.
- `shared/contracts/widget.ts` - active surface kind and reused state/action/data
  references.
- `shared/contracts/manifest.ts` - optional generation hints and validation.
- `shared/types/index.ts` - generated/shared public type exports.

API services:

- `api/services/agentic-interface-planner.ts` - new planner.
- `api/services/agentic-interface-prompts.ts` - planner prompt/context builder.
- `api/services/agentic-interface-validate.ts` - verifier.
- `api/services/agentic-interface-normalize.ts` - optional separate normalizer.
- `api/services/agentic-interface-data.ts` - data binding resolver.
- `api/services/agentic-interface-actions.ts` - action executor.
- `api/services/agentic-interface-storage.ts` - saved interface persistence.
- `api/services/command-surfaces.ts` - richer inventory and planner input.
- `api/services/command-dashboard.ts` - likely unchanged until save/unify work,
  but nearby and relevant.
- `api/services/function-index.ts` - index generation hints and richer metadata.
- `api/services/codemode-tools.ts` - extract hints/context/actions into index.
- `api/services/app-context-magnifier.ts` - support data previews and binding
  reads.
- `api/services/flash-broker.ts` - include generated active surfaces in context.
- `api/services/chat-capture.ts` - summarize generated active contexts.
- `api/services/flash-finetune-metadata.ts` - telemetry labels for generated
  interfaces.
- `api/services/call-logger.ts` - generated surface/action audit metadata.
- `api/services/call-receipts.ts` - receipt display for generated actions.
- `api/services/invocation-telemetry.ts` - invocation metadata.

API handlers:

- `api/handlers/platform-mcp.ts` - `ul.command` action schema and execution.
- `api/handlers/user.ts` - desktop REST endpoints for generating, loading,
  saving, data refresh, and action execution.
- `api/handlers/chat.ts` - likely only if active surface request shape changes.
- `api/handlers/mcp.ts` - action metadata passthrough/audit.

Desktop:

- `desktop/src/hooks/useMcp.ts` - add Command action schema.
- `desktop/src/lib/api.ts` - client calls and exported types.
- `desktop/src/lib/widgetAgentTypes.ts` - generated surface source/context
  support.
- `desktop/src/lib/widgetSurfaceRegistry.ts` - register/generated action/event
  support.
- `desktop/src/components/CommandHomescreen.tsx` - Command composer, generated
  workspace, saved interface library entry points.
- `desktop/src/components/command/CommandComposer.tsx` - new global Command
  interface composer.
- `desktop/src/components/agentic/*` - new generated interface renderer and
  component primitives.
- `desktop/src/components/dashboard/WidgetPickerModal.tsx` - likely later hint
  display only, not required for core generation.
- `desktop/src/components/widgets/WidgetComposer.tsx` - only if generated
  surfaces share the same composer UX or action picker.
- `desktop/src/components/widgets/WidgetEventLog.tsx` - optionally generalized
  from widget event log to surface event log.

Database:

- `supabase/migrations/*_agentic_surface_action_audit.sql` - optional generic
  action audit fields.
- `supabase/migrations/*_agentic_interface_storage.sql` - saved generated
  interface table.
- Existing nearby migrations:
  - `supabase/migrations/20260508120000_command_dashboard_runtime.sql`
  - `supabase/migrations/20260523170000_widget_action_audit.sql`

First-party reference apps:

- `apps/mcps/email-ops/manifest.json`
- `apps/mcps/email-ops/index.ts`
- `apps/mcps/study-coach/manifest.json`
- `apps/mcps/study-coach/index.ts`

Docs:

- `docs/WIDGET_CONTRACTS.md`
- `docs/AGENTIC_WIDGET_AUTHORING.md`
- `docs/AGENTIC_INTERFACE_SMOKE_TESTS.md`
- `docs/AGENTIC_INTERFACE_GENERATION_PR_ROADMAP.md`

## Suggested Implementation Order

1. PR 11 first, because every later PR needs stable spec types.
2. PR 12 and PR 13 should be close together. A planner without a verifier is
   useful for development but not product-safe.
3. PR 14 should render temporary verified specs before any persistence exists.
4. PR 15 should follow immediately so generated interfaces become active
   context, not just visual dashboards.
5. PR 16 and PR 17 make the renderer live: data first, then writes/actions.
6. PR 18 adds save/reopen after temporary generation is useful.
7. PR 19 improves developer leverage without blocking the baseline.
8. PR 20 hardens the whole stack with repeatable evaluations.

## First Slice Recommendation

If we want the smallest impressive demo:

1. Implement PR 11 contracts.
2. Implement PR 12/13 enough for a planner to produce a verified spec using
   existing command cards and MCP read functions.
3. Implement PR 14 renderer for metric, table, action bar, and widget embed.
4. Implement PR 15 active context for generated interfaces.

That gives the first real Jarvis-shaped loop:

```text
User: "Make me an interface for pending email approvals."
Command: generates a live approval workspace.
User: "Open the risky ones and show the draft editor."
Agent: understands the generated surface and operates semantic actions.
```

The later PRs make that durable, safer, richer, and more reliable.
