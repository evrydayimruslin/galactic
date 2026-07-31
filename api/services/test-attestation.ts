import { getEnv } from "../lib/env.ts";
import type {
  VersionMetadata,
  VersionTestAttestationMetadata,
  VersionTestAttestationMetadataV2,
  VersionTestQualificationMetadata,
} from "../../shared/types/index.ts";
import {
  canonicalJson,
  computeCanonicalUploadSourceHash,
  computeUploadSourceHash,
  sha256Hex,
  signWithTrustSecret,
  verifyVersionTrustSignature,
} from "./trust.ts";
import {
  bytesToBinaryString,
  decodeBase64Bytes,
  isBinarySourcePath,
} from "./source-file-content.ts";

const V1_TOKEN_PREFIX = "gxt1";
const V1_SIGNING_DOMAIN = "gx.test/v1";
const V2_TOKEN_PREFIX = "gxt2";
const V2_SIGNING_DOMAIN = "gx.test/v2";
const V1_MAX_TOKEN_LENGTH = 4096;
const V2_MAX_TOKEN_LENGTH = 8192;
const DEFAULT_TTL_SECONDS = 15 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 60 * 60;
const MAX_REVISION_LENGTH = 128;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export type TestAttestationMode = "deno_execution" | "gpu_validation";

export interface EncodedSourceFile {
  path: string;
  content: string;
  encoding?: string;
}

export interface DecodedSourceFile {
  path: string;
  content: string;
  /** Present only for byte-oriented artifacts; authoritative over `content`. */
  bytes?: Uint8Array;
}

interface TestAttestationCommonClaims {
  purpose: "gx.test";
  attestation_id: string;
  user_id: string;
  source_hash: string;
  mode: TestAttestationMode;
  lint_error_count: 0;
  tested_at: string;
  expires_at: string;
}

export interface TestAttestationClaimsV1 extends TestAttestationCommonClaims {
  schema_version: 1;
}

export type TestAttestationQualification = VersionTestQualificationMetadata;

export interface TestAttestationClaimsV2 extends TestAttestationCommonClaims {
  schema_version: 2;
  qualification: TestAttestationQualification;
}

export type TestAttestationClaims =
  | TestAttestationClaimsV1
  | TestAttestationClaimsV2;

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

function hasAsciiControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function validateSourceFilePath(path: unknown, index: number): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`files[${index}].path is required`);
  }
  if (path !== path.trim()) {
    throw new Error(
      `Source file path must not contain surrounding whitespace: ${path}`,
    );
  }
  if (path.length > MAX_SOURCE_PATH_LENGTH) {
    throw new Error(
      `Source file path exceeds ${MAX_SOURCE_PATH_LENGTH} characters: ${path}`,
    );
  }
  if (path.startsWith("/") || path.includes("\\")) {
    throw new Error(`Source file path must be a relative POSIX path: ${path}`);
  }
  if (hasAsciiControlCharacters(path)) {
    throw new Error(`Source file path contains control characters: ${path}`);
  }
  const segments = path.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
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

function isCommonClaims(
  value: unknown,
): value is TestAttestationCommonClaims & Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return claims.purpose === "gx.test" &&
    typeof claims.attestation_id === "string" &&
    claims.attestation_id.length > 0 &&
    typeof claims.user_id === "string" &&
    claims.user_id.length > 0 &&
    typeof claims.source_hash === "string" &&
    SHA256_HEX_PATTERN.test(claims.source_hash) &&
    (claims.mode === "deno_execution" || claims.mode === "gpu_validation") &&
    claims.lint_error_count === 0 &&
    typeof claims.tested_at === "string" &&
    Number.isFinite(Date.parse(claims.tested_at)) &&
    typeof claims.expires_at === "string" &&
    Number.isFinite(Date.parse(claims.expires_at));
}

function isClaimsV1(value: unknown): value is TestAttestationClaimsV1 {
  return isCommonClaims(value) &&
    value.schema_version === 1 &&
    hasExactlyKeys(value, [
      "schema_version",
      "purpose",
      "attestation_id",
      "user_id",
      "source_hash",
      "mode",
      "lint_error_count",
      "tested_at",
      "expires_at",
    ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isBoundedRevision(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REVISION_LENGTH &&
    value === value.trim() &&
    !hasAsciiControlCharacters(value);
}

function isQualification(
  value: unknown,
): value is TestAttestationQualification {
  if (!isRecord(value)) return false;
  if (
    !hasExactlyKeys(value, [
      "profile",
      "document_digest",
      "release_digest",
      "report_digest",
      "compiler_revision",
      "runtime_revision",
      "policy_revision",
      "cases",
      "functions",
      "effects",
    ]) ||
    value.profile !== "basic" ||
    typeof value.document_digest !== "string" ||
    !SHA256_HEX_PATTERN.test(value.document_digest) ||
    typeof value.release_digest !== "string" ||
    !SHA256_HEX_PATTERN.test(value.release_digest) ||
    typeof value.report_digest !== "string" ||
    !SHA256_HEX_PATTERN.test(value.report_digest) ||
    !isBoundedRevision(value.compiler_revision) ||
    !isBoundedRevision(value.runtime_revision) ||
    !isBoundedRevision(value.policy_revision) ||
    !isRecord(value.cases) ||
    !isRecord(value.functions) ||
    !isRecord(value.effects)
  ) {
    return false;
  }

  const cases = value.cases;
  const functions = value.functions;
  const effects = value.effects;
  if (
    !hasExactlyKeys(cases, [
      "declared",
      "required",
      "passed",
      "optional_failed",
    ]) ||
    !isSafeCount(cases.declared) ||
    !isSafeCount(cases.required) ||
    !isSafeCount(cases.passed) ||
    !isSafeCount(cases.optional_failed) ||
    cases.declared < 1 ||
    cases.required < 1 ||
    cases.required > cases.declared ||
    cases.passed < cases.required ||
    cases.passed > cases.declared ||
    cases.optional_failed !== cases.declared - cases.passed ||
    !hasExactlyKeys(functions, ["declared", "exercised"]) ||
    !isSafeCount(functions.declared) ||
    !isSafeCount(functions.exercised) ||
    functions.declared < 1 ||
    functions.exercised < 1 ||
    functions.exercised > functions.declared ||
    !hasExactlyKeys(effects, ["declared", "exercised", "untested"]) ||
    !isSafeCount(effects.declared) ||
    !isSafeCount(effects.exercised) ||
    !isSafeCount(effects.untested) ||
    effects.exercised > effects.declared ||
    effects.untested > effects.declared ||
    effects.exercised + effects.untested !== effects.declared
  ) {
    return false;
  }
  return true;
}

function copyQualification(
  qualification: TestAttestationQualification,
): TestAttestationQualification {
  return {
    profile: "basic",
    document_digest: qualification.document_digest,
    release_digest: qualification.release_digest,
    report_digest: qualification.report_digest,
    compiler_revision: qualification.compiler_revision,
    runtime_revision: qualification.runtime_revision,
    policy_revision: qualification.policy_revision,
    cases: {
      declared: qualification.cases.declared,
      required: qualification.cases.required,
      passed: qualification.cases.passed,
      optional_failed: qualification.cases.optional_failed,
    },
    functions: {
      declared: qualification.functions.declared,
      exercised: qualification.functions.exercised,
    },
    effects: {
      declared: qualification.effects.declared,
      exercised: qualification.effects.exercised,
      untested: qualification.effects.untested,
    },
  };
}

function isClaimsV2(value: unknown): value is TestAttestationClaimsV2 {
  return isCommonClaims(value) &&
    value.schema_version === 2 &&
    value.mode === "deno_execution" &&
    hasExactlyKeys(value, [
      "schema_version",
      "purpose",
      "attestation_id",
      "user_id",
      "source_hash",
      "mode",
      "lint_error_count",
      "tested_at",
      "expires_at",
      "qualification",
    ]) &&
    isQualification(value.qualification);
}

/**
 * Decode exactly the bytes that gx.upload will deploy.
 *
 * Text base64 is decoded as UTF-8 so it has the same source identity as the
 * equivalent text input. WebAssembly is byte-oriented and must use base64;
 * its exact decoded bytes are carried separately through the upload pipeline.
 */
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
    const binary = isBinarySourcePath(path);
    if (binary && encoding !== "base64") {
      throw new Error(`Binary source file ${path} must use base64 encoding`);
    }
    try {
      if (encoding !== "base64") {
        return { path, content: file.content };
      }
      const bytes = decodeBase64Bytes(file.content);
      if (binary) {
        return {
          path,
          content: bytesToBinaryString(bytes),
          bytes,
        };
      }
      return {
        path,
        content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } catch {
      throw new Error(`Invalid base64 or UTF-8 content for ${path}`);
    }
  });
}

export function computeDecodedSourceHash(
  files: DecodedSourceFile[],
): Promise<string> {
  return computeUploadSourceHash(files);
}

/** Canonical source identity used only by galactic.yaml / gxt2 releases. */
export function computeCanonicalDecodedSourceHash(
  files: DecodedSourceFile[],
): Promise<string> {
  return computeCanonicalUploadSourceHash(files);
}

export async function issueTestAttestation(input: {
  userId: string;
  sourceHash: string;
  mode: TestAttestationMode;
  now?: Date;
  ttlSeconds?: number;
  qualification?: TestAttestationQualification;
}): Promise<{ token: string; claims: TestAttestationClaims }> {
  const now = input.now ?? new Date();
  const ttlSeconds = input.ttlSeconds ?? configuredTtlSeconds();
  const common: TestAttestationCommonClaims = {
    purpose: "gx.test",
    attestation_id: crypto.randomUUID(),
    user_id: input.userId,
    source_hash: input.sourceHash,
    mode: input.mode,
    lint_error_count: 0,
    tested_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
  let claims: TestAttestationClaims;
  let tokenPrefix: string;
  let signingDomain: string;
  if (input.qualification === undefined) {
    claims = { schema_version: 1, ...common };
    tokenPrefix = V1_TOKEN_PREFIX;
    signingDomain = V1_SIGNING_DOMAIN;
  } else {
    if (input.mode !== "deno_execution") {
      throw new Error(
        "Galactic basic qualification requires deno_execution mode",
      );
    }
    if (!isQualification(input.qualification)) {
      throw new Error("Invalid gx.test qualification metadata");
    }
    claims = {
      schema_version: 2,
      ...common,
      qualification: copyQualification(input.qualification),
    };
    tokenPrefix = V2_TOKEN_PREFIX;
    signingDomain = V2_SIGNING_DOMAIN;
  }
  const encoded = base64UrlEncode(JSON.stringify(claims));
  const signedMessage = `${signingDomain}.${encoded}`;
  const signature = await signWithTrustSecret(signedMessage);
  const token = `${tokenPrefix}.${encoded}.${signature}`;
  if (
    tokenPrefix === V2_TOKEN_PREFIX &&
    token.length > V2_MAX_TOKEN_LENGTH
  ) {
    throw new Error("gx.test attestation exceeds the maximum token size");
  }
  return { token, claims };
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
  if (input.token.length > V2_MAX_TOKEN_LENGTH) {
    return { valid: false, reason: "malformed" };
  }
  const parts = input.token.split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "malformed" };
  }
  const [prefix, encoded, signature] = parts;
  const isV1 = prefix === V1_TOKEN_PREFIX;
  const isV2 = prefix === V2_TOKEN_PREFIX;
  if (
    (!isV1 && !isV2) ||
    (isV1 && input.token.length > V1_MAX_TOKEN_LENGTH) ||
    !SHA256_HEX_PATTERN.test(signature)
  ) {
    return { valid: false, reason: "malformed" };
  }
  let claims: unknown;
  try {
    claims = JSON.parse(base64UrlDecode(encoded));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  let validatedClaims: TestAttestationClaims;
  if (isV1) {
    if (!isClaimsV1(claims)) {
      return { valid: false, reason: "malformed" };
    }
    validatedClaims = claims;
  } else {
    if (!isClaimsV2(claims)) {
      return { valid: false, reason: "malformed" };
    }
    validatedClaims = claims;
  }

  const signingDomain = isV1 ? V1_SIGNING_DOMAIN : V2_SIGNING_DOMAIN;
  const expected = await signWithTrustSecret(`${signingDomain}.${encoded}`);
  if (!timingSafeEqual(expected, signature)) {
    return { valid: false, reason: "bad_signature" };
  }
  const now = input.now ?? new Date();
  if (Date.parse(validatedClaims.expires_at) <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  if (validatedClaims.user_id !== input.userId) {
    return { valid: false, reason: "wrong_user" };
  }
  if (validatedClaims.source_hash !== input.sourceHash) {
    return { valid: false, reason: "wrong_source" };
  }
  if (validatedClaims.mode !== input.mode) {
    return { valid: false, reason: "wrong_mode" };
  }
  return { valid: true, claims: validatedClaims };
}

export function persistedTestAttestation(
  claims: TestAttestationClaims,
  verifiedAt = new Date(),
): VersionTestAttestationMetadata {
  const common = {
    attestation_id: claims.attestation_id,
    mode: claims.mode,
    source_hash: claims.source_hash,
    tested_at: claims.tested_at,
    token_expires_at: claims.expires_at,
    verified_at: verifiedAt.toISOString(),
  };
  if (claims.schema_version === 1) {
    return { schema_version: 1, ...common };
  }
  if (!isQualification(claims.qualification)) {
    throw new Error("Invalid gx.test qualification metadata");
  }
  return {
    schema_version: 2,
    ...common,
    qualification: copyQualification(claims.qualification),
  };
}

export function findPersistedTestAttestation(
  metadata: VersionMetadata[] | null | undefined,
  version: string,
):
  | { entry: VersionMetadata; attestation: VersionTestAttestationMetadata }
  | null {
  if (!Array.isArray(metadata)) return null;
  const entry = [...metadata].reverse().find((candidate) =>
    candidate?.version === version
  );
  // A version's latest metadata row is authoritative. Never fall back to an
  // older duplicate whose proof may describe bytes that were later replaced.
  if (!entry?.test_attestation) return null;
  const attestation = entry.test_attestation;
  if (
    (attestation.schema_version !== 1 &&
      attestation.schema_version !== 2) ||
    !attestation.attestation_id ||
    !SHA256_HEX_PATTERN.test(attestation.source_hash) ||
    !Number.isFinite(Date.parse(attestation.tested_at)) ||
    !Number.isFinite(Date.parse(attestation.token_expires_at)) ||
    !Number.isFinite(Date.parse(attestation.verified_at)) ||
    entry.source_hash !== attestation.source_hash
  ) {
    return null;
  }
  if (
    attestation.schema_version === 2 &&
    !isQualification(attestation.qualification)
  ) {
    return null;
  }
  // A signed V2 VersionTrust record cannot be downgraded by replacing only
  // its persisted proof body with a structurally valid legacy V1 body. The
  // digest marker is covered by the trust HMAC; any record carrying it must
  // complete the V2 cryptographic verification path.
  if (
    attestation.schema_version === 1 &&
    entry.trust?.test_attestation_digest
  ) {
    return null;
  }
  const expectedMode = entry.trust?.runtime === "gpu"
    ? "gpu_validation"
    : "deno_execution";
  if (attestation.mode !== expectedMode) return null;
  return { entry, attestation };
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value;
}

function isPersistedQualificationV2(
  value: unknown,
): value is VersionTestAttestationMetadataV2 {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "attestation_id",
      "mode",
      "source_hash",
      "tested_at",
      "token_expires_at",
      "verified_at",
      "qualification",
    ]) ||
    value.schema_version !== 2 ||
    typeof value.attestation_id !== "string" ||
    value.attestation_id.length === 0 ||
    value.attestation_id.length > MAX_REVISION_LENGTH ||
    value.attestation_id !== value.attestation_id.trim() ||
    hasAsciiControlCharacters(value.attestation_id) ||
    value.mode !== "deno_execution" ||
    typeof value.source_hash !== "string" ||
    !SHA256_HEX_PATTERN.test(value.source_hash) ||
    !isCanonicalIsoTimestamp(value.tested_at) ||
    !isCanonicalIsoTimestamp(value.token_expires_at) ||
    !isCanonicalIsoTimestamp(value.verified_at) ||
    !isQualification(value.qualification)
  ) {
    return false;
  }

  const testedAt = Date.parse(value.tested_at);
  const expiresAt = Date.parse(value.token_expires_at);
  const verifiedAt = Date.parse(value.verified_at);
  return testedAt < expiresAt &&
    verifiedAt >= testedAt &&
    verifiedAt < expiresAt;
}

/**
 * Verify durable V2 qualification evidence for one exact app version.
 *
 * Unlike findPersistedTestAttestation (the compatibility-oriented structural
 * finder), this is a cryptographic trust decision. The persisted proof must be
 * structurally valid, match the entry's source and Deno runtime, and have its
 * canonical digest covered by the exact app/version's valid VersionTrust HMAC.
 */
export async function verifyVersionQualificationEvidence(
  entry: VersionMetadata | null | undefined,
  expected: { appId: string; version: string },
): Promise<
  | {
    entry: VersionMetadata;
    attestation: VersionTestAttestationMetadataV2;
  }
  | null
> {
  if (
    !entry ||
    entry.version !== expected.version ||
    typeof entry.source_hash !== "string" ||
    !SHA256_HEX_PATTERN.test(entry.source_hash) ||
    !isPersistedQualificationV2(entry.test_attestation) ||
    entry.source_hash !== entry.test_attestation.source_hash
  ) {
    return null;
  }

  const trust = entry.trust;
  if (
    !trust ||
    trust.schema_version !== 1 ||
    trust.app_id !== expected.appId ||
    trust.version !== expected.version ||
    trust.runtime !== "deno" ||
    typeof trust.executable_hash !== "string" ||
    !SHA256_HEX_PATTERN.test(trust.executable_hash) ||
    typeof trust.test_attestation_digest !== "string" ||
    !SHA256_HEX_PATTERN.test(trust.test_attestation_digest) ||
    !await verifyVersionTrustSignature(trust)
  ) {
    return null;
  }

  const actualDigest = await sha256Hex(canonicalJson(entry.test_attestation));
  if (!timingSafeEqual(actualDigest, trust.test_attestation_digest)) {
    return null;
  }

  return { entry, attestation: entry.test_attestation };
}
