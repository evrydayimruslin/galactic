// Per-user notification inbox (loop-engineering Tier 2A).
//
// A general primitive, not a routine-only hack: any subsystem writes here and
// the owner reads it from one place (their connected agent via gx.notifications,
// or launch-web). The first writer is the routine executor — an owner learns
// their full-time agent auto-paused / hit a budget wall without polling the
// monitor. v1 delivery is the in-product inbox (this table); email is a v2
// fast-follow (stamped into delivered_channels).

import {
  createSupabaseRestClient,
} from "./platform-clients/supabase-rest.ts";

type NotificationSeverity = "info" | "warning" | "critical";

interface NotificationInput {
  userId: string;
  kind: string;
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

interface NotificationRow {
  id: string;
  user_id: string;
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
}

interface NotificationDeps {
  fetchFn?: typeof fetch;
}

const NOTIFICATION_COLUMNS =
  "id,user_id,kind,severity,title,body,entity_type,entity_id,action_url," +
  "delivered_channels,created_at,read_at";

// 90-day retention (hourly sweep). Matches the call-log sweep horizon.
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// Create a notification, idempotent on (user_id, dedupe_key). PostgREST
// `resolution=ignore-duplicates` makes the unique-constraint collision a no-op
// (returns the existing/none), so a re-claimed run that re-detects the same
// pause never stacks a second row. Returns the inserted row, or null when it
// was a duplicate (or on any error — this is best-effort, never blocks a wake).
export async function createNotification(
  input: NotificationInput,
  deps?: NotificationDeps,
): Promise<NotificationRow | null> {
  try {
    const supabase = createSupabaseRestClient({ fetchFn: deps?.fetchFn });
    const res = await supabase.insert(
      `/rest/v1/user_notifications?select=${NOTIFICATION_COLUMNS}`,
      {
        user_id: input.userId,
        kind: input.kind,
        severity: input.severity ?? "info",
        title: input.title,
        body: input.body ?? null,
        entity_type: input.entityType ?? null,
        entity_id: input.entityId ?? null,
        action_url: input.actionUrl ?? null,
        dedupe_key: input.dedupeKey,
      },
      "resolution=ignore-duplicates,return=representation",
    );
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
  options: { unreadOnly?: boolean; limit?: number } = {},
  deps?: NotificationDeps,
): Promise<NotificationRow[]> {
  const supabase = createSupabaseRestClient({ fetchFn: deps?.fetchFn });
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  let path = `/rest/v1/user_notifications?user_id=eq.${
    encodeURIComponent(userId)
  }&select=${NOTIFICATION_COLUMNS}&order=created_at.desc&limit=${limit}`;
  if (options.unreadOnly) path += `&read_at=is.null`;
  const res = await supabase.request(path);
  if (!res.ok) {
    throw new Error(
      `Failed to list notifications (${res.status}): ${
        await res.text().catch(() => "")
      }`,
    );
  }
  return await res.json().catch(() => []) as NotificationRow[];
}

export async function countUnread(
  userId: string,
  deps?: NotificationDeps,
): Promise<number> {
  const supabase = createSupabaseRestClient({ fetchFn: deps?.fetchFn });
  const res = await supabase.request(
    `/rest/v1/user_notifications?user_id=eq.${
      encodeURIComponent(userId)
    }&read_at=is.null&select=id`,
    { headers: { "Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0" } },
  );
  if (!res.ok) return 0;
  // PostgREST returns the total in Content-Range: "0-0/<total>".
  const range = res.headers.get("content-range") ?? "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

// Mark specific notifications read (scoped to the owner so one user can never
// touch another's rows). Returns how many rows flipped to read.
export async function markNotificationsRead(
  userId: string,
  ids: string[],
  deps?: NotificationDeps,
): Promise<number> {
  const clean = ids.filter((id) => typeof id === "string" && id.length > 0);
  if (clean.length === 0) return 0;
  const supabase = createSupabaseRestClient({ fetchFn: deps?.fetchFn });
  const res = await supabase.patch(
    `/rest/v1/user_notifications?user_id=eq.${
      encodeURIComponent(userId)
    }&id=in.(${clean.map((id) => encodeURIComponent(id)).join(",")})` +
      `&read_at=is.null&select=id`,
    { read_at: new Date().toISOString() },
    "return=representation",
  );
  if (!res.ok) {
    throw new Error(
      `Failed to mark notifications read (${res.status}): ${
        await res.text().catch(() => "")
      }`,
    );
  }
  const rows = await res.json().catch(() => []) as Array<{ id: string }>;
  return Array.isArray(rows) ? rows.length : 0;
}

// Mark all of a user's unread notifications read. Returns how many flipped.
export async function markAllNotificationsRead(
  userId: string,
  deps?: NotificationDeps,
): Promise<number> {
  const supabase = createSupabaseRestClient({ fetchFn: deps?.fetchFn });
  const res = await supabase.patch(
    `/rest/v1/user_notifications?user_id=eq.${
      encodeURIComponent(userId)
    }&read_at=is.null&select=id`,
    { read_at: new Date().toISOString() },
    "return=representation",
  );
  if (!res.ok) {
    throw new Error(
      `Failed to mark all notifications read (${res.status}): ${
        await res.text().catch(() => "")
      }`,
    );
  }
  const rows = await res.json().catch(() => []) as Array<{ id: string }>;
  return Array.isArray(rows) ? rows.length : 0;
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
    const res = await supabase.request(
      `/rest/v1/user_notifications?created_at=lt.${
        encodeURIComponent(cutoff)
      }&select=id`,
      { method: "DELETE", headers: { "Prefer": "return=representation" } },
    );
    if (!res.ok) return 0;
    const rows = await res.json().catch(() => []) as Array<{ id: string }>;
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return 0;
  }
}
