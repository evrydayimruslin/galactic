import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
} from 'lucide-react';
import type { WidgetSurfaceEvent } from '../../../../shared/contracts/widget.ts';
import {
  getWidgetSurface,
  subscribeWidgetSurfaces,
} from '../../lib/widgetSurfaceRegistry';
import {
  summarizeWidgetSurfaceEvents,
  type ActiveWidgetSurface,
} from '../../lib/widgetAgentTypes';

interface WidgetEventLogProps {
  surfaceId: string;
}

function formatTime(value?: string): string {
  if (!value) return '';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return '';
  return time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function eventTone(event: WidgetSurfaceEvent): string {
  if (event.kind === 'error' || event.error) return 'text-red-600 dark:text-red-300';
  if (event.kind === 'agent') return 'text-emerald-700 dark:text-emerald-300';
  return 'text-zinc-500 dark:text-zinc-400';
}

function EventIcon({ event }: { event: WidgetSurfaceEvent }) {
  if (event.kind === 'error' || event.error) {
    return <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />;
  }
  if (event.kind === 'agent') {
    return <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />;
  }
  return <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />;
}

function eventLabel(event: WidgetSurfaceEvent): string {
  if (event.error) return event.error;
  if (event.label) return event.label;
  if (event.action_id) return event.action_id;
  return event.kind;
}

function eventDetail(event: WidgetSurfaceEvent): string {
  const parts: string[] = [];
  if (event.action_id && event.label !== event.action_id) parts.push(event.action_id);
  if (event.turn_id) parts.push(event.turn_id);
  if (event.result !== undefined && !event.error) {
    try {
      const result = typeof event.result === 'string'
        ? event.result
        : JSON.stringify(event.result);
      if (result) parts.push(result.length > 120 ? `${result.slice(0, 117)}...` : result);
    } catch {
      parts.push('result recorded');
    }
  }
  return parts.join(' - ');
}

export default function WidgetEventLog({ surfaceId }: WidgetEventLogProps) {
  const [surface, setSurface] = useState<ActiveWidgetSurface | null>(() =>
    getWidgetSurface(surfaceId)
  );
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setSurface(getWidgetSurface(surfaceId));
    return subscribeWidgetSurfaces(() => {
      setSurface(getWidgetSurface(surfaceId));
    });
  }, [surfaceId]);

  const events = surface?.events ?? [];
  const recentEvents = useMemo(() => events.slice(-8).reverse(), [events]);
  const summary = useMemo(
    () => summarizeWidgetSurfaceEvents(events, 3).replace(/\n/g, ' - '),
    [events],
  );

  if (events.length === 0) return null;

  return (
    <div className="border-t border-zinc-200 bg-zinc-50/95 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950/95 dark:text-zinc-200">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        <span className="font-medium">Activity</span>
        <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
          {events.length}
        </span>
        <span className="min-w-0 flex-1 truncate text-zinc-500 dark:text-zinc-400">
          {summary}
        </span>
      </button>
      {expanded && (
        <div className="max-h-56 overflow-y-auto border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <ol className="space-y-2">
            {recentEvents.map((event, index) => {
              const detail = eventDetail(event);
              return (
                <li
                  key={event.id || `${event.created_at || 'event'}-${index}`}
                  className="grid grid-cols-[auto_1fr_auto] gap-2 text-xs"
                >
                  <span className={`mt-0.5 ${eventTone(event)}`}>
                    <EventIcon event={event} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-zinc-800 dark:text-zinc-100">
                      {eventLabel(event)}
                    </span>
                    {detail && (
                      <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                        {detail}
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] text-zinc-400">
                    {formatTime(event.created_at)}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
