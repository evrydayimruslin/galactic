import { describe, expect, it } from "vitest";
import { verifyComputeR2Private } from "../scripts/verify-r2-private.mjs";

const managedDisabled = {
  success: true,
  result: { enabled: false, domain: "example.r2.dev" },
};
const noCustomDomains = { success: true, result: { domains: [] } };

describe("Compute R2 private-access release gate", () => {
  it("accepts disabled r2.dev access with no custom domains", () => {
    expect(() => verifyComputeR2Private(managedDisabled, noCustomDomains)).not.toThrow();
  });

  it("rejects an enabled r2.dev URL", () => {
    expect(() => verifyComputeR2Private(
      { success: true, result: { enabled: true } },
      noCustomDomains,
    )).toThrow(/development URL/u);
  });

  it("rejects every attached custom domain, including a disabled one", () => {
    for (const enabled of [true, false]) {
      expect(() => verifyComputeR2Private(managedDisabled, {
        success: true,
        result: { domains: [{ domain: "artifacts.example.com", enabled }] },
      })).toThrow(/no attached custom domains/u);
    }
  });

  it("fails closed on malformed Cloudflare responses", () => {
    expect(() => verifyComputeR2Private(
      { success: false },
      noCustomDomains,
    )).toThrow(/invalid/u);
    expect(() => verifyComputeR2Private(
      managedDisabled,
      { success: true, result: {} },
    )).toThrow(/omitted domains/u);
  });
});
