import type { App, HealthWindows, VersionMetadata, VersionTrustMetadata } from "../../shared/types/index.ts";
import type { AppManifest } from "../../shared/contracts/manifest.ts";
import { getManifestEnvVars } from "../../shared/contracts/manifest.ts";
import { getEnv } from "../lib/env.ts";
import { parseAppManifest, resolveAppEnvSchema } from "./app-settings.ts";
import { emptyHealth } from "./app-health.ts";

export interface TrustArtifactFile {
  name: string;
  content: Uint8Array | string;
}

export interface ManifestDiff {
  functions: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  permissions: {
    added: string[];
    removed: string[];
  };
  secrets: {
    added: string[];
    removed: string[];
    changed: string[];
  };
}

export interface TrustCard {
  schema_version: 1;
  signed_manifest: boolean;
  signer: string | null;
  signed_at: string | null;
  version: string | null;
  runtime: string;
  manifest_hash: string | null;
  description_hash: string | null;
  artifact_hash: string | null;
  // Per-file SHA256 map, so a downloading agent can recompute each file's hash
  // and confirm the code it read is the code that was published.
  artifact_hashes: Record<string, string>;
  artifact_count: number;
  permissions: string[];
  capability_summary: {
    ai: boolean;
    network: boolean;
    storage: boolean;
    memory: boolean;
    gpu: boolean;
  };
  required_secrets: string[];
  per_user_secrets: string[];
  access: {
    visibility: App["visibility"];
    download_access: App["download_access"];
  };
  // Open code: the source is downloadable (download_access === "public"), so an
  // Agent can read it AND verify each file against the signed artifact_hashes via
  // gx.verify before calling. Mere downloadability is not safety — it gains
  // ranking weight only when combined with hash-verified reads (Phase 4).
  open_code: boolean;
  // Identity: true iff the publisher's Stripe Connect account has payouts
  // enabled (a real, KYC'd, payable entity stands behind this Agent). Derived,
  // never the raw Connect snapshot.
  publisher_verified: boolean;
  // Binary call-success health over rolling windows, owner-self + free calls
  // excluded. "no_data" when a window has too few paid calls to judge.
  health: HealthWindows;
  reliability?: unknown;
  execution_receipts: {
    enabled: true;
    field: "receipt_id";
    backing_log: "mcp_call_logs.id";
  };
}

const encoder = new TextEncoder();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function bytesFromContent(content: Uint8Array | string): Uint8Array {
  return typeof content === "string" ? encoder.encode(content) : content;
}

function arrayBufferFromContent(content: Uint8Array | string): ArrayBuffer {
  const bytes = bytesFromContent(content);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(content: Uint8Array | string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", arrayBufferFromContent(content)));
}

function resolveTrustSigningSecret(): string {
  const dedicated = getEnv("LIGHT_TRUST_SIGNING_SECRET") ||
    getEnv("TRUST_SIGNING_SECRET");
  if (dedicated) return dedicated;
  // Fail closed in EVERY deployed environment (production, staging, …): never
  // sign trust artifacts with the DB service-role key (the old fallback —
  // key-reuse with the god key) or a public dev constant. A dedicated
  // TRUST_SIGNING_SECRET MUST be set before deploy; the dev default is only for
  // local/test (ENVIRONMENT unset, "development", or "test").
  const environment = getEnv("ENVIRONMENT");
  if (environment && environment !== "development" && environment !== "test") {
    throw new Error(
      "TRUST_SIGNING_SECRET (or LIGHT_TRUST_SIGNING_SECRET) must be set in " +
        `non-development environments (ENVIRONMENT=${environment})`,
    );
  }
  return "development-trust-signing-secret";
}

async function hmacSha256Hex(content: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(resolveTrustSigningSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(content)));
}

// Sign a message with the platform trust secret (HMAC-SHA256). Exported so the
// executed-bundle attestation reuses the SAME secret resolution + fail-closed
// behavior as the version trust signature.
export function signWithTrustSecret(message: string): Promise<string> {
  return hmacSha256Hex(message);
}

// Constant-time equality for two hex digests (avoid leaking position of the
// first mismatching byte). Lengths are public; content comparison is timed-safe.
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Recompute the HMAC over the stored metadata (minus its signature) and confirm
// it matches the embedded signature — i.e. the artifact_hashes / description_hash
// / manifest_hash the platform published for this version were signed by THIS
// platform and have not been altered since. The signature is symmetric (HMAC),
// so only the platform (holder of the trust secret) can run this check; an Agent
// gets the verdict via gx.verify rather than verifying the signature itself.
export async function verifyVersionTrustSignature(
  metadata: VersionTrustMetadata | null | undefined,
): Promise<boolean> {
  if (!metadata?.signature?.signature) return false;
  if (metadata.signature.algorithm !== "HMAC-SHA256") return false;
  const { signature, ...unsigned } = metadata;
  try {
    const expected = await hmacSha256Hex(canonicalJson(unsigned));
    return timingSafeEqualHex(expected, signature.signature);
  } catch {
    // Fail-closed secret resolution (non-dev without TRUST_SIGNING_SECRET) =>
    // cannot verify => not valid.
    return false;
  }
}

export function getManifestPermissions(manifest: AppManifest | string | null | undefined): string[] {
  const parsed = parseAppManifest(manifest);
  if (!Array.isArray(parsed?.permissions)) return [];
  return [...new Set(parsed.permissions.filter((permission) => typeof permission === "string"))];
}

export function getManifestEntrypoints(manifest: AppManifest | string | null | undefined): string[] {
  const parsed = parseAppManifest(manifest);
  const entrypoints: string[] = [];
  if (parsed?.entry?.functions) entrypoints.push(parsed.entry.functions);
  if (parsed?.functions) entrypoints.push(...Object.keys(parsed.functions));
  return [...new Set(entrypoints)];
}

function getSecretKeys(manifest: AppManifest | string | null | undefined): {
  requiredSecrets: string[];
  perUserSecrets: string[];
} {
  const parsed = parseAppManifest(manifest);
  const envVars = parsed ? getManifestEnvVars(parsed) : null;
  if (!envVars) {
    return { requiredSecrets: [], perUserSecrets: [] };
  }

  const requiredSecrets: string[] = [];
  const perUserSecrets: string[] = [];
  for (const [key, entry] of Object.entries(envVars)) {
    if (entry.required) requiredSecrets.push(key);
    if ((entry.scope || entry.type) === "per_user") perUserSecrets.push(key);
  }
  return {
    requiredSecrets: requiredSecrets.sort(),
    perUserSecrets: perUserSecrets.sort(),
  };
}

export function generateGpuManifest(input: {
  name: string;
  version: string;
  description?: string | null;
  exports: string[];
}): AppManifest {
  const functions: NonNullable<AppManifest["functions"]> = {};
  for (const fnName of input.exports.length > 0 ? input.exports : ["main"]) {
    functions[fnName] = {
      description: `GPU function ${fnName}`,
      parameters: {
        input: {
          type: "object",
          description: "Function input payload",
          required: false,
        },
      },
      returns: {
        type: "object",
        description: "Function result",
      },
    };
  }

  return {
    name: input.name,
    version: input.version,
    description: input.description || undefined,
    type: "mcp",
    entry: { functions: "main.py" },
    functions,
    permissions: ["gpu:execute"],
  };
}

// Canonical subject for the description hash: the app description + every
// function's description. Binding this into the signed block lets attestations
// be scoped to the exact descriptions a caller saw, and makes a description
// edit (a rug-pull/tool-poisoning vector) detectable as a hash change.
export function buildDescriptionHashInput(
  manifest: AppManifest | null,
): { app: string; functions: Record<string, string> } {
  const functions: Record<string, string> = {};
  for (const [name, fn] of Object.entries(manifest?.functions || {})) {
    functions[name] = typeof fn?.description === "string" ? fn.description : "";
  }
  return {
    app: typeof manifest?.description === "string" ? manifest.description : "",
    functions,
  };
}

export async function buildVersionTrustMetadata(input: {
  appId: string;
  version: string;
  runtime: string;
  manifest: AppManifest | string | null | undefined;
  files: TrustArtifactFile[];
  storageKey?: string;
}): Promise<VersionTrustMetadata> {
  const manifest = parseAppManifest(input.manifest);
  const manifestJson = manifest ? canonicalJson(manifest) : null;
  const manifestHash = manifestJson ? await sha256Hex(manifestJson) : null;
  const descriptionHash = await sha256Hex(
    canonicalJson(buildDescriptionHashInput(manifest)),
  );

  const artifactHashes: Record<string, string> = {};
  for (const file of [...input.files].sort((a, b) => a.name.localeCompare(b.name))) {
    artifactHashes[file.name] = await sha256Hex(file.content);
  }
  const artifactHash = await sha256Hex(canonicalJson(artifactHashes));
  const secrets = getSecretKeys(manifest);

  const unsigned = {
    schema_version: 1 as const,
    app_id: input.appId,
    version: input.version,
    runtime: input.runtime,
    manifest_hash: manifestHash,
    description_hash: descriptionHash,
    artifact_hash: artifactHash,
    artifact_hashes: artifactHashes,
    storage_key: input.storageKey,
    permissions: getManifestPermissions(manifest).sort(),
    entrypoints: getManifestEntrypoints(manifest).sort(),
    required_secrets: secrets.requiredSecrets,
    per_user_secrets: secrets.perUserSecrets,
  };

  return {
    ...unsigned,
    signature: {
      algorithm: "HMAC-SHA256",
      signer: "light-platform",
      signed_at: new Date().toISOString(),
      signature: await hmacSha256Hex(canonicalJson(unsigned)),
      key_hint: "platform",
    },
  };
}

export function buildVersionMetadataEntry(
  version: string,
  sizeBytes: number,
  trust: VersionTrustMetadata,
): VersionMetadata {
  return {
    version,
    size_bytes: sizeBytes,
    created_at: new Date().toISOString(),
    trust,
  };
}

export function appendVersionTrustMetadata(
  versionMetadata: VersionMetadata[] | null | undefined,
  entry: VersionMetadata,
): VersionMetadata[] {
  return [...(Array.isArray(versionMetadata) ? versionMetadata : []), entry];
}

export function getLatestVersionTrust(app: Pick<App, "current_version" | "version_metadata">): VersionTrustMetadata | null {
  const metadata = Array.isArray(app.version_metadata) ? app.version_metadata : [];
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = metadata[i];
    if (entry?.version === app.current_version && entry.trust) {
      return entry.trust;
    }
  }
  return null;
}

export function buildAppTrustCard(
  app: Pick<App, "current_version" | "runtime" | "manifest" | "version_metadata" | "visibility" | "download_access" | "env_schema">,
  options: { reliability?: unknown; publisher_verified?: boolean; health?: HealthWindows } = {},
): TrustCard {
  const trust = getLatestVersionTrust(app as Pick<App, "current_version" | "version_metadata">);
  const manifest = parseAppManifest(app.manifest);
  const permissions = trust?.permissions.length ? trust.permissions : getManifestPermissions(manifest).sort();
  const envSchema = resolveAppEnvSchema(app);
  const requiredSecrets = Object.entries(envSchema)
    .filter(([, entry]) => entry.required)
    .map(([key]) => key)
    .sort();
  const perUserSecrets = Object.entries(envSchema)
    .filter(([, entry]) => entry.scope === "per_user")
    .map(([key]) => key)
    .sort();

  return {
    schema_version: 1,
    signed_manifest: !!trust?.signature && !!trust.manifest_hash,
    signer: trust?.signature.signer || null,
    signed_at: trust?.signature.signed_at || null,
    version: app.current_version || trust?.version || null,
    runtime: app.runtime || "deno",
    manifest_hash: trust?.manifest_hash || null,
    description_hash: trust?.description_hash || null,
    artifact_hash: trust?.artifact_hash || null,
    artifact_hashes: trust?.artifact_hashes || {},
    artifact_count: trust ? Object.keys(trust.artifact_hashes).length : 0,
    permissions,
    capability_summary: {
      ai: permissions.includes("ai:call"),
      network: permissions.some((permission) => permission === "net:fetch" || permission === "net:connect" || permission.startsWith("net:")),
      storage: permissions.some((permission) => permission.startsWith("storage:")),
      memory: permissions.some((permission) => permission.startsWith("memory:")),
      gpu: permissions.includes("gpu:execute") || app.runtime === "gpu",
    },
    required_secrets: trust?.required_secrets.length ? trust.required_secrets : requiredSecrets,
    per_user_secrets: trust?.per_user_secrets.length ? trust.per_user_secrets : perUserSecrets,
    access: {
      visibility: app.visibility,
      download_access: app.download_access,
    },
    open_code: app.download_access === "public",
    publisher_verified: options.publisher_verified ?? false,
    health: options.health ?? emptyHealth(),
    ...(options.reliability !== undefined ? { reliability: options.reliability } : {}),
    execution_receipts: {
      enabled: true,
      field: "receipt_id",
      backing_log: "mcp_call_logs.id",
    },
  };
}

function namesFromFunctions(manifest: AppManifest | null): string[] {
  return Object.keys(manifest?.functions || {}).sort();
}

function changedFunctionNames(previous: AppManifest | null, next: AppManifest | null): string[] {
  const changed: string[] = [];
  const previousFunctions = previous?.functions || {};
  const nextFunctions = next?.functions || {};
  for (const name of Object.keys(previousFunctions)) {
    if (!nextFunctions[name]) continue;
    if (canonicalJson(previousFunctions[name]) !== canonicalJson(nextFunctions[name])) {
      changed.push(name);
    }
  }
  return changed.sort();
}

function diffKeys(previous: string[], next: string[]): { added: string[]; removed: string[] } {
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  return {
    added: next.filter((item) => !previousSet.has(item)).sort(),
    removed: previous.filter((item) => !nextSet.has(item)).sort(),
  };
}

export function diffManifests(previousManifest: unknown, nextManifest: unknown): ManifestDiff {
  const previous = parseAppManifest(previousManifest);
  const next = parseAppManifest(nextManifest);
  const previousSecrets = getSecretKeys(previous).requiredSecrets.concat(getSecretKeys(previous).perUserSecrets);
  const nextSecrets = getSecretKeys(next).requiredSecrets.concat(getSecretKeys(next).perUserSecrets);

  return {
    functions: {
      ...diffKeys(namesFromFunctions(previous), namesFromFunctions(next)),
      changed: changedFunctionNames(previous, next),
    },
    permissions: diffKeys(getManifestPermissions(previous).sort(), getManifestPermissions(next).sort()),
    secrets: {
      ...diffKeys([...new Set(previousSecrets)].sort(), [...new Set(nextSecrets)].sort()),
      changed: [],
    },
  };
}
