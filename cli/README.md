# galacticconnection — Galactic local MCP bridge + CLI

Connect any computer-access agent (Claude Code, Claude Desktop, Cursor, …) to [Galactic](https://connectgalactic.com), and build, deploy, and manage Galactic Agents from your shell.

Galactic is one platform MCP server that gives your agent a library of Agents (apps) it can discover, call, and deploy — with unified auth and per-call payments. This package installs a **local stdio MCP bridge** that proxies to that platform, plus local **filesystem tools** so the agent can work with source on your machine.

## Quick start

1. Create an API key in the Galactic web app (the **Add to agent** button mints one for you).
2. Run setup:

```bash
npx galacticconnection setup --token gx_your_api_key
```

`setup` validates the token, saves it to `~/.galactic/config.json`, and writes a **stdio** MCP server entry into every agent config it finds — Claude Code (`.claude.json` / `.claude/mcp.json`), Claude Desktop, and Cursor — plus registers the Claude Code plugin. It runs in pure Node.js.

Prefer manual configuration? Add the bridge yourself:

```json
{
  "mcpServers": {
    "galactic": {
      "command": "npx",
      "args": ["-y", "galacticconnection", "mcp"]
    }
  }
}
```

The bridge reads your token from `~/.galactic/config.json` (so it is **not** duplicated into client config files). Set `GALACTIC_TOKEN` to override.

Inside a Galactic Compute body, the same CLI automatically enters a separate,
lease-scoped job mode. The platform supplies `GALACTIC_LEASE_ID`, an optional
`GALACTIC_GATEWAY_URL` (default `https://galactic.internal/v1`), and an optional
`GALACTIC_JOB_TOKEN_FILE` (default `/run/galactic/job-token`). The opaque token
is read from that file for each CLI process; it is never accepted on argv,
written to CLI config, or printed.

## How the MCP connection works

The Galactic platform MCP runs server-side; there's nothing to "run locally." The bridge is a thin **stdio ↔ HTTP proxy**:

- On `tools/list`, it fetches the platform's catalog and re-advertises it **verbatim** (so it never drifts from the platform), then appends the `local.*` filesystem tools.
- On `tools/call`, platform tools (`gx.*`, per-app functions) are forwarded to `https://api.connectgalactic.com/mcp/platform` with your `gx_` Bearer token; `local.*` tools run on your machine.

In compute-job mode, platform MCP traffic goes only to the private lease gateway
at `/mcp/platform`. Direct `/mcp/{app}` routes are disabled; `galactic run` uses
the exactly scoped `gx.call` platform function instead. The gateway remains the
server-authoritative permissions boundary.

stdio works in every desktop MCP client, including ones that can't speak the platform's bare HTTP-POST endpoint.

### Local filesystem tools

Scoped to the working directory the agent launches the bridge in (override with `GALACTIC_FS_ROOT`); paths that escape the root are rejected.

- `local.read_file` / `local.write_file` — read source before `gx.upload`; write source returned by `gx.download`.
- `local.list_dir` / `local.make_dir` — inspect and scaffold.

## Developer commands

Most commands wrap the platform's `gx.*` MCP tools, so the shell and your agent share one backend. `setup` and the `mcp` bridge run in pure Node.js; build/deploy commands run on [Deno](https://deno.land).

```bash
# Setup & bridge (pure Node — no Deno needed)
galacticconnection setup --token gx_xxx     # Authenticate + write agent MCP configs
galacticconnection mcp                       # Run the stdio MCP bridge (clients launch this)

# Build, deploy, manage & use (require Deno)
galacticconnection login --token gx_xxx      # Authenticate only
galacticconnection whoami                    # Show current user
galacticconnection scaffold my-app           # Generate a structured app skeleton
galacticconnection test . -f hello           # Test functions in the platform sandbox
galacticconnection upload .                  # Deploy (new app or version)
galacticconnection download my-app           # Fetch deployed source
galacticconnection apps list
galacticconnection set pricing my-app --default 5   # Price per call, in credits
galacticconnection discover "weather API"    # Search the App Store
galacticconnection run my-app hello '{"n":1}'

# Inside a Galactic Compute job
galacticconnection budget
galacticconnection receipt
galacticconnection artifact push ./report.pdf
galacticconnection artifact pull artifact_123 --output ./input.csv
```

Run `galacticconnection help` for the full reference.

## Configuration

- Credentials and defaults live in `~/.galactic/config.json` (the legacy `~/.ultralight/config.json` is read once and migrated forward).
- Environment overrides: `GALACTIC_TOKEN`, `GALACTIC_API_URL`, `GALACTIC_FS_ROOT` (the older `ULTRALIGHT_*` names are still honored as a fallback).
- API keys are created in the Galactic web app and can be scoped and expiring; treat them as secrets.
- Compute-job variables are a fail-closed mode switch: if any job variable is
  present, `GALACTIC_LEASE_ID` is required, persistent human config is never
  read, and setup/login/logout/config commands are unavailable. A missing or
  invalid job token never falls back to `GALACTIC_TOKEN` or `~/.galactic`.

## Documentation

- Platform guide (the same skills doc your agent reads over MCP) ships in this package as `skills.md`, and is served at `GET /api/skills`.
- Full docs: https://connectgalactic.com/docs/cli
