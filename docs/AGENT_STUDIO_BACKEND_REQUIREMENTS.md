# Agent Studio backend requirements

This is the durable implementation memory for backend work exposed by the
July 2026 Agent Studio handoff. Requirement IDs are stable. Product copy,
frontend controls, API contracts, migrations, runtime enforcement, and tests
should reference these IDs instead of creating parallel concepts.

Status meanings:

- **Implemented** — enforced end to end and covered by tests.
- **Partial** — a safe subset exists; the missing acceptance criteria remain
  required.
- **Contracted** — shared types and semantics exist, but storage/runtime/routes
  are not implemented.
- **Required** — no adequate platform contract exists yet.
- **Invariant** — a boundary that future work must preserve.

## Priority ledger

| ID | Requirement | Status | Dependencies |
| --- | --- | --- | --- |
| AS-BE-001 | Purpose-bound coding-agent handoff credential | Implemented | token service, platform MCP auth |
| AS-BE-002 | Durable handoff lifecycle and single-target release semantics | Implemented | M6 candidate submission, M7 member deployment boundary |
| AS-BE-003 | Autonomous per-function policy | Contracted | release declarations, runtime call gate |
| AS-BE-004 | Generic held-work approval envelope | Contracted | AS-BE-003, run executor |
| AS-BE-005 | Owner-safe rich Activity receipts | Partial | execution/event receipts |
| AS-BE-006 | Versioned runtime-bound Directive policies | Required | wake/run snapshot |
| AS-BE-007 | Manifest-declared Knowledge adapter | Required | manifest schema, adapter runtime |
| AS-BE-008 | Per-Agent inference usage and dollar ceiling | Required | provider usage events, pricing snapshots |
| AS-BE-009 | Connection testing and safe value projection | Partial | settings/connectors |
| AS-BE-010 | Interface audience, sharing, and usage metadata | Required | interface artifacts, sharing |
| AS-BE-011 | Release history, rollback, collaborators, retention, archive, deletion | Required | Agent lifecycle |
| AS-BE-012 | Studio Pause/Resume mutation | Partial | Agent Home emergency pause |
| AS-BE-013 | Routine structural lifecycle | Partial | release workflow |
| AS-BE-014 | Keep authority planes semantically distinct | Invariant | every authority UI/API |
| AS-BE-015 | Keep Approvals separate from Alerts/Attention | Invariant | AS-BE-004 |
| AS-BE-016 | Durable machine connection exchange | Required | OAuth/device authorization, AS-BE-001 |
| AS-BE-017 | Idempotent, resumable Interface invocation | Required | function runner, durable jobs, receipts |

## AS-BE-001 — Purpose-bound coding-agent handoff credential

Implemented in Milestone 6:

- Creation requires a confirmed passwordless sign-in-link account session.
  Merely possessing an unconfirmed Supabase session, a general API key, or a
  prior handoff bearer cannot mint another handoff.
- The server creates a first-class, service-role-only handoff session and an
  API-token hash row atomically. The session id and token id are the same for
  client compatibility, but there is intentionally no cascading foreign key:
  consuming the token never deletes lifecycle history.
- The bearer is revealed only in the creation response, stored only as a
  salted hash with `plaintext_token = NULL`, and expires at exactly
  `created_at + 3600 seconds`. The database, not request copy, fixes the expiry.
- The five authenticated intents are `agent`, `interface`, `function`,
  `routine`, and `connect`. `signed-out` remains a presentation and
  draft-preservation state, never a credential intent.
- Galactic derives the exact intent-specific scope set, target semantics,
  candidate-set id, reserved new-Agent id where applicable, and expiry.
  Request bodies cannot widen them. A direct authenticated insert is also
  prevented from self-minting a token that merely looks like `handoff:*`.
- Handoff scope strings are descriptive, not authority. Every request resolves
  the durable session afresh and is accepted only at the exact
  `POST /mcp/platform` surface. Other REST, MCP, run, publish, and deployment
  surfaces reject the bearer even if a generic token verdict is cached.
- Platform MCP returns a handoff-specific initialization response, an empty
  resource list, and no account/library/memory projection. Dispatch checks,
  not only `tools/list`, enforce the same boundary.
- `connect` is inspection-only: it may discover its bounded tool surface and
  use local scaffold/lint guidance, but it cannot enumerate account data,
  stage, test, submit, deploy, or mutate an Agent.
- `agent`, `interface`, `function`, and `routine` may follow the exact
  stage/test/submit candidate path in AS-BE-002. Existing-Agent inspection and
  submission require the assigned UUID. New-Agent work receives one reserved
  UUID and cannot target an existing Agent.
- No handoff can use DB, logs, secrets, routines, grants, calls, incident
  resolution, release promotion, owner approval, or any live/external-effect
  action. Upload consumes the bearer immediately; cancellation, rejection,
  revocation, and expiry also delete it atomically.
- The legacy broad, 30-day builder-key fallback is gone. An issuance or durable
  session failure produces no substitute credential.
- Staging, basic conformance, archive creation, and candidate submission are
  available before membership. Payment, deployment, promotion, setup, and
  activation are deliberately not handoff powers.

Preserve these acceptance invariants:

1. A bearer cannot outlive 60 minutes, widen its purpose, cross its target,
   add secrets, approve authority, or bypass owner review.
2. Full token material appears once and never appears in a list, log, error,
   receipt, archive, or lifecycle projection.
3. Terminal or uploaded state is visible on the next request through the
   authoritative session lookup; token-cache staleness cannot revive it.
4. Promotion always requires an authenticated owner session and an active
   $20/month membership.
5. Workspace `connect` is not an Agent connection-declaration authority.
   Changing declared endpoints, credentials, settings, or authority remains a
   reviewed full-release candidate operation.

## AS-BE-002 — Durable handoff lifecycle

Milestone 6 implements the candidate half and Milestone 7 completes the
owner-controlled deployment half of this state machine:

```text
created -> connected -> staged -> tested -> uploaded
                    \-> restaged     \-> safely retested
       \__________________________-> cancelled | rejected | revoked | expired

uploaded -- authenticated active member manually deploys --> promoted
```

The implemented candidate workflow is:

```text
existing target: gx.project/gx.download (optional inspection)
new target:      gx.scaffold (local guidance)
both:            gx.stage -> gx.test(bundle_id)
                 -> gx.upload(bundle_id, exact test_attestation)
                 -> immutable candidate archive; bearer consumed
```

Durable session behavior:

- One session binds owner, intent, description SHA-256 (never raw
  description), one candidate-set id, and one target. A new-Agent session
  reserves an unused Agent UUID without inserting `public.apps`; an extension
  session binds an existing owned Agent; Connect has no candidate target.
- Stage binds one content-addressed bundle and source hash. Before a successful
  test, a corrected bundle may replace it and increments the lineage revision.
  After testing, a different bundle or release fails closed.
- A successful test must be the current V2 Galactic **basic conformance**
  qualification for the exact staged source, compiled `galactic.yaml`
  document, report, and release digests. A safe retry may replace only the
  attestation id/digest when every release-evidence digest is unchanged.
- Candidate submission recompiles and verifies that exact full release, loads
  its retained conformance report, and writes an immutable archive containing
  source, compiled artifacts, qualification evidence, manifest/authority data,
  candidate-set/target identity, and lineage. The session stores the archive
  root digest plus byte/object counts before moving to `uploaded`.
- `uploaded` means **candidate submitted, not deployed**. It creates no Agent,
  changes no `current_version`, applies no migration, moves no live executable
  pointer, starts no routine, and performs no external action. The bearer is
  deleted atomically with this transition.
- Intent labels describe why the handoff was opened, but all four candidate
  intents submit the same security unit: a complete Agent release. The owner
  must review the complete manifest, authority, endpoints, variables, routines,
  interfaces, compute, and release diff. M6 makes no claim that only the named
  artifact class changed.
- Interface/function/routine sessions snapshot the target's base version,
  optional legacy source/release digests, release generation, and a required
  canonical base-state digest at creation. M7 deployment compare-and-swaps
  that lineage in the leased database saga; a changed live base makes the
  candidate stale and requires a new handoff/review.
- Creation is limited to ten nonterminal/unclaimed sessions per owner.
  Submitted-but-unpromoted archives are additionally limited to ten candidates
  and 100 MiB aggregate per owner. Quota rejection leaves the session tested
  and makes a best-effort deletion of the just-written unbound archive
  objects. The same compensation runs after any definitive lifecycle
  rejection, including a concurrent cancellation. Blobs and the submitted
  pointer are namespaced by each attempt's archive digest, preventing a losing
  exact-retest upload from deleting the committed attempt's objects. Cleanup
  must not run after an ambiguous transport or response failure because the
  database may already reference the archive. Any unreachable objects must be
  reclaimed by an operational garbage collector.
- Transitions are monotonic and idempotent, recorded in an append-only event
  stream, and service-role-only. Cancelled, rejected, revoked, expired, and
  uploaded sessions remain queryable after their token row is gone.

### Milestone 7 deployment boundary

Milestone 7 implements the authenticated manual flow:

```text
durable $20/month checkout attempt -> active membership
  -> owner reviews one or more immutable candidates
  -> manual Deploy for each selected candidate
  -> leased replay-safe saga + base-lineage CAS
  -> private setup_required release; routines paused
  -> credentials/authority/cadence/budget setup -> explicit owner activation
```

Implemented invariants:

- Checkout has a durable server-only attempt identity, request fingerprint,
  Stripe identity binding, expiry, and replay projection. Stripe subscription
  reconciliation may establish the membership entitlement, but checkout and
  its return never deploy a candidate. The owner must return to the invitation
  and click **Deploy**.
- Deployment accepts only a current V2 basic-conformance candidate whose
  session records the exact immutable archive root; source, document, report,
  and release digests; qualification evidence; and reviewed manifest.
- Materialization reads only that frozen archive. Source and release artifacts
  are retained under content-addressed release-digest keys. The executable is
  stored under the release digest with a mandatory signed attestation over its
  exact bytes, version, and digest, then read back and strictly verified; the
  canonical path has no unsigned fallback.
- PostgreSQL claims one deployment with an idempotency fingerprint and a
  fenced lease. It checks active $20/month membership and the candidate's
  target/base lineage in the same authoritative flow, supports safe lease
  reconciliation, and replays the completed result after a lost response
  without rebuilding from mutable source or reapplying effects.
- Commit creates or updates the Agent as private `setup_required`, binds the
  immutable release and provenance, and retires prior routines. Newly declared
  routines remain paused. Setup supplies user credentials and reviews
  authority, cadence, and budget; a separate membership-checked owner action
  explicitly activates the release and any selected routine.
- Multiple invitations are projected and deployed independently. A failed or
  stale candidate does not roll back candidates that succeeded, and the UI
  reports per-candidate progress and retryable failure.
- Qualified release pointers cannot be changed through mutable legacy
  patch/publish/rebuild/upload paths. Canonical runtime loading is bound to the
  active release digest rather than a mutable latest or semantic-version key.
- Authenticated clients no longer have broad direct writes to `public.apps`,
  routines, routine capabilities, runs, or dashboard bindings. Narrow
  service-role/security-definer mutations own release, setup, activation, and
  execution transitions, with membership and lifecycle checks beside the
  database mutation.
- Runtime entry points fail closed unless the Agent lifecycle is runnable and
  membership is currently active. This includes direct run, HTTP/MCP,
  dynamic/native execution, codemode/recipe execution, queued jobs, deferred
  event delivery, and routine/routine-run claims. Membership lapse cannot
  leave a previously active routine or deferred execution path running.

Milestone 7 acceptance is covered by route/service/runtime tests, adversarial
replay and lineage tests, database privilege and concurrency tests, full API
and web suites, typechecks/builds, and responsive browser review. This
completion does not implement the standing OAuth/device exchange in AS-BE-016
or the later Studio requirements below.

## AS-BE-003 — Autonomous per-function policy

The shared contract defines `off | ask | free` and the manifest-declared
consequence groups `read | internal_write | external_side_effect | spend`.
This authority applies only to work initiated by the persistent Agent.

Required implementation:

- Consequence group declared in, and hashed to, the live release.
- Owner/Agent/function policy row with revision-safe CAS writes.
- Policy writes require the expected release id and declaration hash.
- Default policy for newly declared functions is `ask`.
- Runtime enforcement immediately before every autonomous function call.
- Immutable audit entry and conflict-safe Undo for each policy mutation.
- Every projection includes live release id/version and declaration hash.
- Mutation lineage uses an explicit user/system actor, including truthful
  system-created defaults.
- Policy and consequence changes that arrive in a release are reviewed
  together before activation.

## AS-BE-004 — Generic held-work approval envelope

The shared contract defines the durable envelope and discriminated action
request. Storage must bind an approval to the immutable release, function,
input hash, trigger, required generic run id, optional routine/routine-run
lineage, policy revision, expiry, and sanitized source/proposal views.

Acceptance:

- Approve, revise, and reject are idempotent, revision-safe actions.
- Only revise carries replacement input; only approve/revise may atomically
  stop asking.
- Approve/revise resumes the exact held run; it never starts an unrelated run.
- Revision supplies sanitized replacement input and produces a new input hash.
- Expired or changed-release envelopes fail closed.
- `stopAsking` atomically approves and changes that function from `ask` to
  `free`, with one audit lineage.
- No raw reasoning, secrets, or unredacted arguments are exposed.

AS-BE-003 and AS-BE-004 ship together. A UI policy without a runtime hold is
fiction; a generic hold without an owner policy is unmanageable.

## AS-BE-005 — Owner-safe rich Activity receipts

Each run needs ordered calls, timings, redacted arguments/results, explicit
world changes, duration, capacity cost, inference usage, and structured
non-actions such as "held rather than sent because policy X was missing."
Non-actions must be emitted by the runtime; never reconstruct them from model
reasoning. Receipts are paginated and field-projectable.

## AS-BE-006 — Versioned runtime-bound Directive policies

Persist an ordered policy collection with revisions, history, diffs, dry-run
evaluation, and observed-effect attribution. Every wake/run must record the
exact policy version/hash it used. Mission text derived from a routine is not a
substitute for this contract.

## AS-BE-007 — Manifest-declared Knowledge adapter

Add a schema-validated manifest adapter for facts, citations, provenance,
confirmation, contradictions, open questions, answer, and resolution actions.
Galactic normalizes the Studio projection but does not infer domain truth from
logs or arbitrary Agent tables.

## AS-BE-008 — Per-Agent inference usage and dollar ceiling

Store provider/model/input/output/cache counts per `galactic.ai()` inference
event and aggregate them by Agent and billing period. Provider-reported token
counts may be exact. Dollar cost is exact only when the provider returns a
billed amount; otherwise store the immutable price-card snapshot used for the
estimate. Enforce a separate Agent dollar ceiling and outcome policy. Never
merge this meter with Galactic capacity.

## AS-BE-009 — Connections

Implemented:

- `PUT /api/launch/agents/:id/home/settings` requires `expectedRevision`,
  validates every key against the live Agent's declared schema, encrypts values
  before the compare-and-swap transaction, and returns a refreshed,
  secret-safe Agent Home snapshot.
- A stale settings write fails with `412` and the current snapshot. Secret
  values remain write-only; only configured presence is projected.

Remaining:

- Generic test/send-test action with typed adapter semantics.
- Health state, last check/send, and credential rotation timestamp.
- Safe projection of declared non-secret values.
- Secret values remain write-only and are represented only as set/not-set.
- Add request idempotency/replay for settings writes whose transport outcome is
  unknown. Revision CAS already exists; it must not be described as missing.
- Add the dedicated, Agent-scoped connection-declaration coding-agent handoff
  described in AS-BE-001. Do not reuse the workspace `connect` intent.

The current partial API exposes configured presence and supports setting
writes. It cannot reproduce non-secret sample values, test a connection, or
truthfully claim adapter health. Studio must label presence/authority as
Configured or Effective, never Connected or Healthy.

## AS-BE-010 — Interfaces

Add manifest or service fields for audience, authorized sharing/invites,
last-opened time, and workload/unread badge counts. Sharing must have an
explicit authorization endpoint; a visible disabled Share control must not be
backed by guessed public URLs.

## AS-BE-011 — Agent lifecycle settings

Provide versioned release history and narrow rollback, collaborator roles,
effective retention, archive, recoverable deletion, and final deletion. Every
destructive action needs exact impact copy, authorization, idempotency, and
audit lineage.

## AS-BE-012 — Pause and resume

Emergency pause exists on Agent Home. Studio still needs a revision-safe
Pause/Resume projection and mutation with truthful effects on wakes, running
work, queued approvals, and data retention.

## AS-BE-013 — Routine structure

Managed-routine reads, edits, pause/resume, run-now, expected revision, and
action idempotency are strong. Create, delete, and reorder are intentionally
release/coding-agent changes today; do not fake local CRUD. If native
structural endpoints are later introduced, preserve release provenance and
authority review.

## AS-BE-014 — Authority-plane invariant

Never relabel one of these as another:

- Autonomous function policy — what this Agent may do on its own.
- Connected-caller permission — what an external caller may invoke.
- Routine capability approval — what one scheduled routine may call.
- Cross-Agent grant — what one Agent may call on another.
- Secret/configuration access — which credential or value is available.

Effective-access views may compose them, but mutations and audit lineage stay
separate.

## AS-BE-015 — Approvals/Alerts invariant

Approvals hold proposed work and resume a specific run. Alerts/Attention report
the Agent's condition and incidents. Neither may be used as storage,
transport, or UI fallback for the other.

## AS-BE-016 — Durable machine connection exchange

A copied 60-minute bearer is a temporary coding session, not a standing
machine connection. A durable “connect once per machine” promise requires an
OAuth/device exchange with:

- Browser owner authorization and explicit scope review.
- A machine-bound refreshable credential whose access token rotates without
  exposing a long-lived bearer in a copied prompt.
- Renewal, revocation, device naming, last-used evidence, and scope changes.
- Handoff credentials that bootstrap the exchange but cannot become the
  standing credential themselves.

Until this exists, product copy must say temporary 60-minute handoff and tell
the user to request a fresh prompt after expiry.

## AS-BE-017 — Idempotent, resumable Interface invocation

The Interface bridge can request a durable async function run and poll its job,
but `LaunchFunctionRunRequest` currently carries only arguments. If the POST is
accepted and its response is lost, the browser has neither a job id nor a safe
way to distinguish “not dispatched” from “dispatched, response unknown.”
Retrying can duplicate an external side effect. Closing or reloading the
Interface also discards the browser's job association while the queued work
continues.

Required contract:

- Every Interface invocation supplies a caller-generated invocation key. The
  server binds it to owner, Agent, Interface artifact/release, function, and a
  canonical request fingerprint.
- Replaying the same key and fingerprint returns the original acceptance,
  durable job, or terminal result. Reusing a key with a different fingerprint
  fails closed.
- Acceptance is persisted before the response is acknowledged. A lost
  acceptance response can therefore be recovered without dispatching again.
- The host owns a projection for active and recently terminal Interface
  invocations, addressable by invocation key, so remounting the viewer can
  resume observation. Closing a viewer does not imply cancellation.
- Terminal bridge results preserve `jobId`, `executionId`, and `receiptId`
  lineage. A non-retryable status-read failure reports an explicit unknown
  completion state and the recovery identifier.
- Replay records have a documented retention window long enough to cover
  browser reloads and ordinary client retries.
- Until consequence declarations from AS-BE-003 can reliably distinguish
  reads from side effects, the server applies this protection to every
  Interface function invocation rather than trusting a browser classification.

Acceptance tests must cover a lost dispatch response, same-key replay,
different-payload conflict, viewer close/reopen, terminal-result replay, and
receipt lineage. No retry path may create a second job for the same accepted
invocation.
