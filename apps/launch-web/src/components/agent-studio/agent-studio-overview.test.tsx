import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  LaunchAgentHomeRequirement,
  LaunchAgentHomeResponse,
} from "../../../../../shared/contracts/launch.ts";
import { AgentStudioOverview } from "./agent-studio-overview";

const CALLER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const CAPABILITY_ID = "33333333-3333-4333-8333-333333333333";

function requirement(
  kind: "capability" | "grant",
): LaunchAgentHomeRequirement {
  return {
    actionId: kind === "capability" ? CAPABILITY_ID : null,
    actions: kind === "capability" ? ["approve"] : [],
    blocking: true,
    configured: false,
    description: kind === "capability"
      ? "Read invoice status before sending a digest."
      : "Mail Agent · send_digest",
    destination: null,
    group: "Cross-Agent calls",
    help: null,
    id: `${kind}:${CAPABILITY_ID}`,
    input: null,
    kind,
    label: kind === "capability"
      ? "Read invoice status"
      : "Mail Agent",
    placeholder: null,
    required: true,
    secret: false,
    settingKey: null,
    settingScope: null,
    updatedAt: null,
  };
}

function setupHome({
  authorityTarget = TARGET_ID,
  capabilityAppId = TARGET_ID,
  setupRequirement,
}: {
  authorityTarget?: string | null;
  capabilityAppId?: string | null;
  setupRequirement: LaunchAgentHomeRequirement;
}): LaunchAgentHomeResponse {
  return {
    actions: {
      canActivate: false,
      canApproveCapabilities: true,
    },
    activity: {
      recent: [],
    },
    agent: {
      description: null,
      id: CALLER_ID,
      name: "Invoice operator",
      slug: "invoice-operator",
      visibility: "private",
    },
    agentCapacity: null,
    attention: {
      items: [],
      openCount: 0,
    },
    authority: {
      items: [{
        actionId: CAPABILITY_ID,
        source: "routine",
        target: authorityTarget,
      }],
    },
    capacity: null,
    operatingSummary: {
      mode: "setup_required",
      readiness: {
        working: false,
      },
    },
    recentRuns: [],
    release: {
      candidate: null,
      live: {
        version: "1.0.0",
      },
    },
    responsibility: {
      cadence: null,
      mission: "Keep invoice owners informed.",
      reporting: {
        configured: true,
        kind: "galactic_inbox",
        label: "Galactic inbox",
      },
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
      ready: false,
      requirements: [setupRequirement],
    },
    state: {
      lifecycle: "needs_setup",
    },
  } as unknown as LaunchAgentHomeResponse;
}

function renderSetup(home: LaunchAgentHomeResponse): string {
  return renderToStaticMarkup(
    <AgentStudioOverview
      activationBusy={false}
      endpoint={null}
      favoriteInterfaceIds={[]}
      home={home}
      interfaces={[]}
      onActivate={vi.fn()}
      onApproveSetupCapability={vi.fn()}
      onNavigate={vi.fn()}
      onOpenPane={vi.fn()}
      onRemediateSetupGrant={vi.fn()}
      setupActionBusy={null}
      setupActionError=""
    />,
  );
}

describe("Agent Studio setup authority", () => {
  it("names the capability and keeps its approval separate from a grant", () => {
    const markup = renderSetup(setupHome({
      setupRequirement: requirement("capability"),
    }));

    expect(markup).toContain("Approve declared capability");
    expect(markup).toContain("Read invoice status before sending a digest.");
    expect(markup).toContain("requires a separate, bounded grant");
    expect(markup).toContain("Approve capability");
  });

  it("offers an explicit, bounded cross-Agent grant action", () => {
    const markup = renderSetup(setupHome({
      setupRequirement: requirement("grant"),
    }));

    expect(markup).toContain("Authorize cross-Agent access");
    expect(markup).toContain("Mail Agent");
    expect(markup).toContain("send_digest");
    expect(markup).toContain("5,000-credit monthly default");
    expect(markup).toContain("Authorize bounded grant");
  });

  it("routes a stale target/function edge to repair instead of authorization", () => {
    const markup = renderSetup(setupHome({
      authorityTarget: null,
      capabilityAppId: null,
      setupRequirement: requirement("grant"),
    }));

    expect(markup).toContain("Repair cross-Agent access");
    expect(markup).toContain("Update and retest the release");
    expect(markup).toContain("Review capabilities");
    expect(markup).not.toContain("Authorize bounded grant");
  });
});
