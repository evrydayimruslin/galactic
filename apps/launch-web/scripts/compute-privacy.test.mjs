import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const computePane = readFileSync(
  new URL("../src/components/agent-compute-pane.tsx", import.meta.url),
  "utf8",
);
const computeContract = readFileSync(
  new URL("../src/lib/compute.ts", import.meta.url),
  "utf8",
);
const agentOverview = readFileSync(
  new URL("../src/components/agent-home-overview.tsx", import.meta.url),
  "utf8",
);

describe("user-facing Compute privacy contracts", () => {
  it("never renders exact monetary accounting or receipt data", () => {
    expect(computePane).not.toMatch(/\bLight\b/);
    expect(computePane).not.toMatch(/run\.usage/);
    expect(computePane).not.toMatch(/run\.billingMode/);
    expect(computePane).not.toMatch(/run\.receipt(?:Id|Url)/);
    expect(computePane).not.toMatch(
      /<small>(?:Reserved|Actual|True-up|Backed by)<\/small>/,
    );
    expect(computePane).not.toMatch(/Receipt (?:pending|\{)/);
  });

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
