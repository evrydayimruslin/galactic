import type {
  LaunchAgentAttentionAction,
  LaunchAgentAttentionActionKey,
  LaunchAgentAttentionActionRequest,
  LaunchAgentAttentionItem,
  LaunchAgentAttentionLifecycle,
  LaunchAgentAttentionProjection,
  LaunchAgentEvidenceReference,
  LaunchGlobalAttentionAgentCount,
  LaunchGlobalAttentionResponse,
  LaunchNavigationTarget,
} from "../../shared/contracts/launch.ts";
import {
  isOperatorProjectionIdentifierSecretFree,
  redactOperatorProjectionText,
} from "./operator-projection-redaction.ts";
import { createSupabaseRestClient } from "./platform-clients/supabase-rest.ts";

const MAX_ATTENTION_ROWS = 200;
const ATTENTION_CURSOR_PREFIX = "attention-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,239}$/u;
const BRIEF_ACTION_KEYS = new Set<LaunchAgentAttentionActionKey>([
  "open_access_setting",
  "open_release_review",
  "open_routine",
  "approve_grant",
  "resume_agent",
]);

export interface AgentAttentionNotificationRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  action_url: string | null;
  item_class: "report" | "incident";
  requires_action: boolean;
  lifecycle_state: "open" | "snoozed" | "resolved" | "archived";
  state_changed_at: string;
  snoozed_until: string | null;
  resolved_at: string | null;
  resolution_reason: string | null;
  archived_at: string | null;
  created_at: string;
  read_at: string | null;
}

export interface AgentAttentionBriefRow {
  id: string;
  notification_id: string;
  revision: number | string;
  source_hash: string;
  status: "pending" | "ready" | "failed" | "disabled";
  provider: string | null;
  model: string | null;
  headline: string | null;
  impact: string | null;
  recommended_action: string | null;
  evidence: unknown;
  confidence: number | string | null;
  action_key: string | null;
  action_parameters: unknown;
  generated_at: string | null;
}

interface AgentAttentionReadInput {
  agent: {
    id: string;
    slug: string;
    name: string;
  };
  notifications: readonly AgentAttentionNotificationRow[];
  briefs?: readonly AgentAttentionBriefRow[];
  now?: Date;
}

interface AgentAttentionStoreDependencies {
  fetchFn?: typeof fetch;
  now?: Date;
}

interface AgentAttentionPageOptions {
  cursor?: string | null;
  limit?: number;
}

interface AgentAttentionCursorValue {
  occurredAt: string;
  notificationId: string;
}

interface OwnerAttentionSnapshotRow {
  notifications: unknown;
  per_agent_counts: unknown;
  open_count: number | string;
  requires_decision_count: number | string;
  next_before_created_at: unknown;
  next_before_id: unknown;
}

interface AgentAttentionSnapshotRow {
  notifications: unknown;
  open_count: number | string;
  requires_decision_count: number | string;
  next_before_created_at: unknown;
  next_before_id: unknown;
}

export class AgentAttentionStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "ATTENTION_READ_FAILED"
      | "ATTENTION_TRANSITION_FAILED"
      | "ATTENTION_INVALID_REQUEST",
    readonly status = 500,
  ) {
    super(message);
    this.name = "AgentAttentionStoreError";
  }
}

function attentionInvalidRequest(message: string): AgentAttentionStoreError {
  return new AgentAttentionStoreError(
    message,
    "ATTENTION_INVALID_REQUEST",
    400,
  );
}

function attentionPageLimit(value: number | undefined): number {
  const limit = value ?? MAX_ATTENTION_ROWS;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_ATTENTION_ROWS
  ) {
    throw attentionInvalidRequest(
      `Attention page size must be between 1 and ${MAX_ATTENTION_ROWS}.`,
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
    throw attentionInvalidRequest("The Attention cursor is invalid.");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  try {
    return Uint8Array.from(
      atob(base64),
      (character) => character.charCodeAt(0),
    );
  } catch {
    throw attentionInvalidRequest("The Attention cursor is invalid.");
  }
}

export function formatAgentAttentionCursor(
  value: AgentAttentionCursorValue,
): string {
  const occurredAt = validIso(value.occurredAt);
  if (!occurredAt || !UUID.test(value.notificationId)) {
    throw attentionInvalidRequest("The Attention cursor is invalid.");
  }
  const payload = JSON.stringify({
    notificationId: value.notificationId.toLowerCase(),
    occurredAt,
  });
  return `${ATTENTION_CURSOR_PREFIX}.${
    bytesToBase64Url(new TextEncoder().encode(payload))
  }`;
}

function parseAgentAttentionCursor(
  cursor: string,
): AgentAttentionCursorValue {
  if (
    typeof cursor !== "string" ||
    !cursor.startsWith(`${ATTENTION_CURSOR_PREFIX}.`)
  ) {
    throw attentionInvalidRequest("The Attention cursor is invalid.");
  }
  const encoded = cursor.slice(ATTENTION_CURSOR_PREFIX.length + 1);
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        base64UrlToBytes(encoded),
      ),
    );
  } catch (cause) {
    if (cause instanceof AgentAttentionStoreError) throw cause;
    throw attentionInvalidRequest("The Attention cursor is invalid.");
  }
  const parsed = record(value);
  if (
    !parsed ||
    Object.keys(parsed).sort().join(",") !== "notificationId,occurredAt"
  ) {
    throw attentionInvalidRequest("The Attention cursor is invalid.");
  }
  const occurredAt = validIso(parsed.occurredAt);
  const notificationId = parsed.notificationId;
  if (
    !occurredAt ||
    typeof notificationId !== "string" ||
    !UUID.test(notificationId)
  ) {
    throw attentionInvalidRequest("The Attention cursor is invalid.");
  }
  return {
    occurredAt,
    notificationId: notificationId.toLowerCase(),
  };
}

function validIso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function finiteConfidence(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
    ? Number(value)
    : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = redactOperatorProjectionText(value).trim();
  return normalized ? normalized.slice(0, max) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeParameter(
  parameters: Record<string, unknown>,
  key: string,
): string | null {
  const value = parameters[key];
  return typeof value === "string" &&
      SAFE_IDENTIFIER.test(value) &&
      isOperatorProjectionIdentifierSecretFree(value)
    ? value
    : null;
}

function attentionDestination(
  slug: string,
  notificationId: string,
): LaunchNavigationTarget {
  return {
    href: `/agents/${encodeURIComponent(slug)}?pane=alerts&item=${
      encodeURIComponent(notificationId)
    }`,
    pane: "alerts",
    itemId: notificationId,
  };
}

function briefAction(
  brief: AgentAttentionBriefRow,
  agent: AgentAttentionReadInput["agent"],
): LaunchAgentAttentionAction | null {
  if (
    brief.status !== "ready" ||
    !brief.action_key ||
    !BRIEF_ACTION_KEYS.has(brief.action_key as LaunchAgentAttentionActionKey)
  ) {
    return null;
  }
  const key = brief.action_key as LaunchAgentAttentionActionKey;
  const rawParameters = record(brief.action_parameters) || {};
  const agentId = safeParameter(rawParameters, "agentId");
  if (agentId !== agent.id) return null;
  let label: string;
  let destination: LaunchNavigationTarget;
  let parameters: Record<string, string> = {};

  if (key === "open_access_setting") {
    const settingKey = safeParameter(rawParameters, "settingKey");
    parameters = settingKey ? { agentId, settingKey } : { agentId };
    label = settingKey ? "Add credential" : "Review access";
    destination = {
      href: `/agents/${encodeURIComponent(agent.slug)}?pane=access${
        settingKey ? `&item=${encodeURIComponent(`setting:${settingKey}`)}` : ""
      }`,
      pane: "access",
      itemId: settingKey ? `setting:${settingKey}` : null,
    };
  } else if (key === "open_release_review") {
    const releaseId = safeParameter(rawParameters, "releaseId");
    parameters = releaseId ? { agentId, releaseId } : { agentId };
    label = "Review release";
    destination = {
      href: `/agents/${
        encodeURIComponent(agent.slug)
      }?pane=settings&item=release${
        releaseId ? `:${encodeURIComponent(releaseId)}` : ""
      }`,
      pane: "settings",
      itemId: releaseId ? `release:${releaseId}` : "release",
    };
  } else if (key === "open_routine") {
    const routineId = safeParameter(rawParameters, "routineId");
    if (!routineId) return null;
    parameters = { agentId, routineId };
    label = "Open routine";
    destination = {
      href: `/agents/${encodeURIComponent(agent.slug)}?pane=routines&item=${
        encodeURIComponent(routineId)
      }`,
      pane: "routines",
      itemId: routineId,
    };
  } else if (key === "approve_grant") {
    const grantId = safeParameter(rawParameters, "grantId");
    if (!grantId) return null;
    parameters = { agentId, grantId };
    label = "Review access";
    destination = {
      href: `/agents/${encodeURIComponent(agent.slug)}?pane=access&item=${
        encodeURIComponent(`grant:${grantId}`)
      }`,
      pane: "access",
      itemId: `grant:${grantId}`,
    };
  } else {
    parameters = { agentId };
    label = "Resume Agent";
    destination = {
      href: `/agents/${encodeURIComponent(agent.slug)}?pane=overview`,
      pane: "overview",
      itemId: null,
    };
  }

  return {
    id: `brief:${brief.notification_id}:${String(brief.revision)}:${key}`,
    key,
    label,
    emphasis: key === "resume_agent" || key === "open_access_setting"
      ? "primary"
      : "secondary",
    parameters,
    destination,
  };
}

function briefEvidence(
  value: unknown,
  slug: string,
  notificationId: string,
): LaunchAgentEvidenceReference[] {
  if (!Array.isArray(value)) return [];
  const result: LaunchAgentEvidenceReference[] = [];
  for (const entry of value.slice(0, 10)) {
    const item = record(entry);
    if (!item) continue;
    const kind = item.kind;
    if (
      kind !== "routine" && kind !== "run" && kind !== "schedule" &&
      kind !== "notification" && kind !== "setting" &&
      kind !== "authority" && kind !== "release" && kind !== "compute"
    ) continue;
    const sourceId = boundedText(item.sourceId, 240);
    const label = boundedText(item.label, 240);
    if (!sourceId || !label) continue;
    // Stored evidence may identify canonical records, but its navigation is
    // rebuilt server-side. Arbitrary persisted/model URLs never reach clients.
    result.push({
      kind,
      sourceId,
      label,
      observedAt: validIso(item.observedAt),
      destination: kind === "notification"
        ? attentionDestination(slug, notificationId)
        : null,
    });
  }
  return result;
}

function lifecycleFor(
  row: AgentAttentionNotificationRow,
): LaunchAgentAttentionLifecycle | null {
  const stateChangedAt = validIso(row.state_changed_at);
  if (!stateChangedAt) return null;
  const readAt = validIso(row.read_at);
  if (row.item_class === "report") {
    if (row.lifecycle_state !== "open" && row.lifecycle_state !== "archived") {
      return null;
    }
    return {
      state: row.lifecycle_state,
      readAt,
      stateChangedAt,
      snoozedUntil: null,
      resolvedAt: null,
      resolutionReason: null,
      archivedAt: row.lifecycle_state === "archived"
        ? validIso(row.archived_at)
        : null,
    };
  }
  if (
    row.lifecycle_state !== "open" &&
    row.lifecycle_state !== "snoozed" &&
    row.lifecycle_state !== "resolved"
  ) return null;
  return {
    state: row.lifecycle_state,
    readAt,
    stateChangedAt,
    snoozedUntil: row.lifecycle_state === "snoozed"
      ? validIso(row.snoozed_until)
      : null,
    resolvedAt: row.lifecycle_state === "resolved"
      ? validIso(row.resolved_at)
      : null,
    resolutionReason: row.lifecycle_state === "resolved"
      ? boundedText(row.resolution_reason, 500)
      : null,
    archivedAt: null,
  };
}

function isCurrentlyAttention(
  row: AgentAttentionNotificationRow,
  now: Date,
): boolean {
  if (row.item_class === "report") {
    return row.lifecycle_state === "open" && row.read_at === null;
  }
  if (row.lifecycle_state === "open") return true;
  return row.lifecycle_state === "snoozed" &&
    Boolean(row.snoozed_until) &&
    Date.parse(row.snoozed_until!) <= now.getTime();
}

export function buildAgentAttentionProjection(
  input: AgentAttentionReadInput,
): LaunchAgentAttentionProjection {
  const now = input.now ?? new Date();
  const currentBriefs = new Map<string, AgentAttentionBriefRow>();
  for (const brief of input.briefs || []) {
    const existing = currentBriefs.get(brief.notification_id);
    const revision = Number(brief.revision);
    const existingRevision = existing ? Number(existing.revision) : -1;
    if (Number.isSafeInteger(revision) && revision >= existingRevision) {
      currentBriefs.set(brief.notification_id, brief);
    }
  }

  const rows = input.notifications
    .filter((row) =>
      row.agent_id === input.agent.id &&
      row.user_id.length > 0 &&
      UUID.test(row.id) &&
      validIso(row.created_at) &&
      isCurrentlyAttention(row, now)
    )
    .sort((left, right) =>
      Date.parse(right.created_at) - Date.parse(left.created_at) ||
      left.id.localeCompare(right.id)
    )
    .slice(0, MAX_ATTENTION_ROWS);
  const items: LaunchAgentAttentionItem[] = [];
  for (const row of rows) {
    const lifecycle = lifecycleFor(row);
    if (!lifecycle) continue;
    const safeTitle = boundedText(row.title, 500) ?? "Agent notification";
    const safeBody = boundedText(row.body, 2_000);
    const safeKind = boundedText(row.kind, 120);
    const brief = currentBriefs.get(row.id);
    const ready = brief?.status === "ready" &&
      Boolean(boundedText(brief.headline, 240));
    const action = brief ? briefAction(brief, input.agent) : null;
    const evidence = ready && brief
      ? briefEvidence(brief.evidence, input.agent.slug, row.id)
      : [];
    if (evidence.length === 0) {
      evidence.push({
        kind: "notification",
        sourceId: row.id,
        label: safeTitle,
        observedAt: row.created_at,
        destination: attentionDestination(input.agent.slug, row.id),
      });
    }
    const base = {
      id: `attention:${row.id}`,
      notificationId: row.id,
      agentId: input.agent.id,
      severity: row.severity,
      lifecycle,
      brief: {
        headline: ready && brief
          ? boundedText(brief.headline, 240)!
          : safeTitle,
        impact: ready && brief ? boundedText(brief.impact, 2000) : safeBody,
        context: null,
        recommendedNextMove: ready && brief
          ? boundedText(brief.recommended_action, 1000)
          : null,
        requiresDecision: row.item_class === "incident",
        confidence: ready && brief ? finiteConfidence(brief.confidence) : null,
        evidence,
      },
      actions: action ? [action] : [],
      occurredAt: row.created_at,
      enrichment: {
        status: !brief || brief.status === "disabled"
          ? "raw" as const
          : brief.status,
        version: brief ? String(brief.revision) : null,
        generatedAt: ready && brief ? validIso(brief.generated_at) : null,
      },
      raw: {
        kind: safeKind ?? "notification",
        title: safeTitle,
        body: safeBody,
      },
    };
    if (row.item_class === "report") {
      items.push({
        ...base,
        type: "report" as const,
        requiresAction: false as const,
        lifecycle: lifecycle as Extract<
          LaunchAgentAttentionLifecycle,
          { state: "open" | "archived" }
        >,
      });
      continue;
    }
    items.push({
      ...base,
      type: "incident" as const,
      requiresAction: true as const,
      lifecycle: lifecycle as Extract<
        LaunchAgentAttentionLifecycle,
        { state: "open" | "snoozed" | "resolved" }
      >,
      incidentCode: safeKind,
    });
  }

  return {
    items,
    openCount: items.length,
    requiresDecisionCount:
      items.filter((item) =>
        item.type === "incident" && item.brief.requiresDecision
      ).length,
    available: true,
    unavailableReason: null,
  };
}

const BRIEF_COLUMNS = [
  "id",
  "notification_id",
  "revision",
  "source_hash",
  "status",
  "provider",
  "model",
  "headline",
  "impact",
  "recommended_action",
  "evidence",
  "confidence",
  "action_key",
  "action_parameters",
  "generated_at",
].join(",");

async function responseRows<T>(
  response: Response,
  message: string,
): Promise<T[]> {
  if (!response.ok) {
    throw new AgentAttentionStoreError(
      message,
      "ATTENTION_READ_FAILED",
      response.status >= 500 ? 503 : 500,
    );
  }
  const value = await response.json().catch(() => []);
  return Array.isArray(value) ? value as T[] : [];
}

function snapshotCount(value: number | string, message: string): number {
  const count = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
    ? Number(value)
    : NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new AgentAttentionStoreError(
      message,
      "ATTENTION_READ_FAILED",
      503,
    );
  }
  return count;
}

function snapshotNextCursor(
  occurredAtValue: unknown,
  notificationIdValue: unknown,
): string | null {
  if (occurredAtValue === null && notificationIdValue === null) return null;
  const occurredAt = validIso(occurredAtValue);
  if (
    !occurredAt ||
    typeof notificationIdValue !== "string" ||
    !UUID.test(notificationIdValue)
  ) {
    throw new AgentAttentionStoreError(
      "Attention pagination is temporarily unavailable.",
      "ATTENTION_READ_FAILED",
      503,
    );
  }
  return formatAgentAttentionCursor({
    occurredAt,
    notificationId: notificationIdValue,
  });
}

function ownerAgentCounts(
  value: unknown,
  agents: readonly AgentAttentionReadInput["agent"][],
  expectedOpenCount: number,
  expectedDecisionCount: number,
): LaunchGlobalAttentionAgentCount[] {
  if (!Array.isArray(value)) {
    throw new AgentAttentionStoreError(
      "Account Attention counts are temporarily unavailable.",
      "ATTENTION_READ_FAILED",
      503,
    );
  }
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const seen = new Set<string>();
  const result: LaunchGlobalAttentionAgentCount[] = [];
  for (const raw of value) {
    const item = record(raw);
    if (!item) {
      throw new AgentAttentionStoreError(
        "Account Attention counts are inconsistent.",
        "ATTENTION_READ_FAILED",
        503,
      );
    }
    const agentId = item?.agent_id;
    if (
      typeof agentId !== "string" ||
      seen.has(agentId) ||
      !agentsById.has(agentId)
    ) {
      throw new AgentAttentionStoreError(
        "Account Attention counts are inconsistent.",
        "ATTENTION_READ_FAILED",
        503,
      );
    }
    const openCount = snapshotCount(
      item.open_count as number | string,
      "Account Attention counts are temporarily unavailable.",
    );
    const requiresDecisionCount = snapshotCount(
      item.requires_decision_count as number | string,
      "Account decision counts are temporarily unavailable.",
    );
    if (
      openCount < 1 ||
      requiresDecisionCount > openCount
    ) {
      throw new AgentAttentionStoreError(
        "Account Attention counts are inconsistent.",
        "ATTENTION_READ_FAILED",
        503,
      );
    }
    const agent = agentsById.get(agentId)!;
    seen.add(agentId);
    result.push({
      agent: {
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
      },
      openCount,
      requiresDecisionCount,
    });
  }
  const aggregateOpenCount = result.reduce(
    (total, item) => total + item.openCount,
    0,
  );
  const aggregateDecisionCount = result.reduce(
    (total, item) => total + item.requiresDecisionCount,
    0,
  );
  if (
    aggregateOpenCount !== expectedOpenCount ||
    aggregateDecisionCount !== expectedDecisionCount
  ) {
    throw new AgentAttentionStoreError(
      "Account Attention counts are inconsistent.",
      "ATTENTION_READ_FAILED",
      503,
    );
  }
  return result;
}

export async function readAgentAttentionPage(
  userId: string,
  agent: AgentAttentionReadInput["agent"],
  options: AgentAttentionPageOptions = {},
  dependencies: AgentAttentionStoreDependencies = {},
): Promise<LaunchAgentAttentionProjection> {
  const now = dependencies.now ?? new Date();
  const limit = attentionPageLimit(options.limit);
  const cursor = options.cursor
    ? parseAgentAttentionCursor(options.cursor)
    : null;
  const client = createSupabaseRestClient({ fetchFn: dependencies.fetchFn });
  const snapshotRows = await responseRows<AgentAttentionSnapshotRow>(
    await client.rpc("get_agent_attention_page", {
      p_user_id: userId,
      p_agent_id: agent.id,
      p_now: now.toISOString(),
      p_limit: limit,
      p_before_created_at: cursor?.occurredAt ?? null,
      p_before_id: cursor?.notificationId ?? null,
    }),
    "Agent Attention is temporarily unavailable.",
  );
  const snapshot = snapshotRows[0];
  if (!snapshot || !Array.isArray(snapshot.notifications)) {
    throw new AgentAttentionStoreError(
      "Agent Attention is temporarily unavailable.",
      "ATTENTION_READ_FAILED",
      503,
    );
  }
  const notifications = snapshot
    .notifications as AgentAttentionNotificationRow[];
  const ids = notifications.map((row) => row.id).filter((id) => UUID.test(id));
  const briefs = ids.length === 0
    ? []
    : await responseRows<AgentAttentionBriefRow>(
      await client.request(
        `/rest/v1/notification_briefs?user_id=eq.${
          encodeURIComponent(userId)
        }&notification_id=in.(${
          ids.map((id) => encodeURIComponent(id)).join(",")
        })&superseded_at=is.null&select=${BRIEF_COLUMNS}`,
      ),
      "Agent Attention enrichment is temporarily unavailable.",
    ).catch(() => []);
  const projection = buildAgentAttentionProjection({
    agent,
    notifications,
    briefs,
    now,
  });
  const openCount = snapshotCount(
    snapshot.open_count,
    "Agent Attention count is temporarily unavailable.",
  );
  const requiresDecisionCount = snapshotCount(
    snapshot.requires_decision_count,
    "Agent decision count is temporarily unavailable.",
  );
  if (requiresDecisionCount > openCount) {
    throw new AgentAttentionStoreError(
      "Agent Attention counts are inconsistent.",
      "ATTENTION_READ_FAILED",
      503,
    );
  }
  return {
    ...projection,
    openCount,
    requiresDecisionCount,
    nextCursor: snapshotNextCursor(
      snapshot.next_before_created_at,
      snapshot.next_before_id,
    ),
  };
}

export function readAgentAttention(
  userId: string,
  agent: AgentAttentionReadInput["agent"],
  dependencies: AgentAttentionStoreDependencies = {},
): Promise<LaunchAgentAttentionProjection> {
  return readAgentAttentionPage(userId, agent, {}, dependencies);
}

export async function readOwnerAttentionPage(
  userId: string,
  agents: readonly AgentAttentionReadInput["agent"][],
  options: AgentAttentionPageOptions = {},
  dependencies: AgentAttentionStoreDependencies = {},
): Promise<LaunchGlobalAttentionResponse> {
  const now = dependencies.now ?? new Date();
  const limit = attentionPageLimit(options.limit);
  const cursor = options.cursor
    ? parseAgentAttentionCursor(options.cursor)
    : null;
  const uniqueAgentIds = [
    ...new Set(agents.map((agent) => agent.id).filter((id) => UUID.test(id))),
  ];
  if (uniqueAgentIds.length === 0) {
    return {
      entries: [],
      agentCounts: [],
      openCount: 0,
      requiresDecisionCount: 0,
      nextCursor: null,
      available: true,
      unavailableReason: null,
      generatedAt: now.toISOString(),
    };
  }
  const client = createSupabaseRestClient({ fetchFn: dependencies.fetchFn });
  const snapshotRows = await responseRows<OwnerAttentionSnapshotRow>(
    await client.rpc("get_owner_attention_page", {
      p_user_id: userId,
      p_now: now.toISOString(),
      p_limit: limit,
      p_before_created_at: cursor?.occurredAt ?? null,
      p_before_id: cursor?.notificationId ?? null,
    }),
    "Account Attention is temporarily unavailable.",
  );
  const snapshot = snapshotRows[0];
  if (!snapshot || !Array.isArray(snapshot.notifications)) {
    throw new AgentAttentionStoreError(
      "Account Attention is temporarily unavailable.",
      "ATTENTION_READ_FAILED",
      503,
    );
  }
  const notifications = snapshot
    .notifications as AgentAttentionNotificationRow[];
  const openCount = snapshotCount(
    snapshot.open_count,
    "Account Attention count is temporarily unavailable.",
  );
  const requiresDecisionCount = snapshotCount(
    snapshot.requires_decision_count,
    "Account decision count is temporarily unavailable.",
  );
  if (requiresDecisionCount > openCount) {
    throw new AgentAttentionStoreError(
      "Account Attention counts are inconsistent.",
      "ATTENTION_READ_FAILED",
      503,
    );
  }
  const agentCounts = ownerAgentCounts(
    snapshot.per_agent_counts,
    agents,
    openCount,
    requiresDecisionCount,
  );
  const ids = notifications.map((row) => row.id).filter((id) => UUID.test(id));
  const briefs = ids.length === 0
    ? []
    : await responseRows<AgentAttentionBriefRow>(
      await client.request(
        `/rest/v1/notification_briefs?user_id=eq.${
          encodeURIComponent(userId)
        }&notification_id=in.(${
          ids.map((id) => encodeURIComponent(id)).join(",")
        })&superseded_at=is.null&select=${BRIEF_COLUMNS}`,
      ),
      "Account Attention enrichment is temporarily unavailable.",
    ).catch(() => []);

  const notificationsByAgent = new Map<
    string,
    AgentAttentionNotificationRow[]
  >();
  for (const row of notifications) {
    if (!row || typeof row.agent_id !== "string") continue;
    const rows = notificationsByAgent.get(row.agent_id) || [];
    rows.push(row);
    notificationsByAgent.set(row.agent_id, rows);
  }

  const entries = agents.flatMap((agent) =>
    buildAgentAttentionProjection({
      agent,
      notifications: notificationsByAgent.get(agent.id) || [],
      briefs,
      now,
    }).items.map((item) => ({ agent, item }))
  ).sort((left, right) =>
    Date.parse(right.item.occurredAt) - Date.parse(left.item.occurredAt) ||
    left.item.id.localeCompare(right.item.id)
  );

  return {
    entries,
    agentCounts,
    openCount,
    requiresDecisionCount,
    nextCursor: snapshotNextCursor(
      snapshot.next_before_created_at,
      snapshot.next_before_id,
    ),
    available: true,
    unavailableReason: null,
    generatedAt: now.toISOString(),
  };
}

export function readOwnerAttention(
  userId: string,
  agents: readonly AgentAttentionReadInput["agent"][],
  dependencies: AgentAttentionStoreDependencies = {},
): Promise<LaunchGlobalAttentionResponse> {
  return readOwnerAttentionPage(userId, agents, {}, dependencies);
}

function validateTransitionRequest(
  request: LaunchAgentAttentionActionRequest,
  now: Date,
): void {
  if (
    !request ||
    ![
      "read",
      "archive",
      "snooze",
      "resolve",
      "reopen",
      "execute_brief",
    ].includes(request.action) ||
    typeof request.idempotencyKey !== "string" ||
    request.idempotencyKey.length < 8 ||
    request.idempotencyKey.length > 200
  ) {
    throw new AgentAttentionStoreError(
      "The Attention action is invalid.",
      "ATTENTION_INVALID_REQUEST",
      400,
    );
  }
  if (
    request.action === "snooze" &&
    (!validIso(request.snoozedUntil) ||
      Date.parse(request.snoozedUntil!) <= now.getTime())
  ) {
    throw new AgentAttentionStoreError(
      "snoozedUntil must be a future timestamp.",
      "ATTENTION_INVALID_REQUEST",
      400,
    );
  }
  if (
    request.action === "execute_brief" &&
    (!request.actionId || request.actionId.length > 500)
  ) {
    throw new AgentAttentionStoreError(
      "actionId is required for an enriched action.",
      "ATTENTION_INVALID_REQUEST",
      400,
    );
  }
}

export async function transitionAgentAttention(
  userId: string,
  notificationId: string,
  request: LaunchAgentAttentionActionRequest,
  dependencies: AgentAttentionStoreDependencies = {},
): Promise<LaunchAgentAttentionLifecycle> {
  const now = dependencies.now ?? new Date();
  validateTransitionRequest(request, now);
  if (!UUID.test(notificationId)) {
    throw new AgentAttentionStoreError(
      "The notification id is invalid.",
      "ATTENTION_INVALID_REQUEST",
      400,
    );
  }
  if (request.action === "execute_brief") {
    throw new AgentAttentionStoreError(
      "Enriched actions must be resolved by the control-plane allowlist.",
      "ATTENTION_INVALID_REQUEST",
      409,
    );
  }
  const client = createSupabaseRestClient({ fetchFn: dependencies.fetchFn });
  const response = await client.rpc("transition_user_notification", {
    p_user_id: userId,
    p_notification_id: notificationId,
    p_action: request.action,
    p_snoozed_until: request.snoozedUntil || null,
    p_resolution_reason: request.resolutionReason || null,
  });
  if (!response.ok) {
    throw new AgentAttentionStoreError(
      response.status === 404
        ? "Attention item not found."
        : "The Attention action could not be completed.",
      "ATTENTION_TRANSITION_FAILED",
      response.status === 404 ? 404 : response.status >= 500 ? 503 : 409,
    );
  }
  const rows = await response.json().catch(() => []) as Array<{
    item_class: "report" | "incident";
    lifecycle_state: AgentAttentionNotificationRow["lifecycle_state"];
    read_at: string | null;
    snoozed_until: string | null;
    resolved_at: string | null;
    archived_at: string | null;
  }>;
  const row = rows[0];
  if (!row) {
    throw new AgentAttentionStoreError(
      "The Attention action returned no state.",
      "ATTENTION_TRANSITION_FAILED",
      503,
    );
  }
  const mapped = lifecycleFor({
    id: notificationId,
    user_id: userId,
    agent_id: null,
    kind: "transition",
    severity: "info",
    title: "Attention",
    body: null,
    entity_type: null,
    entity_id: null,
    action_url: null,
    item_class: row.item_class,
    requires_action: row.item_class === "incident",
    lifecycle_state: row.lifecycle_state,
    state_changed_at: now.toISOString(),
    snoozed_until: row.snoozed_until,
    resolved_at: row.resolved_at,
    resolution_reason: request.resolutionReason || null,
    archived_at: row.archived_at,
    created_at: now.toISOString(),
    read_at: row.read_at,
  });
  if (!mapped) {
    throw new AgentAttentionStoreError(
      "The Attention action returned invalid state.",
      "ATTENTION_TRANSITION_FAILED",
      503,
    );
  }
  return mapped;
}
