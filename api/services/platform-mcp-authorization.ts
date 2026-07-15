import type { RequestAuthSource } from "./request-auth.ts";

/**
 * API-key scopes understood by the platform MCP aggregator.
 *
 * `apps:call` remains the narrow compatibility scope used by dedicated Agent
 * connections. Building and operating hosted Agents require explicit scopes;
 * the legacy `*` scope intentionally does not imply either one. This makes old
 * broad keys safe by default instead of silently granting newly-added control
 * plane capabilities.
 */
export const PLATFORM_MCP_SCOPES = {
  read: "apps:read",
  call: "apps:call",
  build: "agents:build",
  operate: "agents:operate",
} as const;

export type PlatformMcpScope =
  (typeof PLATFORM_MCP_SCOPES)[keyof typeof PLATFORM_MCP_SCOPES];

export interface PlatformMcpAuthContext {
  authSource?: RequestAuthSource;
  scopes?: string[];
}

export interface PlatformMcpAuthorizationDecision {
  allowed: boolean;
  accountSessionRequired?: boolean;
  requiredScopes?: PlatformMcpScope[];
  reason?: string;
}

/**
 * Trust the authentication result, never the header/cookie transport used to
 * carry the credential. A scoped key presented through an auth cookie is still
 * an API token and must retain every connected-builder restriction.
 */
export function isApiTokenPlatformAuth(
  auth: PlatformMcpAuthContext | undefined,
): boolean {
  return auth?.authSource === "api_token";
}

export function violatesPrivateAgentCreationPolicy(input: {
  appId?: string;
  visibility?: string;
}): boolean {
  return !input.appId && (input.visibility || "private") !== "private";
}

export function canApiTokenManageAgentVisibility(
  visibility: string | null | undefined,
): boolean {
  return visibility === "private";
}

/**
 * Existing GPU releases do not yet have a version-addressed build artifact
 * that gx.set can atomically promote. Keep connected builders on the staged
 * Deno path until that invariant exists; owner sessions retain the legacy GPU
 * workflow for now.
 */
export function canApiTokenStageExistingRuntime(input: {
  currentRuntime?: string | null;
  uploadContainsGpuConfig?: boolean;
}): boolean {
  return input.currentRuntime !== "gpu" && !input.uploadContainsGpuConfig;
}

export function shouldAutoLiveExistingUpload(input: {
  callerIsApiToken?: boolean;
  requestedAutoLive?: unknown;
  uploadedByName?: boolean;
}): boolean {
  if (input.callerIsApiToken) return false;
  return Boolean(input.requestedAutoLive || input.uploadedByName);
}

function canonicalToolName(name: string): string {
  if (name.startsWith("gx.")) return `ul.${name.slice(3)}`;
  if (name === "ultralight.job") return "ul.job";
  return name;
}

function toolMatches(name: string, root: string): boolean {
  return name === root || name.startsWith(`${root}.`);
}

/**
 * Return the least-privilege scope alternatives for a platform tool.
 * Unknown tools fail closed for API keys; account sessions continue through to
 * normal method-not-found handling so this layer does not redefine dispatch.
 */
export function requiredPlatformMcpScopes(
  requestedName: string,
): PlatformMcpScope[] | null {
  const name = canonicalToolName(requestedName);

  if (
    toolMatches(name, "ul.discover") ||
    name === "ul.verify"
  ) {
    return [
      PLATFORM_MCP_SCOPES.read,
      PLATFORM_MCP_SCOPES.call,
      PLATFORM_MCP_SCOPES.build,
      PLATFORM_MCP_SCOPES.operate,
    ];
  }

  if (
    name === "ul.call" ||
    name === "ul.job" ||
    name === "ul.codemode" ||
    name === "ul.execute" ||
    name === "ul.flag" ||
    name === "ul.rate" ||
    name === "ul.like" ||
    name === "ul.dislike"
  ) {
    return [PLATFORM_MCP_SCOPES.call];
  }

  if (
    name === "ul.download" ||
    name === "ul.test" ||
    name === "ul.upload" ||
    toolMatches(name, "ul.set") ||
    name === "ul.db" ||
    toolMatches(name, "ul.logs") ||
    name === "ul.lint" ||
    name === "ul.scaffold" ||
    name === "ul.health" ||
    name === "ul.gaps" ||
    name === "ul.shortcomings"
  ) {
    return [PLATFORM_MCP_SCOPES.build];
  }

  if (
    name === "ul.routine" ||
    name === "ul.grants" ||
    name === "ul.notifications" ||
    toolMatches(name, "ul.memory") ||
    name === "ul.consent" ||
    name === "ul.permit" ||
    name === "ul.secrets" ||
    name === "ul.connect" ||
    name === "ul.connections"
  ) {
    return [PLATFORM_MCP_SCOPES.operate];
  }

  // ul.auth.link is only for provisional sessions, never an API key.
  return null;
}

function explicitScopeMatch(
  scopes: string[] | undefined,
  required: PlatformMcpScope[],
): boolean {
  if (!scopes) return false;
  // Backward compatibility is deliberately narrow: historical wildcard keys
  // may keep reading/calling Agents, but do not inherit build/operate powers.
  if (
    scopes.includes("*") &&
    (required.includes(PLATFORM_MCP_SCOPES.read) ||
      required.includes(PLATFORM_MCP_SCOPES.call))
  ) {
    return true;
  }
  return required.some((scope) => scopes.includes(scope));
}

function apiTokenAccountSessionRestriction(
  requestedName: string,
  args: Record<string, unknown>,
): string | null {
  const name = canonicalToolName(requestedName);

  if (
    (name === "ul.discover" && args.scope === "appstore") ||
    name === "ul.discover.appstore"
  ) {
    return "Marketplace discovery is deferred for launch and requires an authenticated Galactic account session.";
  }

  if (name === "ul.upload" && args.type === "page") {
    return "Publishing pages requires an authenticated Galactic account session.";
  }

  if (
    (name === "ul.secrets" || name === "ul.connect") &&
    args.secrets !== undefined
  ) {
    return "Secret values can only be added or changed from an authenticated Galactic account session.";
  }

  if (name === "ul.grants") {
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "approve" || action === "set_cap") {
      return "Grant approval and grant spending-cap changes require an authenticated Galactic account session.";
    }
  }

  if (name === "ul.routine") {
    const action = typeof args.action === "string" ? args.action : "";
    const requestedCapabilities = [
      ...(Array.isArray(args.capabilities) ? args.capabilities : []),
      ...(Array.isArray(args.extra_capabilities)
        ? args.extra_capabilities
        : []),
    ];
    const embedsCapabilityApproval = requestedCapabilities.some((capability) =>
      capability !== null && typeof capability === "object" &&
      (capability as Record<string, unknown>).approved === true
    );
    if (
      action === "resume" ||
      action === "run_now" ||
      action === "delete" ||
      (action === "create" &&
        (args.activate === true || args.approve_capabilities === true ||
          embedsCapabilityApproval))
    ) {
      return "Routine capability approval and activation require an authenticated Galactic account session.";
    }
    if (
      action === "update" &&
      Object.keys(args).some((key) =>
        !["action", "routine_id", "name", "description"].includes(
          key,
        )
      )
    ) {
      return "Changing a routine's mission, cadence, configuration, capabilities, concurrency, next wake, budget, approval policy, or status requires an authenticated Galactic account session.";
    }
  }

  if (name === "ul.notifications" && args.action === "mark_read") {
    return "Only an authenticated Galactic account session may mark owner notifications read.";
  }

  if (name === "ul.logs" && args.resolve_event_id !== undefined) {
    return "Only an authenticated Galactic account session may resolve health events.";
  }

  if (name === "ul.db" && args.action === "support_read") {
    return "Reading another user's Agent data for support requires an authenticated Galactic account session.";
  }

  if (toolMatches(name, "ul.set")) {
    const isVersionOnlyAlias = name === "ul.set.version";
    const settingKeys = Object.keys(args).filter((key) => !key.startsWith("_"));
    const isAggregateVersionOnly = name === "ul.set" &&
      settingKeys.every((key) => key === "app_id" || key === "version") &&
      args.version !== undefined;
    if (!isVersionOnlyAlias && !isAggregateVersionOnly) {
      return "Builder keys may only promote a staged version. Visibility, publication, pricing, rate limits, storage bindings, download access, and other authority changes require an authenticated Galactic account session.";
    }
  }

  if (
    (name === "ul.consent" || name === "ul.permit") &&
    args.decision !== undefined
  ) {
    return "Persistent caller-policy decisions require an authenticated Galactic account session.";
  }

  return null;
}

export function authorizePlatformMcpTool(input: {
  requestedName: string;
  args?: Record<string, unknown>;
  auth: PlatformMcpAuthContext;
}): PlatformMcpAuthorizationDecision {
  // Browser/account sessions are already protected by Supabase auth and can
  // reach the existing owner checks. This policy is specifically the API-key
  // control-plane boundary.
  if (!isApiTokenPlatformAuth(input.auth)) return { allowed: true };

  const args = input.args || {};
  const requiredScopes = requiredPlatformMcpScopes(input.requestedName);
  if (!requiredScopes) {
    return {
      allowed: false,
      requiredScopes: [],
      reason: "This platform tool is not available to API keys.",
    };
  }

  if (!explicitScopeMatch(input.auth.scopes, requiredScopes)) {
    const scopeList = requiredScopes.join(" or ");
    const hasLegacyWildcard = input.auth.scopes?.includes("*") === true;
    return {
      allowed: false,
      requiredScopes,
      reason: hasLegacyWildcard
        ? `Legacy wildcard API keys do not authorize this control-plane operation. Rotate the key with explicit scope: ${scopeList}.`
        : `API key missing required scope: ${scopeList}.`,
    };
  }

  const accountSessionReason = apiTokenAccountSessionRestriction(
    input.requestedName,
    args,
  );
  if (accountSessionReason) {
    return {
      allowed: false,
      accountSessionRequired: true,
      reason: accountSessionReason,
    };
  }

  return { allowed: true, requiredScopes };
}

export function filterPlatformMcpToolsForAuth<T extends { name: string }>(
  tools: T[],
  auth: PlatformMcpAuthContext,
): T[] {
  if (!isApiTokenPlatformAuth(auth)) return tools;
  return tools.filter((tool) => {
    const required = requiredPlatformMcpScopes(tool.name);
    return required !== null && explicitScopeMatch(auth.scopes, required);
  });
}
