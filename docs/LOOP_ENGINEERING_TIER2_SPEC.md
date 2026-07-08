# Loop-Engineering Tier 2 — Implementation Spec

Two follow-ups to the full-time-agent track (PRs #75/#76/#78/#79). Neither blocks
launch; both make an always-on agent more trustworthy. Land **after** #78/#79
merge — both build directly on the flight recorder (#78) and the auto-pause
circuit breaker (#76).

- **A. Owner notifications** — tell the owner when their agent is auto-paused or
  hits a budget wall. *The real gap: there is no notification channel anywhere
  on the platform yet.*
- **B. Diff recording** — record what an agent's wake actually **changed** in the
  data, not just what it reasoned and did.

---

## A. Owner notifications (auto-pause + budget events)

### The gap today
`#76` already does the detection: `updateRoutineAfterRun`
(`api/services/routine-executor.ts`) writes `routine.metadata.auto_pause =
{ reason, at, ... }` and sets `status: "paused"`; the budget day/month gate in
`executeClaimedRun` records a skipped run with a `budget_*_exhausted` code. **But
nothing informs the owner** — they only find out by opening the routine monitor.
There is no notification primitive on the platform to reuse.

### Design — build a general primitive, not a routine-only hack
A durable per-user notification store that any subsystem can write to (routines
first; auto-heal, Connect, payouts, publish-gates are obvious later consumers).

**1. Storage** — new Supabase table `user_notifications`:

| column | notes |
|---|---|
| `id` | uuid pk |
| `user_id` | recipient (the routine **owner**) |
| `kind` | enum: `routine_paused`, `routine_budget_exhausted`, … |
| `severity` | `info` \| `warning` \| `critical` |
| `title`, `body` | human-facing copy |
| `entity_type`, `entity_id` | e.g. `routine`, `<routine_id>` — deep-link target |
| `action_url` | resume/configure link |
| `dedupe_key` | unique with `user_id` — idempotency |
| `created_at`, `read_at` | `read_at` null = unread |
| `delivered_channels` | jsonb — which channels have fired (in_app, email) |

**2. Service** — `api/services/notifications.ts`:
- `createNotification(input)` — **idempotent** on `(user_id, dedupe_key)` (Postgres
  `on conflict do nothing`), so a retried/re-claimed run never double-notifies.
- `listNotifications(userId, { unreadOnly?, limit? })`, `markRead(userId, ids[])`.

**3. Hook points** (best-effort, `waitUntil`, never block the executor):
- **Auto-pause** — in `updateRoutineAfterRun` where `autoPause` is set:
  `createNotification({ kind: "routine_paused", severity: "critical",
  dedupe_key: `routine_paused:${routineId}:${autoPause.at}`,
  title: "<name> was paused", body: <reason>, action_url: <resume link> })`.
  The `at` timestamp in the dedupe key = one notification per pause event.
- **Budget exhausted** — in the day/month skip branch of `executeClaimedRun`:
  `severity: "info"`, `dedupe_key:
  `routine_budget:${routineId}:${period}:${resetKey}`` so it fires **once per
  reset window** (UTC day / month), not on every skipped tick.

**4. Delivery channels**
- **v1 — in-product inbox (the table itself).** Surfaces:
  - `gx.notifications` (Tier-1 read capability): `list` / `mark_read` — so the
    owner's connected agent can surface "your Inbox Keeper was paused" in chat.
  - launch-web: a bell/inbox panel reading `GET /api/launch/notifications`
    (+ `PATCH` mark-read). The routine monitor already renders `auto_pause`;
    this adds the cross-entity global surface.
- **v2 — email (fast follow, behind a provider key).** Gated on a
  `NOTIFICATIONS_EMAIL_KEY` secret + a per-user preference (`notify_email`,
  default on for `critical`). One template per `kind`, unsubscribe honored.
  This is the piece that makes "works while you're away" honest — but it needs
  an external provider + deliverability, so it stays v2, not v1.
- Push/desktop: later, same primitive.

**5. Housekeeping** — 90-day retention sweep (hourly cron, like the call-log
sweep); notifications are strictly per-owner `user_id`.

### Decisions for the owner
1. **General primitive vs routine-specific?** → recommend general (many future
   callers). Small extra cost now, avoids a second system later.
2. **v1 in-app only, or email in the first cut?** → recommend in-app first (zero
   external dependency, unblocks the honesty gap immediately); email as the very
   next PR behind a key.
3. **Owner surface**: new launch-web bell **and** keep the routine-monitor
   inline reason. (Not either/or.)

### Rough size
Table + service + 2 hook calls + `gx.notifications` read + launch-web panel =
one focused PR for v1. Email (v2) is a second, smaller PR once a provider key is
chosen.

---

## B. Diff recording (state-change capture in the flight recorder)

### The gap today
`#78` captures each wake's `galactic.ai()` exchanges into
`globalThis.__flight.ai`, returns them in the result envelope, and persists them
as `routine_run_steps` at settlement (when `flight_recorder` + a routine context
are present). It records **what the agent thought and did** — but **not what
changed in the data**. You can see "it decided to archive three emails," not
"unread went 12 → 9."

### Design — cheap version: a per-wake DB write tally
Not full before/after snapshots (expensive, privacy-heavy, big storage). Just
count the mutations per wake, per table.

**1. Capture — host-side, in the DB binding (recommended over the SDK shim).**
`galactic.db` mutations (`insert`/`update`/`delete`/`upsert`/`batch`) run through
the D1 binding (`api/src/bindings/database-binding.ts` / `scoped-query.ts`),
which already sees each op and its D1 `meta` (rows written). Tally there, keyed
by `execCtxHandle`, and consume at result-build time the same way
`consumeAiSpend` is consumed in `dynamic-sandbox.ts`. Shape:

```
flight.db = {
  inserts, updates, deletes, upserts,      // op counts
  rows_written,                            // sum of D1 meta.changes
  by_table: { [table]: { inserts, updates, deletes, upserts, rows } }
}   // by_table bounded to N tables
```

> **Why host-side, not the SDK shim.** The shim (mirroring `__flight.ai`) is
> simpler, but it is *app-reported* — tenant code could undercount. The flight
> recorder is an **audit/evidence** surface, so the count must be
> host-authoritative. This is the one real design decision here.

**2. Persist** — fold the tally into the root routine step's `metadata` in
`recordRootStep` (`routine-executor.ts`), or the run's `metadata`. **No new
table** — it rides the existing `routine_run_steps`. Gate identically to the
ai-exchange persistence: `flight_recorder` + routine context.

**3. Read-back** — free. `galactic.runs.recent()` already returns steps with
metadata (`api/services/routine-recent-runs.ts`), so the agent and the owner see
the tally with no extra wiring.

**4. Reuse-key note** — if capture lives in the generated SDK template at all,
it changes the baked module text → bump `SANDBOX_TEMPLATE_VERSION` and repin the
snapshot test (same dance as #78). Host-side (binding) capture avoids this
entirely — another point for the binding approach.

### Scope
- **v1**: counts only — "N rows inserted / updated / deleted, by table." Answers
  "did anything actually change, and roughly what," and catches the silent-no-op
  case (agent *thinks* it acted; nothing moved).
- **Deferred (v2+)**: actual before/after row values. Expensive (read-before-
  write), privacy-sensitive, storage-heavy — explicitly out of scope for now.
- **Optional same-pattern extension**: also tally app-data (`store`/`remove`) and
  `memory` writes. Nice, not required.

### Decision for the owner
- **Capture site: host-side binding (trustworthy) vs SDK shim (simple).** →
  recommend binding, because this is an audit record.

### Rough size
One PR: binding-side tally + consume at result build + fold into the root step
metadata. Smaller than #78 (no new binding, no new read API — reuses
`runs.recent`).

---

## Sequencing
1. Merge #78 + #79, cut the prod tag, smoke the loop live (blocked on CI/Actions
   as of 2026-07-08).
2. **B (diff recording)** — small, extends the recorder you just shipped; do it
   while the flight recorder is fresh.
3. **A (notifications)** — v1 in-app, then v2 email. Larger because the channel
   is net-new.

Tier 3 (owner-writable / user-readable app-global scope for multi-subscriber
shared presence) is **deferred from launch** and stays on the design shelf.
