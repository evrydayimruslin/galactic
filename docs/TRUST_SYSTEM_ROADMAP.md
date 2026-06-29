# Galactic Trust System — End-to-End Path & Implementation Roadmap

Agent-native trust: when a user (and their connected agent) discovers a third-party
Agent, they can decide whether to trust it. Trust is something **agents can verify
and report**, not just a badge. This supersedes the earlier "trust page" phases.

## 0. Locked decisions

- **Four trust layers**, every signal **BINARY** (green/red, verified yes/no — no yellow; "no data" is distinct from red).
- **Seeding audit: DROPPED.** No platform LLM behavioral audit. The *caller* reads the open code; the *flag-after-call* loop measures real behavior. (Keep only the existing deterministic publish-time checks: `integrity.ts` lint + schema conformance.)
- **Identity = boolean `publisher_verified`** (verified on Stripe Connect or not). Do **not** surface a named publisher. But **pull maximum Stripe Connect data into our backend** (store the full account snapshot internally).
- **Health = binary green/red per window**, windows = **1h / 24h / 7d / 30d** (uptime-status style). A window with too few calls is "no data", not red.
- **Near-universal post-call flagging**: a standing agent directive + per-call nudge compels the connected agent to submit a green/red flag after (almost) every call, **verified by the call's `receipt_id`** so it's proof-of-use, not spammable.

## 1. The four trust layers

| Layer | Proves | Signal (binary) | Source | Status today |
|---|---|---|---|---|
| **1. Identity** | A real, KYC'd legal entity stands behind this Agent | `publisher_verified` | Stripe Connect `payouts_enabled`/`details_submitted` | ~70% (boolean computed; not surfaced) |
| **2. Integrity** | The code that runs == the code that was published & signed | `integrity_verified` | signed hash of the **executed** bundle | ~25% (hashes exist over source; runtime doesn't verify) |
| **3. Transparency** | The code is open, an agent read it, and it matched the hash | `open_code` + `verified_reads` | `download_access` + download + hash match | ~80% toggle/download; ~0% verify loop |
| **4. Reliability** | It actually works, repeatedly, recently | per-window `green/red` + flag sentiment | `mcp_call_logs` windows + `app_call_flags` | ~35% (single 30d metric; inflatable) |

## 2. End-to-end path (lifecycle)

```
Developer publishes ──▶ [L2] platform signs the EXECUTED bundle; runtime will verify it on load
   │  (optionally flips download_access=public → [L3] open code)
   ▼
Discovery ──▶ ranking factors all four layers (gates + bounded boosts + bandit for new Agents)
   │
   ▼
Connected agent inspects ──▶ [L3] gx.download → recompute per-file sha256 → match signed hash
   │                          → "open + verified" (knows what it read is what runs, via L2)
   ▼
Agent calls a function ──▶ response carries receipt_id (proof the call happened)
   │
   ▼
Agent flags outcome ──▶ gx.flag({receipt_id, green|red, note?})  [compelled by standing directive]
   │                     platform verifies receipt_id ∈ mcp_call_logs (this user, recent, unflagged)
   ▼
Signals update ──▶ [L4] per-window green/red from mcp_call_logs; flag sentiment (proof-of-use)
   │
   └────────────▶ feeds back into Discovery ranking (loop)
```

The four layers attach to distinct moments: **L1** at the publisher, **L2** at publish+runtime,
**L3** at inspection-time (caller reads), **L4** at call-time + post-call. A calling agent can
gate on a machine-readable composite (`publisher_verified ∧ integrity_verified ∧ open_code ∧
health_green ∧ flag_ratio ≥ τ`) before invoking.

## 3. Data model changes

**Integrity (L2) — the linchpin.**
- `buildVersionTrustMetadata` already hashes files incl. the ESM bundle. Add an explicit
  `executed_bundle_hash` = sha256 of the exact bytes written to `esm:{appId}:latest`, and a
  named `description_hash` (sha256 of `{app_description, functions[].description}`) to the signed
  block (`shared/types VersionTrustMetadata`, `api/services/trust.ts`).
- **Runtime verify:** at `dynamic-sandbox.ts:123` (KV load), recompute sha256 of the loaded
  bundle and compare to the signed `executed_bundle_hash`; refuse to execute on mismatch.
- Expose **per-file `artifact_hashes`** (+ canonical file list) to callers — today only the
  aggregate is in the trust card (`buildAppTrustCard`).

**Identity (L1).**
- `users.publisher_verified boolean` (derived from Connect `payouts_enabled && details_submitted`).
- `users.stripe_connect_snapshot jsonb` — full `getAccountStatus()` payload (requirements,
  individual/company, capabilities), synced on Connect webhook + a periodic refresh. Internal only;
  surface just the boolean.

**Reliability — flags (L4).** New table `app_call_flags`:
```
id, app_id, function_name, user_id,
receipt_id        -- FK mcp_call_logs.id, UNIQUE (one flag per call)
status            -- boolean: true=green, false=red
note              -- required when red, null when green
agent_desc_hash, fn_desc_hash   -- bind the flag to the descriptions the caller saw
caller_app_id     -- from mcp_call_logs (self-call detection / weighting)
weight            -- derived: tier + proof-of-use
created_at
UNIQUE(receipt_id); INDEX(app_id, function_name, created_at)
```

**Reliability — health (L4).** Derived, no table: extend `getAppMetrics` (marketplace.ts) to
compute per-window success-rate from `mcp_call_logs (success, created_at, app_id)` over
`{1h, 24h, 7d, 30d}`; binary `green` iff `calls ≥ N_window && success_rate ≥ τ`, else `red`;
`null` ("no data") iff `calls < N_window`. **Exclude owner/self + free/zero-charge rows** (fixes
TRUST-1 inflation).

## 4. Components & code touchpoints

**A. Identity boolean + Connect sync** — `stripe-connect.ts:230 getAccountStatus` (already rich);
add a sync writing `publisher_verified` + `stripe_connect_snapshot` on the Connect webhook and a
refresh job; surface `publisher_verified` in `buildAppTrustCard` + discovery.

**B. Integrity (Phase 0)** — `trust.ts buildVersionTrustMetadata` (add executed-bundle + description
hashes), `dynamic-sandbox.ts:123` (verify-on-load), `buildAppTrustCard` (expose per-file hashes),
the `gx.set`/rollback/rebuild paths (re-sign the bundle they write: platform-mcp.ts:7054, 9736).

**C. Open-code verify loop** — `executeDownload` (platform-mcp.ts:7772) returns `{path, content}`;
add the matching `artifact_hashes` to the response (or a `gx.verify({app_id})` tool); ship a CLI/
agent verify routine (recompute + match). The green-flag gains an `open_code_read: true` qualifier
when the caller verified before calling (worth more in ranking).

**D. Post-call flagging (the near-universal telemetry)** —
- New tool `gx.flag({ receipt_id, status, note? })`: verify `receipt_id ∈ mcp_call_logs` for this
  user, recent (≤ TTL), target app matches, not already flagged; reject self-originated
  (`caller_app` owned by the app owner); write `app_call_flags` with tier weight.
- **Compel it** three ways: (1) standing directive in `buildInstructions` (platform-mcp.ts:3893) —
  every connected agent sees it on `initialize`; (2) each `gx.call` result appends a structured
  nudge `{ receipt_id, _flag: "report outcome via gx.flag" }`; (3) a published Galactic skill that
  encodes the protocol for skill-using agents.
- **Honesty/FTC:** agent-submitted flags are **ranking signal only**, never shown as human "reviews".

**E. Health windows** — extend `getAppMetrics` (marketplace.ts:~1201) to the 4-window binary model;
surface as 4 chips on the card + a machine field for callers.

**F. Discovery ranking** — `discover.ts executeSearch` composite (currently
`sim*0.7 + native*0.15 + like*0.15`). Add **gates** (filter known-bad / integrity-fail) and
**bounded boosts** (publisher_verified, integrity_verified, open_code+verified_reads, health_green,
flag_ratio), capped so no single trust term dominates; **bandit exploration** for new Agents (cold
start). Inject the same fields into the agent-readable suggestion payload.

**G. Surfacing** — `buildAppTrustCard` + the `/agents/:slug` detail page: four binary chips
(Verified publisher · Integrity verified · Open code · Health 1h/24h/7d/30d) + flag ratio; combine
trust-card/capabilities/description; demote pricing; wiring behind a modal (per earlier notes).

## 5. Implementation roadmap

| Phase | Deliverable | Depends on | Effort |
|---|---|---|---|
| **0. Integrity linchpin** | Sign + **runtime-verify the executed bundle**; expose per-file hashes; named `description_hash`; harden `TRUST_SIGNING_SECRET` (fail-closed, drop god-key/dev fallback) | — | **M** |
| **1. Identity + Health** | `publisher_verified` boolean + full Connect snapshot sync; 4-window binary health from `mcp_call_logs` (excl. self/free); surface both on the card | — (parallel to 0) | **S–M** |
| **2. Open-code verify** | Hashes in `executeDownload`/`gx.verify`; agent/CLI verify routine; `open_code_read` qualifier | Phase 0 (verify is only meaningful once the executed bundle is signed) | **S–M** |
| **3. Post-call flags** | `gx.flag` tool + `receipt_id` verification + sybil (proof-of-use, self-call reject, one-per-receipt, tier weight); compel via `buildInstructions` + call nudge + skill | `app_call_flags`; description hashes (Phase 0) | **M** |
| **4. Discovery + detail page** | Wire all four layers into ranking (gates + bounded boosts + bandit); reorg detail page to binary chips; agent-readable composite | Phases 0–3 (signals must exist) | **M** |
| ~~Seeding audit~~ | **Removed** | — | — |

**Sequencing rationale.** Phase 0 is the gate: it makes both Integrity (L2) and the open-code
verify (L3) *true* instead of decorative. Phase 1 is independent and cheap, so it can land in
parallel — it gives the card real content immediately (identity + health). Phase 3 (flags) is the
highest-ongoing-value signal but needs the description hashes from Phase 0 to bind flags to a
version. Phase 4 ties it together; it should land last so ranking only consumes signals that exist.

## 6. Open decisions

- **Health green threshold** `τ` and per-window min-calls `N` (e.g. green iff ≥X calls and ≥95%).
  Below `N` → "no data", not red (don't punish new Agents).
- **Flag compulsion strength**: directive + nudge is near-universal but not enforceable; do we also
  gate anything on flag submission (e.g. a small credit nudge)? Recommend directive+nudge only.
- **`open_code` ranking weight**: boost the *composite* (open **+ hash-verified + positive
  verified-reads**), never mere downloadability — open ≠ safe.
- **Connect snapshot refresh cadence** + which fields (capabilities/requirements) we retain.

## 7. Phase 3 implementation follow-ups (deferred)

- **Async-call flagging (medium):** `gx.call` on an async function returns a job envelope with no
  `receipt_id`; `gx.job` later returns `execution_id`, which is NOT the `mcp_call_logs.id` a flag
  needs — so the whole async-function class can't be flagged, biasing the signal toward sync apps.
  Fix: have the queue consumer persist the run's `receiptId` on the job row, return it from
  `gx.job`'s completed/failed branches, and attach the same `_flag` nudge in the async path.
- **Outer-throw receipt (low):** a platform-internal throw after the sandbox returns yields no
  `receipt_id`, so those (rare) failures can't be flagged negative. App-logic failures ARE caught
  and flaggable. Fix: hoist `receiptId` before the try so the outer catch can attach it.
- **Phase 4 must gate the flag signal:** count a flag toward ranking only with a real **paid** call
  (already enforced at write: `call_charge_light > 0`), weight **distinct flaggers** by account
  trust (residual second-account Sybil), and never render `app_call_flags.note` as a public review.
