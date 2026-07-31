// RPC Events Binding for Dynamic Workers
// Lets sandboxed app code emit pub/sub events WITHOUT the platform WORKER_SECRET
// ever entering the isolate. Identity (emitter app + user) and the hop ceiling
// come from the signed caller-context token, verified host-side here — exactly
// as the legacy /api/events/emit endpoint did — so sandbox JS cannot spoof the
// emitter, the user, or the hop. topic + payload are the only sandbox inputs.

import { WorkerEntrypoint } from "cloudflare:workers";
import { emitEvent } from "../../services/agent-events.ts";
import { verifyCallerContextToken } from "../../services/agent-caller-context.ts";
import {
  consumeExecutionEventPublish,
  resolveExecutionContext,
} from "../../services/execution-context-registry.ts";

type EventsBindingProps = Record<string, never>;

interface EmitResult {
  ok: boolean;
  event_id: string | null;
  rejected:
    | "hop_exceeded"
    | "not_configured"
    | "private_owner_required"
    | null;
}

export class EventsBinding
  extends WorkerEntrypoint<unknown, EventsBindingProps> {
  async emit(
    topic: unknown,
    payload: unknown,
    execCtxHandle?: string,
  ): Promise<EmitResult> {
    if (typeof topic !== "string" || !topic) {
      throw new Error("emit requires a topic string");
    }
    // Every production emit consumes its host-owned execution budget before
    // any asynchronous verification or delivery. There is intentionally no
    // frozen-prop fallback: a raw binding call that omits, forges, or replays a
    // handle must fail closed in fresh and warm isolates alike.
    consumeExecutionEventPublish(execCtxHandle);
    const callerContextToken =
      resolveExecutionContext(execCtxHandle)?.callerContextToken ?? null;
    // Identity + hop come from the VERIFIED signed token, never from sandbox
    // input — this is the same trust boundary the /api/events/emit endpoint used.
    const verified = await verifyCallerContextToken(callerContextToken);
    if (!verified.claims) {
      throw new Error("emit requires an authenticated user context");
    }
    const out = await emitEvent({
      userId: verified.claims.userId,
      emitterAppId: verified.claims.callerAppId,
      capacityAgentId: verified.claims.capacityAgentId ||
        verified.claims.callerAppId,
      topic,
      payload: (payload && typeof payload === "object")
        ? payload as Record<string, unknown>
        : {},
      emitHop: verified.claims.hop,
    });
    return {
      ok: !out.rejected,
      event_id: out.eventId,
      rejected: out.rejected ?? null,
    };
  }
}
