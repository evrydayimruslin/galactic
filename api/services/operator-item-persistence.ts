import { getEnv } from "../lib/env.ts";
import {
  type LaunchAgentEvidenceReference,
  type LaunchOperatorItemCandidate,
  type LaunchOperatorRemediation,
  type LaunchOperatorScope,
  OPERATOR_ISSUE_CONTRACT_VERSION,
} from "../../shared/contracts/launch.ts";
import { redactOperatorProjectionText } from "./operator-projection-redaction.ts";
import { assertRegisteredOperatorRemediation } from "./operator-remediation-registry.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CAUSE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/u;
const MAX_ITEMS = 500;
const MAX_BATCH_BYTES = 1_000_000;
const MAX_SUMMARY_CHARS = 240;
const MAX_DETAIL_CHARS = 2_000;
const MAX_LABEL_CHARS = 160;
const CONDITION_CODES = new Set([
  "ACCOUNT_BYOK_MISSING",
  "ACCOUNT_USAGE_EXHAUSTED",
  "AGENT_CAPABILITY_APPROVAL_REQUIRED",
  "AGENT_GRANT_REQUIRED",
  "AGENT_PRIMARY_ROUTINE_MISSING",
  "AGENT_RELEASE_REVIEW_REQUIRED",
  "AGENT_REPORTING_NOT_CONFIGURED",
  "AGENT_SECRET_MISSING",
  "AGENT_SETTING_MISSING",
  "ROUTINE_PAUSED_AFTER_FAILURES",
  "ROUTINE_USAGE_EXHAUSTED",
]);

export interface OperatorItemPersistenceDependencies {
  fetchFn?: typeof fetch;
  supabaseUrl?: string;
  serviceRoleKey?: string;
}

export interface ReconcileOperatorItemsInput {
  userId: string;
  sourceKey: string;
  items: readonly LaunchOperatorItemCandidate[];
  observedAt: string;
  /**
   * A complete source snapshot recovers active rows from this source that are
   * absent from `items`. Partial/event writers must leave this false.
   */
  completeSnapshot: boolean;
}

export interface ReconciledOperatorItemReference {
  id: string;
  conditionKey: string;
  created: boolean;
}

export interface ReconcileOperatorItemsResult {
  observedCount: number;
  insertedCount: number;
  updatedCount: number;
  recoveredCount: number;
  items: ReconciledOperatorItemReference[];
}

export type OperatorItemPersistenceErrorCode =
  | "INVALID_INPUT"
  | "UNSAFE_ITEM"
  | "SERVICE_UNAVAILABLE"
  | "PERSISTENCE_FAILED"
  | "INVALID_RESPONSE";

export class OperatorItemPersistenceError extends Error {
  constructor(
    readonly code: OperatorItemPersistenceErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OperatorItemPersistenceError";
  }
}

interface PersistedOperatorItemPayload {
  contractVersion: typeof OPERATOR_ISSUE_CONTRACT_VERSION;
  conditionKey: string;
  itemClass: LaunchOperatorItemCandidate["itemClass"];
  scope: LaunchOperatorScope;
  severity: LaunchOperatorItemCandidate["severity"];
  diagnosis: LaunchOperatorItemCandidate["diagnosis"];
  affectedAgents: LaunchOperatorItemCandidate["affectedAgents"];
  remediations: LaunchOperatorItemCandidate["remediations"];
  requiresAction: boolean;
  requiresDecision: boolean;
  ordering: LaunchOperatorItemCandidate["ordering"];
  recovery: LaunchOperatorItemCandidate["recovery"];
  detectedAt: string;
  definitionHash: string;
}

function fail(
  code: OperatorItemPersistenceErrorCode,
  message: string,
): never {
  throw new OperatorItemPersistenceError(
    code,
    message,
    code === "INVALID_INPUT" || code === "UNSAFE_ITEM" ? 400 : 503,
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function validConditionKey(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 600 &&
    !containsControlCharacter(value) &&
    redactOperatorProjectionText(value) === value;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
  code: OperatorItemPersistenceErrorCode = "INVALID_INPUT",
): Record<string, unknown> {
  const parsed = record(value);
  if (
    !parsed ||
    Object.keys(parsed).sort().join(",") !== [...expected].sort().join(",")
  ) {
    fail(code, `${label} contains unsupported fields.`);
  }
  return parsed;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    fail("INVALID_INPUT", `${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

function iso(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail("INVALID_INPUT", `${label} must be an ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function safeText(
  value: unknown,
  label: string,
  maxChars: number,
  nullable = false,
): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars ||
    containsControlCharacter(value)
  ) {
    fail("INVALID_INPUT", `${label} must be bounded plain text.`);
  }
  if (redactOperatorProjectionText(value) !== value) {
    fail("UNSAFE_ITEM", `${label} contains secret-shaped content.`);
  }
  return value;
}

function safeIdentifier(
  value: unknown,
  label: string,
  maxChars = 240,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars ||
    containsControlCharacter(value)
  ) {
    fail("INVALID_INPUT", `${label} is invalid.`);
  }
  if (redactOperatorProjectionText(value) !== value) {
    fail("UNSAFE_ITEM", `${label} contains secret-shaped content.`);
  }
  return value;
}

function validateEvidence(value: LaunchAgentEvidenceReference): void {
  const parsed = record(value);
  if (!parsed) fail("INVALID_INPUT", "Evidence must be an object.");
  const allowed = [
    "kind",
    "sourceId",
    "label",
    "observedAt",
    "destination",
  ];
  if (Object.keys(parsed).some((key) => !allowed.includes(key))) {
    fail("INVALID_INPUT", "Evidence contains unsupported fields.");
  }
  if (
    ![
      "routine",
      "run",
      "schedule",
      "notification",
      "setting",
      "authority",
      "release",
      "compute",
    ].includes(String(value.kind))
  ) {
    fail("INVALID_INPUT", "Evidence kind is invalid.");
  }
  safeIdentifier(value.sourceId, "evidence.sourceId", 240);
  safeText(value.label, "evidence.label", MAX_LABEL_CHARS);
  if (value.observedAt !== null) iso(value.observedAt, "evidence.observedAt");
  if (value.destination !== undefined && value.destination !== null) {
    const destination = record(value.destination);
    if (!destination) {
      fail("INVALID_INPUT", "Evidence destination is invalid.");
    }
    const destinationAllowed = ["href", "agentId", "pane", "itemId"];
    if (
      Object.keys(destination).some((key) =>
        !destinationAllowed.includes(key)
      ) ||
      typeof value.destination.href !== "string" ||
      !value.destination.href.startsWith("/") ||
      value.destination.href.startsWith("//") ||
      value.destination.href.length > 500 ||
      containsControlCharacter(value.destination.href) ||
      redactOperatorProjectionText(value.destination.href) !==
        value.destination.href
    ) {
      fail("UNSAFE_ITEM", "Evidence destination must be an internal route.");
    }
  }
}

function validateScope(value: LaunchOperatorScope): {
  agentId: string | null;
  routineId: string | null;
  runId: string | null;
} {
  switch (value.kind) {
    case "account":
      exactKeys(value, ["kind"], "Account scope");
      return { agentId: null, routineId: null, runId: null };
    case "agent":
      exactKeys(value, ["kind", "agentId"], "Agent scope");
      return {
        agentId: uuid(value.agentId, "scope.agentId"),
        routineId: null,
        runId: null,
      };
    case "routine":
      exactKeys(value, ["kind", "agentId", "routineId"], "Routine scope");
      return {
        agentId: uuid(value.agentId, "scope.agentId"),
        routineId: uuid(value.routineId, "scope.routineId"),
        runId: null,
      };
    case "run":
      exactKeys(
        value,
        ["kind", "agentId", "routineId", "runId"],
        "Run scope",
      );
      return {
        agentId: uuid(value.agentId, "scope.agentId"),
        routineId: uuid(value.routineId, "scope.routineId"),
        runId: uuid(value.runId, "scope.runId"),
      };
  }
}

function remediationAgentId(
  remediation: LaunchOperatorRemediation,
): string | null {
  return "agentId" in remediation.target
    ? uuid(remediation.target.agentId, "remediation.target.agentId")
    : null;
}

function validateRemediations(
  conditionKey: string,
  remediations: readonly LaunchOperatorRemediation[],
  affectedAgentIds: ReadonlySet<string>,
  scope: ReturnType<typeof validateScope>,
): void {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const remediation of remediations) {
    try {
      assertRegisteredOperatorRemediation(remediation);
    } catch (cause) {
      fail(
        "UNSAFE_ITEM",
        cause instanceof Error
          ? cause.message
          : "Remediation is not registered.",
      );
    }
    const expectedId = `${conditionKey}:remediation:${remediation.key}`;
    if (remediation.id !== expectedId) {
      fail("UNSAFE_ITEM", "Remediation identity is not server-derived.");
    }
    if (ids.has(remediation.id) || keys.has(remediation.key)) {
      fail("INVALID_INPUT", "Remediations must be unique.");
    }
    ids.add(remediation.id);
    keys.add(remediation.key);
    safeText(remediation.label, "remediation.label", MAX_LABEL_CHARS);
    safeText(
      remediation.description,
      "remediation.description",
      500,
      true,
    );
    const targetAgentId = remediationAgentId(remediation);
    if (
      targetAgentId &&
      (!affectedAgentIds.has(targetAgentId) ||
        (scope.agentId !== null && scope.agentId !== targetAgentId))
    ) {
      fail(
        "UNSAFE_ITEM",
        "Remediation target is outside the affected Agent scope.",
      );
    }
    if (
      "routineId" in remediation.target &&
      scope.routineId !== null &&
      uuid(remediation.target.routineId, "remediation.target.routineId") !==
        scope.routineId
    ) {
      fail("UNSAFE_ITEM", "Remediation target uses another routine.");
    }
    if (
      "runId" in remediation.target &&
      remediation.target.runId !== null &&
      scope.runId !== null &&
      uuid(remediation.target.runId, "remediation.target.runId") !== scope.runId
    ) {
      fail("UNSAFE_ITEM", "Remediation target uses another run.");
    }
  }
}

function validateCandidate(item: LaunchOperatorItemCandidate): void {
  exactKeys(
    item,
    [
      "id",
      "itemClass",
      "conditionKey",
      "scope",
      "severity",
      "diagnosis",
      "affectedAgents",
      "remediations",
      "requiresAction",
      "requiresDecision",
      "ordering",
      "recovery",
      "detectedAt",
    ],
    "Operator item",
  );
  if (item.id !== null) {
    fail("INVALID_INPUT", "Only unpersisted compiler candidates are accepted.");
  }
  if (!validConditionKey(item.conditionKey)) {
    fail("INVALID_INPUT", "conditionKey is invalid.");
  }
  const scope = validateScope(item.scope);
  if (!["info", "warning", "critical"].includes(item.severity)) {
    fail("INVALID_INPUT", "Operator item severity is invalid.");
  }
  const diagnosis = exactKeys(
    item.diagnosis,
    ["code", "causeCode", "summary", "detail", "provenance", "evidence"],
    "Diagnosis",
  );
  if (
    typeof diagnosis.code !== "string" ||
    !CONDITION_CODES.has(diagnosis.code)
  ) {
    fail("INVALID_INPUT", "diagnosis.code is invalid.");
  }
  if (
    diagnosis.causeCode !== null &&
    (typeof diagnosis.causeCode !== "string" ||
      !CAUSE_CODE.test(diagnosis.causeCode))
  ) {
    fail("INVALID_INPUT", "diagnosis.causeCode is invalid.");
  }
  safeText(diagnosis.summary, "diagnosis.summary", MAX_SUMMARY_CHARS);
  safeText(diagnosis.detail, "diagnosis.detail", MAX_DETAIL_CHARS, true);
  if (
    !["platform", "provider", "developer", "combined", "unknown"].includes(
      String(diagnosis.provenance),
    )
  ) {
    fail("INVALID_INPUT", "diagnosis.provenance is invalid.");
  }
  if (!Array.isArray(item.diagnosis.evidence)) {
    fail("INVALID_INPUT", "diagnosis.evidence must be an array.");
  }
  item.diagnosis.evidence.forEach(validateEvidence);

  if (
    !Array.isArray(item.affectedAgents) ||
    item.affectedAgents.length === 0 ||
    item.affectedAgents.length > 500
  ) {
    fail("INVALID_INPUT", "affectedAgents must be a bounded non-empty array.");
  }
  const affectedAgentIds = new Set<string>();
  for (const affected of item.affectedAgents) {
    exactKeys(
      affected,
      ["agentId", "blocking"],
      "Affected Agent",
    );
    const agentId = uuid(affected.agentId, "affectedAgent.agentId");
    if (
      affectedAgentIds.has(agentId) || typeof affected.blocking !== "boolean"
    ) {
      fail("INVALID_INPUT", "Affected Agents must be unique and typed.");
    }
    affectedAgentIds.add(agentId);
  }
  if (scope.agentId !== null && !affectedAgentIds.has(scope.agentId)) {
    fail("INVALID_INPUT", "Scoped Agent must be affected by the item.");
  }

  if (!Array.isArray(item.remediations)) {
    fail("INVALID_INPUT", "remediations must be an array.");
  }
  validateRemediations(
    item.conditionKey,
    item.remediations,
    affectedAgentIds,
    scope,
  );
  if (
    (item.itemClass === "issue" &&
      (!item.requiresAction || item.remediations.length === 0)) ||
    (item.itemClass === "report" &&
      (item.requiresAction ||
        item.requiresDecision ||
        item.remediations.length !== 0)) ||
    !["issue", "report"].includes(item.itemClass)
  ) {
    fail("INVALID_INPUT", "Operator item class shape is invalid.");
  }
  if (
    typeof item.requiresDecision !== "boolean" ||
    typeof item.requiresAction !== "boolean"
  ) {
    fail("INVALID_INPUT", "Operator item action flags are invalid.");
  }

  exactKeys(
    item.ordering,
    ["sourceOrdinal", "dependsOnConditionKeys"],
    "Ordering",
  );
  if (
    !Number.isSafeInteger(item.ordering.sourceOrdinal) ||
    item.ordering.sourceOrdinal < 0 ||
    !Array.isArray(item.ordering.dependsOnConditionKeys)
  ) {
    fail("INVALID_INPUT", "Operator item ordering is invalid.");
  }
  const dependencies = new Set<string>();
  for (const dependency of item.ordering.dependsOnConditionKeys) {
    if (
      !validConditionKey(dependency) ||
      dependency === item.conditionKey ||
      dependencies.has(dependency)
    ) {
      fail("INVALID_INPUT", "Operator item dependencies are invalid.");
    }
    dependencies.add(dependency);
  }

  exactKeys(
    item.recovery,
    ["mode", "mayRecoverAutomatically", "resumesScheduledWork"],
    "Recovery",
  );
  if (
    ![
      "automatic_reset",
      "revalidate_condition",
      "successful_verification",
    ].includes(item.recovery.mode) ||
    item.recovery.mayRecoverAutomatically !== true ||
    item.recovery.resumesScheduledWork !== false
  ) {
    fail("UNSAFE_ITEM", "Operator item recovery policy is invalid.");
  }
  iso(item.detectedAt, "detectedAt");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const parsed = value as Record<string, unknown>;
  return `{${
    Object.keys(parsed).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(parsed[key])}`
    ).join(",")
  }}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function payload(
  item: LaunchOperatorItemCandidate,
): Promise<PersistedOperatorItemPayload> {
  validateCandidate(item);
  const definition = {
    contractVersion: OPERATOR_ISSUE_CONTRACT_VERSION,
    conditionKey: item.conditionKey,
    itemClass: item.itemClass,
    scope: item.scope,
    severity: item.severity,
    diagnosis: item.diagnosis,
    affectedAgents: item.affectedAgents,
    remediations: item.remediations,
    requiresAction: item.requiresAction,
    requiresDecision: item.requiresDecision,
    ordering: item.ordering,
    recovery: item.recovery,
    detectedAt: iso(item.detectedAt, "detectedAt"),
  };
  return {
    ...definition,
    definitionHash: await sha256(canonicalJson(definition)),
  };
}

function persistenceConfig(
  dependencies: OperatorItemPersistenceDependencies,
): { baseUrl: string; serviceRoleKey: string; fetchFn: typeof fetch } {
  const baseUrl = (dependencies.supabaseUrl ?? getEnv("SUPABASE_URL")).replace(
    /\/+$/u,
    "",
  );
  const serviceRoleKey = dependencies.serviceRoleKey ??
    getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !serviceRoleKey) {
    fail(
      "SERVICE_UNAVAILABLE",
      "Operator item persistence is not configured.",
    );
  }
  return {
    baseUrl,
    serviceRoleKey,
    fetchFn: dependencies.fetchFn ?? fetch,
  };
}

function finiteCount(value: unknown, label: string): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Number(value)
    : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail("INVALID_RESPONSE", `${label} is invalid.`);
  }
  return parsed;
}

function reconciliationResult(value: unknown): ReconcileOperatorItemsResult {
  const parsed = exactKeys(
    value,
    [
      "observedCount",
      "insertedCount",
      "updatedCount",
      "recoveredCount",
      "items",
    ],
    "Operator item reconciliation response",
    "INVALID_RESPONSE",
  );
  if (!Array.isArray(parsed.items)) {
    fail("INVALID_RESPONSE", "Operator item reconciliation items are invalid.");
  }
  const items = parsed.items.map((value, index) => {
    const item = exactKeys(
      value,
      ["id", "conditionKey", "created"],
      `Reconciled item ${index}`,
      "INVALID_RESPONSE",
    );
    if (
      typeof item.conditionKey !== "string" ||
      !validConditionKey(item.conditionKey) ||
      typeof item.created !== "boolean"
    ) {
      fail("INVALID_RESPONSE", `Reconciled item ${index} is invalid.`);
    }
    return {
      id: uuid(item.id, `reconciled item ${index} id`),
      conditionKey: item.conditionKey,
      created: item.created,
    };
  });
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    new Set(items.map((item) => item.conditionKey)).size !== items.length
  ) {
    fail(
      "INVALID_RESPONSE",
      "Operator reconciliation returned duplicate item references.",
    );
  }
  const result = {
    observedCount: finiteCount(parsed.observedCount, "observedCount"),
    insertedCount: finiteCount(parsed.insertedCount, "insertedCount"),
    updatedCount: finiteCount(parsed.updatedCount, "updatedCount"),
    recoveredCount: finiteCount(parsed.recoveredCount, "recoveredCount"),
    items,
  };
  if (
    result.observedCount !== items.length ||
    result.insertedCount + result.updatedCount !== result.observedCount ||
    result.insertedCount !== items.filter((item) => item.created).length ||
    result.updatedCount !== items.filter((item) => !item.created).length
  ) {
    fail(
      "INVALID_RESPONSE",
      "Operator reconciliation counts are inconsistent.",
    );
  }
  return result;
}

export async function reconcileOperatorItems(
  input: ReconcileOperatorItemsInput,
  dependencies: OperatorItemPersistenceDependencies = {},
): Promise<ReconcileOperatorItemsResult> {
  const userId = uuid(input.userId, "userId");
  if (
    typeof input.sourceKey !== "string" ||
    !SOURCE_KEY.test(input.sourceKey)
  ) {
    fail("INVALID_INPUT", "sourceKey is invalid.");
  }
  if (
    !Array.isArray(input.items) ||
    input.items.length > MAX_ITEMS ||
    typeof input.completeSnapshot !== "boolean"
  ) {
    fail("INVALID_INPUT", "Operator item reconciliation input is invalid.");
  }
  const observedAt = iso(input.observedAt, "observedAt");
  const conditionKeys = new Set<string>();
  for (const item of input.items) {
    const candidate = record(item);
    if (
      !candidate ||
      !validConditionKey(candidate.conditionKey)
    ) {
      fail("INVALID_INPUT", "Operator item candidate is invalid.");
    }
    if (conditionKeys.has(candidate.conditionKey)) {
      fail("INVALID_INPUT", "A batch cannot repeat a conditionKey.");
    }
    conditionKeys.add(candidate.conditionKey);
  }
  const items = await Promise.all(input.items.map(payload));
  if (
    items.some((item) => Date.parse(item.detectedAt) > Date.parse(observedAt))
  ) {
    fail("INVALID_INPUT", "detectedAt cannot be later than observedAt.");
  }
  const snapshotHash = await sha256(canonicalJson({
    completeSnapshot: input.completeSnapshot,
    items,
  }));
  const body = {
    p_user_id: userId,
    p_source_key: input.sourceKey,
    p_items: items,
    p_observed_at: observedAt,
    p_complete_snapshot: input.completeSnapshot,
    p_snapshot_hash: snapshotHash,
  };
  if (
    new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_BATCH_BYTES
  ) {
    fail("INVALID_INPUT", "Operator item reconciliation batch is too large.");
  }
  const config = persistenceConfig(dependencies);
  let response: Response;
  let text: string;
  try {
    response = await config.fetchFn(
      `${config.baseUrl}/rest/v1/rpc/reconcile_operator_items`,
      {
        method: "POST",
        headers: {
          "apikey": config.serviceRoleKey,
          "Authorization": `Bearer ${config.serviceRoleKey}`,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        body: JSON.stringify(body),
      },
    );
    text = await response.text();
  } catch {
    fail("PERSISTENCE_FAILED", "Operator item persistence is unavailable.");
  }
  if (!response.ok) {
    fail("PERSISTENCE_FAILED", "Operator item reconciliation failed.");
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    fail(
      "INVALID_RESPONSE",
      "Operator item persistence returned invalid JSON.",
    );
  }
  return reconciliationResult(parsed);
}
