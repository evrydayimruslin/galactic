// Pillar P4: compiled policy predicates — the deterministic layer between
// the owner's overlay switches and (at P5) the judge.
//
// The contract (doc §6): the owner's sentences compile on THEIR model
// (I8) into a schema-validated artifact; validation failures and
// clarification requests FAIL THE SAVE with precise errors — no vague
// rule ever enters the gate. The readback the owner approves is rendered
// from the artifact by the code templates below, never by a model: they
// approve what will execute, not what they typed. Effects only narrow
// (hold | deny); there is no allow effect by construction (I1).

import type {
  LaunchAgentPolicySet,
  LaunchAgentPolicySetSummary,
  LaunchPolicyArtifact,
  LaunchPolicyRule,
  LaunchPolicyRuleCondition,
  LaunchPolicyScalar,
  LaunchPolicySourceEntry,
} from "../../shared/contracts/launch.ts";
import {
  LAUNCH_POLICY_RULE_EFFECTS,
  LAUNCH_POLICY_RULE_OPS,
} from "../../shared/contracts/launch.ts";
import { getEnv } from "../lib/env.ts";
import {
  fetchInferenceChatCompletion,
  selectInferenceModel,
} from "./inference-client.ts";
import {
  InferenceRouteError,
  resolveInferenceRoute,
} from "./inference-route.ts";
import type { DeclaredFunctionFacts } from "./policy-gate.ts";
import { PolicyConflictError } from "./policy-gate.ts";

const MAX_RULES = 32;
const MAX_CONDITIONS = 4;
const RULE_ID_PATTERN = /^r[0-9]{1,3}$/;

// ── Validation floor ────────────────────────────────────────────────────
// The model proposes; THIS decides. Unknown function, unknown path,
// unknown op, or a type mismatch fails the save with the exact reason.

interface SchemaLeaf {
  type: string | null;
}

function resolveSchemaPath(
  inputSchema: Record<string, unknown> | null | undefined,
  path: string,
): SchemaLeaf | null {
  if (!inputSchema) return null;
  let node: Record<string, unknown> | null = inputSchema;
  for (const segment of path.split(".")) {
    if (!segment) return null;
    const properties = node?.properties as
      | Record<string, unknown>
      | undefined;
    const next = properties?.[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) return null;
    node = next as Record<string, unknown>;
  }
  return { type: typeof node.type === "string" ? node.type : null };
}

function isScalar(value: unknown): value is LaunchPolicyScalar {
  return typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean";
}

export function validatePolicyArtifact(
  artifact: LaunchPolicyArtifact,
  facts: DeclaredFunctionFacts[],
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const factByName = new Map(facts.map((fact) => [fact.name, fact]));
  if (artifact.version !== 1) {
    errors.push(`Unknown artifact version ${String(artifact.version)}.`);
  }
  if (!Array.isArray(artifact.rules)) {
    return { ok: false, errors: ["artifact.rules must be an array."] };
  }
  if (artifact.rules.length > MAX_RULES) {
    errors.push(`Too many rules (${artifact.rules.length} > ${MAX_RULES}).`);
  }
  const seenIds = new Set<string>();
  artifact.rules.forEach((rule, index) => {
    const label = rule.id || `rule ${index + 1}`;
    if (!RULE_ID_PATTERN.test(rule.id ?? "")) {
      errors.push(`${label}: id must match r1..r999.`);
    } else if (seenIds.has(rule.id)) {
      errors.push(`${label}: duplicate rule id.`);
    } else {
      seenIds.add(rule.id);
    }
    if (
      !LAUNCH_POLICY_RULE_EFFECTS.includes(
        rule.effect as typeof LAUNCH_POLICY_RULE_EFFECTS[number],
      )
    ) {
      errors.push(
        `${label}: effect must be hold or deny — never allow (I1).`,
      );
    }
    const fact = factByName.get(rule.functionName);
    if (!fact) {
      errors.push(
        `${label}: '${rule.functionName}' is not declared by the current release.`,
      );
      return;
    }
    if (
      !Array.isArray(rule.when) || rule.when.length < 1 ||
      rule.when.length > MAX_CONDITIONS
    ) {
      errors.push(
        `${label}: when must contain 1–${MAX_CONDITIONS} conditions.`,
      );
      return;
    }
    rule.when.forEach((condition) => {
      const where = `${label} on '${rule.functionName}'`;
      if (
        !LAUNCH_POLICY_RULE_OPS.includes(
          condition.op as typeof LAUNCH_POLICY_RULE_OPS[number],
        )
      ) {
        errors.push(`${where}: unknown op '${String(condition.op)}'.`);
        return;
      }
      const leaf = resolveSchemaPath(fact.inputSchema, condition.path ?? "");
      if (!leaf) {
        errors.push(
          `${where}: path '${condition.path}' is not declared in the function's schema.`,
        );
        return;
      }
      const numericOps = ["gt", "gte", "lt", "lte"];
      if (numericOps.includes(condition.op)) {
        if (typeof condition.value !== "number") {
          errors.push(
            `${where}: ${condition.op} needs a number value.`,
          );
        }
        if (leaf.type && leaf.type !== "number" && leaf.type !== "integer") {
          errors.push(
            `${where}: ${condition.op} targets '${condition.path}' which is declared ${leaf.type}, not a number.`,
          );
        }
      } else if (condition.op === "eq" || condition.op === "neq") {
        if (!isScalar(condition.value)) {
          errors.push(`${where}: ${condition.op} needs a scalar value.`);
        }
      } else if (condition.op === "contains") {
        if (typeof condition.value !== "string") {
          errors.push(`${where}: contains needs a string value.`);
        }
      } else if (condition.op === "in") {
        if (
          !Array.isArray(condition.value) || condition.value.length === 0 ||
          !condition.value.every(isScalar)
        ) {
          errors.push(`${where}: in needs a non-empty array of scalars.`);
        }
      } else if (condition.op === "exists" || condition.op === "absent") {
        if (condition.value !== undefined) {
          errors.push(`${where}: ${condition.op} takes no value.`);
        }
      }
    });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

// ── Readback ────────────────────────────────────────────────────────────
// Code templates only. Deterministic on the artifact: same artifact, same
// words, forever — which is why readback is derived and never stored.

function renderValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(renderValue).join(", ");
  return typeof value === "string" ? `"${value}"` : String(value);
}

function renderCondition(condition: LaunchPolicyRuleCondition): string {
  const path = `\`${condition.path}\``;
  switch (condition.op) {
    case "eq":
      return `whose ${path} equals ${renderValue(condition.value)}`;
    case "neq":
      return `whose ${path} does not equal ${renderValue(condition.value)}`;
    case "gt":
      return `whose ${path} is greater than ${renderValue(condition.value)}`;
    case "gte":
      return `whose ${path} is at least ${renderValue(condition.value)}`;
    case "lt":
      return `whose ${path} is less than ${renderValue(condition.value)}`;
    case "lte":
      return `whose ${path} is at most ${renderValue(condition.value)}`;
    case "contains":
      return `whose ${path} contains ${renderValue(condition.value)}`;
    case "in":
      return `whose ${path} is one of ${renderValue(condition.value)}`;
    case "exists":
      return `where ${path} is present`;
    case "absent":
      return `where ${path} is absent`;
  }
}

export function renderRuleReadback(rule: LaunchPolicyRule): string {
  const conditions = rule.when.map(renderCondition).join(" and ");
  if (rule.effect === "deny") {
    return `${rule.id}: Never run \`${rule.functionName}\` ${conditions} — ` +
      "each attempt is recorded as a deliberate non-action.";
  }
  return `${rule.id}: Hold every \`${rule.functionName}\` call ${conditions} — ` +
    "you approve each one in Approvals before it runs.";
}

export function renderPolicyReadback(artifact: LaunchPolicyArtifact): string[] {
  if (artifact.rules.length === 0) {
    return [
      "No compiled rules — the Capabilities switches and the release ceiling still apply.",
    ];
  }
  return artifact.rules.map(renderRuleReadback);
}

// ── Evaluation ──────────────────────────────────────────────────────────
// First matching rule wins (doc §4). A missing arg path makes a comparison
// FALSE — presence semantics belong to exists/absent, so optional args
// absent from a call never trigger value rules by accident.

function resolveArgPath(
  args: Record<string, unknown>,
  path: string,
): unknown {
  let node: unknown = args;
  for (const segment of path.split(".")) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

function conditionMatches(
  condition: LaunchPolicyRuleCondition,
  args: Record<string, unknown>,
): boolean {
  const actual = resolveArgPath(args, condition.path);
  switch (condition.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "absent":
      return actual === undefined || actual === null;
    case "eq":
      return isScalar(actual) && actual === condition.value;
    case "neq":
      return isScalar(actual) && actual !== condition.value;
    case "gt":
      return typeof actual === "number" &&
        typeof condition.value === "number" && actual > condition.value;
    case "gte":
      return typeof actual === "number" &&
        typeof condition.value === "number" && actual >= condition.value;
    case "lt":
      return typeof actual === "number" &&
        typeof condition.value === "number" && actual < condition.value;
    case "lte":
      return typeof actual === "number" &&
        typeof condition.value === "number" && actual <= condition.value;
    case "contains":
      if (typeof condition.value !== "string") return false;
      if (typeof actual === "string") {
        return actual.toLowerCase().includes(condition.value.toLowerCase());
      }
      return Array.isArray(actual) && actual.includes(condition.value);
    case "in":
      return Array.isArray(condition.value) && isScalar(actual) &&
        (condition.value as LaunchPolicyScalar[]).includes(actual);
  }
}

export function evaluatePolicyRules(
  artifact: LaunchPolicyArtifact,
  functionName: string,
  args: Record<string, unknown>,
): { rule: LaunchPolicyRule } | null {
  for (const rule of artifact.rules) {
    if (rule.functionName !== functionName) continue;
    if (rule.when.every((condition) => conditionMatches(condition, args))) {
      return { rule };
    }
  }
  return null;
}

// ── Store ───────────────────────────────────────────────────────────────

interface PolicySetRow {
  app_id: string;
  user_id: string;
  version: number;
  source: LaunchPolicySourceEntry[];
  artifact: LaunchPolicyArtifact;
  compile_model: string;
  created_at: string;
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

function projectPolicySet(row: PolicySetRow): LaunchAgentPolicySet {
  return {
    version: row.version,
    source: row.source ?? [],
    artifact: row.artifact,
    readback: renderPolicyReadback(row.artifact),
    compileModel: row.compile_model,
    createdAt: row.created_at,
  };
}

export async function readPolicySetHead(
  appId: string,
): Promise<LaunchAgentPolicySet | null> {
  const res = await fetch(
    restUrl(
      `agent_policy_sets?app_id=eq.${encodeURIComponent(appId)}` +
        `&order=version.desc&limit=1`,
    ),
    { headers: supabaseHeaders() },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to read policy head: ${err}`);
  }
  const rows = await res.json() as PolicySetRow[];
  return rows[0] ? projectPolicySet(rows[0]) : null;
}

export async function listPolicySetSummaries(
  userId: string,
  appId: string,
  limit = 50,
): Promise<LaunchAgentPolicySetSummary[]> {
  const res = await fetch(
    restUrl(
      `agent_policy_sets?app_id=eq.${encodeURIComponent(appId)}` +
        `&user_id=eq.${encodeURIComponent(userId)}` +
        `&select=version,created_at,compile_model,artifact` +
        `&order=version.desc&limit=${limit}`,
    ),
    { headers: supabaseHeaders() },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to list policy sets: ${err}`);
  }
  const rows = await res.json() as PolicySetRow[];
  return rows.map((row) => ({
    version: row.version,
    createdAt: row.created_at,
    compileModel: row.compile_model,
    ruleCount: row.artifact?.rules?.length ?? 0,
  }));
}

/**
 * Insert version = expectedHeadVersion + 1. The (app_id, version) primary
 * key is the CAS: a concurrent approve hits the duplicate key and maps to
 * PolicyConflictError so the caller reloads the head and re-reads the
 * readback before trying again.
 */
export async function insertPolicySet(input: {
  appId: string;
  userId: string;
  expectedHeadVersion: number;
  source: LaunchPolicySourceEntry[];
  artifact: LaunchPolicyArtifact;
  compileModel: string;
  createdBy: string;
}): Promise<LaunchAgentPolicySet> {
  const res = await fetch(restUrl("agent_policy_sets"), {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify({
      app_id: input.appId,
      user_id: input.userId,
      version: input.expectedHeadVersion + 1,
      source: input.source,
      artifact: input.artifact,
      compile_model: input.compileModel,
      created_by: input.createdBy,
    }),
  });
  if (res.status === 409) {
    await res.body?.cancel();
    throw new PolicyConflictError(
      "Another policy version was approved since you compiled — reload and re-read the readback.",
    );
  }
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to save policy set: ${err}`);
  }
  return projectPolicySet(((await res.json()) as PolicySetRow[])[0]);
}

// ── Gate consumption ────────────────────────────────────────────────────

export interface PredicateVerdict {
  effect: "hold" | "deny";
  ruleId: string;
  policyVersion: number;
  /** The single rule's readback line — envelope/receipt attribution (I6). */
  readback: string;
}

/**
 * The compiled-predicate layer of the dispatch gate (both checkpoints).
 * Callers treat a throw as fail-closed (I2). No head = no compiled layer.
 */
export async function evaluateCompiledPredicates(input: {
  appId: string;
  functionName: string;
  args: Record<string, unknown>;
}): Promise<PredicateVerdict | null> {
  const head = await readPolicySetHead(input.appId);
  if (!head || head.artifact.rules.length === 0) return null;
  const matched = evaluatePolicyRules(
    head.artifact,
    input.functionName,
    input.args,
  );
  if (!matched) return null;
  return {
    effect: matched.rule.effect,
    ruleId: matched.rule.id,
    policyVersion: head.version,
    readback: renderRuleReadback(matched.rule),
  };
}

// ── Compiler (BYOK) ─────────────────────────────────────────────────────

export class PolicyCompileError extends Error {
  readonly kind: "clarification" | "invalid" | "no_byok" | "model_output";
  readonly errors: string[];
  constructor(
    kind: "clarification" | "invalid" | "no_byok" | "model_output",
    message: string,
    errors: string[] = [],
  ) {
    super(message);
    this.name = "PolicyCompileError";
    this.kind = kind;
    this.errors = errors;
  }
}

function describeFunctionForCompiler(fact: DeclaredFunctionFacts): string {
  const paths: string[] = [];
  const walk = (
    schema: Record<string, unknown> | null | undefined,
    prefix: string,
  ) => {
    const properties = schema?.properties as
      | Record<string, unknown>
      | undefined;
    if (!properties) return;
    for (const [key, raw] of Object.entries(properties)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const node = raw as Record<string, unknown>;
      const path = prefix ? `${prefix}.${key}` : key;
      paths.push(
        `${path} (${typeof node.type === "string" ? node.type : "unknown"})`,
      );
      walk(node, path);
    }
  };
  walk(fact.inputSchema ?? null, "");
  return `- ${fact.name}: ${fact.description ?? "no description"}\n` +
    `  paths: ${paths.length > 0 ? paths.join(", ") : "none declared"}`;
}

const COMPILER_SYSTEM_PROMPT =
  `You compile an agent owner's plain-language policy into deterministic rules.

Output STRICT JSON, nothing else. Either:
  {"rules": [{"id": "r1", "functionName": "...", "effect": "hold"|"deny", "when": [{"path": "...", "op": "...", "value": ...}], "note": "short paraphrase of the source clause"}]}
or, when the text cannot compile into rules over the declared functions:
  {"clarificationNeeded": "one precise question for the owner"}

Rules:
- Ops: eq, neq, gt, gte, lt, lte (numbers), contains (string), in (array of scalars), exists, absent (no value).
- 'when' is an AND of 1-4 conditions on declared arg paths. Use separate rules for OR.
- effect 'hold' means the owner approves each matching call; 'deny' means it never runs. There is NO allow effect.
- Only reference the declared functions and paths given. If the policy names something undeclared or is vague ("be careful"), emit clarificationNeeded instead of guessing.
- ids are r1, r2, ... in order.`;

export interface CompilePolicyDeps {
  resolveRoute?: typeof resolveInferenceRoute;
  fetchCompletion?: typeof fetchInferenceChatCompletion;
}

export async function compilePolicyText(
  input: {
    userId: string;
    userEmail: string;
    text: string;
    facts: DeclaredFunctionFacts[];
  },
  deps: CompilePolicyDeps = {},
): Promise<{
  artifact: LaunchPolicyArtifact;
  source: LaunchPolicySourceEntry[];
  compileModel: string;
}> {
  const resolveRoute = deps.resolveRoute ?? resolveInferenceRoute;
  const fetchCompletion = deps.fetchCompletion ?? fetchInferenceChatCompletion;
  let route;
  try {
    // Decision 1: compiling is BYOK — the platform never supplies the model.
    route = await resolveRoute({
      userId: input.userId,
      userEmail: input.userEmail,
      byokOnly: true,
    });
  } catch (err) {
    if (err instanceof InferenceRouteError) {
      throw new PolicyCompileError(
        "no_byok",
        "Compiling policies runs on your own model key. Add a BYOK provider in Settings, then compile again.",
      );
    }
    throw err;
  }
  const model = selectInferenceModel(route, null);
  const catalog = input.facts.map(describeFunctionForCompiler).join("\n");
  const response = await fetchCompletion(
    route,
    {
      model,
      messages: [
        { role: "system", content: COMPILER_SYSTEM_PROMPT },
        {
          role: "user",
          content: `## Declared functions\n${catalog}\n\n## Policy text\n${input.text}`,
        },
      ],
      temperature: 0,
      max_tokens: 2048,
      response_format: { type: "json_object" },
    },
    {
      title: "Galactic Policy Compiler",
      referer: "https://api.ultralightagent.com",
    },
  );
  if (!response.ok) {
    const err = await response.text().catch(() => response.statusText);
    throw new PolicyCompileError(
      "model_output",
      `Your model could not be reached to compile (${response.status}).`,
      [err.slice(0, 300)],
    );
  }
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
  };
  const raw = data.choices?.[0]?.message?.content ?? "";
  const stripped = raw.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "")
    .trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    throw new PolicyCompileError(
      "model_output",
      "Your model's compile output was not valid JSON — try rephrasing, or switch the BYOK model.",
      [stripped.slice(0, 300)],
    );
  }
  if (typeof parsed.clarificationNeeded === "string") {
    // Doc §6: clarification is surfaced as the save error — nothing persists.
    throw new PolicyCompileError("clarification", parsed.clarificationNeeded);
  }
  const artifact: LaunchPolicyArtifact = {
    version: 1,
    rules: Array.isArray(parsed.rules)
      ? parsed.rules as LaunchPolicyRule[]
      : [],
  };
  const validation = validatePolicyArtifact(artifact, input.facts);
  if (!validation.ok) {
    throw new PolicyCompileError(
      "invalid",
      "The compiled rules failed validation — nothing was saved.",
      validation.errors,
    );
  }
  return {
    artifact,
    source: [{
      text: input.text,
      ruleIds: artifact.rules.map((rule) => rule.id),
    }],
    compileModel: data.model ?? model,
  };
}
