# Agentic Widgets PR Roadmap

Last reviewed: `2026-05-23`

Agentic widgets make every widget a live software surface that can still be
clicked and typed into by a human, while optionally exposing semantic state,
searchable read context, and safe actions to the composer/agent loop.

The product goal is not to replace custom widget UIs with a platform component
system. The goal is to let developers keep building arbitrary rich clickable
widgets, then progressively opt into agentic control by publishing the semantic
handles the platform needs.

## Locked Product Decisions

- Widgets remain arbitrary clickable HTML/JS surfaces. Agentic behavior is a
  progressive enhancement, not a requirement for existing widgets.
- Widget composers live in platform chrome around the widget, not inside the
  iframe. This keeps model routing, scope, voice input, tool insertion, safety,
  and permissions consistent.
- The default widget composer scope is narrow: active widget context, the
  underlying MCP/app, widget-relevant D1/app read context, recent widget event
  history, and app-declared actions.
- The context index can search app D1 data for read grounding after the app/user
  has granted that capability. Writes still flow through MCP functions or
  widget-declared semantic actions.
- Agentic control should use semantic actions, not brittle DOM selectors.
  Widget DOM automation may be useful for tests/debugging, but it should not be
  the platform contract.
- Every agent-triggered action records a widget event with inputs, result,
  errors, and the resulting visible state/snapshot when available.
- Voice is an input medium for the same composer/orchestrator path. It should
  not become a separate action plane.

## Current State

Today widgets can already be rich UI surfaces. The runtime loads widget HTML,
injects `ulAction`, renders the widget in an iframe, and supports
widget-to-widget navigation:

- [shared/contracts/widget.ts](../shared/contracts/widget.ts)
- [shared/contracts/manifest.ts](../shared/contracts/manifest.ts)
- [desktop/src/lib/widgetRuntime.ts](../desktop/src/lib/widgetRuntime.ts)
- [desktop/src/components/InChatWidget.tsx](../desktop/src/components/InChatWidget.tsx)
- [desktop/src/components/WidgetWindow.tsx](../desktop/src/components/WidgetWindow.tsx)
- [desktop/src/lib/multiWindow.ts](../desktop/src/lib/multiWindow.ts)

The gap is that open widgets are not yet agentic surfaces. The agent does not
receive a live widget state snapshot, visible component list, selected entity,
pending edit state, UI action registry, or widget-local event history. The
orchestrator request has `scope` and `projectContext`, but no active widget
context:

- [desktop/src/lib/api.ts](../desktop/src/lib/api.ts)
- [desktop/src/components/ChatView.tsx](../desktop/src/components/ChatView.tsx)
- [api/services/orchestrator.ts](../api/services/orchestrator.ts)
- [api/services/flash-broker.ts](../api/services/flash-broker.ts)

The server already magnifies app D1 data for regular chats in
[api/services/flash-broker.ts](../api/services/flash-broker.ts). That behavior
should become available to widget composers through a permissioned, scoped app
data context source instead of raw write access.

## Target Architecture

```
Widget iframe
  custom clickable UI
  ulAction(...)
  ulOpenWidget(...)
  ulWidget.reportState(...)
  ulWidget.registerAction(...)
        |
        v
Desktop widget surface registry
  active surface id
  current snapshot
  visible component metadata
  enabled semantic actions
  recent event history
  latest widget data payload
        |
        v
Widget composer
  default scope = active widget + app + D1 read context + actions
  quick insert = functions/tools/context sources from index
        |
        v
/chat/orchestrate
  activeWidgetContexts[]
  scope narrowed to active app by default
        |
        v
Flash/codemode
  D1 read-context magnification
  MCP-backed write actions
  optional client-side widget action directives
        |
        v
Widget refresh/update/log
```

## Core Contract Shape

Prefer a hybrid contract. Manifest metadata gives static discoverability; the
runtime bridge gives live precision.

Manifest-level additions:

```ts
widgets: [{
  id: "email_inbox",
  label: "Email Approvals",
  agentic: true,
  context_function: "widget_email_inbox_context",
  actions_function: "widget_email_inbox_actions",
  context_sources: ["email_conversations"],
  agent_actions: [...]
}]

context_sources: [{
  id: "email_conversations",
  label: "Email conversations",
  type: "d1_table" | "d1_query" | "function",
  access: "read",
  searchable: true,
  default_for_widgets: ["email_inbox"],
  tables?: ["conversations", "drafts"],
  function?: "search_conversations_context",
  redactions?: [...]
}]
```

Runtime bridge additions:

```ts
ulWidget.reportState(() => snapshot)
ulWidget.registerAction(actionDeclaration, handler)
ulWidget.logEvent(event)
ulWidget.refreshContext()
```

Snapshot shape should be semantic and compact:

```ts
{
  surfaceId,
  appId,
  appSlug,
  widgetId,
  title,
  currentView,
  visibleComponents,
  visibleDataRefs,
  selectedEntities,
  pendingEdits,
  enabledActions,
  errors,
  updatedAt
}
```

Action shape should be safe to put in model context:

```ts
{
  id,
  label,
  description,
  argsSchema,
  mode: "read" | "write" | "ui",
  confirmation: "none" | "user" | "high_risk",
  mcp?: { function: "conversation_act", argsTemplate: {...} },
  expectedResult
}
```

## Affected File Map

### Shared Contracts

- [shared/contracts/widget.ts](../shared/contracts/widget.ts)
  - Add `WidgetAgenticDeclaration`, `WidgetContextSourceRef`,
    `WidgetActionDeclaration`, `WidgetActionMode`,
    `WidgetConfirmationPolicy`, `WidgetStateSnapshot`,
    `WidgetVisibleComponent`, `WidgetSurfaceEvent`,
    `WidgetActionInvocation`, and `WidgetActionResult`.
  - Keep existing `WidgetDeclaration`, `CommandCardDeclaration`, and legacy
    `WidgetAction` shapes backward-compatible.

- [shared/contracts/manifest.ts](../shared/contracts/manifest.ts)
  - Validate `widgets[].agentic`, `widgets[].context_function`,
    `widgets[].actions_function`, `widgets[].context_sources`,
    `widgets[].agent_actions`.
  - Validate root `context_sources[]` for read-only D1/function magnification.
  - Warn when a widget declares agentic mode but no context/action source.

- Optional new file:
  - `shared/contracts/widget-agent.ts`
  - Use this if `widget.ts` becomes too large. Re-export from `widget.ts` or
    `shared/types/index.ts` during migration.

- [packages/types](../packages/types)
  - Export new public widget-agent contracts after the canonical shared
    contract lands.

### Desktop Widget Runtime

- [desktop/src/lib/widgetRuntime.ts](../desktop/src/lib/widgetRuntime.ts)
  - Extend the injected bridge with `window.ulWidget`.
  - Support iframe-to-parent messages:
    - `ul-widget-state`
    - `ul-widget-actions`
    - `ul-widget-event`
    - `ul-widget-action-result`
  - Support parent-to-iframe messages:
    - `ul-widget-command`
    - `ul-widget-refresh-context`
  - Keep `ulAction`, `ulOpenWidget`, and resize behavior unchanged.

- New file: `desktop/src/lib/widgetSurfaceRegistry.ts`
  - Central in-memory registry of active widget surfaces.
  - Tracks surface id, source, launch context, latest snapshot, action registry,
    latest widget data payload, recent event ring buffer, and freshness.
  - Uses `BroadcastChannel` where available so standalone widget windows and
    main chat can share surface context, with `localStorage` event fallback.

- New file: `desktop/src/lib/widgetAgentTypes.ts`
  - Desktop-facing narrowed types for active surfaces and composer payloads.
  - Imports shared contracts and adds client-only fields such as iframe/window
    channel ids.

- [desktop/src/components/InChatWidget.tsx](../desktop/src/components/InChatWidget.tsx)
  - Register/deregister inline widget surfaces.
  - Forward bridge state/action/event messages into the surface registry.
  - Include a generated `surfaceId` in `buildWidgetSrcDoc`.
  - Handle widget command messages when an inline widget is the target.

- [desktop/src/components/WidgetWindow.tsx](../desktop/src/components/WidgetWindow.tsx)
  - Register standalone widget windows as active surfaces.
  - Add platform chrome for widget-local composer.
  - Forward state/action/event bridge messages into the registry.
  - Send refresh/command messages back into the iframe after agent actions.

- [desktop/src/lib/multiWindow.ts](../desktop/src/lib/multiWindow.ts)
  - Pass stable `surfaceId` or parent correlation id when opening widget
    windows.
  - Preserve context query params for existing widgets.

- [desktop/src/lib/widgetRuntime.test.ts](../desktop/src/lib/widgetRuntime.test.ts)
  - Cover bridge script generation for `ulWidget`, state/action messages,
    parent commands, and backward compatibility.

### Desktop Composer And Context Index

- New file: `desktop/src/components/widgets/WidgetComposer.tsx`
  - Native composer attached to widget windows and optionally inline widgets.
  - Reuses `ChatInput` affordances where practical, but keeps a widget-specific
    scope preview and active-surface target.

- [desktop/src/components/ChatInput.tsx](../desktop/src/components/ChatInput.tsx)
  - Extract reusable composer primitives if needed:
    `ComposerShell`, `ComposerTextarea`, model picker, attachment controls,
    and quick-insert tool/context controls.
  - Do not add voice in the first spine PR unless the composer extraction makes
    it trivial.

- [desktop/src/components/composer/ToolSelectionPopover.tsx](../desktop/src/components/composer/ToolSelectionPopover.tsx)
  - Allow a scoped function/context index mode.
  - Show active widget actions, underlying MCP functions, and app context
    sources before global tools.

- [desktop/src/lib/api.ts](../desktop/src/lib/api.ts)
  - Add `ActiveWidgetContext`/`WidgetComposerContext` request types.
  - Add `activeWidgetContexts?: ActiveWidgetContext[]` to
    `streamOrchestrate`.
  - Extend `FunctionIndex` with `contextSources` and agentic widget metadata.

- [desktop/src/components/ChatView.tsx](../desktop/src/components/ChatView.tsx)
  - For global chat, include active widgets only when the user explicitly
    references them or inserts them into scope.
  - For widget composer turns, call `streamOrchestrate` with active widget
    context and default scope narrowed to the widget app.
  - Handle streamed widget action directives if PR4 adds client-side widget
    commands.

### Desktop Command/Dashboard Surfaces

- [desktop/src/components/CommandHomescreen.tsx](../desktop/src/components/CommandHomescreen.tsx)
  - Register visible command cards as read-only surface context.
  - Let the widget composer know which card opened the full widget.

- [desktop/src/components/dashboard/WidgetPickerModal.tsx](../desktop/src/components/dashboard/WidgetPickerModal.tsx)
  - Optionally show which cards/widgets expose agentic context/actions.

### Server Function Index And Context Sources

- [api/services/codemode-tools.ts](../api/services/codemode-tools.ts)
  - Extend `WidgetIndexEntry` with agentic metadata:
    `agentic`, `contextFunction`, `actionsFunction`, `contextSources`,
    `agentActions`.
  - Continue skipping widget UI/data internals by default.
  - Only expose widget data/action functions to codemode when explicitly
    declared as agent-safe.

- [api/services/function-index.ts](../api/services/function-index.ts)
  - Index root `context_sources[]` and widget-level context source references.
  - Persist `contextSources` beside `functions`, `widgets`, `routines`, and
    `types`.
  - Include D1 availability and app slug/id mapping needed for scoped
    magnification.

- [desktop/src/lib/api.ts](../desktop/src/lib/api.ts)
  - Mirror `FunctionIndex.contextSources` for desktop cache consumers.

### Server Orchestration

- [api/services/orchestrator.ts](../api/services/orchestrator.ts)
  - Add `activeWidgetContexts?: ActiveWidgetContext[]` to
    `OrchestrateRequest`.
  - Pass widget context into `runFlashBroker`.
  - Add SSE events for widget action planning/execution if client-side widget
    commands are introduced:
    - `widget_action_request`
    - `widget_action_result`
    - `widget_context_refresh`

- [api/services/flash-broker.ts](../api/services/flash-broker.ts)
  - Add active widget context to broker analysis and final prompt.
  - Default scope to the active widget app for widget composer turns.
  - Magnify D1/app data using the widget/app context source declarations and
    the user's natural-language query.
  - Include only semantic snapshots and recent event summaries, not raw DOM.

- New file: `api/services/app-context-magnifier.ts`
  - Extract current D1 magnification from `flash-broker.ts`.
  - Add context-source filtering, table/query/function strategies, redactions,
    SELECT-only enforcement, row/char budgets, and audit metadata.
  - Reuse this for regular chat and widget composer magnification.

- [api/handlers/platform-mcp.ts](../api/handlers/platform-mcp.ts)
  - Add a platform primitive such as `ul.widget`:
    - `inventory`
    - `inspect`
    - `plan`
    - `invoke`
    - `refresh`
  - In the first server-only version, `invoke` should resolve MCP-backed
    actions and return structured results.
  - In the later client-command version, `invoke` can emit a client action
    directive for UI-only actions.

- [api/handlers/mcp.ts](../api/handlers/mcp.ts)
  - Thread `_widget_surface_id`, `_widget_action_id`,
    `_widget_agentic_turn_id`, and `_widget_pull_reason` through MCP call
    metadata for traces, billing, and event history.

### D1 Permissioning And Persistence

- New Supabase migration, if persistent user toggles are required:
  - `user_app_context_permissions`
  - Fields: `user_id`, `app_id`, `context_source_id`, `enabled`,
    `granted_at`, `revoked_at`.

- Alternative MVP:
  - Treat installed app + manifest-declared `context_sources[].searchable=true`
    as read-context permission.
  - Add explicit per-widget/user toggles in a later privacy PR.

- [api/services/d1-provisioning.ts](../api/services/d1-provisioning.ts)
  - Reuse existing database id resolution for context magnification.

- [api/src/bindings/database-binding.ts](../api/src/bindings/database-binding.ts)
  - No first-spine change expected unless the context magnifier is moved into a
    Worker binding later.

### First-Party App Upgrades

- [apps/mcps/email-ops/manifest.json](../apps/mcps/email-ops/manifest.json)
  - Add first reference agentic widget declaration for `email_inbox`.
  - Add read context source(s) for conversations/drafts.
  - Add MCP-backed actions for refresh, filter, open conversation, regenerate,
    send, discard, and follow-up with confirmation policies.

- [apps/mcps/email-ops/index.ts](../apps/mcps/email-ops/index.ts)
  - Emit live snapshots from `DECK_UI_HTML`.
  - Register live actions with the bridge.
  - Log user clicks and agent actions.
  - Refresh visible state after MCP-backed action results.

- [apps/mcps/study-coach/manifest.json](../apps/mcps/study-coach/manifest.json)
  - Add agentic declarations for `quiz`, `progress`, and `lessons`.

- [apps/mcps/study-coach/index.ts](../apps/mcps/study-coach/index.ts)
  - Add snapshot/action/event bridge usage for a lower-risk second reference app.

### Docs And Developer Experience

- [docs/WIDGET_CONTRACTS.md](./WIDGET_CONTRACTS.md)
  - Add the agentic widget contract after PR1 lands.

- [docs/IN-CHAT-WIDGETS-IMPLEMENTATION.md](./IN-CHAT-WIDGETS-IMPLEMENTATION.md)
  - Update current-state notes once in-chat widgets can register surfaces.

- New docs:
  - `docs/AGENTIC_WIDGET_AUTHORING.md`
  - Shows how to add snapshots, action schemas, D1 context sources, event logs,
    and confirmation policies to an existing clickable widget.

## PR Stack

### PR 1: Shared Agentic Widget Contracts

Purpose:

- Define the static and runtime contracts without changing runtime behavior.
- Keep existing widgets fully compatible.

Expected files:

- `shared/contracts/widget.ts`
- `shared/contracts/manifest.ts`
- `shared/types/index.ts`
- `packages/types/*` if generated public exports are updated
- `docs/WIDGET_CONTRACTS.md`

Acceptance:

- Existing manifests validate unchanged.
- New manifest fields validate with useful warnings/errors.
- Shared types describe snapshots, components, actions, events, and context
  sources.
- No widget UI behavior changes.

Verification:

- `cd api && npm run typecheck`
- targeted manifest validation tests, if present

### PR 2: Desktop Surface Registry And Bridge

Purpose:

- Make open widgets visible to the desktop platform as active surfaces.
- Let widgets report state/actions/events without requiring agent use yet.

Expected files:

- `desktop/src/lib/widgetRuntime.ts`
- `desktop/src/lib/widgetSurfaceRegistry.ts`
- `desktop/src/lib/widgetAgentTypes.ts`
- `desktop/src/components/InChatWidget.tsx`
- `desktop/src/components/WidgetWindow.tsx`
- `desktop/src/lib/multiWindow.ts`
- `desktop/src/lib/widgetRuntime.test.ts`

Acceptance:

- Inline and standalone widgets register active surfaces.
- A widget can call `ulWidget.reportState`, `ulWidget.registerAction`, and
  `ulWidget.logEvent`.
- Main chat/window code can read active surfaces.
- Existing widgets that never call `ulWidget` behave exactly as before.

Verification:

- `cd desktop && npm test -- widgetRuntime`
- manual smoke: open email widget, confirm no regression in clicks/refresh

### PR 3: Widget Composer And Scoped Context Index

Purpose:

- Attach a native composer to widget windows.
- Scope the composer to the active widget/app by default.
- Expose quick-insert tools/functions/context sources from the same function
  index used by regular chat.

Expected files:

- `desktop/src/components/widgets/WidgetComposer.tsx`
- `desktop/src/components/WidgetWindow.tsx`
- `desktop/src/components/ChatInput.tsx`
- `desktop/src/components/composer/ToolSelectionPopover.tsx`
- `desktop/src/lib/api.ts`
- `desktop/src/components/ChatView.tsx`

Acceptance:

- Widget windows show a native composer.
- Widget composer turns send `activeWidgetContexts`.
- Default scope includes the widget app and does not include unrelated apps.
- Tool quick-insert prioritizes widget actions, app MCP functions, and app
  context sources.

Verification:

- Desktop typecheck/build.
- Manual smoke with an existing clickable widget.
- Confirm global chat behavior is unchanged.

### PR 4: Server Active Widget Context In Orchestration

Purpose:

- Let Flash and heavy model reason over active widget state, visible data,
  event history, and app-local functions.

Expected files:

- `shared/contracts/widget.ts`
- `shared/types/index.ts`
- `desktop/src/lib/api.ts`
- `api/handlers/chat.ts`
- `api/services/orchestrator.ts`
- `api/services/flash-broker.ts`
- `api/services/chat-capture.ts`
- `api/services/flash-finetune-metadata.ts`

Acceptance:

- `OrchestrateRequest.activeWidgetContexts` is accepted and passed through.
- Flash prompt includes compact widget context only for relevant turns.
- Widget composer scope magnifies the active app by default.
- Widget internals remain hidden unless explicitly declared agent-safe.
- Capture and Flash telemetry record widget-context counts and compact summaries.

Verification:

- `cd api && npm run typecheck`
- `cd desktop && npm run typecheck`
- unit tests around request parsing and prompt construction where available

### PR 5: Permissioned D1 Context Sources

Purpose:

- Make app D1 data searchable as read context for widget composers and regular
  chat, using declared context sources instead of raw arbitrary access.

Expected files:

- `shared/contracts/manifest.ts`
- `api/services/codemode-tools.ts`
- `api/services/function-index.ts`
- `api/services/app-context-magnifier.ts`
- `api/services/flash-broker.ts`
- `api/services/app-context-magnifier.test.ts`
- `docs/WIDGET_CONTRACTS.md`

Acceptance:

- Apps can declare searchable read context sources.
- Widget composer turns search only the active app/context sources by default.
- Context magnification is SELECT-only, row/char-budgeted, redacted, and
  auditable.
- No write path is added through D1 context sources.
- Function-backed context sources are indexed but not executable until the
  read-only MCP invocation path is audited.

Verification:

- API typecheck.
- Tests for context-source validation, SELECT-only enforcement, redaction, and
  scoped search fallback.

### PR 6: MCP-Backed Semantic Actions

Purpose:

- Allow the agent to invoke widget-declared actions that resolve to MCP
  function calls, then refresh the widget and log the result.

Expected files:

- `shared/contracts/widget.ts`
- `api/services/call-logger.ts`
- `api/services/codemode-tools.ts`
- `api/handlers/platform-mcp.ts`
- `api/handlers/mcp.ts`
- `desktop/src/lib/widgetSurfaceRegistry.ts`
- `desktop/src/lib/widgetRuntime.ts`
- `desktop/src/components/widgets/WidgetComposer.tsx`
- `desktop/src/components/WidgetWindow.tsx`
- `apps/mcps/email-ops/manifest.json`
- `apps/mcps/email-ops/index.ts`

Acceptance:

- Email widget publishes at least one read action and one confirmed write
  action.
- Agent can invoke an MCP-backed action from the widget composer.
- MCP call metadata includes widget surface/action ids.
- Widget refreshes or receives enough result data to update visible state.
- Widget event history records request, result, and error states.

Verification:

- API typecheck.
- Desktop smoke: use composer to refresh/filter/open a conversation.
- Manual safety smoke: sending/discarding requires confirmation policy.

Implementation notes:

- Add awaitable widget action invocation with `turn_id` correlation and
  request/result/error event history.
- Have the runtime bridge annotate MCP calls made during widget action handlers
  with widget surface/action metadata.
- Let the widget composer invoke matching live semantic actions directly while
  keeping ordinary chat routing available for non-action requests.
- Make the email approvals widget publish and handle one read action plus
  confirmed send/discard write actions.

### PR 7: UI-Only Widget Commands

Purpose:

- Let agents command live UI changes that are not backend writes: open panels,
  focus fields, surface custom views, change tabs, or prefill forms.

Expected files:

- `desktop/src/lib/widgetRuntime.ts`
- `desktop/src/lib/widgetSurfaceRegistry.ts`
- `desktop/src/components/InChatWidget.tsx`
- `desktop/src/components/WidgetWindow.tsx`
- `api/services/orchestrator.ts`
- `api/handlers/platform-mcp.ts`
- first-party widget implementations

Acceptance:

- A widget can register a UI-only action.
- The agent can ask the widget to surface a view or focus/prefill a component.
- The command result is logged and reflected in the next widget snapshot.
- Backward compatibility with MCP-backed actions remains intact.

Verification:

- Desktop tests for parent-to-iframe command dispatch.
- Manual smoke: "show me the draft editor for this conversation" opens the
  relevant component without requiring a raw DOM selector.

Implementation notes:

- Keep UI-only actions in `agent_actions[]` with `mode: "ui"` and optional
  `ui.command`, `ui.component_id`, and `ui.args_template` metadata.
- Reuse `WidgetActionInvocation`/`WidgetActionResult` so MCP-backed actions and
  UI-only commands share one event, timeout, and snapshot path.
- Add first-party email examples for tab navigation, draft editor focus,
  history expansion, and prompt prefilling.

### PR 8: Event History, Summaries, And Audit

Purpose:

- Make "what happened in this widget" available to both user and agent without
  sending unbounded logs into context.

Expected files:

- `shared/contracts/widget.ts`
- `shared/contracts/ai.ts`
- `desktop/src/lib/widgetSurfaceRegistry.ts`
- `desktop/src/lib/widgetAgentTypes.ts`
- `desktop/src/components/widgets/WidgetEventLog.tsx`
- `api/services/call-logger.ts`
- `api/services/call-receipts.ts`
- `api/services/execution-settlement.ts`
- `api/services/invocation-telemetry.ts`
- `api/handlers/mcp.ts`
- `api/handlers/platform-mcp.ts`
- `supabase/migrations/*_widget_action_audit.sql`

Acceptance:

- Each surface keeps a bounded local event ring buffer.
- Agent context receives a compact recent-event summary.
- MCP-backed writes can be audited by surface/action/turn id.
- User can inspect recent agentic widget actions.

Verification:

- Desktop unit tests for event ring buffer and summaries.
- API telemetry tests if persistence is added.

Implementation notes:

- Keep full history desktop-local for v1 and send only bounded recent events
  plus `recentEventSummary` into agent context.
- Normalize every event as it enters the surface registry so user-authored
  widget events, action request events, and action result events share one
  inspectable shape.
- Persist MCP audit identity on `mcp_call_logs`, keyed by surface/action/turn,
  rather than relying only on generic JSON metadata.

### PR 9: First-Party Reference Widgets

Purpose:

- Prove the developer model on real widgets without requiring all widgets to
  migrate.

Expected files:

- `apps/mcps/email-ops/manifest.json`
- `apps/mcps/email-ops/index.ts`
- `apps/mcps/study-coach/manifest.json`
- `apps/mcps/study-coach/index.ts`
- `docs/AGENTIC_WIDGET_AUTHORING.md`

Acceptance:

- Email Ops demonstrates high-value D1 read context + confirmed write actions.
- Study Coach demonstrates lower-risk read/progress/lesson/quiz state
  navigation.
- Both remain fully clickable if the agentic bridge is unavailable.

Verification:

- App build/deploy smoke.
- Manual user flows for clickable and agentic modes.

Implementation notes:

- Email Ops should remain the high-stakes reference: D1 read grounding for
  threads/conventions, visible draft state, and confirmed send/discard actions.
- Study Coach should remain the lower-risk reference: semantic state and UI
  navigation across quiz setup, progress, pending quizzes, unread lessons, and
  paginated lessons.
- Add an authoring guide that shows the manifest fields, bridge calls, and
  fallback rule that clickable UI must keep working without `window.ulWidget`.

### PR 10: Voice Input On The Same Composer Path

Purpose:

- Add voice after the widget-agent spine works, so voice controls real semantic
  surfaces instead of becoming a separate feature island.

Expected files:

- `desktop/src/components/ChatInput.tsx`
- `desktop/src/components/widgets/WidgetComposer.tsx`
- `desktop/src/lib/byok.ts`
- `shared/types/index.ts`
- `api/services/inference-client.ts`
- `api/services/inference-route.ts`
- `desktop/src-tauri/tauri.conf.json`

Acceptance:

- Native/iOS dictation works through normal text inputs where available.
- Optional desktop mic path feeds transcripts into the same composer submit.
- BYOK Realtime, if added, has explicit provider capabilities, CSP websocket
  support, mic permission UX, and no separate action semantics.

Verification:

- Desktop permission/CSP smoke.
- Composer regression tests.

Implementation notes:

- Treat browser/iOS dictation as already supported wherever the normal text
  input is focused; the native keyboard remains the simplest voice path.
- Add an optional mic button to the standard chat composer and widget composer.
  Final transcripts append into the same draft text and submit through the same
  existing send/action path.
- Keep BYOK Realtime as a declared capability, not a separate agent lane:
  OpenAI is marked realtime-capable, desktop CSP allows `wss://api.openai.com`,
  and other providers remain explicitly `realtime: false` until implemented.
- Desktop mic UX uses browser speech recognition where available plus a macOS
  microphone usage string in the bundled `Info.plist`.

## MVP Cut

The first credible MVP should stop after PR6:

1. Contracts.
2. Surface registry/bridge.
3. Widget composer.
4. Active widget context in orchestration.
5. Permissioned D1 read context.
6. MCP-backed semantic actions.

That is enough to make the platform feel meaningfully agentic while preserving
all clickable widget behavior. UI-only commands, richer audit, reference app
polish, cross-widget orchestration, and voice can follow after the spine is
stable.

## Open Questions

- Should D1 context sources default on for installed apps that declare
  `searchable: true`, or should every context source require a user toggle
  before first use?
- Should widget event history be desktop-local in v1, server-persisted, or both?
- Should `ul.widget.invoke` be a server-side MCP-backed primitive first, with
  UI-only client commands later, or should the bidirectional client command bus
  land before any agent invocation?
- Should inline in-chat widgets get a visible composer immediately, or should
  the first composer ship only in standalone widget windows?
- How should multiple active widgets be ranked in global chat: focused window,
  most recent interaction, explicit user mention, or quick-insert only?

## Risks

- Context bloat if snapshots include raw DOM, large tables, or unbounded event
  histories.
- Security drift if D1 read context becomes confused with write access.
- Fragile developer ergonomics if action declarations require too much boilerplate.
- Ambiguous targeting when multiple widget windows are open.
- Server/client impedance mismatch for UI-only commands because the server
  orchestrator cannot directly reach a local iframe without a client command
  event loop.

## Success Criteria

- Existing clickable widgets continue to work without changes.
- A migrated widget can explain its current visible state to the agent.
- A migrated widget can expose safe semantic actions with JSON schemas.
- Widget composer turns are scoped to the active widget/app by default.
- D1/app data is searchable for read context when declared and permitted.
- MCP functions remain the authoritative write path.
- Agent-triggered actions update widget UI and leave an inspectable event trail.
