import { describe, expect, it, vi } from "vitest";

import type { AgentGrantSummary } from "../../../../../shared/contracts/agent-grants.ts";
import type {
  LaunchAgentHomeResponse,
  LaunchAgentOperatingState,
} from "../../../../../shared/contracts/launch.ts";
import {
  agentStudioSetupCapabilityId,
  agentStudioSetupGrantRequest,
  matchingAgentStudioSetupGrant,
  remediateAgentStudioSetupGrant,
  shouldShowAgentSetup,
  studioStatus,
} from "../../lib/agent-studio-state";

const CALLER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const CAPABILITY_ID = "33333333-3333-4333-8333-333333333333";

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

function grantSetupHome({
  capabilityActionId = CAPABILITY_ID,
  capabilityAppId = TARGET_ID,
  authorityTarget = TARGET_ID,
}: {
  capabilityActionId?: string | null;
  capabilityAppId?: string | null;
  authorityTarget?: string | null;
} = {}): LaunchAgentHomeResponse {
  return {
    actions: {
      canApproveCapabilities: true,
    },
    agent: {
      id: CALLER_ID,
      name: "Inbox operator",
      slug: "inbox-operator",
    },
    authority: {
      items: [{
        actionId: CAPABILITY_ID,
        source: "routine",
        target: authorityTarget,
      }],
    },
    routines: {
      routines: [{
        capabilities: [{
          appId: capabilityAppId,
          functionName: "send_digest",
          id: CAPABILITY_ID,
        }],
      }],
    },
    setup: {
      requirements: [
        {
          actionId: capabilityActionId,
          actions: ["approve"],
          blocking: true,
          id: `capability:${CAPABILITY_ID}`,
          kind: "capability",
          required: true,
        },
        {
          actionId: null,
          actions: [],
          blocking: true,
          id: `grant:${CAPABILITY_ID}`,
          kind: "grant",
          required: true,
        },
      ],
    },
  } as unknown as LaunchAgentHomeResponse;
}

function grant(
  status: AgentGrantSummary["status"],
  overrides: Partial<AgentGrantSummary> = {},
): AgentGrantSummary {
  return {
    callerApp: { id: CALLER_ID, name: "Inbox operator", slug: "inbox-operator" },
    callerFunction: null,
    createdBy: "auto_request",
    id: `grant-${status}`,
    mode: "call",
    monthlyCapCredits: 2_500,
    periodStart: "2026-07-31T12:00:00.000Z",
    slot: null,
    spentCreditsPeriod: 0,
    status,
    targetApp: { id: TARGET_ID, name: "Mail", slug: "mail" },
    targetFunction: "send_digest",
    topic: null,
    updatedAt: "2026-07-31T12:00:00.000Z",
    ...overrides,
  };
}

describe("Agent Studio derived state", () => {
  it("shows setup only for genuinely new or unconfigured Agents", () => {
    expect(shouldShowAgentSetup(homeState({ live: false }))).toBe(true);
    expect(shouldShowAgentSetup(
      homeState({ mode: "no_enabled_routine" }),
    )).toBe(false);
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
    expect(studioStatus(
      homeState({ lifecycle: "ready", mode: "no_enabled_routine" }),
    )).toEqual({ label: "Available on demand", tone: "live" });
  });
});

describe("Agent Studio setup authority remediation", () => {
  it("only returns owner-approvable capability ids", () => {
    const home = grantSetupHome();
    expect(agentStudioSetupCapabilityId(
      home,
      `capability:${CAPABILITY_ID}`,
    )).toBe(CAPABILITY_ID);

    home.setup.requirements[0]!.actions = [];
    expect(agentStudioSetupCapabilityId(
      home,
      `capability:${CAPABILITY_ID}`,
    )).toBeNull();
    expect(agentStudioSetupCapabilityId(
      home,
      `grant:${CAPABILITY_ID}`,
    )).toBeNull();
  });

  it("derives the exact bounded ambient CALL grant from typed routine data", () => {
    expect(agentStudioSetupGrantRequest(
      grantSetupHome(),
      `grant:${CAPABILITY_ID}`,
    )).toEqual({
      callerAppId: CALLER_ID,
      mode: "call",
      monthlyCapCredits: 5_000,
      targetAppId: TARGET_ID,
      targetFunction: "send_digest",
    });

    expect(agentStudioSetupGrantRequest(
      grantSetupHome({ capabilityAppId: "mail-agent" }),
      `grant:${CAPABILITY_ID}`,
    )?.targetAppId).toBe(TARGET_ID);

    expect(agentStudioSetupGrantRequest(
      grantSetupHome({
        authorityTarget: null,
        capabilityAppId: null,
      }),
      `grant:${CAPABILITY_ID}`,
    )).toBeNull();
  });

  it("matches only the exact ambient call edge and prefers active authority", () => {
    const request = agentStudioSetupGrantRequest(
      grantSetupHome(),
      `grant:${CAPABILITY_ID}`,
    )!;
    const pending = grant("pending");
    const active = grant("active");
    expect(matchingAgentStudioSetupGrant([
      grant("active", { callerFunction: "run" }),
      grant("active", { slot: "mailer" }),
      pending,
      active,
    ], request)).toEqual(active);
  });

  it("approves a matching pending proposal without replacing its cap", async () => {
    const pending = grant("pending");
    const active = grant("active", {
      id: pending.id,
      monthlyCapCredits: pending.monthlyCapCredits,
    });
    const client = {
      approveGrant: vi.fn().mockResolvedValue({ grant: active }),
      createGrant: vi.fn(),
      listGrants: vi.fn().mockResolvedValue({ grants: [pending] }),
    };

    await expect(remediateAgentStudioSetupGrant(
      client,
      grantSetupHome(),
      `grant:${CAPABILITY_ID}`,
    )).resolves.toEqual({ grant: active, outcome: "approved" });
    expect(client.approveGrant).toHaveBeenCalledWith(pending.id);
    expect(client.createGrant).not.toHaveBeenCalled();
  });

  it("replays active authority and otherwise creates a bounded owner grant", async () => {
    const active = grant("active");
    const activeClient = {
      approveGrant: vi.fn(),
      createGrant: vi.fn(),
      listGrants: vi.fn().mockResolvedValue({ grants: [active] }),
    };
    await expect(remediateAgentStudioSetupGrant(
      activeClient,
      grantSetupHome(),
      `grant:${CAPABILITY_ID}`,
    )).resolves.toEqual({ grant: active, outcome: "already_active" });
    expect(activeClient.approveGrant).not.toHaveBeenCalled();
    expect(activeClient.createGrant).not.toHaveBeenCalled();

    const created = grant("active", { id: "grant-created" });
    const createClient = {
      approveGrant: vi.fn(),
      createGrant: vi.fn().mockResolvedValue({ grant: created }),
      listGrants: vi.fn().mockResolvedValue({ grants: [] }),
    };
    await expect(remediateAgentStudioSetupGrant(
      createClient,
      grantSetupHome(),
      `grant:${CAPABILITY_ID}`,
    )).resolves.toEqual({ grant: created, outcome: "created" });
    expect(createClient.createGrant).toHaveBeenCalledWith({
      callerAppId: CALLER_ID,
      mode: "call",
      monthlyCapCredits: 5_000,
      targetAppId: TARGET_ID,
      targetFunction: "send_digest",
    });
  });

  it("fails closed before an API call when the release edge is stale", async () => {
    const client = {
      approveGrant: vi.fn(),
      createGrant: vi.fn(),
      listGrants: vi.fn(),
    };
    await expect(remediateAgentStudioSetupGrant(
      client,
      grantSetupHome({
        authorityTarget: null,
        capabilityAppId: null,
      }),
      `grant:${CAPABILITY_ID}`,
    )).rejects.toThrow("Update and retest the release");
    expect(client.listGrants).not.toHaveBeenCalled();
  });
});
