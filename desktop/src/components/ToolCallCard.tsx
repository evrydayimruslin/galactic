// Tool call card — clean, non-technical display of tool invocations.
// For app calls: shows polished app name + human-readable action summary.
// Single expand layer with formatted details.

import { useState, useMemo, useEffect, useRef } from 'react';
import type { AccumulatedToolCall } from '../lib/sse';
import ToolResultRenderer from './tool-renderers';

interface ToolCallCardProps {
  toolCall: AccumulatedToolCall;
  result?: string;
  executing?: boolean;
  /** Post-hoc error message (BE telemetry status='error' / 'aborted' / 'timeout',
   *  or a content heuristic from MessageBubble until the BE pipes structured
   *  error metadata into the Message type). When set, the card renders the
   *  errored visual treatment instead of completed. */
  error?: string;
}

// ── Helpers ──

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Convert slug/kebab-case to Title Case: "resort-manager" → "Resort Manager" */
function toTitleCase(s: string): string {
  return s
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/** Build a human-readable action from function name + args.
 *  e.g. rooms_list({ room_number: "502" }) → "Checking room 502"
 *       guest_summary({ room_number: "835", guest_name: "Sato" }) → "Looking up guest Sato in room 835"
 */
function humanizeAction(fnName: string, args?: Record<string, unknown>): string {
  const name = fnName.toLowerCase();
  const vals = args ? Object.values(args).filter(v => v !== undefined && v !== null) : [];
  const firstVal = vals.length > 0 ? String(vals[0]) : '';
  const allVals = vals.map(v => String(v)).join(', ');

  // Common patterns
  if (name.includes('list') || name.includes('search') || name.includes('find'))
    return firstVal ? `Searching ${firstVal}` : 'Searching...';
  if (name.includes('get') || name.includes('lookup') || name.includes('check') || name.includes('status'))
    return firstVal ? `Checking ${firstVal}` : 'Checking...';
  if (name.includes('summary') || name.includes('detail') || name.includes('info'))
    return firstVal ? `Looking up ${allVals}` : 'Looking up details...';
  if (name.includes('create') || name.includes('add') || name.includes('new') || name.includes('book') || name.includes('reserve'))
    return firstVal ? `Creating ${firstVal}` : 'Creating...';
  if (name.includes('update') || name.includes('edit') || name.includes('modify') || name.includes('change'))
    return firstVal ? `Updating ${firstVal}` : 'Updating...';
  if (name.includes('delete') || name.includes('remove') || name.includes('cancel'))
    return firstVal ? `Removing ${firstVal}` : 'Removing...';
  if (name.includes('today') || name.includes('current') || name.includes('now'))
    return firstVal ? `Checking today's ${firstVal}` : `Checking today's ${toTitleCase(fnName.replace(/today|current|now/gi, '').trim())}`;
  if (name.includes('billing') || name.includes('payment') || name.includes('charge'))
    return firstVal ? `Checking billing for ${firstVal}` : 'Checking billing...';
  if (name.includes('history') || name.includes('log') || name.includes('activity'))
    return firstVal ? `Reviewing history for ${firstVal}` : 'Reviewing history...';

  // Fallback: convert function name to readable phrase
  const readable = fnName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return firstVal ? `${readable}: ${truncate(firstVal, 40)}` : readable;
}

/** Format non-app tool calls into human-readable descriptions */
function humanizeToolAction(name: string, args: Record<string, unknown>): { label: string; detail: string } {
  switch (name) {
    case 'ul_discover': {
      const query = String(args.query || args.search || '');
      const scope = String(args.scope || '');
      if (scope === 'inspect') return { label: 'Inspecting App', detail: '' };
      return { label: 'Discovering Apps', detail: query };
    }
    case 'file_read':
      return { label: 'Reading File', detail: String(args.path || '') };
    case 'file_write':
      return { label: 'Writing File', detail: String(args.path || '') };
    case 'file_edit':
      return { label: 'Editing File', detail: String(args.path || '') };
    case 'glob':
      return { label: 'Finding Files', detail: String(args.pattern || '') };
    case 'grep':
      return { label: 'Searching Code', detail: String(args.pattern || '') };
    case 'ls':
      return { label: 'Listing Directory', detail: String(args.path || '.') };
    case 'shell_exec':
      return { label: 'Running Command', detail: truncate(String(args.command || ''), 50) };
    case 'git':
      return { label: 'Git', detail: `${args.subcommand || ''}` };
    case 'spawn_agent':
      return { label: 'Creating Agent', detail: String(args.name || '') };
    case 'check_agent':
      return { label: 'Checking Agent', detail: '' };
    case 'update_card_status':
      return { label: 'Updating Card', detail: `→ ${args.status || ''}` };
    case 'ul_memory':
      return { label: 'Memory', detail: '' };
    default:
      return { label: toTitleCase(name), detail: '' };
  }
}

// ── Component ──

export default function ToolCallCard({ toolCall, result, executing, error }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const startTimeRef = useRef<number>(Date.now());
  const [elapsed, setElapsed] = useState(0);

  // Ring-resolve animation: fires once on executing -> completed transition.
  const prevExecutingRef = useRef(executing);
  const [resolving, setResolving] = useState(false);
  useEffect(() => {
    const wasExecuting = prevExecutingRef.current;
    prevExecutingRef.current = executing;
    if (wasExecuting && !executing && result) {
      setResolving(true);
      const timer = setTimeout(() => setResolving(false), 700);
      return () => clearTimeout(timer);
    }
  }, [executing, result]);

  const parsedArgs = useMemo(() => {
    try {
      return JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  }, [toolCall.function.arguments]);

  const name = toolCall.function.name;
  const isAppCall = name === 'ul_call';

  // Build display info
  const display = useMemo(() => {
    if (isAppCall) {
      const fnName = String(parsedArgs.function_name || parsedArgs.function || '');
      const fnArgs = parsedArgs.args as Record<string, unknown> | undefined;

      // Resolve app name: try to get from metadata, fall back to slug from app_id
      let appDisplayName = '';
      const appId = String(parsedArgs.app_id || '');
      // For UUID app_ids, we'll show the function action as primary
      // The app name will be resolved from connected apps context if available
      if (appId && !appId.includes('-')) {
        appDisplayName = toTitleCase(appId);
      }

      const action = humanizeAction(fnName, fnArgs);
      return { appName: appDisplayName, action, fnName, fnArgs };
    }
    const { label, detail } = humanizeToolAction(name, parsedArgs);
    return { appName: '', action: detail ? `${label}: ${detail}` : label, fnName: '', fnArgs: undefined };
  }, [isAppCall, name, parsedArgs]);

  // Timer
  useEffect(() => {
    if (!executing) return;
    startTimeRef.current = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - startTimeRef.current), 500);
    return () => clearInterval(timer);
  }, [executing]);

  useEffect(() => {
    if (result && !executing) setElapsed(Date.now() - startTimeRef.current);
  }, [result, executing]);

  // Rich result
  const richResult = result ? <ToolResultRenderer toolName={name} args={parsedArgs} result={result} /> : null;

  // Derived 4-state: errored takes precedence over executing/result.
  const isErrored = !!error;

  return (
    <div className={`my-2 rounded-lg overflow-hidden transition-colors animate-toolpop ${
      resolving && !isErrored ? 'animate-ring-resolve' : ''
    } ${
      isErrored
        ? 'border border-ul-error bg-ul-error-soft'
        // TODO(token): border-blue-200, blue-50/40, border-gray-150 — no exact ul-* equivalents; kept raw.
        : executing ? 'border border-blue-200 bg-gradient-to-r from-blue-50/40 to-transparent' : 'border border-gray-150'
    }`}>
      {/* Header — single clean row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50/50 transition-colors text-left"
      >
        {/* Status */}
        {isErrored ? (
          <svg className="w-3.5 h-3.5 text-ul-error flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : executing ? (
          <div className="w-3.5 h-3.5 rounded-full border-2 border-blue-300 border-t-blue-600 animate-spin flex-shrink-0" />
        ) : result ? (
          <svg className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <div className="w-3.5 h-3.5 rounded-full border-2 border-gray-300 flex-shrink-0" />
        )}

        {/* Action description */}
        <span className={`text-small flex-1 min-w-0 truncate ${
          isErrored ? 'text-ul-error' : executing ? 'text-blue-700' : 'text-ul-text-secondary'
        }`}>
          {display.action}
        </span>

        {/* Timing */}
        {elapsed > 0 && (
          // TODO(token): text-gray-400 — no exact ul-* equivalent; kept raw.
          <span className={`text-nano tabular-nums flex-shrink-0 ${executing ? 'text-ul-completed' : 'text-gray-400'}`}>
            {formatDuration(elapsed)}
          </span>
        )}

        {/* Chevron */}
        <svg
          className={`w-3 h-3 text-gray-300 transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded: details + result in single layer */}
      {expanded && (
        <div className={`border-t px-3 py-2 space-y-2 ${
          isErrored ? 'border-ul-error/30' : 'border-gray-100'
        }`}>
          {/* Error banner — prominent when present */}
          {isErrored && (
            <div className="bg-ul-error-soft border border-ul-error/30 rounded-md px-2.5 py-2 text-small text-ul-error font-mono whitespace-pre-wrap">
              {error}
            </div>
          )}
          {/* Formatted details — always visible when expanded */}
          {isAppCall ? (
            <div className="space-y-0.5">
              {display.fnName && (
                <div className="flex items-baseline gap-2">
                  <span className="text-nano text-gray-400 w-16 shrink-0">Function</span>
                  <span className="text-xs font-mono text-ul-text-secondary">{display.fnName}</span>
                </div>
              )}
              {display.fnArgs && Object.keys(display.fnArgs).length > 0 && (
                Object.entries(display.fnArgs).map(([k, v]) => (
                  <div key={k} className="flex items-baseline gap-2">
                    <span className="text-nano text-gray-400 w-16 shrink-0">{toTitleCase(k)}</span>
                    <span className="text-xs text-ul-text-secondary">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
                  </div>
                ))
              )}
            </div>
          ) : (
            <pre className="text-xs font-mono bg-ul-bg-sidebar rounded p-2 overflow-x-auto whitespace-pre-wrap text-ul-text-secondary">
              {JSON.stringify(parsedArgs, null, 2)}
            </pre>
          )}

          {/* Result */}
          {result && richResult ? (
            <div className="pt-1">{richResult}</div>
          ) : result ? (
            <pre className="text-xs font-mono bg-ul-bg-sidebar rounded-md p-2.5 overflow-x-auto whitespace-pre-wrap max-h-60 overflow-y-auto text-ul-text-secondary border border-gray-100">
              {result.length > 3000 ? result.slice(0, 3000) + '\n... (truncated)' : result}
            </pre>
          ) : executing ? (
            <div className="flex items-center gap-2 text-caption text-blue-500 py-1">
              <div className="w-3 h-3 rounded-full border-2 border-blue-300 border-t-blue-600 animate-spin" />
              Working...
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
