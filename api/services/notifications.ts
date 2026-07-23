// Per-user notification inbox (loop-engineering Tier 2A).
//
// A general primitive, not a routine-only hack: any subsystem writes here and
// the owner reads it from one place (their connected agent via gx.notifications,
// or launch-web). The first writer is the routine executor — an owner learns
// their full-time agent auto-paused / hit a budget wall without polling the
// monitor. v1 delivery is the in-product inbox (this table); email is a v2
// fast-follow (stamped into delivered_channels).

import { createSupabaseRestClient } from "./platform-clients/supabase-rest.ts";

type NotificationSeverity = "info" | "warning" | "critical";
export type NotificationItemClass = "report" | "incident";
export type NotificationLifecycleState =
  | "open"
  | "snoozed"
  | "resolved"
  | "archived";

export interface NotificationInput {
  userId: string;
  // Stable Agent attribution for Fleet/Agent inbox filters. This is separate
  // from entityType/entityId, which may point at a specific routine or action.
  agentId?: string | null;
  kind: string;
  // Classification is deterministic, never inferred from title/body text.
  // The database owns the canonical kind allowlist. This legacy field remains
  // source-compatible but cannot override server classification.
  itemClass?: NotificationItemClass;
  severity?: NotificationSeverity;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  actionUrl?: string | null;
  // Idempotency key scoped to (userId, dedupeKey). Identify the EVENT (one
  // pause, one budget-reset window) so retries/re-claims don't double-notify.
  dedupeKey: string;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  action_url: string | null;
  delivered_channels: string[];
  created_at: string;
  read_at: string | null;
  item_class: NotificationItemClass;
  requires_action: boolean;
  lifecycle_state: NotificationLifecycleState;
  state_changed_at: string;
  snoozed_until: string | null;
  resolved_at: string | null;
  resolution_reason: string | null;
  archived_at: string | null;
}

interface NotificationDeps {
  fetchFn?: typeof fetch;
  now?: Date;
}

const NOTIFICATION_COLUMNS =
  "id,user_id,agent_id,kind,severity,title,body,entity_type,entity_id,action_url," +
  "delivered_channels,created_at,read_at,item_class,requires_action," +
  "lifecycle_state,state_changed_at,snoozed_until,resolved_at," +
  "resolution_reason,archived_at";

// Informational output is opt-in. Unknown kinds remain incidents so a typo or
// new operational failure cannot silently disappear after being read.
const INFORMATIONAL_REPORT_KINDS = new Set([
  "agent_report",
  "routine_report",
  "routine_summary",
]);

function attentionFilter(now: Date): string {
  // Canonical Attention is:
  //   - every open incident, even after it has been read;
  //   - a snoozed incident once its snooze expires; and
  //   - an unread open informational report.
  // Keep this predicate aligned with Fleet SQL and agent-attention.ts.
  return "or=(and(item_class.eq.incident,lifecycle_state.eq.open)," +
    "and(item_class.eq.incident,lifecycle_state.eq.snoozed,snoozed_until.lte." +
    `${encodeURIComponent(now.toISOString())}),` +
    "and(item_class.eq.report,lifecycle_state.eq.open,read_at.is.null))";
}

// 90-day retention (hourly sweep). Matches the call-log sweep horizon.
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function classifyNotificationKind(kind: string): NotificationItemClass {
  return INFORMATIONAL_REPORT_KINDS.has(kind) ? "report" : "incident";
}

// Create one immutable notification episode. The database serializes writers
// by (owner, dedupe key): an active episode makes a delivery retry a no-op,
// while recurrence after resolution creates a fresh row without rewriting
// prior evidence. Snoozed incidents remain active and idempotent. Returns the
// newly inserted row, or null for an active duplicate/error (best-effort;
// never blocks a wake).
export async function createNotification(
  input: NotificationInput,
  deps?: NotificationDeps,
): Promise<NotificationRow | null> {
  try {
    const supabase = createSupabaseRestClient({ fetchFn: deps?.fetchFn });
    const res = await supabase.rpc("create_user_notification_episode", {
      p_user_id: input.userId,
      p_agent_id: input.agentId ?? null,
      p_kind: input.kind,
      p_severity: input.severity ?? "info",
      p_title: input.title,
      p_body: input.body ?? null,
      p_entity_type: input.entityType ?? null,
      p_entity_id: input.entityId ?? null,
      p_action_url: input.actionUrl ?? null,
      p_dedupe_key: input.dedupeKey,
    });
    if (!res.ok) {
      console.error(
        "[NOTIFY] createNotification failed:",
        res.status,
        await res.text().catch(() => ""),
      );
      return null;
    }
    const rows = await res.json().catch(() => []) as NotificationRow[];
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch (err) {
    console.error("[NOTIFY] createNotification threw:", err);
    return null;
  }
}

export async function listNotifications(
  userId: string,
  options: { unreadOnly?: boolean; limit?: number; agentId?: string } = {},
  deps?: NotificationDeps,
): Promise<NotificationRow[]> {
  const supabase = createSupabaseRestClient({ fetchFn: deps?.fetchFn });
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  let path = `/rest/v1/user_notifications?user_id=eq.${
    encodeURIComponent(userId)
  }&select=${NOTIFICATION_COLUMNS}&order=created_at.desc&limit=${limit}`;
  // Keep the historical `unreadOnly` option name for API compatibility. Its
  // operator meaning is now canonical Attention: every open incident remains
  // visible after it is read, while informational reports leave Attention
  // once read.
  if (options.unreadOnly) {
    path += `&${attentionFilter(deps?.now ?? new Date())}`;
  }
  if (options.agentId) {
    path += `&agent_id=eq.${encodeURIComponent(options.agentId)}`;
  }
  const res = await supabase.request(path);
  if (!res.ok) {
    throw new Error(
      `Failed to list notifications (${res.status}): ${await res.text().catch(
        () => "",
      )}`,
    );
  }
  return await res.json().catch(() => []) as NotificationRow[];
}

export async function countAttention(
  userId: string,
  optionsOrDeps: { agentId?: string } | NotificationDeps = {},
  deps?: NotificationDeps,
): Promise<number> {
  // Keep the pre-Agent-filter `(userId, deps)` call shape working while the
  // launch API adopts `(userId, options, deps)`.
  const legacyDeps = "fetchFn" in optionsOrDeps || "now" in optionsOrDeps;
  const options: { agentId?: string } = legacyDeps
    ? {}
    : optionsOrDeps as { agentId?: string };
  const resolvedDeps = legacyDeps ? optionsOrDeps as NotificationDeps : deps;
  const supabase = createSupabaseRestClient({ fetchFn: resolvedDeps?.fetchFn });
  const res = await supabase.request(
    `/rest/v1/user_notifications?user_id=eq.${encodeURIComponent(userId)}&${
      attentionFilter(resolvedDeps?.now ?? new Date())
    }${
      options.agentId
        ? `&agent_id=eq.${encodeURIComponent(options.agentId)}`
        : ""
    }&select=id`,
    {
      headers: {
        "Prefer": "count=exact",
        "Range-Unit": "items",
        "Range": "0-0",
      },
    },
  );
  if (!res.ok) return 0;
  // PostgREST returns the total in Content-Range: "0-0/<total>".
  const range = res.headers.get("content-range") ?? "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

// Backward-compatible name used by the existing launch and gx.notifications
// response shape (`unread_count`). The value is the canonical Attention count:
// open incidents plus unread open reports.
export const countUnread = countAttention;

// Mark specific notifications read (scoped to the owner so one user can never
// touch another's rows). Returns how many rows flipped to read.
export async function markNotificationsRead(
  userId: string,
  ids: string[],
  optionsOrDeps: { agentId?: string } | NotificationDeps = {},
  deps?: NotificationDeps,
): Promise<number> {
  // Preserve the historical `(userId, ids, deps)` call shape while allowing
  // the Agent-filtered browser pane to keep selected-id writes inside the
  // exact same Agent boundary as its read.
  const legacyDeps = "fetchFn" in optionsOrDeps || "now" in optionsOrDeps;
  const options: { agentId?: string } = legacyDeps
    ? {}
    : optionsOrDeps as { agentId?: string };
  const resolvedDeps = legacyDeps ? optionsOrDeps as NotificationDeps : deps;
  const clean = ids.filter((id) => typeof id === "string" && id.length > 0);
  if (clean.length === 0) return 0;
  const supabase = createSupabaseRestClient({ fetchFn: resolvedDeps?.fetchFn });
  const res = await supabase.patch(
    `/rest/v1/user_notifications?user_id=eq.${encodeURIComponent(userId)}${
      options.agentId
        ? `&agent_id=eq.${encodeURIComponent(options.agentId)}`
        : ""
    }&id=in.(${clean.map((id) => encodeURIComponent(id)).join(",")})` +
      `&read_at=is.null&select=id`,
    { read_at: new Date().toISOString() },
    "return=representation",
  );
  if (!res.ok) {
    throw new Error(
      `Failed to mark notifications read (${res.status}): ${await res.text()
        .catch(() => "")}`,
    );
  }
  const rows = await res.json().catch(() => []) as Array<{ id: string }>;
  return Array.isArray(rows) ? rows.length : 0;
}

// Mark all of a user's unread notifications read. Returns how many flipped.
export async function markAllNotificationsRead(
  userId: string,
  optionsOrDeps: { agentId?: string } | NotificationDeps = {},
  deps?: NotificationDeps,
): Promise<number> {
  // Backward compatible with the former `(userId, deps)` signature.
  const legacyDeps = "fetchFn" in optionsOrDeps || "now" in optionsOrDeps;
  const options: { agentId?: string } = legacyDeps
    ? {}
    : optionsOrDeps as { agentId?: string };
  const resolvedDeps = legacyDeps ? optionsOrDeps as NotificationDeps : deps;
  const supabase = createSupabaseRestClient({ fetchFn: resolvedDeps?.fetchFn });
  const res = await supabase.patch(
    `/rest/v1/user_notifications?user_id=eq.${
      encodeURIComponent(userId)
    }&read_at=is.null${
      options.agentId
        ? `&agent_id=eq.${encodeURIComponent(options.agentId)}`
        : ""
    }&select=id`,
    { read_at: new Date().toISOString() },
    "return=representation",
  );
  if (!res.ok) {
    throw new Error(
      `Failed to mark all notifications read (${res.status}): ${await res.text()
        .catch(() => "")}`,
    );
  }
  const rows = await res.json().catch(() => []) as Array<{ id: string }>;
  return Array.isArray(rows) ? rows.length : 0;
}

// Recovery paths call this with the exact dedupe key that opened an incident.
// The database owns the lifecycle transition and scopes it to the supplied
// owner; read_at is intentionally untouched.
export async function resolveNotificationIncidentByDedupe(
  userId: string,
  dedupeKey: string,
  resolutionReason: string,
  deps: NotificationDeps = {},
): Promise<number> {
  const normalizedDedupeKey = dedupeKey.trim();
  const normalizedReason = resolutionReason.trim();
  if (!userId || !normalizedDedupeKey || !normalizedReason) {
    throw new Error(
      "Resolving a notification incident requires owner, dedupe key, and reason.",
    );
  }

  const supabase = createSupabaseRestClient({ fetchFn: deps.fetchFn });
  const res = await supabase.rpc("resolve_notification_incident_by_dedupe", {
    p_user_id: userId,
    p_dedupe_key: normalizedDedupeKey,
    p_resolution_reason: normalizedReason.slice(0, 500),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to resolve notification incident (${res.status}).`,
    );
  }
  const value = await res.json().catch(() => 0);
  const count = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

// Delete notifications older than the retention horizon. Called from the hourly
// cron; best-effort (returns 0 on failure). Uses the provided clock so tests
// (and resume) are deterministic — never argless new Date() in a code path a
// workflow might replay.
export async function sweepExpiredNotifications(
  now: Date = new Date(),
  deps?: NotificationDeps,
): Promise<number> {
  try {
    const supabase = createSupabaseRestClient({ fetchFn: deps?.fetchFn });
    const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
    // An unresolved incident is durable evidence even after the owner reads it.
    // Past the horizon we may delete terminal incidents, or informational
    // reports that are archived/read/non-critical. A malformed filter 400s and
    // becomes a no-op rather than risking an over-broad delete.
    const res = await supabase.request(
      `/rest/v1/user_notifications?created_at=lt.${
        encodeURIComponent(cutoff)
      }&or=(and(item_class.eq.incident,lifecycle_state.eq.resolved),` +
        `and(item_class.eq.report,or(lifecycle_state.eq.archived,` +
        `read_at.not.is.null,severity.neq.critical)))&select=id`,
      { method: "DELETE", headers: { "Prefer": "return=representation" } },
    );
    if (!res.ok) return 0;
    const rows = await res.json().catch(() => []) as Array<{ id: string }>;
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return 0;
  }
}
