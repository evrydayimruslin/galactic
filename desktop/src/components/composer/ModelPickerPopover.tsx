// Model picker popover — provider list + per-provider model catalog +
// search-and-paste. Renders for both Flash and Heavy tiers; the tier only
// determines the persistence target (setInterpreterModel vs setHeavyModel)
// since the BE doesn't distinguish flash/heavy at the model level.
//
// Data: ChatInferenceOptionsResponse from /chat/inference-options.
// The "light" option is rendered as a virtual "Ultralight" provider on top
// of the real BYOK providers, matching the mockup's mental model.

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type {
  ChatInferenceOptionsResponse,
  ChatInferenceLightOption,
  ChatInferenceProviderOption,
} from '../../../../shared/contracts/ai';
import type { BYOKModel } from '../../../../shared/types/index';
import Popover from './Popover';

interface ModelPickerPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  tier: 'flash' | 'heavy';
  /** null while inference settings load. */
  options: ChatInferenceOptionsResponse | null;
  /** Currently-selected model id for this tier (from storage). */
  selectedModel: string;
  /** Called when user picks a model id (catalog or custom paste). */
  onPick: (modelId: string) => void;
}

interface ProviderRow {
  id: string;
  name: string;
  description: string;
  status: { kind: 'light'; balanceLight: number | null; usable: boolean } | { kind: 'byok'; configured: boolean };
  models: BYOKModel[];
}

/** Returns true when any model in the catalog carries the B1 `tier`
 *  annotation. Drives the staged-rollout fallback: when no model is
 *  tagged we keep the legacy "both popovers show everything" behavior;
 *  once BE starts tagging, the filter kicks in automatically. */
function hasAnyTierAnnotation(options: ChatInferenceOptionsResponse): boolean {
  if (options.light.models.some((m) => m.tier !== undefined)) return true;
  return options.providers.some((p) => p.models.some((m) => m.tier !== undefined));
}

/** Match rule for a single tier — `'both'` and untagged models always
 *  pass; otherwise we require an exact tier hit. Untagged-as-pass keeps
 *  the picker usable during the partial rollout. */
function modelMatchesTier(model: BYOKModel, tier: 'flash' | 'heavy'): boolean {
  if (model.tier === undefined) return true;
  return model.tier === tier || model.tier === 'both';
}

function buildProviderRows(
  options: ChatInferenceOptionsResponse,
  tier: 'flash' | 'heavy',
): ProviderRow[] {
  const filterByTier = hasAnyTierAnnotation(options);
  const filterModels = (models: BYOKModel[]): BYOKModel[] =>
    filterByTier ? models.filter((m) => modelMatchesTier(m, tier)) : models;

  const rows: ProviderRow[] = [];
  const light: ChatInferenceLightOption = options.light;
  rows.push({
    id: '__light__',
    name: 'Ultralight',
    description: 'Light-denominated · pay per call',
    status: { kind: 'light', balanceLight: light.balanceLight, usable: light.usable },
    models: filterModels(light.models),
  });
  for (const p of options.providers as ChatInferenceProviderOption[]) {
    rows.push({
      id: p.id,
      name: p.name,
      description: p.description,
      status: { kind: 'byok', configured: p.configured },
      models: filterModels(p.models),
    });
  }
  return rows;
}

function findInitialProviderId(rows: ProviderRow[], selectedModel: string): string {
  for (const r of rows) {
    if (r.models.some((m) => m.id === selectedModel)) return r.id;
  }
  // Fallback to Ultralight (light option)
  return rows[0]?.id ?? '__light__';
}

function StatusBadge({ status }: { status: ProviderRow['status'] }) {
  if (status.kind === 'light') {
    const warn = !status.usable;
    const label = status.balanceLight !== null
      ? `${status.balanceLight.toLocaleString()}`
      : '—';
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-px rounded-full font-mono text-nano whitespace-nowrap ${
          warn ? 'bg-ul-error-soft text-ul-error' : 'bg-ul-success-soft text-ul-success-strong'
        }`}
      >
        <span className="font-semibold">✦</span>
        <span>{label}</span>
        {warn && <span>· top up</span>}
      </span>
    );
  }
  const connected = status.configured;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-px rounded-full font-mono text-nano whitespace-nowrap ${
        connected ? 'bg-ul-success-soft text-ul-success-strong' : 'bg-ul-accent-soft text-ul-text-muted'
      }`}
    >
      <span
        className="w-1 h-1 rounded-full"
        style={{ background: connected ? '#15803d' : '#9a9a9a', opacity: connected ? 1 : 0.6 }}
      />
      <span>{connected ? 'connected' : 'no key'}</span>
    </span>
  );
}

function ProviderRowDisplay({
  row,
  open,
  onClick,
}: {
  row: ProviderRow;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      className="flex items-center gap-2.5 px-3.5 py-1.5 cursor-pointer hover:bg-ul-bg-hover"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-caption font-medium text-ul-text">{row.name}</span>
          <StatusBadge status={row.status} />
        </div>
        <div className="text-nano text-ul-text-muted font-mono truncate">{row.description}</div>
      </div>
      <ChevronDown
        className={`w-3 h-3 text-ul-text-muted flex-shrink-0 transition-transform duration-base ${
          open ? 'rotate-180' : ''
        }`}
        strokeWidth={1.5}
      />
    </div>
  );
}

function ModelRow({
  model,
  selected,
  onPick,
}: {
  model: BYOKModel;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <div
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onPick(); }}
      className="flex items-center gap-2.5 px-3.5 py-1.5 cursor-pointer hover:bg-ul-bg-hover"
    >
      <div className="flex-1 min-w-0">
        <div className="text-caption font-medium text-ul-text truncate">{model.name}</div>
        <div className="text-nano text-ul-text-muted font-mono truncate">{model.id}</div>
      </div>
      <span
        className={`w-3.5 inline-flex justify-center text-caption ${
          selected ? 'text-ul-text' : 'text-transparent'
        }`}
      >
        ✓
      </span>
    </div>
  );
}

export default function ModelPickerPopover({
  open,
  onClose,
  anchorRef,
  tier,
  options,
  selectedModel,
  onPick,
}: ModelPickerPopoverProps) {
  const rows = useMemo(() => (options ? buildProviderRows(options, tier) : []), [options, tier]);

  // Selected provider + sub-list visibility
  const initialProvider = useMemo(
    () => (rows.length ? findInitialProviderId(rows, selectedModel) : '__light__'),
    [rows, selectedModel],
  );
  const [providerId, setProviderId] = useState<string>(initialProvider);
  // Re-anchor providerId when the catalog first loads or the selected model
  // changes from outside (e.g., user picks from the other tier). Effect (not
  // render-time setState) so React doesn't warn / loop.
  useEffect(() => {
    if (rows.length > 0 && !rows.some((r) => r.id === providerId)) {
      setProviderId(initialProvider);
    }
  }, [rows, providerId, initialProvider]);

  const [providerListOpen, setProviderListOpen] = useState(false);
  const [query, setQuery] = useState('');

  const current = rows.find((r) => r.id === providerId);
  const q = query.trim().toLowerCase();
  const filteredModels = useMemo(() => {
    if (!current) return [];
    if (!q) return current.models;
    return current.models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [current, q]);
  const showCustomPaste = q.length > 0 && filteredModels.length === 0;

  const tierLabel = tier === 'flash' ? 'Flash' : 'Heavy';
  const tierSub = tier === 'flash' ? 'Runs every turn' : 'On escalation';

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} align="right" width={340} maxHeight={480} flex>
      {/* Fixed header */}
      <div className="flex-shrink-0">
        <div className="px-3.5 pt-3 pb-2.5">
          <div className="text-caption font-bold text-ul-text">{tierLabel}</div>
          <div className="text-nano text-ul-text-muted font-mono uppercase mt-px">{tierSub}</div>
        </div>
        <div className="h-px bg-ul-border" />

        {/* Provider section */}
        <div className="px-3.5 pt-2.5 pb-1 text-nano text-ul-text-muted font-mono uppercase">
          Provider
        </div>
        {!options ? (
          <div className="px-3.5 py-1.5 text-micro text-ul-text-muted">Loading providers…</div>
        ) : current ? (
          <ProviderRowDisplay
            row={current}
            open={providerListOpen}
            onClick={() => setProviderListOpen((o) => !o)}
          />
        ) : null}

        {/* Provider sublist — animated reveal */}
        <div
          className="grid transition-all duration-slow ease-out"
          style={{
            gridTemplateRows: providerListOpen ? '1fr' : '0fr',
            opacity: providerListOpen ? 1 : 0,
          }}
        >
          <div className="min-h-0 overflow-hidden">
            {rows
              .filter((r) => r.id !== providerId)
              .map((r) => (
                <div
                  key={r.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setProviderId(r.id);
                    setProviderListOpen(false);
                    setQuery('');
                  }}
                  className="flex items-center gap-2.5 px-3.5 py-1.5 cursor-pointer hover:bg-ul-bg-hover"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-caption font-medium text-ul-text">{r.name}</span>
                      <StatusBadge status={r.status} />
                    </div>
                    <div className="text-nano text-ul-text-muted font-mono truncate">
                      {r.description}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </div>

        <div className="px-3.5 pt-2.5 pb-1 text-nano text-ul-text-muted font-mono uppercase">
          Model
        </div>
      </div>

      {/* Scrolling model list */}
      <div className="flex-1 min-h-0 overflow-y-auto pb-1.5">
        {!options ? null : filteredModels.length > 0 ? (
          filteredModels.map((m) => (
            <ModelRow
              key={m.id}
              model={m}
              selected={m.id === selectedModel}
              onPick={() => {
                onPick(m.id);
                onClose();
              }}
            />
          ))
        ) : showCustomPaste ? (
          <div className="px-3.5 py-1.5">
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onPick(query);
                setQuery('');
                onClose();
              }}
              // TODO(token): border-dashed via raw class — design wanted a dashed
              // border for the custom-paste CTA; no token covers dashed borders.
              className="w-full text-left px-2.5 py-1.5 text-micro font-semibold text-ul-text bg-ul-bg border border-dashed border-ul-border rounded-sm cursor-pointer hover:bg-ul-bg-hover"
            >
              Use <span className="font-mono">{query}</span> as {tierLabel}
            </button>
          </div>
        ) : (
          <div className="px-3.5 py-1.5 text-micro text-ul-text-muted">No matches.</div>
        )}
      </div>

      {/* Sticky search */}
      <div className="flex-shrink-0 px-3.5 pt-2 pb-2.5 border-t border-ul-border bg-ul-bg">
        <div className="flex items-center gap-1.5 px-2.5 py-1 border border-ul-border rounded-md">
          <Search className="w-3 h-3 text-ul-text-muted flex-shrink-0" strokeWidth={1.5} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search or paste a ${tierLabel} model…`}
            className="flex-1 border-none outline-none bg-transparent text-micro text-ul-text font-mono placeholder:text-ul-text-muted"
          />
          {query && (
            <button
              onMouseDown={(e) => { e.preventDefault(); setQuery(''); }}
              className="border-none bg-transparent text-ul-text-muted cursor-pointer text-caption leading-none font-mono p-0"
            >
              ×
            </button>
          )}
        </div>
      </div>
    </Popover>
  );
}
