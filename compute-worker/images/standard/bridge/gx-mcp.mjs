#!/usr/bin/env node

/**
 * Job-only stdio MCP bridge for a Galactic Compute body.
 *
 * There is intentionally no persistent-config, environment-token, public-API,
 * or login fallback in this file. Every remote request uses the current
 * lease's token file and the private intercepted gateway.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const TOKEN_FILE = "/run/galactic/job-token";
const GATEWAY = "https://galactic.internal/v1";
const FS_ROOT = realpathSync("/workspace");
const RPC_TIMEOUT_MS = 30_000;
const MAX_LOCAL_READ_BYTES = 1024 * 1024;
const MAX_LOCAL_WRITE_BYTES = 10 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 1_000;

function jobToken() {
  let value;
  try {
    value = readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    throw new Error(`Galactic Compute job token is unavailable at ${TOKEN_FILE}`);
  }
  if (!value || value.length > 16_384 || /[\r\n\0]/.test(value)) {
    throw new Error("Galactic Compute job token file is invalid");
  }
  return value;
}

function safePath(input) {
  if (
    typeof input !== "string" || input.length === 0 || input.length > 1024 ||
    /[\0\r\n]/.test(input)
  ) {
    throw new Error("path is required");
  }
  const absolute = isAbsolute(input) ? resolve(input) : resolve(FS_ROOT, input);
  const lexical = relative(FS_ROOT, absolute);
  if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new Error("path escapes /workspace");
  }
  let existing = absolute;
  while (!existsSync(existing) && dirname(existing) !== existing) {
    existing = dirname(existing);
  }
  const resolvedExisting = realpathSync(existing);
  const real = relative(FS_ROOT, resolvedExisting);
  if (real === ".." || real.startsWith(`..${sep}`) || isAbsolute(real)) {
    throw new Error("path resolves outside /workspace");
  }
  let cursor = FS_ROOT;
  for (const segment of lexical.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error("path may not traverse a symlink");
    }
  }
  return absolute;
}

function readLocalFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_LOCAL_READ_BYTES) {
      throw new Error("local.read_file is limited to 1 MiB");
    }
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

async function rpc(method, params) {
  const response = await fetch(`${GATEWAY}/mcp/platform`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jobToken()}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: params ?? {},
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Galactic gateway ${method} failed (${response.status})${
        detail ? `: ${detail.slice(0, 300)}` : ""
      }`,
    );
  }
  const envelope = await response.json();
  if (envelope?.error) {
    throw new Error(envelope.error.message || JSON.stringify(envelope.error));
  }
  return envelope?.result;
}

const LOCAL_TOOLS = [
  {
    name: "local.read_file",
    description: "Read a UTF-8 file under /workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "local.write_file",
    description: "Write a UTF-8 file under /workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "local.list_dir",
    description: "List a directory under /workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
    },
  },
  {
    name: "local.make_dir",
    description: "Create a directory under /workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

function text(value) {
  return { content: [{ type: "text", text: value }] };
}

function callLocal(name, args) {
  if (name === "local.read_file") {
    return text(readLocalFile(safePath(args.path)));
  }
  if (name === "local.write_file") {
    const path = safePath(args.path);
    const content = String(args.content ?? "");
    if (Buffer.byteLength(content) > MAX_LOCAL_WRITE_BYTES) {
      throw new Error("local.write_file is limited to 10 MiB");
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, {
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC |
        constants.O_NOFOLLOW,
      mode: 0o600,
    });
    return text(`Wrote ${Buffer.byteLength(content)} bytes`);
  }
  if (name === "local.list_dir") {
    const rawEntries = readdirSync(safePath(args.path || "."), {
      withFileTypes: true,
    });
    if (rawEntries.length > MAX_DIRECTORY_ENTRIES) {
      throw new Error("local.list_dir is limited to 1000 entries");
    }
    const entries = rawEntries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : "file",
    })).sort((left, right) => left.name.localeCompare(right.name));
    return text(JSON.stringify(entries, null, 2));
  }
  if (name === "local.make_dir") {
    mkdirSync(safePath(args.path), { recursive: true });
    return text("Directory created");
  }
  throw new Error("unknown local tool");
}

const server = new Server(
  { name: "galactic-compute", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
let remoteTools;

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!remoteTools) {
    const result = await rpc("tools/list", {});
    remoteTools = Array.isArray(result?.tools)
      ? result.tools.slice(0, 128).filter((tool) =>
        tool && typeof tool.name === "string" && tool.name.length > 0
      )
      : [];
  }
  return { tools: [...remoteTools, ...LOCAL_TOOLS] };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  try {
    if (typeof name === "string" && name.startsWith("local.")) {
      return callLocal(name, args);
    }
    const result = await rpc("tools/call", { name, arguments: args });
    return result && Array.isArray(result.content)
      ? result
      : text(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: error instanceof Error ? error.message : "Compute gateway failure",
      }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
process.stderr.write(`[gx] lease MCP ready; gateway=${GATEWAY}; fs-root=${FS_ROOT}\n`);
