// CommandHomescreen — native cozy dashboard.
//
// Ports `CozyHomescreen` from handoff/mockups/command-screens.jsx. Replaces
// the tabbed HomeView (Project / Agents / Activity) per design call A6 in
// handoff/DESIGN-FOLLOWUPS.md.
//
// Data flow:
//   1. fetchCommandDashboardLayout('command_home') -> StoredCommandDashboardLayout
//   2. fetchCommandWidgets() -> FunctionIndex.widgets[] (card metadata lookup)
//   3. For each card instance, look up its card defn via app_id + widget_id +
//      card_id to determine kind + dataView + sizing.
//   4. Render the tile in a grid based on size ("WxH").
//
// 3c-i scope (this PR):
//   - Chrome + grid layout + click-to-expand into the parent widget window.
//   - Tile templates: metric, list, generic fallback. No per-tile data fetch
//     yet — tiles show kind-aware placeholder content.
//   - Edit Layout + + Widget buttons render as stubs.
//
// 3c-ii (next PR): per-tile data fetching via dataFunction, edit-layout
// drag/resize, + Widget picker modal, save via saveCommandDashboardLayout.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchCommandDashboardLayout,
  fetchCommandWidgets,
  type CommandDashboardLayout,
  type FunctionIndex,
} from '../lib/api';
import { openWidgetWindow } from '../lib/multiWindow';
import Glyph, { deriveGlyph, deriveTone } from './ui/Glyph';

// ── Types (FE-internal) ───────────────────────────────────────────────

type CardInstance = CommandDashboardLayout['cards'][number];
type WidgetDefn = NonNullable<FunctionIndex['widgets'][number]>;
type CardDefn = NonNullable<WidgetDefn['cards']>[number];

interface ResolvedTile {
  instance: CardInstance;
  widget: WidgetDefn;
  card: CardDefn;
}

// ── Sizing ────────────────────────────────────────────────────────────

/** Parse "1x1", "2x1", "2x2", "4x2"... into [colSpan, rowSpan]. Defaults to 1×1. */
function parseSize(size: string): { colSpan: number; rowSpan: number } {
  const m = /^(\d+)x(\d+)$/i.exec(size.trim());
  if (!m) return { colSpan: 1, rowSpan: 1 };
  const col = Math.min(Math.max(parseInt(m[1], 10) || 1, 1), 4);
  const row = Math.min(Math.max(parseInt(m[2], 10) || 1, 1), 4);
  return { colSpan: col, rowSpan: row };
}

// ── Tile templates ────────────────────────────────────────────────────

function MetricTile({ card }: { card: CardDefn }) {
  // Placeholder structure matches the mockup's metric-shape tiles
  // (big number, optional sub-label). Real data wiring in 3c-ii.
  return (
    <div className="flex flex-col h-full justify-between">
      <div className="text-display text-ul-text leading-none tabular-nums">—</div>
      <div className="text-caption text-ul-text-secondary">
        {card.description || card.label}
      </div>
    </div>
  );
}

function ListTile({ card }: { card: CardDefn }) {
  // Placeholder structure for list-shape tiles. Empty rows hint at the
  // future layout; 3c-ii wires real items via the data function.
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex flex-col gap-1.5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex items-center justify-between border-b border-ul-border last:border-b-0 pb-1.5"
          >
            <div className="h-2.5 w-2/3 bg-ul-bg-active rounded-xs" />
            <div className="h-2 w-8 bg-ul-bg-subtle rounded-xs" />
          </div>
        ))}
      </div>
      <div className="text-nano text-ul-text-muted font-mono mt-2">
        {card.description || card.label}
      </div>
    </div>
  );
}

function GenericTile({ card }: { card: CardDefn }) {
  return (
    <div className="flex flex-col h-full justify-center items-center text-center gap-1">
      <div className="text-caption font-semibold text-ul-text">{card.label}</div>
      {card.kind && (
        <div className="text-nano font-mono text-ul-text-muted uppercase tracking-wider">
          {card.kind}
        </div>
      )}
      {card.description && (
        <div className="text-nano text-ul-text-secondary line-clamp-2 px-2">
          {card.description}
        </div>
      )}
    </div>
  );
}

function renderTileBody(card: CardDefn) {
  switch (card.kind) {
    case 'metric':
      return <MetricTile card={card} />;
    case 'list':
      return <ListTile card={card} />;
    default:
      return <GenericTile card={card} />;
  }
}

// ── Tile shell ────────────────────────────────────────────────────────

function CozyTile({
  tile,
  colSpan,
  rowSpan,
  onOpen,
}: {
  tile: ResolvedTile;
  colSpan: number;
  rowSpan: number;
  onOpen: () => void;
}) {
  const { widget, card } = tile;
  const appLabel = widget.appName || widget.appSlug || 'tool';
  const tone = deriveTone(widget.appId);
  return (
    <button
      type="button"
      onClick={onOpen}
      // TODO(token): rounded-[22px] — design tile radius doesn't match
      // any current ul-* radius token (xs/sm/md/pill/lg/card/xl).
      className="bg-ul-bg border border-ul-border rounded-[22px] p-4 relative cursor-pointer overflow-hidden transition-all duration-base hover:-translate-y-px hover:shadow-md flex flex-col gap-2.5 text-left"
      style={{ gridColumn: `span ${colSpan}`, gridRow: `span ${rowSpan}` }}
    >
      <div className="flex items-center gap-2.5">
        <Glyph glyph={deriveGlyph(appLabel)} tone={tone} size={22} />
        <div
          className="text-nano font-mono uppercase tracking-widest font-semibold truncate"
          style={{ color: tone }}
        >
          {appLabel}
        </div>
        {/* Burn rate / cost-per-min not on card defn today — DESIGN-FOLLOWUPS B6. */}
      </div>
      <div className="flex-1 min-h-0">{renderTileBody(card)}</div>
    </button>
  );
}

// ── Empty state ───────────────────────────────────────────────────────

function EmptyState({ onAddWidget }: { onAddWidget: () => void }) {
  return (
    <div className="px-7 pt-6 pb-6 flex flex-col items-center justify-center min-h-[60vh]">
      <div className="text-h2 text-ul-text tracking-tight mb-2">No widgets yet</div>
      <div className="text-body text-ul-text-secondary max-w-md text-center mb-6">
        Your homescreen is a grid of widgets pulled from your installed tools.
        Add one to start.
      </div>
      <button
        type="button"
        onClick={onAddWidget}
        // TODO(token): rounded-md, bg-ul-text + text-white pair is consistent
        // with composer send button "armed" state.
        className="bg-ul-text text-white px-4 py-2.5 rounded-md font-mono text-caption cursor-pointer hover:bg-ul-accent-hover transition-colors"
      >
        ＋ Add a widget
      </button>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────

export default function CommandHomescreen() {
  const [layout, setLayout] = useState<CommandDashboardLayout | null>(null);
  const [widgetsIndex, setWidgetsIndex] = useState<FunctionIndex['widgets']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Format today's date in the cozy header style ("Sunday, March 9")
  const today = useMemo(() => {
    return new Date().toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  }, []);

  // Initial load — fetch layout + widget index in parallel
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchCommandDashboardLayout('command_home'), fetchCommandWidgets()])
      .then(([stored, widgets]) => {
        if (cancelled) return;
        setLayout(stored?.layout ?? null);
        setWidgetsIndex(widgets?.widgets ?? []);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Resolve each card instance against the widget index. Drops orphans
  // (instances whose widget or card was removed from the manifest).
  const tiles = useMemo<ResolvedTile[]>(() => {
    if (!layout || widgetsIndex.length === 0) return [];
    const resolved: ResolvedTile[] = [];
    for (const instance of layout.cards) {
      const widget = widgetsIndex.find(
        (w) => w.appId === instance.app_id && w.name === instance.widget_id,
      );
      if (!widget) continue;
      const card = widget.cards?.find((c) => c.id === instance.card_id);
      if (!card) continue;
      resolved.push({ instance, widget, card });
    }
    return resolved;
  }, [layout, widgetsIndex]);

  const onOpenTile = useCallback((tile: ResolvedTile) => {
    void openWidgetWindow({
      appUuid: tile.widget.appId,
      appSlug: tile.widget.appSlug ?? '',
      appName: tile.widget.appName ?? tile.widget.appSlug ?? 'Widget',
      widgetName: tile.widget.name,
      // Convention used by widgetRuntime: widget_<name>_ui / widget_<name>_data.
      // We trust the manifest's declared functions when present, falling back
      // to the convention when the index didn't include them (older builds).
      uiFunction: tile.widget.uiFunction ?? `widget_${tile.widget.name}_ui`,
      dataFunction: tile.widget.dataFunction ?? `widget_${tile.widget.name}_data`,
    });
  }, []);

  const onEditLayout = useCallback(() => {
    // 3c-ii wires edit mode (drag/resize + remove + save).
    // TODO(scope): no-op until 3c-ii.
  }, []);

  const onAddWidget = useCallback(() => {
    // 3c-ii wires the widget picker modal.
    // TODO(scope): no-op until 3c-ii.
  }, []);

  return (
    <div className="bg-ul-warm-paper h-full overflow-auto relative">
      {/* Header */}
      <div className="px-7 pt-6 pb-3.5 flex items-end justify-between">
        <div>
          <div className="text-micro font-mono uppercase tracking-widest text-ul-text-muted mb-1">
            Command
          </div>
          <div className="text-h2 text-ul-text tracking-tight">{today}</div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onEditLayout}
            // TODO(scope): disabled — 3c-ii wires edit mode.
            disabled
            className="font-mono text-caption text-ul-text-secondary bg-ul-bg border border-ul-border px-3 py-2 rounded-md cursor-not-allowed opacity-60"
            title="Edit layout (coming in 3c-ii)"
          >
            Edit layout
          </button>
          <button
            type="button"
            onClick={onAddWidget}
            disabled
            className="font-mono text-caption text-white bg-ul-text border border-ul-text px-3.5 py-2 rounded-md cursor-not-allowed opacity-60"
            title="Add widget (coming in 3c-ii)"
          >
            ＋ Widget
          </button>
        </div>
      </div>

      {/* Body */}
      {loading && !layout ? (
        <div className="px-7 py-6 text-caption text-ul-text-muted">
          Loading homescreen…
        </div>
      ) : error ? (
        <div className="px-7 py-6 text-caption text-ul-error">{error}</div>
      ) : tiles.length === 0 ? (
        <EmptyState onAddWidget={onAddWidget} />
      ) : (
        <div
          className="px-[22px] pt-2 pb-6 grid grid-cols-4 gap-3.5"
          style={{ gridAutoRows: '150px' }}
        >
          {tiles.map((tile) => {
            const { colSpan, rowSpan } = parseSize(tile.instance.size);
            return (
              <CozyTile
                key={tile.instance.instance_id}
                tile={tile}
                colSpan={colSpan}
                rowSpan={rowSpan}
                onOpen={() => onOpenTile(tile)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
