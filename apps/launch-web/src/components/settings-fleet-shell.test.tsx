import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LaunchRouteLiveState } from "../lib/live-data";
import type { LaunchNavigate } from "../lib/navigation";
import { resolveLaunchRoute } from "../lib/routes";
import { ThemeProvider } from "../lib/theme";
import { NebulaFleetApp } from "./nebula-fleet";

function storageWithSession(): Storage {
  const values = new Map<string, string>([
    ["ultralight.launch.authToken", "owner-session"],
  ]);
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

beforeEach(() => {
  vi.stubGlobal("window", {
    localStorage: storageWithSession(),
    location: {
      origin: "https://connectgalactic.com",
      pathname: "/account",
      search: "",
    },
    matchMedia: () => ({ matches: false }),
    scrollY: 0,
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("Settings Fleet shell", () => {
  it("keeps Fleet chrome mounted and replaces only the content region", () => {
    const live = {
      data: {
        fleet: {
          agents: [],
          accountCapacity: { plan: "max_5x" },
          fleetRevision: "fleet:1",
          generatedAt: "2026-08-04T12:00:00.000Z",
        },
      },
      reload: vi.fn(),
      status: "ready",
    } as unknown as LaunchRouteLiveState;

    const markup = renderToStaticMarkup(
      <ThemeProvider>
        <NebulaFleetApp
          live={live}
          location={{ pathname: "/account", search: "" }}
          navigate={vi.fn() as LaunchNavigate}
          route={resolveLaunchRoute("/account")}
        />
      </ThemeProvider>,
    );

    expect(markup).toContain("neb-wordmark-tier");
    expect(markup).toContain(">max</span>");
    expect(markup).toContain("neb-topbar-actions");
    expect(markup).toContain("neb-cmdk-chip");
    expect(markup).toContain('aria-label="Alerts"');
    expect(markup).toContain('aria-label="Settings"');
    expect(markup).not.toContain("neb-settings-topbar-crumb");
    expect(markup.match(/<h1>Settings<\/h1>/gu)).toHaveLength(1);
    expect(markup.indexOf('class="neb-hero"')).toBeLessThan(
      markup.indexOf("neb-settings-panel"),
    );
  });
});
