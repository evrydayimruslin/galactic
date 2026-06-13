# Interface Relaunch — PR Implementation Roadmap

Status: **PR1–PR6 IMPLEMENTED** (2026-06-12, commits `b4a005c` `89d10e7` `cc23741`
`56b466a` `4055628` + PR6). Remaining: deploy actions in RELEASE_RUNBOOK.md
("Interfaces Rollout") — staging smoke + demo-agent upload + production tag.
Design + decisions: `docs/INTERFACE_RELAUNCH_INVESTIGATION.md` (locked: multiple
interfaces via manifest `interfaces[]`; the other §8 items adopted as working
assumptions).
Pattern follows `docs/DURABLE_EXECUTION_ROADMAP.md`: six PRs, each independently landable and
gated; PR1–PR4 are user-invisible, PR5 flips the feature on, PR6 hardens and ships.

**One-line recap of the design:** developers upload static self-contained HTML files with their
app bundle; we copy each declared entry to a content-addressed R2 key; a new tiny sandbox Worker
serves them with a locked-down CSP; the agent page embeds them in an opaque-origin iframe; a
MessageChannel bridge forwards allowlisted function calls to the existing
`POST /api/launch/agents/:id/functions/:fn/run` (same path as the Functions playground). Renders
are free and Supabase-free; only function calls bill, via existing machinery.

---

## Cross-cutting invariants (hold in every PR)

- **I1 — Never serve bundle paths.** Uploaded bundles live at `apps/{appId}/{version}/…`
  (api/handlers/upload.ts:523,759,1000) and contain app source. The sandbox worker serves ONLY
  the dedicated `interfaces/{appId}/{sha256}.html` prefix, validated by regex before any R2 read.
- **I2 — Stored artifact = exactly what the developer uploaded.** No server-side script
  injection into interface HTML (the old widget runtime injected a bridge script; v2 instead
  documents a ~30-line handshake snippet developers paste in). Hash is computed over the
  uploaded bytes, so content-addressing stays honest.
- **I3 — `interfaces[]` must survive manifest regeneration** (the Phase-1 `external_functions`
  stripping trap, review-confirmed HIGH). Every PR touching the upload path keeps the
  carry-forward tests green.
- **I4 — The bridge is the only data path.** Sandbox CSP keeps `connect-src` at `'none'`
  (fallback from `default-src 'none'`); the parent page makes all API calls and enforces the
  manifest `functions` allowlist before forwarding.
- **I5 — No cookies, ever, on the sandbox origin.** No `Set-Cookie`, no auth, nothing worth
  stealing on that origin.
- **I6 — Kill switch stays single-point:** the facade omitting `interfaces[]` hides the feature
  everywhere (FE renders the tab only when the summary carries entries).
- **I7 — CF deploy gotchas** (learned on staging): no module-scope randomness (deploy error
  10021 — lazy-init); `Response.redirect()` headers are immutable — construct responses manually
  when setting header suites.

---

## PR1 — Contracts & manifest spine (invisible)

**Goal:** `interfaces[]` exists, validates, and survives regeneration. No facade/FE exposure.

- `shared/contracts/manifest.ts`: add to `AppManifest` (next to `external_functions`, ~line 32):
  ```ts
  interfaces?: InterfaceDeclaration[];
  // { id, label, description?, entry, functions: string[], min_height? }
  ```
  Keep `widgets?` untouched (dormant basin rule).
- New `validateManifestInterfaces()` modeled on `validateManifestExternalFunctions()`
  (manifest.ts:923–1010): ids unique/slug-safe; `entry` required, path-safe (no `..`, no leading
  `/`, must end `.html`); `functions` non-empty array of strings, warn (not error) on names
  absent from the manifest's own functions; `min_height` finite positive number if present.
  Wire into `validateAppManifest()` beside the widgets validator.
- Carry-forward: extend the preserve-list mechanism in
  `api/services/app-manifest-generation.ts:158–167` (generalize
  `carryForwardExternalFunctions()` → `carryForwardManifestFields()` or add a sibling) so
  `interfaces` survives weak AND full regeneration; tests follow
  `app-manifest-generation.test.ts:71–117`.
- Regenerate the types package: `node scripts/contracts/generate-types-package.mjs`
  (API CI gates on the artifact being current — add to local gate list).

**Tests:** validator unit tests (accept/reject matrix incl. traversal entries); carry-forward
survival; types artifact current.
**Gates:** `api: npm run test` + `npm run typecheck`, knip baseline, contract generator.
**Risk:** low; pure contracts. Size: S.

## PR2 — Upload pipeline + content-addressed R2 artifacts (invisible)

**Goal:** declared interface files are validated at upload and copied to the serving prefix.

- In the upload flows of `api/handlers/upload.ts` (the three storageKey sites: 523, 759, 1000 —
  factor a shared helper rather than triplicating), after manifest hydration
  (`hydrateManifestForSource()`, app-manifest-generation.ts:224):
  - For each `manifest.interfaces[i]`: entry file must exist among uploaded files; size ≤
    `INTERFACE_MAX_BYTES = 1 MiB` (new constant beside `MAX_UPLOAD_SIZE_BYTES`); reject with the
    existing `error()` response shape on violation (deploy fails loudly, not silently).
  - Compute sha256 of the bytes; write a copy to R2 key `interfaces/{appId}/{sha256}.html` via
    `r2Service.uploadFiles` (content-addressed ⇒ idempotent re-writes; unchanged interfaces keep
    the same URL across app versions ⇒ browser caches survive deploys).
  - Stamp the server-derived hash into the stored manifest entry (`interfaces[i].hash`) —
    developer-supplied `hash` values are ignored/overwritten.
- Garbage collection of orphaned `interfaces/` objects: explicitly deferred (storage is
  $0.015/GB-mo noise); recorded in the PR6 accepted-risks entry of LAUNCH_RELEASE_PACKET.md.

**Tests:** upload with valid interface → R2 copy + hash stamped; missing entry → 4xx; oversize →
4xx; re-upload identical file → same key, no error; regeneration keeps `interfaces` + hashes
(I3); a bundle WITHOUT interfaces is byte-identical in behavior to today.
**Gates:** full API suite (`npm run test:full`), typecheck, knip.
**Risk:** medium (touches the publish path) — mitigated by the no-interfaces no-op test. Size: M.

## PR3 — Sandbox worker (new 4th deployable, no consumers yet)

**Goal:** `ultralight-interfaces` Worker serving the `interfaces/` prefix with the full header
suite, deployed to staging+prod alongside the existing workers.

- New top-level `interfaces-worker/` modeled on `worker/wrangler.toml` (name, `main`,
  `compatibility_date`, R2 binding `R2_BUCKET` → `ultralight-apps`, `[env.staging]` mirroring
  api/wrangler.toml's env split). Vars: `FRAME_ANCESTORS` (prod = launch-web prod origin;
  staging adds staging origin + localhost:5173/5178 — same origin list discipline as
  `CORS_ALLOWED_ORIGINS`, api/wrangler.toml:83).
- Routes: `GET|HEAD /i/:appId/:hash` where `:appId` and `:hash` are strictly validated
  (`^[0-9a-f]{64}$` for hash; reject anything else before touching R2 — I1). Everything else →
  404/405. Root `/` → 204 or a one-line text response (no redirects needed).
- Response headers (exact, from investigation §4.2):
  `Content-Security-Policy: sandbox allow-scripts allow-forms; default-src 'none';
  script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; img-src data: blob: https:;
  font-src data: https:; form-action 'none'; frame-ancestors <FRAME_ANCESTORS>`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: public, max-age=31536000, immutable`,
  `Content-Type: text/html; charset=utf-8`. Never `Set-Cookie` (I5).
  (`img-src https:` technically allows GET-beacon exfil; accepted because the only data inside
  the frame is what the developer's own functions returned — record as an adversarial-review
  checklist item, PR6.)
- CI: dedicated `.github/workflows/interfaces-worker-deploy.yml` (not an api-deploy.yml job —
  api-deploy's path filter wouldn't trigger on interfaces-worker changes). Same gating: staging
  on `main` push, prod on `v*` tag, env-scoped `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`;
  verify job (typecheck + deno tests + dry-runs) also runs on PRs. Honor I7 gotchas.
- Smoke: `scripts/smoke/interface-serve-smoke.mjs` (pattern: durable-exec-smoke.mjs) — seeds a
  test object (or uses a fixture app's interface), asserts 200 + every security header + 404 on
  a forged path + 405 on POST.

**Tests:** worker unit tests for path validation + header suite; smoke against staging after
deploy.
**Gates:** worker typecheck wired into CI; smoke green on staging.
**Risk:** low (isolated deployable, nothing consumes it yet). Size: M.

## PR4 — Facade exposure (invisible until FE lands)

**Goal:** agent responses carry renderable interface descriptors.

- `shared/contracts/launch.ts`: new `LaunchInterfaceSummary
  { id, label, description?, url, functions: string[], minHeight? }`;
  `LaunchAgentSummary.interfaces?: LaunchInterfaceSummary[]` (insert in the 590–607 block; no
  deprecated alias needed — net-new field).
- `toLaunchAgentSummary()` (api/handlers/launch.ts:5309–5335): map `manifest.interfaces` →
  summaries; `url = ${INTERFACE_SANDBOX_BASE_URL}/i/{appId}/{hash}`; **omit entries missing a
  stamped hash** (pre-PR2 manifests degrade gracefully); intersect `functions` with the agent's
  actual manifest functions at response time (allowlist can't reference ghosts).
- New wrangler var `INTERFACE_SANDBOX_BASE_URL` (prod + staging) — the Phase-3 HIGH
  (configureUrl pointing at the wrong origin) says: make it explicit config, never derive from
  request Host.
- Anonymous access works by construction: `handleLaunchTool` resolves public agents without auth
  (`tryAuthenticate` → `resolvePublicLaunchTool`, launch.ts:3667–3669).
- OpenAPI: extend the agent response schema in `buildLaunchOpenApiSpec()` (launch.ts:764+).

**Tests** (api/handlers/launch.test.ts, `withLaunchEnv` harness): interfaces present iff
declared+hashed; URL shape pinned; ghost-function pruning; anonymous GET includes interfaces;
agents without interfaces → field absent (I6).
**Gates:** full API suite, typecheck, knip, contract generator, OpenAPI snapshot if tested.
**Risk:** low. Size: S–M.

## PR5 — Interface tab + bridge on launch-web (FEATURE VISIBLE)

**Goal:** the agent page renders interfaces and brokers function calls.

- `foundation-pages.tsx`: extend `AgentPageTabId` (line 397) with `"interface"`; tab appears in
  `AgentDetailSurface` (1223–1280) only when `agent.interfaces?.length` (I6); multiple
  interfaces → pill sub-tabs (house style per commit `9f25f59`).
- New `apps/launch-web/src/lib/interface-bridge.ts` + `AgentInterfaceSurface` component:
  - iframe `sandbox="allow-scripts allow-forms"`, `src = summary.url`, `allow=""` (no
    permissions-policy grants).
  - Handshake: frame posts `ul-interface-hello`; parent verifies
    `event.source === iframe.contentWindow` (origin checks are useless against an opaque
    origin), then transfers a `MessageChannel` port; ALL subsequent traffic on the port.
    Re-handshake on iframe reload; ignore duplicate hellos.
  - Port protocol (schema-validated, args size-capped ~64 KiB, rate-limited ~30 calls/min,
    ≤4 in flight):
    `call {id, functionName, args}` → parent checks allowlist (`summary.functions`) → existing
    `launchApi.runAgentFunction(tool.id, fn, { args })` (exactly the Functions-playground path,
    foundation-pages.tsx:1574 — inherits auth header, single-flight 401 refresh, error taxonomy)
    → reply `{id, success, result?, error?, receiptId?}`.
    `context` (pushed on connect): `{ agent: {id, slug, name}, signedIn, theme, minHeight }`.
    `resize {height}` → clamp 120–900px.
    Signed-out `call` → typed `{error: {type: "SIGN_IN_REQUIRED"}}` (render still works — only
    calls require a session).
  - Spend affordance in host chrome: per-function price from the existing functions data
    (`formatAgentPrice`, foundation-pages.tsx:1619) + cumulative credits-spent counter for the
    session.
- `apps/launch-web/public/_headers`: add the sandbox origin to the SPA CSP `frame-src`
  (NOT to `connect-src`; CORS_ALLOWED_ORIGINS unchanged — the sandbox origin never calls the
  API).
- States: loading skeleton, "interface failed to load" (sandbox 404 e.g. stale hash), empty.

**Tests/verification:** web typecheck + production build; staging deploy and manual run-through
with a fixture agent (signed-in call, signed-out SIGN_IN_REQUIRED, resize, two interfaces
switching, forged-message rejection via devtools).
**Gates:** launch-web typecheck/build, API suite untouched-green.
**Risk:** medium (new security-relevant FE surface) — adversarial review happens in PR6 before
any prod tag. Size: L (the biggest PR).

## PR6 — Hardening, metering, docs, release packet

**Goal:** ship-ready.

- **Adversarial review** (house pattern, multi-agent) with explicit checklist: escape from
  sandbox attr + CSP combo; direct-navigation behavior (CSP `sandbox` header must keep the doc
  inert); postMessage forgery from other frames/tabs; allowlist bypass (call a non-allowlisted
  function); img-src beacon exfil rationale re-verified; clickjacking via nested framing;
  phishing-shaped interfaces (fake login forms — `form-action 'none'` + no-network means
  credentials can only exit via the agent's own functions; document as accepted-with-rationale
  or add UI framing "developer content").
- **Metering (0-price):** log render/connect events — v1 = Workers analytics on the sandbox
  worker + a `console`/call-logger line on first bridge connect per surface. Do NOT wire
  `widget_pulls` receipts yet; the dormant basin (`widget_pulls_per_cloud_unit`,
  call-receipts.ts) is the upgrade path if charging ever starts. Decision recorded in
  investigation §6.
- **Developer docs:** `ultralight-spec/conventions/interfaces.md` — manifest examples, the
  handshake snippet (the ~30 lines an interface pastes to get `ul.call/ul.context/ul.resize`),
  limits (1 MiB, single file, no network, allowlist), versioning/caching semantics.
- **Demo:** ship one fixture/demo agent with a real interface (note: demo-app manifest gaps
  already chip-tracked — coordinate).
- **Release packet:** LAUNCH_RELEASE_PACKET.md row (accepted risks: img-src exfil rationale,
  GC deferral, no per-interface review queue) + RELEASE_RUNBOOK section (new worker first-deploy
  steps, INTERFACE_SANDBOX_BASE_URL secret/var setting, smoke command); legal note for /terms
  (user-generated content rendering) flagged for counsel.

**Gates:** everything green + review findings fixed with regression tests (house rule). Size: M.

---

## Rollout & rollback

- **Order:** PR1 → PR2 → PR3 → PR4 → PR5 → PR6, each landable alone; PR3 can go in parallel
  with PR2 (no dependency). Staging gets each automatically on `main` push (api-deploy.yml +
  launch-web-deploy.yml); production only on the next `v*` tag — confirm the tag pipeline
  includes the new interfaces-worker job before tagging.
- **Rollback:** any prod issue → facade stops emitting `interfaces[]` (one-line guard / env
  flag), which hides the tab everywhere (I6); the sandbox worker can stay up harmlessly
  (serves inert content on an origin nothing links to).
- **Definition of done:** staging smoke green (serve headers + bridge call round-trip), full
  suites green, adversarial review clean, demo agent interface usable signed-out (render) and
  signed-in (calls), release packet updated.

## Deferred (explicitly out of v1)

- `render_function` dynamic interfaces (old model, opt-in later).
- Agentic layer (state snapshots / actions / composer — basin dormant).
- Vanity usercontent domain (slot-in replacement for the workers.dev origin).
- R2 orphan GC; per-interface review queue; `widget_pulls`-based charging (knob exists).
