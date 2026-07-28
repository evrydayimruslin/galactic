import {
  Fragment,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  AGENT_STUDIO_GROUP_COPY,
  AGENT_STUDIO_PANE_REGISTRY,
  type AgentStudioPane,
  type AgentStudioPaneGroup,
} from "../../lib/agent-studio-route";

export type AgentStudioTheme = "light" | "dark";

interface AgentStudioShellProps {
  agentName: string;
  badges?: Partial<Record<AgentStudioPane, number>>;
  canRunNow: boolean;
  children: ReactNode;
  onBack: () => void;
  onPaneChange: (pane: AgentStudioPane) => void;
  onRunNow: () => void;
  onThemeChange: (theme: AgentStudioTheme) => void;
  pane: AgentStudioPane;
  releaseVersion: string | null;
  runBusy: boolean;
  statusLabel: string;
  statusTone: "live" | "waiting" | "stopped";
  theme: AgentStudioTheme;
}

const primaryGroups: readonly Exclude<AgentStudioPaneGroup, "settings">[] = [
  "watch",
  "teach",
  "grant",
];

export function AgentStudioShell({
  agentName,
  badges = {},
  canRunNow,
  children,
  onBack,
  onPaneChange,
  onRunNow,
  onThemeChange,
  pane,
  releaseVersion,
  runBusy,
  statusLabel,
  statusTone,
  theme,
}: AgentStudioShellProps): ReactElement {
  const [railOpen, setRailOpen] = useState(false);
  const railRef = useRef<HTMLElement>(null);
  const selectPane = (next: AgentStudioPane) => {
    onPaneChange(next);
    setRailOpen(false);
  };
  useEffect(() => {
    if (!railOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      [...(railRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [tabindex="0"]',
      ) ?? [])];
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setRailOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = focusable();
      if (candidates.length === 0) return;
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = priorOverflow;
      previousFocus?.focus();
    };
  }, [railOpen]);

  return (
    <div className="agent-studio" data-theme={theme}>
      <StudioMotif />
      <header className="agent-studio-header">
        <div className="agent-studio-identity">
          <button
            className="agent-studio-wordmark"
            onClick={onBack}
            type="button"
          >
            galactic
          </button>
          <span className="agent-studio-slash" aria-hidden="true">/</span>
          <span className="agent-studio-agent-name">{agentName}</span>
          {releaseVersion
            ? (
              <span className="agent-studio-release">
                {releaseVersion.startsWith("v")
                  ? releaseVersion
                  : `v${releaseVersion}`}
              </span>
            )
            : null}
          <span className={`agent-studio-status ${statusTone}`}>
            <span aria-hidden="true" />
            {statusLabel}
          </span>
        </div>
        <div className="agent-studio-header-actions">
          <div
            aria-label="Studio theme"
            className="agent-studio-segmented"
            role="group"
          >
            {(["light", "dark"] as const).map((option) => (
              <button
                aria-pressed={theme === option}
                key={option}
                onClick={() => onThemeChange(option)}
                type="button"
              >
                {option[0].toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>
          <button
            className="agent-studio-run"
            disabled={!canRunNow || runBusy}
            onClick={onRunNow}
            type="button"
          >
            {runBusy ? "Starting…" : "Run now"}
          </button>
          <button
            aria-label="Open Agent settings"
            className="agent-studio-settings-button"
            onClick={() => selectPane("settings")}
            type="button"
          >
            <StudioSettingsGlyph />
          </button>
          <button
            aria-controls="agent-studio-navigation"
            aria-expanded={railOpen}
            aria-label="Toggle Agent Studio navigation"
            className="agent-studio-menu-button"
            onClick={() => setRailOpen((open) => !open)}
            type="button"
          >
            <span /><span /><span />
          </button>
        </div>
      </header>
      <div className="agent-studio-body">
        {railOpen
          ? (
            <button
              aria-label="Close Agent Studio navigation"
              className="agent-studio-rail-backdrop"
              onClick={() => setRailOpen(false)}
              type="button"
            />
          )
          : null}
        <nav
          aria-label={`${agentName} Studio sections`}
          className={`agent-studio-rail${railOpen ? " open" : ""}`}
          id="agent-studio-navigation"
          ref={railRef}
        >
          <div className="agent-studio-rail-mobile-meta">
            <div>
              {releaseVersion
                ? (
                  <span className="agent-studio-release">
                    {releaseVersion.startsWith("v")
                      ? releaseVersion
                      : `v${releaseVersion}`}
                  </span>
                )
                : null}
              <span className={`agent-studio-status ${statusTone}`}>
                <span aria-hidden="true" />
                {statusLabel}
              </span>
            </div>
            <div
              aria-label="Studio theme"
              className="agent-studio-segmented"
              role="group"
            >
              {(["light", "dark"] as const).map((option) => (
                <button
                  aria-pressed={theme === option}
                  key={option}
                  onClick={() => onThemeChange(option)}
                  type="button"
                >
                  {option[0].toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>
          </div>
          {primaryGroups.map((group) => (
            <Fragment key={group}>
              <RailGroupHeader group={group} />
              <div className="agent-studio-rail-items">
                {AGENT_STUDIO_PANE_REGISTRY
                  .filter((entry) => entry.group === group)
                  .map((entry) => (
                    <button
                      aria-current={pane === entry.id ? "page" : undefined}
                      className={pane === entry.id ? "active" : ""}
                      key={entry.id}
                      onClick={() => selectPane(entry.id)}
                      type="button"
                    >
                      <span>{entry.label}</span>
                      {(badges[entry.id] ?? 0) > 0
                        ? (
                          <span className="agent-studio-rail-badge">
                            {badges[entry.id]}
                          </span>
                        )
                        : null}
                    </button>
                  ))}
              </div>
            </Fragment>
          ))}
          <div className="agent-studio-rail-settings">
            <button
              aria-current={pane === "settings" ? "page" : undefined}
              className={pane === "settings" ? "active" : ""}
              onClick={() => selectPane("settings")}
              type="button"
            >
              Settings
            </button>
          </div>
        </nav>
        <main
          aria-hidden={railOpen || undefined}
          className="agent-studio-content"
          inert={railOpen || undefined}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

function RailGroupHeader({
  group,
}: {
  group: Exclude<AgentStudioPaneGroup, "settings">;
}): ReactElement {
  const copy = AGENT_STUDIO_GROUP_COPY[group];
  const tooltipId = `agent-studio-${group}-description`;
  return (
    <div className="agent-studio-rail-group">
      <span>{copy.label}</span>
      <button
        aria-describedby={tooltipId}
        aria-label={`About ${copy.label}`}
        className="agent-studio-rail-info"
        type="button"
      >
        i
        <span id={tooltipId} role="tooltip">{copy.gloss}</span>
      </button>
    </div>
  );
}

function StudioMotif(): ReactElement {
  return (
    <div className="agent-studio-motif" aria-hidden="true">
      <div />
      <svg viewBox="0 0 980 980" fill="none">
        <circle cx="576" cy="404" r="258.6" />
        <circle cx="352" cy="490" r="258.6" />
        <circle cx="500" cy="674" r="258.6" />
        <circle cx="576" cy="404" r="260" />
        <circle cx="352" cy="490" r="260" />
        <circle cx="500" cy="674" r="260" />
      </svg>
    </div>
  );
}

function StudioSettingsGlyph(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      width="16"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0V21a1.7 1.7 0 0 0-3-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 14.2h-.2a2 2 0 1 1 0-4H3a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </svg>
  );
}
