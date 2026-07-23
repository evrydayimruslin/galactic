import { describe, expect, it } from "vitest";

import {
  moveFleetAgentBefore,
  moveFleetAgentByOffset,
} from "./fleet-order";

describe("Fleet ordering", () => {
  const ids = ["agent-a", "agent-b", "agent-c", "agent-d"];

  it("moves a dragged Agent before its drop target without losing ids", () => {
    expect(moveFleetAgentBefore(ids, "agent-d", "agent-b")).toEqual([
      "agent-a",
      "agent-d",
      "agent-b",
      "agent-c",
    ]);
    expect(ids).toEqual(["agent-a", "agent-b", "agent-c", "agent-d"]);
  });

  it("handles forward drag indexes after removing the source", () => {
    expect(moveFleetAgentBefore(ids, "agent-a", "agent-d")).toEqual([
      "agent-b",
      "agent-c",
      "agent-a",
      "agent-d",
    ]);
  });

  it("returns null for no-ops and unknown Agents", () => {
    expect(moveFleetAgentBefore(ids, "agent-b", "agent-b")).toBeNull();
    expect(moveFleetAgentBefore(ids, "unknown", "agent-b")).toBeNull();
    expect(moveFleetAgentBefore(ids, "agent-a", "agent-b")).toBeNull();
  });

  it("moves one stable position and fences both ends", () => {
    expect(moveFleetAgentByOffset(ids, "agent-c", -1)).toEqual([
      "agent-a",
      "agent-c",
      "agent-b",
      "agent-d",
    ]);
    expect(moveFleetAgentByOffset(ids, "agent-c", 1)).toEqual([
      "agent-a",
      "agent-b",
      "agent-d",
      "agent-c",
    ]);
    expect(moveFleetAgentByOffset(ids, "agent-a", -1)).toBeNull();
    expect(moveFleetAgentByOffset(ids, "agent-d", 1)).toBeNull();
  });
});
