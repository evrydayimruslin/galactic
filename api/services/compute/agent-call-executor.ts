import type { UserContext } from "../../runtime/sandbox.ts";
import type { TrustedComputeAgentFunctionCall } from "../compute-platform-gateway.ts";
import { mintCallerContextToken } from "../agent-caller-context.ts";
import { resolveInternalMcpCall } from "../internal-mcp.ts";
import { mintSandboxAuthToken } from "../sandbox-actor.ts";

const MAX_DOWNSTREAM_ERROR_BYTES = 2_048;

export interface ComputeAgentCallPrincipal {
  userId: string;
  user: UserContext;
  sourceAgentId: string;
  /** Trusted root Agent whose subscription-capacity lineage owns this work. */
  capacityAgentId: string;
  callerFunction: string;
  executionId: string;
}

export interface ComputeAgentCallExecutorDeps {
  /**
   * Re-authorize the exact resolved Agent UUID + function against the current
   * run. This check must introspect the job token/container pair server-side;
   * an allowlist supplied by the body is never sufficient.
   */
  authorizeExact(input: {
    targetAgentId: string;
    functionName: string;
  }): Promise<boolean>;
  mintActorToken?: typeof mintSandboxAuthToken;
  mintCallerToken?: typeof mintCallerContextToken;
  resolveInternalCall?: typeof resolveInternalMcpCall;
  baseUrl?: string;
}

interface JsonRpcErrorShape {
  code?: number;
  message?: string;
  data?: unknown;
}

interface JsonRpcEnvelope {
  result?: unknown;
  error?: JsonRpcErrorShape;
}

function clip(value: string): string {
  return value.length <= MAX_DOWNSTREAM_ERROR_BYTES
    ? value
    : `${value.slice(0, MAX_DOWNSTREAM_ERROR_BYTES)}…`;
}

function unwrapMcpResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return value;
  const text = content.find((item): item is { type: "text"; text: string } =>
    !!item && typeof item === "object" && !Array.isArray(item) &&
    (item as { type?: unknown }).type === "text" &&
    typeof (item as { text?: unknown }).text === "string"
  )?.text;
  if (text === undefined) return value;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Execute one exact Agent function for a Compute job without ever exposing a
 * human, Agent, API-key, or actor bearer to the body.
 *
 * The short-lived actor token and signed caller context exist only in this
 * trusted host callback. The target's ordinary cross-Agent grant and runtime
 * gates remain in force in addition to the Compute run authority.
 */
export async function executeComputeAgentFunction(
  call: TrustedComputeAgentFunctionCall,
  principal: ComputeAgentCallPrincipal,
  deps: ComputeAgentCallExecutorDeps,
): Promise<unknown> {
  if (
    !principal.userId || principal.user.id !== principal.userId ||
    call.userId !== principal.userId
  ) {
    throw new Error("Compute Agent-call principal does not match the job.");
  }
  if (
    !principal.sourceAgentId || !principal.capacityAgentId ||
    !principal.callerFunction
  ) {
    throw new Error("Compute Agent-call source identity is incomplete.");
  }

  // This is intentionally first: no counters, token mint, app execution, or
  // network hop occurs for a body-selected target outside the lease authority.
  if (
    !(await deps.authorizeExact({
      targetAgentId: call.agentId,
      functionName: call.functionName,
    }))
  ) {
    throw new Error(
      "Compute job is not authorized for this exact Agent function.",
    );
  }

  const actorToken = await (deps.mintActorToken ?? mintSandboxAuthToken)({
    user: principal.user,
    appId: principal.sourceAgentId,
    executionId: principal.executionId,
    hasBroadCallPermission: false,
    dependencyAppIds: [call.agentId],
  });
  if (!actorToken) {
    throw new Error("Compute Agent-call actor token could not be minted.");
  }
  const callerToken = await (deps.mintCallerToken ?? mintCallerContextToken)({
    callerAppId: principal.sourceAgentId,
    capacityAgentId: principal.capacityAgentId,
    userId: principal.userId,
    callerFunction: principal.callerFunction,
    incomingHop: 0,
  });

  const internal = (deps.resolveInternalCall ?? resolveInternalMcpCall)(
    call.agentId,
    { baseUrl: deps.baseUrl ?? "https://internal" },
  );
  const response = await internal.fetchFn(internal.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${actorToken}`,
      "X-Galactic-Caller": callerToken,
      // Never forward X-Galactic-Confirm. `call.confirmed` came from the body,
      // not an authenticated account-session interaction.
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: call.functionName,
        arguments: call.args,
      },
    }),
  });

  if (!response.ok) {
    const detail = clip(await response.text().catch(() => response.statusText));
    throw new Error(
      `Compute Agent call failed (${response.status})${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  const envelope = await response.json() as JsonRpcEnvelope;
  if (envelope.error) {
    throw new Error(
      envelope.error.message ||
        `Compute Agent call failed (${envelope.error.code ?? "unknown"}).`,
    );
  }
  return unwrapMcpResult(envelope.result);
}
