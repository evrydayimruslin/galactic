# Release Runbook

This is the operator playbook for staging validation and public desktop
releases after the Wave 0 / Wave 1 launch-hardening work.

## Preconditions

Before running this flow, make sure:

- staging and production Supabase projects are configured
- the staging and production Workers.dev origins point at the right Worker
  deployments; if replacing them with custom domains, confirm the domains are
  project-owned first
- the `ultralight-launch-web` Cloudflare Pages project exists, or the launch-web
  deploy workflow can create it with production branch `main` before the first
  staging branch upload
- GitHub environment secrets are configured for:
  - staging database deploy
  - production database deploy
  - staging API deploy
  - production API deploy
  - staging launch-web Pages deploy
  - production launch-web Pages deploy
  - desktop macOS signing / notarization
  - desktop Windows signing
  - Tauri updater signing + public key

References:

- [Release topology](RELEASE_TOPOLOGY.md)
- [Environment isolation matrix](ENVIRONMENT_ISOLATION_MATRIX.md)
- [Launch evidence registry](LAUNCH_EVIDENCE_REGISTRY.md)
- [Launch signoff policy](LAUNCH_SIGNOFF_POLICY.md)
- [Release packet template](RELEASE_PACKET_TEMPLATE.md)
- [Desktop release pipeline](DESKTOP_RELEASE_PIPELINE.md)
- [Smoke checklists](SMOKE_CHECKLISTS.md)
- [Launch route inventory](LAUNCH_ROUTE_INVENTORY.md)
- [Launch scorecard](LAUNCH_SCORECARD.md)
- [Runtime architecture decision](RUNTIME_ARCHITECTURE_DECISION.md)

Start with
[docs/RELEASE_TOPOLOGY.md](RELEASE_TOPOLOGY.md)
if you need to answer “what deploys where, and in what order?” This runbook is
the operational procedure layered on top of that topology.

Before collecting audit or smoke output, define a local evidence directory that
matches the conventions in
[docs/LAUNCH_EVIDENCE_REGISTRY.md](LAUNCH_EVIDENCE_REGISTRY.md).

Example staging candidate:

```bash
export UL_LAUNCH_EVIDENCE_DIR="docs/_generated/launch/staging/2026-04-21-main-<sha>"
mkdir -p "$UL_LAUNCH_EVIDENCE_DIR"/{audits,smoke,manual}
source ~/.nvm/nvm.sh && nvm use
node scripts/ops/init-release-packet.mjs \
  --target staging \
  --commit-sha <sha> \
  --git-ref main
```

## Runtime Architecture

The canonical launch runtime is:

- main API: Cloudflare Worker from
  [api/src/worker-entry.ts](../api/src/worker-entry.ts)
- launch website: Cloudflare Pages static SPA from
  [apps/launch-web](../apps/launch-web)
- deployment path: Wrangler plus
  [.github/workflows/api-deploy.yml](../.github/workflows/api-deploy.yml)
  and
  [.github/workflows/launch-web-deploy.yml](../.github/workflows/launch-web-deploy.yml)
- schema path: [supabase/migrations/](../supabase/migrations)

Important scope note:

- [worker/src/index.ts](../worker/src/index.ts)
  is currently a secondary internal data-layer worker, not the main API
  entrypoint.
- the former DO/Deno deployment files now live under
  [archive/legacy-runtime/](../archive/legacy-runtime)
  and are historical reference only, not part of the standard release flow.
- the full cross-surface promotion chain now lives in
  [docs/RELEASE_TOPOLOGY.md](RELEASE_TOPOLOGY.md),
  including the current staging/production shared-resource exceptions.
- the detailed owner/risk/removal map for those exceptions now lives in
  [docs/ENVIRONMENT_ISOLATION_MATRIX.md](ENVIRONMENT_ISOLATION_MATRIX.md)
  and should be reviewed whenever a candidate touches Cloudflare bindings,
  `worker/**`, or desktop runtime environment wiring.

## Supabase Migration Audit

Before rolling out the Wave 4 Supabase cleanup, generate a real migration
report from the target environment:

```bash
source ~/.nvm/nvm.sh && nvm use
node scripts/supabase/audit-app-supabase-configs.mjs \
  --write-json "$UL_LAUNCH_EVIDENCE_DIR/audits/supabase-audit.json"
```

That report identifies which apps already use saved config IDs and which still
need migration from legacy app-level or platform-default Supabase state.

## Manifest Contract Audit

Before rolling out the Wave 4 manifest-first cleanup, generate a real contract
coverage report from the target environment:

```bash
source ~/.nvm/nvm.sh && nvm use
node scripts/apps/audit-app-manifest-coverage.mjs \
  --write-json "$UL_LAUNCH_EVIDENCE_DIR/audits/manifest-coverage-audit.json"
```

That report identifies which stored apps are already manifest-backed and which
still rely on legacy `skills_parsed`, GPU export discovery, or plain export
fallback.

## API Token Compatibility Audit

Before rolling out the Wave 4 token-schema cleanup, generate a real token
compatibility report from the target environment:

```bash
source ~/.nvm/nvm.sh && nvm use
node scripts/tokens/audit-api-token-compat.mjs \
  --write-json "$UL_LAUNCH_EVIDENCE_DIR/audits/token-compat-audit.json"
```

If the report shows legacy rows that still retain plaintext, you can backfill
canonical salts and hashes in-place:

```bash
source ~/.nvm/nvm.sh && nvm use
node scripts/tokens/audit-api-token-compat.mjs \
  --apply-backfill \
  --write-json "$UL_LAUNCH_EVIDENCE_DIR/audits/token-compat-audit.json"
```

Rows reported as `legacy_unrecoverable` should be revoked or deleted before
closing Wave 4 token cleanup, because they will no longer validate once the
remaining plaintext-assisted migration branch is removed.

## Chat Capture Rollout

Before enabling chat capture on a candidate environment:

1. Push the checked-in Supabase migrations to the target Supabase project.
2. Configure target Worker secrets/vars:
   - `ANALYTICS_PEPPER_V1`
   - `ANALYTICS_PEPPER_VERSION=v1`
   - `CHAT_CAPTURE_ENABLED=false`
   - `CHAT_CAPTURE_ARTIFACTS_ENABLED=true`
   - `CHAT_CAPTURE_MAX_INLINE_BYTES=64000`
3. Deploy the target Worker.
4. Flip `CHAT_CAPTURE_ENABLED=true`.
5. Run the capture smoke:

```bash
ULTRALIGHT_TOKEN=... \
SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/smoke/chat-capture-smoke.mjs \
  --target production \
  --exercise-orchestrate \
  --write-json "$UL_LAUNCH_EVIDENCE_DIR/smoke/chat-capture.json"
```

The smoke verifies the capture schema is reachable by service role, sends one
real `/chat/orchestrate` request with project context and a file, then confirms
thread/message/event/artifact/link rows were written for that conversation.

## Secret Crypto Compatibility Audit

Before rolling out the Wave 4 secret-crypto cleanup, generate a real report from
the target environment:

```bash
source ~/.nvm/nvm.sh && nvm use
node scripts/secrets/audit-secret-crypto-compat.mjs \
  --write-json "$UL_LAUNCH_EVIDENCE_DIR/audits/secret-crypto-audit.json"
```

If the report shows recoverable legacy rows, you can rewrite them into the
canonical per-record encrypted format in-place:

```bash
source ~/.nvm/nvm.sh && nvm use
node scripts/secrets/audit-secret-crypto-compat.mjs \
  --apply-backfill \
  --write-json "$UL_LAUNCH_EVIDENCE_DIR/audits/secret-crypto-audit.json"
```

Rows still reported as unreadable after the audit need manual rotation,
recreation, or deletion before closing Wave 4 secret cleanup, because runtime
decrypt paths now assume the canonical encrypted format only.

## Platform Alias Retirement Rollout

Before fully deleting the Wave 4 platform alias shim, use the staged runtime
switch first:

1. Review recent `platform_mcp_alias` logs and confirm the removable alias set
   is quiet enough to trial.
2. In staging, set `PLATFORM_MCP_DISABLED_ALIASES=removable`.
3. Deploy staging and run the normal smoke checks plus one legacy-alias probe
   from a known old client or a manual MCP call.
4. Confirm removable aliases now fail with a clear canonical replacement
   message, while blocked aliases like `ul.health`, `ul.gaps`,
   `ul.shortcomings`, `ul.markdown.list`, and `ul.markdown.share` still work.
5. Only after staging is clean should the same setting move to production.

## Backup And Restore Drill

Before closing the Wave 6 backup/restore item, run the real drill from:

- [docs/BACKUP_RESTORE_DRILL.md](BACKUP_RESTORE_DRILL.md)

Initialize the drill packet inside the current evidence directory with:

```bash
source ~/.nvm/nvm.sh && nvm use
node scripts/ops/init-backup-restore-drill.mjs \
  --source-environment production \
  --restore-target "<isolated-supabase-project-ref-or-name>" \
  --output-dir "$UL_LAUNCH_EVIDENCE_DIR/restore-drill"
```

That creates the minimum drill artifact set:

- `restore-drill/metadata.json`
- `restore-drill/notes.md`
- `restore-drill/validation-queries.sql`

Use the drill document to record:

- the source restore reference
- the isolated restore target
- the validation seed rows
- actual RTO / RPO
- operator notes and surprises

Do not mark backup/restore as complete from documentation alone. The launch
scorecard should move only after a real restore has been executed and validated.

## Durable Execution Rollout (one-time, before the first post-PR3/4 deploy)

The Queues-based durable-execution spine (async function jobs) and the
queue-driven event bus need one-time provisioning per Cloudflare account and
one Supabase migration. `wrangler deploy` FAILS to attach consumers if the
queues do not exist (the `API Deploy` workflow now provisions them
idempotently, but first-time manual deploys must do this by hand):

```bash
# Production
wrangler queues create ultralight-exec
wrangler queues create ultralight-exec-dlq
wrangler queues create ultralight-events
wrangler queues create ultralight-events-dlq
# Staging
wrangler queues create ultralight-exec-staging
wrangler queues create ultralight-exec-staging-dlq
wrangler queues create ultralight-events-staging
wrangler queues create ultralight-events-staging-dlq
```

Supabase: apply `supabase/migrations/20260611090000_async_jobs_durable_execution.sql`
(async_jobs gains args/caller attribution/started_at + the queued status
sweep index) via the normal `Supabase DB` workflow or `supabase db push`.

Secrets (set per environment via `wrangler secret put`; see
`api/.dev.vars.example` for the full local list):

- `AGENT_CALLER_SECRET` — signs cross-Agent caller-context headers; grant
  enforcement fails closed without it.
- `ROUTINE_ACTOR_TOKEN_SECRET` / `WORKER_SECRET` — sign internal actor
  tokens (routine + sandbox executions).

Supabase Auth: confirm the PRODUCTION redirect URLs include the launch-web
production origin (Auth → URL Configuration) before announcing — staging-only
redirect lists are the classic silent login breaker.

First deploy after provisioning: run the durable-execution smoke
(`scripts/smoke/durable-exec-smoke.mjs`, see SMOKE_CHECKLISTS.md) BEFORE
relying on async functions — `ctx.exports` availability inside `queue()` is
undocumented platform behavior and must be proven once per environment.

## Interfaces Rollout (one-time, first deploy of the interfaces worker)

The Interfaces feature (docs/INTERFACE_RELAUNCH_PR_ROADMAP.md) adds a 4th
deployable: the `interfaces-worker/` sandbox worker
(`ultralight-interfaces` / `ultralight-interfaces-staging`), deployed by
`.github/workflows/interfaces-worker-deploy.yml` (staging on `main` push,
production on `v*` tags — same env-scoped Cloudflare secrets as the API).
No new queues, secrets, or migrations.

One-time checks per environment:

1. After the worker's first deploy, run the serving smoke (negative-path
   posture needs no fixtures):
   ```bash
   node scripts/smoke/interface-serve-smoke.mjs \
     --url https://ultralight-interfaces-staging.rgn4jz429m.workers.dev
   ```
2. Upload the demo agent (`examples/interface-demo/` — manifest + index.ts +
   interfaces/playground.html) with a real account, open its agent page,
   and confirm: Interface tab renders, the frame connects (buttons enable),
   a signed-out call returns SIGN_IN_REQUIRED inside the frame, a signed-in
   call returns a result and increments the session-spend line. Then re-run
   the smoke with `--app <appId> --hash <stamped hash>` (hash is in the
   stored manifest) to assert the full positive-path header suite.
3. Config sanity: `INTERFACE_SANDBOX_BASE_URL` (api/wrangler.toml, both
   envs) must point at the matching worker host — the facade fails closed
   (no interfaces anywhere) when unset, which is also the rollback lever.
   `FRAME_ANCESTORS` (interfaces-worker/wrangler.toml) must list the
   launch-web origin(s) or every embed renders blank.

Render metering is log-only (`[INTERFACE-SERVE]` via `wrangler tail` +
Workers analytics). Developer docs: ultralight-spec/conventions/interfaces.md.

## Normal Release Flow

1. Merge release-ready work to `main`.
2. Wait for the `main` workflows to finish:
   - `API CI`
   - `Launch Guardrails`
   - `Supabase DB` staging deploy
   - `API Deploy` staging deploy
   - `Launch Web Deploy` staging deploy
   - `Desktop Build`
   - `Staging Launch Gate`
3. Locally or in CI, confirm the Wave 1 guardrail baseline still matches:

   ```bash
   source ~/.nvm/nvm.sh && nvm use
   node scripts/checks/run-guardrail-checks.mjs
   ```

4. Run the staging smoke checks from
   [SMOKE_CHECKLISTS.md](SMOKE_CHECKLISTS.md).
   The current staging candidate SHA and its expected workflow links should now
   be visible in the `Staging Launch Gate` workflow summary and artifact. Keep
   `release-packet.md` open while you do this and fill the workflow, smoke,
   audit, and exception sections as evidence arrives.
   Prefer the wrapper:

   ```bash
   source ~/.nvm/nvm.sh && nvm use
   ULTRALIGHT_TOKEN=... node scripts/smoke/run-release-smoke.mjs \
     --target staging \
     --url https://ultralight-api-staging.rgn4jz429m.workers.dev \
     --supabase-url https://vonlzcnwxbwaxlbngjre.supabase.co \
     --exercise-chat
   ```
   Then run the staging launch-web Pages smoke:

   ```bash
   ULTRALIGHT_TOKEN=... \
   node scripts/smoke/launch-web-pages-smoke.mjs \
     --target staging \
     --pages-url https://staging.ultralight-launch-web.pages.dev \
     --api-url https://ultralight-api-staging.rgn4jz429m.workers.dev \
     --tool-slug <known-public-tool-slug> \
     --admin-tool-id <owned-staging-tool-id> \
     --output-dir "$UL_LAUNCH_EVIDENCE_DIR"
   ```

   This writes `smoke/launch-web-pages.json` and
   `smoke/launch-web-pages.md`. The Pages route probes should return the SPA
   shell, the public launch API probes should return valid JSON, and the API
   CORS probe should allow
   `https://staging.ultralight-launch-web.pages.dev`.
5. If staging fails, fix forward on `main`. Do not tag a known-bad commit.
6. Confirm the desktop version is correct in:
   - `desktop/package.json`
   - `desktop/src-tauri/tauri.conf.json`
   - `desktop/src-tauri/Cargo.toml`
7. Create and push the release tag:

   ```bash
   git checkout main
   git pull
   git tag -a v0.1.0 -m "Release v0.1.0"
   git push origin v0.1.0
   ```

8. Watch the tag-triggered production workflows:
   - `Supabase Production DB`
   - `API Deploy`
   - `Launch Web Deploy`
   - `Desktop Release`
   - `Production Launch Gate`
   Then initialize the production packet if it does not already exist:

   ```bash
   source ~/.nvm/nvm.sh && nvm use
   node scripts/ops/init-release-packet.mjs \
     --target production \
     --git-ref refs/tags/v0.1.0 \
     --version-tag v0.1.0 \
     --commit-sha <sha>
   ```
9. Run the production smoke checks from
   [SMOKE_CHECKLISTS.md](SMOKE_CHECKLISTS.md).
   Prefer the wrapper:

   ```bash
   source ~/.nvm/nvm.sh && nvm use
   ULTRALIGHT_TOKEN=... node scripts/smoke/run-release-smoke.mjs \
     --target production \
     --url https://ultralight-api.rgn4jz429m.workers.dev \
     --supabase-url https://uavjzycsltdnwblwutmb.supabase.co \
     --exercise-chat
   ```
   Then run the production launch-web Pages smoke:

   ```bash
   ULTRALIGHT_TOKEN=... \
   node scripts/smoke/launch-web-pages-smoke.mjs \
     --target production \
     --pages-url https://ultralight-launch-web.pages.dev \
     --api-url https://ultralight-api.rgn4jz429m.workers.dev \
     --tool-slug <known-public-tool-slug> \
     --admin-tool-id <owned-production-tool-id> \
     --output-dir "$UL_LAUNCH_EVIDENCE_DIR"
   ```

   The Pages probes should return the SPA shell, the API probes should return
   valid launch JSON, and the API CORS probe should allow
   `https://ultralight-launch-web.pages.dev`.
   The production gate summary should reference the same candidate SHA that
   already passed `Staging Launch Gate`, plus the required production workflow
   run links for the release tag. Record those URLs and the resulting smoke
   summary in the release packet before announcement.
10. If you are validating the updater path, run the optional updater smoke with
   a previously tagged desktop build still installed.
11. Announce the release only after `Production Launch Gate` is green and
    production smoke passes, the release packet is complete, and the candidate
    satisfies
    [docs/LAUNCH_SIGNOFF_POLICY.md](LAUNCH_SIGNOFF_POLICY.md).

## Rollback Guidance

For the full rehearsal kit and scenario-specific playbooks, use:

- [docs/ROLLBACK_REHEARSAL.md](ROLLBACK_REHEARSAL.md)

Initialize the rehearsal packet with:

```bash
source ~/.nvm/nvm.sh && nvm use
node scripts/ops/init-rollback-rehearsal.mjs \
  --target production \
  --output-dir "$UL_LAUNCH_EVIDENCE_DIR/rollback-rehearsal"
```

That creates the minimum rehearsal artifacts:

- `rollback-rehearsal/metadata.json`
- `rollback-rehearsal/notes.md`

### If staging fails

- Do not tag.
- Fix forward on `main`.
- Re-run staging smoke after the fix lands.

### If a production workflow fails mid-release

- Fix forward with a new patch release.
- Do not move or reuse the existing tag.
- Cut a new tag such as `v0.1.1` from a revert or hotfix commit.

### Launch website rollback

- Cloudflare Pages deployments are independent from the API Worker. If a
  launch-web-only deploy is bad, roll the `ultralight-launch-web` project back
  to the previous successful deployment in Cloudflare Pages, then record the
  deployment ID in the release packet.
- If rollback needs to happen from source instead, revert the launch-web change
  on `main` for staging or cut a patch tag for production. Do not point staging
  Pages at production API or production Pages at staging API to work around a
  bad build.

### Database caution

- Production database migrations should be additive and backward-compatible.
- This release flow does not assume automatic database rollback.
- If a migration causes a severe production issue, stop and treat it as a
  manual recovery event using Supabase restore / operator intervention.
- The backup-and-restore drill in
  [docs/BACKUP_RESTORE_DRILL.md](BACKUP_RESTORE_DRILL.md)
  is the reference exercise for proving that this recovery path is actually
  usable.

### Desktop release issue after publication

- Prefer a hotfix patch release.
- If needed, point users to the previous signed GitHub Release artifact while
  the hotfix is prepared.
- Treat updater issues separately from installer issues in the incident notes.

## Operator Notes

- `main` builds staging desktop artifacts. Tags build production desktop
  releases.
- The release workflows are intentionally separate, so watch all production
  workflows on the tag before declaring success.
- `Launch Guardrails` is the CI backstop for tokenized-URL transport, wildcard
  CORS regressions, placeholder runtime strings, backup artifacts, and new
  root-level `migration-*.sql` files. Treat a failing guardrail workflow as
  stop-ship until reviewed. The current reviewed
  `query-token-auth` baseline is now `0`.
- The updater feed is GitHub Release `latest.json`, so production desktop
  updates depend on the repository staying public or on moving the updater feed
  elsewhere later.
- Desktop logout now calls the server sign-out path when a saved token is
  present, then clears secure local storage. This revokes the current
  Supabase session refresh path, but it is still not a global Google logout.
- Shared markdown links now bootstrap through
  `/share/p/:userId/:slug#share_token=...` and exchange that fragment secret
  into a page-scoped HttpOnly cookie before redirecting to the real page URL.
