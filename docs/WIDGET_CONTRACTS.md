# Widget Contracts

Last reviewed: `2026-05-04`

This document is the canonical contract for desktop/home-screen widgets in
Ultralight. The goal is to keep widget discovery predictable and make Wave 4
legacy removal reviewable.

## Canonical Contract

For a widget with id `email_inbox`, the canonical contract is:

- manifest declaration:
  - `id: "email_inbox"`
  - `label: "Email Approvals"`
  - optional `data_tool: "widget_email_inbox_data"`
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
