#!/usr/bin/env node
import {
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const gateway = "https://galactic.internal/v1";
const tokenFile = "/run/galactic/job-token";
const workspaceRoot = realpathSync("/workspace");
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

function assertUnderWorkspace(path) {
  const lexical = relative(workspaceRoot, path);
  if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new Error("artifact path escapes /workspace");
  }
}

function rejectSymlinkSegments(path) {
  const lexical = relative(workspaceRoot, path);
  let cursor = workspaceRoot;
  for (const segment of lexical.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error("artifact path may not traverse a symlink");
    }
  }
}

function workspacePath(input) {
  if (typeof input !== "string" || input.length < 1 || input.length > 1024 || /[\0\r\n]/.test(input)) {
    throw new Error("artifact path is invalid");
  }
  const absolute = isAbsolute(input) ? resolve(input) : resolve(workspaceRoot, input);
  assertUnderWorkspace(absolute);
  rejectSymlinkSegments(absolute);
  let existing = absolute;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  assertUnderWorkspace(realpathSync(existing));
  return absolute;
}

function boundedBody(stream, maximum) {
  let seen = 0;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maximum) {
        controller.error(new Error("artifact exceeds the 100 MiB body limit"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

async function sha256File(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(path, {
    flags: constants.O_RDONLY | constants.O_NOFOLLOW,
  });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function artifactIdempotencyKey(name, size, sha256) {
  const bytes = createHash("sha256")
    .update(`gx-artifact-v1\0${name}\0${size}\0${sha256}`)
    .digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function token() {
  let value;
  try {
    value = readFileSync(tokenFile, "utf8").trim();
  } catch {
    throw new Error(`Galactic job token is unavailable at ${tokenFile}`);
  }
  if (!value || value.length > 16_384 || /[\r\n\0]/.test(value)) {
    throw new Error("Galactic job token file is invalid");
  }
  return value;
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${token()}`);
  headers.set("accept", "application/json");
  const response = await fetch(`${gateway}${path}`, { ...options, headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Galactic gateway returned ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
  }
  return response;
}

async function jsonRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await request(path, { ...options, headers });
  return response.status === 204 ? null : await response.json();
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(exitCode = 0) {
  process.stderr.write(`gx — Galactic's lease-scoped compute phone line

Usage:
  gx budget
  gx receipt
  gx artifacts pull <artifact-id> [destination]
  gx artifacts push <path> [logical-name]
  gx platform tools
  gx platform call <tool-name> [json-arguments]
  gx mcp

The CLI reads a short-lived job token from ${tokenFile}. It never reads a
human or Agent bearer, and every platform call is re-authorized server-side.\n`);
  process.exitCode = exitCode;
}

async function pullArtifact(id, destination) {
  if (!id) throw new Error("artifact id is required");
  const response = await request(`/artifacts/${encodeURIComponent(id)}`);
  if (!response.body) throw new Error("artifact response had no body");
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_ARTIFACT_BYTES) {
    throw new Error("artifact exceeds the 100 MiB body limit");
  }
  const output = workspacePath(
    destination || response.headers.get("x-galactic-artifact-name") || id,
  );
  await pipeline(
    Readable.fromWeb(boundedBody(response.body, MAX_ARTIFACT_BYTES)),
    createWriteStream(output, {
      flags: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
        constants.O_NOFOLLOW,
      mode: 0o600,
    }),
  );
  print({ artifact_id: id, path: output });
}

async function pushArtifact(file, logicalName) {
  if (!file) throw new Error("artifact path is required");
  const path = workspacePath(file);
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error("artifact push currently accepts files only");
  if (stats.size > MAX_ARTIFACT_BYTES) throw new Error("artifact exceeds the 100 MiB body limit");
  if (
    logicalName !== undefined &&
    (typeof logicalName !== "string" || logicalName.length > 256 || /[\0\r\n]/.test(logicalName))
  ) throw new Error("logical artifact name is invalid");
  const sha256 = await sha256File(path);
  const name = logicalName || file;
  const query = new URLSearchParams({ name });
  const response = await request(`/artifacts?${query}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(stats.size),
      "x-galactic-sha256": sha256,
      "x-galactic-idempotency-key": artifactIdempotencyKey(
        name,
        stats.size,
        sha256,
      ),
    },
    body: Readable.toWeb(createReadStream(path, {
      flags: constants.O_RDONLY | constants.O_NOFOLLOW,
    })),
    duplex: "half",
  });
  print(await response.json());
}

async function platformRpc(method, params) {
  const result = await jsonRequest("/mcp/platform", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  if (result?.error) throw new Error(result.error.message || JSON.stringify(result.error));
  return result?.result;
}

async function runMcp() {
  // This bridge is baked with the image and knows only lease auth. Do not
  // delegate to an independently published CLI version: an older package can
  // consult ~/.galactic or fall back to the public platform endpoint.
  const child = spawn(process.execPath, ["/opt/galactic/bridge/gx-mcp.mjs"], {
    stdio: "inherit",
    env: {
      HOME: "/tmp/galactic-home",
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: "/tmp",
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
      SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    },
  });
  await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`MCP bridge terminated by ${signal}`));
      else if (code === 0) resolvePromise();
      else reject(new Error(`MCP bridge exited with code ${code}`));
    });
  });
}

async function main() {
  const [command, action, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") return usage();
  if (command === "budget") return print(await jsonRequest("/budget"));
  if (command === "receipt") return print(await jsonRequest("/receipts/current"));
  if (command === "artifacts" && action === "pull") return await pullArtifact(args[0], args[1]);
  if (command === "artifacts" && action === "push") return await pushArtifact(args[0], args[1]);
  if (command === "platform" && action === "tools") return print(await platformRpc("tools/list", {}));
  if (command === "platform" && action === "call") {
    if (!args[0]) throw new Error("platform tool name is required");
    const toolArgs = args[1] ? JSON.parse(args[1]) : {};
    return print(await platformRpc("tools/call", { name: args[0], arguments: toolArgs }));
  }
  if (command === "mcp" && action === undefined) return await runMcp();
  usage(2);
}

main().catch((error) => {
  process.stderr.write(`gx: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
