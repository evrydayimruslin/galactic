# G1 — Persistent-Agent Launch Verification Runbook

P2.2 is the operational gate for the web/API launch. Evidence is written under
`docs/_generated/launch/<target>/<candidate-id>/` and uploaded by CI; credentials
and raw database dumps are never artifacts.

## Owners

- Release lead: Russell In
- Rollback owner: Russell In
- Communications owner: Russell In

## Prerequisites

- Node 20.
- Environment-isolated builder/operator credentials containing `agents:build`
  and `agents:operate`: `ULTRALIGHT_TOKEN_STAGING` for staging and
  `ULTRALIGHT_TOKEN` for production. Never reuse one environment's token in the
  other.
- Environment-isolated fixed private smoke Agents:
  `GALACTIC_SMOKE_APP_ID_STAGING` for staging and `GALACTIC_SMOKE_APP_ID` for
  production. The automation redeploys the exact tested source idempotently and
  must never create ad-hoc duplicates.
- Production and isolated restore database passwords stored as GitHub Actions
  secrets. Do not place passwords in a command line, log, evidence file, or PR.
- Optional async-capable Agent/function inputs for the durable-execution smoke.

## 1. Staging certification

Run the `G1 Launch Smoke` workflow with `target=staging`. It performs:

1. Worker/Supabase/auth/BYOK/subscription-capacity preflight.
2. Release packet initialization with named owners.
3. Core API, CORS, Pages, subscription/capacity, retired-wallet, fixed-Agent
   interface deploy, and optional durable-execution smokes.

Any executed smoke failure is stop-ship. A missing fixed-Agent credential is a
failure, not a pass. A durable smoke may be explicitly marked not applicable
only when the candidate did not change the durable execution spine.

## 2. Canonical browser journey

Using the authenticated launch account, record in `manual/canonical-journey.md`:

- Agents, Profile, and Agent Home load without marketplace/credit UI.
- The connected coding agent downloads the full-time scaffold, tests it, and
  uploads the exact attested files to the fixed private Agent.
- Mission, interval cadence, secrets/readiness, approved actions, reporting,
  finite limits, pause/resume, recent runs, and logs are visible or editable in
  Agent Home as designed.
- An AI Agent is activation-blocked without BYOK; after a provider key is
  configured, inference uses that provider rather than Galactic credits.
- Capacity always shows `available`, `low`, or `waiting` plus reset time. A wait
  is distinguishable from breakage.
- Pro checkout/webhook/account projection and Billing Portal work. Reuse the
  recorded real transaction unless the billing code or Stripe configuration
  changed; do not create needless live charges.

## 3. Backup/restore drill

Dispatch `P2.2 Supabase Restore Drill` with the required confirmation string.
The workflow:

- creates an encrypted-in-transit, ephemeral custom-format dump;
- replaces only the isolated restore target's `public` application schema;
- compares source/target public-table counts and schema fingerprints;
- deletes the raw dump before artifact upload;
- uploads a sanitized JSON/Markdown result with timings.

The target must never receive production traffic. Restore failure, count drift,
schema drift, or accidental raw-dump artifacting is stop-ship.

## 4. Rollback rehearsal

Initialize the rehearsal:

```bash
node scripts/ops/init-rollback-rehearsal.mjs \
  --target production \
  --candidate-id "$CID" \
  --operator "Russell In" \
  --output-dir "$DIR/rollback-rehearsal"
```

Walk through bad staging Worker, bad production Worker, bad database migration,
and bad Pages deploy. For each, record trigger, first safe action, recovery path,
communications point, time to identify the playbook, and gaps. Database recovery
uses the restore evidence; destructive rollback is never improvised.

## 5. Candidate and production certification

Merge the exact green commit, tag it `vX.Y.Z`, and wait for the required DB/API/
Pages production workflows and `Production Launch Gate`. Ordinary `v*` tags do
not build desktop; desktop is deferred and uses `desktop-v*` tags.

Then dispatch `G1 Launch Smoke` with `target=production`, complete the canonical
browser journey, attach the restore/rehearsal evidence, accept the documented
shared R2/KV staging exception, and fill the release packet.

Do not announce until production smoke is green and Russell In records `go`.

## Local command reference

```bash
node scripts/ops/verify-secrets.mjs --target staging --token "$TOK"
node scripts/smoke/run-staging-smoke-suite.mjs \
  --target staging --token "$TOK" --output-dir "$DIR"
node scripts/ops/init-release-packet.mjs \
  --target staging --commit-sha "$(git rev-parse HEAD)" --git-ref main \
  --operator "Russell In" --release-lead "Russell In" \
  --rollback-owner "Russell In" --communications-owner "Russell In" \
  --output-dir "$DIR"
```

The Free Mode credit smoke is retained as historical compatibility coverage but
is not a P2.2 launch gate. Customer-facing credits, wallet top-ups, platform AI,
marketplace, public sharing, and desktop are outside this release contract.
