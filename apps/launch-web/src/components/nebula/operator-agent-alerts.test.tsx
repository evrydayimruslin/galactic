import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  LaunchAgentAttentionActionResponse,
  LaunchAgentAttentionIncident,
  LaunchAgentAttentionItem,
  LaunchAgentAttentionProjection,
  LaunchAgentAttentionReport,
  LaunchNavigationTarget,
} from "../../../../../shared/contracts/launch.ts";
import {
  activeAttentionCount,
  appendAttentionItems,
  attentionCountAfterLifecycleTransition,
  activeAttentionDecisionCount,
  attentionDecisionCountAfterLifecycleTransition,
  attentionLifecycleActions,
  buildAttentionLifecycleRequest,
  groupAttentionItems,
  OperatorAgentAlerts,
  performAttentionLifecycleAction,
  resolveAttentionItemTarget,
  safeAttentionDestinationHref,
} from "./operator-agent-alerts";

const AGENT = {
  id: "agent-1",
  slug: "email-ops",
  name: "email-ops",
};
const NOW = new Date("2026-07-23T12:00:00.000Z");

function report(
  overrides: Partial<LaunchAgentAttentionReport> = {},
): LaunchAgentAttentionReport {
  return {
    id: "attention:report-1",
    notificationId: "report-1",
    agentId: AGENT.id,
    type: "report",
    severity: "info",
    requiresAction: false,
    lifecycle: {
      state: "open",
      readAt: null,
      stateChangedAt: "2026-07-23T11:00:00.000Z",
      snoozedUntil: null,
      resolvedAt: null,
      resolutionReason: null,
      archivedAt: null,
    },
    brief: {
      headline: "Inbox report is ready",
      impact: "Three replies were drafted.",
      context: "All drafts are below the confidence threshold.",
      recommendedNextMove: "Review the drafts in Inbox.",
      requiresDecision: false,
      confidence: 0.92,
      evidence: [
        {
          kind: "notification",
          sourceId: "report-1",
          label: "Original inbox report",
          observedAt: "2026-07-23T11:00:00.000Z",
          destination: {
            href: "/agents/email-ops?pane=alerts&item=report-1",
            pane: "alerts",
            itemId: "report-1",
          },
        },
      ],
    },
    actions: [],
    occurredAt: "2026-07-23T11:00:00.000Z",
    enrichment: {
      status: "ready",
      version: "1",
      generatedAt: "2026-07-23T11:00:01.000Z",
    },
    raw: {
      kind: "routine_report",
      title: "Inbox report",
      body: "Three replies were drafted.",
    },
    ...overrides,
  };
}

function incident(
  overrides: Partial<LaunchAgentAttentionIncident> = {},
): LaunchAgentAttentionIncident {
  return {
    id: "attention:incident-1",
    notificationId: "incident-1",
    agentId: AGENT.id,
    type: "incident",
    severity: "warning",
    requiresAction: true,
    incidentCode: "missing_setting",
    lifecycle: {
      state: "open",
      readAt: null,
      stateChangedAt: "2026-07-23T11:30:00.000Z",
      snoozedUntil: null,
      resolvedAt: null,
      resolutionReason: null,
      archivedAt: null,
    },
    brief: {
      headline: "email-ops cannot check the inbox",
      impact: "No new email has been processed since 10:42 AM.",
      context: "The live release requires one missing Gmail credential.",
      recommendedNextMove: "Add the credential in Access.",
      requiresDecision: true,
      confidence: 0.97,
      evidence: [],
    },
    actions: [
      {
        id: "brief:incident-1:1:open_access_setting",
        key: "open_access_setting",
        label: "Add credential",
        emphasis: "primary",
        parameters: {
          settingKey: "GMAIL_TOKEN",
          secret: "must-never-render",
        },
        destination: {
          href:
            "/agents/email-ops?pane=access&item=setting%3AGMAIL_TOKEN",
          pane: "access",
          itemId: "setting:GMAIL_TOKEN",
        },
      },
    ],
    occurredAt: "2026-07-23T11:30:00.000Z",
    enrichment: {
      status: "ready",
      version: "1",
      generatedAt: "2026-07-23T11:30:01.000Z",
    },
    raw: {
      kind: "missing_setting",
      title: "Missing Gmail setting",
      body: "GMAIL_TOKEN is absent.",
    },
    ...overrides,
  };
}

function destination(
  href: string,
  pane: LaunchNavigationTarget["pane"] = "access",
  itemId: string | null = "setting:GMAIL_TOKEN",
): LaunchNavigationTarget {
  return {
    href,
    agentId: AGENT.id,
    pane,
    itemId,
  };
}

describe("safeAttentionDestinationHref", () => {
  it("canonicalizes a same-Agent pane/item destination", () => {
    expect(safeAttentionDestinationHref(
      destination(
        "/agents/email-ops?item=setting%3AGMAIL_TOKEN&pane=access",
      ),
      AGENT,
    )).toBe(
      "/agents/email-ops?pane=access&item=setting%3AGMAIL_TOKEN",
    );
  });

  it.each([
    ["external", "https://example.com/agents/email-ops?pane=access&item=setting%3AGMAIL_TOKEN"],
    ["protocol relative", "//example.com/agents/email-ops?pane=access&item=setting%3AGMAIL_TOKEN"],
    ["wrong Agent", "/agents/other?pane=access&item=setting%3AGMAIL_TOKEN"],
    ["fragment", "/agents/email-ops?pane=access&item=setting%3AGMAIL_TOKEN#secret"],
    ["extra query", "/agents/email-ops?pane=access&item=setting%3AGMAIL_TOKEN&next=https%3A%2F%2Fexample.com"],
    ["duplicate pane", "/agents/email-ops?pane=access&pane=access&item=setting%3AGMAIL_TOKEN"],
  ])("rejects an %s destination", (_label, href) => {
    expect(
      safeAttentionDestinationHref(destination(href), AGENT),
    ).toBeNull();
  });

  it("rejects mismatched destination metadata", () => {
    const wrongAgent = destination(
      "/agents/email-ops?pane=access&item=setting%3AGMAIL_TOKEN",
    );
    wrongAgent.agentId = "agent-2";
    const wrongPane = destination(
      "/agents/email-ops?pane=access&item=setting%3AGMAIL_TOKEN",
    );
    wrongPane.pane = "settings";
    const wrongItem = destination(
      "/agents/email-ops?pane=access&item=setting%3AGMAIL_TOKEN",
    );
    wrongItem.itemId = "setting:OTHER";

    expect(safeAttentionDestinationHref(wrongAgent, AGENT)).toBeNull();
    expect(safeAttentionDestinationHref(wrongPane, AGENT)).toBeNull();
    expect(safeAttentionDestinationHref(wrongItem, AGENT)).toBeNull();
  });
});

describe("Attention lifecycle", () => {
  it("offers only valid report and incident transitions", () => {
    expect(attentionLifecycleActions(report()).map(({ action }) => action))
      .toEqual(["read", "archive"]);
    expect(attentionLifecycleActions(incident()).map(({ action }) => action))
      .toEqual(["read", "snooze", "resolve"]);
    expect(attentionLifecycleActions(incident({
      lifecycle: {
        state: "snoozed",
        readAt: null,
        stateChangedAt: NOW.toISOString(),
        snoozedUntil: "2026-07-23T13:00:00.000Z",
        resolvedAt: null,
        resolutionReason: null,
        archivedAt: null,
      },
    })).map(({ action }) => action)).toEqual(["read", "reopen"]);
    expect(attentionLifecycleActions(incident({
      lifecycle: {
        state: "resolved",
        readAt: NOW.toISOString(),
        stateChangedAt: NOW.toISOString(),
        snoozedUntil: null,
        resolvedAt: NOW.toISOString(),
        resolutionReason: "Configuration restored",
        archivedAt: null,
      },
    })).map(({ action }) => action)).toEqual(["reopen"]);
    expect(attentionLifecycleActions(report({
      lifecycle: {
        state: "archived",
        readAt: NOW.toISOString(),
        stateChangedAt: NOW.toISOString(),
        snoozedUntil: null,
        resolvedAt: null,
        resolutionReason: null,
        archivedAt: NOW.toISOString(),
      },
    }))).toEqual([]);
  });

  it("builds a bounded one-hour snooze request", () => {
    expect(
      buildAttentionLifecycleRequest("snooze", "idempotency-1", NOW),
    ).toEqual({
      action: "snooze",
      idempotencyKey: "idempotency-1",
      snoozedUntil: "2026-07-23T13:00:00.000Z",
    });
    expect(
      buildAttentionLifecycleRequest("resolve", "idempotency-2", NOW),
    ).toEqual({
      action: "resolve",
      idempotencyKey: "idempotency-2",
    });
  });

  it("routes every lifecycle mutation through the typed Attention endpoint", async () => {
    const payload: LaunchAgentAttentionActionResponse = {
      ok: true,
      notificationId: "incident-1",
      actionId: null,
      lifecycle: {
        state: "resolved",
        readAt: null,
        stateChangedAt: NOW.toISOString(),
        snoozedUntil: null,
        resolvedAt: NOW.toISOString(),
        resolutionReason: null,
        archivedAt: null,
      },
      destination: null,
    };
    const actOnAttention = vi.fn(async () => payload);

    await expect(performAttentionLifecycleAction("incident-1", {
      action: "resolve",
      actOnAttention,
      idempotencyKey: "idempotency-3",
      now: NOW,
    })).resolves.toBe(payload);
    expect(actOnAttention).toHaveBeenCalledWith("incident-1", {
      action: "resolve",
      idempotencyKey: "idempotency-3",
    });
  });

  it("counts and groups only current Attention truth", () => {
    const futureSnooze = incident({
      id: "attention:snoozed",
      notificationId: "snoozed",
      lifecycle: {
        state: "snoozed",
        readAt: null,
        stateChangedAt: NOW.toISOString(),
        snoozedUntil: "2026-07-23T13:00:00.000Z",
        resolvedAt: null,
        resolutionReason: null,
        archivedAt: null,
      },
    });
    const dueSnooze = incident({
      id: "attention:due",
      notificationId: "due",
      lifecycle: {
        state: "snoozed",
        readAt: NOW.toISOString(),
        stateChangedAt: NOW.toISOString(),
        snoozedUntil: "2026-07-23T11:59:00.000Z",
        resolvedAt: null,
        resolutionReason: null,
        archivedAt: null,
      },
    });
    const readReport = report({
      id: "attention:read-report",
      notificationId: "read-report",
      lifecycle: {
        ...report().lifecycle,
        readAt: NOW.toISOString(),
      },
    });
    const items: LaunchAgentAttentionItem[] = [
      report(),
      incident(),
      futureSnooze,
      dueSnooze,
      readReport,
    ];

    expect(activeAttentionCount(items, NOW.getTime())).toBe(3);
    expect(activeAttentionDecisionCount(items, NOW.getTime())).toBe(2);
    expect(groupAttentionItems(items, NOW.getTime()).map((group) => [
      group.id,
      group.items.map((item) => item.notificationId),
    ])).toEqual([
      ["active", ["report-1", "incident-1", "due"]],
      ["snoozed", ["snoozed"]],
    ]);
  });
});

describe("Attention item targets", () => {
  const items = [incident(), report()];

  it.each([
    ["incident-1", "incident-1"],
    ["attention:incident-1", "incident-1"],
    ["report-1", "report-1"],
    ["attention:report-1", "report-1"],
  ])("resolves %s to notification %s", (itemId, notificationId) => {
    expect(resolveAttentionItemTarget(items, itemId)?.notificationId)
      .toBe(notificationId);
  });

  it("returns null for an empty or stale target", () => {
    expect(resolveAttentionItemTarget(items, null)).toBeNull();
    expect(resolveAttentionItemTarget(items, "missing")).toBeNull();
  });
});

describe("OperatorAgentAlerts", () => {
  it("applies lifecycle deltas to an exact count above the bounded 200-row page", () => {
    const source = incident();
    expect(
      attentionCountAfterLifecycleTransition(241, source, {
        ...source.lifecycle,
        state: "resolved",
        resolvedAt: "2026-07-23T12:05:00.000Z",
        resolutionReason: "Recovered",
        snoozedUntil: null,
      }, NOW.getTime()),
    ).toBe(240);
    expect(
      attentionCountAfterLifecycleTransition(241, source, {
        ...source.lifecycle,
        readAt: "2026-07-23T12:05:00.000Z",
      }, NOW.getTime()),
    ).toBe(241);
    expect(
      attentionDecisionCountAfterLifecycleTransition(173, source, {
        ...source.lifecycle,
        state: "resolved",
        resolvedAt: "2026-07-23T12:05:00.000Z",
        resolutionReason: "Recovered",
        snoozedUntil: null,
      }, NOW.getTime()),
    ).toBe(172);
    expect(
      attentionDecisionCountAfterLifecycleTransition(173, report(), {
        ...report().lifecycle,
        state: "archived",
        archivedAt: "2026-07-23T12:05:00.000Z",
      }, NOW.getTime()),
    ).toBe(173);
  });

  it("deduplicates overlapping cursor pages", () => {
    expect(
      appendAttentionItems(
        [incident()],
        [incident(), report()],
      ).map((item) => item.notificationId),
    ).toEqual(["incident-1", "report-1"]);
  });

  it("renders exact totals rather than bounded row counts", () => {
    const markup = renderToStaticMarkup(
      <OperatorAgentAlerts
        agent={AGENT}
        attention={{
          items: [incident()],
          openCount: 241,
          requiresDecisionCount: 173,
          nextCursor: "attention-v1.next",
          available: true,
          unavailableReason: null,
        }}
        onAttentionCountChange={() => {}}
        onNavigate={() => {}}
      />,
    );
    expect(markup).toContain("173 decisions needed");
    expect(markup).toContain(">241<");
    expect(markup).toContain("Load older alerts");
  });

  it("renders enriched cards, safe destinations, lifecycle controls, and deep-link highlighting", () => {
    const unsafeIncident = incident({
      id: "attention:unsafe",
      notificationId: "unsafe",
      brief: {
        ...incident().brief,
        headline: "Unsafe action is filtered",
      },
      actions: [
        {
          ...incident().actions[0]!,
          id: "unsafe-action",
          label: "Leave Galactic",
          destination: {
            href: "https://example.com",
            pane: "access",
            itemId: "setting:GMAIL_TOKEN",
          },
        },
      ],
    });
    const attention: LaunchAgentAttentionProjection = {
      items: [incident(), report(), unsafeIncident],
      openCount: 3,
      requiresDecisionCount: 2,
      available: true,
      unavailableReason: null,
    };

    const markup = renderToStaticMarkup(
      <OperatorAgentAlerts
        agent={AGENT}
        attention={attention}
        itemId="incident-1"
        onAttentionCountChange={() => {}}
        onNavigate={() => {}}
      />,
    );

    expect(markup).toContain("email-ops cannot check the inbox");
    expect(markup).toContain("No new email has been processed");
    expect(markup).toContain("The live release requires");
    expect(markup).toContain("Recommended next move");
    expect(markup).toContain("Add credential");
    expect(markup).toContain("Mark read");
    expect(markup).toContain("Snooze 1h");
    expect(markup).toContain("Resolve");
    expect(markup).toContain("Contextualized");
    expect(markup).toContain('id="attention-incident-1"');
    expect(markup).toContain("neb-deep-link-target");
    expect(markup).toContain(
      'href="/agents/email-ops?pane=access&amp;item=setting%3AGMAIL_TOKEN"',
    );
    expect(markup).not.toContain("must-never-render");
    expect(markup).not.toContain("Leave Galactic");
    expect(markup).not.toContain("https://example.com");
  });

  it("renders explicit unavailable and empty states", () => {
    const unavailable = renderToStaticMarkup(
      <OperatorAgentAlerts
        agent={AGENT}
        attention={{
          items: [],
          openCount: 0,
          requiresDecisionCount: 0,
          available: false,
          unavailableReason: "temporarily_unavailable",
        }}
        onAttentionCountChange={() => {}}
        onNavigate={() => {}}
      />,
    );
    const empty = renderToStaticMarkup(
      <OperatorAgentAlerts
        agent={AGENT}
        attention={{
          items: [],
          openCount: 0,
          requiresDecisionCount: 0,
          available: true,
          unavailableReason: null,
        }}
        onAttentionCountChange={() => {}}
        onNavigate={() => {}}
      />,
    );

    expect(unavailable).toContain(
      "Agent Alerts are temporarily unavailable.",
    );
    expect(empty).toContain("Nothing needs your attention.");
  });

  it("renders an explicit stale-item state instead of the ordinary empty state", () => {
    const markup = renderToStaticMarkup(
      <OperatorAgentAlerts
        agent={AGENT}
        attention={{
          items: [],
          openCount: 0,
          requiresDecisionCount: 0,
          available: true,
          unavailableReason: null,
        }}
        itemId="missing-alert"
        onAttentionCountChange={() => {}}
        onClearItem={() => {}}
        onNavigate={() => {}}
      />,
    );

    expect(markup).toContain(
      "This alert is no longer available for this Agent.",
    );
    expect(markup).toContain("Return to Alerts");
    expect(markup).not.toContain("Nothing needs your attention.");
  });

  it("supports the embedded account view and filters on enriched context", () => {
    const markup = renderToStaticMarkup(
      <OperatorAgentAlerts
        agent={AGENT}
        attention={{
          items: [incident(), report()],
          openCount: 2,
          requiresDecisionCount: 1,
          available: true,
          unavailableReason: null,
        }}
        embedded
        onAttentionCountChange={() => {}}
        onNavigate={() => {}}
        query="credential"
      />,
    );
    expect(markup).toContain("email-ops");
    expect(markup).toContain("email-ops cannot check the inbox");
    expect(markup).not.toContain("Daily report");
    expect(markup).not.toContain("The bell keeps the account-wide");
  });
});
