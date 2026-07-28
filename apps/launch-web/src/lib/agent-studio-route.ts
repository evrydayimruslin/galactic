export type AgentStudioPaneGroup = "watch" | "teach" | "grant" | "settings";

export type AgentStudioPaneAvailability =
  | "ready"
  | "partial"
  | "requires_contract";

export const AGENT_STUDIO_PANE_REGISTRY = [
  {
    availability: "ready",
    group: "watch",
    id: "overview",
    label: "Overview",
  },
  {
    availability: "ready",
    group: "watch",
    id: "interfaces",
    label: "Interfaces",
  },
  {
    availability: "requires_contract",
    group: "watch",
    id: "approvals",
    label: "Approvals",
  },
  {
    availability: "partial",
    group: "watch",
    id: "activity",
    label: "Activity",
  },
  {
    availability: "ready",
    group: "watch",
    id: "alerts",
    label: "Alerts",
  },
  {
    availability: "partial",
    group: "teach",
    id: "directive",
    label: "Directive",
  },
  {
    availability: "ready",
    group: "teach",
    id: "routines",
    label: "Routines",
  },
  {
    availability: "requires_contract",
    group: "teach",
    id: "knowledge",
    label: "Knowledge",
  },
  {
    availability: "partial",
    group: "grant",
    id: "capabilities",
    label: "Capabilities",
  },
  {
    availability: "ready",
    group: "grant",
    id: "connections",
    label: "Connections",
  },
  {
    availability: "ready",
    group: "grant",
    id: "compute",
    label: "Compute",
  },
  {
    availability: "partial",
    group: "grant",
    id: "limits",
    label: "Limits",
  },
  {
    availability: "partial",
    group: "settings",
    id: "settings",
    label: "Settings",
  },
] as const satisfies readonly {
  availability: AgentStudioPaneAvailability;
  group: AgentStudioPaneGroup;
  id: string;
  label: string;
}[];

export type AgentStudioPane =
  typeof AGENT_STUDIO_PANE_REGISTRY[number]["id"];

export interface AgentStudioRouteState {
  item?: string;
  pane: AgentStudioPane;
}

export const DEFAULT_AGENT_STUDIO_PANE: AgentStudioPane = "overview";

export const AGENT_STUDIO_GROUP_COPY: Record<
  Exclude<AgentStudioPaneGroup, "settings">,
  { label: string; gloss: string }
> = {
  watch: {
    label: "Watch",
    gloss: "What it has been doing, and what it is waiting on.",
  },
  teach: {
    label: "Teach",
    gloss: "What it knows and when it wakes.",
  },
  grant: {
    label: "Grant",
    gloss: "What it is allowed to reach.",
  },
};

const paneIds = new Set<string>(
  AGENT_STUDIO_PANE_REGISTRY.map((pane) => pane.id),
);

const legacyPaneAliases: Readonly<Record<string, AgentStudioPane>> = {
  access: "connections",
  functions: "capabilities",
};

export function isAgentStudioPane(
  value: string | null | undefined,
): value is AgentStudioPane {
  return Boolean(value && paneIds.has(value));
}

export function normalizeAgentStudioPane(
  value: string | null | undefined,
): AgentStudioPane | null {
  if (isAgentStudioPane(value)) return value;
  return value ? legacyPaneAliases[value] ?? null : null;
}

export function parseAgentStudioRouteState(
  searchValue: string,
): AgentStudioRouteState {
  const search = new URLSearchParams(searchValue);
  const requestedPane = search.get("pane");
  const requestedItem = normalizedQueryValue(search.get("item"));
  const legacyActivity = (
    requestedPane === null || requestedPane === "overview"
  ) && requestedItem === "activity";
  const legacyOverviewInterface = (
      requestedPane === null || requestedPane === "overview"
    ) &&
    Boolean(requestedItem?.startsWith("interface:")) &&
    requestedItem !== "interface:";
  const legacyLimits = requestedPane === "settings" &&
    requestedItem === "rate-limits";
  const pane = legacyActivity
    ? "activity"
    : legacyOverviewInterface
    ? "interfaces"
    : legacyLimits
    ? "limits"
    : normalizeAgentStudioPane(requestedPane) ?? DEFAULT_AGENT_STUDIO_PANE;
  const item = legacyOverviewInterface
    ? requestedItem?.slice("interface:".length)
    : legacyActivity || legacyLimits
    ? undefined
    : requestedItem;
  return {
    ...(item ? { item } : {}),
    pane,
  };
}

export function updateAgentStudioRoute(
  pathname: string,
  searchValue: string,
  update: {
    item?: string | null;
    pane?: AgentStudioPane;
  },
): string {
  const current = parseAgentStudioRouteState(searchValue);
  const search = new URLSearchParams(searchValue);
  const pane = update.pane ?? current.pane;
  const paneChanged = update.pane !== undefined &&
    update.pane !== current.pane;
  const item = Object.prototype.hasOwnProperty.call(update, "item")
    ? normalizedQueryValue(update.item)
    : paneChanged
    ? undefined
    : current.item;

  if (pane === DEFAULT_AGENT_STUDIO_PANE) {
    search.delete("pane");
  } else {
    search.set("pane", pane);
  }
  if (item) {
    search.set("item", item);
  } else {
    search.delete("item");
  }

  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function normalizedQueryValue(
  value: string | null | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
