// Pillar P3: approval envelopes — the durable continuation of a run held
// by an 'ask' policy.
//
// The envelope is the OWNER-SAFE record (I10): sanitized proposal + source
// only; the raw input lives on the held async_jobs row (service plane) and
// is never projected here. Resolution is full CAS (I5): approve/revise/
// reject present the revision they read and an idempotency key, and a lost
// race returns the surviving state instead of double-acting. Approve flips
// the held job to 'queued' through the same status filter the queue
// consumer claims through — resumption is exactly-once (I9). Envelopes
// expire rather than lurk: listing lazily settles overdue pending rows to
// 'expired' so the store never shows an actionable hold that is not.

import { getEnv } from "../lib/env.ts";
import type {
  LaunchApprovalEnvelope,
  LaunchApprovalStatus,
  LaunchFunctionConsequenceGroup,
} from "../../shared/contracts/launch.ts";
import { hashJsonStable, PolicyConflictError } from "./policy-gate.ts";

export const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const REDACTED = "•••";
const SECRET_KEY_PATTERN =
  /secret|token|password|credential|authorization|api[_-]?key|private[_-]?key/i;
const STRING_CLIP = 160;
const ARRAY_CAP = 8;
const MAX_DEPTH = 3;

export interface ApprovalRow {
  id: string;
  app_id: string;
  user_id: string;
  owner_id: string;
  status: LaunchApprovalStatus;
  revision: string;
  job_id: string | null;
  release_id: string | null;
  release_version: string | null;
  function_name: string;
  consequence: LaunchFunctionConsequenceGroup;
  input_hash: string;
  trigger: string | null;
  run_id: string;
  routine_id: string | null;
  routine_run_id: string | null;
  trace_id: string | null;
  policy_revision: string;
  source: Record<string, unknown>;
  proposal: Record<string, unknown>;
  resolved_by: Record<string, unknown> | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
}

function supabaseHeaders(extra?: Record<string, string>) {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(extra || {}),
  };
}

function restUrl(path: string): string {
  return `${getEnv("SUPABASE_URL")}/rest/v1/${path}`;
}

/**
 * Owner-safe projection of a function input (I10). Values under
 * secret-looking keys are redacted; long strings clip; depth and array
 * length are bounded. `lossless: true` marks a preview that IS the input —
 * the only case where a revise UI may round-trip the preview back as
 * revisedInput without clobbering hidden values.
 */
export function sanitizeProposal(args: Record<string, unknown>): {
  argKeys: string[];
  preview: Record<string, unknown>;
  lossless: boolean;
} {
  let lossless = true;
  const sanitize = (value: unknown, depth: number, keyHint: string): unknown => {
    if (SECRET_KEY_PATTERN.test(keyHint)) {
      lossless = false;
      return REDACTED;
    }
    if (typeof value === "string") {
      if (value.length > STRING_CLIP) {
        lossless = false;
        return `${value.slice(0, STRING_CLIP)}…`;
      }
      return value;
    }
    if (value === null || typeof value !== "object") return value;
    if (depth >= MAX_DEPTH) {
      lossless = false;
      return Array.isArray(value) ? "[…]" : "{…}";
    }
    if (Array.isArray(value)) {
      const kept = value.slice(0, ARRAY_CAP).map((item) =>
        sanitize(item, depth + 1, keyHint)
      );
      if (value.length > ARRAY_CAP) {
        lossless = false;
        kept.push(`… ${value.length - ARRAY_CAP} more`);
      }
      return kept;
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        sanitize(v, depth + 1, k),
      ]),
    );
  };
  const preview = sanitize(args, 0, "") as Record<string, unknown>;
  return { argKeys: Object.keys(args), preview, lossless };
}

export async function createApprovalEnvelope(input: {
  appId: string;
  userId: string;
  ownerId: string;
  jobId: string;
  executionId: string;
  functionName: string;
  consequence: LaunchFunctionConsequenceGroup;
  args: Record<string, unknown>;
  trigger: string | null;
  releaseId: string | null;
  releaseVersion: string | null;
  routineId: string | null;
  routineRunId: string | null;
  traceId: string | null;
  policyRevision: string;
}): Promise<ApprovalRow> {
  const { argKeys, preview, lossless } = sanitizeProposal(input.args);
  const now = Date.now();
  const res = await fetch(restUrl("agent_approvals"), {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify({
      app_id: input.appId,
      user_id: input.userId,
      owner_id: input.ownerId,
      status: "pending",
      revision: crypto.randomUUID(),
      job_id: input.jobId,
      release_id: input.releaseId,
      release_version: input.releaseVersion,
      function_name: input.functionName,
      consequence: input.consequence,
      input_hash: await hashJsonStable(input.args),
      trigger: input.trigger,
      run_id: input.executionId,
      routine_id: input.routineId,
      routine_run_id: input.routineRunId,
      trace_id: input.traceId,
      policy_revision: input.policyRevision,
      source: {
        kind: input.routineId ? "routine_wake" : "autonomous_call",
        routineId: input.routineId,
        routineRunId: input.routineRunId,
        trigger: input.trigger,
      },
      proposal: { argKeys, preview, lossless },
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to create approval envelope: ${err}`);
  }
  return ((await res.json()) as ApprovalRow[])[0];
}

async function readApproval(
  appId: string,
  approvalId: string,
): Promise<ApprovalRow | null> {
  const res = await fetch(
    restUrl(
      `agent_approvals?id=eq.${encodeURIComponent(approvalId)}` +
        `&app_id=eq.${encodeURIComponent(appId)}&limit=1`,
    ),
    { headers: supabaseHeaders() },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to read approval: ${err}`);
  }
  const rows = await res.json() as ApprovalRow[];
  return rows[0] ?? null;
}

/**
 * Newest-first envelope list. Overdue pending rows settle to 'expired'
 * first (best-effort CAS by revision — a lost race means someone resolved
 * them, which the re-read reflects).
 */
export async function listApprovalEnvelopes(
  userId: string,
  appId: string,
  limit = 50,
): Promise<ApprovalRow[]> {
  const query = `agent_approvals?app_id=eq.${encodeURIComponent(appId)}` +
    `&user_id=eq.${encodeURIComponent(userId)}` +
    `&order=created_at.desc&limit=${limit}`;
  const res = await fetch(restUrl(query), { headers: supabaseHeaders() });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to list approvals: ${err}`);
  }
  let rows = await res.json() as ApprovalRow[];
  const overdue = rows.filter((row) =>
    row.status === "pending" && Date.parse(row.expires_at) < Date.now()
  );
  if (overdue.length > 0) {
    await Promise.all(overdue.map((row) =>
      fetch(
        restUrl(
          `agent_approvals?id=eq.${row.id}&status=eq.pending` +
            `&revision=eq.${encodeURIComponent(row.revision)}`,
        ),
        {
          method: "PATCH",
          headers: supabaseHeaders(),
          body: JSON.stringify({
            status: "expired",
            revision: crypto.randomUUID(),
            resolved_at: new Date().toISOString(),
            resolved_by: { kind: "system", source: "ttl" },
          }),
        },
      ).catch(() => null)
    ));
    const reread = await fetch(restUrl(query), { headers: supabaseHeaders() });
    if (reread.ok) rows = await reread.json() as ApprovalRow[];
  }
  return rows;
}

/** Job statuses for envelopes in 'resuming' — terminal ones project onward. */
export async function readResumedJobStatuses(
  jobIds: string[],
): Promise<Map<string, string>> {
  if (jobIds.length === 0) return new Map();
  const res = await fetch(
    restUrl(
      `async_jobs?id=in.(${jobIds.map(encodeURIComponent).join(",")})` +
        `&select=id,status`,
    ),
    { headers: supabaseHeaders() },
  );
  if (!res.ok) return new Map();
  const rows = await res.json() as Array<{ id: string; status: string }>;
  return new Map(rows.map((row) => [row.id, row.status]));
}

/**
 * The stored status, advanced by what actually happened to the resumed job.
 * 'resuming' + terminal job -> completed/failed at projection time; the
 * envelope row itself stays 'resuming' (the job row is the execution truth,
 * we do not mirror it eagerly).
 */
export function deriveEnvelopeStatus(
  row: ApprovalRow,
  jobStatus: string | undefined,
): LaunchApprovalStatus {
  if (row.status === "resuming" && jobStatus) {
    if (jobStatus === "completed") return "completed";
    if (jobStatus === "failed") return "failed";
  }
  return row.status;
}

export function projectEnvelope(
  row: ApprovalRow,
  jobStatus?: string,
): LaunchApprovalEnvelope {
  return {
    id: row.id,
    agentId: row.app_id,
    status: deriveEnvelopeStatus(row, jobStatus),
    revision: row.revision,
    releaseId: row.release_id ?? "",
    releaseVersion: row.release_version ?? "",
    functionName: row.function_name,
    consequence: row.consequence,
    inputHash: row.input_hash,
    trigger: row.trigger ?? "schedule",
    runId: row.run_id,
    routineId: row.routine_id,
    routineRunId: row.routine_run_id,
    traceId: row.trace_id,
    policyRevision: row.policy_revision,
    source: row.source ?? {},
    proposal: row.proposal ?? {},
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
  };
}

/**
 * CAS transition pending -> next. Returns the transitioned row or null if
 * the race was lost (someone else resolved, or TTL settled it).
 */
async function transitionApproval(
  row: ApprovalRow,
  expectedRevision: string,
  next: {
    status: LaunchApprovalStatus;
    resolvedBy: Record<string, unknown>;
  },
): Promise<ApprovalRow | null> {
  const res = await fetch(
    restUrl(
      `agent_approvals?id=eq.${row.id}&status=eq.pending` +
        `&revision=eq.${encodeURIComponent(expectedRevision)}`,
    ),
    {
      method: "PATCH",
      headers: supabaseHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify({
        status: next.status,
        revision: crypto.randomUUID(),
        resolved_at: new Date().toISOString(),
        resolved_by: next.resolvedBy,
      }),
    },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to transition approval: ${err}`);
  }
  const rows = await res.json() as ApprovalRow[];
  return rows[0] ?? null;
}

export interface ResolveApprovalDeps {
  /** Replace the held job's args (revise). False = job vanished/not held. */
  reviseHeldJobArgs: (
    jobId: string,
    args: Record<string, unknown>,
  ) => Promise<boolean>;
  /** held -> queued CAS + enqueue; false = the flip lost (already moved). */
  resumeHeldJob: (jobId: string) => Promise<boolean>;
  /** held -> denied CAS; idempotent. */
  denyHeldJob: (jobId: string) => Promise<boolean>;
  /** Best-effort ask->free flip when the owner says stop asking. */
  stopAsking?: (functionName: string) => Promise<void>;
  /** Best-effort witness write for the resolution (P0 stream). */
  recordResolutionEffect?: (
    row: ApprovalRow,
    outcome: string,
  ) => Promise<void>;
}

export async function resolveApproval(
  input: {
    userId: string;
    appId: string;
    approvalId: string;
    action: "approve" | "revise" | "reject";
    expectedRevision: string;
    idempotencyKey: string;
    revisedInput?: Record<string, unknown>;
    stopAsking?: boolean;
  },
  deps: ResolveApprovalDeps,
): Promise<ApprovalRow> {
  const row = await readApproval(input.appId, input.approvalId);
  if (!row) throw new ApprovalNotFoundError();
  if (
    row.resolved_by &&
    row.resolved_by.idempotencyKey === input.idempotencyKey
  ) {
    // The double-submit of a write that already landed.
    return row;
  }
  if (row.status !== "pending") {
    throw new PolicyConflictError(
      `This approval was already resolved (${row.status}).`,
    );
  }
  if (Date.parse(row.expires_at) < Date.now()) {
    await transitionApproval(row, row.revision, {
      status: "expired",
      resolvedBy: { kind: "system", source: "ttl" },
    }).catch(() => null);
    throw new PolicyConflictError("This approval expired before resolution.");
  }
  if (input.expectedRevision !== row.revision) {
    throw new PolicyConflictError(
      "This approval changed since you read it.",
    );
  }

  const resolvedBy = {
    kind: "user",
    userId: input.userId,
    action: input.action,
    idempotencyKey: input.idempotencyKey,
    ...(input.stopAsking ? { stopAsking: true } : {}),
  };

  if (input.action === "reject") {
    const transitioned = await transitionApproval(row, input.expectedRevision, {
      status: "rejected",
      resolvedBy,
    });
    if (!transitioned) {
      throw new PolicyConflictError("This approval changed since you read it.");
    }
    if (row.job_id) await deps.denyHeldJob(row.job_id).catch(() => false);
    await deps.recordResolutionEffect?.(
      row,
      "rejected by owner",
    ).catch(() => undefined);
    return transitioned;
  }

  // approve | revise — the job must still be resumable before we commit.
  if (!row.job_id) {
    throw new PolicyConflictError(
      "This approval has no resumable work attached.",
    );
  }
  if (input.action === "revise") {
    if (!input.revisedInput) {
      throw new Error("revise requires revisedInput");
    }
    const revised = await deps.reviseHeldJobArgs(
      row.job_id,
      input.revisedInput,
    );
    if (!revised) {
      throw new PolicyConflictError(
        "The held run is no longer revisable.",
      );
    }
  }
  const transitioned = await transitionApproval(row, input.expectedRevision, {
    status: "resuming",
    resolvedBy,
  });
  if (!transitioned) {
    throw new PolicyConflictError("This approval changed since you read it.");
  }
  const resumed = await deps.resumeHeldJob(row.job_id);
  if (!resumed) {
    // The job moved without us (consumer crash cleanup, manual ops). The
    // envelope stays 'resuming'; projection follows the job's real status.
    console.warn(
      `[APPROVALS] held job ${row.job_id} was not resumable after CAS win`,
    );
  }
  if (input.stopAsking && deps.stopAsking) {
    await deps.stopAsking(row.function_name).catch((err) => {
      console.warn("[APPROVALS] stop-asking flip failed:", err);
    });
  }
  await deps.recordResolutionEffect?.(
    row,
    input.action === "revise" ? "approved with revisions" : "approved",
  ).catch(() => undefined);
  return transitioned;
}

export class ApprovalNotFoundError extends Error {
  constructor() {
    super("Approval not found");
    this.name = "ApprovalNotFoundError";
  }
}
