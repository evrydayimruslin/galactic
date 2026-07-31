import {
  type AgentGrantCreateRequest,
  type AgentGrantSummary,
  DEFAULT_GRANT_MONTHLY_CAP_CREDITS,
} from "../../../../shared/contracts/agent-grants.ts";
import type {
  LaunchAgentHomeResponse,
} from "../../../../shared/contracts/launch.ts";
import type { LaunchApiClient } from "./api";

export interface AgentStudioStatus {
  label: string;
  tone: "live" | "waiting" | "stopped";
}

export interface AgentStudioSetupGrantRequest extends AgentGrantCreateRequest {
  monthlyCapCredits: number;
}

export interface AgentStudioSetupGrantResolution {
  grant: AgentGrantSummary;
  outcome: "already_active" | "approved" | "created";
}

export type AgentStudioSetupGrantClient = Pick<
  LaunchApiClient,
  "approveGrant" | "createGrant" | "listGrants"
>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function shouldShowAgentSetup(
  home: LaunchAgentHomeResponse,
): boolean {
  const mode = home.operatingSummary?.mode;
  return !home.release.live ||
    mode === "no_live_release" ||
    (
      home.state.lifecycle === "needs_setup" &&
      home.recentRuns.length === 0
    );
}

export function studioStatus(
  home: LaunchAgentHomeResponse | null | undefined,
): AgentStudioStatus {
  if (!home) return { label: "Loading", tone: "waiting" };
  if (
    home.state.lifecycle === "disabled" ||
    home.operatingSummary?.mode === "disabled"
  ) {
    return { label: "Disabled", tone: "stopped" };
  }
  if (
    home.state.health === "failing" ||
    home.operatingSummary?.mode === "error"
  ) {
    return { label: "Error", tone: "stopped" };
  }
  if (home.operatingSummary?.readiness.working) {
    return { label: "Live", tone: "live" };
  }
  if (
    home.state.lifecycle === "paused" ||
    home.operatingSummary?.mode === "paused"
  ) {
    return { label: "Paused", tone: "stopped" };
  }
  if (
    home.state.lifecycle === "needs_setup" ||
    home.operatingSummary?.mode === "no_live_release" ||
    home.operatingSummary?.mode === "setup_required"
  ) {
    return { label: "Setup", tone: "waiting" };
  }
  if (
    home.state.lifecycle === "ready" &&
    home.operatingSummary?.mode === "no_enabled_routine"
  ) {
    return { label: "Available on demand", tone: "live" };
  }
  return { label: "Waiting", tone: "waiting" };
}

/**
 * Return the exact opaque capability id that Agent Home accepts for one setup
 * requirement. Reporting/inference requirements are also represented as
 * capabilities, but they deliberately have no owner-approval action and must
 * never be smuggled through this path.
 */
export function agentStudioSetupCapabilityId(
  home: LaunchAgentHomeResponse,
  requirementId: string,
): string | null {
  const requirement = home.setup.requirements.find((item) =>
    item.id === requirementId
  );
  return requirement?.blocking === true &&
      requirement.required === true &&
      requirement.kind === "capability" &&
      requirement.actions.includes("approve") &&
      typeof requirement.actionId === "string" &&
      requirement.actionId.length > 0
    ? requirement.actionId
    : null;
}

/**
 * Compile a blocking grant requirement into the exact ambient CALL grant used
 * by scheduled routines. The function and target come from the typed routine
 * projection, never from parsing human-facing labels.
 */
export function agentStudioSetupGrantRequest(
  home: LaunchAgentHomeResponse,
  requirementId: string,
): AgentStudioSetupGrantRequest | null {
  const requirement = home.setup.requirements.find((item) =>
    item.id === requirementId
  );
  if (
    !requirement ||
    !requirement.blocking ||
    !requirement.required ||
    requirement.kind !== "grant" ||
    !requirement.id.startsWith("grant:")
  ) return null;

  const capabilityId = requirement.id.slice("grant:".length);
  if (!capabilityId) return null;
  const capability = home.routines?.routines
    .flatMap((routine) => routine.capabilities)
    .find((item) => item.id === capabilityId);
  if (!capability?.functionName) return null;
  const authority = home.authority.items.find((item) =>
    item.source === "routine" && item.actionId === capabilityId
  );
  const targetAppId = [capability.appId, authority?.target].find((value) =>
    typeof value === "string" && UUID_PATTERN.test(value)
  );
  if (!targetAppId) return null;

  return {
    callerAppId: home.agent.id,
    mode: "call",
    monthlyCapCredits: DEFAULT_GRANT_MONTHLY_CAP_CREDITS,
    targetAppId,
    targetFunction: capability.functionName,
  };
}

export function matchingAgentStudioSetupGrant(
  grants: readonly AgentGrantSummary[],
  request: AgentStudioSetupGrantRequest,
): AgentGrantSummary | null {
  const exact = grants.filter((grant) =>
    grant.mode === "call" &&
    grant.callerApp.id === request.callerAppId &&
    grant.callerFunction === null &&
    grant.slot === null &&
    grant.targetApp.id === request.targetAppId &&
    grant.targetFunction === request.targetFunction
  );
  return exact.find((grant) => grant.status === "active") ??
    exact.find((grant) => grant.status === "pending") ??
    exact.find((grant) => grant.status === "revoked") ??
    null;
}

/**
 * Resolve one cross-Agent setup blocker without weakening authority:
 * preserve and approve an existing pending proposal, replay an active grant,
 * or create an explicit owner grant with the platform's bounded default cap.
 */
export async function remediateAgentStudioSetupGrant(
  client: AgentStudioSetupGrantClient,
  home: LaunchAgentHomeResponse,
  requirementId: string,
): Promise<AgentStudioSetupGrantResolution> {
  const request = agentStudioSetupGrantRequest(home, requirementId);
  if (!request) {
    throw new Error(
      "This target Agent or function is no longer available. Update and retest the release before granting access.",
    );
  }
  const response = await client.listGrants({ caller: home.agent.id });
  const existing = matchingAgentStudioSetupGrant(response.grants, request);
  if (existing?.status === "active") {
    return { grant: existing, outcome: "already_active" };
  }
  if (existing?.status === "pending") {
    const approved = await client.approveGrant(existing.id);
    return { grant: approved.grant, outcome: "approved" };
  }
  const created = await client.createGrant(request);
  return { grant: created.grant, outcome: "created" };
}

/** Keep a request key only when the server outcome is unknown. */
export function retainIdempotencyKeyAfterFailure(reason: unknown): boolean {
  if (!reason || typeof reason !== "object" || !("status" in reason)) {
    return true;
  }
  const error = reason as {
    code?: unknown;
    responseBody?: unknown;
    status?: unknown;
  };
  if (
    error.responseBody &&
    typeof error.responseBody === "object" &&
    (error.responseBody as { terminal?: unknown }).terminal === false
  ) {
    return true;
  }
  if (
    typeof error.code === "string" &&
    (error.code.includes("STATUS_UNKNOWN") ||
      error.code.includes("ACTION_IN_PROGRESS"))
  ) {
    return true;
  }
  return typeof error.status !== "number" || error.status === 409 ||
    error.status >= 500;
}

const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function getOrCreateStudioActionKey(
  attemptSignature: string,
  memory: Map<string, string>,
): string {
  const storageKey = `galactic:agent-studio:action:${attemptSignature}`;
  let stored: string | null = null;
  try {
    stored = window.sessionStorage.getItem(storageKey);
  } catch {
    // The in-memory map still protects retries in this mounted session.
  }
  const key = memory.get(attemptSignature) ??
    (stored && IDEMPOTENCY_KEY_PATTERN.test(stored) ? stored : null) ??
    globalThis.crypto.randomUUID();
  memory.set(attemptSignature, key);
  try {
    window.sessionStorage.setItem(storageKey, key);
  } catch {
    // Keep the in-memory attempt.
  }
  return key;
}

export function clearStudioActionKey(
  attemptSignature: string,
  memory: Map<string, string>,
): void {
  memory.delete(attemptSignature);
  try {
    window.sessionStorage.removeItem(
      `galactic:agent-studio:action:${attemptSignature}`,
    );
  } catch {
    // The attempt is cleared in memory even when storage is unavailable.
  }
}
