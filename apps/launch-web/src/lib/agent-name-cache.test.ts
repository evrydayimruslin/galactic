import { describe, expect, it } from "vitest";

import { recallAgentName, rememberAgentNames } from "./agent-name-cache";

function fakeStorage(): Pick<Storage, "getItem" | "setItem"> {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("agent name hints", () => {
  it("remembers names under both id and slug", () => {
    const storage = fakeStorage();
    rememberAgentNames(
      [{ id: "app-5vyb54", slug: "galactic-canon", name: "Galactic Canon" }],
      storage,
    );
    expect(recallAgentName("app-5vyb54", storage)).toBe("Galactic Canon");
    expect(recallAgentName("galactic-canon", storage)).toBe("Galactic Canon");
    expect(recallAgentName("unknown", storage)).toBe(null);
  });

  it("overwrites stale names and skips blank ones", () => {
    const storage = fakeStorage();
    rememberAgentNames([{ slug: "email-ops", name: "Email Ops" }], storage);
    rememberAgentNames(
      [{ slug: "email-ops", name: "Luma Reservations" }],
      storage,
    );
    expect(recallAgentName("email-ops", storage)).toBe("Luma Reservations");
    rememberAgentNames([{ slug: "no-name", name: "  " }], storage);
    expect(recallAgentName("no-name", storage)).toBe(null);
  });

  it("stays quiet without storage", () => {
    expect(() => rememberAgentNames([{ slug: "x", name: "X" }], null))
      .not.toThrow();
    expect(recallAgentName("x", null)).toBe(null);
  });

  it("bounds the store to the newest entries", () => {
    const storage = fakeStorage();
    for (let index = 0; index < 220; index += 1) {
      rememberAgentNames(
        [{ slug: `agent-${index}`, name: `Agent ${index}` }],
        storage,
      );
    }
    expect(recallAgentName("agent-0", storage)).toBe(null);
    expect(recallAgentName("agent-219", storage)).toBe("Agent 219");
  });
});
