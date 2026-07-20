# Galactic Compute v1 viability gate

This package targets Cloudflare Containers through `@cloudflare/sandbox`
`0.12.3`, using the RPC transport. `developer-v1` is one immutable, disposable
Linux image; public callers select semantic tools, never image names or Docker
instructions.

The `developer-v1` image catalog is the complete v1 tool authority. Claimed
runs must carry an empty `toolpacks` array; syntax-only pack metadata is
rejected until a separately reviewed signed-pack protocol exists.

## Reproducible checks

1. Use Node 22 or newer.
2. Start a Docker-compatible engine.
3. Run `npm ci && npm run verify`.
4. Run `npm run image:build && npm run image:smoke`.
5. Run `npm run deploy:staging:dry-run`.
6. After staging resources exist, deploy and exercise one sync and one async
   run covering public HTTP(S), Playwright Chromium, R2 input/output, timeout,
   cancellation, forced process failure, private/control-plane destination
   denial, and raw non-HTTP transport denial.

The Worker bundle and all bindings can be checked without rebuilding the
container with:

```sh
wrangler deploy --config wrangler.staging.toml --dry-run --containers-rollout=none
```

That shortcut is not the launch gate. A real image build and staging run are
required because Docker package availability, Chromium libraries, Cloudflare's
runtime CA, egress interception, cold-start time, and teardown behavior cannot
be proven by TypeScript tests.

## Pass criteria

- The image digest is recorded and the build uses the pinned Sandbox base.
- The SBOM gate retains the full Grype result and rejects every CRITICAL plus
  every fixable HIGH finding before any image push or Worker deploy.
- Compute workflows pin third-party Actions by full commit, and Cloudflare
  deploy credentials exist only on the exact resource/deploy steps that need
  them—not on dependency installation, image build, smoke, or scanning.
- `gx`, Chromium/Playwright, document/OCR/media/data tools, and the pinned
  coding-agent CLIs pass the offline image smoke.
- The deployed body records live `/workspace` capacity. `developer-v1` rejects
  policy budgets above 1 GiB and rejects each run before R2 staging when its
  declared inputs would leave less than 512 MiB of writable scratch space.
- Direct Container internet is disabled. Public HTTP(S) works only through the
  registered catch-all Worker handler; the pinned SDK's supported simple-glob
  rules reject metadata/private literals and Galactic public control-plane
  hostnames before that handler.
- Redirect-to-private, DNS-rebinding, alternate-DNS, `CONNECT`, raw TCP on
  80/443, SSH, and native database-port probes all fail in staging. Browser WSS
  is supported only if an actual Upgrade/echo probe passes on the pinned
  runtime; otherwise it remains outside the release contract.
- `https://galactic.internal/v1/*` works only through outbound interception and
  the private named service binding.
- No body environment or filesystem contains a human bearer, Agent bearer,
  platform key, Supabase/service-role key, Cloudflare token, or undeclared
  secret. Explicit Agent-configured third-party compute secrets are the only
  raw credentials v1 may deliver.
- Duplicate queue delivery executes a run at most once; terminal finalization
  produces one receipt and one true-up.
- Timeout and cancellation destroy the whole container, not merely the SDK
  command request.
- The measured startup and teardown percentiles fit the reserved wall budget;
  concurrency saturation produces a controlled queued/denied state.

## Current local result

The Worker dry-run bundles successfully with the production Durable Object,
Container, R2, named service binding, and queue configuration. The current
workspace has no running Docker CLI/engine, so the image-build and live
Container portions remain an external staging gate rather than a claimed pass.
