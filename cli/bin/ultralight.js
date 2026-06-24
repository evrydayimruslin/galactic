#!/usr/bin/env node

/**
 * Galactic CLI — npm package entry point
 *
 * The `setup` command runs in pure Node.js (no extra dependencies).
 * Other commands delegate to the full Deno CLI if available.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion() {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const API_URL = process.env.GALACTIC_API_URL || process.env.ULTRALIGHT_API_URL ||
  'https://api.ultralightagent.com';
const DENO_INSTALL_URL = 'https://raw.githubusercontent.com/evrydayimruslin/ultralight/main/cli/mod.ts';
const DENO_BIN_NAME = platform() === 'win32' ? 'deno.exe' : 'deno';

// ─── Color helpers (no dependencies) ─────────────────────────────────
const isTTY = process.stdout.isTTY;
const c = {
  green:  (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:    (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  cyan:   (s) => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
  dim:    (s) => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
  bold:   (s) => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
  yellow: (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
};
const stderr = (line) => console.error(line);

// ─── Config helpers ──────────────────────────────────────────────────
function getConfigDir() {
  return join(homedir(), '.ultralight');
}

function readJSON(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJSON(filePath, data) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

async function findDeno() {
  const candidates = [
    process.env.DENO_BIN,
    process.env.DENO,
    'deno',
    join(homedir(), '.deno', 'bin', DENO_BIN_NAME),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const ok = await new Promise((resolve) => {
      const proc = spawn(candidate, ['--version'], { stdio: 'pipe' });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
    if (ok) return candidate;
  }

  return null;
}

// ─── Plugin content ──────────────────────────────────────────────────

const PLUGIN_JSON = {
  name: 'galactic',
  description: 'Galactic — serverless MCP platform. Discover, build, test, and deploy AI agent tools.',
  version: '1.0.0',
  author: { name: 'Galactic', url: 'https://api.ultralightagent.com' },
  homepage: 'https://api.ultralightagent.com',
  license: 'MIT',
  keywords: ['galactic', 'mcp', 'serverless', 'ai', 'tools', 'agent'],
};

const SKILL_FRONTMATTER = `---
name: galactic-platform
description: >
  Galactic MCP platform guidance. Use when the user works with Galactic tools
  (gx.call, gx.discover, gx.upload, gx.download, gx.test, gx.set, gx.memory,
  gx.permissions, gx.logs, gx.rate), builds serverless MCP apps, deploys TypeScript
  functions, manages app permissions, or mentions "galactic". Provides tool curation
  workflow, building guide with SDK globals, and agent best practices.
---

`;

const COMMANDS = {
  'discover.md': `---
description: Search and explore Galactic apps across desk, library, and app store
argument-hint: [query or scope]
---

# Discover Galactic Apps

Search and explore apps using the Galactic platform.

1. Parse the user's intent from: $ARGUMENTS
2. Determine the right scope:
   - No arguments or "desk" → \`gx.discover({ scope: "desk" })\` — show recent apps
   - An app ID or URL → \`gx.discover({ scope: "inspect", app_id: "<id>" })\` — deep introspection
   - "library" or "my apps" → \`gx.discover({ scope: "library" })\` — owned + saved apps
   - A search query → \`gx.discover({ scope: "appstore", query: "<query>" })\` — search all published apps
   - A task description → \`gx.discover({ scope: "appstore", query: "<query>", task: "<task>" })\` — context-aware search with inline content
3. Call gx.discover with the appropriate parameters
4. Present results clearly: app names, descriptions, function counts, and capabilities
5. For inspect results, summarize function schemas, storage architecture, and permissions
6. Suggest next steps: call a function with /call, save to library, or build something new
`,

  'call.md': `---
description: Execute any Galactic app function through the platform connection
argument-hint: <app_id> <function_name> [args as JSON]
---

# Call Galactic App Function

Execute a function on any Galactic app through the single platform connection.

1. Parse from: $ARGUMENTS
   - First argument: app_id (required)
   - Second argument: function_name (required)
   - Remaining: JSON args object (optional)
2. If args provided as a JSON string, parse it into an object
3. Call \`gx.call({ app_id, function_name, args })\`
4. On first call per app, the response includes full inspect context — summarize the app's capabilities briefly
5. Present the function result clearly to the user
6. If error occurs, read the message carefully and suggest specific fixes
7. Suggest follow-up actions based on the result
`,

  'upload.md': `---
description: Deploy a TypeScript app or publish a markdown page to Galactic
argument-hint: [name or app_id] [description]
---

# Upload to Galactic

Deploy an app or publish content to the Galactic platform.

1. Parse from: $ARGUMENTS — look for app name, app_id (for new version), or description
2. Look for source files in the current project:
   - Read index.ts (or src/*.ts) for the app code
   - Read manifest.json for function definitions
   - Read .ultralightrc.json for app config (app_id for updates)
3. Prepare the upload payload with files array
4. For new apps (no app_id): \`gx.upload({ files, name, description, visibility: "private" })\`
5. For updates (with app_id): \`gx.upload({ files, app_id })\` — creates new version (NOT auto-live)
6. For markdown pages: \`gx.upload({ type: "page", content, slug, title })\`
7. After upload, confirm: name, function count, version, MCP endpoint
8. Suggest next steps: activate version with /set, grant permissions, record in memory
`,

  'download.md': `---
description: Download app source code or scaffold a new Galactic app
argument-hint: [app_id] or [new app name and description]
---

# Download from Galactic

Download source code or scaffold a new app.

1. Parse from: $ARGUMENTS
2. If an app_id or slug is provided:
   - Call \`gx.download({ app_id })\` to get the source code
   - Write the received files to the current directory
3. If no app_id (scaffold mode):
   - Parse name, description, and any function specs from arguments
   - Call \`gx.download({ name, description, functions, storage })\`
   - Write the scaffolded files to a new directory
4. Explain the file structure: index.ts (code), manifest.json (schemas), .ultralightrc.json (config)
5. Suggest next steps: implement functions, test with /test, deploy with /upload
`,

  'test.md': `---
description: Test and lint Galactic app code in sandbox without deploying
argument-hint: [function_name] [test args as JSON]
---

# Test Galactic App

Test code in the Galactic sandbox without deploying.

1. Read source files from the current project (index.ts, manifest.json)
2. Parse from: $ARGUMENTS — optional function_name and test args JSON
3. Prepare the files array from the source code
4. If "lint" or "lint_only" in arguments: \`gx.test({ files, lint_only: true })\`
5. Otherwise: \`gx.test({ files, function_name, test_args })\`
6. Present results clearly:
   - Success/failure status and duration
   - Exported function list
   - Lint warnings or errors (if any)
   - Function return value (if executed)
7. If errors, analyze the error message and suggest specific code fixes
8. If all passes, suggest deploying with /upload
`,

  'set.md': `---
description: Configure Galactic app settings (version, visibility, pricing, rate limits)
argument-hint: <app_id> [setting=value ...]
---

# Configure Galactic App

Batch-configure app settings. Only provided fields are updated.

1. Parse from: $ARGUMENTS — app_id (required) and setting key=value pairs
2. Supported settings:
   - version=X.Y.Z — set which version is live
   - visibility=private|unlisted|published — control discoverability
   - download_access=owner|public — who can download source
   - calls_per_minute=N — rate limit per minute
   - calls_per_day=N — rate limit per day
   - default_price_credits=N — price per call in credits (✦)
3. Build the settings object from parsed values
4. Call \`gx.set({ app_id, ...settings })\`
5. Confirm what was changed and the current state
`,

  'memory.md': `---
description: Read or write to your persistent Galactic memory (markdown notes and KV store)
argument-hint: [read | write <content> | recall <key> [value] | query [prefix]]
---

# Galactic Memory

Access persistent cross-session storage with two layers: memory.md (free-form notes) and KV store (structured data).

1. Parse from: $ARGUMENTS
2. Determine the action:
   - "read" or no args → \`gx.memory({ action: "read" })\` — show memory.md
   - "write <content>" → \`gx.memory({ action: "write", content, append: true })\` — append to memory.md
   - "recall <key>" → \`gx.memory({ action: "recall", key })\` — get a KV value
   - "recall <key> <value>" → \`gx.memory({ action: "recall", key, value })\` — set a KV value
   - "query" or "query <prefix>" → \`gx.memory({ action: "query", prefix })\` — list KV keys
3. Call gx.memory with the appropriate parameters
4. Present results clearly
5. For write operations, confirm what was stored
`,

  'permissions.md': `---
description: Manage access control for Galactic apps (grant, revoke, list, export)
argument-hint: <app_id> <grant|revoke|list|export> [email] [options]
---

# Galactic Permissions

Manage app access control with granular constraints.

1. Parse from: $ARGUMENTS — app_id, action, and optional parameters
2. Determine the action:
   - "grant <email>" → \`gx.permissions({ app_id, action: "grant", email })\`
   - "grant <email> <functions>" → grant with function restrictions
   - "revoke <email>" → \`gx.permissions({ app_id, action: "revoke", email })\`
   - "list" → \`gx.permissions({ app_id, action: "list" })\`
   - "export" → \`gx.permissions({ app_id, action: "export" })\`
3. For grants, parse optional constraints: IP whitelist, time windows, budget limits, expiry
4. Call gx.permissions with the appropriate parameters
5. Present the current permission state clearly
6. For export, format as requested (JSON or CSV)
`,

  'logs.md': `---
description: View call logs and health events for Galactic apps
argument-hint: [app_id] [--health] [--since <date>]
---

# Galactic Logs

View call logs and health events for your apps.

1. Parse from: $ARGUMENTS — optional app_id and filter flags
2. Determine the mode:
   - Default: call logs → \`gx.logs({ app_id })\`
   - "--health" or "health": health events → \`gx.logs({ app_id, health: true })\`
   - "--since <date>": filter by time → \`gx.logs({ app_id, since: "<ISO date>" })\`
3. Call gx.logs with the appropriate parameters
4. Present logs in a readable format with timestamps, functions called, and status
5. Highlight any errors or anomalies
6. For health events, show status (detected/acknowledged/resolved) and suggest actions
`,

  'rate.md': `---
description: Rate Galactic apps (save to library) or report platform issues
argument-hint: <app_id> [like | dislike | none]
---

# Rate Galactic App

Rate apps to manage your library, or report platform shortcomings.

1. Parse from: $ARGUMENTS — app_id and rating
2. Determine the action:
   - "like" → \`gx.rate({ app_id, rating: "like" })\` — save to library
   - "dislike" → \`gx.rate({ app_id, rating: "dislike" })\` — hide from appstore
   - "none" → \`gx.rate({ app_id, rating: "none" })\` — remove rating
3. Call gx.rate with the appropriate parameters
4. Confirm the action taken
`,
};

// ─── Plugin registration ─────────────────────────────────────────────

function getSkillsContent() {
  // Try reading from bundled skills.md first
  const candidates = [
    join(__dirname, '..', '..', 'skills.md'),
    join(__dirname, '..', 'skills.md'),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf-8');
    } catch {
      // continue
    }
  }
  return null;
}

function registerPlugin(token, apiUrl) {
  const home = homedir();
  const marketplaceBase = join(home, '.claude', 'plugins', 'marketplaces',
    'claude-plugins-official');
  const marketplaceDir = join(marketplaceBase, 'external_plugins');

  if (!existsSync(marketplaceDir)) {
    console.log(c.yellow('⚠ Claude Code plugin marketplace not found. Skipping plugin registration.'));
    console.log(c.dim('  MCP config in ~/.claude.json is still active — tools will work after restart.'));
    return false;
  }

  const pluginBase = join(marketplaceDir, 'galactic');

  try {
    // Create directory structure
    mkdirSync(join(pluginBase, '.claude-plugin'), { recursive: true });
    mkdirSync(join(pluginBase, 'commands'), { recursive: true });
    mkdirSync(join(pluginBase, 'skills', 'galactic-platform'), { recursive: true });

    // 1. Write plugin.json
    writeJSON(join(pluginBase, '.claude-plugin', 'plugin.json'), PLUGIN_JSON);

    // 2. Write .mcp.json (flat format — standard for external plugins).
    // stdio entry → launches the local bridge; token comes from ~/.ultralight.
    const mcpConfig = {
      galactic: {
        command: 'npx',
        args: ['-y', `galacticconnection@${getVersion()}`, 'mcp'],
      },
    };
    writeJSON(join(pluginBase, '.mcp.json'), mcpConfig);

    // 3. Write SKILL.md
    const skillsBody = getSkillsContent();
    if (skillsBody) {
      writeFileSync(
        join(pluginBase, 'skills', 'galactic-platform', 'SKILL.md'),
        SKILL_FRONTMATTER + skillsBody
      );
    } else {
      console.log(c.yellow('⚠ Skills.md source not found. Skipping skill registration.'));
    }

    // 4. Write 10 command files
    for (const [filename, content] of Object.entries(COMMANDS)) {
      writeFileSync(join(pluginBase, 'commands', filename), content);
    }

    // 5. Register in marketplace.json so Claude Code discovers the plugin
    const manifestPath = join(marketplaceBase, '.claude-plugin', 'marketplace.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = readJSON(manifestPath);
        if (manifest && Array.isArray(manifest.plugins)) {
          const exists = manifest.plugins.some((p) => p.name === 'galactic');
          if (!exists) {
            manifest.plugins.push({
              name: 'galactic',
              description: 'Galactic — serverless MCP platform. Discover, build, test, and deploy AI agent tools instantly.',
              category: 'development',
              source: './external_plugins/galactic',
              homepage: 'https://api.ultralightagent.com',
            });
            writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
          }
        }
      } catch {
        // Non-critical — plugin files are still written
      }
    }

    console.log(c.green('✓ Claude Code plugin registered'));
    console.log(c.dim(`  Plugin:   ${pluginBase}`));
    console.log(c.dim('  Commands: /discover, /call, /upload, /download, /test, /set, /memory, /permissions, /logs, /rate'));
    if (skillsBody) {
      console.log(c.dim('  Skill:    galactic-platform (auto-activates for Galactic tasks)'));
    }

    return true;
  } catch (err) {
    console.log(c.yellow(`⚠ Plugin registration failed: ${err.message}`));
    console.log(c.dim('  MCP config in ~/.claude.json is still active — tools will work after restart.'));
    return false;
  }
}

// ─── setup command ───────────────────────────────────────────────────
async function runSetup(args) {
  // Parse --token / -t
  let token = null;
  let showHelp = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { showHelp = true; break; }
    if (arg === '--token' || arg === '-t') { token = args[i + 1]; i++; }
    else if (arg.startsWith('--token=')) { token = arg.slice(8); }
  }

  if (showHelp) {
    console.log(`
${c.bold('galactic setup')}

Set up Galactic: authenticate and configure your agent's MCP connection.

${c.dim('OPTIONS')}
  --token, -t <token>   Your API token (starts with ul_)

${c.dim('WHAT IT DOES')}
  1. Saves your token to ~/.ultralight/config.json
  2. Verifies the token against the Galactic API
  3. Detects MCP client config files (Claude Code, Claude Desktop, Cursor)
  4. Writes the Galactic MCP server entry to each detected config
  5. Registers Galactic as a Claude Code plugin (skills + slash commands)
  6. Outputs connection info so your agent can use tools immediately

${c.dim('EXAMPLES')}
  npx galacticconnection setup --token ul_abc123...
  galacticconnection setup -t ul_abc123...
`);
    return;
  }

  if (!token) {
    console.log(`
${c.bold('Galactic Setup')}

To set up, you need an API token.

${c.dim('Get a token:')}
  1. Go to ${c.cyan(API_URL)}
  2. Sign in with Google
  3. Go to Settings > API Tokens
  4. Create a new token

${c.dim('Then run:')}
  ${c.cyan('npx galacticconnection setup --token <your-token>')}
`);
    return;
  }

  // Validate token format
  if (!token.startsWith('ul_')) {
    console.log(c.red('x Invalid token format. Galactic API tokens start with ul_'));
    process.exit(1);
  }

  // Step 1: Save token to config
  const configDir = getConfigDir();
  const configPath = join(configDir, 'config.json');
  const config = readJSON(configPath) || {};
  config.api_url = API_URL;
  config.auth = { token, is_api_token: true };
  if (!config.defaults) config.defaults = { visibility: 'private', auto_docs: true };
  writeJSON(configPath, config);
  console.log(c.green('✓ Token saved to ~/.ultralight/config.json'));

  // Step 2: Verify token
  let userInfo = null;
  try {
    const res = await fetch(`${API_URL}/api/user`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(res.status === 401 ? 'Invalid or expired token' : `HTTP ${res.status}: ${body}`);
    }
    userInfo = await res.json();
    console.log(c.green(`✓ Authenticated as ${c.cyan(userInfo.email || userInfo.display_name || 'user')}`));
  } catch (err) {
    console.log(c.red(`x Token validation failed: ${err.message}`));
    console.log(c.dim('  Check that your token is correct and try again.'));
    // Clear the bad token
    delete config.auth;
    writeJSON(configPath, config);
    process.exit(1);
  }

  // Step 3: Detect and write MCP client configs
  const home = homedir();
  const appData = process.env.APPDATA || '';
  const mcpEndpoint = `${API_URL}/mcp/platform`;

  // Write a STDIO entry: clients launch the local bridge (`galacticconnection mcp`),
  // which proxies to the remote platform MCP. stdio works in every desktop MCP
  // client (unlike the bare HTTP-POST endpoint), and the token is NOT embedded
  // here — the bridge reads it from ~/.ultralight/config.json (written above).
  const mcpEntry = {
    command: 'npx',
    args: ['-y', `galacticconnection@${getVersion()}`, 'mcp'],
  };

  const configTargets = [
    { path: join(home, '.claude.json'), name: 'Claude Code', key: 'mcpServers' },
    { path: join(home, '.claude', 'mcp.json'), name: 'Claude Code (mcp.json)', key: 'mcpServers' },
    { path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), name: 'Claude Desktop (macOS)', key: 'mcpServers' },
    { path: join(home, '.config', 'Claude', 'claude_desktop_config.json'), name: 'Claude Desktop (Linux)', key: 'mcpServers' },
    ...(appData ? [{ path: join(appData, 'Claude', 'claude_desktop_config.json'), name: 'Claude Desktop (Windows)', key: 'mcpServers' }] : []),
    { path: join(process.cwd(), '.cursor', 'mcp.json'), name: 'Cursor (project)', key: 'mcpServers' },
  ];

  let configsWritten = 0;

  for (const target of configTargets) {
    if (!existsSync(target.path)) continue;
    try {
      const existing = readJSON(target.path) || {};
      const servers = existing[target.key] || {};
      servers['ultralight'] = mcpEntry;
      existing[target.key] = servers;
      writeFileSync(target.path, JSON.stringify(existing, null, 2));
      console.log(c.green(`✓ MCP config written to ${c.dim(target.path)} (${target.name})`));
      configsWritten++;
    } catch {
      // File exists but can't be read/written, skip
    }
  }

  if (configsWritten === 0) {
    console.log('');
    console.log(c.yellow('⚠ No MCP client config files detected.'));
    console.log(c.dim('  Add this to your MCP client config manually:'));
    console.log('');
    console.log(c.dim(JSON.stringify({ mcpServers: { ultralight: mcpEntry } }, null, 2)));
    console.log('');
    console.log(c.dim('  Common config file locations:'));
    console.log(c.dim('    Claude Code:    ~/.claude.json'));
    console.log(c.dim('    Claude Desktop: ~/.config/Claude/claude_desktop_config.json'));
    console.log(c.dim('    Cursor:         .cursor/mcp.json'));
  }

  // Step 4: Register Claude Code plugin (skills + slash commands + marketplace manifest)
  const pluginRegistered = registerPlugin(token, API_URL);

  // Step 5: Output results + agent bridge
  console.log('');
  console.log(c.green(c.bold('✓ Galactic is ready!')));
  console.log('');
  if (userInfo) {
    console.log(`  ${c.dim('Account:')}  ${userInfo.email || 'authenticated'}`);
    console.log(`  ${c.dim('Tier:')}     ${userInfo.tier || 'free'}`);
  }
  if (pluginRegistered) {
    console.log(`  ${c.dim('Plugin:')}   Registered (Skills + 10 slash commands)`);
  }
  console.log(`  ${c.dim('Restart:')}  Restart Claude Code / Claude Desktop for native MCP tools`);
  console.log('');

  // Agent bridge — structured output so the running agent can use tools
  // immediately. The token is deliberately NOT printed (it would land in
  // terminal scrollback / captured CI logs); the curl examples read it from
  // ~/.ultralight/config.json at call time via Node (guaranteed available).
  const tokenFromConfig =
    '$(node -e "process.stdout.write(JSON.parse(require(\'fs\').readFileSync(require(\'os\').homedir()+\'/.ultralight/config.json\',\'utf8\')).auth.token)")';
  console.log(`--- ULTRALIGHT AGENT BRIDGE ---
MCP_ENDPOINT=${mcpEndpoint}
Your API token is saved in ~/.ultralight/config.json (not printed here).

To call Galactic tools in this session, POST JSON-RPC 2.0 to the endpoint above.

List available tools:
curl -s -X POST "${mcpEndpoint}" -H "Authorization: Bearer ${tokenFromConfig}" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

Call a tool (example — discover apps):
curl -s -X POST "${mcpEndpoint}" -H "Authorization: Bearer ${tokenFromConfig}" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"gx.discover","arguments":{"scope":"appstore","query":"hello"}}}'

MCP is configured for future sessions. Tools activate natively on next agent restart.
--- END ULTRALIGHT AGENT BRIDGE ---`);
}

// ─── main router ─────────────────────────────────────────────────────
async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  // Setup runs in pure Node.js — no Deno needed
  if (command === 'setup') {
    await runSetup(args);
    return;
  }

  // MCP bridge runs in pure Node.js — no Deno needed. This is the stdio MCP
  // server that desktop agents launch; it proxies to the remote platform MCP.
  if (command === 'mcp' || command === 'serve') {
    const { runMcpBridge } = await import('../lib/mcp-bridge.mjs');
    await runMcpBridge();
    return;
  }

  // Version / help
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(getVersion());
    return;
  }

  if (!command || command === '--help' || command === '-h') {
    console.log(`
${c.bold('Galactic')} ${c.dim('v' + getVersion())}

${c.dim('QUICK START')} ${c.dim('(pure Node — no extra runtime)')}
  galacticconnection setup --token <token>   Authenticate + wire up your MCP clients
  galacticconnection mcp                      Run the local stdio MCP bridge (clients launch this)

${c.dim('FULL CLI')}
  Other commands (scaffold, upload, test, etc.) require the Deno runtime.
  Install Deno: ${c.cyan('curl -fsSL https://deno.land/install.sh | sh')}

  galacticconnection scaffold     Generate a new app skeleton
  galacticconnection upload       Deploy an app
  galacticconnection test         Test functions without deploying
  galacticconnection discover     Search the App Store
  galacticconnection apps         Manage your apps
  galacticconnection --help       Show all commands (requires Deno)
`);
    return;
  }

  // All other commands delegate to Deno CLI
  const denoBin = await findDeno();

  if (!denoBin) {
    stderr(`
${c.red('Deno is required for this command.')}

The ${c.cyan('setup')} command works without Deno, but ${c.cyan(command)} needs the full CLI.

Install Deno:
  ${c.cyan('curl -fsSL https://deno.land/install.sh | sh')}

Or visit: ${c.cyan('https://deno.land/#installation')}
`);
    process.exit(1);
  }

  // Find CLI source — local dev or error (no remote fetch)
  const localPath = join(__dirname, '..', 'mod.ts');
  if (!existsSync(localPath)) {
    stderr(`
${c.red('Full CLI not found.')}

The ${c.cyan('setup')} command works standalone, but ${c.cyan(command)} needs the full Deno CLI.

To use the full CLI, clone the repo or install globally:
  ${c.cyan(`deno install --allow-all -n galactic ${DENO_INSTALL_URL}`)}
`);
    process.exit(1);
  }

  const proc = spawn(denoBin, [
    'run',
    '--allow-net',
    '--allow-read',
    '--allow-write',
    '--allow-env',
    localPath,
    command,
    ...args,
  ], {
    stdio: 'inherit',
    env: process.env,
  });

  proc.on('close', (code) => process.exit(code || 0));
  proc.on('error', (err) => {
    stderr(`Failed to start CLI: ${err.message}`);
    process.exit(1);
  });
}

main();
