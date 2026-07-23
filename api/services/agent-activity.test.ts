import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type {
  LaunchAgentRoutineOverview,
  LaunchAgentRoutineRun,
} from "../../shared/contracts/launch.ts";
import {
  buildAgentActivityPreview,
  excludeAgentActivitySources,
} from "./agent-activity.ts";

const NOW = new Date("2026-07-23T12:00:00.000Z");

function run(
  id: string,
  status: LaunchAgentRoutineRun["status"],
  createdAt: string,
): LaunchAgentRoutineRun {
  return {
    id,
    status,
    trigger: "schedule",
    traceId: null,
    startedAt: createdAt,
    completedAt: status === "running" ? null : createdAt,
    durationMs: status === "running" ? null : 100,
    totalLight: 1,
    summary: `Run ${id}`,
    errorCode: null,
    createdAt,
  };
}

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
    mission: `Mission ${id}`,
    schedule: {
      kind: "interval",
      intervalSeconds: 300,
      label: "Every 5 minutes",
    },
    nextOccurrences: ["2026-07-23T12:05:00.000Z"],
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

Deno.test("agent activity: returns one up next, current work, and three recent items", () => {
  const preview = buildAgentActivityPreview({
    agentSlug: "email-ops",
    now: NOW,
    routines: [routine("one", {
      recentRuns: [
        run("running", "running", "2026-07-23T11:59:00.000Z"),
        run("three", "succeeded", "2026-07-23T11:58:00.000Z"),
        run("two", "failed", "2026-07-23T11:57:00.000Z"),
        run("one", "succeeded", "2026-07-23T11:56:00.000Z"),
        run("old", "succeeded", "2026-07-23T11:55:00.000Z"),
      ],
    })],
  });
  assertEquals(preview.upNext?.id, "scheduled:one:2026-07-23T12:05:00.000Z");
  assertEquals(preview.now.map((item) => item.id), ["run:running"]);
  assertEquals(
    preview.recent.map((item) => item.id),
    ["run:three", "run:two", "run:one"],
  );
  assertEquals(preview.items.length, 5);
  assertEquals(
    preview.upNext?.destination?.href,
    "/agents/email-ops?pane=routines&item=one",
  );
  assertEquals(
    preview.now[0]?.destination?.href,
    "/agents/email-ops?pane=routines&item=one",
  );
});

Deno.test("agent activity: deduplicates schedule aliases and run ids", () => {
  const duplicate = run(
    "same",
    "succeeded",
    "2026-07-23T11:58:00.000Z",
  );
  const preview = buildAgentActivityPreview({
    agentSlug: "email-ops",
    now: NOW,
    routines: [
      routine("one", { recentRuns: [duplicate] }),
      routine("two", {
        nextRunAt: "2026-07-23T12:04:00.000Z",
        nextOccurrences: ["2026-07-23T12:04:00.000Z"],
        recentRuns: [duplicate],
      }),
    ],
  });
  assertEquals(preview.upNext?.id, "scheduled:two:2026-07-23T12:04:00.000Z");
  assertEquals(preview.recent.map((item) => item.id), ["run:same"]);
});

Deno.test("agent activity: uses stable source-derived ids for external items", () => {
  const preview = buildAgentActivityPreview({
    agentSlug: "email-ops",
    now: NOW,
    routines: [],
    additionalItems: [{
      kind: "attention",
      sourceId: "notice-1",
      title: "Credential missing",
      status: "open",
      occurredAt: "2026-07-23T11:59:00.000Z",
    }],
  });
  assertEquals(preview.recent[0]?.id, "attention:notice-1");
  assertEquals(preview.recent[0]?.sourceId, "notice-1");
});

Deno.test("agent activity: compact Overview excludes exact Attention sources only", () => {
  const activity = buildAgentActivityPreview({
    agentSlug: "email-ops",
    now: NOW,
    routines: [routine()],
    additionalItems: [{
      kind: "incident",
      sourceId: "attention-1",
      title: "Inbox setup required",
      status: "open",
      occurredAt: "2026-07-23T14:00:00.000Z",
    }, {
      kind: "compute_run",
      sourceId: "compute-1",
      title: "Compute finished",
      status: "succeeded",
      occurredAt: "2026-07-23T13:00:00.000Z",
    }],
  });

  const filtered = excludeAgentActivitySources(
    activity,
    new Set(["attention-1"]),
  );
  assertEquals(
    filtered.recent.some((item) => item.sourceId === "attention-1"),
    false,
  );
  assertEquals(
    filtered.recent.some((item) => item.sourceId === "compute-1"),
    true,
  );
  assertEquals(
    filtered.items.some((item) => item.sourceId === "attention-1"),
    false,
  );
});
