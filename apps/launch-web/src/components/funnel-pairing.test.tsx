import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LaunchFunnelPairingProjection } from "../../../../shared/contracts/launch";
import { resolveLaunchRoute } from "../lib/routes";
import { FunnelPairingView, funnelStageRows } from "./funnel-pairing";

function projection(
  overrides: Partial<LaunchFunnelPairingProjection> = {},
): LaunchFunnelPairingProjection {
  return {
    pairingCode: "abcdefghjkmnpqrs2345",
    surface: "cli",
    status: "staged",
    createdAt: "2026-08-03T21:00:00.000Z",
    connectedAt: "2026-08-03T21:02:00.000Z",
    stagedAt: "2026-08-03T21:05:00.000Z",
    testedAt: null,
    uploadedAt: null,
    promotedAt: null,
    handoffExpiresAt: "2026-08-03T22:00:00.000Z",
    returnWindowExpiresAt: "2026-08-10T21:00:00.000Z",
    claimed: false,
    reservedAgentId: "00000000-0000-4000-8000-000000000004",
    agentName: null,
    uploadedVersion: null,
    ...overrides,
  };
}

describe("funnel pairing watch page", () => {
  it("routes /b/:code to the pairing page with its code", () => {
    const resolved = resolveLaunchRoute("/b/abcdefghjkmnpqrs2345");
    expect(resolved.definition.key).toBe("pairing");
    expect(resolved.params.code).toBe("abcdefghjkmnpqrs2345");
  });

  it("renders the six ledger stages in order, marking progress honestly", () => {
    const rows = funnelStageRows(projection());
    expect(rows.map((row) => row.key)).toEqual([
      "handed_off",
      "connected",
      "staged",
      "tested",
      "uploaded",
      "promoted",
    ]);

    const markup = renderToStaticMarkup(
      <FunnelPairingView projection={projection()} />,
    );
    expect(markup).toContain("Watching a build");
    expect(markup).toContain("Your agent");
    expect(markup).toContain("Coding agent connected");
    expect(markup).toContain("Exact-tested");
    expect(markup).toContain("in progress");
    expect(markup).toContain("7 days");
  });

  it("names the agent only once an upload names it", () => {
    const markup = renderToStaticMarkup(
      <FunnelPairingView
        projection={projection({
          agentName: "Invoice Chaser",
          uploadedVersion: "1.0.0",
          uploadedAt: "2026-08-03T21:20:00.000Z",
          testedAt: "2026-08-03T21:15:00.000Z",
        })}
      />,
    );
    expect(markup).toContain("Invoice Chaser");
    expect(markup).toContain("v1.0.0");
  });

  it("keeps the watch page free of credential-shaped content", () => {
    const markup = renderToStaticMarkup(
      <FunnelPairingView projection={projection()} />,
    );
    for (const forbidden of ["gx_", "plaintext", "tokenPrefix", "Bearer"]) {
      expect(markup).not.toContain(forbidden);
    }
  });

  it("offers Run it once after upload, then renders the held card", () => {
    const uploaded = projection({
      uploadedAt: "2026-08-03T21:20:00.000Z",
      testedAt: "2026-08-03T21:15:00.000Z",
    });
    const before = renderToStaticMarkup(
      <FunnelPairingView projection={uploaded} />,
    );
    expect(before).toContain("Run it once");

    const withCard = renderToStaticMarkup(
      <FunnelPairingView
        projection={{
          ...uploaded,
          heldCard: {
            envelopeId: "env-1",
            functionName: "send_email",
            consequence: "external_side_effect",
            status: "pending",
            createdAt: "2026-08-03T21:30:00.000Z",
            expiresAt: "2026-08-10T21:30:00.000Z",
            seedSentence: "sending anything to a human",
          },
          trialRunsUsed: 1,
          trialRunLimit: 3,
        }}
      />,
    );
    expect(withCard).toContain("Held by your policy");
    expect(withCard).toContain(
      "It must ask me before sending anything to a human.",
    );
    expect(withCard).toContain("send_email");
    expect(withCard).toContain("denying and editing are always free");
    expect(withCard).not.toContain("Run it once");
    for (const forbidden of ["gx_", "plaintext", "Bearer"]) {
      expect(withCard).not.toContain(forbidden);
    }
  });

  it("switches to the claimed voice after a claim", () => {
    const markup = renderToStaticMarkup(
      <FunnelPairingView
        projection={projection({ claimed: true })}
      />,
    );
    expect(markup).toContain("claimed");
    expect(markup).toContain("Open the fleet");
    expect(markup).not.toContain("Sign in to claim");
  });
});
