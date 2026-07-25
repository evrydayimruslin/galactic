import { describe, expect, it } from "vitest";

import type {
  LaunchOperatorAttentionEntry,
  LaunchOperatorAttentionProjection,
  LaunchOperatorRemediation,
} from "../../../../shared/contracts/launch.ts";
import {
  appendOperatorAttentionPage,
  canonicalOperatorAttention,
  operatorAttentionAgentMap,
  operatorAttentionEntryMatches,
  operatorRemediationHref,
  resolveOperatorAttentionEntry,
} from "./operator-attention";

const AGENT = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "mail ops",
  name: "Mail Ops",
};

function entry(id = "22222222-2222-4222-8222-222222222222") {
  return {
    item: {
      id,
      conditionKey: `condition:${id}`,
      itemClass: "issue",
      scope: { kind: "agent", agentId: AGENT.id },
      severity: "warning",
      diagnosis: {
        code: "AGENT_SECRET_MISSING",
        causeCode: null,
        summary: "Configure IMAP password",
        detail: "Mail Ops cannot check the inbox.",
        provenance: "platform",
        evidence: [],
      },
      affectedAgents: [{ agentId: AGENT.id, blocking: true }],
      remediations: [],
      requiresAction: true,
      requiresDecision: false,
      ordering: { sourceOrdinal: 0, dependsOnConditionKeys: [] },
      recovery: {
        mode: "revalidate_condition",
        mayRecoverAutomatically: true,
        resumesScheduledWork: false,
      },
      detectedAt: "2026-07-24T18:00:00.000Z",
    },
    attention: {
      state: "open",
      readAt: null,
      snoozedUntil: null,
      dismissedAt: null,
    },
  } satisfies LaunchOperatorAttentionEntry;
}

function projection(
  items = [entry()],
): LaunchOperatorAttentionProjection {
  return {
    contractVersion: "2026-07-24.operator-issues.1",
    items,
    agentCounts: [{
      agent: AGENT,
      openCount: items.length,
      requiresDecisionCount: 0,
      blockingCount: items.length,
    }],
    openCount: items.length,
    requiresDecisionCount: 0,
    blockingCount: items.length,
    nextCursor: null,
    available: true,
    unavailableReason: null,
    generatedAt: "2026-07-24T18:00:00.000Z",
  };
}

describe("canonical operator Attention web model", () => {
  it("cuts over only when the API declares canonical authoritative", () => {
    const canonical = projection();
    expect(canonicalOperatorAttention({
      readSource: "legacy",
      operatorItems: canonical,
    })).toBeNull();
    expect(canonicalOperatorAttention({
      readSource: "canonical",
      operatorItems: canonical,
    })).toBe(canonical);
  });

  it("merges canonical cursor pages by item id and keeps newest aggregates", () => {
    const first = projection([entry()]);
    first.nextCursor = "operator-attention-v1.next";
    const secondEntry = entry("33333333-3333-4333-8333-333333333333");
    const second = projection([entry(), secondEntry]);
    second.openCount = 241;
    const merged = appendOperatorAttentionPage(first, second);
    expect(merged.items.map(({ item }) => item.id)).toEqual([
      entry().item.id,
      secondEntry.item.id,
    ]);
    expect(merged.openCount).toBe(241);
  });

  it("searches diagnosis and affected Agent identity without prose routing", () => {
    const agents = operatorAttentionAgentMap(projection());
    expect(operatorAttentionEntryMatches(entry(), "imap", agents)).toBe(true);
    expect(operatorAttentionEntryMatches(entry(), "mail ops", agents)).toBe(
      true,
    );
    expect(operatorAttentionEntryMatches(entry(), "billing", agents)).toBe(
      false,
    );
  });

  it("builds routes only from typed semantic targets and known Agents", () => {
    const agents = operatorAttentionAgentMap(projection());
    const remediation = {
      id: "condition:remediation:configure_secret",
      key: "configure_secret",
      label: "Add password",
      description: null,
      presentation: "inline",
      requiredAuthority: "account_session",
      sideEffect: "configuration_write",
      target: {
        kind: "agent_setting",
        agentId: AGENT.id,
        settingKey: "IMAP_PASSWORD",
        settingScope: "per_user",
      },
    } satisfies LaunchOperatorRemediation;
    expect(operatorRemediationHref(remediation, agents)).toBe(
      "/agents/mail%20ops?pane=access&item=setting%3AIMAP_PASSWORD",
    );
    expect(operatorRemediationHref({
      ...remediation,
      target: { ...remediation.target, agentId: crypto.randomUUID() },
    }, agents)).toBeNull();
  });

  it("resolves deep links only by canonical id or condition key", () => {
    const item = entry();
    expect(resolveOperatorAttentionEntry([item], item.item.id)).toBe(item);
    expect(resolveOperatorAttentionEntry([item], item.item.conditionKey)).toBe(
      item,
    );
    expect(resolveOperatorAttentionEntry([item], "Configure IMAP password"))
      .toBeNull();
  });
});
