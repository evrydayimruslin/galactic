import { getEnv } from "../lib/env.ts";
import type {
  VersionMetadata,
  VersionTestAttestationMetadata,
} from "../../shared/types/index.ts";
import {
  computeUploadSourceHash,
  signWithTrustSecret,
} from "./trust.ts";

const TOKEN_PREFIX = "gxt1";
const SIGNING_DOMAIN = "gx.test/v1";
const DEFAULT_TTL_SECONDS = 15 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 60 * 60;

export type TestAttestationMode = "deno_execution" | "gpu_validation";

export interface EncodedSourceFile {
  path: string;
  content: string;
  encoding?: string;
}

export interface DecodedSourceFile {
  path: string;
  content: string;
}

export interface TestAttestationClaims {
  schema_version: 1;
  purpose: "gx.test";
  attestation_id: string;
  user_id: string;
  source_hash: string;
  mode: TestAttestationMode;
  lint_error_count: 0;
  tested_at: string;
  expires_at: string;
}

export type TestAttestationVerificationReason =
  | "missing"
  | "malformed"
  | "bad_signature"
  | "expired"
  | "wrong_user"
  | "wrong_source"
  | "wrong_mode";

export type TestAttestationVerification =
  | { valid: true; claims: TestAttestationClaims }
  | { valid: false; reason: TestAttestationVerificationReason };

const MAX_SOURCE_PATH_LENGTH = 512;

function validateSourceFilePath(path: unknown, index: number): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`files[${index}].path is required`);
  }
  if (path !== path.trim()) {
    throw new Error(`Source file path must not contain surrounding whitespace: ${path}`);
  }
  if (path.length > MAX_SOURCE_PATH_LENGTH) {
    throw new Error(
      `Source file path exceeds ${MAX_SOURCE_PATH_LENGTH} characters: ${path}`,
    );
  }
  if (path.startsWith("/") || path.includes("\\")) {
    throw new Error(`Source file path must be a relative POSIX path: ${path}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error(`Source file path contains control characters: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Source file path is not canonical: ${path}`);
  }
  return path;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(
    normalized + "=".repeat((4 - normalized.length % 4) % 4),
  );
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function configuredTtlSeconds(): number {
  const configured = Number(getEnv("GX_TEST_ATTESTATION_TTL_SECONDS"));
  if (!Number.isFinite(configured)) return DEFAULT_TTL_SECONDS;
  return Math.max(
    MIN_TTL_SECONDS,
    Math.min(MAX_TTL_SECONDS, Math.floor(configured)),
  );
}

function isClaims(value: unknown): value is TestAttestationClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return claims.schema_version === 1 &&
    claims.purpose === "gx.test" &&
    typeof claims.attestation_id === "string" &&
    claims.attestation_id.length > 0 &&
    typeof claims.user_id === "string" &&
    claims.user_id.length > 0 &&
    typeof claims.source_hash === "string" &&
    /^[a-f0-9]{64}$/.test(claims.source_hash) &&
    (claims.mode === "deno_execution" || claims.mode === "gpu_validation") &&
    claims.lint_error_count === 0 &&
    typeof claims.tested_at === "string" &&
    Number.isFinite(Date.parse(claims.tested_at)) &&
    typeof claims.expires_at === "string" &&
    Number.isFinite(Date.parse(claims.expires_at));
}

/** Decode exactly the file bytes-as-text that gx.upload will deploy. */
export function decodeSourceFileSet(
  files: EncodedSourceFile[],
): DecodedSourceFile[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("files array is required and must not be empty");
  }
  const seen = new Set<string>();
  return files.map((file, index) => {
    if (!file || typeof file !== "object") {
      throw new Error(`files[${index}] must be an object`);
    }
    const path = validateSourceFilePath(file.path, index);
    if (seen.has(path)) throw new Error(`Duplicate source file path: ${path}`);
    seen.add(path);
    if (typeof file.content !== "string") {
      throw new Error(`files[${index}].content must be a string`);
    }
    const encoding = file.encoding || "text";
    if (encoding !== "text" && encoding !== "base64") {
      throw new Error(`Unsupported encoding for ${path}: ${encoding}`);
    }
    try {
      return {
        path,
        content: encoding === "base64" ? atob(file.content) : file.content,
      };
    } catch {
      throw new Error(`Invalid base64 content for ${path}`);
    }
  });
}

export function computeDecodedSourceHash(
  files: DecodedSourceFile[],
): Promise<string> {
  return computeUploadSourceHash(files);
}

export async function issueTestAttestation(input: {
  userId: string;
  sourceHash: string;
  mode: TestAttestationMode;
  now?: Date;
  ttlSeconds?: number;
}): Promise<{ token: string; claims: TestAttestationClaims }> {
  const now = input.now ?? new Date();
  const ttlSeconds = input.ttlSeconds ?? configuredTtlSeconds();
  const claims: TestAttestationClaims = {
    schema_version: 1,
    purpose: "gx.test",
    attestation_id: crypto.randomUUID(),
    user_id: input.userId,
    source_hash: input.sourceHash,
    mode: input.mode,
    lint_error_count: 0,
    tested_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
  const encoded = base64UrlEncode(JSON.stringify(claims));
  const signedMessage = `${SIGNING_DOMAIN}.${encoded}`;
  const signature = await signWithTrustSecret(signedMessage);
  return { token: `${TOKEN_PREFIX}.${encoded}.${signature}`, claims };
}

export async function verifyTestAttestation(input: {
  token: unknown;
  userId: string;
  sourceHash: string;
  mode: TestAttestationMode;
  now?: Date;
}): Promise<TestAttestationVerification> {
  if (typeof input.token !== "string" || input.token.length === 0) {
    return { valid: false, reason: "missing" };
  }
  if (input.token.length > 4096) return { valid: false, reason: "malformed" };
  const parts = input.token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    return { valid: false, reason: "malformed" };
  }
  const [, encoded, signature] = parts;
  if (!/^[a-f0-9]{64}$/.test(signature)) {
    return { valid: false, reason: "malformed" };
  }
  let claims: unknown;
  try {
    claims = JSON.parse(base64UrlDecode(encoded));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (!isClaims(claims)) return { valid: false, reason: "malformed" };

  const expected = await signWithTrustSecret(`${SIGNING_DOMAIN}.${encoded}`);
  if (!timingSafeEqual(expected, signature)) {
    return { valid: false, reason: "bad_signature" };
  }
  const now = input.now ?? new Date();
  if (Date.parse(claims.expires_at) <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  if (claims.user_id !== input.userId) {
    return { valid: false, reason: "wrong_user" };
  }
  if (claims.source_hash !== input.sourceHash) {
    return { valid: false, reason: "wrong_source" };
  }
  if (claims.mode !== input.mode) {
    return { valid: false, reason: "wrong_mode" };
  }
  return { valid: true, claims };
}

export function persistedTestAttestation(
  claims: TestAttestationClaims,
  verifiedAt = new Date(),
): VersionTestAttestationMetadata {
  return {
    schema_version: 1,
    attestation_id: claims.attestation_id,
    mode: claims.mode,
    source_hash: claims.source_hash,
    tested_at: claims.tested_at,
    token_expires_at: claims.expires_at,
    verified_at: verifiedAt.toISOString(),
  };
}

export function findPersistedTestAttestation(
  metadata: VersionMetadata[] | null | undefined,
  version: string,
): { entry: VersionMetadata; attestation: VersionTestAttestationMetadata } | null {
  if (!Array.isArray(metadata)) return null;
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = metadata[i];
    if (entry?.version !== version || !entry.test_attestation) continue;
    const attestation = entry.test_attestation;
    if (
      attestation.schema_version !== 1 ||
      !attestation.attestation_id ||
      !/^[a-f0-9]{64}$/.test(attestation.source_hash) ||
      !Number.isFinite(Date.parse(attestation.tested_at)) ||
      !Number.isFinite(Date.parse(attestation.token_expires_at)) ||
      !Number.isFinite(Date.parse(attestation.verified_at)) ||
      entry.source_hash !== attestation.source_hash
    ) {
      return null;
    }
    const expectedMode = entry.trust?.runtime === "gpu"
      ? "gpu_validation"
      : "deno_execution";
    if (attestation.mode !== expectedMode) return null;
    return { entry, attestation };
  }
  return null;
}
