# Free Mode — Design Doc

**Status:** Approved for build (Phase 0 next) · **Date:** 2026-06-24 · **Owner:** TBD

Free Mode lets a user with a near-empty wallet keep using Galactic in a **read-only / no-spend** capacity: only free functions run, AI functions run only against the user's own BYOK key, and paid functions are neither suggested nor callable. It activates automatically from the wallet balance — there is no persisted flag.

---

## 1. Behavior spec

Free Mode is active for a caller when **`balance_light < 25`** (i.e. **< $0.25**; 100 Light = $1). While active:

1. **Free functions run.** A call runs if the **caller is never charged** — i.e. price = 0 (always-free), a self-call (owner calling own app), or an **owner-sponsored free-quota** call (price > 0 but within the developer's `free_calls` allowance, where the owner pays).
2. **AI functions need BYOK.** A function that uses inference (`galactic.ai()`) runs **only if the caller has a BYOK key** configured (BYOK inference draws no platform credits). With no BYOK key, inference-using functions are **not suggested and not callable**.
3. **Paid functions are blocked.** Any call that would charge the **caller** (app charge or infra-fallback) is **neither suggested nor executed**.
4. **The agent is told.** The connected agent is informed it is in Free Mode, what that means, and that the user can top up their balance to exit it.

`codemode` is disabled in Free Mode (it bypasses the billing path — see §6).

---

## 2. Locked decisions

| # | Decision |
|---|---|
| D1 | "Free" in Free Mode = **caller is not charged** (price 0 / self / owner-sponsored free-quota). Finite per-user allowances are honored at **execution from Phase 1** (resolved inside the hold) and **surfaced in discovery from Phase 3** (needs the peek RPC). |
| D2 | **Per-function** inference detection (not per-app). Derived statically at **upload** and persisted as a manifest flag `uses_inference` for cheap reads. Detection is a **conservative call-graph reachability pass that defaults to `true` when uncertain** (fail-safe toward blocking). App-level `ai:call` permission is unchanged (it still gates the runtime AI binding). |
| D3 | **Single threshold = $0.25 (25 Light)** for both the inference floor and Free Mode. The existing `CHAT_MIN_BALANCE_LIGHT` (today 50 / $0.50) folds into this — **this lowers the platform-inference floor from $0.50 → $0.25** (intended). |
| D4 | **`gx.codemode` is dropped** from the Free-Mode tool surface. |
| D5 | **Fail-open** for the paid-call block (a transient balance-read error must not block a paying user). **Fail-closed** for the AI-without-BYOK block (a read error there must not let a $0 user spend). |
| D6 | **Owner-sponsored free-quota calls are allowed** in Free Mode (caller pays nothing). Enforced inside the hold RPC where the payer is resolved. |
| D7 | **Phase-1 paid-call gate lives in the hold RPC** (`create_app_call_runtime_cloud_hold`) so the decision happens **before any debit** — not a TS post-hold release. |
| D8 | The **peek RPC** (read-only free-allowance remaining) is **Phase 3**, used only to align discovery with execution. |

---

## 3. How the platform works today (load-bearing facts)

### 3.1 Money path
- **Unit:** `LIGHT_PER_DOLLAR_CANONICAL = 100` → 100 Light = $1, so **$0.25 = 25 Light** (`shared/types/index.ts:1250`). Always render dollars to users via `formatDollarsFromLight` (`:1375`).
- **Balance** lives in `users.balance_light` (= `deposit_balance_light` + `earned_balance_light`). Canonical read: `checkChatBalance(userId)` (`api/services/chat-billing.ts:62`) → a one-column `select=balance_light`. **There is no `get_balance` RPC**, and balance is **not in JS scope** on the call path — it is read only inside the Postgres RPCs.
- **Paid-call lifecycle** (`api/services/execution-settlement.ts`): `preflightRuntimeCloudHold` (`:360`) → `evaluateAccessPolicy` (`:364`) → anonymous-caller gate (`:419`) → `createRuntimeCloudHold` (`:443`, reserves balance) → tax preflight (`:478`) → **execute** → `settleRuntimeCloudPreflight` (`:620`, releases unused infra) → `settleAppCall` (`:745`) → `transfer_light` (`:885`, the buyer→creator transfer).
- **The hold RPC** `create_app_call_runtime_cloud_hold` (`supabase/migrations/20260608140000_economic_operation_idempotency.sql:1488`) resolves the payer: self → charge 0; `price ≤ 0` → free, **owner sponsors infra**; `free_call_limit > 0` → increment `app_caller_usage` → within limit → **owner pays (free for caller)**, else **caller pays**; else caller pays. If the owner can't cover sponsored infra it **falls back to charging the caller** (`:1642`, raises `caller_infra_fallback_light_required` if the caller also can't).
- **Insufficient balance** is discovered by attempting the SQL debit (`debit_spendable_light` raises at `…20260430130000…:291`) and mapped to `-32009 LIGHT_REQUIRED` (MCP, `api/handlers/mcp.ts:2637`) / HTTP `402` (`api/handlers/http.ts:749`).
- **The only existing balance-threshold gate:** `CHAT_MIN_BALANCE_LIGHT = 50` (`shared/contracts/ai.ts:198`), used by `chat.ts:110`, `inference-options.ts:71`, `runtime-ai.ts:169`. BYOK routes skip it. **No Free Mode exists today.**
- **15% fee + waiver:** `transfer_light` (`…20260518150000…:26`) computes `amount × 0.15`, fully waived for the developer's own referred customer (`publisher_fee_waiver_grants`) or partially from `publisher_fee_credit_accounts`. Orthogonal to Free Mode — a free-mode call never reaches `transfer_light` (it never charges).

### 3.2 Pricing / free calls
- Owner sets `apps.pricing_config` (`AppPricingConfig`, `shared/types/index.ts:999`): `default_price_light`, `default_free_calls`, `free_calls_scope` (`app` | `function`), per-function `functions{}` overrides. Helpers `getCallPriceLight` (`:1050`), `getFreeCalls` (`:1069`). Set via `gx.set`/`ul.set` (`api/handlers/platform-mcp.ts:2155` schema, `:10807` `executeSetPricing`).
- Call-time decision: `evaluateStaticAccessPolicy` (`api/services/access-policy.ts:149`) → `{ priceLight, free, freeQuotaLimit, freeQuotaCounterKey }`; `free === (priceLight ≤ 0 && !self)` (`:170`). Module (`access_policy: mode:"module"`) policies run in a sandbox (`access-policy-runtime.ts`) and can override price/deny at call time → **not statically classifiable**.
- **Free-call allowances** (`app_caller_usage`: `app_id, user_id, counter_key, call_count`) are **consumed atomically only inside the hold RPC**. **There is no read-only "remaining" peek** — the central gap behind D1/D8.

### 3.3 Inference / BYOK / `ai:call`
- `galactic.ai()` binding: in-process `api/runtime/sandbox.ts:2072`; production worker `api/runtime/dynamic-sandbox.ts:236` → RPC `api/src/bindings/ai-binding.ts:92`.
- **"Function uses inference" ≡ "the app's manifest declares `ai:call`"** today. Enforced in 3 layers: in-process gate (`sandbox.ts:2073`), binding-attachment gate (`dynamic-sandbox.ts:477` — `AI` binding only attached when `ai:call` present), and the handler branch (`run.ts:435`, `mcp.ts:2571`, `http.ts:581`). Permissions come **solely from `getManifestPermissions(app.manifest)`** via `resolveStrictManifestPermissions` (`api/services/app-runtime-resources.ts:781`) — **runtime never scans code**, and `ai:call` is **per-app, not per-function**.
- Static detection at upload: `inferPermissions` (`api/services/parser.ts:727`) regex-matches `ultralight.ai(` → adds `ai:call`; upload linter at `platform-mcp.ts:8864`. **Bug to fix:** these match `ultralight.ai(` but **not** `galactic.ai(`.
- **BYOK:** `users.byok_keys` (JSONB, AES-GCM via `api-key-crypto.ts`), `byok_enabled`, `byok_provider` (primary). `getPrimaryByokProvider` (`api/services/inference-route.ts:96`). When a primary BYOK provider exists, `galactic.ai()` already routes through it with **`shouldDebitLight:false`** (no platform credits) — so "allow AI if BYOK" is economically consistent today. BYOK presence is **already loaded onto the caller context** (`api/services/request-caller-context.ts:102`).
- AI billing: `calculateCostLight` (`chat-billing.ts:105`), debited **mid-execution** per call (`ai-binding.ts:221`, `p_allow_partial:true`). The existing low-balance AI gate (`runtime-ai.ts:166`) **fails open** on a balance-read error.

### 3.4 Discovery / suggestion surfaces
- `gx.call` is a **thin proxy** that re-issues `tools/call` to `/mcp/:appId` — **all** billing lives in the per-app handler, so there is **one execution chokepoint** for both `gx.call` and per-app calls.
- Price reaches the agent through exactly **one machine-readable channel: the generated `skills.md` `## Pricing` section** (`api/services/docgen.ts:136`), served via `gx.discover scope:"inspect"` and first-call auto-inspect (`platform-mcp.ts:3322`). It is **not** in `tools/list`, tool descriptions, the manifest, or discover rows.
- Per-app `tools/list` (`api/handlers/mcp.ts:1431`, `manifestToMCPTools` in `shared/contracts/manifest.ts:2880`) emits no price; a per-user filter exists only for **private** apps (`mcp.ts:1492`).
- `gx.codemode` (`platform-mcp.ts:5904`) has a dynamic-worker path (`:6077`) that runs app functions **in-process, bypassing `/mcp/:appId`, the balance gate, and the app charge** (and attaches **no** AI binding).

---

## 4. Architecture

### 4.1 One computed `CallerEconomicState`
Resolve once where the caller is already loaded — `resolveRequestCallerContext` (`api/handlers/mcp.ts:797`) and the platform-MCP user context (`platform-mcp.ts:3125`):

```ts
interface CallerEconomicState {
  balanceLight: number;
  freeMode: boolean;     // balanceLight < FREE_MODE_BALANCE_LIGHT
  byokPresent: boolean;  // already derivable from callerContext
}
```

This is the single source of truth both discovery and execution read. Only the `balance_light` read is new.

### 4.2 Single threshold
`FREE_MODE_BALANCE_LIGHT = 25` in `shared/`; `CHAT_MIN_BALANCE_LIGHT` folds into it. One boundary at **$0.25** governs both "can start platform inference" and "is in Free Mode."

### 4.3 Per-function inference flag (`uses_inference`)
At **upload**, statically derive — per exported function — whether it (transitively) reaches `galactic.ai(`/`ultralight.ai(`, and persist as manifest metadata:

```ts
// ManifestFunction (shared/contracts/manifest.ts)
uses_inference?: boolean; // upload-derived; conservative (true when uncertain)
```

Free Mode then reads **two per-function flags** — `uses_inference` + price — both cheap. The per-app `ai:call` permission is untouched (it still gates the runtime AI binding).

### 4.4 Enforcement matrix

| Axis | Rule when `freeMode` | Chokepoint | Fail mode |
|---|---|---|---|
| Paid app call | Block iff the **caller** would be charged (app or infra-fallback). Allow free / self / owner-sponsored. | **Hold RPC** `create_app_call_runtime_cloud_hold` (new `p_free_mode`), reached via `preflightRuntimeCloudHold` (`execution-settlement.ts:443`). New status → existing `-32009`/`402` contract. | open |
| AI function | Block the call iff `fn.uses_inference && !byokPresent`. | `executeAppFunction` after manifest resolution (`mcp.ts`); plus inference route hardened to deny the Light route. | closed |
| Don't *list* | Filter per-app `tools/list`: drop paid + `uses_inference && !byok` functions. | `mcp.ts:1465` (mirror the private-app filter at `:1492`). | open |
| Don't *suggest* (docs) | Strip/annotate paid + blocked functions; add a Free-Mode banner. | `docgen.ts:136` at **serve time** (per-user). | open |
| `gx.codemode` | Remove from the advertised tool set. | platform-MCP `tools/list`. | n/a |
| Agent awareness | Emit `free_mode: true` + explanation + top-up URL. | discovery/tool metadata + platform instructions. | n/a |

### 4.5 What counts as "free" (precise)
A call is allowed in Free Mode iff, at the hold, the **caller's charge resolves to 0**: price = 0, self-call, or within the owner's `free_calls` allowance (owner sponsors). Everything else is "paid" and blocked. Until the Phase-3 peek RPC, **discovery** classifies any `price > 0` function as paid (so allowance-backed functions execute if called, but may not be surfaced); Phase 3 aligns the two.

### 4.6 Agent awareness (D-tell)
When `freeMode`, inject a short notice into discovery results / the platform instructions: *"Free Mode is active because the wallet balance is under $0.25. Only free functions are available; AI functions need a BYOK key; paid functions are hidden. The user can add credits in their wallet to restore full access."* (Dollars only, never Light.)

---

## 5. Phased roadmap

### Phase 0 — Signals & foundations — ✅ SHIPPED (2026-06-24)
- [x] `FREE_MODE_BALANCE_LIGHT = 25` (`shared/contracts/ai.ts`, canonical); `CHAT_MIN_BALANCE_LIGHT` aliases it; the `shared/types/index.ts` duplicate set to 25. **One live behavior change: the platform-inference floor drops $0.50 → $0.25 (D3, intended).**
- [x] `CallerEconomicState` — `balance_light` added to `getUser`'s existing select (zero extra round-trip); `resolveRequestCallerContext` + the two synthesized `mcp.ts` contexts expose `{ balanceLight, freeMode, byokPresent }` via the shared `deriveCallerEconomicState()` helper (fails open).
- [x] **Per-function inference detection** — AST call-graph analysis in `parser.ts` (`analyzeInferenceUsage`) sets `ParsedFunction.usesInference`; written to `ManifestFunction.uses_inference` (generate + merge, true-is-sticky). Conservative: multi-file / destructured-`ai` / unattributed → all true. `inferPermissions` regex fixed to match `galactic.*` (the rebrand had silently broken it for **all** SDK namespaces, not just `ai`).
- [x] Linter (`platform-mcp.ts`): `ai:call` mismatch checks now match `galactic.ai(` too.
- [x] Tests: `api/services/free-mode-signals.test.ts` (12). Full suite 1006/0; typecheck clean.
- **Deferred deliberately:** the platform-MCP *discovery* context (`platform-mcp.ts:3125`) economic-state read — it would add a new DB round-trip with no consumer until Phase 2's discovery filtering. The execution path (`resolveRequestCallerContext`, used by `mcp.ts`/`http.ts`/`run.ts` where Phase 1's gates live) carries it now at zero cost. Wire the discovery context in Phase 2.
- **Backfill:** `uses_inference` is (re)derived on every upload; absent on old manifests. Phase 1's reader must treat *absent + app declares `ai:call`* as `true` (conservative) until apps re-upload.

### Phase 1 — Hard execution enforcement — ✅ SHIPPED (2026-06-24), inert behind `FREE_MODE` (default OFF)
- [x] **Paid-call gate in the hold RPC** — migration `20260625000000_free_mode_hold_gate.sql` adds `p_free_mode` (DROP + recreate to avoid an overload; grants re-applied) and `RAISE`s `free_mode_blocked` before any debit in both caller-charged branches (over-quota / no-allowance app charge, and the infra-fallback-to-caller). Owner/self/within-quota pass through (D6). The `RAISE` rolls back the free-quota increment too.
- [x] **Threading** — `freeMode` + `byokPresent` flow from the caller context through the three preflight call sites (`mcp.ts`/`run.ts`/`http.ts`) → `preflightRuntimeCloudHold` → `createRuntimeCloudHold`. The enforcement flag (`isFreeModeEnabled`) is applied in the preflight. `free_mode_blocked` maps to a new `free_mode_paid_blocked` verdict. **Fail-open** (unknown balance → `freeMode=false`). **No deploy-ordering constraint:** `p_free_mode` is omitted from the RPC body when false, so a 16-arg call matches across the migration boundary.
- [x] **Per-function AI gate** — in `preflightRuntimeCloudHold` (the shared chokepoint, so `gx.call`/cross-agent are covered): `freeMode && !byokPresent && functionUsesInference(...)` → block with `free_mode_ai_requires_byok` before the hold. `functionUsesInference` reads the explicit per-function flag, with the conservative `ai:call`-app backfill. Plus the route-level `runtime-ai.ts` gate hardened to **fail-closed** in free mode (a balance-read error denies inference).
- [x] **New leaf module** `api/services/free-mode.ts` (`isFreeModeEnabled` + `functionUsesInference`); manifest writer now records `uses_inference` explicitly (true AND false) for `ai:call` apps so the gate has per-function precision.
- [x] Tests: `free-mode-enforcement.test.ts` (6) + 3 preflight tests in `execution-settlement.test.ts` (paid→`free_mode_paid_blocked` mapping, AI blocked w/o BYOK, AI allowed w/ BYOK). Full suite 1016/0; typecheck clean.
- **To activate:** set `FREE_MODE=1` in the API worker env (after the migration applies).

### Phase 2 — Don't suggest + agent awareness
- [ ] Filter per-app `tools/list` (`mcp.ts:1465`) for free-mode callers (drop paid + `uses_inference && !byok`); load `pricing_config` + `uses_inference` there.
- [ ] `skills.md` serve-time strip/annotate (`docgen.ts:136` path) + Free-Mode banner.
- [ ] Emit `free_mode` + explanation + top-up URL to the agent.
- [ ] Drop `gx.codemode` from the free-mode tool set.
- **Acceptance:** an agent in Free Mode never sees a paid/blocked function as callable and is told why + how to top up.

### Phase 3 — Allowance honoring (discovery) + edges
- [ ] `peek_caller_usage` read-only RPC → discovery **shows** functions with free allowance remaining (aligns discovery with Phase-1 execution).
- [ ] `runtime_policy` (module access-policy) functions: classify via sandboxed `evaluateAccessPolicy`, or exclude from Free Mode.
- [ ] launch-web wallet "Free Mode" state + top-up CTA.
- **Acceptance:** allowance-backed free functions are both surfaced and callable; module-priced functions handled deterministically.

---

## 6. Gaps & risks
1. **No read-only allowance peek** — Phase-1 execution honors allowances (in-hold), but discovery can't surface them until Phase 3. Temporary mismatch: execution allows what discovery hid (safe direction).
2. **Per-function detection is heuristic** — transitive reachability over the bundle; conservative default `true`. Over-blocks rather than under-blocks (acceptable per D2). Re-derived only on (re)upload.
3. **`codemode` bypasses billing** in production (pre-existing) — mitigated by D4 (drop in Free Mode).
4. **Detection regex** matches `ultralight.ai(` only — fixed in Phase 0; until then `galactic.*`-authored apps may ship without `ai:call`/`uses_inference` (they then fail at runtime rather than upload).
5. **Module access-policy functions** can't be statically classified — Phase 3.
6. **Threshold change** ($0.50 → $0.25 inference floor) is a user-visible behavior change (intended, D3) — call it out in release notes.

## 7. Fail-open / fail-closed policy (D5)
- **Paid-call block → fail-open:** on a balance-read error, treat as **not** Free Mode (do not block a paying user). The downstream SQL debit still protects against an actual overspend.
- **AI-without-BYOK block → fail-closed:** on a balance/BYOK-read error in Free Mode, **block** the inference function (a $0 user must not be able to spend on platform inference).

## 8. Test plan (high level)
- Unit: `uses_inference` detection (direct, transitive, uncertain→true, `galactic.*` + `ultralight.*`).
- RPC: `create_app_call_runtime_cloud_hold` with `p_free_mode` — caller-charged → blocked pre-debit; owner-sponsored/self/price-0 → allowed; infra-fallback-to-caller → blocked.
- Handler: Free-Mode paid block (open on read error); AI block without BYOK (closed); AI allowed with BYOK; `gx.call` proxy + cross-agent covered; `gx.codemode` absent in Free Mode.
- Discovery: `tools/list` + `skills.md` hide paid/blocked; `free_mode` notice present.
- Threshold: inference floor now $0.25; Free Mode boundary identical.
