# P2.3 — Agent Fleet and Developer Schedules (2026-07-17)

P2.3 keeps the private, single-owner launch boundary while widening what one
owner can operate: an Agent may have multiple independently managed routines,
use interval, cron/timezone, or reactive event triggers, and consume an
owner-configured share of the account's subscription capacity. The launch web
surface becomes one compact Fleet with Agent, Alert, and Settings overlays.

## Locked launch contract

- Every launch Agent remains private, owned, and operated by one account.
- One routine is elected `primary` for compatibility and Agent-level defaults;
  any number of additional managed routines may run within the same shared
  account and per-Agent capacity ceilings.
- Scheduled routines accept safe intervals or strict five-field numeric cron
  expressions with an IANA timezone. The scheduler computes timezone-aware
  occurrences, including daylight-saving transitions, on the server.
- Reactive Agent events preserve the signed root Agent for capacity
  attribution. A structured pre-execution capacity denial waits durably and
  resumes once; an ordinary or ambiguous handler failure remains terminal.
- Paid owners may cap an Agent from `0.01%` through `100%` of both account
  windows. The cap is enforced atomically with account admission across direct,
  nested, scheduled, and reactive work. Free remains fixed and qualitative.
- Paid UI surfaces may show percentage usage, but raw Light allowances remain
  private calibration data. Free surfaces show only `available`, `low`, or
  `waiting` and reset times.
- Agent-generated and platform-generated Alerts carry Agent attribution and can
  be filtered without weakening the account-wide inbox.
- The compact Fleet response contains owner-private Agent identity, aggregate
  routine state, next wake, deferred wakes, unread Alerts, and three recent
  activities. It deliberately excludes secret values, routine config, run
  arguments, and raw capacity limits.
- Agent icons accept validated PNG, JPEG, WebP, or GIF content. Animated GIFs
  are bounded by bytes, dimensions, and frame count and are served with
  content-addressed URLs.
- Runtime memory remains available to Agent code but is not a launch-web pane.
  Billing stays in Stripe; variables/settings remain presence/status-only.

## Mutation and concurrency rules

Managed-routine writes require an account session, exact private ownership, an
opaque Agent revision, and the exact routine id. Database compare-and-swap owns
the mutation. Pausing one sibling does not release the Agent's activation slot;
pausing the final active sibling does. On Free, concurrently activating routines
on different Agents atomically admits only one Agent, while sibling routines on
the already-active Agent remain allowed.

Every capacity reservation uses a unique execution idempotency key and the
signed root Agent. Reservation, settlement, release, expiry, and policy changes
share an account advisory lock and a deterministic row-lock order. Admitted work
settles actual usage even when it exceeds its prediction or the cap changes
while it runs.

## Web surface

`/` and `/agents` resolve to the same Fleet experience. `/agents/:slug` keeps
that Fleet visible behind the selected Agent overlay. `/account` opens Settings
over the Fleet. The bell opens account Alerts; an Agent overlay has its own
filtered Alerts, Interfaces, Routines, Functions, and Settings panes. Memory is
intentionally absent. Existing public, admin, legal, and authentication routes
remain compatibility surfaces rather than primary navigation.

## Deployment order

1. Apply migrations `20260717120000` through `20260717160000` in filename order.
2. Run real-Postgres concurrent activation and capacity reserve/settle/release
   checks with the Agent-capacity feature gate still off.
3. Drain in-flight legacy v1 capacity reservations/executions.
4. Deploy the API Worker, then set `AGENT_CAPACITY_ENABLED=1`.
5. Deploy the launch web app and exercise Fleet, interval/cron routines,
   Agent-filtered Alerts, cap changes, GIF icons, and Stripe delegation.

Do not enable the gate before the migration and concurrency smoke. Routines and
reactive events auto-resume after capacity opens; generic durable async jobs
remain terminal on a pre-execution capacity denial in this milestone.
