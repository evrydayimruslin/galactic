import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  LaunchAgentPane,
  LaunchAgentSearchResponse,
  LaunchAgentSearchResult,
  LaunchAgentSearchSubjectKind,
  LaunchFleetAgentSummary,
} from "../../../../../shared/contracts/launch.ts";
import {
  groupAgentSearchResults,
  SearchPanel,
  stableAgentSearchHref,
  startDebouncedAgentSearch,
} from "./search-panel";

const AGENT = {
  id: "agent-1",
  slug: "email-ops",
  name: "email-ops",
};

function searchResult({
  id = "document-1",
  itemId = "subject-1",
  kind = "function",
  pane = "functions",
  summary = "Sends an approved reply.",
  title = "send_reply",
}: {
  id?: string;
  itemId?: string | null;
  kind?: LaunchAgentSearchSubjectKind;
  pane?: LaunchAgentPane;
  summary?: string | null;
  title?: string;
} = {}): LaunchAgentSearchResult {
  const params = new URLSearchParams({ pane });
  if (itemId) params.set("item", itemId);
  return {
    id,
    kind,
    agent: AGENT,
    title,
    summary,
    destination: {
      href: `/agents/${AGENT.slug}?${params.toString()}`,
      agentId: AGENT.id,
      pane,
      ...(itemId ? { itemId } : {}),
    },
    score: 0.91,
  };
}

function response(
  query: string,
  results: LaunchAgentSearchResult[] = [],
): LaunchAgentSearchResponse {
  return {
    query,
    results,
    generatedAt: "2026-07-23T12:00:00.000Z",
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("stableAgentSearchHref", () => {
  it.each([
    ["agent", "overview", null],
    ["directive", "overview", null],
    ["interface", "interfaces", "inbox"],
    ["routine", "routines", "check-inbox"],
    ["function", "functions", "send-reply"],
    ["function_field", "functions", "send-reply.subject"],
    ["attention", "alerts", "attention-1"],
    ["run", "compute", "run-1"],
    ["release", "settings", "release-1"],
    ["setting", "settings", "setting-1"],
    ["authority", "access", "authority-1"],
  ] as const)(
    "accepts a canonical %s destination",
    (kind, pane, itemId) => {
      const result = searchResult({ kind, pane, itemId });
      const expected = new URLSearchParams({ pane });
      if (itemId) expected.set("item", itemId);

      expect(stableAgentSearchHref(result)).toBe(
        `/agents/email-ops?${expected.toString()}`,
      );
    },
  );

  it("accepts settings metadata on the Access pane", () => {
    expect(stableAgentSearchHref(searchResult({
      kind: "setting",
      pane: "access",
      itemId: "gmail-token",
    }))).toBe("/agents/email-ops?pane=access&item=gmail-token");
  });

  it.each([
    ["an external URL", "https://example.com/agents/email-ops?pane=overview"],
    ["a mismatched Agent path", "/agents/other?pane=overview"],
    [
      "an unknown query parameter",
      "/agents/email-ops?pane=overview&redirect=https%3A%2F%2Fexample.com",
    ],
    [
      "a duplicate query parameter",
      "/agents/email-ops?pane=overview&pane=overview",
    ],
    ["a fragment", "/agents/email-ops?pane=overview#unexpected"],
  ])("rejects %s", (_label, href) => {
    const result = searchResult({
      kind: "agent",
      pane: "overview",
      itemId: null,
    });
    result.destination.href = href;

    expect(stableAgentSearchHref(result)).toBeNull();
  });

  it("rejects contract mismatches instead of trusting the href", () => {
    const wrongAgent = searchResult();
    wrongAgent.destination.agentId = "agent-2";
    const wrongPane = searchResult();
    wrongPane.destination.pane = "alerts";
    const wrongItem = searchResult();
    wrongItem.destination.itemId = "another-item";
    const missingItem = searchResult({ itemId: null });
    const extraItem = searchResult({
      kind: "agent",
      pane: "overview",
      itemId: "unexpected",
    });

    expect(stableAgentSearchHref(wrongAgent)).toBeNull();
    expect(stableAgentSearchHref(wrongPane)).toBeNull();
    expect(stableAgentSearchHref(wrongItem)).toBeNull();
    expect(stableAgentSearchHref(missingItem)).toBeNull();
    expect(stableAgentSearchHref(extraItem)).toBeNull();
  });

  it("fails closed for an unknown runtime result kind", () => {
    const malformed = searchResult();
    (malformed as { kind: string }).kind = "secret";

    expect(stableAgentSearchHref(malformed)).toBeNull();
  });
});

describe("groupAgentSearchResults", () => {
  it("groups safe metadata in the operator-facing order", () => {
    const results = [
      searchResult({
        id: "release",
        kind: "release",
        pane: "settings",
        itemId: "release:v2",
        title: "Release v2",
      }),
      searchResult({
        id: "field",
        kind: "function_field",
        pane: "functions",
        itemId: "send_reply.subject",
        title: "subject",
      }),
      searchResult({
        id: "attention",
        kind: "attention",
        pane: "alerts",
        itemId: "approval",
        title: "Approval required",
      }),
      searchResult({
        id: "function",
        kind: "function",
        pane: "functions",
        itemId: "send_reply",
        title: "send_reply",
      }),
      searchResult({
        id: "interface",
        kind: "interface",
        pane: "interfaces",
        itemId: "inbox",
        title: "Inbox",
      }),
    ];

    const groups = groupAgentSearchResults(results);

    expect(groups.map(({ label }) => label)).toEqual([
      "Attention",
      "Interfaces",
      "Functions",
      "Releases",
    ]);
    expect(groups[2]?.results.map(({ result }) => result.id)).toEqual([
      "field",
      "function",
    ]);
  });

  it("deduplicates results, removes unsafe destinations, and avoids duplicate local Agent rows", () => {
    const localAgent = searchResult({
      id: "local-agent",
      kind: "agent",
      pane: "overview",
      itemId: null,
      title: "email-ops",
    });
    const duplicate = searchResult({
      id: "duplicate",
      kind: "interface",
      pane: "interfaces",
      itemId: "inbox",
      title: "Inbox",
    });
    const unsafe = searchResult({
      id: "unsafe",
      kind: "function",
      pane: "functions",
      itemId: "send_reply",
    });
    unsafe.destination.href = "https://example.com";

    const groups = groupAgentSearchResults(
      [localAgent, duplicate, duplicate, unsafe],
      new Set([AGENT.id]),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("Interfaces");
    expect(groups[0]?.results).toEqual([
      {
        href: "/agents/email-ops?pane=interfaces&item=inbox",
        result: duplicate,
      },
    ]);
  });
});

describe("startDebouncedAgentSearch", () => {
  it("does nothing for blank or unauthenticated searches", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => response("inbox"));
    const onLoading = vi.fn();

    startDebouncedAgentSearch({
      authenticated: false,
      query: "inbox",
      search,
      onLoading,
      onSuccess: vi.fn(),
      onError: vi.fn(),
    });
    startDebouncedAgentSearch({
      authenticated: true,
      query: "   ",
      search,
      onLoading,
      onSuccess: vi.fn(),
      onError: vi.fn(),
    });
    await vi.runAllTimersAsync();

    expect(onLoading).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("trims, debounces, and returns the typed response", async () => {
    vi.useFakeTimers();
    const result = searchResult();
    const payload = response("send reply", [result]);
    const search = vi.fn(async () => payload);
    const onLoading = vi.fn();
    const onSuccess = vi.fn();

    startDebouncedAgentSearch({
      authenticated: true,
      delayMs: 240,
      query: "  send reply  ",
      search,
      onLoading,
      onSuccess,
      onError: vi.fn(),
    });

    expect(onLoading).toHaveBeenCalledOnce();
    expect(onLoading).toHaveBeenCalledWith("send reply");
    await vi.advanceTimersByTimeAsync(239);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledWith("send reply");
    expect(onSuccess).toHaveBeenCalledWith("send reply", payload);
  });

  it("reports failure without exposing the underlying error", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();

    startDebouncedAgentSearch({
      authenticated: true,
      delayMs: 1,
      query: "inbox",
      search: vi.fn(async () => {
        throw new Error("sensitive transport detail");
      }),
      onLoading: vi.fn(),
      onSuccess: vi.fn(),
      onError,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(onError).toHaveBeenCalledWith("inbox");
    expect(onError.mock.calls[0]).toHaveLength(1);
  });

  it("cancels queued work and suppresses late Promise settlement", async () => {
    vi.useFakeTimers();
    const queuedSearch = vi.fn(async () => response("queued"));
    const cancelQueued = startDebouncedAgentSearch({
      authenticated: true,
      delayMs: 10,
      query: "queued",
      search: queuedSearch,
      onLoading: vi.fn(),
      onSuccess: vi.fn(),
      onError: vi.fn(),
    });
    cancelQueued();
    await vi.advanceTimersByTimeAsync(10);
    expect(queuedSearch).not.toHaveBeenCalled();

    let resolveSearch:
      | ((value: LaunchAgentSearchResponse) => void)
      | undefined;
    const pending = new Promise<LaunchAgentSearchResponse>((resolve) => {
      resolveSearch = resolve;
    });
    const onSuccess = vi.fn();
    const cancelPending = startDebouncedAgentSearch({
      authenticated: true,
      delayMs: 1,
      query: "pending",
      search: vi.fn(() => pending),
      onLoading: vi.fn(),
      onSuccess,
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(1);
    cancelPending();
    resolveSearch?.(response("pending"));
    await Promise.resolve();

    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe("SearchPanel", () => {
  it("renders immediate local Agent and action navigation without an answer surface", () => {
    const agent = {
      agent: AGENT,
    } as unknown as LaunchFleetAgentSummary;

    const markup = renderToStaticMarkup(
      <SearchPanel
        agents={[agent]}
        onAlerts={() => {}}
        onClose={() => {}}
        onNavigate={() => {}}
      />,
    );

    expect(markup).toContain("email-ops");
    expect(markup).toContain("Alerts");
    expect(markup).toContain("Connect AI");
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('role="listbox"');
    expect(markup).not.toContain("answer");
  });
});
