import { describe, expect, it } from "vitest";
import {
  prefixesOverlap,
  verifyComputeR2Lifecycle,
} from "../scripts/verify-r2-lifecycle.mjs";

function payload(rules) {
  return { success: true, result: { rules } };
}

const safeAbort = {
  id: "compute-incomplete-uploads",
  enabled: true,
  conditions: { prefix: "compute-v1/" },
  abortMultipartUploadsTransition: {
    condition: { type: "Age", maxAge: 86_400 },
  },
};

const safeCheckpointExpiry = {
  id: "compute-finalization-checkpoints",
  enabled: true,
  conditions: { prefix: "_galactic-control/v1/compute-finalization/" },
  deleteObjectsTransition: {
    condition: { type: "Age", maxAge: 86_400 },
  },
};

describe("Compute R2 lifecycle release gate", () => {
  it("accepts a multipart-only rule and unrelated object expiration", () => {
    expect(() =>
      verifyComputeR2Lifecycle(payload([
        safeAbort,
        safeCheckpointExpiry,
        {
          id: "unrelated-expiry",
          enabled: true,
          conditions: { prefix: "other/" },
          deleteObjectsTransition: {
            condition: { type: "Age", maxAge: 86_400 },
          },
        },
      ]))
    ).not.toThrow();
  });

  for (const prefix of ["", "compute-", "compute-v1/", "compute-v1/owner/"]) {
    it(`rejects object expiration on overlapping prefix ${JSON.stringify(prefix)}`, () => {
      expect(() =>
        verifyComputeR2Lifecycle(payload([
          safeAbort,
          safeCheckpointExpiry,
          {
            id: "dangerous-expiry",
            enabled: true,
            conditions: { prefix },
            deleteObjectsTransition: {
              condition: { type: "Age", maxAge: 2_592_000 },
            },
          },
        ]))
      ).toThrow(/Database reconciliation owns artifact deletion/u);
    });
  }

  it("rejects a missing or too-slow multipart abort", () => {
    expect(() => verifyComputeR2Lifecycle(payload([]))).toThrow(/multipart/u);
    expect(() =>
      verifyComputeR2Lifecycle(payload([{
        ...safeAbort,
        abortMultipartUploadsTransition: {
          condition: { type: "Age", maxAge: 86_401 },
        },
      }, safeCheckpointExpiry]))
    ).toThrow(/multipart/u);
  });

  it("requires an exact, bounded checkpoint expiry that cannot race active replay", () => {
    expect(() => verifyComputeR2Lifecycle(payload([safeAbort]))).toThrow(
      /abandoned checkpoints/u,
    );
    for (const maxAge of [3_599, 3_600, 86_399, 86_401]) {
      expect(() =>
        verifyComputeR2Lifecycle(payload([
          safeAbort,
          {
            ...safeCheckpointExpiry,
            deleteObjectsTransition: {
              condition: { type: "Age", maxAge },
            },
          },
        ]))
      ).toThrow(/exactly one day/u);
    }
    expect(() =>
      verifyComputeR2Lifecycle(payload([
        safeAbort,
        {
          ...safeCheckpointExpiry,
          conditions: {
            prefix: "_galactic-control/v1/compute-finalization/child/",
          },
        },
      ]))
    ).toThrow(/race or escape the checkpoint bound/u);
    expect(() =>
      verifyComputeR2Lifecycle(payload([
        safeAbort,
        safeCheckpointExpiry,
        {
          id: "checkpoint-ancestor-too-fast",
          enabled: true,
          conditions: { prefix: "_galactic-control/" },
          deleteObjectsTransition: {
            condition: { type: "Age", maxAge: 60 },
          },
        },
      ]))
    ).toThrow(/race or escape the checkpoint bound/u);
  });

  it("fails closed on malformed Cloudflare responses", () => {
    expect(() => verifyComputeR2Lifecycle({ success: false })).toThrow(
      /invalid/u,
    );
    expect(() => verifyComputeR2Lifecycle({
      success: true,
      result: {},
    })).toThrow(/omitted rules/u);
  });

  it("classifies ancestor, exact, and descendant prefixes as overlapping", () => {
    expect(prefixesOverlap("compute-v1/", "")).toBe(true);
    expect(prefixesOverlap("compute-v1/", "compute-v1/")).toBe(true);
    expect(prefixesOverlap("compute-v1/", "compute-v1/run/")).toBe(true);
    expect(prefixesOverlap("compute-v1/", "other/")).toBe(false);
  });
});
