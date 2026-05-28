# Agentic Interface Smoke Tests

Last reviewed: `2026-05-28`

Use this checklist before merging changes that affect generated agentic
interfaces, widget active context, interface data refresh, or generated actions.

## Automated Harness

Run the focused API checks:

```bash
cd api
npm run test -- agentic-interface
```

Run the focused desktop checks:

```bash
cd desktop
npm test -- GeneratedInterface widgetSurfaceRegistry
```

The harness should prove:

- Fixture prompts produce valid, verified `AgenticInterfaceSpec` objects.
- Generated specs have no raw `html`, `react`, `css`, `script`, iframe, or DOM
  selector fields.
- Components, layout items, data bindings, and actions reference known ids.
- Write actions require `user` or `high_risk` confirmation.
- Stale saved specs re-verify against changed inventory and degrade to warnings
  or typed empty states.
- Desktop rendering tolerates missing data/action bindings.
- Generated interface surfaces publish active context snapshots and bounded
  refresh/action event history.

## Manual Smoke

1. Generate an Email Ops interface.

   Use `ul.command({ action: "interface", prompt: "review pending guest email approvals", include_data_preview: true })`.

   Expected: the result has a verified spec, Email Ops scope, at least one draft
   queue/table/card component, no raw UI fields, and only confirmed write
   actions.

2. Inspect the rendered interface.

   Open the generated interface in desktop Command. Confirm the first viewport
   renders typed components, warnings are visible if any capabilities are
   missing, and the original clickable widget can still be opened.

3. Refresh data.

   Click the refresh control or run `ul.command({ action: "interface_data", spec })`.

   Expected: read bindings refresh, row counts or binding errors appear in the
   generated surface context, and no write path is used for D1 data.

4. Execute a safe read/UI action.

   Trigger an open-widget, select-entity, refresh-binding, or read MCP action.

   Expected: the action runs without write confirmation, the surface event log
   records the turn, and active context includes the latest visible components
   and selected entities.

5. Execute a write action.

   Trigger a generated write action, such as sending or discarding a draft.

   Expected: the UI asks for confirmation first. After confirmation, the MCP call
   includes generated-interface audit metadata and the interface refreshes its
   data.

6. Save and reopen.

   Run `ul.command({ action: "save_interface", spec, title })`, reload desktop,
   then reopen it from the saved interface catalog.

   Expected: the saved spec re-verifies against current inventory, renders, and
   shows warnings rather than crashing if anything has gone missing.

7. Ask a follow-up from active context.

   With the generated interface open, ask about the currently visible table,
   selected row, or recent action result.

   Expected: composer context includes the generated surface snapshot, visible
   data refs, selected entities, enabled actions, and recent event summary.

8. Repeat with Study Coach and mixed prompts.

   Suggested prompts:

   - `show weak concepts study progress and quiz history`
   - `show email approvals and study weak concepts`

   Expected: each prompt produces scoped, verified, renderable components with
   no hallucinated functions, cards, widgets, or context sources.
