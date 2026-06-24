# galacticconnection — Galactic local MCP bridge + CLI

Connect any computer-access agent (Claude Code, Claude Desktop, Cursor, …) to [Galactic](https://ultralightagent.com), and build, deploy, and manage Galactic Agents from your shell.

Galactic is one platform MCP server that gives your agent a library of Agents (apps) it can discover, call, and deploy — with unified auth and per-call payments. This package installs a **local stdio MCP bridge** that proxies to that platform, plus local **filesystem tools** so the agent can work with source on your machine.

## Quick start

1. Create an API key in the Galactic web app (the **Add to agent** button mints one for you).
2. Run setup:

```bash
npx galacticconnection setup --token ul_your_api_key
```

`setup` validates the token, saves it to `~/.ultralight/config.json`, and writes a **stdio** MCP server entry into every agent config it finds — Claude Code (`.claude.json` / `.claude/mcp.json`), Claude Desktop, and Cursor — plus registers the Claude Code plugin. It runs in pure Node.js.

Prefer manual configuration? Add the bridge yourself:

```json
{
  "mcpServers": {
    "ultralight": {
      "command": "npx",
      "args": ["-y", "galacticconnection", "mcp"]
    }
  }
}
```

The bridge reads your token from `~/.ultralight/config.json` (so it is **not** duplicated into client config files). Set `ULTRALIGHT_TOKEN` to override.

## How the MCP connection works

The Galactic platform MCP runs server-side; there's nothing to "run locally." The bridge is a thin **stdio ↔ HTTP proxy**:

- On `tools/list`, it fetches the platform's catalog and re-advertises it **verbatim** (so it never drifts from the platform), then appends the `local.*` filesystem tools.
- On `tools/call`, platform tools (`ul.*`, per-app functions) are forwarded to `https://api.ultralightagent.com/mcp/platform` with your `ul_` Bearer token; `local.*` tools run on your machine.

stdio works in every desktop MCP client, including ones that can't speak the platform's bare HTTP-POST endpoint.

### Local filesystem tools

Scoped to the working directory the agent launches the bridge in (override with `ULTRALIGHT_FS_ROOT`); paths that escape the root are rejected.

- `local.read_file` / `local.write_file` — read source before `ul.upload`; write source returned by `ul.download`.
- `local.list_dir` / `local.make_dir` — inspect and scaffold.

## Developer commands

Most commands wrap the platform's `ul.*` MCP tools, so the shell and your agent share one backend. `setup` and the `mcp` bridge run in pure Node.js; build/deploy commands run on [Deno](https://deno.land).

```bash
# Setup & bridge (pure Node — no Deno needed)
galacticconnection setup --token ul_xxx     # Authenticate + write agent MCP configs
galacticconnection mcp                       # Run the stdio MCP bridge (clients launch this)

# Build, deploy, manage & use (require Deno)
galacticconnection login --token ul_xxx      # Authenticate only
galacticconnection whoami                    # Show current user
galacticconnection scaffold my-app           # Generate a structured app skeleton
galacticconnection test . -f hello           # Test functions in the platform sandbox
galacticconnection upload .                  # Deploy (new app or version)
galacticconnection download my-app           # Fetch deployed source
galacticconnection apps list
galacticconnection set pricing my-app --default 5   # Price per call, in credits (✦)
galacticconnection discover "weather API"    # Search the App Store
galacticconnection run my-app hello '{"n":1}'
```

Run `galacticconnection help` for the full reference.

## Configuration

- Credentials and defaults live in `~/.ultralight/config.json`.
- API keys are created in the Galactic web app and can be scoped and expiring; treat them as secrets.

## Documentation

- Platform guide (the same skills doc your agent reads over MCP) ships in this package as `skills.md`, and is served at `GET /api/skills`.
- Full docs: https://ultralightagent.com/docs/cli
