import { validateConnectedUploadFileSet } from "./connected-upload-admission.ts";
import {
  computeDecodedSourceHash,
  type DecodedSourceFile,
  decodeSourceFileSet,
  type EncodedSourceFile,
  validateSourceFilePath,
} from "./test-attestation.ts";
import type { FileUpload } from "./storage.ts";
import { canonicalJson, sha256Hex } from "./trust.ts";
import {
  bytesToBinaryString,
  isBinarySourcePath,
  sourceFileBytes,
} from "./source-file-content.ts";

const BUNDLE_ID_PREFIX = "gxb1_";
const DEFAULT_RETENTION_SECONDS = 24 * 60 * 60;
const MAX_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MANIFEST_SCHEMA_VERSION = 1;
// R2 lifecycle expiry is asynchronous. Quota reservations deliberately cover
// the seven-day object lifecycle plus one day for the collector to finish.
export const STAGED_BUNDLE_QUOTA_RETENTION_SECONDS = 8 * 24 * 60 * 60;

export interface StagedBundleStore {
  uploadFile(key: string, file: FileUpload): Promise<void>;
  fetchFile(key: string): Promise<Uint8Array>;
  fetchTextFile(key: string): Promise<string>;
}

export interface StagedBundleFile {
  path: string;
  sha256: string;
  size_bytes: number;
  encoding: "text" | "binary";
}

export interface StagedBundleManifest {
  schema_version: 1;
  bundle_id: string;
  owner_id: string;
  source_hash: string;
  files: StagedBundleFile[];
  created_at: string;
  expires_at: string;
}

export interface StagedBundleAdmissionObject {
  objectId: string;
  sizeBytes: number;
}

export interface StagedBundleAdmissionRequest {
  ownerId: string;
  bundleId: string;
  objects: StagedBundleAdmissionObject[];
  retainedUntil: string;
}

export interface StagedBundleAdmissionReservation {
  /**
   * Release only this admission claim. Implementations must not release
   * pre-existing or concurrent claims for reused content-addressed objects.
   */
  release(): Promise<void>;
}

export type StagedBundleAdmission = (
  request: StagedBundleAdmissionRequest,
) => Promise<StagedBundleAdmissionReservation | void>;

export interface StageBundleInput {
  ownerId: string;
  files?: EncodedSourceFile[];
  baseBundleId?: string;
  deletePaths?: string[];
  now?: Date;
  retentionSeconds?: number;
  /**
   * Host-authoritative, fail-closed admission hook. It runs after immutable
   * object identities are known, but before the first R2 PUT.
   */
  admit?: StagedBundleAdmission;
}

export interface StageBundleResult {
  bundle_id: string;
  source_hash: string;
  file_count: number;
  size_bytes: number;
  changed_files: string[];
  reused_files: string[];
  deleted_files: string[];
  created_at: string;
  expires_at: string;
}

export class StagedBundleError extends Error {
  constructor(
    public readonly code:
      | "invalid_bundle_id"
      | "bundle_not_found"
      | "bundle_expired"
      | "bundle_corrupt"
      | "invalid_stage",
    message: string,
  ) {
    super(message);
    this.name = "StagedBundleError";
  }
}

function invalidStageError(error: unknown): StagedBundleError {
  if (error instanceof StagedBundleError) return error;
  return new StagedBundleError(
    "invalid_stage",
    error instanceof Error ? error.message : String(error),
  );
}

function ownerStorageSegment(ownerId: string): string {
  return encodeURIComponent(ownerId);
}

function bundleManifestKey(ownerId: string, bundleId: string): string {
  return `staged-bundles/${
    ownerStorageSegment(ownerId)
  }/bundles/${bundleId}.json`;
}

function bundleBlobKey(ownerId: string, sha256: string): string {
  return `staged-bundles/${ownerStorageSegment(ownerId)}/blobs/${sha256}`;
}

async function computeBundleId(
  files: Array<Pick<StagedBundleFile, "path" | "sha256" | "encoding">>,
): Promise<string> {
  const canonicalFiles = files
    .map(({ path, sha256, encoding }) => ({ path, sha256, encoding }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const hash = await sha256Hex(canonicalJson({
    schema_version: MANIFEST_SCHEMA_VERSION,
    files: canonicalFiles,
  }));
  return `${BUNDLE_ID_PREFIX}${hash}`;
}

function parseBundleId(bundleId: unknown): string {
  if (
    typeof bundleId !== "string" ||
    !new RegExp(`^${BUNDLE_ID_PREFIX}[a-f0-9]{64}$`).test(bundleId)
  ) {
    throw new StagedBundleError(
      "invalid_bundle_id",
      "bundle_id must be a valid Galactic staged bundle ID",
    );
  }
  return bundleId;
}

function retentionSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RETENTION_SECONDS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new StagedBundleError(
      "invalid_stage",
      "retentionSeconds must be a positive number",
    );
  }
  return Math.min(MAX_RETENTION_SECONDS, Math.floor(value));
}

function parseManifest(
  raw: string,
  ownerId: string,
  expectedBundleId: string,
): StagedBundleManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new StagedBundleError(
      "bundle_corrupt",
      "Bundle manifest is not valid JSON",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StagedBundleError("bundle_corrupt", "Bundle manifest is invalid");
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schema_version !== MANIFEST_SCHEMA_VERSION ||
    manifest.bundle_id !== expectedBundleId ||
    manifest.owner_id !== ownerId ||
    typeof manifest.source_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.source_hash) ||
    typeof manifest.created_at !== "string" ||
    !Number.isFinite(Date.parse(manifest.created_at)) ||
    typeof manifest.expires_at !== "string" ||
    !Number.isFinite(Date.parse(manifest.expires_at)) ||
    !Array.isArray(manifest.files)
  ) {
    throw new StagedBundleError("bundle_corrupt", "Bundle manifest is invalid");
  }

  const seen = new Set<string>();
  const files = manifest.files.map((rawFile, index) => {
    if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) {
      throw new StagedBundleError(
        "bundle_corrupt",
        "Bundle file metadata is invalid",
      );
    }
    const file = rawFile as Record<string, unknown>;
    if (
      typeof file.path !== "string" ||
      seen.has(file.path) ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.size_bytes !== "number" ||
      !Number.isSafeInteger(file.size_bytes) ||
      file.size_bytes < 0 ||
      (file.encoding !== "text" && file.encoding !== "binary")
    ) {
      throw new StagedBundleError(
        "bundle_corrupt",
        "Bundle file metadata is invalid",
      );
    }
    try {
      validateSourceFilePath(file.path, index);
    } catch {
      throw new StagedBundleError(
        "bundle_corrupt",
        "Bundle manifest contains an invalid source path",
      );
    }
    if (
      (file.encoding === "binary") !== isBinarySourcePath(file.path)
    ) {
      throw new StagedBundleError(
        "bundle_corrupt",
        `Bundle file encoding is invalid for ${file.path}`,
      );
    }
    const encoding: StagedBundleFile["encoding"] = file.encoding;
    seen.add(file.path);
    return {
      path: file.path,
      sha256: file.sha256,
      size_bytes: file.size_bytes,
      encoding,
    };
  });
  if (files.length === 0) {
    throw new StagedBundleError(
      "bundle_corrupt",
      "Bundle manifest cannot be empty",
    );
  }
  return {
    schema_version: 1,
    bundle_id: expectedBundleId,
    owner_id: ownerId,
    source_hash: manifest.source_hash,
    files,
    created_at: manifest.created_at,
    expires_at: manifest.expires_at,
  };
}

async function fetchManifest(
  store: StagedBundleStore,
  ownerId: string,
  bundleId: string,
): Promise<StagedBundleManifest> {
  const parsedId = parseBundleId(bundleId);
  let raw: string;
  try {
    raw = await store.fetchTextFile(bundleManifestKey(ownerId, parsedId));
  } catch {
    throw new StagedBundleError(
      "bundle_not_found",
      "Staged bundle was not found",
    );
  }
  return parseManifest(raw, ownerId, parsedId);
}

function assertNotExpired(manifest: StagedBundleManifest, now: Date): void {
  if (Date.parse(manifest.expires_at) <= now.getTime()) {
    throw new StagedBundleError(
      "bundle_expired",
      "Staged bundle has expired; stage the source again",
    );
  }
}

async function readBundleFiles(
  store: StagedBundleStore,
  manifest: StagedBundleManifest,
): Promise<DecodedSourceFile[]> {
  return await Promise.all(manifest.files.map(async (file) => {
    let bytes: Uint8Array;
    try {
      bytes = await store.fetchFile(
        bundleBlobKey(manifest.owner_id, file.sha256),
      );
    } catch {
      throw new StagedBundleError(
        "bundle_corrupt",
        `Bundle content is missing for ${file.path}`,
      );
    }
    if (
      await sha256Hex(bytes) !== file.sha256 ||
      bytes.byteLength !== file.size_bytes
    ) {
      throw new StagedBundleError(
        "bundle_corrupt",
        `Bundle content failed integrity verification for ${file.path}`,
      );
    }
    if (file.encoding === "binary") {
      return {
        path: file.path,
        content: bytesToBinaryString(bytes),
        bytes,
      };
    }
    try {
      return {
        path: file.path,
        content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } catch {
      throw new StagedBundleError(
        "bundle_corrupt",
        `Bundle text is not valid UTF-8 for ${file.path}`,
      );
    }
  }));
}

export async function resolveStagedBundle(
  store: StagedBundleStore,
  input: { ownerId: string; bundleId: string; now?: Date },
): Promise<{ manifest: StagedBundleManifest; files: DecodedSourceFile[] }> {
  const manifest = await fetchManifest(store, input.ownerId, input.bundleId);
  assertNotExpired(manifest, input.now ?? new Date());
  if (await computeBundleId(manifest.files) !== manifest.bundle_id) {
    throw new StagedBundleError(
      "bundle_corrupt",
      "Bundle manifest failed content-address verification",
    );
  }
  const files = await readBundleFiles(store, manifest);
  const sourceHash = await computeDecodedSourceHash(files);
  if (sourceHash !== manifest.source_hash) {
    throw new StagedBundleError(
      "bundle_corrupt",
      "Bundle source hash failed integrity verification",
    );
  }
  return { manifest, files };
}

export async function stageBundle(
  store: StagedBundleStore,
  input: StageBundleInput,
): Promise<StageBundleResult> {
  const now = input.now ?? new Date();
  const encodedChanges = input.files ?? [];
  if (!Array.isArray(encodedChanges)) {
    throw new StagedBundleError("invalid_stage", "files must be an array");
  }
  let changes: DecodedSourceFile[];
  try {
    changes = encodedChanges.length > 0
      ? decodeSourceFileSet(encodedChanges)
      : [];
  } catch (error) {
    throw invalidStageError(error);
  }
  if (!Array.isArray(input.deletePaths ?? [])) {
    throw new StagedBundleError(
      "invalid_stage",
      "delete_paths must be an array",
    );
  }
  const deletePaths = input.deletePaths ?? [];
  let validatedDeletes: string[];
  try {
    const seenDeletes = new Set<string>();
    validatedDeletes = deletePaths.map((path, index) => {
      const validated = validateSourceFilePath(path, index);
      if (seenDeletes.has(validated)) {
        throw new Error(`Duplicate source file path: ${validated}`);
      }
      seenDeletes.add(validated);
      return validated;
    });
  } catch (error) {
    throw invalidStageError(error);
  }
  const changedPaths = new Set(changes.map((file) => file.path));
  for (const path of validatedDeletes) {
    if (changedPaths.has(path)) {
      throw new StagedBundleError(
        "invalid_stage",
        `A path cannot be changed and deleted in the same stage: ${path}`,
      );
    }
  }
  if (!input.baseBundleId && changes.length === 0) {
    throw new StagedBundleError(
      "invalid_stage",
      "files are required when base_bundle_id is not provided",
    );
  }

  let baseFiles: DecodedSourceFile[] = [];
  if (input.baseBundleId) {
    baseFiles = (await resolveStagedBundle(store, {
      ownerId: input.ownerId,
      bundleId: input.baseBundleId,
      now,
    })).files;
  }

  const filesByPath = new Map(
    baseFiles.map((file) => [file.path, file]),
  );
  const basePaths = new Set(filesByPath.keys());
  for (const path of validatedDeletes) filesByPath.delete(path);
  for (const file of changes) filesByPath.set(file.path, file);
  const files = [...filesByPath.values()]
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) {
    throw new StagedBundleError(
      "invalid_stage",
      "A staged bundle cannot be empty",
    );
  }
  let totalBytes: number;
  try {
    ({ totalBytes } = validateConnectedUploadFileSet(files));
  } catch (error) {
    throw invalidStageError(error);
  }

  const fileMetadata = await Promise.all(files.map(async (file) => ({
    path: file.path,
    sha256: await sha256Hex(sourceFileBytes(file)),
    size_bytes: sourceFileBytes(file).byteLength,
    encoding: file.bytes ? "binary" as const : "text" as const,
  })));
  const bundleId = await computeBundleId(fileMetadata);
  const sourceHash = await computeDecodedSourceHash(files);

  // Content-addressing makes repeated stages idempotent. Preserve the original
  // lease while it remains valid; expired leases may be renewed without changing
  // the immutable source identity or blob keys.
  try {
    const existing = await fetchManifest(store, input.ownerId, bundleId);
    if (Date.parse(existing.expires_at) > now.getTime()) {
      await resolveStagedBundle(store, {
        ownerId: input.ownerId,
        bundleId,
        now,
      });
      return {
        bundle_id: existing.bundle_id,
        source_hash: existing.source_hash,
        file_count: existing.files.length,
        size_bytes: existing.files.reduce(
          (sum, file) => sum + file.size_bytes,
          0,
        ),
        changed_files: changes.map((file) => file.path).sort(),
        reused_files: existing.files
          .map((file) => file.path)
          .filter((path) => !changedPaths.has(path))
          .sort(),
        deleted_files: validatedDeletes.filter((path) => basePaths.has(path))
          .sort(),
        created_at: existing.created_at,
        expires_at: existing.expires_at,
      };
    }
  } catch (error) {
    if (
      !(error instanceof StagedBundleError) ||
      error.code !== "bundle_not_found"
    ) {
      throw error;
    }
  }

  const manifest: StagedBundleManifest = {
    schema_version: 1,
    bundle_id: bundleId,
    owner_id: input.ownerId,
    source_hash: sourceHash,
    files: fileMetadata,
    created_at: now.toISOString(),
    expires_at: new Date(
      now.getTime() + retentionSeconds(input.retentionSeconds) * 1000,
    ).toISOString(),
  };
  const manifestContent = new TextEncoder().encode(JSON.stringify(manifest));

  // A newer manifest may reuse a much older content-addressed blob. R2
  // lifecycle expiry is object-age based, so renew every referenced hash before
  // publishing the manifest. Deduplicate identical contents across paths.
  const uniqueBlobs = new Map<
    string,
    { content: Uint8Array; sizeBytes: number }
  >();
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const metadata = fileMetadata[index];
    if (!file || !metadata || uniqueBlobs.has(metadata.sha256)) continue;
    uniqueBlobs.set(metadata.sha256, {
      content: sourceFileBytes(file),
      sizeBytes: metadata.size_bytes,
    });
  }

  const admission = await input.admit?.({
    ownerId: input.ownerId,
    bundleId,
    objects: [
      ...[...uniqueBlobs.entries()].map(([sha256, blob]) => ({
        objectId: `blob:${sha256}`,
        sizeBytes: blob.sizeBytes,
      })),
      {
        objectId: `manifest:${bundleId}`,
        sizeBytes: manifestContent.byteLength,
      },
    ],
    retainedUntil: new Date(
      now.getTime() + STAGED_BUNDLE_QUOTA_RETENTION_SECONDS * 1000,
    ).toISOString(),
  });

  const releaseFailedPublication = async (publicationError: unknown) => {
    if (admission) {
      try {
        await admission.release();
      } catch (releaseError) {
        console.error(
          "[STAGED-BUNDLE] Failed to release publication admission",
          releaseError,
        );
      }
    }
    throw publicationError;
  };

  // Wait for every in-flight blob write to settle before compensating quota;
  // Promise.all could release while a sibling PUT was still completing.
  const blobWrites = await Promise.allSettled(
    [...uniqueBlobs.entries()].map(async ([sha256, blob]) => {
      await store.uploadFile(
        bundleBlobKey(input.ownerId, sha256),
        {
          name: sha256,
          content: blob.content,
          contentType: "application/octet-stream",
        },
      );
    }),
  );
  const failedBlobWrite = blobWrites.find((result) =>
    result.status === "rejected"
  );
  if (failedBlobWrite?.status === "rejected") {
    return await releaseFailedPublication(failedBlobWrite.reason);
  }

  try {
    await store.uploadFile(
      bundleManifestKey(input.ownerId, bundleId),
      {
        name: `${bundleId}.json`,
        content: manifestContent,
        contentType: "application/json",
      },
    );
  } catch (manifestWriteError) {
    // R2 PUT responses can be ambiguous: the manifest may have committed even
    // though the transport threw. Verify the published identity before
    // releasing quota; a valid readable manifest is a successful stage.
    try {
      await resolveStagedBundle(store, {
        ownerId: input.ownerId,
        bundleId,
        now,
      });
    } catch {
      return await releaseFailedPublication(manifestWriteError);
    }
  }

  return {
    bundle_id: bundleId,
    source_hash: sourceHash,
    file_count: files.length,
    size_bytes: totalBytes,
    changed_files: changes.map((file) => file.path).sort(),
    reused_files: files
      .map((file) => file.path)
      .filter((path) => basePaths.has(path) && !changedPaths.has(path))
      .sort(),
    deleted_files: validatedDeletes.filter((path) => basePaths.has(path))
      .sort(),
    created_at: manifest.created_at,
    expires_at: manifest.expires_at,
  };
}
