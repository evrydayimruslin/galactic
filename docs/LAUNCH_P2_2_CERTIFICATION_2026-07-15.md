# P2.2 — Launch Certification (2026-07-15)

P2.2 turns the narrowed persistent-Agent product into a release decision backed
by reproducible evidence. It does not add marketplace, desktop, wallet, public
sharing, or new end-user authority.

## Certification owners

- Release lead: Russell In
- Rollback owner: Russell In
- Communications owner: Russell In

One person may hold all three roles at launch. The release packet still records
the roles separately so ownership can split without changing the procedure.

## Required proof

1. The fixed builder/operator credential can download, test, upload, and operate
   the private smoke Agent. It must include `agents:build`; a call-only key is an
   invalid certification credential.
2. The launch website serves Agents, Profile, and Agent Home; its authenticated
   API projection returns subscription and capacity state/reset timestamps.
3. BYOK is the only customer-facing inference mode. Wallet/credit endpoints
   return `410`, and no balance, processing fee, per-Agent fee, or Galactic AI
   projection appears in launch responses.
4. Direct and scheduled execution retain the hardened admission, settlement,
   retry, idempotency, coalescing, and reporting paths delivered in P0–P2.1.
5. The Pro checkout, verified Stripe webhook, entitlement projection, and Billing
   Portal work in production. The already-completed real $20 transaction is part
   of the release evidence; no additional charge is required for every rerun.
6. A production database backup restores into the isolated
   `galactic-restore-drill` project. Raw dump files remain ephemeral and are
   never uploaded; only sanitized counts, timings, and schema checks become
   artifacts.
7. API, database, and Pages rollback steps are rehearsed and have a named owner.
8. Staging smoke precedes the tagged production candidate; production smoke is
   the last release gate.

## Deliberate exclusions

- Marketplace, Browse, public/unlisted Agents, installs, seller pricing,
  earnings, payouts, referrals, and trust/reputation.
- Customer credits, top-ups, overages, processing fees, and per-Agent fees.
- Desktop builds and updater releases. Desktop artifacts use `desktop-v*` tags;
  ordinary `v*` web/API releases must not trigger Desktop Release.
- Multiple-user collaboration and cross-user function whitelists.
- A configurable key-permissions checklist. The current top-bar connection
  action mints the standard builder/operator scopes; a least-privilege creation
  UI is a post-launch security/usability improvement.

## Accepted launch exceptions

The staging and production Workers intentionally still share the R2 app object
store and the `CODE_CACHE`/`FN_INDEX` KV namespaces. Database, auth, Worker
script, queue, and Pages origins remain isolated. Treat cache/object mutations
as coupled during staging tests and remove this exception when separate
Cloudflare resources are provisioned.

## Exit criteria

P2.2 is complete only when the release packet identifies the exact commit/tag,
all required workflows and smokes are green, restore and rollback evidence is
attached, accepted exceptions are explicit, and Russell In records the final
go/no-go decision after production smoke.
