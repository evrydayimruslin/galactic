export const AGENT_PANE_REGISTRY = [
  {
    group: "operate",
    id: "overview",
    label: "Overview",
  },
  {
    group: "operate",
    id: "interfaces",
    label: "Interfaces",
  },
  {
    group: "operate",
    id: "alerts",
    label: "Alerts",
  },
  {
    group: "manage",
    id: "access",
    label: "Access",
  },
  {
    group: "manage",
    id: "routines",
    label: "Routines",
  },
  {
    group: "manage",
    id: "functions",
    label: "Functions",
  },
  {
    group: "manage",
    id: "compute",
    label: "Compute",
  },
  {
    group: "manage",
    id: "settings",
    label: "Settings",
  },
] as const;

export type AgentPane = typeof AGENT_PANE_REGISTRY[number]["id"];
export type AgentPaneGroup = typeof AGENT_PANE_REGISTRY[number]["group"];

export const DEFAULT_AGENT_PANE: AgentPane = "overview";

export const AGENT_PANE_GROUP_LABELS: Record<AgentPaneGroup, string> = {
  operate: "Operate",
  manage: "Manage",
};

const agentPaneIds = new Set<string>(
  AGENT_PANE_REGISTRY.map((pane) => pane.id),
);

export function isAgentPane(value: string | null | undefined): value is AgentPane {
  return Boolean(value && agentPaneIds.has(value));
}

export function agentPaneLabel(pane: AgentPane): string {
  return AGENT_PANE_REGISTRY.find((entry) => entry.id === pane)?.label ??
    AGENT_PANE_GROUP_LABELS.operate;
}

export function agentPanesInGroup(
  group: AgentPaneGroup,
): readonly typeof AGENT_PANE_REGISTRY[number][] {
  return AGENT_PANE_REGISTRY.filter((pane) => pane.group === group);
}
