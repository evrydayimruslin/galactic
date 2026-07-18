// Cross-Agent pub/sub event bus (Phase 4.5 / P5).
//
// An owner-private Agent emits a topic (ultralight.emit); the dispatcher fans
// the event out to every owner-private Agent the user wired a mode='subscribe'
// grant for, invoking the subscriber's handler. Both ends are revalidated at
// execution time and RECEIVING remains grant-gated.
// Delivery is async — emit inserts the event row AND enqueues {eventId} to
// EVENT_QUEUE; the queue consumer performs the fan-out with bounded
// concurrency (PR4). The minute cron is demoted to a recovery sweeper for
// stuck events (emit-time send failures, lost messages, expired leases).
// Delivery is billed to the user and capped by the subscribe grant's monthly
// cap. Cascades are bounded by the caller-context hop ceiling.
// See docs/LAUNCH_PIVOT_DECISIONS.md.

import { getEnv, getEventQueue } from "../lib/env.ts";
import {
  type AgentEvent,
  MAX_AGENT_CALL_HOP_DEPTH,
  MAX_EVENT_DELIVERY_ATTEMPTS,
  MAX_EVENT_FANOUT,
} from "../../shared/contracts/agent-grants.ts";
import { resolveSubscribeGrant, resolveSubscribers } from "./agent-grants.ts";
import { createNotification } from "./notifications.ts";

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
  capacity_agent_id?: string | null;
  topic: string;
  payload: Record<string, unknown> | null;
  status: string;
  attempts: number;
  emit_hop: number;
  created_at: string;
  dispatched_at: string | null;
  next_eligible_at?: string | null;
}

interface DeliveryRow {
  id: string;
  grant_id: string;
  subscriber_app_id: string;
  target_function: string;
  status: string;
  attempts: number;
  next_eligible_at: string | null;
}

type PrivateOwnerAgentState =
  | { allowed: true }
  | { allowed: false; reason: "not_found" | "not_owner_private" };

const MAX_TOPIC_LENGTH = 200;
// The lease must outlive a full consumer PASS (waves of deliveries up to the
// soft deadline), not a single delivery — the old 120s lease equalled the max
// single-delivery time, so an in-progress fan-out could be re-claimed
// mid-flight by the next tick.
const LEASE_SECONDS = 900;
// Fan-out runs in concurrent waves: high enough to keep a big fan-out inside
// the consumer's wall budget, low enough to respect the 6-simultaneous-
// connection limit per invocation.
const EVENT_DELIVERY_CONCURRENCY = 5;
// Per-invocation budget: each delivery costs ~15-20 subrequests through the
// full execution pipeline, and an invocation gets 1000 — cap the pass and
// continue in a fresh invocation (re-enqueue) rather than starving.
const MAX_DELIVERIES_PER_PASS = 40;
// Stop launching new waves past this elapsed time so the invocation settles
// well inside the consumer's 15-min wall even with worst-case 120s handlers.
const SOFT_DEADLINE_MS = 10 * 60_000;
// The sweeper ignores pending rows younger than this: the queue path delivers
// in seconds, and sweeping fresh rows would race the consumer's claim every
// tick. Applies only when EVENT_QUEUE is bound.
const SWEEP_GRACE_MS = 2 * 60_000;
// Bound the stored payload: every event is duplicated into the delivery path
// for up to MAX_EVENT_FANOUT subscribers, so an unbounded blob is a storage +
// fan-out amplification vector.
const MAX_PAYLOAD_BYTES = 32 * 1024;

async function resolvePrivateOwnerAgent(
  db: DbConfig,
  userId: string,
  appId: string,
): Promise<PrivateOwnerAgentState> {
  const response = await fetch(
    `${db.baseUrl}/rest/v1/apps?id=eq.${encodeURIComponent(appId)}` +
      "&select=id,owner_id,visibility,deleted_at&limit=1",
    { headers: db.headers },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Failed to verify event Agent isolation (${response.status}): ${detail}`,
    );
  }
  const rows = await response.json().catch(() => []) as Array<{
    id?: string;
    owner_id?: string;
    visibility?: string;
    deleted_at?: string | null;
  }>;
  const app = Array.isArray(rows) ? rows[0] : undefined;
  if (!app || app.deleted_at) return { allowed: false, reason: "not_found" };
  if (app.owner_id !== userId || app.visibility !== "private") {
    return { allowed: false, reason: "not_owner_private" };
  }
  return { allowed: true };
}

async function notifyEventAlert(input: {
  userId: string;
  agentId: string | null;
  eventId: string;
  deliveryId?: string;
  kind:
    | "event_dispatch_failed"
    | "event_delivery_failed"
    | "event_delivery_blocked"
    | "event_delivery_waiting";
  title: string;
  body: string;
  severity?: "warning" | "critical";
}): Promise<void> {
  await createNotification({
    userId: input.userId,
    agentId: input.agentId,
    kind: input.kind,
    severity: input.severity ?? "warning",
    title: input.title,
    body: input.body.slice(0, 1000),
    entityType: input.deliveryId ? "agent_event_delivery" : "agent_event",
    entityId: input.deliveryId ?? input.eventId,
    actionUrl: input.agentId
      ? `/agents/${encodeURIComponent(input.agentId)}?tab=alerts`
      : null,
    dedupeKey: `${input.kind}:${input.deliveryId ?? input.eventId}`,
  });
}

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
  capacityAgentId?: string;
  topic: string;
  payload?: Record<string, unknown>;
  emitHop: number;
}): Promise<{
  eventId: string | null;
  rejected?: "hop_exceeded" | "not_configured" | "private_owner_required";
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

  const emitterState = await resolvePrivateOwnerAgent(
    db,
    input.userId,
    input.emitterAppId,
  );
  if (!emitterState.allowed) {
    return { eventId: null, rejected: "private_owner_required" };
  }
  const capacityAgentId = input.capacityAgentId?.trim() || input.emitterAppId;
  if (capacityAgentId !== input.emitterAppId) {
    const capacityAgentState = await resolvePrivateOwnerAgent(
      db,
      input.userId,
      capacityAgentId,
    );
    if (!capacityAgentState.allowed) {
      return { eventId: null, rejected: "private_owner_required" };
    }
  }

  const response = await fetch(`${db.baseUrl}/rest/v1/agent_events`, {
    method: "POST",
    headers: { ...db.headers, Prefer: "return=representation" },
    body: JSON.stringify([{
      user_id: input.userId,
      emitter_app_id: input.emitterAppId,
      capacity_agent_id: capacityAgentId,
      topic,
      payload,
      status: "pending",
      emit_hop: Math.max(1, Math.floor(input.emitHop)),
    }]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail ? `Failed to enqueue event: ${detail}` : "Failed to enqueue event",
    );
  }
  const rows = await response.json().catch(() => []);
  const eventId = Array.isArray(rows) && rows[0]?.id ? rows[0].id : null;

  // Fast path: hand the event to the queue consumer. Best-effort — a failed
  // send leaves the row 'pending' and the cron sweeper re-enqueues it within
  // a couple of minutes, so emit never fails on queue trouble.
  if (eventId) {
    const queue = getEventQueue();
    if (queue) {
      await queue.send({ eventId }).catch((err) => {
        console.warn(
          "[AGENT-EVENTS] EVENT_QUEUE send failed; sweeper will recover:",
          err,
        );
      });
    }
  }
  return { eventId };
}

function mapEvent(row: EventRow): AgentEvent {
  return {
    id: row.id,
    userId: row.user_id,
    emitterAppId: row.emitter_app_id,
    capacityAgentId: row.capacity_agent_id || row.emitter_app_id,
    topic: row.topic,
    payload: (row.payload && typeof row.payload === "object")
      ? row.payload
      : {},
    status:
      (["pending", "delivering", "waiting", "delivered", "failed"].includes(
          row.status,
        )
        ? row.status
        : "pending") as AgentEvent["status"],
    attempts: row.attempts ?? 0,
    emitHop: row.emit_hop ?? 1,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    nextEligibleAt: row.next_eligible_at ?? null,
  };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

interface EventDispatchResult {
  scanned: number;
  delivered: number;
  failed: number;
  denied: number;
}

interface EventDeliveryExecutionInput {
  subscriberAppId: string;
  targetFunction: string;
  payload: Record<string, unknown>;
  userId: string;
  emitterAppId: string;
  capacityAgentId: string;
  grantId: string;
  hop: number;
  /** Trusted EVENT_QUEUE facts owned by at most one delivery per pass. */
  capacityQueueOperations?: unknown;
  /** Owns the surrounding Queue consumer's one Standard Worker request. */
  capacityRootWorkerRequest?: boolean;
}

interface EventDeliveryExecutionOutcome {
  success: boolean;
  receiptId: string | null;
  error?: string;
  admission?: {
    code:
      | "capacity_waiting"
      | "agent_cap_waiting"
      | "agent_cap_too_low_for_request"
      | "concurrency_waiting";
    nextEligibleAt: string | null;
    capacityAgentId: string | null;
    bindingConstraint: "account" | "agent" | null;
    concurrencyScope: "account" | "agent" | "ai" | "routine" | null;
  };
}

interface EventDispatchDeps {
  executeDelivery?: (
    input: EventDeliveryExecutionInput,
  ) => Promise<EventDeliveryExecutionOutcome>;
  /** Internal-only Queue facts supplied by processEventMessage. */
  capacityQueueOperations?: unknown;
  capacityRootWorkerRequest?: boolean;
}

/**
 * Optimistically claim an event for dispatch (pending/expired-delivering or
 * capacity-waiting whose reset has arrived → delivering with a fresh lease).
 * Returns the claimed event, or null when
 * another consumer/sweeper already owns it — the at-most-once guard against
 * the queue's at-least-once delivery. Throws on infra failure (nothing has
 * executed; the queue consumer may retry the message).
 */
export async function claimEventById(
  eventId: string,
  nowMs: number,
): Promise<AgentEvent | null> {
  const db = getDbConfig();
  if (!db) return null;

  // Read first (PostgREST cannot increment in a PATCH); the claim itself is
  // race-safe regardless — two claimers PATCH through the same status filter
  // and exactly one matches the row.
  const readResp = await fetch(
    `${db.baseUrl}/rest/v1/agent_events?id=eq.${eventId}&select=*&limit=1`,
    { headers: db.headers },
  );
  if (!readResp.ok) {
    const detail = await readResp.text().catch(() => "");
    throw new Error(`Failed to read event ${eventId}: ${detail}`);
  }
  const readRows = await readResp.json().catch(() => []) as EventRow[];
  const row = Array.isArray(readRows) ? readRows[0] : undefined;
  if (!row) return null;

  const nowIso = new Date(nowMs).toISOString();
  const leaseUntil = new Date(nowMs + LEASE_SECONDS * 1000).toISOString();
  const claim = await fetch(
    `${db.baseUrl}/rest/v1/agent_events?id=eq.${eventId}` +
      `&or=(status.eq.pending,and(status.eq.delivering,lease_until.lt.${nowIso}),and(status.eq.waiting,next_eligible_at.lte.${nowIso}))`,
    {
      method: "PATCH",
      headers: { ...db.headers, Prefer: "return=representation" },
      body: JSON.stringify({
        status: "delivering",
        lease_until: leaseUntil,
        next_eligible_at: null,
        // attempts counts dispatch PASSES (claims), not deliveries.
        attempts: (row.attempts ?? 0) + 1,
      }),
    },
  );
  if (!claim.ok) {
    const detail = await claim.text().catch(() => "");
    throw new Error(`Failed to claim event ${eventId}: ${detail}`);
  }
  const claimed = await claim.json().catch(() => []);
  if (!Array.isArray(claimed) || claimed.length === 0) return null;
  return mapEvent(claimed[0] as EventRow);
}

/**
 * Fan an already-claimed event out to its subscribers and settle the event
 * row. Never re-runs a delivered/failed/denied delivery (the delivery-row
 * claim is per-subscriber at-most-once). Runs deliveries in bounded
 * concurrent waves; a pass that hits the per-invocation budget patches the
 * event back to 'pending' and re-enqueues it so a fresh invocation finishes
 * the remaining subscribers.
 */
export async function dispatchClaimedEvent(
  event: AgentEvent,
  nowMs: number,
  deps: EventDispatchDeps = {},
): Promise<{ delivered: number; failed: number; denied: number }> {
  const db = getDbConfig();
  if (!db) return { delivered: 0, failed: 0, denied: 0 };
  try {
    return await runFanOut(db, event, nowMs, deps);
  } catch (err) {
    // A throw here is a FAN-OUT-level failure (e.g. resolving subscribers
    // errored) — distinct from an individual delivery failing, which is
    // recorded per-row without throwing. Retry the whole event (back to
    // pending → re-dispatched) up to the attempt ceiling, then give up.
    console.warn("[AGENT-EVENTS] Event dispatch error:", err);
    const finalFail = event.attempts >= MAX_EVENT_DELIVERY_ATTEMPTS;
    await patchEvent(db, event.id, {
      status: finalFail ? "failed" : "pending",
      lease_until: null,
      next_eligible_at: null,
      last_error: err instanceof Error ? err.message : String(err),
    });
    if (!finalFail) {
      await requeueEvent(event.id);
    } else {
      await notifyEventAlert({
        userId: event.userId,
        agentId: event.emitterAppId,
        eventId: event.id,
        kind: "event_dispatch_failed",
        title: "Reactive trigger dispatch failed",
        body: `Topic ${event.topic} exhausted its dispatch retries: ${
          err instanceof Error ? err.message : String(err)
        }`,
        severity: "critical",
      });
    }
    return { delivered: 0, failed: 0, denied: 0 };
  }
}

type DeliveryOutcomeKind =
  | "delivered"
  | "failed"
  | "denied"
  | "waiting" // capacity rejected before tenant code ran; safe to resume
  | "already" // a prior pass owns this (event, grant) — at-most-once skip
  | "retryable"; // pre-claim infra failure — safe to attempt on a later pass

interface DeliveryOutcome {
  kind: DeliveryOutcomeKind;
  nextEligibleAt?: string;
  /**
   * True only when the delivery returned a receipt, proving its settlement can
   * own this pass's indivisible Queue lifecycle without double counting.
   */
  capacityQueueAllocated?: boolean;
}

async function runFanOut(
  db: DbConfig,
  event: AgentEvent,
  nowMs: number,
  deps: EventDispatchDeps,
): Promise<{ delivered: number; failed: number; denied: number }> {
  let delivered = 0;
  let failed = 0;
  let denied = 0;

  // Grants are durable and can outlive a visibility/ownership change. Recheck
  // the launch isolation boundary at dispatch, not only when the event or
  // subscription was created.
  const emitterState = await resolvePrivateOwnerAgent(
    db,
    event.userId,
    event.emitterAppId,
  );
  if (!emitterState.allowed) {
    const reason = emitterState.reason === "not_found"
      ? "The emitting Agent no longer exists."
      : "The emitting Agent is no longer private and owned by this account.";
    await patchEvent(db, event.id, {
      status: "failed",
      lease_until: null,
      next_eligible_at: null,
      last_error: `private_owner_isolation: ${emitterState.reason}`,
      dispatched_at: new Date(nowMs).toISOString(),
    });
    await notifyEventAlert({
      userId: event.userId,
      // A hard-deleted emitter cannot satisfy the notification FK; keep the
      // alert account-wide in that edge case instead of dropping it entirely.
      agentId: emitterState.reason === "not_found" ? null : event.emitterAppId,
      eventId: event.id,
      kind: "event_dispatch_failed",
      title: "Reactive trigger could not dispatch",
      body: `${reason} Topic: ${event.topic}.`,
      severity: "critical",
    });
    return { delivered: 0, failed: 1, denied: 0 };
  }
  if (event.capacityAgentId !== event.emitterAppId) {
    const rootState = await resolvePrivateOwnerAgent(
      db,
      event.userId,
      event.capacityAgentId,
    );
    if (!rootState.allowed) {
      await patchEvent(db, event.id, {
        status: "failed",
        lease_until: null,
        next_eligible_at: null,
        last_error: `capacity_root_isolation: ${rootState.reason}`,
        dispatched_at: new Date(nowMs).toISOString(),
      });
      await notifyEventAlert({
        userId: event.userId,
        agentId: event.emitterAppId,
        eventId: event.id,
        kind: "event_dispatch_failed",
        title: "Reactive trigger lost its capacity root",
        body:
          `Topic ${event.topic} could not run because its originating Agent is no longer private and active.`,
        severity: "critical",
      });
      return { delivered: 0, failed: 1, denied: 0 };
    }
  }

  const subscribers = (await resolveSubscribers({
    userId: event.userId,
    emitterAppId: event.emitterAppId,
    topic: event.topic,
  })).slice(0, MAX_EVENT_FANOUT);

  const passStartMs = Date.now();
  let index = 0;
  let attempted = 0;
  let incomplete = false;
  let capacityQueueAllocated = deps.capacityQueueOperations === undefined;

  while (index < subscribers.length) {
    if (
      attempted >= MAX_DELIVERIES_PER_PASS ||
      Date.now() - passStartMs > SOFT_DEADLINE_MS
    ) {
      incomplete = true;
      break;
    }
    const wave = subscribers.slice(index, index + EVENT_DELIVERY_CONCURRENCY);
    index += wave.length;
    const outcomes: DeliveryOutcome[] = [];

    // A Queue invocation is one indivisible customer-attributable lifecycle,
    // not one lifecycle per subscriber. Walk candidates serially only until an
    // actual execution returns a receipt; that one receipt owns write/read/
    // delete + the consumer's Standard Worker request. Already/denied/waiting
    // candidates return no receipt, so ownership remains available for the
    // next real delivery. Once allocated, the remainder fan out concurrently.
    while (!capacityQueueAllocated && wave.length > 0) {
      const grant = wave.shift()!;
      const outcome = await deliverToSubscriber(db, event, grant, nowMs, {
        ...deps,
        capacityQueueOperations: deps.capacityQueueOperations,
        capacityRootWorkerRequest: deps.capacityRootWorkerRequest === true,
      });
      outcomes.push(outcome);
      if (outcome.capacityQueueAllocated === true) {
        capacityQueueAllocated = true;
      }
    }
    outcomes.push(
      ...await Promise.all(
        wave.map((grant) =>
          deliverToSubscriber(db, event, grant, nowMs, {
            ...deps,
            capacityQueueOperations: undefined,
            capacityRootWorkerRequest: false,
          })
        ),
      ),
    );
    for (const outcome of outcomes) {
      // Only outcomes that ran the expensive path consume the pass budget.
      // An "already" skip (a prior pass owns the delivery row) costs ~one
      // subrequest — charging it would make continuation passes re-walk the
      // delivered prefix, burn the whole budget on skips, and strand every
      // subscriber past the first window forever.
      if (outcome.kind === "delivered") {
        delivered++;
        attempted++;
      } else if (outcome.kind === "failed") {
        failed++;
        attempted++;
      } else if (outcome.kind === "denied") {
        denied++;
        attempted++;
      } else if (outcome.kind === "waiting") {
        attempted++;
      } // "retryable": the subscriber was never claimed — finish the pass and
      // let a later pass give it its one attempt.
      else if (outcome.kind === "retryable") incomplete = true;
    }
  }

  // Capacity waits are durable and do NOT consume the generic dispatch-attempt
  // ceiling. Re-read them after the pass so continuation-budget cuts and
  // concurrent claims cannot lose the earliest reset. Revoked subscriptions
  // are terminalized instead of leaving orphaned waiting rows forever.
  const waiting = await reconcileWaitingDeliveries(
    db,
    event,
    new Set(subscribers.map((grant) => grant.id)),
  );
  if (waiting.nextEligibleAt) {
    await patchEvent(db, event.id, {
      status: "waiting",
      lease_until: null,
      next_eligible_at: waiting.nextEligibleAt,
      last_error: `capacity_waiting_until:${waiting.nextEligibleAt}`,
    });
    return { delivered, failed, denied };
  }

  if (incomplete) {
    // Budget cut or unclaimed stragglers. Hand the remainder to a fresh
    // invocation; terminal delivery rows make the next pass idempotent.
    if (event.attempts >= MAX_EVENT_DELIVERY_ATTEMPTS) {
      await patchEvent(db, event.id, {
        status: "failed",
        lease_until: null,
        next_eligible_at: null,
        last_error:
          `fan-out incomplete after ${event.attempts} passes (${delivered} delivered, ${failed} failed, ${denied} denied this pass)`,
        dispatched_at: new Date(nowMs).toISOString(),
      });
    } else {
      await patchEvent(db, event.id, {
        status: "pending",
        lease_until: null,
        next_eligible_at: null,
      });
      await requeueEvent(event.id);
    }
    return { delivered, failed, denied };
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
  // A continuation pass only counts ITS deliveries, so the terminal status
  // also checks the rows for failures recorded by earlier passes — an event
  // must never read 'delivered' when one of its deliveries failed.
  const crossPassFailed = failed === 0 && event.attempts > 1
    ? await hasFailedDeliveries(db, event.id)
    : false;
  const anyFailed = failed > 0 || crossPassFailed;
  const total = delivered + failed + denied;
  await patchEvent(db, event.id, {
    status: anyFailed ? "failed" : "delivered",
    lease_until: null,
    next_eligible_at: null,
    last_error: failed > 0
      ? `${failed} of ${total} deliveries failed${
        event.attempts > 1 ? " in the final pass" : ""
      }`
      : crossPassFailed
      ? "one or more deliveries failed in an earlier pass"
      : null,
    dispatched_at: new Date(nowMs).toISOString(),
  });
  return { delivered, failed, denied };
}

async function deliverToSubscriber(
  db: DbConfig,
  event: AgentEvent,
  grant: { id: string; targetAppId: string; targetFunction: string },
  nowMs: number,
  deps: EventDispatchDeps,
): Promise<DeliveryOutcome> {
  // Resolve private-owner isolation before claiming the at-most-once delivery.
  // An infrastructure error remains retryable because no handler can have run.
  let subscriberState: PrivateOwnerAgentState;
  try {
    subscriberState = await resolvePrivateOwnerAgent(
      db,
      event.userId,
      grant.targetAppId,
    );
  } catch (err) {
    console.warn("[AGENT-EVENTS] Subscriber isolation check failed:", err);
    return { kind: "retryable" };
  }

  // Idempotent per (event, grant): create a delivery row, or skip if one
  // already exists in any status.
  let deliveryClaim: DeliveryClaim;
  try {
    deliveryClaim = await claimDelivery(
      db,
      event,
      grant.id,
      grant.targetAppId,
      grant.targetFunction,
      nowMs,
    );
  } catch (err) {
    // Nothing claimed, nothing executed — a later pass can safely retry.
    console.warn("[AGENT-EVENTS] Delivery claim failed:", err);
    return { kind: "retryable" };
  }
  if (deliveryClaim.kind === "already") return { kind: "already" };
  if (deliveryClaim.kind === "waiting") {
    return {
      kind: "waiting",
      nextEligibleAt: deliveryClaim.nextEligibleAt,
    };
  }
  const deliveryId = deliveryClaim.deliveryId;

  if (!subscriberState.allowed) {
    const missing = subscriberState.reason === "not_found";
    const status = missing ? "failed" : "denied";
    const reason = missing
      ? "Subscriber Agent not found"
      : "Subscriber Agent must remain private and owned by this account";
    await patchDelivery(db, deliveryId, {
      status,
      last_error: `private_owner_isolation: ${subscriberState.reason}`,
    });
    await notifyEventAlert({
      userId: event.userId,
      // A missing subscriber has no surviving Agent row/page to attribute.
      agentId: missing ? event.emitterAppId : grant.targetAppId,
      eventId: event.id,
      deliveryId,
      kind: missing ? "event_delivery_failed" : "event_delivery_blocked",
      title: missing ? "Reactive trigger failed" : "Reactive trigger blocked",
      body: `${reason}. Topic: ${event.topic}.`,
      severity: missing ? "critical" : "warning",
    });
    return { kind: status };
  }

  try {
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
      await patchDelivery(db, deliveryId, {
        status: "denied",
        last_error: resolution.reason ?? "denied",
      });
      await notifyEventAlert({
        userId: event.userId,
        agentId: grant.targetAppId,
        eventId: event.id,
        deliveryId,
        kind: "event_delivery_blocked",
        title: "Reactive trigger blocked",
        body: `Topic ${event.topic} was not delivered: ${
          resolution.reason ?? "subscription denied"
        }.`,
      });
      return { kind: "denied" };
    }

    // executeEventDelivery reuses the full settlement path: it bills the user,
    // attributes caller_app_id=emitter, and records spend on the subscribe
    // grant's monthly cap (via meta.callerGrantId).
    const executeDelivery = deps.executeDelivery ??
      (await import("../handlers/mcp.ts")).executeEventDelivery;
    const outcome = await executeDelivery({
      subscriberAppId: grant.targetAppId,
      targetFunction: grant.targetFunction,
      payload: event.payload,
      userId: event.userId,
      emitterAppId: event.emitterAppId,
      capacityAgentId: event.capacityAgentId,
      grantId: grant.id,
      hop: event.emitHop,
      capacityQueueOperations: deps.capacityQueueOperations,
      capacityRootWorkerRequest: deps.capacityRootWorkerRequest === true,
    });
    const capacityQueueAllocated = outcome.receiptId != null;

    if (outcome.success) {
      await patchDelivery(db, deliveryId, {
        status: "delivered",
        receipt_id: outcome.receiptId,
        delivered_at: new Date(nowMs).toISOString(),
      });
      return { kind: "delivered", capacityQueueAllocated };
    }

    if (outcome.admission) {
      const retryAt = normalizeCapacityRetryAt(
        outcome.admission.nextEligibleAt,
        nowMs,
      );
      if (
        outcome.admission.code === "agent_cap_too_low_for_request" ||
        !retryAt
      ) {
        await patchDelivery(db, deliveryId, {
          status: "denied",
          next_eligible_at: null,
          capacity_code: outcome.admission.code,
          last_error: outcome.error ?? outcome.admission.code,
        });
        await notifyEventAlert({
          userId: event.userId,
          agentId: grant.targetAppId,
          eventId: event.id,
          deliveryId,
          kind: "event_delivery_blocked",
          title: "Reactive trigger needs more Agent capacity",
          body: `Topic ${event.topic} could not run: ${
            outcome.error ?? outcome.admission.code
          }`,
        });
        return { kind: "denied", capacityQueueAllocated };
      }

      await patchDelivery(db, deliveryId, {
        status: "waiting",
        next_eligible_at: retryAt,
        capacity_code: outcome.admission.code,
        receipt_id: outcome.receiptId ?? null,
        last_error: outcome.error ?? outcome.admission.code,
      });
      await notifyEventAlert({
        userId: event.userId,
        agentId: grant.targetAppId,
        eventId: event.id,
        deliveryId,
        kind: "event_delivery_waiting",
        title: "Reactive trigger is waiting for capacity",
        body: `Topic ${event.topic} will resume after ${retryAt}.`,
      });
      return {
        kind: "waiting",
        nextEligibleAt: retryAt,
        capacityQueueAllocated,
      };
    }
    await patchDelivery(db, deliveryId, {
      status: "failed",
      // A failed handler still executed and settled — keep the receipt link
      // so the failure is billable-traceable, not just a message.
      receipt_id: outcome.receiptId ?? null,
      next_eligible_at: null,
      capacity_code: null,
      last_error: outcome.error ?? "delivery failed",
    });
    await notifyEventAlert({
      userId: event.userId,
      agentId: grant.targetAppId,
      eventId: event.id,
      deliveryId,
      kind: "event_delivery_failed",
      title: "Reactive trigger failed",
      body: `Topic ${event.topic} failed in ${grant.targetFunction}: ${
        outcome.error ?? "delivery failed"
      }`,
      severity: "critical",
    });
    return { kind: "failed", capacityQueueAllocated };
  } catch (err) {
    // The delivery row is claimed — the handler may have run and settled, so
    // this delivery must never be re-attempted. Record the failure on the row
    // (a stuck 'pending' row would otherwise block this subscriber forever).
    console.warn("[AGENT-EVENTS] Delivery failed post-claim:", err);
    await patchDelivery(db, deliveryId, {
      status: "failed",
      next_eligible_at: null,
      capacity_code: null,
      last_error: err instanceof Error ? err.message : String(err),
    });
    await notifyEventAlert({
      userId: event.userId,
      agentId: grant.targetAppId,
      eventId: event.id,
      deliveryId,
      kind: "event_delivery_failed",
      title: "Reactive trigger failed",
      body: `Topic ${event.topic} failed in ${grant.targetFunction}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      severity: "critical",
    });
    return { kind: "failed" };
  }
}

function normalizeCapacityRetryAt(
  value: string | null,
  nowMs: number,
): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  // A reset racing this invocation must not hot-loop through queue/sweeper
  // claims. Capacity is re-evaluated on resume; the one-minute floor matches
  // the recovery sweeper's cadence.
  return new Date(Math.max(parsed, nowMs + 60_000)).toISOString();
}

async function reconcileWaitingDeliveries(
  db: DbConfig,
  event: AgentEvent,
  activeGrantIds: Set<string>,
): Promise<{ nextEligibleAt: string | null }> {
  const response = await fetch(
    `${db.baseUrl}/rest/v1/agent_event_deliveries?event_id=eq.${event.id}` +
      "&status=eq.waiting&select=id,grant_id,subscriber_app_id,target_function,status,attempts,next_eligible_at",
    { headers: db.headers },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Failed to reconcile waiting event deliveries (${response.status}): ${detail}`,
    );
  }
  const rows = await response.json().catch(() => []) as DeliveryRow[];
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!activeGrantIds.has(row.grant_id)) {
      await patchDelivery(db, row.id, {
        status: "denied",
        next_eligible_at: null,
        capacity_code: null,
        last_error: "subscription_inactive_while_capacity_waiting",
      });
      await notifyEventAlert({
        userId: event.userId,
        agentId: row.subscriber_app_id,
        eventId: event.id,
        deliveryId: row.id,
        kind: "event_delivery_blocked",
        title: "Reactive trigger subscription changed",
        body:
          `Topic ${event.topic} was not resumed because its subscription is no longer active.`,
      });
      continue;
    }
    const eligibleMs = Date.parse(row.next_eligible_at ?? "");
    if (!Number.isFinite(eligibleMs)) {
      await patchDelivery(db, row.id, {
        status: "denied",
        next_eligible_at: null,
        last_error: "capacity_wait_missing_reset",
      });
      await notifyEventAlert({
        userId: event.userId,
        agentId: row.subscriber_app_id,
        eventId: event.id,
        deliveryId: row.id,
        kind: "event_delivery_blocked",
        title: "Reactive trigger could not resume",
        body: `Topic ${event.topic} has no valid capacity reset time.`,
        severity: "critical",
      });
      continue;
    }
    earliestMs = Math.min(earliestMs, eligibleMs);
  }
  return {
    nextEligibleAt: Number.isFinite(earliestMs)
      ? new Date(earliestMs).toISOString()
      : null,
  };
}

// Any failed delivery recorded for this event (cheap existence probe — used
// by continuation passes whose own counters can't see earlier passes).
async function hasFailedDeliveries(
  db: DbConfig,
  eventId: string,
): Promise<boolean> {
  const resp = await fetch(
    `${db.baseUrl}/rest/v1/agent_event_deliveries?event_id=eq.${eventId}` +
      `&status=eq.failed&select=id&limit=1`,
    { headers: db.headers },
  ).catch(() => null);
  if (!resp || !resp.ok) return false;
  const rows = await resp.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

// Best-effort continuation: hand an event back to the queue. MUST be awaited
// — a detached send is cancelled when the consumer invocation acks and
// returns. Failure is still fine: the sweeper re-enqueues stuck rows within
// a couple of minutes.
async function requeueEvent(eventId: string): Promise<void> {
  const queue = getEventQueue();
  if (!queue) return;
  await queue.send({ eventId }).catch((err) => {
    console.warn("[AGENT-EVENTS] Event re-enqueue failed:", err);
  });
}

// ── Sweeper (minute cron) ──────────────────────────────────────────────────

// Recover stuck events. With EVENT_QUEUE bound this only re-enqueues — all
// dispatch happens in queue consumers, so a slow fan-out can never blow the
// cron's wall budget or starve sibling minute jobs. Pending rows younger than
// the grace window are the consumer's (racing its claim every tick would just
// burn attempts). Without a queue (local dev), this is the inline dispatcher
// it always was.
export async function dispatchPendingEvents(
  options: { limit?: number; nowMs?: number } = {},
): Promise<EventDispatchResult> {
  const db = getDbConfig();
  const result: EventDispatchResult = {
    scanned: 0,
    delivered: 0,
    failed: 0,
    denied: 0,
  };
  if (!db) return result;
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.min(options.limit ?? 50, 200);
  const queue = getEventQueue();

  const nowIso = new Date(nowMs).toISOString();
  // With a queue, pending rows younger than the grace window belong to the
  // consumer. Without one (dev), the bare pending arm is the pre-queue
  // behavior — a created_at-vs-worker-clock comparison would let DB clock
  // skew hide a just-emitted row for a tick.
  const pendingArm = queue
    ? `and(status.eq.pending,created_at.lt.${
      new Date(nowMs - SWEEP_GRACE_MS).toISOString()
    })`
    : `status.eq.pending`;
  const scanUrl = `${db.baseUrl}/rest/v1/agent_events?` +
    `or=(${pendingArm},and(status.eq.delivering,lease_until.lt.${nowIso}),and(status.eq.waiting,next_eligible_at.lte.${nowIso}))` +
    `&order=created_at.asc&limit=${limit}&select=*`;
  const scanResp = await fetch(scanUrl, { headers: db.headers });
  if (!scanResp.ok) return result;
  const rows = await scanResp.json().catch(() => []) as EventRow[];
  if (!Array.isArray(rows)) return result;

  for (const row of rows) {
    result.scanned++;

    if (queue) {
      // The consumer claims and dispatches; a duplicate message loses the
      // claim and acks.
      await queue.send({ eventId: row.id }).catch((err) => {
        console.warn("[AGENT-EVENTS] Sweeper re-enqueue failed:", err);
      });
      continue;
    }

    // Dev fallback: inline claim + dispatch (the pre-queue behavior).
    let event: AgentEvent | null;
    try {
      event = await claimEventById(row.id, nowMs);
    } catch (err) {
      console.warn("[AGENT-EVENTS] Sweeper claim failed:", err);
      continue;
    }
    if (!event) continue;
    const outcome = await dispatchClaimedEvent(event, nowMs);
    result.delivered += outcome.delivered;
    result.failed += outcome.failed;
    result.denied += outcome.denied;
  }
  return result;
}

type DeliveryClaim =
  | { kind: "claimed"; deliveryId: string }
  | { kind: "waiting"; nextEligibleAt: string }
  | { kind: "already" };

// Claim the right to invoke one subscriber for this event. New rows are
// inserted idempotently. A capacity-waiting row is the sole retry exception:
// because structured admission proves tenant code never ran, it may transition
// waiting→pending exactly once after next_eligible_at. Terminal rows and
// ambiguous pending rows are never re-invoked.
async function claimDelivery(
  db: DbConfig,
  event: AgentEvent,
  grantId: string,
  subscriberAppId: string,
  targetFunction: string,
  nowMs: number,
): Promise<DeliveryClaim> {
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
        attempts: 1,
      }]),
    },
  );
  if (!response.ok) {
    // Infra failure, NOT a duplicate: nothing was claimed and the handler was
    // never invoked. Throw so the caller routes this to the retryable lane —
    // returning null here would permanently skip the subscriber.
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to claim delivery: ${detail || response.status}`);
  }
  const rows = await response.json().catch(() => []);
  // ignore-duplicates returns the inserted row only when it was new.
  if (Array.isArray(rows) && rows[0]?.id) {
    return { kind: "claimed", deliveryId: String(rows[0].id) };
  }

  const read = await fetch(
    `${db.baseUrl}/rest/v1/agent_event_deliveries?event_id=eq.${event.id}` +
      `&grant_id=eq.${grantId}` +
      "&select=id,grant_id,subscriber_app_id,target_function,status,attempts,next_eligible_at&limit=1",
    { headers: db.headers },
  );
  if (!read.ok) {
    const detail = await read.text().catch(() => "");
    throw new Error(
      `Failed to read existing delivery: ${detail || read.status}`,
    );
  }
  const existingRows = await read.json().catch(() => []) as DeliveryRow[];
  const existing = Array.isArray(existingRows) ? existingRows[0] : undefined;
  if (!existing || existing.status !== "waiting") return { kind: "already" };

  const nextMs = Date.parse(existing.next_eligible_at ?? "");
  if (!Number.isFinite(nextMs)) return { kind: "already" };
  if (nextMs > nowMs) {
    return {
      kind: "waiting",
      nextEligibleAt: new Date(nextMs).toISOString(),
    };
  }

  const nowIso = new Date(nowMs).toISOString();
  const resume = await fetch(
    `${db.baseUrl}/rest/v1/agent_event_deliveries?id=eq.${existing.id}` +
      `&status=eq.waiting&next_eligible_at=lte.${nowIso}`,
    {
      method: "PATCH",
      headers: { ...db.headers, Prefer: "return=representation" },
      body: JSON.stringify({
        status: "pending",
        attempts: Math.max(0, existing.attempts ?? 0) + 1,
        next_eligible_at: null,
        capacity_code: null,
        last_error: null,
      }),
    },
  );
  if (!resume.ok) {
    const detail = await resume.text().catch(() => "");
    throw new Error(
      `Failed to resume waiting delivery: ${detail || resume.status}`,
    );
  }
  const resumed = await resume.json().catch(() => []);
  return Array.isArray(resumed) && resumed[0]?.id
    ? { kind: "claimed", deliveryId: String(resumed[0].id) }
    : { kind: "already" };
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
  await fetch(
    `${db.baseUrl}/rest/v1/agent_event_deliveries?id=eq.${deliveryId}`,
    {
      method: "PATCH",
      headers: { ...db.headers, Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    },
  ).catch(() => {});
}
