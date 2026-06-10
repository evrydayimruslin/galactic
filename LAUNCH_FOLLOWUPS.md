# Launch Follow-ups

> **⚠️ PARTIALLY SUPERSEDED (2026-06-10)**: the desktop app is scrapped, so
> every desktop-release follow-up below (signing, notarization, updater
> keypairs, desktop smoke) is void. The owned-domain cleanup and live
> staging/production smoke items remain relevant. Current plan:
> [docs/LAUNCH_PIVOT_DECISIONS.md](docs/LAUNCH_PIVOT_DECISIONS.md).

This file tracks issues intentionally deferred while we land the launch PR
sequence. It is not a backlog for everything in the repo; it is a scoped list
of launch-relevant follow-ups discovered during implementation.

## Phase 3 (2026-06-10)

- **Tools → Agents alias windows:** the rename shipped with full backward
  compatibility — legacy public routes (`/tools/:slug`, `/admin/tools/:id`),
  legacy API paths (`/api/launch/tools/*`, `.../agent-permissions` — see
  `LAUNCH_COMPATIBILITY_API_ROUTES`), deprecated response-field aliases
  (`tool`, `toolInstall`, `selectedToolSlug`, `publicToolUrl`,
  `agentPermission`), and deprecated contract type aliases
  (`LaunchTool*`, `LaunchAgentFunctionPermission*`). Schedule removal one
  release window after clients migrate.
- **Republish @ultralightpro/types** after the next API deploy so external
  consumers get the `LaunchAgent*`/`LaunchCaller*` names (old names remain
  as deprecated aliases — non-breaking).
- **Unrenamed by design:** DB tables (`user_agent_function_permissions`,
  `user_agent_permission_defaults`), machine error codes
  (`AGENT_PERMISSION_REQUIRED`/`DENIED`, RPC -32003), and MCP protocol
  vocabulary (`tools/list`, `tools/call`).

## Phase 2 (2026-06-10)

- **Deploy-before-republish ordering:** the CLI now sends
  `default_price_credits` to `ul.set`. Deploy the API Worker (which accepts
  both `default_price_credits` and the deprecated `default_price_light`)
  BEFORE publishing the next `ultralightpro` CLI release, or the new CLI
  against the old API will fail pricing updates.
- **Balance-gate behavior change:** credits-billed runtime inference now
  requires a minimum spendable balance (the chat-gate constant, 50 credits)
  BEFORE the provider call. Users below the minimum get a clear
  "add credits or configure BYOK" error instead of an under-collected call.
  The gate fails open on billing-read outages (post-hoc debiting still
  applies there).
- **Light-alias deprecation window:** launch contracts/wire now emit/accept
  both `credits` and deprecated `light` spellings (`LaunchMoneyAmount.light`,
  `amountLight`, `lightPerDollar`, `amount_light`, `default_price_light`).
  Schedule removal of the deprecated aliases one release window after
  clients migrate. Machine error codes (`LIGHT_REQUIRED`, …) and MCP output
  field names (`cost_light`, `charged_light`, …) intentionally unchanged.
- **Persona docs still say Light:** `skills/*.md` system-agent prompts are
  R2-served (`system-agents/{type}/skills.md`) with no sync script; they
  still teach "Light (✦)" and desktop-era surfaces. Edit + re-upload in a
  later cleanup (they are outside the launch surface).

## Phase 0 (2026-06-10)

- **Deploy ordering requirement:** apply Supabase migration
  `20260610120000_embed_bridge_consumption.sql` BEFORE (or with) the next API
  Worker deploy. `/auth/launch/exchange` now fails closed (503) when the
  bridge-consumption table is unreachable, so deploying the Worker against a
  database without the table breaks launch sign-in.
- Desktop teardown slice still pending: `/auth/embed/*` endpoints,
  desktop OAuth polling, `?embed=1` X-Frame-Options skip, desktop release
  workflows, tauri entries in `supabase/config.toml`, and the desktop
  download surfaces in `api/handlers/app.ts` remain live until the dedicated
  teardown pass.
- Accepted-risk notes from the Phase 0 security review: the
  `/auth/launch/refresh` Origin check passes requests with no Origin header
  (cookie possession still required; browsers always send Origin on
  cross-origin POSTs); the access JWT remains a localStorage bearer by
  design — XSS hardening on the Pages origin is the operative defense.

## Deferred After PR1

- Owned-domain cleanup:
  active API clients now use the direct Workers.dev origins because
  `ultralight.dev` is not controlled by the project. Choose an owned custom
  domain later, configure it as a Cloudflare Worker custom domain, then move
  `BASE_URL`, clients, docs, share links, MCP config, marketing surfaces, and
  HTTP referers to that owned hostname.
- Keep the newly restored desktop validation gates green:
  `corepack pnpm run analyze`, `corepack pnpm test`, `corepack pnpm run
  build:production`, `corepack pnpm audit --audit-level high`, and
  `cargo check` now pass locally. Re-run them before cutting the desktop commit
  slices and again before the release tag.

## Deferred After PR2

- Decide whether desktop logout should also clear browser-side Ultralight
  cookies via `/auth/signout`. For launch we are keeping logout local to the
  desktop app, with explicit account switching on the sign-in screen.
- Add component-style auth flow coverage later if we want UI-level coverage on
  top of the current desktop auth/storage unit tests and backend redirect smoke.

## Deferred After PR3

- Finish the non-SQL staging Supabase setup:
  separate project-level config is still required for staging and production,
  including Google OAuth credentials, redirect URLs, storage buckets, and any
  other dashboard-managed settings that migrations do not cover.
- Stage the remaining Cloudflare-side runtime setup:
  staging now has committed `wrangler` config and deploy workflow support, but
  the runtime still needs staging secrets in Cloudflare plus a first successful
  `ultralight-api-staging.rgn4jz429m.workers.dev` deployment before end-to-end
  auth smoke can pass.
- Decide whether to provision dedicated Cloudflare R2/KV resources for staging:
  the committed `wrangler` staging environment currently shares the production
  R2 bucket and KV namespaces as an intentional interim step. This is workable
  for launch hardening, but dedicated staging bindings would provide cleaner
  operational isolation later.

## Deferred After PR4

- Add the real desktop release credentials:
  the signed tag-driven release pipeline is committed, but it still requires
  GitHub production-environment secrets for macOS notarization/signing and
  Windows code signing before the first public release can succeed.
- Decide whether the Windows signing path should stay `.pfx`-based or move to
  Azure Trusted Signing:
  the current workflow assumes an exportable certificate. That is the simplest
  path for now, but Azure may be a better long-term fit depending on the
  certificate vendor and launch needs.

## Deferred After PR5

- Run the committed smoke checks against live staging and production:
  the scripts and runbooks are in place now, but the real staging/prod smoke
  pass still depends on the final Cloudflare runtime/domain setup and release
  credentials being in place.
- Decide whether to automate the manual desktop smoke later:
  launch hardening now uses backend redirect smoke plus a short manual desktop
  pass. A full desktop E2E harness would be valuable later, but it is not a
  day-one launch blocker.

## Deferred After PR6

- Generate and store the real Tauri updater signing keypair:
  the release workflow now expects `TAURI_UPDATER_PUBLIC_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY`, but those still need to be created, backed up,
  and loaded into GitHub production secrets before the first updater-enabled
  public release.
- Run a live updater smoke on top of two consecutive signed releases:
  the in-app updater UI and release wiring are committed, but we still need one
  real-world pass where an older installed build sees the toast, downloads the
  update, and relaunches successfully.
- Decide whether staging should eventually get its own updater channel:
  the current implementation intentionally enables updater checks only for
  production desktop builds so staging/internal builds never self-update into
  public releases. A dedicated beta feed can be added later if it becomes
  useful.
