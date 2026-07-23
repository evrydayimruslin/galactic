import { describe, expect, it } from "vitest";

import {
  consumeExternalReturnRevalidation,
  markExternalReturnRevalidation,
} from "./external-navigation";

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

describe("external navigation revalidation", () => {
  it("marks one reload when returning from an external flow", () => {
    const storage = memoryStorage();
    expect(consumeExternalReturnRevalidation(storage)).toBe(false);

    markExternalReturnRevalidation(storage);

    expect(consumeExternalReturnRevalidation(storage)).toBe(true);
    expect(consumeExternalReturnRevalidation(storage)).toBe(false);
  });

  it("does not block navigation when browser storage is unavailable", () => {
    const unavailable = {
      getItem: () => { throw new DOMException("denied", "SecurityError"); },
      removeItem: () => { throw new DOMException("denied", "SecurityError"); },
      setItem: () => { throw new DOMException("denied", "SecurityError"); },
    };

    expect(() => markExternalReturnRevalidation(unavailable)).not.toThrow();
    expect(consumeExternalReturnRevalidation(unavailable)).toBe(false);
  });
});
