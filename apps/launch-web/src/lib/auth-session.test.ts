import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearLaunchAuthToken,
  isLaunchAuthSessionStorageChange,
  LAUNCH_AUTH_SESSION_CHANGED_EVENT,
  launchAuthSessionIdentity,
  launchAuthSubject,
  setLaunchAuthToken,
} from "./auth";

const TOKEN = "header.eyJzdWIiOiJvd25lci0xIn0.signature";
const REFRESHED_TOKEN =
  "refreshed-header.eyJzdWIiOiJvd25lci0xIn0.refreshed-signature";
const SECOND_TOKEN = "header.eyJzdWIiOiJvd25lci0yIn0.signature";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Launch auth cache boundary", () => {
  it("derives a stable owner scope only from a valid token subject", () => {
    expect(launchAuthSubject(TOKEN)).toBe("owner-1");
    expect(launchAuthSubject("not-a-token")).toBeNull();
    expect(launchAuthSubject(null)).toBeNull();
    expect(launchAuthSessionIdentity(TOKEN)).toBe("user:owner-1");
    expect(launchAuthSessionIdentity(REFRESHED_TOKEN)).toBe(
      launchAuthSessionIdentity(TOKEN),
    );
    expect(launchAuthSessionIdentity(SECOND_TOKEN)).toBe("user:owner-2");
    expect(launchAuthSessionIdentity(null)).toBe("public");
    expect(launchAuthSessionIdentity("not-a-token")).not.toContain(
      "not-a-token",
    );
    expect(isLaunchAuthSessionStorageChange("ultralight.launch.authToken"))
      .toBe(true);
    expect(isLaunchAuthSessionStorageChange(null)).toBe(true);
    expect(isLaunchAuthSessionStorageChange("unrelated")).toBe(false);
  });

  it("announces token replacement and logout synchronously", () => {
    const dispatchEvent = vi.fn<(event: Event) => boolean>(() => true);
    vi.stubGlobal("window", {
      dispatchEvent,
      localStorage: memoryStorage(),
    });

    setLaunchAuthToken(TOKEN, 3_600);
    setLaunchAuthToken(TOKEN, 3_600);
    clearLaunchAuthToken();

    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    expect(dispatchEvent.mock.calls.every(
      ([event]) =>
        event instanceof Event &&
        event.type === LAUNCH_AUTH_SESSION_CHANGED_EVENT,
    )).toBe(true);
  });
});
