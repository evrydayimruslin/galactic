import type { AgenticInterfaceCardRefComponent } from '../../../../shared/contracts/agentic-interface.ts';
import Glyph, { deriveGlyph, deriveTone } from '../ui/Glyph';

export default function AgenticInterfaceCardRef({
  component,
  onOpenWidget,
}: {
  component: AgenticInterfaceCardRefComponent;
  onOpenWidget?: (input: { appId: string; appSlug?: string; widgetId: string }) => void;
}) {
  const appLabel = component.app_slug || component.app_id;
  return (
    <button
      type="button"
      onClick={() => onOpenWidget?.({
        appId: component.app_id,
        appSlug: component.app_slug,
        widgetId: component.widget_id,
      })}
      className="h-full w-full text-left border border-ul-border bg-ul-bg rounded-md p-4 hover:bg-ul-bg-hover transition-colors"
    >
      <div className="flex items-center gap-2 mb-3">
        <Glyph glyph={deriveGlyph(appLabel)} tone={deriveTone(component.app_id)} size={22} />
        <div className="text-nano font-mono uppercase tracking-widest text-ul-text-muted truncate">
          {appLabel}
        </div>
      </div>
      <div className="text-small font-semibold text-ul-text truncate">{component.title || component.card_id}</div>
      <div className="text-caption text-ul-text-secondary mt-1 truncate">
        {component.widget_id} / {component.card_id}
      </div>
      <div className="text-nano font-mono text-ul-text-muted mt-3">{component.size || 'card'}</div>
    </button>
  );
}
