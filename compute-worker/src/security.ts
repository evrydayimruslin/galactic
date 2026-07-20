import type { ComputeControlPlaneBinding } from "./contracts";

const WORKSPACE_ROOT = "/workspace";
const SECRET_ROOT = "/run/galactic/secrets";
const TOOLPACK_ROOT = "/opt/galactic/packs";

const RESERVED_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "GALACTIC_AGENT_TOKEN",
  "GALACTIC_HUMAN_TOKEN",
  "GALACTIC_PLATFORM_KEY",
  "GALACTIC_API_KEY",
  "GALACTIC_GATEWAY_URL",
  "GALACTIC_JOB_TOKEN_FILE",
  "GALACTIC_RUN_ID",
  "GALACTIC_LEASE_ID",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const PRIVATE_GATEWAY_HOST = "galactic.internal";

export function assertUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) throw new Error(`${label} must be a UUID`);
  return value.toLowerCase();
}

export function assertSha256(value: string, label: string): string {
  if (!SHA256_RE.test(value)) throw new Error(`${label} must be sha256 hex`);
  return value.toLowerCase();
}

export function assertSafeName(value: string, label: string): string {
  if (!SAFE_NAME_RE.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function assertOpaqueId(value: string, label: string): string {
  if (!OPAQUE_ID_RE.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function workspacePath(relative: string): string {
  return confinedPath(WORKSPACE_ROOT, relative, "workspace path");
}

export function secretPath(relative: string): string {
  return confinedPath(SECRET_ROOT, relative, "secret file path");
}

export function toolpackPath(name: string, version: string): string {
  return `${TOOLPACK_ROOT}/${assertSafeName(name, "toolpack name")}/${
    assertSafeName(version, "toolpack version")
  }`;
}

function confinedPath(root: string, relative: string, label: string): string {
  if (typeof relative !== "string" || relative.length === 0 || relative.length > 1024) {
    throw new Error(`${label} is invalid`);
  }
  if (
    /[\u0000-\u001f\u007f]/.test(relative) || relative.startsWith("/") ||
    relative.includes("\\")
  ) {
    throw new Error(`${label} must be relative`);
  }
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} escapes its root`);
  }
  return `${root}/${segments.join("/")}`;
}

export function parentDirectory(path: string): string {
  const splitAt = path.lastIndexOf("/");
  return splitAt <= 0 ? "/" : path.slice(0, splitAt);
}

export function assertSecretEnvName(name: string): string {
  if (!ENV_NAME_RE.test(name)) throw new Error("secret environment name is invalid");
  if (RESERVED_ENV_NAMES.has(name) || name.startsWith("GALACTIC_INTERNAL_")) {
    throw new Error(`secret environment name ${name} is reserved`);
  }
  return name;
}

export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("command values cannot contain NUL");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function shellCommand(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error("argv must not be empty");
  return argv.map(shellQuote).join(" ");
}

export function artifactObjectKey(input: {
  accountId: string;
  agentId: string;
  runId: string;
  artifactId: string;
  index: number;
  name: string;
}): string {
  const basename = input.name.split("/").at(-1) || "artifact";
  const safeBasename = basename.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 96) || "artifact";
  return [
    "compute-v1",
    assertOpaqueId(input.accountId, "account id"),
    assertOpaqueId(input.agentId, "agent id"),
    assertUuid(input.runId, "run id"),
    "outputs",
    `${input.index}-${assertUuid(input.artifactId, "artifact id")}-${safeBasename}`,
  ].join("/");
}

export class BoundedText {
  readonly #limit: number;
  #value = "";
  #bytesSeen = 0;
  #bytesStored = 0;
  #truncated = false;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 0) throw new Error("invalid output limit");
    this.#limit = limit;
  }

  append(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.#bytesSeen += encoded.byteLength;
    const remaining = this.#limit - this.#bytesStored;
    if (remaining <= 0) {
      if (encoded.byteLength > 0) this.#truncated = true;
      return;
    }
    if (encoded.byteLength <= remaining) {
      this.#value += value;
      this.#bytesStored += encoded.byteLength;
      return;
    }
    // Never decode a partial UTF-8 sequence into U+FFFD: the replacement
    // character itself is three bytes and could make the retained text exceed
    // the byte ceiling. At most three bytes need to be backed off.
    let end = remaining;
    while (end > 0) {
      try {
        const prefix = new TextDecoder("utf-8", { fatal: true }).decode(
          encoded.slice(0, end),
        );
        this.#value += prefix;
        this.#bytesStored += end;
        break;
      } catch {
        end -= 1;
      }
    }
    this.#truncated = true;
  }

  get value(): string {
    return this.#value;
  }

  get bytesSeen(): number {
    return this.#bytesSeen;
  }

  get truncated(): boolean {
    return this.#truncated;
  }
}

export function redactError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return "unknown compute failure";
}

/**
 * Terminate a body's intercepted private-gateway request in trusted Worker
 * code. Identity headers are always derived from Sandbox context; every
 * body-supplied `x-galactic-*` value is discarded.
 */
export async function proxyComputeGateway(
  request: Request,
  binding: Pick<ComputeControlPlaneBinding, "fetch">,
  context: { containerId: string; className: string },
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" || url.hostname !== PRIVATE_GATEWAY_HOST ||
    !url.pathname.startsWith("/v1/")
  ) {
    return new Response("compute gateway route not found", { status: 404 });
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (
    !authorization.startsWith("Bearer ") ||
    authorization.slice("Bearer ".length).trim().length === 0 ||
    authorization.length > 16_391
  ) {
    return new Response("compute job token required", { status: 401 });
  }
  if (
    !context.containerId || !context.className ||
    context.containerId.length > 256 || context.className.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(context.containerId) ||
    !/^[A-Za-z][A-Za-z0-9._-]*$/.test(context.className)
  ) {
    return new Response("compute identity unavailable", { status: 503 });
  }

  // This is an allowlist, not a collection of known-bad proxy headers. The
  // body may declare artifact integrity/idempotency metadata, but it may not
  // supply identity, routing, client-IP, method-override, or other
  // platform-adjacent metadata.
  const headers = new Headers();
  for (const name of [
    "authorization",
    "accept",
    "content-type",
    "content-length",
    "range",
    "if-none-match",
    "x-galactic-idempotency-key",
    "x-galactic-sha256",
  ]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("x-galactic-container-id", context.containerId);
  headers.set("x-galactic-container-class", context.className);
  return await binding.fetch(new Request(request, { headers }));
}
