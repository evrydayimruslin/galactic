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
- **Stage 1 — registry + AI spend off props.** Add `execution-context-registry.ts`
  + mint/verify `execCtxToken`. Thread to `AIBinding.call`; resolve `aiExecutionId`
  from the registry; drop `executionId` from AIBinding props. register/deregister
  around the fetch. Still `load()` → props and registry agree → zero-behavior-change
  diff. Test: recordAiSpend keyed correctly; replayed/absent handle → 0 debit.
- **Stage 2 — cloud metering off props.** Thread `execCtxToken` through
  DB/DATA/MEMORY methods; resolve `operationMetering` from the registry; drop it
  from all three props. Convert EventsBinding `callerContextToken` from prop to
  per-RPC token. Still `load()`. Test: debits land on the correct receiptId/hold;
  forged handle → no debit.
- **Stage 3 — enable `get()` behind `EXECUTED_LOADER_GET_REUSE` (default OFF).**
  `loader.load()` → `loader.get(key, cb)`. Stages 1-2 already made props
  reuse-safe. Flag OFF in prod, ON in staging. Test: reuse an isolate across two
  executions with DIFFERENT executionId/receiptId → each debit lands on its OWN
  context (no free inference, no cross-hold debit).
- **Stage 4 — staging isolation smoke + adversarial review = PROD GATE.** Extend
  `scripts/smoke/sandbox-isolation-smoke.ts` (flag ON): (i) concurrent two-user
  cross-billing probe, (ii) stale/replayed-handle probe, (iii) tenant-isolation
  regression (userId-in-key still scopes D1/DATA/MEMORY). Adversarial review. Only
  then flip the prod flag (mirroring DATA_TENANT_ENFORCE / free-mode discipline).

## Per-binding change list
- **AIBinding** (ai-binding.ts:100/116/309): +execCtxToken param; resolve
  aiExecutionId from registry; drop `executionId` from props. apiKey/provider/
  model/shouldDebitLight/shouldRequireBalance STAY in props (per-(user,route),
  valid — key retains userId).
- **DatabaseBinding** (database-binding.ts:85 + each select/first/count/insert/
  update/delete/upsert/batch): +execCtxToken; resolve metering; drop
  operationMetering/operationBillingConfig from props; KEEP databaseId/appId/userId.
- **AppDataBinding** (appdata-binding.ts:42): same; KEEP appId/userId.
- **MemoryBinding** (memory-binding.ts:54): same; KEEP userId/appId.
- **EventsBinding** (events-binding.ts:32): callerContextToken prop → per-RPC token.
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
