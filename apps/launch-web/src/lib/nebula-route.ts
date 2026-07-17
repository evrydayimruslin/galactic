import type { LaunchAgentRelationship } from "../../../../shared/contracts/launch.ts";
import type { LaunchLoadStatus } from "./live-data";
import type { LaunchRouteKey } from "./routes";

export interface NebulaRouteDecision {
  agentRelationship?: LaunchAgentRelationship;
  authenticated: boolean;
  loadStatus: LaunchLoadStatus;
  routeKey: LaunchRouteKey;
  sessionRestoring?: boolean;
}

/**
 * Keep authenticated owner surfaces inside the Nebula shell while a first
 * Agent lookup is pending. A resolved non-owner (or failed/malformed lookup)
 * still falls back to the public compatibility surface.
 */
export function shouldUseNebulaRoute({
  agentRelationship,
  authenticated,
  loadStatus,
  routeKey,
  sessionRestoring = false,
}: NebulaRouteDecision): boolean {
  // A refresh-cookie marker is not authorization. It may only select the
  // sanitized Nebula loading shell while the session is being revalidated.
  if (sessionRestoring) {
    return routeKey === "home" || routeKey === "library" ||
      routeKey === "settings" || routeKey === "agent";
  }
  if (!authenticated) return false;

  if (routeKey === "home" || routeKey === "library" || routeKey === "settings") {
    return true;
  }

  if (routeKey !== "agent") return false;
  if (agentRelationship === "owner") return true;
  if (agentRelationship) return false;

  return loadStatus === "idle" || loadStatus === "loading";
}
