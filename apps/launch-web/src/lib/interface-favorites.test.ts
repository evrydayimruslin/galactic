import { describe, expect, it } from "vitest";

import {
  clearLegacyInterfaceFavorites,
  readInterfaceFavorites,
  readLegacyInterfaceFavoritesForMigration,
  shouldApplyInterfaceFavoritesRead,
  shouldMigrateLegacyInterfaceFavorites,
  writeInterfaceFavorites,
} from "./interface-favorites";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("interface favorites", () => {
  it("migrates the previous first-three overview behavior", () => {
    expect(readInterfaceFavorites(memoryStorage(), "agent-1", ["a", "b", "c", "d"]))
      .toEqual(["a", "b", "c"]);
  });

  it("persists an explicit empty selection", () => {
    const storage = memoryStorage();
    writeInterfaceFavorites(storage, "agent-1", []);
    expect(readInterfaceFavorites(storage, "agent-1", ["a", "b"])).toEqual([]);
  });

  it("deduplicates favorites and drops interfaces that no longer exist", () => {
    const storage = memoryStorage();
    writeInterfaceFavorites(storage, "agent-1", ["a", "b", "a", "gone"]);
    expect(readInterfaceFavorites(storage, "agent-1", ["a", "b", "c"]))
      .toEqual(["a", "b"]);
  });

  it("migrates only an explicit legacy selection and preserves explicit none", () => {
    const storage = memoryStorage();
    expect(
      readLegacyInterfaceFavoritesForMigration(storage, "agent-1", ["a", "b"]),
    ).toBeNull();

    writeInterfaceFavorites(storage, "agent-1", []);
    expect(
      readLegacyInterfaceFavoritesForMigration(storage, "agent-1", ["a", "b"]),
    ).toEqual([]);
  });

  it("clears the legacy value after a successful server migration", () => {
    const storage = memoryStorage();
    writeInterfaceFavorites(storage, "agent-1", ["a"]);
    clearLegacyInterfaceFavorites(storage, "agent-1");
    expect(
      readLegacyInterfaceFavoritesForMigration(storage, "agent-1", ["a"]),
    ).toBeNull();
  });

  it("never overwrites an explicit server choice, including explicit none", () => {
    expect(
      shouldMigrateLegacyInterfaceFavorites(
        { favoriteInterfaceIds: [], favoritesExplicit: true },
        ["inbox"],
      ),
    ).toBe(false);
    expect(
      shouldMigrateLegacyInterfaceFavorites(
        { favoriteInterfaceIds: ["report"], favoritesExplicit: true },
        ["inbox"],
      ),
    ).toBe(false);
  });

  it("migrates a differing local choice over the automatic onboarding default once", () => {
    expect(
      shouldMigrateLegacyInterfaceFavorites(
        { favoriteInterfaceIds: ["inbox"], favoritesExplicit: false },
        ["report"],
      ),
    ).toBe(true);
    expect(
      shouldMigrateLegacyInterfaceFavorites(
        { favoriteInterfaceIds: ["inbox"], favoritesExplicit: false },
        ["inbox"],
      ),
    ).toBe(false);
  });

  it("rejects an in-flight read superseded by a mutation or newer read", () => {
    const baseline = {
      mounted: true,
      readGeneration: 4,
      currentReadGeneration: 4,
      mutationGeneration: 7,
      currentMutationGeneration: 7,
    };
    expect(shouldApplyInterfaceFavoritesRead(baseline)).toBe(true);
    expect(
      shouldApplyInterfaceFavoritesRead({
        ...baseline,
        currentMutationGeneration: 8,
      }),
    ).toBe(false);
    expect(
      shouldApplyInterfaceFavoritesRead({
        ...baseline,
        currentReadGeneration: 5,
      }),
    ).toBe(false);
    expect(
      shouldApplyInterfaceFavoritesRead({ ...baseline, mounted: false }),
    ).toBe(false);
  });
});
