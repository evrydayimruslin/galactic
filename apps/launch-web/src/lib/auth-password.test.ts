import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authenticateLaunchWithPassword,
  LAUNCH_AUTH_REFRESH_AVAILABLE_KEY,
  LAUNCH_AUTH_TOKEN_KEY,
} from "./auth";

function createLocalStorage(): Storage {
  const values = new Map<string, string>();
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("launch password auth", () => {
  it("stores a successful email sign-in in the existing launch session", async () => {
    const localStorage = createLocalStorage();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      dispatchEvent,
      localStorage,
      location: {
        origin: "https://launch.test",
        pathname: "/agents",
        search: "?welcome=1",
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "access-token",
      audience: "launch_web",
      confirmation_required: false,
      expires_in: 3600,
      refresh_supported: true,
      user: {
        email: "person@example.com",
        id: "user-1",
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await authenticateLaunchWithPassword(
      "sign_in",
      "person@example.com",
      "password",
    );

    expect(result.confirmation_required).toBe(false);
    expect(localStorage.getItem(LAUNCH_AUTH_TOKEN_KEY)).toBe("access-token");
    expect(localStorage.getItem(LAUNCH_AUTH_REFRESH_AVAILABLE_KEY)).toBe("1");
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://launch.test/auth/launch/password");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(String(init.body))).toEqual({
      email: "person@example.com",
      mode: "sign_in",
      next: "/agents?welcome=1",
      password: "password",
    });
  });

  it("leaves the browser signed out while a new account awaits confirmation", async () => {
    const localStorage = createLocalStorage();
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      localStorage,
      location: {
        origin: "https://launch.test",
        pathname: "/connect",
        search: "",
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        audience: "launch_web",
        confirmation_required: true,
        email: "person@example.com",
        refresh_supported: false,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    const result = await authenticateLaunchWithPassword(
      "sign_up",
      "person@example.com",
      "Strong-password-1!",
    );

    expect(result.confirmation_required).toBe(true);
    expect(localStorage.getItem(LAUNCH_AUTH_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(LAUNCH_AUTH_REFRESH_AVAILABLE_KEY)).toBeNull();
  });
});
