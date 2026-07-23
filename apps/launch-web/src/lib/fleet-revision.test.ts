import { describe, expect, it } from "vitest";

import {
  reconcileFleetPreferenceRead,
  withSharedFleetRevision,
  withSharedPreferenceRevision,
} from "./fleet-revision";

describe("shared Fleet preference revision", () => {
  const fleet = { fleetRevision: "revision-1", agents: ["agent-1"] };
  const preferences = {
    revision: "revision-1",
    shortcutsEnabled: true,
    shortcutMap: { search: "k" },
    updatedAt: "2026-07-23T12:00:00.000Z",
  };

  it("carries an order mutation revision into shortcut preferences", () => {
    const nextFleet = withSharedFleetRevision(fleet, "revision-2");
    const nextPreferences = withSharedPreferenceRevision(
      preferences,
      "revision-2",
      "2026-07-23T12:01:00.000Z",
    );

    expect(nextFleet?.fleetRevision).toBe("revision-2");
    expect(nextPreferences?.revision).toBe("revision-2");
    expect(nextPreferences?.shortcutMap).toEqual({ search: "k" });
  });

  it("carries a shortcut mutation revision into Fleet ordering", () => {
    const savedPreferences = {
      ...preferences,
      revision: "revision-3",
      shortcutMap: { search: "g" },
      updatedAt: "2026-07-23T12:02:00.000Z",
    };
    const nextFleet = withSharedFleetRevision(
      fleet,
      savedPreferences.revision,
    );

    expect(nextFleet).toEqual({
      fleetRevision: "revision-3",
      agents: ["agent-1"],
    });
    expect(savedPreferences.shortcutMap).toEqual({ search: "g" });
  });

  it("does not synthesize projections that have not loaded", () => {
    expect(withSharedFleetRevision(undefined, "revision-2")).toBeUndefined();
    expect(
      withSharedPreferenceRevision(
        null,
        "revision-2",
        "2026-07-23T12:01:00.000Z",
      ),
    ).toBeNull();
  });

  it("does not let a late initial read roll back a committed revision", () => {
    expect(
      reconcileFleetPreferenceRead(
        preferences,
        0,
        1,
        "revision-2",
      ),
    ).toEqual({
      ...preferences,
      revision: "revision-2",
    });
    expect(
      reconcileFleetPreferenceRead(preferences, 0, 0, "revision-2"),
    ).toBe(preferences);
  });
});
