import { afterEach, describe, expect, it, vi } from "vitest";

import {
  establishLaunchMagicLinkSession,
  LAUNCH_AUTH_REFRESH_AVAILABLE_KEY,
  LAUNCH_AUTH_TOKEN_KEY,
  requestLaunchMagicLink,
  resolveMagicLinkNextPath,
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

describe("launch magic-link auth", () => {
  it("requests a one-time link for the current local path", async () => {
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      localStorage: createLocalStorage(),
      location: {
        origin: "https://launch.test",
        pathname: "/agents",
        search: "?welcome=1",
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          audience: "launch_web",
          email: "person@example.com",
          link_sent: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestLaunchMagicLink("person@example.com");

    expect(result.link_sent).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://launch.test/auth/launch/magic-link");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(String(init.body))).toEqual({
      email: "person@example.com",
      next: "/agents?welcome=1",
    });
  });

  it("stores the verified launch session", async () => {
    const localStorage = createLocalStorage();
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      localStorage,
      location: { origin: "https://launch.test" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            audience: "launch_web",
            confirmation_required: false,
            expires_in: 3600,
            refresh_supported: true,
            user: {
              email: "person@example.com",
              id: "user-1",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    await establishLaunchMagicLinkSession("one-time-token-hash");

    expect(localStorage.getItem(LAUNCH_AUTH_TOKEN_KEY)).toBe("access-token");
    expect(localStorage.getItem(LAUNCH_AUTH_REFRESH_AVAILABLE_KEY)).toBe("1");
  });

  it("unwraps only a same-origin continuation", () => {
    expect(resolveMagicLinkNextPath(
      "https://launch.test/auth/callback?next=%2Fagents%3Fwelcome%3D1",
      "https://launch.test",
    )).toBe("/agents?welcome=1");
    expect(resolveMagicLinkNextPath(
      "https://attacker.example/steal",
      "https://launch.test",
    )).toBe("/account");
  });
});
