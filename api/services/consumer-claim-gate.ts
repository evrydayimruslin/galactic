// Pillar P3.5: the queue consumer's claim point becomes the second
// checkpoint of the one dispatch gate (doc §4) — so schedule, manual,
// event, retry, and recovery paths all pass one evaluator, not just the
// MCP dispatch seam.
//
// Scope: autonomous triggers only (schedule | manual | event | retry).
// Interface-triggered jobs are the user plane and pass untouched. A job
// minted by an approved envelope carries meta.approvalHold — the approval
// IS its authorization, so it skips re-evaluation (otherwise ask would
// loop forever). Cost discipline: one policy-row read per autonomous
// claim; the app row is fetched only when a policy row exists.

import { getEnv } from "../lib/env.ts";
import type { AsyncJob } from "./async-jobs.ts";
import { denyClaimedJob, holdClaimedJob } from "./async-jobs.ts";
import {
  classifyFunctionConsequence,
  computeDeclarationHash,
  declaredFunctionFactsFromApp,
  evaluateAutonomousGate,
  readFunctionPolicy,
} from "./policy-gate.ts";
import {
  createApprovalEnvelope,
  readApprovalByRunId,
} from "./agent-approvals.ts";
import {
  drainEffectEvents,
  recordEffectEvent,
} from "./effect-event-tracker.ts";
import { persistEffectEvents } from "./effect-event-store.ts";

const AUTONOMOUS_TRIGGERS = new Set(["schedule", "manual", "event", "retry"]);

export type ClaimGateOutcome = "proceed" | "denied" | "held";

function jobMeta(job: AsyncJob): Record<string, unknown> {
  return (job.meta && typeof job.meta === "object"
    ? job.meta
    : {}) as Record<string, unknown>;
}

async function fetchAppForGate(
  appId: string,
): Promise<
  | { manifest?: unknown; pricing_config?: unknown; owner_id: string }
  | null
> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(
    `${getEnv("SUPABASE_URL")}/rest/v1/apps?id=eq.${
      encodeURIComponent(appId)
    }&select=manifest,pricing_config,owner_id&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Claim gate could not read the app: ${err}`);
  }
  const rows = await res.json() as Array<
    { manifest?: unknown; pricing_config?: unknown; owner_id: string }
  >;
  return rows[0] ?? null;
}

/**
 * Evaluate a CLAIMED (running) autonomous job before tenant code runs.
 * 'denied' and 'held' have already settled the job row and witnessed the
 * outcome when this returns — the consumer just acks. Fail-closed (I2):
 * an unreadable policy store parks the job as held rather than executing.
 */
export async function gateClaimedAutonomousJob(
  job: AsyncJob,
): Promise<ClaimGateOutcome> {
  const trigger = (job as { trigger?: string | null }).trigger ?? null;
  if (!trigger || !AUTONOMOUS_TRIGGERS.has(trigger)) return "proceed";
  if (jobMeta(job).approvalHold === true) return "proceed";

  let verdict;
  let declarationHash: string | null = null;
  let consequence: ReturnType<typeof classifyFunctionConsequence> =
    "external_side_effect";
  try {
    const row = await readFunctionPolicy(job.app_id, job.function_name);
    if (!row) return "proceed";
    // A row exists — fetch the app once for hash + consequence.
    const app = await fetchAppForGate(job.app_id);
    const facts = app
      ? declaredFunctionFactsFromApp(app, job.function_name)
      : null;
    declarationHash = facts ? await computeDeclarationHash(facts) : null;
    if (facts) consequence = classifyFunctionConsequence(facts);
    verdict = await evaluateAutonomousGate({
      appId: job.app_id,
      functionName: job.function_name,
      currentDeclarationHash: declarationHash,
    });
  } catch (err) {
    console.error(
      `[CLAIM-GATE] evaluation failed for job ${job.id} — holding (I2):`,
      err,
    );
    const parked = await holdClaimedJob(job.id).catch(() => false);
    return parked ? "held" : "proceed";
  }

  if (verdict.verdict === "allow") return "proceed";

  if (verdict.verdict === "deny") {
    const denied = await denyClaimedJob(job.id);
    if (!denied) return "proceed"; // lost the row — settlement owns it
    recordEffectEvent(job.execution_id, {
      kind: "non_action",
      channel: `policy:${job.function_name}`,
      outcome: "denied at claim: autonomous policy is Off",
      attestation: "attested",
    });
    const drained = drainEffectEvents(job.execution_id);
    await persistEffectEvents({
      userId: job.user_id,
      appId: job.app_id,
      executionId: job.execution_id,
      runId: null,
      events: drained.events,
    }).catch(() => 0);
    return "denied";
  }

  // hold — but the envelope is the authorization record: if this exact
  // invocation was already approved (status 'resuming'), the claim is its
  // sanctioned resumption and proceeds; ask means each invocation asks
  // ONCE, not once per claim.
  let existing = null;
  try {
    existing = await readApprovalByRunId(job.execution_id);
  } catch (err) {
    console.error(
      `[CLAIM-GATE] envelope lookup failed for job ${job.id} — holding:`,
      err,
    );
    const parkedOnError = await holdClaimedJob(job.id).catch(() => false);
    return parkedOnError ? "held" : "proceed";
  }
  if (
    existing && (existing.status === "resuming" ||
      existing.status === "approved" || existing.status === "completed")
  ) {
    return "proceed";
  }
  const parked = await holdClaimedJob(job.id);
  if (!parked) return "proceed";
  if (existing) {
    // A pending/terminal envelope already exists for this invocation —
    // the row is parked again and the existing record stands.
    return "held";
  }
  try {
    await createApprovalEnvelope({
      appId: job.app_id,
      userId: job.user_id,
      ownerId: job.owner_id,
      jobId: job.id,
      executionId: job.execution_id,
      functionName: job.function_name,
      consequence,
      args: (job.args ?? {}) as Record<string, unknown>,
      trigger,
      releaseId: null,
      releaseVersion: null,
      routineId: null,
      routineRunId: null,
      traceId: null,
      policyRevision: verdict.revision ?? "",
      declarationHash,
    });
  } catch (err) {
    // The job is safely held either way; a missing envelope means the hold
    // is invisible until the next claim files one — log loudly.
    console.error(
      `[CLAIM-GATE] envelope create failed for held job ${job.id}:`,
      err,
    );
  }
  return "held";
}
