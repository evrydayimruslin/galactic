import { describe, expect, it } from "vitest";

import type {
  LaunchAgentHomeResponse,
  LaunchAgentOperatingState,
} from "../../../../../shared/contracts/launch.ts";
import {
  shouldShowAgentSetup,
  studioStatus,
} from "../../lib/agent-studio-state";

function homeState(overrides: {
  health?: LaunchAgentHomeResponse["state"]["health"];
  lifecycle?: LaunchAgentHomeResponse["state"]["lifecycle"];
  live?: boolean;
  mode?: LaunchAgentOperatingState;
  recentRuns?: number;
  setupReady?: boolean;
} = {}): LaunchAgentHomeResponse {
  const mode = overrides.mode ?? "standing_by";
  return {
    release: {
      live: overrides.live === false ? null : { version: "2.2.0" },
    },
    operatingSummary: {
      mode,
      readiness: {
        working: mode === "running",
      },
    },
    recentRuns: Array.from(
      { length: overrides.recentRuns ?? 1 },
      (_, index) => ({ id: `run-${index}` }),
    ),
    setup: {
      ready: overrides.setupReady ?? true,
    },
    state: {
      health: overrides.health ?? "healthy",
      lifecycle: overrides.lifecycle ?? "active",
    },
  } as unknown as LaunchAgentHomeResponse;
}

describe("Agent Studio derived state", () => {
  it("shows setup only for genuinely new or unconfigured Agents", () => {
    expect(shouldShowAgentSetup(homeState({ live: false }))).toBe(true);
    expect(shouldShowAgentSetup(
      homeState({ mode: "no_enabled_routine" }),
    )).toBe(true);
    expect(shouldShowAgentSetup(
      homeState({
        lifecycle: "needs_setup",
        recentRuns: 0,
        setupReady: false,
      }),
    )).toBe(true);
  });

  it("keeps established paused and repairable Agents in their mature view", () => {
    expect(shouldShowAgentSetup(
      homeState({ lifecycle: "paused", mode: "paused" }),
    )).toBe(false);
    expect(shouldShowAgentSetup(
      homeState({
        lifecycle: "needs_setup",
        recentRuns: 4,
        setupReady: false,
      }),
    )).toBe(false);
  });

  it("does not flatten disabled or failing Agents into Waiting", () => {
    expect(studioStatus(
      homeState({ lifecycle: "disabled", mode: "disabled" }),
    )).toEqual({ label: "Disabled", tone: "stopped" });
    expect(studioStatus(
      homeState({ health: "failing", mode: "error" }),
    )).toEqual({ label: "Error", tone: "stopped" });
    expect(studioStatus(
      homeState({ lifecycle: "paused", mode: "paused" }),
    )).toEqual({ label: "Paused", tone: "stopped" });
  });
});
