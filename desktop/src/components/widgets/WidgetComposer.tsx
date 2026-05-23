import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Database,
  Loader2,
  Mic,
  MousePointerClick,
  Send,
  SlidersHorizontal,
  Wrench,
  X,
} from 'lucide-react';
import {
  fetchFunctionIndex,
  streamOrchestrate,
  type FunctionIndex,
} from '../../lib/api';
import type { WidgetAppSource } from '../../lib/widgetRuntime';
import {
  getWidgetSurface,
  invokeWidgetSurfaceAction,
  subscribeWidgetSurfaces,
} from '../../lib/widgetSurfaceRegistry';
import {
  buildActiveWidgetContext,
  type ActiveWidgetSurface,
} from '../../lib/widgetAgentTypes';
import { appendVoiceTranscript, useVoiceInput } from '../../lib/voiceInput';

interface WidgetComposerProps {
  surfaceId: string;
  source: WidgetAppSource;
  context?: Record<string, string>;
}

type ComposerTurn = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

type WidgetComposerAction = ActiveWidgetSurface['actions'][number];

function appendText(base: string, delta: string): string {
  if (!delta) return base;
  return base ? `${base}${delta}` : delta;
}

function summarizeFunction(fnName: string, fn: FunctionIndex['functions'][string]): string {
  const params = Object.entries(fn.params || {})
    .slice(0, 3)
    .map(([name, param]) => `${name}${param.required ? '' : '?'}`)
    .join(', ');
  return params ? `${fnName}(${params})` : `${fnName}()`;
}

function findWidgetDefinition(index: FunctionIndex | null, source: WidgetAppSource) {
  if (!index) return null;
  return index.widgets.find((widget) =>
    widget.name === source.widgetName &&
    (widget.appId === source.appUuid || widget.appSlug === source.appSlug)
  ) ?? null;
}

function normalizeActionText(value: string | undefined): string {
  return (value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findActionForMessage(
  message: string,
  actions: WidgetComposerAction[],
): WidgetComposerAction | null {
  const normalizedMessage = normalizeActionText(message);
  if (!normalizedMessage) return null;

  for (const action of actions) {
    const aliases = [
      action.id,
      action.label,
      action.description,
    ]
      .map(normalizeActionText)
      .filter(Boolean);

    if (aliases.some((alias) =>
      normalizedMessage === alias ||
      normalizedMessage.includes(alias) ||
      normalizedMessage.includes(`use ${alias}`)
    )) {
      return action;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractQuotedFragment(message: string): string | null {
  const match = message.match(/"([^"]+)"|'([^']+)'/);
  return match?.[1] || match?.[2] || null;
}

function buildActionArgs(action: WidgetComposerAction, message: string): Record<string, unknown> {
  const template = isRecord(action.mcp?.args_template)
    ? action.mcp.args_template
    : isRecord(action.ui?.args_template)
    ? action.ui.args_template
    : {};
  const args: Record<string, unknown> = { ...template };
  if (action.mode === 'ui') {
    args.query = message;
    const quoted = extractQuotedFragment(message);
    if (quoted && args.text === undefined && args.prompt === undefined && args.value === undefined) {
      args.text = quoted;
    }
  }
  return args;
}

function shouldConfirmAction(action: WidgetComposerAction): boolean {
  return action.confirmation === 'user' ||
    action.confirmation === 'high_risk' ||
    (action.mode === 'write' && action.confirmation !== 'none');
}

function summarizeActionResult(action: WidgetComposerAction, result: Awaited<ReturnType<typeof invokeWidgetSurfaceAction>>): string {
  if (!result.ok) {
    return `${action.label} failed: ${result.error || 'Unknown error'}`;
  }
  if (result.data === undefined || result.data === null) {
    return `${action.label} completed.`;
  }
  const preview = typeof result.data === 'string'
    ? result.data
    : JSON.stringify(result.data, null, 2);
  return `${action.label} completed.\n${preview.length > 700 ? `${preview.slice(0, 700)}...` : preview}`;
}

export default function WidgetComposer({ surfaceId, source, context }: WidgetComposerProps) {
  const [value, setValue] = useState('');
  const [turns, setTurns] = useState<ComposerTurn[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [surface, setSurface] = useState<ActiveWidgetSurface | null>(() => getWidgetSurface(surfaceId));
  const [index, setIndex] = useState<FunctionIndex | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const appendVoiceText = useCallback((transcript: string) => {
    setValue((prev) => appendVoiceTranscript(prev, transcript));
  }, []);

  const focusTextarea = useCallback(() => {
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const voice = useVoiceInput({
    disabled: isLoading,
    onTranscript: appendVoiceText,
    onAfterTranscript: focusTextarea,
  });

  useEffect(() => {
    return subscribeWidgetSurfaces((surfaces) => {
      setSurface(surfaces.find((item) => item.surfaceId === surfaceId) ?? null);
    });
  }, [surfaceId]);

  useEffect(() => {
    let cancelled = false;
    fetchFunctionIndex()
      .then((nextIndex) => {
        if (!cancelled) setIndex(nextIndex);
      })
      .catch(() => {
        if (!cancelled) setIndex(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
  }, [value]);

  const widgetDefinition = useMemo(() => findWidgetDefinition(index, source), [index, source]);

  const appFunctions = useMemo(() => {
    if (!index) return [];
    return Object.entries(index.functions)
      .filter(([, fn]) => fn.appSlug === source.appSlug)
      .slice(0, 18);
  }, [index, source.appSlug]);

  const appContextSources = useMemo(() => {
    if (!index?.contextSources) return [];
    return index.contextSources
      .filter((contextSource) =>
        contextSource.appId === source.appUuid ||
        contextSource.appSlug === source.appSlug ||
        contextSource.defaultForWidgets?.includes(source.widgetName)
      )
      .slice(0, 12);
  }, [index, source.appSlug, source.appUuid, source.widgetName]);

  const actions: WidgetComposerAction[] = surface?.actions.length
    ? surface.actions
    : widgetDefinition?.agentActions ?? [];

  const insertPromptFragment = useCallback((fragment: string) => {
    setValue((prev) => {
      const prefix = prev.trim() ? `${prev.trim()} ` : '';
      return `${prefix}${fragment}`;
    });
    setScopeOpen(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const send = useCallback(async () => {
    const message = value.trim();
    if (!message || isLoading) return;

    const currentSurface = getWidgetSurface(surfaceId) ?? surface;
    const activeWidgetContexts = currentSurface
      ? [buildActiveWidgetContext(currentSurface)]
      : [];

    const userTurn: ComposerTurn = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
    };
    setTurns((prev) => [...prev, userTurn]);
    setValue('');
    setIsLoading(true);
    setStatus('Thinking...');

    let assistantContent = '';
    let latestStatus = 'Thinking...';
    const assistantId = crypto.randomUUID();
    const conversationHistory = turns.map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));

    try {
      const matchedAction = currentSurface ? findActionForMessage(message, actions) : null;
      if (matchedAction) {
        if (shouldConfirmAction(matchedAction)) {
          const confirmed = typeof window === 'undefined'
            ? true
            : window.confirm(
              `${matchedAction.label}\n\n${matchedAction.description || 'This will run a widget action.'}`,
            );
          if (!confirmed) {
            assistantContent = `${matchedAction.label} cancelled.`;
            return;
          }
        }

        latestStatus = `Running ${matchedAction.label}...`;
        setStatus(latestStatus);
        const result = await invokeWidgetSurfaceAction({
          surface_id: surfaceId,
          widget_id: source.widgetName,
          action_id: matchedAction.id,
          args: buildActionArgs(matchedAction, message),
          turn_id: userTurn.id,
          source: 'agent',
        });
        assistantContent = summarizeActionResult(matchedAction, result);
        setStatus(null);
        return;
      }

      for await (const event of streamOrchestrate({
        message,
        conversationHistory,
        scope: source.appSlug
          ? {
            [source.appSlug]: {
              access: 'all',
            },
          }
          : undefined,
        activeWidgetContexts,
        conversationId: `widget:${surfaceId}`,
        userMessageId: userTurn.id,
        assistantMessageId: assistantId,
      })) {
        if (event.type === 'flash_status' || event.type === 'heavy_status' || event.type === 'status') {
          latestStatus = event.text || event.message || 'Working...';
          setStatus(latestStatus);
        } else if (event.type === 'flash_direct') {
          assistantContent = event.content || '';
          setStatus(null);
        } else if (event.type === 'heavy_text' || event.type === 'text') {
          assistantContent = appendText(assistantContent, event.content || event.text || '');
          setStatus(null);
        } else if (event.type === 'exec_result') {
          if (!assistantContent && event.data !== undefined) {
            assistantContent = typeof event.data === 'string'
              ? event.data
              : JSON.stringify(event.data, null, 2);
          }
        } else if (event.type === 'plan_ready') {
          latestStatus = 'Plan ready';
          setStatus('Plan ready');
        } else if (event.type === 'error') {
          assistantContent = event.message || event.error || 'Widget composer request failed.';
          setStatus(null);
        } else if (event.type === 'done') {
          break;
        }
      }
    } catch (err) {
      assistantContent = err instanceof Error ? err.message : 'Widget composer request failed.';
    } finally {
      setTurns((prev) => [
        ...prev,
        {
          id: assistantId,
          role: 'assistant',
          content: assistantContent || latestStatus || 'Done.',
        },
      ]);
      setStatus(null);
      setIsLoading(false);
    }
  }, [actions, isLoading, source.appSlug, source.widgetName, surface, surfaceId, turns, value]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const title = surface?.snapshot?.title || widgetDefinition?.label || source.appName || source.widgetName;
  const currentView = surface?.snapshot?.current_view;

  return (
    <div className="border-t border-gray-200 bg-white shrink-0">
      {turns.length > 0 && (
        <div className="max-h-36 overflow-y-auto border-b border-gray-100 px-3 py-2 space-y-1.5">
          {turns.slice(-4).map((turn) => (
            <div key={turn.id} className="flex gap-2 text-xs leading-relaxed">
              <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-gray-300 shrink-0" />
              <div className="min-w-0">
                <span className="font-medium text-gray-800">
                  {turn.role === 'user' ? 'You' : title}
                </span>
                <span className="text-gray-500"> · </span>
                <span className="text-gray-700 whitespace-pre-wrap break-words">{turn.content}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="px-3 pt-2 pb-2">
        <div className="mb-2 flex items-center gap-1.5 overflow-x-auto">
          <button
            type="button"
            onClick={() => setScopeOpen((open) => !open)}
            className="flex h-7 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
            title="Widget scope"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.7} />
            <span className="max-w-32 truncate">{title}</span>
          </button>
          {currentView && (
            <span className="h-7 rounded-md border border-gray-100 bg-gray-50 px-2 py-1 text-xs text-gray-500">
              {currentView}
            </span>
          )}
          {actions.length > 0 && (
            <span className="h-7 rounded-md border border-gray-100 bg-gray-50 px-2 py-1 text-xs text-gray-500">
              {actions.length} actions
            </span>
          )}
          {appFunctions.length > 0 && (
            <span className="h-7 rounded-md border border-gray-100 bg-gray-50 px-2 py-1 text-xs text-gray-500">
              {appFunctions.length} tools
            </span>
          )}
        </div>

        {scopeOpen && (
          <div className="mb-2 max-h-52 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
              <div className="text-xs font-semibold text-gray-800">Context index</div>
              <button
                type="button"
                onClick={() => setScopeOpen(false)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                title="Close"
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.7} />
              </button>
            </div>

            {actions.length > 0 && (
              <div className="py-1">
                <div className="px-3 py-1 text-[10px] font-mono uppercase text-gray-400">Widget actions</div>
                {actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    onClick={() => insertPromptFragment(`Use ${action.label}.`)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-50"
                  >
                    <MousePointerClick className="h-3.5 w-3.5 text-gray-400" strokeWidth={1.7} />
                    <span className="min-w-0 flex-1 truncate text-gray-700">{action.label}</span>
                    <span className="text-[10px] font-mono text-gray-400">{action.mode}</span>
                  </button>
                ))}
              </div>
            )}

            {appContextSources.length > 0 && (
              <div className="border-t border-gray-100 py-1">
                <div className="px-3 py-1 text-[10px] font-mono uppercase text-gray-400">App data</div>
                {appContextSources.map((contextSource) => (
                  <button
                    key={contextSource.id}
                    type="button"
                    onClick={() => insertPromptFragment(`Search ${contextSource.label} for `)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-50"
                  >
                    <Database className="h-3.5 w-3.5 text-gray-400" strokeWidth={1.7} />
                    <span className="min-w-0 flex-1 truncate text-gray-700">{contextSource.label}</span>
                    <span className="text-[10px] font-mono text-gray-400">{contextSource.type}</span>
                  </button>
                ))}
              </div>
            )}

            {appFunctions.length > 0 && (
              <div className="border-t border-gray-100 py-1">
                <div className="px-3 py-1 text-[10px] font-mono uppercase text-gray-400">MCP functions</div>
                {appFunctions.map(([fnName, fn]) => (
                  <button
                    key={fnName}
                    type="button"
                    onClick={() => insertPromptFragment(`Use ${fn.fnName}.`)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-50"
                  >
                    <Wrench className="h-3.5 w-3.5 text-gray-400" strokeWidth={1.7} />
                    <span className="min-w-0 flex-1 truncate text-gray-700">
                      {summarizeFunction(fnName, fn)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex items-end gap-2 rounded-lg border border-gray-200 bg-white px-2 py-2 focus-within:border-gray-300 focus-within:shadow-sm">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={isLoading}
            placeholder="Ask about this widget..."
            className="min-h-8 flex-1 resize-none border-0 bg-transparent px-1 py-1 text-sm text-gray-900 outline-none placeholder:text-gray-400 disabled:opacity-60"
          />
          {voice.supported && !isLoading && (
            <button
              type="button"
              onClick={() => void voice.toggle()}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors ${
                voice.listening
                  ? 'bg-gray-900 text-white'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
              }`}
              title={voice.listening ? 'Stop dictation' : 'Dictate'}
              aria-label={voice.listening ? 'Stop dictation' : 'Dictate'}
            >
              <Mic className="h-4 w-4" strokeWidth={1.8} />
            </button>
          )}
          <button
            type="button"
            onClick={() => void send()}
            disabled={isLoading || !value.trim()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gray-900 text-white transition-colors hover:bg-gray-700 disabled:bg-gray-200 disabled:text-gray-400"
            title={isLoading ? 'Working' : 'Send'}
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
            ) : (
              <Send className="h-4 w-4" strokeWidth={1.8} />
            )}
          </button>
        </div>
        {status && (
          <div className="mt-1.5 text-xs text-gray-500">{status}</div>
        )}
        {(voice.interimTranscript || voice.error) && (
          <div className="mt-1.5 text-xs text-gray-500" aria-live="polite">
            {voice.interimTranscript || voice.error}
          </div>
        )}
      </div>
    </div>
  );
}
