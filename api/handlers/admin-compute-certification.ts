import { json } from "./response.ts";
import {
  type ComputeCertificationArtifact,
  type ComputeCertificationBacking,
  type ComputeCertificationBudget,
  ComputeCertificationError,
  type ComputeCertificationHealth,
  type ComputeCertificationReceipt,
  type ComputeCertificationRun,
  type ComputeCertificationSnapshot,
  getComputeCertificationSnapshot,
} from "../services/compute-certification.ts";
import type { ComputeDatabaseDeps } from "../services/compute/database.ts";
import type {
  ComputeCertificationPrincipal,
} from "../services/compute-certification-auth.ts";

const MAX_BODY_BYTES = 16_384;
const REQUEST_KEYS = ["agent_id", "owner_id", "run_ids", "since"] as const;

function privateResponse(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Vary", "Authorization");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

function invalid(message: string, status = 400): ComputeCertificationError {
  return new ComputeCertificationError(
    "COMPUTE_CERTIFICATION_INVALID",
    status,
    message,
  );
}

function isJsonMediaType(request: Request): boolean {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]
    .trim().toLowerCase();
  return mediaType === "application/json" ||
    mediaType?.endsWith("+json") === true;
}

async function boundedRequestText(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel("request body too large").catch(() => undefined);
        throw invalid("Compute certification request body is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("Compute certification request body must be UTF-8 JSON.");
  }
}

async function parseRequest(request: Request): Promise<{
  ownerId: string;
  agentId: string;
  runIds: string[];
  since: string;
}> {
  if (!isJsonMediaType(request)) {
    throw invalid("Content-Type must be application/json.", 415);
  }
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw invalid("Compute certification request body is too large.", 413);
  }
  const text = await boundedRequestText(request);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw invalid("Compute certification request body must be valid JSON.");
  }
  if (
    decoded === null || typeof decoded !== "object" || Array.isArray(decoded)
  ) {
    throw invalid("Compute certification request body must be an object.");
  }
  const body = decoded as Record<string, unknown>;
  const suppliedKeys = Object.keys(body).sort();
  const expectedKeys = [...REQUEST_KEYS].sort();
  if (
    suppliedKeys.length !== expectedKeys.length ||
    suppliedKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw invalid("Compute certification request has an unexpected schema.");
  }
  if (
    typeof body.owner_id !== "string" ||
    typeof body.agent_id !== "string" ||
    typeof body.since !== "string" ||
    !Array.isArray(body.run_ids) ||
    body.run_ids.some((runId) => typeof runId !== "string")
  ) {
    throw invalid("Compute certification request has invalid field types.");
  }
  return {
    ownerId: body.owner_id,
    agentId: body.agent_id,
    runIds: body.run_ids as string[],
    since: body.since,
  };
}

function artifactBody(artifact: ComputeCertificationArtifact) {
  return {
    artifact_id: artifact.artifactId,
    direction: artifact.direction,
    state: artifact.state,
    state_version: artifact.stateVersion,
    sha256: artifact.sha256,
    size_bytes: artifact.sizeBytes,
    expires_at: artifact.expiresAt,
    object_deleted: artifact.objectDeleted,
  };
}

function backingBody(backing: ComputeCertificationBacking) {
  return {
    run_capacity_reservation: backing.runCapacityReservation,
    budget_hold: backing.budgetHold,
    budget_capacity_reservation: backing.budgetCapacityReservation,
    receipt_hold: backing.receiptHold,
    receipt_capacity_reservation: backing.receiptCapacityReservation,
    receipt_cloud_usage_event: backing.receiptCloudUsageEvent,
    budget_matches_run_capacity: backing.budgetMatchesRunCapacity,
    receipt_matches_run_capacity: backing.receiptMatchesRunCapacity,
    receipt_matches_budget_hold: backing.receiptMatchesBudgetHold,
    budget_owner_match: backing.budgetOwnerMatch,
    budget_capacity_agent_match: backing.budgetCapacityAgentMatch,
    receipt_principal_match: backing.receiptPrincipalMatch,
    receipt_capacity_agent_match: backing.receiptCapacityAgentMatch,
  };
}

function budgetBody(budget: ComputeCertificationBudget | null) {
  return budget === null ? null : {
    status: budget.status,
    billing_mode: budget.billingMode,
    rate_version: budget.rateVersion,
    rate_light_per_ms: budget.rateLightPerMs,
    actual_wall_ms: budget.actualWallMs,
    reserved_wall_ms: budget.reservedWallMs,
    teardown_allowance_ms: budget.teardownAllowanceMs,
    reserved_light: budget.reservedLight,
    actual_light: budget.actualLight,
    released_light: budget.releasedLight,
    expires_at: budget.expiresAt,
    settled_at: budget.settledAt,
  };
}

function receiptBody(receipt: ComputeCertificationReceipt | null) {
  return receipt === null ? null : {
    id: receipt.id,
    outcome: receipt.outcome,
    billing_mode: receipt.billingMode,
    rate_version: receipt.rateVersion,
    capacity_settlement_status: receipt.capacitySettlementStatus,
    reserved_light: receipt.reservedLight,
    actual_light: receipt.actualLight,
    released_light: receipt.releasedLight,
    worker_wall_ms: receipt.workerWallMs,
    teardown_allowance_ms: receipt.teardownAllowanceMs,
    billed_wall_ms: receipt.billedWallMs,
    created_at: receipt.createdAt,
  };
}

function runBody(run: ComputeCertificationRun) {
  return {
    run_id: run.runId,
    receipt_id: run.receiptId,
    owner_id: run.ownerId,
    agent_id: run.agentId,
    caller_function: run.callerFunction,
    state: run.state,
    state_version: run.stateVersion,
    billing_mode: run.billingMode,
    capacity_agent_id: run.capacityAgentId,
    environment_digest: run.environmentDigest,
    directive_hash: run.directiveHash,
    request_hash: run.requestHash,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    expires_at: run.expiresAt,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    cardinality: {
      budget_rows: run.cardinality.budgetRows,
      receipt_rows: run.cardinality.receiptRows,
      token_rows: run.cardinality.tokenRows,
      artifact_rows: run.cardinality.artifactRows,
      input_artifact_rows: run.cardinality.inputArtifactRows,
      output_artifact_rows: run.cardinality.outputArtifactRows,
      projected_artifact_rows: run.cardinality.projectedArtifactRows,
    },
    backing: backingBody(run.backing),
    budget: budgetBody(run.budget),
    receipt: receiptBody(run.receipt),
    terminal_active_token_count: run.terminalActiveTokenCount,
    artifacts: run.artifacts.map(artifactBody),
    violations: run.violations,
  };
}

function healthBody(health: ComputeCertificationHealth) {
  return {
    stale_nonterminal_runs: health.staleNonterminalRuns,
    old_settlement_pending: health.oldSettlementPending,
    terminal_reserved_budgets: health.terminalReservedBudgets,
    receipt_mismatches: health.receiptMismatches,
    terminal_active_tokens: health.terminalActiveTokens,
    dlq_fenced_runs: health.dlqFencedRuns,
    stale_pending_artifacts: health.stalePendingArtifacts,
    unreconciled_deleted_outputs: health.unreconciledDeletedOutputs,
    terminal_input_aliases: health.terminalInputAliases,
    violations: health.violations,
  };
}

function responseBody(snapshot: ComputeCertificationSnapshot) {
  return {
    schema_version: snapshot.schemaVersion,
    generated_at: snapshot.generatedAt,
    owner_id: snapshot.ownerId,
    agent_id: snapshot.agentId,
    since: snapshot.since,
    latch_state: snapshot.latchState,
    requested_run_count: snapshot.requestedRunCount,
    selected_run_count: snapshot.selectedRunCount,
    runs: snapshot.runs.map(runBody),
    health: healthBody(snapshot.health),
    violations: snapshot.violations,
  };
}

export async function handleAdminComputeCertification(
  request: Request,
  deps: ComputeDatabaseDeps & {
    authorizedPrincipal?: ComputeCertificationPrincipal;
    readSnapshot?: typeof getComputeCertificationSnapshot;
  } = {},
): Promise<Response> {
  try {
    const input = await parseRequest(request);
    if (!deps.authorizedPrincipal) {
      throw new ComputeCertificationError(
        "COMPUTE_CERTIFICATION_AUTH_UNAVAILABLE",
        503,
        "Compute certification authorization is unavailable.",
      );
    }
    if (
      input.ownerId !== deps.authorizedPrincipal.ownerId ||
      input.agentId !== deps.authorizedPrincipal.agentId
    ) {
      throw new ComputeCertificationError(
        "COMPUTE_CERTIFICATION_PRINCIPAL_FORBIDDEN",
        403,
        "Compute certification principal is outside this credential's scope.",
      );
    }
    const readSnapshot = deps.readSnapshot ?? getComputeCertificationSnapshot;
    const {
      authorizedPrincipal: _authorizedPrincipal,
      readSnapshot: _readSnapshot,
      ...database
    } = deps;
    const snapshot = await readSnapshot(input, database);
    return privateResponse(json(responseBody(snapshot)));
  } catch (caught) {
    if (caught instanceof ComputeCertificationError) {
      return privateResponse(json({
        error: caught.message,
        code: caught.code,
      }, caught.status));
    }
    console.error("[COMPUTE] Certification snapshot request failed", {
      code: "COMPUTE_CERTIFICATION_UNAVAILABLE",
    });
    return privateResponse(json({
      error: "Compute certification snapshot is unavailable.",
      code: "COMPUTE_CERTIFICATION_UNAVAILABLE",
    }, 503));
  }
}
