/**
 * Ultralight local MCP bridge (stdio ↔ HTTP).
 *
 * The Ultralight platform MCP is server-side code on the Worker; there is no
 * portable MCP server to run locally. This bridge is a thin stdio MCP server
 * that a computer-access agent (Claude Code, Claude Desktop, Cursor, …) mounts,
 * and which forwards every tools/call to the remote platform endpoint
 * (https://api.ultralightagent.com/mcp/platform) with the user's ul_ Bearer
 * token. It NEVER re-declares the platform's tools — it calls remote tools/list
 * and re-advertises the catalog verbatim, so it can't drift from the platform.
 *
 * On top of the proxied platform tools it adds a small set of `local.*`
 * filesystem tools, scoped to the working directory, so the agent can read
 * source before ul.upload, write source returned by ul.download, and scaffold
 * files — the one genuine "direct computer access" capability the remote MCP
 * can't offer.
 *
 * Pure Node (no Deno). Only dependency: @modelcontextprotocol/sdk.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  realpathSync,
} from 'fs';
import {
  resolve,
  join,
  relative,
  isAbsolute,
  dirname,
  sep,
} from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ─── Auth / config resolution ────────────────────────────────────────────
// Token is read from ~/.ultralight/config.json (written by `setup`) so it is
// never duplicated into client MCP config files. Env vars override.
const DEFAULT_API_URL = 'https://api.ultralightagent.com';
// Old hosts that older CLI configs may still pin — rewrite to the current one
// (mirrors cli/config.ts LEGACY_API_URLS) so upgraders aren't left on a dead API.
const LEGACY_API_URLS = new Set([
  'https://api.ultralight.dev',
  'https://ultralight-api-iikqz.ondigitalocean.app',
  'https://ultralight-api.rgn4jz429m.workers.dev',
]);

function loadAuth() {
  let token = process.env.GALACTIC_TOKEN || process.env.ULTRALIGHT_TOKEN ||
    process.env.ULTRALIGHT_API_TOKEN || null;
  let apiUrl = process.env.ULTRALIGHT_API_URL || null;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.ultralight', 'config.json'), 'utf-8'));
    if (!token && cfg?.auth?.token) token = cfg.auth.token;
    if (!apiUrl && cfg?.api_url) apiUrl = cfg.api_url;
  } catch {
    // no config file — fall back to env / defaults
  }
  apiUrl = (apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  if (LEGACY_API_URLS.has(apiUrl)) apiUrl = DEFAULT_API_URL;
  return { token, apiUrl };
}

// ─── Filesystem confinement ──────────────────────────────────────────────
// All local.* tools are rooted at the working directory (where the agent
// launched the bridge), never allowed to escape it.
const FS_ROOT = resolve(process.env.ULTRALIGHT_FS_ROOT || process.cwd());
// Canonical (symlink-resolved) root. Containment is checked against this so a
// symlink can't lexically appear inside the root while pointing outside it.
let REAL_ROOT = FS_ROOT;
try {
  REAL_ROOT = realpathSync(FS_ROOT);
} catch {
  // root doesn't resolve (shouldn't happen for cwd) — fall back to lexical root
}

function escapes(root, abs) {
  const rel = relative(root, abs);
  return rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

// Resolve a caller path and confine it to REAL_ROOT, defeating symlink escapes.
// resolve()/relative() are purely lexical and do NOT follow symlinks, so we
// additionally realpath the longest existing ancestor (and the leaf, if it
// exists) and re-check containment against the canonical root.
function safePath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('`path` is required');
  }
  const abs = isAbsolute(p) ? resolve(p) : resolve(REAL_ROOT, p);
  if (escapes(REAL_ROOT, abs)) {
    throw new Error(`path "${p}" escapes the working directory (${REAL_ROOT})`);
  }
  // Realpath the deepest component that already exists (the leaf for reads,
  // an ancestor dir for not-yet-created writes). Any symlink along that
  // existing prefix that points outside the root is then caught.
  let existing = abs;
  while (!existsSync(existing) && dirname(existing) !== existing) {
    existing = dirname(existing);
  }
  let realExisting;
  try {
    realExisting = realpathSync(existing);
  } catch {
    realExisting = existing;
  }
  if (escapes(REAL_ROOT, realExisting)) {
    throw new Error(`path "${p}" resolves outside the working directory via a symlink`);
  }
  return abs;
}
function relDisplay(abs) {
  const r = relative(REAL_ROOT, abs);
  return r || '.';
}

// ─── Remote JSON-RPC (stateless POST, no session/SSE) ──────────────────────
let rpcId = 0;
const RPC_TIMEOUT_MS = Number(process.env.ULTRALIGHT_TIMEOUT_MS) || 30000;
async function rpc(apiUrl, token, method, params) {
  let res;
  try {
    res = await fetch(`${apiUrl}/mcp/platform`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: params ?? {} }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`platform ${method} timed out after ${RPC_TIMEOUT_MS}ms (${apiUrl})`);
    }
    throw new Error(`platform ${method} request failed: ${err?.message || err} (${apiUrl})`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint = res.status === 401
      ? ' — token invalid or expired; run `ultralightagent setup --token ul_...`'
      : '';
    throw new Error(`platform ${method} failed: HTTP ${res.status}${hint}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  const json = await res.json();
  if (json.error) {
    throw new Error(`platform ${method} error: ${json.error.message || JSON.stringify(json.error)}`);
  }
  return json.result;
}

// ─── Local filesystem tools ────────────────────────────────────────────────
const LOCAL_TOOLS = [
  {
    name: 'local.read_file',
    description:
      "Read a UTF-8 text file from the agent's working directory. Use to gather source files before deploying with ul.upload, or to inspect files written by ul.download. Paths are relative to the directory where the agent runs.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path relative to the working directory.' } },
      required: ['path'],
    },
  },
  {
    name: 'local.write_file',
    description:
      'Write a UTF-8 text file under the working directory (parent directories are created). Use to save source returned by ul.download, or to scaffold files you will then deploy with ul.upload.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the working directory.' },
        content: { type: 'string', description: 'Full file contents to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'local.list_dir',
    description: 'List the files and subdirectories of a directory under the working directory.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path relative to the working directory (defaults to ".").' } },
    },
  },
  {
    name: 'local.make_dir',
    description: 'Create a directory (recursively) under the working directory.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path relative to the working directory.' } },
      required: ['path'],
    },
  },
];

function asText(t) {
  return { content: [{ type: 'text', text: t }] };
}

// Keep only well-formed tool definitions before re-advertising the remote
// catalog, so one malformed platform entry can't fail a strict client's
// tools/list validation (which would also drop the local.* tools).
function normalizeRemoteTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t && typeof t.name === 'string' && t.name.length > 0)
    .map((t) => {
      const schema = t.inputSchema && typeof t.inputSchema === 'object'
        ? t.inputSchema
        : { type: 'object' };
      return { ...t, inputSchema: schema };
    });
}

function handleLocal(name, args) {
  switch (name) {
    case 'local.read_file': {
      const abs = safePath(args.path);
      return asText(readFileSync(abs, 'utf-8'));
    }
    case 'local.write_file': {
      const abs = safePath(args.path);
      const content = String(args.content ?? '');
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return asText(`Wrote ${Buffer.byteLength(content)} bytes to ${relDisplay(abs)}`);
    }
    case 'local.list_dir': {
      const abs = safePath(args.path || '.');
      const entries = readdirSync(abs, { withFileTypes: true })
        .map((d) => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file' }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return asText(JSON.stringify(entries, null, 2));
    }
    case 'local.make_dir': {
      const abs = safePath(args.path);
      mkdirSync(abs, { recursive: true });
      return asText(`Created ${relDisplay(abs)}`);
    }
    default:
      throw new Error(`unknown local tool: ${name}`);
  }
}

// ─── Bridge entry point ────────────────────────────────────────────────────
export async function runMcpBridge() {
  const version = readVersion();
  const { token, apiUrl } = loadAuth();

  if (!token) {
    process.stderr.write(
      '[ultralightagent] No API token found — serving local filesystem tools only. ' +
        'Run `ultralightagent setup --token ul_...` (or set ULTRALIGHT_TOKEN) to enable platform tools.\n',
    );
  }

  // Cache the remote catalog after the first successful fetch so we don't
  // re-hit the platform on every tools/list.
  let remoteToolsCache = null;
  async function remoteTools() {
    if (!token) return [];
    if (remoteToolsCache) return remoteToolsCache;
    try {
      const result = await rpc(apiUrl, token, 'tools/list', {});
      // Cache ONLY on success, so a transient failure on the first call
      // (network blip, 5xx, token-rotation 401) doesn't permanently strip the
      // platform catalog for the session — the next tools/list will retry.
      remoteToolsCache = normalizeRemoteTools(result?.tools);
      return remoteToolsCache;
    } catch (err) {
      process.stderr.write(`[ultralightagent] Could not load platform tools (will retry on next tools/list): ${err.message}\n`);
      return [];
    }
  }

  const server = new Server(
    { name: 'ultralightagent', version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const remote = await remoteTools();
    return { tools: [...remote, ...LOCAL_TOOLS] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params?.name;
    const args = req.params?.arguments ?? {};
    try {
      if (typeof name === 'string' && name.startsWith('local.')) {
        return handleLocal(name, args);
      }
      if (!token) {
        return {
          content: [{ type: 'text', text: 'Not authenticated. Run `ultralightagent setup --token ul_...` to enable platform tools.' }],
          isError: true,
        };
      }
      const result = await rpc(apiUrl, token, 'tools/call', { name, arguments: args });
      // The platform is itself an MCP server, so its tools/call result is
      // already a CallToolResult ({ content: [...] }). Pass it through; wrap
      // defensively if a tool ever returns a bare value.
      if (result && Array.isArray(result.content)) return result;
      return asText(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    } catch (err) {
      return { content: [{ type: 'text', text: String(err?.message || err) }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[ultralightagent] MCP bridge ready — ${token ? 'authenticated' : 'local-only'}; ` +
      `api=${apiUrl}; fs-root=${FS_ROOT}\n`,
  );
}
