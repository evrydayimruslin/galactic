# Dynamic Worker `load()` → `get()` — staged design (v2, post concurrency finding)

**Goal:** reuse warm V8 isolates via Cloudflare Worker Loader `get()` to cut the
now-mandatory Dynamic Worker per-load fee (~1 load/call → ~1 load/(app,user)/day),
**without** any tenant-isolation or billing-integrity regression.

## The two findings that shape the design

1. **`get()` caches the isolate INCLUDING its env bindings, frozen at load.** So any
   per-**execution** value baked into a binding's props (AIBinding `executionId`;
   DB/DATA/MEMORY `operationMetering` = receiptId/holdId/functionName/payerUserId)
   goes **stale** on a warm hit → free inference + cloud-debits against a closed
   hold. (The PR #67 security review.)
2. **A warm isolate serves CONCURRENT requests through a SHARED `globalThis`.**
   Cloudflare: *"a single Workers instance may handle … concurrent requests in a
   single-threaded event loop"* and *"Pass state through function arguments … Never
   in module-level variables."* So `globalThis.__rpcEnv = env` (today's pattern,
   dynamic-sandbox.ts) and the draft's `globalThis.__ulReq` are **race hazards** —
   independent of staleness. Warm reuse just makes the race common instead of rare.

**Corollary:** per-execution context must (a) never live on `globalThis`, and (b)
never enter the sandbox in forgeable form (payerUserId/receiptId must stay
parent-side). AsyncLocalStorage is NOT available in the sandbox (no
`nodejs_compat` on the loadConfig), so context must be threaded as explicit
call-frame arguments.

## Chosen design — HYBRID (reuse KEY + parent-side registry)

- **Reuse key:** `` `${appId}:${bundleHash}:${userId}:${secretFingerprint}` ``.
  Per-(app, version, user). Keeps all **per-tenant** props (databaseId, appId,
  userId, credentials, aiRoute) valid on reuse. `secretFingerprint` = sha256 of
  ONLY the mutable-per-user secrets (credential values + BYOK key) so a rotation
  mints a fresh isolate (no stale secret) — a NARROW fingerprint, not the draft's
  whole-state blob (which fragmented reuse). `functionName`/`args`/`authToken`/
  `execCtxToken` are NOT in the key.
- **Per-execution context registry (parent-side):** a new
  `execution-context-registry.ts` (module Map, modeled on `ai-spend-tracker.ts`):
  `register(executionId, { aiExecutionId, cloudOperationMetering,
  cloudOperationBillingConfig })` before the loader fetch; `deregister` in a
  `finally`. These are the ONLY per-call fields; tenant identity stays in props.
- **Unforgeable handle:** the parent mints `execCtxToken =
  signed({executionId, jti, exp})`, passes it into the sandbox (like
  `callerContextToken` today), and the wrapper reads it from the Request. The
  sandbox echoes it as a trailing arg on every binding RPC (`e.AI.call(r,
  execCtxToken)`, `e.DB.select({...}, execCtxToken)`, …). The binding
  **verifies** (HMAC+exp) and **resolves** the registry entry synchronously;
  payerUserId/receiptId **never enter the sandbox**. Absent/expired/replayed →
  fail-closed (no debit).
- **Concurrency-safe SDK facade:** replace `globalThis.__rpcEnv = env` with a
  **per-fetch facade** built inside `wrapper.fetch(request, env)` that closes over
  `{env, execCtxToken}` and is passed explicitly to the app — no module-level
  mutation. The parent registry is synchronous (no await between resolve and use)
  to avoid a TOCTOU vs deregister.

## Stages (each independently landable + testable; `load()` until Stage 3)

- **Stage 0 — concurrency proof + facade refactor (pure, still `load()`).**
  (a) A test firing 2+ concurrent executions at one warm isolate, asserting the
  shared-`globalThis` hazard empirically. (b) Refactor the sandbox SDK off
  `globalThis.__rpcEnv` to a per-fetch-bound facade threading `{env,
  execCtxToken}` explicitly. Backward-compatible (load() still per-call). Isolates
  the highest-risk change from billing. Gate: wave3-e2e + unit green.
- **Stage 1 — registry + AI spend off props. ✅ DONE (ba6431b).** Added
  `execution-context-registry.ts`. Design deviation from the sketch: the sandbox
  gets an OPAQUE RANDOM HANDLE (128-bit) resolved against the parent-side
  registry, NOT a signed/verified token — strictly safer (the sandbox holds
  nothing forgeable; an unknown handle → null → fail closed) and needs no signing
  secret. Threaded to `AIBinding.call`; `aiExecutionId` resolves from the registry.
  register/deregister around the fetch. Still `load()` → props and registry agree.
- **Stage 2 — cloud metering off props + events per-RPC. ✅ DONE (1254ca1).**
  Threaded `execCtxHandle` through every DB/DATA/MEMORY public method; a
  `meteringContext()` helper resolves `operationMetering`/`billingConfig` from the
  registry. EventsBinding `callerContextToken` now resolved per-RPC (it bakes in
  the per-call entry function + hop; a frozen prop would report a stale hop and
  defeat the hop ceiling). **Deviation — props KEPT, not dropped:** the resolution
  rule is *handle threaded → resolve-or-FAIL-CLOSED (never read props); handle
  absent (legacy/direct-call) → props fallback*. This is a genuine no-op under
  `load()` (handle always resolves to the same value props hold) AND already
  reuse-safe (under `get()`, stale props are never consulted). Net effect: Stage 3
  becomes a pure loader flag flip with ZERO further billing-logic edits. Still
  `load()`. Curated suite 1314 passed / 0 failed.
- **Stage 3 — enable `get()` behind `EXECUTED_LOADER_GET_REUSE` (default OFF). ✅ DONE.**
  `loader.load()` → `loader.get(reuseKey, cb)` when the flag is `1` AND the
  execution is reuse-eligible. Per-call data moved off baked literals onto the
  fetch body (functionName/args/authToken/callerCtx/execCtxHandle); wrapper reads
  them per fetch and resets `__aiCostLight` + `__emitCount`. Reusable-isolate
  bindings carry `requireExecCtx=true` → a handle-less direct-binding RPC fails
  closed (`assertExecutionContext`). Flag OFF in prod (`[vars]` comment), ON in
  `[env.staging.vars]`. Tests: `dynamic-sandbox-reuse-key.test.ts` (isolation
  invariants), `dynamic-sandbox-get-reuse.test.ts` (load-vs-get dispatch, body
  plumbing, warm-hit frozen-env, eligibility gates).

  **Stage-3 adversarial review (~57 agents, 6 dimensions, 3-lens verify) found 8
  confirmed findings; all fixed before commit:**
  - *reuse-key completeness (medium×2/low):* the key now folds in a
    `SANDBOX_TEMPLATE_VERSION` constant, the resolved D1 `dbId`, and `hasDb`/
    `hasMemory` binding-set presence (`bindingState` param) — previously a lazily
    (re)provisioned DB or a toggled binding set could collide on one warm isolate
    (sticky "D1 not available" / split-database writes). `SANDBOX_TEMPLATE_VERSION`
    is a manual constant, so `dynamic-sandbox-template-version.test.ts` snapshots
    the generated setup/wrapper for a fixed config and fails loudly on any
    template drift — converting "forgot to bump the version" into a CI failure.
  - *hop-ceiling + function-grant defeat (HIGH + medium):* `ultralight.call`
    reads its caller-context token from the app-mutable, sibling-shared
    `globalThis.__ulReq.callerCtx`; a warm isolate serving concurrent same-(app,
    user) executions could let a deep-chain call present a shallow-hop token
    (defeating `MAX_AGENT_CALL_HOP_DEPTH`) or replay a captured token to bypass a
    function-scoped grant. A host-side move alone does NOT fix this (the RPC still
    reads the shared `__execHandle`), and there is no AsyncLocalStorage in the
    sandbox. **Fix: cross-Agent-call-capable executions are ineligible for reuse**
    (`isolateReuseEligibility` → `cross_agent_call_capable` when app:call /
    appCallDependencies / slotBindings present) → they stay on `load()`, one
    isolate per call, no shared-globalThis race and no cross-execution module
    state. The token is minted for every non-anon user but only *usable* by
    `ultralight.call`, so gating on call-capability is the precise cut. (Future:
    a host-side call binding + async-context handle store could reclaim reuse for
    these apps.)
  - *test fidelity (medium/low):* both `loader.get` mocks now cache-by-id (build
    callback fires once per id; warm hits replay frozen env/modules), so the
    frozen-props / body-wins / fail-closed contract is actually exercised; the
    wave3 mock also gained `aiCostLight` + the `Available:` fn list.
  - *`__proto__`-in-args (low):* NOT a regression — the new body-`JSON.parse`
    path prevents the prototype-pollution the old baked-object-literal allowed.
- **Stage 4 — staging isolation smoke + adversarial review = PROD GATE.** Extend
  `scripts/smoke/sandbox-isolation-smoke.ts` (flag ON): (i) concurrent two-user
  cross-billing probe, (ii) stale/replayed-handle probe, (iii) tenant-isolation
  regression (userId-in-key still scopes D1/DATA/MEMORY). Adversarial review. Only
  then flip the prod flag (mirroring DATA_TENANT_ENFORCE / free-mode discipline).

## Per-binding change list (as SHIPPED)
Props are KEPT on every binding as the legacy no-handle fallback (see Stage 2
deviation); the per-call values are resolved from the registry whenever a handle
is threaded. Nothing was dropped from props.
- **AIBinding** (ai-binding.ts): +execCtxHandle param; resolve aiExecutionId from
  registry; refuse the call if a threaded handle is unresolvable. `executionId`
  KEPT in props as the no-handle fallback. apiKey/provider/model/
  shouldDebitLight/shouldRequireBalance stay in props (per-(user,route), valid —
  the reuse key retains userId).
- **DatabaseBinding** (each select/first/count/insert/update/delete/upsert/batch):
  +execCtxHandle; `meteringContext()` resolves metering; props kept; the guard
  `if (h !== undefined) this.execCtxHandle = h` preserves the handle when `batch`
  fans out to insert/update/delete via `dispatchWrite` (no handle re-passed).
- **AppDataBinding** (store/load/remove/list): +execCtxHandle; same helper.
- **MemoryBinding** (remember/recall): +execCtxHandle; same helper.
- **EventsBinding** (emit): +execCtxHandle; callerContextToken resolved per-RPC
  from the registry (prop kept as no-handle fallback).
- **ai-spend-tracker.ts:** unchanged (parent-side, keyed by config.executionId).
- **NEW execution-context-registry.ts:** register/resolve/deregister + bounded TTL
  sweep (mirror ai-spend-tracker.ts).

## Open decisions (defaults chosen; confirm)
- Key = per-(app,user) — right cost/isolation tradeoff (rejected per-(app) which
  would make the handle a tenant boundary). **KEEP** a narrow secret-only
  fingerprint for rotation safety (design refinement over the synthesis's
  drop-it).
- `execCtxToken` exp must exceed the LONGEST execution (async/batch/routine can
  exceed 60s) — set exp to the async ceiling, not 60s; the registry entry lives
  by deregister-in-finally regardless.
- Rollout: `EXECUTED_LOADER_GET_REUSE` ships default-OFF in prod, flips only after
  the staging isolation smoke is green.
- Draft PR #67 is SUPERSEDED by this plan (its key + `__ulReq` global are the
  concurrency hazard); close it.
