# Agent Studio implementation

This document maps the July 2026 Agent Studio design handoff to Galactic's
production contracts. It is an implementation boundary, not a replacement for
the visual specification.

Backend discrepancies and acceptance criteria are durable requirements in
[`AGENT_STUDIO_BACKEND_REQUIREMENTS.md`](./AGENT_STUDIO_BACKEND_REQUIREMENTS.md).
Use its stable `AS-BE-*` IDs in implementation and review work.

## Source of truth

- `Agent Studio.dc.html` is authoritative for the 13-screen Studio, themes,
  Live/New structure, information hierarchy, and embedded coding-agent
  handoff.
- `Handoff Prompt Copy.dc.html` is authoritative for six handoff
  presentations: five authenticated intents (`agent`, `interface`, `function`,
  `routine`, and `connect`) plus the non-credentialed `signed-out` state.
- The two exploration canvases are reference-only. Their abandoned authority
  ladder, activity spine, work-order, tabs, and staged wizard must not leak
  into production.
- `support.js` is generated design-canvas runtime code and is not product code.

The Studio shell preserves the handoff's four-font system, Porcelain and
Obsidian color tokens, square geometry, engraved light surfaces, clipped
three-ring motif, 208px rail, and user-question information architecture.
Production controls remain semantic, keyboard accessible, and responsive.
Existing production panes are being ported behind that shell screen by screen;
their legacy internal hierarchy is transitional rather than a claim of
pixel-level completion.

## Architecture

Authenticated owner routes at `/agents/:slug` render an isolated full-page
Studio. Fleet, account, public, and installed-Agent surfaces remain in their
existing shells.

The Studio owns a canonical route model:

```text
Watch: Overview, Interfaces, Approvals, Activity, Alerts
Teach: Directive, Routines, Knowledge
Grant: Capabilities, Connections, Compute, Limits
Settings
```

Compatibility aliases preserve existing links:

```text
functions -> capabilities
access -> connections
overview?item=activity -> activity
settings?item=rate-limits -> limits
```

Existing server-authored destinations may continue emitting legacy panes
during the migration. The Studio normalizes them at its boundary.

The design prototype's Live/New toggle is not a production control. Studio
derives the structure from the live release, setup requirements, and managed
routine state. Overview has the first complete derived setup structure. Each
remaining screen still needs its handoff-specific New structure as its native
pane replaces the legacy implementation.

## Contract readiness

| Screen | Current source | Readiness | Deliberate boundary |
| --- | --- | --- | --- |
| Overview | Agent Home, Agent detail, install context | Strong | Daily run aggregates and priced inference consumption are absent |
| Interfaces | Release declarations, artifact bridge, preferences | Strong/partial | Audience and last-opened metadata are absent; invocation replay/resume is AS-BE-017 |
| Approvals | None generically | Blocked | Do not substitute Attention or caller permissions |
| Activity | Agent Home activity and paginated activity | Partial | No owner-safe nested run steps, world changes, or structured non-actions |
| Alerts | Attention lifecycle, evidence, allowlisted actions | Strong | Remains separate from approvals |
| Directive | Home directive and managed routines | Partial | No versioned policy collection, effect attribution, history, or dry run |
| Routines | Managed-routine contracts | Strong | Capability names are projected; an ordered execution plan is not |
| Knowledge | No common contract | Blocked | Do not infer facts from logs or arbitrary Agent tables |
| Capabilities | Functions and several existing authority planes | Partial | Autonomous Off / Ask / Free does not exist |
| Connections | Home access and revision-CAS write-only settings | Strong/partial | No generic connection test, safe nonsecret value projection, or Agent-scoped connection-declaration handoff |
| Compute | Compute settings, policy, runs, artifacts | Strong | Runtime override language must remain distinct from release structure |
| Limits | Agent capacity | Partial | No priced per-Agent inference rollup or dollar policy |
| Settings | Manifest identity, release candidate, recent runs | Partial | Studio Pause/Resume is not wired yet; no release history/rollback, collaborators, retention, archive, or complete deletion contract |

## Semantic boundaries

### Capabilities

The handoff's Off / Ask / Runs freely control is a new autonomous execution
policy. Existing caller permissions govern connected Agents invoking this
Agent. Cross-Agent grants govern calls from one Agent to another. Routine
capability approval governs a routine's declared dependencies. None controls
what this persistent Agent may do on its own next wake.

Do not visually relabel any of those systems as the new capability policy.
Required platform work:

- A release-reviewed consequence declaration per function:
  `read`, `internal_write`, `external_side_effect`, or `spend`.
- An owner/Agent/function effective policy with `off`, `ask`, and `free`.
- Runtime enforcement for autonomous calls.
- A durable approval queue for `ask`.
- Revision-safe writes, immutable audit entries, and conflict-safe Undo.
- Live release provenance in every projection.

### Approvals

Attention reports conditions; it does not hold arbitrary proposed work.
Approvals require a durable execution envelope bound to an immutable release,
function, input hash, trigger, routine, and run. It needs sanitized source and
proposal views plus idempotent approve, revise, reject, and resume actions.
“Stop asking” updates autonomous function policy.

### Directive

Editable policies are real only if every wake records and uses their version or
hash. The current directive is the mission derived from managed routines.
Policy ordering, history, diffs, dry runs, and observed effects require a
versioned runtime-bound contract.

### Knowledge

Galactic should not own every Agent's domain schema. Prefer a manifest-declared
Studio adapter whose list/upsert/question/answer functions have validated
schemas. Studio can then normalize facts, citations, provenance,
contradictions, confirmation, and open questions without guessing.

### Activity and receipts

Expose privacy-redacted run details, never raw reasoning or secret-bearing
arguments. Ordered steps and database diffs already have backend foundations.
“Considered but did not act, because…” must be an explicit structured event;
it cannot be reliably reconstructed from model reasoning.

### Interface invocation recovery

The current Interface bridge queues async function work and follows the durable
job instead of resubmitting on capacity waits. It does not yet make initial
dispatch exactly-once: the function-run request has no caller invocation key,
and a lost acceptance response or viewer reload loses the browser's job
association. AS-BE-017 requires server replay by invocation key, remount-time
resume, and terminal job/execution/receipt lineage before Interfaces can safely
retry side-effecting calls.

### Limits

Token counts can be exact when reported by the provider. Dollar cost remains
estimated unless the usage event stores the provider's billed amount or a
contemporaneous immutable price snapshot. Galactic percentage and inference
dollars remain separate meters and policies.

## Coding-agent handoff

The handoff must use the Milestone 1 token-saving path:

```text
gx.project -> gx.download (only when source is needed)
           -> gx.stage -> gx.test(bundle_id)
           -> gx.upload(bundle_id, test_attestation) -> owner review
```

Implemented:

- One shared component and model for five authenticated intent configurations:
  `agent`, `interface`, `function`, `routine`, and `connect`, plus a
  `signed-out` presentation that can never issue a credential.
- Required human descriptions for structural changes. Workspace `connect`
  remains optional because it can open an inspection-only coding session.
- Signed-out draft and continuation-intent preservation through
  authentication.
- Credential creation only when the user requests Copy.
- Account-session-only, reveal-once credentials with an exact server-selected
  30-minute expiry.
- Exact Agent UUID and app-id restriction for `interface`, `function`, and
  `routine`; workspace scope for `connect`.
- Fail-closed client validation of target, expiry, and the complete exact scope
  set returned by the server.
- Removal of the legacy broad, 30-day builder-key fallback. An issuance failure
  now produces no substitute credential.
- A visible New-Agent presentation that is deliberately non-operational. Both
  client and server disable issuance until one credential can be atomically
  bound to one created private, paused Agent.

Remaining:

- Persist the handoff lifecycle: created, connected, staged, tested, uploaded,
  promoted, cancelled/rejected/revoked, or expired.
- Prove that the reviewed semantic delta matches the selected structural
  intent, not only that it targets the right Agent.
- Add a dedicated Agent-scoped connection-declaration intent for changing an
  Agent release's declared settings, credentials, endpoints, or authority
  requirements. This is distinct from workspace `connect`, which only opens a
  temporary coding session.
- Enable New-Agent issuance only after AS-BE-002 provides atomic single-create
  binding and terminal revocation.
- Implement the OAuth/device-style standing machine exchange in AS-BE-016.
  Until then, every copied prompt is a temporary 30-minute handoff and users
  must request a fresh one after expiry.

## Rollout order

1. Full-page shell, canonical routes and aliases, exact themes, Overview, and
   honest contract-boundary states.
2. Port existing Interfaces, Alerts, Routines, Connections, Compute, and
   Settings into Studio-native screen components without changing behavior.
3. Add owner-safe Activity run detail, inference usage rollup, release history,
   and narrow rollback.
4. Implement autonomous function policy and the approval envelope together.
5. Add runtime-bound directive policies and a validated Knowledge adapter.
6. Add collaborator roles, effective retention, archive, and deletion only
   after backend enforcement exists.

Every phase requires route tests, reducer/model tests for interaction state,
component render tests, and browser screenshot review in light/dark desktop and
narrow layouts.
