import { describe, expect, it, vi } from "vitest";

import type { LaunchComputeRunSummary } from "../lib/compute";
import { parseAgentRouteState } from "../lib/agent-route-state";
import {
  loadComputeRunsForTarget,
  normalizeComputeRunTarget,
} from "./agent-compute-pane";

const TARGET_RUN_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_RUN_ID = "88888888-8888-4888-8888-888888888888";

function run(runId: string): LaunchComputeRunSummary {
  return {
    runId,
    receiptId: null,
    receiptUrl: null,
    billingMode: "subscription_capacity",
    status: "completed",
    agentId: "agent-1",
    agentName: "email-ops",
    functionName: "check_inbox",
    createdAt: "2026-07-23T12:00:00.000Z",
    startedAt: "2026-07-23T12:00:01.000Z",
    finishedAt: "2026-07-23T12:00:02.000Z",
    usage: {
      reserved: 1,
      actual: 1,
      trueUp: 0,
      unit: "compute_second",
    },
    exitCode: 0,
    infraFailure: null,
    artifacts: [],
    cancellable: false,
  };
}

describe("Compute run direct links", () => {
  it("loads through owner-scoped history until the URL target is resolved", async () => {
    const route = parseAgentRouteState({
      pathname: "/agents/email-ops",
      search: `?pane=compute&item=${TARGET_RUN_ID}`,
    });
    const loadPage = vi.fn(async (cursor?: string) =>
      cursor === "page-2"
        ? { runs: [run(TARGET_RUN_ID)], next_cursor: "page-3" }
        : { runs: [run(OTHER_RUN_ID)], next_cursor: "page-2" }
    );

    const result = await loadComputeRunsForTarget(loadPage, route?.item);

    expect(route).toEqual({
      slug: "email-ops",
      pane: "compute",
      item: TARGET_RUN_ID,
    });
    expect(loadPage.mock.calls).toEqual([[], ["page-2"]]);
    expect(result.targetState).toBe("found");
    expect(result.targetRunId).toBe(TARGET_RUN_ID);
    expect(result.runs.map((item) => item.runId)).toEqual([
      OTHER_RUN_ID,
      TARGET_RUN_ID,
    ]);
    expect(result.nextCursor).toBe("page-3");
  });

  it("returns a stale target after a bounded scan instead of issuing unbounded requests", async () => {
    const loadPage = vi.fn(async (cursor?: string) => ({
      runs: [run(OTHER_RUN_ID)],
      next_cursor: cursor === "page-2" ? "page-3" : "page-2",
    }));

    const result = await loadComputeRunsForTarget(
      loadPage,
      TARGET_RUN_ID,
      2,
    );

    expect(loadPage.mock.calls).toEqual([[], ["page-2"]]);
    expect(result.targetState).toBe("stale");
    expect(result.nextCursor).toBe("page-3");
  });

  it.each([
    "javascript:alert(1)",
    "../../../../settings",
    "[data-secret]",
    `${TARGET_RUN_ID}#receipt`,
    "not-a-run",
  ])("never uses an unsafe item target: %s", async (itemId) => {
    const loadPage = vi.fn(async () => ({
      runs: [run(OTHER_RUN_ID)],
      next_cursor: "page-2",
    }));

    const result = await loadComputeRunsForTarget(loadPage, itemId);

    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadPage).toHaveBeenCalledWith();
    expect(result.targetRunId).toBeNull();
    expect(result.targetState).toBe("invalid");
  });

  it("normalizes UUID casing and rejects non-UUID item identifiers", () => {
    expect(normalizeComputeRunTarget(` ${TARGET_RUN_ID.toUpperCase()} `))
      .toBe(TARGET_RUN_ID);
    expect(normalizeComputeRunTarget("run-1")).toBeNull();
    expect(normalizeComputeRunTarget(null)).toBeNull();
  });
});
