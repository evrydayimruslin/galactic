#!/usr/bin/env node

/**
 * Post-install script for ultralightpro
 * Simple success message — setup command runs in pure Node.js, no extra deps needed.
 */

console.log(`
✓ Ultralight CLI installed.

Connect your agent (writes Claude Code / Claude Desktop / Cursor MCP configs):
  ultralight setup --token <your-api-key>

Create an API key from the Ultralight web app — "Add to agent" mints one and
copies a ready-to-paste prompt that runs this same setup for you.

  ultralight --help                        Show all commands
`);
