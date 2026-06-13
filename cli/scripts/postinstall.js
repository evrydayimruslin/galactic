#!/usr/bin/env node

/**
 * Post-install script for ultralightagent.
 * Simple success message — setup + the MCP bridge run in pure Node.js.
 */

console.log(`
✓ ultralightagent installed.

Connect your agent (writes Claude Code / Claude Desktop / Cursor MCP configs):
  ultralightagent setup --token <your-api-key>

This wires up a local stdio MCP bridge (ultralightagent mcp) that proxies to the
Ultralight platform and adds local filesystem tools. Create an API key from the
Ultralight web app — "Add to agent" mints one and copies a ready-to-paste prompt
that runs this same setup for you.

  ultralightagent --help                   Show all commands
`);
