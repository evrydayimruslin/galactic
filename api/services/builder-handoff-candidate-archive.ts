import type { AppManifest } from "../../shared/contracts/manifest.ts";
import { validateManifest } from "../../shared/contracts/manifest.ts";
import type {
  VersionTestAttestationMetadataV2,
  VersionTestQualificationMetadata,
} from "../../shared/types/index.ts";
import { validateConnectedUploadFileSet } from "./connected-upload-admission.ts";
import {
  assertQualificationMatchesPreparedRelease,
  isCurrentGalacticQualification,
} from "./galactic-qualified-release.ts";
import type { PipelineResult } from "./upload-pipeline.ts";
import {
  type DecodedSourceFile,
  validateSourceFilePath,
} from "./test-attestation.ts";
import type { FileUpload } from "./storage.ts";
import {
  bytesToBinaryString,
  isBinarySourcePath,
  sourceFileBytes,
} from "./source-file-content.ts";
import {
  canonicalJson,
  computeCanonicalUploadSourceHash,
  sha256Hex,
} from "./trust.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BUNDLE_ID_PATTERN = /^gxb1_[0-9a-f]{64}$/;
const MAX_CANDIDATE_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_CANDIDATE_ARCHIVE_OBJECTS = 256;
const MAX_CANDIDATE_ARCHIVE_DESCRIPTORS = MAX_CANDIDATE_ARCHIVE_OBJECTS * 4;
const CANDIDATE_INTENTS = new Set([
  "agent",
  "interface",
  "function",
  "routine",
]);

export interface BuilderHandoffCandidateArchiveStore {
  uploadFile(key: string, file: FileUpload): Promise<void>;
  fetchFile(key: string): Promise<Uint8Array>;
  fetchTextFile(key: string): Promise<string>;
  deleteFile?(key: string): Promise<void>;
}

export interface BuilderHandoffCandidateArchiveFile {
  path: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  encoding?: "text" | "binary";
}

export interface BuilderHandoffCandidateArchiveManifest {
  schema_version: 1;
  owner_id: string;
  session_id: string;
  candidate_set_id: string;
  target_agent_id: string;
  intent: "agent" | "interface" | "function" | "routine";
  change_scope: "full_release";
  base_lineage: {
    version: string;
    source_hash: string | null;
    release_digest: string | null;
    state_digest: string;
  } | null;
  bundle_id: string;
  source_hash: string;
  attestation_id: string;
  attestation_digest: string;
  document_digest: string;
  report_digest: string;
  release_digest: string;
  version: string;
  name: string | null;
  description: string | null;
  functions: string[];
  source_files: BuilderHandoffCandidateArchiveFile[];
  release_artifacts: BuilderHandoffCandidateArchiveFile[];
  interface_artifacts: BuilderHandoffCandidateArchiveFile[];
  executable: BuilderHandoffCandidateArchiveFile;
  qualification: VersionTestQualificationMetadata;
  /**
   * Durable, compact V2 evidence for version metadata. The opaque, replayable
   * gx.test token is deliberately never retained.
   *
   * This is optional only so archives created before the M7 deployment
   * boundary remain readable for an invitation. A deployable archive must
   * contain it and pass the strict loader below.
   */
  test_attestation?: VersionTestAttestationMetadataV2;
  conformance_report: unknown;
  agent_document: unknown;
  compiled_manifest: unknown;
}

export interface PersistBuilderHandoffCandidateArchiveInput {
  ownerId: string;
  sessionId: string;
  candidateSetId: string;
  targetAgentId: string;
  intent: "agent" | "interface" | "function" | "routine";
  baseVersion: string | null;
  baseSourceHash: string | null;
  baseReleaseDigest: string | null;
  baseStateDigest: string | null;
  bundleId: string;
  sourceHash: string;
  attestationId: string;
  attestationDigest: string;
  qualification: VersionTestQualificationMetadata;
  testAttestation?: VersionTestAttestationMetadataV2;
  conformanceReport: unknown;
  sourceFiles: DecodedSourceFile[];
  pipeline: PipelineResult;
  version: string;
}

interface BuilderHandoffCandidateArchiveReceipt {
  archiveDigest: string;
  archiveKey: string;
  pointerKey: string;
  archiveByteCount: number;
  archiveObjectCount: number;
  objectKeys: string[];
  manifest: BuilderHandoffCandidateArchiveManifest;
}

/**
 * Every field here must come from the locked `builder_handoff_sessions` row.
 * In particular, `archiveDigest` must be the digest bound by the upload
 * transition. Callers must never resolve it through the mutable R2 pointer.
 */
export interface BuilderHandoffCandidateArchiveExpectedBinding {
  ownerId: string;
  sessionId: string;
  candidateSetId: string;
  targetAgentId: string;
  intent: "agent" | "interface" | "function" | "routine";
  baseVersion: string | null;
  baseSourceHash: string | null;
  baseReleaseDigest: string | null;
  baseStateDigest: string | null;
  bundleId: string;
  sourceHash: string;
  attestationId: string;
  attestationDigest: string;
  documentDigest: string;
  reportDigest: string;
  releaseDigest: string;
  archiveDigest: string;
  archiveByteCount: number;
  archiveObjectCount: number;
  version: string;
}

export interface BuilderHandoffCandidateFunctionSummary {
  name: string;
  description: string;
  authorityLevel: "read" | "internal_write" | "external_write" | null;
  effects: Array<{
    id: string;
    policy: "ask" | "free";
  }>;
  spend: Array<{
    category: "inference" | "compute";
    policy: "ask" | "free";
  }>;
}

export interface BuilderHandoffCandidateSettingSummary {
  key: string;
  label: string | null;
  description: string | null;
  required: boolean;
  secret: boolean;
  scope: "agent" | "per_user";
  destination: string | null;
}

/**
 * Secret-free, bounded projection derived from a digest-verified compiled
 * manifest. Unlike the archive manifest, this object is safe to hand to an
 * owner-facing invitation serializer.
 */
export interface BuilderHandoffVerifiedCandidateArchiveManifest {
  archive: {
    digest: string;
    byteCount: number;
    objectCount: number;
  };
  candidate: {
    candidateSetId: string;
    targetAgentId: string;
    intent: "agent" | "interface" | "function" | "routine";
    changeScope: "full_release";
    baseLineage: BuilderHandoffCandidateArchiveManifest["base_lineage"];
  };
  release: {
    version: string;
    name: string;
    description: string | null;
    functions: BuilderHandoffCandidateFunctionSummary[];
    interfaces: Array<{
      id: string;
      label: string;
      description: string | null;
      functions: string[];
    }>;
    routines: Array<{
      id: string;
      label: string;
      description: string | null;
      handler: string;
      hasDefaultSchedule: boolean;
    }>;
    settings: BuilderHandoffCandidateSettingSummary[];
    network: Array<{
      host: string;
      label: string | null;
      description: string | null;
    }>;
    compute: {
      profile: string;
      tools: string[];
      secretNames: string[];
    } | null;
    permissions: string[];
  };
  evidence: {
    bundleId: string;
    sourceHash: string;
    attestationId: string;
    attestationDigest: string;
    documentDigest: string;
    reportDigest: string;
    releaseDigest: string;
    qualification: VersionTestQualificationMetadata;
  };
  /** False for a pre-M7 archive which lacks durable compact V2 evidence. */
  deploymentReady: boolean;
}

/**
 * Trusted-backend-only exact bytes for deployment. Never serialize this object
 * into an invitation response: it intentionally contains retained source and
 * executable bytes.
 */
export interface BuilderHandoffCandidateDeploymentSnapshot {
  verifiedManifest: BuilderHandoffVerifiedCandidateArchiveManifest;
  manifest: AppManifest;
  sourceFiles: DecodedSourceFile[];
  releaseArtifacts: FileUpload[];
  interfaceArtifacts: FileUpload[];
  executable: {
    name: "executable.mjs";
    content: Uint8Array;
    code: string;
    sha256: string;
  };
  exports: string[];
  migrations: PipelineResult["migrations"];
  normalizedEntryName: string;
  testAttestation: VersionTestAttestationMetadataV2;
}

export class BuilderHandoffCandidateArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderHandoffCandidateArchiveError";
  }
}

type JsonRecord = Record<string, unknown>;

interface ValidatedCandidateArchive {
  manifest: BuilderHandoffCandidateArchiveManifest;
  summary: BuilderHandoffVerifiedCandidateArchiveManifest;
  prefix: string;
  descriptors: {
    sourceFiles: BuilderHandoffCandidateArchiveFile[];
    releaseArtifacts: BuilderHandoffCandidateArchiveFile[];
    interfaceArtifacts: BuilderHandoffCandidateArchiveFile[];
    executable: BuilderHandoffCandidateArchiveFile;
  };
}

function archiveFailure(message: string): never {
  throw new BuilderHandoffCandidateArchiveError(message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value);
}

function hasExactlyKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key)
  ) &&
    keys.every((key) => allowed.has(key));
}

function isSafeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum &&
    Number(value) <= maximum;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

function hasAsciiControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hasUnsafeDescriptionControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (
      (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function isBoundedRevision(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= 128 && value === value.trim() &&
    !hasAsciiControlCharacters(value);
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function validateQualification(
  value: unknown,
): VersionTestQualificationMetadata {
  if (
    !isRecord(value) ||
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
    !SHA256_PATTERN.test(value.document_digest) ||
    typeof value.release_digest !== "string" ||
    !SHA256_PATTERN.test(value.release_digest) ||
    typeof value.report_digest !== "string" ||
    !SHA256_PATTERN.test(value.report_digest) ||
    !isBoundedRevision(value.compiler_revision) ||
    !isBoundedRevision(value.runtime_revision) ||
    !isBoundedRevision(value.policy_revision) ||
    !isRecord(value.cases) ||
    !isRecord(value.functions) ||
    !isRecord(value.effects)
  ) {
    archiveFailure("Candidate archive qualification metadata is invalid");
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
    !isSafeIntegerInRange(cases.declared, 1, 10_000) ||
    !isSafeIntegerInRange(cases.required, 1, cases.declared as number) ||
    !isSafeIntegerInRange(
      cases.passed,
      cases.required as number,
      cases.declared as number,
    ) ||
    !isSafeIntegerInRange(
      cases.optional_failed,
      0,
      cases.declared as number,
    ) ||
    Number(cases.optional_failed) !==
      Number(cases.declared) - Number(cases.passed) ||
    !hasExactlyKeys(functions, ["declared", "exercised"]) ||
    !isSafeIntegerInRange(functions.declared, 1, 10_000) ||
    !isSafeIntegerInRange(
      functions.exercised,
      1,
      functions.declared as number,
    ) ||
    !hasExactlyKeys(effects, ["declared", "exercised", "untested"]) ||
    !isSafeIntegerInRange(effects.declared, 0, 100_000) ||
    !isSafeIntegerInRange(
      effects.exercised,
      0,
      effects.declared as number,
    ) ||
    !isSafeIntegerInRange(
      effects.untested,
      0,
      effects.declared as number,
    ) ||
    Number(effects.exercised) + Number(effects.untested) !==
      Number(effects.declared)
  ) {
    archiveFailure("Candidate archive qualification coverage is invalid");
  }
  return cloneJsonValue(value) as unknown as VersionTestQualificationMetadata;
}

function validatePersistedV2Attestation(
  value: unknown,
  expected: {
    attestationId: string;
    sourceHash: string;
    qualification: VersionTestQualificationMetadata;
  },
): VersionTestAttestationMetadataV2 {
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
    value.mode !== "deno_execution" ||
    typeof value.attestation_id !== "string" ||
    value.attestation_id !== expected.attestationId ||
    value.attestation_id.length < 1 ||
    value.attestation_id.length > 128 ||
    value.attestation_id !== value.attestation_id.trim() ||
    hasAsciiControlCharacters(value.attestation_id) ||
    value.source_hash !== expected.sourceHash ||
    !isCanonicalIsoTimestamp(value.tested_at) ||
    !isCanonicalIsoTimestamp(value.token_expires_at) ||
    !isCanonicalIsoTimestamp(value.verified_at)
  ) {
    archiveFailure(
      "Candidate archive compact V2 test attestation is invalid",
    );
  }

  const qualification = validateQualification(value.qualification);
  if (
    canonicalJson(qualification) !== canonicalJson(expected.qualification)
  ) {
    archiveFailure(
      "Candidate archive compact V2 test attestation does not match its qualification",
    );
  }
  const testedAt = Date.parse(value.tested_at);
  const expiresAt = Date.parse(value.token_expires_at);
  const verifiedAt = Date.parse(value.verified_at);
  if (
    testedAt >= expiresAt || verifiedAt < testedAt || verifiedAt >= expiresAt
  ) {
    archiveFailure(
      "Candidate archive compact V2 test attestation chronology is invalid",
    );
  }
  return cloneJsonValue(value) as unknown as VersionTestAttestationMetadataV2;
}

function requireCanonicalVersion(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)
  ) {
    archiveFailure(`Candidate archive ${label} is invalid`);
  }
  return value;
}

function validateBaseLineage(
  value: unknown,
  intent: BuilderHandoffCandidateArchiveExpectedBinding["intent"],
): BuilderHandoffCandidateArchiveManifest["base_lineage"] {
  if (intent === "agent") {
    if (value !== null) {
      archiveFailure("A new-Agent candidate archive cannot have base lineage");
    }
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "version",
      "source_hash",
      "release_digest",
      "state_digest",
    ])
  ) {
    archiveFailure("Candidate archive base lineage is invalid");
  }
  const version = requireCanonicalVersion(value.version, "base version");
  if (
    value.source_hash !== null &&
    (typeof value.source_hash !== "string" ||
      !SHA256_PATTERN.test(value.source_hash))
  ) {
    archiveFailure("Candidate archive base source hash is invalid");
  }
  if (
    value.release_digest !== null &&
    (typeof value.release_digest !== "string" ||
      !SHA256_PATTERN.test(value.release_digest))
  ) {
    archiveFailure("Candidate archive base release digest is invalid");
  }
  if (
    typeof value.state_digest !== "string" ||
    !SHA256_PATTERN.test(value.state_digest)
  ) {
    archiveFailure("Candidate archive base state digest is invalid");
  }
  return {
    version,
    source_hash: value.source_hash as string | null,
    release_digest: value.release_digest as string | null,
    state_digest: value.state_digest,
  };
}

function normalizedExpectedBinding(
  input: BuilderHandoffCandidateArchiveExpectedBinding,
): BuilderHandoffCandidateArchiveExpectedBinding {
  const ownerId = requireUuid(input.ownerId, "owner ID");
  const sessionId = requireUuid(input.sessionId, "session ID");
  const candidateSetId = requireUuid(
    input.candidateSetId,
    "candidate-set ID",
  );
  const targetAgentId = requireUuid(
    input.targetAgentId,
    "target Agent ID",
  );
  if (new Set([sessionId, candidateSetId, targetAgentId]).size !== 3) {
    archiveFailure("Candidate archive identities must be distinct");
  }
  if (!CANDIDATE_INTENTS.has(input.intent)) {
    archiveFailure("Candidate archive intent is invalid");
  }
  if (!BUNDLE_ID_PATTERN.test(input.bundleId)) {
    archiveFailure("Candidate archive staged bundle ID is invalid");
  }
  const attestationId = requireBoundedText(
    input.attestationId,
    "attestation ID",
  );
  const version = requireCanonicalVersion(input.version, "version");
  const baseLineage = validateBaseLineage(
    input.intent === "agent" ? null : {
      version: input.baseVersion,
      source_hash: input.baseSourceHash,
      release_digest: input.baseReleaseDigest,
      state_digest: input.baseStateDigest,
    },
    input.intent,
  );
  if (
    !isSafeIntegerInRange(
      input.archiveByteCount,
      1,
      MAX_CANDIDATE_ARCHIVE_BYTES,
    ) ||
    !isSafeIntegerInRange(
      input.archiveObjectCount,
      3,
      MAX_CANDIDATE_ARCHIVE_OBJECTS,
    )
  ) {
    archiveFailure("Candidate archive retained size is invalid");
  }
  return {
    ownerId,
    sessionId,
    candidateSetId,
    targetAgentId,
    intent: input.intent,
    baseVersion: baseLineage?.version ?? null,
    baseSourceHash: baseLineage?.source_hash ?? null,
    baseReleaseDigest: baseLineage?.release_digest ?? null,
    baseStateDigest: baseLineage?.state_digest ?? null,
    bundleId: input.bundleId,
    sourceHash: requireDigest(input.sourceHash, "source hash"),
    attestationId,
    attestationDigest: requireDigest(
      input.attestationDigest,
      "attestation digest",
    ),
    documentDigest: requireDigest(
      input.documentDigest,
      "document digest",
    ),
    reportDigest: requireDigest(input.reportDigest, "report digest"),
    releaseDigest: requireDigest(input.releaseDigest, "release digest"),
    archiveDigest: requireDigest(input.archiveDigest, "archive digest"),
    archiveByteCount: input.archiveByteCount,
    archiveObjectCount: input.archiveObjectCount,
    version,
  };
}

function validateDescriptor(
  value: unknown,
  index: number,
  kind: "source" | "release" | "interface" | "executable",
): BuilderHandoffCandidateArchiveFile {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(
      value,
      ["path", "sha256", "size_bytes", "content_type"],
      ["encoding"],
    )
  ) {
    archiveFailure(`Candidate archive ${kind} descriptor is invalid`);
  }
  let path: string;
  try {
    path = validateSourceFilePath(value.path, index);
  } catch {
    archiveFailure(`Candidate archive ${kind} descriptor path is invalid`);
  }
  if (
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    !isSafeIntegerInRange(
      value.size_bytes,
      0,
      MAX_CANDIDATE_ARCHIVE_BYTES,
    ) ||
    typeof value.content_type !== "string" ||
    value.content_type.length < 3 ||
    value.content_type.length > 128 ||
    value.content_type !== value.content_type.trim() ||
    !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(
      value.content_type,
    )
  ) {
    archiveFailure(`Candidate archive ${kind} descriptor fields are invalid`);
  }

  if (kind === "source") {
    const expectedEncoding = isBinarySourcePath(path) ? "binary" : "text";
    if (
      value.encoding !== expectedEncoding ||
      value.content_type !== "application/octet-stream"
    ) {
      archiveFailure(
        `Candidate archive source descriptor encoding is invalid: ${path}`,
      );
    }
  } else if (kind === "executable") {
    if (
      path !== "executable.mjs" ||
      value.encoding !== "text" ||
      value.content_type !== "application/javascript"
    ) {
      archiveFailure("Candidate archive executable descriptor is invalid");
    }
  } else if (value.encoding !== undefined) {
    archiveFailure(
      `Candidate archive ${kind} descriptor cannot declare an encoding`,
    );
  }
  if (
    kind === "interface" &&
    !/^[a-f0-9]{64}\.html$/.test(path)
  ) {
    archiveFailure("Candidate archive interface descriptor name is invalid");
  }

  return {
    path,
    sha256: value.sha256,
    size_bytes: value.size_bytes,
    content_type: value.content_type,
    ...(value.encoding === "text" || value.encoding === "binary"
      ? { encoding: value.encoding }
      : {}),
  };
}

function validateDescriptorArray(
  value: unknown,
  kind: "source" | "release" | "interface",
  allowEmpty: boolean,
): BuilderHandoffCandidateArchiveFile[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.length > MAX_CANDIDATE_ARCHIVE_DESCRIPTORS
  ) {
    archiveFailure(`Candidate archive ${kind} descriptor set is invalid`);
  }
  const descriptors = value.map((entry, index) =>
    validateDescriptor(entry, index, kind)
  );
  const paths = descriptors.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    archiveFailure(`Candidate archive ${kind} descriptor paths are not unique`);
  }
  const sorted = [...paths].sort();
  if (paths.some((path, index) => path !== sorted[index])) {
    archiveFailure(`Candidate archive ${kind} descriptors are not canonical`);
  }
  return descriptors;
}

function validateConformanceReport(
  value: unknown,
  qualification: VersionTestQualificationMetadata,
): void {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    value.profile !== "basic" ||
    value.passed !== true ||
    value.release_digest !== qualification.release_digest ||
    !isRecord(value.coverage) ||
    !isRecord(value.coverage.cases) ||
    !isRecord(value.coverage.functions) ||
    !isRecord(value.coverage.effects) ||
    canonicalJson(value.coverage.cases) !== canonicalJson(qualification.cases)
  ) {
    archiveFailure("Candidate archive conformance report is invalid");
  }
  const functionCoverage = value.coverage.functions;
  const effectCoverage = value.coverage.effects;
  if (
    functionCoverage.declared !== qualification.functions.declared ||
    functionCoverage.exercised !== qualification.functions.exercised ||
    effectCoverage.declared !== qualification.effects.declared ||
    effectCoverage.exercised !== qualification.effects.exercised ||
    effectCoverage.untested !== qualification.effects.untested
  ) {
    archiveFailure(
      "Candidate archive conformance report coverage does not match its qualification",
    );
  }
}

function compiledManifestSummary(
  rawManifest: unknown,
  archived: {
    name: string | null;
    description: string | null;
    version: string;
    functions: string[];
  },
): {
  manifest: AppManifest;
  release: BuilderHandoffVerifiedCandidateArchiveManifest["release"];
} {
  if (!isRecord(rawManifest)) {
    archiveFailure("Candidate archive compiled manifest is invalid");
  }
  const manifestInput = cloneJsonValue(rawManifest);
  const validation = validateManifest(manifestInput);
  if (!validation.valid || !validation.manifest) {
    archiveFailure("Candidate archive compiled manifest failed validation");
  }
  const manifest = validation.manifest;
  const functionNames = Object.keys(manifest.functions ?? {}).sort();
  if (
    manifest.name !== archived.name ||
    manifest.version !== archived.version ||
    (manifest.description ?? null) !== archived.description ||
    canonicalJson(functionNames) !== canonicalJson(archived.functions)
  ) {
    archiveFailure(
      "Candidate archive release summary does not match its compiled manifest",
    );
  }

  const functions: BuilderHandoffCandidateFunctionSummary[] = functionNames.map(
    (name) => {
      const fn = manifest.functions![name] as unknown as JsonRecord;
      const authority = isRecord(fn.authority) ? fn.authority : null;
      const level = authority?.level;
      const authorityLevel:
        | "read"
        | "internal_write"
        | "external_write"
        | null = level === "read" || level === "internal_write" ||
            level === "external_write"
          ? level
          : null;
      const rawEffects = authority && isRecord(authority.effects)
        ? authority.effects
        : {};
      const effects: BuilderHandoffCandidateFunctionSummary["effects"] = Object
        .entries(rawEffects).map(([id, policy]) => {
          if (
            !/^(?:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*|x-[a-z0-9][a-z0-9._-]*)$/
              .test(id) ||
            (policy !== "ask" && policy !== "free")
          ) {
            archiveFailure(
              "Candidate archive compiled manifest authority is invalid",
            );
          }
          return { id, policy: policy as "ask" | "free" };
        }).sort((left, right) => left.id.localeCompare(right.id));
      const rawSpend = isRecord(fn.spend) ? fn.spend : {};
      const spend: BuilderHandoffCandidateFunctionSummary["spend"] = [];
      for (const category of ["inference", "compute"] as const) {
        const policy = rawSpend[category];
        if (policy === undefined) continue;
        if (policy !== "ask" && policy !== "free") {
          archiveFailure(
            "Candidate archive compiled manifest spend policy is invalid",
          );
        }
        spend.push({ category, policy });
      }
      if (!authorityLevel) {
        archiveFailure(
          "Candidate archive compiled manifest is missing function authority",
        );
      }
      return {
        name,
        description: fn.description as string,
        authorityLevel,
        effects,
        spend,
      };
    },
  );

  const interfaces = (manifest.interfaces ?? []).map((entry) => ({
    id: entry.id,
    label: entry.label,
    description: entry.description ?? null,
    functions: [...entry.functions],
  }));
  const routines = (manifest.routines ?? []).map((entry) => ({
    id: entry.id,
    label: entry.label,
    description: entry.description ?? null,
    handler: entry.handler,
    hasDefaultSchedule: entry.default_schedule !== undefined,
  }));
  const env = manifest.env_vars ?? manifest.env ?? {};
  const settings = Object.entries(env).sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([key, entry]) => ({
    key,
    label: entry.label ?? null,
    description: entry.description ?? null,
    required: entry.required === true,
    secret: entry.input === "password" || entry.credential !== undefined,
    scope: entry.scope === "per_user" || entry.type === "per_user"
      ? "per_user" as const
      : "agent" as const,
    destination: entry.credential?.destination ?? null,
  }));
  const network = (manifest.network?.allowed_destinations ?? []).map(
    (entry) => ({
      host: entry.host,
      label: entry.label ?? null,
      description: entry.description ?? null,
    }),
  );
  const compute = manifest.compute
    ? {
      profile: manifest.compute.profile,
      tools: [...manifest.compute.tools],
      secretNames: [...(manifest.compute.secrets ?? [])],
    }
    : null;
  return {
    manifest,
    release: {
      version: manifest.version,
      name: manifest.name,
      description: manifest.description ?? null,
      functions,
      interfaces,
      routines,
      settings,
      network,
      compute,
      permissions: [...(manifest.permissions ?? [])].sort(),
    },
  };
}

function requireUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new BuilderHandoffCandidateArchiveError(
      `Candidate archive requires a valid ${label}`,
    );
  }
  return value.toLowerCase();
}

function requireDigest(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new BuilderHandoffCandidateArchiveError(
      `Candidate archive requires a lowercase SHA-256 ${label}`,
    );
  }
  return value;
}

function requireBoundedText(value: string, label: string): string {
  if (
    value.length < 1 ||
    value.length > 128 ||
    value !== value.trim() ||
    hasAsciiControlCharacters(value)
  ) {
    throw new BuilderHandoffCandidateArchiveError(
      `Candidate archive requires a valid ${label}`,
    );
  }
  return value;
}

function candidatePrefix(ownerId: string, sessionId: string): string {
  return `builder-handoff-candidates/${ownerId}/${sessionId}/`;
}

export function builderHandoffCandidateArchiveKey(input: {
  ownerId: string;
  sessionId: string;
  archiveDigest: string;
}): string {
  return `${
    candidatePrefix(input.ownerId, input.sessionId)
  }archives/${input.archiveDigest}.json`;
}

function builderHandoffCandidatePointerKey(input: {
  ownerId: string;
  sessionId: string;
  archiveDigest: string;
}): string {
  return `${
    candidatePrefix(input.ownerId, input.sessionId)
  }archive-pointers/${input.archiveDigest}/submitted.json`;
}

function builderHandoffQualificationReportKey(input: {
  ownerId: string;
  sessionId: string;
  reportDigest: string;
}): string {
  return `${
    candidatePrefix(input.ownerId, input.sessionId)
  }reports/${input.reportDigest}.json`;
}

async function descriptor(
  path: string,
  content: Uint8Array,
  contentType: string,
  encoding?: "text" | "binary",
): Promise<BuilderHandoffCandidateArchiveFile> {
  return {
    path,
    sha256: await sha256Hex(content),
    size_bytes: content.byteLength,
    content_type: contentType,
    ...(encoding ? { encoding } : {}),
  };
}

function blobKey(
  prefix: string,
  archiveDigest: string,
  blobDigest: string,
): string {
  return `${prefix}archive-blobs/${archiveDigest}/${blobDigest}`;
}

async function loadValidatedCandidateArchive(
  store: BuilderHandoffCandidateArchiveStore,
  expectedInput: BuilderHandoffCandidateArchiveExpectedBinding,
): Promise<ValidatedCandidateArchive> {
  const expected = normalizedExpectedBinding(expectedInput);
  const archiveKey = builderHandoffCandidateArchiveKey({
    ownerId: expected.ownerId,
    sessionId: expected.sessionId,
    archiveDigest: expected.archiveDigest,
  });
  let retainedManifestBytes: Uint8Array;
  try {
    // Deliberately address the immutable manifest directly from the
    // Postgres-bound digest. The submitted.json pointer is not read here.
    retainedManifestBytes = await store.fetchFile(archiveKey);
  } catch {
    archiveFailure("The exact candidate archive is no longer available");
  }
  if (
    retainedManifestBytes.byteLength === 0 ||
    retainedManifestBytes.byteLength > expected.archiveByteCount ||
    retainedManifestBytes.byteLength > MAX_CANDIDATE_ARCHIVE_BYTES
  ) {
    archiveFailure("Candidate archive manifest size is invalid");
  }

  let rawManifest: string;
  try {
    rawManifest = new TextDecoder("utf-8", { fatal: true }).decode(
      retainedManifestBytes,
    );
  } catch {
    archiveFailure("Candidate archive manifest is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest);
  } catch {
    archiveFailure("Candidate archive manifest is not valid JSON");
  }
  if (!isRecord(parsed)) {
    archiveFailure("Candidate archive manifest must be an object");
  }
  const requiredKeys = [
    "schema_version",
    "owner_id",
    "session_id",
    "candidate_set_id",
    "target_agent_id",
    "intent",
    "change_scope",
    "base_lineage",
    "bundle_id",
    "source_hash",
    "attestation_id",
    "attestation_digest",
    "document_digest",
    "report_digest",
    "release_digest",
    "version",
    "name",
    "description",
    "functions",
    "source_files",
    "release_artifacts",
    "interface_artifacts",
    "executable",
    "qualification",
    "conformance_report",
    "agent_document",
    "compiled_manifest",
  ] as const;
  if (!hasExactlyKeys(parsed, requiredKeys, ["test_attestation"])) {
    archiveFailure("Candidate archive manifest fields are invalid");
  }

  let canonicalManifest: string;
  try {
    canonicalManifest = canonicalJson(parsed);
  } catch {
    archiveFailure("Candidate archive manifest cannot be canonicalized");
  }
  if (rawManifest !== canonicalManifest) {
    archiveFailure("Candidate archive manifest is not canonical JSON");
  }
  if (await sha256Hex(canonicalManifest) !== expected.archiveDigest) {
    archiveFailure(
      "Candidate archive manifest does not match the database-bound digest",
    );
  }

  if (
    parsed.schema_version !== 1 ||
    parsed.owner_id !== expected.ownerId ||
    parsed.session_id !== expected.sessionId ||
    parsed.candidate_set_id !== expected.candidateSetId ||
    parsed.target_agent_id !== expected.targetAgentId ||
    parsed.intent !== expected.intent ||
    parsed.change_scope !== "full_release" ||
    parsed.bundle_id !== expected.bundleId ||
    parsed.source_hash !== expected.sourceHash ||
    parsed.attestation_id !== expected.attestationId ||
    parsed.attestation_digest !== expected.attestationDigest ||
    parsed.document_digest !== expected.documentDigest ||
    parsed.report_digest !== expected.reportDigest ||
    parsed.release_digest !== expected.releaseDigest ||
    parsed.version !== expected.version
  ) {
    archiveFailure(
      "Candidate archive manifest does not match its database-bound session",
    );
  }

  const baseLineage = validateBaseLineage(parsed.base_lineage, expected.intent);
  const expectedBaseLineage = expected.intent === "agent" ? null : {
    version: expected.baseVersion!,
    source_hash: expected.baseSourceHash,
    release_digest: expected.baseReleaseDigest,
    state_digest: expected.baseStateDigest!,
  };
  if (canonicalJson(baseLineage) !== canonicalJson(expectedBaseLineage)) {
    archiveFailure(
      "Candidate archive base lineage does not match its database-bound session",
    );
  }
  const version = requireCanonicalVersion(parsed.version, "version");
  const name = parsed.name;
  const description = parsed.description;
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 512 ||
    name !== name.trim() ||
    hasAsciiControlCharacters(name) ||
    (description !== null &&
      (typeof description !== "string" ||
        description.length > 16_384 ||
        hasUnsafeDescriptionControlCharacters(description)))
  ) {
    archiveFailure("Candidate archive release description is invalid");
  }
  if (
    !Array.isArray(parsed.functions) ||
    parsed.functions.length < 1 ||
    parsed.functions.length > 1_024 ||
    parsed.functions.some((entry) =>
      typeof entry !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(entry)
    )
  ) {
    archiveFailure("Candidate archive function list is invalid");
  }
  const functions = parsed.functions as string[];
  const sortedFunctions = [...functions].sort();
  if (
    new Set(functions).size !== functions.length ||
    functions.some((entry, index) => entry !== sortedFunctions[index])
  ) {
    archiveFailure("Candidate archive function list is not canonical");
  }

  const qualification = validateQualification(parsed.qualification);
  if (
    qualification.document_digest !== expected.documentDigest ||
    qualification.report_digest !== expected.reportDigest ||
    qualification.release_digest !== expected.releaseDigest
  ) {
    archiveFailure(
      "Candidate archive qualification does not match its bound evidence",
    );
  }
  if (
    await sha256Hex(canonicalJson(parsed.conformance_report)) !==
      expected.reportDigest
  ) {
    archiveFailure(
      "Candidate archive conformance report failed its digest check",
    );
  }
  validateConformanceReport(parsed.conformance_report, qualification);
  if (!isRecord(parsed.agent_document)) {
    archiveFailure("Candidate archive Agent document is invalid");
  }

  const testAttestation = parsed.test_attestation === undefined
    ? undefined
    : validatePersistedV2Attestation(parsed.test_attestation, {
      attestationId: expected.attestationId,
      sourceHash: expected.sourceHash,
      qualification,
    });

  const sourceFiles = validateDescriptorArray(
    parsed.source_files,
    "source",
    false,
  );
  const releaseArtifacts = validateDescriptorArray(
    parsed.release_artifacts,
    "release",
    false,
  );
  const interfaceArtifacts = validateDescriptorArray(
    parsed.interface_artifacts,
    "interface",
    true,
  );
  const executable = validateDescriptor(
    parsed.executable,
    0,
    "executable",
  );
  const allDescriptors = [
    ...sourceFiles,
    ...releaseArtifacts,
    ...interfaceArtifacts,
    executable,
  ];
  if (allDescriptors.length > MAX_CANDIDATE_ARCHIVE_DESCRIPTORS) {
    archiveFailure("Candidate archive contains too many descriptors");
  }
  const sizeByDigest = new Map<string, number>();
  for (const file of allDescriptors) {
    const retainedSize = sizeByDigest.get(file.sha256);
    if (retainedSize !== undefined && retainedSize !== file.size_bytes) {
      archiveFailure(
        "Candidate archive aliases one blob digest to inconsistent sizes",
      );
    }
    sizeByDigest.set(file.sha256, file.size_bytes);
  }
  const pointerJson = canonicalJson({
    schema_version: 1,
    archive_digest: expected.archiveDigest,
    release_digest: expected.releaseDigest,
  });
  let derivedByteCount = retainedManifestBytes.byteLength +
    new TextEncoder().encode(pointerJson).byteLength;
  for (const size of sizeByDigest.values()) {
    derivedByteCount += size;
    if (
      !Number.isSafeInteger(derivedByteCount) ||
      derivedByteCount > MAX_CANDIDATE_ARCHIVE_BYTES
    ) {
      archiveFailure("Candidate archive retained size exceeds its limit");
    }
  }
  const derivedObjectCount = sizeByDigest.size + 2;
  if (
    derivedByteCount !== expected.archiveByteCount ||
    derivedObjectCount !== expected.archiveObjectCount
  ) {
    archiveFailure(
      "Candidate archive descriptors do not match the database-bound retained size",
    );
  }

  const compiled = compiledManifestSummary(parsed.compiled_manifest, {
    name,
    description: description as string | null,
    version,
    functions,
  });
  const manifest: BuilderHandoffCandidateArchiveManifest = {
    schema_version: 1,
    owner_id: expected.ownerId,
    session_id: expected.sessionId,
    candidate_set_id: expected.candidateSetId,
    target_agent_id: expected.targetAgentId,
    intent: expected.intent,
    change_scope: "full_release",
    base_lineage: baseLineage,
    bundle_id: expected.bundleId,
    source_hash: expected.sourceHash,
    attestation_id: expected.attestationId,
    attestation_digest: expected.attestationDigest,
    document_digest: expected.documentDigest,
    report_digest: expected.reportDigest,
    release_digest: expected.releaseDigest,
    version,
    name,
    description: description as string | null,
    functions: [...functions],
    source_files: sourceFiles,
    release_artifacts: releaseArtifacts,
    interface_artifacts: interfaceArtifacts,
    executable,
    qualification,
    ...(testAttestation ? { test_attestation: testAttestation } : {}),
    conformance_report: cloneJsonValue(parsed.conformance_report),
    agent_document: cloneJsonValue(parsed.agent_document),
    compiled_manifest: cloneJsonValue(parsed.compiled_manifest),
  };
  return {
    manifest,
    prefix: candidatePrefix(expected.ownerId, expected.sessionId),
    descriptors: {
      sourceFiles,
      releaseArtifacts,
      interfaceArtifacts,
      executable,
    },
    summary: {
      archive: {
        digest: expected.archiveDigest,
        byteCount: expected.archiveByteCount,
        objectCount: expected.archiveObjectCount,
      },
      candidate: {
        candidateSetId: expected.candidateSetId,
        targetAgentId: expected.targetAgentId,
        intent: expected.intent,
        changeScope: "full_release",
        baseLineage,
      },
      release: compiled.release,
      evidence: {
        bundleId: expected.bundleId,
        sourceHash: expected.sourceHash,
        attestationId: expected.attestationId,
        attestationDigest: expected.attestationDigest,
        documentDigest: expected.documentDigest,
        reportDigest: expected.reportDigest,
        releaseDigest: expected.releaseDigest,
        qualification,
      },
      deploymentReady: testAttestation !== undefined &&
        isCurrentGalacticQualification(qualification),
    },
  };
}

/**
 * Lightweight invitation read. This verifies the canonical archive manifest,
 * all database-bound identities/evidence, descriptor grammar/cardinality, and
 * the compiled manifest before returning a deliberately secret-free summary.
 * It does not fetch blobs or compile code.
 */
export async function loadVerifiedBuilderHandoffCandidateArchiveManifest(
  store: BuilderHandoffCandidateArchiveStore,
  expected: BuilderHandoffCandidateArchiveExpectedBinding,
): Promise<BuilderHandoffVerifiedCandidateArchiveManifest> {
  return (await loadValidatedCandidateArchive(store, expected)).summary;
}

async function fetchVerifiedArchiveBlobs(
  store: BuilderHandoffCandidateArchiveStore,
  archive: ValidatedCandidateArchive,
): Promise<Map<string, Uint8Array>> {
  const descriptorByDigest = new Map<
    string,
    BuilderHandoffCandidateArchiveFile
  >();
  for (
    const file of [
      ...archive.descriptors.sourceFiles,
      ...archive.descriptors.releaseArtifacts,
      ...archive.descriptors.interfaceArtifacts,
      archive.descriptors.executable,
    ]
  ) {
    descriptorByDigest.set(file.sha256, file);
  }
  const blobs = new Map<string, Uint8Array>();
  await Promise.all(
    [...descriptorByDigest.entries()].map(async ([digest, file]) => {
      let content: Uint8Array;
      try {
        content = await store.fetchFile(
          blobKey(archive.prefix, archive.summary.archive.digest, digest),
        );
      } catch {
        archiveFailure(
          `Candidate archive blob is missing: ${file.path}`,
        );
      }
      if (
        content.byteLength !== file.size_bytes ||
        await sha256Hex(content) !== digest
      ) {
        archiveFailure(
          `Candidate archive blob failed verification: ${file.path}`,
        );
      }
      blobs.set(digest, new Uint8Array(content));
    }),
  );
  return blobs;
}

function decodeArchiveText(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    archiveFailure(`Candidate archive ${label} is not valid UTF-8`);
  }
}

function exactSourceFiles(
  descriptors: BuilderHandoffCandidateArchiveFile[],
  blobs: ReadonlyMap<string, Uint8Array>,
): DecodedSourceFile[] {
  return descriptors.map((file) => {
    const bytes = blobs.get(file.sha256);
    if (!bytes) {
      archiveFailure(`Candidate archive source is missing: ${file.path}`);
    }
    if (file.encoding === "binary") {
      return {
        path: file.path,
        content: bytesToBinaryString(bytes),
        bytes: new Uint8Array(bytes),
      };
    }
    return {
      path: file.path,
      content: decodeArchiveText(bytes, `source file ${file.path}`),
    };
  });
}

async function descriptorsForArtifacts(
  artifacts: Array<{ name: string; content: Uint8Array; contentType: string }>,
): Promise<BuilderHandoffCandidateArchiveFile[]> {
  return await Promise.all(
    [...artifacts]
      .sort((left, right) =>
        left.name === right.name ? 0 : left.name < right.name ? -1 : 1
      )
      .map((file) => descriptor(file.name, file.content, file.contentType)),
  );
}

function assertSameCanonicalValue(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    archiveFailure(message);
  }
}

/**
 * Strict M7 deployment read. It reruns current source admission and strict
 * compilation, then proves the regenerated Agent document, manifest,
 * artifacts, interfaces, release identity, and executable match the exact
 * content-addressed archive. No mutable workspace, draft, version, or pointer
 * object participates in this proof.
 */
export async function loadBuilderHandoffCandidateDeploymentSnapshot(
  store: BuilderHandoffCandidateArchiveStore,
  expected: BuilderHandoffCandidateArchiveExpectedBinding,
): Promise<BuilderHandoffCandidateDeploymentSnapshot> {
  const archive = await loadValidatedCandidateArchive(store, expected);
  const testAttestation = archive.manifest.test_attestation;
  if (!testAttestation || !archive.summary.deploymentReady) {
    archiveFailure(
      "Candidate archive lacks a current durable V2 qualification; submit the exact tested release again",
    );
  }
  const blobs = await fetchVerifiedArchiveBlobs(store, archive);
  const sourceFiles = exactSourceFiles(
    archive.descriptors.sourceFiles,
    blobs,
  );
  try {
    validateConnectedUploadFileSet(sourceFiles);
  } catch (error) {
    archiveFailure(
      `Candidate archive source no longer passes deployment admission: ${
        error instanceof Error ? error.message : "source rejected"
      }`,
    );
  }
  if (
    await computeCanonicalUploadSourceHash(sourceFiles) !==
      archive.manifest.source_hash
  ) {
    archiveFailure("Candidate archive source hash does not match its evidence");
  }

  let pipeline: PipelineResult;
  try {
    const { processUploadPipeline } = await import("./upload-pipeline.ts");
    pipeline = await processUploadPipeline(
      sourceFiles.map((file) => ({
        name: file.path,
        content: file.content,
        ...(file.bytes ? { bytes: new Uint8Array(file.bytes) } : {}),
      })),
      { strictBuild: true },
    );
  } catch (error) {
    archiveFailure(
      `Candidate archive no longer compiles as its qualified release: ${
        error instanceof Error ? error.message : "strict build failed"
      }`,
    );
  }
  if (
    pipeline.runtime !== "deno" ||
    pipeline.agentDocument?.sourceKind !== "galactic_yaml" ||
    !pipeline.agentDocument.document ||
    !pipeline.manifest ||
    !pipeline.esmBundledCode ||
    !pipeline.safetyPassed
  ) {
    archiveFailure(
      "Candidate archive did not reproduce a strict Galactic Deno release",
    );
  }
  if (
    pipeline.agentDocument.documentDigest !==
      archive.manifest.document_digest
  ) {
    archiveFailure(
      "Candidate archive Agent document differs from its qualification",
    );
  }
  assertSameCanonicalValue(
    pipeline.agentDocument.document,
    archive.manifest.agent_document,
    "Candidate archive Agent document differs from its retained document",
  );
  assertSameCanonicalValue(
    pipeline.manifest,
    archive.manifest.compiled_manifest,
    "Candidate archive compiled manifest differs from the exact source",
  );
  assertSameCanonicalValue(
    [...pipeline.exports].sort(),
    archive.manifest.functions,
    "Candidate archive function list differs from the exact source",
  );

  let releaseIdentity: Awaited<
    ReturnType<typeof assertQualificationMatchesPreparedRelease>
  >;
  try {
    releaseIdentity = await assertQualificationMatchesPreparedRelease({
      qualification: archive.manifest.qualification,
      prepared: {
        sourceHash: archive.manifest.source_hash,
        documentDigest: pipeline.agentDocument.documentDigest,
        filesToUpload: pipeline.filesToUpload,
        interfaceArtifacts: pipeline.interfaceArtifacts,
        esmBundledCode: pipeline.esmBundledCode,
      },
    });
  } catch (error) {
    archiveFailure(
      error instanceof Error
        ? error.message
        : "Candidate archive release qualification does not match",
    );
  }
  if (releaseIdentity.release_digest !== archive.manifest.release_digest) {
    archiveFailure(
      "Candidate archive release identity differs from its retained evidence",
    );
  }

  const reproducedReleaseDescriptors = await descriptorsForArtifacts(
    pipeline.filesToUpload,
  );
  const reproducedInterfaceDescriptors = await descriptorsForArtifacts(
    pipeline.interfaceArtifacts,
  );
  assertSameCanonicalValue(
    reproducedReleaseDescriptors,
    archive.descriptors.releaseArtifacts,
    "Candidate archive release artifacts differ from the exact source",
  );
  assertSameCanonicalValue(
    reproducedInterfaceDescriptors,
    archive.descriptors.interfaceArtifacts,
    "Candidate archive interface artifacts differ from the exact source",
  );
  const executableBytes = blobs.get(archive.descriptors.executable.sha256);
  if (!executableBytes) {
    archiveFailure("Candidate archive executable is missing");
  }
  const reproducedExecutable = new TextEncoder().encode(
    pipeline.esmBundledCode,
  );
  if (
    executableBytes.byteLength !== reproducedExecutable.byteLength ||
    await sha256Hex(reproducedExecutable) !==
      archive.descriptors.executable.sha256
  ) {
    archiveFailure(
      "Candidate archive executable differs from the exact source",
    );
  }

  const toUploads = (
    descriptors: BuilderHandoffCandidateArchiveFile[],
  ): FileUpload[] =>
    descriptors.map((file) => ({
      name: file.path,
      content: new Uint8Array(blobs.get(file.sha256)!),
      contentType: file.content_type,
    }));
  return {
    verifiedManifest: archive.summary,
    manifest: cloneJsonValue(pipeline.manifest),
    sourceFiles,
    releaseArtifacts: toUploads(archive.descriptors.releaseArtifacts),
    interfaceArtifacts: toUploads(archive.descriptors.interfaceArtifacts),
    executable: {
      name: "executable.mjs",
      content: new Uint8Array(executableBytes),
      code: decodeArchiveText(executableBytes, "executable"),
      sha256: archive.descriptors.executable.sha256,
    },
    exports: [...pipeline.exports],
    migrations: pipeline.migrations.map((migration) => ({ ...migration })),
    normalizedEntryName: pipeline.normalizedEntryName,
    testAttestation: cloneJsonValue(testAttestation),
  };
}

async function assertRetained(
  store: BuilderHandoffCandidateArchiveStore,
  key: string,
  expected: Uint8Array,
): Promise<void> {
  let retained: Uint8Array;
  try {
    retained = await store.fetchFile(key);
  } catch {
    throw new BuilderHandoffCandidateArchiveError(
      `Candidate archive write could not be verified: ${key}`,
    );
  }
  if (await sha256Hex(retained) !== await sha256Hex(expected)) {
    throw new BuilderHandoffCandidateArchiveError(
      `Candidate archive bytes changed during retention: ${key}`,
    );
  }
}

export async function persistBuilderHandoffQualificationReport(
  store: BuilderHandoffCandidateArchiveStore,
  input: {
    ownerId: string;
    sessionId: string;
    reportDigest: string;
    report: unknown;
  },
): Promise<string> {
  const ownerId = requireUuid(input.ownerId, "owner ID");
  const sessionId = requireUuid(input.sessionId, "session ID");
  const reportDigest = requireDigest(input.reportDigest, "report digest");
  const reportJson = canonicalJson(input.report);
  if (await sha256Hex(reportJson) !== reportDigest) {
    throw new BuilderHandoffCandidateArchiveError(
      "Conformance report does not match its qualification digest",
    );
  }
  const key = builderHandoffQualificationReportKey({
    ownerId,
    sessionId,
    reportDigest,
  });
  const bytes = new TextEncoder().encode(reportJson);
  await store.uploadFile(key, {
    name: `${reportDigest}.json`,
    content: bytes,
    contentType: "application/json",
  });
  await assertRetained(store, key, bytes);
  return key;
}

export async function loadBuilderHandoffQualificationReport(
  store: BuilderHandoffCandidateArchiveStore,
  input: {
    ownerId: string;
    sessionId: string;
    reportDigest: string;
  },
): Promise<unknown> {
  const ownerId = requireUuid(input.ownerId, "owner ID");
  const sessionId = requireUuid(input.sessionId, "session ID");
  const reportDigest = requireDigest(input.reportDigest, "report digest");
  let raw: string;
  try {
    raw = await store.fetchTextFile(builderHandoffQualificationReportKey({
      ownerId,
      sessionId,
      reportDigest,
    }));
  } catch {
    throw new BuilderHandoffCandidateArchiveError(
      "The tested conformance report is no longer available",
    );
  }
  if (await sha256Hex(raw) !== reportDigest) {
    throw new BuilderHandoffCandidateArchiveError(
      "The retained conformance report failed its digest check",
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new BuilderHandoffCandidateArchiveError(
      "The retained conformance report is not valid JSON",
    );
  }
}

/**
 * Persist the exact tested release before its one-time Builder credential is
 * consumed. R2 publication happens first; the caller binds `archiveDigest`
 * into the atomic Postgres upload transition only after every retained byte
 * has been read back and verified.
 *
 * A failed database transition can leave an unreferenced, content-addressed
 * archive, but can never leave a submitted session pointing at missing bytes.
 */
export async function persistBuilderHandoffCandidateArchive(
  store: BuilderHandoffCandidateArchiveStore,
  input: PersistBuilderHandoffCandidateArchiveInput,
): Promise<BuilderHandoffCandidateArchiveReceipt> {
  const ownerId = requireUuid(input.ownerId, "owner ID");
  const sessionId = requireUuid(input.sessionId, "session ID");
  const candidateSetId = requireUuid(
    input.candidateSetId,
    "candidate-set ID",
  );
  const targetAgentId = requireUuid(
    input.targetAgentId,
    "target Agent ID",
  );
  if (
    new Set([sessionId, candidateSetId, targetAgentId]).size !== 3
  ) {
    throw new BuilderHandoffCandidateArchiveError(
      "Candidate archive identities must be distinct",
    );
  }
  if (!BUNDLE_ID_PATTERN.test(input.bundleId)) {
    throw new BuilderHandoffCandidateArchiveError(
      "Candidate archive requires a valid staged bundle ID",
    );
  }
  if (!CANDIDATE_INTENTS.has(input.intent)) {
    throw new BuilderHandoffCandidateArchiveError(
      "Candidate archive requires a candidate-bearing handoff intent",
    );
  }
  const attestationId = requireBoundedText(
    input.attestationId,
    "attestation ID",
  );
  const version = requireBoundedText(input.version, "version");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new BuilderHandoffCandidateArchiveError(
      "Candidate archive requires a canonical x.y.z version",
    );
  }
  const baseLineage = input.intent === "agent" ? null : {
    version: requireBoundedText(
      input.baseVersion ?? "",
      "base version",
    ),
    source_hash: input.baseSourceHash === null
      ? null
      : requireDigest(input.baseSourceHash, "base source hash"),
    release_digest: input.baseReleaseDigest === null
      ? null
      : requireDigest(input.baseReleaseDigest, "base release digest"),
    state_digest: requireDigest(
      input.baseStateDigest ?? "",
      "base state digest",
    ),
  };
  if (baseLineage !== null && !/^\d+\.\d+\.\d+$/.test(baseLineage.version)) {
    throw new BuilderHandoffCandidateArchiveError(
      "Candidate archive requires a canonical x.y.z base version",
    );
  }
  if (
    input.intent === "agent" &&
    (input.baseVersion !== null ||
      input.baseSourceHash !== null ||
      input.baseReleaseDigest !== null ||
      input.baseStateDigest !== null)
  ) {
    throw new BuilderHandoffCandidateArchiveError(
      "A new-Agent candidate cannot carry existing-Agent base lineage",
    );
  }
  const sourceHash = requireDigest(input.sourceHash, "source hash");
  if (
    await computeCanonicalUploadSourceHash(input.sourceFiles) !== sourceHash
  ) {
    throw new BuilderHandoffCandidateArchiveError(
      "Candidate archive source files do not match their source hash",
    );
  }
  const attestationDigest = requireDigest(
    input.attestationDigest,
    "attestation digest",
  );
  const qualification = validateQualification(input.qualification);
  const documentDigest = requireDigest(
    qualification.document_digest,
    "document digest",
  );
  const reportDigest = requireDigest(
    qualification.report_digest,
    "report digest",
  );
  const releaseDigest = requireDigest(
    qualification.release_digest,
    "release digest",
  );
  if (
    await sha256Hex(canonicalJson(input.conformanceReport)) !== reportDigest
  ) {
    throw new BuilderHandoffCandidateArchiveError(
      "Candidate archive conformance report does not match its qualification",
    );
  }
  if (
    input.pipeline.agentDocument?.documentDigest !== documentDigest ||
    input.pipeline.agentDocument?.sourceKind !== "galactic_yaml" ||
    !input.pipeline.esmBundledCode
  ) {
    throw new BuilderHandoffCandidateArchiveError(
      "Candidate archive does not match a compiled Galactic release",
    );
  }
  const testAttestation = input.testAttestation === undefined
    ? undefined
    : validatePersistedV2Attestation(input.testAttestation, {
      attestationId,
      sourceHash,
      qualification,
    });

  const prefix = candidatePrefix(ownerId, sessionId);
  const blobs = new Map<string, { content: Uint8Array; contentType: string }>();
  const remember = (
    file: BuilderHandoffCandidateArchiveFile,
    content: Uint8Array,
  ) => {
    const existing = blobs.get(file.sha256);
    if (existing) return;
    blobs.set(file.sha256, {
      content: new Uint8Array(content),
      contentType: file.content_type,
    });
  };

  const sourceFiles = await Promise.all(
    [...input.sourceFiles]
      .sort((left, right) =>
        left.path === right.path ? 0 : left.path < right.path ? -1 : 1
      )
      .map(async (file) => {
        const content = sourceFileBytes(file);
        const entry = await descriptor(
          file.path,
          content,
          "application/octet-stream",
          file.bytes ? "binary" : "text",
        );
        remember(entry, content);
        return entry;
      }),
  );
  const releaseArtifacts = await Promise.all(
    [...input.pipeline.filesToUpload]
      .sort((left, right) =>
        left.name === right.name ? 0 : left.name < right.name ? -1 : 1
      )
      .map(async (file) => {
        const content = new Uint8Array(file.content);
        const entry = await descriptor(
          file.name,
          content,
          file.contentType,
        );
        remember(entry, content);
        return entry;
      }),
  );
  const interfaceArtifacts = await Promise.all(
    [...input.pipeline.interfaceArtifacts]
      .sort((left, right) =>
        left.name === right.name ? 0 : left.name < right.name ? -1 : 1
      )
      .map(async (file) => {
        const content = new Uint8Array(file.content);
        const entry = await descriptor(
          file.name,
          content,
          file.contentType,
        );
        remember(entry, content);
        return entry;
      }),
  );
  const executableBytes = new TextEncoder().encode(
    input.pipeline.esmBundledCode,
  );
  const executable = await descriptor(
    "executable.mjs",
    executableBytes,
    "application/javascript",
    "text",
  );
  remember(executable, executableBytes);

  const manifest: BuilderHandoffCandidateArchiveManifest = {
    schema_version: 1,
    owner_id: ownerId,
    session_id: sessionId,
    candidate_set_id: candidateSetId,
    target_agent_id: targetAgentId,
    intent: input.intent,
    change_scope: "full_release",
    base_lineage: baseLineage,
    bundle_id: input.bundleId,
    source_hash: sourceHash,
    attestation_id: attestationId,
    attestation_digest: attestationDigest,
    document_digest: documentDigest,
    report_digest: reportDigest,
    release_digest: releaseDigest,
    version,
    name: input.pipeline.manifest?.name ?? null,
    description: input.pipeline.manifest?.description ?? null,
    functions: [...input.pipeline.exports].sort(),
    source_files: sourceFiles,
    release_artifacts: releaseArtifacts,
    interface_artifacts: interfaceArtifacts,
    executable,
    qualification,
    ...(testAttestation ? { test_attestation: testAttestation } : {}),
    conformance_report: input.conformanceReport,
    agent_document: input.pipeline.agentDocument.document,
    compiled_manifest: input.pipeline.manifest,
  };
  const manifestJson = canonicalJson(manifest);
  const archiveDigest = await sha256Hex(manifestJson);
  const archiveKey = builderHandoffCandidateArchiveKey({
    ownerId,
    sessionId,
    archiveDigest,
  });
  const pointerKey = builderHandoffCandidatePointerKey({
    ownerId,
    sessionId,
    archiveDigest,
  });
  const manifestBytes = new TextEncoder().encode(manifestJson);
  const pointerBytes = new TextEncoder().encode(canonicalJson({
    schema_version: 1,
    archive_digest: archiveDigest,
    release_digest: releaseDigest,
  }));
  const objectKeys = [
    ...[...blobs.keys()].map((digest) =>
      blobKey(prefix, archiveDigest, digest)
    ),
    archiveKey,
    pointerKey,
  ];
  const archiveByteCount = [...blobs.values()].reduce(
    (sum, blob) => sum + blob.content.byteLength,
    manifestBytes.byteLength + pointerBytes.byteLength,
  );
  const archiveObjectCount = objectKeys.length;
  if (
    archiveByteCount > MAX_CANDIDATE_ARCHIVE_BYTES ||
    archiveObjectCount > MAX_CANDIDATE_ARCHIVE_OBJECTS
  ) {
    throw new BuilderHandoffCandidateArchiveError(
      "Candidate archive exceeds the pre-membership retention limit",
    );
  }

  const blobWrites = await Promise.allSettled(
    [...blobs.entries()].map(([digest, blob]) =>
      store.uploadFile(blobKey(prefix, archiveDigest, digest), {
        name: digest,
        content: blob.content,
        contentType: blob.contentType,
      })
    ),
  );
  if (blobWrites.some((result) => result.status === "rejected")) {
    throw new BuilderHandoffCandidateArchiveError(
      "Candidate archive blob publication failed",
    );
  }
  await Promise.all(
    [...blobs.entries()].map(([digest, blob]) =>
      assertRetained(
        store,
        blobKey(prefix, archiveDigest, digest),
        blob.content,
      )
    ),
  );

  await store.uploadFile(archiveKey, {
    name: `${archiveDigest}.json`,
    content: manifestBytes,
    contentType: "application/json",
  });
  await assertRetained(store, archiveKey, manifestBytes);

  // Publish the small pointer last. The database remains the authority for
  // whether this archive was actually submitted; this object alone grants
  // nothing and is never exposed through the handoff bearer.
  await store.uploadFile(pointerKey, {
    name: "submitted.json",
    content: pointerBytes,
    contentType: "application/json",
  });
  await assertRetained(store, pointerKey, pointerBytes);

  return {
    archiveDigest,
    archiveKey,
    pointerKey,
    archiveByteCount,
    archiveObjectCount,
    objectKeys,
    manifest,
  };
}

/**
 * Best-effort compensation used only after the database explicitly rejects an
 * archive before binding its digest. Never call this after an ambiguous RPC
 * outcome: the database may already reference the objects.
 */
export async function deleteUnboundBuilderHandoffCandidateArchive(
  store: BuilderHandoffCandidateArchiveStore,
  receipt: Pick<BuilderHandoffCandidateArchiveReceipt, "objectKeys">,
): Promise<void> {
  if (!store.deleteFile) return;
  await Promise.allSettled(
    receipt.objectKeys.map((key) => store.deleteFile!(key)),
  );
}
