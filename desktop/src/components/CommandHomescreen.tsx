// CommandHomescreen — native cozy dashboard. Replaces the legacy tabbed
// HomeView (Project / Agents / Activity) per the Batch 7 addendum's
// A8 + A9 decisions. Ports `CozyHomescreen` from
// handoff/mockups/command-screens.jsx.
//
// Data flow:
//   1. fetchCommandDashboardLayout('command_home') -> StoredCommandDashboardLayout
//   2. fetchCommandWidgets() -> FunctionIndex.widgets[] (card metadata lookup)
//   3. For each card instance, look up its card defn via app_id + widget_id +
//      card_id to determine kind + dataView + sizing.
//   4. Render the tile in a grid based on size ("WxH").
//
// Behaviour:
//   - Chrome + 4-col grid + click-to-expand into the parent widget window.
//   - Per-tile data fetched via the widget's dataFunction. metric / list
//     templates render the response; generic fallback shows kind + label
//     when the shape doesn't match a known template.
//   - Edit mode: tiles wiggle, header recolors, × remove button per tile,
//     "Done" exits. Remove persists via saveCommandDashboardLayout.
//   - + Widget opens WidgetPickerModal listing every available card from
//     the function index; pick appends to the layout and persists.
//   - Drag-to-reorder: in edit mode, tiles are HTML5-draggable. Dropping
//     a tile on top of another moves it before that target and shifts the
//     rest. Card sizes are fixed (per addendum: no resize); reorder is
//     the only positional affordance.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchCommandDashboardLayout,
  fetchCommandWidgets,
  saveCommandDashboardLayout,
  type CommandDashboardLayout,
  type FunctionIndex,
} from '../lib/api';
import { openWidgetWindow } from '../lib/multiWindow';
import { fetchWidgetDataPayload } from '../lib/widgetRuntime';
import Glyph, { deriveGlyph, deriveTone } from './ui/Glyph';
import WidgetPickerModal, { type PickedCard, buildKey } from './dashboard/WidgetPickerModal';

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

// ── Tile data shapes ──────────────────────────────────────────────────
// Tolerant parsers — the data function may wrap the payload in a `body`
// envelope (per email-ops convention) or return the body directly.

interface MetricBody {
  metric: number | string;
  label?: string;
  suffix?: string;
}
interface ListItem {
  primary?: string;
  secondary?: string;
  trailing?: string;
}
interface ListBody {
  items: ListItem[];
}

function unwrapBody(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'body' in raw) {
    return (raw as { body: unknown }).body;
  }
  return raw;
}

function parseMetricBody(raw: unknown): MetricBody | null {
  const body = unwrapBody(raw);
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  // accept `metric` (per email-ops shape) or `value` (common alternative)
  const metric = obj.metric ?? obj.value;
  if (metric === undefined || metric === null) return null;
  if (typeof metric !== 'number' && typeof metric !== 'string') return null;
  return {
    metric,
    label: typeof obj.label === 'string' ? obj.label : undefined,
    suffix: typeof obj.suffix === 'string' ? obj.suffix : undefined,
  };
}

function parseListBody(raw: unknown): ListBody | null {
  const body = unwrapBody(raw);
  if (!body || typeof body !== 'object') return null;
  const items = (body as Record<string, unknown>).items;
  if (!Array.isArray(items)) return null;
  return {
    items: items.map((item) => {
      if (!item || typeof item !== 'object') return {};
      const o = item as Record<string, unknown>;
      return {
        primary: typeof o.primary === 'string' ? o.primary : (typeof o.title === 'string' ? o.title : undefined),
        secondary: typeof o.secondary === 'string' ? o.secondary : (typeof o.subtitle === 'string' ? o.subtitle : undefined),
        trailing: typeof o.trailing === 'string' ? o.trailing : (typeof o.right === 'string' ? o.right : undefined),
      };
    }),
  };
}

// ── Tile templates ────────────────────────────────────────────────────

function MetricTile({ card, data, loading }: { card: CardDefn; data: unknown; loading: boolean }) {
  const parsed = parseMetricBody(data);
  return (
    <div className="flex flex-col h-full justify-between">
      <div className="text-display text-ul-text leading-none tabular-nums">
        {loading && !parsed ? <span className="text-ul-text-muted">—</span> : (parsed?.metric ?? '—')}
        {parsed?.suffix && <span className="text-h3 text-ul-text-muted ml-1">{parsed.suffix}</span>}
      </div>
      <div className="text-caption text-ul-text-secondary">
        {parsed?.label || card.description || card.label}
      </div>
    </div>
  );
}

function ListTile({ card, data, loading }: { card: CardDefn; data: unknown; loading: boolean }) {
  const parsed = parseListBody(data);
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex flex-col gap-1.5 overflow-hidden">
        {!parsed && loading
          ? // Skeleton rows while loading and shape unknown
            [0, 1, 2].map((i) => (
              <div key={i} className="flex items-center justify-between border-b border-ul-border last:border-b-0 pb-1.5">
                <div className="h-2.5 w-2/3 bg-ul-bg-active rounded-xs" />
                <div className="h-2 w-8 bg-ul-bg-subtle rounded-xs" />
              </div>
            ))
          : parsed?.items.slice(0, 4).map((item, i) => (
              <div key={i} className="flex items-center justify-between gap-2 border-b border-ul-border last:border-b-0 pb-1.5 min-w-0">
                <div className="flex-1 min-w-0">
                  {item.primary && (
                    <div className="text-caption text-ul-text font-medium truncate">{item.primary}</div>
                  )}
                  {item.secondary && (
                    <div className="text-nano text-ul-text-muted truncate">{item.secondary}</div>
                  )}
                </div>
                {item.trailing && (
                  <div className="text-nano text-ul-text-muted font-mono flex-shrink-0">{item.trailing}</div>
                )}
              </div>
            ))}
      </div>
      <div className="text-nano text-ul-text-muted font-mono mt-2">
        {card.description || card.label}
      </div>
    </div>
  );
}

function GenericTile({ card, data }: { card: CardDefn; data: unknown }) {
  // Render data if present (tolerant), else the card metadata.
  const body = unwrapBody(data);
  return (
    <div className="flex flex-col h-full justify-center items-center text-center gap-1">
      <div className="text-caption font-semibold text-ul-text">{card.label}</div>
      {card.kind && (
        <div className="text-nano font-mono text-ul-text-muted uppercase tracking-wider">
          {card.kind}
        </div>
      )}
      {!body && card.description && (
        <div className="text-nano text-ul-text-secondary line-clamp-2 px-2">
          {card.description}
        </div>
      )}
      {body && typeof body === 'object' ? (
        <pre className="text-nano font-mono text-ul-text-muted overflow-hidden whitespace-pre-wrap max-h-16">
          {JSON.stringify(body, null, 0)}
        </pre>
      ) : null}
    </div>
  );
}

function renderTileBody(card: CardDefn, data: unknown, loading: boolean) {
  switch (card.kind) {
    case 'metric':
      return <MetricTile card={card} data={data} loading={loading} />;
    case 'list':
      return <ListTile card={card} data={data} loading={loading} />;
    default:
      return <GenericTile card={card} data={data} />;
  }
}

// ── Tile shell ────────────────────────────────────────────────────────

function CozyTile({
  tile,
  colSpan,
  rowSpan,
  data,
  loading,
  edit,
  wiggleDelayMs,
  isDragging,
  isDropTarget,
  onOpen,
  onRemove,
  onDragStart,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
  onDragEnd,
}: {
  tile: ResolvedTile;
  colSpan: number;
  rowSpan: number;
  data: unknown;
  loading: boolean;
  edit: boolean;
  wiggleDelayMs: number;
  isDragging: boolean;
  isDropTarget: boolean;
  onOpen: () => void;
  onRemove: () => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnter: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const { widget, card } = tile;
  const appLabel = widget.appName || widget.appSlug || 'tool';
  const tone = deriveTone(widget.appId);

  return (
    <div
      onClick={edit ? undefined : onOpen}
      draggable={edit}
      onDragStart={edit ? onDragStart : undefined}
      onDragOver={edit ? onDragOver : undefined}
      onDragEnter={edit ? onDragEnter : undefined}
      onDragLeave={edit ? onDragLeave : undefined}
      onDrop={edit ? onDrop : undefined}
      onDragEnd={edit ? onDragEnd : undefined}
      // TODO(token): rounded-[22px] — design tile radius doesn't match
      // any current ul-* radius token (xs/sm/md/pill/lg/card/xl).
      className={`bg-ul-bg border rounded-[22px] p-4 relative overflow-${edit ? 'visible' : 'hidden'} transition-all duration-base flex flex-col gap-2.5 text-left ${
        edit
          ? `cursor-grab shadow-md ${isDragging ? 'opacity-40' : 'animate-wiggle'} ${isDropTarget ? 'border-ul-text ring-2 ring-ul-text/15' : 'border-ul-border'}`
          : 'cursor-pointer hover:-translate-y-px hover:shadow-md border-ul-border'
      }`}
      style={{
        gridColumn: `span ${colSpan}`,
        gridRow: `span ${rowSpan}`,
        animationDelay: edit && !isDragging ? `${wiggleDelayMs}ms` : undefined,
      }}
    >
      {edit && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          // TODO(token): bg-ul-text + shadow combo is the negative-action mockup style.
          className="absolute -top-2 -left-2 w-[22px] h-[22px] rounded-full bg-ul-text text-white text-caption flex items-center justify-center cursor-pointer shadow-md z-10 leading-none"
          title="Remove from dashboard"
        >
          ×
        </button>
      )}
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
      <div className="flex-1 min-h-0">{renderTileBody(card, data, loading)}</div>
    </div>
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
  const [edit, setEdit] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Drag-to-reorder state (edit mode only). draggingId lives in component
  // state so the dragged tile can fade; dropTargetId drives the ring on the
  // tile currently being hovered. Cleared on dragend / drop.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  // Per-instance card data, keyed by instance_id
  const [cardData, setCardData] = useState<Record<string, unknown>>({});
  const [cardLoading, setCardLoading] = useState<Record<string, boolean>>({});
  // Track which instance ids we've already started a fetch for. Ref (not
  // state) so the dispatch loop doesn't read stale cardData/cardLoading
  // closures when tiles change quickly (e.g. after a layout edit).
  const fetchedInstanceIdsRef = useRef<Set<string>>(new Set());

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

  // Per-tile data fetch. Triggers when tiles list changes; uses a ref-tracked
  // dispatch set so the guard doesn't read stale state when tiles change
  // quickly. On failure, the id is removed from the set so a subsequent
  // tiles change retries.
  useEffect(() => {
    let cancelled = false;
    for (const tile of tiles) {
      const id = tile.instance.instance_id;
      if (fetchedInstanceIdsRef.current.has(id)) continue;
      fetchedInstanceIdsRef.current.add(id);
      setCardLoading((s) => ({ ...s, [id]: true }));
      void fetchWidgetDataPayload(
        {
          appUuid: tile.widget.appId,
          appSlug: tile.widget.appSlug ?? '',
          dataFunction: tile.widget.dataFunction ?? `widget_${tile.widget.name}_data`,
        },
        undefined,
        null,
        { card_id: tile.card.id, data_view: tile.card.dataView ?? tile.card.id },
      )
        .then((payload) => {
          if (cancelled) return;
          setCardData((s) => ({ ...s, [id]: payload?.raw ?? null }));
        })
        .catch(() => {
          if (cancelled) return;
          // Drop from the dispatch set so a future tiles change retries.
          fetchedInstanceIdsRef.current.delete(id);
          setCardData((s) => ({ ...s, [id]: null }));
        })
        .finally(() => {
          if (cancelled) return;
          setCardLoading((s) => ({ ...s, [id]: false }));
        });
    }
    return () => { cancelled = true; };
  }, [tiles]);

  const onOpenTile = useCallback((tile: ResolvedTile) => {
    void openWidgetWindow({
      appUuid: tile.widget.appId,
      appSlug: tile.widget.appSlug ?? '',
      appName: tile.widget.appName ?? tile.widget.appSlug ?? 'Widget',
      widgetName: tile.widget.name,
      // Convention used by widgetRuntime: widget_<name>_ui / widget_<name>_data.
      uiFunction: tile.widget.uiFunction ?? `widget_${tile.widget.name}_ui`,
      dataFunction: tile.widget.dataFunction ?? `widget_${tile.widget.name}_data`,
    });
  }, []);

  // Persist a layout change. Optimistic update — UI reflects immediately;
  // server confirms in the background. Reverts on failure.
  const persistLayout = useCallback(async (next: CommandDashboardLayout) => {
    const prev = layout;
    setLayout(next);
    const saved = await saveCommandDashboardLayout(next);
    if (!saved) {
      setLayout(prev);
      setError('Failed to save dashboard. Reverted.');
    }
  }, [layout]);

  const onRemoveTile = useCallback(
    async (instanceId: string) => {
      if (!layout) return;
      const prev = layout;
      const next: CommandDashboardLayout = {
        ...layout,
        cards: layout.cards.filter((c) => c.instance_id !== instanceId),
      };
      // Optimistic layout update.
      setLayout(next);
      const saved = await saveCommandDashboardLayout(next);
      if (!saved) {
        // Revert layout; KEEP cardData intact so the restored tile still has
        // its content. (Bug fix vs. earlier impl that purged data eagerly.)
        setLayout(prev);
        setError('Failed to remove. Reverted.');
        return;
      }
      // Save confirmed — now safe to purge the cache + allow re-fetch if
      // the card is later re-added.
      setCardData((s) => {
        const { [instanceId]: _drop, ...rest } = s;
        return rest;
      });
      fetchedInstanceIdsRef.current.delete(instanceId);
    },
    [layout],
  );

  const onAddCard = useCallback(
    (pick: PickedCard) => {
      const next: CommandDashboardLayout = {
        dashboard_key: layout?.dashboard_key ?? 'command_home',
        cards: [
          ...(layout?.cards ?? []),
          {
            instance_id: crypto.randomUUID(),
            app_id: pick.appId,
            app_slug: pick.appSlug,
            widget_id: pick.widgetId,
            card_id: pick.cardId,
            size: pick.size,
            position: { x: 0, y: layout?.cards.length ?? 0 },
          },
        ],
      };
      void persistLayout(next);
      setPickerOpen(false);
    },
    [layout, persistLayout],
  );

  // ── Drag-to-reorder ────────────────────────────────────────────────
  //
  // HTML5 drag-and-drop handlers. Stays inside the addendum's "no new
  // dependencies" rule (vs reaching for react-dnd / dnd-kit). Move-before
  // semantics: dragging tile A onto tile B inserts A immediately before
  // B's slot and shifts the rest right.

  const onTileDragStart = useCallback(
    (instanceId: string, e: React.DragEvent<HTMLDivElement>) => {
      setDraggingId(instanceId);
      // setData is required for Firefox to start a drag.
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', instanceId);
      }
    },
    [],
  );

  const onTileDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // preventDefault is what tells the browser "this is a valid drop target".
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }, []);

  const onTileDragEnter = useCallback((instanceId: string) => {
    setDropTargetId(prev => (prev === instanceId ? prev : instanceId));
  }, []);

  const onTileDragLeave = useCallback((instanceId: string) => {
    setDropTargetId(prev => (prev === instanceId ? null : prev));
  }, []);

  const onTileDragEnd = useCallback(() => {
    setDraggingId(null);
    setDropTargetId(null);
  }, []);

  const onTileDrop = useCallback(
    (targetId: string) => {
      if (!layout || !draggingId || draggingId === targetId) {
        setDraggingId(null);
        setDropTargetId(null);
        return;
      }
      const cards = layout.cards;
      const fromIdx = cards.findIndex(c => c.instance_id === draggingId);
      const toIdx = cards.findIndex(c => c.instance_id === targetId);
      if (fromIdx === -1 || toIdx === -1) {
        setDraggingId(null);
        setDropTargetId(null);
        return;
      }
      const reordered = [...cards];
      const [moved] = reordered.splice(fromIdx, 1);
      // Inserting at toIdx after the splice naturally lands moved at the
      // target's original visual position when dragging right-to-left, and
      // just-before the target when dragging left-to-right. That matches
      // the iOS app-grid mental model the design references.
      reordered.splice(toIdx, 0, moved);
      const next: CommandDashboardLayout = { ...layout, cards: reordered };
      setDraggingId(null);
      setDropTargetId(null);
      void persistLayout(next);
    },
    [layout, draggingId, persistLayout],
  );

  // Set of widget+card keys currently on the dashboard — drives the
  // "Added" badge on picker rows.
  const takenKeys = useMemo(() => {
    const set = new Set<string>();
    for (const c of layout?.cards ?? []) {
      set.add(buildKey(c.app_id, c.widget_id, c.card_id));
    }
    return set;
  }, [layout]);

  return (
    <div className="bg-ul-warm-paper h-full overflow-auto relative">
      {/* Header */}
      <div className="px-7 pt-6 pb-3.5 flex items-end justify-between">
        <div>
          <div
            className={`text-micro font-mono uppercase tracking-widest mb-1 ${
              edit ? 'text-ul-info' : 'text-ul-text-muted'
            }`}
          >
            {edit ? 'Command · edit mode' : 'Command'}
          </div>
          <div className="text-h2 text-ul-text tracking-tight">
            {edit ? 'Drag or remove' : today}
          </div>
        </div>
        <div className="flex gap-2">
          {edit ? (
            <button
              type="button"
              onClick={() => setEdit(false)}
              className="font-mono text-caption text-ul-text-secondary bg-ul-bg border border-ul-border px-3.5 py-2 rounded-md cursor-pointer hover:bg-ul-bg-hover"
            >
              Done
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setEdit(true)}
              disabled={tiles.length === 0}
              className="font-mono text-caption text-ul-text-secondary bg-ul-bg border border-ul-border px-3 py-2 rounded-md cursor-pointer hover:bg-ul-bg-hover disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Edit layout
            </button>
          )}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="font-mono text-caption text-white bg-ul-text border border-ul-text px-3.5 py-2 rounded-md cursor-pointer hover:bg-ul-accent-hover"
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
        <EmptyState onAddWidget={() => setPickerOpen(true)} />
      ) : (
        <div
          className="px-[22px] pt-2 pb-6 grid grid-cols-4 gap-3.5"
          style={{ gridAutoRows: '150px' }}
        >
          {tiles.map((tile, i) => {
            const { colSpan, rowSpan } = parseSize(tile.instance.size);
            const id = tile.instance.instance_id;
            return (
              <CozyTile
                key={id}
                tile={tile}
                colSpan={colSpan}
                rowSpan={rowSpan}
                data={cardData[id]}
                loading={cardLoading[id] ?? false}
                edit={edit}
                wiggleDelayMs={i * 60}
                isDragging={draggingId === id}
                isDropTarget={dropTargetId === id && draggingId !== id}
                onOpen={() => onOpenTile(tile)}
                onRemove={() => onRemoveTile(id)}
                onDragStart={(e) => onTileDragStart(id, e)}
                onDragOver={onTileDragOver}
                onDragEnter={() => onTileDragEnter(id)}
                onDragLeave={() => onTileDragLeave(id)}
                onDrop={() => onTileDrop(id)}
                onDragEnd={onTileDragEnd}
              />
            );
          })}
        </div>
      )}

      {pickerOpen && (
        <WidgetPickerModal
          widgets={widgetsIndex}
          takenKeys={takenKeys}
          onClose={() => setPickerOpen(false)}
          onPick={onAddCard}
        />
      )}
    </div>
  );
}
