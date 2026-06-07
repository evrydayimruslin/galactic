// BYOKEditor — server-backed BYOK provider settings.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Trash2 } from 'lucide-react';
import type { BYOKConfig } from '../../../../shared/types/index';
import {
  clearBYOKKey,
  decorateBYOKProvider,
  fetchBYOKConfig,
  saveBYOKKey,
  setPrimaryBYOKProvider,
  updateBYOKProvider,
  type BYOKProvider,
  type BYOKProviderInfo,
  type BYOKStatusResponse,
} from '../../lib/byok';

function configuredMask(info: BYOKProviderInfo): string {
  return info.keyPrefix ? `${info.keyPrefix}•••••••• encrypted` : 'Key encrypted server-side';
}

function formatAddedAt(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function BYOKEditor() {
  const [config, setConfig] = useState<BYOKStatusResponse | null>(null);
  const [openId, setOpenId] = useState<BYOKProvider | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [busyId, setBusyId] = useState<BYOKProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadingStatus(true);
    setError(null);
    try {
      setConfig(await fetchBYOKConfig());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load BYOK settings.');
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const providers = useMemo(
    () => (config?.available_providers ?? []).map(decorateBYOKProvider),
    [config],
  );
  const configsByProvider = useMemo(() => {
    const map = new Map<BYOKProvider, BYOKConfig>();
    for (const entry of config?.configs ?? []) {
      map.set(entry.provider as BYOKProvider, entry);
    }
    return map;
  }, [config]);
  const connectedCount = providers.filter((info) => configsByProvider.get(info.id)?.has_key).length;

  const refreshAfterMutation = useCallback(async () => {
    await load();
    setOpenId(null);
  }, [load]);

  const handleRemove = useCallback(async (provider: BYOKProvider) => {
    setBusyId(provider);
    setError(null);
    try {
      await clearBYOKKey(provider);
      await refreshAfterMutation();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove provider.');
    } finally {
      setBusyId(null);
    }
  }, [refreshAfterMutation]);

  const handlePrimary = useCallback(async (provider: BYOKProvider) => {
    setBusyId(provider);
    setError(null);
    try {
      await setPrimaryBYOKProvider(provider);
      await refreshAfterMutation();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set primary provider.');
    } finally {
      setBusyId(null);
    }
  }, [refreshAfterMutation]);

  const handleModel = useCallback(async (provider: BYOKProvider, model: string) => {
    setBusyId(provider);
    setError(null);
    try {
      await updateBYOKProvider(provider, { model, validate: false });
      await refreshAfterMutation();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update provider model.');
    } finally {
      setBusyId(null);
    }
  }, [refreshAfterMutation]);

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-body-lg font-semibold tracking-tight">Bring your own AI keys</div>
        <div className="text-nano font-mono text-ul-text-muted">
          {loadingStatus ? '...' : `${connectedCount} of ${providers.length} connected`}
        </div>
      </div>
      <p className="text-caption text-ul-text-secondary leading-relaxed mb-5">
        Route inference through your own provider account when available. Keys are validated by
        Ultralight, encrypted on the server, and never shown again after save.
      </p>

      {error && (
        <div className="mb-3 p-2.5 border border-ul-error-soft bg-ul-error-soft text-ul-error text-caption leading-relaxed rounded-md">
          {error}
        </div>
      )}

      <div className="border border-ul-border rounded-lg overflow-hidden">
        {providers.length === 0 && (
          <div className="px-4 py-4 text-caption text-ul-text-muted">
            {loadingStatus ? 'Loading providers...' : 'No BYOK providers are available.'}
          </div>
        )}
        {providers.map((info, i) => {
          const providerConfig = configsByProvider.get(info.id);
          return (
            <BYOKRow
              key={info.id}
              info={info}
              config={providerConfig}
              primary={config?.primary_provider === info.id && providerConfig?.has_key === true}
              isOpen={openId === info.id}
              isFirst={i === 0}
              busy={busyId === info.id}
              onExpand={() => setOpenId(openId === info.id ? null : info.id)}
              onCancel={() => setOpenId(null)}
              onSaved={refreshAfterMutation}
              onRemoved={() => void handleRemove(info.id)}
              onPrimary={() => void handlePrimary(info.id)}
              onModel={(model) => void handleModel(info.id, model)}
            />
          );
        })}
      </div>

      <div className="mt-4 p-3 bg-ul-bg-raised border border-ul-border rounded-md text-nano text-ul-text-secondary leading-relaxed">
        <strong className="text-ul-text">Routing.</strong> BYOK mode uses your primary provider
        by default. Light balance remains available for platform-routed calls.
      </div>
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────

interface BYOKRowProps {
  info: BYOKProviderInfo;
  config: BYOKConfig | undefined;
  primary: boolean;
  isOpen: boolean;
  isFirst: boolean;
  busy: boolean;
  onExpand: () => void;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onRemoved: () => void;
  onPrimary: () => void;
  onModel: (model: string) => void;
}

function BYOKRow({
  info,
  config,
  primary,
  isOpen,
  isFirst,
  busy,
  onExpand,
  onCancel,
  onSaved,
  onRemoved,
  onPrimary,
  onModel,
}: BYOKRowProps) {
  const connected = config?.has_key === true;
  const selectedModel = config?.model || info.defaultModel;
  const addedAt = formatAddedAt(config?.added_at);

  return (
    <div
      className={`${isFirst ? '' : 'border-t border-ul-border'} ${isOpen ? 'bg-ul-bg-raised' : 'bg-ul-bg'}`}
    >
      <div className="flex items-center gap-3.5 px-4 py-3.5">
        <div
          className="w-8 h-8 rounded-md text-white inline-flex items-center justify-center font-mono font-bold flex-shrink-0"
          style={{ background: info.tone, fontSize: 13 }}
        >
          {info.glyph}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-small font-semibold">{info.name}</span>
            {connected ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-xs bg-ul-success-soft text-ul-success-strong font-mono text-nano font-semibold uppercase tracking-[0.06em]">
                <span className="w-1 h-1 rounded-full bg-ul-success" />
                Connected
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-xs border border-ul-border text-ul-text-muted font-mono text-nano font-semibold uppercase tracking-[0.06em]">
                <span className="w-1 h-1 rounded-full bg-ul-border-strong" />
                No key
              </span>
            )}
            {primary && (
              <span className="inline-flex px-1.5 py-0.5 rounded-xs border border-ul-border text-ul-text font-mono text-nano font-semibold uppercase tracking-[0.06em]">
                Primary
              </span>
            )}
            {info.capabilities.webSearch && (
              <span className="inline-flex px-1.5 py-0.5 rounded-xs bg-ul-accent-soft text-ul-text-muted font-mono text-nano uppercase">
                Browsing
              </span>
            )}
          </div>
          <div className={`text-caption text-ul-text-secondary truncate ${connected ? 'font-mono' : ''}`}>
            {connected ? configuredMask(info) : info.tagline}
          </div>
          {connected && (
            <div className="mt-1 flex items-center gap-2 text-nano text-ul-text-muted">
              <select
                value={selectedModel}
                disabled={busy}
                onChange={(e) => onModel(e.target.value)}
                className="max-w-[260px] border border-ul-border bg-ul-bg rounded-sm px-1.5 py-0.5 font-mono text-nano text-ul-text-secondary"
              >
                {info.models.map((model) => (
                  <option key={model.id} value={model.id}>{model.name}</option>
                ))}
              </select>
              {addedAt && <span>added {addedAt}</span>}
            </div>
          )}
        </div>
        <div className="flex gap-1.5 flex-shrink-0">
          {connected && !primary && (
            <button
              type="button"
              disabled={busy}
              onClick={onPrimary}
              className="px-2.5 py-1.5 text-caption text-ul-text bg-transparent border border-ul-border rounded-sm cursor-pointer hover:bg-ul-bg-hover disabled:opacity-60"
            >
              Make primary
            </button>
          )}
          {connected ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={onExpand}
                className="px-2.5 py-1.5 text-caption text-ul-text bg-transparent border border-ul-border rounded-sm cursor-pointer hover:bg-ul-bg-hover disabled:opacity-60"
              >
                Replace
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onRemoved}
                title="Remove key"
                aria-label="Remove key"
                className="w-8 h-[30px] text-ul-text-secondary bg-transparent border border-ul-border rounded-sm cursor-pointer inline-flex items-center justify-center hover:bg-ul-bg-hover disabled:opacity-60"
              >
                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.7} />
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onExpand}
              className="px-3 py-1.5 text-caption text-white bg-ul-text border-none rounded-sm cursor-pointer font-medium hover:bg-ul-accent-hover disabled:opacity-60"
            >
              + Add key
            </button>
          )}
        </div>
      </div>
      {isOpen && (
        <BYOKEditPanel
          info={info}
          selectedModel={selectedModel}
          isReplacing={connected}
          onCancel={onCancel}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

// ── Edit panel ───────────────────────────────────────────────────────

interface BYOKEditPanelProps {
  info: BYOKProviderInfo;
  selectedModel: string;
  isReplacing: boolean;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}

function BYOKEditPanel({ info, selectedModel, isReplacing, onCancel, onSaved }: BYOKEditPanelProps) {
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState(selectedModel);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSave = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);

    try {
      await saveBYOKKey(info.id, trimmed, model, true);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save provider key.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-4 pb-4 pl-[62px] animate-fade-up">
      <div className="text-nano font-mono uppercase tracking-[0.06em] text-ul-text-muted mb-1.5">
        {isReplacing ? 'Replace key' : 'Paste API key'}
      </div>
      <div className="flex items-stretch gap-2">
        <div className="flex-1 flex items-center px-2.5 border border-ul-border rounded-sm bg-ul-bg">
          <input
            type={reveal ? 'text' : 'password'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`${info.keyPrefix || 'api-key'}...`}
            autoFocus
            disabled={saving}
            className="flex-1 border-none outline-none bg-transparent px-0 py-2 font-mono text-small text-ul-text"
            style={{ letterSpacing: reveal ? 0 : '0.05em' }}
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            title={reveal ? 'Hide key' : 'Show key'}
            disabled={saving}
            className="p-1.5 text-ul-text-muted bg-transparent border-none cursor-pointer inline-flex items-center"
          >
            {reveal ? (
              <EyeOff className="w-3.5 h-3.5" strokeWidth={1.7} />
            ) : (
              <Eye className="w-3.5 h-3.5" strokeWidth={1.7} />
            )}
          </button>
        </div>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={saving}
          className="max-w-[210px] border border-ul-border rounded-sm bg-ul-bg px-2 py-2 text-caption font-mono text-ul-text-secondary"
        >
          {info.models.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={!draft.trim() || saving}
          className="px-3.5 py-2 text-caption text-white bg-ul-text border-none rounded-sm cursor-pointer font-medium hover:bg-ul-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? 'Validating...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="px-3 py-2 text-caption text-ul-text-secondary bg-transparent border border-ul-border rounded-sm cursor-pointer disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
      {error && (
        <div className="mt-2 text-nano text-ul-error leading-relaxed">{error}</div>
      )}
      <div className="mt-2 flex items-center gap-2 text-nano text-ul-text-muted leading-relaxed">
        <span>Validated before save, then encrypted server-side.</span>
        <a
          href={info.apiKeyUrl}
          target="_blank"
          rel="noreferrer"
          className="text-ul-text-secondary underline underline-offset-[3px] hover:text-ul-text"
        >
          Get key
        </a>
      </div>
    </div>
  );
}
