# Light Cloud Economy Debt Log

Date started: 2026-05-05

This tracks caveats, cleanup items, migration follow-through, and final hardening work accumulated while implementing PR15 onward from `docs/light-cloud-economy-pr-stack.md`.

## Migration Follow-Through

Apply and verify these together before merge:

- `supabase/migrations/20260505120000_light_cloud_economy_config.sql`
- `supabase/migrations/20260505130000_cloud_usage_ledger.sql`
- `supabase/migrations/20260505140000_runtime_cloud_holds.sql`
- `supabase/migrations/20260505141000_mcp_call_logs_cloud_usage.sql`
- `supabase/migrations/20260505150000_combined_storage_d1.sql`
- `supabase/migrations/20260505160000_payout_net_economics.sql`
- `supabase/migrations/20260505170000_call_receipt_economics.sql`
- `supabase/migrations/20260507120000_caller_infra_fallback.sql`
- `supabase/tests/database/cloud_usage_ledger.test.sql`

Status:

- 2026-05-05: User reported the PR15-25 migration stack was applied to Supabase successfully in timestamp order.
- 2026-05-05: Local Supabase validation passed via `./scripts/supabase/validate-local.sh`; migration replay, schema lint with `--fail-on error`, `cloud_usage_ledger.test.sql`, and `marketplace_light_ledger.test.sql` all passed.
- 2026-05-05: Local DB smoke confirmed 15% platform fee config, `0.001` Light per cloud unit, `$25` card/wire funding minimums, cloud usage ledger tables, receipt economics columns, and cloud/payout RPCs.
- 2026-05-05: Pre-stage verification passed: `deno task verify`, API full tests, API full TypeScript check, desktop tests, desktop build, SDK build, Worker dry-run deploy, launch guardrails, and `git diff --check`.
- 2026-05-05: `packages/types` declarations were regenerated so shared economics constants and stale marketplace copy match the source changes.

Backlog:

- Run a remote read-only smoke check against the deployed Supabase project/API once service credentials are available in the release environment.
- Confirm migration ordering against any production migrations added after `2026-05-05`.
- Active API clients, package homepages, and smoke defaults now use `https://ultralight-api.rgn4jz429m.workers.dev` because `ultralight.dev` is not project-owned and `https://api.ultralight.dev` currently resolves to an external CloudFront distribution. Remaining `ultralight.dev` references in legacy docs/design copy are deferred until an owned custom domain is chosen.
- Staging API defaults now point at `https://ultralight-api-staging.rgn4jz429m.workers.dev`, but that Workers.dev hostname returned Cloudflare 1042 before the first staging Worker deploy. Re-smoke after the staging deploy workflow provisions it.
- Repo-wide `deno lint` is not yet a usable gate; it currently reports existing lint debt across old API/SDK/CLI files. Continue using the documented `deno task verify` path until lint debt is retired.

## PR15-25 Caveats

- PR15: billing config defaults and public labels are updated, but final admin UX/copy audit is intentionally deferred to PR25.
- PR16: cloud usage ledger/RPC client exists, but database-level verification still needs the migration/test workflow above.
- PR17: MCP, `/http`, and `/run` share settlement, and unauthenticated public `/http` execution is gated. Final receipt/UI presentation is deferred to PR25.
- PR18: runtime holds and call-log cloud columns are wired. Final call receipt detail/rollup display is deferred to PR25.
- PR19: runtime/storage operation metering backbone is wired for R2/KV/appdata/memory/dynamic worker paths. Audit remaining historical control-plane/cache paths such as FN_INDEX/upload/cache helpers for unmetered R2/KV operations.
- PR20: D1 runtime read/write metering is wired through runtime bindings and legacy service paths. Old D1 overage billing is reconciliation-only now; confirm no UI still presents the old D1 free-tier economics after PR25 copy pass.
- PR21: storage-at-rest billing covers source/app bytes, user app data, D1 storage, and page/memory/library content bytes. There is no separate authoritative counter yet for developer-owned logs/shared platform artifacts, so those remain a storage-attribution backlog item.
- PR22: publish deposit gating is disabled by default and guarded by billing config if re-enabled. No dedicated upload handler test file was present; coverage was added at the shared tier-enforcement helper and config/QA layers.
- PR23: widget pulls now create a distinct `widget_pull` cloud usage event in addition to the underlying runtime/storage metering for the app call. Keep this additive model unless the final product economics decide widget pulls should bundle or replace runtime units.
- PR23: widget monthly cost projection is desktop-local and uses the configured public rate of `0.001` Light per pull. Final receipt/admin UI should sync the displayed estimate to live billing config if admins change `widget_pulls_per_cloud_unit` or cloud-unit Light pricing.
- PR23: coverage was added at widget runtime/helper and settlement layers. Hook/component interaction tests remain a backlog item unless a desktop hook/component harness is introduced.
- PR24: payout processing now transfers/pays out net proceeds and persists gross, estimated fee, actual transfer, and actual payout cents. Apply the payout migration before processing real payouts, because old rows will not have authoritative actual transfer/payout amounts unless Stripe responses already captured them.
- PR24: Stripe fee pass-through uses the estimate captured at payout request time. Reconcile against Stripe balance reports in admin after live runs to tune any region- or method-specific fee deltas.
- PR25: call receipt economics are durable for new rows after `20260505170000_call_receipt_economics.sql`. Historical rows are backfilled from legacy call-charge/cloud-charge fields where possible, but historical platform fee/developer net detail may be incomplete if it was never captured.
- PR25: admin cloud economics relies on `cloud_usage_events` plus enriched `mcp_call_logs`; run the migration stack before using it as the launch audit source.
- PR26: owner-sponsored free-call runtime holds now fall back to caller-funded infra when the owner has no Light. Platform control-plane tools remain outside runtime metering for now and should stay protected by account/token rate limits.

## Final Hardening Backlog

- Full stale-copy audit for deeper docs that are not product/API surfaces, including legacy architecture docs that still mention prior storage or 10% economics.
- Full receipt audit against live data after migrations: app price, infra Light, cloud units, worker/D1/R2/KV/widget units, platform fee, developer net.
- Ensure all runtime infra paths fail closed or hold before externally billable work.
- Confirm no partial debits remain for cloud infrastructure charges.
- Confirm every cloud usage event has enough metadata to debug payer, sponsor, app, function, source, receipt, and config version.
- Reconcile account storage attribution for logs, app-owned shared data, build artifacts, and any platform-only control-plane storage that should be metered or explicitly excluded.
- Run full API, desktop, and migration verification before final merge.
