# Operator issue and remediation architecture

Status: M0 invariants locked; M1 contract/compiler foundation implemented

Last reviewed: `2026-07-24`

This decision defines the source of truth for setup blockers, operational
issues, usage reports, diagnostics, and remediation across launch-web, Codex,
Claude Code, Cursor, CLI, and MCP clients.

## Canonical statement

The backend owns diagnosis and remediation intent. It compiles trusted
condition codes and entity identifiers into typed operator items. Clients
choose how to present that intent; they do not infer it from titles, bodies,
model output, or URLs.

One blocker and many blockers use the same card/deck model. Each card has its
own diagnosis and direct remediation. The number of cards changes, not the
interaction pattern.

## Separate authorities

Three related records have different responsibilities:

| Record | Owns | Must not own |
| --- | --- | --- |
| Operator issue | Current observed condition and recovery | Read, snooze, or dismiss preference |
| Attention state | Per-user presentation state | Whether the condition is actually fixed |
| Notification | Immutable event/report evidence | Mutable issue truth or executable remediation |

`Mark resolved` is a presentation action and must eventually be implemented as
an Attention dismissal. It never marks the underlying condition recovered.
Recovery comes from trusted observation: configuration revalidation, a reset
window, or a successful issue-specific verification.

## Classification

Classification dimensions are independent:

- `itemClass`: `issue` or `report`
- `requiresAction`: whether the operator has a concrete remediation
- `requiresDecision`: whether owner judgment/approval is required
- `blocking`: whether this condition currently blocks a particular affected
  Agent

Examples:

| Condition | Class | Action | Decision | Blocking |
| --- | --- | --- | --- | --- |
| Missing account BYOK | Issue | Yes | No | Per affected Agent |
| Capability or grant approval | Issue | Yes | Yes | Per affected Agent |
| Routine paused after failures | Issue | Yes | No | Yes |
| Routine/account usage exhausted | Report | No | No | Yes until reset |

Usage exhaustion is not a decision. It is a report that recovers
automatically when the applicable window resets.

## Scope and counting

An item has one canonical scope: account, Agent, routine, or run. A separate
affected-Agent projection records relevance and blocking state.

One account issue may affect several Agents. It appears once in global
Attention and may be referenced by every affected Agent. Therefore:

- global count means unique operator items;
- Agent counts mean relevance projections;
- Agent counts may sum to more than the global count; and
- relevance is never an authorization boundary.

The first account-scoped conditions are missing BYOK and shared account usage
exhaustion. The existing Account Alerts UI is an aggregation of Agent-owned
notifications, not canonical account scope.

## Diagnosis provenance and safety

Diagnosis provenance is explicit: platform, provider, developer, combined, or
unknown.

Platform-observed facts take precedence. A developer/provider diagnostic may
add a safe cause code and explanation, but it cannot:

- change the platform condition code;
- choose an action or authorization level;
- construct a URL or privileged button; or
- impersonate platform capacity, payment, approval, or security failures.

M2 must normalize and redact diagnostics before they enter operator issue
evidence. Raw owner logs remain isolated and are never copied into issue
payloads.

## Remediation registry

Remediations use a closed server registry and semantic targets. A target names
an account provider, Agent setting, Access item, release, routine, run, or log
view. It is not a browser URL.

Existing canonical domain endpoints perform configuration and approval
mutations. Narrow new endpoints are permitted only where the domain primitive
does not exist, notably safe connection verification and paused `Run once`.
There is no generic arbitrary-action bus.

Developer manifests may later declare safe operator error metadata. They never
declare privileged remediations, routes, buttons, or arbitrary entity IDs.

## Ordering

Blockers render in actual dependency order. Items without a dependency retain
the trusted producer's stable source order. Type-based priority is forbidden.
A dependency cycle is a compiler error.

## Recovery and execution

Configuration changes may automatically revalidate and recover their exact
issue. Usage reports recover at reset. A paused-routine failure may recover
after successful verification.

Recovery never resumes scheduled work. A recovered paused routine moves to
`Ready to resume`; the owner explicitly resumes it.

Future execution controls remain distinct:

- `Verify connection`: platform-controlled and intended to be side-effect-free.
- `Run once`: real work with usage and possible side effects; schedule stays paused.
- `Resume scheduled runs`: reactivates future work.
- `Resume and run now`: explicitly confirmed compound action.

## M1 implementation boundary

The first compiler in
[`api/services/operator-issue-compiler.ts`](../api/services/operator-issue-compiler.ts)
is intentionally pure and additive. It:

- accepts typed trusted conditions;
- compiles canonical diagnosis, semantic targets, and server labels;
- coalesces a shared account blocker across affected Agents;
- keeps usage exhaustion as a report;
- applies dependency/source ordering; and
- rejects conflicting shared definitions and dependency cycles.

It does not persist issues or replace existing Attention reads. Persistence,
dual-read/write, reconciliation, and client cutover are later milestones.

Legacy notification parsing remains compatibility-only until the typed
pipeline has reached read parity.

## Rollout order

1. Contracts and deterministic compiler.
2. Secret-safe diagnostic ingestion and safe run inspection.
3. Additive canonical issue persistence.
4. Producer reconciliation and account fanout.
5. API dual-read/shadow comparison.
6. Shared web blocker cards.
7. Verification and paused `Run once`.
8. Developer declarations and multi-client parity.

Database schema precedes API readers; API readers precede clients. Rollback
disables new readers without deleting schema or issue history.
