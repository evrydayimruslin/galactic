# Agentic Widget Authoring

Last reviewed: `2026-05-23`

Agentic widgets are normal clickable widgets with optional semantic handles for
composer and agent control. A widget should keep its existing HTML, buttons,
forms, and keyboard flows working when the bridge is unavailable.

## Manifest

Declare the widget, its data shell, read context, and semantic actions:

```json
{
  "context_sources": [
    {
      "id": "recent_records",
      "label": "Recent records",
      "type": "d1_query",
      "access": "read",
      "searchable": true,
      "query": "SELECT id, title, status FROM records WHERE user_id = :user_id AND title LIKE :query ORDER BY updated_at DESC LIMIT :limit",
      "default_for_widgets": ["review_queue"]
    }
  ],
  "widgets": [
    {
      "id": "review_queue",
      "label": "Review Queue",
      "ui_function": "widget_review_queue_ui",
      "data_function": "widget_review_queue_data",
      "data_tool": "widget_review_queue_data",
      "agentic": true,
      "context_function": "widget_review_queue_data",
      "actions_function": "widget_review_queue_data",
      "context_sources": ["recent_records"],
      "agent_actions": [
        {
          "id": "show_editor",
          "label": "Show editor",
          "mode": "ui",
          "confirmation": "none",
          "ui": { "command": "focus", "component_id": "record_editor" }
        },
        {
          "id": "approve_selected",
          "label": "Approve selected",
          "mode": "write",
          "confirmation": "user",
          "mcp": {
            "function": "record_act",
            "args_template": { "action": "approve" }
          }
        }
      ]
    }
  ]
}
```

Use `d1_table` or SELECT-only `d1_query` context sources for read grounding.
Queries must include `:user_id`; `:query` and `:limit` are available for search
and budgeted retrieval. Do not use context sources for writes.

## Runtime Bridge

Inside the widget iframe, call the bridge only when it exists:

```js
function buildSnapshot() {
  return {
    widget_id: 'review_queue',
    title: 'Review Queue',
    current_view: state.view,
    selected_entities: state.selected
      ? [{ type: 'record', id: state.selected.id, label: state.selected.title }]
      : [],
    visible_components: [
      {
        id: 'record_editor',
        type: 'editor',
        label: 'Record editor',
        purpose: 'Edit the selected record before approving it',
        actions: ['show_editor', 'approve_selected']
      }
    ],
    enabled_actions: state.selected ? ['show_editor', 'approve_selected'] : [],
    updated_at: new Date().toISOString()
  };
}

function syncAgentContext() {
  if (!window.ulWidget) return;
  window.ulWidget.reportState(buildSnapshot);
}

function registerAction(action, handler) {
  if (!window.ulWidget) return;
  if (action.mode === 'ui' && window.ulWidget.registerViewAction) {
    window.ulWidget.registerViewAction(action, handler);
  } else {
    window.ulWidget.registerAction(action, handler);
  }
}
```

UI actions should move, reveal, focus, or prefill existing clickable UI. Write
actions should call the same MCP functions the widget already uses, with a user
confirmation policy when they mutate data or send messages.

## Reference Widgets

- Email Ops demonstrates D1 read context, reviewable drafts, and confirmed
  write actions such as sending or discarding a selected draft.
- Study Coach demonstrates lower-risk navigation across quiz, progress, and
  lesson state, plus one confirmed quiz-start action.

Both apps continue to work through clicks and forms when `window.ulWidget` is
not present.
