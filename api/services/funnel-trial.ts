import { getEnv } from "../lib/env.ts";
import type { BuilderHandoffSessionServiceOptions } from "./builder-handoff-sessions.ts";
import { FunnelSessionError } from "./funnel-sessions.ts";
import { createQueuedJob } from "./async-jobs.ts";
import { createApprovalEnvelope } from "./agent-approvals.ts";
import { buildFunctionPolicyProjections } from "./policy-gate.ts";

/**
 * WO-F5 PR B: the trial run — "Run it once" from the pairing page.
 *
 * The composition is deliberately made of P3 primitives and nothing else:
 * a job created HELD-FOR-APPROVAL (invisible to the consumer's queued-only
 * claim; approval flips it through the same filter, exactly-once) plus a
 * real approval envelope filed against the starter policy's `ask` row.
 * Nothing executes, nothing external can happen, no gate code is modified
 * — the card is real because the envelope and the held job are the same
 * objects production holds use. Execution reality begins only after
 * claim + membership + the existing deploy boundary, at resume.
 */

export const FUNNEL_TRIAL_RUN_LIMIT = 3;
export const FUNNEL_TRIAL_TRIGGER = "manual" as const;

export interface FunnelTrialCard {
  envelopeId: string;
  functionName: string;
  consequence: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  seedSentence: string | null;
}

export interface FunnelTrialDependencies {
  createJob?: typeof createQueuedJob;
  createEnvelope?: typeof createApprovalEnvelope;
  projections?: typeof buildFunctionPolicyProjections;
  randomUUID?: () => string;
}

interface RestConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchFn: typeof fetch;
}

function restConfig(options: BuilderHandoffSessionServiceOptions): RestConfig {
  const supabaseUrl = options.supabaseUrl ?? getEnv("SUPABASE_URL");
  const serviceRoleKey = options.serviceRoleKey ??
    getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new FunnelSessionError(
      "unavailable",
      "Trial runs are unavailable: database configuration is missing",
    );
  }
  return { supabaseUrl, serviceRoleKey, fetchFn: options.fetchFn ?? fetch };
}

async function restJson(
  cfg: RestConfig,
  pathAndQuery: string,
): Promise<unknown> {
  const fetchFn = cfg.fetchFn;
  let response: Response;
  try {
    response = await fetchFn(`${cfg.supabaseUrl}/rest/v1/${pathAndQuery}`, {
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
      },
    });
  } catch {
    throw new FunnelSessionError(
      "unavailable",
      "Trial-run storage did not respond",
    );
  }
  if (!response.ok) {
    throw new FunnelSessionError(
      "unavailable",
      `Trial-run storage rejected the request (${response.status})`,
    );
  }
  return await response.json();
}

function firstRow(payload: unknown): Record<string, unknown> | null {
  const rows = Array.isArray(payload) ? payload : [];
  const row = rows[0];
  return row && typeof row === "object"
    ? row as Record<string, unknown>
    : null;
}

/** Latest envelope for the funnel's Agent, projected stages-only-safe. */
export async function readFunnelHeldCard(
  appId: string,
  options: BuilderHandoffSessionServiceOptions = {},
): Promise<{ card: FunnelTrialCard | null; trialRunsUsed: number }> {
  const cfg = restConfig(options);
  const payload = await restJson(
    cfg,
    `agent_approvals?app_id=eq.${encodeURIComponent(appId)}` +
      `&order=created_at.desc&limit=10` +
      `&select=id,function_name,consequence,status,created_at,expires_at`,
  );
  const rows = Array.isArray(payload) ? payload : [];
  const trialRunsUsed = rows.length;
  const row = firstRow(rows.slice(0, 1));
  if (!row) return { card: null, trialRunsUsed };

  let seedSentence: string | null = null;
  try {
    const draftPayload = await restJson(
      cfg,
      `agent_policy_drafts?app_id=eq.${encodeURIComponent(appId)}` +
        `&order=created_at.desc&limit=1&select=sentence`,
    );
    const draft = firstRow(draftPayload);
    seedSentence = typeof draft?.sentence === "string" ? draft.sentence : null;
  } catch {
    // The card renders without the sentence rather than not at all.
  }

  return {
    trialRunsUsed,
    card: {
      envelopeId: String(row.id ?? ""),
      functionName: String(row.function_name ?? ""),
      consequence: String(row.consequence ?? ""),
      status: String(row.status ?? "pending"),
      createdAt: String(row.created_at ?? ""),
      expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
      seedSentence,
    },
  };
}

/**
 * Server-side owner context for a live (unclaimed, in-window) pairing.
 * Never exposed to clients — route handlers derive from it.
 */
export async function readFunnelOwnerContext(
  pairingCode: string,
  options: BuilderHandoffSessionServiceOptions = {},
): Promise<{
  ownerId: string;
  uploadedAppId: string | null;
  uploadedVersion: string | null;
}> {
  const cfg = restConfig(options);
  const funnel = firstRow(
    await restJson(
      cfg,
      `funnel_sessions?pairing_code=eq.${encodeURIComponent(pairingCode)}` +
        `&select=provisional_owner_id,handoff_session_id,claimed_at,expires_at&limit=1`,
    ),
  );
  if (!funnel) {
    throw new FunnelSessionError("not_found", "Unknown pairing code");
  }
  if (funnel.claimed_at !== null && funnel.claimed_at !== undefined) {
    throw new FunnelSessionError(
      "already_claimed",
      "This build is claimed — run it from its fleet",
    );
  }
  if (
    typeof funnel.expires_at === "string" &&
    Date.parse(funnel.expires_at) <= Date.now()
  ) {
    throw new FunnelSessionError("not_found", "Unknown pairing code");
  }
  const session = firstRow(
    await restJson(
      cfg,
      `builder_handoff_sessions?id=eq.${
        encodeURIComponent(String(funnel.handoff_session_id))
      }&select=uploaded_app_id,uploaded_version&limit=1`,
    ),
  );
  return {
    ownerId: String(funnel.provisional_owner_id),
    uploadedAppId: typeof session?.uploaded_app_id === "string"
      ? session.uploaded_app_id
      : null,
    uploadedVersion: typeof session?.uploaded_version === "string"
      ? session.uploaded_version
      : null,
  };
}

/**
 * Pairing-level entry: validates the funnel row (unclaimed, inside the
 * return window, candidate uploaded) and delegates. The pairing code is
 * the only input a stranger holds; everything else is derived server-side.
 */
export async function runFunnelTrialByPairing(
  pairingCode: string,
  options: BuilderHandoffSessionServiceOptions = {},
  deps: FunnelTrialDependencies = {},
): Promise<FunnelTrialCard> {
  const context = await readFunnelOwnerContext(pairingCode, options);
  if (!context.uploadedAppId) {
    throw new FunnelSessionError(
      "invalid_request",
      "The candidate has not uploaded yet — finish the build first",
    );
  }
  return await runFunnelTrial({
    appId: context.uploadedAppId,
    ownerId: context.ownerId,
    uploadedVersion: context.uploadedVersion,
  }, options, deps);
}

/**
 * Run it once: file a real held job + envelope against the starter
 * policy's `ask` posture. Requires an uploaded candidate and at least one
 * guarded (`ask`) function; bounded per funnel Agent.
 */
export async function runFunnelTrial(
  input: {
    appId: string;
    ownerId: string;
    uploadedVersion: string | null;
  },
  options: BuilderHandoffSessionServiceOptions = {},
  deps: FunnelTrialDependencies = {},
): Promise<FunnelTrialCard> {
  const cfg = restConfig(options);

  const appPayload = await restJson(
    cfg,
    `apps?id=eq.${encodeURIComponent(input.appId)}` +
      `&select=id,owner_id,manifest,pricing_config&limit=1`,
  );
  const app = firstRow(appPayload);
  if (!app || app.owner_id !== input.ownerId) {
    throw new FunnelSessionError("not_found", "Trial target not found");
  }

  const manifest = typeof app.manifest === "string"
    ? (() => {
      try {
        return JSON.parse(app.manifest as string);
      } catch {
        return null;
      }
    })()
    : app.manifest;
  const functionsRecord = manifest && typeof manifest === "object" &&
      !Array.isArray(manifest)
    ? (manifest as Record<string, unknown>).functions
    : null;
  const functionNames = functionsRecord && typeof functionsRecord === "object"
    ? Object.keys(functionsRecord as Record<string, unknown>)
    : [];
  if (functionNames.length === 0) {
    throw new FunnelSessionError(
      "invalid_request",
      "The candidate declares no functions yet — upload it first",
    );
  }

  const { declaredFunctionFactsFromApp } = await import("./policy-gate.ts");
  const facts = functionNames
    .map((name) =>
      declaredFunctionFactsFromApp(
        app as { manifest?: unknown; pricing_config?: unknown },
        name,
      )
    )
    .filter((fact): fact is NonNullable<typeof fact> => fact !== null);

  const projections = await (deps.projections ??
    buildFunctionPolicyProjections)({
      userId: input.ownerId,
      appId: input.appId,
      functions: facts,
      release: null,
    });
  const guarded = projections.find((row) => row.policy === "ask");
  if (!guarded) {
    throw new FunnelSessionError(
      "invalid_request",
      "No guarded function is set to ask — attach the starter policy (gx.policy attach_template) first",
    );
  }

  const { trialRunsUsed } = await readFunnelHeldCard(input.appId, options);
  if (trialRunsUsed >= FUNNEL_TRIAL_RUN_LIMIT) {
    throw new FunnelSessionError(
      "invalid_request",
      `Trial-run ceiling reached (${FUNNEL_TRIAL_RUN_LIMIT}) — claim the build to keep going`,
    );
  }

  const executionId = (deps.randomUUID ?? (() => crypto.randomUUID()))();
  const jobId = await (deps.createJob ?? createQueuedJob)({
    appId: input.appId,
    userId: input.ownerId,
    ownerId: input.ownerId,
    functionName: guarded.functionName,
    args: {},
    trigger: FUNNEL_TRIAL_TRIGGER,
    heldForApproval: true,
    executionId,
    meta: { funnel_trial: true },
  });

  const envelope = await (deps.createEnvelope ?? createApprovalEnvelope)({
    appId: input.appId,
    userId: input.ownerId,
    ownerId: input.ownerId,
    jobId,
    executionId,
    functionName: guarded.functionName,
    consequence: guarded.consequence,
    args: {},
    trigger: FUNNEL_TRIAL_TRIGGER,
    releaseId: null,
    releaseVersion: input.uploadedVersion,
    routineId: null,
    routineRunId: null,
    traceId: null,
    policyRevision: guarded.revision,
    declarationHash: guarded.declarationHash,
  });

  return {
    envelopeId: envelope.id,
    functionName: guarded.functionName,
    consequence: guarded.consequence,
    status: "pending",
    createdAt: envelope.created_at ?? new Date().toISOString(),
    expiresAt: envelope.expires_at ?? null,
    seedSentence: null,
  };
}
