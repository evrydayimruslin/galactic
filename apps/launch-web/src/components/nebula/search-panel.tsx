import {
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  LaunchAgentPane,
  LaunchAgentSearchResponse,
  LaunchAgentSearchResult,
  LaunchAgentSearchSubjectKind,
  LaunchFleetAgentSummary,
} from "../../../../../shared/contracts/launch.ts";
import { launchApi } from "../../lib/api";
import {
  hasLaunchAuthToken,
  isLaunchRefreshAvailable,
} from "../../lib/auth";
import type { LaunchNavigate } from "../../lib/navigation";
import { Glyph } from "./glyph";

const REMOTE_SEARCH_DEBOUNCE_MS = 240;
const REMOTE_SEARCH_LIMIT = 30;

const REMOTE_GROUPS = [
  { id: "agents", label: "Agents", kinds: ["agent"] },
  { id: "attention", label: "Attention", kinds: ["attention"] },
  { id: "interfaces", label: "Interfaces", kinds: ["interface"] },
  { id: "directives", label: "Directives", kinds: ["directive"] },
  { id: "routines", label: "Routines", kinds: ["routine"] },
  {
    id: "functions",
    label: "Functions",
    kinds: ["function", "function_field"],
  },
  { id: "runs", label: "Runs", kinds: ["run"] },
  { id: "releases", label: "Releases", kinds: ["release"] },
  { id: "settings", label: "Settings", kinds: ["setting"] },
  { id: "access", label: "Access", kinds: ["authority"] },
] as const satisfies readonly {
  id: string;
  label: string;
  kinds: readonly LaunchAgentSearchSubjectKind[];
}[];

const RESULT_TYPE_LABELS: Record<LaunchAgentSearchSubjectKind, string> = {
  agent: "AGENT",
  directive: "DIRECTIVE",
  interface: "INTERFACE",
  routine: "ROUTINE",
  function: "FUNCTION",
  function_field: "FIELD",
  attention: "ALERT",
  run: "RUN",
  release: "RELEASE",
  setting: "SETTING",
  authority: "ACCESS",
};

const ALLOWED_PANES_BY_KIND: Readonly<
  Record<LaunchAgentSearchSubjectKind, readonly LaunchAgentPane[]>
> = {
  agent: ["overview"],
  directive: ["overview"],
  interface: ["interfaces"],
  routine: ["routines"],
  function: ["functions"],
  function_field: ["functions"],
  attention: ["alerts"],
  run: ["compute"],
  release: ["settings"],
  setting: ["settings", "access"],
  authority: ["access"],
};

const ITEM_REQUIRED_KINDS = new Set<LaunchAgentSearchSubjectKind>([
  "interface",
  "routine",
  "function",
  "function_field",
  "attention",
  "run",
  "release",
  "setting",
  "authority",
]);

export interface GroupedAgentSearchResult {
  href: string;
  result: LaunchAgentSearchResult;
}

export interface AgentSearchResultGroup {
  id: string;
  label: string;
  results: GroupedAgentSearchResult[];
}

export interface DebouncedAgentSearchOptions {
  authenticated: boolean;
  delayMs?: number;
  onError: (query: string) => void;
  onLoading: (query: string) => void;
  onSuccess: (query: string, response: LaunchAgentSearchResponse) => void;
  query: string;
  search: (query: string) => Promise<LaunchAgentSearchResponse>;
}

interface LocalSearchItem {
  key: string;
  label: string;
  run: () => void;
  type: string;
}

interface SearchPanelItem {
  key: string;
  label: string;
  run: () => void;
  summary: string | null;
  type: string;
}

interface SearchPanelGroup {
  id: string;
  items: SearchPanelItem[];
  label: string;
}

type RemoteSearchState =
  | { query: ""; results: []; status: "idle" }
  | {
    query: string;
    results: LaunchAgentSearchResult[];
    status: "loading" | "ready" | "error";
  };

export interface SearchPanelProps {
  agents: LaunchFleetAgentSummary[];
  onAlerts: () => void;
  onClose: () => void;
  onNavigate: LaunchNavigate;
}

function normalizedQuery(value: string): string {
  return value.trim();
}

function canUseAuthenticatedSearch(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return hasLaunchAuthToken() || isLaunchRefreshAvailable();
  } catch {
    return false;
  }
}

/**
 * A client-side defense around the server-authored navigation contract.
 * Search can only land on one canonical Agent pane/item route.
 */
export function stableAgentSearchHref(
  result: LaunchAgentSearchResult,
): string | null {
  const allowedPanes = (
    ALLOWED_PANES_BY_KIND as Partial<
      Record<string, readonly LaunchAgentPane[]>
    >
  )[result.kind];
  if (
    !allowedPanes ||
    typeof result.agent?.id !== "string" ||
    typeof result.agent.slug !== "string" ||
    typeof result.destination?.href !== "string"
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(result.destination.href, "https://galactic.internal");
  } catch {
    return null;
  }

  const expectedPath = `/agents/${encodeURIComponent(result.agent.slug)}`;
  if (
    parsed.origin !== "https://galactic.internal" ||
    parsed.pathname !== expectedPath ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    result.destination.agentId !== result.agent.id
  ) {
    return null;
  }

  const entries = [...parsed.searchParams.entries()];
  if (
    entries.some(([key]) => key !== "pane" && key !== "item") ||
    new Set(entries.map(([key]) => key)).size !== entries.length
  ) {
    return null;
  }

  const pane = parsed.searchParams.get("pane");
  if (
    !pane ||
    result.destination.pane !== pane ||
    !allowedPanes.includes(pane as LaunchAgentPane)
  ) {
    return null;
  }

  const item = parsed.searchParams.get("item");
  const destinationItem = result.destination.itemId ?? null;
  if (
    item !== destinationItem ||
    (ITEM_REQUIRED_KINDS.has(result.kind) && !item) ||
    (!ITEM_REQUIRED_KINDS.has(result.kind) && item !== null)
  ) {
    return null;
  }

  const canonical = new URLSearchParams({ pane });
  if (item) canonical.set("item", item);
  return `${expectedPath}?${canonical.toString()}`;
}

/**
 * Groups only navigation-safe, owner metadata results. Agent hits already
 * present in the immediate fleet list are omitted to avoid duplicate rows.
 */
export function groupAgentSearchResults(
  results: readonly LaunchAgentSearchResult[],
  localAgentIds: ReadonlySet<string> = new Set(),
): AgentSearchResultGroup[] {
  const seen = new Set<string>();
  const safeResults = results.flatMap((result) => {
    if (
      seen.has(result.id) ||
      (result.kind === "agent" && localAgentIds.has(result.agent.id))
    ) {
      return [];
    }
    const href = stableAgentSearchHref(result);
    if (!href) return [];
    seen.add(result.id);
    return [{ href, result }];
  });

  return REMOTE_GROUPS.flatMap((group) => {
    const grouped = safeResults.filter(({ result }) =>
      (group.kinds as readonly LaunchAgentSearchSubjectKind[]).includes(
        result.kind,
      )
    );
    return grouped.length > 0
      ? [{ id: group.id, label: group.label, results: grouped }]
      : [];
  });
}

/**
 * Starts a cancellable, authenticated debounce. Cancellation suppresses both
 * queued work and late Promise settlement, preventing stale query results.
 */
export function startDebouncedAgentSearch(
  options: DebouncedAgentSearchOptions,
): () => void {
  const query = normalizedQuery(options.query);
  if (!options.authenticated || !query) return () => {};

  let cancelled = false;
  options.onLoading(query);
  const timer = globalThis.setTimeout(() => {
    void options.search(query).then(
      (response) => {
        if (!cancelled) options.onSuccess(query, response);
      },
      () => {
        if (!cancelled) options.onError(query);
      },
    );
  }, options.delayMs ?? REMOTE_SEARCH_DEBOUNCE_MS);

  return () => {
    cancelled = true;
    globalThis.clearTimeout(timer);
  };
}

export function SearchPanel({
  agents,
  onAlerts,
  onClose,
  onNavigate,
}: SearchPanelProps): ReactElement {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [remote, setRemote] = useState<RemoteSearchState>({
    query: "",
    results: [],
    status: "idle",
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const localItems = useMemo<LocalSearchItem[]>(() => [
    ...agents.map((item) => ({
      key: `agent-${item.agent.id}`,
      label: item.agent.name,
      type: "AGENT",
      run: () => onNavigate(`/agents/${encodeURIComponent(item.agent.slug)}`),
    })),
    { key: "action-alerts", label: "Alerts", type: "VIEW", run: onAlerts },
    {
      key: "action-usage",
      label: "Usage",
      type: "SETTINGS",
      run: () => onNavigate("/account?pane=usage"),
    },
    {
      key: "action-billing",
      label: "Billing",
      type: "SETTINGS",
      run: () => onNavigate("/account?pane=billing"),
    },
    {
      key: "action-byok",
      label: "BYOK Setup",
      type: "SETTINGS",
      run: () => onNavigate("/account?pane=byok"),
    },
    {
      key: "action-keys",
      label: "Galactic Keys",
      type: "SETTINGS",
      run: () => onNavigate("/account?pane=keys"),
    },
    {
      key: "action-connect",
      label: "Connect AI",
      type: "SETTINGS",
      run: () => onNavigate("/account?pane=connect"),
    },
  ], [agents, onAlerts, onNavigate]);
  const searchQuery = normalizedQuery(query);
  const filteredLocal = useMemo(
    () =>
      localItems.filter((item) =>
        item.label.toLowerCase().includes(searchQuery.toLowerCase())
      ),
    [localItems, searchQuery],
  );
  const localAgentIds = useMemo(
    () => new Set(agents.map((item) => item.agent.id)),
    [agents],
  );
  const visibleRemote = remote.query === searchQuery
    ? remote
    : searchQuery
    ? { query: searchQuery, results: [], status: "loading" as const }
    : { query: "", results: [], status: "idle" as const };
  const remoteGroups = useMemo(
    () =>
      groupAgentSearchResults(
        visibleRemote.status === "ready" ? visibleRemote.results : [],
        localAgentIds,
      ),
    [localAgentIds, visibleRemote],
  );
  const groups = useMemo<SearchPanelGroup[]>(() => [
    ...(filteredLocal.length > 0
      ? [{
        id: "local",
        label: "Agents & actions",
        items: filteredLocal.map((item) => ({
          ...item,
          summary: null,
        })),
      }]
      : []),
    ...remoteGroups.map((group) => ({
      id: group.id,
      label: group.label,
      items: group.results.map(({ href, result }) => ({
        key: `remote-${result.id}`,
        label: result.title,
        summary: [result.agent.name, result.summary]
          .filter((value): value is string => Boolean(value))
          .join(" · ") || null,
        type: RESULT_TYPE_LABELS[result.kind],
        run: () => onNavigate(href, { scroll: "preserve" }),
      })),
    })),
  ], [filteredLocal, onNavigate, remoteGroups]);
  const filtered = useMemo(
    () => groups.flatMap((group) => group.items),
    [groups],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    setSelected((current) =>
      filtered.length === 0
        ? 0
        : Math.min(current, filtered.length - 1)
    );
  }, [filtered.length]);
  useEffect(() => {
    const normalized = normalizedQuery(query);
    const authenticated = canUseAuthenticatedSearch();
    if (!normalized) {
      setRemote({ query: "", results: [], status: "idle" });
      return;
    }
    if (!authenticated) {
      setRemote({ query: normalized, results: [], status: "ready" });
      return;
    }
    setRemote({ query: normalized, results: [], status: "loading" });
    return startDebouncedAgentSearch({
      authenticated,
      query: normalized,
      search: (value) =>
        launchApi.searchAgents({
          query: value,
          limit: REMOTE_SEARCH_LIMIT,
        }),
      onLoading: (value) => {
        setRemote({ query: value, results: [], status: "loading" });
      },
      onSuccess: (value, response) => {
        setRemote({
          query: value,
          results: response.results,
          status: "ready",
        });
      },
      onError: (value) => {
        setRemote({ query: value, results: [], status: "error" });
      },
    });
  }, [query]);

  let itemOffset = 0;
  return (
    <section className="neb-inline-panel neb-search-panel" aria-label="Search">
      <div className="neb-cmdk-input-wrap">
        <Glyph name="search" />
        <input
          aria-activedescendant={filtered[selected]
            ? `${listId}-item-${selected}`
            : undefined}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded="true"
          className="neb-cmdk-input"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected((value) =>
                filtered.length === 0
                  ? 0
                  : Math.min(filtered.length - 1, value + 1)
              );
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              filtered[selected]?.run();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
          placeholder="Jump to an agent or action…"
          ref={inputRef}
          role="combobox"
          value={query}
        />
      </div>
      <div
        aria-busy={visibleRemote.status === "loading"}
        className="neb-cmdk-list"
        id={listId}
        role="listbox"
      >
        {groups.map((group) => {
          const startIndex = itemOffset;
          itemOffset += group.items.length;
          return (
            <div aria-label={group.label} key={group.id} role="group">
              <div className="neb-rail-group-label">{group.label}</div>
              {group.items.map((item, groupIndex) => {
                const index = startIndex + groupIndex;
                return (
                  <button
                    aria-selected={selected === index}
                    className={`neb-cmdk-item${
                      selected === index ? " sel" : ""
                    }`}
                    id={`${listId}-item-${index}`}
                    key={item.key}
                    onClick={item.run}
                    onMouseMove={() => setSelected(index)}
                    role="option"
                    type="button"
                  >
                    <Glyph
                      name={item.type === "AGENT" ? "spark" : "chevron"}
                    />
                    {item.summary
                      ? (
                        <span className="neb-operator-activity-main">
                          <strong>{item.label}</strong>
                          <small>{item.summary}</small>
                        </span>
                      )
                      : <span>{item.label}</span>}
                    <span className="k-type">{item.type}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {visibleRemote.status === "loading"
          ? (
            <div className="neb-cmdk-empty" role="status">
              Searching Agent details…
            </div>
          )
          : null}
        {visibleRemote.status === "error"
          ? (
            <div className="neb-error-note" role="status">
              Detailed search is temporarily unavailable. Local matches are
              still available.
            </div>
          )
          : null}
        {filtered.length === 0 &&
            (visibleRemote.status === "idle" ||
              visibleRemote.status === "ready")
          ? <div className="neb-cmdk-empty">Nothing matches.</div>
          : null}
      </div>
      <div className="neb-cmdk-foot">
        <span>↑↓ NAVIGATE</span><span>↵ SELECT</span><span>ESC CLOSE</span>
      </div>
    </section>
  );
}
