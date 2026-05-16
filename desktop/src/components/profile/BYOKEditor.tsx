// BYOKEditor — B16 inline editor for BYOK provider keys.
//
// Ports BB_B16_KeyEditor from handoff/mockups/batch-b.jsx. Replaces the
// previous read-only BYOK block in ProfileView's Settings tab.
//
// Four fixed providers (Anthropic / OpenAI / OpenRouter / DeepSeek).
// Each row exposes:
//   • 32×32 brand glyph
//   • Provider name + Connected/No-key status pill
//   • Masked key + last-used line when configured; tagline when empty
//   • + Add key (empty) or Replace + remove icon (connected)
//
// Expanding a row reveals an inline panel with a masked input (eye-toggle
// reveals), Save + Cancel, and an 11px helper line. Save runs the
// verify-on-save probe in lib/byok.ts before persisting to the keychain.
//
// Keys live in the OS keychain via the secure_*_secret Tauri commands
// (one entry per provider, allowlisted on the Rust side). Diverged from
// the addendum's `~/.ultralight/byok.json` filesystem suggestion — see
// lib/byok.ts header.

import { useEffect, useState } from 'react';
import { Eye, EyeOff, Trash2 } from 'lucide-react';
import {
  BYOK_PROVIDERS,
  type BYOKProvider,
  type BYOKProviderInfo,
  getBYOKKey,
  setBYOKKey,
  clearBYOKKey,
  verifyBYOKKey,
  maskBYOKKey,
} from '../../lib/byok';

interface RowStatus {
  connected: boolean;
  masked: string | null;
}

type StatusMap = Record<BYOKProvider, RowStatus>;

const EMPTY_STATUS: StatusMap = {
  anthropic: { connected: false, masked: null },
  openai: { connected: false, masked: null },
  openrouter: { connected: false, masked: null },
  deepseek: { connected: false, masked: null },
};

export default function BYOKEditor() {
  const [status, setStatus] = useState<StatusMap>(EMPTY_STATUS);
  const [openId, setOpenId] = useState<BYOKProvider | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);

  // Initial load — read every provider's keychain entry in parallel,
  // mask whatever's there so we never hold a plaintext key in memory
  // outside the editor's input.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        BYOK_PROVIDERS.map(async (p) => {
          const raw = await getBYOKKey(p.id);
          return [p.id, raw ? { connected: true, masked: maskBYOKKey(raw) } : { connected: false, masked: null }] as const;
        }),
      );
      if (cancelled) return;
      const next: StatusMap = { ...EMPTY_STATUS };
      for (const [id, s] of entries) next[id] = s;
      setStatus(next);
      setLoadingStatus(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connectedCount = Object.values(status).filter((s) => s.connected).length;

  const onSaved = (provider: BYOKProvider, rawKey: string) => {
    setStatus((prev) => ({
      ...prev,
      [provider]: { connected: true, masked: maskBYOKKey(rawKey) },
    }));
    setOpenId(null);
  };

  const onRemoved = (provider: BYOKProvider) => {
    setStatus((prev) => ({ ...prev, [provider]: { connected: false, masked: null } }));
    setOpenId(null);
  };

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-body-lg font-semibold tracking-tight">Bring your own AI keys</div>
        <div className="text-nano font-mono text-ul-text-muted">
          {loadingStatus ? '…' : `${connectedCount} of ${BYOK_PROVIDERS.length} connected`}
        </div>
      </div>
      <p className="text-caption text-ul-text-secondary leading-relaxed mb-5">
        Calls to these providers route through your key — no per-token markup.
        Keys live in the OS keychain (Tauri secure storage) on your device.
        Rotate or remove any time.
      </p>

      <div className="border border-ul-border rounded-lg overflow-hidden">
        {BYOK_PROVIDERS.map((info, i) => (
          <BYOKRow
            key={info.id}
            info={info}
            status={status[info.id]}
            isOpen={openId === info.id}
            isFirst={i === 0}
            onExpand={() => setOpenId(openId === info.id ? null : info.id)}
            onCancel={() => setOpenId(null)}
            onSaved={onSaved}
            onRemoved={onRemoved}
          />
        ))}
      </div>

      <div className="mt-4 p-3 bg-ul-bg-raised border border-ul-border rounded-md text-nano text-ul-text-secondary leading-relaxed">
        <strong className="text-ul-text">Routing.</strong> When you select a model,
        Ultralight prefers your own key if one is connected for that provider.
        Otherwise it falls back to the platform key and meters ✦ per call.
      </div>
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────

interface BYOKRowProps {
  info: BYOKProviderInfo;
  status: RowStatus;
  isOpen: boolean;
  isFirst: boolean;
  onExpand: () => void;
  onCancel: () => void;
  onSaved: (provider: BYOKProvider, rawKey: string) => void;
  onRemoved: (provider: BYOKProvider) => void;
}

function BYOKRow({ info, status, isOpen, isFirst, onExpand, onCancel, onSaved, onRemoved }: BYOKRowProps) {
  return (
    <div
      className={`${isFirst ? '' : 'border-t border-ul-border'} ${isOpen ? 'bg-ul-bg-raised' : 'bg-ul-bg'}`}
    >
      <div className="flex items-center gap-3.5 px-4 py-3.5">
        <div
          className="w-8 h-8 rounded-md text-white inline-flex items-center justify-center font-mono font-bold flex-shrink-0"
          style={{
            background: info.tone,
            fontSize: 13,
            letterSpacing: '-0.02em',
          }}
        >
          {info.glyph}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-small font-semibold">{info.name}</span>
            {status.connected ? (
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
          </div>
          <div className={`text-caption text-ul-text-secondary truncate ${status.connected ? 'font-mono' : ''}`}>
            {status.connected ? status.masked : info.tagline}
          </div>
        </div>
        <div className="flex gap-1.5 flex-shrink-0">
          {status.connected ? (
            <>
              <button
                type="button"
                onClick={onExpand}
                className="px-2.5 py-1.5 text-caption text-ul-text bg-transparent border border-ul-border rounded-sm cursor-pointer hover:bg-ul-bg-hover"
              >
                Replace
              </button>
              <button
                type="button"
                onClick={() => void handleRemove(info.id, onRemoved)}
                title="Remove key"
                aria-label="Remove key"
                className="w-8 h-[30px] text-ul-text-secondary bg-transparent border border-ul-border rounded-sm cursor-pointer inline-flex items-center justify-center hover:bg-ul-bg-hover"
              >
                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.7} />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onExpand}
              className="px-3 py-1.5 text-caption text-white bg-ul-text border-none rounded-sm cursor-pointer font-medium hover:bg-ul-accent-hover"
            >
              + Add key
            </button>
          )}
        </div>
      </div>
      {isOpen && (
        <BYOKEditPanel
          info={info}
          isReplacing={status.connected}
          onCancel={onCancel}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

async function handleRemove(provider: BYOKProvider, onRemoved: (p: BYOKProvider) => void) {
  try {
    await clearBYOKKey(provider);
    onRemoved(provider);
  } catch {
    // Keychain remove failure is rare and recoverable on retry; the row
    // stays in connected state so the user can try again. We don't
    // surface a toast here — the inline UI is the only signal channel.
  }
}

// ── Edit panel ───────────────────────────────────────────────────────

interface BYOKEditPanelProps {
  info: BYOKProviderInfo;
  isReplacing: boolean;
  onCancel: () => void;
  onSaved: (provider: BYOKProvider, rawKey: string) => void;
}

function BYOKEditPanel({ info, isReplacing, onCancel, onSaved }: BYOKEditPanelProps) {
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSave = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);

    const verify = await verifyBYOKKey(info.id, trimmed);
    if (!verify.ok) {
      setError(verify.message ?? 'Verification failed.');
      setSaving(false);
      return;
    }

    try {
      await setBYOKKey(info.id, trimmed);
      onSaved(info.id, trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key to keychain.');
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
            placeholder={`${info.keyPrefix}…`}
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
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={!draft.trim() || saving}
          className="px-3.5 py-2 text-caption text-white bg-ul-text border-none rounded-sm cursor-pointer font-medium hover:bg-ul-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? 'Verifying…' : 'Save'}
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
      <div className="mt-2 text-nano text-ul-text-muted leading-relaxed">
        Key is verified with a test call before save. Never leaves your machine
        in plaintext.
      </div>
    </div>
  );
}
