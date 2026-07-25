import { getEnv } from "../lib/env.ts";
import {
  type LaunchAgentEvidenceReference,
  type LaunchAgentPane,
  type LaunchOperatorAttentionAgentCount,
  type LaunchOperatorAttentionEntry,
  type LaunchOperatorAttentionProjection,
  type LaunchOperatorItem,
  type LaunchOperatorRemediation,
  OPERATOR_ISSUE_CONTRACT_VERSION,
} from "../../shared/contracts/launch.ts";
import {
  isOperatorProjectionIdentifierSecretFree,
  redactOperatorProjectionText,
} from "./operator-projection-redaction.ts";
import {
  assertRegisteredOperatorRemediation,
  OperatorRemediationRegistryError,
} from "./operator-remediation-registry.ts";

const MAX_OPERATOR_ITEMS = 200;
const OPERATOR_ATTENTION_CURSOR_PREFIX = "operator-attention-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
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
const EVIDENCE_KINDS = new Set([
  "routine",
  "run",
  "schedule",
  "notification",
  "setting",
  "authority",
  "release",
  "compute",
]);
const AGENT_PANES = new Set<LaunchAgentPane>([
  "overview",
  "interfaces",
  "alerts",
  "access",
  "routines",
  "functions",
  "compute",
  "settings",
]);

export interface OperatorAttentionAgent {
  id: string;
  slug: string;
  name: string;
}

export interface OperatorAttentionPageOptions {
  cursor?: string | null;
  limit?: number;
}

interface OperatorItemReaderDependencies {
  fetchFn?: typeof fetch;
  now?: Date;
  supabaseUrl?: string;
  serviceRoleKey?: string;
}

interface OperatorAttentionCursor {
  sourceKey: string;
  sourceOrdinal: number;
  detectedAt: string;
  itemId: string;
}

interface OperatorAttentionSnapshotRow {
  items: unknown;
  per_agent_counts: unknown;
  open_count: number | string;
  requires_decision_count: number | string;
  blocking_count: number | string;
  next_source_key: unknown;
  next_source_ordinal: unknown;
  next_detected_at: unknown;
  next_id: unknown;
}

type OperatorItemReadErrorCode =
  | "INVALID_REQUEST"
  | "SERVICE_UNAVAILABLE"
  | "READ_FAILED"
  | "INVALID_RESPONSE";

export class OperatorItemReadError extends Error {
  constructor(
    readonly code: OperatorItemReadErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OperatorItemReadError";
  }
}

function fail(
  code: OperatorItemReadErrorCode,
  message: string,
): never {
  throw new OperatorItemReadError(
    code,
    message,
    code === "INVALID_REQUEST" ? 400 : 503,
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const parsed = record(value);
  if (
    !parsed ||
    Object.keys(parsed).sort().join(",") !== [...keys].sort().join(",")
  ) {
    fail("INVALID_RESPONSE", `${label} contains unsupported fields.`);
  }
  return parsed;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    fail("INVALID_RESPONSE", `${label} is invalid.`);
  }
  return value.toLowerCase();
}

function requestUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    fail("INVALID_REQUEST", `${label} is invalid.`);
  }
  return value.toLowerCase();
}

function iso(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail("INVALID_RESPONSE", `${label} is invalid.`);
  }
  return new Date(value).toISOString();
}

function safeText(
  value: unknown,
  label: string,
  max: number,
  nullable = false,
): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    redactOperatorProjectionText(value) !== value
  ) {
    fail("INVALID_RESPONSE", `${label} is not bounded, secret-safe text.`);
  }
  return value;
}

function safeIdentifier(
  value: unknown,
  label: string,
  max = 600,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    !isOperatorProjectionIdentifierSecretFree(value)
  ) {
    fail("INVALID_RESPONSE", `${label} is not a safe identifier.`);
  }
  return value;
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

function pageLimit(value: number | undefined): number {
  const limit = value ?? MAX_OPERATOR_ITEMS;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_OPERATOR_ITEMS
  ) {
    fail(
      "INVALID_REQUEST",
      `Operator Attention page size must be between 1 and ${MAX_OPERATOR_ITEMS}.`,
    );
  }
  return limit;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/u,
    "",
  );
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > 1_024) {
    fail("INVALID_REQUEST", "The Operator Attention cursor is invalid.");
  }
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(
      atob(base64),
      (character) => character.charCodeAt(0),
    );
  } catch {
    fail("INVALID_REQUEST", "The Operator Attention cursor is invalid.");
  }
}

export function isOperatorAttentionCursor(value: string | null | undefined) {
  return typeof value === "string" &&
    value.startsWith(`${OPERATOR_ATTENTION_CURSOR_PREFIX}.`);
}

export function formatOperatorAttentionCursor(
  value: OperatorAttentionCursor,
): string {
  if (
    !SOURCE_KEY.test(value.sourceKey) ||
    !Number.isSafeInteger(value.sourceOrdinal) ||
    value.sourceOrdinal < 0 ||
    !UUID.test(value.itemId) ||
    !Number.isFinite(Date.parse(value.detectedAt))
  ) {
    fail("INVALID_REQUEST", "The Operator Attention cursor is invalid.");
  }
  const payload = JSON.stringify({
    sourceKey: value.sourceKey,
    sourceOrdinal: value.sourceOrdinal,
    detectedAt: new Date(value.detectedAt).toISOString(),
    itemId: value.itemId.toLowerCase(),
  });
  return `${OPERATOR_ATTENTION_CURSOR_PREFIX}.${
    bytesToBase64Url(new TextEncoder().encode(payload))
  }`;
}

function parseOperatorAttentionCursor(
  value: string,
): OperatorAttentionCursor {
  if (!isOperatorAttentionCursor(value)) {
    fail("INVALID_REQUEST", "The Operator Attention cursor is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        base64UrlToBytes(
          value.slice(OPERATOR_ATTENTION_CURSOR_PREFIX.length + 1),
        ),
      ),
    );
  } catch (cause) {
    if (cause instanceof OperatorItemReadError) throw cause;
    fail("INVALID_REQUEST", "The Operator Attention cursor is invalid.");
  }
  const cursor = record(parsed);
  if (
    !cursor ||
    Object.keys(cursor).sort().join(",") !==
      "detectedAt,itemId,sourceKey,sourceOrdinal" ||
    typeof cursor.sourceKey !== "string" ||
    !SOURCE_KEY.test(cursor.sourceKey) ||
    !Number.isSafeInteger(cursor.sourceOrdinal) ||
    Number(cursor.sourceOrdinal) < 0 ||
    typeof cursor.detectedAt !== "string" ||
    !Number.isFinite(Date.parse(cursor.detectedAt)) ||
    typeof cursor.itemId !== "string" ||
    !UUID.test(cursor.itemId)
  ) {
    fail("INVALID_REQUEST", "The Operator Attention cursor is invalid.");
  }
  return {
    sourceKey: cursor.sourceKey,
    sourceOrdinal: Number(cursor.sourceOrdinal),
    detectedAt: new Date(cursor.detectedAt).toISOString(),
    itemId: cursor.itemId.toLowerCase(),
  };
}

function parseEvidence(
  value: unknown,
  index: number,
  affectedIds: ReadonlySet<string>,
): LaunchAgentEvidenceReference {
  const evidence = record(value);
  if (!evidence) fail("INVALID_RESPONSE", `Evidence ${index} is invalid.`);
  const keys = Object.keys(evidence).sort().join(",");
  if (
    keys !== "kind,label,observedAt,sourceId" &&
    keys !== "destination,kind,label,observedAt,sourceId"
  ) {
    fail("INVALID_RESPONSE", `Evidence ${index} contains unsupported fields.`);
  }
  if (
    typeof evidence.kind !== "string" ||
    !EVIDENCE_KINDS.has(evidence.kind)
  ) {
    fail("INVALID_RESPONSE", `Evidence ${index} kind is invalid.`);
  }
  const destination = evidence.destination;
  let parsedDestination: LaunchAgentEvidenceReference["destination"];
  if (destination !== undefined && destination !== null) {
    const target = record(destination);
    if (
      !target ||
      typeof target.href !== "string" ||
      !target.href.startsWith("/") ||
      target.href.startsWith("//") ||
      target.href.length > 500 ||
      redactOperatorProjectionText(target.href) !== target.href ||
      Object.keys(target).some((key) =>
        !["href", "agentId", "pane", "itemId"].includes(key)
      )
    ) {
      fail("INVALID_RESPONSE", `Evidence ${index} destination is invalid.`);
    }
    const agentId = target.agentId === undefined || target.agentId === null
      ? null
      : uuid(target.agentId, `evidence ${index} destination.agentId`);
    if (agentId !== null && !affectedIds.has(agentId)) {
      fail(
        "INVALID_RESPONSE",
        `Evidence ${index} destination crosses Agent scope.`,
      );
    }
    if (
      target.pane !== undefined &&
      target.pane !== null &&
      (typeof target.pane !== "string" ||
        !AGENT_PANES.has(target.pane as LaunchAgentPane))
    ) {
      fail(
        "INVALID_RESPONSE",
        `Evidence ${index} destination pane is invalid.`,
      );
    }
    const itemId = target.itemId === undefined || target.itemId === null
      ? null
      : safeIdentifier(
        target.itemId,
        `evidence ${index} destination.itemId`,
        240,
      );
    parsedDestination = {
      href: target.href,
      ...(target.agentId === undefined ? {} : { agentId }),
      ...(target.pane === undefined
        ? {}
        : { pane: target.pane as LaunchAgentPane | null }),
      ...(target.itemId === undefined ? {} : { itemId }),
    };
  } else if (destination === null) {
    parsedDestination = null;
  }
  return {
    kind: evidence.kind as LaunchAgentEvidenceReference["kind"],
    sourceId: safeIdentifier(
      evidence.sourceId,
      `evidence ${index} sourceId`,
      240,
    ),
    label: safeText(evidence.label, `evidence ${index} label`, 160)!,
    observedAt: evidence.observedAt === null
      ? null
      : iso(evidence.observedAt, `evidence ${index} observedAt`),
    ...(destination === undefined ? {} : { destination: parsedDestination }),
  };
}

function parseOperatorItem(
  value: unknown,
  index: number,
): LaunchOperatorAttentionEntry {
  const entry = exactKeys(
    value,
    ["item", "attention"],
    `Operator Attention entry ${index}`,
  );
  const item = exactKeys(
    entry.item,
    [
      "id",
      "conditionKey",
      "itemClass",
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
    `Operator item ${index}`,
  );
  const id = uuid(item.id, `operator item ${index} id`);
  const conditionKey = safeIdentifier(
    item.conditionKey,
    `operator item ${index} conditionKey`,
  );
  if (item.itemClass !== "issue" && item.itemClass !== "report") {
    fail("INVALID_RESPONSE", `Operator item ${index} class is invalid.`);
  }
  if (
    item.severity !== "info" &&
    item.severity !== "warning" &&
    item.severity !== "critical"
  ) {
    fail("INVALID_RESPONSE", `Operator item ${index} severity is invalid.`);
  }

  const affected = item.affectedAgents;
  if (
    !Array.isArray(affected) || affected.length < 1 || affected.length > 500
  ) {
    fail("INVALID_RESPONSE", `Operator item ${index} fanout is invalid.`);
  }
  const affectedIds = new Set<string>();
  const affectedAgents = affected.map((value, affectedIndex) => {
    const fanout = exactKeys(
      value,
      ["agentId", "blocking"],
      `Operator item ${index} affected Agent ${affectedIndex}`,
    );
    const agentId = uuid(
      fanout.agentId,
      `operator item ${index} affected Agent ${affectedIndex} id`,
    );
    if (affectedIds.has(agentId) || typeof fanout.blocking !== "boolean") {
      fail("INVALID_RESPONSE", `Operator item ${index} fanout is invalid.`);
    }
    affectedIds.add(agentId);
    return { agentId, blocking: fanout.blocking };
  });

  const scope = record(item.scope);
  if (!scope || typeof scope.kind !== "string") {
    fail("INVALID_RESPONSE", `Operator item ${index} scope is invalid.`);
  }
  const scopeKeys: Record<string, string[]> = {
    account: ["kind"],
    agent: ["kind", "agentId"],
    routine: ["kind", "agentId", "routineId"],
    run: ["kind", "agentId", "routineId", "runId"],
  };
  const expectedScopeKeys = scopeKeys[scope.kind];
  if (
    !expectedScopeKeys ||
    Object.keys(scope).sort().join(",") !== expectedScopeKeys.sort().join(",")
  ) {
    fail("INVALID_RESPONSE", `Operator item ${index} scope is invalid.`);
  }
  for (const key of ["agentId", "routineId", "runId"]) {
    if (key in scope) uuid(scope[key], `operator item ${index} scope.${key}`);
  }
  if (
    typeof scope.agentId === "string" &&
    !affectedIds.has(scope.agentId.toLowerCase())
  ) {
    fail("INVALID_RESPONSE", `Operator item ${index} scope is not affected.`);
  }

  const diagnosis = exactKeys(
    item.diagnosis,
    ["code", "causeCode", "summary", "detail", "provenance", "evidence"],
    `Operator item ${index} diagnosis`,
  );
  if (
    typeof diagnosis.code !== "string" ||
    !CONDITION_CODES.has(diagnosis.code) ||
    (diagnosis.causeCode !== null &&
      (typeof diagnosis.causeCode !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,79}$/u.test(diagnosis.causeCode))) ||
    !["platform", "provider", "developer", "combined", "unknown"].includes(
      String(diagnosis.provenance),
    ) ||
    !Array.isArray(diagnosis.evidence) ||
    diagnosis.evidence.length > 100
  ) {
    fail("INVALID_RESPONSE", `Operator item ${index} diagnosis is invalid.`);
  }
  const parsedDiagnosis = {
    code: diagnosis.code,
    causeCode: diagnosis.causeCode as string | null,
    summary: safeText(
      diagnosis.summary,
      `operator item ${index} diagnosis.summary`,
      240,
    )!,
    detail: safeText(
      diagnosis.detail,
      `operator item ${index} diagnosis.detail`,
      2_000,
      true,
    ),
    provenance: diagnosis.provenance,
    evidence: diagnosis.evidence.map((evidence, evidenceIndex) =>
      parseEvidence(evidence, evidenceIndex, affectedIds)
    ),
  };

  if (!Array.isArray(item.remediations) || item.remediations.length > 20) {
    fail(
      "INVALID_RESPONSE",
      `Operator item ${index} remediations are invalid.`,
    );
  }
  const remediations = item.remediations as LaunchOperatorRemediation[];
  try {
    for (const remediation of remediations) {
      assertRegisteredOperatorRemediation(remediation);
      if (
        remediation.id !==
          `${conditionKey}:remediation:${remediation.key}`
      ) {
        fail(
          "INVALID_RESPONSE",
          `Operator item ${index} remediation id is invalid.`,
        );
      }
      const target = remediation.target as unknown as Record<string, unknown>;
      for (const key of ["agentId", "routineId", "runId"]) {
        if (target[key] !== undefined && target[key] !== null) {
          uuid(
            target[key],
            `operator item ${index} remediation target.${key}`,
          );
        }
      }
      if (
        typeof target.agentId === "string" &&
        !affectedIds.has(target.agentId.toLowerCase())
      ) {
        fail(
          "INVALID_RESPONSE",
          `Operator item ${index} remediation crosses Agent scope.`,
        );
      }
    }
  } catch (cause) {
    if (cause instanceof OperatorItemReadError) throw cause;
    if (cause instanceof OperatorRemediationRegistryError) {
      fail("INVALID_RESPONSE", cause.message);
    }
    throw cause;
  }

  const ordering = exactKeys(
    item.ordering,
    ["sourceOrdinal", "dependsOnConditionKeys"],
    `Operator item ${index} ordering`,
  );
  if (
    !Number.isSafeInteger(ordering.sourceOrdinal) ||
    Number(ordering.sourceOrdinal) < 0 ||
    !Array.isArray(ordering.dependsOnConditionKeys) ||
    ordering.dependsOnConditionKeys.length > 100
  ) {
    fail("INVALID_RESPONSE", `Operator item ${index} ordering is invalid.`);
  }
  const dependencies = ordering.dependsOnConditionKeys.map((dependency) =>
    safeIdentifier(
      dependency,
      `operator item ${index} dependency`,
    )
  );
  if (
    dependencies.includes(conditionKey) ||
    new Set(dependencies).size !== dependencies.length
  ) {
    fail(
      "INVALID_RESPONSE",
      `Operator item ${index} dependencies are invalid.`,
    );
  }

  const recovery = exactKeys(
    item.recovery,
    ["mode", "mayRecoverAutomatically", "resumesScheduledWork"],
    `Operator item ${index} recovery`,
  );
  if (
    ![
      "automatic_reset",
      "revalidate_condition",
      "successful_verification",
    ].includes(String(recovery.mode)) ||
    recovery.mayRecoverAutomatically !== true ||
    recovery.resumesScheduledWork !== false
  ) {
    fail("INVALID_RESPONSE", `Operator item ${index} recovery is invalid.`);
  }
  if (
    typeof item.requiresAction !== "boolean" ||
    typeof item.requiresDecision !== "boolean" ||
    (item.itemClass === "issue" &&
      (!item.requiresAction || remediations.length === 0)) ||
    (item.itemClass === "report" &&
      (item.requiresAction ||
        item.requiresDecision ||
        remediations.length !== 0))
  ) {
    fail("INVALID_RESPONSE", `Operator item ${index} class shape is invalid.`);
  }

  const attention = exactKeys(
    entry.attention,
    ["state", "readAt", "snoozedUntil", "dismissedAt"],
    `Operator item ${index} Attention state`,
  );
  if (
    attention.state !== "open" ||
    attention.snoozedUntil !== null ||
    attention.dismissedAt !== null
  ) {
    fail(
      "INVALID_RESPONSE",
      `Operator item ${index} is not an active Attention item.`,
    );
  }

  return {
    item: {
      id,
      conditionKey,
      itemClass: item.itemClass,
      scope: scope as LaunchOperatorItem["scope"],
      severity: item.severity,
      diagnosis: parsedDiagnosis as LaunchOperatorItem["diagnosis"],
      affectedAgents,
      remediations,
      requiresAction: item.requiresAction,
      requiresDecision: item.requiresDecision,
      ordering: {
        sourceOrdinal: Number(ordering.sourceOrdinal),
        dependsOnConditionKeys: dependencies,
      },
      recovery: {
        mode: recovery.mode as LaunchOperatorItem["recovery"]["mode"],
        mayRecoverAutomatically: true,
        resumesScheduledWork: false,
      },
      detectedAt: iso(
        item.detectedAt,
        `operator item ${index} detectedAt`,
      ),
    } as LaunchOperatorItem,
    attention: {
      state: "open",
      readAt: attention.readAt === null
        ? null
        : iso(attention.readAt, `operator item ${index} readAt`),
      snoozedUntil: null,
      dismissedAt: null,
    },
  };
}

function readerConfig(
  dependencies: OperatorItemReaderDependencies,
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
      "Canonical Operator Attention is not configured.",
    );
  }
  return {
    baseUrl,
    serviceRoleKey,
    fetchFn: dependencies.fetchFn ?? fetch,
  };
}

async function responseRows(response: Response): Promise<unknown[]> {
  if (!response.ok) {
    await response.text().catch(() => "");
    fail("READ_FAILED", "Canonical Operator Attention is unavailable.");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    fail("INVALID_RESPONSE", "Canonical Operator Attention is unavailable.");
  }
  if (!Array.isArray(value)) {
    fail("INVALID_RESPONSE", "Canonical Operator Attention is unavailable.");
  }
  return value;
}

function nextCursor(snapshot: OperatorAttentionSnapshotRow): string | null {
  const values = [
    snapshot.next_source_key,
    snapshot.next_source_ordinal,
    snapshot.next_detected_at,
    snapshot.next_id,
  ];
  if (values.every((value) => value === null)) return null;
  if (
    typeof snapshot.next_source_key !== "string" ||
    !SOURCE_KEY.test(snapshot.next_source_key) ||
    !Number.isSafeInteger(snapshot.next_source_ordinal) ||
    Number(snapshot.next_source_ordinal) < 0
  ) {
    fail("INVALID_RESPONSE", "Canonical Operator Attention cursor is invalid.");
  }
  return formatOperatorAttentionCursor({
    sourceKey: snapshot.next_source_key,
    sourceOrdinal: Number(snapshot.next_source_ordinal),
    detectedAt: iso(snapshot.next_detected_at, "next detectedAt"),
    itemId: uuid(snapshot.next_id, "next item id"),
  });
}

function parseAgentCounts(
  value: unknown,
  agents: readonly OperatorAttentionAgent[],
): LaunchOperatorAttentionAgentCount[] {
  if (!Array.isArray(value)) {
    fail("INVALID_RESPONSE", "Canonical Agent counts are invalid.");
  }
  const agentById = new Map(agents.map((agent) => [
    requestUuid(agent.id, "agent.id"),
    agent,
  ]));
  const seen = new Set<string>();
  return value.map((row, index) => {
    const count = exactKeys(
      row,
      [
        "agent_id",
        "open_count",
        "requires_decision_count",
        "blocking_count",
      ],
      `Canonical Agent count ${index}`,
    );
    const agentId = uuid(count.agent_id, `canonical Agent count ${index} id`);
    const agent = agentById.get(agentId);
    if (!agent || seen.has(agentId)) {
      fail("INVALID_RESPONSE", "Canonical Agent counts are not owner-scoped.");
    }
    seen.add(agentId);
    const openCount = finiteCount(count.open_count, "Agent openCount");
    const requiresDecisionCount = finiteCount(
      count.requires_decision_count,
      "Agent requiresDecisionCount",
    );
    const blockingCount = finiteCount(
      count.blocking_count,
      "Agent blockingCount",
    );
    if (
      requiresDecisionCount > openCount ||
      blockingCount > openCount
    ) {
      fail("INVALID_RESPONSE", "Canonical Agent counts are inconsistent.");
    }
    return {
      agent: {
        id: agentId,
        slug: agent.slug || agentId,
        name: agent.name || agent.slug || agentId,
      },
      openCount,
      requiresDecisionCount,
      blockingCount,
    };
  });
}

export async function readOperatorAttentionPage(
  userIdValue: string,
  agents: readonly OperatorAttentionAgent[],
  agentIdValue: string | null,
  options: OperatorAttentionPageOptions = {},
  dependencies: OperatorItemReaderDependencies = {},
): Promise<LaunchOperatorAttentionProjection> {
  const userId = requestUuid(userIdValue, "userId");
  const agentId = agentIdValue === null
    ? null
    : requestUuid(agentIdValue, "agentId");
  const uniqueAgentIds = new Set<string>();
  for (const agent of agents) {
    const id = requestUuid(agent.id, "agent.id");
    if (uniqueAgentIds.has(id)) {
      fail("INVALID_REQUEST", "Agent metadata contains duplicates.");
    }
    uniqueAgentIds.add(id);
  }
  if (agentId !== null && !uniqueAgentIds.has(agentId)) {
    fail(
      "INVALID_REQUEST",
      "Agent metadata does not include the requested Agent.",
    );
  }
  const cursor = options.cursor
    ? parseOperatorAttentionCursor(options.cursor)
    : null;
  const limit = pageLimit(options.limit);
  const now = dependencies.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    fail("INVALID_REQUEST", "now is invalid.");
  }
  const config = readerConfig(dependencies);
  const response = await config.fetchFn(
    `${config.baseUrl}/rest/v1/rpc/get_operator_attention_page`,
    {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_agent_id: agentId,
        p_now: now.toISOString(),
        p_limit: limit,
        p_after_source_key: cursor?.sourceKey ?? null,
        p_after_source_ordinal: cursor?.sourceOrdinal ?? null,
        p_after_detected_at: cursor?.detectedAt ?? null,
        p_after_id: cursor?.itemId ?? null,
      }),
    },
  ).catch(() =>
    fail("READ_FAILED", "Canonical Operator Attention is unavailable.")
  );
  const rows = await responseRows(response);
  const snapshot = record(rows[0]) as OperatorAttentionSnapshotRow | null;
  if (!snapshot || rows.length !== 1 || !Array.isArray(snapshot.items)) {
    fail("INVALID_RESPONSE", "Canonical Operator Attention is unavailable.");
  }
  const items = snapshot.items.map(parseOperatorItem);
  if (new Set(items.map((entry) => entry.item.id)).size !== items.length) {
    fail(
      "INVALID_RESPONSE",
      "Canonical Operator Attention contains duplicates.",
    );
  }
  const openCount = finiteCount(snapshot.open_count, "openCount");
  const requiresDecisionCount = finiteCount(
    snapshot.requires_decision_count,
    "requiresDecisionCount",
  );
  const blockingCount = finiteCount(snapshot.blocking_count, "blockingCount");
  if (
    items.length > limit ||
    items.length > openCount ||
    requiresDecisionCount > openCount ||
    blockingCount > openCount
  ) {
    fail(
      "INVALID_RESPONSE",
      "Canonical Operator Attention counts are inconsistent.",
    );
  }
  const agentCounts = parseAgentCounts(snapshot.per_agent_counts, agents);
  if (
    agentId !== null && agentCounts.some((entry) => entry.agent.id !== agentId)
  ) {
    fail("INVALID_RESPONSE", "Canonical Agent projection crosses Agent scope.");
  }
  return {
    contractVersion: OPERATOR_ISSUE_CONTRACT_VERSION,
    items,
    agentCounts,
    openCount,
    requiresDecisionCount,
    blockingCount,
    nextCursor: nextCursor(snapshot),
    available: true,
    unavailableReason: null,
    generatedAt: now.toISOString(),
  };
}
