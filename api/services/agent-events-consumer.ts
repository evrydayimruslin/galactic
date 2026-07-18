// Event-bus queue consumer (PR4).
//
// Each message carries { eventId }; the event row holds everything else.
// The optimistic pending→delivering claim is the at-most-once guard against
// Queues' at-least-once delivery — a duplicate message finds the row claimed
// (or terminal) and acks. Queue retries only help failures BEFORE the claim;
// after it, the event-row state machine owns recovery (attempt ceiling,
// lease expiry, sweeper), never message redelivery — per-subscriber handlers
// are non-idempotent and each delivery row gets exactly one attempt.

import { claimEventById, dispatchClaimedEvent } from "./agent-events.ts";

type EventMessageOutcome = "ack" | "retry";

export async function processEventMessage(
  body: unknown,
): Promise<EventMessageOutcome> {
  const eventId = body && typeof body === "object" &&
      typeof (body as { eventId?: unknown }).eventId === "string"
    ? (body as { eventId: string }).eventId
    : null;
  if (!eventId) {
    console.warn("[QUEUE-EVENTS] Dropping malformed message:", body);
    return "ack";
  }

  let event;
  try {
    event = await claimEventById(eventId, Date.now());
  } catch (err) {
    // Pre-claim infra failure: nothing has dispatched — safe to retry.
    console.warn(
      `[QUEUE-EVENTS] Claim failed for event ${eventId}, will retry:`,
      err,
    );
    return "retry";
  }
  if (!event) {
    // Already claimed/terminal/unknown: at-least-once duplicate, a sweeper
    // race, or a deleted row.
    return "ack";
  }

  // dispatchClaimedEvent handles its own failures (per-delivery rows; the
  // fan-out-level catch re-queues or fails the event by attempt ceiling).
  // Never retry the message post-claim.
  await dispatchClaimedEvent(event, Date.now(), {
    // One normal EVENT_QUEUE lifecycle. Re-enqueues are separate consumer
    // invocations and receive a fresh envelope when their message is claimed.
    capacityQueueOperations: { write: 1, read: 1, delete: 1, total: 3 },
    capacityRootWorkerRequest: true,
  }).catch((err) => {
    console.error(`[QUEUE-EVENTS] Dispatch crashed for event ${eventId}:`, err);
  });
  return "ack";
}
