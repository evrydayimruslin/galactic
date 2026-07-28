import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type {
  LaunchAgentSummary,
  LaunchInterfaceSummary,
} from "../../../../../shared/contracts/launch.ts";
import {
  getLaunchAuthToken,
  hasLaunchAuthToken,
  launchAuthSubject,
} from "../../lib/auth";
import {
  attachInterfaceBridge,
  clampInterfaceHeight,
  runInterfaceFunctionDurably,
} from "../../lib/interface-bridge";
import { runInterfaceCallWithCache } from "../../lib/interface-read-cache";
import {
  interfacePrefetches,
  interfaceReadModel,
} from "../../lib/interface-read-models";
import {
  scheduleInterfaceWarmup,
  warmInterfaceDocument,
} from "../../lib/interface-warmup";
import { launchApi } from "../../lib/api";
import { StudioPageHeader } from "./agent-studio-overview";

import "./agent-studio-interfaces.css";

export interface AgentStudioInterfacesProps {
  agent: Pick<LaunchAgentSummary, "id" | "slug" | "name">;
  favoriteInterfaceIds: readonly string[];
  interfaces: readonly LaunchInterfaceSummary[];
  itemId?: string | null;
  onAddInterface: () => void;
  onItemChange: (interfaceId: string | null) => void;
  onShareInterface?: (iface: LaunchInterfaceSummary) => void;
  onToggleFavorite: (interfaceId: string) => void;
}

/**
 * Studio-native Interface management. All operational labels come from the
 * live release declaration; sharing remains unavailable until the owner
 * contract can describe who may receive an Interface.
 */
export function AgentStudioInterfaces({
  agent,
  favoriteInterfaceIds,
  interfaces,
  itemId,
  onAddInterface,
  onItemChange,
  onShareInterface,
  onToggleFavorite,
}: AgentStudioInterfacesProps): ReactElement {
  const favoriteIds = new Set(favoriteInterfaceIds);
  const selected = itemId
    ? interfaces.find((iface) => iface.id === itemId) ?? null
    : null;
  const selectedDeclarationKey = selected
    ? interfaceDeclarationKey(selected)
    : null;

  useWarmInterfaceReadModels(agent, interfaces);
  useEffect(
    () => scheduleInterfaceWarmup(interfaces.map((iface) => iface.url)),
    [interfaces],
  );
  useEffect(() => {
    if (selected) warmInterfaceDocument(selected.url);
  }, [selected?.id, selected?.url]);

  return (
    <section className="agent-studio-screen agent-studio-interfaces">
      <StudioPageHeader
        description={`The screens ${agent.name} gives you to work with it. Each one is purpose-built for a single job — reviewing, reading, or teaching — and obeys the same capabilities the Agent itself has.`}
        title="Interfaces"
      />

      <button
        className="agent-studio-interface-add"
        onClick={onAddInterface}
        type="button"
      >
        + Add interface
      </button>

      {interfaces.length > 0
        ? (
          <div
            aria-label={`${agent.name} Interfaces`}
            className="agent-studio-interface-list"
          >
            {interfaces.map((iface) => {
              const favorite = favoriteIds.has(iface.id);
              return (
                <article
                  className="agent-studio-interface-row"
                  key={iface.id}
                >
                  <button
                    aria-label={`${favorite ? "Unpin" : "Pin"} ${
                      iface.label
                    } ${favorite ? "from" : "to"} Overview`}
                    aria-pressed={favorite}
                    className={`agent-studio-interface-pin${
                      favorite ? " active" : ""
                    }`}
                    onClick={() => onToggleFavorite(iface.id)}
                    title={favorite
                      ? "Remove from Overview"
                      : "Pin to Overview"}
                    type="button"
                  >
                    <StarIcon filled={favorite} />
                  </button>

                  <button
                    className="agent-studio-interface-summary"
                    onClick={() => onItemChange(iface.id)}
                    onFocus={() => warmInterfaceDocument(iface.url)}
                    onPointerEnter={() => warmInterfaceDocument(iface.url)}
                    type="button"
                  >
                    <span className="agent-studio-interface-title-line">
                      <strong>{iface.label}</strong>
                      <em>{interfaceFunctionLabel(iface)}</em>
                    </span>
                    <span className="agent-studio-interface-description">
                      {iface.description ??
                        "A purpose-built screen declared by this Agent’s live release."}
                    </span>
                    <span className="agent-studio-interface-meta">
                      {interfaceReleaseLabel(iface)}
                    </span>
                  </button>

                  <div className="agent-studio-interface-actions">
                    <button
                      className="primary"
                      onClick={() => onItemChange(iface.id)}
                      onFocus={() => warmInterfaceDocument(iface.url)}
                      onPointerEnter={() => warmInterfaceDocument(iface.url)}
                      type="button"
                    >
                      Open
                    </button>
                    <button
                      aria-label={onShareInterface
                        ? `Share ${iface.label}`
                        : `Share ${iface.label} — unavailable`}
                      disabled={!onShareInterface}
                      onClick={() => onShareInterface?.(iface)}
                      title={onShareInterface
                        ? `Share ${iface.label}`
                        : "Sharing is not available for this Agent yet."}
                      type="button"
                    >
                      Share
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )
        : (
          <div className="agent-studio-interface-empty">
            <span aria-hidden="true">◇</span>
            <strong>No interfaces have been published yet.</strong>
            <p>
              Add the first purpose-built screen to this Agent’s next release.
              Nothing can open here until that immutable artifact is live.
            </p>
            <button onClick={onAddInterface} type="button">
              Write the request
            </button>
          </div>
        )}

      {itemId && !selected
        ? (
          <div className="agent-studio-interface-stale" role="status">
            <strong>This Interface is no longer in the live release.</strong>
            <p>
              Its old deep link is safe to keep, but Galactic will not open an
              artifact that the Agent no longer declares.
            </p>
            <button onClick={() => onItemChange(null)} type="button">
              Return to Interfaces
            </button>
          </div>
        )
        : null}

      <p className="agent-studio-interface-note">
        Interfaces are declared in the release manifest alongside the
        functions they use —{" "}
        <button onClick={onAddInterface} type="button">
          Add interface
        </button>{" "}
        writes the request for your coding agent rather than building one
        here. A pinned interface sits on Overview.
      </p>

      {selected
        ? (
          <AgentStudioInterfaceViewer
            agent={agent}
            iface={selected}
            key={`${agent.id}:${selectedDeclarationKey}`}
            onClose={() => onItemChange(null)}
          />
        )
        : null}
    </section>
  );
}

export function interfaceFunctionLabel(iface: LaunchInterfaceSummary): string {
  return `${iface.functions.length} function${
    iface.functions.length === 1 ? "" : "s"
  }`;
}

export function interfaceReleaseLabel(iface: LaunchInterfaceSummary): string {
  return iface.releaseVersion
    ? `Published with ${
      iface.releaseVersion.startsWith("v")
        ? iface.releaseVersion
        : `v${iface.releaseVersion}`
    }`
    : "Published in the live release";
}

/**
 * Identity of the executable declaration rather than its mutable display copy.
 * A release may reuse the same HTML artifact while changing its allowlist,
 * read-model authority, or sizing contract, so artifactHash alone is not a
 * sufficient React/bridge lifetime key.
 */
export function interfaceDeclarationKey(
  iface: LaunchInterfaceSummary,
): string {
  return canonicalInterfaceKey([
    iface.id,
    iface.url,
    iface.artifactHash ?? null,
    iface.releaseVersion ?? null,
    iface.minHeight ?? null,
    [...iface.functions].sort(),
    [...(iface.readModels ?? [])]
      .sort((left, right) =>
        left.functionName.localeCompare(right.functionName)
      )
      .map((model) => ({
        freshForMs: model.freshForMs,
        functionName: model.functionName,
        prefetchArgs: model.prefetchArgs,
        staleForMs: model.staleForMs,
      })),
  ]);
}

function canonicalInterfaceKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalInterfaceKey).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${
      Object.keys(record)
        .sort()
        .map((key) =>
          `${JSON.stringify(key)}:${canonicalInterfaceKey(record[key])}`
        )
        .join(",")
    }}`;
  }
  return JSON.stringify(value) ?? "null";
}

const INTERFACE_LEFT_GAP = 12;
const INTERFACE_TOP_CLEARANCE = 30;
const INTERFACE_RIGHT_CLEARANCE = 28;
const INTERFACE_BOTTOM_CLEARANCE = 28;
const INTERFACE_COMPACT_BREAKPOINT = 720;
const INTERFACE_CONNECT_TIMEOUT_MS = 10_000;

type InterfaceConnectionState = "connecting" | "ready" | "timed_out";

interface InterfaceFrame {
  height: number;
  left: number;
  top: number;
  width: number;
}

function initialInterfaceFrame(iface: LaunchInterfaceSummary): InterfaceFrame {
  const viewportWidth = typeof window === "undefined" ? 1200 : window.innerWidth;
  const viewportHeight = typeof window === "undefined"
    ? 800
    : window.innerHeight;
  const width = Math.max(
    1,
    viewportWidth - INTERFACE_LEFT_GAP - INTERFACE_RIGHT_CLEARANCE,
  );
  const height = Math.min(
    Math.max(
      1,
      viewportHeight - INTERFACE_TOP_CLEARANCE -
        INTERFACE_BOTTOM_CLEARANCE,
    ),
    clampInterfaceHeight(iface.minHeight ?? 560),
  );
  return {
    height,
    left: INTERFACE_LEFT_GAP,
    top: Math.max(
      INTERFACE_TOP_CLEARANCE,
      (viewportHeight - height) / 2,
    ),
    width,
  };
}

function AgentStudioInterfaceViewer({
  agent,
  iface,
  onClose,
}: {
  agent: Pick<LaunchAgentSummary, "id" | "slug" | "name">;
  iface: LaunchInterfaceSummary;
  onClose: () => void;
}): ReactElement | null {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const manuallyResized = useRef(false);
  const dragStart = useRef<PointerStart | null>(null);
  const resizeStart = useRef<ResizeStart | null>(null);
  const connectionTimer = useRef<number | null>(null);
  const declarationKey = interfaceDeclarationKey(iface);
  const [connectionState, setConnectionState] =
    useState<InterfaceConnectionState>("connecting");
  const [compactViewport, setCompactViewport] = useState(() =>
    typeof window !== "undefined" &&
    window.innerWidth <= INTERFACE_COMPACT_BREAKPOINT
  );
  const [frame, setFrame] = useState(() => initialInterfaceFrame(iface));
  closeRef.current = onClose;

  const clearConnectionTimer = useCallback(() => {
    if (connectionTimer.current === null || typeof window === "undefined") {
      return;
    }
    window.clearTimeout(connectionTimer.current);
    connectionTimer.current = null;
  }, []);
  const beginConnecting = useCallback(() => {
    if (typeof window === "undefined") return;
    clearConnectionTimer();
    setConnectionState("connecting");
    connectionTimer.current = window.setTimeout(() => {
      connectionTimer.current = null;
      setConnectionState((current) =>
        current === "ready" ? current : "timed_out"
      );
    }, INTERFACE_CONNECT_TIMEOUT_MS);
  }, [clearConnectionTimer]);
  const markConnected = useCallback(() => {
    clearConnectionTimer();
    setConnectionState("ready");
  }, [clearConnectionTimer]);

  const applyInterfaceHeight = useCallback((requestedHeight: number) => {
    if (manuallyResized.current || typeof window === "undefined") return;
    const height = Math.min(
      Math.max(
        1,
        window.innerHeight - INTERFACE_TOP_CLEARANCE -
          INTERFACE_BOTTOM_CLEARANCE,
      ),
      clampInterfaceHeight(requestedHeight),
    );
    setFrame((current) => ({
      ...current,
      height,
      top: Math.max(
        INTERFACE_TOP_CLEARANCE,
        (window.innerHeight - height) / 2,
      ),
    }));
  }, []);

  useLayoutEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    beginConnecting();
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
          args,
          artifactHash: iface.artifactHash,
          functionName,
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
      onClose: () => closeRef.current(),
      onConnected: markConnected,
      onResize: applyInterfaceHeight,
    });
    return () => {
      clearConnectionTimer();
      controller.abort();
      detach();
    };
  }, [
    agent.id,
    agent.name,
    agent.slug,
    applyInterfaceHeight,
    beginConnecting,
    clearConnectionTimer,
    declarationKey,
    markConnected,
  ]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), iframe, [tabindex]:not([tabindex='-1'])",
        ) ?? [],
      ).filter((item) => item.offsetParent !== null);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    const focusTimer = window.setTimeout(() => {
      modalRef.current?.querySelector<HTMLButtonElement>(
        ".agent-studio-interface-close",
      )?.focus();
    }, 0);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const fitToViewport = () => {
      setCompactViewport(
        window.innerWidth <= INTERFACE_COMPACT_BREAKPOINT,
      );
      setFrame((current) => fitInterfaceFrame(current));
    };
    window.addEventListener("resize", fitToViewport);
    return () => window.removeEventListener("resize", fitToViewport);
  }, []);

  const moveFrame = (nextLeft: number, nextTop: number) => {
    if (typeof window === "undefined") return;
    setFrame((current) => ({
      ...current,
      left: Math.max(
        INTERFACE_LEFT_GAP,
        Math.min(
          nextLeft,
          window.innerWidth - current.width - INTERFACE_RIGHT_CLEARANCE,
        ),
      ),
      top: Math.max(
        INTERFACE_TOP_CLEARANCE,
        Math.min(
          nextTop,
          window.innerHeight - current.height -
            INTERFACE_BOTTOM_CLEARANCE,
        ),
      ),
    }));
  };
  const resizeFrame = (nextWidth: number, nextHeight: number) => {
    if (typeof window === "undefined") return;
    setFrame((current) => {
      const maxWidth = Math.max(
        1,
        window.innerWidth - current.left - INTERFACE_RIGHT_CLEARANCE,
      );
      const maxHeight = Math.max(
        1,
        window.innerHeight - current.top - INTERFACE_BOTTOM_CLEARANCE,
      );
      return {
        ...current,
        width: Math.min(maxWidth, Math.max(Math.min(320, maxWidth), nextWidth)),
        height: Math.min(
          maxHeight,
          Math.max(Math.min(180, maxHeight), nextHeight),
        ),
      };
    });
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <InterfaceDialog
      agentName={agent.name}
      compactViewport={compactViewport}
      connectionState={connectionState}
      frame={frame}
      iface={iface}
      modalRef={modalRef}
      onClose={onClose}
      onDrag={(event, phase) => {
        if (phase === "start") {
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
          return;
        }
        const start = dragStart.current;
        if (!start || start.pointerId !== event.pointerId) return;
        if (phase === "move") {
          moveFrame(
            start.left + event.clientX - start.x,
            start.top + event.clientY - start.y,
          );
          return;
        }
        dragStart.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onMove={moveFrame}
      onResize={(event, phase) => {
        if (phase === "start") {
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
          return;
        }
        const start = resizeStart.current;
        if (!start || start.pointerId !== event.pointerId) return;
        if (phase === "move") {
          resizeFrame(
            start.width + event.clientX - start.x,
            start.height + event.clientY - start.y,
          );
          return;
        }
        resizeStart.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onResizeBy={resizeFrame}
      onReload={() => {
        beginConnecting();
        if (iframeRef.current) iframeRef.current.src = iface.url;
      }}
      iframeRef={iframeRef}
    />,
    document.body,
  );
}

interface PointerStart {
  left: number;
  pointerId: number;
  top: number;
  x: number;
  y: number;
}

interface ResizeStart {
  height: number;
  pointerId: number;
  width: number;
  x: number;
  y: number;
}

type PointerPhase = "start" | "move" | "end";

function InterfaceDialog({
  agentName,
  compactViewport,
  connectionState,
  frame,
  iface,
  iframeRef,
  modalRef,
  onClose,
  onDrag,
  onMove,
  onResize,
  onResizeBy,
  onReload,
}: {
  agentName: string;
  compactViewport: boolean;
  connectionState: InterfaceConnectionState;
  frame: InterfaceFrame;
  iface: LaunchInterfaceSummary;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  modalRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onDrag: (
    event: ReactPointerEvent<HTMLButtonElement>,
    phase: PointerPhase,
  ) => void;
  onMove: (left: number, top: number) => void;
  onResize: (
    event: ReactPointerEvent<HTMLButtonElement>,
    phase: PointerPhase,
  ) => void;
  onResizeBy: (width: number, height: number) => void;
  onReload: () => void;
}): ReactElement {
  const label = `${agentName} — ${iface.label}`;
  const ready = connectionState === "ready";
  const style: CSSProperties = {
    height: frame.height,
    left: frame.left,
    top: frame.top,
    width: frame.width,
  };
  return (
    <div
      className="agent-studio-interface-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-label={label}
        aria-modal="true"
        className="agent-studio-interface-dialog"
        ref={modalRef}
        role="dialog"
        style={style}
      >
        <button
          aria-label="Move Interface"
          className="agent-studio-interface-drag"
          disabled={compactViewport}
          onKeyDown={(event) => {
            const amount = event.shiftKey ? 48 : 16;
            if (event.key === "ArrowLeft") {
              onMove(frame.left - amount, frame.top);
            } else if (event.key === "ArrowRight") {
              onMove(frame.left + amount, frame.top);
            } else if (event.key === "ArrowUp") {
              onMove(frame.left, frame.top - amount);
            } else if (event.key === "ArrowDown") {
              onMove(frame.left, frame.top + amount);
            } else return;
            event.preventDefault();
          }}
          onPointerCancel={(event) => onDrag(event, "end")}
          onPointerDown={(event) => onDrag(event, "start")}
          onPointerMove={(event) => onDrag(event, "move")}
          onPointerUp={(event) => onDrag(event, "end")}
          title="Drag to move"
          type="button"
        >
          <span>{iface.label}</span>
        </button>
        <button
          aria-label={`Close ${iface.label}`}
          className="agent-studio-interface-close"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
        <div
          aria-busy={connectionState === "connecting"}
          className={`agent-studio-interface-frame-wrap${
            ready ? " ready" : ""
          }`}
        >
          {connectionState === "timed_out"
            ? (
              <div
                aria-live="polite"
                className="agent-studio-interface-boot timed-out"
                role="status"
              >
                <span aria-hidden="true"><i /></span>
                <strong>{iface.label} did not connect.</strong>
                <p>
                  Reload it to retry the private Galactic bridge.
                </p>
                <button onClick={onReload} type="button">Reload</button>
              </div>
            )
            : (
              <div className="agent-studio-interface-boot" aria-hidden="true">
                <span><i /></span>
                <strong>Opening {iface.label}</strong>
                <em><i /></em>
              </div>
            )}
          <iframe
            aria-hidden={!ready}
            className="agent-studio-interface-frame"
            loading="eager"
            ref={iframeRef}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-forms"
            src={iface.url}
            tabIndex={ready ? 0 : -1}
            title={label}
          />
        </div>
        <button
          aria-label="Resize Interface"
          className="agent-studio-interface-resize"
          onKeyDown={(event) => {
            const amount = event.shiftKey ? 48 : 16;
            if (event.key === "ArrowLeft") {
              onResizeBy(frame.width - amount, frame.height);
            } else if (event.key === "ArrowRight") {
              onResizeBy(frame.width + amount, frame.height);
            } else if (event.key === "ArrowUp") {
              onResizeBy(frame.width, frame.height - amount);
            } else if (event.key === "ArrowDown") {
              onResizeBy(frame.width, frame.height + amount);
            } else return;
            event.preventDefault();
          }}
          onPointerCancel={(event) => onResize(event, "end")}
          onPointerDown={(event) => onResize(event, "start")}
          onPointerMove={(event) => onResize(event, "move")}
          onPointerUp={(event) => onResize(event, "end")}
          title="Drag to resize"
          type="button"
        />
      </div>
    </div>
  );
}

function fitInterfaceFrame(current: InterfaceFrame): InterfaceFrame {
  const maxWidth = Math.max(
    1,
    window.innerWidth - INTERFACE_LEFT_GAP - INTERFACE_RIGHT_CLEARANCE,
  );
  const maxHeight = Math.max(
    1,
    window.innerHeight - INTERFACE_TOP_CLEARANCE -
      INTERFACE_BOTTOM_CLEARANCE,
  );
  const width = Math.min(current.width, maxWidth);
  const height = Math.min(current.height, maxHeight);
  return {
    width,
    height,
    left: Math.max(
      INTERFACE_LEFT_GAP,
      Math.min(
        current.left,
        window.innerWidth - width - INTERFACE_RIGHT_CLEARANCE,
      ),
    ),
    top: Math.max(
      INTERFACE_TOP_CLEARANCE,
      Math.min(
        current.top,
        window.innerHeight - height - INTERFACE_BOTTOM_CLEARANCE,
      ),
    ),
  };
}

function useWarmInterfaceReadModels(
  agent: Pick<LaunchAgentSummary, "id">,
  interfaces: readonly LaunchInterfaceSummary[],
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

function StarIcon({ filled }: { filled: boolean }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
      height="14"
      viewBox="0 0 24 24"
      width="14"
    >
      <path
        d="m12 3.5 2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}
