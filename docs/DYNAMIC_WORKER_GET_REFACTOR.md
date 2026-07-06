# Dynamic Worker `load()` → `get()` refactor — design

**Goal:** stop paying Cloudflare's Dynamic Worker per-load fee on every execution by
reusing warm isolates, without weakening tenant isolation, and align the cost
basis with the chosen **per-agent-per-user-day** billing model.

## Why it isn't a one-line swap

`executeInDynamicSandbox` (api/runtime/dynamic-sandbox.ts) bakes **per-request**
data into the worker's *content*, then invokes `getEntrypoint().fetch(new
Request("http://internal/execute"))` with **no payload**. Cloudflare's contract:
`get(id, cb)` caches the isolate (incl. `env`), the callback "must return exactly
the same content for the same ID," and "if anything about the content changes,
use a new ID." Since our content changes every call, a stable-ID `get()` would
serve a **stale auth token / wrong args** (a security + correctness bug) or never
cache (no savings).

### What is baked today, and where it must go

| Data | Baked in | Varies by | Target |
|---|---|---|---|
| `functionName`, `args` | `wrapper.js` (`escapedFnName`/`escapedArgs`) | every call | **→ per-request** (fetch body) |
| `sandboxAuthToken` (executionId-scoped) | `setup.js` | every call | **→ per-request** |
| `callerContextToken` | `setup.js` | every call | **→ per-request** |
| `callDependencies` (grant-gated app:call allowlist) | `setup.js` (`__ulAllowsAppCall`) | user + grant state | **→ per-request** |
| `config.user` | `setup.js` (`userJson`) | user | baked; covered by `userId` in key |
| `credentials` (decrypted values) | `CredentialBinding` props (env) | user + secret rotation | baked; covered by `stateFingerprint` |
| AI route / BYOK | `AIBinding` props (env) | user + BYOK change | baked; covered by `stateFingerprint` |
| `envVars`, `permissions` | `setup.js` | app-version only | baked; covered by `bundleHash` |
| `esmCode` (app.js) | module | app-version | baked; covered by `bundleHash` |

## Design — "Level 1" (per-user isolate reuse)

Chosen because it maps **1:1 to the per-agent-per-user-day billing model** and
requires **no change to the security-critical per-user bindings** (each user keeps
their own isolate with their own baked DB/MEMORY/AI/CREDENTIALS/OUTBOUND bindings —
we only warm-reuse it across *that user's* repeated calls).

**Cache key:** `` `${appId}:${bundleHash}:${userId}:${stateFingerprint}` ``
- `bundleHash` — code change ⇒ new isolate (correct new version).
- `userId` — **never reuse across users** (the tenant-isolation guarantee, by construction).
- `stateFingerprint` — `sha256(credentials ‖ aiRoute/BYOK ‖ call-dependency/grant state)`;
  any secret rotation or grant change ⇒ new isolate (no staleness).

**Per-request payload** (moved out of baked content, passed as the fetch body;
the wrapper reads `await request.json()`): `functionName`, `args`,
`sandboxAuthToken`, `callerContextToken`, `callDependencies`. None of these enter
the cache key, so they don't bust reuse.

**Invocation:** `loader.get(key, () => loadConfig)` — the callback (building
`loadConfig`) runs only on a cache miss.

### Reset-on-reuse correctness
The wrapper already resets `globalThis.__aiCostLight = 0` and rebinds
`globalThis.__rpcEnv = env` per fetch (comment at dynamic-sandbox.ts already
anticipates reuse). Extend that discipline: any per-execution global (logs array
is already function-local) must be initialized inside `fetch`, never at module
top-level. Audit `setup.js` for module-level per-execution state (there is none
today beyond the baked literals we're moving).

### AI-spend ledger
`consumeAiSpend(executionId)` is keyed by `executionId` in the **parent** and is
unaffected by isolate reuse (the authoritative ledger lives parent-side; the
sandbox number is cross-checked only).

## What does NOT change
- Per-user binding isolation (CredentialBinding etc. still parent-side, still
  per-user props). Reuse is scoped to a single `(app, version, user, secret-state)`.
- `globalOutbound: null` fail-closed egress, `limits`, SELF binding gating.
- `load()` stays for **codemode** (it bakes the user *into the recipe code* and
  fans over N app bundles — no stable identity to key on).

## Verification gates (before prod)
1. Unit tests: key derivation (cross-user ⇒ different key; rotation ⇒ different
   key; same user+state ⇒ same key), and per-request payload round-trip.
2. **Staging `sandbox-isolation-smoke`** — must prove: (a) user A's call never
   observes user B's data/secrets on a warm isolate; (b) a rotated secret is not
   served stale; (c) a code redeploy mints a new isolate. Non-negotiable on the
   tenant boundary.
3. Adversarial review (cross-tenant reuse, stale-state, per-request-injection).

## After it lands
Cloudflare cost becomes ~1 load per `(agent, user, secret-state)` per day →
flip the per-load floor to charge **once per (agent, user, UTC-day)** (gate the
existing `workerLoadLightPerInvocation` charge on a daily marker) at 0.5 Light
($0.005). Also close the **codemode** infra-billing gap (it creates no cloud hold
at all — a separate PR).
