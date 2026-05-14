// Tool Selection popover — Connected apps + Tool Dealer ambient suggestions.
//
// Data shape: AmbientSuggestion[] from useAmbientSuggestions. We split by the
// `connected` flag so "Connected" surfaces apps the user has authed, and
// "Tool Dealer" surfaces ambient (auto-curated) suggestions for this thread.

import type { AmbientSuggestion } from '../../types/ambientSuggestion';
import Popover from './Popover';

interface ToolSelectionPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  suggestions: AmbientSuggestion[];
  /** Fires "Open in chat" — expands the in-chat ambient panel. */
  onOpenPanel?: () => void;
}

function SectionLabel({ label, accent, count }: { label: string; accent?: string; count?: number }) {
  return (
    <div className="px-3.5 pt-2.5 pb-1 text-nano text-ul-text-muted font-mono uppercase flex items-center gap-1.5">
      {accent && (
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: accent }}
        />
      )}
      <span>{label}</span>
      {typeof count === 'number' && (
        <span className="text-ul-text-muted/60">· {count}</span>
      )}
    </div>
  );
}

function Row({
  dot,
  title,
  hint,
  right,
  onClick,
}: {
  dot?: string;
  title: string;
  hint?: string;
  right?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      onMouseDown={(e) => {
        if (!onClick) return;
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className={`flex items-center gap-2.5 px-3.5 py-1.5 ${onClick ? 'cursor-pointer hover:bg-ul-bg-hover' : ''}`}
    >
      {dot && (
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: dot }}
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-caption font-medium text-ul-text truncate">{title}</div>
        {hint && (
          <div className="text-nano text-ul-text-muted font-mono truncate">{hint}</div>
        )}
      </div>
      {right}
    </div>
  );
}

export default function ToolSelectionPopover({
  open,
  onClose,
  anchorRef,
  suggestions,
  onOpenPanel,
}: ToolSelectionPopoverProps) {
  const connected = suggestions.filter((s) => s.connected);
  const ambient = suggestions.filter((s) => !s.connected);

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} width={340}>
      <div className="px-3.5 py-3">
        <div className="text-caption font-semibold text-ul-text">Tool selection</div>
        <div className="text-micro text-ul-text-muted mt-0.5 leading-relaxed">
          Connected apps and Tool Dealer suggestions auto-curated from this thread.
        </div>
      </div>
      <div className="h-px bg-ul-border" />

      {/* Connected */}
      <SectionLabel label="Connected" accent="#0a0a0a" count={connected.length} />
      {connected.length > 0 ? (
        connected.map((s) => (
          <Row
            key={s.id}
            dot="#0a0a0a"
            title={s.name}
            hint={s.description}
            right={
              <span className="text-nano text-ul-text-muted font-mono">on</span>
            }
          />
        ))
      ) : (
        <div className="px-3.5 py-1.5 text-micro text-ul-text-muted">
          No apps connected yet.
        </div>
      )}

      <div className="h-px bg-ul-border mt-2" />

      {/* Tool Dealer ambient */}
      <SectionLabel
        label={`Tool Dealer · ${ambient.length} from this thread`}
        accent="#004225"
      />
      {ambient.length > 0 && onOpenPanel && (
        <div className="px-3.5 pb-1 text-nano text-ul-text-muted font-mono leading-relaxed">
          Auto-curated.{' '}
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              onClose();
              onOpenPanel();
            }}
            className="text-ul-deep-green underline bg-transparent border-none p-0 font-mono text-nano cursor-pointer"
          >
            Open in chat →
          </button>
        </div>
      )}
      {ambient.length > 0 ? (
        ambient.map((s) => (
          <Row
            key={s.id}
            dot="#004225"
            title={s.name}
            hint={s.description}
            right={
              <button
                onMouseDown={(e) => e.stopPropagation()}
                className="text-nano font-mono text-ul-deep-green bg-ul-deep-green/10 px-1.5 py-0.5 rounded-xs border-none cursor-pointer"
              >
                + Add
              </button>
            }
          />
        ))
      ) : (
        <div className="px-3.5 pb-3 text-micro text-ul-text-muted">
          No ambient suggestions yet — they'll surface as the conversation
          builds context.
        </div>
      )}
    </Popover>
  );
}
