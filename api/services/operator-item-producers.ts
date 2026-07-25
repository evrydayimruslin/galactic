import type {
  LaunchAgentEvidenceReference,
  LaunchAgentHomeRequirement,
  LaunchOperatorItemCandidate,
} from "../../shared/contracts/launch.ts";
import type { AccountCapacityStatus } from "./account-capacity.ts";
import {
  compileOperatorItems,
  type OperatorIssueAgentReference,
  type OperatorIssueCompilerInput,
} from "./operator-issue-compiler.ts";
import {
  reconcileOperatorItems,
  type ReconcileOperatorItemsInput,
  type ReconcileOperatorItemsResult,
} from "./operator-item-persistence.ts";
import type { LaunchOperatorRunDiagnostic } from "../../shared/contracts/launch.ts";

export const OPERATOR_ITEM_SOURCE = {
  accountByok: "setup.account",
  accountUsage: "usage.account",
  agentSetup: (agentId: string) => `setup.agent:${agentId}`,
  routineHealth: (routineId: string) => `routine.health:${routineId}`,
  routineUsage: (routineId: string) => `routine.usage:${routineId}`,
} as const;

type Reconcile = (
  input: ReconcileOperatorItemsInput,
) => Promise<ReconcileOperatorItemsResult>;

export interface OperatorItemProducerDependencies {
  reconcile?: Reconcile;
}

export interface OperatorItemProducerResult {
  sourceKey: string;
  reconciliation: ReconcileOperatorItemsResult;
}

function stableAgents(
  agents: readonly OperatorIssueAgentReference[],
): OperatorIssueAgentReference[] {
  const byId = new Map<string, OperatorIssueAgentReference>();
  for (const agent of agents) {
    if (!byId.has(agent.id)) byId.set(agent.id, agent);
  }
  return [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
}

async function persistCompiled(
  input: {
    userId: string;
    sourceKey: string;
    observedAt: string;
    conditions: readonly OperatorIssueCompilerInput[];
    completeSnapshot: boolean;
  },
  dependencies: OperatorItemProducerDependencies,
): Promise<OperatorItemProducerResult> {
  const items = compileOperatorItems(input.conditions);
  const reconcile = dependencies.reconcile ?? reconcileOperatorItems;
  return {
    sourceKey: input.sourceKey,
    reconciliation: await reconcile({
      userId: input.userId,
      sourceKey: input.sourceKey,
      items,
      observedAt: input.observedAt,
      completeSnapshot: input.completeSnapshot,
    }),
  };
}

/**
 * Agent Home is the trusted setup producer. Account BYOK is intentionally
 * excluded here: one Agent snapshot must never recover a shared blocker still
 * affecting another Agent.
 */
export async function reconcileAgentSetupOperatorItems(
  input: {
    userId: string;
    agent: OperatorIssueAgentReference;
    requirements: readonly LaunchAgentHomeRequirement[];
    observedAt: string;
  },
  dependencies: OperatorItemProducerDependencies = {},
): Promise<OperatorItemProducerResult> {
  const conditions = input.requirements
    .filter((requirement) => requirement.id !== "inference:byok")
    .map((requirement, sourceOrdinal): OperatorIssueCompilerInput => ({
      condition: "setup_requirement",
      agent: input.agent,
      requirement,
      detectedAt: input.observedAt,
      sourceOrdinal,
    }));
  return await persistCompiled({
    userId: input.userId,
    sourceKey: OPERATOR_ITEM_SOURCE.agentSetup(input.agent.id),
    observedAt: input.observedAt,
    conditions,
    completeSnapshot: true,
  }, dependencies);
}

/**
 * BYOK is an account-owned condition. Its complete snapshot is compiled once
 * with exact affected-Agent membership, so configuring one provider clears the
 * shared blocker without N independently-owned copies.
 */
export async function reconcileAccountByokOperatorItem(
  input: {
    userId: string;
    configured: boolean;
    affectedAgents: readonly OperatorIssueAgentReference[];
    observedAt: string;
  },
  dependencies: OperatorItemProducerDependencies = {},
): Promise<OperatorItemProducerResult> {
  const affectedAgents = stableAgents(input.affectedAgents);
  const conditions: OperatorIssueCompilerInput[] =
    !input.configured && affectedAgents.length > 0
      ? [{
        condition: "account_byok_missing",
        affectedAgents,
        detectedAt: input.observedAt,
      }]
      : [];
  return await persistCompiled({
    userId: input.userId,
    sourceKey: OPERATOR_ITEM_SOURCE.accountByok,
    observedAt: input.observedAt,
    conditions,
    completeSnapshot: true,
  }, dependencies);
}

export async function reconcileRoutineUsageOperatorItem(
  input: {
    userId: string;
    agent: OperatorIssueAgentReference;
    routine: { id: string; name: string };
    gate: {
      period: "daily" | "monthly";
      spent: number;
      limit: number;
      resetsAt: string;
    } | null;
    observedAt: string;
  },
  dependencies: OperatorItemProducerDependencies = {},
): Promise<OperatorItemProducerResult> {
  const conditions: OperatorIssueCompilerInput[] = input.gate
    ? [{
      condition: "routine_usage_exhausted",
      agent: input.agent,
      routine: input.routine,
      period: input.gate.period,
      spent: input.gate.spent,
      limit: input.gate.limit,
      resetsAt: input.gate.resetsAt,
      detectedAt: input.observedAt,
    }]
    : [];
  return await persistCompiled({
    userId: input.userId,
    sourceKey: OPERATOR_ITEM_SOURCE.routineUsage(input.routine.id),
    observedAt: input.observedAt,
    conditions,
    completeSnapshot: true,
  }, dependencies);
}

/**
 * A pause event opens/refreshes the health condition, but does not provide a
 * complete health snapshot. M7's successful verification owns recovery.
 */
export async function recordRoutinePausedOperatorItem(
  input: {
    userId: string;
    agent: OperatorIssueAgentReference;
    routine: { id: string; name: string };
    failedAttempts: number;
    latestRunId: string | null;
    diagnostic: LaunchOperatorRunDiagnostic | null;
    observedAt: string;
  },
  dependencies: OperatorItemProducerDependencies = {},
): Promise<OperatorItemProducerResult> {
  const evidence: LaunchAgentEvidenceReference[] = input.latestRunId
    ? [{
      kind: "run",
      sourceId: input.latestRunId,
      label: "Latest failed run",
      observedAt: input.observedAt,
    }]
    : [];
  return await persistCompiled({
    userId: input.userId,
    sourceKey: OPERATOR_ITEM_SOURCE.routineHealth(input.routine.id),
    observedAt: input.observedAt,
    conditions: [{
      condition: "routine_paused_after_failures",
      agent: input.agent,
      routine: input.routine,
      failedAttempts: input.failedAttempts,
      latestRunId: input.latestRunId,
      diagnostic: input.diagnostic
        ? {
          causeCode: input.diagnostic.causeCode,
          summary: input.diagnostic.summary,
          detail: input.diagnostic.detail,
          provenance: input.diagnostic.provenance,
          suggestedActions: input.diagnostic.suggestedActions,
          evidence,
        }
        : null,
      detectedAt: input.observedAt,
    }],
    completeSnapshot: false,
  }, dependencies);
}

/**
 * A successful M7 verification is a complete observation that the routine
 * health condition is absent. Persistence recovers only the active episode for
 * this exact source; it never changes the routine's paused schedule state.
 */
export async function recoverRoutineHealthOperatorItem(
  input: {
    userId: string;
    routineId: string;
    observedAt: string;
  },
  dependencies: OperatorItemProducerDependencies = {},
): Promise<OperatorItemProducerResult> {
  return await persistCompiled({
    userId: input.userId,
    sourceKey: OPERATOR_ITEM_SOURCE.routineHealth(input.routineId),
    observedAt: input.observedAt,
    conditions: [],
    completeSnapshot: true,
  }, dependencies);
}

export function accountUsageConditions(
  status: Pick<AccountCapacityStatus, "burst" | "weekly">,
  affectedAgentsInput: readonly OperatorIssueAgentReference[],
  observedAt: string,
): OperatorIssueCompilerInput[] {
  const affectedAgents = stableAgents(affectedAgentsInput);
  if (affectedAgents.length === 0) return [];
  const conditions: OperatorIssueCompilerInput[] = [];
  if (status.burst.state === "waiting") {
    conditions.push({
      condition: "account_usage_exhausted",
      affectedAgents,
      period: "five_hour",
      resetsAt: status.burst.resetsAt,
      detectedAt: observedAt,
      sourceOrdinal: 0,
    });
  }
  if (status.weekly.state === "waiting") {
    conditions.push({
      condition: "account_usage_exhausted",
      affectedAgents,
      period: "weekly",
      resetsAt: status.weekly.resetsAt,
      detectedAt: observedAt,
      sourceOrdinal: 1,
    });
  }
  return conditions;
}

export async function reconcileAccountUsageOperatorItems(
  input: {
    userId: string;
    status: Pick<AccountCapacityStatus, "burst" | "weekly">;
    affectedAgents: readonly OperatorIssueAgentReference[];
    observedAt: string;
  },
  dependencies: OperatorItemProducerDependencies = {},
): Promise<OperatorItemProducerResult> {
  return await persistCompiled({
    userId: input.userId,
    sourceKey: OPERATOR_ITEM_SOURCE.accountUsage,
    observedAt: input.observedAt,
    conditions: accountUsageConditions(
      input.status,
      input.affectedAgents,
      input.observedAt,
    ),
    completeSnapshot: true,
  }, dependencies);
}

function producerErrorCode(error: unknown): string {
  if (
    typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code)
  ) {
    return error.code;
  }
  return error instanceof Error &&
      /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(error.name)
    ? error.name
    : "OPERATOR_PRODUCER_FAILED";
}

/**
 * Producer shadow writes must never fail the domain operation that observed
 * the condition. Logs contain only a closed source key and error code—never a
 * diagnostic message, request body, credential, or persistence response.
 */
export async function runOperatorItemProducerBestEffort(
  sourceKey: string,
  task: () => Promise<unknown>,
  log: (message: string, fields: Record<string, unknown>) => void = (
    message,
    fields,
  ) => console.error(message, fields),
): Promise<void> {
  try {
    await task();
  } catch (error) {
    log("[OPERATOR-ITEMS] producer reconciliation failed", {
      sourceKey,
      errorCode: producerErrorCode(error),
    });
  }
}

export async function scheduleOperatorItemProducer(
  sourceKey: string,
  task: () => Promise<unknown>,
): Promise<void> {
  const reconciliation = runOperatorItemProducerBestEffort(sourceKey, task);
  const ctx = (globalThis as {
    __ctx?: { waitUntil?: (promise: Promise<unknown>) => void };
  }).__ctx;
  if (ctx?.waitUntil) {
    ctx.waitUntil(reconciliation);
    return;
  }
  // Non-Worker runtimes have no lifecycle extension primitive. Awaiting keeps
  // local servers and tests deterministic instead of leaking a background
  // digest/fetch into the next request.
  await reconciliation;
}

export function operatorItemCandidates(
  conditions: readonly OperatorIssueCompilerInput[],
): LaunchOperatorItemCandidate[] {
  return compileOperatorItems(conditions);
}
