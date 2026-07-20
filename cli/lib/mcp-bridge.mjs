/**
 * Galactic local MCP bridge (stdio ↔ HTTP).
 *
 * The Galactic platform MCP is server-side code on the Worker; there is no
 * portable MCP server to run locally. This bridge is a thin stdio MCP server
 * that a computer-access agent (Claude Code, Claude Desktop, Cursor, …) mounts,
 * and which forwards every tools/call to the remote platform endpoint
 * (https://api.connectgalactic.com/mcp/platform) with the user's gx_ Bearer
 * token. It NEVER re-declares the platform's tools — it calls remote tools/list
 * and re-advertises the catalog verbatim, so it can't drift from the platform.
 *
 * On top of the proxied platform tools it adds a small set of `local.*`
 * filesystem tools, scoped to the working directory, so the agent can read
 * source before gx.upload, write source returned by gx.download, and scaffold
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
import { fileURLToPath } from 'url';
import { loadAuth } from './job-context.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ─── Filesystem confinement ──────────────────────────────────────────────
// All local.* tools are rooted at the working directory (where the agent
// launched the bridge), never allowed to escape it.
const FS_ROOT = resolve(process.env.GALACTIC_FS_ROOT || process.env.ULTRALIGHT_FS_ROOT || process.cwd());
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
const RPC_TIMEOUT_MS = Number(process.env.GALACTIC_TIMEOUT_MS || process.env.ULTRALIGHT_TIMEOUT_MS) || 30000;

// Single source of truth: fetch the LIVE platform skills/SDK guide and serve it
// as the MCP `initialize` instructions, so an Agent connecting through this
// bridge reads the same up-to-date guide as a direct connection (the website
// and direct MCP already render /api/skills). Best-effort — never block startup.
async function fetchPlatformSkills(apiUrl, jobMode) {
  // The v1 lease gateway intentionally exposes only scoped platform MCP and
  // lease utility routes. Do not probe an unscoped/public documentation route
  // from a body.
  if (jobMode) return undefined;
  try {
    const url = new URL('/api/skills', apiUrl).toString();
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const text = await res.text();
      if (text && text.length > 200) return text;
    }
  } catch { /* offline / transient — fall through to no instructions */ }
  return undefined;
}
async function rpc(apiUrl, token, method, params, jobMode = false) {
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
      ? jobMode
        ? ' — compute lease token invalid or expired'
        : ' — token invalid or expired; run `galacticconnection setup --token gx_...`'
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
      "Read a UTF-8 text file from the agent's working directory. Use to gather source files before deploying with gx.upload, or to inspect files written by gx.download. Paths are relative to the directory where the agent runs.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path relative to the working directory.' } },
      required: ['path'],
    },
  },
  {
    name: 'local.write_file',
    description:
      'Write a UTF-8 text file under the working directory (parent directories are created). Use to save source returned by gx.download, or to scaffold files you will then deploy with gx.upload.',
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
  const { token, apiUrl, jobMode } = loadAuth();

  if (!token) {
    if (jobMode) {
      throw new Error('Galactic Compute job authentication is unavailable');
    }
    process.stderr.write(
      '[galacticconnection] No API token found — serving local filesystem tools only. ' +
        'Run `galacticconnection setup --token gx_...` (or set GALACTIC_TOKEN) to enable platform tools.\n',
    );
  }

  // Cache the remote catalog after the first successful fetch so we don't
  // re-hit the platform on every tools/list.
  let remoteToolsCache = null;
  async function remoteTools() {
    if (!token) return [];
    if (remoteToolsCache) return remoteToolsCache;
    try {
      const result = await rpc(apiUrl, token, 'tools/list', {}, jobMode);
      // Cache ONLY on success, so a transient failure on the first call
      // (network blip, 5xx, token-rotation 401) doesn't permanently strip the
      // platform catalog for the session — the next tools/list will retry.
      remoteToolsCache = normalizeRemoteTools(result?.tools);
      return remoteToolsCache;
    } catch (err) {
      process.stderr.write(`[galacticconnection] Could not load platform tools (will retry on next tools/list): ${err.message}\n`);
      return [];
    }
  }

  const instructions = await fetchPlatformSkills(apiUrl, jobMode);
  const server = new Server(
    { name: 'galacticagent', version },
    {
      capabilities: { tools: {} },
      ...(instructions ? { instructions } : {}),
    },
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
          content: [{ type: 'text', text: 'Not authenticated. Run `galacticconnection setup --token ul_...` to enable platform tools.' }],
          isError: true,
        };
      }
      const result = await rpc(apiUrl, token, 'tools/call', { name, arguments: args }, jobMode);
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
    `[galacticconnection] MCP bridge ready — ${jobMode ? 'compute-job' : token ? 'authenticated' : 'local-only'}; ` +
      `api=${apiUrl}; fs-root=${FS_ROOT}\n`,
  );
}
