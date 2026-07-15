import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AgentGrantSummary } from "../../shared/contracts/agent-grants.ts";
import type {
  LaunchAgentRoutineOverview,
  LaunchFunctionSummary,
} from "../../shared/contracts/launch.ts";
import {
  agentHomeCallTargetKey,
  type AgentHomeBuildInput,
  buildAgentHomeResponse,
} from "./agent-home.ts";

const NOW = new Date("2026-07-14T20:00:00.000Z");
const APP_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const ROUTINE_ID = "33333333-3333-4333-8333-333333333333";
const CAPABILITY_ID = "44444444-4444-4444-8444-444444444444";

function grant(status: "active" | "pending" | "revoked" = "active"): AgentGrantSummary {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    callerApp: { id: APP_ID, slug: "watcher", name: "Watcher" },
    targetApp: { id: TARGET_ID, slug: "archive", name: "Archive" },
    callerFunction: null,
    slot: null,
    targetFunction: "store",
    topic: null,
    mode: "call",
    status,
    monthlyCapCredits: 100,
    spentCreditsPeriod: 2,
    periodStart: "2026-07-01T00:00:00.000Z",
    createdBy: "user",
    updatedAt: "2026-07-14T18:00:00.000Z",
  };
}

function routine(
  overrides: Partial<LaunchAgentRoutineOverview> = {},
): LaunchAgentRoutineOverview {
  return {
    id: ROUTINE_ID,
    status: "paused",
    health: "paused",
    mission: "Watch the launch inbox and archive actionable reports.",
    intervalSeconds: 3600,
    budgets: {
      maxLightPerRun: 10,
      maxLightPerDay: 100,
      maxLightPerMonth: 1000,
      maxCallsPerRun: 8,
    },
    capabilities: [{
      id: CAPABILITY_ID,
      appId: TARGET_ID,
      appRef: "archive",
      functionName: "store",
      access: "write",
      required: true,
      purpose: "Archive owner-approved reports.",
      approved: true,
      approvedAt: "2026-07-14T18:00:00.000Z",
    }],
    blockers: [],
    reportingDestination: {
      kind: "galactic_inbox",
      label: "Galactic inbox",
    },
    nextRunAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    failureCount: 0,
    autoPauseReason: null,
    errorReason: null,
    recentRuns: [],
    actions: {
      canApproveCapabilities: false,
      canActivate: true,
      canPause: false,
      canRunNow: false,
    },
    ...overrides,
  };
}

const functions: LaunchFunctionSummary[] = [{
  name: "wake",
  description: "Inspect new reports.",
  annotations: { readOnlyHint: true },
  usesInference: true,
}];

function input(
  overrides: Partial<AgentHomeBuildInput> = {},
): AgentHomeBuildInput {
  return {
    now: NOW,
    revision: "ah1:11111111-1111-4111-8111-111111111111:7",
    agent: {
      id: APP_ID,
      slug: "watcher",
      name: "Watcher",
      description: "A persistent report watcher.",
    },
    manifest: {
      name: "Watcher",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      functions: {},
      permissions: ["ai:call", "app:call", "notify:owner"],
    },
    effectivePermissions: ["ai:call", "app:call", "notify:owner"],
    ignoredPermissions: [],
    functions,
    dependencies: [{ app: "archive", functions: ["store"], access: "write" }],
    callTargets: new Map([
      [agentHomeCallTargetKey(TARGET_ID, "store"), {
        valid: true,
        targetAppId: TARGET_ID,
      }],
      [agentHomeCallTargetKey("archive", "store"), {
        valid: true,
        targetAppId: TARGET_ID,
      }],
    ]),
    grants: [grant()],
    routine: routine(),
    settings: [{
      key: "ARCHIVE_TOKEN",
      scope: "per_user",
      label: "Archive token",
      description: "Credential for the archive API.",
      help: null,
      input: "text",
      placeholder: null,
      group: "Archive",
      required: true,
      configured: true,
      secret: true,
      destination: "archive.example.com",
      updatedAt: "2026-07-14T18:00:00.000Z",
    }],
    disclosure: {
      destinations: [{
        host: "archive.example.com",
        label: "Archive",
        description: "Stores approved reports.",
        credentials: [{
          key: "ARCHIVE_TOKEN",
          label: "Archive token",
          required: true,
          connected: true,
        }],
      }],
      general_settings: [],
    },
    budgetUsage: {
      lastRun: 0,
      lastRunCalls: 0,
      daily: 2,
      monthly: 9,
      dayStartedAt: "2026-07-14T00:00:00.000Z",
      monthStartedAt: "2026-07-01T00:00:00.000Z",
    },
    callsByRun: new Map(),
    release: {
      versions: ["1.0.0"],
      currentVersion: "1.0.0",
      versionMetadata: [{
        version: "1.0.0",
        size_bytes: 10,
        created_at: "2026-07-14T17:00:00.000Z",
        source_hash: "a".repeat(64),
      }],
      promotedAt: "2026-07-14T17:05:00.000Z",
      executedVersion: "1.0.0",
      integrity: "verified",
      candidateAuthorityChanges: [],
      candidateManifestAvailable: false,
      candidatePreflightReady: false,
    },
    ...overrides,
  };
}

Deno.test("agent home: derives an initial ready Agent without conflating health", () => {
  const home = buildAgentHomeResponse(input());
  assertEquals(home.contractVersion, "2026-07-14.v1");
  assertEquals(home.state.lifecycle, "ready");
  assertEquals(home.state.execution, "idle");
  assertEquals(home.state.health, "unknown");
  assert(home.setup.ready);
  assert(home.actions.canActivate);
  assertEquals(home.responsibility.reporting.configured, true);
  const credential = home.setup.requirements.find((item) =>
    item.settingKey === "ARCHIVE_TOKEN"
  );
  assertEquals(credential?.secret, true, "destination-bound credentials are secret");
  assertEquals(credential?.settingScope, "per_user");
});

Deno.test("agent home: an active Agent remains active when new setup blockers appear", () => {
  const base = input();
  const home = buildAgentHomeResponse(input({
    routine: routine({ status: "active", health: "active" }),
    settings: base.settings.map((setting) => ({ ...setting, configured: false })),
    effectivePermissions: ["ai:call", "app:call"],
  }));
  assertEquals(home.state.lifecycle, "active");
  assertEquals(home.setup.ready, false);
  assertEquals(home.responsibility.reporting.configured, false);
  assert(home.state.blockers.some((item) => item.code === "missing_required_setting"));
  assertEquals(home.actions.canRunNow, false);
});

Deno.test("agent home: running takes precedence over queued and recovered health is healthy", () => {
  const runs: LaunchAgentRoutineOverview["recentRuns"] = [{
    id: "run-queued",
    status: "queued",
    trigger: "manual",
    traceId: "66666666-6666-4666-8666-666666666666",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    totalLight: 0,
    summary: null,
    errorCode: null,
    createdAt: "2026-07-14T19:59:00.000Z",
  }, {
    id: "run-running",
    status: "running",
    trigger: "scheduled",
    traceId: "77777777-7777-4777-8777-777777777777",
    startedAt: "2026-07-14T19:58:00.000Z",
    completedAt: null,
    durationMs: null,
    totalLight: 1,
    summary: null,
    errorCode: null,
    createdAt: "2026-07-14T19:58:00.000Z",
  }, {
    id: "run-success",
    status: "succeeded",
    trigger: "scheduled",
    traceId: null,
    startedAt: "2026-07-14T18:00:00.000Z",
    completedAt: "2026-07-14T18:00:10.000Z",
    durationMs: 10_000,
    totalLight: 2,
    summary: "Archived one report.",
    errorCode: null,
    createdAt: "2026-07-14T18:00:00.000Z",
  }];
  const home = buildAgentHomeResponse(input({
    routine: routine({
      status: "active",
      health: "running",
      lastRunAt: runs[0].createdAt,
      lastSuccessAt: runs[2].completedAt,
      recentRuns: runs,
    }),
    callsByRun: new Map([["run-success", 2]]),
  }));
  assertEquals(home.state.execution, "running");
  assertEquals(home.state.health, "healthy");
  assertEquals(home.recentRuns[2].calls, 2);
  assertEquals(home.recentRuns[2].detailUrl, null);
});

Deno.test("agent home: grant approval is not confused with effective authority", () => {
  const home = buildAgentHomeResponse(input({ grants: [grant("pending")] }));
  const capability = home.authority.items.find((item) =>
    item.actionId === CAPABILITY_ID
  );
  assertEquals(capability?.approved, true);
  assertEquals(capability?.effective, false);
  assertEquals(capability?.approvalBasis, "owner_capability_approval");
  const grantRequirement = home.setup.requirements.find((item) =>
    item.kind === "grant"
  );
  assertEquals(grantRequirement?.blocking, true);
  assertEquals(grantRequirement?.actionId, null);
  assertEquals(grantRequirement?.actions, []);
});

Deno.test("agent home: manifest grants never erase a pending routine approval path", () => {
  const pendingRoutine = routine({
    capabilities: [{
      ...routine().capabilities[0],
      approved: false,
      approvedAt: null,
    }],
    actions: {
      ...routine().actions,
      canApproveCapabilities: true,
      canActivate: false,
    },
  });
  const home = buildAgentHomeResponse(input({ routine: pendingRoutine }));
  const routineAuthority = home.authority.items.find((item) =>
    item.source === "routine" && item.actionId === CAPABILITY_ID
  );
  const manifestAuthority = home.authority.items.find((item) =>
    item.source === "manifest" && item.kind === "agent_call" &&
    item.label === "archive.store"
  );
  assertEquals(routineAuthority?.approved, false);
  assertEquals(routineAuthority?.effective, false);
  assertEquals(routineAuthority?.approvalBasis, "pending");
  assertEquals(manifestAuthority?.actionId, null);
  assertEquals(manifestAuthority?.effective, true);
  assertEquals(home.actions.canApproveCapabilities, true);
  assertEquals(
    home.setup.requirements.find((item) =>
      item.id === `capability:${CAPABILITY_ID}`
    )?.blocking,
    true,
  );
});

Deno.test("agent home: caller-function grants do not authorize routine execution", () => {
  const narrowedGrant = { ...grant(), callerFunction: "wake" };
  const home = buildAgentHomeResponse(input({ grants: [narrowedGrant] }));
  const authority = home.authority.items.find((item) =>
    item.actionId === CAPABILITY_ID
  );
  const grantRequirement = home.setup.requirements.find((item) =>
    item.kind === "grant"
  );
  assertEquals(authority?.effective, false);
  assertEquals(grantRequirement?.configured, false);
  assertEquals(grantRequirement?.blocking, true);
});

Deno.test("agent home: a prior-month grant cap starts fresh in the current UTC month", () => {
  const rolledGrant = {
    ...grant(),
    spentCreditsPeriod: 100,
    periodStart: "2026-06-30T23:59:59.000Z",
  };
  const home = buildAgentHomeResponse(input({ grants: [rolledGrant] }));
  const authority = home.authority.items.find((item) =>
    item.actionId === CAPABILITY_ID
  );
  const grantRequirement = home.setup.requirements.find((item) =>
    item.kind === "grant"
  );
  assertEquals(authority?.effective, true);
  assertEquals(grantRequirement?.configured, true);
  assertEquals(grantRequirement?.blocking, false);
});

Deno.test("agent home: stale grants never make a missing target function effective", () => {
  const invalidTargets = new Map([
    [agentHomeCallTargetKey(TARGET_ID, "store"), {
      valid: false,
      targetAppId: TARGET_ID,
    }],
    [agentHomeCallTargetKey("archive", "store"), {
      valid: false,
      targetAppId: TARGET_ID,
    }],
  ]);
  const home = buildAgentHomeResponse(input({ callTargets: invalidTargets }));
  const authority = home.authority.items.find((item) =>
    item.actionId === CAPABILITY_ID
  );
  const grantRequirement = home.setup.requirements.find((item) =>
    item.kind === "grant"
  );
  assertEquals(authority?.approved, true);
  assertEquals(authority?.effective, false);
  assertEquals(grantRequirement?.configured, false);
  assertEquals(grantRequirement?.blocking, true);
  assertStringIncludes(grantRequirement?.description || "", "expose this function");
});

Deno.test("agent home: an ignored network permission never makes destinations effective", () => {
  const home = buildAgentHomeResponse(input({
    manifest: {
      name: "Watcher",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      functions: {},
      permissions: ["ai:call", "app:call", "notify:owner", "net:bogus"],
    },
    effectivePermissions: ["ai:call", "app:call", "notify:owner"],
    ignoredPermissions: ["net:bogus"],
  }));
  const destination = home.authority.items.find((item) =>
    item.id === "network:archive.example.com"
  );
  const unsupported = home.authority.items.find((item) =>
    item.id === "manifest:net:bogus"
  );
  assertEquals(destination?.approved, false);
  assertEquals(destination?.effective, false);
  assertEquals(unsupported?.effective, false);
});

Deno.test("agent home: chooses the newest tested staged release and surfaces integrity", () => {
  const proof = (version: string, hash: string) => ({
    version,
    size_bytes: 12,
    created_at: `2026-07-14T${version === "1.1.0" ? "18" : "19"}:00:00.000Z`,
    source_hash: hash,
    test_attestation: {
      schema_version: 1 as const,
      attestation_id: crypto.randomUUID(),
      mode: "deno_execution" as const,
      source_hash: hash,
      tested_at: "2026-07-14T17:59:00.000Z",
      token_expires_at: "2026-07-14T18:10:00.000Z",
      verified_at: "2026-07-14T18:00:00.000Z",
    },
  });
  const home = buildAgentHomeResponse(input({
    release: {
      versions: ["1.0.0", "1.1.0", "1.2.0", "1.2.0", "1.3.0"],
      currentVersion: "1.0.0",
      versionMetadata: [
        proof("1.1.0", "b".repeat(64)),
        proof("1.2.0", "c".repeat(64)),
        {
          version: "1.3.0",
          size_bytes: 12,
          created_at: "2026-07-14T19:30:00.000Z",
          source_hash: "d".repeat(64),
        },
      ],
      promotedAt: null,
      executedVersion: "0.9.0",
      integrity: "unverified",
      candidateAuthorityChanges: [{
        change: "added",
        path: "permissions:net:fetch",
        label: "permissions › net:fetch",
      }],
      candidateManifestAvailable: true,
      candidatePreflightReady: true,
    },
  }));
  assertEquals(home.release.candidate?.version, "1.2.0");
  assertEquals(home.release.candidateCount, 2);
  assertEquals(home.release.live?.executedVersion, "0.9.0");
  assertEquals(home.release.live?.integrity, "unverified");
  assertEquals(home.state.health, "degraded");
  assert(home.state.blockers.some((item) => item.code === "executed_release_unverified"));
});

Deno.test("agent home: never serializes setting values or attestation tokens", () => {
  const serialized = JSON.stringify(buildAgentHomeResponse(input()));
  assert(!serialized.includes("super-secret-value"));
  assert(!serialized.includes("test_attestation"));
  assertStringIncludes(serialized, "ARCHIVE_TOKEN");
});
