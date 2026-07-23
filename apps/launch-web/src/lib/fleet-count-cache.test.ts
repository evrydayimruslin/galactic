import { describe, expect, it, vi } from "vitest";

import { readCachedFleetCount, writeCachedFleetCount } from "./fleet-count-cache";

const FIRST_TOKEN = "header.eyJzdWIiOiJ1c2VyLTEifQ.signature";
const SECOND_TOKEN = "header.eyJzdWIiOiJ1c2VyLTIifQ.signature";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("fleet count cache", () => {
  it("restores a cached count only for the same signed-in user", () => {
    const storage = memoryStorage();
    writeCachedFleetCount(storage, FIRST_TOKEN, 9);

    expect(readCachedFleetCount(storage, FIRST_TOKEN)).toBe(9);
    expect(readCachedFleetCount(storage, SECOND_TOKEN)).toBeUndefined();
  });

  it("writes only when the resolved count changes", () => {
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, "setItem");

    writeCachedFleetCount(storage, FIRST_TOKEN, 9);
    writeCachedFleetCount(storage, FIRST_TOKEN, 9);
    writeCachedFleetCount(storage, FIRST_TOKEN, 10);

    expect(setItem).toHaveBeenCalledTimes(2);
    expect(readCachedFleetCount(storage, FIRST_TOKEN)).toBe(10);
  });

  it("ignores malformed tokens, values, and unavailable storage", () => {
    const storage = memoryStorage();
    storage.setItem("ultralight.launch.workingAgentCount.v2:user-1", "9 agents");

    expect(readCachedFleetCount(storage, FIRST_TOKEN)).toBeUndefined();
    expect(readCachedFleetCount(storage, "not-a-token")).toBeUndefined();
    expect(readCachedFleetCount({
      getItem: () => { throw new DOMException("denied", "SecurityError"); },
    }, FIRST_TOKEN)).toBeUndefined();
  });
});
