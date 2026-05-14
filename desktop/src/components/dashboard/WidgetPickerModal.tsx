// WidgetPickerModal — modal for picking a command-card to add to the
// dashboard. Lists every card declared by every installed widget.
//
// Ports the picker affordance from handoff/mockups/command-screens.jsx
// (`WidgetPicker` line 554). The mockup's gallery / two-pane variants
// (`CommandWidgetPickerGallery`, `CommandWidgetPickerTwoPane`) are not
// shipped this batch — gallery preview imagery would require app-supplied
// thumbnails (DESIGN-FOLLOWUPS B7).

import { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { FunctionIndex } from '../../lib/api';
import Glyph, { deriveGlyph, deriveTone } from '../ui/Glyph';

export interface PickedCard {
  appId: string;
  appSlug?: string;
  widgetId: string;
  cardId: string;
  size: string;
}

type WidgetDefn = FunctionIndex['widgets'][number];
type CardDefn = NonNullable<WidgetDefn['cards']>[number];

interface PickerRow {
  appId: string;
  appLabel: string;
  appSlug?: string;
  widget: WidgetDefn;
  card: CardDefn;
}

interface WidgetPickerModalProps {
  widgets: FunctionIndex['widgets'];
  /** instance ids already on the dashboard; rendered as disabled in the picker. */
  takenKeys?: Set<string>;
  onClose: () => void;
  onPick: (pick: PickedCard) => void;
}

function buildKey(appId: string, widgetId: string, cardId: string): string {
  return `${appId}::${widgetId}::${cardId}`;
}

export default function WidgetPickerModal({
  widgets,
  takenKeys,
  onClose,
  onPick,
}: WidgetPickerModalProps) {
  const [query, setQuery] = useState('');

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Flatten widgets[].cards[] into pickable rows
  const rows = useMemo<PickerRow[]>(() => {
    const out: PickerRow[] = [];
    for (const w of widgets) {
      const label = w.appName || w.appSlug || 'tool';
      for (const c of w.cards ?? []) {
        out.push({ appId: w.appId, appLabel: label, appSlug: w.appSlug, widget: w, card: c });
      }
    }
    return out;
  }, [widgets]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.appLabel.toLowerCase().includes(q) ||
      r.card.label.toLowerCase().includes(q) ||
      (r.card.description?.toLowerCase().includes(q) ?? false),
    );
  }, [rows, query]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-6 py-10 animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-ul-bg rounded-lg shadow-xl border border-ul-border w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden animate-fade-up">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-ul-border">
          <div>
            <div className="text-micro font-mono uppercase tracking-widest text-ul-text-muted mb-0.5">
              Add widget
            </div>
            <div className="text-h3 text-ul-text tracking-tight">Pick a card to surface on your homescreen</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full text-ul-text-muted hover:bg-ul-bg-hover flex items-center justify-center cursor-pointer"
            title="Close"
          >
            <X className="w-4 h-4" strokeWidth={1.5} />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 pt-4 pb-2 flex-shrink-0">
          <div className="flex items-center gap-2 px-3 py-2 border border-ul-border rounded-pill bg-ul-bg-raised">
            <Search className="w-3.5 h-3.5 text-ul-text-muted flex-shrink-0" strokeWidth={1.5} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools or cards…"
              className="flex-1 border-none outline-none bg-transparent text-small text-ul-text"
            />
          </div>
        </div>

        {/* Card grid */}
        <div className="flex-1 overflow-y-auto px-5 pb-5 pt-2">
          {rows.length === 0 ? (
            <div className="px-1 py-6 text-caption text-ul-text-muted">
              No widget cards available. Install a tool that publishes cards (like email-ops) and they'll appear here.
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-1 py-6 text-caption text-ul-text-muted">No matches.</div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              {filtered.map((r) => {
                const key = buildKey(r.appId, r.widget.name, r.card.id);
                const taken = takenKeys?.has(key) ?? false;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      onPick({
                        appId: r.appId,
                        appSlug: r.appSlug,
                        widgetId: r.widget.name,
                        cardId: r.card.id,
                        size: r.card.size,
                      });
                    }}
                    disabled={taken}
                    className={`text-left border border-ul-border rounded-md p-3 transition-colors ${
                      taken
                        ? 'bg-ul-bg-subtle opacity-60 cursor-not-allowed'
                        : 'bg-ul-bg hover:bg-ul-bg-hover cursor-pointer'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <Glyph
                        glyph={deriveGlyph(r.appLabel)}
                        tone={deriveTone(r.appId)}
                        size={20}
                      />
                      <span className="text-nano font-mono uppercase tracking-widest text-ul-text-muted truncate">
                        {r.appLabel}
                      </span>
                    </div>
                    <div className="text-small font-semibold text-ul-text truncate">{r.card.label}</div>
                    {r.card.description && (
                      <div className="text-caption text-ul-text-secondary mt-0.5 line-clamp-2">
                        {r.card.description}
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      {r.card.kind && (
                        <span className="text-nano font-mono uppercase tracking-wider text-ul-text-muted bg-ul-bg-active px-1.5 py-0.5 rounded-xs">
                          {r.card.kind}
                        </span>
                      )}
                      <span className="text-nano font-mono text-ul-text-muted">
                        {r.card.size}
                      </span>
                      {taken && (
                        <span className="text-nano font-mono uppercase tracking-wider text-ul-success-strong ml-auto">
                          Added
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export { buildKey };
