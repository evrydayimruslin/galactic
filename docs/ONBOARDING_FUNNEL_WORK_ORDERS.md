# Onboarding Funnel — Work Orders

**Status:** Draft for owner review · **Baseline:** `main @ fc3ceee` (2026-08-03, post PR #206, v0.4.93 — pillar P0–P6 complete)
**Builder:** Claude Code sessions, one branch/PR per work order (this stream owns WO-F5; the pillar session is wound down)
**Companions:** `docs/AGENT_STUDIO_LAUNCH_WORK_ORDERS.md` (conventions + landed WOs), `docs/POLICY_PILLAR_ARCHITECTURE.md` (gate/envelope invariants this stream must not weaken)

This document is a living plan. Each landed PR updates the status table and,
where implementation diverged, the order itself. Line references are anchors
verified at the baseline commit; re-locate by symbol, not line number.

---

## North star

A stranger reaches their first **"Held by your policy"** card in under ten
minutes, on either surface (website or terminal), without an account and
without paying. Deployment is an *escalation of the policy*, not the product
moment. Payment sits at the resume: **hold free, resume paid.**

The funnel, end-state:

1. Homepage hero (or docs/tweet): copy `npx galacticconnection new "chase overdue invoices"`.
2. Plan echoed back + one policy seed: *"it must ask me before ___"* (pre-filled, skippable).
3. Their coding agent builds from the universal scaffold, attaches the starter
   policy via `gx.policy`, uploads, exact-tests. Terminal and pairing page
   (`/b/:code`) mirror the session ledger stages.
4. **Run it once** → the exact-tested candidate runs through *live* dispatch in
   the trial execution context → the gate holds at the guarded consequence
   group → the card: *"Held by your policy. Approve · Edit · Reject."* Real
   envelope; zero real-world effects; nothing paid.
5. Approve → checkout (Stripe Link OTP one-click when the email is known) →
   membership → resume fires the action → receipt.
6. Setup checklist: BYOK model key, explicit deploy confirm, activate;
   `galacticconnection login` (device grant) upgrades the CLI to a `gx_` key.

Members short-circuit: `new` under a session claims straight into the fleet,
no checkout, same card. Deny/Edit are free forever.

**KPI: time-to-first-held-card.** Every stage emits a funnel event from day one.

---

## Status

| WO | Title | Depends on | Est. | Status |
|----|-------|-----------|------|--------|
| WO-F1 | Anonymous claimable handoff + pairing page + hero | — | 2 PRs | **PR A built** (API + migration: provisional owners, anonymous mint, stages-only pairing read, atomic claim RPC, reaper). Divergences from the original order, adopted: (1) pairing lives in a dedicated `funnel_sessions` table keyed by pairing code — not columns on `builder_handoff_sessions` — so the code survives `resume` re-mints (the funnel row swaps its `handoff_session_id`); (2) the reaper runs opportunistically at mint (bounded batch of 25, failure-silent) instead of a cron — same semantics, zero new scheduled infrastructure, promotable to cron later. PR B (pairing page + hero) next. |
| WO-F2 | `galacticconnection new` | WO-F1 | 1–2 PRs | planned |
| WO-F3 | Checkout at the card + claim consolidation | WO-F1 | 1–2 PRs | planned |
| WO-F4 | Device authorization grant → `gx_` keys | — | 1 PR | planned |
| WO-F5 | Policy lane: `gx.policy`, starter policy, trial execution context | WO-F1 (envelope re-parenting) | 2–3 PRs | planned |

Recommended order: **F1 → F2 + F5 in parallel → F3 → F4.** F1 is the shared
spine (the only migration). F5's `gx.policy` + scaffold PR can start alongside
F1; its trial-context PR needs F1's provisional owner.

---

## Decision register (final, 2026-08-03)

1. **Trial ≠ membership trial.** The trial lane is run-until-held: no routines,
   no schedules, no activation, N runs per session. Resumes are the scarce
   unit, not minutes. Function scoping via a locked overlay (guarded = ask,
   consequential = off, reads = free) + a dispatch allowlist.
2. **Door (b).** Pre-member live-gate runs use a **trial execution context**
   over the exact-tested candidate — live dispatch without deployment. The
   membership deployment boundary
   (`supabase/migrations/20260730130000_membership_deployment_enforcement.sql`)
   is not touched.
3. **Provisional owner.** Anonymous mints create a flagged provisional account
   row; claim re-parents agents, handoff sessions, envelopes, and receipts.
   Reaped after the 7-day retention if unclaimed.
4. **Hold-first templates; BYOK never required pre-card.** The scaffold's
   guarded action fires before any AI call, so the pre-card path needs no
   model key and no platform inference subsidy. Volunteering a key early
   (to watch a full run) is offered, never required. Key entry stays where it
   already is: the post-payment setup checklist (everything remains BYOK).
5. **One universal scaffold; one starter policy.** The starter policy is
   **consequence-group-scoped** ("ask before anything that sends / spends /
   writes externally"), parameterized, pre-compiled once at authoring time
   with the compile model identity pinned — valid against any manifest a
   coding agent produces. No per-use-case template library. The homepage
   example agents remain marketing fixtures.
6. **Policy ratification is owner-only, permanently.** `gx.policy` can read,
   attach the template policy, propose drafts, and dry-run. It can never
   approve, activate, or edit live policy.
7. **60-minute handoff TTL untouched** (DB CHECK + copy-guard tests). Long
   builds re-mint via `galacticconnection resume`.
8. **Two clocks.** Build credential: 60 minutes. Human return window
   (pairing link, unclaimed agent, trial-lane envelope expiry): **7 days**.
9. **Email is the identity spine.** Auth-first: provider/magic-link email →
   customer-bound checkout → Link OTP. Pay-first: Link email → provisional
   claim, with **magic-link verification required** when the email already has
   an account.
10. **Command spelling:** `npx galacticconnection new`, hero rendered with a
    copy button. Web/terminal parity is a requirement, not a preference.

---

## Verified baseline facts (2026-08-03)

- **Handoff machinery** (`api/services/builder-handoff-sessions.ts`):
  owner-bound sessions, purpose-bound credential, lifecycle timestamps
  (connected/staged/tested/uploaded/promoted), `BUILDER_HANDOFF_TTL_SECONDS =
  3_600`, 10-candidate cap, "a prior handoff bearer cannot mint another
  handoff" (AS-BE-001). Routes: `POST /api/launch/handoffs`,
  `POST /api/launch/agents/:id/handoffs` (`shared/contracts/launch.ts` ~L142).
- **No MCP policy capability exists.** `api/services/capabilities/registry.ts`
  registers discover/project/download/stage/upload/test/set/consent/secrets/
  call/codemode/db_inspect/verify/job/concepts/attention/notifications/flag/
  routine/emit — nothing for policies. Policy compile is an
  **account-session, owner-only** route running on the owner's BYOK model and
  returning the code-rendered readback (`api/handlers/launch.ts` ~L3143).
- **Policies attach at the manifest level.** `GET /api/launch/agents/{id}/policies`
  serves declaration-derived defaults merged over the current release
  (`shared/contracts/launch.ts` ~L729). Deployment only escalates the
  enforcement lane.
- **The gate runs at exactly two checkpoints** — MCP dispatch
  (`api/handlers/mcp.ts`) and the consumer claim point
  (`api/services/consumer-claim-gate.ts`) — with envelopes in
  `api/services/agent-approvals.ts` and verdicts allow/deny/hold in
  `api/services/policy-gate.ts`. **The qualification/test lane is hermetic**
  (testMode binding stubs, local fixtures; Studio copy: "live external
  services were not exercised") and never traverses the gate. A real held
  card therefore requires a real dispatch — hence the trial context.
- **Checkout is already customer-bound for signed-in users**
  (`api/services/subscriptions.ts`, `getOrCreateStripeCustomerForUser`), so
  Link OTP consolidation is an extension, not a rebuild.
- **CLI** (`cli/`, npm `galacticconnection`, bins `galacticconnection` +
  `galactic`): commands today are `setup --token`, `mcp|serve`, `version`,
  `help` (`cli/bin/ultralight.js` ~L635). `setup` already writes stdio MCP
  entries into Claude Code / Claude Desktop / Cursor configs; token lives in
  `~/.galactic/config.json`; the bridge proxies to
  `https://api.connectgalactic.com/mcp/platform`.
- **Web auth:** magic link (`apps/launch-web/src/lib/auth.ts` ~L321,
  `/auth/launch/magic-link`) + provider OAuth via the authCallback route.
- **Pre-auth surface:** `apps/launch-web/src/components/pre-auth-fleet.tsx`
  ("plan without an account" already exists; the hero and live mirror do not).

Repository conventions are inherited from
`docs/AGENT_STUDIO_LAUNCH_WORK_ORDERS.md` §Repository conventions (tests,
migrations, routes + OpenAPI registration, contracts additive-only, reserved
args, per-PR verification gates). One addition for this stream:

- **Funnel events:** every WO that adds a user-visible stage emits a typed
  funnel event (stage id, session id, surface web|cli, timestamp) through the
  existing telemetry path; no PII beyond the provisional/claimed account id.

---

## WO-F1 — Anonymous claimable handoff + pairing page + hero

**Problem.** The handoff machinery requires an authenticated owner, so the
funnel's first minute demands an account — exactly the friction the funnel
exists to remove. There is no way to watch a build without signing in, and
the pre-auth homepage neither shows the price nor offers the terminal path.

**Design.**
- **Provisional owner:** an unauthenticated mint creates a flagged provisional
  account row (`account_kind = 'provisional'` or equivalent — keep `owner_id`
  non-null everywhere; the ledger assumes it). The handoff session, the agent
  it builds, its envelopes, and its receipts all parent to that row. **Claim**
  re-parents everything to a real account in one transaction; claim sources
  are WO-F3 (payment) and WO-F4/web sign-in.
- **Anonymous mint endpoint:** a variant of `POST /api/launch/handoffs` that
  requires no session, returns the handoff credential *plus* a **pairing
  code** (high-entropy, unlisted). Abuse ceiling: per-IP mint rate limit, one
  active anonymous session per pairing browser, existing 10-candidate cap,
  containment-gated tests only.
- **Pairing page `/b/:code`:** stages-only pre-claim — the session ledger's
  own timestamps (connected → staged → tested → uploaded) rendered on the
  pre-auth fleet surface, adopting the agent card in place of the example
  fixtures. Polling transport (existing live-reload pattern). The link (and
  the unclaimed agent, and — after WO-F5 — its held envelope) lives **7
  days**, then a reaper removes provisional rows never claimed. Claimed rows
  are never touched by the reaper.
- **Homepage hero (Concept A as add-on):** terminal block above the existing
  plan card — one sentence of copy including the price ("Free to plan and
  build — $20/month when you deploy"), the command, a copy button. Nothing
  existing is removed.

**Schema.** One migration: provisional flag on accounts (or a minimal
`provisional_accounts` companion), `pairing_code` (unique, indexed) +
`claimed_at`/`claimed_by` on handoff sessions, reaper bookkeeping. RLS
service-role-only; the pairing read goes through a dedicated sanitized route,
never PostgREST.

**Touchpoints.** `api/services/builder-handoff-sessions.ts` (mint variant,
claim, re-parenting), `api/handlers/launch.ts` (anonymous mint route + pairing
read route + OpenAPI), reaper beside existing scheduled jobs,
`apps/launch-web/src/components/pre-auth-fleet.tsx` (hero + adopted card),
new pairing page route in `apps/launch-web/src/lib/routes.ts`, funnel events.

**Tests.** Mint-without-session returns credential + code and creates the
provisional row; rate limits enforced; pairing read is stages-only (assert no
source, no evidence, no receipts in the payload); claim re-parents session +
agent atomically and is idempotent; reaper spares claimed rows; copy-guard:
the hero states the price and the "no account needed" promise.

**Acceptance.** A browser with no cookies can mint, watch a build progress on
`/b/:code`, and nothing beyond lifecycle stages leaks pre-claim. An
authenticated claim moves everything; the 60-minute TTL and all existing
authenticated handoff behavior are unchanged.

**Guardrails.** Do not widen what a handoff credential can do; do not make
`owner_id` nullable; do not touch the TTL CHECK; no PII on provisional rows
beyond what Stripe/auth later supplies at claim.

---

## WO-F2 — `galacticconnection new`

**Problem.** The CLI is web-first: `setup --token` requires a key minted in
the browser. The funnel needs the terminal to be the front door.

**Design.** New command `new [description]`:
1. **Plan:** inline description, or the web funnel's questions as skippable
   prompts — plus the policy seed: *"Finish this sentence: it must ask me
   before ___"*, pre-filled from the universal scaffold's starter policy
   default, enter to accept, editable, skippable.
2. **Mint:** call the WO-F1 anonymous endpoint; print the pairing URL.
3. **Wire:** reuse `setup`'s config-writing machinery to register the MCP
   bridge with the **handoff credential** (stored in `~/.galactic/config.json`
   with its expiry; never on argv). Detect Claude Code first, then Cursor /
   Claude Desktop. Print the build brief (the same handoff prompt the Studio
   hands off today, extended with the policy seed + `gx.policy` instructions);
   **offer** enter-to-launch when a coding agent binary is detected — never
   auto-run. No agent detected → print the brief with a one-line pointer.
4. **Watch:** poll the pairing read route; mirror stage transitions as
   terminal lines; on hold (WO-F5) print the card event; on exact-tested +
   checkout availability (WO-F3) print the checkout URL.
5. **`resume`:** re-mint an expired build credential for the same session
   (subject to the same anonymous ceiling), preserving the pairing code.
6. **Credential upgrade:** after claim/login, the bridge silently prefers the
   `gx_` key over the spent handoff credential.

**Touchpoints.** `cli/bin/ultralight.js` (command table ~L635), config
read/write module, `cli/README.md`, funnel events (surface=cli).

**Tests.** CLI unit tests for plan parsing, config writing (fixture configs
for all three clients), credential storage + expiry handling, brief content
(includes the seed sentence; never includes secrets), watch-loop state
machine against a mocked pairing route, `resume` reuse of the pairing code.

**Acceptance.** On a machine with Claude Code configured, `npx
galacticconnection new "…" ` reaches a printed pairing URL and a handed-off
brief in under a minute, with zero accounts, zero tokens, zero prompts that
block. Everything the terminal shows matches what `/b/:code` shows.

**Guardrails.** Never launch another program without an explicit keypress;
never accept or print card data; never write the handoff credential into
per-client config files (bridge reads it from `~/.galactic/config.json`, the
existing pattern).

---

## WO-F3 — Checkout at the card + claim consolidation

**Problem.** Checkout today assumes a signed-in member-to-be. The funnel needs
payment to sit at the held card, reachable by strangers, with the email doing
double duty as identity.

**Design.**
- **Pre-created checkout:** when a funnel session's release reaches
  exact-tested, mint the Stripe checkout session server-side (idempotent per
  funnel session, existing `checkoutIdempotencyKey` precedent) with the
  **claim token in metadata**. Surface it on the pairing page (primary button
  on the held card: "Approve and let it finish — $20/month") and to the CLI
  watch loop.
- **Pay-first (stranger):** Stripe Link captures the email → webhook creates
  the account from that email → claim token re-parents (WO-F1) → return URL
  lands on the card → the pending approval resolves → resume. If the email
  already has an account: **hold the claim** and require magic-link
  verification before attaching (decision 9); the card shows "check your
  email to finish."
- **Auth-first (member or signer-in):** existing
  `getOrCreateStripeCustomerForUser` path — email carried from Google/magic
  link → customer-bound checkout → Link OTP one-click. Members skip checkout
  entirely; their claim is immediate.
- **After payment:** deploy confirm stays an explicit click; the setup
  checklist (BYOK key, deploy, activate) is the landing state.

**Touchpoints.** `api/services/subscriptions.ts` (funnel checkout variant +
metadata), Stripe webhook handler (claim-on-payment), `api/handlers/launch.ts`
routes + OpenAPI, pairing page card states, CLI watch-loop line, funnel
events (checkout_shown, checkout_completed, claim_verified).

**Tests.** Idempotent checkout minting; webhook claim path (fresh email /
existing-email-requires-verification / already-signed-in); return-URL landing
resolves to the card; no card data ever transits our API; members bypass
checkout.

**Acceptance.** From the held card, a stranger with a Link-known email is a
paying member in one OTP; the resume executes exactly once; an email
collision cannot attach an agent to an account its owner didn't verify.

**Guardrails.** Payment details never touch the terminal or our servers;
`hasActiveSubscription` semantics and the deploy-confirm click are unchanged;
no auto-approval of the held envelope on payment — approve is its own act.

---

## WO-F4 — Device authorization grant → `gx_` keys

**Problem.** Durable CLI auth today means copying a key out of the browser.
The standard device-grant shape (gh/flyctl/wrangler) ends that.

**Design.** Two endpoints (mint device code; poll/exchange) + a `/device` web
page that runs the **existing** auth funnel (magic link or provider OAuth) and
confirms the short code. On confirmation the poll returns a **standard-scope
`gx_` API key** — the existing credential, new issuance path, no new token
type. CLI: `galacticconnection login`, auto-offered at claim time in `new`.
Codes: single-use, short expiry (10 min), rate-limited polling, user-code
format `XXXX-XXXX`.

**Touchpoints.** `api/handlers/launch.ts` (two routes + OpenAPI), API-key
service (issuance attribution `via=device`), `apps/launch-web` `/device`
page + route, `cli/bin/ultralight.js` (`login`), `cli/README.md`.

**Tests.** Code single-use + expiry; poll rate limit; exchange yields a key
with exactly the standard scopes; the `/device` page requires an
authenticated session; CLI stores the key via the existing config path.

**Acceptance.** `galacticconnection login` → browser confirm → working `gx_`
key in `~/.galactic/config.json`, no copy-paste, in under a minute.

**Guardrails.** No broader-than-standard scopes; no silent key rotation; the
device page never auto-confirms a code from a URL parameter alone (explicit
click required — codes arrive over shoulder-surfable channels).

---

## WO-F5 — Policy lane: `gx.policy`, starter policy, trial execution context

**Problem.** Coding agents cannot touch policies (no registry capability;
compile is owner-only), and no lane exists where a pre-member run can produce
a real held envelope — the test lane is hermetic by design. Without both, the
north-star moment cannot happen.

**Design.**
- **`gx.policy` capability** (registry entry beside `concepts`; MCP-only, no
  sandbox binding in v1 — the binding-change pattern is deliberately deferred):
  - `read` — current policies + declaration-derived defaults for the target
    agent.
  - `attach_template` — bind the universal scaffold's pre-compiled,
    consequence-group-scoped starter policy with parameter substitution.
    Deterministic; no model call; compile model identity of the template
    artifact recorded at authoring time.
  - `propose` — store a freeform NL sentence as an **uncompiled,
    agent-attributed draft**. Compilation happens later, at owner readback,
    on the owner's key — the existing owner-only route, untouched.
  - `dry_run` — replay the scaffold's shipped sample invocations against a
    policy ("would have held 3 of 5"). Owner-key auth; handoff plane gets
    read/attach/propose scoped to the handoff's target agent only
    (builder_handoff precedent: `gx.concepts`).
  - Drafts are unversioned; immutable policy versions mint **only** on owner
    approval. Attribution (agent-proposed) is visible in readback and receipts.
- **Universal scaffold update:** canonical guarded consequence-group shape,
  the starter-policy default seed, sample invocation fixtures for dry_run,
  skills-doc section teaching `gx.policy` (doc-completeness test already
  enforces registry coverage).
- **Trial execution context:** a first-class context (precedent:
  `api/services/execution-context-registry.ts`) that runs the **exact-tested
  candidate** through live dispatch without promotion:
  - Locked overlay: guarded group = ask, other consequential groups = off,
    reads = free; plus a dispatch allowlist derived from the manifest.
  - No routines, no schedules, no activation; N runs per funnel session
    (constant, revisable).
  - Holds create **real envelopes** owned by the provisional user (WO-F1
    re-parenting covers them); expiry = the 7-day window, not the ops-lane
    default; resumption reuses the existing exactly-once machinery.
  - **Resume requires an active membership.** Deny and Edit do not.
  - Every receipt, activity item, and envelope from this lane is
    honesty-labeled `trial`.
- **Pairing page:** "Run it once" button (trial run trigger) and the held
  card with Approve (→ WO-F3 checkout when unmembered) / Edit / Reject.

**Schema.** Expected none beyond WO-F1's, *if* envelopes and policy drafts can
carry lane/status discriminators additively. If a draft state cannot ride the
existing policy-set tables additively, a minimal drafts table joins WO-F1's
migration — decide at implementation, additive either way.

**Touchpoints.** `api/services/capabilities/registry.ts` (+ capability
module), `api/services/policy-gate.ts` (trial overlay source — read-only
consumption, no verdict changes), `api/services/agent-approvals.ts` (lane
label, expiry override, membership check on resume),
`api/services/consumer-claim-gate.ts` / `api/handlers/mcp.ts` (trial context
admission), scaffold + skills docs, pairing page card states, funnel events
(run_started, held_card_shown, resume_after_payment).

**Tests.** Registry/capability contract tests (auth planes per verb; handoff
scoped to its own agent; propose never compiles); attach_template determinism
(same params → same artifact hash); trial context: guarded call holds, off
group refuses, read passes, run count enforced, activation impossible;
envelope: provisional ownership, 7-day expiry, resume blocked without
membership and exactly-once with it; honesty labels present end-to-end;
dry_run fixture verdicts stable.

**Acceptance.** From a fresh `new` session with no account and no key: a
trial run reaches a real held envelope on the pairing page; approve without
membership routes to checkout; approve with membership resumes exactly once
and the receipt is labeled trial. The owner-only ratification invariant and
the membership deployment boundary are untouched throughout.

**Guardrails.** Never let `gx.policy` approve/activate/edit-live under any
auth plane; never run a trial against anything but an exact-tested candidate;
never fire real inference in the default pre-card path (the scaffold's
guarded action precedes AI); the gate's verdict logic is consumed, not
modified — any change to `policy-gate.ts` semantics is out of scope for this
stream and gets its own review against the pillar doc.

---

## Cross-cutting

- **Parity:** every stage exists on web and terminal; the pairing page and the
  CLI watch loop render the same session-ledger facts. Divergence is a bug.
- **Honesty labels:** trial-lane artifacts say so, everywhere they appear.
- **Metrics:** funnel events land from WO-F1 onward; the dashboard's headline
  is time-to-first-held-card (p50/p90), with stage-level drop-off.
- **Abuse posture:** all anonymous ceilings (mint rate, active sessions,
  candidate cap, trial-run count, retention) are constants in one module so
  support can reason about them and tests can pin them.
- **Deprecations:** none. The existing authenticated handoff, checkout, and
  policy flows are supersets, not casualties, of this stream.
