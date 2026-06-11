# ultralightpro — Ultralight CLI

Connect any MCP-capable agent (Claude Code, Claude Desktop, Cursor, Codex, …) to [Ultralight](https://ultralight.dev), and build, deploy, and manage Ultralight Agents from your shell.

Ultralight is one remote MCP server that gives your agent a library of Agents (apps) it can discover, call, and deploy — with unified auth and per-call payments.

## Quick start

1. Create an API key in the Ultralight web app (the **Add to agent** button mints one for you).
2. Run setup:

```bash
npx ultralightpro setup --token ul_your_api_key
```

`setup` validates the token, saves it to `~/.ultralight/config.json`, and writes the Ultralight MCP server into every agent config it finds — Claude Code (`.claude.json` / `.claude/mcp.json`), Claude Desktop, and Cursor — plus registers the Claude Code plugin. It runs in pure Node.js; no other dependencies.

Prefer manual configuration? Add the remote MCP server yourself:

```json
{
  "mcpServers": {
    "ultralight": {
      "url": "https://ultralight-api.rgn4jz429m.workers.dev/mcp/platform",
      "headers": { "Authorization": "Bearer ul_your_api_key" }
    }
  }
}
```

Once connected, your agent's `initialize` response carries the full platform guide; it can list its tools (`ul.discover`, `ul.call`, `ul.upload`, …) and start working immediately.

## Developer commands

Most commands wrap the platform's `ul.*` MCP tools, so the shell and your agent share one backend. Build/deploy commands run on [Deno](https://deno.land); `setup` and `login` work without it.

```bash
# Setup
ultralight setup --token ul_xxx       # Authenticate + write agent MCP configs
ultralight login --token ul_xxx       # Authenticate only
ultralight whoami                     # Show current user

# Build & deploy
ultralight scaffold my-app            # Generate a structured app skeleton
ultralight test . -f hello            # Test functions in the platform sandbox
ultralight lint . --strict            # Validate platform conventions
ultralight upload .                   # Deploy (new app or version)
ultralight download my-app            # Fetch deployed source

# Manage
ultralight apps list                  # Your apps
ultralight set pricing my-app --default 5   # Price per call, in credits (✦)
ultralight permissions grant my-app user@example.com
ultralight draft publish my-app

# Use
ultralight discover "weather API"     # Search the App Store
ultralight run my-app hello '{"n":1}' # Call a deployed function
ultralight logs my-app --limit 20
ultralight health
```

Run `ultralight help` for the full reference.

## CLI vs MCP connection

These are two doors into the same platform:

- **MCP connection** — what your *agent* uses: the remote server URL plus a bearer key. `setup` writes this for you; the website's "Add to agent" flow produces a paste-into-agent prompt that does the equivalent.
- **CLI commands** — what *you* use in a shell to build, deploy, and administer Agents.

Both authenticate with the same `ul_` API keys and talk to the same endpoint.

## Configuration

- Credentials and defaults live in `~/.ultralight/config.json`.
- `ultralight config` shows current settings.
- API keys are created in the Ultralight web app and can be scoped (per-app, per-function) and expiring; treat them as secrets.

## Documentation

- Platform guide (the same skills doc your agent reads over MCP) ships in this package as `skills.md`, and is served at `GET /api/skills`.
- Full docs: https://ultralight.dev/docs/cli
