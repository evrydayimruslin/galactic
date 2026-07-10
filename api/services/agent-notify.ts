// Agent-writable owner notifications — the write half of the notification
// primitive (loop-engineering Tier 2A shipped the inbox + two executor-only
// writers; this adds the first AGENT-facing writer).
//
// Containment is structural, not policy:
//   - SELF-NOTIFICATION ONLY: the (appId, userId) identity is baked into the
//     binding props host-side — an agent writes to the inbox of the user it is
//     running FOR, never anyone else's.
//   - FIXED KIND: every agent write is kind 'agent_report'; an agent can never
//     forge a platform kind (routine_paused is the fleet's dead-man's switch).
//   - NAMESPACED DEDUPE: the host prefixes dedupe keys with the app id, so one
//     app can never collide with (or pre-claim and suppress) another app's —
//     or the platform's — notifications.
//   - RATE-CAPPED: per (user, app, UTC day), so a buggy or hostile agent
//     cannot flood the bell into uselessness. Hitting the cap is a soft
//     result, not an error — a wake must not fail because it reported a lot.

import { createNotification } from "./notifications.ts";
import { createSupabaseRestClient } from "./platform-clients/supabase-rest.ts";

const AGENT_NOTIFY_KIND = "agent_report";
// Generous for a daily digest + real anomalies; tight enough that the bell —
// the owner's only alert channel — stays readable.
export const AGENT_NOTIFY_DAILY_CAP = 20;

const TITLE_MAX = 140;
const BODY_MAX = 2000;
const DEDUPE_KEY_MAX = 120;
const SEVERITIES = new Set(["info", "warning", "critical"]);

export interface AgentNotifyInput {
  title?: unknown;
  body?: unknown;
  severity?: unknown;
  dedupe_key?: unknown;
}

export interface AgentNotifyResult {
  created: boolean;
  // 'rate_limited' = daily cap hit; 'duplicate' = same (user, dedupe_key)
  // already notified (or a best-effort write failed — never blocks a wake).
  reason?: "rate_limited" | "duplicate";
}

interface AgentNotifyDeps {
  fetchFn?: typeof fetch;
  now?: Date;
}

/**
 * Validate and deliver one agent-authored notification to the executing
 * user's inbox. Throws on malformed input (programming errors should be
 * loud); returns a soft result for cap/duplicate outcomes.
 */
export async function notifyOwnerFromAgent(
  appId: string,
  userId: string,
  input: AgentNotifyInput,
  deps: AgentNotifyDeps = {},
): Promise<AgentNotifyResult> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) {
    throw new Error("galactic.notify requires a non-empty string `title`.");
  }
  const dedupeKey = typeof input.dedupe_key === "string"
    ? input.dedupe_key.trim()
    : "";
  if (!dedupeKey) {
    throw new Error(
      "galactic.notify requires `dedupe_key` — a string identifying the EVENT " +
        '(e.g. "digest:2026-07-09") so retried runs never double-notify.',
    );
  }
  const severity = input.severity === undefined || input.severity === null
    ? "info"
    : String(input.severity);
  if (!SEVERITIES.has(severity)) {
    throw new Error(
      "galactic.notify `severity` must be one of: info, warning, critical.",
    );
  }
  const body = input.body === undefined || input.body === null
    ? null
    : String(input.body).slice(0, BODY_MAX);

  const sentToday = await countAgentReportsToday(userId, appId, deps);
  if (sentToday >= AGENT_NOTIFY_DAILY_CAP) {
    return { created: false, reason: "rate_limited" };
  }

  const row = await createNotification({
    userId,
    kind: AGENT_NOTIFY_KIND,
    severity: severity as "info" | "warning" | "critical",
    title: title.slice(0, TITLE_MAX),
    body,
    entityType: "app",
    entityId: appId,
    dedupeKey: `${AGENT_NOTIFY_KIND}:${appId}:${
      dedupeKey.slice(0, DEDUPE_KEY_MAX)
    }`,
  }, { fetchFn: deps.fetchFn });

  return row ? { created: true } : { created: false, reason: "duplicate" };
}

// Count today's (UTC) agent_report rows for this (user, app). Fails CLOSED —
// if the count is unreadable, the cap is treated as hit rather than letting
// an unmetered writer flood the bell.
async function countAgentReportsToday(
  userId: string,
  appId: string,
  deps: AgentNotifyDeps,
): Promise<number> {
  try {
    const supabase = createSupabaseRestClient({ fetchFn: deps.fetchFn });
    const now = deps.now ?? new Date();
    const dayStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    )).toISOString();
    const res = await supabase.request(
      `/rest/v1/user_notifications?user_id=eq.${
        encodeURIComponent(userId)
      }&kind=eq.${AGENT_NOTIFY_KIND}&entity_type=eq.app&entity_id=eq.${
        encodeURIComponent(appId)
      }&created_at=gte.${encodeURIComponent(dayStart)}&select=id`,
      {
        headers: {
          "Prefer": "count=exact",
          "Range-Unit": "items",
          "Range": "0-0",
        },
      },
    );
    if (!res.ok) return AGENT_NOTIFY_DAILY_CAP;
    const range = res.headers.get("content-range") ?? "";
    const total = Number(range.split("/")[1]);
    return Number.isFinite(total) ? total : AGENT_NOTIFY_DAILY_CAP;
  } catch {
    return AGENT_NOTIFY_DAILY_CAP;
  }
}
