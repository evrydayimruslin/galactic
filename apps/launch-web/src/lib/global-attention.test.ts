import { describe, expect, it } from "vitest";

import type {
  LaunchAgentAttentionItem,
  LaunchGlobalAttentionEntry,
  LaunchGlobalAttentionResponse,
} from "../../../../shared/contracts/launch.ts";
import {
  appendGlobalAttentionPage,
  exactGlobalAttentionCountAfterAgentChange,
  globalAttentionAgentCountMap,
  globalAttentionEntryMatches,
  groupGlobalAttentionEntries,
} from "./global-attention";

function entry(
  agentId: string,
  notificationId: string,
  headline: string,
): LaunchGlobalAttentionEntry {
  const item = {
    id: `attention:${notificationId}`,
    notificationId,
    agentId,
    type: "incident",
    severity: "warning",
    requiresAction: true,
    incidentCode: "missing_setting",
    lifecycle: {
      state: "open",
      readAt: "2026-07-23T12:00:00.000Z",
      stateChangedAt: "2026-07-23T12:00:00.000Z",
      snoozedUntil: null,
      resolvedAt: null,
      resolutionReason: null,
      archivedAt: null,
    },
    brief: {
      headline,
      impact: "Work is blocked.",
      context: null,
      recommendedNextMove: "Add the credential.",
      requiresDecision: true,
      confidence: 0.9,
      evidence: [],
    },
    actions: [],
    occurredAt: "2026-07-23T12:00:00.000Z",
    enrichment: {
      status: "ready",
      version: "1",
      generatedAt: "2026-07-23T12:00:01.000Z",
    },
    raw: {
      kind: "missing_setting",
      title: headline,
      body: "Work is blocked.",
    },
  } satisfies LaunchAgentAttentionItem;
  return {
    agent: {
      id: agentId,
      slug: `agent-${agentId}`,
      name: `Agent ${agentId}`,
    },
    item,
  };
}

describe("global Attention grouping", () => {
  it("groups current Attention by Agent without changing server order", () => {
    const entries = [
      entry("a", "n1", "First"),
      entry("b", "n2", "Second"),
      entry("a", "n3", "Third"),
    ];
    const groups = groupGlobalAttentionEntries(entries);
    expect(groups.map((group) => group.agent.id)).toEqual(["a", "b"]);
    expect(groups[0].items.map((item) => item.notificationId)).toEqual([
      "n1",
      "n3",
    ]);
  });

  it("searches Agent identity and enriched operator context", () => {
    const target = entry("email", "n1", "Inbox cannot be checked");
    expect(globalAttentionEntryMatches(target, "email")).toBe(true);
    expect(globalAttentionEntryMatches(target, "credential")).toBe(true);
    expect(globalAttentionEntryMatches(target, "unrelated")).toBe(false);
  });

  it("applies lifecycle deltas without truncating an exact count to the 200-row page", () => {
    expect(exactGlobalAttentionCountAfterAgentChange(947, 200, 199)).toBe(946);
    expect(exactGlobalAttentionCountAfterAgentChange(947, 199, 200)).toBe(948);
    expect(exactGlobalAttentionCountAfterAgentChange(947, 200, 200)).toBe(947);
  });

  it("appends cursor pages without duplicates and keeps the newest exact aggregates", () => {
    const first: LaunchGlobalAttentionResponse = {
      entries: [entry("a", "n1", "First")],
      agentCounts: [{
        agent: entry("a", "n1", "First").agent,
        openCount: 241,
        requiresDecisionCount: 173,
      }],
      openCount: 241,
      requiresDecisionCount: 173,
      nextCursor: "page-2",
      available: true,
      unavailableReason: null,
      generatedAt: "2026-07-23T12:00:00.000Z",
    };
    const second: LaunchGlobalAttentionResponse = {
      ...first,
      entries: [
        entry("a", "n1", "Duplicate"),
        entry("a", "n2", "Second"),
      ],
      nextCursor: null,
      generatedAt: "2026-07-23T12:01:00.000Z",
    };
    const merged = appendGlobalAttentionPage(first, second);
    expect(merged.entries.map(({ item }) => item.notificationId)).toEqual([
      "n1",
      "n2",
    ]);
    expect(merged.nextCursor).toBeNull();
    expect(
      globalAttentionAgentCountMap(merged.agentCounts).get("a")?.openCount,
    ).toBe(241);
  });
});
