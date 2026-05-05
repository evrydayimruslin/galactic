# Smoke Checklists

These are the short smoke checks for staging and production after the Wave 0 /
Wave 1 launch hardening work.

The recommended operator entry point is now:

```bash
source ~/.nvm/nvm.sh && nvm use
node scripts/smoke/run-release-smoke.mjs --help
```

That wrapper runs the command-line smoke checks below and writes machine-readable
and markdown summaries into the Wave 6 evidence layout. The manual desktop
checks in this document still remain manual on purpose.

## Pre-Smoke Guardrails

Before running manual smoke on a release candidate, confirm the automated
Wave 1 guardrails are clean locally or in CI:

```bash
source ~/.nvm/nvm.sh && nvm use
node scripts/checks/run-guardrail-checks.mjs
```

This should match the committed baseline. A changed result means a new
tokenized-URL, wildcard-CORS, placeholder-runtime, or backup-artifact finding
needs review before release smoke continues.

## Staging Smoke (after push to `main`)

Recommended wrapper:

```bash
export UL_LAUNCH_EVIDENCE_DIR="docs/_generated/launch/staging/2026-04-21-main-<sha>"
mkdir -p "$UL_LAUNCH_EVIDENCE_DIR"/{audits,smoke,manual}

source ~/.nvm/nvm.sh && nvm use
ULTRALIGHT_TOKEN=... node scripts/smoke/run-release-smoke.mjs \
  --target staging \
  --url https://ultralight-api-staging.rgn4jz429m.workers.dev \
  --supabase-url https://vonlzcnwxbwaxlbngjre.supabase.co \
  --exercise-chat
```

This writes:

- `smoke/guardrails.txt`
- `smoke/auth-redirect.log`
- `smoke/api-smoke.log`
- `smoke/cors-allowed.*`
- `smoke/cors-blocked.*`
- `smoke/summary.json`
- `smoke/summary.md`

After the wrapper finishes, copy the result paths and final pass/fail state
into `release-packet.md` for the candidate.

### Automated checks

Run the auth redirect smoke once the staging Worker origin is live:

```bash
./scripts/smoke/auth-redirect-smoke.sh \
  --url https://ultralight-api-staging.rgn4jz429m.workers.dev \
  --supabase-url https://vonlzcnwxbwaxlbngjre.supabase.co
```

Run the broader API smoke with a staging bearer token:

```bash
ULTRALIGHT_TOKEN=... ./scripts/smoke-test.sh \
  --url https://ultralight-api-staging.rgn4jz429m.workers.dev \
  --exercise-chat
```

For chat capture rollout candidates, run the capture-specific smoke after the
staging migration has been pushed and the staging Worker has
`ANALYTICS_PEPPER_V1` plus `CHAT_CAPTURE_ENABLED=true` configured:

```bash
ULTRALIGHT_TOKEN=... \
SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/smoke/chat-capture-smoke.mjs \
  --target staging \
  --exercise-orchestrate \
  --write-json "$UL_LAUNCH_EVIDENCE_DIR/smoke/chat-capture.json"
```

This sends one real `/chat/orchestrate` request with project context and a small
file attachment, then verifies `chat_threads`, `chat_messages`, `chat_events`,
`capture_artifacts`, and `capture_artifact_links` rows appeared for the smoke
conversation.

Run a quick CORS sanity check from one allowed and one disallowed origin:

```bash
curl -i -X OPTIONS https://ultralight-api-staging.rgn4jz429m.workers.dev/http/test/ping \
  -H 'Origin: https://ultralight-api-staging.rgn4jz429m.workers.dev' \
  -H 'Access-Control-Request-Method: POST'

curl -i -X OPTIONS https://ultralight-api-staging.rgn4jz429m.workers.dev/http/test/ping \
  -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: POST'
```

Notes:

- `--exercise-chat` sends one tiny streaming prompt and incurs a small real API
  cost.
- Use a real staging test account with enough balance to pass
  `/debug/chat-preflight`.
- If alias retirement is being trialed with
  `PLATFORM_MCP_DISABLED_ALIASES=removable`, include one manual MCP call using a
  removable alias such as `ul.execute` or `ul.lint` and confirm the response
  points at the canonical replacement instead of silently succeeding.

### Manual desktop checks

Use the latest desktop artifact from the `Desktop Build` workflow on `main`.

1. Launch the staging desktop build.
2. Click `Sign in with Google` and confirm the system browser opens.
3. Complete Google sign-in with a staging test user.
4. Confirm the desktop leaves the auth gate without manual token entry.
5. Send one short prompt in a fresh chat and confirm the response streams.
6. Click `Sign out` and confirm the desktop returns to the auth screen.
7. Click `Use another account` and confirm the browser shows Google account
   selection instead of silently reusing the previous account.
8. If you cancel mid-poll, confirm `Open sign-in page again` reopens the login
   page cleanly.
9. Open an embedded settings/dashboard page and confirm the loaded URL uses
   `#bridge_token=...` when auth handoff is needed, not `?token=...`.
10. Open a shared markdown page link and confirm it lands on
    `/share/p/...#share_token=...`, then redirects to `/p/...` without leaving
    the share secret in the request URL.

Stop-ship failures:

- Browser login never reaches the desktop app
- Desktop poll never completes after successful browser auth
- First chat cannot stream
- Sign out leaves the desktop in a broken authenticated state
- Any copied MCP/dashboard/share URL exposes a bearer-style `?token=...`
- Shared markdown links fail after the fragment bootstrap redirect
- Allowed/disallowed CORS preflight behavior does not match the environment
- The release packet still shows `pending` for smoke after the candidate smoke
  is complete

## Production Smoke (after pushing a release tag)

Recommended wrapper:

```bash
export UL_LAUNCH_EVIDENCE_DIR="docs/_generated/launch/production/2026-04-21-v0.1.0-<sha>"
mkdir -p "$UL_LAUNCH_EVIDENCE_DIR"/{audits,smoke,manual}

source ~/.nvm/nvm.sh && nvm use
ULTRALIGHT_TOKEN=... node scripts/smoke/run-release-smoke.mjs \
  --target production \
  --url https://ultralight-api.rgn4jz429m.workers.dev \
  --supabase-url https://uavjzycsltdnwblwutmb.supabase.co \
  --exercise-chat
```

### Automated checks

Run the auth redirect smoke:

```bash
./scripts/smoke/auth-redirect-smoke.sh \
  --url https://ultralight-api.rgn4jz429m.workers.dev \
  --supabase-url https://uavjzycsltdnwblwutmb.supabase.co
```

Run the broader API smoke with a production bearer token:

```bash
ULTRALIGHT_TOKEN=... ./scripts/smoke-test.sh \
  --url https://ultralight-api.rgn4jz429m.workers.dev \
  --exercise-chat
```

For chat capture rollout candidates, run the capture-specific smoke after the
production migration has been pushed and the production Worker has
`ANALYTICS_PEPPER_V1` plus `CHAT_CAPTURE_ENABLED=true` configured:

```bash
ULTRALIGHT_TOKEN=... \
SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/smoke/chat-capture-smoke.mjs \
  --target production \
  --exercise-orchestrate \
  --write-json "$UL_LAUNCH_EVIDENCE_DIR/smoke/chat-capture.json"
```

If a future owned public production domain drifts away from the Worker
deployment, pass it explicitly with `--url` and compare it against the
Workers.dev origin before promoting it as canonical.

Run the same CORS sanity check against production before announcing the release:

```bash
curl -i -X OPTIONS https://ultralight-api.rgn4jz429m.workers.dev/http/test/ping \
  -H 'Origin: https://ultralight-api.rgn4jz429m.workers.dev' \
  -H 'Access-Control-Request-Method: POST'

curl -i -X OPTIONS https://ultralight-api.rgn4jz429m.workers.dev/http/test/ping \
  -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: POST'
```

### Manual desktop checks

Use the freshly published installer from the GitHub Release.

1. Install or update to the tagged desktop build.
2. Launch the app and complete Google sign-in.
3. Send one short prompt in a new chat and confirm the response streams.
4. Start a new session and confirm the app still behaves normally.
5. Sign out and confirm the auth screen returns.
6. Optionally verify `Use another account` if auth-session behavior changed in
   the release.
7. Confirm any copied MCP/API URL is a bare URL without `?token=...`.
8. Confirm a newly generated shared markdown link uses
   `/share/p/...#share_token=...` and still opens successfully after the
   bootstrap redirect.
9. If alias retirement shipped in this release, run one manual removable-alias
   probe and confirm the API returns a clear canonical replacement error.

### Optional updater smoke

Run this only when you have a previously tagged production build installed.

1. Install the previous signed desktop release.
2. Publish the new signed tag and wait for `latest.json` to land on the GitHub
   Release.
3. Relaunch the installed desktop app and wait for the update toast to appear.
4. Confirm the toast names the new version and offers `Update & relaunch`.
5. Click the update action and confirm the app restarts into the newer version.

After production smoke, update `release-packet.md` with:

- the `Production Launch Gate` URL
- the production smoke summary result
- the manual desktop and updater outcomes
- any accepted launch exceptions that still apply to the candidate

## Scope Notes

- These smoke checks are intentionally short. They exist to catch launch-killer
  auth, routing, and first-chat failures quickly.
- The wrapper script only automates the command-line portion of release smoke.
  Manual desktop verification still needs to be recorded separately in the
  evidence directory.
- The current desktop auth smoke is split between a scriptable backend redirect
  check and a short manual desktop UI pass. Full desktop E2E automation is a
  later improvement, not a launch requirement.
- Signing out revokes the current server-side refresh/session path, but a raw
  access-token JWT that was copied elsewhere can still remain valid until its
  natural expiry.
