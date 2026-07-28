import { describe, expect, it } from "vitest";

import type {
  LaunchAgentHomeResponse,
} from "../../../../../shared/contracts/launch.ts";
import {
  candidateSignal,
  galacticUsagePercent,
} from "./agent-studio-overview";

type Candidate = NonNullable<
  LaunchAgentHomeResponse["release"]["candidate"]
>;

function candidate(
  overrides: Partial<Candidate> = {},
): Candidate {
  return {
    authorityChanges: [],
    canPromote: true,
    reviewStatus: "ready",
    sourceFingerprint: "sha256:bundle",
    testedAt: "2026-07-27T12:00:00.000Z",
    uploadedAt: "2026-07-27T12:01:00.000Z",
    version: "2.2.0",
    ...overrides,
  };
}

describe("Agent Studio Overview projections", () => {
  it("never certifies an unavailable or untested candidate", () => {
    expect(candidateSignal(candidate({
      canPromote: false,
      reviewStatus: "unavailable",
    }))).toEqual({
      detail:
        "Version 2.2.0 is staged, but its review state is unavailable. Open Settings for diagnostics.",
      title: "A staged release needs attention",
    });
    expect(candidateSignal(candidate({ testedAt: null })).title)
      .toBe("A staged release needs review");
    expect(candidateSignal(candidate()).title)
      .toBe("A staged release is ready");
  });

  it("uses the weekly window rather than silently preferring burst usage", () => {
    const home = {
      agentCapacity: {
        burst: {
          capUsedPercent: 8,
        },
        capPercent: 20,
        weekly: {
          capUsedPercent: 96,
        },
      },
    } as unknown as LaunchAgentHomeResponse;

    expect(galacticUsagePercent(home)).toBe(96);
  });
});
