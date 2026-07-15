# Launch P1 — Agent Home Contract

Date: 2026-07-14

Contract version: `2026-07-14.v1`

Depends on: Launch P0 persistent-Agent safety

## Outcome

Agent Home is the authenticated owner's canonical operating surface for one
private persistent Agent. `Overview` is the home tab; `Functions` and
`Interfaces` remain focused inspection/configuration tabs. The website is not a
second Agent builder: connected coding agents continue to build and test with
`gx.download`, `gx.test`, and `gx.upload`.

The canonical read model is
`GET /api/launch/agents/:id/home`. It is an owner-only aggregate over the shared
runtime, not a parallel backend. Focused writes mutate identity, routine
configuration, settings, or runtime/release actions and return a fresh aggregate
snapshot.

`POST /api/launch/agents/:id/home/pause` is the deliberate safety exception:
an idempotent owner-only stop lane that does not depend on the aggregate,
revision CAS, or an action/promotion lease. It remains available from the UI
even when the Home read model is degraded. Legacy routine mutation routes are
retired so they cannot bypass this contract; the legacy routine route is
read-only. Its database RPC locks the private owned Agent and current canonical
routine in one transaction, refuses a concurrently disabled routine, and
idempotently clears the next wake while setting the routine to paused.

## Locked P1 choices

1. One versioned Agent Home aggregate read contract.
2. Lifecycle, execution, and health are independent dimensions.
3. Allowed actions disclose the full authority envelope: exposed functions,
   runtime permissions, network destinations, AI, storage, memory, reporting,
   downstream Agent calls, and their grants.
4. Data-source and setting requirements are actionable and write-only. Values
   never round-trip; required missing values block activation.
5. Budgets show both hard ceilings and exact current consumption in Credits.
6. Live and tested staged release state appear on Overview, including executed
   bundle integrity and structured authority changes.
7. Owner configuration uses a durable, config-only optimistic revision and
   database-level compare-and-swap. Routine wakes and usage updates do not make
   an unrelated form stale.
8. Overview shows five bounded recent runs. A run detail link remains absent
   until a real trace-detail surface exists.

## Read model

The `LaunchAgentHomeResponse` contract lives in
`shared/contracts/launch.ts`. It contains:

- Agent identity and private visibility;
- live mission, interval cadence, and Galactic inbox reporting readiness;
- lifecycle (`needs_setup`, `ready`, `active`, `paused`, `disabled`), execution
  (`idle`, `queued`, `running`), and health (`unknown`, `healthy`, `degraded`,
  `failing`);
- structured activation blockers and setup requirements;
- requested, approved, and effective authority with an explicit approval basis;
- per-run/daily/monthly/call ceilings and UTC-window usage;
- the live release, executed version/integrity, and newest valid tested staged
  candidate;
- five sanitized run summaries; and
- server-derived action availability.

An Agent can be `active` while `setup.ready` is false after configuration or
authority is removed. The scheduler state is never relabeled to hide that
condition; run/activation actions fail closed until the blocker is resolved.

## Authority semantics

`requested`, `approved`, and `effective` are not synonyms:

- manifest authority is admitted by the live release and carries
  `approvalBasis: live_release`;
- a routine capability requires explicit owner approval;
- a downstream call is effective only while its target remains valid and its
  matching grant is active and below its cap;
- unsupported manifest permission strings remain visible but ineffective;
- Agent-authored inbox reporting requires the effective `notify:owner`
  permission; platform-generated budget/pause notices are separate platform
  policy.

Read/Write/AI badges remain disclosure. Runtime authorization, grants, network
policy, and hard budget admission remain authoritative.

## Settings and secrets

Overview includes both scopes:

- `agent`: owner-managed universal settings stored encrypted on the Agent;
- `per_user`: owner-as-caller settings stored in the per-user vault.

The response contains only declarations, configured state, timestamps, and
destination binding. Credential-bound fields are secret even when their input
widget is not `password`. Set, replace, and remove operations accept plaintext
only over the authenticated mutation request, encrypt before persistence, and
return a new status snapshot without values.

Removing a required value makes the Agent unready and prevents further wakes;
the runtime never interprets a missing setting as an empty value.

## Revisions and mutations

The revision token is opaque, Agent-bound, and backed by a monotonic database
revision. It changes for owner configuration and authority changes, including:

- identity/description;
- live release and manifest authority;
- routine mission, cadence, ceilings, status, and capability approvals;
- Agent-wide or per-user settings; and
- downstream grants.

It deliberately excludes run rows, usage/reservation progress, next/last wake
timestamps, and other volatile monitoring state. Focused configuration writes
perform database-level compare-and-swap. A stale request returns HTTP 412 with
the machine code `AGENT_HOME_REVISION_CONFLICT` and a fresh snapshot; clients keep
the dirty draft for review.

## Release truth

`current_version` is database intent, not proof of executing code. Agent Home
therefore reports the live bundle's attested executed version and integrity.
Sustained mismatch is a blocker and degrades health. Promotion remains an
explicit account-session action and revalidates the exact tested source,
manifest, authority delta, staged artifacts, and migrations before changing the
live pointer.

The singular candidate is the newest unique, non-live version with valid
persisted `gx.test` proof. Untested or metadata-only versions cannot displace a
valid tested candidate. Owner-facing authority changes are structured and
sanitized; internal canonical separators are never exposed.

## Action durability

Owner actions carry a client-stable UUID idempotency key and a canonical request
fingerprint. Except for emergency pause, the database permits one in-progress
action per Agent, leases each attempt with a rotating fencing token, and allows
takeover only after expiry. A replacement key for the exact same canonical
request is durably aliased to the original request, so late retries from either
browser remain idempotent. A different request first receives the exact
owner-scoped recovery action and reconciles it before proceeding. Terminal
results replay only for the identical canonical request.

`run_now` validates the current revision, active launch-primary routine, request
lease, unique run linkage, and the routine's queued/running concurrency capacity
in one transaction. A consumer-side database trigger also enforces
`max_concurrency` on every transition to running. A lost response therefore
reconciles to the existing run instead of enqueueing a duplicate, and separate
manual requests cannot overlap a single-concurrency launch routine.

Candidate promotion treats database intent, attested live bundle, and exact live
storage accounting as separate commit facts. Retries distinguish untouched,
partially applied, and fully applied state. Partial state is repaired with the
same request; every irreversible D1, live-bundle, app-record, and accounting
step renews the current fencing lease. The first irreversible phase atomically
checks the exact reviewed Home revision and starts a durable promotion saga.
While that saga is active, a database trigger rejects competing release-field
writes; its app-record commit is a dedicated lease-token RPC. Repair retries use
the durable saga/postconditions rather than incorrectly comparing against a
revision the promotion itself advanced. An ambiguous acknowledgement remains
nonterminal and the client retries the same key—it is never mislabeled failed.

## Security and transport

Every Agent Home route requires an authenticated account session, exact owner,
private visibility, and a non-deleted Agent. API tokens and routine/sandbox
actors are rejected even when a valid browser cookie is also present.

Responses set:

```text
Cache-Control: private, no-store
Vary: Cookie, Authorization
```

Secret values, ciphertext, routine config/metadata, run arguments/results,
BYOK material, raw source, and attestation tokens are excluded recursively.

## Deferred

- new run/trace observability console;
- multiple routines, cron/timezones, or external reporting destinations;
- cross-user collaboration and sharing;
- marketplace, pricing, monetization, and trust/reputation surfaces;
- a website Agent builder.
