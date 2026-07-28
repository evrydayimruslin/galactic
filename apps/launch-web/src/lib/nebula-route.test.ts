import { describe, expect, it } from "vitest";

import {
  shouldUseAgentStudioRoute,
  shouldUseNebulaRoute,
} from "./nebula-route";

describe("shouldUseNebulaRoute", () => {
  it.each(["home", "library", "settings", "connect"] as const)(
    "keeps the authenticated %s route inside Nebula",
    (routeKey) => {
      expect(shouldUseNebulaRoute({
        authenticated: true,
        loadStatus: "loading",
        routeKey,
      })).toBe(true);
    },
  );

  it.each(["store", "adminAgent", "authCallback", "terms", "privacy"] as const)(
    "keeps the %s compatibility route outside Nebula",
    (routeKey) => {
      expect(shouldUseNebulaRoute({
        authenticated: true,
        loadStatus: "ready",
        routeKey,
      })).toBe(false);
    },
  );

  it("keeps an authenticated first-visit Agent inside Nebula while identity loads", () => {
    expect(shouldUseNebulaRoute({
      authenticated: true,
      loadStatus: "loading",
      routeKey: "agent",
    })).toBe(true);
  });

  it.each(["ready", "error"] as const)(
    "keeps resolved owners inside Nebula with a %s route status",
    (loadStatus) => {
      expect(shouldUseNebulaRoute({
        agentRelationship: "owner",
        authenticated: true,
        loadStatus,
        routeKey: "agent",
      })).toBe(true);
    },
  );

  it.each(["installed", "public"] as const)(
    "uses the compatibility surface for a resolved %s Agent",
    (agentRelationship) => {
      expect(shouldUseNebulaRoute({
        agentRelationship,
        authenticated: true,
        loadStatus: "ready",
        routeKey: "agent",
      })).toBe(false);
    },
  );

  it.each(["ready", "error"] as const)(
    "fails closed when Agent identity is absent after a %s result",
    (loadStatus) => {
      expect(shouldUseNebulaRoute({
        authenticated: true,
        loadStatus,
        routeKey: "agent",
      })).toBe(false);
    },
  );

  it("never exposes Nebula Agent surfaces without an authenticated session", () => {
    expect(shouldUseNebulaRoute({
      agentRelationship: "owner",
      authenticated: false,
      loadStatus: "ready",
      routeKey: "agent",
    })).toBe(false);
  });

  it("keeps the signed-out Connect tutorial inside Nebula", () => {
    expect(shouldUseNebulaRoute({
      authenticated: false,
      loadStatus: "ready",
      routeKey: "connect",
    })).toBe(true);
  });

  it.each(["idle", "loading", "ready", "error"] as const)(
    "uses the Nebula loading shell while an existing Agent session is revalidated from %s",
    (loadStatus) => {
      expect(shouldUseNebulaRoute({
        authenticated: false,
        loadStatus,
        routeKey: "agent",
        sessionRestoring: true,
      })).toBe(true);
    },
  );

  it("does not move compatibility routes into Nebula during session restoration", () => {
    expect(shouldUseNebulaRoute({
      authenticated: false,
      loadStatus: "loading",
      routeKey: "store",
      sessionRestoring: true,
    })).toBe(false);
  });
});

describe("shouldUseAgentStudioRoute", () => {
  it("selects Studio while an authenticated Agent owner lookup is pending", () => {
    expect(shouldUseAgentStudioRoute({
      authenticated: true,
      loadStatus: "loading",
      routeKey: "agent",
    })).toBe(true);
  });

  it.each(["ready", "error"] as const)(
    "selects Studio for a resolved owner with %s route data",
    (loadStatus) => {
      expect(shouldUseAgentStudioRoute({
        agentRelationship: "owner",
        authenticated: true,
        loadStatus,
        routeKey: "agent",
      })).toBe(true);
    },
  );

  it.each(["installed", "public"] as const)(
    "keeps a resolved %s Agent out of the private Studio",
    (agentRelationship) => {
      expect(shouldUseAgentStudioRoute({
        agentRelationship,
        authenticated: true,
        loadStatus: "ready",
        routeKey: "agent",
      })).toBe(false);
    },
  );

  it.each(["ready", "error"] as const)(
    "fails closed when Agent identity is absent after a %s result",
    (loadStatus) => {
      expect(shouldUseAgentStudioRoute({
        authenticated: true,
        loadStatus,
        routeKey: "agent",
      })).toBe(false);
    },
  );

  it("does not select Studio during session restoration or on non-Agent routes", () => {
    expect(shouldUseAgentStudioRoute({
      authenticated: false,
      loadStatus: "loading",
      routeKey: "agent",
      sessionRestoring: true,
    })).toBe(false);
    expect(shouldUseAgentStudioRoute({
      authenticated: true,
      loadStatus: "ready",
      routeKey: "library",
    })).toBe(false);
  });
});
