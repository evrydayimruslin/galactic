import { describe, expect, it } from "vitest";

import type {
  LaunchAgentActivityItem,
  LaunchAgentActivityPreview,
} from "../../../../shared/contracts/launch.ts";
import { mergeAgentActivityPages } from "./operator-activity-state";

function item(id: string): LaunchAgentActivityItem {
  return {
    id,
    kind: "routine_run",
    phase: "recent",
    title: id,
    summary: null,
    status: "succeeded",
    occurredAt: "2026-07-23T00:00:00.000Z",
    scheduledAt: null,
    routineId: null,
    sourceId: id,
    destination: null,
    evidence: [],
  };
}

function page(ids: string[]): LaunchAgentActivityPreview {
  const recent = ids.map(item);
  return {
    upNext: null,
    now: [],
    recent,
    items: recent,
    generatedAt: "2026-07-23T00:00:00.000Z",
  };
}

describe("mergeAgentActivityPages", () => {
  it("appends older events in order and removes overlap", () => {
    expect(
      mergeAgentActivityPages(page(["new", "middle"]), page(["middle", "old"]))
        .recent.map((entry) => entry.id),
    ).toEqual(["new", "middle", "old"]);
  });

  it("uses the incoming first page unchanged", () => {
    const incoming = page(["one"]);
    expect(mergeAgentActivityPages(null, incoming)).toBe(incoming);
  });
});
