import {
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type {
  LaunchAgentActivityPreview,
  LaunchAgentCapacityResponse,
  LaunchAgentFunctionsResponse,
  LaunchAgentManagedRoutineUpdateRequest,
  LaunchAgentPreferences,
  LaunchAgentRoutineOverview,
  LaunchAgentSummary,
  LaunchApiKeySummary,
  LaunchByokProviderOption,
  LaunchByokSummaryResponse,
  LaunchFleetAgentSummary,
  LaunchFleetPreferences,
  LaunchFleetResponse,
  LaunchFunctionSummary,
  LaunchGlobalAttentionResponse,
  LaunchInterfaceSummary,
  LaunchNotification,
  LaunchSubscriptionResponse,
} from '../../../../shared/contracts/launch.ts';
import type { LaunchPageProps } from '../App';
import { type AgentPane, DEFAULT_AGENT_PANE } from '../lib/agent-pane-registry';
import { parseAgentRouteState, updateAgentRouteState } from '../lib/agent-route-state';
import {
  getLaunchAuthToken,
  hasLaunchAuthToken,
  launchAuthSubject,
  signOutLaunch,
} from '../lib/auth';
import {
  attachInterfaceBridge,
  clampInterfaceHeight,
  runInterfaceFunctionDurably,
} from '../lib/interface-bridge';
import { scheduleInterfaceWarmup, warmInterfaceDocument } from '../lib/interface-warmup';
import { runInterfaceCallWithCache } from '../lib/interface-read-cache';
import { interfacePrefetches, interfaceReadModel } from '../lib/interface-read-models';
import {
  clearLegacyInterfaceFavorites,
  readLegacyInterfaceFavoritesForMigration,
  shouldApplyInterfaceFavoritesRead,
  shouldMigrateLegacyInterfaceFavorites,
} from '../lib/interface-favorites';
import {
  type LaunchAgentSettingsResponse,
  launchApi,
  launchApiOrigin,
  type LaunchSettingsResponse,
} from '../lib/api';
import {
  createReleaseCandidateReviewToken,
  createReleasePromotionRequest,
  createSafeReleasePromotionStorage,
  currentReleaseSnapshotFromError,
  executeReleasePromotionWithRecovery,
  getOrCreateReleasePromotionIdempotencyKey,
  releaseCandidateMatchesReview,
  type ReleaseCandidateReviewToken,
  releasePromotionStorageKey,
  releaseReviewLabel,
  shortReleaseFingerprint,
  shouldRetainAgentHomeOverride,
  shouldRetainReleasePromotionAttempt,
} from '../lib/nebula-release';
import { readCachedFleetCount, writeCachedFleetCount } from '../lib/fleet-count-cache';
import {
  appendGlobalAttentionPage,
  exactGlobalAttentionCountAfterAgentChange,
  globalAttentionAgentCountMap,
  globalAttentionEntryMatches,
  groupGlobalAttentionEntries,
} from '../lib/global-attention';
import { type AgentExtensionKind, buildAgentExtensionPrompt } from '../lib/agent-extension-prompt';
import {
  fleetAgentAttentionCount,
  fleetStatusPresentation,
  isFleetAgentWorkingOrReady,
} from '../lib/fleet-status';
import { moveFleetAgentBefore, moveFleetAgentByOffset } from '../lib/fleet-order';
import {
  reconcileFleetPreferenceRead,
  withSharedFleetRevision,
  withSharedPreferenceRevision,
} from '../lib/fleet-revision';
import { markExternalReturnRevalidation } from '../lib/external-navigation';
import { reconcileCollapsibleRouteTarget } from '../lib/collapsible-state';
import {
  type OverviewConditionalSection,
  overviewSectionBuckets,
} from '../lib/overview-section-order';
import { mergeAgentActivityPages } from '../lib/operator-activity-state';
import {
  resolveOperatorAccessItem,
  resolveOperatorFunctionItem,
  resolveOperatorSettingsItem,
} from '../lib/operator-item-targets';
import {
  createLaunchShortcutConfiguration,
  DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION,
  LAUNCH_SHORTCUT_ACTIONS,
  launchAgentShortcutAction,
  launchAgentShortcutPosition,
  type LaunchShortcutAction,
  launchShortcutAriaKeyShortcuts,
  type LaunchShortcutConfiguration,
  launchShortcutDisplayLabel,
  resolveLaunchShortcut,
  validateLaunchShortcutPreferences,
} from '../lib/keyboard-shortcuts';
import {
  dismissLaunchWorkspace,
  type LaunchNavigate,
} from '../lib/navigation';
import { AgentComputePane } from './agent-compute-pane';
import { AgentOverviewLayout } from './nebula/agent-overview-layout';
import {
  AgentPanelShell,
  AgentPanePlaceholder,
  AgentStructurePlaceholder,
} from './nebula/agent-panel-shell';
import { FleetRoster } from './nebula/fleet-roster';
import { Glyph } from './nebula/glyph';
import { OperatorAgentAlerts } from './nebula/operator-agent-alerts';
import { OperatorAgentAccess } from './nebula/operator-agent-access';
import { OperatorAgentOverview } from './nebula/operator-agent-overview';
import { SearchPanel } from './nebula/search-panel';
import './nebula-fleet.css';

type SettingsPane =
  | 'general'
  | 'shortcuts'
  | 'billing'
  | 'usage'
  | 'byok'
  | 'keys'
  | 'connect';

type RoutineUpdate = Omit<
  LaunchAgentManagedRoutineUpdateRequest,
  'expectedRevision'
>;

interface NebulaProps extends LaunchPageProps {}

async function provisionConnectAgentPrompt(
  keyPurpose = 'Agent connect',
): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const suffix = Math.random().toString(36).slice(2, 6);
  const [key, install] = await Promise.all([
    launchApi.createApiKey({
      name: `${keyPurpose} ${stamp} ${suffix}`,
      expiresInDays: 90,
      scopes: ['apps:read', 'apps:call', 'agents:build', 'agents:operate'],
    }),
    launchApi.install(),
  ]);
  const template = install.instructions.find((item) => item.target === 'prompt')
    ?.configText;
  return template?.replaceAll('$GALACTIC_API_KEY', key.plaintextToken) ??
    `Connect Galactic at ${launchApiOrigin()}/mcp/platform with Authorization: Bearer ${key.plaintextToken}. Then ask me what persistent Agent to conjure.`;
}

async function provisionNewAgentPrompt(): Promise<string> {
  const connectionPrompt = await provisionConnectAgentPrompt('New Agent build');
  return [
    connectionPrompt,
    '',
    'Help me create and deploy a new persistent Galactic Agent. Begin by asking what it should do, when it should run, what tools or data it needs, and what constraints it must follow.',
    '',
    'Offer me the option to start from the Galactic scaffold by calling gx.download(full_time: true), then customize that scaffold for this Agent. I can also choose to build it from scratch.',
    '',
    'Test the Agent, explain its behavior and permissions, and upload it as a paused proposal for my review. Do not activate it without my explicit approval.',
  ].join('\n');
}

async function provisionAgentExtensionPrompt(
  agent: LaunchAgentSummary,
  kind: AgentExtensionKind,
): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const suffix = Math.random().toString(36).slice(2, 6);
  const nameBase = `${agent.slug} ${kind} builder`.slice(0, 28).trim();
  const key = await launchApi.createApiKey({
    name: `${nameBase} ${stamp} ${suffix}`,
    expiresInDays: 30,
    scopes: ['apps:read', 'agents:build'],
    appIds: [agent.id],
  });
  return buildAgentExtensionPrompt({
    agent,
    apiKey: key.plaintextToken,
    kind,
    platformMcpUrl: `${launchApiOrigin()}/mcp/platform`,
  });
}

let audioContext: AudioContext | null = null;
const modalStack: symbol[] = [];

function tone(
  freqA: number,
  freqB: number | null,
  duration: number,
  volume: number,
) {
  try {
    const AudioContextCtor = window.AudioContext;
    audioContext = audioContext || new AudioContextCtor();
    if (audioContext.state === 'suspended') {
      void audioContext.resume().catch(() => undefined);
    }
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(freqA, audioContext.currentTime);
    if (freqB) {
      oscillator.frequency.exponentialRampToValueAtTime(
        freqB,
        audioContext.currentTime + duration * 0.9,
      );
    }
    gain.gain.setValueAtTime(volume, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      audioContext.currentTime + duration,
    );
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + duration);
  } catch {
    // Browsers may withhold audio until a gesture. Sound is enhancement only.
  }
}

const sounds = {
  click: () => tone(680, 380, 0.1, 0.05),
  close: () => tone(780, 520, 0.1, 0.03),
  confirm: () => {
    tone(660, null, 0.07, 0.04);
    window.setTimeout(() => tone(880, null, 0.09, 0.04), 70);
  },
  hover: () => tone(1050, null, 0.045, 0.016),
  open: () => tone(520, 780, 0.12, 0.04),
  wake: () => tone(440, 880, 0.18, 0.035),
};

function formatRelative(
  iso: string | null | undefined,
  now = Date.now(),
): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 30) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function formatRelativePast(iso: string): string {
  const relative = formatRelative(iso);
  return relative === 'now' ? 'just now' : `${relative} ago`;
}

function asPercent(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value ?? 0));
}

function agentLocator(agent: LaunchAgentSummary): string {
  return agent.slug || agent.id;
}

function apiAssetUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('/api/')) return `${launchApiOrigin()}${value}`;
  return value;
}

function randomId(): string {
  return crypto.randomUUID();
}

function useClock(interval = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(id);
  }, [interval]);
  return now;
}

function Starfield(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stars = Array.from({ length: 180 }, () => ({
      x: Math.random(),
      y: Math.random(),
      radius: Math.random() * 1.2 + 0.3,
      depth: Math.random() * 0.7 + 0.3,
      phase: Math.random() * Math.PI * 2,
      speed: 0.0006 + Math.random() * 0.0012,
    }));
    let pointerX = 0;
    let pointerY = 0;
    let parallaxX = 0;
    let parallaxY = 0;
    let frame = 0;
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(innerWidth * ratio);
      canvas.height = Math.round(innerHeight * ratio);
      canvas.style.width = `${innerWidth}px`;
      canvas.style.height = `${innerHeight}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const move = (event: MouseEvent) => {
      pointerX = event.clientX / innerWidth - 0.5;
      pointerY = event.clientY / innerHeight - 0.5;
    };
    const draw = (time: number) => {
      parallaxX += (pointerX - parallaxX) * 0.03;
      parallaxY += (pointerY - parallaxY) * 0.03;
      context.clearRect(0, 0, innerWidth, innerHeight);
      for (const star of stars) {
        const alpha = reduced
          ? 0.5
          : 0.25 + 0.55 * Math.abs(Math.sin(time * star.speed + star.phase));
        context.beginPath();
        context.arc(
          star.x * innerWidth + parallaxX * 18 * star.depth,
          star.y * innerHeight + parallaxY * 18 * star.depth,
          star.radius,
          0,
          Math.PI * 2,
        );
        context.fillStyle = `rgba(255,255,255,${alpha})`;
        context.fill();
      }
      if (!reduced) frame = requestAnimationFrame(draw);
    };
    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('mousemove', move);
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      document.removeEventListener('mousemove', move);
    };
  }, []);
  return <canvas className='neb-stars' ref={canvasRef} aria-hidden='true' />;
}

function Modal({
  children,
  className = '',
  label,
  onClose,
  overlayClassName = '',
  style,
}: {
  children: ReactNode;
  className?: string;
  label: string;
  onClose: () => void;
  overlayClassName?: string;
  style?: CSSProperties;
}): ReactElement {
  const modalRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const modalId = Symbol(label);
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    modalStack.push(modalId);
    sounds.open();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== modalId) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key === 'Tab') {
        const focusable = Array.from(
          modalRef.current?.querySelectorAll<HTMLElement>(
            "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
          ) ?? [],
        ).filter((item) => item.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const timer = window.setTimeout(() => {
      modalRef.current?.querySelector<HTMLElement>(
        "button, input, [tabindex='0']",
      )?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
      const position = modalStack.lastIndexOf(modalId);
      if (position >= 0) modalStack.splice(position, 1);
      returnFocus?.focus();
    };
  }, [label]);
  return createPortal(
    <div
      className={`nebula-root neb-modal-overlay open${
        overlayClassName ? ` ${overlayClassName}` : ''
      }`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role='presentation'
    >
      <div
        className={`neb-modal ${className}`}
        ref={modalRef}
        role='dialog'
        aria-label={label}
        aria-modal='true'
        style={style}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function CloseButton({ onClose }: { onClose: () => void }): ReactElement {
  return (
    <button
      className='neb-modal-close'
      onClick={onClose}
      aria-label='Close'
      type='button'
    >
      <Glyph name='close' />
    </button>
  );
}

function CopyButton({ text }: { text: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={copied ? 'neb-btn-sm saved' : 'neb-btn-sm'}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        sounds.confirm();
        window.setTimeout(() => setCopied(false), 1200);
      }}
      type='button'
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function FleetCard({
  agentCount,
  canReorder,
  item,
  index,
  now,
  onDropAgent,
  onMoveAgent,
  onOpen,
  onIconChanged,
  reorderBusy,
  shortcutConfig,
}: {
  agentCount: number;
  canReorder: boolean;
  item: LaunchFleetAgentSummary;
  index: number;
  now: number;
  onDropAgent: (sourceAgentId: string, targetAgentId: string) => void;
  onMoveAgent: (agentId: string, offset: -1 | 1) => void;
  onOpen: () => void;
  onIconChanged: () => void;
  reorderBusy: boolean;
  shortcutConfig: LaunchShortcutConfiguration;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const wakePlayedRef = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const status = fleetStatusPresentation(item, now);
  const attentionCount = fleetAgentAttentionCount(item);
  const waking = status.waking;
  useEffect(() => {
    if (waking && !wakePlayedRef.current) {
      wakePlayedRef.current = true;
      sounds.wake();
    } else if (!waking) {
      wakePlayedRef.current = false;
    }
  }, [waking]);
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file || uploading) return;
    setUploading(true);
    setUploadError('');
    try {
      await launchApi.uploadAgentIcon(item.agent.id, file);
      sounds.confirm();
      onIconChanged();
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : 'Icon upload failed.',
      );
    } finally {
      setUploading(false);
      event.currentTarget.value = '';
    }
  };

  return (
    <article
      aria-keyshortcuts={launchAgentShortcutAction(index + 1)
        ? launchShortcutAriaKeyShortcuts(
          launchAgentShortcutAction(index + 1)!,
          shortcutConfig,
        )
        : undefined}
      className={`neb-agent-card${waking ? ' waking' : ''}${
        attentionCount > 0 ? ' has-alerts' : ''
      }`}
      onDragOver={(event) => {
        if (
          canReorder &&
          event.dataTransfer.types.includes('text/x-galactic-agent')
        ) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }
      }}
      onDrop={(event) => {
        const sourceAgentId = event.dataTransfer.getData(
          'text/x-galactic-agent',
        );
        if (!canReorder || !sourceAgentId) return;
        event.preventDefault();
        event.stopPropagation();
        onDropAgent(sourceAgentId, item.agent.id);
      }}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      role='button'
      tabIndex={0}
    >
      {canReorder
        ? (
          <div
            className='neb-card-order-controls'
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <button
              aria-label={`Drag ${item.agent.name} to reorder`}
              className='neb-card-drag-handle'
              disabled={reorderBusy}
              draggable={!reorderBusy}
              onDragEnd={(event) => {
                event.currentTarget.blur();
              }}
              onDragStart={(event) => {
                event.stopPropagation();
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(
                  'text/x-galactic-agent',
                  item.agent.id,
                );
              }}
              type='button'
            >
              <span aria-hidden='true'>⠿</span>
            </button>
            <button
              aria-label={`Move ${item.agent.name} earlier`}
              disabled={reorderBusy || index === 0}
              onClick={() => onMoveAgent(item.agent.id, -1)}
              type='button'
            >
              ↑
            </button>
            <button
              aria-label={`Move ${item.agent.name} later`}
              disabled={reorderBusy || index === agentCount - 1}
              onClick={() => onMoveAgent(item.agent.id, 1)}
              type='button'
            >
              ↓
            </button>
          </div>
        )
        : null}
      <span className='neb-card-no'>{String(index + 1).padStart(3, '0')}</span>
      {attentionCount > 0
        ? (
          <span className='neb-card-alert-count'>
            <span aria-hidden='true'>{attentionCount}</span>
            <span className='sr-only'>
              {attentionCount} {attentionCount === 1 ? 'item' : 'items'} requiring attention
            </span>
          </span>
        )
        : null}
      <div className='neb-agent-head'>
        <button
          className='neb-agent-avatar'
          disabled={uploading}
          onClick={(event) => {
            event.stopPropagation();
            inputRef.current?.click();
          }}
          title={uploadError || 'Upload Agent icon (GIF supported)'}
          type='button'
        >
          {apiAssetUrl(item.agent.iconUrl)
            ? <img src={apiAssetUrl(item.agent.iconUrl) ?? undefined} alt='' />
            : <Glyph name='camera' />}
          <input
            accept='image/png,image/jpeg,image/webp,image/gif,.gif'
            hidden
            onChange={(event) => void upload(event)}
            ref={inputRef}
            type='file'
          />
        </button>
        <div className='neb-agent-meta'>
          <div className='neb-agent-name'>{item.agent.name}</div>
          <div className={`neb-status-row ${waking ? 'waking' : ''}`}>
            {status.showLiveSignal ? <span className='neb-status-dot' /> : null}
            <span className='neb-status-copy'>{status.label}</span>
          </div>
        </div>
      </div>
      <div className='neb-last-actions'>
        {item.recentActivity.slice(0, 3).map((activity) => (
          <div className='neb-last-action-item' key={activity.id}>
            <span>{activity.title}</span>
            <span className='neb-last-action-time'>
              {formatRelative(activity.createdAt, now)}
            </span>
          </div>
        ))}
        {item.recentActivity.length === 0
          ? (
            <div className='neb-last-action-item'>
              <span>No activity yet</span>
            </div>
          )
          : null}
      </div>
    </article>
  );
}

function AddAgentCard({ number }: { number: number }): ReactElement {
  const [copyState, setCopyState] = useState<
    'idle' | 'creating' | 'copied' | 'error'
  >('idle');
  const copyNewAgentPrompt = async () => {
    if (copyState === 'creating') return;
    setCopyState('creating');
    try {
      const prompt = await provisionNewAgentPrompt();
      await copyTextToClipboard(prompt);
      setCopyState('copied');
      sounds.confirm();
      window.setTimeout(() => setCopyState('idle'), 3000);
    } catch {
      setCopyState('error');
      window.setTimeout(() => setCopyState('idle'), 3000);
    }
  };
  return (
    <button
      className={`neb-add-agent-card${copyState === 'copied' ? ' copied-prompt' : ''}`}
      disabled={copyState === 'creating'}
      onClick={() => void copyNewAgentPrompt()}
      type='button'
    >
      <span className='neb-card-no'>{String(number).padStart(3, '0')}</span>
      <Glyph name={copyState === 'copied' ? 'check' : 'plus'} />
      <span>
        {copyState === 'creating'
          ? 'Creating prompt…'
          : copyState === 'copied'
          ? 'Copied — paste into agent'
          : copyState === 'error'
          ? 'Copy failed — try again'
          : 'Add agent'}
      </span>
    </button>
  );
}

function HomeHeroActions({
  onAlerts,
  unread,
}: {
  onAlerts: () => void;
  unread: number;
}): ReactElement {
  const [copyState, setCopyState] = useState<
    'idle' | 'creating' | 'copied' | 'error'
  >('idle');
  const copyConnectionPrompt = async () => {
    if (copyState === 'creating') return;
    setCopyState('creating');
    try {
      const prompt = await provisionConnectAgentPrompt();
      await copyTextToClipboard(prompt);
      setCopyState('copied');
      sounds.confirm();
      window.setTimeout(() => setCopyState('idle'), 3000);
    } catch {
      setCopyState('error');
      window.setTimeout(() => setCopyState('idle'), 3000);
    }
  };
  return (
    <div className='neb-hero-actions'>
      <button className='neb-hero-alerts-btn' onClick={onAlerts} type='button'>
        <span className='neb-hero-alerts-dot' />
        {unread} Alert{unread === 1 ? '' : 's'}
      </button>
      <button
        className={`neb-hero-cta secondary${copyState === 'copied' ? ' copied' : ''}`}
        disabled={copyState === 'creating'}
        onClick={() => void copyConnectionPrompt()}
        type='button'
      >
        {copyState === 'creating'
          ? 'Creating prompt…'
          : copyState === 'copied'
          ? 'Copied — paste into agent'
          : copyState === 'error'
          ? 'Copy failed — try again'
          : 'Connect AI'}
      </button>
    </div>
  );
}

async function copyTextToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    if (!copied) throw new Error('Clipboard copy failed');
  }
}

export function NebulaSessionRestoringShell({
  agentOpen,
  onAgentClose,
}: {
  agentOpen: boolean;
  onAgentClose: () => void;
}): ReactElement {
  return (
    <div className='nebula-root' aria-busy='true'>
      <Starfield />
      <div className='neb-nebula n1' aria-hidden='true' />
      <div className='neb-nebula n2' aria-hidden='true' />
      <div className='neb-nebula n3' aria-hidden='true' />
      <div className='neb-grain' aria-hidden='true' />

      <header className='neb-topbar-shell'>
        <div className='neb-topbar'>
          <div className='neb-wordmark'>galactic</div>
        </div>
      </header>
      <main className='neb-app'>
        <section className={`neb-hero${agentOpen ? ' neb-context-hero' : ''}`}>
          <h1>{agentOpen ? 'Loading agent' : 'Agents work here'}</h1>
        </section>
        {agentOpen ? <AgentStructurePlaceholder /> : null}
      </main>
    </div>
  );
}

export function NebulaFleetApp({
  live,
  location,
  navigate,
  route,
}: NebulaProps): ReactElement {
  const now = useClock();
  const [atPageTop, setAtPageTop] = useState(() => window.scrollY <= 1);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const settingsOpen = route.definition.key === 'settings';
  const agentOpen = route.definition.key === 'agent';
  const globalAlertsOpen = route.definition.key === 'home' &&
    new URLSearchParams(location.search).get('panel') === 'alerts';
  const searchOpen = route.definition.key === 'home' &&
    new URLSearchParams(location.search).get('panel') === 'search';
  const returnToAlerts = new URLSearchParams(location.search).get('from') === 'alerts';
  const agentRouteState = useMemo(
    () => parseAgentRouteState(location),
    [location.pathname, location.search],
  );
  const workspaceOpen = globalAlertsOpen || searchOpen || agentOpen ||
    settingsOpen;
  const [cachedFleetCount, setCachedFleetCount] = useState<number | undefined>(
    () => readCachedFleetCount(window.localStorage, getLaunchAuthToken()),
  );
  const [retainedFleet, setRetainedFleet] = useState<
    LaunchFleetResponse | undefined
  >(live.data.fleet);
  const [shortcutPreferences, setShortcutPreferences] = useState<
    LaunchFleetPreferences | null
  >(null);
  const sharedFleetMutationGeneration = useRef(0);
  const latestSharedFleetRevision = useRef<string | null>(
    live.data.fleet?.fleetRevision ?? null,
  );
  const acceptShortcutPreferences = useCallback((
    preferences: LaunchFleetPreferences,
    mutation = false,
  ) => {
    if (mutation) sharedFleetMutationGeneration.current += 1;
    latestSharedFleetRevision.current = preferences.revision;
    setShortcutPreferences(preferences);
    setRetainedFleet((current) => withSharedFleetRevision(current, preferences.revision));
  }, []);
  useEffect(() => {
    if (!live.data.fleet) return;
    setRetainedFleet(live.data.fleet);
    const revision = live.data.fleet.fleetRevision;
    if (!revision) return;
    latestSharedFleetRevision.current = revision;
    setShortcutPreferences((current) =>
      withSharedPreferenceRevision(
        current,
        revision,
        current?.updatedAt ?? live.data.fleet?.generatedAt ?? '',
      )
    );
  }, [live.data.fleet]);
  const fleet = retainedFleet ?? live.data.fleet;
  const [fleetOrderBusy, setFleetOrderBusy] = useState(false);
  const [fleetOrderError, setFleetOrderError] = useState('');
  const shortcutConfig = useMemo(() => {
    if (!shortcutPreferences) return DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION;
    try {
      return createLaunchShortcutConfiguration({
        enabled: shortcutPreferences.shortcutsEnabled,
        bindings: shortcutPreferences.shortcutMap,
      });
    } catch {
      return DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION;
    }
  }, [shortcutPreferences]);
  const fleetLoading = !fleet &&
    (live.status === 'idle' || live.status === 'loading');
  const fleetLoaderStartedAt = useRef<number | null>(
    fleetLoading ? Date.now() : null,
  );
  const [holdFleetLoader, setHoldFleetLoader] = useState(fleetLoading);
  const showFleetLoader = fleetLoading || holdFleetLoader;
  const agents = fleet?.agents ?? [];
  const workingAgentCount = useMemo(
    () =>
      fleet?.workingSummary?.working ??
        agents.filter(isFleetAgentWorkingOrReady).length,
    [agents, fleet?.workingSummary?.working],
  );
  const activeAgent = live.data.agent?.agent ?? live.data.agent?.tool ?? null;
  const selectedFleetSummary = agentOpen
    ? agents.find((item) => item.agent.slug === route.params.slug) ?? null
    : null;
  const selectedFleetAgent = selectedFleetSummary?.agent ?? null;
  const fleetUnread = useMemo(
    () =>
      agents.reduce(
        (total, item) => total + fleetAgentAttentionCount(item),
        0,
      ),
    [agents],
  );
  const [unread, setUnread] = useState(fleetUnread);
  const displayedFleetCount = fleet ? workingAgentCount : cachedFleetCount;
  const homeHeading = displayedFleetCount === undefined
    ? 'Agents Working'
    : `${displayedFleetCount} ${displayedFleetCount === 1 ? 'Agent' : 'Agents'} Working`;
  const contextHeading = globalAlertsOpen
    ? unread === 1 ? '1 alert' : `${unread} alerts`
    : searchOpen
    ? 'Search'
    : agentOpen
    ? activeAgent?.name ?? selectedFleetAgent?.name ?? 'Loading agent'
    : settingsOpen
    ? 'Settings'
    : homeHeading;
  const orderedShortcutAgents = useMemo(
    () =>
      [...agents].sort((left, right) =>
        (left.fleetPosition ?? Number.MAX_SAFE_INTEGER) -
          (right.fleetPosition ?? Number.MAX_SAFE_INTEGER) ||
        left.agent.name.localeCompare(right.agent.name)
      ),
    [agents],
  );

  useEffect(() => {
    let active = true;
    const requestedAtMutationGeneration = sharedFleetMutationGeneration.current;
    void launchApi.fleetPreferences()
      .then(({ preferences }) => {
        if (!active) return;
        const reconciled = reconcileFleetPreferenceRead(
          preferences,
          requestedAtMutationGeneration,
          sharedFleetMutationGeneration.current,
          latestSharedFleetRevision.current,
        );
        if (reconciled === preferences) {
          acceptShortcutPreferences(preferences);
        } else {
          setShortcutPreferences(reconciled);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [acceptShortcutPreferences]);

  const commitFleetOrder = useCallback(async (agentIds: string[]) => {
    if (
      fleetOrderBusy ||
      !fleet?.fleetRevision ||
      agentIds.length !== agents.length
    ) return;
    const before = fleet;
    const positionById = new Map(
      agentIds.map((agentId, fleetPosition) => [agentId, fleetPosition]),
    );
    setFleetOrderBusy(true);
    setFleetOrderError('');
    setRetainedFleet({
      ...fleet,
      agents: [...agents].sort((left, right) =>
        (positionById.get(left.agent.id) ?? Number.MAX_SAFE_INTEGER) -
        (positionById.get(right.agent.id) ?? Number.MAX_SAFE_INTEGER)
      ).map((item) => ({
        ...item,
        fleetPosition: positionById.get(item.agent.id) ?? null,
      })),
    });
    try {
      const response = await launchApi.updateFleetOrder({
        agentIds,
        expectedRevision: fleet.fleetRevision,
      });
      sharedFleetMutationGeneration.current += 1;
      latestSharedFleetRevision.current = response.revision;
      const confirmedPositions = new Map(
        response.positions.map((position) => [
          position.agentId,
          position.fleetPosition,
        ]),
      );
      setRetainedFleet((current) =>
        current
          ? {
            ...current,
            fleetRevision: response.revision,
            agents: [...current.agents].sort((left, right) =>
              (confirmedPositions.get(left.agent.id) ??
                Number.MAX_SAFE_INTEGER) -
              (confirmedPositions.get(right.agent.id) ??
                Number.MAX_SAFE_INTEGER)
            ).map((item) => ({
              ...item,
              fleetPosition: confirmedPositions.get(item.agent.id) ?? null,
            })),
          }
          : current
      );
      setShortcutPreferences((current) =>
        withSharedPreferenceRevision(
          current,
          response.revision,
          response.updatedAt,
        )
      );
      sounds.confirm();
      void live.reload();
    } catch (error) {
      setRetainedFleet(before);
      setFleetOrderError(
        error instanceof Error ? error.message : 'The Agent order could not be saved.',
      );
      void live.reload();
    } finally {
      setFleetOrderBusy(false);
    }
  }, [agents, fleet, fleetOrderBusy, live.reload]);

  const dropFleetAgent = useCallback((
    sourceAgentId: string,
    targetAgentId: string,
  ) => {
    const ordered = moveFleetAgentBefore(
      agents.map((item) => item.agent.id),
      sourceAgentId,
      targetAgentId,
    );
    if (ordered) void commitFleetOrder(ordered);
  }, [agents, commitFleetOrder]);

  const moveFleetAgent = useCallback((
    agentId: string,
    offset: -1 | 1,
  ) => {
    const ordered = moveFleetAgentByOffset(
      agents.map((item) => item.agent.id),
      agentId,
      offset,
    );
    if (ordered) void commitFleetOrder(ordered);
  }, [agents, commitFleetOrder]);

  useEffect(() => {
    setUnread((current) => Math.max(current, fleetUnread));
  }, [fleetUnread]);

  useEffect(() => {
    const resolvedCount = live.data.fleet?.workingSummary?.working ??
      live.data.fleet?.agents.filter(isFleetAgentWorkingOrReady).length;
    if (resolvedCount === undefined) return;
    setCachedFleetCount((current) => current === resolvedCount ? current : resolvedCount);
    writeCachedFleetCount(
      window.localStorage,
      getLaunchAuthToken(),
      resolvedCount,
    );
  }, [live.data.fleet?.agents, live.data.fleet?.workingSummary?.working]);

  useEffect(() => {
    if (fleetLoading) {
      if (fleetLoaderStartedAt.current === null) {
        fleetLoaderStartedAt.current = Date.now();
      }
      setHoldFleetLoader(true);
      return;
    }
    if (!holdFleetLoader || fleetLoaderStartedAt.current === null) return;
    const remaining = Math.max(
      0,
      1_250 - (Date.now() - fleetLoaderStartedAt.current),
    );
    const timer = window.setTimeout(() => {
      fleetLoaderStartedAt.current = null;
      setHoldFleetLoader(false);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [fleetLoading, holdFleetLoader]);

  useEffect(() => {
    const onScroll = () => setAtPageTop(window.scrollY <= 1);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const timers = new Map<Element, number>();
    const onPanelScroll = (event: Event) => {
      const panel = event.target instanceof Element
        ? event.target.closest('.neb-modal-content, .neb-alerts-content')
        : null;
      if (!panel) return;
      panel.classList.add('neb-scrolling');
      const previous = timers.get(panel);
      if (previous) window.clearTimeout(previous);
      timers.set(
        panel,
        window.setTimeout(() => {
          panel.classList.remove('neb-scrolling');
          timers.delete(panel);
        }, 650),
      );
    };
    document.addEventListener('scroll', onPanelScroll, true);
    return () => {
      document.removeEventListener('scroll', onPanelScroll, true);
      timers.forEach((timer, panel) => {
        window.clearTimeout(timer);
        panel.classList.remove('neb-scrolling');
      });
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const refreshUnread = () => {
      void launchApi.listNotifications({ unreadOnly: true, limit: 1 })
        .then((response) => {
          if (mounted) setUnread(response.unread_count);
        })
        .catch(() => undefined);
    };
    refreshUnread();
    const id = window.setInterval(refreshUnread, 60_000);
    return () => {
      mounted = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = resolveLaunchShortcut(event, {
        activeElement: document.activeElement,
        dialogActive: modalStack.length > 0,
        config: shortcutConfig,
      });
      if (!action) return;
      event.preventDefault();
      const position = launchAgentShortcutPosition(action);
      if (position) {
        const target = orderedShortcutAgents[position - 1];
        if (target) {
          navigate(`/agents/${encodeURIComponent(target.agent.slug)}`, {
            scroll: 'top',
          });
        }
        return;
      }
      if (action === 'search') navigate('/?panel=search');
      else if (action === 'alerts') navigate('/?panel=alerts');
      else if (action === 'settings') navigate('/account');
      else if (action === 'help') setShortcutHelpOpen(true);
      else if (action === 'dismiss' && workspaceOpen) {
        sounds.close();
        dismissLaunchWorkspace(navigate, returnToAlerts);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [
    modalStack.length,
    navigate,
    orderedShortcutAgents,
    returnToAlerts,
    shortcutConfig,
    workspaceOpen,
  ]);

  useEffect(() => {
    if (!globalAlertsOpen && !searchOpen && !agentOpen && !settingsOpen) return;
    const onOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.closest(
          '.neb-inline-panel, .neb-topbar-shell, .neb-modal-overlay, .neb-agent-card',
        )
      ) return;
      sounds.close();
      dismissLaunchWorkspace(navigate, returnToAlerts);
    };
    document.addEventListener('mousedown', onOutsideMouseDown);
    return () => {
      document.removeEventListener('mousedown', onOutsideMouseDown);
    };
  }, [
    agentOpen,
    globalAlertsOpen,
    navigate,
    returnToAlerts,
    searchOpen,
    settingsOpen,
  ]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest(
        'button, .neb-agent-card, .neb-add-agent-card, .neb-notif-item, .neb-cmdk-item',
      );
      if (target && !target.classList.contains('neb-modal-close')) {
        sounds.click();
      }
    };
    const onHover = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest(
        'button, .neb-agent-card, .neb-add-agent-card, .neb-notif-item, .neb-cmdk-item',
      );
      if (
        !target ||
        (event.relatedTarget && target.contains(event.relatedTarget as Node))
      ) return;
      sounds.hover();
    };
    document.addEventListener('click', onClick);
    document.addEventListener('mouseover', onHover);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('mouseover', onHover);
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => live.reload(), 60_000);
    return () => window.clearInterval(id);
  }, [live.reload]);

  const searchShortcutLabel = launchShortcutDisplayLabel(
    'search',
    shortcutConfig,
  );
  return (
    <div className='nebula-root'>
      <Starfield />
      <div className='neb-nebula n1' aria-hidden='true' />
      <div className='neb-nebula n2' aria-hidden='true' />
      <div className='neb-nebula n3' aria-hidden='true' />
      <div className='neb-grain' aria-hidden='true' />

      <header className='neb-topbar-shell'>
        <div className='neb-topbar'>
          <button
            className='neb-wordmark'
            onClick={() => navigate('/')}
            type='button'
          >
            galactic
            <span className='neb-wordmark-tier'>
              {(fleet?.accountCapacity.plan ?? '').replace('max_5x', 'max')
                .replace('max_10x', 'ultra')}
            </span>
          </button>
          <div className='neb-topbar-actions'>
            <button
              aria-keyshortcuts={launchShortcutAriaKeyShortcuts(
                'search',
                shortcutConfig,
              )}
              className='neb-cmdk-chip'
              onClick={() => navigate('/?panel=search')}
              type='button'
            >
              Search
              {searchShortcutLabel ? <kbd>{searchShortcutLabel}</kbd> : null}
            </button>
            <button
              aria-keyshortcuts={launchShortcutAriaKeyShortcuts(
                'alerts',
                shortcutConfig,
              )}
              className='neb-icon-btn'
              onClick={() => navigate('/?panel=alerts')}
              aria-label='Alerts'
              type='button'
            >
              <Glyph name='bell' />
              {unread > 0 ? <span className='neb-notif-dot' /> : null}
            </button>
            <button
              aria-keyshortcuts={launchShortcutAriaKeyShortcuts(
                'settings',
                shortcutConfig,
              )}
              className='neb-icon-btn'
              onClick={() => navigate('/account')}
              aria-label='Settings'
              type='button'
            >
              <Glyph name='gear' />
            </button>
          </div>
        </div>
      </header>

      <main className='neb-app'>
        <section
          className={`neb-hero${
            globalAlertsOpen || searchOpen || agentOpen || settingsOpen ? ' neb-context-hero' : ''
          }`}
        >
          <h1>{contextHeading}</h1>
          {!workspaceOpen
            ? (
              <HomeHeroActions
                onAlerts={() => navigate('/?panel=alerts')}
                unread={unread}
              />
            )
            : null}
        </section>
        {globalAlertsOpen
          ? (
            <GlobalAlerts
              onNavigate={(path) => {
                const next = new URL(path, window.location.origin);
                next.searchParams.set('from', 'alerts');
                navigate(`${next.pathname}${next.search}`);
              }}
              onUnreadChange={setUnread}
            />
          )
          : searchOpen
          ? (
            <SearchPanel
              agents={agents}
              onClose={() => {
                sounds.close();
                dismissLaunchWorkspace(navigate);
              }}
              onNavigate={navigate}
              onAlerts={() => navigate('/?panel=alerts')}
            />
          )
          : agentOpen
          ? (
            <AgentPanel
              agent={activeAgent ?? selectedFleetAgent}
              detailReady={Boolean(activeAgent)}
              fleetAgent={agents.find((item) => item.agent.slug === route.params.slug) ?? null}
              initialUnread={selectedFleetSummary
                ? fleetAgentAttentionCount(selectedFleetSummary)
                : 0}
              itemId={agentRouteState?.item}
              key={route.params.slug}
              live={live}
              onNavigate={navigate}
              onPaneChange={(pane) => {
                const next = updateAgentRouteState(location, { pane });
                if (next) navigate(next, { scroll: 'preserve' });
              }}
              onClose={() => {
                sounds.close();
                dismissLaunchWorkspace(navigate, returnToAlerts);
              }}
              pane={agentRouteState?.pane ?? DEFAULT_AGENT_PANE}
            />
          )
          : settingsOpen
          ? (
            <SettingsPanel
              fleetRevision={fleet?.fleetRevision ?? null}
              initial={live.data}
              onShortcutPreferencesChange={(preferences) =>
                acceptShortcutPreferences(preferences, true)}
              onClose={() => {
                sounds.close();
                dismissLaunchWorkspace(navigate, returnToAlerts);
              }}
              shortcutPreferences={shortcutPreferences}
            />
          )
          : null}

        <FleetRoster
          behindWorkspace={workspaceOpen && atPageTop}
          error={live.status === 'error' && agents.length === 0
            ? live.error || 'Fleet could not be loaded.'
            : fleetOrderError || undefined}
          loading={showFleetLoader}
        >
          {agents.map((item, index) => (
            <FleetCard
              agentCount={agents.length}
              canReorder={Boolean(fleet?.fleetRevision) && agents.length > 1}
              index={index}
              item={item}
              key={item.agent.id}
              now={now}
              onDropAgent={dropFleetAgent}
              onIconChanged={live.reload}
              onMoveAgent={moveFleetAgent}
              onOpen={() =>
                navigate(
                  agentOpen && route.params.slug === item.agent.slug
                    ? '/'
                    : `/agents/${encodeURIComponent(item.agent.slug)}`,
                )}
              reorderBusy={fleetOrderBusy}
              shortcutConfig={shortcutConfig}
            />
          ))}
          <AddAgentCard number={agents.length + 1} />
        </FleetRoster>
      </main>
      {shortcutHelpOpen
        ? (
          <Modal
            className='neb-shortcut-help'
            label='Keyboard shortcuts'
            onClose={() => setShortcutHelpOpen(false)}
          >
            <CloseButton onClose={() => setShortcutHelpOpen(false)} />
            <div className='neb-modal-content'>
              <h2 className='neb-modal-h'>Keyboard shortcuts</h2>
              <div className='neb-shortcut-list'>
                {([
                  ['Search', 'search'],
                  ['Alerts', 'alerts'],
                  ['Settings', 'settings'],
                  ['Agents 1–9', 'agent-1'],
                  ['Agent 10', 'agent-10'],
                  ['This help', 'help'],
                  ['Close focused page', 'dismiss'],
                ] as const).map(([label, action]) => (
                  <div className='neb-ov-row' key={action}>
                    <span className='neb-ov-row-key'>{label}</span>
                    <kbd>
                      {action === 'agent-1'
                        ? '1–9'
                        : launchShortcutDisplayLabel(action, shortcutConfig) ??
                          'Off'}
                    </kbd>
                  </div>
                ))}
              </div>
              <p className='neb-ov-note'>
                Shortcuts pause while you type, use an embedded Interface, or interact with a
                dialog.
              </p>
            </div>
          </Modal>
        )
        : null}
    </div>
  );
}

function NotificationRow({
  notification,
  onOpen,
}: {
  notification: LaunchNotification;
  onOpen: () => void;
}): ReactElement {
  return (
    <button
      className={`neb-notif-item${notification.read_at ? '' : ' unread'}`}
      onClick={onOpen}
      type='button'
    >
      <span
        className={`neb-notif-icon ${notification.severity !== 'info' ? 'warn' : ''}`}
      >
        <Glyph
          name={notification.severity !== 'info' ? 'alert' : 'spark'}
        />
      </span>
      <span className='neb-notif-body'>
        <span className='neb-notif-title'>{notification.title}</span>
        {notification.body ? <span className='neb-notif-copy'>{notification.body}</span> : null}
        <span className='neb-notif-time'>
          {formatRelative(notification.created_at)}
        </span>
      </span>
    </button>
  );
}

function GlobalAlerts({
  onNavigate,
  onUnreadChange,
}: {
  onNavigate: LaunchNavigate;
  onUnreadChange: (count: number) => void;
}): ReactElement {
  const [attention, setAttention] = useState<
    LaunchGlobalAttentionResponse | null
  >(null);
  const [agentCounts, setAgentCounts] = useState<
    Record<string, { openCount: number; requiresDecisionCount: number }>
  >({});
  const [exactOpenCount, setExactOpenCount] = useState(0);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setError('');
    try {
      const response = await launchApi.globalAttention();
      setAttention(response);
      const counts: Record<
        string,
        { openCount: number; requiresDecisionCount: number }
      > = {};
      for (const count of response.agentCounts) {
        counts[count.agent.id] = {
          openCount: count.openCount,
          requiresDecisionCount: count.requiresDecisionCount,
        };
      }
      setAgentCounts(counts);
      setExactOpenCount(response.openCount);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Account Alerts are temporarily unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [onUnreadChange]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!attention) return;
    onUnreadChange(exactOpenCount);
  }, [attention, exactOpenCount, onUnreadChange]);
  const loadOlder = useCallback(async () => {
    if (!attention?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const page = await launchApi.globalAttention({
        cursor: attention.nextCursor,
        limit: 200,
      });
      setAttention((current) =>
        current ? appendGlobalAttentionPage(current, page) : page
      );
      setAgentCounts(
        Object.fromEntries(
          globalAttentionAgentCountMap(page.agentCounts).entries(),
        ),
      );
      setExactOpenCount(page.openCount);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Older account Alerts could not be loaded.',
      );
    } finally {
      setLoadingMore(false);
    }
  }, [attention?.nextCursor, loadingMore]);
  const groups = useMemo(
    () => groupGlobalAttentionEntries(attention?.entries || []),
    [attention?.entries],
  );
  const visibleGroups = groups.filter((group) =>
    (attention?.entries || []).some((entry) =>
      entry.agent.id === group.agent.id &&
      globalAttentionEntryMatches(entry, query)
    )
  );
  return (
    <section className='neb-inline-panel neb-alerts-panel' aria-label='Alerts'>
      <div className='neb-alerts-toolbar'>
        <label className='neb-alerts-search'>
          <Glyph name='search' />
          <input
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder='Search alerts'
            value={query}
          />
        </label>
      </div>
      <div className='neb-alerts-content'>
        {visibleGroups.map((group) => (
          <OperatorAgentAlerts
            agent={group.agent}
            attention={{
              items: group.items,
              openCount: agentCounts[group.agent.id]?.openCount || 0,
              requiresDecisionCount:
                agentCounts[group.agent.id]?.requiresDecisionCount || 0,
              nextCursor: null,
              available: attention?.available ?? true,
              unavailableReason: attention?.unavailableReason ?? null,
            }}
            embedded
            key={group.agent.id}
            onAttentionCountChange={(count) => {
              setAgentCounts((current) => {
                const previous = current[group.agent.id]?.openCount || 0;
                if (previous === count) return current;
                setExactOpenCount((exact) =>
                  exactGlobalAttentionCountAfterAgentChange(
                    exact,
                    previous,
                    count,
                  )
                );
                return {
                  ...current,
                  [group.agent.id]: {
                    openCount: count,
                    requiresDecisionCount:
                      current[group.agent.id]?.requiresDecisionCount || 0,
                  },
                };
              });
            }}
            onNavigate={onNavigate}
            query={query}
          />
        ))}
        {!loading && !error && visibleGroups.length === 0
          ? (
            <div className='neb-alerts-empty'>
              {query ? 'No alerts match.' : 'Nothing needs your attention.'}
            </div>
          )
          : null}
        {attention?.nextCursor
          ? (
            <button
              className='neb-add-row'
              disabled={loadingMore}
              onClick={() => void loadOlder()}
              type='button'
            >
              {loadingMore ? 'Loading older alerts…' : 'Load older alerts'}
            </button>
          )
          : null}
        {loading ? <div className='neb-alerts-empty'>Loading alerts…</div> : null}
        {error
          ? (
            <div className='neb-compute-gate' role='alert'>
              <strong>Account Alerts are temporarily unavailable.</strong>
              <p>{error}</p>
              <button
                className='neb-btn-sm secondary'
                onClick={() => void refresh()}
                type='button'
              >
                Try again
              </button>
            </div>
          )
          : null}
      </div>
    </section>
  );
}

function SettingsPanel({
  fleetRevision,
  initial,
  onClose,
  onShortcutPreferencesChange,
  shortcutPreferences,
}: {
  fleetRevision: string | null;
  initial: LaunchPageProps['live']['data'];
  onClose: () => void;
  onShortcutPreferencesChange: (preferences: LaunchFleetPreferences) => void;
  shortcutPreferences: LaunchFleetPreferences | null;
}): ReactElement {
  const requested = new URLSearchParams(window.location.search).get('pane') as
    | SettingsPane
    | null;
  const [pane, setPane] = useState<SettingsPane>(
    requested &&
      ['general', 'shortcuts', 'billing', 'usage', 'byok', 'keys', 'connect']
        .includes(requested)
      ? requested
      : 'general',
  );
  const [showing, setShowing] = useState(Boolean(requested));
  const [subscription, setSubscription] = useState<
    LaunchSubscriptionResponse | undefined
  >(initial.subscription);
  const [byok, setByok] = useState<LaunchByokSummaryResponse | undefined>(
    initial.byok,
  );
  const [keys, setKeys] = useState(initial.apiKeys?.apiKeys ?? []);
  const [settings, setSettings] = useState<LaunchSettingsResponse | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const [subResult, byokResult, keysResult, settingsResult] = await Promise
      .allSettled([
        launchApi.subscription(),
        launchApi.byok(),
        launchApi.apiKeys(),
        launchApi.getLaunchSettings(),
      ]);
    if (subResult.status === 'fulfilled') setSubscription(subResult.value);
    if (byokResult.status === 'fulfilled') setByok(byokResult.value);
    if (keysResult.status === 'fulfilled') setKeys(keysResult.value.apiKeys);
    if (settingsResult.status === 'fulfilled') {
      setSettings(settingsResult.value);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const choose = (next: SettingsPane) => {
    setPane(next);
    setShowing(true);
  };
  return (
    <section
      className={`neb-inline-panel neb-settings-panel railed${showing ? ' showing-content' : ''}`}
      aria-label='Settings'
    >
      <nav className='neb-modal-rail' aria-label='Settings sections'>
        {([
          ['general', 'General'],
          ['shortcuts', 'Shortcuts'],
          ['billing', 'Billing'],
          ['usage', 'Usage'],
          ['byok', 'BYOK Setup'],
          ['keys', 'Galactic Keys'],
          ['connect', 'Connect AI'],
        ] as const).map(([id, label]) => (
          <button
            className={`neb-rail-btn${pane === id ? ' active' : ''}`}
            key={id}
            onClick={() => choose(id)}
            type='button'
          >
            {label}
          </button>
        ))}
      </nav>
      <div className='neb-modal-content'>
        <button
          className='neb-mobile-back'
          onClick={() => setShowing(false)}
          type='button'
        >
          ‹ Menu
        </button>
        {error ? <p className='neb-error-note' role='alert'>{error}</p> : null}
        {pane === 'general'
          ? (
            <GeneralSettings
              settings={settings}
              onChange={setSettings}
              setError={setError}
            />
          )
          : null}
        {pane === 'shortcuts'
          ? (
            <ShortcutSettings
              expectedRevision={fleetRevision}
              onChange={onShortcutPreferencesChange}
              preferences={shortcutPreferences}
              setError={setError}
            />
          )
          : null}
        {pane === 'billing'
          ? <BillingSettings subscription={subscription} setError={setError} />
          : null}
        {pane === 'usage' ? <UsageSettings subscription={subscription} /> : null}
        {pane === 'byok'
          ? <ByokSettings byok={byok} onChange={setByok} setError={setError} />
          : null}
        {pane === 'keys'
          ? <KeySettings keys={keys} onChange={setKeys} setError={setError} />
          : null}
        {pane === 'connect' ? <ConnectSettings setError={setError} /> : null}
      </div>
    </section>
  );
}

function GeneralSettings({
  settings,
  onChange,
  setError,
}: {
  settings: LaunchSettingsResponse | null;
  onChange: (value: LaunchSettingsResponse) => void;
  setError: (value: string) => void;
}): ReactElement {
  const [name, setName] = useState(settings?.displayName ?? '');
  const [saved, setSaved] = useState(false);
  useEffect(() => setName(settings?.displayName ?? ''), [
    settings?.displayName,
  ]);
  const save = async () => {
    setError('');
    try {
      const response = await launchApi.updateLaunchSettings({
        displayName: name.trim() || null,
      });
      onChange(response);
      setSaved(true);
      sounds.confirm();
      window.setTimeout(() => setSaved(false), 1200);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <section className='neb-modal-pane active'>
      <h2 className='neb-modal-h'>General</h2>
      <label className='neb-field-label'>Display name</label>
      <div className='neb-inline-field'>
        <input
          className='neb-edit-input'
          onChange={(event) => setName(event.currentTarget.value)}
          value={name}
        />
        <button
          className={`neb-btn-sm${saved ? ' saved' : ''}`}
          onClick={() => void save()}
          type='button'
        >
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>
      <div className='neb-ov-row'>
        <span className='neb-ov-row-key'>Account mode</span>
        <span className='neb-ov-row-val'>Private fleet</span>
      </div>
      <div className='neb-ov-row'>
        <span className='neb-ov-row-key'>Inference</span>
        <span className='neb-ov-row-val'>BYOK only</span>
      </div>
      <button
        className='neb-btn neb-signout'
        onClick={() =>
          void signOutLaunch().finally(() => {
            window.location.href = '/';
          })}
        type='button'
      >
        Sign out
      </button>
    </section>
  );
}

const SHORTCUT_LABELS: Record<LaunchShortcutAction, string> = {
  search: 'Search',
  alerts: 'Alerts',
  settings: 'Settings',
  'agent-1': 'Agent 1',
  'agent-2': 'Agent 2',
  'agent-3': 'Agent 3',
  'agent-4': 'Agent 4',
  'agent-5': 'Agent 5',
  'agent-6': 'Agent 6',
  'agent-7': 'Agent 7',
  'agent-8': 'Agent 8',
  'agent-9': 'Agent 9',
  'agent-10': 'Agent 10',
  help: 'Shortcut help',
  dismiss: 'Close focused page',
};

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

function ShortcutSettings({
  expectedRevision,
  onChange,
  preferences,
  setError,
}: {
  expectedRevision: string | null;
  onChange: (preferences: LaunchFleetPreferences) => void;
  preferences: LaunchFleetPreferences | null;
  setError: (value: string) => void;
}): ReactElement {
  const [enabled, setEnabled] = useState(
    preferences?.shortcutsEnabled ?? true,
  );
  const [bindings, setBindings] = useState(() => shortcutDraft(preferences));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!preferences) return;
    setEnabled(preferences.shortcutsEnabled);
    setBindings(shortcutDraft(preferences));
  }, [preferences]);

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
      setSaved(true);
      sounds.confirm();
      window.setTimeout(() => setSaved(false), 1200);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className='neb-modal-pane active'>
      <h2 className='neb-modal-h'>Keyboard shortcuts</h2>
      <label className='neb-shortcut-toggle'>
        <input
          checked={enabled}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
          type='checkbox'
        />
        <span>Enable shortcuts when no field or Interface has focus</span>
      </label>
      <div className='neb-shortcut-editor'>
        {LAUNCH_SHORTCUT_ACTIONS.map((action) => (
          <label className='neb-shortcut-edit-row' key={action}>
            <span>{SHORTCUT_LABELS[action]}</span>
            <input
              aria-label={`${SHORTCUT_LABELS[action]} shortcut`}
              disabled={!enabled}
              maxLength={8}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setBindings((current) => ({
                  ...current,
                  [action]: value === '' ? null : value,
                }));
              }}
              placeholder='Off'
              value={bindings[action] ?? ''}
            />
          </label>
        ))}
      </div>
      {!validation.valid
        ? (
          <p className='neb-error-note' role='alert'>
            {validation.issues[0]?.message}
          </p>
        )
        : null}
      <div className='neb-inline-actions'>
        <button
          className='neb-btn-sm'
          onClick={() => {
            setEnabled(true);
            setBindings({
              ...DEFAULT_LAUNCH_SHORTCUT_CONFIGURATION.bindings,
            });
          }}
          type='button'
        >
          Restore defaults
        </button>
        <button
          className={`neb-btn-sm${saved ? ' saved' : ''}`}
          disabled={!preferences || !validation.valid}
          onClick={() => void save()}
          type='button'
        >
          {preferences ? saved ? 'Saved' : 'Save' : 'Loading…'}
        </button>
      </div>
      <p className='neb-ov-note'>
        Shortcuts never fire while you type, compose with an IME, use a dialog, or interact with an
        embedded Interface.
      </p>
    </section>
  );
}

function BillingSettings({
  subscription,
  setError,
}: {
  subscription?: LaunchSubscriptionResponse;
  setError: (value: string) => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = subscription?.canManage
        ? await launchApi.createSubscriptionPortal()
        : await launchApi.createSubscriptionCheckout();
      markExternalReturnRevalidation();
      window.location.assign(result.url);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };
  return (
    <section className='neb-modal-pane active'>
      <h2 className='neb-modal-h'>Billing</h2>
      <div className='neb-plan-card'>
        <div>
          <div className='neb-plan-name'>
            {subscription?.planName ?? 'Loading…'}
          </div>
          <div className='neb-plan-price'>
            {subscription
              ? `$${(subscription.priceCents / 100).toLocaleString()} / month`
              : 'Checking Stripe…'}
            {subscription?.currentPeriodEnd
              ? ` · renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
              : ''}
          </div>
        </div>
        <button
          className='neb-btn'
          disabled={busy || !subscription}
          onClick={() => void open()}
          type='button'
        >
          {subscription?.canManage ? 'Manage in Stripe' : 'Upgrade to Pro'}
        </button>
      </div>
      <p className='neb-ov-note'>
        Subscription changes, payment methods, invoices, and cancellation are handled securely by
        Stripe.
      </p>
    </section>
  );
}

function UsageSettings(
  { subscription }: { subscription?: LaunchSubscriptionResponse },
): ReactElement {
  return (
    <section className='neb-modal-pane active'>
      <h2 className='neb-modal-h'>Usage</h2>
      {subscription
        ? ([
          ['5-hour limit', subscription.capacity.burst],
          ['Weekly limit', subscription.capacity.weekly],
        ] as const).map(([label, window]) => (
          <div className='neb-usage-block' key={label}>
            <div className='neb-usage-row'>
              <span className='neb-usage-label'>{label}</span>
              <span className='neb-usage-value'>
                {window.usedPercent === undefined
                  ? window.state
                  : `${Math.round(window.usedPercent)}% used`}
              </span>
            </div>
            <div className='neb-usage-bar'>
              <div
                className='neb-usage-bar-fill'
                style={{ width: `${asPercent(window.usedPercent)}%` }}
              />
            </div>
            <div className='neb-usage-reset'>
              Resets {new Date(window.resetsAt).toLocaleString()}
            </div>
          </div>
        ))
        : <p className='neb-ov-note'>Loading capacity…</p>}
      {subscription?.capacity.state === 'waiting'
        ? (
          <p className='neb-capacity-wait'>
            Agents are waiting and resume automatically in the next open capacity block.
          </p>
        )
        : null}
      <p className='neb-ov-note'>
        Capacity is pooled across every Agent on this account. Free allowance numbers remain
        unpublished, while status and reset time always stay visible.
      </p>
    </section>
  );
}

function ByokSettings({
  byok,
  onChange,
  setError,
}: {
  byok?: LaunchByokSummaryResponse;
  onChange: (value: LaunchByokSummaryResponse) => void;
  setError: (value: string) => void;
}): ReactElement {
  const refresh = async () => onChange(await launchApi.byok());
  return (
    <section className='neb-modal-pane active'>
      <h2 className='neb-modal-h'>BYOK Setup</h2>
      <p className='neb-ov-note top-note'>
        Your model API keys power galactic.ai() directly. Galactic does not resell or mark up
        inference.
      </p>
      {(byok?.providers ?? []).map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          onRefresh={refresh}
          setError={setError}
        />
      ))}
      {!byok ? <p className='neb-ov-note'>Loading inference providers…</p> : null}
    </section>
  );
}

function ProviderRow({
  provider,
  onRefresh,
  setError,
}: {
  provider: LaunchByokProviderOption;
  onRefresh: () => Promise<void>;
  setError: (value: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [model, setModel] = useState(
    provider.model ?? provider.defaultModel ?? '',
  );
  const [busy, setBusy] = useState(false);
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
      await onRefresh();
      setKey('');
      setOpen(false);
      sounds.confirm();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className='neb-provider-row'>
      <div className='neb-provider-head'>
        <div>
          <strong>{provider.name}</strong>
          <span>
            {provider.configured
              ? `${provider.apiKeyPrefix ?? 'Key'} · ${
                provider.model ?? provider.defaultModel ?? 'default model'
              }`
              : provider.description ?? 'Not connected'}
          </span>
        </div>
        <div className='neb-provider-actions'>
          {provider.configured && !provider.primary
            ? (
              <button
                className='neb-btn-sm'
                onClick={() =>
                  void launchApi.setByokPrimary(provider.id).then(onRefresh)
                    .catch((error) =>
                      setError(
                        error instanceof Error ? error.message : String(error),
                      )
                    )}
                type='button'
              >
                Make primary
              </button>
            )
            : null}
          <button
            className='neb-btn-sm'
            onClick={() => setOpen((value) => !value)}
            type='button'
          >
            {provider.configured ? 'Replace' : 'Add key'}
          </button>
          {provider.configured
            ? (
              <button
                className='neb-btn-sm danger'
                onClick={() => {
                  if (
                    !window.confirm(
                      `Disconnect ${provider.name}? Agents using it will wait until another configured provider is selected.`,
                    )
                  ) return;
                  void launchApi.deleteByokProvider(provider.id)
                    .then(onRefresh)
                    .catch((error) =>
                      setError(
                        error instanceof Error ? error.message : String(error),
                      )
                    );
                }}
                type='button'
              >
                Remove
              </button>
            )
            : null}
        </div>
      </div>
      {open
        ? (
          <div className='neb-provider-editor'>
            <input
              className='neb-edit-input'
              onChange={(event) => setKey(event.currentTarget.value)}
              placeholder='API key'
              type='password'
              value={key}
            />
            <input
              className='neb-edit-input'
              onChange={(event) => setModel(event.currentTarget.value)}
              placeholder={provider.defaultModel ?? 'Default model'}
              value={model}
            />
            <button
              className='neb-btn-sm'
              disabled={busy || !key.trim()}
              onClick={() => void save()}
              type='button'
            >
              {busy ? 'Validating…' : 'Save'}
            </button>
          </div>
        )
        : null}
    </div>
  );
}

function KeySettings({
  keys,
  onChange,
  setError,
}: {
  keys: LaunchApiKeySummary[];
  onChange: (value: LaunchApiKeySummary[]) => void;
  setError: (value: string) => void;
}): ReactElement {
  const [plaintext, setPlaintext] = useState('');
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
      sounds.confirm();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <section className='neb-modal-pane active'>
      <h2 className='neb-modal-h'>Galactic Keys</h2>
      <p className='neb-ov-note top-note'>
        Programmatic credentials for Galactic. Inference providers use separate BYOK keys.
      </p>
      {plaintext
        ? (
          <div className='neb-secret-reveal'>
            <code>{plaintext}</code>
            <CopyButton text={plaintext} />
            <p>Shown once. Store it now.</p>
          </div>
        )
        : null}
      {keys.map((key) => (
        <div className='neb-ov-connect' key={key.id}>
          <code>{key.name} · {key.tokenPrefix}••••</code>
          <button
            className='neb-btn-sm'
            onClick={() =>
              void launchApi.revokeApiKey(key.id).then(() =>
                onChange(keys.filter((candidate) => candidate.id !== key.id))
              ).catch((error) => setError(error instanceof Error ? error.message : String(error)))}
            type='button'
          >
            Revoke
          </button>
        </div>
      ))}
      <button className='neb-btn' onClick={() => void create()} type='button'>
        Create scoped key
      </button>
    </section>
  );
}

function ConnectSettings(
  { setError }: { setError: (value: string) => void },
): ReactElement {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setPrompt(await provisionConnectAgentPrompt());
      sounds.confirm();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className='neb-modal-pane active'>
      <h2 className='neb-modal-h'>Connect AI</h2>
      <p className='neb-ov-note top-note'>
        Pair Codex, Claude Code, Cursor, or another MCP client to deploy and supervise this fleet.
      </p>
      {prompt
        ? (
          <div className='neb-connect-prompt'>
            <pre>{prompt}</pre>
            <CopyButton text={prompt} />
          </div>
        )
        : (
          <button
            className='neb-btn'
            disabled={busy}
            onClick={() => void create()}
            type='button'
          >
            {busy ? 'Creating connection…' : 'Create connection prompt'}
          </button>
        )}
    </section>
  );
}

function AgentPanel({
  agent,
  detailReady,
  fleetAgent,
  initialUnread,
  itemId,
  live,
  onClose,
  onNavigate,
  onPaneChange,
  pane,
}: {
  agent: LaunchAgentSummary | null;
  detailReady: boolean;
  fleetAgent: LaunchFleetAgentSummary | null;
  initialUnread: number;
  itemId?: string;
  live: LaunchPageProps['live'];
  onClose: () => void;
  onNavigate: LaunchNavigate;
  onPaneChange: (pane: AgentPane) => void;
  pane: AgentPane;
}): ReactElement {
  const [showing, setShowing] = useState(pane !== DEFAULT_AGENT_PANE);
  const previousPane = useRef(pane);
  const [unread, setUnread] = useState(initialUnread);
  useEffect(() => {
    if (previousPane.current !== pane) {
      previousPane.current = pane;
      setShowing(true);
    }
  }, [pane]);
  useEffect(() => {
    if (!agent) return;
    let mounted = true;
    launchApi.listNotifications({
      agent: agentLocator(agent),
      unreadOnly: true,
      limit: 1,
    })
      .then((response) => {
        if (mounted) setUnread(response.unread_count);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [agent?.id, agent?.slug]);
  const choose = (next: AgentPane) => {
    setShowing(true);
    if (next !== pane) onPaneChange(next);
  };
  const interfaces = agent?.interfaces ?? [];
  const interfaceIdsKey = interfaces.map((item) => item.id).join('\u0000');
  const [preferences, setPreferences] = useState<LaunchAgentPreferences | null>(
    null,
  );
  const [preferencesError, setPreferencesError] = useState('');
  const preferencesReadGeneration = useRef(0);
  const preferencesMutationGeneration = useRef(0);
  const activityExpanded = itemId === 'activity';
  const [expandedActivity, setExpandedActivity] = useState<
    LaunchAgentActivityPreview | null
  >(null);
  const [activityNextCursor, setActivityNextCursor] = useState<string | null>(
    null,
  );
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState('');
  const loadActivity = useCallback(async (cursor?: string) => {
    if (!agent || activityLoading) return;
    setActivityLoading(true);
    try {
      const response = await launchApi.agentActivity(agentLocator(agent), {
        ...(cursor ? { cursor } : {}),
        limit: 20,
      });
      setExpandedActivity((current) =>
        mergeAgentActivityPages(cursor ? current : null, response.activity)
      );
      setActivityNextCursor(response.nextCursor);
      setActivityError('');
    } catch (reason) {
      setActivityError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setActivityLoading(false);
    }
  }, [activityLoading, agent?.id, agent?.slug]);
  useEffect(() => {
    setExpandedActivity(null);
    setActivityNextCursor(null);
    if (activityExpanded) void loadActivity();
  }, [activityExpanded, agent?.id]);
  useEffect(() => {
    const readGeneration = ++preferencesReadGeneration.current;
    const mutationGeneration = preferencesMutationGeneration.current;
    if (!agent) {
      setPreferences(null);
      return;
    }
    let mounted = true;
    const upstream = live.data.agentHome?.preferences;
    if (upstream?.agentId === agent.id) setPreferences(upstream);
    launchApi.agentPreferences(agentLocator(agent))
      .then(async ({ preferences: fetched }) => {
        if (!shouldApplyInterfaceFavoritesRead({
          mounted,
          readGeneration,
          currentReadGeneration: preferencesReadGeneration.current,
          mutationGeneration,
          currentMutationGeneration: preferencesMutationGeneration.current,
        })) return;
        let resolved = fetched;
        const legacy = readLegacyInterfaceFavoritesForMigration(
          window.localStorage,
          agent.id,
          interfaces.map((item) => item.id),
        );
        if (legacy !== null) {
          if (shouldMigrateLegacyInterfaceFavorites(fetched, legacy)) {
            const migrated = await launchApi.updateAgentPreferences(
              agentLocator(agent),
              {
                expectedRevision: fetched.revision,
                favoriteInterfaceIds: legacy,
                favoritesInitialized: true,
              },
            );
            resolved = migrated.preferences;
          }
          clearLegacyInterfaceFavorites(window.localStorage, agent.id);
        }
        if (shouldApplyInterfaceFavoritesRead({
          mounted,
          readGeneration,
          currentReadGeneration: preferencesReadGeneration.current,
          mutationGeneration,
          currentMutationGeneration: preferencesMutationGeneration.current,
        })) {
          setPreferences(resolved);
          setPreferencesError('');
        }
      })
      .catch((reason) => {
        if (!shouldApplyInterfaceFavoritesRead({
          mounted,
          readGeneration,
          currentReadGeneration: preferencesReadGeneration.current,
          mutationGeneration,
          currentMutationGeneration: preferencesMutationGeneration.current,
        })) return;
        setPreferencesError(
          reason instanceof Error ? reason.message : String(reason),
        );
      });
    return () => {
      mounted = false;
    };
  }, [agent?.id, interfaceIdsKey, live.data.agentHome?.preferences?.revision]);
  const toggleFavoriteInterface = async (interfaceId: string) => {
    if (!agent || !preferences) return;
    const mutationGeneration = ++preferencesMutationGeneration.current;
    const favoriteInterfaceIds = preferences.favoriteInterfaceIds.includes(
        interfaceId,
      )
      ? preferences.favoriteInterfaceIds.filter((id) => id !== interfaceId)
      : [...preferences.favoriteInterfaceIds, interfaceId];
    try {
      const next = await launchApi.updateAgentPreferences(
        agentLocator(agent),
        {
          expectedRevision: preferences.revision,
          favoriteInterfaceIds,
          favoritesInitialized: true,
        },
      );
      if (mutationGeneration === preferencesMutationGeneration.current) {
        setPreferences(next.preferences);
        setPreferencesError('');
        live.reload();
      }
    } catch (reason) {
      if (mutationGeneration !== preferencesMutationGeneration.current) return;
      setPreferencesError(
        reason instanceof Error ? reason.message : String(reason),
      );
      const current = await launchApi.agentPreferences(agentLocator(agent))
        .catch(() => null);
      if (
        current &&
        mutationGeneration === preferencesMutationGeneration.current
      ) setPreferences(current.preferences);
    }
  };
  const favoriteInterfaceIds = preferences?.favoriteInterfaceIds ?? [];
  const functions = live.data.agentFunctions;
  const home = live.data.agentHome;
  const selectedOverviewInterface = pane === 'overview' &&
      itemId?.startsWith('interface:')
    ? interfaces.find((item) => item.id === itemId.slice('interface:'.length)) ?? null
    : null;
  const staleOverviewItem = pane === 'overview' && Boolean(itemId) &&
    itemId !== 'activity' && !selectedOverviewInterface;
  const accessItemTarget = pane === 'access'
    ? resolveOperatorAccessItem(home?.access?.groups ?? [], itemId)
    : null;
  const selectedAccessSettingKey = accessItemTarget?.kind === 'setting'
    ? accessItemTarget.settingKey
    : null;
  const canonicalHomeReady = Boolean(
    home?.directive && home.operatingSummary && home.activity &&
      home.attention,
  );
  const navigateToAgentItem = (
    targetPane: AgentPane,
    targetItem: string | null,
  ) => {
    if (!agent) return;
    const next = updateAgentRouteState(
      {
        pathname: `/agents/${encodeURIComponent(agent.slug)}`,
        search: window.location.search,
      },
      { pane: targetPane, item: targetItem },
    );
    if (next) onNavigate(next, { scroll: 'preserve' });
  };
  return (
    <AgentPanelShell
      agentName={agent?.name ?? 'Loading Agent'}
      onMobileBack={() => setShowing(false)}
      onPaneChange={choose}
      pane={pane}
      showing={showing}
      unread={unread}
    >
      {!detailReady || !agent ? <AgentPanePlaceholder pane={pane} /> : (
        <>
          {pane === 'overview'
            ? canonicalHomeReady && home
              ? (
                <>
                  <OperatorAgentOverview
                    activityExpanded={activityExpanded}
                    activityLoading={activityLoading}
                    activityNextCursor={activityNextCursor}
                    activityOverride={expandedActivity}
                    home={home}
                    interfaces={interfaces}
                    onCloseActivity={() => navigateToAgentItem('overview', null)}
                    onEditDirective={() => {
                      const next = updateAgentRouteState(
                        {
                          pathname: `/agents/${encodeURIComponent(agent.slug)}`,
                          search: window.location.search,
                        },
                        {
                          pane: 'routines',
                          item: home.directive?.sourceRoutineId ?? null,
                        },
                      );
                      if (next) onNavigate(next, { scroll: 'preserve' });
                    }}
                    onNavigate={onNavigate}
                    onLoadMoreActivity={() => {
                      if (activityNextCursor) {
                        void loadActivity(activityNextCursor);
                      }
                    }}
                    onOpenActivity={() => {
                      const next = updateAgentRouteState(
                        {
                          pathname: `/agents/${encodeURIComponent(agent.slug)}`,
                          search: window.location.search,
                        },
                        { item: 'activity' },
                      );
                      if (next) onNavigate(next, { scroll: 'preserve' });
                    }}
                    onOpenInterface={(item) =>
                      navigateToAgentItem(
                        'overview',
                        `interface:${item.id}`,
                      )}
                  />
                  {activityError ? <p className='neb-error-note'>{activityError}</p> : null}
                </>
              )
              : (
                <AgentOverviewPane
                  agent={agent}
                  favoriteInterfaceIds={favoriteInterfaceIds}
                  fleetAgent={fleetAgent}
                  initialUnread={unread}
                  interfaces={interfaces}
                  live={live}
                  onOpenInterface={(item) =>
                    navigateToAgentItem(
                      'overview',
                      `interface:${item.id}`,
                    )}
                  onUnread={setUnread}
                />
              )
            : null}
          {pane === 'overview' && selectedOverviewInterface
            ? (
              <InterfaceViewer
                agent={agent}
                iface={selectedOverviewInterface}
                key={selectedOverviewInterface.id}
                onClose={() => navigateToAgentItem('overview', null)}
              />
            )
            : null}
          {staleOverviewItem
            ? (
              <StaleAgentItem
                label='Overview item'
                onClear={() => navigateToAgentItem('overview', null)}
                returnLabel='Overview'
              />
            )
            : null}
          {pane === 'alerts' && home?.attention
            ? (
              <OperatorAgentAlerts
                agent={agent}
                attention={home.attention}
                itemId={itemId}
                onAttentionCountChange={setUnread}
                onClearItem={() => navigateToAgentItem('alerts', null)}
                onNavigate={onNavigate}
              />
            )
            : null}
          {pane === 'alerts' && !home?.attention ? <AgentPanePlaceholder pane='alerts' /> : null}
          {pane === 'interfaces'
            ? (
              <InterfacesPane
                agent={agent}
                favoriteInterfaceIds={favoriteInterfaceIds}
                interfaces={interfaces}
                itemId={itemId}
                onNavigate={onNavigate}
                onToggleFavorite={(interfaceId) => void toggleFavoriteInterface(interfaceId)}
              />
            )
            : null}
          {pane === 'routines'
            ? (
              <RoutinesPane
                agent={agent}
                itemId={itemId}
                live={live}
                onNavigate={onNavigate}
              />
            )
            : null}
          {pane === 'functions'
            ? (
              <FunctionsPane
                agent={agent}
                functions={functions}
                itemId={itemId}
                live={live}
                onNavigate={onNavigate}
              />
            )
            : null}
          {pane === 'compute'
            ? (
              <AgentComputePane
                agent={agent}
                itemId={itemId}
                onClearItem={() => navigateToAgentItem('compute', null)}
              />
            )
            : null}
          {pane === 'access' && home?.access
            ? (
              <OperatorAgentAccess
                access={home.access}
                agentSlug={agent.slug}
                itemId={itemId}
                onConfigureSetting={(settingKey) => {
                  const next = updateAgentRouteState(
                    {
                      pathname: `/agents/${encodeURIComponent(agent.slug)}`,
                      search: window.location.search,
                    },
                    {
                      pane: 'access',
                      item: `setting:${settingKey}`,
                    },
                  );
                  if (next) onNavigate(next, { scroll: 'preserve' });
                }}
                onNavigate={onNavigate}
              />
            )
            : null}
          {pane === 'access' && !home?.access ? <AgentPanePlaceholder pane='access' /> : null}
          {pane === 'settings'
            ? (
              <AgentSettingsPane
                agent={agent}
                itemId={itemId}
                live={live}
                onClearItem={() => navigateToAgentItem('settings', null)}
              />
            )
            : null}
          {preferencesError ? <p className='neb-error-note'>{preferencesError}</p> : null}
          {selectedAccessSettingKey
            ? (
              <AgentAccessSettingEditor
                agent={agent}
                key={selectedAccessSettingKey}
                onClose={() => {
                  const next = updateAgentRouteState(
                    {
                      pathname: `/agents/${encodeURIComponent(agent.slug)}`,
                      search: window.location.search,
                    },
                    { pane: 'access', item: null },
                  );
                  if (next) onNavigate(next, { scroll: 'preserve' });
                }}
                onSaved={live.reload}
                settingKey={selectedAccessSettingKey}
              />
            )
            : null}
        </>
      )}
    </AgentPanelShell>
  );
}

function AgentOverviewPane({
  agent,
  favoriteInterfaceIds,
  fleetAgent,
  initialUnread,
  interfaces,
  live,
  onOpenInterface,
  onUnread,
}: {
  agent: LaunchAgentSummary;
  favoriteInterfaceIds: string[];
  fleetAgent: LaunchFleetAgentSummary | null;
  initialUnread: number;
  interfaces: LaunchInterfaceSummary[];
  live: LaunchPageProps['live'];
  onOpenInterface: (item: LaunchInterfaceSummary) => void;
  onUnread: (count: number) => void;
}): ReactElement {
  const [alerts, setAlerts] = useState<LaunchNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(initialUnread);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const now = useClock();
  const routines = live.data.agentRoutines;
  const active = (routines?.aggregate.active ?? 0) > 0;
  const overviewStatus = fleetAgent ? fleetStatusPresentation(fleetAgent, now) : {
    label: active ? 'Waiting for next event' : 'Standing by',
    showLiveSignal: true,
    waking: false,
  };
  const canPause = Boolean(
    routines?.routines.some((routine) => routine.status === 'active' && routine.actions.canPause),
  );
  const canResume = Boolean(
    routines?.routines.some((routine) =>
      routine.status === 'paused' && routine.actions.canActivate
    ),
  );
  const canToggle = canPause || canResume;
  const endpoint = live.data.install?.agentInstall?.agentMcpUrl ??
    `${launchApiOrigin()}/mcp/${agent.id}`;
  const favoriteInterfaceIdSet = new Set(favoriteInterfaceIds);
  const favoriteInterfaces = interfaces.filter((item) => favoriteInterfaceIdSet.has(item.id));
  const recentActions = fleetAgent?.recentActivity.slice(0, 5) ?? [];
  const hasUnreadAlerts = unreadCount > 0;
  const hasFavoriteInterfaces = favoriteInterfaces.length > 0;
  const hasRecentActions = recentActions.length > 0;
  const sectionBuckets = overviewSectionBuckets({
    hasUnreadAlerts,
    hasFavoriteInterfaces,
    hasRecentActivity: hasRecentActions,
  });

  useWarmInterfaceReadModels(agent, interfaces);

  useEffect(
    () => scheduleInterfaceWarmup(interfaces.map((item) => item.url)),
    [interfaces],
  );

  useEffect(() => {
    let mounted = true;
    setAlertsLoading(true);
    launchApi.listNotifications({
      agent: agentLocator(agent),
      unreadOnly: true,
      limit: 5,
    })
      .then((response) => {
        if (!mounted) return;
        setAlerts(response.notifications);
        setUnreadCount(response.unread_count);
        onUnread(response.unread_count);
      })
      .catch((reason) => {
        if (mounted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => mounted && setAlertsLoading(false));
    return () => {
      mounted = false;
    };
  }, [agent.id, agent.slug, onUnread]);

  const readAlert = async (item: LaunchNotification) => {
    await launchApi.markNotificationsRead({
      ids: [item.id],
      agent: agentLocator(agent),
    }).catch(() => undefined);
    live.reload();
    setAlerts((current) => current.filter((entry) => entry.id !== item.id));
    setUnreadCount((current) => {
      const next = Math.max(0, current - 1);
      onUnread(next);
      return next;
    });
  };

  const toggleAgent = async () => {
    if (!routines || busy) return;
    setBusy(true);
    setError('');
    try {
      let collection = await launchApi.agentRoutines(agentLocator(agent));
      const activeRoutines = collection.routines.filter((routine) =>
        routine.status === 'active' && routine.actions.canPause
      );
      const targets = activeRoutines.length > 0
        ? activeRoutines.map((routine) => [routine, 'pause'] as const)
        : collection.routines.filter((routine) =>
          routine.status === 'paused' && routine.actions.canActivate
        ).map((routine) => [routine, 'activate'] as const);
      for (const [routine, action] of targets) {
        await launchApi.actOnAgentManagedRoutine(
          agentLocator(agent),
          routine.id,
          {
            action,
            expectedRevision: collection.revision,
            idempotencyKey: randomId(),
          },
        );
        collection = await launchApi.agentRoutines(agentLocator(agent));
      }
      live.reload();
      sounds.confirm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const alertsSummary = (
    <section
      className='neb-overview-block neb-overview-alerts'
      aria-labelledby='neb-overview-alerts-title'
    >
      <div className='neb-overview-section-head compact'>
        <div className='neb-ov-label' id='neb-overview-alerts-title'>
          Unread Alerts
        </div>
        {unreadCount > 0 ? <span className='neb-rail-count'>{unreadCount}</span> : null}
      </div>
      {alerts.map((item) => (
        <NotificationRow
          key={item.id}
          notification={item}
          onOpen={() => void readAlert(item)}
        />
      ))}
      {!alertsLoading && alerts.length === 0
        ? <p className='neb-ov-note'>No unread alerts.</p>
        : null}
      {alertsLoading ? <p className='neb-ov-note'>Loading unread alerts…</p> : null}
      {unreadCount > alerts.length
        ? (
          <p className='neb-ov-note'>
            Showing the newest {alerts.length} of {unreadCount}. Open Alerts for the full list.
          </p>
        )
        : null}
    </section>
  );

  const interfacesSummary = (
    <section
      className='neb-overview-block'
      aria-labelledby='neb-overview-interfaces-title'
    >
      <div className='neb-ov-label' id='neb-overview-interfaces-title'>
        Favorites
      </div>
      <div className='neb-overview-interface-grid'>
        {favoriteInterfaces.map((item) => (
          <button
            className='neb-overview-interface'
            key={item.id}
            onClick={() => onOpenInterface(item)}
            onFocus={() => warmInterfaceDocument(item.url)}
            onPointerEnter={() => warmInterfaceDocument(item.url)}
            type='button'
          >
            <Glyph name='star' />
            <span>
              <strong>{item.label}</strong>
              <small>
                {item.description ??
                  `${item.functions.length} connected function${
                    item.functions.length === 1 ? '' : 's'
                  }`}
              </small>
            </span>
          </button>
        ))}
      </div>
    </section>
  );

  const recentActivitySummary = (
    <section
      className='neb-overview-block'
      aria-labelledby='neb-overview-actions-title'
    >
      <div className='neb-ov-label' id='neb-overview-actions-title'>
        Recent Activity
      </div>
      {recentActions.map((activity) => (
        <div className='neb-history-item' key={activity.id}>
          {activity.title}
          {activity.summary
            ? (
              <div className='neb-overview-action-summary'>
                {activity.summary}
              </div>
            )
            : null}
          <div className='neb-history-time'>
            {formatRelativePast(activity.createdAt)} · {activity.status}
          </div>
        </div>
      ))}
      {!hasRecentActions ? <p className='neb-ov-note'>No recent actions yet.</p> : null}
    </section>
  );
  const renderConditionalSection = (
    section: OverviewConditionalSection,
  ): ReactElement => {
    if (section === 'alerts') return alertsSummary;
    if (section === 'interfaces') return interfacesSummary;
    return recentActivitySummary;
  };

  const identity = (
    <section
      className='neb-overview-identity'
      aria-labelledby='neb-overview-identity-title'
    >
      <div className='neb-overview-section-head'>
        <div>
          <div className='neb-ov-label' id='neb-overview-identity-title'>
            Identity
          </div>
          <strong>{agent.name}</strong>
          {agent.description ? <p>{agent.description}</p> : null}
        </div>
        <button
          className='neb-btn-sm neb-overview-status-action'
          disabled={!canToggle || busy}
          onClick={() => void toggleAgent()}
          type='button'
        >
          <Glyph name={active ? 'pause' : 'play'} />
          {busy ? 'Updating…' : active ? 'Pause' : 'Resume'}
        </button>
      </div>
      <div className='neb-overview-status-line'>
        <span
          className={`neb-status-dot${overviewStatus.showLiveSignal ? '' : ' paused'}`}
        />
        {overviewStatus.label}
      </div>
    </section>
  );
  const connection = (
    <section
      className='neb-overview-block neb-overview-connection'
      aria-labelledby='neb-overview-connection-title'
    >
      <div className='neb-ov-label' id='neb-overview-connection-title'>
        Connection
      </div>
      <div className='neb-ov-connect neb-overview-connect'>
        <code>{endpoint}</code>
        <CopyButton text={endpoint} />
      </div>
    </section>
  );

  return (
    <AgentOverviewLayout
      afterIdentity={sectionBuckets.afterIdentity.map((section) => ({
        content: renderConditionalSection(section),
        key: `after-${section}`,
      }))}
      beforeIdentity={sectionBuckets.beforeIdentity.map((section) => ({
        content: renderConditionalSection(section),
        key: `before-${section}`,
      }))}
      connection={connection}
      error={error}
      identity={identity}
    />
  );
}

function AgentAccessSettingEditor({
  agent,
  onClose,
  onSaved,
  settingKey,
}: {
  agent: LaunchAgentSummary;
  onClose: () => void;
  onSaved: () => void;
  settingKey: string;
}): ReactElement {
  const [settings, setSettings] = useState<LaunchAgentSettingsResponse | null>(
    null,
  );
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let mounted = true;
    launchApi.agentSettings(agentLocator(agent))
      .then((response) => {
        if (mounted) setSettings(response);
      })
      .catch((reason) => {
        if (mounted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      mounted = false;
    };
  }, [agent.id, agent.slug]);
  const setting = settings?.settings.find((item) => item.key === settingKey) ??
    null;
  const save = async (nextValue: string | null) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await launchApi.updateAgentSettings(agentLocator(agent), {
        [settingKey]: nextValue,
      });
      sounds.confirm();
      onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      className='neb-routine-editor'
      label={`Configure ${setting?.label ?? settingKey}`}
      onClose={onClose}
    >
      <CloseButton onClose={onClose} />
      <div className='neb-modal-content'>
        <h2 className='neb-modal-h'>{setting?.label ?? settingKey}</h2>
        {setting
          ? (
            <>
              {setting.description
                ? <p className='neb-ov-note top-note'>{setting.description}</p>
                : null}
              <label
                className='neb-field-label'
                htmlFor={`agent-setting-${agent.id}-${setting.key}`}
              >
                {setting.configured
                  ? 'Replace configured value'
                  : setting.required
                  ? 'Required value'
                  : 'Value'}
              </label>
              <input
                autoComplete='off'
                className='neb-edit-input'
                id={`agent-setting-${agent.id}-${setting.key}`}
                onChange={(event) => setValue(event.currentTarget.value)}
                placeholder={setting.placeholder ?? undefined}
                type={setting.input === 'password' ? 'password' : 'text'}
                value={value}
              />
              <p className='neb-ov-note'>
                Existing values are never returned to the browser.
                {setting.help ? ` ${setting.help}` : ''}
              </p>
              <div className='neb-release-actions'>
                <button
                  className='neb-btn-sm'
                  disabled={busy || !value}
                  onClick={() => void save(value)}
                  type='button'
                >
                  {busy ? 'Saving…' : setting.configured ? 'Replace' : 'Save'}
                </button>
                {setting.configured
                  ? (
                    <button
                      className='neb-btn-sm'
                      disabled={busy}
                      onClick={() => void save(null)}
                      type='button'
                    >
                      Clear
                    </button>
                  )
                  : null}
              </div>
            </>
          )
          : !error
          ? <p className='neb-ov-note'>Loading configuration…</p>
          : null}
        {settings && !setting
          ? (
            <p className='neb-error-note'>
              This setting is not declared by the live Agent release.
            </p>
          )
          : null}
        {error ? <p className='neb-error-note' role='alert'>{error}</p> : null}
      </div>
    </Modal>
  );
}

function StaleAgentItem({
  label,
  onClear,
  returnLabel = `${label}s`,
}: {
  label: string;
  onClear: () => void;
  returnLabel?: string;
}): ReactElement {
  return (
    <div className='neb-stale-item' role='status'>
      <p className='neb-ov-note'>
        This {label.toLowerCase()} is no longer published by the live Agent.
      </p>
      <button className='neb-btn-sm' onClick={onClear} type='button'>
        Return to {returnLabel}
      </button>
    </div>
  );
}

function InterfacesPane({
  agent,
  favoriteInterfaceIds,
  interfaces,
  itemId,
  onNavigate,
  onToggleFavorite,
}: {
  agent: LaunchAgentSummary;
  favoriteInterfaceIds: string[];
  interfaces: LaunchInterfaceSummary[];
  itemId?: string;
  onNavigate: LaunchNavigate;
  onToggleFavorite: (interfaceId: string) => void;
}): ReactElement {
  const selected = itemId ? interfaces.find((item) => item.id === itemId) ?? null : null;
  useWarmInterfaceReadModels(agent, interfaces);
  useEffect(
    () => scheduleInterfaceWarmup(interfaces.map((item) => item.url)),
    [interfaces],
  );
  const navigateToInterface = (interfaceId: string | null) => {
    const next = updateAgentRouteState(
      {
        pathname: `/agents/${encodeURIComponent(agent.slug)}`,
        search: window.location.search,
      },
      { pane: 'interfaces', item: interfaceId },
    );
    if (next) onNavigate(next, { scroll: 'preserve' });
  };
  return (
    <section className='neb-modal-pane active'>
      <h2 className='neb-modal-h'>Interfaces</h2>
      <PromptButton agent={agent} kind='interface' />
      {interfaces.map((item) => {
        const favorite = favoriteInterfaceIds.includes(item.id);
        return (
          <div className='neb-interface-list-item' key={item.id}>
            <button
              aria-label={`${favorite ? 'Remove' : 'Add'} ${item.label} ${
                favorite ? 'from' : 'to'
              } favorites`}
              aria-pressed={favorite}
              className={`neb-interface-favorite${favorite ? ' active' : ''}`}
              onClick={() => onToggleFavorite(item.id)}
              title={favorite ? 'Remove from Favorites' : 'Add to Favorites'}
              type='button'
            >
              <Glyph name='star' />
            </button>
            <button
              className='neb-popup-item'
              onClick={() => navigateToInterface(item.id)}
              onFocus={() => warmInterfaceDocument(item.url)}
              onPointerEnter={() => warmInterfaceDocument(item.url)}
              type='button'
            >
              <span className='neb-popup-item-name'>{item.label}</span>
              <span className='neb-popup-item-desc'>
                {item.description ??
                  `${item.functions.length} connected function${
                    item.functions.length === 1 ? '' : 's'
                  }`}
              </span>
            </button>
          </div>
        );
      })}
      {interfaces.length === 0
        ? (
          <p className='neb-ov-note'>
            This Agent has not published a custom interface.
          </p>
        )
        : null}
      {selected
        ? (
          <InterfaceViewer
            agent={agent}
            iface={selected}
            key={selected.id}
            onClose={() => navigateToInterface(null)}
          />
        )
        : null}
      {itemId && !selected
        ? (
          <StaleAgentItem
            label='Interface'
            onClear={() => navigateToInterface(null)}
          />
        )
        : null}
    </section>
  );
}

function PromptButton(
  { agent, kind }: { agent: LaunchAgentSummary; kind: AgentExtensionKind },
): ReactElement {
  const [copyState, setCopyState] = useState<
    'idle' | 'creating' | 'copied' | 'error'
  >('idle');
  const cachedPromptRef = useRef<{ key: string; prompt: string } | null>(null);
  const copyPrompt = async () => {
    if (copyState === 'creating') return;
    setCopyState('creating');
    try {
      const cacheKey = `${agent.id}:${kind}`;
      const prompt = cachedPromptRef.current?.key === cacheKey
        ? cachedPromptRef.current.prompt
        : await provisionAgentExtensionPrompt(agent, kind);
      cachedPromptRef.current = { key: cacheKey, prompt };
      await copyTextToClipboard(prompt);
      setCopyState('copied');
      sounds.confirm();
      window.setTimeout(() => setCopyState('idle'), 3000);
    } catch {
      setCopyState('error');
      window.setTimeout(() => setCopyState('idle'), 3000);
    }
  };
  return (
    <button
      aria-live='polite'
      className={`neb-add-btn${
        copyState === 'copied' ? ' copied' : copyState === 'error' ? ' error' : ''
      }`}
      disabled={copyState === 'creating'}
      onClick={() => void copyPrompt()}
      type='button'
    >
      {copyState === 'creating'
        ? 'Creating secure prompt…'
        : copyState === 'copied'
        ? 'Copied — paste into your coding agent'
        : copyState === 'error'
        ? 'Couldn’t prepare prompt — try again'
        : `+ Add ${kind}`}
    </button>
  );
}

const INTERFACE_WINDOW_LEFT_GAP = 12;
const INTERFACE_WINDOW_TOP_CLEARANCE = 28;
const INTERFACE_WINDOW_RIGHT_CLEARANCE = 28;
const INTERFACE_WINDOW_BOTTOM_CLEARANCE = 28;

function useWarmInterfaceReadModels(
  agent: LaunchAgentSummary,
  interfaces: LaunchInterfaceSummary[],
): void {
  useEffect(() => {
    const prefetches = interfacePrefetches(interfaces);
    if (prefetches.length === 0) return;
    const timer = window.setTimeout(() => {
      for (const prefetch of prefetches) {
        void runInterfaceCallWithCache({
          agentId: agent.id,
          args: prefetch.args,
          artifactHash: prefetch.artifactHash,
          functionName: prefetch.functionName,
          interfaceId: prefetch.interfaceId,
          ownerScope: launchAuthSubject(getLaunchAuthToken()),
          readModel: prefetch.readModel,
          releaseVersion: prefetch.releaseVersion,
          execute: () =>
            runInterfaceFunctionDurably({
              client: launchApi,
              agentId: agent.id,
              functionName: prefetch.functionName,
              args: prefetch.args,
            }),
        }).catch(() => undefined);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [agent.id, interfaces]);
}

function InterfaceViewer({
  agent,
  iface,
  onClose,
}: {
  agent: LaunchAgentSummary;
  iface: LaunchInterfaceSummary;
  onClose: () => void;
}): ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const manuallyResized = useRef(false);
  const [interfaceReady, setInterfaceReady] = useState(false);
  const dragStart = useRef<
    {
      left: number;
      pointerId: number;
      top: number;
      x: number;
      y: number;
    } | null
  >(null);
  const resizeStart = useRef<
    {
      height: number;
      pointerId: number;
      width: number;
      x: number;
      y: number;
    } | null
  >(null);
  const [frame, setFrame] = useState(() => {
    const width = Math.max(
      1,
      window.innerWidth - INTERFACE_WINDOW_LEFT_GAP -
        INTERFACE_WINDOW_RIGHT_CLEARANCE,
    );
    const height = Math.min(
      Math.max(
        1,
        window.innerHeight - INTERFACE_WINDOW_TOP_CLEARANCE -
          INTERFACE_WINDOW_BOTTOM_CLEARANCE,
      ),
      clampInterfaceHeight(iface.minHeight ?? 360),
    );
    return {
      height,
      left: INTERFACE_WINDOW_LEFT_GAP,
      top: Math.max(
        INTERFACE_WINDOW_TOP_CLEARANCE,
        (window.innerHeight - height) / 2,
      ),
      width,
    };
  });
  const applyInterfaceHeight = useCallback((requestedHeight: number) => {
    if (manuallyResized.current) return;
    const height = Math.min(
      Math.max(
        1,
        window.innerHeight - INTERFACE_WINDOW_TOP_CLEARANCE -
          INTERFACE_WINDOW_BOTTOM_CLEARANCE,
      ),
      clampInterfaceHeight(requestedHeight),
    );
    setFrame((current) => ({
      ...current,
      height,
      top: Math.max(
        INTERFACE_WINDOW_TOP_CLEARANCE,
        (window.innerHeight - height) / 2,
      ),
    }));
  }, []);
  useLayoutEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const controller = new AbortController();
    const detach = attachInterfaceBridge({
      iframe,
      context: {
        agent: { id: agent.id, slug: agent.slug, name: agent.name },
        interfaceId: iface.id,
        signedIn: hasLaunchAuthToken(),
        minHeight: iface.minHeight ?? null,
      },
      allowlist: iface.functions,
      runFunction: (functionName, args) =>
        runInterfaceCallWithCache({
          agentId: agent.id,
          functionName,
          args,
          artifactHash: iface.artifactHash,
          interfaceId: iface.id,
          ownerScope: launchAuthSubject(getLaunchAuthToken()),
          readModel: interfaceReadModel(iface, functionName),
          releaseVersion: iface.releaseVersion,
          execute: () =>
            runInterfaceFunctionDurably({
              client: launchApi,
              agentId: agent.id,
              functionName,
              args,
              signal: controller.signal,
            }),
        }),
      onResize: applyInterfaceHeight,
      onConnected: () => setInterfaceReady(true),
    });
    return () => {
      controller.abort();
      detach();
    };
  }, [
    agent.id,
    agent.name,
    agent.slug,
    applyInterfaceHeight,
    iface.artifactHash,
    iface.functions,
    iface.id,
    iface.minHeight,
    iface.readModels,
    iface.releaseVersion,
  ]);
  useEffect(() => {
    const fitToViewport = () => {
      setFrame((current) => {
        const maxWidth = Math.max(
          1,
          window.innerWidth - INTERFACE_WINDOW_LEFT_GAP -
            INTERFACE_WINDOW_RIGHT_CLEARANCE,
        );
        const maxHeight = Math.max(
          1,
          window.innerHeight - INTERFACE_WINDOW_TOP_CLEARANCE -
            INTERFACE_WINDOW_BOTTOM_CLEARANCE,
        );
        const width = Math.min(current.width, maxWidth);
        const height = Math.min(current.height, maxHeight);
        return {
          width,
          height,
          left: Math.max(
            INTERFACE_WINDOW_LEFT_GAP,
            Math.min(
              current.left,
              window.innerWidth - width - INTERFACE_WINDOW_RIGHT_CLEARANCE,
            ),
          ),
          top: Math.max(
            INTERFACE_WINDOW_TOP_CLEARANCE,
            Math.min(
              current.top,
              window.innerHeight - height - INTERFACE_WINDOW_BOTTOM_CLEARANCE,
            ),
          ),
        };
      });
    };
    window.addEventListener('resize', fitToViewport);
    return () => window.removeEventListener('resize', fitToViewport);
  }, []);
  const resizeFrame = (
    nextWidth: number,
    nextHeight: number,
  ) => {
    setFrame((current) => {
      const maxWidth = Math.max(
        1,
        window.innerWidth - current.left - INTERFACE_WINDOW_RIGHT_CLEARANCE,
      );
      const maxHeight = Math.max(
        1,
        window.innerHeight - current.top - INTERFACE_WINDOW_BOTTOM_CLEARANCE,
      );
      const minWidth = Math.min(320, maxWidth);
      const minHeight = Math.min(180, maxHeight);
      return {
        ...current,
        width: Math.min(maxWidth, Math.max(minWidth, nextWidth)),
        height: Math.min(maxHeight, Math.max(minHeight, nextHeight)),
      };
    });
  };
  const moveFrame = (nextLeft: number, nextTop: number) => {
    setFrame((current) => ({
      ...current,
      left: Math.max(
        INTERFACE_WINDOW_LEFT_GAP,
        Math.min(
          nextLeft,
          window.innerWidth - current.width - INTERFACE_WINDOW_RIGHT_CLEARANCE,
        ),
      ),
      top: Math.max(
        INTERFACE_WINDOW_TOP_CLEARANCE,
        Math.min(
          nextTop,
          window.innerHeight - current.height -
            INTERFACE_WINDOW_BOTTOM_CLEARANCE,
        ),
      ),
    }));
  };
  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragStart.current = {
      left: frame.left,
      pointerId: event.pointerId,
      top: frame.top,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const continueDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = dragStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    moveFrame(
      start.left + event.clientX - start.x,
      start.top + event.clientY - start.y,
    );
  };
  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragStart.current?.pointerId !== event.pointerId) return;
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    manuallyResized.current = true;
    resizeStart.current = {
      height: frame.height,
      pointerId: event.pointerId,
      width: frame.width,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const continueResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = resizeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    resizeFrame(
      start.width + event.clientX - start.x,
      start.height + event.clientY - start.y,
    );
  };
  const finishResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeStart.current?.pointerId !== event.pointerId) return;
    resizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  return (
    <Modal
      className='neb-interface-modal'
      label={`${agent.name} — ${iface.label}`}
      onClose={onClose}
      overlayClassName='neb-interface-overlay'
      style={{
        height: frame.height,
        left: frame.left,
        maxHeight: 'none',
        position: 'fixed',
        top: frame.top,
        width: frame.width,
      }}
    >
      <button
        aria-label='Move interface'
        className='neb-interface-drag-handle'
        onKeyDown={(event) => {
          const amount = event.shiftKey ? 48 : 16;
          if (event.key === 'ArrowLeft') {
            moveFrame(
              frame.left - amount,
              frame.top,
            );
          } else if (event.key === 'ArrowRight') {
            moveFrame(
              frame.left + amount,
              frame.top,
            );
          } else if (event.key === 'ArrowUp') {
            moveFrame(
              frame.left,
              frame.top - amount,
            );
          } else if (event.key === 'ArrowDown') {
            moveFrame(
              frame.left,
              frame.top + amount,
            );
          } else return;
          event.preventDefault();
        }}
        onPointerCancel={finishDrag}
        onPointerDown={startDrag}
        onPointerMove={continueDrag}
        onPointerUp={finishDrag}
        title='Drag to move'
        type='button'
      />
      <div
        aria-busy={!interfaceReady}
        className={`neb-modal-content interface-content${interfaceReady ? ' ready' : ''}`}
      >
        <div className='neb-interface-boot' aria-hidden='true'>
          <span className='neb-interface-boot-orbit'>
            <i />
          </span>
          <span className='neb-interface-boot-label'>
            Opening {iface.label}
          </span>
          <span className='neb-interface-boot-track'>
            <i />
          </span>
        </div>
        <iframe
          className={`neb-interface-frame${interfaceReady ? ' ready' : ''}`}
          loading='eager'
          onLoad={() => setInterfaceReady(true)}
          ref={iframeRef}
          referrerPolicy='no-referrer'
          sandbox='allow-scripts allow-forms'
          src={iface.url}
          style={{ height: '100%' }}
          title={`${agent.name} — ${iface.label}`}
        />
      </div>
      <button
        aria-label='Resize interface'
        className='neb-interface-resize-handle'
        onKeyDown={(event) => {
          const amount = event.shiftKey ? 48 : 16;
          if (event.key === 'ArrowLeft') {
            resizeFrame(
              frame.width - amount,
              frame.height,
            );
          } else if (event.key === 'ArrowRight') {
            resizeFrame(
              frame.width + amount,
              frame.height,
            );
          } else if (event.key === 'ArrowUp') {
            resizeFrame(
              frame.width,
              frame.height - amount,
            );
          } else if (event.key === 'ArrowDown') {
            resizeFrame(
              frame.width,
              frame.height + amount,
            );
          } else return;
          event.preventDefault();
          manuallyResized.current = true;
        }}
        onPointerCancel={finishResize}
        onPointerDown={startResize}
        onPointerMove={continueResize}
        onPointerUp={finishResize}
        title='Drag to resize'
        type='button'
      />
    </Modal>
  );
}

function RoutinesPane({
  agent,
  itemId,
  live,
  onNavigate,
}: {
  agent: LaunchAgentSummary;
  itemId?: string;
  live: LaunchPageProps['live'];
  onNavigate: LaunchNavigate;
}): ReactElement {
  const [response, setResponse] = useState(live.data.agentRoutines);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => setResponse(live.data.agentRoutines), [
    live.data.agentRoutines,
  ]);
  const refresh = async () => {
    const next = await launchApi.agentRoutines(agentLocator(agent));
    setResponse(next);
    return next;
  };
  const act = async (
    routine: LaunchAgentRoutineOverview,
    action: 'pause' | 'activate' | 'run_now',
  ) => {
    if (!response || busy) return;
    setBusy(routine.id);
    setError('');
    try {
      await launchApi.actOnAgentManagedRoutine(
        agentLocator(agent),
        routine.id,
        {
          action,
          expectedRevision: response.revision,
          idempotencyKey: randomId(),
        },
      );
      await refresh();
      live.reload();
      sounds.confirm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };
  const save = async (
    routine: LaunchAgentRoutineOverview,
    update: RoutineUpdate,
  ) => {
    if (!response || busy) return false;
    setBusy(routine.id);
    setError('');
    try {
      await launchApi.updateAgentManagedRoutine(
        agentLocator(agent),
        routine.id,
        {
          ...update,
          expectedRevision: response.revision,
        },
      );
      await refresh();
      live.reload();
      sounds.confirm();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const navigateToRoutine = (routineId: string | null) => {
    const next = updateAgentRouteState(
      {
        pathname: `/agents/${encodeURIComponent(agent.slug)}`,
        search: window.location.search,
      },
      { pane: 'routines', item: routineId },
    );
    if (next) onNavigate(next, { scroll: 'preserve' });
  };
  return (
    <section className='neb-modal-pane active'>
      <h2 className='neb-modal-h'>Routines</h2>
      <PromptButton agent={agent} kind='routine' />
      {error ? <p className='neb-error-note' role='alert'>{error}</p> : null}
      {(response?.routines ?? []).map((routine) => (
        <RoutineRow
          busy={busy === routine.id}
          initiallyEditing={routine.id === itemId}
          key={routine.id}
          onAction={(action) => void act(routine, action)}
          onEditingChange={(editing) => navigateToRoutine(editing ? routine.id : null)}
          onSave={(update) => save(routine, update)}
          routine={routine}
        />
      ))}
      {response && response.routines.length === 0
        ? <p className='neb-ov-note'>No managed routines yet.</p>
        : null}
      {!response ? <p className='neb-ov-note'>Loading routines…</p> : null}
      {response && itemId &&
          !response.routines.some((routine) => routine.id === itemId)
        ? (
          <StaleAgentItem
            label='Routine'
            onClear={() => navigateToRoutine(null)}
          />
        )
        : null}
    </section>
  );
}

function RoutineRow({
  busy,
  initiallyEditing,
  onAction,
  onEditingChange,
  onSave,
  routine,
}: {
  busy: boolean;
  initiallyEditing: boolean;
  onAction: (action: 'pause' | 'activate' | 'run_now') => void;
  onEditingChange: (editing: boolean) => void;
  onSave: (update: RoutineUpdate) => Promise<boolean>;
  routine: LaunchAgentRoutineOverview;
}): ReactElement {
  return (
    <div className='neb-popup-item neb-routine-item'>
      <button
        className='neb-routine-main'
        onClick={() => onEditingChange(true)}
        type='button'
      >
        <span className='neb-popup-item-name'>
          {routine.name}
          {routine.role === 'primary' ? <small>PRIMARY</small> : null}
        </span>
        <span className='neb-popup-item-desc'>{routine.schedule.label}</span>
        <span className='neb-routine-meta'>
          <span
            className={routine.health === 'error'
              ? 'routine-fail'
              : routine.status === 'active'
              ? 'routine-ok'
              : ''}
          >
            {routine.health}
          </span>
          {routine.lastRunAt ? ` · ${formatRelative(routine.lastRunAt)} ago` : ' · never run'}
        </span>
      </button>
      <div className='neb-routine-actions'>
        {routine.actions.canRunNow
          ? (
            <button
              className='neb-run-now'
              disabled={busy}
              onClick={() => onAction('run_now')}
              title='Run now'
              type='button'
            >
              →
            </button>
          )
          : null}
        {routine.status === 'active' && routine.actions.canPause
          ? (
            <button
              className='neb-pause-btn'
              disabled={busy}
              onClick={() => onAction('pause')}
              aria-label='Pause routine'
              type='button'
            >
              <Glyph name='pause' />
            </button>
          )
          : routine.actions.canActivate
          ? (
            <button
              className='neb-pause-btn paused'
              disabled={busy}
              onClick={() => onAction('activate')}
              aria-label='Activate routine'
              type='button'
            >
              <Glyph name='play' />
            </button>
          )
          : null}
      </div>
      {initiallyEditing
        ? (
          <RoutineEditor
            routine={routine}
            onSave={onSave}
            onClose={() => onEditingChange(false)}
          />
        )
        : null}
    </div>
  );
}

function RoutineEditor({
  onClose,
  onSave,
  routine,
}: {
  onClose: () => void;
  onSave: (update: RoutineUpdate) => Promise<boolean>;
  routine: LaunchAgentRoutineOverview;
}): ReactElement {
  const [name, setName] = useState(routine.name);
  const [description, setDescription] = useState(routine.description ?? '');
  const [mission, setMission] = useState(routine.mission);
  const [kind, setKind] = useState<'interval' | 'cron'>(routine.schedule.kind);
  const [intervalMinutes, setIntervalMinutes] = useState(
    routine.schedule.kind === 'interval' ? String(routine.schedule.intervalSeconds / 60) : '5',
  );
  const [expression, setExpression] = useState(
    routine.schedule.kind === 'cron' ? routine.schedule.expression : '0 9 * * 1-5',
  );
  const [timezone, setTimezone] = useState(
    routine.schedule.kind === 'cron'
      ? routine.schedule.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const ok = await onSave({
      name: name.trim(),
      description: description.trim() || null,
      mission: mission.trim() || null,
      schedule: kind === 'interval'
        ? {
          kind: 'interval',
          intervalSeconds: Math.max(
            60,
            Math.round(Number(intervalMinutes) * 60),
          ),
        }
        : {
          kind: 'cron',
          expression: expression.trim(),
          timezone: timezone.trim() || 'UTC',
        },
    });
    setSaving(false);
    if (ok) onClose();
  };
  return (
    <Modal
      className='neb-routine-editor'
      label={`Edit ${routine.name}`}
      onClose={onClose}
    >
      <CloseButton onClose={onClose} />
      <form
        className='neb-modal-content'
        onSubmit={(event) => void submit(event)}
      >
        <h2 className='neb-modal-h'>Routine</h2>
        <label className='neb-field-label'>Name</label>
        <input
          className='neb-edit-input'
          onChange={(event) => setName(event.currentTarget.value)}
          value={name}
        />
        <label className='neb-field-label'>Description</label>
        <input
          className='neb-edit-input'
          onChange={(event) => setDescription(event.currentTarget.value)}
          value={description}
        />
        <label className='neb-field-label'>Mission</label>
        <textarea
          className='neb-edit-textarea'
          onChange={(event) => setMission(event.currentTarget.value)}
          value={mission}
        />
        <label className='neb-field-label'>Schedule type</label>
        <select
          className='neb-edit-input'
          onChange={(event) => setKind(event.currentTarget.value as 'interval' | 'cron')}
          value={kind}
        >
          <option value='interval'>Interval</option>
          <option value='cron'>Cron</option>
        </select>
        {kind === 'interval'
          ? (
            <>
              <label className='neb-field-label'>Every (minutes)</label>
              <input
                className='neb-edit-input'
                min='1'
                onChange={(event) => setIntervalMinutes(event.currentTarget.value)}
                type='number'
                value={intervalMinutes}
              />
            </>
          )
          : (
            <>
              <label className='neb-field-label'>Five-field cron</label>
              <input
                className='neb-edit-input mono'
                onChange={(event) => setExpression(event.currentTarget.value)}
                value={expression}
              />
              <label className='neb-field-label'>IANA timezone</label>
              <input
                className='neb-edit-input mono'
                onChange={(event) => setTimezone(event.currentTarget.value)}
                value={timezone}
              />
            </>
          )}
        <p className='neb-ov-note'>
          {routine.nextOccurrences.length > 0
            ? `Next: ${
              routine.nextOccurrences.map((item) => new Date(item).toLocaleString()).join(' · ')
            }`
            : 'The server computes the next occurrences after save.'}
        </p>
        <button className='neb-btn' disabled={saving} type='submit'>
          {saving ? 'Saving…' : 'Save routine'}
        </button>
      </form>
    </Modal>
  );
}

function functionBadges(
  fn: LaunchFunctionSummary,
): Array<'Read' | 'Write' | 'AI'> {
  const badges: Array<'Read' | 'Write' | 'AI'> = [
    fn.annotations?.readOnlyHint === true ? 'Read' : 'Write',
  ];
  if (fn.usesInference) badges.push('AI');
  return badges;
}

function FunctionsPane({
  agent,
  functions,
  itemId,
  live,
  onNavigate,
}: {
  agent: LaunchAgentSummary;
  functions?: LaunchAgentFunctionsResponse;
  itemId?: string;
  live: LaunchPageProps['live'];
  onNavigate: LaunchNavigate;
}): ReactElement {
  const target = resolveOperatorFunctionItem(
    functions?.functions ?? [],
    itemId,
  );
  const selected = target
    ? functions?.functions.find((fn) => fn.name === target.functionName) ?? null
    : null;
  const navigateToFunction = (functionName: string | null) => {
    const next = updateAgentRouteState(
      {
        pathname: `/agents/${encodeURIComponent(agent.slug)}`,
        search: window.location.search,
      },
      { pane: 'functions', item: functionName },
    );
    if (next) onNavigate(next, { scroll: 'preserve' });
  };
  return (
    <section className='neb-modal-pane active'>
      <h2 className='neb-modal-h'>Functions</h2>
      <PromptButton agent={agent} kind='function' />
      {(functions?.functions ?? []).map((fn) => (
        <button
          className='neb-popup-item'
          key={fn.name}
          onClick={() => navigateToFunction(fn.name)}
          type='button'
        >
          <span className='neb-popup-item-line'>
            <span className='neb-popup-item-name'>{fn.name}</span>
            <span className='neb-function-badges'>
              {functionBadges(fn).map((badge) => (
                <span
                  className={`neb-function-badge ${badge.toLowerCase()}`}
                  key={badge}
                >
                  {badge}
                </span>
              ))}
            </span>
          </span>
          <span className='neb-popup-item-desc'>
            {fn.description ?? 'No description published.'}
          </span>
        </button>
      ))}
      {functions && functions.functions.length === 0
        ? (
          <p className='neb-ov-note'>
            This Agent has not published callable functions.
          </p>
        )
        : null}
      {!functions ? <p className='neb-ov-note'>Loading functions…</p> : null}
      {selected
        ? (
          <FunctionDetail
            agent={agent}
            fn={selected}
            focusedField={target?.fieldName ?? null}
            key={selected.name}
            live={live}
            onClose={() => navigateToFunction(null)}
          />
        )
        : null}
      {functions && itemId && !selected
        ? (
          <StaleAgentItem
            label='Function'
            onClear={() => navigateToFunction(null)}
          />
        )
        : null}
    </section>
  );
}

function schemaProperties(
  fn: LaunchFunctionSummary,
): Array<{ name: string; description: string; type: string }> {
  const raw = fn.inputSchema?.properties;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw).map(([name, value]) => {
    const schema = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    return {
      name,
      description: typeof schema.description === 'string' ? schema.description : '',
      type: typeof schema.type === 'string' ? schema.type : 'string',
    };
  });
}

function FunctionDetail({
  agent,
  fn,
  focusedField,
  live,
  onClose,
}: {
  agent: LaunchAgentSummary;
  fn: LaunchFunctionSummary;
  focusedField: string | null;
  live: LaunchPageProps['live'];
  onClose: () => void;
}): ReactElement {
  const inputs = schemaProperties(fn);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [permission, setPermission] = useState(
    fn.callerPermission?.policy ?? fn.agentPermission?.policy ?? 'ask',
  );
  const [savingPermission, setSavingPermission] = useState(false);
  const [error, setError] = useState('');
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = async () => {
    if (running) return;
    setRunning(true);
    setError('');
    try {
      const parsed = Object.fromEntries(inputs.map((input) => {
        const raw = args[input.name] ?? '';
        if (input.type === 'number' || input.type === 'integer') {
          return [input.name, Number(raw)];
        }
        if (input.type === 'boolean') return [input.name, raw === 'true'];
        if (input.type === 'object' || input.type === 'array') {
          try {
            return [input.name, JSON.parse(raw)];
          } catch {
            return [input.name, raw];
          }
        }
        return [input.name, raw];
      }));
      const response = await launchApi.runAgentFunction(
        agentLocator(agent),
        fn.name,
        { args: parsed },
      );
      if (!mountedRef.current) return;
      const record = response.result && typeof response.result === 'object' &&
          !Array.isArray(response.result)
        ? response.result as Record<string, unknown>
        : null;
      if (record?._async === true && typeof record.job_id === 'string') {
        setResult({ status: 'queued', job_id: record.job_id });
        const jobId = record.job_id;
        for (let index = 0; index < 100; index += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 3000));
          if (!mountedRef.current) return;
          const job = await launchApi.launchJob(jobId);
          if (!mountedRef.current) return;
          setResult(job);
          if (job.status === 'completed' || job.status === 'failed') break;
        }
      } else {
        setResult(response);
      }
      sounds.confirm();
    } catch (reason) {
      if (mountedRef.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  };
  const savePermission = async () => {
    setSavingPermission(true);
    setError('');
    try {
      await launchApi.updateAgentCallerPermissions(agentLocator(agent), {
        permissions: [{
          functionName: fn.name,
          policy: permission,
          healthGate: fn.callerPermission?.healthGate ??
            fn.agentPermission?.healthGate ?? true,
        }],
      });
      live.reload();
      sounds.confirm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingPermission(false);
    }
  };
  return (
    <Modal
      className='neb-function-modal'
      label={`${fn.name} function`}
      onClose={onClose}
    >
      <CloseButton onClose={onClose} />
      <div className='neb-modal-content'>
        <h2 className='neb-modal-h function-title'>{fn.name}</h2>
        <p className='neb-ov-note top-note'>
          {fn.description ?? 'No description published.'}
        </p>
        <div className='neb-function-badges detail'>
          {functionBadges(fn).map((badge) => (
            <span
              className={`neb-function-badge ${badge.toLowerCase()}`}
              key={badge}
            >
              {badge}
            </span>
          ))}
        </div>
        {inputs.map((input) => (
          <label
            className={`neb-function-arg${focusedField === input.name ? ' focused' : ''}`}
            key={input.name}
          >
            <span>{input.name}</span>
            <input
              autoFocus={focusedField === input.name}
              className='neb-edit-input mono'
              onChange={(event) =>
                setArgs((current) => ({
                  ...current,
                  [input.name]: event.currentTarget.value,
                }))}
              placeholder={input.description || input.type}
              value={args[input.name] ?? ''}
            />
          </label>
        ))}
        {inputs.length === 0 ? <p className='neb-ov-note'>No arguments.</p> : null}
        <button
          className='neb-btn'
          disabled={running}
          onClick={() => void run()}
          type='button'
        >
          {running ? 'Running…' : '→ Run'}
        </button>
        {error ? <p className='neb-error-note' role='alert'>{error}</p> : null}
        {result !== null
          ? <pre className='neb-function-result'>{JSON.stringify(result, null, 2)}</pre>
          : null}

        {fn.usesInference
          ? (
            <div className='neb-ov-section function-setting'>
              <div className='neb-ov-label'>This function uses AI</div>
              <div className='neb-ov-row'>
                <span className='neb-ov-row-key'>Current model</span>
                <span className='neb-ov-row-val'>
                  {fn.inferenceOverride
                    ? `${
                      fn.inferenceOverride.model ?? 'default'
                    } · ${fn.inferenceOverride.provider}`
                    : 'Account BYOK default'}
                </span>
              </div>
              <button
                className='neb-btn-sm'
                onClick={() => setModelOpen(true)}
                type='button'
              >
                Choose model
              </button>
            </div>
          )
          : null}
        <div className='neb-ov-section function-setting'>
          <div className='neb-ov-label'>Connected Agent permission</div>
          <div className='neb-inline-field compact'>
            <select
              className='neb-edit-input'
              onChange={(event) => setPermission(
                event.currentTarget.value as 'always' | 'ask' | 'never',
              )}
              value={permission}
            >
              <option value='always'>Always</option>
              <option value='ask'>Ask</option>
              <option value='never'>Never</option>
            </select>
            <button
              className='neb-btn-sm'
              disabled={savingPermission}
              onClick={() => void savePermission()}
              type='button'
            >
              Save
            </button>
          </div>
        </div>
      </div>
      {modelOpen
        ? (
          <ModelPicker
            agent={agent}
            fn={fn}
            live={live}
            onClose={() => setModelOpen(false)}
          />
        )
        : null}
    </Modal>
  );
}

function ModelPicker({
  agent,
  fn,
  live,
  onClose,
}: {
  agent: LaunchAgentSummary;
  fn: LaunchFunctionSummary;
  live: LaunchPageProps['live'];
  onClose: () => void;
}): ReactElement {
  const providers = (live.data.byok?.providers ?? []).filter((item) => item.configured);
  const initial = fn.inferenceOverride?.provider ?? providers[0]?.id ?? '';
  const [provider, setProvider] = useState(initial);
  const providerRecord = providers.find((item) => item.id === provider);
  const [model, setModel] = useState(
    fn.inferenceOverride?.model ?? providerRecord?.model ??
      providerRecord?.defaultModel ?? '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (!provider || !model.trim()) return;
    setSaving(true);
    setError('');
    try {
      await launchApi.updateAgentFunctionInference(
        agentLocator(agent),
        fn.name,
        { provider, model: model.trim() },
      );
      live.reload();
      sounds.confirm();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      className='neb-model-modal'
      label='Choose AI model'
      onClose={onClose}
    >
      <CloseButton onClose={onClose} />
      <div className='neb-modal-content'>
        <h2 className='neb-modal-h'>AI model for this function</h2>
        <p className='neb-ov-note top-note'>
          Choose one of your configured Class 1 inference providers and its real model slug.
        </p>
        {providers.length === 0
          ? (
            <p className='neb-error-note'>
              No BYOK provider is configured. Add one in Settings → BYOK Setup.
            </p>
          )
          : null}
        <label className='neb-field-label'>Provider</label>
        <select
          className='neb-edit-input'
          disabled={providers.length === 0}
          onChange={(event) => {
            const next = event.currentTarget.value;
            const option = providers.find((item) => item.id === next);
            setProvider(next);
            setModel(option?.model ?? option?.defaultModel ?? '');
          }}
          value={provider}
        >
          {providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <label className='neb-field-label'>Model</label>
        <input
          className='neb-edit-input'
          onChange={(event) => setModel(event.currentTarget.value)}
          placeholder={providerRecord?.defaultModel ?? 'Model slug'}
          value={model}
        />
        {error ? <p className='neb-error-note'>{error}</p> : null}
        <button
          className='neb-btn'
          disabled={saving || !provider || !model.trim()}
          onClick={() => void save()}
          type='button'
        >
          {saving ? 'Saving…' : 'Save model'}
        </button>
      </div>
    </Modal>
  );
}

function Collapsible({
  children,
  focusTarget = null,
  label,
  initiallyOpen = true,
}: {
  children: ReactNode;
  focusTarget?: string | null;
  label: string;
  initiallyOpen?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(initiallyOpen);
  const headerRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusTarget = useRef<string | null>(null);
  useEffect(() => {
    if (initiallyOpen) setOpen(true);
  }, [initiallyOpen]);
  useEffect(() => {
    setOpen((current) =>
      reconcileCollapsibleRouteTarget(
        current,
        previousFocusTarget.current,
        focusTarget,
      )
    );
    previousFocusTarget.current = focusTarget;
  }, [focusTarget]);
  useEffect(() => {
    if (!focusTarget || !open) return;
    const frame = window.requestAnimationFrame(() => {
      headerRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
      headerRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusTarget, open]);
  return (
    <section className={`neb-ov-section${open ? '' : ' collapsed'}`}>
      <button
        aria-current={focusTarget ? 'location' : undefined}
        className={`neb-ov-section-header${focusTarget ? ' neb-deep-link-target' : ''}`}
        onClick={() => setOpen((value) => !value)}
        ref={headerRef}
        type='button'
      >
        <span className='neb-ov-label'>{label}</span>
        <span className='neb-ov-chevron'>
          <Glyph name='chevron' />
        </span>
      </button>
      {open ? <div className='neb-ov-section-body'>{children}</div> : null}
    </section>
  );
}

function AgentSettingsPane({
  agent,
  itemId,
  live,
  onClearItem,
}: {
  agent: LaunchAgentSummary;
  itemId?: string;
  live: LaunchPageProps['live'];
  onClearItem: () => void;
}): ReactElement {
  const upstreamHome = live.data.agentHome;
  const [homeOverride, setHomeOverride] = useState<
    {
      agentId: string;
      snapshot: NonNullable<typeof upstreamHome>;
    } | null
  >(null);
  const home = homeOverride?.agentId === agent.id ? homeOverride.snapshot : upstreamHome;
  const [capacity, setCapacity] = useState<
    LaunchAgentCapacityResponse | undefined
  >(live.data.agentCapacity);
  const [cap, setCap] = useState(
    String(live.data.agentCapacity?.capPercent ?? 100),
  );
  const [identityName, setIdentityName] = useState(agent.name);
  const [identityDescription, setIdentityDescription] = useState(
    agent.description ?? '',
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [promotionNotice, setPromotionNotice] = useState('');
  const [releaseReview, setReleaseReview] = useState<
    ReleaseCandidateReviewToken | null
  >(null);
  const promotionInFlight = useRef(false);
  const promotionStorage = useMemo(() => {
    let primary: Storage | null = null;
    try {
      primary = window.sessionStorage;
    } catch {
      // Hardened browsers can deny access to the storage object itself.
    }
    return createSafeReleasePromotionStorage(primary);
  }, []);
  useEffect(() => {
    if (!upstreamHome) return;
    setHomeOverride((current) => {
      if (!current || current.agentId !== agent.id) return null;
      return shouldRetainAgentHomeOverride(
          agent.id,
          current.snapshot,
          upstreamHome,
        )
        ? current
        : null;
    });
  }, [agent.id, upstreamHome?.generatedAt, upstreamHome?.revision]);
  useEffect(() => {
    setReleaseReview((current) =>
      current && home && releaseCandidateMatchesReview(agent.id, home, current) ? current : null
    );
  }, [
    agent.id,
    home?.release.candidate?.sourceFingerprint,
    home?.release.candidate?.version,
    home?.revision,
  ]);
  useEffect(() => {
    setCapacity(live.data.agentCapacity);
    setCap(String(live.data.agentCapacity?.capPercent ?? 100));
  }, [live.data.agentCapacity]);
  useEffect(() => {
    setIdentityName(home?.agent.name ?? agent.name);
    setIdentityDescription(
      home?.agent.description ?? agent.description ?? '',
    );
  }, [
    agent.description,
    agent.id,
    agent.name,
    home?.agent.description,
    home?.agent.name,
  ]);

  const promoteCandidate = async () => {
    if (!home || !releaseReview || busy || promotionInFlight.current) return;
    const reviewedVersion = releaseReview.version;
    const attemptStorageKey = releasePromotionStorageKey(
      agent.id,
      reviewedVersion,
    );
    const idempotencyKey = getOrCreateReleasePromotionIdempotencyKey(
      promotionStorage,
      attemptStorageKey,
      randomId,
    );
    const request = createReleasePromotionRequest(
      agent.id,
      home,
      releaseReview,
      idempotencyKey,
    );
    if (!request) {
      promotionStorage.removeItem(attemptStorageKey);
      setReleaseReview(null);
      setError(
        'That candidate changed or is no longer ready. Review the latest release before promoting.',
      );
      live.reload();
      return;
    }
    promotionInFlight.current = true;
    setBusy('release');
    setError('');
    setPromotionNotice('');
    try {
      const next = await executeReleasePromotionWithRecovery({
        agentId: agent.id,
        call: (action) => launchApi.actOnAgentHome(agentLocator(agent), action),
        idempotencyKey,
        review: releaseReview,
        snapshot: home,
        storage: promotionStorage,
      });
      setHomeOverride({ agentId: agent.id, snapshot: next });
      setReleaseReview(null);
      setPromotionNotice(`Version ${reviewedVersion} is live.`);
      promotionStorage.removeItem(attemptStorageKey);
      live.reload();
      sounds.confirm();
    } catch (reason) {
      const current = currentReleaseSnapshotFromError(reason);
      if (current) {
        setHomeOverride({ agentId: agent.id, snapshot: current });
        setReleaseReview(null);
      }
      if (!shouldRetainReleasePromotionAttempt(reason)) {
        promotionStorage.removeItem(attemptStorageKey);
      }
      setError(reason instanceof Error ? reason.message : String(reason));
      live.reload();
    } finally {
      promotionInFlight.current = false;
      setBusy(null);
    }
  };
  const cancelPromotionReview = () => {
    if (releaseReview) {
      promotionStorage.removeItem(
        releasePromotionStorageKey(agent.id, releaseReview.version),
      );
    }
    setReleaseReview(null);
  };
  const saveCap = async () => {
    const value = Number(cap);
    if (!Number.isFinite(value) || value < 0.01 || value > 100 || busy) return;
    setBusy('capacity');
    setError('');
    try {
      const next = await launchApi.updateAgentCapacity(agentLocator(agent), {
        capPercent: value,
      });
      setCapacity(next);
      setCap(String(next.capPercent ?? value));
      live.reload();
      sounds.confirm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };
  const saveIdentity = async () => {
    if (!home || busy) return;
    setBusy('identity');
    setError('');
    try {
      const next = await launchApi.updateAgentHomeIdentity(
        agentLocator(agent),
        {
          expectedRevision: home.revision,
          name: identityName.trim(),
          description: identityDescription.trim() || null,
        },
      );
      setHomeOverride({ agentId: agent.id, snapshot: next });
      live.reload();
      sounds.confirm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };
  const liveRelease = home?.release.live;
  const candidate = home?.release.candidate;
  const settingsTarget = resolveOperatorSettingsItem(home?.release, itemId);
  const staleSettingsItem = Boolean(home && itemId && !settingsTarget);
  const releaseReviewActive = Boolean(
    home && releaseReview &&
      releaseCandidateMatchesReview(agent.id, home, releaseReview),
  );
  const promotionAllowed = Boolean(
    candidate?.canPromote && home?.actions.canPromoteCandidate,
  );
  return (
    <section className='neb-modal-pane active'>
      <h2 className='neb-modal-h'>Settings</h2>
      {error ? <p className='neb-error-note' role='alert'>{error}</p> : null}
      {staleSettingsItem
        ? (
          <StaleAgentItem
            label='Settings item'
            onClear={onClearItem}
            returnLabel='Settings'
          />
        )
        : null}

      <Collapsible
        focusTarget={settingsTarget?.kind === 'rate-limits' ? itemId : null}
        initiallyOpen={!itemId || settingsTarget?.kind === 'rate-limits'}
        label='Rate limits'
      >
        {capacity
          ? (
            <>
              <div className='neb-ov-row'>
                <span className='neb-ov-row-key'>Share of 5-hour pool</span>
                <span className='neb-ov-row-val'>
                  {capacity.burst.shareUsedPercent === undefined
                    ? capacity.burst.state
                    : `${Math.round(capacity.burst.shareUsedPercent)}%`}
                </span>
              </div>
              <div className='neb-ov-row'>
                <span className='neb-ov-row-key'>Share of weekly pool</span>
                <span className='neb-ov-row-val'>
                  {capacity.weekly.shareUsedPercent === undefined
                    ? capacity.weekly.state
                    : `${Math.round(capacity.weekly.shareUsedPercent)}%`}
                </span>
              </div>
            </>
          )
          : <p className='neb-ov-note'>Capacity is not available.</p>}
        {capacity?.capPercent !== null && capacity
          ? (
            <div className='neb-ov-row'>
              <span className='neb-ov-row-key'>Cap this Agent at</span>
              <span className='neb-limit-input-wrap'>
                <input
                  className='neb-limit-input'
                  min='0.01'
                  max='100'
                  onChange={(event) => setCap(event.currentTarget.value)}
                  step='0.01'
                  type='number'
                  value={cap}
                />%<button
                  className='neb-btn-sm'
                  disabled={busy === 'capacity'}
                  onClick={() => void saveCap()}
                  type='button'
                >
                  Save
                </button>
              </span>
            </div>
          )
          : (
            <p className='neb-ov-note'>
              Free capacity is fixed and intentionally qualitative.
            </p>
          )}
        <p className='neb-ov-note'>
          Lower the ceiling to reserve room for other Agents. Both five-hour and weekly windows
          enforce the same percentage.
        </p>
      </Collapsible>

      <Collapsible
        focusTarget={settingsTarget?.kind === 'release' ? itemId : null}
        label={`Release${
          (home?.release.candidateCount ?? 0) > 1 ? ` · ${home?.release.candidateCount} staged` : ''
        }`}
        initiallyOpen={settingsTarget?.kind === 'release' ||
          (!itemId && Boolean(candidate))}
      >
        <div className='neb-release-block'>
          <div className='neb-release-heading'>Live</div>
          {liveRelease
            ? (
              <>
                <div className='neb-ov-row'>
                  <span className='neb-ov-row-key'>Declared version</span>
                  <span className='neb-ov-row-val'>{liveRelease.version}</span>
                </div>
                {liveRelease.executedVersion &&
                    liveRelease.executedVersion !== liveRelease.version
                  ? (
                    <div className='neb-ov-row'>
                      <span className='neb-ov-row-key'>Executing version</span>
                      <span className='neb-ov-row-val'>
                        {liveRelease.executedVersion}
                      </span>
                    </div>
                  )
                  : null}
                <div className='neb-ov-row'>
                  <span className='neb-ov-row-key'>Integrity</span>
                  <span
                    className={`neb-ov-row-val${liveRelease.integrity === 'verified' ? ' on' : ''}`}
                  >
                    {liveRelease.integrity}
                  </span>
                </div>
                <p className='neb-ov-note'>
                  {liveRelease.promotedAt
                    ? `Promoted ${formatRelativePast(liveRelease.promotedAt)}.`
                    : 'Promotion time unavailable.'}
                </p>
              </>
            )
            : (
              <p className='neb-ov-note'>
                {!home
                  ? live.data.agentHomeError
                    ? 'Release state is unavailable. Refresh the Agent to try again.'
                    : 'Loading release state…'
                  : 'No live version.'}
              </p>
            )}
        </div>
        <div className='neb-release-block candidate'>
          <div className='neb-release-heading'>Latest candidate</div>
          {candidate
            ? (
              <>
                <div className='neb-ov-row'>
                  <span className='neb-ov-row-key'>Exact-tested version</span>
                  <span className='neb-ov-row-val'>{candidate.version}</span>
                </div>
                {shortReleaseFingerprint(candidate.sourceFingerprint)
                  ? (
                    <div className='neb-ov-row'>
                      <span className='neb-ov-row-key'>Source fingerprint</span>
                      <span
                        className='neb-ov-row-val'
                        title={candidate.sourceFingerprint ?? undefined}
                      >
                        {shortReleaseFingerprint(candidate.sourceFingerprint)}
                      </span>
                    </div>
                  )
                  : null}
                <div className='neb-ov-row'>
                  <span className='neb-ov-row-key'>Review</span>
                  <span
                    className={`neb-release-status ${candidate.reviewStatus}`}
                  >
                    {releaseReviewLabel(candidate.reviewStatus)}
                  </span>
                </div>
                <p className='neb-ov-note'>
                  {candidate.testedAt
                    ? `Tested ${formatRelativePast(candidate.testedAt)}.`
                    : candidate.uploadedAt
                    ? `Uploaded ${formatRelativePast(candidate.uploadedAt)}.`
                    : 'Upload time unavailable.'}
                </p>
                {candidate.authorityChanges.length > 0
                  ? (
                    <div
                      className='neb-release-changes'
                      aria-label='Authority changes'
                    >
                      {candidate.authorityChanges.map((change) => (
                        <div
                          className='neb-release-change'
                          key={`${change.change}:${change.path}`}
                        >
                          <span
                            className={`neb-release-change-kind ${change.change}`}
                          >
                            {change.change}
                          </span>
                          <span>{change.label}</span>
                        </div>
                      ))}
                    </div>
                  )
                  : (
                    <p className='neb-ov-note'>
                      No authority change from live.
                    </p>
                  )}
                {releaseReviewActive
                  ? (
                    <div
                      className='neb-release-confirm'
                      role='group'
                      aria-label='Confirm promotion'
                    >
                      <p>Make exact-tested version {candidate.version} live?</p>
                      <div className='neb-release-actions'>
                        <button
                          className='neb-btn-sm'
                          disabled={!promotionAllowed || busy === 'release'}
                          onClick={() => void promoteCandidate()}
                          type='button'
                        >
                          {busy === 'release' ? 'Promoting…' : 'Confirm promotion'}
                        </button>
                        <button
                          className='neb-btn-sm'
                          disabled={busy === 'release'}
                          onClick={cancelPromotionReview}
                          type='button'
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )
                  : (
                    <button
                      className='neb-btn-sm neb-release-promote'
                      disabled={!promotionAllowed || Boolean(busy)}
                      onClick={() => {
                        if (!home) return;
                        setPromotionNotice('');
                        setReleaseReview(
                          createReleaseCandidateReviewToken(agent.id, home),
                        );
                      }}
                      type='button'
                    >
                      Review &amp; promote
                    </button>
                  )}
              </>
            )
            : home
            ? <p className='neb-ov-note'>No staged candidate.</p>
            : null}
          {promotionNotice
            ? (
              <p className='neb-release-success' role='status'>
                {promotionNotice}
              </p>
            )
            : null}
        </div>
      </Collapsible>

      <Collapsible
        focusTarget={settingsTarget?.kind === 'history' ? itemId : null}
        label='History'
        initiallyOpen={settingsTarget?.kind === 'history'}
      >
        {(home?.recentRuns ?? []).slice(0, 12).map((run) => (
          <div className='neb-history-item' key={run.id}>
            {run.summary ?? `${run.trigger} · ${run.status}`}
            <div className='neb-history-time'>
              {formatRelative(run.createdAt)} · {run.workUnits} work units
            </div>
          </div>
        ))}
        {home && home.recentRuns.length === 0 ? <p className='neb-ov-note'>No runs yet.</p> : null}
      </Collapsible>

      <Collapsible
        focusTarget={settingsTarget?.kind === 'identity' ? itemId : null}
        label='Identity'
        initiallyOpen={settingsTarget?.kind === 'identity'}
      >
        <label className='neb-field-label' htmlFor={`agent-name-${agent.id}`}>
          Name
        </label>
        <input
          className='neb-edit-input'
          id={`agent-name-${agent.id}`}
          onChange={(event) => setIdentityName(event.currentTarget.value)}
          value={identityName}
        />
        <label
          className='neb-field-label'
          htmlFor={`agent-description-${agent.id}`}
        >
          Description
        </label>
        <textarea
          className='neb-edit-textarea'
          id={`agent-description-${agent.id}`}
          onChange={(event) => setIdentityDescription(event.currentTarget.value)}
          value={identityDescription}
        />
        <button
          className='neb-btn-sm'
          disabled={!home?.actions.canEditIdentity || busy === 'identity' ||
            !identityName.trim()}
          onClick={() => void saveIdentity()}
          type='button'
        >
          {busy === 'identity' ? 'Saving…' : 'Save identity'}
        </button>
      </Collapsible>

      <Collapsible
        focusTarget={settingsTarget?.kind === 'connection' ? itemId : null}
        label='Connection'
        initiallyOpen={settingsTarget?.kind === 'connection'}
      >
        <div className='neb-ov-connect neb-overview-connect'>
          <code>
            {live.data.install?.agentInstall?.agentMcpUrl ??
              `${launchApiOrigin()}/mcp/${agent.id}`}
          </code>
          <CopyButton
            text={live.data.install?.agentInstall?.agentMcpUrl ??
              `${launchApiOrigin()}/mcp/${agent.id}`}
          />
        </div>
      </Collapsible>
    </section>
  );
}
