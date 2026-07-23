import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { LaunchAgentRoutineOverview } from "../../shared/contracts/launch.ts";
import {
  buildAgentDirective,
  buildAgentOperatingSummary,
  deriveAgentWorkingReadiness,
} from "./agent-operating-state.ts";

const NOW = new Date("2026-07-23T12:00:00.000Z");

function routine(
  id: string,
  overrides: Partial<LaunchAgentRoutineOverview> = {},
): LaunchAgentRoutineOverview {
  return {
    id,
    name: `Routine ${id}`,
    description: null,
    role: "routine",
    status: "active",
    health: "active",
    mission: `Perform responsibility ${id}.`,
    schedule: {
      kind: "interval",
      intervalSeconds: 300,
      label: "Every 5 minutes",
    },
    nextOccurrences: [],
    budgets: {
      maxLightPerRun: 10,
      maxLightPerDay: 100,
      maxLightPerMonth: 1000,
      maxCallsPerRun: 5,
    },
    capabilities: [],
    blockers: [],
    reportingDestination: {
      kind: "galactic_inbox",
      label: "Galactic inbox",
    },
    nextRunAt: "2026-07-23T12:05:00.000Z",
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    failureCount: 0,
    autoPauseReason: null,
    errorReason: null,
    recentRuns: [],
    actions: {
      canApproveCapabilities: false,
      canActivate: false,
      canPause: true,
      canRunNow: true,
    },
    ...overrides,
  };
}

Deno.test("agent operating state: strict readiness excludes paused and failing Agents", () => {
  assertEquals(
    deriveAgentWorkingReadiness({
      hasLiveRelease: true,
      setupReady: true,
      routines: [routine("paused", { status: "paused", health: "paused" })],
    }),
    {
      working: false,
      ready: false,
      exclusionReason: "paused",
      activeRoutineCount: 0,
      totalRoutineCount: 1,
    },
  );
  assertEquals(
    deriveAgentWorkingReadiness({
      hasLiveRelease: true,
      setupReady: true,
      routines: [
        routine("healthy"),
        routine("failed", { status: "error", health: "error" }),
      ],
    }).exclusionReason,
    "error",
  );
  assertEquals(
    deriveAgentWorkingReadiness({
      hasLiveRelease: true,
      setupReady: true,
      routines: [routine("approval", { health: "needs_approval" })],
    }).exclusionReason,
    "setup_required",
  );
});

Deno.test("agent operating state: an active routine may work beside a paused sibling", () => {
  const readiness = deriveAgentWorkingReadiness({
    hasLiveRelease: true,
    setupReady: true,
    routines: [
      routine("active"),
      routine("paused", { status: "paused", health: "paused" }),
    ],
  });
  assertEquals(readiness.working, true);
  assertEquals(readiness.activeRoutineCount, 1);
});

Deno.test("agent operating state: setup and failure outrank running in multi-routine summaries", () => {
  const running = routine("running", { health: "running" });
  const failing = routine("failing", {
    status: "error",
    health: "error",
    errorReason: "provider_unavailable",
  });
  assertEquals(
    buildAgentOperatingSummary({
      now: NOW,
      hasLiveRelease: true,
      setupReady: false,
      routines: [running, failing],
    }).mode,
    "setup_required",
  );
  const summary = buildAgentOperatingSummary({
    now: NOW,
    hasLiveRelease: true,
    setupReady: true,
    routines: [running, failing],
  });
  assertEquals(summary.mode, "error");
  assertEquals(summary.routineId, "failing");
  assertEquals(summary.evidence[0]?.sourceId, "failing");
});

Deno.test("agent operating state: scheduled state is independent of Agent or routine naming", () => {
  const first = buildAgentOperatingSummary({
    now: NOW,
    hasLiveRelease: true,
    setupReady: true,
    routines: [routine("one", { name: "Inbox sentinel" })],
  });
  const second = buildAgentOperatingSummary({
    now: NOW,
    hasLiveRelease: true,
    setupReady: true,
    routines: [routine("two", { name: "Totally unrelated words" })],
  });
  assertEquals(first.mode, "scheduled");
  assertEquals(first.label, second.label);
});

Deno.test("agent operating state: directive follows the primary routine", () => {
  const directive = buildAgentDirective({
    routines: [
      routine("secondary"),
      routine("primary", {
        role: "primary",
        mission: "Own inbound triage.",
      }),
    ],
    reportingConfigured: true,
  });
  assertEquals(directive.mission, "Own inbound triage.");
  assertEquals(directive.source, "primary_routine");
  assertEquals(directive.sourceRoutineId, "primary");
  assertEquals(directive.reporting.configured, true);
});
