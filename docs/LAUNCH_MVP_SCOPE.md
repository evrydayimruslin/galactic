# Persistent Agent Launch Scope

Locked: 2026-07-14; amended by P2.3 on 2026-07-17

Current delivery milestones:

- Launch P0 — Persistent-Agent Safety (2026-07-14)
- [Launch P1 — Agent Home Contract (2026-07-14)](LAUNCH_P1_AGENT_HOME_CONTRACT_2026-07-14.md)
- Launch P2 — Canonical Conjuring Journey (2026-07-15)
- [Launch P2.1 — BYOK Subscription Capacity (2026-07-15)](LAUNCH_P2_1_SUBSCRIPTION_CAPACITY_2026-07-15.md)
- [Launch P2.2 — Launch Certification (2026-07-15)](LAUNCH_P2_2_CERTIFICATION_2026-07-15.md)
- [Launch P2.3 — Agent Fleet and Developer Schedules (2026-07-17)](LAUNCH_P2_3_AGENT_FLEET_2026-07-17.md)

This is the active launch contract for Galactic. It supersedes the
marketplace-first scope recorded on 2026-06-10. The repository remains the
capability basin: launch narrows what Galactic exposes and promises; it does not
remove mature runtime, security, billing, observability, or compatibility
infrastructure.

## Launch thesis

**Conjure an agent. Galactic keeps it working. Take the agent anywhere.**

Connect Galactic to Codex, Claude Code, Cursor, or another MCP client. Describe
an ongoing responsibility. The connected coding agent writes, tests, deploys,
and supervises a private Galactic Agent that wakes when needed, remembers its
work, uses approved capabilities, stays inside hard cost limits, and reports
back.

The MVP proves that people can create useful persistent Agents and keep them
running cheaply before Galactic introduces a market around them.

## Included in the MVP

- A Cloudflare Pages Fleet that merges Home and Agents, with account Settings,
  Alerts, and private Agent operations presented as focused overlays.
- A private Agent surface with Alerts, Interfaces, Routines, Functions, and
  Settings; runtime memory remains available to code without a website pane.
- One compatibility primary plus any number of additional persistent routines
  per owned Agent, sharing the account and per-Agent capacity ceilings.
- Mission, interval or cron/timezone cadence, reactive triggers, setup readiness,
  approved actions, reporting state, cost ceilings, recent activity, and owner
  controls on the Agent surface.
- The platform MCP and per-Agent MCP endpoints for Codex, Claude Code, Cursor,
  and other MCP clients.
- The existing coding-agent conjuring flow: `gx.download({ full_time: true })`,
  edit, `tested = gx.test(...)`, upload the exact same files with
  `test_attestation: tested.test_attestation`, create a paused routine, owner
  approval, resume.
- Sandboxed execution with BYOK inference, storage, memory, network policy,
  Agent-to-Agent calls, receipts, tracing, and run journals.
- Owner-owned Agent-to-Agent composition through explicit, bounded grants.
- Galactic inbox reporting for anomalies and meaningful milestones.
- Encrypted runtime settings, scoped Galactic keys, BYOK selection, and shared
  account capacity with visible state and reset times.

## Locked launch decisions

1. **Private and owner-only.** New launch Agents are private. Public, unlisted,
   install, and cross-user sharing semantics remain compatibility-only and are
   not available through the Conjure path.
2. **One Agent, many managed routines.** One routine remains the compatibility
   primary, while developers may create and operate additional independently
   scheduled routines on the same private Agent.
3. **The mission is live state.** “Mission” means `user_routines.intent`, the
   directive injected on every wake. Package description remains separate
   metadata.
4. **Developer scheduling is first-class.** Managed routines support safe
   intervals, strict five-field cron with IANA timezones, and durable reactive
   events. Capacity-waiting work resumes without replay storms.
5. **Human activation boundary.** A connected coding agent may scaffold, test,
   upload, and propose a routine. Only an authenticated account session may
   approve capabilities, activate a routine, widen grants, or increase its
   authority.
6. **Scoped connected-agent credentials.** Platform MCP tools enforce explicit
   scopes. Call-only keys cannot deploy, change secrets, create grants, or
   manage routines. Billing, BYOK, approvals, and other account controls stay
   session-only. Legacy REST control-plane mutations are account-session-only;
   connected builders use the attested `gx.*` path regardless of whether a key
   arrived as a bearer header or auth cookie.
7. **Owned-to-owned composition.** A launch routine may call only the owner's
   private Agents through an approved grant. Routine ID, run ID, and trace
   context are server-minted and propagate immutably across every hop.
8. **Hard ceilings.** Activation requires finite per-run, daily, monthly, and
   calls-per-run limits. Enforcement happens before billable work. Manual runs
   count toward the same limits unless the owner authorizes an explicit one-shot
   override. For launch, in-routine D1, KV, R2, and widget micro-operations are
   deliberately platform-sponsored and non-billable because D1 row cost is known
   only after a query. Runtime, function, and AI work remain pre-authorized and
   hard-budgeted; GPU execution is unavailable to routines until it has a
   provable preflight bound.
9. **Galactic inbox reporting.** External email, Slack, webhook, and
   dormant-client push delivery are deferred. Agents report anomalies and
   meaningful milestones; the runtime prevents notification floods and retry
   duplicates.
10. **Safe updates.** Upload and test a new version before promotion. Expanded
    capabilities require fresh approval; a running Agent must not silently
    acquire more authority. Release versions are canonical numeric `x.y.z`,
    staged uploads obey the shared file/byte quota, and connected builders may
    retain at most three non-live versions per Agent. Existing GPU Agent updates
    remain owner-session-only until GPU builds have version-addressed atomic
    promotion.
11. **Badges disclose; authorization enforces.** Read, Write, and AI badges are
    manifest declarations or conservative inference hints. Runtime permissions,
    grants, network policy, and budgets remain authoritative.

Exact numerical defaults—private capacity limits, default interval, default cost limits,
notification frequency, and run retention—may evolve without changing these
safety invariants. Defaults must always be finite and launch-safe.

## Capability basin retained

The following are part of the MVP's reliability and safety even when they are
not directly visible on the website:

- queue isolation, leases, concurrency control, stale-run recovery;
- retries with bounded backoff and idempotent bookkeeping;
- circuit breakers and automatic pause notifications;
- sandbox tenant isolation, egress policy, encrypted credentials;
- D1 journals, memory, flight-recorder steps, receipts, cost attribution,
  traces;
- BYOK routing, private cost metering, hard routine budgets, rate limits;
- Agent grants, caller identity, hop limits, event delivery, and monitoring;
- integrity/authentication/audit evidence used to protect execution.

“No trust product” means no marketplace trust/reputation surface. It does not
mean removing authentication, authorization, integrity verification, or
auditability.

## Dormant or deferred from launch

- Browse, marketplace discovery, installation, and public Agent listings.
- Public and unlisted publication.
- Agent pricing, seller monetization, commissions, earnings, payouts, referrals,
  and leaderboards.
- Marketplace trust cards, reputation, ranking, and public verification copy.
- Cross-user whitelists or link sharing; future collaboration needs an explicit
  member/operator model rather than reusing per-function invocation permissions.
- Arbitrary external reporting destinations.
- A separate website Agent builder. The user's existing coding agent is the
  builder.

These systems may remain implemented for compatibility and future use. They must
not appear in primary launch navigation, first-contact guidance, default tool
discovery, or launch claims.

## Canonical conjuring flow

1. Connect a coding agent with a scoped Galactic builder/operator key.
2. Describe an ongoing responsibility.
3. Scaffold with `gx.download({ full_time: true })`.
4. Implement the observation and action boundaries.
5. Run a representative wake with `gx.test` and retain its short-lived,
   owner/source/runtime-bound `test_attestation`.
6. Upload the exact tested files and attestation as a new private Agent or a
   non-live version of an existing Agent.
7. Configure required secrets and a BYOK inference provider when the Agent uses AI.
8. Create one or more routines in a paused state with missions, schedules, and
   finite limits; one is elected primary for compatibility.
9. Review and approve exact capabilities, grants, cadence, and budgets in the
   authenticated website session.
10. Activate, then supervise through Fleet, the Agent overlay, recent activity,
    receipts, and Alerts. Updates repeat the test/promotion process.

## Implementation boundary

Do not fork the backend for launch. The launch website and API are an owner-safe
projection over the shared services:

```text
apps/launch-web                 # Cloudflare Pages website
api/handlers/launch.ts          # Owner-scoped launch facade
api/handlers/platform-mcp.ts    # Connected coding-agent surface
api/services/routine-*.ts       # Persistent runtime and monitoring
shared/contracts/launch.ts      # Machine-readable launch scope
```

Production Pages and the API Worker have separate promotion paths. Changes are
launch-ready only after focused tests, the staging production-shaped conjure
E2E, and explicit production Worker promotion.
