# Launch Scorecard

Last reviewed: `2026-04-24`

This scorecard maps the current codebase against the launch checklist used in
the Wave 0 hardening program. It is evidence-based, not aspirational.

Use it with
[docs/LAUNCH_SIGNOFF_POLICY.md](LAUNCH_SIGNOFF_POLICY.md).
This scorecard is not the release decision by itself. The release decision
lives in the candidate's `release-packet.md`, which must reference this
scorecard and the supporting evidence.

Status legend:

- `Pass`: evidence exists in the repo and the current implementation appears to
  satisfy the checklist item.
- `Partial`: some of the requirement exists, but the implementation is
  inconsistent, incomplete, or still uses risky fallbacks.
- `Unresolved`: the checklist item is not met or the current implementation has
  a launch-blocking gap.
- `Operational`: may be true in production, but cannot be verified from the
  repo alone.
- `N/A`: not applicable to the current auth model or deployment model.

Verification class legend:

- `Repo-backed`: may move based on committed code, CI output, and reviewed repo
  evidence.
- `Operational`: requires candidate-specific runtime or operator evidence and
  must not move to `Pass` from a doc-only change.
- `Launch exception`: may ship only with explicit acceptance in the release
  packet and a named evidence source.

## Summary

Current launch status: `Not ready`

This status must not be lifted by editing this file alone. It can move only
through the release-packet and signoff flow defined in
[docs/LAUNCH_SIGNOFF_POLICY.md](LAUNCH_SIGNOFF_POLICY.md).

Primary stop-ship items before MVP launch:

- The repo-side launch checks now land locally with guardrail baselines passing,
  API/desktop analysis passing, API tests passing, desktop tests/build passing,
  Wrangler production and staging dry-runs passing, and dependency audits clean.
- Launch readiness is still held back by operational evidence: live staging and
  production smoke, Supabase migration validation/deploy evidence,
  backup/restore proof, release secrets, updater/signing proof, and manual
  desktop end-to-end signoff.

## Security

| Checklist item | Status | Verification class | Evidence | Gap / next action |
| --- | --- | --- | --- | --- |
| No API keys or secrets in frontend code | Partial | Repo-backed | No obvious hardcoded production secrets were found in `web/` or `desktop/`. Desktop embeds now use bridge tokens instead of iframe bearer URLs, browser shells no longer migrate legacy localStorage auth into sessions, app endpoint copy flows emit bare MCP URLs, and shared markdown links now use `/share/p/...#share_token=...` fragment bootstrap plus a page-scoped HttpOnly cookie instead of request-URL token transport. | Shared-page links are still bearer-style share secrets at the product level even though they no longer travel in request URLs. |
| Every route checks authentication | Partial | Repo-backed | `docs/LAUNCH_ROUTE_INVENTORY.md` now classifies routes by public, authenticated, owner-only, webhook, or service-secret access. MCP and HTTP bearer-query fallback have been removed in code, and many major routes do authenticate explicitly. | Authentication policy is still not centralized, and the repo still mixes public shells, optional auth, service-secret routes, cookie sessions, and bearer headers. Wave 1 should keep converging those models. |
| HTTPS enforced everywhere, HTTP redirected | Partial | Operational | `api/src/worker-entry.ts` sets HSTS headers, and `api/handlers/auth.ts` forces `https://` when building the auth callback origin behind a load balancer. | There is no repo-wide explicit redirect policy proving all HTTP traffic is redirected at the edge. Confirm and document edge-level redirect behavior. |
| CORS locked to your domain, not wildcard | Partial | Operational | `api/services/cors.ts` now centralizes allowlist-based CORS for the Worker entrypoint, legacy entrypoint, `/http/*`, and `/api/skills`, with explicit origins configured in `api/wrangler.toml`. `scripts/checks/run-guardrail-checks.mjs` also fails CI on new wildcard/reflected CORS regressions. | Deploy and smoke-test the new allowlists in staging/production, then remove any remaining assumptions about cross-origin consumers. |
| Input validated and sanitized server-side | Partial | Repo-backed | Shared validators now cover auth/session bootstrap, refresh, signout, embed exchange, shared-page exchange, OAuth registration/authorize/token/revoke, billing/connect mutations, Supabase linking, upload metadata, admin gaps/assessments/balance/app-curation mutations, and marketplace bid/ask/accept/reject/cancel/buy/metrics-visibility writes. The new validator layers live in `api/services/auth-request-validation.ts`, `api/services/platform-request-validation.ts`, `api/services/admin-request-validation.ts`, and `api/services/marketplace-request-validation.ts`. | Validation is materially stronger on the Wave 1 stop-ship surfaces, but it is still not systemic across every route in the repo. Remaining gaps are now mostly outside the core Wave 1 auth/billing/share paths, especially in debug/operator-only or lower-priority mutation surfaces. |
| Rate limiting on auth and sensitive endpoints | Partial | Operational | Rate limiting now covers auth, OAuth, embed bridge/exchange, shared-page exchange, signout, discover, chat, MCP, platform MCP, provisional signup, BYOK/token/config writes, billing/connect writes, marketplace money-moving writes, upload creation/draft, developer mutations, and admin operations through `api/services/auth-rate-limit.ts` and `api/services/sensitive-route-rate-limit.ts`. | Remaining gaps should now be treated as explicit exceptions rather than the norm, and staging/prod smoke still needs to verify the new auth/share throttles behave as expected behind real edge traffic. |
| Passwords hashed with bcrypt or argon2 | N/A | Repo-backed | First-party login is Supabase/OAuth-driven. This repo does not implement its own password database. | Keep this delegated to Supabase/Auth if that remains the model; document clearly that first-party password handling is out of scope. |
| Auth tokens have expiry | Partial | Repo-backed | Browser cookies use max-age in `api/services/auth-cookies.ts`; OAuth auth codes expire; desktop OAuth session rows expire; API tokens have optional `expires_at` in `api/services/tokens.ts`. | Personal API tokens can still be created without mandatory expiry, so the overall platform rule is not universal. |
| Sessions invalidated on logout, server-side | Partial | Operational | `api/handlers/auth.ts` `/auth/signout` now calls Supabase logout for the current access-token JWT before clearing cookies, desktop logout calls the same endpoint when a secure token exists, and auth regression tests cover signout and embed exchange validation behavior. | Refresh/session revocation is now server-side, but JWT access tokens still remain valid until their natural expiry. Keep JWT expiry appropriately short and document the caveat in smoke checks. |

## Database

| Checklist item | Status | Verification class | Evidence | Gap / next action |
| --- | --- | --- | --- | --- |
| Backups configured and tested | Partial | Operational | The repo now includes a concrete drill in `docs/BACKUP_RESTORE_DRILL.md`, an operator scaffold in `scripts/ops/init-backup-restore-drill.mjs`, and the release runbook now points at the drill instead of only mentioning generic manual recovery. | A real restore still needs to be executed into an isolated target, validated against known data, and attached to the release evidence before this can be marked `Pass`. |
| Parameterized queries everywhere | Partial | Repo-backed | D1 proxy surfaces accept `params` arrays in `worker/src/index.ts`, and the D1 design docs emphasize parameterized access. | The repo still contains raw SQL proxies and many dynamically concatenated REST query strings. This is not yet provable as a universal guarantee. |
| Separate dev and production databases | Pass | Repo-backed | `supabase/README.md`, `.github/workflows/supabase-db.yml`, and `.github/workflows/supabase-production-db.yml` distinguish staging and production Supabase projects. | Keep the separation explicit in runbooks and env management. |
| Connection pooling configured | Operational | Operational | Supabase/managed platform infrastructure likely covers pooling, but there is no in-repo confirmation. | Document the runtime assumption or add provider-level evidence. |
| Migrations in version control, not manual changes | Pass | Repo-backed | `supabase/README.md` states the baseline migration is checked in; `supabase/migrations/` is versioned; staging and production workflows deploy migrations from git. | Keep all new schema changes in the canonical migrations path only. |
| App uses a non-root DB user | Partial | Operational | Browser/user flows use Supabase anon/session access patterns; backend service flows use `SUPABASE_SERVICE_ROLE_KEY`. | Service-role usage is still broad in backend handlers; least-privilege review is still needed for launch hardening. |

## Deployment

| Checklist item | Status | Verification class | Evidence | Gap / next action |
| --- | --- | --- | --- | --- |
| All environment variables set on the production server | Operational | Operational | GitHub workflows and docs reference required environments and secrets for staging and production. | The repo cannot prove the live production environment is complete or current. |
| SSL certificate installed and valid | Operational | Operational | The release runbook uses Workers.dev origins until an owned custom API domain is configured. | Certificate validity is an external environment concern and is not verifiable from repo state alone. |
| Firewall configured, only 80/443 public | Operational | Operational | Cloudflare Workers make the traditional firewall/process model less relevant for the primary API. | The repo cannot verify edge/network policy. |
| Process manager running | N/A | Repo-backed | The current primary API entry point is `api/src/worker-entry.ts` for Cloudflare Workers, and legacy DigitalOcean/server-process artifacts have been removed from the launch path. | Keep the Worker deployment topology authoritative in docs and CI. |
| Rollback plan exists | Partial | Operational | `docs/RELEASE_RUNBOOK.md` now points at a dedicated rehearsal kit in `docs/ROLLBACK_REHEARSAL.md`, desktop recovery notes are explicit in `docs/DESKTOP_RELEASE_PIPELINE.md`, and `scripts/ops/init-rollback-rehearsal.mjs` scaffolds a rehearsal packet in the Wave 6 evidence tree. | The recovery model is now documented, but it is still not rehearsed until a real tabletop is run and attached to release evidence. |
| Staging test passed before production deploy | Pass | Operational | `docs/RELEASE_RUNBOOK.md` and `docs/SMOKE_CHECKLISTS.md` explicitly require staging workflows and staging smoke before tagging production. | Keep the stop-ship discipline enforced in release operations. |

## Code

| Checklist item | Status | Verification class | Evidence | Gap / next action |
| --- | --- | --- | --- | --- |
| No `console.log` in production build | Partial | Repo-backed | Wave 5 moved the highest-value runtime surfaces onto shared logging helpers and `scripts/checks/run-guardrail-checks.mjs` now protects those converted files through the `guarded-direct-console` baseline. | Broader repo-wide console debt still exists in lower-priority API/services and CLI/stdout surfaces, so this is not yet a universal guarantee. |
| Error handling on all async operations | Partial | Repo-backed | Many handlers now catch and classify failures, especially in auth, upload, chat, OAuth, admin flows, quota/billing checks, originality, D1 metering, and launch-sensitive platform mutations. Failure-policy tests now cover strict fail-closed behavior on high-cost paths and explicit fail-open exceptions where retained. | This is materially stronger, but still not a universal guarantee across every async surface in the repo. |
| Loading and error states in UI | Partial | Repo-backed | Some important UI surfaces, such as `desktop/src/components/WebPanel.tsx`, do show explicit loading and retry states. | This is not yet a platform-wide guarantee across the web shell, desktop app, and generated app surfaces. |
| Pagination on all list endpoints | Partial | Repo-backed | Some list endpoints use `limit` and query parameters, for example in discover and transaction/history-style routes. | Several read APIs still return bounded lists without a stable pagination contract, especially owner dashboards and analytics-style reads. |
| `npm audit` run, critical issues resolved | Pass | Repo-backed | API `npm audit --audit-level=critical` is clean. Desktop `pnpm audit --audit-level=high` is clean after the Vite/Vitest/plugin-react updates and the `picomatch` overrides in `desktop/package.json` / `desktop/pnpm-lock.yaml`. | Re-run audits as part of each release candidate and attach workflow or terminal output to the release packet. |

## Active Launch Exceptions

| Exception | Verification class | Status | Evidence | Release rule |
| --- | --- | --- | --- | --- |
| Shared Cloudflare R2 object store between staging and production | Launch exception | Active | [docs/ENVIRONMENT_ISOLATION_MATRIX.md](ENVIRONMENT_ISOLATION_MATRIX.md) | May ship only if the release packet accepts it explicitly for the candidate |
| Shared Cloudflare KV `CODE_CACHE` between staging and production | Launch exception | Active | [docs/ENVIRONMENT_ISOLATION_MATRIX.md](ENVIRONMENT_ISOLATION_MATRIX.md) | May ship only if the release packet accepts it explicitly for the candidate |
| Shared Cloudflare KV `FN_INDEX` between staging and production | Launch exception | Active | [docs/ENVIRONMENT_ISOLATION_MATRIX.md](ENVIRONMENT_ISOLATION_MATRIX.md) | May ship only if the release packet accepts it explicitly for the candidate |
| Desktop staging data-plane coupling through shared R2/KV | Launch exception | Active | [docs/ENVIRONMENT_ISOLATION_MATRIX.md](ENVIRONMENT_ISOLATION_MATRIX.md) | May ship only if the release packet accepts it explicitly for the candidate |
| Production-only secondary data worker when touched by a candidate | Launch exception | Conditional stop-ship | [docs/ENVIRONMENT_ISOLATION_MATRIX.md](ENVIRONMENT_ISOLATION_MATRIX.md) | Blocks release unless the packet records an explicit exception decision and validation plan |

## Additional Notes

- The route inventory is now the authoritative baseline for “what is exposed”:
  [LAUNCH_ROUTE_INVENTORY.md](LAUNCH_ROUTE_INVENTORY.md).
- The current staging/production coupling and production-only runtime
  exceptions are now inventoried in
  [ENVIRONMENT_ISOLATION_MATRIX.md](ENVIRONMENT_ISOLATION_MATRIX.md).
- This scorecard should be updated only when evidence changes in the repo or in
  a documented operational runbook.
- Repo-backed items may move based on code and CI evidence. Operational items
  require candidate-specific evidence in the release packet. Launch exceptions
  require explicit acceptance in the packet.
- Repo-side readiness is now strong enough to start commit slicing, but
  operational evidence still controls the final launch decision.
