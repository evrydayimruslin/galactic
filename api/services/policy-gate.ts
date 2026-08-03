// Pillar P2: the dispatch gate's first evaluator — the owner's per-function
// autonomous policy overlay (off | ask | free).
//
// Scope (decision register): the gate governs the agent's OWN autonomous
// calls — scheduled wakes, manual run-now, event deliveries, retries.
// Direct user/interface calls are a different authority plane and are
// never gated here. Defaults: no row = 'free' (zero behavior change until
// an owner flips a switch). 'ask' rows are dormant until P3 activates
// holds — the gate treats them as 'free' WITH a warning, never as 'off'
// (a stored preference must not brick an agent before holds exist).

import type {
  LaunchAutonomousFunctionPolicy,
  LaunchAutonomousFunctionPolicyProjection,
  LaunchFunctionConsequenceGroup,
} from "../../shared/contracts/launch.ts";
import type { MCPToolAnnotations } from "../../shared/contracts/mcp.ts";
import { getEnv } from "../lib/env.ts";

export type AutonomousFunctionPolicy = LaunchAutonomousFunctionPolicy;

export interface FunctionPolicyRow {
  app_id: string;
  user_id: string;
  function_name: string;
  policy: AutonomousFunctionPolicy;
  declaration_hash: string | null;
  revision: string;
  set_by: Record<string, unknown>;
  updated_at: string;
}

export interface GateVerdict {
  verdict: "allow" | "deny";
  /** The layer that decided (I6 — receipts name their decider). */
  layer: "default" | "overlay";
  policy: AutonomousFunctionPolicy | null;
  revision: string | null;
}

export class PolicyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyConflictError";
  }
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

export async function readFunctionPolicy(
  appId: string,
  functionName: string,
): Promise<FunctionPolicyRow | null> {
  const res = await fetch(
    restUrl(
      `agent_function_policies?app_id=eq.${encodeURIComponent(appId)}` +
        `&function_name=eq.${encodeURIComponent(functionName)}&limit=1`,
    ),
    { headers: supabaseHeaders() },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to read function policy: ${err}`);
  }
  const rows = await res.json() as FunctionPolicyRow[];
  return rows[0] ?? null;
}

export async function listFunctionPolicies(
  userId: string,
  appId: string,
): Promise<FunctionPolicyRow[]> {
  const res = await fetch(
    restUrl(
      `agent_function_policies?app_id=eq.${encodeURIComponent(appId)}` +
        `&user_id=eq.${encodeURIComponent(userId)}&order=function_name.asc`,
    ),
    { headers: supabaseHeaders() },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to list function policies: ${err}`);
  }
  return await res.json() as FunctionPolicyRow[];
}

/**
 * Owner write with CAS. First write: expectedRevision null. Later writes
 * must present the revision they read; a mismatch throws PolicyConflictError
 * (the caller maps it to 409). Every write mints a fresh revision and
 * records the actor (I6).
 */
export async function setFunctionPolicy(input: {
  userId: string;
  appId: string;
  functionName: string;
  policy: AutonomousFunctionPolicy;
  expectedRevision: string | null;
  declarationHash?: string | null;
  actor: Record<string, unknown>;
}): Promise<FunctionPolicyRow> {
  const revision = crypto.randomUUID();
  const now = new Date().toISOString();
  if (input.expectedRevision === null) {
    const res = await fetch(restUrl("agent_function_policies"), {
      method: "POST",
      headers: supabaseHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify({
        app_id: input.appId,
        user_id: input.userId,
        function_name: input.functionName,
        policy: input.policy,
        declaration_hash: input.declarationHash ?? null,
        revision,
        set_by: input.actor,
        updated_at: now,
      }),
    });
    if (res.ok) return ((await res.json()) as FunctionPolicyRow[])[0];
    if (res.status === 409) {
      await res.body?.cancel();
      throw new PolicyConflictError(
        "A policy already exists for this function — read it and retry with its revision.",
      );
    }
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to create function policy: ${err}`);
  }
  const res = await fetch(
    restUrl(
      `agent_function_policies?app_id=eq.${encodeURIComponent(input.appId)}` +
        `&function_name=eq.${encodeURIComponent(input.functionName)}` +
        `&revision=eq.${encodeURIComponent(input.expectedRevision)}`,
    ),
    {
      method: "PATCH",
      headers: supabaseHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify({
        policy: input.policy,
        ...(input.declarationHash !== undefined
          ? { declaration_hash: input.declarationHash }
          : {}),
        revision,
        set_by: input.actor,
        updated_at: now,
      }),
    },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to update function policy: ${err}`);
  }
  const rows = await res.json() as FunctionPolicyRow[];
  if (!rows[0]) {
    throw new PolicyConflictError(
      "The policy changed since you read it — reload and retry.",
    );
  }
  return rows[0];
}

/**
 * The P2 gate evaluation: overlay only (the release ceiling already ran —
 * it exists today as manifest authority enforcement). Fail-open ONLY for
 * infrastructure errors on 'free'-posture reads is wrong under I2 — a gate
 * that cannot read its policy fails CLOSED for autonomous work.
 */
export async function evaluateAutonomousGate(input: {
  appId: string;
  functionName: string;
}): Promise<GateVerdict> {
  const row = await readFunctionPolicy(input.appId, input.functionName);
  if (!row) {
    return { verdict: "allow", layer: "default", policy: null, revision: null };
  }
  if (row.policy === "off") {
    return {
      verdict: "deny",
      layer: "overlay",
      policy: "off",
      revision: row.revision,
    };
  }
  if (row.policy === "ask") {
    // Dormant until P3: stored preference, not yet an active hold.
    console.warn(
      `[GATE] 'ask' policy on ${input.functionName} is dormant until holds ship — allowing.`,
    );
  }
  return {
    verdict: "allow",
    layer: "overlay",
    policy: row.policy,
    revision: row.revision,
  };
}

/** The declaration facts a policy binds to (a subset of LaunchFunctionSummary). */
export interface DeclaredFunctionFacts {
  name: string;
  description?: string | null;
  inputSchema?: Record<string, unknown> | null;
  annotations?: MCPToolAnnotations | null;
  /** Truthy when the function carries pricing (classifies as 'spend'). */
  priced?: boolean;
}

/**
 * One function, one highest-authority consequence group. Order matters:
 * spend supersedes the external side effect inherent in a paid action;
 * an explicit read-only declaration is trusted below that; open-world
 * reach marks external side effects; everything else mutates only the
 * agent's own world.
 */
export function classifyFunctionConsequence(
  fn: DeclaredFunctionFacts,
): LaunchFunctionConsequenceGroup {
  if (fn.priced) return "spend";
  if (fn.annotations?.readOnlyHint) return "read";
  if (fn.annotations?.openWorldHint || fn.annotations?.destructiveHint) {
    return "external_side_effect";
  }
  return "internal_write";
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Content identity of a function's declaration. A policy is a conversation
 * about THIS declaration — when the declaration changes, the hash changes,
 * every expectedDeclarationHash a stale UI holds stops matching, and the
 * owner re-confirms against what the function now claims to be. Pricing is
 * billing configuration, not declaration, so it is excluded on purpose.
 */
export async function computeDeclarationHash(
  fn: DeclaredFunctionFacts,
): Promise<string> {
  const canonical = stableStringify({
    annotations: fn.annotations ?? null,
    description: fn.description ?? null,
    inputSchema: fn.inputSchema ?? null,
    name: fn.name,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The CAS token an unset policy presents. Deterministic on the declaration:
 * a PUT that read defaults stays valid exactly as long as the declaration
 * it read is the declaration that's live.
 */
export function defaultPolicyRevision(declarationHash: string): string {
  return `default:${declarationHash}`;
}

/**
 * Defaults merged over the release's declared functions — every declared
 * function projects a policy row, unset ones as 'free' attributed to
 * `release_default`. Stored rows project with the CURRENT declaration
 * hash: the gate keeps honoring the row by name (narrowing survives a
 * redeploy — I1), while stale-hash PUTs 409 and re-read.
 */
export async function buildFunctionPolicyProjections(input: {
  userId: string;
  appId: string;
  functions: DeclaredFunctionFacts[];
  release: { id: string; version: string; createdAt: string } | null;
}): Promise<LaunchAutonomousFunctionPolicyProjection[]> {
  const rows = await listFunctionPolicies(input.userId, input.appId);
  const byName = new Map(rows.map((row) => [row.function_name, row]));
  const projections: LaunchAutonomousFunctionPolicyProjection[] = [];
  for (const fn of input.functions) {
    const declarationHash = await computeDeclarationHash(fn);
    const row = byName.get(fn.name) ?? null;
    projections.push({
      agentId: input.appId,
      functionName: fn.name,
      consequence: classifyFunctionConsequence(fn),
      policy: row?.policy ?? "free",
      revision: row?.revision ?? defaultPolicyRevision(declarationHash),
      declaredReleaseId: input.release?.id ?? "",
      declaredReleaseVersion: input.release?.version ?? "",
      declarationHash,
      updatedAt: row?.updated_at ?? input.release?.createdAt ??
        new Date(0).toISOString(),
      updatedBy: row
        ? {
          kind: "user",
          userId: typeof row.set_by?.userId === "string"
            ? row.set_by.userId as string
            : input.userId,
        }
        : { kind: "system", source: "release_default" },
    });
  }
  return projections;
}
