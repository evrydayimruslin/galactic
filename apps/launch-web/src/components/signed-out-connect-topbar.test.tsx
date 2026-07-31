import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LaunchRouteLiveState } from "../lib/live-data";
import type { LaunchNavigate } from "../lib/navigation";
import { resolveLaunchRoute } from "../lib/routes";
import { NebulaFleetApp } from "./nebula-fleet";
import { PRE_AUTH_ADD_AGENT_HREF } from "./pre-auth-fleet";

function createStorage(): Storage {
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

beforeEach(() => {
  vi.stubGlobal("window", {
    localStorage: createStorage(),
    location: {
      origin: "https://connectgalactic.com",
      pathname: "/connect",
      search: "?intent=agent&source=fleet-card",
    },
    matchMedia: () => ({ matches: false }),
    scrollY: 0,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signed-out Add-agent route", () => {
  it("keeps Sign in visible and withholds member top-bar controls", () => {
    const target = new URL(
      PRE_AUTH_ADD_AGENT_HREF,
      "https://connectgalactic.com",
    );
    const live = {
      data: {},
      reload: vi.fn(),
      status: "ready",
    } as unknown as LaunchRouteLiveState;

    const markup = renderToStaticMarkup(
      <NebulaFleetApp
        live={live}
        location={{ pathname: target.pathname, search: target.search }}
        navigate={vi.fn() as LaunchNavigate}
        route={resolveLaunchRoute(target.pathname)}
      />,
    );

    expect(markup).toContain('data-connect-intent="agent"');
    expect(markup).toContain(">Sign in</button>");
    expect(markup).not.toContain('aria-label="Alerts"');
    expect(markup).not.toContain('aria-label="Settings"');
    expect(markup).not.toContain("neb-cmdk-chip");
    expect(markup).not.toContain("neb-wordmark-tier");
  });
});
