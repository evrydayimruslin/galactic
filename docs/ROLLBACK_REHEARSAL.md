# Rollback Rehearsal

Last reviewed: `2026-07-16`

This document is the Wave 6 recovery and rollback rehearsal kit for Galactic.

Its purpose is to make release-day recovery decisions explicit and rehearsable.
It does not pretend every incident has a clean “undo” button.

## Core Rule

Use the right word for the right recovery mode:

- `Fix forward`: ship a new commit, deploy, or release tag that corrects the
  problem.
- `Rollback`: move users back to a prior known-good runtime state without
  relying on the broken release remaining live.
- `Manual recovery`: a provider- or operator-driven intervention, especially
  for database incidents, where the platform does not support a safe automatic
  rollback.

Galactic is intentionally fix-forward in many places. That is acceptable as
long as the recovery path is explicit and rehearsed.

## Scope

This rehearsal kit covers four launch-relevant incident classes:

1. bad staging deploy
2. bad production API deploy
3. bad production database migration
4. bad launch Pages deploy

Desktop release/updater recovery is not part of the persistent-Agent web/API
launch. Ordinary `v*` tags do not publish desktop artifacts; desktop retains
its separate `desktop-v*` recovery procedure for a later milestone.

## Evidence Location

Keep rehearsal notes in the Wave 6 evidence tree:

```text
docs/_generated/launch/<target>/<candidate-id>/rollback-rehearsal/
```

Initialize the packet with:

```bash
source ~/.nvm/nvm.sh && nvm use
node scripts/ops/init-rollback-rehearsal.mjs \
  --target production \
  --candidate-id "<candidate-id>" \
  --output-dir "$UL_LAUNCH_EVIDENCE_DIR/rollback-rehearsal"
```

That helper creates:

- `metadata.json`
- `notes.md`

These are the minimum rehearsal artifacts.

## Recovery Matrix

| Incident | Trigger condition | First safe action | Communication point | Preferred recovery path | Do not do this |
| --- | --- | --- | --- | --- | --- |
| Bad staging deploy | staging gate fails, staging smoke fails, or staging app behavior is clearly broken before tag | stop the release; do not tag | note the blocking SHA and evidence in the release packet / team incident channel | fix forward on `main`, rerun staging gate and staging smoke | do not tag anyway; do not bypass staging because “the change is small” |
| Bad production API deploy | tag shipped, production deploy or smoke fails, or production API behavior regresses | stop release announcement; capture the failing tag and gate summary | declare a production release incident with the tag, SHA, and failing workflow/smoke step | hotfix or revert on `main`, then cut a new patch tag such as `v0.1.1` | do not move or reuse the existing tag; do not deploy an unreviewed manual patch from a laptop |
| Bad production DB migration | migration causes incompatible schema, data corruption risk, or user-visible production failure | freeze additional schema changes and treat it as a DB recovery incident | escalate to the DB owner / incident lead immediately with migration id and timing | prefer additive fix-forward if safe; if severe, use the restore path proven by the backup drill and validate recovery steps deliberately | do not assume an automatic DB rollback exists; do not run panic SQL without recording intent and effect |
| Bad launch Pages deploy | Pages deploy fails, deep links stop serving the SPA shell, or the launch site points at the wrong API | stop release announcement and preserve the API/DB state while isolating the web failure | record the tag, commit, Pages deployment URL, and failing route in the release packet / incident channel | use Cloudflare Pages deployment rollback to the prior known-good deployment, or fix forward on `main` and cut a new patch tag | do not roll back a healthy API or database to compensate for a Pages-only failure; do not repoint production DNS ad hoc |

## Scenario Playbooks

### 1. Bad Staging Deploy

Use this when:

- `Staging Launch Gate` fails
- staging smoke fails
- staging behavior regresses before any production tag is pushed

Operator sequence:

1. Stop the release.
2. Record the candidate SHA, failing workflow, and failing smoke step.
3. Confirm no production tag has been created.
4. Fix forward on `main`.
5. Wait for `Staging Launch Gate` to go green again.
6. Re-run staging smoke and update the evidence packet.

What success looks like:

- no production tag was pushed
- the next staging candidate is clearly identified
- the release packet records why the prior candidate was blocked

### 2. Bad Production API Deploy

Use this when:

- `Production Launch Gate` fails
- production smoke fails after the tag was pushed
- the production API is live but clearly broken

Operator sequence:

1. Stop announcement and outbound release comms.
2. Record the tag, SHA, failing workflow URLs, and smoke artifacts.
3. Decide whether the fastest safe path is:
   - revert the offending commit on `main`, or
   - hotfix forward on `main`
4. Cut a new patch tag from the corrected state.
5. Run the production gate and smoke against the patch tag.

What success looks like:

- a new corrective release exists
- the broken tag remains historical, not silently replaced
- operators can point to the exact tag that restored service

### 3. Bad Production Database Migration

Use this when:

- the production schema push succeeds but application behavior breaks
- a migration is incompatible with the live runtime
- data integrity is in doubt

Operator sequence:

1. Stop additional deploys that would compound the incident.
2. Record the migration file name, tag, SHA, and incident start time.
3. Decide whether a safe additive fix-forward exists.
4. If not, treat this as a manual recovery event:
   - use the backup-and-restore drill as the reference recovery path
   - validate restore behavior deliberately
   - involve the DB owner before any destructive action
5. Record every operator step in the release packet and incident notes.

What success looks like:

- the team explicitly chose fix-forward or manual recovery
- no one assumed automatic DB rollback existed
- the recovery path used the backup/restore drill evidence instead of guesswork

### 4. Bad Launch Pages Deploy

Use this when:

- the production Pages deploy fails
- a launch-site deep link no longer serves the SPA shell
- the launch site loads but targets the wrong API origin

Operator sequence:

1. Stop announcement and record the tag, SHA, failing routes, Pages deployment
   URL, and production smoke evidence.
2. Confirm the API and database are healthy before changing either one.
3. Identify the prior known-good Pages deployment in Cloudflare deployment
   history.
4. Roll Pages back to that immutable deployment, or fix forward on `main` and
   cut a new patch tag when rollback is not suitable.
5. Re-run production Pages/API smoke and update the release packet.

What success looks like:

- the launch site and deep links serve the expected SPA shell
- the launch site targets the production API origin
- API/database state was not changed to compensate for a web-only incident
- the recovered Pages deployment or corrective patch tag is recorded

## Rehearsal Procedure

### 1. Prepare The Rehearsal Packet

Run:

```bash
source ~/.nvm/nvm.sh && nvm use
node scripts/ops/init-rollback-rehearsal.mjs \
  --target production \
  --candidate-id "<candidate-id>" \
  --output-dir "$UL_LAUNCH_EVIDENCE_DIR/rollback-rehearsal"
```

Then fill in the scenario owners, communication path, and the exact workflows
or artifacts you would consult first.

### 2. Tabletop Each Scenario

For each incident class above, record:

- what would trigger the incident
- who would own the first response
- what the first safe action is
- what evidence you would collect first
- what recovery path you would choose
- what would still feel unclear or slow

### 3. Record Timings And Gaps

For each scenario, write down:

- time to identify the correct playbook
- time to identify the correct owner
- time to identify the first safe action
- any missing workflow links, permissions, or unclear runbook steps

### 4. Update The Runbooks

If the rehearsal uncovers ambiguity, fix the docs before calling the rehearsal
complete.

The point is not to “pass” the first tabletop. The point is to remove
avoidable confusion before a real incident.

## Desktop Recovery Is Deferred

Desktop has a separate tag family and release procedure. It is deliberately
not rehearsed or certified by P2.2; see
[docs/DESKTOP_RELEASE_PIPELINE.md](DESKTOP_RELEASE_PIPELINE.md) when that launch
surface returns to scope.

## Database-Specific Recovery Notes

The database path is not a normal rollback path.

Treat severe DB incidents as manual recovery events. Use:

- [docs/BACKUP_RESTORE_DRILL.md](BACKUP_RESTORE_DRILL.md)

to guide the restore side of the decision. The rehearsal should confirm the
team knows when to stop pretending “rollback” is automatic and escalate to the
manual recovery path.

## Success Criteria

The rehearsal kit is ready when:

- each incident class has a documented playbook
- the helper script creates a rehearsal packet in the evidence tree
- the launch runbook and Pages deployment workflow point at the same recovery
  model
- operators can tell the difference between fix-forward, rollback, and manual
  recovery without improvising definitions

The rehearsal itself is only complete after someone actually records notes and
timings in the packet.
