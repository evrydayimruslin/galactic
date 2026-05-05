# Launch Follow-ups

This file tracks issues intentionally deferred while we land the launch PR
sequence. It is not a backlog for everything in the repo; it is a scoped list
of launch-relevant follow-ups discovered during implementation.

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
