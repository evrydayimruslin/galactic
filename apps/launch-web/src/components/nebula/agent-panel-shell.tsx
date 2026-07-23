import { Fragment, type ReactElement, type ReactNode } from "react";

import {
  AGENT_PANE_GROUP_LABELS,
  agentPaneLabel,
  agentPanesInGroup,
  DEFAULT_AGENT_PANE,
  type AgentPane,
  type AgentPaneGroup,
} from "../../lib/agent-pane-registry";

interface AgentPanelShellProps {
  agentName: string;
  children: ReactNode;
  onMobileBack: () => void;
  onPaneChange: (pane: AgentPane) => void;
  pane: AgentPane;
  showing: boolean;
  unread: number;
}

export function AgentPanelShell({
  agentName,
  children,
  onMobileBack,
  onPaneChange,
  pane,
  showing,
  unread,
}: AgentPanelShellProps): ReactElement {
  return (
    <section
      className={`neb-inline-panel neb-agent-panel railed${showing ? " showing-content" : ""}`}
      aria-label={agentName}
    >
      <AgentRail
        agentName={agentName}
        onPaneChange={onPaneChange}
        pane={pane}
        unread={unread}
      />
      <div className="neb-modal-content">
        <button
          className="neb-mobile-back"
          onClick={onMobileBack}
          type="button"
        >
          ‹ Menu
        </button>
        {children}
      </div>
    </section>
  );
}

export function AgentStructurePlaceholder(): ReactElement {
  return (
    <AgentPanelShell
      agentName="Loading Agent"
      onMobileBack={() => undefined}
      onPaneChange={() => undefined}
      pane={DEFAULT_AGENT_PANE}
      showing={false}
      unread={0}
    >
      <AgentPanePlaceholder pane={DEFAULT_AGENT_PANE} />
    </AgentPanelShell>
  );
}

export function AgentPanePlaceholder(
  { pane }: { pane: AgentPane },
): ReactElement {
  const label = agentPaneLabel(pane);
  return (
    <section className="neb-modal-pane active" aria-busy="true">
      <h2 className="neb-modal-h">{label}</h2>
      <div className="neb-pane-loading" aria-label={`Loading ${label}`}>
        <span /><span /><span />
      </div>
    </section>
  );
}

function AgentRail({
  agentName,
  onPaneChange,
  pane,
  unread,
}: {
  agentName: string;
  onPaneChange: (pane: AgentPane) => void;
  pane: AgentPane;
  unread: number;
}): ReactElement {
  const renderGroup = (group: AgentPaneGroup) => (
    <Fragment key={group}>
      <div className="neb-rail-group-label">
        {AGENT_PANE_GROUP_LABELS[group]}
      </div>
      {agentPanesInGroup(group).map((entry) => (
        <button
          className={`neb-rail-btn${pane === entry.id ? " active" : ""}`}
          key={entry.id}
          onClick={() => onPaneChange(entry.id)}
          type="button"
        >
          {entry.label}
          {entry.id === "alerts" && unread > 0
            ? <span className="neb-rail-count">{unread}</span>
            : null}
        </button>
      ))}
    </Fragment>
  );

  return (
    <nav
      className="neb-modal-rail agent-rail"
      aria-label={`${agentName} sections`}
    >
      {renderGroup("operate")}
      {renderGroup("manage")}
    </nav>
  );
}
