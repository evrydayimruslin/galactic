#!/usr/bin/env node
// Secrets preflight — probes a DEPLOYED worker for secret-dependent behavior, so
// you catch a missing/wrong secret before running the full G1 smoke (which is
// slower and noisier). It can't read Cloudflare's encrypted secrets directly, so
// it infers health from endpoints that fail in a recognizable way when a secret
// is absent. Run it against staging first, then production.
//
// Usage:
//   node scripts/ops/verify-secrets.mjs --target staging --token <ul_ api token>
//   node scripts/ops/verify-secrets.mjs --target production --token <ul_ api token>
//
// Exit 0 = all critical probes OK · 1 = a critical probe failed.
// Stripe checkout itself is verified through an authenticated browser session.

import { parseArgs } from "../analysis/_shared.mjs";

const args = parseArgs(process.argv.slice(2));
const target = String(args.get("--target") || "staging").trim().toLowerCase();
const apiBase = String(
  args.get("--url") || process.env.ULTRALIGHT_API_URL ||
    (target === "production"
      ? "https://api.connectgalactic.com"
      : "https://ultralight-api-staging.rgn4jz429m.workers.dev"),
).replace(/\/$/, "");
const token = String(args.get("--token") || process.env.ULTRALIGHT_TOKEN || "").trim();

const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
const rows = [];
function record(name, status, implies, detail = "") {
  rows.push({ name, status, implies, detail });
  const tag = status === "OK" ? "OK   " : status === "WARN" ? "WARN " : status === "SKIP" ? "SKIP " : "FAIL ";
  console.log(`[${tag}] ${name.padEnd(26)} ${implies}${detail ? `  — ${detail}` : ""}`);
}
async function get(path, headers = {}) {
  try {
    const res = await fetch(`${apiBase}${path}`, { headers });
    let body = null;
    try { body = await res.json(); } catch { /* non-json */ }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, error: String(err?.message || err) };
  }
}

console.log(`Secrets preflight — ${target} — ${apiBase}\n`);

// 1. Worker boots at all.
{
  const r = await get("/health");
  record("/health", r.status === 200 ? "OK" : "FAIL", "worker boots + routes", r.status === 200 ? "" : `status ${r.status}${r.error ? ` (${r.error})` : ""}`);
}
// 2. Supabase reachable (SUPABASE_URL + service/anon keys).
{
  const r = await get("/api/discover/status");
  record("/api/discover/status", r.status === 200 ? "OK" : "FAIL", "SUPABASE_URL + keys", r.status === 200 ? "" : `status ${r.status}`);
}
// 3. Auth works end-to-end with the token (Supabase keys + a valid token).
if (token) {
  const r = await get("/auth/user", authHeaders);
  const ok = r.status === 200 && !!r.body?.email;
  record("/auth/user", ok ? "OK" : "FAIL", "auth + token valid", ok ? r.body.email : `status ${r.status}`);
} else {
  record("/auth/user", "SKIP", "auth (needs --token)", "");
}
// 4. BYOK-only launch projection. A platform inference route is intentionally
//    not required: each account supplies its own provider key.
if (token) {
  const r = await get("/api/launch/inference-options", authHeaders);
  const projectionOk = r.status === 200 && r.body?.billingMode === "byok" &&
    !Object.prototype.hasOwnProperty.call(r.body || {}, "credits") &&
    !Object.prototype.hasOwnProperty.call(r.body || {}, "platformModel");
  // BYOK configuration is intentionally an account-session surface: connected
  // Agent keys may build and operate Agents, but may not read or change the
  // owner's provider credentials. CI normally uses a connected key, so a 403
  // is the expected security boundary; the authenticated browser journey owns
  // the customer-facing projection assertion.
  const accountBoundaryOk = r.status === 403 &&
    /account session/i.test(String(r.body?.error || r.body?.message || ""));
  const ok = projectionOk || accountBoundaryOk;
  record(
    "BYOK launch inference",
    ok ? "OK" : "FAIL",
    projectionOk
      ? "billingMode=byok; no credits/platform model"
      : "connected key blocked; browser session owns BYOK projection",
    ok ? "" : `status ${r.status}`,
  );
} else {
  record("BYOK launch inference", "SKIP", "inference projection (needs --token)", "");
}
// 5. Subscription/capacity projection. Checkout and portal require a browser
//    account session and are exercised in the canonical-journey run.
if (token) {
  const subscription = await get("/api/launch/subscription", authHeaders);
  const capacity = await get("/api/launch/capacity", authHeaders);
  const ok = subscription.status === 200 && capacity.status === 200 &&
    ["free", "pro", "max_5x", "max_10x"].includes(subscription.body?.plan) &&
    ["available", "low", "waiting"].includes(capacity.body?.state);
  record("subscription capacity", ok ? "OK" : "FAIL", "Stripe projection + capacity RPC", ok ? `${subscription.body.plan}/${capacity.body.state}` : `statuses ${subscription.status}/${capacity.status}`);
} else {
  record("subscription capacity", "SKIP", "subscription projection (needs --token)", "");
}

const failed = rows.filter((r) => r.status === "FAIL");
console.log("");
if (failed.length) {
  console.error(`Secrets preflight: ${failed.length} CRITICAL probe(s) failed: ${failed.map((r) => r.name).join(", ")}`);
  console.error("→ A failing critical probe usually means a missing/wrong Worker secret. Fix before the G1 smoke.");
  process.exit(1);
}
console.log("Secrets preflight: all critical launch probes OK.");
