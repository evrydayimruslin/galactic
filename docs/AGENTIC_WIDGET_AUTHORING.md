# Agentic Widget Authoring

Last reviewed: `2026-05-28`

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
      "default_for_widgets": ["review_queue"],
      "generation_hints": {
        "tags": ["review", "approvals"],
        "preferred_component": "table",
        "entity_types": ["record"],
        "safe_default_filters": { "status": "pending", "limit": 10 },
        "prompt_examples": ["show pending records to approve"]
      }
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
      "generation_hints": {
        "tags": ["review queue", "approval workflow"],
        "preferred_component": "widget_embed",
        "entity_types": ["record"],
        "action_group": "record_review",
        "suggested_components": [
          {
            "kind": "table",
            "title": "Pending records",
            "description": "Show pending records with owner, status, and update time."
          },
          {
            "kind": "action_bar",
            "title": "Review actions",
            "action_ids": ["show_editor", "approve_selected"]
          }
        ]
      },
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
          },
          "generation_hints": {
            "tags": ["approve"],
            "action_group": "record_review",
            "entity_types": ["record"]
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

`generation_hints` are optional quality hints for generated agentic interfaces.
They do not make custom views mandatory and they do not change the clickable
widget contract. Use them when the default planner would otherwise have to infer
too much from labels alone:

- `tags` and `prompt_examples` make cards, context sources, and functions easier
  to find from natural language.
- `preferred_component` nudges generated surfaces toward `table`, `list`,
  `metric`, `detail`, `timeline`, `widget_embed`, `form`, `action_bar`, or
  another supported component kind.
- `entity_types` tells the planner what records are produced or acted on.
- `action_group` helps companion actions cluster together.
- `safe_default_filters` may prefill read-only filters such as
  `{ "status": "pending", "limit": 10 }`; write actions still require their
  normal MCP/widget confirmation policy.
- `suggested_components` lets a widget/card author propose companion pieces,
  such as a details panel next to a queue or an action bar beside a selected row.

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
