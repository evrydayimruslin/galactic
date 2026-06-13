#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * Ultralight v2.0.0
 * Command-line interface for managing Ultralight apps
 *
 * All platform MCP tools use the `ul.*` namespace.
 * Per-app MCP calls go to POST /mcp/{appId}.
 * User REST API lives at GET/PATCH /api/user.
 *
 * Usage:
 *   ultralight <command> [options]
 *
 * Commands:
 *   setup           Set up Ultralight: authenticate + configure MCP connection
 *   login           Authenticate with Ultralight
 *   logout          Clear stored credentials
 *   whoami          Show current user
 *   scaffold        Generate a structured app skeleton (ul.download scaffold mode)
 *   upload          Upload a new app or update existing (ul.upload)
 *   test            Test functions without deploying (ul.test)
 *   lint            Validate code against conventions (ul.test lint_only mode)
 *   download        Download app source code (ul.download)
 *   apps            App management commands
 *   draft           Draft management commands
 *   docs            Documentation commands
 *   set             App settings (version, visibility, ratelimit, pricing, supabase)
 *   permissions     Permission management (grant, revoke, list, export)
 *   run             Execute a deployed app function
 *   discover        Search the App Store for MCP tools
 *   logs            View MCP call logs (ul.logs)
 *   health          App health monitoring (ul.health)
 *
 * Run `ultralight <command> --help` for more information on a command.
 */

import { parseArgs, getConfig, saveConfig, clearConfig, type Config } from './config.ts';
import { ApiClient } from './api.ts';
import { colors } from './colors.ts';
import { createCliLogger } from './logging.ts';

const VERSION = '2.0.0';
const cliLogger = createCliLogger('CLI');
const writeStderr = (line: string): void => console.error(line);

// Command handlers
const commands: Record<string, (args: string[], client: ApiClient, config: Config) => Promise<void>> = {
  init,
  setup,
  login,
  logout,
  whoami,
  upload,
  download: downloadCmd,
  apps,
  draft,
  docs,
  set: setCmd,
  permissions,
  test: testCmd,
  lint,
  scaffold,
  run,
  discover,
  logs: logsCmd,
  health,
  config: configCmd,
  help,
  version,
};

async function main() {
  const args = Deno.args;

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    await help([], null as unknown as ApiClient, {} as Config);
    return;
  }

  if (args[0] === '--version' || args[0] === '-v') {
    console.log(`ultralight v${VERSION}`);
    return;
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  if (!commands[command]) {
    cliLogger.warn('Unknown command requested', { command });
    writeStderr(colors.red(`Unknown command: ${command}`));
    writeStderr(`Run ${colors.cyan('ultralight help')} for available commands.`);
    Deno.exit(1);
  }

  try {
    const config = await getConfig();
    const client = new ApiClient(config);

    await commands[command](commandArgs, client, config);
  } catch (err) {
    cliLogger.error('Unhandled CLI command failure', {
      command,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    if (err instanceof Error) {
      writeStderr(colors.red(`Error: ${err.message}`));
    } else {
      writeStderr(colors.red('An unexpected error occurred'));
    }
    Deno.exit(1);
  }
}

type ToolArgs = Record<string, unknown>;

async function callPlatformDiscover(
  client: ApiClient,
  scope: 'desk' | 'inspect' | 'library' | 'appstore',
  args: ToolArgs = {},
) {
  return await client.callTool('ul.discover', { scope, ...args });
}

async function callPlatformSet(
  client: ApiClient,
  appId: string,
  updates: ToolArgs,
) {
  return await client.callTool('ul.set', { app_id: appId, ...updates });
}

async function callPlatformPermissions(
  client: ApiClient,
  action: 'grant' | 'revoke' | 'list' | 'export',
  args: ToolArgs,
) {
  return await client.callTool('ul.permissions', { action, ...args });
}

async function callPlatformLint(client: ApiClient, args: ToolArgs) {
  return await client.callTool('ul.test', { ...args, lint_only: true });
}

async function callPlatformScaffold(client: ApiClient, args: ToolArgs) {
  return await client.callTool('ul.download', args);
}

// ============================================
// COMMAND IMPLEMENTATIONS
// ============================================

async function help(_args: string[], _client: ApiClient, _config: Config) {
  console.log(`
${colors.bold('Ultralight CLI')} v${VERSION}

${colors.dim('USAGE')}
  ultralight <command> [options]

${colors.dim('SETUP')}
  ${colors.cyan('setup')}              Set up Ultralight: authenticate + configure MCP connection
  ${colors.cyan('login')}              Authenticate with Ultralight (token only)
  ${colors.cyan('logout')}             Clear stored credentials
  ${colors.cyan('whoami')}             Show current user

${colors.dim('BUILD')}
  ${colors.cyan('scaffold')} <name>    Generate a structured app skeleton (ul.download scaffold mode)
  ${colors.cyan('upload')} [dir]       Upload app or new version (ul.upload)
  ${colors.cyan('test')} [dir]         Test functions in sandbox (ul.test)
  ${colors.cyan('lint')} [dir]         Validate against conventions (ul.test lint_only)
  ${colors.cyan('download')} <app>     Download app source code (ul.download)

${colors.dim('MANAGE')}
  ${colors.cyan('apps')}               App management (list, get, delete)
  ${colors.cyan('set')}                App settings (version, visibility, ratelimit, pricing, supabase)
  ${colors.cyan('permissions')}        Permission management (grant, revoke, list, export)
  ${colors.cyan('draft')}              Draft management (upload, status, publish, discard)
  ${colors.cyan('docs')}               Documentation (generate, get)

${colors.dim('USE')}
  ${colors.cyan('run')} <app> <fn>     Execute a deployed app function
  ${colors.cyan('discover')} <query>   Search the App Store for MCP tools
  ${colors.cyan('logs')} <app>         View MCP call logs (ul.logs)
  ${colors.cyan('health')} [app]       View app health events (ul.health)

${colors.dim('OTHER')}
  ${colors.cyan('init')} [name]        Create a local app project (offline)
  ${colors.cyan('config')}             CLI configuration
  ${colors.cyan('help')}               Show this help message
  ${colors.cyan('version')}            Show version

${colors.dim('BUILD WORKFLOW')}
  1. ${colors.cyan('ultralight scaffold my-app')}        Generate skeleton
  2. Fill in function implementations
  3. ${colors.cyan('ultralight test .')}                  Verify functions work
  4. ${colors.cyan('ultralight lint .')}                  Validate conventions
  5. ${colors.cyan('ultralight upload .')}                Deploy

${colors.dim('EXAMPLES')}
  ultralight scaffold my-app --storage supabase
  ultralight test . --function hello '{"name":"World"}'
  ultralight lint . --strict
  ultralight upload . --name "My App"
  ultralight discover "weather API"
  ultralight run my-app hello '{"name": "World"}'
  ultralight logs my-app --limit 20
  ultralight health
  ultralight set version my-app 2.0.0
  ultralight permissions grant my-app user@email.com

${colors.dim('DOCUMENTATION')}
  https://ultralightagent.com/docs/cli
`);
}

async function version(_args: string[], _client: ApiClient, _config: Config) {
  console.log(`ultralight v${VERSION}`);
}

// ============================================
// INIT COMMAND (offline — local template)
// ============================================

async function init(args: string[], _client: ApiClient, _config: Config) {
  const parsed = parseArgs(args, {
    boolean: ['react', 'help'],
    alias: { r: 'react', h: 'help' },
  });

  if (parsed.help) {
    console.log(`
${colors.bold('ultralight init')} [name]

Create a new Ultralight app project with TypeScript types and starter template.
This is an offline command — use ${colors.cyan('ultralight scaffold')} for server-generated skeletons.

${colors.dim('OPTIONS')}
  --react, -r     Use React template instead of basic TypeScript

${colors.dim('EXAMPLES')}
  ultralight init my-app          # Create basic TypeScript app
  ultralight init my-app --react  # Create React app

${colors.dim('WHAT IT CREATES')}
  my-app/
  ├── index.ts         # Entry point with example functions
  ├── tsconfig.json    # TypeScript config
  ├── package.json     # Dependencies (types only)
  └── README.md        # Quick reference
`);
    return;
  }

  const projectName = parsed._[0] as string || 'ultralight-app';
  const useReact = parsed.react as boolean;

  // Check if directory already exists
  try {
    const stat = await Deno.stat(projectName);
    if (stat.isDirectory) {
      writeStderr(colors.red(`Error: Directory '${projectName}' already exists`));
      Deno.exit(1);
    }
  } catch {
    // Directory doesn't exist, which is good
  }

  console.log(colors.cyan(`Creating ${useReact ? 'React' : 'TypeScript'} app: ${projectName}`));

  // Create directory
  await Deno.mkdir(projectName, { recursive: true });

  // Create files based on template
  if (useReact) {
    await createReactTemplate(projectName);
  } else {
    await createBasicTemplate(projectName);
  }

  console.log(colors.green('\n✓ Project created successfully!\n'));
  console.log(`${colors.dim('Next steps:')}`);
  console.log(`  cd ${projectName}`);
  console.log(`  ${colors.cyan('ultralight test .')}       # verify`);
  console.log(`  ${colors.cyan('ultralight lint .')}       # validate`);
  console.log(`  ${colors.cyan('ultralight upload .')}     # deploy`);
  console.log('');
}

async function createBasicTemplate(dir: string) {
  // index.ts — uses correct single-args-object pattern
  const indexTs = `/// <reference types="@ultralightpro/types" />

/**
 * Hello World function
 * @param args.name - Name to greet
 * @returns Greeting message
 */
export function hello(args: { name?: string }) {
  const name = args.name || 'World';
  return { message: \`Hello, \${name}!\` };
}

/**
 * Example using AI (requires BYOK setup in Settings)
 * @param args.question - Question to ask the AI
 * @returns AI response
 */
export async function ask(args: { question: string }) {
  const response = await ultralight.ai({
    messages: [{ role: 'user', content: args.question }],
  });
  return { answer: response.content };
}

/**
 * Example using data storage
 * @param args.title - Note title
 * @param args.content - Note content
 */
export async function saveNote(args: { title: string; content: string }) {
  await ultralight.store(\`notes/\${args.title}\`, {
    content: args.content,
    createdAt: new Date().toISOString(),
  });
  return { saved: true, title: args.title };
}

/**
 * Load a note by title
 * @param args.title - Note title to load
 */
export async function getNote(args: { title: string }) {
  const data = await ultralight.load(\`notes/\${args.title}\`);
  return { title: args.title, data: data };
}

/**
 * List all notes
 * @returns Array of note titles
 */
export async function listNotes() {
  const keys = await ultralight.list('notes/');
  return { notes: keys.map(k => k.replace('notes/', '')) };
}
`;

  // package.json
  const packageJson = {
    name: dir,
    version: '1.0.0',
    type: 'module',
    devDependencies: {
      '@ultralightpro/types': '^1.0.0',
      'typescript': '^5.0.0',
    },
  };

  // tsconfig.json
  const tsConfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      types: ['@ultralightpro/types'],
    },
    include: ['*.ts', '*.tsx'],
  };

  // README.md
  const readme = `# ${dir}

An Ultralight app.

## Development

\`\`\`bash
ultralight test .       # Test functions in sandbox
ultralight lint .       # Validate conventions
\`\`\`

## Deploy

\`\`\`bash
ultralight upload .
\`\`\`

## Function Pattern

All functions receive a single args object (NOT positional params):

\`\`\`typescript
// Correct
export function search(args: { query: string; limit?: number }) {
  return { query: args.query, results: [] };
}

// Wrong — will fail in sandbox
export function search(query: string, limit?: number) { ... }
\`\`\`

Return values must use explicit \`key: value\` form (no shorthand) for IIFE bundling safety.

## SDK Reference

The \`ultralight\` global is available in all functions:

\`\`\`typescript
// Data storage
await ultralight.store('key', value);
await ultralight.load('key');
await ultralight.list('prefix/');

// AI (requires BYOK in Settings)
await ultralight.ai({ messages: [{ role: 'user', content: 'Hi' }] });

// User context
if (ultralight.isAuthenticated()) {
  const user = ultralight.user;
}
\`\`\`

## Learn More

- [Ultralight Documentation](https://ultralightagent.com/docs)
- [SDK Types](https://www.npmjs.com/package/@ultralightpro/types)
`;

  // Write files
  await Deno.writeTextFile(`${dir}/index.ts`, indexTs);
  await Deno.writeTextFile(`${dir}/package.json`, JSON.stringify(packageJson, null, 2));
  await Deno.writeTextFile(`${dir}/tsconfig.json`, JSON.stringify(tsConfig, null, 2));
  await Deno.writeTextFile(`${dir}/README.md`, readme);
  await Deno.writeTextFile(`${dir}/.gitignore`, 'node_modules/\n.ultralight/\n');

  console.log(colors.dim(`  Created ${dir}/index.ts`));
  console.log(colors.dim(`  Created ${dir}/package.json`));
  console.log(colors.dim(`  Created ${dir}/tsconfig.json`));
  console.log(colors.dim(`  Created ${dir}/README.md`));
  console.log(colors.dim(`  Created ${dir}/.gitignore`));
}

async function createReactTemplate(dir: string) {
  // index.tsx — uses correct single-args-object pattern for exported MCP functions
  const indexTsx = `/// <reference types="@ultralightpro/types" />
import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';

/**
 * Main App Component
 */
function App({ sdk }: UltralightProps) {
  const [notes, setNotes] = useState<string[]>([]);
  const [newNote, setNewNote] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadNotes();
  }, []);

  async function loadNotes() {
    setLoading(true);
    const keys = await sdk.list('notes/');
    setNotes(keys.map(k => k.replace('notes/', '')));
    setLoading(false);
  }

  async function addNote() {
    if (!newNote.trim()) return;
    await sdk.store(\`notes/\${newNote}\`, {
      title: newNote,
      createdAt: new Date().toISOString(),
    });
    setNewNote('');
    await loadNotes();
  }

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>My Notes</h1>

      <div style={{ marginBottom: '1rem' }}>
        <input
          type="text"
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          placeholder="New note title..."
          style={{ padding: '0.5rem', marginRight: '0.5rem' }}
        />
        <button onClick={addNote} style={{ padding: '0.5rem 1rem' }}>
          Add Note
        </button>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : notes.length === 0 ? (
        <p>No notes yet. Create your first note!</p>
      ) : (
        <ul>
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Ultralight entry point
 * This function is called when the app loads
 */
const UltralightApp: UltralightApp = (container, sdk) => {
  const root = ReactDOM.createRoot(container);
  root.render(<App sdk={sdk} />);
};

export default UltralightApp;

// Also export server-side functions for MCP
// Note: MCP functions use single-args-object pattern
export async function getNotes() {
  const keys = await ultralight.list('notes/');
  return { notes: keys.map(k => k.replace('notes/', '')) };
}

export async function saveNote(args: { title: string; content: string }) {
  await ultralight.store(\`notes/\${args.title}\`, {
    title: args.title,
    content: args.content,
    createdAt: new Date().toISOString(),
  });
  return { saved: true };
}
`;

  // package.json
  const packageJson = {
    name: dir,
    version: '1.0.0',
    type: 'module',
    devDependencies: {
      '@ultralightpro/types': '^1.0.0',
      '@types/react': '^18.0.0',
      '@types/react-dom': '^18.0.0',
      'typescript': '^5.0.0',
    },
    dependencies: {
      'react': '^18.0.0',
      'react-dom': '^18.0.0',
    },
  };

  // tsconfig.json
  const tsConfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      jsx: 'react-jsx',
      types: ['@ultralightpro/types'],
    },
    include: ['*.ts', '*.tsx'],
  };

  // README.md
  const readme = `# ${dir}

A React app running on Ultralight.

## Development

\`\`\`bash
ultralight test .       # Test functions in sandbox
ultralight lint .       # Validate conventions
\`\`\`

## Deploy

\`\`\`bash
ultralight upload .
\`\`\`

## How It Works

This app exports a default function that receives:
- \`container\`: The DOM element to render into
- \`sdk\`: The Ultralight SDK (\`ultralight\` global)

\`\`\`tsx
const App: UltralightApp = (container, sdk) => {
  const root = ReactDOM.createRoot(container);
  root.render(<MyComponent sdk={sdk} />);
};
export default App;
\`\`\`

You can also export server-side functions for MCP:

\`\`\`typescript
// Must use single-args-object pattern
export async function myServerFunction(args: { key: string }) {
  return { data: await ultralight.load(args.key) };
}
\`\`\`

## Learn More

- [Ultralight Documentation](https://ultralightagent.com/docs)
- [SDK Types](https://www.npmjs.com/package/@ultralightpro/types)
`;

  // Write files
  await Deno.writeTextFile(`${dir}/index.tsx`, indexTsx);
  await Deno.writeTextFile(`${dir}/package.json`, JSON.stringify(packageJson, null, 2));
  await Deno.writeTextFile(`${dir}/tsconfig.json`, JSON.stringify(tsConfig, null, 2));
  await Deno.writeTextFile(`${dir}/README.md`, readme);
  await Deno.writeTextFile(`${dir}/.gitignore`, 'node_modules/\n.ultralight/\n');

  console.log(colors.dim(`  Created ${dir}/index.tsx`));
  console.log(colors.dim(`  Created ${dir}/package.json`));
  console.log(colors.dim(`  Created ${dir}/tsconfig.json`));
  console.log(colors.dim(`  Created ${dir}/README.md`));
  console.log(colors.dim(`  Created ${dir}/.gitignore`));
}

// ============================================
// AUTH COMMANDS
// ============================================

async function login(args: string[], _client: ApiClient, config: Config) {
  const parsed = parseArgs(args, {
    string: ['token'],
    alias: { t: 'token' },
  });

  if (parsed.help) {
    console.log(`
${colors.bold('ultralight login')}

Authenticate with Ultralight using an API token.

${colors.dim('OPTIONS')}
  --token, -t <token>   Your API token (create one in User Settings → API Tokens)

${colors.dim('TOKEN TYPES')}
  API Token (ul_xxx)    Long-lived token for CLI/API access
  JWT Token             Short-lived session token (from browser)

${colors.dim('EXAMPLES')}
  ultralight login --token ul_abc123...   # Use API token (recommended)
  ultralight login                         # Show instructions
`);
    return;
  }

  if (parsed.token) {
    const token = parsed.token as string;
    const isApiToken = token.startsWith('ul_');

    // Token-based login
    config.auth = {
      token,
      is_api_token: isApiToken,
      // API tokens don't need client-side expiry tracking
      expires_at: isApiToken ? undefined : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    };
    await saveConfig(config);

    if (isApiToken) {
      console.log(colors.green('✓ Logged in with API token'));
      console.log(colors.dim('  Token starts with: ' + token.substring(0, 10) + '...'));
    } else {
      console.log(colors.green('✓ Logged in with session token'));
    }
    return;
  }

  // No token provided - show instructions
  console.log(`
${colors.bold('How to get an API token:')}

  1. Go to ${colors.cyan(config.api_url)}
  2. Sign in and click your profile icon
  3. Go to ${colors.cyan('Settings → API Tokens')}
  4. Create a new token and copy it
  5. Run: ${colors.cyan('ultralight login --token <your-token>')}

${colors.dim('API tokens start with ul_ and can be used for CLI and API access.')}
`);
}

async function setup(args: string[], _client: ApiClient, config: Config) {
  const parsed = parseArgs(args, {
    string: ['token'],
    alias: { t: 'token' },
  });

  if (parsed.help) {
    console.log(`
${colors.bold('ultralight setup')}

Set up Ultralight: authenticate and configure your agent's MCP connection.

${colors.dim('OPTIONS')}
  --token, -t <token>   Your API token (starts with ul_)

${colors.dim('WHAT IT DOES')}
  1. Saves your token to ~/.ultralight/config.json
  2. Verifies the token against the Ultralight API
  3. Detects MCP client config files (Claude Code, Claude Desktop, Cursor)
  4. Writes the Ultralight MCP server entry to each detected config
  5. Your agent can use Ultralight immediately after restarting

${colors.dim('EXAMPLES')}
  ultralight setup --token ul_abc123...
  ultralight setup -t ul_abc123...
`);
    return;
  }

  if (!parsed.token) {
    console.log(`
${colors.bold('Ultralight Setup')}

To set up, you need an API token.

${colors.dim('Get a token:')}
  1. Go to ${colors.cyan(config.api_url)}
  2. Sign in with Google
  3. Go to Settings → API Tokens
  4. Create a new token

${colors.dim('Then run:')}
  ${colors.cyan('ultralight setup --token <your-token>')}

Or get the full setup command from ${colors.cyan(config.api_url)} — click "Connect" on the homepage.
`);
    return;
  }

  const token = parsed.token as string;

  // Validate token format
  if (!token.startsWith('ul_')) {
    console.log(colors.red('✗ Invalid token format. Ultralight API tokens start with ul_'));
    return;
  }

  // Step 1: Save token to config
  config.auth = {
    token,
    is_api_token: true,
  };
  await saveConfig(config);
  console.log(colors.green('✓ Token saved to ~/.ultralight/config.json'));

  // Step 2: Verify token
  let userInfo: Record<string, unknown> | null = null;
  try {
    const verifyClient = new ApiClient(config);
    userInfo = await verifyClient.restGet('/api/user');
    console.log(colors.green(`✓ Authenticated as ${colors.cyan(String(userInfo.email || userInfo.display_name || 'user'))}`));
  } catch (err) {
    console.log(colors.red(`✗ Token validation failed: ${err instanceof Error ? err.message : 'Unknown error'}`));
    console.log(colors.dim('  Check that your token is correct and try again.'));
    // Clear the bad token
    delete config.auth;
    await saveConfig(config);
    return;
  }

  // Step 3: Detect MCP client config files
  const home = Deno.env.get('HOME') || Deno.env.get('USERPROFILE') || '';
  const appData = Deno.env.get('APPDATA') || '';
  const mcpUrl = `${config.api_url}/mcp/platform`;

  const mcpEntry = {
    url: mcpUrl,
    transport: 'http-post' as const,
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  };

  const configPaths = [
    { path: `${home}/.claude.json`, name: 'Claude Code', key: 'mcpServers' },
    { path: `${home}/.claude/mcp.json`, name: 'Claude Code (mcp.json)', key: 'mcpServers' },
    { path: `${home}/.config/Claude/claude_desktop_config.json`, name: 'Claude Desktop', key: 'mcpServers' },
    ...(appData ? [{ path: `${appData}/Claude/claude_desktop_config.json`, name: 'Claude Desktop (Windows)', key: 'mcpServers' }] : []),
    { path: '.cursor/mcp.json', name: 'Cursor (project)', key: 'mcpServers' },
  ];

  let configsWritten = 0;
  const writtenPaths: string[] = [];

  for (const configTarget of configPaths) {
    try {
      // Check if config file exists
      await Deno.stat(configTarget.path);

      // Read existing config
      let existingConfig: Record<string, unknown> = {};
      try {
        const content = await Deno.readTextFile(configTarget.path);
        existingConfig = JSON.parse(content);
      } catch {
        existingConfig = {};
      }

      // Merge in Ultralight server entry
      const servers = (existingConfig[configTarget.key] || {}) as Record<string, unknown>;
      servers['ultralight'] = mcpEntry;
      existingConfig[configTarget.key] = servers;

      // Write back
      await Deno.writeTextFile(configTarget.path, JSON.stringify(existingConfig, null, 2));
      console.log(colors.green(`✓ MCP config written to ${colors.dim(configTarget.path)} (${configTarget.name})`));
      configsWritten++;
      writtenPaths.push(configTarget.path);
    } catch {
      // File doesn't exist, skip
    }
  }

  // Step 4: Output results
  if (configsWritten === 0) {
    console.log('');
    console.log(colors.yellow('⚠ No MCP client config files detected.'));
    console.log(colors.dim('  Add this to your MCP client config manually:'));
    console.log('');
    const manualConfig = JSON.stringify({ mcpServers: { ultralight: mcpEntry } }, null, 2);
    console.log(colors.dim(manualConfig));
    console.log('');
    console.log(colors.dim('  Common config file locations:'));
    console.log(colors.dim('    Claude Code:    ~/.claude.json'));
    console.log(colors.dim('    Claude Desktop: ~/.config/Claude/claude_desktop_config.json'));
    console.log(colors.dim('    Cursor:         .cursor/mcp.json'));
  } else {
    console.log('');
    console.log(colors.green(colors.bold('✓ Ultralight is ready!')));
    console.log('');
    console.log(`  ${colors.dim('Platform tools:')} 10 tools (discover, build, test, deploy, call, and more)`);
    if (userInfo) {
      console.log(`  ${colors.dim('Account:')}        ${userInfo.email || 'authenticated'}`);
      console.log(`  ${colors.dim('Tier:')}           ${userInfo.tier || 'free'}`);
    }
    console.log('');
    console.log(colors.dim('  Restart your agent or reconnect MCP to activate.'));
  }
}

async function logout(_args: string[], _client: ApiClient, _config: Config) {
  await clearConfig();
  console.log(colors.green('✓ Logged out successfully'));
}

async function whoami(_args: string[], client: ApiClient, _config: Config) {
  // Use REST API: GET /api/user
  const user = await client.restGet('/api/user');
  console.log(`
${colors.bold('Logged in as:')}
  Email: ${colors.cyan(String(user.email || ''))}
  Name:  ${user.display_name || colors.dim('(not set)')}
  Tier:  ${user.tier || 'free'}
  ID:    ${colors.dim(String(user.id || ''))}
`);
}

// ============================================
// UPLOAD COMMAND — uses ul.upload
// ============================================

async function upload(args: string[], client: ApiClient, _config: Config) {
  const parsed = parseArgs(args, {
    string: ['name', 'description', 'visibility', 'version', 'app-id'],
    boolean: ['help'],
    alias: { n: 'name', d: 'description', v: 'visibility', a: 'app-id', h: 'help' },
  });

  if (parsed.help) {
    console.log(`
${colors.bold('ultralight upload')} [directory]

Upload source code to create a new app or update an existing one (ul.upload).
No app_id → creates new app (v1.0.0, set live automatically).
With app_id → creates new version (NOT set live — use: ultralight set version).

${colors.dim('ARGUMENTS')}
  directory             Directory to upload (default: current directory)

${colors.dim('OPTIONS')}
  --name, -n <name>     App display name (new apps only)
  --description, -d     App description
  --visibility, -v      Visibility: private, unlisted, published (default: private)
  --version             Explicit version (e.g. "2.0.0"). Default: patch bump
  --app-id, -a          Existing app ID or slug (auto-detected from .ultralightrc.json)

${colors.dim('EXAMPLES')}
  ultralight upload                       # Upload current directory as new app
  ultralight upload ./my-app              # Upload specific directory
  ultralight upload --name "My App"       # With custom name
  ultralight upload -a my-slug            # New version of existing app
`);
    return;
  }

  const dir = parsed._[0] as string || '.';
  const files = await collectFiles(dir);

  if (files.length === 0) {
    throw new Error('No valid files found in directory');
  }

  // Check if this is an existing app (has .ultralightrc.json or --app-id)
  let appId: string | undefined = parsed['app-id'] as string | undefined;
  if (!appId) {
    try {
      const rcPath = `${dir}/.ultralightrc.json`;
      const rc = JSON.parse(await Deno.readTextFile(rcPath));
      appId = rc.app_id;
    } catch {
      // No existing app
    }
  }

  console.log(colors.dim(`Uploading ${files.length} files${appId ? ` to ${appId}` : ' (new app)'}...`));

  const toolArgs: Record<string, unknown> = {
    files: files.map(f => ({
      path: f.name,
      content: f.content,
    })),
  };
  if (appId) toolArgs.app_id = appId;
  if (parsed.name) toolArgs.name = parsed.name;
  if (parsed.description) toolArgs.description = parsed.description;
  if (parsed.visibility) toolArgs.visibility = parsed.visibility;
  if (parsed.version) toolArgs.version = parsed.version;

  const result = await client.callTool('ul.upload', toolArgs);

  // Save app ID to .ultralightrc.json for future uploads
  if (result.app_id) {
    const rc = {
      app_id: result.app_id,
      slug: result.slug,
      name: parsed.name || result.slug,
    };
    try {
      await Deno.writeTextFile(`${dir}/.ultralightrc.json`, JSON.stringify(rc, null, 2));
    } catch {
      // Best-effort — dir may be read-only
    }
  }

  console.log();
  console.log(colors.green(appId ? '✓ New version uploaded' : '✓ App created'));
  if (result.app_id) console.log(`  ID:       ${result.app_id}`);
  if (result.slug) console.log(`  Slug:     ${result.slug}`);
  if (result.version) console.log(`  Version:  ${result.version}`);
  if (result.exports) console.log(`  Exports:  ${(result.exports as string[]).join(', ')}`);
  if (result.is_live !== undefined) console.log(`  Live:     ${result.is_live ? colors.green('yes') : colors.yellow('no — use: ultralight set version')}`);
  if (result.mcp_endpoint) console.log(`  MCP:      ${colors.cyan(String(result.mcp_endpoint))}`);
}

// ============================================
// DOWNLOAD COMMAND — uses ul.download
// ============================================

async function downloadCmd(args: string[], client: ApiClient, _config: Config) {
  const parsed = parseArgs(args, {
    string: ['version', 'output'],
    boolean: ['help'],
    alias: { v: 'version', o: 'output', h: 'help' },
  });

  if (parsed.help) {
    console.log(`
${colors.bold('ultralight download')} <app-id>

Download source code for an app (ul.download). Respects download_access settings.

${colors.dim('OPTIONS')}
  --version, -v <ver>   Specific version to download (default: live version)
  --output, -o <dir>    Output directory (default: ./<slug>)

${colors.dim('EXAMPLES')}
  ultralight download my-app
  ultralight download my-app --version 1.0.0
  ultralight download my-app -o ./downloaded
`);
    return;
  }

  const appId = parsed._[0] as string;
  if (!appId) {
    throw new Error('Usage: ultralight download <app-id>');
  }

  const toolArgs: Record<string, unknown> = { app_id: appId };
  if (parsed.version) toolArgs.version = parsed.version;

  console.log(colors.dim(`Downloading ${appId}...`));

  const result = await client.callTool('ul.download', toolArgs);

  const downloadFiles = result.files as Array<{ path: string; content: string }>;
  if (!downloadFiles || downloadFiles.length === 0) {
    throw new Error('No files returned. You may not have download access.');
  }

  const outputDir = (parsed.output as string) || String(result.slug || appId);

  // Create directory and write files
  await Deno.mkdir(outputDir, { recursive: true });

  for (const file of downloadFiles) {
    const filePath = `${outputDir}/${file.path}`;
    // Ensure subdirectories exist
    const dirPart = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dirPart !== outputDir) {
      await Deno.mkdir(dirPart, { recursive: true });
    }
    await Deno.writeTextFile(filePath, file.content);
    console.log(colors.dim(`  ${filePath}`));
  }

  console.log();
  console.log(colors.green(`✓ Downloaded ${downloadFiles.length} files to ${outputDir}/`));
  if (result.version) console.log(`  Version: ${result.version}`);
}

// ============================================
// TEST COMMAND — uses ul.test
// ============================================

async function testCmd(args: string[], client: ApiClient, _config: Config) {
  const parsed = parseArgs(args, {
    string: ['function'],
    boolean: ['help', 'json'],
    alias: { f: 'function', h: 'help' },
  });

  if (parsed.help) {
    console.log(`
${colors.bold('ultralight test')} [directory] [options]

Test your app functions in the Ultralight sandbox without deploying (ul.test).
Supports all sandbox globals (fetch, crypto, lodash, dateFns, etc).

${colors.dim('OPTIONS')}
  --function, -f <name>  Function to test (with optional JSON args after)
  --json                 Output raw JSON result

${colors.dim('EXAMPLES')}
  ultralight test . --function hello '{"name":"World"}'
  ultralight test ./my-app -f process '{"data":[1,2]}'
`);
    return;
  }

  // Determine directory (first positional arg or current dir)
  let dir = '.';
  const positional = parsed._ as string[];
  if (positional.length > 0 && !positional[0].startsWith('{')) {
    dir = positional[0];
  }

  const files = await collectFiles(dir);
  if (files.length === 0) {
    throw new Error('No valid files found in directory');
  }

  const fnName = parsed.function as string | undefined;
  let fnArgs: Record<string, unknown> | undefined;

  // Parse function args — look for JSON in remaining positional args
  if (fnName) {
    const jsonArg = positional.find(a => a.startsWith('{'));
    if (jsonArg) {
      try {
        fnArgs = JSON.parse(jsonArg);
      } catch {
        throw new Error('Invalid JSON arguments. Must be valid JSON object.');
      }
    }
  }

  console.log(colors.dim(`Testing${fnName ? ` ${fnName}()` : ''} from ${dir}...`));
  console.log();

  // ul.test uses function_name and test_args
  const toolArgs: Record<string, unknown> = {
    files: files.map(f => ({ path: f.name, content: f.content })),
  };
  if (fnName) {
    toolArgs.function_name = fnName;
    if (fnArgs) toolArgs.test_args = fnArgs;
  }

  const result = await client.callTool('ul.test', toolArgs);

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.success) {
    console.log(colors.green('✓ Test passed') + (result.duration_ms ? ` (${result.duration_ms}ms)` : ''));
    if (result.exports) {
      console.log(`  Exports: ${(result.exports as string[]).join(', ')}`);
    }
    if (result.result !== undefined) {
      console.log();
      console.log(colors.dim('Result:'));
      console.log(typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2));
    }
  } else {
    console.log(colors.red('✗ Test failed'));
    if (result.error_type) {
      console.log(`  Type: ${result.error_type}`);
    }
    console.log(`  ${result.error}`);
  }

  if (result.logs && (result.logs as unknown[]).length > 0) {
    console.log();
    console.log(colors.dim('--- Logs ---'));
    for (const log of result.logs as Array<{ message: string }>) {
      console.log(log.message);
    }
  }
}

// ============================================
// LINT COMMAND — uses ul.test({ lint_only: true })
// ============================================

async function lint(args: string[], client: ApiClient, _config: Config) {
  const parsed = parseArgs(args, {
    boolean: ['strict', 'help', 'json'],
    alias: { s: 'strict', h: 'help' },
  });

  if (parsed.help) {
    console.log(`
${colors.bold('ultralight lint')} [directory]

Validate source code and manifest against Ultralight conventions via ul.test({ lint_only: true }).
Checks: single-args-object, no-shorthand-return, function-count, manifest sync, permissions.

${colors.dim('OPTIONS')}
  --strict, -s    Treat warnings as errors (useful for CI)
  --json          Output raw JSON result

${colors.dim('EXAMPLES')}
  ultralight lint .
  ultralight lint ./my-app --strict
`);
    return;
  }

  const dir = (parsed._[0] as string) || '.';
  const files = await collectFiles(dir);
  if (files.length === 0) {
    throw new Error('No valid files found in directory');
  }

  console.log(colors.dim(`Linting ${files.length} files from ${dir}...`));
  console.log();

  const result = await callPlatformLint(client, {
    files: files.map(f => ({ path: f.name, content: f.content })),
    strict: parsed.strict || false,
  });

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const issues = result.issues as Array<{ severity: string; rule: string; message: string; suggestion?: string }> || [];

  if (result.valid) {
    console.log(colors.green('✓ All checks passed'));
  } else {
    console.log(colors.red(`✗ ${issues.length} issue(s) found`));
  }

  if (result.summary) {
    console.log(`  ${colors.dim(result.summary as string)}`);
  }

  console.log();
  for (const issue of issues) {
    const icon = issue.severity === 'error' ? colors.red('✗') : colors.yellow('⚠');
    console.log(`  ${icon} ${colors.bold(issue.rule)}: ${issue.message}`);
    if (issue.suggestion) {
      console.log(`    ${colors.dim(`→ ${issue.suggestion}`)}`);
    }
  }

  if (!result.valid) {
    console.log();
    console.log(colors.dim('Fix issues and run again before uploading.'));
    Deno.exit(1);
  }
}

// ============================================
// SCAFFOLD COMMAND — uses ul.download scaffold mode
// ============================================

async function scaffold(args: string[], client: ApiClient, _config: Config) {
  const parsed = parseArgs(args, {
    string: ['description', 'storage'],
    boolean: ['help'],
    alias: { d: 'description', h: 'help' },
  });

  if (parsed.help) {
    console.log(`
${colors.bold('ultralight scaffold')} <name>

Generate a properly structured app skeleton following all Ultralight conventions via ul.download.
Returns index.ts + manifest.json + migrations/001_initial.sql with correct patterns.

${colors.dim('OPTIONS')}
  --description, -d <text>       App description (used to generate function stubs)
  --storage <none|d1|kv|supabase>  Storage type (default: d1)

${colors.dim('EXAMPLES')}
  ultralight scaffold my-app
  ultralight scaffold weather-api -d "Get weather data" --storage none
  ultralight scaffold my-db-app --storage d1
`);
    return;
  }

  const name = parsed._[0] as string;
  if (!name) {
    throw new Error('Usage: ultralight scaffold <name>');
  }

  // Check if directory exists
  try {
    const stat = await Deno.stat(name);
    if (stat.isDirectory) {
      throw new Error(`Directory '${name}' already exists`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) throw err;
    // Directory doesn't exist — good
  }

  console.log(colors.dim(`Scaffolding ${name}...`));

  const result = await callPlatformScaffold(client, {
    name: name,
    description: parsed.description || `${name} — an Ultralight MCP app`,
    storage: parsed.storage || 'd1',
  });

  const generatedFiles = result.files as Array<{ path: string; content: string }>;

  if (!generatedFiles || generatedFiles.length === 0) {
    throw new Error('No files generated. Check that scaffold mode is available on ul.download.');
  }

  // Create directory and write files
  await Deno.mkdir(name, { recursive: true });

  for (const file of generatedFiles) {
    const filePath = `${name}/${file.path}`;
    // Ensure subdirectories exist (e.g., migrations/)
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dir) await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(filePath, file.content);
    console.log(colors.dim(`  Created ${filePath}`));
  }

  console.log();
  console.log(colors.green('✓ Scaffold created'));

  if (result.next_steps) {
    console.log();
    console.log(colors.dim('Next steps:'));
    for (const step of result.next_steps as string[]) {
      console.log(`  ${step}`);
    }
  }

  if (result.tip) {
    console.log();
    console.log(colors.dim(`💡 ${result.tip}`));
  }

  console.log();
  console.log(colors.dim('Build workflow:'));
  console.log(`  cd ${name}`);
  console.log(`  ${colors.cyan('ultralight test .')}       # verify`);
  console.log(`  ${colors.cyan('ultralight lint .')}       # validate`);
  console.log(`  ${colors.cyan('ultralight upload .')}     # deploy`);
}

// ============================================
// APPS COMMAND
// ============================================

async function apps(args: string[], client: ApiClient, _config: Config) {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'list':
    case 'ls': {
      const result = await callPlatformDiscover(client, 'library', {});

      if (typeof result.library === 'string') {
        console.log(result.library);
        if (typeof result.memory === 'string' && result.memory.trim()) {
          console.log();
          console.log(colors.dim('--- Memory ---'));
          console.log(result.memory);
        }
      } else if (result.results) {
        const appList = result.results as Array<Record<string, unknown>>;
        if (appList.length === 0) {
          console.log(colors.dim('No apps found.'));
          return;
        }
        console.log(`${colors.bold('Your Apps')} (${appList.length} total)\n`);
        for (const app of appList) {
          const vis = app.visibility === 'published' ? colors.green('published') :
                      app.visibility === 'unlisted' ? colors.yellow('unlisted') :
                      colors.dim('private');
          console.log(`  ${colors.cyan(String(app.slug || app.name))}`);
          console.log(`    ${app.name} · ${vis}${app.version ? ` · v${app.version}` : ''}`);
          if (app.id) console.log(`    ${colors.dim(String(app.id))}`);
          console.log();
        }
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
      break;
    }

    case 'get': {
      const appId = subArgs[0];
      if (!appId) {
        throw new Error('Usage: ultralight apps get <app-id>');
      }

      const result = await client.callTool('ul.download', {
        app_id: appId,
      });

      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'delete': {
      const appId = subArgs[0];
      if (!appId) {
        throw new Error('Usage: ultralight apps delete <app-id>');
      }

      const parsed = parseArgs(subArgs.slice(1), {
        boolean: ['yes'],
        alias: { y: 'yes' },
      });

      if (!parsed.yes) {
        console.log(colors.yellow(`Warning: This will delete the app "${appId}"`));
        console.log('Run with --yes to confirm.');
        return;
      }

      // No direct delete tool — guide user to web UI
      console.log(colors.yellow('App deletion is available via the web dashboard.'));
      console.log('Configure an owned web dashboard origin before using this CLI handoff.');
      break;
    }

    default:
      console.log(`
${colors.bold('ultralight apps')} <command>

Manage your Ultralight apps.

${colors.dim('COMMANDS')}
  list, ls        List your apps (ul.discover scope=library)
  get <app>       Get app details
  delete <app>    Delete an app

${colors.dim('EXAMPLES')}
  ultralight apps list
  ultralight apps get my-app
`);
  }
}

// ============================================
// SET COMMAND — app settings
// ============================================

async function setCmd(args: string[], client: ApiClient, _config: Config) {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'version': {
      const appId = subArgs[0];
      const ver = subArgs[1];
      if (!appId || !ver) {
        throw new Error('Usage: ultralight set version <app-id> <version>');
      }
      await callPlatformSet(client, appId, { version: ver });
      console.log(colors.green(`✓ Live version set to ${ver}`));
      break;
    }

    case 'visibility': {
      const appId = subArgs[0];
      const vis = subArgs[1];
      if (!appId || !vis) {
        throw new Error('Usage: ultralight set visibility <app-id> <private|unlisted|published>');
      }
      await callPlatformSet(client, appId, { visibility: vis });
      console.log(colors.green(`✓ Visibility set to ${vis}`));
      break;
    }

    case 'ratelimit': {
      const parsed = parseArgs(subArgs, {
        string: ['app'],
        number: ['per-minute', 'per-day'],
        alias: { a: 'app' },
      });
      const appId = parsed._[0] as string || parsed.app as string;
      if (!appId) {
        throw new Error('Usage: ultralight set ratelimit <app-id> [--per-minute N] [--per-day N]');
      }
      const toolArgs: ToolArgs = {};
      if (parsed['per-minute'] !== undefined) toolArgs.calls_per_minute = parsed['per-minute'];
      if (parsed['per-day'] !== undefined) toolArgs.calls_per_day = parsed['per-day'];
      await callPlatformSet(client, appId, toolArgs);
      console.log(colors.green('✓ Rate limits updated'));
      break;
    }

    case 'pricing': {
      const parsed = parseArgs(subArgs, {
        number: ['default'],
      });
      const appId = parsed._[0] as string;
      if (!appId) {
        throw new Error('Usage: ultralight set pricing <app-id> --default <credits>');
      }
      const toolArgs: ToolArgs = {};
      if (parsed.default !== undefined) toolArgs.default_price_credits = parsed.default;
      await callPlatformSet(client, appId, toolArgs);
      console.log(colors.green('✓ Pricing updated'));
      break;
    }

    case 'supabase': {
      const appId = subArgs[0];
      const serverName = subArgs[1];
      if (!appId) {
        throw new Error('Usage: ultralight set supabase <app-id> <server-name|null>');
      }
      await callPlatformSet(client, appId, {
        supabase_server: serverName === 'null' ? null : serverName,
      });
      console.log(colors.green(serverName === 'null' ? '✓ Supabase unassigned' : `✓ Supabase set to ${serverName}`));
      break;
    }

    case 'download-access': {
      const appId = subArgs[0];
      const access = subArgs[1];
      if (!appId || !access) {
        throw new Error('Usage: ultralight set download-access <app-id> <owner|public>');
      }
      await callPlatformSet(client, appId, { download_access: access });
      console.log(colors.green(`✓ Download access set to ${access}`));
      break;
    }

    default:
      console.log(`
${colors.bold('ultralight set')} <setting> <app-id> <value>

Configure app settings.

${colors.dim('SETTINGS')}
  version <app> <ver>                  Set the live version (ul.set)
  visibility <app> <private|unlisted|published>  Change visibility (ul.set)
  ratelimit <app> [--per-minute N] [--per-day N]  Set rate limits (ul.set)
  pricing <app> --default <credits>    Set price in credits (✦) per call (ul.set)
  supabase <app> <server-name|null>    Assign Supabase server (ul.set)
  download-access <app> <owner|public> Set download access (ul.set)

${colors.dim('EXAMPLES')}
  ultralight set version my-app 2.0.0
  ultralight set visibility my-app published
  ultralight set ratelimit my-app --per-minute 60 --per-day 10000
  ultralight set pricing my-app --default 5
  ultralight set supabase my-app my-db
  ultralight set download-access my-app public
`);
  }
}

// ============================================
// PERMISSIONS COMMAND — ul.permissions
// ============================================

async function permissions(args: string[], client: ApiClient, _config: Config) {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'grant': {
      const parsed = parseArgs(subArgs, {
        string: ['functions', 'constraints', 'expires'],
        alias: { f: 'functions', c: 'constraints', e: 'expires' },
      });

      const appId = parsed._[0] as string;
      const email = parsed._[1] as string;
      if (!appId || !email) {
        throw new Error('Usage: ultralight permissions grant <app-id> <email> [--functions fn1,fn2] [--expires ISO]');
      }

      const toolArgs: ToolArgs = { app_id: appId, email: email };
      if (parsed.functions) {
        toolArgs.functions = (parsed.functions as string).split(',');
      }
      if (parsed.expires || parsed.constraints) {
        const constraints: Record<string, unknown> = {};
        if (parsed.expires) constraints.expires_at = parsed.expires;
        if (parsed.constraints) {
          try {
            Object.assign(constraints, JSON.parse(parsed.constraints as string));
          } catch {
            throw new Error('Invalid --constraints JSON');
          }
        }
        toolArgs.constraints = constraints;
      }

      await callPlatformPermissions(client, 'grant', toolArgs);
      console.log(colors.green(`✓ Access granted to ${email}`));
      break;
    }

    case 'revoke': {
      const parsed = parseArgs(subArgs, {
        string: ['functions', 'email'],
        alias: { f: 'functions', e: 'email' },
      });

      const appId = parsed._[0] as string;
      if (!appId) {
        throw new Error('Usage: ultralight permissions revoke <app-id> [email] [--functions fn1,fn2]');
      }

      const toolArgs: ToolArgs = { app_id: appId };
      const email = (parsed._[1] as string) || (parsed.email as string);
      if (email) toolArgs.email = email;
      if (parsed.functions) {
        toolArgs.functions = (parsed.functions as string).split(',');
      }

      await callPlatformPermissions(client, 'revoke', toolArgs);
      console.log(colors.green(email ? `✓ Access revoked for ${email}` : '✓ All access revoked'));
      break;
    }

    case 'list':
    case 'ls': {
      const appId = subArgs[0];
      if (!appId) {
        throw new Error('Usage: ultralight permissions list <app-id>');
      }

      const result = await callPlatformPermissions(client, 'list', { app_id: appId });

      if (result.users) {
        const users = result.users as Array<Record<string, unknown>>;
        if (users.length === 0) {
          console.log(colors.dim('No permissions granted.'));
          return;
        }
        console.log(`${colors.bold('Permissions')} for ${appId}\n`);
        for (const user of users) {
          const email = String(user.email || 'unknown');
          const status = user.status === 'pending' ? colors.yellow(' (pending)') : '';
          console.log(`  ${colors.cyan(email)}${status}`);
          const functions = Array.isArray(user.functions) ? user.functions as Array<Record<string, unknown>> : [];
          if (functions.length > 0) {
            console.log(`    Functions: ${functions.map((fn) => String(fn.name || '?')).join(', ')}`);
          }
          const constrainedFunctions = functions.filter((fn) => fn.constraints);
          if (constrainedFunctions.length > 0) {
            console.log(`    Constraints: ${colors.dim(JSON.stringify(constrainedFunctions.map((fn) => ({ name: fn.name, constraints: fn.constraints }))))}`);
          }
          console.log();
        }
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
      break;
    }

    case 'export': {
      const parsed = parseArgs(subArgs, {
        string: ['format', 'since', 'until'],
        number: ['limit'],
        alias: { f: 'format' },
      });

      const appId = parsed._[0] as string;
      if (!appId) {
        throw new Error('Usage: ultralight permissions export <app-id> [--format json|csv] [--since ISO] [--limit N]');
      }

      const toolArgs: ToolArgs = { app_id: appId };
      if (parsed.format) toolArgs.format = parsed.format;
      if (parsed.since) toolArgs.since = parsed.since;
      if (parsed.until) toolArgs.until = parsed.until;
      if (parsed.limit) toolArgs.limit = parsed.limit;

      const result = await callPlatformPermissions(client, 'export', toolArgs);
      if ((parsed.format === 'csv' || result.format === 'csv') && typeof result.data === 'string') {
        console.log(result.data);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
      break;
    }

    default:
      console.log(`
${colors.bold('ultralight permissions')} <command>

Manage app permissions.

${colors.dim('COMMANDS')}
  grant <app> <email>   Grant access (ul.permissions)
  revoke <app> [email]  Revoke access (ul.permissions)
  list <app>            List granted users (ul.permissions)
  export <app>          Export audit log (ul.permissions)

${colors.dim('OPTIONS (grant)')}
  --functions, -f <fn1,fn2>    Specific functions to grant (default: all)
  --expires, -e <ISO>          Auto-expire date
  --constraints, -c <JSON>     Full constraint JSON (IP, time, budget, args)

${colors.dim('OPTIONS (revoke)')}
  --functions, -f <fn1,fn2>    Revoke specific functions only

${colors.dim('OPTIONS (export)')}
  --format, -f <json|csv>      Export format (default: json)
  --since <ISO>                 Logs after this time
  --until <ISO>                 Logs before this time
  --limit <N>                   Max entries (default: 500)

${colors.dim('EXAMPLES')}
  ultralight permissions grant my-app user@email.com
  ultralight permissions grant my-app user@email.com --functions search,analyze --expires 2025-12-31T00:00:00Z
  ultralight permissions revoke my-app user@email.com
  ultralight permissions list my-app
  ultralight permissions export my-app --format csv --since 2025-01-01T00:00:00Z
`);
  }
}

// ============================================
// DRAFT COMMAND
// ============================================

async function draft(args: string[], client: ApiClient, _config: Config) {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'upload': {
      const parsed = parseArgs(subArgs, {
        string: ['app-id'],
        alias: { a: 'app-id' },
      });

      let appId = parsed['app-id'] as string | undefined;
      const dir = (parsed._[0] as string) || '.';

      // Try to read app_id from .ultralightrc.json
      if (!appId) {
        try {
          const rcPath = `${dir}/.ultralightrc.json`;
          const rc = JSON.parse(await Deno.readTextFile(rcPath));
          appId = rc.app_id;
        } catch {
          // No existing app
        }
      }

      if (!appId) {
        throw new Error('No app_id found. Use --app-id or run from a directory with .ultralightrc.json');
      }

      const files = await collectFiles(dir);
      if (files.length === 0) {
        throw new Error('No valid files found in directory');
      }

      console.log(colors.dim(`Uploading new version for ${appId}...`));

      // ul.upload with app_id creates new version (not set live)
      const result = await client.callTool('ul.upload', {
        app_id: appId,
        files: files.map(f => ({ path: f.name, content: f.content })),
      });

      console.log();
      console.log(colors.green('✓ New version uploaded'));
      if (result.version) console.log(`  Version: ${result.version}`);
      if (result.exports) console.log(`  Exports: ${(result.exports as string[]).join(', ')}`);
      console.log();
      console.log(`Set live: ${colors.cyan(`ultralight set version ${appId} ${result.version}`)}`);
      break;
    }

    case 'status': {
      const appId = subArgs[0];
      if (!appId) {
        throw new Error('Usage: ultralight draft status <app-id>');
      }

      // Show app versions via download info
      const result = await client.callTool('ul.download', { app_id: appId });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'publish': {
      const appId = subArgs[0];
      const ver = subArgs[1];
      if (!appId) {
        throw new Error('Usage: ultralight draft publish <app-id> [version]');
      }

      if (ver) {
        await callPlatformSet(client, appId, { version: ver });
        console.log(colors.green(`✓ Version ${ver} set live`));
      } else {
        console.log(colors.yellow('Specify which version to set live:'));
        console.log(`  ${colors.cyan(`ultralight set version ${appId} <version>`)}`);
      }
      break;
    }

    default:
      console.log(`
${colors.bold('ultralight draft')} <command>

Manage app versions.

${colors.dim('COMMANDS')}
  upload [dir]        Upload a new version without setting it live
  status <app>        Show app version info
  publish <app> <ver> Set a version as live (alias for: set version)

${colors.dim('OPTIONS (upload)')}
  --app-id, -a <id>   App ID or slug (auto-detected from .ultralightrc.json)

${colors.dim('EXAMPLES')}
  ultralight draft upload .
  ultralight draft upload . --app-id my-app
  ultralight draft publish my-app 2.0.0
`);
  }
}

// ============================================
// DOCS COMMAND
// ============================================

async function docs(args: string[], client: ApiClient, _config: Config) {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'generate': {
      const appId = subArgs[0];
      if (!appId) {
        throw new Error('Usage: ultralight docs generate <app-id>');
      }

      console.log(colors.dim('Documentation is auto-generated on upload.'));
      console.log(`To regenerate, re-upload: ${colors.cyan(`ultralight upload . --app-id ${appId}`)}`);
      break;
    }

    case 'get': {
      const appId = subArgs[0];
      if (!appId) {
        throw new Error('Usage: ultralight docs get <app-id>');
      }

      // Download source to get skills.md
      const result = await client.callTool('ul.download', { app_id: appId });
      const files = result.files as Array<{ path: string; content: string }> || [];
      const skillsFile = files.find(f => f.path === 'skills.md' || f.path === 'Skills.md');

      if (skillsFile) {
        console.log(skillsFile.content);
      } else {
        console.log(colors.dim('No Skills.md found. Upload your app to auto-generate documentation.'));
      }
      break;
    }

    default:
      console.log(`
${colors.bold('ultralight docs')} <command>

Manage app documentation (Skills.md).

${colors.dim('COMMANDS')}
  generate <app>  Regenerate documentation (re-upload)
  get <app>       Get documentation content

${colors.dim('EXAMPLES')}
  ultralight docs get my-app
`);
  }
}

// ============================================
// RUN COMMAND — calls per-app MCP endpoint
// ============================================

async function run(args: string[], client: ApiClient, _config: Config) {
  const parsed = parseArgs(args, {
    boolean: ['json', 'help'],
    alias: { h: 'help' },
  });

  if (parsed.help || args.length < 2) {
    console.log(`
${colors.bold('ultralight run')} <app> <function> [args]

Execute a function on a deployed app via its MCP endpoint (POST /mcp/{appId}).

${colors.dim('ARGUMENTS')}
  app         App ID or slug
  function    Function name to execute
  args        JSON arguments (optional)

${colors.dim('OPTIONS')}
  --json      Output raw JSON result

${colors.dim('EXAMPLES')}
  ultralight run my-app hello
  ultralight run my-app greet '{"name": "World"}'
  ultralight run my-app search '{"query": "test"}' --json
`);
    return;
  }

  const appId = parsed._[0] as string;
  const fnName = parsed._[1] as string;
  const rawArgs = parsed._[2] as string | undefined;

  let fnArgs: Record<string, unknown> | undefined;
  if (rawArgs) {
    try {
      fnArgs = JSON.parse(rawArgs);
    } catch {
      throw new Error('Invalid JSON arguments. Must be valid JSON object.');
    }
  }

  console.log(colors.dim(`Calling ${appId}.${fnName}()...`));
  console.log();

  // Per-app tools are prefixed: {slug}_{fnName}
  // Try slug-based name first, fallback to listing tools
  try {
    const toolName = `${appId}_${fnName}`;
    const result = await client.callAppTool(appId, toolName, fnArgs);

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(colors.green('✓ Success'));
      console.log();
      if (Object.keys(result).length > 0) {
        console.log(JSON.stringify(result, null, 2));
      }
    }
  } catch (err) {
    // If tool name was wrong, try listing tools to find the right prefix
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('not found') || errMsg.includes('Unknown tool')) {
      console.log(colors.dim('Looking up tool name...'));
      try {
        const tools = await client.listAppTools(appId);
        const matchingTool = tools.find(t => t.name.endsWith(`_${fnName}`));
        if (matchingTool) {
          const result = await client.callAppTool(appId, matchingTool.name, fnArgs);
          if (parsed.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(colors.green('✓ Success'));
            console.log();
            if (Object.keys(result).length > 0) {
              console.log(JSON.stringify(result, null, 2));
            }
          }
        } else {
          console.log(colors.red(`✗ Function "${fnName}" not found on ${appId}`));
          if (tools.length > 0) {
            console.log();
            console.log(colors.dim('Available functions:'));
            for (const tool of tools) {
              const name = tool.name.includes('_') ? tool.name.split('_').slice(1).join('_') : tool.name;
              console.log(`  ${colors.cyan(name)} — ${tool.description || ''}`);
            }
          }
        }
      } catch {
        throw err; // Re-throw original error
      }
    } else {
      throw err;
    }
  }
}

// ============================================
// DISCOVER COMMAND — uses ul.discover
// ============================================

async function discover(args: string[], client: ApiClient, _config: Config) {
  const parsed = parseArgs(args, {
    number: ['limit'],
    boolean: ['featured', 'help', 'desk', 'library'],
    alias: { l: 'limit', f: 'featured', h: 'help' },
  });

  if (parsed.help) {
    console.log(`
${colors.bold('ultralight discover')} [query]

Search the App Store for MCP tools by natural language via ul.discover({ scope: "appstore", ... }).
Uses semantic search with composite ranking (similarity + community signal + native capability).

${colors.dim('OPTIONS')}
  --limit, -l <n>     Max results (default: 10)
  --featured, -f      Show top-ranked apps (no query needed)
  --desk              Show last 3 apps you called (ul.discover scope=desk)
  --library           Search your library instead (ul.discover scope=library)

${colors.dim('EXAMPLES')}
  ultralight discover "weather API"
  ultralight discover "send email notifications" --limit 20
  ultralight discover --featured
  ultralight discover --desk
  ultralight discover --library "notes"
`);
    return;
  }

  // Desk mode
  if (parsed.desk) {
    console.log(colors.dim('Checking desk...'));
    console.log();
    const result = await callPlatformDiscover(client, 'desk', {});
    if (result.text) {
      console.log(result.text);
    } else if (result.desk) {
      const deskApps = result.desk as Array<Record<string, unknown>>;
      if (deskApps.length === 0) {
        console.log(colors.dim('Desk is empty — call some apps first.'));
        return;
      }
      console.log(colors.bold('Recent Apps (Desk)\n'));
      for (const app of deskApps) {
        console.log(`  ${colors.cyan(String(app.slug || app.name))}`);
        if (app.description) console.log(`    ${colors.dim(String(app.description).substring(0, 80))}`);
        if (app.mcp_endpoint) console.log(`    ${colors.dim(String(app.mcp_endpoint))}`);
        console.log();
      }
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  // Library mode
  if (parsed.library) {
    const query = (parsed._ as string[]).join(' ') || undefined;
    console.log(colors.dim(query ? `Searching library for "${query}"...` : 'Loading library...'));
    console.log();
    const toolArgs: ToolArgs = {};
    if (query) toolArgs.query = query;
    const result = await callPlatformDiscover(client, 'library', toolArgs);
    if (typeof result.library === 'string') {
      console.log(result.library);
      if (typeof result.memory === 'string' && result.memory.trim()) {
        console.log();
        console.log(colors.dim('--- Memory ---'));
        console.log(result.memory);
      }
    } else if (result.results) {
      console.log(JSON.stringify(result.results, null, 2));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  // Featured mode
  if (parsed.featured) {
    console.log(colors.dim('Fetching featured apps...'));
    console.log();

    const result = await callPlatformDiscover(client, 'appstore', {
      limit: parsed.limit || 10,
    });

    if (!result.results || (result.results as unknown[]).length === 0) {
      console.log(colors.dim('No featured apps found.'));
      return;
    }

    console.log(`${colors.bold('Featured Apps')}\n`);
    for (const app of result.results as Array<Record<string, unknown>>) {
      const likes = app.likes || 0;
      const owner = app.is_owner ? colors.cyan(' (yours)') : '';
      const native = app.fully_connected ? colors.green(' ★') : '';
      console.log(`  ${colors.cyan(String(app.slug))}${owner}${native} ${colors.dim(`${likes} likes`)}`);
      console.log(`    ${app.name}`);
      if (app.description) {
        console.log(`    ${colors.dim(String(app.description).substring(0, 80))}`);
      }
      if (app.mcp_endpoint) console.log(`    ${colors.dim(String(app.mcp_endpoint))}`);
      console.log();
    }
    return;
  }

  // Search mode
  const searchQuery = (parsed._ as string[]).join(' ');

  if (!searchQuery) {
    console.log(`
${colors.bold('ultralight discover')} [query]

Search the App Store for MCP tools by natural language.

${colors.dim('EXAMPLES')}
  ultralight discover "weather API"
  ultralight discover "send email notifications"
  ultralight discover --featured
  ultralight discover --desk
`);
    return;
  }

  console.log(colors.dim(`Searching for "${searchQuery}"...`));
  console.log();

  const result = await callPlatformDiscover(client, 'appstore', {
    query: searchQuery,
    limit: parsed.limit || 10,
  });

  if (!result.results || (result.results as unknown[]).length === 0) {
    console.log(colors.dim('No apps found matching your query.'));
    return;
  }

  console.log(`${colors.bold('Results')}\n`);
  for (const app of result.results as Array<Record<string, unknown>>) {
    const score = app.final_score ? Math.round(Number(app.final_score) * 100) : Math.round((Number(app.similarity) || 0) * 100);
    const owner = app.is_owner ? colors.cyan(' (yours)') : '';
    const native = app.fully_connected ? colors.green(' ★') : '';
    console.log(`  ${colors.cyan(String(app.slug))}${owner}${native} ${colors.dim(`${score}% match`)}`);
    console.log(`    ${app.name}`);
    if (app.description) {
      console.log(`    ${colors.dim(String(app.description).substring(0, 80))}`);
    }
    if (app.mcp_endpoint) console.log(`    ${colors.dim(String(app.mcp_endpoint))}`);
    console.log();
  }
}

// ============================================
// LOGS COMMAND — uses ul.logs
// ============================================

async function logsCmd(args: string[], client: ApiClient, _config: Config) {
  const parsed = parseArgs(args, {
    string: ['emails', 'functions', 'since'],
    number: ['limit'],
    boolean: ['help', 'json'],
    alias: { l: 'limit', h: 'help', e: 'emails', f: 'functions' },
  });

  if (parsed.help) {
    console.log(`
${colors.bold('ultralight logs')} <app-id>

View MCP call logs for an app you own (ul.logs).

${colors.dim('OPTIONS')}
  --limit, -l <n>          Max entries (default: 50)
  --emails, -e <a,b>       Filter by caller emails (comma-separated)
  --functions, -f <a,b>    Filter by function names (comma-separated)
  --since <ISO>            Only logs after this timestamp
  --json                   Output raw JSON

${colors.dim('EXAMPLES')}
  ultralight logs my-app
  ultralight logs my-app --limit 20
  ultralight logs my-app --emails user@email.com
  ultralight logs my-app --functions search,analyze --since 2025-01-01T00:00:00Z
`);
    return;
  }

  const appId = parsed._[0] as string;
  if (!appId) {
    throw new Error('Usage: ultralight logs <app-id>');
  }

  const toolArgs: Record<string, unknown> = { app_id: appId };
  if (parsed.limit) toolArgs.limit = parsed.limit;
  if (parsed.since) toolArgs.since = parsed.since;
  if (parsed.emails) toolArgs.emails = (parsed.emails as string).split(',');
  if (parsed.functions) toolArgs.functions = (parsed.functions as string).split(',');

  const result = await client.callTool('ul.logs', toolArgs);

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const logs = result.logs as Array<Record<string, unknown>> || [];
  if (logs.length === 0) {
    console.log(colors.dim('No logs found.'));
    return;
  }

  console.log(`${colors.bold('Call Logs')} for ${appId} (${logs.length} entries)\n`);
  for (const log of logs) {
    const ts = log.created_at ? new Date(String(log.created_at)).toLocaleString() : '';
    const status = log.success ? colors.green('✓') : colors.red('✗');
    const fn = log.function_name || log.tool_name || '?';
    const caller = log.caller_email || log.caller_id || '';
    const duration = log.duration_ms ? `${log.duration_ms}ms` : '';

    console.log(`  ${status} ${colors.cyan(String(fn))} ${colors.dim(String(caller))} ${colors.dim(duration)} ${colors.dim(ts)}`);
    if (!log.success && log.error) {
      console.log(`    ${colors.red(String(log.error))}`);
    }
  }
}

// ============================================
// HEALTH COMMAND — uses ul.health
// ============================================

async function health(args: string[], client: ApiClient, _config: Config) {
  const parsed = parseArgs(args, {
    string: ['status', 'resolve'],
    number: ['limit'],
    boolean: ['help', 'json'],
    alias: { s: 'status', r: 'resolve', l: 'limit', h: 'help' },
  });

  if (parsed.help) {
    console.log(`
${colors.bold('ultralight health')} [app-id]

View health events and error reports for your apps (ul.health).
The platform auto-detects failing functions (>50% error rate) and records events.

${colors.dim('OPTIONS')}
  --status, -s <state>    Filter: detected, acknowledged, resolved, all (default: detected)
  --resolve, -r <id>      Mark a health event as resolved
  --limit, -l <n>         Max events (default: 20)
  --json                  Output raw JSON

${colors.dim('EXAMPLES')}
  ultralight health                          # Check all your apps
  ultralight health my-app                   # Check specific app
  ultralight health --status all             # Show all events including resolved
  ultralight health --resolve <event-id>     # Mark event as resolved
`);
    return;
  }

  const appId = parsed._[0] as string | undefined;

  const toolArgs: Record<string, unknown> = {};
  if (appId) toolArgs.app_id = appId;
  if (parsed.status) toolArgs.status = parsed.status;
  if (parsed.limit) toolArgs.limit = parsed.limit;
  if (parsed.resolve) toolArgs.resolve_event_id = parsed.resolve;

  const result = await client.callTool('ul.health', toolArgs);

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (parsed.resolve) {
    console.log(colors.green('✓ Event resolved'));
    return;
  }

  const events = result.events as Array<Record<string, unknown>> || [];
  if (events.length === 0) {
    console.log(colors.green('✓ No health issues detected'));
    return;
  }

  console.log(`${colors.bold('Health Events')}${appId ? ` for ${appId}` : ''} (${events.length} events)\n`);
  for (const event of events) {
    const statusIcon = event.status === 'detected' ? colors.red('●') :
                       event.status === 'acknowledged' ? colors.yellow('●') :
                       colors.green('●');
    const ts = event.detected_at ? new Date(String(event.detected_at)).toLocaleString() : '';

    console.log(`  ${statusIcon} ${colors.bold(String(event.function_name || event.app_slug || '?'))}`);
    console.log(`    ${event.description || event.summary || ''}`);
    if (event.error_rate) console.log(`    Error rate: ${colors.red(String(event.error_rate))}`);
    if (event.sample_error) console.log(`    Sample: ${colors.dim(String(event.sample_error).substring(0, 100))}`);
    console.log(`    ${colors.dim(ts)} ${colors.dim(`ID: ${event.id}`)}`);
    console.log();
  }
}

// ============================================
// CONFIG COMMAND
// ============================================

async function configCmd(args: string[], _client: ApiClient, config: Config) {
  const subcommand = args[0];
  const subArgs = args.slice(1);
  const configMap = config as unknown as Record<string, unknown>;

  switch (subcommand) {
    case 'get': {
      const key = subArgs[0];
      if (key) {
        const value = configMap[key];
        console.log(value !== undefined ? JSON.stringify(value, null, 2) : colors.dim('(not set)'));
      } else {
        throw new Error('Usage: ultralight config get <key>');
      }
      break;
    }

    case 'set': {
      const [key, value] = subArgs;
      if (!key || !value) {
        throw new Error('Usage: ultralight config set <key> <value>');
      }

      configMap[key] = value;
      await saveConfig(config);
      console.log(colors.green('✓ Config updated'));
      break;
    }

    case 'list': {
      console.log(JSON.stringify(config, null, 2));
      break;
    }

    default:
      console.log(`
${colors.bold('ultralight config')} <command>

Manage CLI configuration.

${colors.dim('COMMANDS')}
  get <key>         Get a config value
  set <key> <value> Set a config value
  list              Show all config

${colors.dim('EXAMPLES')}
  ultralight config get api_url
  ultralight config set api_url https://api.custom.example
  ultralight config list
`);
  }
}

// ============================================
// HELPERS
// ============================================

async function collectFiles(dir: string): Promise<Array<{ name: string; content: string; size: number }>> {
  const files: Array<{ name: string; content: string; size: number }> = [];
  const allowedExtensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.css'];
  const ignoreDirs = ['node_modules', '.git', 'dist', 'build', '.ultralight'];

  async function walk(path: string, base: string) {
    for await (const entry of Deno.readDir(path)) {
      const fullPath = `${path}/${entry.name}`;
      const relativePath = base ? `${base}/${entry.name}` : entry.name;

      if (entry.isDirectory) {
        if (!ignoreDirs.includes(entry.name)) {
          await walk(fullPath, relativePath);
        }
      } else if (entry.isFile) {
        const ext = entry.name.substring(entry.name.lastIndexOf('.'));
        if (allowedExtensions.includes(ext)) {
          const content = await Deno.readTextFile(fullPath);
          files.push({
            name: relativePath,
            content,
            size: content.length,
          });
        }
      }
    }
  }

  await walk(dir, '');
  return files;
}

// Run main
main();
