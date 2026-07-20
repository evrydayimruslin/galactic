import type { UserContext } from "../runtime/sandbox.ts";
import {
  authorizePlatformMcpTool,
  canonicalPlatformMcpToolName,
  PLATFORM_MCP_SCOPES,
  type PlatformMcpAuthContext,
  type PlatformMcpAuthorizationDecision,
} from "./platform-mcp-authorization.ts";

/**
 * The trusted Compute caller is derived by the control plane after it has
 * introspected a job token. It deliberately contains no bearer or other
 * credential that platform dispatch could forward.
 */
export interface ComputePlatformGatewayPrincipal {
  userId: string;
  user: UserContext;
  /** Internal canonical names only (`ul.call`, never `gx.call`). */
  allowedPlatformFunctions: readonly string[];
  executeAgentFunction?: TrustedComputeAgentFunctionExecutor;
  /** Redacted telemetry attribution; never contains the job bearer or secrets. */
  computeAttribution?: {
    runId: string;
    sourceAgentId: string;
    capacityAgentId: string;
    callerFunction: string;
  };
}

/**
 * A bearer-free Agent call handed back to the trusted Compute host. The host
 * must authorize the exact resolved Agent ID + function against the job's
 * server-side authority before executing it.
 */
export interface TrustedComputeAgentFunctionCall {
  userId: string;
  requestedAgentId: string;
  agentId: string;
  functionName: string;
  args: Record<string, unknown>;
  confirmed: boolean;
}

export type TrustedComputeAgentFunctionExecutor = (
  call: TrustedComputeAgentFunctionCall,
) => Promise<unknown>;

export interface ComputePlatformAuthorizationDecision
  extends PlatformMcpAuthorizationDecision {
  exactScopeDenied?: boolean;
  bearerDependentToolDenied?: boolean;
}

/**
 * Compute is a non-human caller. Giving this context every API-key scope does
 * not grant every tool: the exact function allowlist is checked first, and the
 * existing account-session-only action restrictions are still enforced.
 */
export const COMPUTE_PLATFORM_AUTH_CONTEXT: PlatformMcpAuthContext = {
  authSource: "api_token",
  scopes: [
    PLATFORM_MCP_SCOPES.read,
    PLATFORM_MCP_SCOPES.call,
    PLATFORM_MCP_SCOPES.build,
    PLATFORM_MCP_SCOPES.operate,
  ],
};

/**
 * Validate server-derived authority once at the gateway boundary. Aliases in
 * an authority document are rejected so an introspection/wiring bug cannot
 * silently widen or reinterpret a lease.
 */
export function createComputePlatformFunctionAllowlist(
  names: readonly string[],
): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const rawName of names) {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const canonical = canonicalPlatformMcpToolName(name);
    if (!name || !name.startsWith("ul.") || canonical !== name) {
      throw new Error(
        `Compute platform authority must use canonical ul.* names: ${
          name || "<empty>"
        }`,
      );
    }
    allowed.add(name);
  }
  return allowed;
}

export function isComputePlatformFunctionAllowed(
  requestedName: string,
  allowed: ReadonlySet<string>,
): boolean {
  return allowed.has(canonicalPlatformMcpToolName(requestedName));
}

export function filterComputePlatformTools<T extends { name: string }>(
  tools: readonly T[],
  allowed: ReadonlySet<string>,
): T[] {
  return tools.filter((tool) =>
    isComputePlatformFunctionAllowed(tool.name, allowed) &&
    !isComputeBearerDependentPlatformTool(tool.name)
  );
}

export function isComputeBearerDependentPlatformTool(name: string): boolean {
  const canonical = canonicalPlatformMcpToolName(name);
  return canonical === "ul.codemode" || canonical === "ul.execute";
}

/** Exact lease authority is evaluated before the platform's non-human policy. */
export function authorizeComputePlatformFunction(input: {
  requestedName: string;
  args?: Record<string, unknown>;
  allowed: ReadonlySet<string>;
}): ComputePlatformAuthorizationDecision {
  if (!isComputePlatformFunctionAllowed(input.requestedName, input.allowed)) {
    return {
      allowed: false,
      exactScopeDenied: true,
      reason: "Compute job is not authorized for this platform function.",
    };
  }

  if (isComputeBearerDependentPlatformTool(input.requestedName)) {
    return {
      allowed: false,
      bearerDependentToolDenied: true,
      reason:
        "This platform function depends on a public caller bearer and is unavailable to Compute jobs.",
    };
  }

  // gx.emit is deliberately account-session-only for ambient public API keys,
  // but a Compute job is not an ambient key: the control plane has already
  // matched this exact function against the immutable lease authority. Event
  // recipients remain subscribe-grant-gated and both emitter/root identities
  // are revalidated server-side by emitEvent.
  if (canonicalPlatformMcpToolName(input.requestedName) === "ul.emit") {
    return { allowed: true };
  }

  return authorizePlatformMcpTool({
    requestedName: input.requestedName,
    args: input.args,
    auth: COMPUTE_PLATFORM_AUTH_CONTEXT,
  });
}

/**
 * Preserve only protocol/session correlation metadata for internal dispatch.
 * In particular, Authorization, Cookie, and every caller-controlled credential
 * header are dropped.
 */
export function createBearerFreeComputePlatformRequest(
  request: Request,
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (
    const name of [
      "MCP-Protocol-Version",
      "Mcp-Session-Id",
      "mcp-session-id",
    ]
  ) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Request("https://compute-gateway.internal/mcp/platform", {
    method: "POST",
    headers,
  });
}
