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
  children: ReactNode;
  onBack: () => void;
  onPaneChange: (pane: AgentStudioPane) => void;
  pane: AgentStudioPane;
  releaseVersion: string | null;
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
  children,
  onBack,
  onPaneChange,
  pane,
  releaseVersion,
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
          <button
            aria-label="Close the Studio and return to your fleet"
            className="agent-studio-home"
            onClick={onBack}
            type="button"
          >
            Home
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

