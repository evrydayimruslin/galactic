import { afterEach, describe, expect, it, vi } from "vitest";

import {
  establishLaunchMagicLinkSession,
  isLaunchAuthSessionStorageChange,
  LAUNCH_AUTH_GENERATION_KEY,
  LAUNCH_AUTH_REFRESH_AVAILABLE_KEY,
  LAUNCH_AUTH_SIGNED_OUT_GENERATION_KEY,
  LAUNCH_AUTH_TOKEN_KEY,
  refreshLaunchSession,
  signOutLaunch,
} from "./auth";

function memoryStorage(
  initial: Record<string, string> = {},
): Storage {
  const values = new Map(Object.entries(initial));
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolved) => {
    resolve = resolved;
  });
  return { promise, resolve };
}

function serializedWebLocks() {
  let tail = Promise.resolve<unknown>(undefined);
  return {
    request: vi.fn(
      (
        _name: string,
        operation: () => Promise<unknown>,
      ): Promise<unknown> => {
        const result = tail.then(operation);
        tail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    ),
  };
}

function refreshResponse(token: string): Response {
  return new Response(JSON.stringify({
    access_token: token,
    audience: "launch_web",
    expires_in: 3_600,
    refresh_supported: true,
    user: {
      email: "person@example.com",
      id: "user-1",
    },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("launch auth logout boundary", () => {
  it("discards a refresh that resolves after logout and blocks later refreshes", async () => {
    const localStorage = memoryStorage({
      [LAUNCH_AUTH_REFRESH_AVAILABLE_KEY]: "1",
      [LAUNCH_AUTH_TOKEN_KEY]: "expired-access-token",
    });
    const refresh = deferred<Response>();
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith("/auth/launch/refresh")) return refresh.promise;
      if (url.endsWith("/auth/signout")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const locks = serializedWebLocks();
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      localStorage,
      location: { origin: "https://launch.test" },
    });
    vi.stubGlobal("navigator", { locks });
    vi.stubGlobal("fetch", fetchMock);

    const refreshing = refreshLaunchSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const signingOut = signOutLaunch();
    expect(localStorage.getItem(LAUNCH_AUTH_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(LAUNCH_AUTH_REFRESH_AVAILABLE_KEY)).toBeNull();

    refresh.resolve(refreshResponse("must-not-survive-logout"));

    await expect(refreshing).resolves.toBeNull();
    await signingOut;
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://launch.test/auth/launch/refresh",
      "https://launch.test/auth/signout",
    ]);
    expect(localStorage.getItem(LAUNCH_AUTH_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(LAUNCH_AUTH_REFRESH_AVAILABLE_KEY)).toBeNull();
    expect(localStorage.getItem(LAUNCH_AUTH_SIGNED_OUT_GENERATION_KEY)).toBe(
      localStorage.getItem(LAUNCH_AUTH_GENERATION_KEY),
    );

    await expect(refreshLaunchSession()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors a logout generation written by another tab", async () => {
    const localStorage = memoryStorage({
      [LAUNCH_AUTH_REFRESH_AVAILABLE_KEY]: "1",
      [LAUNCH_AUTH_TOKEN_KEY]: "expired-access-token",
    });
    const refresh = deferred<Response>();
    const fetchMock = vi.fn(() => refresh.promise);
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      localStorage,
      location: { origin: "https://launch.test" },
    });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("fetch", fetchMock);

    const refreshing = refreshLaunchSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    localStorage.setItem(LAUNCH_AUTH_GENERATION_KEY, "42");
    localStorage.setItem(LAUNCH_AUTH_SIGNED_OUT_GENERATION_KEY, "42");
    localStorage.removeItem(LAUNCH_AUTH_TOKEN_KEY);
    localStorage.removeItem(LAUNCH_AUTH_REFRESH_AVAILABLE_KEY);
    refresh.resolve(refreshResponse("cross-tab-stale-token"));

    await expect(refreshing).resolves.toBeNull();
    expect(localStorage.getItem(LAUNCH_AUTH_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(LAUNCH_AUTH_REFRESH_AVAILABLE_KEY)).toBeNull();
    expect(isLaunchAuthSessionStorageChange(LAUNCH_AUTH_GENERATION_KEY)).toBe(
      true,
    );
    expect(
      isLaunchAuthSessionStorageChange(
        LAUNCH_AUTH_SIGNED_OUT_GENERATION_KEY,
      ),
    ).toBe(true);
  });

  it("allows a new magic-link completion to replace the logout tombstone", async () => {
    const localStorage = memoryStorage({
      [LAUNCH_AUTH_GENERATION_KEY]: "42",
      [LAUNCH_AUTH_SIGNED_OUT_GENERATION_KEY]: "42",
    });
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      dispatchEvent,
      localStorage,
      location: { origin: "https://launch.test" },
    });
    vi.stubGlobal("navigator", { locks: serializedWebLocks() });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(refreshResponse("new-magic-link-token")),
    );

    await establishLaunchMagicLinkSession("one-time-token-hash");

    expect(localStorage.getItem(LAUNCH_AUTH_TOKEN_KEY)).toBe(
      "new-magic-link-token",
    );
    expect(localStorage.getItem(LAUNCH_AUTH_REFRESH_AVAILABLE_KEY)).toBe("1");
    expect(
      localStorage.getItem(LAUNCH_AUTH_SIGNED_OUT_GENERATION_KEY),
    ).toBeNull();
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });
});
