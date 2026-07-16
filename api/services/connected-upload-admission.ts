import {
  ALLOWED_EXTENSIONS,
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_SIZE_BYTES,
} from "../../shared/types/index.ts";

export const MAX_CONNECTED_NON_LIVE_VERSIONS = 3;

type ConnectedUploadAdmissionDecision =
  | "deduplicate"
  | "stage"
  | "staged_version_limit";

export function decideConnectedUploadAdmission({
  verifiedIdenticalLiveDenoRedeploy,
  enforceStagedVersionLimit,
  retainedNonLiveVersions,
}: {
  verifiedIdenticalLiveDenoRedeploy: boolean;
  enforceStagedVersionLimit: boolean;
  retainedNonLiveVersions: number;
}): ConnectedUploadAdmissionDecision {
  // A retry of the exact live Deno bundle is a no-op, not another staged
  // version. Evaluate this first so a full draft history cannot turn a safe,
  // idempotent retry into a false admission failure.
  if (verifiedIdenticalLiveDenoRedeploy) return "deduplicate";
  if (
    enforceStagedVersionLimit &&
    retainedNonLiveVersions >= MAX_CONNECTED_NON_LIVE_VERSIONS
  ) {
    return "staged_version_limit";
  }
  return "stage";
}

export interface ConnectedUploadFile {
  path: string;
  content: string;
}

export function validateConnectedUploadFileSet(
  files: ConnectedUploadFile[],
): { totalBytes: number } {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("files array is required and must not be empty");
  }
  if (files.length > MAX_FILES_PER_UPLOAD) {
    throw new Error(`Maximum ${MAX_FILES_PER_UPLOAD} files allowed`);
  }

  let totalBytes = 0;
  for (const file of files) {
    const lowerPath = file.path.toLowerCase();
    if (!ALLOWED_EXTENSIONS.some((extension) => lowerPath.endsWith(extension))) {
      throw new Error(`File type not allowed: ${file.path}`);
    }
    totalBytes += new TextEncoder().encode(file.content).byteLength;
    if (totalBytes > MAX_UPLOAD_SIZE_BYTES) {
      throw new Error(
        `Total upload size exceeds ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024}MB limit`,
      );
    }
  }
  return { totalBytes };
}

export function countConnectedNonLiveVersions(
  versions: unknown,
  currentVersion: string | null | undefined,
): number {
  if (!Array.isArray(versions)) return 0;
  return new Set(
    versions.filter((version): version is string =>
      typeof version === "string" && version !== currentVersion
    ),
  ).size;
}

export function retainedNonLiveVersionBytes(
  metadata: unknown,
  currentVersion: string | null | undefined,
): number {
  if (!Array.isArray(metadata)) return 0;
  const bytesByVersion = new Map<string, number>();
  for (const rawEntry of metadata) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.version !== "string" || entry.version === currentVersion) {
      continue;
    }
    const bytes = typeof entry.size_bytes === "number"
      ? entry.size_bytes
      : typeof entry.size_bytes === "string"
      ? Number(entry.size_bytes)
      : NaN;
    if (Number.isFinite(bytes) && bytes >= 0) {
      bytesByVersion.set(entry.version, Math.trunc(bytes));
    }
  }
  return [...bytesByVersion.values()].reduce((sum, bytes) => sum + bytes, 0);
}
