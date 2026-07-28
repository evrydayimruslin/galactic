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
| AS-BE-001 | Purpose-bound coding-agent handoff credential | Partial | token service, platform MCP auth |
| AS-BE-002 | Durable handoff lifecycle and single-target release semantics | Contracted | AS-BE-001, staged bundles, attestations |
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

Implemented in this tranche:

- Dedicated account-session-only handoff endpoints.
- Reveal-once credential with an exact server-selected 30-minute expiry.
- One shared handoff model has five authenticated intent configurations:
  `agent`, `interface`, `function`, `routine`, and `connect`. `signed-out` is a
  presentation and draft-preservation state, never a credential intent.
- Caller-selected intent is validated against the workspace or owned-Agent
  route. Galactic derives scopes, exact app IDs, and expiry; body overrides
  are rejected.
- Structural intents require a human description before credential creation.
- Interface, function, and routine credentials are restricted to the owned
  Agent in platform MCP authorization.
- Handoff credentials expose bounded discovery, source projection/download,
  staging, testing, candidate upload, lint, and scaffold tools only. They
  cannot use DB, logs, secrets, routines, grants, calls, incident resolution,
  release promotion, or owner approval actions.
- Agent-scoped inspection and upload require the exact assigned Agent UUID.
- New-Agent issuance and publication are disabled until AS-BE-002 can enforce
  one create. The UI does not install an issuer for this path, its credential
  adapter fails closed, and the server rejects the intent. Extension/connect
  handoffs cannot create another Agent.
- The enabled credential paths are workspace `connect` and Agent-scoped
  `interface`, `function`, and `routine`. The signed-out presentation preserves
  the intended path and its draft through authentication without issuing or
  copying a credential.
- The Connect surface no longer falls back to the legacy broad, 30-day builder
  key. If short-lived handoff issuance is unavailable, it shows the failure and
  issues no substitute.
- The general API-key endpoint cannot mint reserved `handoff:*` scopes, and
  malformed or multiple handoff markers fail closed.
- Cached authentication verdicts carry the database expiry and cannot extend
  a 30-minute credential beyond its exact expiry.

Remaining:

- Store a first-class handoff session rather than deriving purpose from the
  credential.
- Bind audit records to a description hash without putting the raw
  description into credential metadata.
- Revoke automatically after a terminal lifecycle state, not only at expiry.
- Bind the reviewed release delta to the selected intent. Today
  interface/function/routine are purpose-labelled but share the same bounded
  target-Agent build path; Galactic cannot yet prove that an uploaded candidate
  changed only the named artifact class.
- Add a dedicated Agent-scoped connection-declaration intent. Workspace
  `connect` means “open a temporary coding session”; it does not authorize a
  coding agent to add or change an Agent release's declared credentials,
  settings, endpoints, or authority requirements. That new intent must receive
  its own semantic-delta validation under AS-BE-002.

Acceptance:

1. A credential cannot outlive 30 minutes, widen its own scope, operate on a
   different Agent, add secrets, approve authority, or bypass owner review.
2. Full token material is returned once and never appears in list, log, error,
   receipt, or lifecycle responses.
3. Every denied cross-purpose and cross-Agent operation is tested at dispatch,
   not merely hidden from `tools/list`.
4. Promotion always requires an authenticated owner session.

## AS-BE-002 — Durable handoff lifecycle

Persist the state machine:

```text
created -> connected -> staged -> tested -> uploaded -> promoted
       \__________________________-> cancelled | rejected | revoked | expired
```

Each transition must bind the credential, owner, intent, target Agent (when
known), reviewed semantic delta, source/bundle hash, test attestation, release,
and timestamp. State advancement is monotonic and idempotent. Every terminal
state revokes the credential. For a new-Agent intent, the first successful
creation atomically and permanently binds the handoff to that private, paused
Agent so the same credential cannot create or update another. Failed retries
may reuse the same content-addressed bundle but may not change purpose.

The upload/promotion boundary must use:

```text
gx.project -> gx.stage -> gx.test(bundle_id)
           -> gx.upload(bundle_id, test_attestation)
           -> authenticated owner review and promotion
```

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

A copied 30-minute bearer is a temporary coding session, not a standing
machine connection. A durable “connect once per machine” promise requires an
OAuth/device exchange with:

- Browser owner authorization and explicit scope review.
- A machine-bound refreshable credential whose access token rotates without
  exposing a long-lived bearer in a copied prompt.
- Renewal, revocation, device naming, last-used evidence, and scope changes.
- Handoff credentials that bootstrap the exchange but cannot become the
  standing credential themselves.

Until this exists, product copy must say temporary 30-minute handoff and tell
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
