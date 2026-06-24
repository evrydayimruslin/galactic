#!/usr/bin/env node

/**
 * Post-install script for galacticconnection.
 * Simple success message — setup + the MCP bridge run in pure Node.js.
 */

console.log(`
✓ galacticconnection installed.

Connect your agent (writes Claude Code / Claude Desktop / Cursor MCP configs):
  galacticconnection setup --token <your-api-key>

This wires up a local stdio MCP bridge (galacticconnection mcp) that proxies to the
Galactic platform and adds local filesystem tools. Create an API key from the
Galactic web app — "Add to agent" mints one and copies a ready-to-paste prompt
that runs this same setup for you.

  galacticconnection --help                   Show all commands
`);
