import {
  DEFAULT_AGENT_PANE,
  isAgentPane,
  type AgentPane,
} from "./agent-pane-registry";

export interface AgentRouteLocation {
  pathname: string;
  search: string;
}

export interface AgentRouteState {
  item?: string;
  pane: AgentPane;
  slug: string;
}

export interface AgentRouteStateUpdate {
  item?: string | null;
  pane?: AgentPane;
}

export function parseAgentRouteState(
  location: AgentRouteLocation,
): AgentRouteState | null {
  const slug = agentSlugFromPathname(location.pathname);
  if (!slug) return null;

  const search = new URLSearchParams(location.search);
  const requestedPane = search.get("pane");
  const item = normalizedQueryValue(search.get("item"));

  return {
    ...(item ? { item } : {}),
    pane: isAgentPane(requestedPane) ? requestedPane : DEFAULT_AGENT_PANE,
    slug,
  };
}

export function serializeAgentRouteState(
  state: AgentRouteState,
  search = "",
): string {
  const params = new URLSearchParams(search);
  if (state.pane === DEFAULT_AGENT_PANE) {
    params.delete("pane");
  } else {
    params.set("pane", state.pane);
  }

  const item = normalizedQueryValue(state.item);
  if (item) {
    params.set("item", item);
  } else {
    params.delete("item");
  }

  const query = params.toString();
  const pathname = `/agents/${encodeURIComponent(state.slug)}`;
  return query ? `${pathname}?${query}` : pathname;
}

export function updateAgentRouteState(
  location: AgentRouteLocation,
  update: AgentRouteStateUpdate,
): string | null {
  const current = parseAgentRouteState(location);
  if (!current) return null;

  const pane = update.pane ?? current.pane;
  const paneChanged = update.pane !== undefined && update.pane !== current.pane;
  const item = Object.prototype.hasOwnProperty.call(update, "item")
    ? normalizedQueryValue(update.item)
    : paneChanged
    ? undefined
    : current.item;

  return serializeAgentRouteState(
    {
      ...(item ? { item } : {}),
      pane,
      slug: current.slug,
    },
    location.search,
  );
}

function agentSlugFromPathname(pathname: string): string | null {
  const normalized = pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
  const match = /^\/agents\/([^/]+)$/u.exec(normalized);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function normalizedQueryValue(
  value: string | null | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
