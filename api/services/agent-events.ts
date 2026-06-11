// Cross-Agent pub/sub event bus (Phase 4.5 / P5).
//
// An Agent emits a topic (ultralight.emit); the dispatcher fans the event out to
// every Agent the user wired a mode='subscribe' grant for, invoking the
// subscriber's handler. Emitting is unprivileged; RECEIVING is grant-gated.
// Delivery is async (enqueue at emit, drain via cron), billed to the user, and
// capped by the subscribe grant's monthly cap. Cascades are bounded by the
// caller-context hop ceiling. See docs/LAUNCH_PIVOT_DECISIONS.md.

import { getEnv } from "../lib/env.ts";
import {
  type AgentEvent,
  MAX_AGENT_CALL_HOP_DEPTH,
  MAX_EVENT_DELIVERY_ATTEMPTS,
  MAX_EVENT_FANOUT,
} from "../../shared/contracts/agent-grants.ts";
import { resolveSubscribeGrant, resolveSubscribers } from "./agent-grants.ts";

interface DbConfig {
  baseUrl: string;
  headers: HeadersInit;
}

function getDbConfig(): DbConfig | null {
  const baseUrl = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !key) return null;
  return {
    baseUrl,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  };
}

interface EventRow {
  id: string;
  user_id: string;
  emitter_app_id: string;
  topic: string;
  payload: Record<string, unknown> | null;
  status: string;
  attempts: number;
  emit_hop: number;
  created_at: string;
  dispatched_at: string | null;
}

const MAX_TOPIC_LENGTH = 200;
const LEASE_SECONDS = 120;
// Bound the stored payload: every event is duplicated into the delivery path
// for up to MAX_EVENT_FANOUT subscribers, so an unbounded blob is a storage +
// fan-out amplification vector.
const MAX_PAYLOAD_BYTES = 32 * 1024;

function normalizeTopic(value: unknown): string {
  const topic = typeof value === "string" ? value.trim() : "";
  if (!topic) throw new Error("topic is required");
  if (topic.length > MAX_TOPIC_LENGTH) {
    throw new Error(`topic must be ${MAX_TOPIC_LENGTH} characters or less`);
  }
  return topic;
}

function normalizePayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  if (JSON.stringify(value).length > MAX_PAYLOAD_BYTES) {
    throw new Error(`event payload must be ${MAX_PAYLOAD_BYTES} bytes or less`);
  }
  return value as Record<string, unknown>;
}

// ── Emit ─────────────────────────────────────────────────────────────────

// Enqueue an event. Identity (emitterAppId, userId, emitHop) comes from the
// VERIFIED caller-context token at the internal emit endpoint — never from
// untrusted sandbox-supplied values. Rejects an emit beyond the hop ceiling so
// a reactive cascade (handler emits → delivery → handler emits …) terminates.
export async function emitEvent(input: {
  userId: string;
  emitterAppId: string;
  topic: string;
  payload?: Record<string, unknown>;
  emitHop: number;
}): Promise<{
  eventId: string | null;
  rejected?: "hop_exceeded" | "not_configured";
}> {
  const topic = normalizeTopic(input.topic);
  const payload = normalizePayload(input.payload);
  if (input.emitHop > MAX_AGENT_CALL_HOP_DEPTH) {
    return { eventId: null, rejected: "hop_exceeded" };
  }
  const db = getDbConfig();
  // A dropped emit must NOT report success — surface it so the caller's `ok`
  // reflects that nothing was enqueued.
  if (!db) return { eventId: null, rejected: "not_configured" };

  const response = await fetch(`${db.baseUrl}/rest/v1/agent_events`, {
    method: "POST",
    headers: { ...db.headers, Prefer: "return=representation" },
    body: JSON.stringify([{
      user_id: input.userId,
      emitter_app_id: input.emitterAppId,
      topic,
      payload,
      status: "pending",
      emit_hop: Math.max(1, Math.floor(input.emitHop)),
    }]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail ? `Failed to enqueue event: ${detail}` : "Failed to enqueue event");
  }
  const rows = await response.json().catch(() => []);
  return { eventId: Array.isArray(rows) && rows[0]?.id ? rows[0].id : null };
}

function mapEvent(row: EventRow): AgentEvent {
  return {
    id: row.id,
    userId: row.user_id,
    emitterAppId: row.emitter_app_id,
    topic: row.topic,
    payload: (row.payload && typeof row.payload === "object") ? row.payload : {},
    status: (["pending", "delivering", "delivered", "failed"].includes(row.status)
      ? row.status
      : "pending") as AgentEvent["status"],
    attempts: row.attempts ?? 0,
    emitHop: row.emit_hop ?? 1,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
  };
}

// ── Dispatch (cron drain) ──────────────────────────────────────────────────

interface EventDispatchResult {
  scanned: number;
  delivered: number;
  failed: number;
  denied: number;
}

// Drain pending events. Imported lazily by the cron so this module doesn't pull
// the mcp handler graph into every request path.
export async function dispatchPendingEvents(
  options: { limit?: number; nowMs?: number } = {},
): Promise<EventDispatchResult> {
  const db = getDbConfig();
  const result: EventDispatchResult = { scanned: 0, delivered: 0, failed: 0, denied: 0 };
  if (!db) return result;
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.min(options.limit ?? 50, 200);

  // Pending events, plus any 'delivering' whose lease has expired (a prior tick
  // crashed mid-flight) — oldest first.
  const nowIso = new Date(nowMs).toISOString();
  const scanUrl = `${db.baseUrl}/rest/v1/agent_events?` +
    `or=(status.eq.pending,and(status.eq.delivering,lease_until.lt.${nowIso}))` +
    `&order=created_at.asc&limit=${limit}&select=*`;
  const scanResp = await fetch(scanUrl, { headers: db.headers });
  if (!scanResp.ok) return result;
  const rows = await scanResp.json().catch(() => []) as EventRow[];
  if (!Array.isArray(rows)) return result;

  for (const row of rows) {
    result.scanned++;
    // Optimistic claim: flip pending/expired-delivering -> delivering with a
    // fresh lease. If another tick already claimed it, the status filter
    // matches 0 rows and we skip (no double-dispatch).
    const leaseUntil = new Date(nowMs + LEASE_SECONDS * 1000).toISOString();
    const claim = await fetch(
      `${db.baseUrl}/rest/v1/agent_events?id=eq.${row.id}` +
        `&or=(status.eq.pending,and(status.eq.delivering,lease_until.lt.${nowIso}))`,
      {
        method: "PATCH",
        headers: { ...db.headers, Prefer: "return=representation" },
        body: JSON.stringify({
          status: "delivering",
          lease_until: leaseUntil,
          attempts: (row.attempts ?? 0) + 1,
        }),
      },
    );
    if (!claim.ok) continue;
    const claimed = await claim.json().catch(() => []);
    if (!Array.isArray(claimed) || claimed.length === 0) continue;

    const event = mapEvent(claimed[0] as EventRow);
    try {
      const outcome = await dispatchOneEvent(db, event, nowMs);
      result.delivered += outcome.delivered;
      result.failed += outcome.failed;
      result.denied += outcome.denied;
    } catch (err) {
      // A throw here is a FAN-OUT-level failure (e.g. resolving subscribers
      // errored) — distinct from an individual delivery failing, which
      // dispatchOneEvent records per-row without throwing. Retry the whole event
      // (back to pending → re-scanned) up to the attempt ceiling, then give up.
      console.warn("[AGENT-EVENTS] Event dispatch error:", err);
      const finalFail = event.attempts >= MAX_EVENT_DELIVERY_ATTEMPTS;
      await patchEvent(db, event.id, {
        status: finalFail ? "failed" : "pending",
        lease_until: null,
        last_error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

async function dispatchOneEvent(
  db: DbConfig,
  event: AgentEvent,
  nowMs: number,
): Promise<{ delivered: number; failed: number; denied: number }> {
  const { executeEventDelivery } = await import("../handlers/mcp.ts");
  let delivered = 0;
  let failed = 0;
  let denied = 0;

  const subscribers = (await resolveSubscribers({
    userId: event.userId,
    emitterAppId: event.emitterAppId,
    topic: event.topic,
  })).slice(0, MAX_EVENT_FANOUT);

  for (const grant of subscribers) {
    // Idempotent per (event, grant): create a delivery row, or skip if one is
    // already terminal.
    const deliveryId = await claimDelivery(db, event, grant.id, grant.targetAppId, grant.targetFunction);
    if (!deliveryId) continue; // already delivered/denied by a prior tick

    // Re-check the cap right before invoking (resolveSubscribeGrant checks it).
    const resolution = await resolveSubscribeGrant({
      userId: event.userId,
      emitterAppId: event.emitterAppId,
      subscriberAppId: grant.targetAppId,
      targetFunction: grant.targetFunction,
      topic: event.topic,
      nowMs,
    });
    if (!resolution.allowed) {
      denied++;
      await patchDelivery(db, deliveryId, {
        status: "denied",
        last_error: resolution.reason ?? "denied",
      });
      continue;
    }

    // executeEventDelivery reuses the full settlement path: it bills the user,
    // attributes caller_app_id=emitter, and records spend on the subscribe
    // grant's monthly cap (via meta.callerGrantId).
    const outcome = await executeEventDelivery({
      subscriberAppId: grant.targetAppId,
      targetFunction: grant.targetFunction,
      payload: event.payload,
      userId: event.userId,
      emitterAppId: event.emitterAppId,
      grantId: grant.id,
      hop: event.emitHop,
    });

    if (outcome.success) {
      delivered++;
      await patchDelivery(db, deliveryId, {
        status: "delivered",
        receipt_id: outcome.receiptId,
        delivered_at: new Date(nowMs).toISOString(),
      });
    } else {
      failed++;
      await patchDelivery(db, deliveryId, {
        status: "failed",
        last_error: outcome.error ?? "delivery failed",
      });
    }
  }

  // Roll the per-subscriber outcomes up into the event's terminal status.
  //
  // Delivery is AT-MOST-ONCE: claimDelivery's unique (event, grant) row means a
  // given subscriber is invoked at most once per event, and we deliberately do
  // NOT auto-retry a `failed` delivery — the handler may have run and settled
  // before erroring, so a blind retry could double-bill or double-act. A failure
  // is recorded on its delivery row and surfaced here as a `failed` event (with
  // last_error), so it is queryable rather than silently swallowed.
  //
  // Un-attempted subscribers ARE still completed after a mid-fan-out crash: the
  // lease expires, the event re-scans, and already-terminal delivery rows are
  // skipped while the unreached ones get their one attempt.
  const total = delivered + failed + denied;
  await patchEvent(db, event.id, {
    status: failed > 0 ? "failed" : "delivered",
    lease_until: null,
    last_error: failed > 0 ? `${failed} of ${total} deliveries failed` : null,
    dispatched_at: new Date(nowMs).toISOString(),
  });
  return { delivered, failed, denied };
}

// Claim the right to invoke one subscriber for this event. Inserts the delivery
// row idempotently and returns its id; returns null if a row already exists in
// ANY status — that subscriber has already had its single at-most-once attempt
// for this event, so we never invoke it again (this is what prevents a
// re-scanned event from double-billing an already-settled delivery).
async function claimDelivery(
  db: DbConfig,
  event: AgentEvent,
  grantId: string,
  subscriberAppId: string,
  targetFunction: string,
): Promise<string | null> {
  const response = await fetch(
    `${db.baseUrl}/rest/v1/agent_event_deliveries?on_conflict=event_id,grant_id`,
    {
      method: "POST",
      headers: {
        ...db.headers,
        // ignore-duplicates: an existing row (any status) means this (event,
        // grant) was already handled — do not invoke again.
        Prefer: "resolution=ignore-duplicates,return=representation",
      },
      body: JSON.stringify([{
        event_id: event.id,
        grant_id: grantId,
        user_id: event.userId,
        subscriber_app_id: subscriberAppId,
        target_function: targetFunction,
        status: "pending",
      }]),
    },
  );
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  // ignore-duplicates returns the inserted row only when it was new.
  return Array.isArray(rows) && rows[0]?.id ? rows[0].id : null;
}

async function patchEvent(
  db: DbConfig,
  eventId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await fetch(`${db.baseUrl}/rest/v1/agent_events?id=eq.${eventId}`, {
    method: "PATCH",
    headers: { ...db.headers, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  }).catch(() => {});
}

async function patchDelivery(
  db: DbConfig,
  deliveryId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await fetch(`${db.baseUrl}/rest/v1/agent_event_deliveries?id=eq.${deliveryId}`, {
    method: "PATCH",
    headers: { ...db.headers, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  }).catch(() => {});
}
