# Launch Release Packet — Durable-Execution Cut (PR1–PR6)

Date: 2026-06-11. Covers commits `499addd` (PR1), `175d558` (PR2), `ac3c167`
(PR3), `85ee6c8` (PR4), `8e77ee6` (PR5) and the PR6 ops changes. Complements
[RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) (procedure),
[SMOKE_CHECKLISTS.md](SMOKE_CHECKLISTS.md) (verification), and
[DURABLE_EXECUTION_ROADMAP.md](DURABLE_EXECUTION_ROADMAP.md) (decision record
per PR).

## What this cut ships

- Failure honesty + billing correctness: authoritative AI-spend accounting
  (abort-proof, tenant-tamper-proof), failed deliveries/jobs recorded as
  failed, provider-fetch timeouts.
- Internal call-path hygiene: all internal loopbacks on the SELF binding
  (no public-URL self-fetch), dead user-cron system deleted.
- Durable async execution on Cloudflare Queues: manifest
  `execution.class: "async"` (or `_async: true`) returns a job envelope in
  milliseconds; the queue consumer runs up to 300s with full settlement;
  poll via `ul.job` / `ultralight.job` / `GET /api/launch/jobs/:id`.
- Event bus on Queues: emit→delivery in seconds with bounded-concurrency
  fan-out; the minute cron demoted to an enqueue-only recovery sweeper.
- Hot-path streamlining: billing-config + api-token verdict caches,
  supabase-bearer auth chain 3 RTs → 1, entity-index rebuild debounce,
  per-tenant isolate resource ceilings.

## Pre-announce checklist (operator actions)

- [ ] Run migration `20260611090000_async_jobs_durable_execution.sql`
      (staging + production).
- [ ] Provision the 8 queues (see RELEASE_RUNBOOK.md “Durable Execution
      Rollout”) — the deploy workflow also does this idempotently.
- [ ] Set secrets per environment: `AGENT_CALLER_SECRET`,
      `ROUTINE_ACTOR_TOKEN_SECRET` (or `WORKER_SECRET`), plus the existing
      list in `api/.dev.vars.example`.
- [ ] Supabase Auth production redirect URLs include the production
      launch-web origin.
- [ ] Staging: green `durable-exec-smoke.mjs` run (proves `ctx.exports`
      inside `queue()` — undocumented platform behavior — plus claim,
      limits, settlement).
- [ ] Staging: manual checks from SMOKE_CHECKLISTS.md (emit→delivery,
      SELF loopbacks, Stripe test topup→webhook→balance, browser session
      refresh, tenant-limits sanity).
- [ ] Legal review of /terms and /privacy (launch placeholders are honest
      but unreviewed; the top-up checkbox links to /terms).
- [ ] Starter-credit decision (below).

## Open product decision: starter credits

New accounts currently start at 0 credits; the only acquisition path is a
Stripe top-up. Options:

1. **No starter credits** — simplest; first-run experience requires a card,
   which suppresses activation.
2. **Small one-time grant (recommended)** — e.g. 50–100 credits on first
   login, enough for a handful of inference calls to feel the product.
   Bounded abuse surface (provisional accounts already expire after 24h
   idle; grants are per-account, sybil cost ≈ OAuth identity). Requires a
   small ledger entry type + idempotent grant at first-contact provisioning.
3. **BYOK-first onboarding** — steer new users to bring their own key
   (zero platform inference cost) and reserve credits for platform-billed
   features. Lowest cost, highest setup friction.

Recommendation: (2) with a low amount, plus (3) as the documented
power-user path. Not implemented in this cut — needs a product sign-off on
the amount and the ledger entry.

## Accepted risks (deliberate, documented)

| Risk | Bound | Where decided |
| --- | --- | --- |
| Revoked api-token honored up to 60s in isolates the revoke didn't run in (in-isolate verdict cache; every revocation path evicts locally) | 60s TTL | PR5 |
| Admin billing-config change converges per-isolate within 60s | 60s TTL | PR5 |
| `_async: true` opt-in grants the 300s budget to functions whose owners never declared async (balance-gated; grant-capped cross-agent) | caller's balance / grant cap | PR3 |
| A queued job that outlives the 60-min queued sweep fails honestly rather than executing late | 1h backstop | PR3 |
| A cpuMs/subRequests kill loses tenant logs for that execution (spend accounting still settles via PR1) | per-execution | PR5 |
| Tenant resource ceilings (apps 512 subrequests / codemode 128) are set conservatively but unverified against workerd accounting until the staging smoke | staging smoke gate | PR5 |
| Event/delivery timestamps stamp pass-claim time, not per-row write time (audit columns only; billing uses receipts) | minutes | PR4 |
| `last_used_at` on api tokens updates per cache miss (≤60s granularity) | 60s | PR5 |
| Pending-permission invites created in the sub-second window around a user's first contact resolve at next session establishment (≤~1h) instead of next request | ~1h, fail-closed | PR5 |

## Resolved since packet creation

- Repeated same-operation R2/KV debits per receipt no longer collapse: ruled
  an undercharge bug (the debit RPC silently returned the first call's result
  for duplicate idempotency keys). Each metered call now carries a per-call
  key discriminator; semantics pinned by a test in
  `api/services/cloud-usage.test.ts`. Note this raises metered storage charges
  to their intended per-operation level.

## Post-launch register (tracked, not blocking)

Operator dashboards/alerts over failed jobs + deliveries; codemode metering
economics; at-least-once event delivery with idempotent settlement;
reasoning-journal feature; webhook `secret` auth mode; event reply channel
(`correlation_id`); GPU grant-cap gate before enabling GPU; Phase 2/3 alias
removals; Workflows adoption for >15-min jobs; per-user emit rate limit.
