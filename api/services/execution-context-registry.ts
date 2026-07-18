// Parent-side registry of per-EXECUTION billing context, resolved by an
// unforgeable handle. This is the foundation of safe warm-isolate reuse
// (loader.get()): Cloudflare caches the isolate INCLUDING its env bindings,
// frozen at load, so per-execution values (executionId, the cloud-operation
// metering context with receiptId/holdId/payerUserId) MUST NOT be baked into
// binding props — a warm hit would serve call N under call 1's context (free
// inference, debits against a settled hold).
//
// Instead the parent registers the per-call context here before the loader
// fetch and hands the sandbox only an OPAQUE HANDLE (a 128-bit random id,
// distinct from executionId). The sandbox echoes the handle on each binding
// RPC; the binding resolves it here. Safety:
//   - UNFORGEABLE: the handle is cryptographically random and single-execution;
//     a tenant can only echo the handle it was given (its own). An unknown
//     handle resolves to null → the binding FAILS CLOSED (no debit).
//   - payerUserId / receiptId NEVER enter the sandbox (they live only here).
//   - CONCURRENCY-SAFE: resolve() is a synchronous in-memory read; register /
//     resolve / deregister never yield, so there is no TOCTOU window with the
//     deregister that runs in the execution's finally.
//
// Modeled on ai-spend-tracker.ts (same lifecycle + bounded TTL sweep backstop).

import type { RuntimeConfig } from "../runtime/sandbox.ts";
import type { RoutineTraceContext } from "./routine-trace.ts";

export interface ExecutionContextEntry {
  /** Opaque settlement receipt used only to correlate this host RPC's CPU. */
  capacityReceiptId?: string | null;
  /** The execution id the AI-spend ledger (ai-spend-tracker.ts) is keyed by. */
  aiExecutionId: string | null;
  /**
   * App + entry-function attribution for this execution's billing rows
   * (debit_light p_app_id/p_function_name, ai_usage_events). functionName is
   * per-CALL, so like the metering context it must resolve per-RPC — a warm
   * isolate's frozen props would attribute call N's spend to call 1's function.
   */
  appId: string | null;
  functionName: string | null;
  /** Per-call cloud-operation metering (receiptId/holdId/payerUserId/...). */
  cloudOperationMetering: RuntimeConfig["cloudOperationMetering"];
  cloudOperationBillingConfig: RuntimeConfig["cloudOperationBillingConfig"];
  /**
   * The signed caller-context token this execution emits pub/sub events under.
   * It bakes in the per-call entry function + incoming hop, so — like the
   * metering context — it MUST be resolved per-RPC, never read from a warm
   * isolate's frozen props (a stale hop would defeat the hop ceiling).
   */
  callerContextToken: string | null;
  /** Server-authenticated routine identity for per-AI-call budget admission. */
  routineContext?: RoutineTraceContext | null;
  /**
   * Absolute host deadline for this execution. Provider bindings use the
   * remaining budget across all attempts, so a fallback can never outlive the
   * sandbox that requested it. Per-call because warm isolates reuse bindings.
   */
  executionDeadlineAtMs?: number | null;
}

const registry = new Map<string, ExecutionContextEntry & { at: number }>();

// Executions are short-lived and deregister in a finally, so the TTL only
// backstops a handle stranded by an unhandled parent throw before finally. Set
// well above the longest async/batch/routine execution (which can exceed the
// 30s default sandbox timeout) so a still-running execution's handle never
// expires out from under it.
const ENTRY_TTL_MS = 30 * 60 * 1000;
const SWEEP_THRESHOLD = 1_000;

/**
 * Register a per-execution context and return its opaque handle. Call before the
 * loader fetch; pass the handle into the sandbox (never the context itself).
 */
export function registerExecutionContext(
  entry: ExecutionContextEntry,
): string {
  if (registry.size >= SWEEP_THRESHOLD) sweep();
  const handle = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
  registry.set(handle, { ...entry, at: Date.now() });
  return handle;
}

/**
 * Resolve a handle to its context. Synchronous by contract (no await) so there
 * is no yield between resolve and use vs a concurrent deregister. Returns null
 * for an unknown / already-deregistered handle → callers FAIL CLOSED.
 */
export function resolveExecutionContext(
  handle: string | null | undefined,
): ExecutionContextEntry | null {
  if (!handle) return null;
  const entry = registry.get(handle);
  if (!entry) return null;
  if (entry.capacityReceiptId) {
    // Each ctx.exports/Service Binding invocation is a distinct TailItem. Mark
    // it with the owning execution so CPU remains attributable even when one
    // top-level request contains several nested Agent calls/receipts.
    console.log(
      `GALACTIC_CAPACITY_EXECUTION_V1 ${
        JSON.stringify({ receipt_id: entry.capacityReceiptId })
      }`,
    );
  }
  return {
    capacityReceiptId: entry.capacityReceiptId ?? null,
    aiExecutionId: entry.aiExecutionId,
    appId: entry.appId,
    functionName: entry.functionName,
    cloudOperationMetering: entry.cloudOperationMetering,
    cloudOperationBillingConfig: entry.cloudOperationBillingConfig,
    callerContextToken: entry.callerContextToken,
    routineContext: entry.routineContext ?? null,
    executionDeadlineAtMs: entry.executionDeadlineAtMs ?? null,
  };
}

/** Remove a handle. MUST run in the execution's finally (success + error). */
export function deregisterExecutionContext(
  handle: string | null | undefined,
): void {
  if (!handle) return;
  registry.delete(handle);
}

/**
 * Fail-closed guard for bindings loaded into a REUSABLE isolate
 * (props.requireExecCtx). Sandbox code can bypass the SDK and call a binding
 * on globalThis.__rpcEnv directly, omitting the handle — under warm reuse that
 * must refuse the OPERATION (not silently fall back to the props frozen at
 * first load, which would meter against a stale, possibly settled hold).
 * No-op when `required` is falsy (fresh-load / legacy paths keep today's
 * behavior). Throws unless the handle resolves to a live execution context.
 */
export function assertExecutionContext(
  handle: string | null | undefined,
  required: boolean | undefined,
): void {
  if (!required) return;
  if (typeof handle !== "string" || !resolveExecutionContext(handle)) {
    throw new Error(
      "Execution context required: this operation must carry the current " +
        "execution's context handle (missing, expired, or unknown). " +
        "Use the galactic.* SDK methods rather than calling bindings directly.",
    );
  }
}

/** Test-only: current entry count. */
export function _executionContextRegistrySize(): number {
  return registry.size;
}

function sweep(): void {
  const cutoff = Date.now() - ENTRY_TTL_MS;
  for (const [key, entry] of registry) {
    if (entry.at < cutoff) registry.delete(key);
  }
}
