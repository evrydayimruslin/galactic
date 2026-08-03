// Pillar P6: attribution + dry-run — policies visibly earning their keep.
//
// Counters aggregate the envelope ledger (the same rows the Approvals tab
// shows — no second bookkeeping to drift). Dry-run replays RECORDED
// autonomous invocations through evaluatePolicyRules — the exact evaluator
// the production gate uses (doc §12's one-code-path requirement), so a
// dry-run verdict IS a production verdict. Semantic rules match by
// meaning, not by comparison: dry-run reports how many recorded calls fall
// in their SCOPE ("would consult the judge") rather than paying N judge
// calls to guess — the deterministic layer is exact, the semantic layer is
// honest about being scoped.

import { getEnv } from "../lib/env.ts";
import type {
  LaunchPolicyArtifact,
  LaunchPolicyDryRunResponse,
  LaunchPolicyDryRunRow,
  LaunchPolicyRuleAttribution,
} from "../../shared/contracts/launch.ts";
import {
  applicableSemanticRules,
  evaluatePolicyRules,
} from "./policy-predicates.ts";

const AUTONOMOUS_TRIGGERS = ["schedule", "manual", "event", "retry"];
export const ATTRIBUTION_WINDOW_DAYS = 7;
const DRY_RUN_MAX = 200;

function supabaseHeaders() {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

function restUrl(path: string): string {
  return `${getEnv("SUPABASE_URL")}/rest/v1/${path}`;
}

interface AttributionEnvelopeRow {
  status: string;
  created_at: string;
  source: Record<string, unknown> | null;
}

function heldByOf(
  row: AttributionEnvelopeRow,
): { ruleId: string; policyVersion: number; readback: string | null } | null {
  const heldBy = row.source?.heldBy;
  if (!heldBy || typeof heldBy !== "object" || Array.isArray(heldBy)) {
    return null;
  }
  const record = heldBy as Record<string, unknown>;
  if (
    typeof record.ruleId !== "string" ||
    typeof record.policyVersion !== "number"
  ) {
    return null;
  }
  return {
    ruleId: record.ruleId,
    policyVersion: record.policyVersion,
    readback: typeof record.readback === "string" ? record.readback : null,
  };
}

/**
 * Per-rule "held N this week" + per-version totals, from the envelope
 * ledger. Rules the overlay held (no heldBy) are excluded on purpose —
 * the Capabilities switches attribute themselves.
 */
export async function aggregatePolicyAttribution(
  userId: string,
  appId: string,
  windowDays = ATTRIBUTION_WINDOW_DAYS,
): Promise<{
  rules: LaunchPolicyRuleAttribution[];
  versions: Array<{ policyVersion: number; held: number }>;
}> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    .toISOString();
  const res = await fetch(
    restUrl(
      `agent_approvals?app_id=eq.${encodeURIComponent(appId)}` +
        `&user_id=eq.${encodeURIComponent(userId)}` +
        `&created_at=gte.${encodeURIComponent(since)}` +
        `&select=status,created_at,source&order=created_at.desc&limit=500`,
    ),
    { headers: supabaseHeaders() },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to aggregate attribution: ${err}`);
  }
  const rows = await res.json() as AttributionEnvelopeRow[];
  const byRule = new Map<string, LaunchPolicyRuleAttribution>();
  const byVersion = new Map<number, number>();
  for (const row of rows) {
    const heldBy = heldByOf(row);
    if (!heldBy) continue;
    const key = `v${heldBy.policyVersion}:${heldBy.ruleId}`;
    const entry = byRule.get(key) ?? {
      ruleId: heldBy.ruleId,
      policyVersion: heldBy.policyVersion,
      readback: heldBy.readback,
      heldLast7d: 0,
      pendingNow: 0,
    };
    entry.heldLast7d += 1;
    if (row.status === "pending") entry.pendingNow += 1;
    if (!entry.readback && heldBy.readback) entry.readback = heldBy.readback;
    byRule.set(key, entry);
    byVersion.set(
      heldBy.policyVersion,
      (byVersion.get(heldBy.policyVersion) ?? 0) + 1,
    );
  }
  return {
    rules: [...byRule.values()].sort((a, b) => b.heldLast7d - a.heldLast7d),
    versions: [...byVersion.entries()]
      .map(([policyVersion, held]) => ({ policyVersion, held }))
      .sort((a, b) => b.policyVersion - a.policyVersion),
  };
}

interface RecordedInvocationRow {
  id: string;
  function_name: string;
  args: Record<string, unknown> | null;
  created_at: string;
}

export async function fetchRecordedAutonomousInvocations(
  appId: string,
  limit: number,
): Promise<RecordedInvocationRow[]> {
  const res = await fetch(
    restUrl(
      `async_jobs?app_id=eq.${encodeURIComponent(appId)}` +
        `&trigger=in.(${AUTONOMOUS_TRIGGERS.join(",")})` +
        `&select=id,function_name,args,created_at` +
        `&order=created_at.desc&limit=${Math.min(limit, DRY_RUN_MAX)}`,
    ),
    { headers: supabaseHeaders() },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to read recorded invocations: ${err}`);
  }
  return await res.json() as RecordedInvocationRow[];
}

type DryRunVerdict = "allow" | "hold" | "deny" | "would_judge";

function verdictFor(
  artifact: LaunchPolicyArtifact | null,
  functionName: string,
  args: Record<string, unknown>,
): { verdict: DryRunVerdict; ruleId: string | null } {
  if (!artifact) return { verdict: "allow", ruleId: null };
  const matched = evaluatePolicyRules(artifact, functionName, args);
  if (matched) {
    return { verdict: matched.rule.effect, ruleId: matched.rule.id };
  }
  const semantic = applicableSemanticRules(artifact, functionName);
  if (semantic.length > 0) {
    return { verdict: "would_judge", ruleId: semantic[0].id };
  }
  return { verdict: "allow", ruleId: null };
}

/**
 * Replay recorded invocations under the proposed artifact vs the current
 * head. Same evaluator as the gate — a changed row here is a changed
 * verdict in production.
 */
export function dryRunArtifacts(
  invocations: RecordedInvocationRow[],
  proposed: LaunchPolicyArtifact,
  currentHead: LaunchPolicyArtifact | null,
): LaunchPolicyDryRunResponse {
  const changed: LaunchPolicyDryRunRow[] = [];
  let newlyHeld = 0;
  let newlyDenied = 0;
  let newlyAllowed = 0;
  let wouldConsultJudge = 0;
  for (const invocation of invocations) {
    const args = (invocation.args ?? {}) as Record<string, unknown>;
    const next = verdictFor(proposed, invocation.function_name, args);
    const current = verdictFor(
      currentHead,
      invocation.function_name,
      args,
    );
    if (next.verdict === "would_judge") wouldConsultJudge += 1;
    if (next.verdict === current.verdict) continue;
    if (next.verdict === "hold") newlyHeld += 1;
    if (next.verdict === "deny") newlyDenied += 1;
    if (next.verdict === "allow") newlyAllowed += 1;
    changed.push({
      jobId: invocation.id,
      functionName: invocation.function_name,
      createdAt: invocation.created_at,
      proposed: next.verdict,
      proposedRuleId: next.ruleId,
      current: current.verdict,
      currentRuleId: current.ruleId,
    });
  }
  return {
    replayed: invocations.length,
    changed,
    summary: { newlyHeld, newlyDenied, newlyAllowed, wouldConsultJudge },
    generatedAt: new Date().toISOString(),
  };
}
