import type { LaunchOperatorItemActionResponse } from "../../shared/contracts/launch.ts";
import {
  AgentHomeRevisionError,
  claimAgentHomeAction,
  completeAgentHomeAction,
  queueOperatorItemRoutineRunOnce,
  resolveOperatorItemRoutineRunOnce,
} from "./agent-home-revision.ts";
import type { RequestAuthSource } from "./request-auth.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

type Resolve = typeof resolveOperatorItemRoutineRunOnce;
type Claim = typeof claimAgentHomeAction;
type Queue = typeof queueOperatorItemRoutineRunOnce;
type Complete = typeof completeAgentHomeAction;

interface OperatorItemExecutionDependencies {
  resolve?: Resolve;
  claim?: Claim;
  queue?: Queue;
  complete?: Complete;
  now?: () => Date;
}

export class OperatorItemExecutionError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "ACTION_FAILED"
      | "STATUS_UNKNOWN"
      | "INVALID_RESPONSE",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OperatorItemExecutionError";
  }
}

function requestUuid(value: string, label: string): string {
  if (!UUID.test(value)) {
    throw new OperatorItemExecutionError(
      "INVALID_REQUEST",
      `${label} must be a UUID.`,
      400,
    );
  }
  return value.toLowerCase();
}

function requestIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) {
    throw new OperatorItemExecutionError(
      "INVALID_REQUEST",
      `${label} is invalid.`,
      400,
    );
  }
  return normalized;
}

function storedRunOnceResponse(
  value: Record<string, unknown>,
): Omit<LaunchOperatorItemActionResponse, "replayed" | "generatedAt"> {
  if (
    value.code !== "OPERATOR_ITEM_ACTION_QUEUED" ||
    value.action !== "run_once" ||
    typeof value.itemId !== "string" || !UUID.test(value.itemId) ||
    typeof value.remediationId !== "string" ||
    !IDENTIFIER.test(value.remediationId) ||
    typeof value.requestId !== "string" || !UUID.test(value.requestId) ||
    typeof value.runId !== "string" || !UUID.test(value.runId) ||
    value.state !== "queued" ||
    value.scheduleState !== "paused"
  ) {
    throw new OperatorItemExecutionError(
      "INVALID_RESPONSE",
      "The saved remediation result is invalid.",
      503,
    );
  }
  return {
    itemId: value.itemId.toLowerCase(),
    remediationId: value.remediationId,
    action: "run_once",
    requestId: value.requestId.toLowerCase(),
    runId: value.runId.toLowerCase(),
    state: "queued",
    scheduleState: "paused",
  };
}

/**
 * Queues one real execution from an exact canonical issue remediation.
 *
 * The durable Agent Home saga makes acknowledgement retries idempotent. Both
 * target resolution and queue insertion are server-owned; no client-supplied
 * Agent or routine identifier crosses the execution trust boundary.
 */
export async function executeOperatorItemRemediation(
  input: {
    userId: string;
    itemId: string;
    remediationId: string;
    idempotencyKey: string;
    expectedRevision: string;
    authSource: RequestAuthSource | string | null | undefined;
  },
  dependencies: OperatorItemExecutionDependencies = {},
): Promise<LaunchOperatorItemActionResponse> {
  const itemId = requestUuid(input.itemId, "itemId");
  const remediationId = requestIdentifier(
    input.remediationId,
    "remediationId",
  );
  const idempotencyKey = requestUuid(
    input.idempotencyKey,
    "idempotencyKey",
  );
  const resolve = dependencies.resolve ?? resolveOperatorItemRoutineRunOnce;
  const claimAction = dependencies.claim ?? claimAgentHomeAction;
  const queueRun = dependencies.queue ?? queueOperatorItemRoutineRunOnce;
  const completeAction = dependencies.complete ?? completeAgentHomeAction;
  const now = dependencies.now ?? (() => new Date());

  const target = await resolve({
    userId: input.userId,
    itemId,
    remediationId,
    authSource: input.authSource,
  });
  const claim = await claimAction({
    appId: target.appId,
    userId: input.userId,
    expectedRevision: input.expectedRevision,
    authSource: input.authSource,
    idempotencyKey,
    action: "operator_run_once",
    requestPayload: {
      routineId: target.routineId,
      operatorItemId: itemId,
      remediationId,
    },
  });

  if (claim.status === "completed") {
    return {
      ...storedRunOnceResponse(claim.response),
      replayed: true,
      generatedAt: now().toISOString(),
    };
  }
  if (claim.status === "failed") {
    throw new OperatorItemExecutionError(
      "ACTION_FAILED",
      "The previous remediation attempt failed. Recheck the live issue before trying again.",
      typeof claim.response.status === "number" &&
        claim.response.status >= 400 &&
        claim.response.status < 500
        ? claim.response.status
        : 409,
    );
  }

  let queued: { runId: string; isNew: boolean };
  try {
    queued = await queueRun({
      appId: target.appId,
      userId: input.userId,
      routineId: target.routineId,
      itemId,
      remediationId,
      requestId: claim.requestId,
      leaseToken: claim.leaseToken,
      expectedRevision: input.expectedRevision,
      authSource: input.authSource,
    });
  } catch (error) {
    if (error instanceof AgentHomeRevisionError && error.status < 500) {
      await completeAction({
        appId: target.appId,
        userId: input.userId,
        requestId: claim.requestId,
        leaseToken: claim.leaseToken,
        authSource: input.authSource,
        status: "failed",
        response: {
          code: error.code,
          error: error.message,
          status: error.status,
        },
      }).catch(() => {});
    }
    throw error;
  }

  const stored = {
    code: "OPERATOR_ITEM_ACTION_QUEUED",
    itemId,
    remediationId,
    action: "run_once",
    requestId: claim.requestId,
    runId: queued.runId,
    state: "queued",
    scheduleState: "paused",
  } as const;
  try {
    await completeAction({
      appId: target.appId,
      userId: input.userId,
      requestId: claim.requestId,
      leaseToken: claim.leaseToken,
      authSource: input.authSource,
      status: "completed",
      response: stored,
    });
  } catch {
    throw new OperatorItemExecutionError(
      "STATUS_UNKNOWN",
      "The run was queued, but its durable acknowledgement could not be confirmed. Retry with the same idempotency key.",
      503,
    );
  }

  return {
    ...storedRunOnceResponse(stored),
    replayed: !queued.isNew,
    generatedAt: now().toISOString(),
  };
}
