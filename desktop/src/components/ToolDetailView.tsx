// ToolDetailView — native tool / app detail page.
//
// Ports `PToolPage` from handoff/mockups/tool-page.jsx. Replaces the
// embedded WebPanel /app/:appId iframe.
//
// Layout:
//   Breadcrumb · MARKETPLACE · {CATEGORY} · {NAME}
//   Avatar (Glyph) + Name + "by @owner · category" + tagline
//   [ Install ]  [ Acquire ]
//   ┌── Functions table ──────────┐  ┌─ Side rail ─┐
//   │ name(args)  ✦/call  latency │  │ For sale /  │
//   │   [expand] -> sandbox       │  │ Not for sale│
//   │ ...                         │  │ Bids list   │
//   └─────────────────────────────┘  │ Revenue     │
//   ┌── Capabilities pills ───────┐  └─────────────┘
//
// Scope notes (see DESIGN-FOLLOWUPS.md):
//   - Sandbox runner: rendered as placeholder; real `ul.call` execution
//     requires permissions handling and is a follow-up batch.
//   - Side rail: ask price / bids / revenue not on the App type today —
//     side rail renders the "Not for sale" placeholder.
//   - Install / Acquire buttons: visual only — wiring requires the
//     marketplace acquisition flow which is Batch 4.

import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import Glyph, { deriveGlyph, deriveTone } from './ui/Glyph';
import { fetchFromApi, getToken } from '../lib/storage';
import type { App, SkillFunction, PermissionDeclaration } from '../../../shared/types/index';

interface ToolDetailViewProps {
  appId: string;
  /** Optional name to render while the full app payload loads. */
  fallbackName?: string;
}

// ── Fetch ─────────────────────────────────────────────────────────────

async function fetchApp(appId: string): Promise<App | null> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchFromApi(`/api/apps/${encodeURIComponent(appId)}`, { headers });
  if (!res.ok) return null;
  const data = (await res.json()) as { app?: App } | App;
  // Tolerate either { app: App } or App at top level.
  if (data && typeof data === 'object' && 'app' in data && data.app) {
    return data.app as App;
  }
  return data as App;
}

// ── Helpers ───────────────────────────────────────────────────────────

function parseFunctionArgs(parameters: Record<string, unknown> | undefined): string {
  if (!parameters || typeof parameters !== 'object') return '()';
  const keys = Object.keys(parameters);
  if (keys.length === 0) return '()';
  return `(${keys.join(', ')})`;
}

// Permission strings look like "memory:read" / "net:api.openai.com" / "ai:call".
// Map the kind prefix to a tone + arrow glyph matching the mockup palette.
const CAP_TONES: Record<string, { tone: string; arrow: string; label: string }> = {
  read: { tone: '#3b82f6', arrow: '↘', label: 'read' },
  write: { tone: '#f59e0b', arrow: '↗', label: 'write' },
  net: { tone: '#8b5cf6', arrow: '⇄', label: 'net' },
  ai: { tone: '#7c3aed', arrow: '✦', label: 'ai' },
  memory: { tone: '#3b82f6', arrow: '↘', label: 'memory' },
  storage: { tone: '#22c55e', arrow: '↗', label: 'storage' },
  gpu: { tone: '#ef4444', arrow: '⚡', label: 'gpu' },
};

function classifyPermission(p: PermissionDeclaration): { tone: string; arrow: string; label: string; detail: string } {
  const [head, ...rest] = p.permission.split(':');
  const meta = CAP_TONES[head] ?? { tone: '#9a9a9a', arrow: '·', label: head };
  return { ...meta, detail: rest.join(':') || p.description || p.permission };
}

// ── Subcomponents ─────────────────────────────────────────────────────

function FunctionRow({
  fn,
  isLast,
  defaultOpen,
}: {
  fn: SkillFunction;
  isLast: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={isLast ? '' : 'border-b border-ul-border'}>
      <div
        onClick={() => setOpen((o) => !o)}
        className="grid grid-cols-[1fr_110px_80px_24px] items-center gap-4 py-2.5 px-1 cursor-pointer"
      >
        <div className="min-w-0">
          <div className="font-mono text-small text-ul-text font-medium">
            {fn.name}
            <span className="text-ul-text-muted font-normal">{parseFunctionArgs(fn.parameters)}</span>
          </div>
          <div className="text-caption text-ul-text-secondary mt-0.5 truncate">{fn.description}</div>
        </div>
        {/* TODO(data): per-function price/call not in skills_parsed today — placeholder. */}
        <div className="font-mono text-caption text-ul-text-muted tabular-nums text-left">
          ✦—<span className="text-ul-text-muted">/call</span>
        </div>
        {/* TODO(data): per-function latency not in skills_parsed today — placeholder. */}
        <div className="font-mono text-micro text-ul-text-muted tabular-nums text-center">—</div>
        <ChevronRight
          className={`w-3.5 h-3.5 text-ul-text-muted transition-transform duration-base ${open ? 'rotate-90' : ''}`}
          strokeWidth={1.5}
        />
      </div>
      {open && (
        <div className="px-1 pb-3.5 pt-1 animate-fade-up">
          <SandboxPlaceholder fn={fn} />
        </div>
      )}
    </div>
  );
}

function SandboxPlaceholder({ fn }: { fn: SkillFunction }) {
  // TODO(scope): Real `ul.call` sandbox requires per-app permission handling
  // (DESIGN-FOLLOWUPS A7). Until then, show the function signature + a
  // disabled Run button so users can see the shape of the call.
  const paramKeys =
    fn.parameters && typeof fn.parameters === 'object' ? Object.keys(fn.parameters) : [];
  return (
    <div className="border border-ul-border bg-ul-bg overflow-hidden">
      <div className="p-3.5 grid grid-cols-2 gap-4 items-stretch">
        <div className="flex flex-col">
          <div className="text-micro text-ul-text-muted mb-1.5 font-mono">arguments</div>
          <div className="flex flex-col gap-2">
            {paramKeys.length === 0 ? (
              <div className="text-caption text-ul-text-muted italic">no arguments</div>
            ) : (
              paramKeys.map((k) => (
                <label key={k} className="text-caption text-ul-text-secondary">
                  {k}
                  <input
                    disabled
                    placeholder={`(${k})`}
                    className="block w-full box-border mt-1 px-2.5 py-2 border border-ul-border text-small font-sans outline-none bg-ul-bg-subtle text-ul-text-muted"
                  />
                </label>
              ))
            )}
            <button
              disabled
              className="mt-1 w-full box-border px-3.5 py-2 bg-ul-bg text-ul-text-muted border border-ul-border text-caption font-medium cursor-not-allowed inline-flex items-center justify-center gap-1.5"
              title="Sandbox runner ships in a follow-up batch"
            >
              Run <span className="font-mono opacity-50">↵</span>
            </button>
          </div>
        </div>
        <div className="flex flex-col">
          <div className="text-micro text-ul-text-muted mb-1.5 font-mono">output sandbox</div>
          <pre className="m-0 p-2.5 bg-ul-text text-emerald-300 text-micro font-mono flex-1 leading-relaxed overflow-auto whitespace-pre-wrap">
            // Sandbox runner arrives in a follow-up batch.
          </pre>
        </div>
      </div>
    </div>
  );
}

function CapabilityPill({ cap }: { cap: PermissionDeclaration }) {
  const { tone, arrow, label, detail } = classifyPermission(cap);
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 bg-ul-bg-raised border border-ul-border rounded-md">
      <span className="font-mono text-micro font-semibold" style={{ color: tone }}>
        {arrow} {label}
      </span>
      <span className="text-caption text-ul-text-secondary">{detail}</span>
    </div>
  );
}

function SideRail() {
  // TODO(data): Marketplace listing (ask, bids, revenue) not on App type today.
  // Renders "Not for sale" placeholder until marketplace BE lands (Batch 4).
  return (
    <aside className="sticky top-6 self-start">
      <div className="border border-ul-border rounded-lg overflow-hidden bg-ul-bg">
        <div className="px-4 py-3.5 border-b border-ul-border bg-ul-bg-raised">
          <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest mb-1">
            Not for sale
          </div>
          <div className="text-small text-ul-text-secondary leading-tight">
            Owner hasn't set an ask. Marketplace ask / bid surfaces arrive with the marketplace batch.
          </div>
        </div>
        <div className="px-3.5 py-2.5 text-micro text-ul-text-muted italic leading-relaxed">
          Revenue is private.
        </div>
      </div>
    </aside>
  );
}

// ── ToolDetailView ────────────────────────────────────────────────────

export default function ToolDetailView({ appId, fallbackName }: ToolDetailViewProps) {
  const [app, setApp] = useState<App | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchApp(appId)
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setError('Tool not found');
        } else {
          setApp(result);
        }
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [appId]);

  const displayName = app?.name || fallbackName || 'Loading…';
  const functions = app?.skills_parsed?.functions ?? [];
  const permissions = app?.declared_permissions ?? app?.skills_parsed?.permissions ?? [];
  const tagline = app?.description || app?.skills_parsed?.description || '';
  const category = app?.category || 'tool';
  const slug = app?.slug || appId;

  return (
    <div className="bg-ul-bg h-full overflow-auto font-sans">
      <div className="max-w-[1080px] mx-auto px-8 pt-8 pb-16">
        {/* Breadcrumb */}
        <div className="text-micro font-mono text-ul-text-muted mb-4 tracking-wider">
          MARKETPLACE · {category.toUpperCase()} · {slug.toUpperCase()}
        </div>

        {/* Title + tagline + actions */}
        <div className="mb-9 max-w-[720px]">
          <div className="flex items-center gap-3.5 mb-3">
            <Glyph glyph={deriveGlyph(displayName)} tone={deriveTone(app?.id || appId)} size={44} />
            <div>
              <div className="text-h1 text-ul-text leading-none tracking-tighter">{displayName}</div>
              <div className="text-small text-ul-text-secondary mt-1">
                {app ? <>by @{app.owner_id.slice(0, 8)} · {category}</> : <>&nbsp;</>}
              </div>
            </div>
          </div>
          {tagline && (
            <div className="text-body-lg text-ul-text leading-relaxed mb-4">{tagline}</div>
          )}
          {/* Install + Acquire — visual only this batch. Real wiring is Batch 4. */}
          <div className="flex gap-2">
            <button
              disabled={!app}
              className="px-5 py-3 bg-ul-text text-white border-none rounded-lg text-body font-medium cursor-pointer inline-flex items-center justify-center gap-1.5 transition-all disabled:opacity-40 hover:bg-ul-accent-hover"
              title="Install wiring arrives with marketplace batch"
            >
              <span>Install</span>
              {app && app.total_runs > 0 && (
                <span className="font-mono font-normal text-small opacity-60">
                  ({app.total_runs.toLocaleString()})
                </span>
              )}
            </button>
            <button
              disabled={!app}
              className="px-5 py-3 bg-ul-bg text-ul-text border border-ul-border rounded-lg text-body font-medium cursor-pointer inline-flex items-center justify-center gap-1.5 hover:bg-ul-bg-hover disabled:opacity-40"
              title="Acquire wiring arrives with marketplace batch"
            >
              <span>Acquire</span>
              <span className="text-ul-text-muted font-mono font-normal text-small">(make offer)</span>
            </button>
          </div>
        </div>

        {/* Loading / error states */}
        {loading && !app ? (
          <div className="text-caption text-ul-text-muted">Loading tool…</div>
        ) : error ? (
          <div className="text-caption text-ul-error">{error}</div>
        ) : app ? (
          <div className="grid grid-cols-[1fr_320px] gap-8 items-start">
            <div className="min-w-0">
              {/* Functions */}
              <div className="mb-8">
                <div className="mb-2">
                  <div className="grid grid-cols-[1fr_110px_80px_24px] gap-4 px-1 pb-2 border-b border-ul-border text-micro font-mono text-ul-text-muted uppercase tracking-wider">
                    <span>Function ({functions.length})</span>
                    <span className="text-left">Price/call</span>
                    <span className="text-center">Latency</span>
                    <span></span>
                  </div>
                </div>
                <div>
                  {functions.length === 0 ? (
                    <div className="px-1 py-3.5 text-caption text-ul-text-muted">
                      No function metadata published yet.
                    </div>
                  ) : (
                    functions.map((f, i) => (
                      <FunctionRow
                        key={f.name}
                        fn={f}
                        isLast={i === functions.length - 1}
                        defaultOpen={i === 0}
                      />
                    ))
                  )}
                </div>
              </div>

              {/* Capabilities */}
              <div>
                <div className="text-body-lg font-semibold tracking-tight mb-3">Capabilities</div>
                {permissions.length === 0 ? (
                  <div className="text-caption text-ul-text-muted">No capabilities declared.</div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {permissions.map((c, i) => (
                      <CapabilityPill key={i} cap={c} />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <SideRail />
          </div>
        ) : null}
      </div>
    </div>
  );
}
