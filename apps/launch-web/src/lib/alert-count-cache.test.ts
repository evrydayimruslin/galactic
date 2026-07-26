import { describe, expect, it, vi } from "vitest";

import {
  readCachedAlertCount,
  writeCachedAlertCount,
} from "./alert-count-cache";

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

describe("alert count cache", () => {
  it("restores the last authoritative count only for the same user", () => {
    const storage = memoryStorage();
    writeCachedAlertCount(storage, FIRST_TOKEN, 13);

    expect(readCachedAlertCount(storage, FIRST_TOKEN)).toBe(13);
    expect(readCachedAlertCount(storage, SECOND_TOKEN)).toBeUndefined();
  });

  it("writes only when the authoritative count changes", () => {
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, "setItem");

    writeCachedAlertCount(storage, FIRST_TOKEN, 13);
    writeCachedAlertCount(storage, FIRST_TOKEN, 13);
    writeCachedAlertCount(storage, FIRST_TOKEN, 12);

    expect(setItem).toHaveBeenCalledTimes(2);
    expect(readCachedAlertCount(storage, FIRST_TOKEN)).toBe(12);
  });

  it("ignores invalid counts, identities, and unavailable storage", () => {
    const storage = memoryStorage();
    storage.setItem("ultralight.launch.openAlertCount.v1:user-1", "13 alerts");

    expect(readCachedAlertCount(storage, FIRST_TOKEN)).toBeUndefined();
    expect(readCachedAlertCount(storage, "not-a-token")).toBeUndefined();
    expect(readCachedAlertCount({
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    }, FIRST_TOKEN)).toBeUndefined();

    writeCachedAlertCount(storage, FIRST_TOKEN, -1);
    expect(readCachedAlertCount(storage, FIRST_TOKEN)).toBeUndefined();
  });
});
