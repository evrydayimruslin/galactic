import type { AgenticInterfaceWidgetEmbedComponent } from '../../../../shared/contracts/agentic-interface.ts';
import Glyph, { deriveGlyph, deriveTone } from '../ui/Glyph';

export default function AgenticInterfaceWidgetEmbed({
  component,
  onOpenWidget,
}: {
  component: AgenticInterfaceWidgetEmbedComponent;
  onOpenWidget?: (input: { appId: string; appSlug?: string; widgetId: string; context?: Record<string, string> }) => void;
}) {
  const appLabel = component.app_slug || component.app_id;
  return (
    <div className="h-full border border-ul-border bg-ul-bg rounded-md p-4 flex flex-col justify-between">
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Glyph glyph={deriveGlyph(appLabel)} tone={deriveTone(component.app_id)} size={24} />
          <div className="text-nano font-mono uppercase tracking-widest text-ul-text-muted truncate">
            {appLabel}
          </div>
        </div>
        <div className="text-small font-semibold text-ul-text truncate">{component.title || component.widget_id}</div>
        <div className="text-caption text-ul-text-secondary mt-1 line-clamp-2">
          Opens the verified widget surface for this generated workspace.
        </div>
      </div>
      <button
        type="button"
        onClick={() => onOpenWidget?.({
          appId: component.app_id,
          appSlug: component.app_slug,
          widgetId: component.widget_id,
          context: component.context,
        })}
        className="self-start mt-4 px-3 py-2 rounded-md border border-ul-border bg-ul-bg-raised text-caption font-mono text-ul-text-secondary hover:bg-ul-bg-hover"
      >
        Open widget
      </button>
    </div>
  );
}
