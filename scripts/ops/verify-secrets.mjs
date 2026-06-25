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
// Stripe is reported but NOT failed on (you're intentionally on TEST keys).

import { parseArgs } from "../analysis/_shared.mjs";

const args = parseArgs(process.argv.slice(2));
const target = String(args.get("--target") || "staging").trim().toLowerCase();
const apiBase = String(
  args.get("--url") || process.env.ULTRALIGHT_API_URL ||
    (target === "production"
      ? "https://api.ultralightagent.com"
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
// 3. Inference catalog present (OPENROUTER_API_KEY / provider config).
{
  const r = await get("/chat/models");
  const ok = r.status === 200 && Array.isArray(r.body?.models) && r.body.models.length > 0;
  record("/chat/models", ok ? "OK" : "FAIL", "OPENROUTER_API_KEY / models", ok ? `${r.body.models.length} models` : `status ${r.status}`);
}
// 4. Auth works end-to-end with the token (Supabase keys + a valid token).
if (token) {
  const r = await get("/auth/user", authHeaders);
  const ok = r.status === 200 && !!r.body?.email;
  record("/auth/user", ok ? "OK" : "FAIL", "auth + token valid", ok ? r.body.email : `status ${r.status}`);
} else {
  record("/auth/user", "SKIP", "auth (needs --token)", "");
}
// 5. CRITICAL: platform inference actually ROUTES (not just "models list").
//    /chat/models loading is necessary but NOT sufficient — a key can be present
//    yet unusable (legacy-plaintext entry, missing DeepSeek key, etc.). The
//    authoritative signal is chat-preflight.ok for the DEFAULT model.
if (token) {
  const r = await get("/debug/chat-preflight", authHeaders);
  if (r.status === 200 && r.body?.ok === true) {
    record("inference route (default model)", "OK", "platform AI routes", `${r.body?.model || ""} → ${r.body?.route?.upstream_provider || "?"}`);
  } else {
    const failed = Array.isArray(r.body?.checks)
      ? r.body.checks.filter((c) => c && c.ok === false).map((c) => `${c.check}: ${c.result || ""}`)
      : [];
    record("inference route (default model)", "FAIL", "platform AI is BROKEN",
      failed.length ? failed.join("  |  ") : `status ${r.status}`);
  }
} else {
  record("inference route (default model)", "SKIP", "inference (needs --token)", "");
}
// 6. Stripe — WARN/SKIP only (test keys are expected; wallet route is session-gated).
if (token) {
  const r = await get("/api/launch/wallet/topup/quote?amount_credits=2500&method=card", authHeaders);
  if (r.status === 200) {
    record("Stripe top-up quote", "OK", "STRIPE_* configured", "responds — verify TEST vs LIVE in the Stripe dashboard");
  } else if (r.status === 503) {
    record("Stripe top-up quote", "WARN", "STRIPE_* MISSING", "503 not-configured — top-ups will not work");
  } else if (r.status === 403) {
    record("Stripe top-up quote", "SKIP", "Stripe (session-gated)", "wallet route needs a browser session — verify keys via the Stripe/Cloudflare dashboard");
  } else {
    record("Stripe top-up quote", "WARN", "STRIPE_* (unclear)", `status ${r.status}`);
  }
} else {
  record("Stripe top-up quote", "SKIP", "Stripe (needs --token)", "");
}

const failed = rows.filter((r) => r.status === "FAIL");
console.log("");
if (failed.length) {
  console.error(`Secrets preflight: ${failed.length} CRITICAL probe(s) failed: ${failed.map((r) => r.name).join(", ")}`);
  console.error("→ A failing critical probe usually means a missing/wrong Worker secret. Fix before the G1 smoke.");
  process.exit(1);
}
console.log("Secrets preflight: all critical probes OK (Stripe is informational — test keys expected).");
