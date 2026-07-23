import { describe, expect, it } from "vitest";

import type { LaunchFleetAgentSummary } from "../../../../shared/contracts/launch.ts";
import {
  fleetAgentAttentionCount,
  fleetStatusPresentation,
  isFleetAgentWorkingOrReady,
} from "./fleet-status";

const NOW = Date.parse("2026-07-21T20:00:00.000Z");

function agent(
  overrides: Partial<LaunchFleetAgentSummary> = {},
): LaunchFleetAgentSummary {
  return {
    agent: {
      id: "agent-1",
      slug: "agent-1",
      name: "Research Agent",
      description: null,
      kind: "mcp",
      visibility: "private",
      relationship: "owner",
      owner: { userId: "user-1" },
      installed: true,
    },
    state: "idle",
    health: "idle",
    routineCount: 0,
    activeRoutineCount: 0,
    nextWakeAt: null,
    lastRunAt: null,
    deferredWakeCount: 0,
    unreadAlertCount: 0,
    recentActivity: [],
    capacity: null,
    ...overrides,
  } as LaunchFleetAgentSummary;
}

describe("fleetStatusPresentation", () => {
  it("describes paused and unconfigured agents without a live signal", () => {
    expect(fleetStatusPresentation(agent({ state: "paused" }), NOW)).toMatchObject({
      label: "Paused",
      showLiveSignal: false,
    });
    expect(fleetStatusPresentation(agent({ state: "unconfigured" }), NOW)).toMatchObject({
      label: "Setup required",
      showLiveSignal: false,
    });
  });

  it("prioritizes errors over a waiting health payload", () => {
    expect(fleetStatusPresentation(agent({ state: "error", health: "waiting" }), NOW).label)
      .toBe("Needs attention");
    expect(fleetStatusPresentation(agent({ state: "active", health: "error" }), NOW).label)
      .toBe("Needs attention");
  });

  it("describes capacity waiting without a live signal", () => {
    expect(fleetStatusPresentation(agent({ health: "waiting" }), NOW)).toMatchObject({
      label: "Waiting for capacity",
      showLiveSignal: false,
    });
  });

  it("shows current and future scheduled work", () => {
    expect(fleetStatusPresentation(agent({ nextWakeAt: new Date(NOW - 2_000).toISOString() }), NOW))
      .toMatchObject({ label: "Working now", waking: true });
    expect(fleetStatusPresentation(agent({ nextWakeAt: new Date(NOW + 90_000).toISOString() }), NOW).label)
      .toBe("Next run in 1m 30s");
  });

  it("does not describe a stale wake timestamp as waking", () => {
    expect(fleetStatusPresentation(agent({
      activeRoutineCount: 1,
      nextWakeAt: new Date(NOW - 60_000).toISOString(),
    }), NOW).label).toBe("Waiting for next event");
  });

  it("uses deterministic operating data rather than role-name guesses", () => {
    expect(fleetStatusPresentation(agent({
      operatingSummary: {
        mode: "event_waiting",
        state: "event_waiting",
        label: "Watching inbox",
        detail: "Check and triage inbound email",
        basis: "subscription",
        routineId: "routine-1",
        routineName: "Check inbox",
        runId: null,
        nextEventAt: null,
        lastObservedAt: null,
        readiness: {
          working: true,
          ready: true,
          exclusionReason: null,
          activeRoutineCount: 1,
          totalRoutineCount: 1,
        },
        evidence: [],
        derivedAt: new Date(NOW).toISOString(),
      },
    }), NOW).label).toBe("Watching inbox");
    expect(fleetStatusPresentation(agent({ activeRoutineCount: 1 }), NOW).label)
      .toBe("Waiting for next event");
    expect(fleetStatusPresentation(agent(), NOW).label).toBe("Standing by");
  });
});

describe("isFleetAgentWorkingOrReady", () => {
  it("excludes actively paused Agents from the working count", () => {
    expect(isFleetAgentWorkingOrReady(agent({ state: "paused" }))).toBe(false);
    expect(isFleetAgentWorkingOrReady(agent({ health: "paused" }))).toBe(false);
  });

  it("keeps operating and temporarily waiting Agents in the working count", () => {
    expect(isFleetAgentWorkingOrReady(agent({ state: "active", health: "healthy" }))).toBe(true);
    expect(isFleetAgentWorkingOrReady(agent({ state: "active", health: "waiting" }))).toBe(true);
  });

  it("prefers canonical readiness over legacy state flags", () => {
    expect(isFleetAgentWorkingOrReady(agent({
      state: "active",
      health: "healthy",
      workingReadiness: {
        working: false,
        ready: false,
        exclusionReason: "setup_required",
        activeRoutineCount: 1,
        totalRoutineCount: 1,
      },
    }))).toBe(false);
  });
});

describe("fleetAgentAttentionCount", () => {
  it("prefers canonical Attention while preserving the legacy fallback", () => {
    expect(
      fleetAgentAttentionCount(
        agent({ attentionCount: 3, unreadAlertCount: 9 }),
      ),
    ).toBe(3);
    expect(fleetAgentAttentionCount(agent({ unreadAlertCount: 2 }))).toBe(2);
  });
});
