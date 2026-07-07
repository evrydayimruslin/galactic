// RPC Events Binding for Dynamic Workers
// Lets sandboxed app code emit pub/sub events WITHOUT the platform WORKER_SECRET
// ever entering the isolate. Identity (emitter app + user) and the hop ceiling
// come from the signed caller-context token, verified host-side here — exactly
// as the legacy /api/events/emit endpoint did — so sandbox JS cannot spoof the
// emitter, the user, or the hop. topic + payload are the only sandbox inputs.

import { WorkerEntrypoint } from "cloudflare:workers";
import { emitEvent } from "../../services/agent-events.ts";
import { verifyCallerContextToken } from "../../services/agent-caller-context.ts";
import { resolveExecutionContext } from "../../services/execution-context-registry.ts";

interface EventsBindingProps {
  // Signed X-Galactic-Caller token minted server-side for this execution. Set
  // host-side from RuntimeConfig.callerContextToken — never a sandbox input.
  // Kept as the legacy fresh-load fallback; the live token is resolved per-RPC
  // from the execution-context registry (the prop is frozen under warm reuse).
  callerContextToken: string;
  // Set for bindings loaded into a REUSABLE isolate (loader.get): emit() then
  // resolves the token ONLY from the registry, so a direct-binding bypass that
  // omits the handle can never emit under the stale frozen prop (whose baked
  // hop would defeat the hop ceiling).
  requireExecCtx?: boolean;
}

interface EmitResult {
  ok: boolean;
  event_id: string | null;
  rejected: "hop_exceeded" | "not_configured" | null;
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
    // Resolve the signed caller-context token per-RPC. Handle threaded — or
    // the binding loaded into a reusable isolate (props.requireExecCtx, which
    // also catches a direct-binding bypass omitting the handle) → the registry
    // ONLY: a warm-reused isolate's frozen prop carries call 1's hop, which
    // would defeat the hop ceiling. An unresolvable handle yields a null token
    // → the claims check below fails closed. Handle absent on a legacy
    // fresh-load binding → the prop, where they agree.
    const callerContextToken =
      execCtxHandle !== undefined || this.ctx.props.requireExecCtx
        ? (resolveExecutionContext(execCtxHandle)?.callerContextToken ?? null)
        : this.ctx.props.callerContextToken;
    // Identity + hop come from the VERIFIED signed token, never from sandbox
    // input — this is the same trust boundary the /api/events/emit endpoint used.
    const verified = await verifyCallerContextToken(callerContextToken);
    if (!verified.claims) {
      throw new Error("emit requires an authenticated user context");
    }
    const out = await emitEvent({
      userId: verified.claims.userId,
      emitterAppId: verified.claims.callerAppId,
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
