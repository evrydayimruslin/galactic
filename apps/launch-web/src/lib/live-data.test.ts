import { describe, expect, it } from "vitest";

import {
  LaunchRouteDataCache,
  launchRouteDataAfterError,
  launchRouteDataIdentity,
  launchRouteDataSearchKey,
  sameLaunchAuthScope,
} from "./live-data";

describe("launchRouteDataIdentity", () => {
  const route = {
    paramsKey: JSON.stringify({ slug: "private-agent" }),
    pathname: "/agents/private-agent",
    routeKey: "agent",
    sessionRevision: 0,
  };

  it("never shares cached payloads between two authenticated owners", () => {
    const alice = launchRouteDataIdentity({
      ...route,
      sessionIdentity: "user:alice",
    });
    const bob = launchRouteDataIdentity({
      ...route,
      sessionIdentity: "user:bob",
    });
    const cache = new LaunchRouteDataCache();
    cache.set(alice, { agentHomeError: "alice-private-payload" });

    expect(alice).not.toBe(bob);
    expect(cache.get(bob)).toBeUndefined();
  });

  it("never shares cached payloads between authenticated and public sessions", () => {
    const route = {
      paramsKey: JSON.stringify({ slug: "private-agent" }),
      pathname: "/agents/private-agent",
      routeKey: "agent",
      sessionRevision: 0,
    };

    expect(launchRouteDataIdentity({
      ...route,
      sessionIdentity: "user:owner-1",
    })).not.toBe(launchRouteDataIdentity({
      ...route,
      sessionIdentity: "public",
    }));
  });

  it("clears cached owner payloads and rejects prior-session completions", () => {
    const cache = new LaunchRouteDataCache();
    const aliceIdentity = launchRouteDataIdentity({
      ...route,
      sessionIdentity: "user:alice",
    });
    const captured = {
      cacheEpoch: cache.epoch,
      sessionIdentity: "user:alice",
    };
    cache.set(aliceIdentity, { agentHomeError: "alice-private-payload" });

    cache.clearForSessionChange();

    expect(cache.get(aliceIdentity)).toBeUndefined();
    expect(sameLaunchAuthScope(captured, {
      cacheEpoch: cache.epoch,
      sessionIdentity: "user:bob",
    })).toBe(false);
    expect(sameLaunchAuthScope(captured, {
      cacheEpoch: cache.epoch,
      sessionIdentity: "user:alice",
    })).toBe(false);
  });

  it("never preserves prior-owner data after a failed revalidation", () => {
    const priorOwnerData = {
      agentHomeError: "alice-private-payload",
    };

    expect(launchRouteDataAfterError({
      currentData: priorOwnerData,
      currentIdentity: "user:bob@1|agent|{}|/agents/private-agent",
      requestIdentity: "user:alice@0|agent|{}|/agents/private-agent",
    })).toEqual({});
    expect(launchRouteDataAfterError({
      currentData: priorOwnerData,
      currentIdentity: "user:alice@0|agent|{}|/agents/private-agent",
      requestIdentity: "user:alice@0|agent|{}|/agents/private-agent",
    })).toBe(priorOwnerData);
  });

  it("keeps Agent pane and item navigation on one large-data identity", () => {
    const route = {
      paramsKey: JSON.stringify({ slug: "email-ops" }),
      pathname: "/agents/email-ops",
      routeKey: "agent",
      sessionIdentity: "user:owner-1",
      sessionRevision: 0,
    };

    const overview = launchRouteDataIdentity({
      ...route,
      searchKey: launchRouteDataSearchKey("agent", ""),
    });
    const functionItem = launchRouteDataIdentity({
      ...route,
      searchKey: launchRouteDataSearchKey(
        "agent",
        "?pane=functions&item=send_reply",
      ),
    });

    expect(functionItem).toBe(overview);
  });

  it("retains query identity only for routes whose request depends on it", () => {
    expect(launchRouteDataSearchKey("home", "?panel=alerts")).toBe("");
    expect(launchRouteDataSearchKey(
      "agent",
      "?pane=interfaces&item=inbox",
    )).toBe("");
    expect(launchRouteDataSearchKey("store", "?q=email&kind=mcp"))
      .toBe("kind=mcp&q=email");
    expect(launchRouteDataSearchKey("store", "?panel=ignored"))
      .toBe("kind=all");
  });
});
