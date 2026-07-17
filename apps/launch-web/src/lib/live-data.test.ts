import { describe, expect, it } from "vitest";

import {
  launchRouteDataIdentity,
  sameLaunchAuthScope,
} from "./live-data";

describe("launchRouteDataIdentity", () => {
  it("never shares cached payloads between authenticated and public sessions", () => {
    const route = {
      paramsKey: JSON.stringify({ slug: "private-agent" }),
      pathname: "/agents/private-agent",
      routeKey: "agent",
    };

    expect(launchRouteDataIdentity({ ...route, authenticated: true }))
      .not.toBe(launchRouteDataIdentity({ ...route, authenticated: false }));
  });

  it.each([
    { captured: false, current: true },
    { captured: true, current: false },
  ])(
    "rejects a result when auth changes from $captured to $current in flight",
    ({ captured, current }) => {
      expect(sameLaunchAuthScope(captured, current)).toBe(false);
    },
  );
});
