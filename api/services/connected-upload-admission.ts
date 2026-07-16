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
    if (
      !ALLOWED_EXTENSIONS.some((extension) => lowerPath.endsWith(extension))
    ) {
      throw new Error(`File type not allowed: ${file.path}`);
    }
    totalBytes += new TextEncoder().encode(file.content).byteLength;
    if (totalBytes > MAX_UPLOAD_SIZE_BYTES) {
      throw new Error(
        `Total upload size exceeds ${
          MAX_UPLOAD_SIZE_BYTES / 1024 / 1024
        }MB limit`,
      );
    }
  }
  return { totalBytes };
}

function connectedStagedVersionMetadata(
  metadata: unknown,
  currentVersion: string | null | undefined,
): Array<Record<string, unknown> & { version: string }> {
  if (!Array.isArray(metadata)) return [];

  const currentEntry = [...metadata].reverse().find((rawEntry) => {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      return false;
    }
    return (rawEntry as Record<string, unknown>).version === currentVersion;
  }) as Record<string, unknown> | undefined;
  const currentCreatedAt = Date.parse(
    typeof currentEntry?.created_at === "string" ? currentEntry.created_at : "",
  );

  return metadata.filter(
    (rawEntry): rawEntry is Record<string, unknown> & { version: string } => {
      if (
        !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)
      ) {
        return false;
      }
      const entry = rawEntry as Record<string, unknown>;
      if (
        typeof entry.version !== "string" || entry.version === currentVersion ||
        typeof entry.source_hash !== "string" ||
        !entry.test_attestation ||
        typeof entry.test_attestation !== "object" ||
        Array.isArray(entry.test_attestation) ||
        (entry.test_attestation as Record<string, unknown>).source_hash !==
          entry.source_hash
      ) {
        return false;
      }

      // This is the same forward-candidate boundary Agent Home uses. Historical
      // releases (including legacy rows created before staged promotion existed)
      // remain valid history, but they are not retained connected-builder drafts.
      if (!Number.isFinite(currentCreatedAt)) return true;
      const candidateCreatedAt = Date.parse(
        typeof entry.created_at === "string" ? entry.created_at : "",
      );
      return Number.isFinite(candidateCreatedAt) &&
        candidateCreatedAt > currentCreatedAt;
    },
  );
}

export function countConnectedStagedVersions(
  metadata: unknown,
  currentVersion: string | null | undefined,
): number {
  return new Set(
    connectedStagedVersionMetadata(metadata, currentVersion).map((entry) =>
      entry.version
    ),
  ).size;
}

export function retainedConnectedStagedVersionBytes(
  metadata: unknown,
  currentVersion: string | null | undefined,
): number {
  const bytesByVersion = new Map<string, number>();
  for (
    const entry of connectedStagedVersionMetadata(
      metadata,
      currentVersion,
    )
  ) {
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
