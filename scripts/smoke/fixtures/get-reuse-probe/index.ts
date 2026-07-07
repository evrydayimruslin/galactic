// get()-reuse isolation probe fixture. Driven by
// scripts/smoke/get-reuse-isolation-smoke.mjs.
//
// Reuse-ELIGIBLE by construction: storage only, NO cross-Agent calls (no
// app:call / dependencies / slots), so under EXECUTED_LOADER_GET_REUSE=1 it runs
// on the warm-isolate (loader.get) path. Every function is a probe for one
// invariant the staging smoke asserts.

// deno-lint-ignore no-explicit-any
const g = globalThis as any;
const galactic = g.galactic ?? g.ultralight;

// Module-level state. Under loader.load() every call gets a FRESH isolate, so
// this is always 0 -> 1. Under loader.get() warm reuse it PERSISTS across calls
// for the same (app, user) — the observable signal that reuse actually happened
// (the economic claim: ~1 load per (app-version, user)/day).
let moduleCallCount = 0;

export function reuseProbe() {
  moduleCallCount += 1;
  return { callCount: moduleCallCount, warm: moduleCallCount > 1 };
}

// Proves per-call args flow through the fetch body correctly even on a warm
// isolate: the baked module content is call-independent, so `value` can only be
// coming from the per-request body. A stale/echoed value here would mean the
// warm isolate served a previous call's args.
export function echo(args: { value?: unknown }) {
  return { value: args?.value ?? null };
}

// Per-user data round-trip. galactic.store/load scope by userId HOST-SIDE, and
// the reuse key pins userId, so user B must NEVER read user A's value even if a
// warm isolate were (wrongly) shared across users.
export async function storeMine(args: { value?: string }) {
  await galactic.store("reuse_probe_secret", String(args?.value ?? ""));
  return { ok: true };
}
export async function readMine() {
  const value = await galactic.load("reuse_probe_secret");
  return { value: value ?? null };
}

// Direct-binding bypass: call the RPC binding WITHOUT the SDK's per-call context
// handle. On a reusable isolate (props.requireExecCtx=true) this MUST be REFUSED
// (fail closed) so app code cannot skip the handle and ride stale frozen billing
// props under warm reuse. Under load() (flag off / ineligible) it would instead
// succeed against fresh props — so `refused:true` is itself a signal the reuse
// path is active.
export async function directBypass() {
  try {
    const env = g.__rpcEnv;
    if (!env || !env.DATA) return { refused: false, reason: "no DATA binding" };
    await env.DATA.store("reuse_probe_bypass", "x"); // note: no handle argument
    return { refused: false };
  } catch (err) {
    return {
      refused: true,
      error: String((err && (err as Error).message) || err),
    };
  }
}
