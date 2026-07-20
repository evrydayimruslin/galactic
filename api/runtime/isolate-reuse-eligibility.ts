// Single source of truth for "may this execution run in a warm-reused isolate?"
// (Worker Loader get()). Kept in its own dependency-light module so BOTH the
// runtime (dynamic-sandbox.ts, which flips load()->get()) AND billing
// (handlers deciding the per-day load-floor dedup) import the SAME predicate.
// A divergent copy is a money bug: if billing thinks an execution is reuse-
// eligible when the runtime keeps it on load(), Cloudflare bills the load fee
// per call but the per-day dedup under-charges.

import type { RuntimeConfig } from "./sandbox.ts";
import { COMPUTE_EXEC_PERMISSION } from "../../shared/contracts/compute.ts";

// ANONYMOUS_USER_ID (request-caller-context.ts) inlined to avoid an import cycle.
const ANON_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Whether this execution may run in a warm-reused isolate at all (independent
 * of the EXECUTED_LOADER_GET_REUSE rollout flag).
 *  - Anonymous callers NEVER reuse: the anon sentinel is a SHARED user id, so a
 *    warm isolate would persist app module-level state across DIFFERENT
 *    anonymous end-users — a cross-tenant leak.
 *  - Fixture-backed executions (gx.test) NEVER reuse: d1Fixtures are per-call
 *    data baked into FixtureDatabaseBinding props, so a warm isolate would
 *    serve one test's fixtures to the next.
 *  - Cross-Agent-CALL-capable executions NEVER reuse: ultralight.call sets the
 *    X-Galactic-Caller header from a per-call token read at call time from the
 *    shared-globalThis request payload. A warm isolate serves CONCURRENT
 *    executions of the same (app,user) through that shared globalThis, so a
 *    sibling could overwrite the token and let a deep-chain call present a
 *    shallow-hop identity — defeating MAX_AGENT_CALL_HOP_DEPTH (runaway
 *    recursion) and function-scoped grants. There is no per-async-context store
 *    in the sandbox (no AsyncLocalStorage), so the only sound fix today is to
 *    keep these on load(). Call-capability includes GRANT-resolved dependencies
 *    and wired slots (appCallDependencies / slotBindings) — NOT just the
 *    manifest — because a user can wire a call grant onto a manifest-clean app.
 *  - Compute-capable executions NEVER reuse: the compatibility SDK carries its
 *    opaque parent execution handle on writable globalThis state. A warm
 *    isolate could otherwise retain another function's handle and borrow that
 *    function's server-derived Compute identity. Keeping this decision in the
 *    shared predicate also prevents billing from applying the per-day Loader
 *    floor while the runtime actually creates a fresh isolate per call.
 */
export function isolateReuseEligibility(
  config: Pick<
    RuntimeConfig,
    "userId" | "d1Fixtures" | "permissions" | "appCallDependencies" | "slotBindings"
  >,
): { eligible: boolean; reason: string } {
  if (!config.userId || config.userId === ANON_USER_ID) {
    return { eligible: false, reason: "anonymous_user" };
  }
  if (config.d1Fixtures) {
    return { eligible: false, reason: "fixture_execution" };
  }
  if (config.permissions?.includes(COMPUTE_EXEC_PERMISSION)) {
    return { eligible: false, reason: "compute_capable" };
  }
  if (
    config.permissions?.includes("app:call") ||
    (config.appCallDependencies?.length ?? 0) > 0 ||
    (config.slotBindings?.length ?? 0) > 0
  ) {
    return { eligible: false, reason: "cross_agent_call_capable" };
  }
  return { eligible: true, reason: "ok" };
}
