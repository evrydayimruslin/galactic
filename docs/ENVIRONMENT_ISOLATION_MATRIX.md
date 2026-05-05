# Environment Isolation Matrix

Last reviewed: `2026-04-21`

This document is the canonical inventory of release-relevant environment
surfaces and the remaining staging/production coupling that still exists at
launch time.

Use it to answer three questions quickly:

1. What is actually isolated today?
2. What is still shared by exception?
3. Which exceptions are acceptable for launch, and which ones require explicit
   operator signoff before promotion?

## Status Legend

- `Isolated`: staging and production use separate backing resources or clearly
  separate deploy targets.
- `Shared exception`: staging and production intentionally share a backing
  resource today.
- `Production only`: the surface exists in production but does not currently
  have staging parity.
- `Diagnostic only`: the surface is real but should not be treated as a normal
  staging or production release target.

## Control Plane And Client Surfaces

| Surface | Staging | Production | Isolation status | Current owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Public API hostname | `https://ultralight-api-staging.rgn4jz429m.workers.dev` | `https://ultralight-api.rgn4jz429m.workers.dev` | `Isolated` | Platform / API | [api/wrangler.toml](../api/wrangler.toml), [docs/RELEASE_TOPOLOGY.md](RELEASE_TOPOLOGY.md) | Separate Worker scripts and Workers.dev origins; replace only with an owned custom domain |
| Main API Worker script | `ultralight-api-staging` | `ultralight-api` | `Isolated` | Platform / API | [api/wrangler.toml](../api/wrangler.toml) | Same code path, separate Cloudflare script names |
| Main API deploy environment | GitHub `staging` environment | GitHub `production` environment | `Isolated` | Release ops | [`.github/workflows/api-deploy.yml`](../.github/workflows/api-deploy.yml) | Separate deployment credentials and concurrency groups |
| Supabase project | `SUPABASE_STAGING_PROJECT_ID` | `SUPABASE_PRODUCTION_PROJECT_ID` | `Isolated` | Database / Release ops | [`.github/workflows/supabase-db.yml`](../.github/workflows/supabase-db.yml), [`.github/workflows/supabase-production-db.yml`](../.github/workflows/supabase-production-db.yml) | Primary DB boundary is correctly split |
| Schema deploy workflow | Staging schema push on `main` | Production schema push on `v*` tags | `Isolated` | Database / Release ops | [`.github/workflows/supabase-db.yml`](../.github/workflows/supabase-db.yml), [`.github/workflows/supabase-production-db.yml`](../.github/workflows/supabase-production-db.yml) | Canonical migration source is shared, target projects are not |
| Desktop build channel | `staging` | `production` | `Isolated` | Desktop | [`.github/workflows/desktop-build.yml`](../.github/workflows/desktop-build.yml), [`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml) | Build channel is pinned per workflow |
| Desktop pinned API base | `https://ultralight-api-staging.rgn4jz429m.workers.dev` | `https://ultralight-api.rgn4jz429m.workers.dev` | `Isolated` | Desktop | [desktop/src/lib/environment.ts](../desktop/src/lib/environment.ts) | Production and staging desktop builds reject mismatched API bases |
| Desktop updater endpoint | not used in standard staging builds | [latest.json](https://github.com/evrydayimruslin/ultralight/releases/latest/download/latest.json) | `Isolated` | Desktop / Release ops | [`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml), [docs/DESKTOP_RELEASE_PIPELINE.md](DESKTOP_RELEASE_PIPELINE.md) | Production-only by design |
| Secondary data worker | no standard staging deployment | `ultralight-data` | `Production only` | Platform / API | [worker/wrangler.toml](../worker/wrangler.toml), [docs/RELEASE_TOPOLOGY.md](RELEASE_TOPOLOGY.md) | Not part of the main staging release chain |
| Legacy `ultralight.dev` hostnames | not used | not used | `Diagnostic only` | Platform / Release ops | [docs/RELEASE_TOPOLOGY.md](RELEASE_TOPOLOGY.md) | `ultralight.dev` is not project-owned; do not use `api.ultralight.dev` or `staging-api.ultralight.dev` as release evidence unless ownership changes |

## Data Plane Surfaces

| Surface | Staging | Production | Isolation status | Current owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Cloudflare R2 bucket `R2_BUCKET` | `ultralight-apps` | `ultralight-apps` | `Shared exception` | Platform / API | [api/wrangler.toml](../api/wrangler.toml) | Shared object store across staging and production |
| Cloudflare KV `CODE_CACHE` | `d348ee797036460faf4b3e014921f0b0` | `d348ee797036460faf4b3e014921f0b0` | `Shared exception` | Platform / API | [api/wrangler.toml](../api/wrangler.toml), [worker/wrangler.toml](../worker/wrangler.toml) | Shared compiled-code cache |
| Cloudflare KV `FN_INDEX` | `75ce02786ac2466fbca833c95bf3cb56` | `75ce02786ac2466fbca833c95bf3cb56` | `Shared exception` | Platform / API | [api/wrangler.toml](../api/wrangler.toml) | Shared function index for runtime lookups |
| Desktop staging runtime data plane | staging desktop hits staging API, which still binds shared R2/KV | production desktop hits production API, which binds the same R2/KV | `Shared exception` | Desktop + Platform / API | [docs/DESKTOP_RELEASE_PIPELINE.md](DESKTOP_RELEASE_PIPELINE.md), [api/wrangler.toml](../api/wrangler.toml) | Client channel is isolated, object/cache state is not |

## Shared-Resource Exception Register

| Surface | Current owner | Why it is shared today | Risk if it goes wrong | Current guardrail | Target removal wave / date | Launch disposition |
| --- | --- | --- | --- | --- | --- | --- |
| Cloudflare R2 bucket `ultralight-apps` | Platform / API | Avoided blocking staging on new bucket provisioning while the primary auth, hostname, and database boundaries were fixed first | Staging writes can mutate or overwrite production-facing object data | Separate API hostnames, separate Worker scripts, separate Supabase projects, explicit release-topology callout, required smoke on data-plane changes | Post-launch infra-isolation follow-up, target review by `2026-05-31` | `Acceptable launch exception` only if called out in release evidence for candidates that touch object storage, upload, publish, or generated asset flows |
| Cloudflare KV `CODE_CACHE` | Platform / API | Reused existing namespace while converging runtime execution and avoiding cache-migration risk mid-hardening | Staging execution can poison production-adjacent compiled-code cache entries | Shared-runtime caveat documented, dependency-cycle/typecheck/guardrails already in CI, smoke required after runtime or bundling changes | Post-launch infra-isolation follow-up, target review by `2026-05-31` | `Acceptable launch exception` only if release notes call out cache coupling for candidates that touch runtime execution, bundling, or upload paths |
| Cloudflare KV `FN_INDEX` | Platform / API | Same staged rollout choice as `CODE_CACHE`; index split was deferred to keep runtime-path migration bounded | Staging indexing or discovery writes can affect production runtime lookup behavior | Same control set as `CODE_CACHE`, plus release operators should treat function-discovery changes as coupled | Post-launch infra-isolation follow-up, target review by `2026-05-31` | `Acceptable launch exception` only if release evidence notes the shared index for candidates touching function discovery or metadata generation |
| Desktop staging runtime data plane | Desktop + Platform / API | Desktop staging builds are already channel-isolated, but they still inherit the staging API's shared R2/KV backing resources | A desktop staging test can still exercise shared object/cache state and give a false sense of full isolation | Staging desktop remains pinned to staging API, and the shared data-plane caveat is explicit in release docs | Remove when R2/KV split is complete, target review by `2026-05-31` | `Acceptable launch exception` only if desktop staging smoke is treated as data-plane coupled for widget, upload, publish, and cache-sensitive changes |

## Production-Only And Diagnostic Exceptions

| Surface | Current owner | Why it is not fully mirrored in staging | Risk if it is changed | Current guardrail | Target removal wave / date | Launch disposition |
| --- | --- | --- | --- | --- | --- | --- |
| Secondary data worker `ultralight-data` | Platform / API | It is an optional internal runtime and is not deployed by the standard staging workflows today | Changes to [worker/src/index.ts](../worker/src/index.ts) can reach production without standard staging parity | The surface is explicitly marked non-standard in release topology and should be reviewed separately whenever `worker/**` changes | Either add staging parity or retire the surface, target review by `2026-06-15` | `Stop-ship without explicit exception` for candidates that touch `worker/**`, `worker/wrangler.toml`, `WORKER_DATA_URL`, or `WORKER_SECRET` behavior |
| Direct Worker origin fallback | Platform / Desktop | It exists for local development and misroute resilience, not as a formal release hostname | Operators can accidentally test the wrong origin and mistake it for production proof | The origin is documented as diagnostic only and should never be used as the primary smoke target | Review whether it is still needed after launch stabilization, target review by `2026-06-30` | `Acceptable diagnostic surface` as long as release evidence continues to use the canonical custom domains |

## Release Decision Rules

### Acceptable Launch Exceptions

The following exceptions are acceptable at launch if they stay explicit in the
candidate evidence and no new coupling is introduced:

- shared R2 object storage
- shared `CODE_CACHE`
- shared `FN_INDEX`
- desktop staging's inherited data-plane coupling through the staging API
- the direct Worker fallback origin, as long as it stays outside standard smoke
  and promotion evidence

### Stop-Ship Or Explicit-Exception Surfaces

The following should block promotion unless an operator writes and approves an
explicit exception in the candidate notes:

- any candidate that changes
  [worker/src/index.ts](../worker/src/index.ts)
  or [worker/wrangler.toml](../worker/wrangler.toml)
  without production-only validation steps
- any candidate that expands staging/production sharing beyond the resources
  already registered in this document
- any candidate that changes Cloudflare data-plane behavior without updating the
  shared-resource exception lines in the release evidence

## Operator Use

- Start with
  [docs/RELEASE_TOPOLOGY.md](RELEASE_TOPOLOGY.md)
  for the promotion chain.
- Use this matrix when the candidate touches:
  - `api/wrangler.toml`
  - `worker/**`
  - upload, publish, runtime execution, or cache/index behavior
  - desktop release or updater flows
- Carry any applicable shared-resource or production-only exception into the
  candidate evidence before tag promotion.

No intentional staging/production sharing should live only in prose elsewhere.
If a new exception appears, add it here before calling the candidate
release-ready.
