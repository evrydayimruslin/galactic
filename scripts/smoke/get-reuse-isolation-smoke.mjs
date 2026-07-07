#!/usr/bin/env node
// Staging smoke for Worker Loader get() warm-isolate reuse (Stage 4 = PROD GATE
// for EXECUTED_LOADER_GET_REUSE). Run AGAINST STAGING, which has the flag ON.
//
// Prereqs (owner):
//   1. Deploy the probe fixture (scripts/smoke/fixtures/get-reuse-probe) PRIVATE
//      to the staging account; note its app id.
//   2. Two staging user bearer tokens (distinct users A and B).
//   3. Staging API worker running the get()-reuse branch with
//      EXECUTED_LOADER_GET_REUSE=1 (set in [env.staging.vars]).
//
//   ULTRALIGHT_API_URL=https://ultralight-api-staging.<acct>.workers.dev \
//   PROBE_APP_ID=<deployed probe app id> \
//   USER_A_TOKEN=<staging bearer, user A> \
//   USER_B_TOKEN=<staging bearer, user B> \
//   node scripts/smoke/get-reuse-isolation-smoke.mjs
//
// Exit 0 = all gates pass. Non-zero = a SECURITY gate failed (isolation broken)
// or the ECONOMIC gate failed (warm reuse never observed). The two are reported
// distinctly so the operator knows whether to BLOCK the prod flip (security) or
// investigate reuse not engaging (economic).

const API = (process.env.ULTRALIGHT_API_URL || process.env.API_BASE || "")
  .replace(/\/$/, "");
const APP_ID = process.env.PROBE_APP_ID || "";
const USER_A = process.env.USER_A_TOKEN || "";
const USER_B = process.env.USER_B_TOKEN || "";

if (!API || !APP_ID || !USER_A || !USER_B) {
  console.error(
    "Set ULTRALIGHT_API_URL, PROBE_APP_ID, USER_A_TOKEN, USER_B_TOKEN",
  );
  process.exit(2);
}

let securityFail = 0;
let economicFail = 0;
let pass = 0;
function gate(kind, name, ok, detail = "") {
  const tag = ok ? "PASS" : `FAIL[${kind}]`;
  console.log(`${tag}  ${name}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else if (kind === "security") securityFail++;
  else economicFail++;
}

async function mcp(token, method, params) {
  const res = await fetch(`${API}/mcp/${encodeURIComponent(APP_ID)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} non-JSON: ${text.slice(0, 300)}`);
  }
  return body;
}

let toolNames = [];
function resolveTool(fn) {
  return (
    toolNames.find((n) => n === fn) ||
    toolNames.find((n) => n.endsWith(`_${fn}`)) ||
    toolNames.find((n) => n.endsWith(fn)) ||
    fn
  );
}

// Returns the tool's structured result, or throws on a JSON-RPC / tool error.
async function call(token, fn, args = {}) {
  const body = await mcp(token, "tools/call", {
    name: resolveTool(fn),
    arguments: args,
  });
  if (body?.error) {
    throw new Error(body.error.message || JSON.stringify(body.error));
  }
  const r = body?.result;
  if (r?.isError) throw new Error(r.content?.[0]?.text || "tool error");
  if (r?.structuredContent !== undefined) return r.structuredContent;
  const txt = r?.content?.[0]?.text;
  try {
    return txt ? JSON.parse(txt) : r;
  } catch {
    return { text: txt };
  }
}

async function main() {
  // Resolve advertised tool names (slug-prefixed convention).
  const list = await mcp(USER_A, "tools/list", {});
  toolNames = (list?.result?.tools || []).map((t) => t.name);
  if (!toolNames.length) {
    console.error(
      `No tools advertised for app ${APP_ID}. Is the probe fixture deployed and private to user A?`,
    );
    process.exit(2);
  }

  // ── ECONOMIC GATE: warm reuse actually happens ──
  // Fire rapid sequential reuseProbe() calls as ONE user; a warm isolate makes
  // the module counter persist (warm=true). CF get() caching is best-effort and
  // an isolate can be evicted between calls, so to cut transient false-fails we
  // run TWO bursts and pass if EITHER shows a warm hit; the rate is reported.
  async function burst(token, n) {
    let warm = 0;
    let maxCount = 0;
    for (let i = 0; i < n; i++) {
      const r = await call(token, "reuseProbe");
      if (r?.warm) warm++;
      if (typeof r?.callCount === "number") {
        maxCount = Math.max(maxCount, r.callCount);
      }
    }
    return { warm, maxCount };
  }
  const BURST = 10;
  const b1 = await burst(USER_A, BURST);
  const b2 = b1.warm > 0 ? b1 : await burst(USER_A, BURST);
  const warmHits = Math.max(b1.warm, b2.warm);
  const maxCount = Math.max(b1.maxCount, b2.maxCount);
  gate(
    "economic",
    "warm reuse observed (loader.get is caching isolates)",
    warmHits > 0,
    `${warmHits} warm hits across bursts, max module callCount=${maxCount}` +
      (warmHits === 0
        ? " — reuse NOT engaging across 2 bursts (flag off? get() not caching?)"
        : ""),
  );

  // ── SECURITY GATE 1: per-call args are correct on a (likely warm) isolate ──
  const v1 = await call(USER_A, "echo", { value: "alpha-" + Date.now() });
  const want1 = v1?.value;
  const e1 = await call(USER_A, "echo", { value: "beta-marker" });
  const e2 = await call(USER_A, "echo", { value: "gamma-marker" });
  gate(
    "security",
    "per-call args correct under reuse (no stale/echoed body)",
    e1?.value === "beta-marker" && e2?.value === "gamma-marker" &&
      want1 !== undefined,
    `got "${e1?.value}", "${e2?.value}"`,
  );

  // ── SECURITY GATE 2: cross-user data isolation under reuse ──
  // Make the isolation claim against DEMONSTRABLY WARM isolates for BOTH users,
  // and assert POSITIVELY (each user reads back its OWN distinct sentinel) so a
  // missing/undefined value FAILS closed rather than passing on mere inequality.
  const warmA = await call(USER_A, "reuseProbe");
  const warmB = await call(USER_B, "reuseProbe");
  gate(
    "security",
    "both users on a warm-reused isolate before the isolation check",
    warmA?.warm === true && warmB?.warm === true,
    `A.warm=${warmA?.warm} B.warm=${warmB?.warm}` +
      (warmA?.warm && warmB?.warm ? "" : " — not both warm; isolation claim would be vacuous"),
  );

  const secretA = "A-SECRET-" + Date.now();
  const sentinelB = "B-SENTINEL-" + Date.now();
  await call(USER_A, "storeMine", { value: secretA });
  await call(USER_B, "storeMine", { value: sentinelB });
  const bRead = await call(USER_B, "readMine");
  const aRead = await call(USER_A, "readMine");
  // B must read back EXACTLY its own sentinel (positive) and NOT A's secret. A
  // malformed/undefined value fails both halves → gate FAILS (fail-closed).
  gate(
    "security",
    "user B reads its OWN value, never user A's (warm isolate never shared across users)",
    bRead?.value === sentinelB && bRead?.value !== secretA,
    `B read: ${JSON.stringify(bRead?.value)}`,
  );
  gate(
    "security",
    "user A still reads its OWN data (per-user isolate intact)",
    aRead?.value === secretA,
    `A read: ${JSON.stringify(aRead?.value)}`,
  );

  // ── SECURITY GATE 3: direct-binding bypass is refused (fail closed) ──
  // storeMine above already proved R2 is healthy for user A (a handle-BEARING
  // write succeeded), so a throw from the handle-LESS raw call below is
  // attributable to the requireExecCtx guard, not infra. We still require the
  // error to be the GUARD's message ("Execution context required") so an
  // unrelated throw can't score a false "refused".
  const bypass = await call(USER_A, "directBypass");
  if (bypass?.reason === "no DATA binding") {
    // Probe declares storage:read/write, so DATA must be wired — its absence is
    // a setup fault, not an isolation regression. Bail as a setup error.
    console.error(
      "SETUP ERROR: probe reports 'no DATA binding' — storage perms/binding not " +
        "wired on the deployed fixture. Fix deployment and re-run.",
    );
    process.exit(2);
  }
  const guardRefused = bypass?.refused === true &&
    /execution context required/i.test(String(bypass?.error || ""));
  gate(
    "security",
    "handle-less direct binding call is refused by the requireExecCtx guard (fail-closed)",
    guardRefused,
    bypass?.refused
      ? `error: ${String(bypass.error).slice(0, 100)}`
      : "NOT refused — bypass open (flag off, or requireExecCtx not wired)",
  );

  console.log(
    `\n${pass} passed, ${securityFail} security-fail, ${economicFail} economic-fail`,
  );
  if (securityFail > 0) {
    console.log(
      "\n>>> BLOCK THE PROD FLIP: a get()-reuse ISOLATION invariant failed.",
    );
  } else if (economicFail > 0) {
    console.log(
      "\n>>> Security gates passed but warm reuse was never observed — investigate " +
        "before flipping prod (the flip would be safe but yield no cost savings).",
    );
  } else {
    console.log(
      "\n>>> All gates green. Safe to soak, then flip EXECUTED_LOADER_GET_REUSE=1 in prod [vars].",
    );
  }
  process.exit(securityFail > 0 || economicFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke error:", err?.message || err);
  process.exit(2);
});
