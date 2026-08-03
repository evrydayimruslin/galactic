import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The Compute pane itself left the Studio (config moved to skills/docs);
// the privacy contract lives on for the browser-side compute types and the
// overview surfaces that still exist.
const computeContract = readFileSync(
  new URL("../src/lib/compute.ts", import.meta.url),
  "utf8",
);
const agentOverview = readFileSync(
  new URL("../src/components/agent-home-overview.tsx", import.meta.url),
  "utf8",
);

describe("user-facing Compute privacy contracts", () => {
  it("does not model private monetary fields in the browser contract", () => {
    expect(computeContract).not.toMatch(/\bLight\b/);
    expect(computeContract).not.toMatch(/interface LaunchComputeUsage/);
    expect(computeContract).not.toMatch(
      /^\s+(?:receiptId|receiptUrl|billingMode|usage):/m,
    );
  });

  it("does not render exact run-spend figures in Agent overview surfaces", () => {
    expect(agentOverview).not.toMatch(
      /Usage \{formatNumber\(run\.workUnits\)\}/,
    );
    expect(agentOverview).not.toMatch(
      /formatNumber\(snapshot\.budget\.usage\.(?:lastRun|daily|monthly)\)/,
    );
    expect(agentOverview).not.toContain("Cost &amp; rate limits");
  });
});
