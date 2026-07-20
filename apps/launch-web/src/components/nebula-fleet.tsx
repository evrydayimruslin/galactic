import {
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  LaunchAgentCapacityResponse,
  LaunchAgentFunctionsResponse,
  LaunchAgentManagedRoutineUpdateRequest,
  LaunchAgentRoutineOverview,
  LaunchAgentSummary,
  LaunchApiKeySummary,
  LaunchByokProviderOption,
  LaunchByokSummaryResponse,
  LaunchCapacityResponse,
  LaunchFleetAgentSummary,
  LaunchFunctionSummary,
  LaunchInterfaceSummary,
  LaunchNotification,
  LaunchSubscriptionResponse,
} from "../../../../shared/contracts/launch.ts";
import type { LaunchPageProps } from "../App";
import { hasLaunchAuthToken, normalizeLocalPath, signOutLaunch } from "../lib/auth";
import {
  attachInterfaceBridge,
  clampInterfaceHeight,
  runInterfaceFunctionDurably,
} from "../lib/interface-bridge";
import {
  launchApi,
  launchApiOrigin,
  type LaunchAgentSettingsResponse,
  type LaunchSettingsResponse,
} from "../lib/api";
import {
  createReleaseCandidateReviewToken,
  createReleasePromotionRequest,
  createSafeReleasePromotionStorage,
  currentReleaseSnapshotFromError,
  executeReleasePromotionWithRecovery,
  getOrCreateReleasePromotionIdempotencyKey,
  releaseCandidateMatchesReview,
  releaseReviewLabel,
  releasePromotionStorageKey,
  shouldRetainAgentHomeOverride,
  shouldRetainReleasePromotionAttempt,
  shortReleaseFingerprint,
  type ReleaseCandidateReviewToken,
} from "../lib/nebula-release";
import { AgentComputePane } from "./agent-compute-pane";
import "./nebula-fleet.css";

type AgentPane = "alerts" | "interfaces" | "routines" | "functions" | "compute" | "settings";
type SettingsPane = "general" | "billing" | "usage" | "byok" | "keys" | "connect";
type GlyphName =
  | "alert"
  | "bell"
  | "camera"
  | "check"
  | "chevron"
  | "close"
  | "gear"
  | "pause"
  | "play"
  | "plus"
  | "search"
  | "spark";

type RoutineUpdate = Omit<LaunchAgentManagedRoutineUpdateRequest, "expectedRevision">;

interface NebulaProps extends LaunchPageProps {}

const NEW_AGENT_PROMPT =
  "Deploy a new agent to Galactic — describe what it should do, its schedule, and what it should connect to.";

let audioContext: AudioContext | null = null;
const modalStack: symbol[] = [];

function tone(freqA: number, freqB: number | null, duration: number, volume: number) {
  try {
    const AudioContextCtor = window.AudioContext;
    audioContext = audioContext || new AudioContextCtor();
    if (audioContext.state === "suspended") {
      void audioContext.resume().catch(() => undefined);
    }
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
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

function Glyph({ name }: { name: GlyphName }): ReactElement {
  const paths: Record<GlyphName, ReactNode> = {
    alert: <><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 2.8 17a1.7 1.7 0 0 0 1.5 2.5h15.4a1.7 1.7 0 0 0 1.5-2.5L13.7 3.9a1.7 1.7 0 0 0-3.4 0Z" /></>,
    bell: <><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>,
    camera: <><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z" /><circle cx="12" cy="13" r="4" /></>,
    check: <path d="m20 6-11 11-5-5" />,
    chevron: <path d="m6 9 6 6 6-6" />,
    close: <path d="M18 6 6 18M6 6l12 12" />,
    gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.23.5.5 1 .95 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></>,
    pause: <><rect x="6" y="5" width="4" height="14" fill="currentColor" stroke="none" /><rect x="14" y="5" width="4" height="14" fill="currentColor" stroke="none" /></>,
    play: <path d="M8 5v14l11-7Z" fill="currentColor" stroke="none" />,
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
    spark: <path d="m12 2 1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7Z" />,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">{paths[name]}</svg>;
}

function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 30) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatRelativePast(iso: string): string {
  const relative = formatRelative(iso);
  return relative === "now" ? "just now" : `${relative} ago`;
}

function formatCountdown(iso: string | null | undefined, now: number): string {
  if (!iso) return "Not scheduled";
  const seconds = Math.ceil((new Date(iso).getTime() - now) / 1000);
  if (!Number.isFinite(seconds)) return "Not scheduled";
  if (seconds <= 0) return "Waking…";
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function asPercent(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value ?? 0));
}

function qualitativeCapacityLabel(
  capacity: LaunchAgentCapacityResponse | null | undefined,
  accountCapacity: LaunchCapacityResponse | undefined,
  now: number,
): string {
  const state = capacity?.state ?? accountCapacity?.state ?? "available";
  const burstReset = capacity?.burst.resetsAt ?? accountCapacity?.burst.resetsAt;
  const weeklyReset = capacity?.weekly.resetsAt ?? accountCapacity?.weekly.resetsAt;
  const nextReset = [burstReset, weeklyReset]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0];
  const nextEligible = capacity?.nextEligibleAt ?? accountCapacity?.nextEligibleAt;
  const relevant = state === "waiting" ? nextEligible ?? nextReset : nextReset;
  const timing = relevant
    ? `${state === "waiting" ? "resumes" : "resets"} in ${formatCountdown(relevant, now)}`
    : null;
  return `Capacity ${state}${timing ? ` · ${timing}` : ""}`;
}

function agentLocator(agent: LaunchAgentSummary): string {
  return agent.slug || agent.id;
}

function apiAssetUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("/api/")) return `${launchApiOrigin()}${value}`;
  return value;
}

function safeLocalActionPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || decoded.includes("\\")) return null;
    const normalized = normalizeLocalPath(value);
    const parsed = new URL(normalized, window.location.origin);
    return parsed.origin === window.location.origin
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : null;
  } catch {
    return null;
  }
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
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    window.addEventListener("resize", resize);
    document.addEventListener("mousemove", move);
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      document.removeEventListener("mousemove", move);
    };
  }, []);
  return <canvas className="neb-stars" ref={canvasRef} aria-hidden="true" />;
}

function Modal({
  children,
  className = "",
  label,
  onClose,
}: {
  children: ReactNode;
  className?: string;
  label: string;
  onClose: () => void;
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
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== modalId) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key === "Tab") {
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
    document.addEventListener("keydown", onKey);
    const timer = window.setTimeout(() => {
      modalRef.current?.querySelector<HTMLElement>("button, input, [tabindex='0']")?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      const position = modalStack.lastIndexOf(modalId);
      if (position >= 0) modalStack.splice(position, 1);
      returnFocus?.focus();
    };
  }, [label]);
  return (
    <div
      className="neb-modal-overlay open"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div className={`neb-modal ${className}`} ref={modalRef} role="dialog" aria-label={label} aria-modal="true">
        {children}
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }): ReactElement {
  return <button className="neb-modal-close" onClick={onClose} aria-label="Close" type="button"><Glyph name="close" /></button>;
}

function CopyButton({ text }: { text: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={copied ? "neb-btn-sm saved" : "neb-btn-sm"}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        sounds.confirm();
        window.setTimeout(() => setCopied(false), 1200);
      }}
      type="button"
    >{copied ? "Copied" : "Copy"}</button>
  );
}

function FleetCard({
  item,
  index,
  now,
  accountCapacity,
  onOpen,
  onIconChanged,
}: {
  item: LaunchFleetAgentSummary;
  index: number;
  now: number;
  accountCapacity: LaunchCapacityResponse | undefined;
  onOpen: () => void;
  onIconChanged: () => void;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const wakePlayedRef = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const waking = Boolean(
    item.nextWakeAt &&
      new Date(item.nextWakeAt).getTime() <= now &&
      new Date(item.nextWakeAt).getTime() > now - 10_000,
  );
  useEffect(() => {
    if (waking && !wakePlayedRef.current) {
      wakePlayedRef.current = true;
      sounds.wake();
    } else if (!waking) {
      wakePlayedRef.current = false;
    }
  }, [waking]);
  const capacity = item.capacity;
  const usage = Math.max(
    capacity?.burst.shareUsedPercent ?? 0,
    capacity?.weekly.shareUsedPercent ?? 0,
  );
  const cap = capacity?.capPercent ?? 100;
  const burstCeiling = Math.min(
    cap,
    (capacity?.burst.shareUsedPercent ?? 0) +
      (100 - (accountCapacity?.burst.usedPercent ?? 100)),
  );
  const weeklyCeiling = Math.min(
    cap,
    (capacity?.weekly.shareUsedPercent ?? 0) +
      (100 - (accountCapacity?.weekly.usedPercent ?? 100)),
  );
  const effectiveCeiling = Math.max(usage, Math.min(burstCeiling, weeklyCeiling));
  const paidCapacity = Boolean(capacity && accountCapacity?.plan !== "free" && capacity.capPercent !== null);
  const status = item.state === "paused"
    ? "Paused"
    : item.health === "waiting"
    ? `Waiting${capacity?.nextEligibleAt ? ` until ${new Date(capacity.nextEligibleAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : " for capacity"}`
    : item.state === "error"
    ? "Needs attention"
    : waking
    ? "Live: waking"
    : item.nextWakeAt
    ? `Next wake: ${formatCountdown(item.nextWakeAt, now)}`
    : item.activeRoutineCount > 0
    ? "Active · event driven"
    : "Idle";

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file || uploading) return;
    setUploading(true);
    setUploadError("");
    try {
      await launchApi.uploadAgentIcon(item.agent.id, file);
      sounds.confirm();
      onIconChanged();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Icon upload failed.");
    } finally {
      setUploading(false);
      event.currentTarget.value = "";
    }
  };

  return (
    <article
      className={`neb-agent-card${waking ? " waking" : ""}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <span className="neb-card-no">{String(index + 1).padStart(3, "0")}</span>
      <div className="neb-agent-head">
        <button
          className="neb-agent-avatar"
          disabled={uploading}
          onClick={(event) => {
            event.stopPropagation();
            inputRef.current?.click();
          }}
          title={uploadError || "Upload Agent icon (GIF supported)"}
          type="button"
        >
          {apiAssetUrl(item.agent.iconUrl)
            ? <img src={apiAssetUrl(item.agent.iconUrl) ?? undefined} alt="" />
            : <Glyph name="camera" />}
          <input
            accept="image/png,image/jpeg,image/webp,image/gif,.gif"
            hidden
            onChange={(event) => void upload(event)}
            ref={inputRef}
            type="file"
          />
        </button>
        <div className="neb-agent-meta">
          <div className="neb-agent-name">{item.agent.name}</div>
          <div className={`neb-status-row ${waking ? "waking" : ""}`}>
            {item.state !== "paused" && item.state !== "error"
              ? <span className="neb-status-dot" />
              : null}
            <span>{status}</span>
          </div>
        </div>
      </div>
      {paidCapacity && capacity
        ? (
          <>
            <div className="neb-usage-mini-row">
              {Math.round(usage)}% usage ·{" "}
              <span
                className="neb-usage-mini-max"
                data-tip={cap < 100
                  ? `This Agent is capped at ${cap}% of the shared account pool.`
                  : "This Agent can use whatever remains in the shared account pool."}
              >
                up to {Math.round(effectiveCeiling)}%
              </span>
            </div>
            <div className="neb-usage-mini" aria-label={`${Math.round(usage)} percent of shared capacity used`}>
              <div className="neb-usage-mini-potential" style={{ width: `${asPercent(effectiveCeiling)}%` }} />
              <div className="neb-usage-mini-agentlimit" style={{ width: `${asPercent(cap)}%` }} />
              <div className="neb-usage-mini-fill" style={{ width: `${asPercent(usage)}%` }} />
            </div>
          </>
        )
        : (
          <div className="neb-usage-mini-row">
            {qualitativeCapacityLabel(capacity, accountCapacity, now)}
          </div>
        )}
      <div className="neb-last-actions">
        {item.recentActivity.slice(0, 3).map((activity) => (
          <div className="neb-last-action-item" key={activity.id}>
            <span>{activity.title}</span>
            <span className="neb-last-action-time">{formatRelative(activity.createdAt, now)}</span>
          </div>
        ))}
        {item.recentActivity.length === 0
          ? <div className="neb-last-action-item"><span>No activity yet</span><span className="neb-last-action-time">—</span></div>
          : null}
      </div>
      {item.unreadAlertCount > 0
        ? <span className="neb-card-alert-count">{item.unreadAlertCount}</span>
        : null}
    </article>
  );
}

function AddAgentCard({ number }: { number: number }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`neb-add-agent-card${copied ? " copied-prompt" : ""}`}
      onClick={() => {
        void navigator.clipboard.writeText(NEW_AGENT_PROMPT);
        setCopied(true);
        sounds.confirm();
        window.setTimeout(() => setCopied(false), 3000);
      }}
      type="button"
    >
      <span className="neb-card-no">{String(number).padStart(3, "0")}</span>
      <Glyph name={copied ? "check" : "plus"} />
      <span>{copied ? "Copied — paste into agent" : "Add agent"}</span>
    </button>
  );
}

export function NebulaSessionRestoringShell({
  agentOpen,
  onAgentClose,
}: {
  agentOpen: boolean;
  onAgentClose: () => void;
}): ReactElement {
  return (
    <div className="nebula-root" aria-busy="true">
      <Starfield />
      <div className="neb-nebula n1" aria-hidden="true" />
      <div className="neb-nebula n2" aria-hidden="true" />
      <div className="neb-nebula n3" aria-hidden="true" />
      <div className="neb-grain" aria-hidden="true" />

      <main className="neb-app">
        <header className="neb-topbar">
          <div className="neb-wordmark"><span className="dot" />galactic</div>
        </header>
        <section className="neb-hero">
          <h1>Agents work here</h1>
        </section>
      </main>

      {agentOpen
        ? (
          <Modal className="agent-modal" label="Loading Agent" onClose={onAgentClose}>
            <CloseButton onClose={onAgentClose} />
            <div className="neb-modal-content"><p className="neb-ov-note">Restoring session…</p></div>
          </Modal>
        )
        : null}
    </div>
  );
}

export function NebulaFleetApp({
  live,
  navigate,
  route,
}: NebulaProps): ReactElement {
  const now = useClock();
  const [globalAlertsOpen, setGlobalAlertsOpen] = useState(false);
  const [returnToAlerts, setReturnToAlerts] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [capacityOverrides, setCapacityOverrides] = useState<Record<string, LaunchAgentCapacityResponse>>({});
  const settingsOpen = route.definition.key === "settings";
  const agentOpen = route.definition.key === "agent";
  const agents = live.data.fleet?.agents ?? [];
  const activeAgent = live.data.agent?.agent ?? live.data.agent?.tool ?? null;
  const fleetUnread = useMemo(
    () => agents.reduce((total, item) => total + item.unreadAlertCount, 0),
    [agents],
  );
  const [unread, setUnread] = useState(fleetUnread);
  const activeCount = agents.filter((item) => item.activeRoutineCount > 0).length;

  useEffect(() => {
    setUnread((current) => Math.max(current, fleetUnread));
  }, [fleetUnread]);

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
    let mounted = true;
    const missing = agents.filter((item) => !item.capacity && !capacityOverrides[item.agent.id]);
    if (missing.length === 0) return;
    void Promise.all(missing.map(async (item) => {
      try {
        const capacity = await launchApi.agentCapacity(agentLocator(item.agent));
        return [item.agent.id, capacity] as const;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (!mounted) return;
      setCapacityOverrides((current) => ({
        ...current,
        ...Object.fromEntries(entries.filter((entry): entry is readonly [string, LaunchAgentCapacityResponse] => entry !== null)),
      }));
    });
    return () => { mounted = false; };
  }, [agents, capacityOverrides]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest(
        "button, .neb-agent-card, .neb-add-agent-card, .neb-notif-item, .neb-cmdk-item",
      );
      if (target && !target.classList.contains("neb-modal-close")) sounds.click();
    };
    const onHover = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest(
        "button, .neb-agent-card, .neb-add-agent-card, .neb-notif-item, .neb-cmdk-item",
      );
      if (!target || (event.relatedTarget && target.contains(event.relatedTarget as Node))) return;
      sounds.hover();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("mouseover", onHover);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("mouseover", onHover);
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => live.reload(), 60_000);
    return () => window.clearInterval(id);
  }, [live.reload]);

  return (
    <div className="nebula-root">
      <Starfield />
      <div className="neb-nebula n1" aria-hidden="true" />
      <div className="neb-nebula n2" aria-hidden="true" />
      <div className="neb-nebula n3" aria-hidden="true" />
      <div className="neb-grain" aria-hidden="true" />

      <main className="neb-app">
        <header className="neb-topbar">
          <button className="neb-wordmark" onClick={() => navigate("/")} type="button">
            <span className="dot" />galactic
            <span className="neb-wordmark-tier">{(live.data.fleet?.accountCapacity.plan ?? "").replace("max_5x", "max").replace("max_10x", "ultra")}</span>
          </button>
          <div className="neb-topbar-actions">
            <button className="neb-cmdk-chip" onClick={() => setCommandOpen(true)} type="button">Search <kbd>⌘K</kbd></button>
            <button className="neb-icon-btn" onClick={() => setGlobalAlertsOpen(true)} aria-label="Alerts" type="button">
              <Glyph name="bell" />
              {unread > 0 ? <span className="neb-notif-dot" /> : null}
            </button>
            <button className="neb-icon-btn" onClick={() => navigate("/account")} aria-label="Settings" type="button"><Glyph name="gear" /></button>
          </div>
        </header>

        <section className="neb-hero">
          <h1>Agents work here</h1>
          {unread > 0
            ? (
              <button className="neb-hero-alerts-btn" onClick={() => setGlobalAlertsOpen(true)} type="button">
                <span className="neb-hero-alerts-dot" />{unread} Alert{unread === 1 ? "" : "s"}
              </button>
            )
            : null}
        </section>

        <section aria-label="Your Agent fleet">
          <div className="neb-fleet-head">
            <div className="neb-section-label">Your Fleet</div>
            <div className="neb-fleet-meta"><b>{activeCount}</b> active · {agents.length} total</div>
          </div>
          {live.status === "error" && agents.length === 0
            ? <p className="neb-error-note">{live.error || "Fleet could not be loaded."}</p>
            : null}
          <div className="neb-roster">
            {agents.map((item, index) => (
              <FleetCard
                accountCapacity={live.data.fleet?.accountCapacity}
                index={index}
                item={capacityOverrides[item.agent.id]
                  ? { ...item, capacity: capacityOverrides[item.agent.id] }
                  : item}
                key={item.agent.id}
                now={now}
                onIconChanged={live.reload}
                onOpen={() => navigate(`/agents/${encodeURIComponent(item.agent.slug)}`)}
              />
            ))}
            <AddAgentCard number={agents.length + 1} />
          </div>
        </section>
      </main>

      {globalAlertsOpen
        ? (
          <GlobalAlerts
            agents={agents}
            onClose={() => { sounds.close(); setGlobalAlertsOpen(false); setReturnToAlerts(false); }}
            onNavigate={(path) => {
              setGlobalAlertsOpen(false);
              setReturnToAlerts(true);
              navigate(path);
            }}
            onUnreadChange={setUnread}
          />
        )
        : null}
      {settingsOpen
        ? <SettingsModal initial={live.data} onClose={() => {
          sounds.close();
          navigate("/");
          if (returnToAlerts) {
            setReturnToAlerts(false);
            setGlobalAlertsOpen(true);
          }
        }} />
        : null}
      {agentOpen
        ? activeAgent
          ? (
            <AgentModal
              agent={activeAgent}
              initialUnread={agents.find((item) => item.agent.id === activeAgent.id)?.unreadAlertCount ?? 0}
              key={activeAgent.id}
              live={live}
              onClose={() => {
                sounds.close();
                navigate("/");
                if (returnToAlerts) {
                  setReturnToAlerts(false);
                  setGlobalAlertsOpen(true);
                }
              }}
            />
          )
          : (
            <Modal className="agent-modal" label="Loading Agent" onClose={() => navigate("/")}>
              <CloseButton onClose={() => navigate("/")} />
              <div className="neb-modal-content"><p className="neb-ov-note">Loading Agent…</p></div>
            </Modal>
          )
        : null}
      {commandOpen
        ? (
          <CommandPalette
            agents={agents}
            onClose={() => { sounds.close(); setCommandOpen(false); }}
            onNavigate={(path) => {
              setCommandOpen(false);
              navigate(path);
            }}
            onAlerts={() => {
              setCommandOpen(false);
              setGlobalAlertsOpen(true);
            }}
          />
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
      className={`neb-notif-item${notification.read_at ? "" : " unread"}`}
      onClick={onOpen}
      type="button"
    >
      <span className={`neb-notif-icon ${notification.severity !== "info" ? "warn" : ""}`}>
        <Glyph name={notification.severity !== "info" ? "alert" : "spark"} />
      </span>
      <span className="neb-notif-body">
        <span className="neb-notif-title">{notification.title}</span>
        {notification.body ? <span className="neb-notif-copy">{notification.body}</span> : null}
        <span className="neb-notif-time">{formatRelative(notification.created_at)}</span>
      </span>
    </button>
  );
}

function GlobalAlerts({
  agents,
  onClose,
  onNavigate,
  onUnreadChange,
}: {
  agents: LaunchFleetAgentSummary[];
  onClose: () => void;
  onNavigate: (path: string) => void;
  onUnreadChange: (count: number) => void;
}): ReactElement {
  const [items, setItems] = useState<LaunchNotification[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const response = await launchApi.listNotifications({ limit: 100 });
      setItems(response.notifications);
      onUnreadChange(response.unread_count);
    } finally {
      setLoading(false);
    }
  }, [onUnreadChange]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const filtered = items.filter((item) =>
    `${item.title} ${item.body ?? ""}`.toLowerCase().includes(query.toLowerCase())
  );
  const unreadCount = items.filter((item) => !item.read_at).length;
  const open = async (item: LaunchNotification) => {
    if (!item.read_at) {
      await launchApi.markNotificationsRead({ ids: [item.id] }).catch(() => undefined);
      const next = items.map((entry) => entry.id === item.id
        ? { ...entry, read_at: new Date().toISOString() }
        : entry);
      setItems(next);
      onUnreadChange(next.filter((entry) => !entry.read_at).length);
    }
    const ownedAgent = agents.find((candidate) => candidate.agent.id === item.agent_id);
    const localAction = safeLocalActionPath(item.action_url);
    const action = localAction
      ? localAction
      : ownedAgent
      ? `/agents/${encodeURIComponent(ownedAgent.agent.slug)}`
      : null;
    if (action) {
      onNavigate(action);
    }
  };
  return (
    <Modal className="neb-alerts-modal" label="Alerts" onClose={onClose}>
      <CloseButton onClose={onClose} />
      <div className="neb-alerts-header">{unreadCount} Alert{unreadCount === 1 ? "" : "s"}</div>
      <div className="neb-alerts-toolbar">
        <label className="neb-alerts-search">
          <Glyph name="search" />
          <input
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search alerts"
            value={query}
          />
        </label>
      </div>
      <div className="neb-alerts-content">
        {filtered.map((item) => <NotificationRow key={item.id} notification={item} onOpen={() => void open(item)} />)}
        {!loading && filtered.length === 0 ? <div className="neb-alerts-empty">No alerts match.</div> : null}
        {loading ? <div className="neb-alerts-empty">Loading alerts…</div> : null}
      </div>
    </Modal>
  );
}

function CommandPalette({
  agents,
  onAlerts,
  onClose,
  onNavigate,
}: {
  agents: LaunchFleetAgentSummary[];
  onAlerts: () => void;
  onClose: () => void;
  onNavigate: (path: string) => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const items = useMemo(() => [
    ...agents.map((item) => ({
      label: item.agent.name,
      type: "AGENT",
      run: () => onNavigate(`/agents/${encodeURIComponent(item.agent.slug)}`),
    })),
    { label: "Alerts", type: "VIEW", run: onAlerts },
    { label: "Usage", type: "SETTINGS", run: () => onNavigate("/account?pane=usage") },
    { label: "Billing", type: "SETTINGS", run: () => onNavigate("/account?pane=billing") },
    { label: "BYOK Setup", type: "SETTINGS", run: () => onNavigate("/account?pane=byok") },
    { label: "Galactic Keys", type: "SETTINGS", run: () => onNavigate("/account?pane=keys") },
    { label: "Connect Agent", type: "SETTINGS", run: () => onNavigate("/account?pane=connect") },
  ], [agents, onAlerts, onNavigate]);
  const filtered = items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => setSelected(0), [query]);
  return (
    <Modal className="neb-cmdk" label="Command palette" onClose={onClose}>
      <div className="neb-cmdk-input-wrap">
        <Glyph name="search" />
        <input
          className="neb-cmdk-input"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected((value) => Math.min(filtered.length - 1, value + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              filtered[selected]?.run();
            }
          }}
          placeholder="Jump to an agent or action…"
          ref={inputRef}
          value={query}
        />
      </div>
      <div className="neb-cmdk-list">
        {filtered.map((item, index) => (
          <button
            className={`neb-cmdk-item${selected === index ? " sel" : ""}`}
            key={`${item.type}-${item.label}`}
            onClick={item.run}
            onMouseMove={() => setSelected(index)}
            type="button"
          >
            <Glyph name={item.type === "AGENT" ? "spark" : "chevron"} />
            <span>{item.label}</span><span className="k-type">{item.type}</span>
          </button>
        ))}
        {filtered.length === 0 ? <div className="neb-cmdk-empty">Nothing matches.</div> : null}
      </div>
      <div className="neb-cmdk-foot"><span>↑↓ NAVIGATE</span><span>↵ SELECT</span><span>ESC CLOSE</span></div>
    </Modal>
  );
}

function SettingsModal({
  initial,
  onClose,
}: {
  initial: LaunchPageProps["live"]["data"];
  onClose: () => void;
}): ReactElement {
  const requested = new URLSearchParams(window.location.search).get("pane") as SettingsPane | null;
  const [pane, setPane] = useState<SettingsPane>(requested && ["general", "billing", "usage", "byok", "keys", "connect"].includes(requested) ? requested : "general");
  const [showing, setShowing] = useState(Boolean(requested));
  const [subscription, setSubscription] = useState<LaunchSubscriptionResponse | undefined>(initial.subscription);
  const [byok, setByok] = useState<LaunchByokSummaryResponse | undefined>(initial.byok);
  const [keys, setKeys] = useState(initial.apiKeys?.apiKeys ?? []);
  const [settings, setSettings] = useState<LaunchSettingsResponse | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [subResult, byokResult, keysResult, settingsResult] = await Promise.allSettled([
      launchApi.subscription(),
      launchApi.byok(),
      launchApi.apiKeys(),
      launchApi.getLaunchSettings(),
    ]);
    if (subResult.status === "fulfilled") setSubscription(subResult.value);
    if (byokResult.status === "fulfilled") setByok(byokResult.value);
    if (keysResult.status === "fulfilled") setKeys(keysResult.value.apiKeys);
    if (settingsResult.status === "fulfilled") setSettings(settingsResult.value);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const choose = (next: SettingsPane) => {
    setPane(next);
    setShowing(true);
  };
  return (
    <Modal className={`railed${showing ? " showing-content" : ""}`} label="Settings" onClose={onClose}>
      <nav className="neb-modal-rail" aria-label="Settings sections">
        {([
          ["general", "General"],
          ["billing", "Billing"],
          ["usage", "Usage"],
          ["byok", "BYOK Setup"],
          ["keys", "Galactic Keys"],
          ["connect", "Connect Agent"],
        ] as const).map(([id, label]) => (
          <button className={`neb-rail-btn${pane === id ? " active" : ""}`} key={id} onClick={() => choose(id)} type="button">{label}</button>
        ))}
      </nav>
      <div className="neb-modal-content">
        <CloseButton onClose={onClose} />
        <button className="neb-mobile-back" onClick={() => setShowing(false)} type="button">‹ Menu</button>
        {error ? <p className="neb-error-note" role="alert">{error}</p> : null}
        {pane === "general" ? <GeneralSettings settings={settings} onChange={setSettings} setError={setError} /> : null}
        {pane === "billing" ? <BillingSettings subscription={subscription} setError={setError} /> : null}
        {pane === "usage" ? <UsageSettings subscription={subscription} /> : null}
        {pane === "byok" ? <ByokSettings byok={byok} onChange={setByok} setError={setError} /> : null}
        {pane === "keys" ? <KeySettings keys={keys} onChange={setKeys} setError={setError} /> : null}
        {pane === "connect" ? <ConnectSettings setError={setError} /> : null}
      </div>
    </Modal>
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
  const [name, setName] = useState(settings?.displayName ?? "");
  const [saved, setSaved] = useState(false);
  useEffect(() => setName(settings?.displayName ?? ""), [settings?.displayName]);
  const save = async () => {
    setError("");
    try {
      const response = await launchApi.updateLaunchSettings({ displayName: name.trim() || null });
      onChange(response);
      setSaved(true);
      sounds.confirm();
      window.setTimeout(() => setSaved(false), 1200);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <section className="neb-modal-pane active">
      <h2 className="neb-modal-h">General</h2>
      <label className="neb-field-label">Display name</label>
      <div className="neb-inline-field">
        <input className="neb-edit-input" onChange={(event) => setName(event.currentTarget.value)} value={name} />
        <button className={`neb-btn-sm${saved ? " saved" : ""}`} onClick={() => void save()} type="button">{saved ? "Saved" : "Save"}</button>
      </div>
      <div className="neb-ov-row"><span className="neb-ov-row-key">Account mode</span><span className="neb-ov-row-val">Private fleet</span></div>
      <div className="neb-ov-row"><span className="neb-ov-row-key">Inference</span><span className="neb-ov-row-val">BYOK only</span></div>
      <button
        className="neb-btn neb-signout"
        onClick={() => void signOutLaunch().finally(() => { window.location.href = "/"; })}
        type="button"
      >Sign out</button>
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
    setError("");
    try {
      const result = subscription?.canManage
        ? await launchApi.createSubscriptionPortal()
        : await launchApi.createSubscriptionCheckout();
      window.location.assign(result.url);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };
  return (
    <section className="neb-modal-pane active">
      <h2 className="neb-modal-h">Billing</h2>
      <div className="neb-plan-card">
        <div>
          <div className="neb-plan-name">{subscription?.planName ?? "Loading…"}</div>
          <div className="neb-plan-price">
            {subscription ? `$${(subscription.priceCents / 100).toLocaleString()} / month` : "Checking Stripe…"}
            {subscription?.currentPeriodEnd ? ` · renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}` : ""}
          </div>
        </div>
        <button className="neb-btn" disabled={busy || !subscription} onClick={() => void open()} type="button">
          {subscription?.canManage ? "Manage in Stripe" : "Upgrade to Pro"}
        </button>
      </div>
      <p className="neb-ov-note">Subscription changes, payment methods, invoices, and cancellation are handled securely by Stripe.</p>
    </section>
  );
}

function UsageSettings({ subscription }: { subscription?: LaunchSubscriptionResponse }): ReactElement {
  return (
    <section className="neb-modal-pane active">
      <h2 className="neb-modal-h">Usage</h2>
      {subscription
        ? ([
          ["5-hour limit", subscription.capacity.burst],
          ["Weekly limit", subscription.capacity.weekly],
        ] as const).map(([label, window]) => (
          <div className="neb-usage-block" key={label}>
            <div className="neb-usage-row"><span className="neb-usage-label">{label}</span><span className="neb-usage-value">{window.usedPercent === undefined ? window.state : `${Math.round(window.usedPercent)}% used`}</span></div>
            <div className="neb-usage-bar"><div className="neb-usage-bar-fill" style={{ width: `${asPercent(window.usedPercent)}%` }} /></div>
            <div className="neb-usage-reset">Resets {new Date(window.resetsAt).toLocaleString()}</div>
          </div>
        ))
        : <p className="neb-ov-note">Loading capacity…</p>}
      {subscription?.capacity.state === "waiting"
        ? <p className="neb-capacity-wait">Agents are waiting and resume automatically in the next open capacity block.</p>
        : null}
      <p className="neb-ov-note">Capacity is pooled across every Agent on this account. Free allowance numbers remain unpublished, while status and reset time always stay visible.</p>
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
    <section className="neb-modal-pane active">
      <h2 className="neb-modal-h">BYOK Setup</h2>
      <p className="neb-ov-note top-note">Your model API keys power galactic.ai() directly. Galactic does not resell or mark up inference.</p>
      {(byok?.providers ?? []).map((provider) => (
        <ProviderRow key={provider.id} provider={provider} onRefresh={refresh} setError={setError} />
      ))}
      {!byok ? <p className="neb-ov-note">Loading inference providers…</p> : null}
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
  const [key, setKey] = useState("");
  const [model, setModel] = useState(provider.model ?? provider.defaultModel ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await launchApi.upsertByokProvider(provider.id, { apiKey: key.trim(), model: model.trim() || undefined, validate: true });
      await onRefresh();
      setKey("");
      setOpen(false);
      sounds.confirm();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="neb-provider-row">
      <div className="neb-provider-head">
        <div><strong>{provider.name}</strong><span>{provider.configured ? `${provider.apiKeyPrefix ?? "Key"} · ${provider.model ?? provider.defaultModel ?? "default model"}` : provider.description ?? "Not connected"}</span></div>
        <div className="neb-provider-actions">
          {provider.configured && !provider.primary
            ? <button className="neb-btn-sm" onClick={() => void launchApi.setByokPrimary(provider.id).then(onRefresh).catch((error) => setError(error instanceof Error ? error.message : String(error)))} type="button">Make primary</button>
            : null}
          <button className="neb-btn-sm" onClick={() => setOpen((value) => !value)} type="button">{provider.configured ? "Replace" : "Add key"}</button>
          {provider.configured
            ? (
              <button
                className="neb-btn-sm danger"
                onClick={() => {
                  if (!window.confirm(`Disconnect ${provider.name}? Agents using it will wait until another configured provider is selected.`)) return;
                  void launchApi.deleteByokProvider(provider.id)
                    .then(onRefresh)
                    .catch((error) => setError(error instanceof Error ? error.message : String(error)));
                }}
                type="button"
              >Remove</button>
            )
            : null}
        </div>
      </div>
      {open
        ? (
          <div className="neb-provider-editor">
            <input className="neb-edit-input" onChange={(event) => setKey(event.currentTarget.value)} placeholder="API key" type="password" value={key} />
            <input className="neb-edit-input" onChange={(event) => setModel(event.currentTarget.value)} placeholder={provider.defaultModel ?? "Default model"} value={model} />
            <button className="neb-btn-sm" disabled={busy || !key.trim()} onClick={() => void save()} type="button">{busy ? "Validating…" : "Save"}</button>
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
  const [plaintext, setPlaintext] = useState("");
  const create = async () => {
    setError("");
    try {
      const response = await launchApi.createApiKey({
        name: `Web key ${new Date().toISOString().slice(0, 10)}`,
        expiresInDays: 90,
        scopes: ["apps:read", "apps:call", "agents:build", "agents:operate"],
      });
      setPlaintext(response.plaintextToken);
      onChange([response.apiKey, ...keys]);
      sounds.confirm();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <section className="neb-modal-pane active">
      <h2 className="neb-modal-h">Galactic Keys</h2>
      <p className="neb-ov-note top-note">Programmatic credentials for Galactic. Inference providers use separate BYOK keys.</p>
      {plaintext
        ? <div className="neb-secret-reveal"><code>{plaintext}</code><CopyButton text={plaintext} /><p>Shown once. Store it now.</p></div>
        : null}
      {keys.map((key) => (
        <div className="neb-ov-connect" key={key.id}>
          <code>{key.name} · {key.tokenPrefix}••••</code>
          <button className="neb-btn-sm" onClick={() => void launchApi.revokeApiKey(key.id).then(() => onChange(keys.filter((candidate) => candidate.id !== key.id))).catch((error) => setError(error instanceof Error ? error.message : String(error)))} type="button">Revoke</button>
        </div>
      ))}
      <button className="neb-btn" onClick={() => void create()} type="button">Create scoped key</button>
    </section>
  );
}

function ConnectSettings({ setError }: { setError: (value: string) => void }): ReactElement {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const [key, install] = await Promise.all([
        launchApi.createApiKey({
          name: `Agent connect ${new Date().toISOString().slice(0, 16)}`,
          expiresInDays: 90,
          scopes: ["apps:read", "apps:call", "agents:build", "agents:operate"],
        }),
        launchApi.install(),
      ]);
      const template = install.instructions.find((item) => item.target === "prompt")?.configText;
      setPrompt(template?.replaceAll("$GALACTIC_API_KEY", key.plaintextToken) ??
        `Connect Galactic at ${launchApiOrigin()}/mcp/platform with Authorization: Bearer ${key.plaintextToken}. Then ask me what persistent Agent to conjure.`);
      sounds.confirm();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="neb-modal-pane active">
      <h2 className="neb-modal-h">Connect Agent</h2>
      <p className="neb-ov-note top-note">Pair Codex, Claude Code, Cursor, or another MCP client to deploy and supervise this fleet.</p>
      {prompt
        ? <div className="neb-connect-prompt"><pre>{prompt}</pre><CopyButton text={prompt} /></div>
        : <button className="neb-btn" disabled={busy} onClick={() => void create()} type="button">{busy ? "Creating connection…" : "Create connection prompt"}</button>}
    </section>
  );
}

function AgentModal({
  agent,
  initialUnread,
  live,
  onClose,
}: {
  agent: LaunchAgentSummary;
  initialUnread: number;
  live: LaunchPageProps["live"];
  onClose: () => void;
}): ReactElement {
  const [pane, setPane] = useState<AgentPane>(initialUnread > 0 ? "alerts" : "interfaces");
  const [showing, setShowing] = useState(false);
  const [unread, setUnread] = useState(initialUnread);
  const touched = useRef(false);
  useEffect(() => {
    if (unread > 0 && !touched.current) setPane("alerts");
  }, [unread]);
  useEffect(() => {
    let mounted = true;
    launchApi.listNotifications({ agent: agentLocator(agent), unreadOnly: true, limit: 1 })
      .then((response) => {
        if (mounted) setUnread(response.unread_count);
      })
      .catch(() => undefined);
    return () => { mounted = false; };
  }, [agent.id, agent.slug]);
  const choose = (next: AgentPane) => {
    touched.current = true;
    setPane(next);
    setShowing(true);
  };
  const interfaces = agent.interfaces ?? [];
  const functions = live.data.agentFunctions;
  return (
    <Modal className={`railed agent-modal${showing ? " showing-content" : ""}`} label={agent.name} onClose={onClose}>
      <nav className="neb-modal-rail agent-rail" aria-label={`${agent.name} sections`}>
        <button
          className={`neb-rail-btn${pane === "alerts" ? " active" : ""}`}
          onClick={() => choose("alerts")}
          style={{ order: unread > 0 ? 0 : 5 }}
          type="button"
        >Alerts{unread > 0 ? <span className="neb-rail-count">{unread}</span> : null}</button>
        <button className={`neb-rail-btn${pane === "interfaces" ? " active" : ""}`} onClick={() => choose("interfaces")} style={{ order: 1 }} type="button">Interfaces</button>
        <button className={`neb-rail-btn${pane === "routines" ? " active" : ""}`} onClick={() => choose("routines")} style={{ order: 2 }} type="button">Routines</button>
        <button className={`neb-rail-btn${pane === "functions" ? " active" : ""}`} onClick={() => choose("functions")} style={{ order: 3 }} type="button">Functions</button>
        <button className={`neb-rail-btn${pane === "compute" ? " active" : ""}`} onClick={() => choose("compute")} style={{ order: 4 }} type="button">Compute</button>
        <button className={`neb-rail-btn${pane === "settings" ? " active" : ""}`} onClick={() => choose("settings")} style={{ order: 6 }} type="button">Settings</button>
      </nav>
      <div className="neb-modal-content">
        <CloseButton onClose={onClose} />
        <button className="neb-mobile-back" onClick={() => setShowing(false)} type="button">‹ Menu</button>
        {pane === "alerts" ? <AgentAlerts agent={agent} onUnread={setUnread} /> : null}
        {pane === "interfaces" ? <InterfacesPane agent={agent} interfaces={interfaces} /> : null}
        {pane === "routines" ? <RoutinesPane agent={agent} live={live} /> : null}
        {pane === "functions" ? <FunctionsPane agent={agent} functions={functions} live={live} /> : null}
        {pane === "compute" ? <AgentComputePane agent={agent} /> : null}
        {pane === "settings" ? <AgentSettingsPane agent={agent} live={live} /> : null}
      </div>
    </Modal>
  );
}

function AgentAlerts({
  agent,
  onUnread,
}: {
  agent: LaunchAgentSummary;
  onUnread: (count: number) => void;
}): ReactElement {
  const [items, setItems] = useState<LaunchNotification[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    launchApi.listNotifications({ agent: agentLocator(agent), limit: 100 })
      .then((response) => {
        if (!live) return;
        setItems(response.notifications);
        onUnread(response.unread_count);
      })
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [agent.id, agent.slug, onUnread]);
  const read = async (item: LaunchNotification) => {
    if (item.read_at) return;
    await launchApi.markNotificationsRead({ ids: [item.id], agent: agentLocator(agent) }).catch(() => undefined);
    const readAt = new Date().toISOString();
    setItems((current) => {
      const next = current.map((entry) => entry.id === item.id ? { ...entry, read_at: readAt } : entry);
      onUnread(next.filter((entry) => !entry.read_at).length);
      return next;
    });
  };
  return (
    <section className="neb-modal-pane active">
      <h2 className="neb-modal-h">Alerts</h2>
      {items.map((item) => <NotificationRow key={item.id} notification={item} onOpen={() => void read(item)} />)}
      {!loading && items.length === 0 ? <p className="neb-ov-note">No alerts from this Agent yet.</p> : null}
      {loading ? <p className="neb-ov-note">Loading Agent alerts…</p> : null}
      <p className="neb-ov-note">Only this Agent's reports, thresholds, and setup blockers. The bell keeps the account-wide view.</p>
    </section>
  );
}

function InterfacesPane({
  agent,
  interfaces,
}: {
  agent: LaunchAgentSummary;
  interfaces: LaunchInterfaceSummary[];
}): ReactElement {
  const [selected, setSelected] = useState<LaunchInterfaceSummary | null>(null);
  return (
    <section className="neb-modal-pane active">
      <h2 className="neb-modal-h">Interfaces</h2>
      {interfaces.map((item) => (
        <button className="neb-popup-item" key={item.id} onClick={() => setSelected(item)} type="button">
          <span className="neb-popup-item-name">{item.label}</span>
          <span className="neb-popup-item-desc">{item.description ?? `${item.functions.length} connected function${item.functions.length === 1 ? "" : "s"}`}</span>
        </button>
      ))}
      {interfaces.length === 0 ? <p className="neb-ov-note">This Agent has not published a custom interface.</p> : null}
      <PromptButton agent={agent} kind="interface" />
      {selected ? <InterfaceViewer agent={agent} iface={selected} onClose={() => setSelected(null)} /> : null}
    </section>
  );
}

function PromptButton({ agent, kind }: { agent: LaunchAgentSummary; kind: "interface" | "routine" | "function" }): ReactElement {
  const [copied, setCopied] = useState(false);
  const prompt = `Add a new ${kind} to the “${agent.name}” Agent on Galactic — describe ${kind === "routine" ? "the cadence and what it should do" : kind === "interface" ? "the view or controls it should expose" : "what it should do and when the Agent should call it"}.`;
  return (
    <button className={`neb-add-btn${copied ? " copied" : ""}`} onClick={() => {
      void navigator.clipboard.writeText(prompt);
      setCopied(true);
      sounds.confirm();
      window.setTimeout(() => setCopied(false), 3000);
    }} type="button">{copied ? "Copied — paste into your coding agent" : `+ Add ${kind}`}</button>
  );
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
  const [height, setHeight] = useState(() => clampInterfaceHeight(iface.minHeight ?? 360));
  const [connected, setConnected] = useState(false);
  useEffect(() => {
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
        runInterfaceFunctionDurably({
          client: launchApi,
          agentId: agent.id,
          functionName,
          args,
          signal: controller.signal,
        }),
      onConnected: () => setConnected(true),
      onResize: setHeight,
    });
    return () => {
      controller.abort();
      detach();
    };
  }, [agent.id, agent.name, agent.slug, iface.functions, iface.id, iface.minHeight]);
  return (
    <Modal className="neb-interface-modal" label={`${agent.name} — ${iface.label}`} onClose={onClose}>
      <CloseButton onClose={onClose} />
      <div className="neb-modal-content interface-content">
        <h2 className="neb-modal-h">{iface.label}</h2>
        <iframe
          className="neb-interface-frame"
          ref={iframeRef}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-forms"
          src={iface.url}
          style={{ height }}
          title={`${agent.name} — ${iface.label}`}
        />
        <p className="neb-ov-note">{connected ? "Connected to this Agent's allowed functions." : "Waiting for the Galactic interface bridge…"}</p>
      </div>
    </Modal>
  );
}

function RoutinesPane({
  agent,
  live,
}: {
  agent: LaunchAgentSummary;
  live: LaunchPageProps["live"];
}): ReactElement {
  const [response, setResponse] = useState(live.data.agentRoutines);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => setResponse(live.data.agentRoutines), [live.data.agentRoutines]);
  const refresh = async () => {
    const next = await launchApi.agentRoutines(agentLocator(agent));
    setResponse(next);
    return next;
  };
  const act = async (routine: LaunchAgentRoutineOverview, action: "pause" | "activate" | "run_now") => {
    if (!response || busy) return;
    setBusy(routine.id);
    setError("");
    try {
      await launchApi.actOnAgentManagedRoutine(agentLocator(agent), routine.id, {
        action,
        expectedRevision: response.revision,
        idempotencyKey: randomId(),
      });
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
    setError("");
    try {
      await launchApi.updateAgentManagedRoutine(agentLocator(agent), routine.id, {
        ...update,
        expectedRevision: response.revision,
      });
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
  return (
    <section className="neb-modal-pane active">
      <h2 className="neb-modal-h">Routines</h2>
      {error ? <p className="neb-error-note" role="alert">{error}</p> : null}
      {(response?.routines ?? []).map((routine) => (
        <RoutineRow
          busy={busy === routine.id}
          key={routine.id}
          onAction={(action) => void act(routine, action)}
          onSave={(update) => save(routine, update)}
          routine={routine}
        />
      ))}
      {response && response.routines.length === 0 ? <p className="neb-ov-note">No managed routines yet.</p> : null}
      {!response ? <p className="neb-ov-note">Loading routines…</p> : null}
      <PromptButton agent={agent} kind="routine" />
    </section>
  );
}

function RoutineRow({
  busy,
  onAction,
  onSave,
  routine,
}: {
  busy: boolean;
  onAction: (action: "pause" | "activate" | "run_now") => void;
  onSave: (update: RoutineUpdate) => Promise<boolean>;
  routine: LaunchAgentRoutineOverview;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  return (
    <div className="neb-popup-item neb-routine-item">
      <button className="neb-routine-main" onClick={() => setEditing(true)} type="button">
        <span className="neb-popup-item-name">{routine.name}{routine.role === "primary" ? <small> PRIMARY</small> : null}</span>
        <span className="neb-popup-item-desc">{routine.schedule.label}</span>
        <span className="neb-routine-meta">
          <span className={routine.health === "error" ? "routine-fail" : routine.status === "active" ? "routine-ok" : ""}>{routine.health}</span>
          {routine.lastRunAt ? ` · ${formatRelative(routine.lastRunAt)} ago` : " · never run"}
        </span>
      </button>
      <div className="neb-routine-actions">
        {routine.actions.canRunNow
          ? <button className="neb-run-now" disabled={busy} onClick={() => onAction("run_now")} title="Run now" type="button">→</button>
          : null}
        {routine.status === "active" && routine.actions.canPause
          ? <button className="neb-pause-btn" disabled={busy} onClick={() => onAction("pause")} aria-label="Pause routine" type="button"><Glyph name="pause" /></button>
          : routine.actions.canActivate
          ? <button className="neb-pause-btn paused" disabled={busy} onClick={() => onAction("activate")} aria-label="Activate routine" type="button"><Glyph name="play" /></button>
          : null}
      </div>
      {editing ? <RoutineEditor routine={routine} onSave={onSave} onClose={() => setEditing(false)} /> : null}
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
  const [description, setDescription] = useState(routine.description ?? "");
  const [mission, setMission] = useState(routine.mission);
  const [kind, setKind] = useState<"interval" | "cron">(routine.schedule.kind);
  const [intervalMinutes, setIntervalMinutes] = useState(
    routine.schedule.kind === "interval" ? String(routine.schedule.intervalSeconds / 60) : "5",
  );
  const [expression, setExpression] = useState(routine.schedule.kind === "cron" ? routine.schedule.expression : "0 9 * * 1-5");
  const [timezone, setTimezone] = useState(routine.schedule.kind === "cron" ? routine.schedule.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const ok = await onSave({
      name: name.trim(),
      description: description.trim() || null,
      mission: mission.trim() || null,
      schedule: kind === "interval"
        ? { kind: "interval", intervalSeconds: Math.max(60, Math.round(Number(intervalMinutes) * 60)) }
        : { kind: "cron", expression: expression.trim(), timezone: timezone.trim() || "UTC" },
    });
    setSaving(false);
    if (ok) onClose();
  };
  return (
    <Modal className="neb-routine-editor" label={`Edit ${routine.name}`} onClose={onClose}>
      <CloseButton onClose={onClose} />
      <form className="neb-modal-content" onSubmit={(event) => void submit(event)}>
        <h2 className="neb-modal-h">Routine</h2>
        <label className="neb-field-label">Name</label>
        <input className="neb-edit-input" onChange={(event) => setName(event.currentTarget.value)} value={name} />
        <label className="neb-field-label">Description</label>
        <input className="neb-edit-input" onChange={(event) => setDescription(event.currentTarget.value)} value={description} />
        <label className="neb-field-label">Mission</label>
        <textarea className="neb-edit-textarea" onChange={(event) => setMission(event.currentTarget.value)} value={mission} />
        <label className="neb-field-label">Schedule type</label>
        <select className="neb-edit-input" onChange={(event) => setKind(event.currentTarget.value as "interval" | "cron")} value={kind}>
          <option value="interval">Interval</option><option value="cron">Cron</option>
        </select>
        {kind === "interval"
          ? <><label className="neb-field-label">Every (minutes)</label><input className="neb-edit-input" min="1" onChange={(event) => setIntervalMinutes(event.currentTarget.value)} type="number" value={intervalMinutes} /></>
          : <><label className="neb-field-label">Five-field cron</label><input className="neb-edit-input mono" onChange={(event) => setExpression(event.currentTarget.value)} value={expression} /><label className="neb-field-label">IANA timezone</label><input className="neb-edit-input mono" onChange={(event) => setTimezone(event.currentTarget.value)} value={timezone} /></>}
        <p className="neb-ov-note">{routine.nextOccurrences.length > 0 ? `Next: ${routine.nextOccurrences.map((item) => new Date(item).toLocaleString()).join(" · ")}` : "The server computes the next occurrences after save."}</p>
        <button className="neb-btn" disabled={saving} type="submit">{saving ? "Saving…" : "Save routine"}</button>
      </form>
    </Modal>
  );
}

function functionBadges(fn: LaunchFunctionSummary): Array<"Read" | "Write" | "AI"> {
  const badges: Array<"Read" | "Write" | "AI"> = [
    fn.annotations?.readOnlyHint === true ? "Read" : "Write",
  ];
  if (fn.usesInference) badges.push("AI");
  return badges;
}

function FunctionsPane({
  agent,
  functions,
  live,
}: {
  agent: LaunchAgentSummary;
  functions?: LaunchAgentFunctionsResponse;
  live: LaunchPageProps["live"];
}): ReactElement {
  const [selected, setSelected] = useState<LaunchFunctionSummary | null>(null);
  return (
    <section className="neb-modal-pane active">
      <h2 className="neb-modal-h">Functions</h2>
      {(functions?.functions ?? []).map((fn) => (
        <button className="neb-popup-item" key={fn.name} onClick={() => setSelected(fn)} type="button">
          <span className="neb-popup-item-line">
            <span className="neb-popup-item-name">{fn.name}</span>
            <span className="neb-function-badges">{functionBadges(fn).map((badge) => <span className={`neb-function-badge ${badge.toLowerCase()}`} key={badge}>{badge}</span>)}</span>
          </span>
          <span className="neb-popup-item-desc">{fn.description ?? "No description published."}</span>
        </button>
      ))}
      {functions && functions.functions.length === 0 ? <p className="neb-ov-note">This Agent has not published callable functions.</p> : null}
      {!functions ? <p className="neb-ov-note">Loading functions…</p> : null}
      <PromptButton agent={agent} kind="function" />
      {selected
        ? <FunctionDetail agent={agent} fn={selected} live={live} onClose={() => setSelected(null)} />
        : null}
    </section>
  );
}

function schemaProperties(fn: LaunchFunctionSummary): Array<{ name: string; description: string; type: string }> {
  const raw = fn.inputSchema?.properties;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw).map(([name, value]) => {
    const schema = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    return {
      name,
      description: typeof schema.description === "string" ? schema.description : "",
      type: typeof schema.type === "string" ? schema.type : "string",
    };
  });
}

function FunctionDetail({
  agent,
  fn,
  live,
  onClose,
}: {
  agent: LaunchAgentSummary;
  fn: LaunchFunctionSummary;
  live: LaunchPageProps["live"];
  onClose: () => void;
}): ReactElement {
  const inputs = schemaProperties(fn);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [permission, setPermission] = useState(fn.callerPermission?.policy ?? fn.agentPermission?.policy ?? "ask");
  const [savingPermission, setSavingPermission] = useState(false);
  const [error, setError] = useState("");
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
    setError("");
    try {
      const parsed = Object.fromEntries(inputs.map((input) => {
        const raw = args[input.name] ?? "";
        if (input.type === "number" || input.type === "integer") return [input.name, Number(raw)];
        if (input.type === "boolean") return [input.name, raw === "true"];
        if (input.type === "object" || input.type === "array") {
          try { return [input.name, JSON.parse(raw)]; } catch { return [input.name, raw]; }
        }
        return [input.name, raw];
      }));
      const response = await launchApi.runAgentFunction(agentLocator(agent), fn.name, { args: parsed });
      if (!mountedRef.current) return;
      const record = response.result && typeof response.result === "object" && !Array.isArray(response.result)
        ? response.result as Record<string, unknown>
        : null;
      if (record?._async === true && typeof record.job_id === "string") {
        setResult({ status: "queued", job_id: record.job_id });
        const jobId = record.job_id;
        for (let index = 0; index < 100; index += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 3000));
          if (!mountedRef.current) return;
          const job = await launchApi.launchJob(jobId);
          if (!mountedRef.current) return;
          setResult(job);
          if (job.status === "completed" || job.status === "failed") break;
        }
      } else {
        setResult(response);
      }
      sounds.confirm();
    } catch (reason) {
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  };
  const savePermission = async () => {
    setSavingPermission(true);
    setError("");
    try {
      await launchApi.updateAgentCallerPermissions(agentLocator(agent), {
        permissions: [{
          functionName: fn.name,
          policy: permission,
          healthGate: fn.callerPermission?.healthGate ?? fn.agentPermission?.healthGate ?? true,
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
    <Modal className="neb-function-modal" label={`${fn.name} function`} onClose={onClose}>
      <CloseButton onClose={onClose} />
      <div className="neb-modal-content">
        <h2 className="neb-modal-h function-title">{fn.name}</h2>
        <p className="neb-ov-note top-note">{fn.description ?? "No description published."}</p>
        <div className="neb-function-badges detail">{functionBadges(fn).map((badge) => <span className={`neb-function-badge ${badge.toLowerCase()}`} key={badge}>{badge}</span>)}</div>
        {inputs.map((input) => (
          <label className="neb-function-arg" key={input.name}>
            <span>{input.name}</span>
            <input
              className="neb-edit-input mono"
              onChange={(event) => setArgs((current) => ({ ...current, [input.name]: event.currentTarget.value }))}
              placeholder={input.description || input.type}
              value={args[input.name] ?? ""}
            />
          </label>
        ))}
        {inputs.length === 0 ? <p className="neb-ov-note">No arguments.</p> : null}
        <button className="neb-btn" disabled={running} onClick={() => void run()} type="button">{running ? "Running…" : "→ Run"}</button>
        {error ? <p className="neb-error-note" role="alert">{error}</p> : null}
        {result !== null ? <pre className="neb-function-result">{JSON.stringify(result, null, 2)}</pre> : null}

        {fn.usesInference
          ? (
            <div className="neb-ov-section function-setting">
              <div className="neb-ov-label">This function uses AI</div>
              <div className="neb-ov-row"><span className="neb-ov-row-key">Current model</span><span className="neb-ov-row-val">{fn.inferenceOverride ? `${fn.inferenceOverride.model ?? "default"} · ${fn.inferenceOverride.provider}` : "Account BYOK default"}</span></div>
              <button className="neb-btn-sm" onClick={() => setModelOpen(true)} type="button">Choose model</button>
            </div>
          )
          : null}
        <div className="neb-ov-section function-setting">
          <div className="neb-ov-label">Connected Agent permission</div>
          <div className="neb-inline-field compact">
            <select className="neb-edit-input" onChange={(event) => setPermission(event.currentTarget.value as "always" | "ask" | "never")} value={permission}>
              <option value="always">Always</option><option value="ask">Ask</option><option value="never">Never</option>
            </select>
            <button className="neb-btn-sm" disabled={savingPermission} onClick={() => void savePermission()} type="button">Save</button>
          </div>
        </div>
      </div>
      {modelOpen ? <ModelPicker agent={agent} fn={fn} live={live} onClose={() => setModelOpen(false)} /> : null}
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
  live: LaunchPageProps["live"];
  onClose: () => void;
}): ReactElement {
  const providers = (live.data.byok?.providers ?? []).filter((item) => item.configured);
  const initial = fn.inferenceOverride?.provider ?? providers[0]?.id ?? "";
  const [provider, setProvider] = useState(initial);
  const providerRecord = providers.find((item) => item.id === provider);
  const [model, setModel] = useState(fn.inferenceOverride?.model ?? providerRecord?.model ?? providerRecord?.defaultModel ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!provider || !model.trim()) return;
    setSaving(true);
    setError("");
    try {
      await launchApi.updateAgentFunctionInference(agentLocator(agent), fn.name, { provider, model: model.trim() });
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
    <Modal className="neb-model-modal" label="Choose AI model" onClose={onClose}>
      <CloseButton onClose={onClose} />
      <div className="neb-modal-content">
        <h2 className="neb-modal-h">AI model for this function</h2>
        <p className="neb-ov-note top-note">Choose one of your configured Class 1 inference providers and its real model slug.</p>
        {providers.length === 0 ? <p className="neb-error-note">No BYOK provider is configured. Add one in Settings → BYOK Setup.</p> : null}
        <label className="neb-field-label">Provider</label>
        <select className="neb-edit-input" disabled={providers.length === 0} onChange={(event) => {
          const next = event.currentTarget.value;
          const option = providers.find((item) => item.id === next);
          setProvider(next);
          setModel(option?.model ?? option?.defaultModel ?? "");
        }} value={provider}>
          {providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <label className="neb-field-label">Model</label>
        <input className="neb-edit-input" onChange={(event) => setModel(event.currentTarget.value)} placeholder={providerRecord?.defaultModel ?? "Model slug"} value={model} />
        {error ? <p className="neb-error-note">{error}</p> : null}
        <button className="neb-btn" disabled={saving || !provider || !model.trim()} onClick={() => void save()} type="button">{saving ? "Saving…" : "Save model"}</button>
      </div>
    </Modal>
  );
}

function Collapsible({
  children,
  label,
  initiallyOpen = true,
}: {
  children: ReactNode;
  label: string;
  initiallyOpen?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(initiallyOpen);
  const autoOpened = useRef(initiallyOpen);
  useEffect(() => {
    if (!initiallyOpen || autoOpened.current) return;
    autoOpened.current = true;
    setOpen(true);
  }, [initiallyOpen]);
  return (
    <section className={`neb-ov-section${open ? "" : " collapsed"}`}>
      <button className="neb-ov-section-header" onClick={() => setOpen((value) => !value)} type="button">
        <span className="neb-ov-label">{label}</span><span className="neb-ov-chevron"><Glyph name="chevron" /></span>
      </button>
      {open ? <div className="neb-ov-section-body">{children}</div> : null}
    </section>
  );
}

function AgentSettingsPane({
  agent,
  live,
}: {
  agent: LaunchAgentSummary;
  live: LaunchPageProps["live"];
}): ReactElement {
  const upstreamHome = live.data.agentHome;
  const [homeOverride, setHomeOverride] = useState<{
    agentId: string;
    snapshot: NonNullable<typeof upstreamHome>;
  } | null>(null);
  const home = homeOverride?.agentId === agent.id
    ? homeOverride.snapshot
    : upstreamHome;
  const [name, setName] = useState(home?.agent.name ?? agent.name);
  const [description, setDescription] = useState(home?.agent.description ?? agent.description ?? "");
  const [capacity, setCapacity] = useState<LaunchAgentCapacityResponse | undefined>(live.data.agentCapacity);
  const [cap, setCap] = useState(String(live.data.agentCapacity?.capPercent ?? 100));
  const [settings, setSettings] = useState<LaunchAgentSettingsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [promotionNotice, setPromotionNotice] = useState("");
  const [releaseReview, setReleaseReview] = useState<ReleaseCandidateReviewToken | null>(null);
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
      current && home && releaseCandidateMatchesReview(agent.id, home, current)
        ? current
        : null);
  }, [agent.id, home?.release.candidate?.sourceFingerprint, home?.release.candidate?.version, home?.revision]);
  useEffect(() => {
    setName(home?.agent.name ?? agent.name);
    setDescription(home?.agent.description ?? agent.description ?? "");
  }, [agent.description, agent.name, home?.agent.description, home?.agent.name]);
  useEffect(() => {
    setCapacity(live.data.agentCapacity);
    setCap(String(live.data.agentCapacity?.capPercent ?? 100));
  }, [live.data.agentCapacity]);
  useEffect(() => {
    let mounted = true;
    launchApi.agentSettings(agentLocator(agent)).then((value) => mounted && setSettings(value)).catch(() => mounted && setSettings(null));
    return () => { mounted = false; };
  }, [agent.id, agent.slug]);

  const saveIdentity = async () => {
    if (!home || busy) return;
    setBusy("identity");
    setError("");
    try {
      const next = await launchApi.updateAgentHomeIdentity(agentLocator(agent), {
        expectedRevision: home.revision,
        name: name.trim(),
        description: description.trim() || null,
      });
      setHomeOverride({ agentId: agent.id, snapshot: next });
      live.reload();
      sounds.confirm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };
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
      setError("That candidate changed or is no longer ready. Review the latest release before promoting.");
      live.reload();
      return;
    }
    promotionInFlight.current = true;
    setBusy("release");
    setError("");
    setPromotionNotice("");
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
    setBusy("capacity");
    setError("");
    try {
      const next = await launchApi.updateAgentCapacity(agentLocator(agent), { capPercent: value });
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
  const toggleAgent = async () => {
    if (!live.data.agentRoutines || busy) return;
    setBusy("status");
    setError("");
    try {
      let collection = await launchApi.agentRoutines(agentLocator(agent));
      const active = collection.routines.filter((routine) => routine.status === "active" && routine.actions.canPause);
      const targets = active.length > 0
        ? active.map((routine) => [routine, "pause"] as const)
        : collection.routines.filter((routine) => routine.status === "paused" && routine.actions.canActivate).map((routine) => [routine, "activate"] as const);
      for (const [routine, action] of targets) {
        await launchApi.actOnAgentManagedRoutine(agentLocator(agent), routine.id, {
          action,
          expectedRevision: collection.revision,
          idempotencyKey: randomId(),
        });
        collection = await launchApi.agentRoutines(agentLocator(agent));
      }
      live.reload();
      sounds.confirm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };
  const active = (live.data.agentRoutines?.aggregate.active ?? 0) > 0;
  const install = live.data.install?.agentInstall;
  const endpoint = install?.agentMcpUrl ?? `${launchApiOrigin()}/mcp/${agent.id}`;
  const liveRelease = home?.release.live;
  const candidate = home?.release.candidate;
  const releaseReviewActive = Boolean(
    home && releaseReview &&
      releaseCandidateMatchesReview(agent.id, home, releaseReview),
  );
  const promotionAllowed = Boolean(
    candidate?.canPromote && home?.actions.canPromoteCandidate,
  );
  return (
    <section className="neb-modal-pane active">
      <h2 className="neb-modal-h">Settings</h2>
      {error ? <p className="neb-error-note" role="alert">{error}</p> : null}
      <div className="neb-agent-identity">
        <div className="neb-ov-label identity-label">Identity</div>
        <input className="neb-edit-input" onChange={(event) => setName(event.currentTarget.value)} value={name} />
        <textarea className="neb-edit-textarea" onChange={(event) => setDescription(event.currentTarget.value)} rows={3} value={description} />
        <div className="neb-identity-actions">
          <button className="neb-btn-sm" disabled={!home || busy === "identity"} onClick={() => void saveIdentity()} type="button">Save identity</button>
        </div>
        <div className="neb-ov-row status-row-setting">
          <span className="neb-ov-row-key">Status</span>
          <span className="neb-status-control"><span className={`neb-ov-row-val${active ? " on" : ""}`}>{active ? "● Active" : "⏸ Paused"}</span><button className="neb-btn-sm" disabled={!live.data.agentRoutines || busy === "status"} onClick={() => void toggleAgent()} type="button">{active ? "Pause all" : "Resume"}</button></span>
        </div>
      </div>

      <Collapsible label="Rate limits">
        {capacity
          ? <><div className="neb-ov-row"><span className="neb-ov-row-key">Share of 5-hour pool</span><span className="neb-ov-row-val">{capacity.burst.shareUsedPercent === undefined ? capacity.burst.state : `${Math.round(capacity.burst.shareUsedPercent)}%`}</span></div><div className="neb-ov-row"><span className="neb-ov-row-key">Share of weekly pool</span><span className="neb-ov-row-val">{capacity.weekly.shareUsedPercent === undefined ? capacity.weekly.state : `${Math.round(capacity.weekly.shareUsedPercent)}%`}</span></div></>
          : <p className="neb-ov-note">Capacity is not available.</p>}
        {capacity?.capPercent !== null && capacity
          ? (
            <div className="neb-ov-row">
              <span className="neb-ov-row-key">Cap this Agent at</span>
              <span className="neb-limit-input-wrap"><input className="neb-limit-input" min="0.01" max="100" onChange={(event) => setCap(event.currentTarget.value)} step="0.01" type="number" value={cap} />%<button className="neb-btn-sm" disabled={busy === "capacity"} onClick={() => void saveCap()} type="button">Save</button></span>
            </div>
          )
          : <p className="neb-ov-note">Free capacity is fixed and intentionally qualitative.</p>}
        <p className="neb-ov-note">Lower the ceiling to reserve room for other Agents. Both five-hour and weekly windows enforce the same percentage.</p>
      </Collapsible>

      <Collapsible label="Connect">
        <div className="neb-ov-connect"><code>{endpoint}</code><CopyButton text={endpoint} /></div>
        <p className="neb-ov-note">Point any MCP client at this endpoint with an Agent-scoped Galactic key.</p>
      </Collapsible>

      <Collapsible
        label={`Release${(home?.release.candidateCount ?? 0) > 1 ? ` · ${home?.release.candidateCount} staged` : ""}`}
        initiallyOpen={Boolean(candidate)}
      >
        <div className="neb-release-block">
          <div className="neb-release-heading">Live</div>
          {liveRelease
            ? (
              <>
                <div className="neb-ov-row"><span className="neb-ov-row-key">Declared version</span><span className="neb-ov-row-val">{liveRelease.version}</span></div>
                {liveRelease.executedVersion && liveRelease.executedVersion !== liveRelease.version
                  ? <div className="neb-ov-row"><span className="neb-ov-row-key">Executing version</span><span className="neb-ov-row-val">{liveRelease.executedVersion}</span></div>
                  : null}
                <div className="neb-ov-row"><span className="neb-ov-row-key">Integrity</span><span className={`neb-ov-row-val${liveRelease.integrity === "verified" ? " on" : ""}`}>{liveRelease.integrity}</span></div>
                <p className="neb-ov-note">{liveRelease.promotedAt ? `Promoted ${formatRelativePast(liveRelease.promotedAt)}.` : "Promotion time unavailable."}</p>
              </>
            )
            : (
              <p className="neb-ov-note">
                {!home
                  ? live.data.agentHomeError
                    ? "Release state is unavailable. Refresh the Agent to try again."
                    : "Loading release state…"
                  : "No live version."}
              </p>
            )}
        </div>
        <div className="neb-release-block candidate">
          <div className="neb-release-heading">Latest candidate</div>
          {candidate
            ? (
              <>
                <div className="neb-ov-row"><span className="neb-ov-row-key">Exact-tested version</span><span className="neb-ov-row-val">{candidate.version}</span></div>
                {shortReleaseFingerprint(candidate.sourceFingerprint)
                  ? <div className="neb-ov-row"><span className="neb-ov-row-key">Source fingerprint</span><span className="neb-ov-row-val" title={candidate.sourceFingerprint ?? undefined}>{shortReleaseFingerprint(candidate.sourceFingerprint)}</span></div>
                  : null}
                <div className="neb-ov-row"><span className="neb-ov-row-key">Review</span><span className={`neb-release-status ${candidate.reviewStatus}`}>{releaseReviewLabel(candidate.reviewStatus)}</span></div>
                <p className="neb-ov-note">{candidate.testedAt ? `Tested ${formatRelativePast(candidate.testedAt)}.` : candidate.uploadedAt ? `Uploaded ${formatRelativePast(candidate.uploadedAt)}.` : "Upload time unavailable."}</p>
                {candidate.authorityChanges.length > 0
                  ? (
                    <div className="neb-release-changes" aria-label="Authority changes">
                      {candidate.authorityChanges.map((change) => (
                        <div className="neb-release-change" key={`${change.change}:${change.path}`}>
                          <span className={`neb-release-change-kind ${change.change}`}>{change.change}</span>
                          <span>{change.label}</span>
                        </div>
                      ))}
                    </div>
                  )
                  : <p className="neb-ov-note">No authority change from live.</p>}
                {releaseReviewActive
                  ? (
                    <div className="neb-release-confirm" role="group" aria-label="Confirm promotion">
                      <p>Make exact-tested version {candidate.version} live?</p>
                      <div className="neb-release-actions">
                        <button className="neb-btn-sm" disabled={!promotionAllowed || busy === "release"} onClick={() => void promoteCandidate()} type="button">{busy === "release" ? "Promoting…" : "Confirm promotion"}</button>
                        <button className="neb-btn-sm" disabled={busy === "release"} onClick={cancelPromotionReview} type="button">Cancel</button>
                      </div>
                    </div>
                  )
                  : <button className="neb-btn-sm neb-release-promote" disabled={!promotionAllowed || Boolean(busy)} onClick={() => {
                    if (!home) return;
                    setPromotionNotice("");
                    setReleaseReview(createReleaseCandidateReviewToken(agent.id, home));
                  }} type="button">Review &amp; promote</button>}
              </>
            )
            : home ? <p className="neb-ov-note">No staged candidate.</p> : null}
          {promotionNotice ? <p className="neb-release-success" role="status">{promotionNotice}</p> : null}
        </div>
      </Collapsible>

      <Collapsible label="Variables" initiallyOpen={false}>
        {(settings?.settings ?? []).map((setting) => (
          <div className="neb-ov-row" key={setting.key}><span className="neb-ov-row-key">{setting.key}</span><span className={`neb-ov-row-val${setting.configured ? " on" : ""}`}>{setting.configured ? "set" : setting.required ? "required" : "not set"}</span></div>
        ))}
        {settings && settings.settings.length === 0 ? <p className="neb-ov-note">This Agent declares no user variables.</p> : null}
        {!settings ? <p className="neb-ov-note">Variable presence is unavailable. Values are never returned here.</p> : null}
      </Collapsible>

      <Collapsible label="History" initiallyOpen={false}>
        {(home?.recentRuns ?? []).slice(0, 12).map((run) => (
          <div className="neb-history-item" key={run.id}>{run.summary ?? `${run.trigger} · ${run.status}`}<div className="neb-history-time">{formatRelative(run.createdAt)} · {run.workUnits} work units</div></div>
        ))}
        {home && home.recentRuns.length === 0 ? <p className="neb-ov-note">No runs yet.</p> : null}
      </Collapsible>
    </section>
  );
}
