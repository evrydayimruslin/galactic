import { getEnv } from "../lib/env.ts";
import {
  LAUNCH_FLEET_SHORTCUT_ACTIONS,
  LAUNCH_FLEET_SHORTCUT_DEFAULTS,
} from "../../shared/contracts/launch.ts";
import type {
  LaunchAgentActivityItem,
  LaunchAgentActivityKind,
  LaunchAgentActivityPhase,
  LaunchAgentActivityPreview,
  LaunchAgentCapacityResponse,
  LaunchAgentEvidenceKind,
  LaunchAgentEvidenceReference,
  LaunchAgentOperatingState,
  LaunchAgentOperatingSummary,
  LaunchAgentPreferences,
  LaunchAgentWorkingExclusionReason,
  LaunchAgentWorkingReadiness,
  LaunchFleetActivity,
  LaunchFleetAgentHealth,
  LaunchFleetAgentState,
  LaunchFleetOrderResponse,
  LaunchFleetPreferences,
  LaunchFleetShortcutAction,
  LaunchFleetShortcutMap,
  LaunchNavigationTarget,
} from "../../shared/contracts/launch.ts";

const AGENT_REVISION_PREFIX = "agent-preference-v1";
const FLEET_REVISION_PREFIX = "fleet-preference-v1";
const ACTIVITY_CURSOR_PREFIX = "agent-activity-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_PANES = new Set([
  "overview",
  "interfaces",
  "alerts",
  "routines",
  "functions",
  "compute",
  "access",
  "settings",
]);

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export type AgentOperatorStoreErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_REVISION"
  | "REVISION_CONFLICT"
  | "NOT_FOUND"
  | "SERVICE_UNAVAILABLE";

export class AgentOperatorStoreError extends Error {
  readonly code: AgentOperatorStoreErrorCode;
  readonly status: number;
  readonly currentRevision: string | null;
  readonly expectedRevision: string | null;

  constructor(options: {
    code: AgentOperatorStoreErrorCode;
    status: number;
    message: string;
    currentRevision?: string | null;
    expectedRevision?: string | null;
  }) {
    super(options.message);
    this.name = "AgentOperatorStoreError";
    this.code = options.code;
    this.status = options.status;
    this.currentRevision = options.currentRevision ?? null;
    this.expectedRevision = options.expectedRevision ?? null;
  }
}

export interface AgentOperatorStoreDependencies {
  fetchFn?: typeof fetch;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  clock?: () => Date;
}

export interface AgentFleetPreferencesSnapshot
  extends LaunchFleetOrderResponse {
  shortcutsEnabled: boolean;
  shortcutMap: LaunchFleetShortcutMap;
}

export interface AgentInterfaceFavoritesInitialization {
  preferences: LaunchAgentPreferences;
  initializedNow: boolean;
}

export interface AgentOperatorFleetProjection {
  agentId: string;
  state: LaunchFleetAgentState;
  health: LaunchFleetAgentHealth;
  routineCount: number;
  activeRoutineCount: number;
  nextWakeAt: string | null;
  lastRunAt: string | null;
  deferredWakeCount: number;
  unreadAlertCount: number;
  recentActivity: LaunchFleetActivity[];
  capacity: LaunchAgentCapacityResponse | null;
  workingReadiness: LaunchAgentWorkingReadiness;
  attentionCount: number;
  fleetPosition: number;
  operatingSummary: LaunchAgentOperatingSummary;
}

export interface AgentOperatorFleetSnapshot {
  agents: AgentOperatorFleetProjection[];
  workingAgentCount: number;
  generatedAt: string;
}

export interface AgentActivityCursorValue {
  eventAt: string;
  itemKey: string;
}

export interface AgentActivityPage {
  activity: LaunchAgentActivityPreview;
  nextCursor: string | null;
}

export interface GetAgentActivityPageOptions {
  userId: string;
  agentId: string;
  recentLimit?: number;
  cursor?: string | null;
}

interface DatabaseConfig {
  baseUrl: string;
  serviceRoleKey: string;
  fetchFn: typeof fetch;
  now: () => Date;
}

interface ErrorContext {
  revisionKind?: "agent" | "fleet";
  revisionSubject?: string;
  expectedRevision?: string | null;
}

interface FleetRpcRow {
  agent_id?: unknown;
  routine_count?: unknown;
  active_routine_count?: unknown;
  state?: unknown;
  health?: unknown;
  next_wake_at?: unknown;
  last_run_at?: unknown;
  deferred_wake_count?: unknown;
  unread_alert_count?: unknown;
  recent_activity?: unknown;
  capacity_state?: unknown;
  capacity_burst_state?: unknown;
  capacity_weekly_state?: unknown;
  capacity_burst_resets_at?: unknown;
  capacity_weekly_resets_at?: unknown;
  capacity_next_eligible_at?: unknown;
  capacity_cap_basis_points?: unknown;
  capacity_burst_used_percent?: unknown;
  capacity_weekly_used_percent?: unknown;
  working_ready?: unknown;
  working_exclusion_reason?: unknown;
  attention_count?: unknown;
  fleet_position?: unknown;
  operating_summary?: unknown;
  working_agent_count?: unknown;
}

interface MappedActivityRow {
  item: LaunchAgentActivityItem;
  cursor: AgentActivityCursorValue;
}

function error(
  code: AgentOperatorStoreErrorCode,
  message: string,
  options: {
    currentRevision?: string | null;
    expectedRevision?: string | null;
  } = {},
): AgentOperatorStoreError {
  const status = code === "INVALID_REQUEST" || code === "INVALID_REVISION"
    ? 400
    : code === "REVISION_CONFLICT"
    ? 412
    : code === "NOT_FOUND"
    ? 404
    : 503;
  return new AgentOperatorStoreError({
    code,
    status,
    message,
    ...options,
  });
}

function requireUuid(value: string, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw error("INVALID_REQUEST", `${label} is invalid.`);
  }
  return value.toLowerCase();
}

function normalizeRevision(value: unknown): string {
  let raw: string;
  if (typeof value === "bigint") raw = value.toString();
  else if (typeof value === "string") raw = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) {
    raw = String(value);
  } else {
    throw error("SERVICE_UNAVAILABLE", "Operator preference data is invalid.");
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw error("SERVICE_UNAVAILABLE", "Operator preference data is invalid.");
  }
  return BigInt(raw).toString();
}

function revisionToken(
  prefix: string,
  subject: string,
  revision: string | number | bigint,
): string {
  const normalized = normalizeRevision(revision);
  return `${prefix}:${encodeURIComponent(subject)}:${normalized}`;
}

function parseRevisionToken(
  token: string,
  prefix: string,
  expectedSubject: string,
): string {
  if (typeof token !== "string") {
    throw error("INVALID_REVISION", "The preference revision is invalid.");
  }
  const parts = token.split(":");
  if (parts.length !== 3 || parts[0] !== prefix) {
    throw error("INVALID_REVISION", "The preference revision is invalid.");
  }
  let subject: string;
  try {
    subject = decodeURIComponent(parts[1]);
  } catch {
    throw error("INVALID_REVISION", "The preference revision is invalid.");
  }
  if (subject !== expectedSubject || !/^[1-9][0-9]*$/.test(parts[2])) {
    throw error("INVALID_REVISION", "The preference revision is invalid.");
  }
  return BigInt(parts[2]).toString();
}

/** Opaque, Agent-bound concurrency token. */
export function formatAgentPreferenceRevision(
  agentId: string,
  revision: string | number | bigint,
): string {
  return revisionToken(
    AGENT_REVISION_PREFIX,
    requireUuid(agentId, "Agent id"),
    revision,
  );
}

/** Returns the lossless decimal revision expected by the database RPC. */
export function parseAgentPreferenceRevision(
  token: string,
  expectedAgentId: string,
): string {
  return parseRevisionToken(
    token,
    AGENT_REVISION_PREFIX,
    requireUuid(expectedAgentId, "Agent id"),
  );
}

/** Opaque, owner-bound concurrency token. */
export function formatFleetPreferenceRevision(
  userId: string,
  revision: string | number | bigint,
): string {
  return revisionToken(
    FLEET_REVISION_PREFIX,
    requireUuid(userId, "User id"),
    revision,
  );
}

/** Returns the lossless decimal revision expected by the database RPC. */
export function parseFleetPreferenceRevision(
  token: string,
  expectedUserId: string,
): string {
  return parseRevisionToken(
    token,
    FLEET_REVISION_PREFIX,
    requireUuid(expectedUserId, "User id"),
  );
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw error("INVALID_REQUEST", "The activity cursor is invalid.");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  try {
    return Uint8Array.from(
      atob(base64),
      (character) => character.charCodeAt(0),
    );
  } catch {
    throw error("INVALID_REQUEST", "The activity cursor is invalid.");
  }
}

export function formatAgentActivityCursor(
  value: AgentActivityCursorValue,
): string {
  const eventAt = requireTimestamp(value.eventAt, "activity cursor timestamp");
  const itemKey = requireBoundedString(
    value.itemKey,
    "activity cursor key",
    240,
  );
  const payload = JSON.stringify({ eventAt, itemKey });
  return `${ACTIVITY_CURSOR_PREFIX}.${
    bytesToBase64Url(
      new TextEncoder().encode(payload),
    )
  }`;
}

export function parseAgentActivityCursor(
  cursor: string,
): AgentActivityCursorValue {
  if (
    typeof cursor !== "string" ||
    !cursor.startsWith(`${ACTIVITY_CURSOR_PREFIX}.`)
  ) {
    throw error("INVALID_REQUEST", "The activity cursor is invalid.");
  }
  const encoded = cursor.slice(ACTIVITY_CURSOR_PREFIX.length + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        base64UrlToBytes(encoded),
      ),
    );
  } catch (cause) {
    if (cause instanceof AgentOperatorStoreError) throw cause;
    throw error("INVALID_REQUEST", "The activity cursor is invalid.");
  }
  const record = asRecord(parsed);
  if (
    !record || Object.keys(record).sort().join(",") !== "eventAt,itemKey"
  ) {
    throw error("INVALID_REQUEST", "The activity cursor is invalid.");
  }
  return {
    eventAt: requireTimestamp(
      record.eventAt,
      "activity cursor timestamp",
      "INVALID_REQUEST",
    ),
    itemKey: requireBoundedString(
      record.itemKey,
      "activity cursor key",
      240,
      "INVALID_REQUEST",
    ),
  };
}

function databaseConfig(
  dependencies: AgentOperatorStoreDependencies,
): DatabaseConfig {
  const baseUrl = (dependencies.supabaseUrl ?? getEnv("SUPABASE_URL")).replace(
    /\/+$/,
    "",
  );
  const serviceRoleKey = dependencies.serviceRoleKey ??
    getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !serviceRoleKey) {
    throw error(
      "SERVICE_UNAVAILABLE",
      "Agent operator persistence is not configured.",
    );
  }
  return {
    baseUrl,
    serviceRoleKey,
    fetchFn: dependencies.fetchFn ?? fetch,
    now: dependencies.clock ?? (() => new Date()),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function responsePayload(text: string): unknown {
  if (!text) return null;
  // PostgREST serializes PostgreSQL bigint values as JSON numbers. Protect
  // known revision fields before JSON.parse so a valid future revision cannot
  // silently lose precision in JavaScript.
  const lossless = text.replace(
    /("(?:new_)?revision"|"currentRevision"|"expectedRevision"|"current_revision"|"expected_revision")(\s*:\s*)([1-9][0-9]*)(?=\s*[,}\]])/g,
    '$1$2"$3"',
  );
  return JSON.parse(lossless);
}

function databaseErrorDetail(payload: unknown): {
  message: string;
  detail: Record<string, unknown> | null;
} {
  const record = asRecord(payload);
  const message = typeof record?.message === "string" ? record.message : "";
  const rawDetail = record?.details ?? record?.detail;
  if (typeof rawDetail === "string") {
    try {
      return { message, detail: asRecord(responsePayload(rawDetail)) };
    } catch {
      return { message, detail: null };
    }
  }
  return { message, detail: asRecord(rawDetail) };
}

function conflictRevision(
  detail: Record<string, unknown> | null,
  context: ErrorContext,
): string | null {
  if (!detail || !context.revisionKind || !context.revisionSubject) return null;
  try {
    const raw = detail.currentRevision ?? detail.current_revision;
    return context.revisionKind === "agent"
      ? formatAgentPreferenceRevision(context.revisionSubject, raw as string)
      : formatFleetPreferenceRevision(context.revisionSubject, raw as string);
  } catch {
    return null;
  }
}

function mapDatabaseError(
  status: number,
  payload: unknown,
  context: ErrorContext,
): AgentOperatorStoreError {
  const { message, detail } = databaseErrorDetail(payload);
  if (
    message === "agent_preference_revision_conflict" ||
    message === "fleet_preference_revision_conflict"
  ) {
    return error(
      "REVISION_CONFLICT",
      "These operator preferences changed after the page loaded. Refresh before retrying.",
      {
        currentRevision: conflictRevision(detail, context),
        expectedRevision: context.expectedRevision ?? null,
      },
    );
  }
  if (message === "agent_not_found") {
    return error("NOT_FOUND", "The Agent was not found.");
  }
  if (
    message.startsWith("invalid_") ||
    message === "duplicate_interface_favorite_id" ||
    message === "fleet_preference_agent_set_mismatch"
  ) {
    return error(
      "INVALID_REQUEST",
      "The operator preference request is invalid.",
    );
  }
  return error(
    "SERVICE_UNAVAILABLE",
    `Agent operator persistence is unavailable (${status}).`,
  );
}

async function databaseRequest(
  config: DatabaseConfig,
  path: string,
  init: RequestInit,
  context: ErrorContext = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await config.fetchFn(`${config.baseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        ...init.headers,
      },
    });
  } catch {
    throw error(
      "SERVICE_UNAVAILABLE",
      "Agent operator persistence is unavailable.",
    );
  }
  const text = await response.text().catch(() => "");
  let payload: unknown = null;
  try {
    payload = responsePayload(text);
  } catch {
    if (response.ok) {
      throw error(
        "SERVICE_UNAVAILABLE",
        "Agent operator persistence returned invalid data.",
      );
    }
  }
  if (!response.ok) throw mapDatabaseError(response.status, payload, context);
  return payload;
}

function callRpc(
  config: DatabaseConfig,
  rpc: string,
  body: Record<string, unknown>,
  context: ErrorContext = {},
): Promise<unknown> {
  return databaseRequest(config, `rpc/${rpc}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, context);
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !asRecord(item))) {
    throw error(
      "SERVICE_UNAVAILABLE",
      "Agent operator persistence returned invalid data.",
    );
  }
  return value as Record<string, unknown>[];
}

function firstRow(value: unknown): Record<string, unknown> {
  const candidate = Array.isArray(value) ? value[0] : value;
  const row = asRecord(candidate);
  if (!row) {
    throw error(
      "SERVICE_UNAVAILABLE",
      "Agent operator persistence returned no result.",
    );
  }
  return row;
}

function requireBoundedString(
  value: unknown,
  label: string,
  maximum: number,
  code: AgentOperatorStoreErrorCode = "SERVICE_UNAVAILABLE",
): string {
  if (
    typeof value !== "string" || value.length < 1 ||
    value.length > maximum || containsControlCharacter(value)
  ) {
    throw error(code, `${label} is invalid.`);
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  maximum: number,
): string | null {
  if (value === null || value === undefined) return null;
  return requireBoundedString(value, "Operator projection text", maximum);
}

function requireTimestamp(
  value: unknown,
  label: string,
  code: AgentOperatorStoreErrorCode = "SERVICE_UNAVAILABLE",
): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw error(code, `${label} is invalid.`);
  }
  return value;
}

function optionalTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return requireTimestamp(value, "Operator projection timestamp");
}

function nonnegativeInteger(value: unknown, label: string): number {
  const raw = typeof value === "string" && /^[0-9]+$/.test(value)
    ? Number(value)
    : value;
  if (
    typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0
  ) {
    throw error("SERVICE_UNAVAILABLE", `${label} is invalid.`);
  }
  return raw;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw error("SERVICE_UNAVAILABLE", `${label} is invalid.`);
  }
  return value;
}

function favoriteIds(value: unknown): string[] {
  if (
    !Array.isArray(value) || value.length > 100 ||
    value.some((item) =>
      typeof item !== "string" || item.length < 1 || item.length > 160 ||
      containsControlCharacter(item)
    ) || new Set(value).size !== value.length
  ) {
    throw error(
      "SERVICE_UNAVAILABLE",
      "Agent Interface favorites are invalid.",
    );
  }
  return [...value] as string[];
}

function validateFavoriteRequest(value: readonly string[]): string[] {
  if (
    !Array.isArray(value) || value.length > 100 ||
    value.some((item) =>
      typeof item !== "string" || item.length < 1 || item.length > 160 ||
      containsControlCharacter(item)
    ) || new Set(value).size !== value.length
  ) {
    throw error(
      "INVALID_REQUEST",
      "Agent Interface favorites are invalid.",
    );
  }
  return [...value];
}

function preferenceFromRow(
  agentId: string,
  preference: Record<string, unknown> | null,
  favorites: string[],
): LaunchAgentPreferences {
  return {
    agentId,
    favoriteInterfaceIds: favorites,
    favoritesInitialized: preference?.favorites_initialized_at != null,
    favoritesExplicit: preference?.favorites_explicit === true,
    revision: formatAgentPreferenceRevision(
      agentId,
      normalizeRevision(preference?.revision ?? "1"),
    ),
    updatedAt: optionalTimestamp(preference?.updated_at),
  };
}

export async function getAgentInterfaceFavorites(
  userIdInput: string,
  agentIdInput: string,
  dependencies: AgentOperatorStoreDependencies = {},
): Promise<LaunchAgentPreferences> {
  const userId = requireUuid(userIdInput, "User id");
  const agentId = requireUuid(agentIdInput, "Agent id");
  const config = databaseConfig(dependencies);
  const snapshot = firstRow(
    await callRpc(
      config,
      "get_user_agent_interface_favorites_snapshot",
      {
        p_user_id: userId,
        p_agent_id: agentId,
      },
    ),
  );
  return preferenceFromRow(
    agentId,
    snapshot,
    favoriteIds(snapshot.favorite_interface_ids),
  );
}

export async function initializeAgentInterfaceFavorites(
  userIdInput: string,
  agentIdInput: string,
  manifestInterfaceIds: readonly string[],
  dependencies: AgentOperatorStoreDependencies = {},
): Promise<AgentInterfaceFavoritesInitialization> {
  const userId = requireUuid(userIdInput, "User id");
  const agentId = requireUuid(agentIdInput, "Agent id");
  const ids = validateFavoriteRequest(manifestInterfaceIds);
  // No stable Interface exists to select. Preserve "not initialized", allowing
  // a later release with its first stable Interface to receive onboarding.
  if (ids.length === 0) {
    return {
      preferences: await getAgentInterfaceFavorites(
        userId,
        agentId,
        dependencies,
      ),
      initializedNow: false,
    };
  }
  const config = databaseConfig(dependencies);
  const row = firstRow(
    await callRpc(
      config,
      "initialize_user_agent_interface_favorites",
      {
        p_user_id: userId,
        p_agent_id: agentId,
        p_manifest_interface_ids: ids,
      },
    ),
  );
  const initializedAt = optionalTimestamp(row.initialized_at);
  const initializedNow = requireBoolean(
    row.initialized_now,
    "Interface favorite initialization result",
  );
  return {
    preferences: {
      agentId,
      favoriteInterfaceIds: favoriteIds(row.favorite_interface_ids),
      favoritesInitialized: initializedAt !== null,
      favoritesExplicit: requireBoolean(
        row.explicit_choice,
        "Interface favorite explicit-choice result",
      ),
      revision: formatAgentPreferenceRevision(agentId, row.revision as string),
      updatedAt: initializedAt,
    },
    initializedNow,
  };
}

export async function replaceAgentInterfaceFavorites(
  userIdInput: string,
  agentIdInput: string,
  interfaceIds: readonly string[],
  expectedRevision: string,
  dependencies: AgentOperatorStoreDependencies = {},
): Promise<LaunchAgentPreferences> {
  const userId = requireUuid(userIdInput, "User id");
  const agentId = requireUuid(agentIdInput, "Agent id");
  const ids = validateFavoriteRequest(interfaceIds);
  const decimalRevision = parseAgentPreferenceRevision(
    expectedRevision,
    agentId,
  );
  const config = databaseConfig(dependencies);
  const row = firstRow(
    await callRpc(
      config,
      "replace_user_agent_interface_favorites",
      {
        p_user_id: userId,
        p_agent_id: agentId,
        p_interface_ids: ids,
        p_expected_revision: decimalRevision,
      },
      {
        revisionKind: "agent",
        revisionSubject: agentId,
        expectedRevision,
      },
    ),
  );
  const initializedAt = optionalTimestamp(row.initialized_at);
  if (!initializedAt) {
    throw error(
      "SERVICE_UNAVAILABLE",
      "Agent Interface favorite initialization is invalid.",
    );
  }
  return {
    agentId,
    favoriteInterfaceIds: favoriteIds(row.favorite_interface_ids),
    favoritesInitialized: true,
    favoritesExplicit: true,
    revision: formatAgentPreferenceRevision(
      agentId,
      row.new_revision as string,
    ),
    updatedAt: initializedAt,
  };
}

const SHORTCUT_ACTIONS = new Set<string>(LAUNCH_FLEET_SHORTCUT_ACTIONS);

function canonicalShortcutKey(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value !== value.trim()) return undefined;
  if (value === "Escape") return value;
  if (
    Array.from(value).length !== 1 ||
    value === "+" ||
    /\s/u.test(value) ||
    containsControlCharacter(value)
  ) {
    return undefined;
  }
  return /^[A-Z]$/.test(value) ? value.toLowerCase() : value;
}

function shortcutMap(
  value: unknown,
  failureCode: "INVALID_REQUEST" | "SERVICE_UNAVAILABLE" =
    "SERVICE_UNAVAILABLE",
): LaunchFleetShortcutMap {
  const record = asRecord(value);
  if (!record) {
    throw error(
      failureCode,
      failureCode === "INVALID_REQUEST"
        ? "Fleet shortcuts must be an object."
        : "Fleet shortcut data is invalid.",
    );
  }
  if (
    Object.keys(record).length > LAUNCH_FLEET_SHORTCUT_ACTIONS.length ||
    new TextEncoder().encode(JSON.stringify(record)).byteLength > 4_096
  ) {
    throw error(failureCode, "Fleet shortcut data is invalid.");
  }
  const mapped: LaunchFleetShortcutMap = {};
  const suppliedKeys = new Set<string>();
  for (const [key, shortcut] of Object.entries(record)) {
    const canonical = canonicalShortcutKey(shortcut);
    if (
      !SHORTCUT_ACTIONS.has(key) ||
      canonical === undefined ||
      (typeof canonical === "string" && suppliedKeys.has(canonical))
    ) {
      throw error(failureCode, "Fleet shortcut data is invalid.");
    }
    if (typeof canonical === "string") suppliedKeys.add(canonical);
    mapped[key as LaunchFleetShortcutAction] = canonical;
  }
  const effective = new Map<string, LaunchFleetShortcutAction>();
  for (const action of LAUNCH_FLEET_SHORTCUT_ACTIONS) {
    const binding = Object.hasOwn(mapped, action)
      ? mapped[action]
      : LAUNCH_FLEET_SHORTCUT_DEFAULTS[action];
    if (binding === null || binding === undefined) continue;
    if (effective.has(binding)) {
      throw error(
        failureCode,
        failureCode === "INVALID_REQUEST"
          ? "Fleet shortcut keys must be unique after applying defaults."
          : "Fleet shortcut data is invalid.",
      );
    }
    effective.set(binding, action);
  }
  return mapped;
}

export async function getFleetPreferences(
  userIdInput: string,
  dependencies: AgentOperatorStoreDependencies = {},
): Promise<AgentFleetPreferencesSnapshot> {
  const userId = requireUuid(userIdInput, "User id");
  const config = databaseConfig(dependencies);
  const fleet = firstRow(
    await callRpc(
      config,
      "get_user_fleet_preferences_snapshot",
      { p_user_id: userId },
    ),
  );
  const orderedAgentIds = fleet.ordered_agent_ids;
  const orderedFleetPositions = fleet.ordered_fleet_positions;
  if (
    !Array.isArray(orderedAgentIds) ||
    !Array.isArray(orderedFleetPositions) ||
    orderedFleetPositions.length !== orderedAgentIds.length ||
    orderedAgentIds.length > 1000 ||
    orderedFleetPositions.some((position, index) =>
      typeof position !== "number" || !Number.isSafeInteger(position) ||
      position !== index
    )
  ) {
    throw error("SERVICE_UNAVAILABLE", "Fleet ordering is invalid.");
  }
  const positions = orderedAgentIds.map((agentId, fleetPosition) => ({
    agentId: requireUuid(String(agentId), "Agent id"),
    fleetPosition: orderedFleetPositions[fleetPosition] as number,
  }));
  if (
    new Set(positions.map((position) => position.agentId)).size !==
      positions.length
  ) {
    throw error("SERVICE_UNAVAILABLE", "Fleet ordering is invalid.");
  }
  return {
    revision: formatFleetPreferenceRevision(
      userId,
      normalizeRevision(fleet.revision),
    ),
    positions,
    updatedAt: optionalTimestamp(fleet.updated_at) ??
      config.now().toISOString(),
    shortcutsEnabled: requireBoolean(
      fleet.shortcuts_enabled,
      "Fleet shortcut setting",
    ),
    shortcutMap: shortcutMap(fleet.shortcut_map),
  };
}

export async function replaceFleetOrder(
  userIdInput: string,
  agentIdsInput: readonly string[],
  expectedRevision: string,
  dependencies: AgentOperatorStoreDependencies = {},
): Promise<LaunchFleetOrderResponse> {
  const userId = requireUuid(userIdInput, "User id");
  if (
    !Array.isArray(agentIdsInput) || agentIdsInput.length > 1000 ||
    new Set(agentIdsInput).size !== agentIdsInput.length
  ) {
    throw error("INVALID_REQUEST", "The Fleet order is invalid.");
  }
  const agentIds = agentIdsInput.map((id) => requireUuid(id, "Agent id"));
  if (new Set(agentIds).size !== agentIds.length) {
    throw error("INVALID_REQUEST", "The Fleet order is invalid.");
  }
  const decimalRevision = parseFleetPreferenceRevision(
    expectedRevision,
    userId,
  );
  const config = databaseConfig(dependencies);
  const row = firstRow(
    await callRpc(
      config,
      "replace_user_fleet_order",
      {
        p_user_id: userId,
        p_agent_ids: agentIds,
        p_expected_revision: decimalRevision,
      },
      {
        revisionKind: "fleet",
        revisionSubject: userId,
        expectedRevision,
      },
    ),
  );
  if (
    !Array.isArray(row.ordered_agent_ids) ||
    row.ordered_agent_ids.length !== agentIds.length
  ) {
    throw error("SERVICE_UNAVAILABLE", "Fleet ordering is invalid.");
  }
  const ordered = row.ordered_agent_ids.map((id) =>
    requireUuid(String(id), "Agent id")
  );
  if (new Set(ordered).size !== ordered.length) {
    throw error("SERVICE_UNAVAILABLE", "Fleet ordering is invalid.");
  }
  return {
    revision: formatFleetPreferenceRevision(
      userId,
      row.new_revision as string,
    ),
    positions: ordered.map((agentId, fleetPosition) => ({
      agentId,
      fleetPosition,
    })),
    updatedAt: config.now().toISOString(),
  };
}

export async function replaceFleetShortcuts(
  userIdInput: string,
  shortcutsEnabledInput: boolean,
  shortcutMapInput: LaunchFleetShortcutMap,
  expectedRevision: string,
  dependencies: AgentOperatorStoreDependencies = {},
): Promise<LaunchFleetPreferences> {
  const userId = requireUuid(userIdInput, "User id");
  if (typeof shortcutsEnabledInput !== "boolean") {
    throw error(
      "INVALID_REQUEST",
      "Fleet shortcuts enabled must be a boolean.",
    );
  }
  const shortcuts = shortcutMap(shortcutMapInput, "INVALID_REQUEST");
  const decimalRevision = parseFleetPreferenceRevision(
    expectedRevision,
    userId,
  );
  const config = databaseConfig(dependencies);
  const row = firstRow(
    await callRpc(
      config,
      "replace_user_fleet_shortcuts",
      {
        p_user_id: userId,
        p_shortcuts_enabled: shortcutsEnabledInput,
        p_shortcut_map: shortcuts,
        p_expected_revision: decimalRevision,
      },
      {
        revisionKind: "fleet",
        revisionSubject: userId,
        expectedRevision,
      },
    ),
  );
  return {
    revision: formatFleetPreferenceRevision(
      userId,
      row.new_revision as string,
    ),
    shortcutsEnabled: requireBoolean(
      row.shortcuts_enabled,
      "Fleet shortcut setting",
    ),
    shortcutMap: shortcutMap(row.shortcut_map),
    updatedAt: config.now().toISOString(),
  };
}

function fleetState(value: unknown): LaunchFleetAgentState {
  if (
    value === "active" || value === "paused" || value === "error" ||
    value === "idle" || value === "unconfigured"
  ) return value;
  throw error("SERVICE_UNAVAILABLE", "Fleet state is invalid.");
}

function fleetHealth(value: unknown): LaunchFleetAgentHealth {
  if (
    value === "healthy" || value === "waiting" || value === "paused" ||
    value === "error" || value === "idle"
  ) return value;
  throw error("SERVICE_UNAVAILABLE", "Fleet health is invalid.");
}

function exclusionReason(
  value: unknown,
): LaunchAgentWorkingExclusionReason | null {
  if (value === null) return null;
  if (
    value === "no_live_release" || value === "no_enabled_routine" ||
    value === "setup_required" || value === "error" || value === "paused" ||
    value === "disabled"
  ) return value;
  throw error("SERVICE_UNAVAILABLE", "Agent readiness is invalid.");
}

function operatingMode(value: unknown): LaunchAgentOperatingState {
  if (
    value === "no_live_release" || value === "no_enabled_routine" ||
    value === "setup_required" || value === "error" || value === "running" ||
    value === "queued" || value === "capacity_waiting" ||
    value === "scheduled" || value === "event_waiting" ||
    value === "standing_by" || value === "paused" || value === "disabled"
  ) return value;
  throw error("SERVICE_UNAVAILABLE", "Agent operating state is invalid.");
}

function operatingBasis(
  value: unknown,
): LaunchAgentOperatingSummary["basis"] {
  if (
    value === "readiness" || value === "routine_run" ||
    value === "capacity" || value === "next_wake" ||
    value === "subscription" || value === "routine"
  ) return value;
  throw error("SERVICE_UNAVAILABLE", "Agent operating basis is invalid.");
}

function operatingEvidence(
  agentId: string,
  summary: Record<string, unknown>,
): LaunchAgentEvidenceReference[] {
  const destination: LaunchNavigationTarget | null = summary.routineId
    ? {
      href: `?pane=routines&item=${
        encodeURIComponent(String(summary.routineId))
      }`,
      agentId,
      pane: "routines",
      itemId: String(summary.routineId),
    }
    : null;
  if (typeof summary.runId === "string") {
    return [{
      kind: "run",
      sourceId: requireUuid(summary.runId, "Run id"),
      label: optionalBoundedString(summary.routineName, 512) ?? "Agent run",
      observedAt: optionalTimestamp(summary.lastObservedAt),
      destination,
    }];
  }
  if (typeof summary.routineId === "string") {
    const routineId = requireUuid(summary.routineId, "Routine id");
    const evidence: LaunchAgentEvidenceReference[] = [{
      kind: "routine",
      sourceId: routineId,
      label: optionalBoundedString(summary.routineName, 512) ?? "Agent routine",
      observedAt: optionalTimestamp(summary.lastObservedAt),
      destination,
    }];
    if (summary.nextEventAt != null) {
      evidence.push({
        kind: "schedule",
        sourceId: `${routineId}:${
          requireTimestamp(
            summary.nextEventAt,
            "Next event timestamp",
          )
        }`,
        label: "Next scheduled wake",
        observedAt: requireTimestamp(
          summary.nextEventAt,
          "Next event timestamp",
        ),
        destination,
      });
    }
    return evidence;
  }
  return [];
}

function mapOperatingSummary(
  agentId: string,
  row: FleetRpcRow,
  now: Date,
): {
  readiness: LaunchAgentWorkingReadiness;
  summary: LaunchAgentOperatingSummary;
} {
  const totalRoutineCount = nonnegativeInteger(
    row.routine_count,
    "Routine count",
  );
  const activeRoutineCount = nonnegativeInteger(
    row.active_routine_count,
    "Active routine count",
  );
  if (activeRoutineCount > totalRoutineCount) {
    throw error("SERVICE_UNAVAILABLE", "Agent readiness is invalid.");
  }
  const working = requireBoolean(row.working_ready, "Agent working state");
  const reason = exclusionReason(row.working_exclusion_reason);
  if (working !== (reason === null)) {
    throw error("SERVICE_UNAVAILABLE", "Agent readiness is inconsistent.");
  }
  const readiness: LaunchAgentWorkingReadiness = {
    working,
    ready: working,
    exclusionReason: reason,
    activeRoutineCount,
    totalRoutineCount,
  };
  const rawSummary = asRecord(row.operating_summary);
  if (!rawSummary) {
    throw error("SERVICE_UNAVAILABLE", "Agent operating summary is invalid.");
  }
  const mode = operatingMode(rawSummary.mode);
  if (reason !== null && mode !== reason) {
    throw error(
      "SERVICE_UNAVAILABLE",
      "Agent operating summary is inconsistent.",
    );
  }
  const routineId = rawSummary.routineId == null
    ? null
    : requireUuid(String(rawSummary.routineId), "Routine id");
  const runId = rawSummary.runId == null
    ? null
    : requireUuid(String(rawSummary.runId), "Run id");
  return {
    readiness,
    summary: {
      mode,
      state: mode,
      label: requireBoundedString(
        rawSummary.label,
        "Agent operating label",
        512,
      ),
      detail: optionalBoundedString(rawSummary.detail, 2_000),
      basis: operatingBasis(rawSummary.basis),
      routineId,
      routineName: optionalBoundedString(rawSummary.routineName, 512),
      runId,
      nextEventAt: optionalTimestamp(rawSummary.nextEventAt),
      lastObservedAt: optionalTimestamp(rawSummary.lastObservedAt),
      readiness,
      evidence: operatingEvidence(agentId, rawSummary),
      derivedAt: now.toISOString(),
    },
  };
}

function mapFleetActivity(value: unknown): LaunchFleetActivity[] {
  if (!Array.isArray(value) || value.length > 3) {
    throw error("SERVICE_UNAVAILABLE", "Fleet activity is invalid.");
  }
  return value.map((entry) => {
    const row = asRecord(entry);
    if (!row || (row.kind !== "run" && row.kind !== "alert")) {
      throw error("SERVICE_UNAVAILABLE", "Fleet activity is invalid.");
    }
    return {
      id: requireBoundedString(row.id, "Fleet activity id", 240),
      kind: row.kind,
      title: requireBoundedString(row.title, "Fleet activity title", 512),
      summary: optionalBoundedString(row.summary, 4_000),
      status: requireBoundedString(row.status, "Fleet activity status", 120),
      routineId: row.routineId == null
        ? null
        : requireUuid(String(row.routineId), "Routine id"),
      createdAt: requireTimestamp(
        row.createdAt,
        "Fleet activity timestamp",
      ),
    };
  });
}

function capacityState(
  value: unknown,
): LaunchAgentCapacityResponse["state"] {
  if (value === "available" || value === "low" || value === "waiting") {
    return value;
  }
  throw error("SERVICE_UNAVAILABLE", "Agent capacity state is invalid.");
}

function optionalPercentage(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
    ? Number(value)
    : NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw error("SERVICE_UNAVAILABLE", `${label} is invalid.`);
  }
  return parsed;
}

function mapFleetCapacity(
  agentId: string,
  row: FleetRpcRow,
  generatedAt: string,
): LaunchAgentCapacityResponse | null {
  const fields = [
    row.capacity_state,
    row.capacity_burst_state,
    row.capacity_weekly_state,
    row.capacity_burst_resets_at,
    row.capacity_weekly_resets_at,
  ];
  if (fields.every((value) => value == null)) return null;
  if (fields.some((value) => value == null)) {
    throw error(
      "SERVICE_UNAVAILABLE",
      "Agent capacity projection is incomplete.",
    );
  }
  const basisPoints = row.capacity_cap_basis_points == null
    ? null
    : nonnegativeInteger(
      row.capacity_cap_basis_points,
      "Agent capacity cap",
    );
  if (basisPoints !== null && (basisPoints < 1 || basisPoints > 10_000)) {
    throw error("SERVICE_UNAVAILABLE", "Agent capacity cap is invalid.");
  }
  const capPercent = basisPoints === null ? null : basisPoints / 100;
  const window = (
    state: LaunchAgentCapacityResponse["state"],
    resetsAt: string,
    rawShareUsedPercent: unknown,
    label: string,
  ): LaunchAgentCapacityResponse["burst"] => {
    const shareUsedPercent = optionalPercentage(rawShareUsedPercent, label);
    return {
      state,
      resetsAt,
      ...(capPercent !== null && shareUsedPercent !== null
        ? {
          shareUsedPercent,
          capUsedPercent: Math.min(
            100,
            shareUsedPercent / capPercent * 100,
          ),
        }
        : {}),
    };
  };
  return {
    agentId,
    capPercent,
    state: capacityState(row.capacity_state),
    burst: window(
      capacityState(row.capacity_burst_state),
      requireTimestamp(
        row.capacity_burst_resets_at,
        "Agent burst reset timestamp",
      ),
      row.capacity_burst_used_percent,
      "Agent burst usage",
    ),
    weekly: window(
      capacityState(row.capacity_weekly_state),
      requireTimestamp(
        row.capacity_weekly_resets_at,
        "Agent weekly reset timestamp",
      ),
      row.capacity_weekly_used_percent,
      "Agent weekly usage",
    ),
    nextEligibleAt: optionalTimestamp(row.capacity_next_eligible_at),
    blocker: null,
    generatedAt,
  };
}

export function mapAgentOperatorFleetRows(
  payload: unknown,
  now: Date,
): AgentOperatorFleetSnapshot {
  const input = rows(payload) as FleetRpcRow[];
  let workingAgentCount: number | null = input.length === 0 ? 0 : null;
  const agents = input.map((row, index): AgentOperatorFleetProjection => {
    const agentId = requireUuid(String(row.agent_id), "Agent id");
    const fleetPosition = nonnegativeInteger(
      row.fleet_position,
      "Fleet position",
    );
    if (fleetPosition !== index) {
      throw error("SERVICE_UNAVAILABLE", "Fleet ordering is invalid.");
    }
    const rowWorkingCount = nonnegativeInteger(
      row.working_agent_count,
      "Working Agent count",
    );
    if (
      workingAgentCount !== null && workingAgentCount !== rowWorkingCount
    ) {
      throw error(
        "SERVICE_UNAVAILABLE",
        "Working Agent count is inconsistent.",
      );
    }
    workingAgentCount = rowWorkingCount;
    const { readiness, summary } = mapOperatingSummary(agentId, row, now);
    return {
      agentId,
      state: fleetState(row.state),
      health: fleetHealth(row.health),
      routineCount: readiness.totalRoutineCount,
      activeRoutineCount: readiness.activeRoutineCount,
      nextWakeAt: optionalTimestamp(row.next_wake_at),
      lastRunAt: optionalTimestamp(row.last_run_at),
      deferredWakeCount: nonnegativeInteger(
        row.deferred_wake_count,
        "Deferred wake count",
      ),
      unreadAlertCount: nonnegativeInteger(
        row.unread_alert_count,
        "Unread Alert count",
      ),
      recentActivity: mapFleetActivity(row.recent_activity),
      capacity: mapFleetCapacity(agentId, row, now.toISOString()),
      workingReadiness: readiness,
      attentionCount: nonnegativeInteger(
        row.attention_count,
        "Attention count",
      ),
      fleetPosition,
      operatingSummary: summary,
    };
  });
  const observedWorkingCount =
    agents.filter((agent) => agent.workingReadiness.working).length;
  if (workingAgentCount !== observedWorkingCount) {
    throw error("SERVICE_UNAVAILABLE", "Working Agent count is inconsistent.");
  }
  return {
    agents,
    workingAgentCount,
    generatedAt: now.toISOString(),
  };
}

export async function getAgentOperatorFleetSnapshot(
  userIdInput: string,
  dependencies: AgentOperatorStoreDependencies = {},
): Promise<AgentOperatorFleetSnapshot> {
  const userId = requireUuid(userIdInput, "User id");
  const config = databaseConfig(dependencies);
  const payload = await callRpc(config, "get_launch_fleet_snapshot", {
    p_user_id: userId,
    p_include_operator_fields: true,
  });
  return mapAgentOperatorFleetRows(payload, config.now());
}

function activityKind(value: unknown): LaunchAgentActivityKind {
  if (
    value === "scheduled_run" || value === "routine_run" ||
    value === "agent_event" || value === "compute_run" || value === "release"
  ) return value;
  // The SQL separates notification lifecycle class; the public activity
  // contract deliberately exposes both reports and incidents as attention.
  if (value === "attention" || value === "incident" || value === "report") {
    return "attention";
  }
  throw error("SERVICE_UNAVAILABLE", "Agent activity kind is invalid.");
}

function activityPhase(value: unknown): LaunchAgentActivityPhase {
  if (value === "up_next" || value === "now" || value === "recent") {
    return value;
  }
  throw error("SERVICE_UNAVAILABLE", "Agent activity phase is invalid.");
}

function activityDestination(
  value: unknown,
  agentId: string,
): LaunchNavigationTarget | null {
  if (value === null || value === undefined) return null;
  const href = requireBoundedString(value, "Agent activity destination", 2_000);
  let url: URL;
  try {
    url = new URL(href, "https://operator.invalid");
  } catch {
    throw error(
      "SERVICE_UNAVAILABLE",
      "Agent activity destination is invalid.",
    );
  }
  if (
    url.origin !== "https://operator.invalid" ||
    !url.pathname.startsWith("/agents/") || url.hash ||
    url.username || url.password
  ) {
    throw error(
      "SERVICE_UNAVAILABLE",
      "Agent activity destination is invalid.",
    );
  }
  const paneValue = url.searchParams.get("pane");
  const pane = paneValue && AGENT_PANES.has(paneValue)
    ? paneValue as LaunchNavigationTarget["pane"]
    : null;
  if (paneValue && !pane) {
    throw error(
      "SERVICE_UNAVAILABLE",
      "Agent activity destination is invalid.",
    );
  }
  const itemId = url.searchParams.get("item");
  return {
    href: `${url.pathname}${url.search}`,
    agentId,
    pane,
    itemId,
  };
}

function evidenceKind(
  kind: LaunchAgentActivityKind,
): LaunchAgentEvidenceKind | null {
  if (kind === "scheduled_run") return "schedule";
  if (kind === "routine_run") return "run";
  if (kind === "attention") return "notification";
  if (kind === "compute_run") return "compute";
  if (kind === "release") return "release";
  return null;
}

function mapActivityRow(
  value: Record<string, unknown>,
  agentId: string,
): MappedActivityRow {
  const id = requireBoundedString(value.item_key, "Agent activity id", 240);
  const phase = activityPhase(value.phase);
  const kind = activityKind(value.kind);
  const eventAt = requireTimestamp(value.event_at, "Agent activity timestamp");
  const sourceId = requireUuid(String(value.source_id), "Activity source id");
  const routineId = value.routine_id == null
    ? null
    : requireUuid(String(value.routine_id), "Routine id");
  const destination = activityDestination(value.detail_url, agentId);
  const label = requireBoundedString(
    value.title,
    "Agent activity title",
    512,
  );
  const evidenceType = evidenceKind(kind);
  return {
    item: {
      id,
      kind,
      phase,
      title: label,
      summary: optionalBoundedString(value.summary, 4_000),
      status: requireBoundedString(
        value.status,
        "Agent activity status",
        120,
      ),
      occurredAt: phase === "up_next" ? null : eventAt,
      scheduledAt: phase === "up_next" ? eventAt : null,
      routineId,
      sourceId,
      destination,
      evidence: evidenceType
        ? [{
          kind: evidenceType,
          sourceId,
          label,
          observedAt: eventAt,
          destination,
        }]
        : [],
    },
    cursor: { eventAt, itemKey: id },
  };
}

export function mapAgentActivityRows(
  payload: unknown,
  options: {
    agentId: string;
    recentLimit: number;
    now: Date;
  },
): AgentActivityPage {
  const agentId = requireUuid(options.agentId, "Agent id");
  if (
    !Number.isInteger(options.recentLimit) || options.recentLimit < 1 ||
    options.recentLimit > 99
  ) {
    throw error("INVALID_REQUEST", "The activity page size is invalid.");
  }
  const mapped = rows(payload).map((row) => mapActivityRow(row, agentId));
  const upNextCandidates = mapped.filter((entry) =>
    entry.item.phase === "up_next"
  );
  const now = mapped.filter((entry) => entry.item.phase === "now").slice(0, 3)
    .map((entry) => entry.item);
  const recentCandidates = mapped.filter((entry) =>
    entry.item.phase === "recent"
  );
  const hasNextPage = recentCandidates.length > options.recentLimit;
  const visibleRecent = recentCandidates.slice(0, options.recentLimit);
  const upNext = upNextCandidates[0]?.item ?? null;
  const recent = visibleRecent.map((entry) => entry.item);
  const items = [...(upNext ? [upNext] : []), ...now, ...recent];
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw error("SERVICE_UNAVAILABLE", "Agent activity is inconsistent.");
  }
  return {
    activity: {
      upNext,
      now,
      recent,
      items,
      generatedAt: options.now.toISOString(),
    },
    nextCursor: hasNextPage && visibleRecent.length > 0
      ? formatAgentActivityCursor(
        visibleRecent[visibleRecent.length - 1].cursor,
      )
      : null,
  };
}

export async function getAgentActivityPage(
  options: GetAgentActivityPageOptions,
  dependencies: AgentOperatorStoreDependencies = {},
): Promise<AgentActivityPage> {
  const userId = requireUuid(options.userId, "User id");
  const agentId = requireUuid(options.agentId, "Agent id");
  const recentLimit = options.recentLimit ?? 20;
  if (
    !Number.isInteger(recentLimit) || recentLimit < 1 || recentLimit > 99
  ) {
    throw error("INVALID_REQUEST", "The activity page size is invalid.");
  }
  const cursor = options.cursor
    ? parseAgentActivityCursor(options.cursor)
    : null;
  const config = databaseConfig(dependencies);
  const payload = await callRpc(
    config,
    "get_launch_agent_activity",
    {
      p_user_id: userId,
      p_agent_id: agentId,
      p_recent_limit: recentLimit + 1,
      p_cursor_at: cursor?.eventAt ?? null,
      p_cursor_key: cursor?.itemKey ?? null,
      p_include_upcoming: cursor === null,
    },
  );
  return mapAgentActivityRows(payload, {
    agentId,
    recentLimit,
    now: config.now(),
  });
}

export function createAgentOperatorStore(
  dependencies: AgentOperatorStoreDependencies = {},
) {
  return {
    getAgentInterfaceFavorites: (userId: string, agentId: string) =>
      getAgentInterfaceFavorites(userId, agentId, dependencies),
    initializeAgentInterfaceFavorites: (
      userId: string,
      agentId: string,
      manifestInterfaceIds: readonly string[],
    ) =>
      initializeAgentInterfaceFavorites(
        userId,
        agentId,
        manifestInterfaceIds,
        dependencies,
      ),
    replaceAgentInterfaceFavorites: (
      userId: string,
      agentId: string,
      interfaceIds: readonly string[],
      expectedRevision: string,
    ) =>
      replaceAgentInterfaceFavorites(
        userId,
        agentId,
        interfaceIds,
        expectedRevision,
        dependencies,
      ),
    getFleetPreferences: (userId: string) =>
      getFleetPreferences(userId, dependencies),
    replaceFleetOrder: (
      userId: string,
      agentIds: readonly string[],
      expectedRevision: string,
    ) => replaceFleetOrder(userId, agentIds, expectedRevision, dependencies),
    replaceFleetShortcuts: (
      userId: string,
      shortcutsEnabled: boolean,
      shortcuts: LaunchFleetShortcutMap,
      expectedRevision: string,
    ) =>
      replaceFleetShortcuts(
        userId,
        shortcutsEnabled,
        shortcuts,
        expectedRevision,
        dependencies,
      ),
    getAgentOperatorFleetSnapshot: (userId: string) =>
      getAgentOperatorFleetSnapshot(userId, dependencies),
    getAgentActivityPage: (options: GetAgentActivityPageOptions) =>
      getAgentActivityPage(options, dependencies),
  };
}
