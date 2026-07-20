import {
  requireComputeCallerFunction,
  requireComputeUuid,
} from "./authority.ts";
import {
  callComputeRpc,
  type ComputeDatabaseDeps,
  firstComputeRow,
  integerString,
  nullableString,
  queryComputeRows,
  requiredString,
} from "./database.ts";
import type { ComputeArtifact } from "./types.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MEDIA_TYPE_PATTERN =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/;

function exactText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (
    !normalized || normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) throw new Error(`${field} is invalid`);
  return normalized;
}

function nonNegativeInteger(
  value: string | number | bigint | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return BigInt(normalized).toString();
}

export function mapComputeArtifactRow(
  row: Record<string, unknown>,
): ComputeArtifact {
  const operation = "Compute artifact";
  const direction = requiredString(row, "direction", operation);
  const state = requiredString(row, "state", operation);
  if (direction !== "input" && direction !== "output") {
    throw new Error("Compute artifact returned an invalid direction");
  }
  if (state !== "pending" && state !== "ready" && state !== "deleted") {
    throw new Error("Compute artifact returned an invalid state");
  }
  return {
    id: requiredString(row, "id", operation),
    runId: requiredString(row, "run_id", operation),
    userId: requiredString(row, "user_id", operation),
    sourceArtifactId: nullableString(row, "source_artifact_id"),
    direction,
    mountPath: nullableString(row, "mount_path"),
    logicalName: requiredString(row, "logical_name", operation),
    mediaType: requiredString(row, "media_type", operation),
    storageKey: requiredString(row, "storage_key", operation),
    sha256: nullableString(row, "sha256"),
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined
      ? null
      : integerString(row, "size_bytes", operation),
    state,
    stateVersion: integerString(row, "state_version", operation),
    expiresAt: nullableString(row, "expires_at"),
    retentionProtectedUntil: nullableString(row, "retention_protected_until"),
    objectDeletedAt: nullableString(row, "object_deleted_at"),
    createdAt: requiredString(row, "created_at", operation),
    updatedAt: requiredString(row, "updated_at", operation),
  };
}

async function artifactRequestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function registerComputeArtifact(input: {
  artifactId: string;
  idempotencyKey: string;
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  storageKey: string;
  direction: "output";
  logicalName: string;
  mediaType: string;
  sha256?: string | null;
  sizeBytes?: string | number | bigint | null;
}, deps: ComputeDatabaseDeps = {}): Promise<{
  artifact: ComputeArtifact;
  replayed: boolean;
}> {
  if (input.direction !== "output") {
    throw new Error("only running gx output artifacts may be registered");
  }
  const mediaType = exactText(input.mediaType, "mediaType", 255).toLowerCase();
  if (!MEDIA_TYPE_PATTERN.test(mediaType)) {
    throw new Error("mediaType is invalid");
  }
  const sha = input.sha256 === undefined || input.sha256 === null
    ? null
    : exactText(input.sha256, "sha256", 64).toLowerCase();
  if (sha !== null && !SHA256_PATTERN.test(sha)) {
    throw new Error("sha256 must contain 64 hexadecimal characters");
  }
  const normalized = {
    artifactId: requireComputeUuid(input.artifactId, "artifactId"),
    idempotencyKey: requireComputeUuid(input.idempotencyKey, "idempotencyKey"),
    runId: requireComputeUuid(input.runId, "runId"),
    userId: requireComputeUuid(input.userId, "userId"),
    agentId: requireComputeUuid(input.agentId, "agentId"),
    callerFunction: requireComputeCallerFunction(input.callerFunction),
    storageKey: exactText(input.storageKey, "storageKey", 2048),
    direction: input.direction,
    logicalName: exactText(input.logicalName, "logicalName", 512),
    mediaType,
    sha256: sha,
    sizeBytes: nonNegativeInteger(input.sizeBytes, "sizeBytes"),
  };
  // Idempotency describes the body-selected artifact metadata. artifactId and
  // storageKey are server-generated placement values and intentionally do not
  // participate: a retry proposes fresh values, while SQL returns the
  // originally reserved row and the gateway writes that row's storage key.
  const requestHash = await artifactRequestHash({
    idempotencyKey: normalized.idempotencyKey,
    runId: normalized.runId,
    userId: normalized.userId,
    agentId: normalized.agentId,
    callerFunction: normalized.callerFunction,
    direction: normalized.direction,
    logicalName: normalized.logicalName,
    mediaType: normalized.mediaType,
    sha256: normalized.sha256,
    sizeBytes: normalized.sizeBytes,
  });
  const payload = await callComputeRpc("register_compute_artifact", {
    p_idempotency_key: normalized.idempotencyKey,
    p_artifact_id: normalized.artifactId,
    p_request_hash: requestHash,
    p_run_id: normalized.runId,
    p_user_id: normalized.userId,
    p_agent_id: normalized.agentId,
    p_caller_function: normalized.callerFunction,
    p_storage_key: normalized.storageKey,
    p_direction: normalized.direction,
    p_logical_name: normalized.logicalName,
    p_media_type: normalized.mediaType,
    p_sha256: normalized.sha256,
    p_size_bytes: normalized.sizeBytes,
  }, deps);
  const row = firstComputeRow(payload, "Register Compute artifact");
  return {
    artifact: mapComputeArtifactRow(row),
    replayed: row.replayed === true,
  };
}

export async function transitionComputeArtifact(input: {
  artifactId: string;
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  expectedState: "pending" | "ready";
  expectedStateVersion: string | number | bigint;
  toState: "ready" | "deleted";
  sha256?: string | null;
  sizeBytes?: string | number | bigint | null;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeArtifact> {
  const expectedVersion = nonNegativeInteger(
    input.expectedStateVersion,
    "expectedStateVersion",
  );
  if (expectedVersion === null || expectedVersion === "0") {
    throw new Error("expectedStateVersion must be positive");
  }
  const sha = input.sha256 === undefined || input.sha256 === null
    ? null
    : exactText(input.sha256, "sha256", 64).toLowerCase();
  if (sha !== null && !SHA256_PATTERN.test(sha)) {
    throw new Error("sha256 must contain 64 hexadecimal characters");
  }
  const payload = await callComputeRpc("transition_compute_artifact", {
    p_artifact_id: requireComputeUuid(input.artifactId, "artifactId"),
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_user_id: requireComputeUuid(input.userId, "userId"),
    p_agent_id: requireComputeUuid(input.agentId, "agentId"),
    p_caller_function: requireComputeCallerFunction(input.callerFunction),
    p_expected_state: input.expectedState,
    p_expected_state_version: expectedVersion,
    p_to_state: input.toState,
    p_sha256: sha,
    p_size_bytes: nonNegativeInteger(input.sizeBytes, "sizeBytes"),
  }, deps);
  return mapComputeArtifactRow(
    firstComputeRow(payload, "Transition Compute artifact"),
  );
}

export async function getComputeArtifact(input: {
  artifactId: string;
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeArtifact | null> {
  const filters = [
    `id=eq.${
      encodeURIComponent(requireComputeUuid(input.artifactId, "artifactId"))
    }`,
    `run_id=eq.${encodeURIComponent(requireComputeUuid(input.runId, "runId"))}`,
    `user_id=eq.${
      encodeURIComponent(requireComputeUuid(input.userId, "userId"))
    }`,
    `run.agent_id=eq.${
      encodeURIComponent(requireComputeUuid(input.agentId, "agentId"))
    }`,
    `run.caller_function=eq.${
      encodeURIComponent(requireComputeCallerFunction(input.callerFunction))
    }`,
    "select=*,run:compute_runs!inner(agent_id,caller_function)",
    "limit=1",
  ];
  const rows = await queryComputeRows(
    `compute_artifacts?${filters.join("&")}`,
    deps,
  );
  return rows[0] ? mapComputeArtifactRow(rows[0]) : null;
}

/**
 * Authorize one owner download and atomically take the bounded SQL deletion
 * lease. An expired/tombstoned artifact returns null and is never revived.
 */
export async function leaseComputeArtifactOwnerDownload(input: {
  artifactId: string;
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeArtifact | null> {
  const payload = await callComputeRpc(
    "lease_compute_artifact_owner_download",
    {
      p_artifact_id: requireComputeUuid(input.artifactId, "artifactId"),
      p_run_id: requireComputeUuid(input.runId, "runId"),
      p_user_id: requireComputeUuid(input.userId, "userId"),
      p_agent_id: requireComputeUuid(input.agentId, "agentId"),
      p_caller_function: requireComputeCallerFunction(input.callerFunction),
    },
    deps,
  );
  if (!Array.isArray(payload) || payload.length === 0) return null;
  return mapComputeArtifactRow(
    firstComputeRow(payload, "Lease Compute artifact owner download"),
  );
}

/** Commit physical quota release after the exact R2 delete succeeds. */
export async function confirmComputeArtifactObjectDeleted(input: {
  artifactId: string;
  storageKey: string;
  deletedAt: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeArtifact | null> {
  if (!Number.isFinite(Date.parse(input.deletedAt))) {
    throw new Error("deletedAt must be an ISO timestamp");
  }
  const row = firstComputeRow(
    await callComputeRpc("confirm_compute_artifact_object_deleted", {
      p_artifact_id: requireComputeUuid(input.artifactId, "artifactId"),
      p_storage_key: exactText(input.storageKey, "storageKey", 2048),
      p_deleted_at: new Date(input.deletedAt).toISOString(),
    }, deps),
    "Confirm Compute artifact object deletion",
  );
  if (row.skipped === true) return null;
  return mapComputeArtifactRow(row);
}

/** Resolve only an admission-snapshotted current-run input by its source ID. */
export async function getComputeRunInputArtifactBySource(input: {
  sourceArtifactId: string;
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeArtifact | null> {
  const filters = [
    `source_artifact_id=eq.${
      encodeURIComponent(
        requireComputeUuid(input.sourceArtifactId, "sourceArtifactId"),
      )
    }`,
    `run_id=eq.${encodeURIComponent(requireComputeUuid(input.runId, "runId"))}`,
    `user_id=eq.${
      encodeURIComponent(requireComputeUuid(input.userId, "userId"))
    }`,
    "direction=eq.input",
    "state=eq.ready",
    `run.agent_id=eq.${
      encodeURIComponent(requireComputeUuid(input.agentId, "agentId"))
    }`,
    `run.caller_function=eq.${
      encodeURIComponent(requireComputeCallerFunction(input.callerFunction))
    }`,
    "select=*,run:compute_runs!inner(agent_id,caller_function)",
    "limit=1",
  ];
  const rows = await queryComputeRows(
    `compute_artifacts?${filters.join("&")}`,
    deps,
  );
  return rows[0] ? mapComputeArtifactRow(rows[0]) : null;
}

export async function listComputeArtifacts(input: {
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  direction?: "input" | "output";
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeArtifact[]> {
  if (
    input.direction !== undefined && input.direction !== "input" &&
    input.direction !== "output"
  ) throw new Error("direction must be input or output");
  const filters = [
    `run_id=eq.${encodeURIComponent(requireComputeUuid(input.runId, "runId"))}`,
    `user_id=eq.${
      encodeURIComponent(requireComputeUuid(input.userId, "userId"))
    }`,
    `run.agent_id=eq.${
      encodeURIComponent(requireComputeUuid(input.agentId, "agentId"))
    }`,
    `run.caller_function=eq.${
      encodeURIComponent(requireComputeCallerFunction(input.callerFunction))
    }`,
    "select=*,run:compute_runs!inner(agent_id,caller_function)",
    "order=created_at.asc",
  ];
  if (input.direction) filters.push(`direction=eq.${input.direction}`);
  const rows = await queryComputeRows(
    `compute_artifacts?${filters.join("&")}`,
    deps,
  );
  return rows.map(mapComputeArtifactRow);
}
