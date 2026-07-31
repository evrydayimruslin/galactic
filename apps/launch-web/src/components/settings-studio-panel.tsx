import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type {
  LaunchApiKeySummary,
  LaunchByokProviderOption,
  LaunchByokSummaryResponse,
  LaunchFleetAgentSummary,
  LaunchFleetPreferences,
  LaunchSubscriptionResponse,
} from '../../../../shared/contracts/launch.ts';
import type { LaunchPageProps } from '../App';
import {
  launchApi,
  launchApiOrigin,
} from '../lib/api';
import { markExternalReturnRevalidation } from '../lib/external-navigation';
import {
  createLaunchShortcutConfiguration,
  DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION,
  launchAgentShortcutAction,
  type LaunchShortcutAction,
  validateLaunchShortcutPreferences,
} from '../lib/keyboard-shortcuts';
import type { LaunchNavigate } from '../lib/navigation';
import { type ThemePreference, useTheme } from '../lib/theme';

type SettingsPage = 'root' | 'keys' | 'providers' | 'shortcuts';

export function settingsPageFromPane(pane: string | null): SettingsPage {
  if (pane === 'keys') return 'keys';
  if (pane === 'providers' || pane === 'byok') return 'providers';
  if (pane === 'shortcuts') return 'shortcuts';
  return 'root';
}

export function settingsKeyIsIdle(
  key: LaunchApiKeySummary,
  now = Date.now(),
): boolean {
  const observedAt = Date.parse(key.lastUsedAt ?? key.createdAt);
  return Number.isFinite(observedAt) &&
    now - observedAt > 30 * 24 * 60 * 60 * 1_000;
}

function relativePast(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never used';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.max(0, Math.round((now - then) / 1_000));
  if (seconds < 30) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 2) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function subscriptionValue(
  subscription: LaunchSubscriptionResponse | undefined,
): string {
  if (!subscription) return 'Loading…';
  const price = `$${(subscription.priceCents / 100).toLocaleString()} / month`;
  if (!subscription.hasActiveSubscription) return `${price} · subscription required`;
  if (!subscription.currentPeriodEnd) return price;
  const renewal = new Date(subscription.currentPeriodEnd).toLocaleDateString(
    undefined,
    { month: 'short', day: 'numeric' },
  );
  return `${price} · renews ${renewal}`;
}

function weeklyUsageValue(
  subscription: LaunchSubscriptionResponse | undefined,
): string {
  if (!subscription) return 'Loading…';
  const weekly = subscription.capacity.weekly;
  const usage = weekly.usedPercent === undefined
    ? weekly.state
    : `${Math.round(weekly.usedPercent)}% used`;
  const reset = new Date(weekly.resetsAt).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${usage} · resets ${reset}`;
}

function shortcutDraft(
  preferences: LaunchFleetPreferences | null,
): Record<LaunchShortcutAction, string | null> {
  if (!preferences) {
    return { ...DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION.bindings };
  }
  try {
    return {
      ...createLaunchShortcutConfiguration({
        enabled: preferences.shortcutsEnabled,
        bindings: preferences.shortcutMap,
      }).bindings,
    };
  } catch {
    return { ...DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION.bindings };
  }
}

function SettingsGroup({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}): ReactElement {
  return (
    <section className='neb-settings-group'>
      <h2>{label}</h2>
      <div className='neb-settings-rows'>{children}</div>
    </section>
  );
}

function SettingsRow({
  action,
  actionLabel,
  faint = false,
  label,
  tooltip,
  value,
}: {
  action?: () => void;
  actionLabel?: string;
  faint?: boolean;
  label: string;
  tooltip?: string;
  value?: ReactNode;
}): ReactElement {
  return (
    <div className={`neb-settings-row${faint ? ' faint' : ''}`}>
      <span className='neb-settings-row-label'>
        <span>{label}</span>
        {tooltip
          ? (
            <button
              aria-label={`About ${label}`}
              className='neb-settings-info'
              type='button'
            >
              i
              <span role='tooltip'>{tooltip}</span>
            </button>
          )
          : null}
      </span>
      <span className='neb-settings-row-value'>{value ?? ''}</span>
      {action && actionLabel
        ? (
          <button
            className='neb-settings-action'
            onClick={action}
            type='button'
          >
            {actionLabel}
          </button>
        )
        : <span aria-hidden='true' className='neb-settings-action placeholder'>—</span>}
    </div>
  );
}

function SettingsBack({
  children,
  onBack,
  title,
}: {
  children: ReactNode;
  onBack: () => void;
  title: string;
}): ReactElement {
  return (
    <div className='neb-settings-screen neb-settings-drill-in'>
      <button className='neb-settings-back' onClick={onBack} type='button'>
        ← Settings
      </button>
      <h1>{title}</h1>
      {children}
    </div>
  );
}

function SettingsRoot({
  billingBusy,
  byok,
  copiedMcp,
  keyCount,
  onBilling,
  onCopyMcp,
  onOpenProvider,
  onPage,
  onSignOut,
  shortcutPreferences,
  subscription,
}: {
  billingBusy: boolean;
  byok?: LaunchByokSummaryResponse;
  copiedMcp: boolean;
  keyCount: number;
  onBilling: () => void;
  onCopyMcp: (value: string) => void;
  onOpenProvider: (provider: LaunchByokProviderOption) => void;
  onPage: (page: SettingsPage) => void;
  onSignOut: () => void;
  shortcutPreferences: LaunchFleetPreferences | null;
  subscription?: LaunchSubscriptionResponse;
}): ReactElement {
  const { preference, setPreference } = useTheme();
  const providers = byok?.providers ?? [];
  const connected = providers.filter((provider) => provider.configured);
  const available = providers.filter((provider) => !provider.configured);
  const mcpEndpoint = `${launchApiOrigin()}/mcp/platform`;

  return (
    <div className='neb-settings-screen'>
      <h1>Settings</h1>
      <div className='neb-settings-groups'>
        <SettingsGroup label='Plan & usage'>
          <SettingsRow
            action={onBilling}
            actionLabel={billingBusy
              ? 'Opening…'
              : subscription?.canManage
              ? 'Manage'
              : 'Subscribe'}
            label={subscription?.planName ?? 'Plan'}
            value={subscriptionValue(subscription)}
          />
          <SettingsRow
            label='Weekly usage limit'
            tooltip="Pooled across every agent. Inference on your own provider keys is billed by that provider and isn't counted here."
            value={weeklyUsageValue(subscription)}
          />
        </SettingsGroup>

        <SettingsGroup label='Model keys'>
          {connected.map((provider) => (
            <SettingsRow
              action={() => onOpenProvider(provider)}
              actionLabel='Update'
              key={provider.id}
              label={provider.name}
              value={provider.model ?? provider.defaultModel ?? 'default model'}
            />
          ))}
          {!byok
            ? <SettingsRow faint label='Loading providers…' />
            : (
              <SettingsRow
                action={() => onPage('providers')}
                actionLabel='Add a key'
                faint
                label={`${available.length} more provider${
                  available.length === 1 ? '' : 's'
                } available`}
              />
            )}
        </SettingsGroup>

        <SettingsGroup label='Access'>
          <SettingsRow
            action={() => onPage('keys')}
            actionLabel='Manage'
            label='Galactic Keys'
            value={`${keyCount} API key${keyCount === 1 ? '' : 's'}`}
          />
          <SettingsRow
            action={() => onCopyMcp(mcpEndpoint)}
            actionLabel={copiedMcp ? '✓ Copied' : 'Copy'}
            label='MCP endpoint'
            value={mcpEndpoint.replace(/^https?:\/\//u, '')}
          />
          <SettingsRow
            action={() => onPage('shortcuts')}
            actionLabel='View map'
            label='Keyboard shortcuts'
            value={shortcutPreferences?.shortcutsEnabled === false ? 'off' : 'on'}
          />
        </SettingsGroup>

        <SettingsGroup label='Appearance'>
          <div className='neb-settings-theme-row'>
            <span>Theme</span>
            <span className='neb-settings-theme-options'>
              {(['system', 'light', 'dark'] as ThemePreference[]).map((theme) => (
                <button
                  aria-pressed={preference === theme}
                  className={preference === theme ? 'selected' : ''}
                  key={theme}
                  onClick={() => setPreference(theme)}
                  type='button'
                >
                  {theme[0]?.toUpperCase()}{theme.slice(1)}
                </button>
              ))}
            </span>
          </div>
        </SettingsGroup>

        <button className='neb-settings-signout' onClick={onSignOut} type='button'>
          Sign out
        </button>
      </div>
    </div>
  );
}

function ModelKeysSettings({
  byok,
  onBack,
  onOpenProvider,
}: {
  byok?: LaunchByokSummaryResponse;
  onBack: () => void;
  onOpenProvider: (provider: LaunchByokProviderOption) => void;
}): ReactElement {
  const connected = (byok?.providers ?? []).filter((provider) => provider.configured);
  const available = (byok?.providers ?? []).filter((provider) => !provider.configured);

  return (
    <SettingsBack onBack={onBack} title='Model keys'>
      <p className='neb-settings-subtitle'>
        Your keys power <code>galactic.ai()</code> directly. Galactic stores them encrypted,
        never resells inference, and never bills you for it.
      </p>
      <SettingsGroup label='Connected'>
        {connected.map((provider) => (
          <SettingsRow
            action={() => onOpenProvider(provider)}
            actionLabel='Update'
            key={provider.id}
            label={provider.name}
            value={provider.model ?? provider.defaultModel ?? 'default model'}
          />
        ))}
        {byok && connected.length === 0
          ? <div className='neb-settings-empty-row'>No model keys connected</div>
          : null}
      </SettingsGroup>
      <SettingsGroup label='Available'>
        {available.map((provider) => (
          <div className='neb-settings-provider-row' key={provider.id}>
            <span>
              <strong>{provider.name}</strong>
              <small>{provider.description ?? 'Connect this model provider'}</small>
            </span>
            <button
              className='neb-settings-action'
              onClick={() => onOpenProvider(provider)}
              type='button'
            >
              Add key
            </button>
          </div>
        ))}
        {!byok ? <div className='neb-settings-empty-row'>Loading providers…</div> : null}
      </SettingsGroup>
    </SettingsBack>
  );
}

function ProviderKeyDialog({
  onClose,
  onSaved,
  provider,
  setError,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
  provider: LaunchByokProviderOption;
  setError: (value: string) => void;
}): ReactElement {
  const [key, setKey] = useState('');
  const [model, setModel] = useState(
    provider.model ?? provider.defaultModel ?? '',
  );
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const timer = window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const save = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await launchApi.upsertByokProvider(provider.id, {
        apiKey: key.trim(),
        model: model.trim() || undefined,
        validate: true,
      });
      await onSaved();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className='nebula-root neb-settings-key-overlay'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role='presentation'
    >
      <div
        aria-label={`${provider.configured ? 'Update' : 'Add'} ${provider.name} key`}
        aria-modal='true'
        className='neb-settings-key-dialog'
        ref={dialogRef}
        role='dialog'
      >
        <div className='neb-settings-dialog-head'>
          <strong>
            {provider.configured
              ? `Update the ${provider.name} key`
              : `Add a ${provider.name} key`}
          </strong>
          <button aria-label='Close' onClick={onClose} type='button'>✕</button>
        </div>
        <label className='neb-settings-dialog-field'>
          <span>API key</span>
          <input
            autoComplete='off'
            onChange={(event) => setKey(event.currentTarget.value)}
            placeholder={provider.configured ? 'Enter a replacement key' : 'sk-…'}
            type='password'
            value={key}
          />
        </label>
        <label className='neb-settings-dialog-field'>
          <span>Default model</span>
          <input
            onChange={(event) => setModel(event.currentTarget.value)}
            value={model}
          />
        </label>
        <div className='neb-settings-buttons'>
          <button
            className='primary'
            disabled={busy || !key.trim()}
            onClick={() => void save()}
            type='button'
          >
            {busy ? 'Testing…' : 'Save'}
          </button>
          <button onClick={onClose} type='button'>Cancel</button>
        </div>
        <p>
          Saving runs one test call to confirm the key works. Nothing is charged to it until an
          agent asks for that model.
        </p>
      </div>
    </div>,
    document.body,
  );
}

function GalacticKeysSettings({
  hasActiveSubscription,
  copied,
  keys,
  onBack,
  onChange,
  onCopy,
  onToast,
  setError,
}: {
  hasActiveSubscription: boolean;
  copied: boolean;
  keys: LaunchApiKeySummary[];
  onBack: () => void;
  onChange: (value: LaunchApiKeySummary[]) => void;
  onCopy: (value: string) => void;
  onToast: (message: string) => void;
  setError: (value: string) => void;
}): ReactElement {
  const [plaintext, setPlaintext] = useState('');
  const [expanded, setExpanded] = useState(false);
  const sorted = useMemo(() => [...keys].sort((left, right) => {
    const leftTime = Date.parse(left.lastUsedAt ?? left.createdAt);
    const rightTime = Date.parse(right.lastUsedAt ?? right.createdAt);
    return rightTime - leftTime;
  }), [keys]);
  const visible = expanded ? sorted : sorted.slice(0, 6);
  const idle = sorted.filter((key) => settingsKeyIsIdle(key));

  const create = async () => {
    setError('');
    try {
      const response = await launchApi.createApiKey({
        name: `Web key ${new Date().toISOString().slice(0, 10)}`,
        expiresInDays: 90,
        scopes: ['apps:read', 'apps:call', 'agents:build', 'agents:operate'],
      });
      setPlaintext(response.plaintextToken);
      onChange([response.apiKey, ...keys]);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const revoke = async (key: LaunchApiKeySummary) => {
    setError('');
    try {
      await launchApi.revokeApiKey(key.id);
      onChange(keys.filter((candidate) => candidate.id !== key.id));
      onToast(`Revoked ${key.name}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const revokeIdle = async () => {
    setError('');
    try {
      await Promise.all(idle.map((key) => launchApi.revokeApiKey(key.id)));
      const idleIds = new Set(idle.map((key) => key.id));
      onChange(keys.filter((key) => !idleIds.has(key.id)));
      onToast(`Revoked ${idle.length} idle token${idle.length === 1 ? '' : 's'}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <SettingsBack onBack={onBack} title='Galactic Keys'>
      <p className='neb-settings-subtitle'>
        {hasActiveSubscription
          ? 'API keys let something act as you outside this browser. Names come from whatever created them; revoking takes effect on the next request.'
          : 'An active Galactic membership is required to create or use persistent API keys. You can still revoke existing keys below.'}
      </p>
      {plaintext
        ? (
          <div className='neb-settings-new-token'>
            <span aria-hidden='true' />
            <div>
              <code>{plaintext}</code>
              <small>Shown once. Store it now.</small>
            </div>
            <div className='neb-settings-new-token-actions'>
              <button className='primary' onClick={() => onCopy(plaintext)} type='button'>
                {copied ? '✓ Copied' : 'Copy'}
              </button>
              <button onClick={() => setPlaintext('')} type='button'>Dismiss</button>
            </div>
          </div>
        )
        : null}
      <button
        className='neb-settings-create-token'
        disabled={!hasActiveSubscription}
        onClick={() => void create()}
        type='button'
      >
        + Create token
      </button>
      <div className='neb-settings-token-list'>
        {visible.map((key) => (
          <div className='neb-settings-token-row' key={key.id}>
            <span>{key.name}</span>
            <time className={settingsKeyIsIdle(key) ? 'idle' : ''}>
              {relativePast(key.lastUsedAt)}
            </time>
            <code>{key.tokenPrefix}••••</code>
            <button
              className='neb-settings-action'
              onClick={() => void revoke(key)}
              type='button'
            >
              Revoke
            </button>
          </div>
        ))}
      </div>
      <div className='neb-settings-token-summary'>
        {sorted.length > 6
          ? (
            <button onClick={() => setExpanded((current) => !current)} type='button'>
              {expanded ? 'Show fewer ↑' : `Show ${sorted.length - 6} more →`}
            </button>
          )
          : <span />}
        <span>{sorted.length} active</span>
      </div>
      <p className='neb-settings-footnote'>
        {idle.length > 0
          ? (
            <>
              {idle.length} of these haven&apos;t been used in 30 days.{' '}
              <button onClick={() => void revokeIdle()} type='button'>
                Revoke the idle ones
              </button>
            </>
          )
          : 'Every token here has been used in the last 30 days.'}
      </p>
    </SettingsBack>
  );
}

function ShortcutSettings({
  agents,
  expectedRevision,
  onBack,
  onChange,
  onToast,
  preferences,
  setError,
}: {
  agents: LaunchFleetAgentSummary[];
  expectedRevision: string | null;
  onBack: () => void;
  onChange: (preferences: LaunchFleetPreferences) => void;
  onToast: (message: string) => void;
  preferences: LaunchFleetPreferences | null;
  setError: (value: string) => void;
}): ReactElement {
  const [enabled, setEnabled] = useState(
    preferences?.shortcutsEnabled ?? true,
  );
  const [bindings, setBindings] = useState(() => shortcutDraft(preferences));
  const [listening, setListening] = useState<LaunchShortcutAction | null>(null);

  useEffect(() => {
    if (!preferences) return;
    setEnabled(preferences.shortcutsEnabled);
    setBindings(shortcutDraft(preferences));
  }, [preferences]);

  useEffect(() => {
    if (!listening) return;
    const capture = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const value = event.key === 'Escape'
        ? 'Escape'
        : event.key.length === 1 && !/\s/u.test(event.key)
        ? event.key.toLowerCase()
        : null;
      if (value) {
        setBindings((current) => ({ ...current, [listening]: value }));
      }
      setListening(null);
    };
    document.addEventListener('keydown', capture, true);
    return () => document.removeEventListener('keydown', capture, true);
  }, [listening]);

  const validation = validateLaunchShortcutPreferences({
    enabled,
    bindings,
  });

  const save = async () => {
    if (!preferences || !expectedRevision || !validation.valid) return;
    setError('');
    try {
      const response = await launchApi.updateFleetPreferences({
        expectedRevision,
        shortcutsEnabled: enabled,
        shortcutMap: bindings,
      });
      onChange(response.preferences);
      onToast('Shortcuts saved');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const aroundApp: Array<{ action: LaunchShortcutAction; label: string }> = [
    { action: 'search', label: 'Search' },
    { action: 'alerts', label: 'Alerts' },
    { action: 'settings', label: 'Settings' },
    { action: 'help', label: 'Shortcut help' },
    { action: 'dismiss', label: 'Close the focused page' },
  ];
  const agentShortcuts = agents.slice(0, 6).map((agent, index) => ({
    action: launchAgentShortcutAction(index + 1) as LaunchShortcutAction,
    label: agent.agent.name || agent.agent.slug,
  }));
  const displayBinding = (action: LaunchShortcutAction) => {
    if (listening === action) return 'press…';
    if (bindings[action] === 'Escape') return 'Esc';
    return bindings[action] ?? 'Off';
  };
  const rows = (
    items: Array<{ action: LaunchShortcutAction; label: string }>,
  ) => items.map(({ action, label }) => (
    <div className='neb-settings-shortcut-row' key={action}>
      <span>{label}</span>
      <button
        aria-label={`Change ${label} shortcut`}
        className={listening === action ? 'listening' : ''}
        disabled={!enabled}
        onClick={() => setListening(action)}
        type='button'
      >
        {displayBinding(action)}
      </button>
    </div>
  ));

  return (
    <SettingsBack onBack={onBack} title='Keyboard shortcuts'>
      <button
        aria-pressed={enabled}
        className='neb-settings-shortcut-toggle'
        onClick={() => setEnabled((current) => !current)}
        type='button'
      >
        <span aria-hidden='true'>{enabled ? '✓' : ''}</span>
        Turn on shortcuts
      </button>
      <div className={`neb-settings-shortcut-map${enabled ? '' : ' disabled'}`}>
        <SettingsGroup label='Around the app'>{rows(aroundApp)}</SettingsGroup>
        <SettingsGroup label='Jump to an agent'>{rows(agentShortcuts)}</SettingsGroup>
        <p className='neb-settings-shortcut-note'>
          Slots 7–0 follow your fleet order. Reorder the fleet to change them.
        </p>
      </div>
      {!validation.valid
        ? (
          <p className='neb-settings-validation' role='alert'>
            {validation.issues[0]?.message}
          </p>
        )
        : null}
      <div className='neb-settings-buttons'>
        <button
          className='primary'
          disabled={!preferences || !expectedRevision || !validation.valid}
          onClick={() => void save()}
          type='button'
        >
          {preferences ? 'Save' : 'Loading…'}
        </button>
        <button
          onClick={() => {
            setEnabled(true);
            setBindings({
              ...DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION.bindings,
            });
            onToast('Defaults restored');
          }}
          type='button'
        >
          Restore defaults
        </button>
      </div>
      <p className='neb-settings-footnote'>
        Nothing fires while you type, compose with an IME, use a dialog, or work inside an
        embedded Interface.
      </p>
    </SettingsBack>
  );
}

export function SettingsStudioPanel({
  agents,
  fleetRevision,
  initial,
  onNavigate,
  onShortcutPreferencesChange,
  onSignOut,
  shortcutPreferences,
}: {
  agents: LaunchFleetAgentSummary[];
  fleetRevision: string | null;
  initial: LaunchPageProps['live']['data'];
  onNavigate: LaunchNavigate;
  onShortcutPreferencesChange: (preferences: LaunchFleetPreferences) => void;
  onSignOut: () => void | Promise<void>;
  shortcutPreferences: LaunchFleetPreferences | null;
}): ReactElement {
  const requested = new URLSearchParams(window.location.search).get('pane');
  const requestedPage = settingsPageFromPane(requested);
  const [page, setPage] = useState<SettingsPage>(requestedPage);
  const [subscription, setSubscription] = useState<
    LaunchSubscriptionResponse | undefined
  >(initial.subscription);
  const [byok, setByok] = useState<LaunchByokSummaryResponse | undefined>(
    initial.byok,
  );
  const [keys, setKeys] = useState(initial.apiKeys?.apiKeys ?? []);
  const [dialogProvider, setDialogProvider] = useState<
    LaunchByokProviderOption | null
  >(null);
  const [billingBusy, setBillingBusy] = useState(false);
  const [copied, setCopied] = useState<'mcp' | 'token' | null>(null);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const toastTimer = useRef<number | null>(null);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => setPage(requestedPage), [requestedPage]);

  useEffect(() => {
    if (requested !== 'connect') return;
    onNavigate('/connect?intent=connect&source=settings', { replace: true });
  }, [onNavigate, requested]);

  const refresh = useCallback(async () => {
    const [subResult, byokResult, keysResult] = await Promise.allSettled([
      launchApi.subscription(),
      launchApi.byok(),
      launchApi.apiKeys(),
    ]);
    if (subResult.status === 'fulfilled') setSubscription(subResult.value);
    if (byokResult.status === 'fulfilled') setByok(byokResult.value);
    if (keysResult.status === 'fulfilled') setKeys(keysResult.value.apiKeys);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const flash = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 1_600);
  }, []);

  const choose = (next: SettingsPage) => {
    setPage(next);
    onNavigate(
      next === 'root' ? '/account' : `/account?pane=${next}`,
      { scroll: 'top' },
    );
  };

  const copy = async (kind: 'mcp' | 'token', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(null), 1_400);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const openBilling = async () => {
    if (!subscription || billingBusy) return;
    setBillingBusy(true);
    setError('');
    try {
      const result = subscription.canManage
        ? await launchApi.createSubscriptionPortal()
        : await launchApi.createSubscriptionCheckout();
      flash('Opening Stripe…');
      markExternalReturnRevalidation();
      window.location.assign(result.url);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBillingBusy(false);
    }
  };

  return (
    <section className='neb-inline-panel neb-settings-panel' aria-label='Settings'>
      {error ? <p className='neb-settings-error' role='alert'>{error}</p> : null}
      {page === 'root'
        ? (
          <SettingsRoot
            billingBusy={billingBusy}
            byok={byok}
            copiedMcp={copied === 'mcp'}
            keyCount={keys.length}
            onBilling={() => void openBilling()}
            onCopyMcp={(value) => void copy('mcp', value)}
            onOpenProvider={setDialogProvider}
            onPage={choose}
            onSignOut={() => void onSignOut()}
            shortcutPreferences={shortcutPreferences}
            subscription={subscription}
          />
        )
        : null}
      {page === 'keys'
        ? (
          <GalacticKeysSettings
            hasActiveSubscription={subscription?.hasActiveSubscription === true}
            copied={copied === 'token'}
            keys={keys}
            onBack={() => choose('root')}
            onChange={setKeys}
            onCopy={(value) => void copy('token', value)}
            onToast={flash}
            setError={setError}
          />
        )
        : null}
      {page === 'providers'
        ? (
          <ModelKeysSettings
            byok={byok}
            onBack={() => choose('root')}
            onOpenProvider={setDialogProvider}
          />
        )
        : null}
      {page === 'shortcuts'
        ? (
          <ShortcutSettings
            agents={agents}
            expectedRevision={fleetRevision}
            onBack={() => choose('root')}
            onChange={onShortcutPreferencesChange}
            onToast={flash}
            preferences={shortcutPreferences}
            setError={setError}
          />
        )
        : null}
      {dialogProvider
        ? (
          <ProviderKeyDialog
            onClose={() => setDialogProvider(null)}
            onSaved={async () => {
              setByok(await launchApi.byok());
              setDialogProvider(null);
              flash(`${dialogProvider.name} key saved · test call passed`);
            }}
            provider={dialogProvider}
            setError={setError}
          />
        )
        : null}
      {toast
        ? <div className='neb-settings-toast' role='status'>{toast}</div>
        : null}
    </section>
  );
}
