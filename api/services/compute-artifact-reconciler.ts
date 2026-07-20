import { requireComputeUuid } from "./compute/authority.ts";
import { confirmComputeArtifactObjectDeleted as confirmComputeArtifactObjectDeletedRow } from "./compute/artifacts.ts";
import {
  callComputeRpc,
  type ComputeDatabaseDeps,
  firstComputeRow,
  integerString,
  nullableString,
  requiredString,
} from "./compute/database.ts";

const ARTIFACT_PREFIX = "compute-v1/";
const DEFAULT_MIN_AGE_MS = 15 * 60 * 1_000;
const MIN_RECONCILIATION_AGE_MS = 5 * 60 * 1_000;
const MAX_RECONCILIATION_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_PENDING_LIMIT = 100;
const DEFAULT_OBJECT_LIMIT = 100;
const MAX_BATCH_LIMIT = 500;
const UUID_PART =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const OUTPUT_KEY = new RegExp(
  `^compute-v1/(${UUID_PART})/(${UUID_PART})/(${UUID_PART})/outputs/(.+)$`,
  "u",
);

interface ArtifactReconciliationObject {
  key: string;
  uploaded: Date;
}

interface ArtifactReconciliationBucket {
  list(options: {
    prefix: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    objects: ArtifactReconciliationObject[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(key: string): Promise<void>;
}

export interface PendingComputeArtifactCandidate {
  artifactId: string;
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  storageKey: string;
  sha256: string;
  sizeBytes: string;
  stateVersion: string;
  artifactUpdatedAt: string;
  runState: string;
  stopRequestedAt: string | null;
}

export interface ExpiredComputeArtifactCandidate {
  artifactId: string;
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  storageKey: string;
  direction: "input" | "output";
  stateVersion: string;
  expiresAt: string;
  retentionProtectedUntil: string | null;
  runState: string;
  runFinishedAt: string;
}

export interface UnpurgedComputeArtifactCandidate {
  artifactId: string;
  storageKey: string;
  stateVersion: string;
  artifactUpdatedAt: string;
}

export type TombstoneComputeArtifactResult =
  | {
    skipped: true;
    reason: string;
  }
  | {
    skipped: false;
    artifactId: string;
    storageKey: string;
    state: "deleted";
    stateVersion: string;
    replayed: boolean;
  };

export type TombstoneExpiredComputeArtifactResult =
  | { skipped: true; reason: string }
  | {
    skipped: false;
    artifactId: string;
    storageKey: string;
    direction: "input" | "output";
    state: "deleted";
    stateVersion: string;
    deleteObject: boolean;
    replayed: boolean;
  };

interface ArtifactReconciliationCursor {
  cursor: string | null;
  stateVersion: string;
}

export type ComputeArtifactObjectDisposition =
  | { disposition: "keep"; reason: string }
  | { disposition: "delete"; reason: string; artifactId: string | null }
  | {
    disposition: "tombstone";
    reason: string;
    artifactId: string;
    stateVersion: string;
    artifactUpdatedAt: string;
  };

interface ComputeArtifactReconciliationResult {
  unpurgedCandidates: number;
  pendingCandidates: number;
  expiredCandidates: number;
  objectsScanned: number;
  tombstoned: number;
  aliasesReleased: number;
  objectsDeleted: number;
  skipped: number;
  failed: number;
  cursorAdvanced: boolean;
}

interface ComputeArtifactReconcilerDeps extends ComputeDatabaseDeps {
  bucket?: ArtifactReconciliationBucket;
  clock?: () => Date;
  listPending?: (input: {
    now: string;
    cutoff: string;
    limit: number;
  }) => Promise<PendingComputeArtifactCandidate[]>;
  listExpired?: (input: {
    now: string;
    cutoff: string;
    limit: number;
  }) => Promise<ExpiredComputeArtifactCandidate[]>;
  listUnpurged?: (input: {
    now: string;
    cutoff: string;
    limit: number;
  }) => Promise<UnpurgedComputeArtifactCandidate[]>;
  tombstone?: (input: {
    artifactId: string;
    expectedStateVersion: string;
    now: string;
    cutoff: string;
  }) => Promise<TombstoneComputeArtifactResult>;
  tombstoneExpired?: (input: {
    artifactId: string;
    expectedStateVersion: string;
    now: string;
    cutoff: string;
  }) => Promise<TombstoneExpiredComputeArtifactResult>;
  confirmObjectDeleted?: (input: {
    artifactId: string;
    storageKey: string;
    deletedAt: string;
  }) => Promise<{ replayed: boolean }>;
  getCursor?: () => Promise<ArtifactReconciliationCursor>;
  advanceCursor?: (input: {
    expectedStateVersion: string;
    cursor: string | null;
  }) => Promise<ArtifactReconciliationCursor>;
  classifyObject?: (input: {
    storageKey: string;
    runId: string;
    userId: string;
    agentId: string;
  }) => Promise<ComputeArtifactObjectDisposition>;
}

function databaseDeps(
  deps: ComputeArtifactReconcilerDeps,
): ComputeDatabaseDeps {
  return {
    fetchFn: deps.fetchFn,
    supabaseUrl: deps.supabaseUrl,
    serviceRoleKey: deps.serviceRoleKey,
    tokenPepper: deps.tokenPepper,
    now: deps.now,
  };
}

function record(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${operation} returned an invalid row`);
  }
  return value as Record<string, unknown>;
}

function exactIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function pendingCandidate(
  row: Record<string, unknown>,
): PendingComputeArtifactCandidate {
  const operation = "List stale pending Compute artifacts";
  const sha256 = requiredString(row, "sha256", operation);
  if (!/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new Error(`${operation} returned an invalid sha256`);
  }
  return {
    artifactId: requireComputeUuid(
      requiredString(row, "artifact_id", operation),
      "artifactId",
    ),
    runId: requireComputeUuid(
      requiredString(row, "run_id", operation),
      "runId",
    ),
    userId: requireComputeUuid(
      requiredString(row, "user_id", operation),
      "userId",
    ),
    agentId: requireComputeUuid(
      requiredString(row, "agent_id", operation),
      "agentId",
    ),
    callerFunction: requiredString(row, "caller_function", operation),
    storageKey: requiredString(row, "storage_key", operation),
    sha256,
    sizeBytes: integerString(row, "size_bytes", operation),
    stateVersion: integerString(row, "state_version", operation),
    artifactUpdatedAt: exactIso(row.artifact_updated_at, "artifactUpdatedAt"),
    runState: requiredString(row, "run_state", operation),
    stopRequestedAt: nullableString(row, "stop_requested_at"),
  };
}

function expiredCandidate(
  row: Record<string, unknown>,
): ExpiredComputeArtifactCandidate {
  const operation = "List expired Compute artifacts";
  const direction = requiredString(row, "direction", operation);
  if (direction !== "input" && direction !== "output") {
    throw new Error(`${operation} returned an invalid direction`);
  }
  return {
    artifactId: requireComputeUuid(
      requiredString(row, "artifact_id", operation),
      "artifactId",
    ),
    runId: requireComputeUuid(
      requiredString(row, "run_id", operation),
      "runId",
    ),
    userId: requireComputeUuid(
      requiredString(row, "user_id", operation),
      "userId",
    ),
    agentId: requireComputeUuid(
      requiredString(row, "agent_id", operation),
      "agentId",
    ),
    callerFunction: requiredString(row, "caller_function", operation),
    storageKey: requiredString(row, "storage_key", operation),
    direction,
    stateVersion: integerString(row, "state_version", operation),
    expiresAt: exactIso(row.expires_at, "expiresAt"),
    retentionProtectedUntil: row.retention_protected_until === null
      ? null
      : exactIso(row.retention_protected_until, "retentionProtectedUntil"),
    runState: requiredString(row, "run_state", operation),
    runFinishedAt: exactIso(row.run_finished_at, "runFinishedAt"),
  };
}

function unpurgedCandidate(
  row: Record<string, unknown>,
): UnpurgedComputeArtifactCandidate {
  const operation = "List unpurged Compute artifacts";
  return {
    artifactId: requireComputeUuid(
      requiredString(row, "artifact_id", operation),
      "artifactId",
    ),
    storageKey: requiredString(row, "storage_key", operation),
    stateVersion: integerString(row, "state_version", operation),
    artifactUpdatedAt: exactIso(row.artifact_updated_at, "artifactUpdatedAt"),
  };
}

async function listStalePendingComputeArtifacts(input: {
  now: string;
  cutoff: string;
  limit: number;
}, deps: ComputeDatabaseDeps = {}): Promise<PendingComputeArtifactCandidate[]> {
  const payload = await callComputeRpc("list_stale_pending_compute_artifacts", {
    p_now: exactIso(input.now, "now"),
    p_cutoff: exactIso(input.cutoff, "cutoff"),
    p_limit: input.limit,
  }, deps);
  if (!Array.isArray(payload)) {
    throw new Error(
      "List stale pending Compute artifacts returned an invalid response",
    );
  }
  return payload.map((value) =>
    pendingCandidate(record(value, "List pending artifacts"))
  );
}

async function listExpiredComputeArtifacts(input: {
  now: string;
  cutoff: string;
  limit: number;
}, deps: ComputeDatabaseDeps = {}): Promise<ExpiredComputeArtifactCandidate[]> {
  const payload = await callComputeRpc("list_expired_compute_artifacts", {
    p_now: exactIso(input.now, "now"),
    p_cutoff: exactIso(input.cutoff, "cutoff"),
    p_limit: input.limit,
  }, deps);
  if (!Array.isArray(payload)) {
    throw new Error(
      "List expired Compute artifacts returned an invalid response",
    );
  }
  return payload.map((value) =>
    expiredCandidate(record(value, "List expired artifacts"))
  );
}

async function listUnpurgedComputeArtifacts(
  input: {
    now: string;
    cutoff: string;
    limit: number;
  },
  deps: ComputeDatabaseDeps = {},
): Promise<UnpurgedComputeArtifactCandidate[]> {
  const payload = await callComputeRpc("list_unpurged_compute_artifacts", {
    p_now: exactIso(input.now, "now"),
    p_cutoff: exactIso(input.cutoff, "cutoff"),
    p_limit: input.limit,
  }, deps);
  if (!Array.isArray(payload)) {
    throw new Error(
      "List unpurged Compute artifacts returned an invalid response",
    );
  }
  return payload.map((value) =>
    unpurgedCandidate(record(value, "List unpurged artifacts"))
  );
}

async function tombstoneStalePendingComputeArtifact(input: {
  artifactId: string;
  expectedStateVersion: string;
  now: string;
  cutoff: string;
}, deps: ComputeDatabaseDeps = {}): Promise<TombstoneComputeArtifactResult> {
  const row = firstComputeRow(
    await callComputeRpc("tombstone_stale_pending_compute_artifact", {
      p_artifact_id: requireComputeUuid(input.artifactId, "artifactId"),
      p_expected_state_version: input.expectedStateVersion,
      p_now: exactIso(input.now, "now"),
      p_cutoff: exactIso(input.cutoff, "cutoff"),
    }, deps),
    "Tombstone stale pending Compute artifact",
  );
  if (row.skipped === true) {
    return {
      skipped: true,
      reason: typeof row.skip_reason === "string" ? row.skip_reason : "skipped",
    };
  }
  if (requiredString(row, "state", "Tombstone artifact") !== "deleted") {
    throw new Error("Tombstone artifact returned a non-deleted state");
  }
  return {
    skipped: false,
    artifactId: requireComputeUuid(
      requiredString(row, "id", "Tombstone artifact"),
      "artifactId",
    ),
    storageKey: requiredString(row, "storage_key", "Tombstone artifact"),
    state: "deleted",
    stateVersion: integerString(row, "state_version", "Tombstone artifact"),
    replayed: row.replayed === true,
  };
}

async function tombstoneExpiredComputeArtifact(
  input: {
    artifactId: string;
    expectedStateVersion: string;
    now: string;
    cutoff: string;
  },
  deps: ComputeDatabaseDeps = {},
): Promise<TombstoneExpiredComputeArtifactResult> {
  const row = firstComputeRow(
    await callComputeRpc("tombstone_expired_compute_artifact", {
      p_artifact_id: requireComputeUuid(input.artifactId, "artifactId"),
      p_expected_state_version: input.expectedStateVersion,
      p_now: exactIso(input.now, "now"),
      p_cutoff: exactIso(input.cutoff, "cutoff"),
    }, deps),
    "Tombstone expired Compute artifact",
  );
  if (row.skipped === true) {
    return {
      skipped: true,
      reason: typeof row.skip_reason === "string" ? row.skip_reason : "skipped",
    };
  }
  const direction = requiredString(
    row,
    "direction",
    "Tombstone expired artifact",
  );
  if (direction !== "input" && direction !== "output") {
    throw new Error("Tombstone expired artifact returned an invalid direction");
  }
  if (
    requiredString(row, "state", "Tombstone expired artifact") !== "deleted"
  ) {
    throw new Error("Tombstone expired artifact returned a non-deleted state");
  }
  const deleteObject = row.delete_object === true;
  if (deleteObject !== (direction === "output")) {
    throw new Error(
      "Tombstone expired artifact returned an unsafe delete disposition",
    );
  }
  return {
    skipped: false,
    artifactId: requireComputeUuid(
      requiredString(row, "id", "Tombstone expired artifact"),
      "artifactId",
    ),
    storageKey: requiredString(
      row,
      "storage_key",
      "Tombstone expired artifact",
    ),
    direction,
    state: "deleted",
    stateVersion: integerString(
      row,
      "state_version",
      "Tombstone expired artifact",
    ),
    deleteObject,
    replayed: row.replayed === true,
  };
}

async function confirmComputeArtifactObjectDeleted(input: {
  artifactId: string;
  storageKey: string;
  deletedAt: string;
}, deps: ComputeDatabaseDeps = {}): Promise<{ replayed: boolean }> {
  const artifact = await confirmComputeArtifactObjectDeletedRow(input, deps);
  if (!artifact?.objectDeletedAt) {
    throw new Error(
      "Confirm Compute artifact object deletion was not committed",
    );
  }
  exactIso(artifact.objectDeletedAt, "objectDeletedAt");
  return { replayed: false };
}

function reconciliationCursor(
  row: Record<string, unknown>,
): ArtifactReconciliationCursor {
  return {
    cursor: nullableString(row, "cursor"),
    stateVersion: integerString(
      row,
      "state_version",
      "Artifact reconciliation cursor",
    ),
  };
}

async function getComputeArtifactReconciliationCursor(
  deps: ComputeDatabaseDeps = {},
): Promise<ArtifactReconciliationCursor> {
  return reconciliationCursor(firstComputeRow(
    await callComputeRpc(
      "get_compute_artifact_reconciliation_cursor",
      {},
      deps,
    ),
    "Get Compute artifact reconciliation cursor",
  ));
}

async function advanceComputeArtifactReconciliationCursor(input: {
  expectedStateVersion: string;
  cursor: string | null;
}, deps: ComputeDatabaseDeps = {}): Promise<ArtifactReconciliationCursor> {
  return reconciliationCursor(firstComputeRow(
    await callComputeRpc("advance_compute_artifact_reconciliation_cursor", {
      p_expected_state_version: input.expectedStateVersion,
      p_cursor: input.cursor,
    }, deps),
    "Advance Compute artifact reconciliation cursor",
  ));
}

async function classifyComputeArtifactObject(input: {
  storageKey: string;
  runId: string;
  userId: string;
  agentId: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeArtifactObjectDisposition> {
  const row = firstComputeRow(
    await callComputeRpc("classify_compute_artifact_object", {
      p_storage_key: input.storageKey,
      p_run_id: requireComputeUuid(input.runId, "runId"),
      p_user_id: requireComputeUuid(input.userId, "userId"),
      p_agent_id: requireComputeUuid(input.agentId, "agentId"),
    }, deps),
    "Classify Compute artifact object",
  );
  const disposition = requiredString(
    row,
    "disposition",
    "Classify artifact object",
  );
  const reason = requiredString(row, "reason", "Classify artifact object");
  if (disposition === "keep") return { disposition, reason };
  if (disposition === "delete") {
    return {
      disposition,
      reason,
      artifactId: typeof row.artifact_id === "string"
        ? requireComputeUuid(row.artifact_id, "artifactId")
        : null,
    };
  }
  if (disposition !== "tombstone") {
    throw new Error("Classify artifact object returned an invalid disposition");
  }
  return {
    disposition,
    reason,
    artifactId: requireComputeUuid(
      requiredString(row, "artifact_id", "Classify artifact object"),
      "artifactId",
    ),
    stateVersion: integerString(
      row,
      "state_version",
      "Classify artifact object",
    ),
    artifactUpdatedAt: exactIso(row.artifact_updated_at, "artifactUpdatedAt"),
  };
}

export function computeOutputObjectIdentity(key: string): {
  storageKey: string;
  userId: string;
  agentId: string;
  runId: string;
} | null {
  if (
    key.length < 1 || key.length > 2048 || key.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(key)
  ) return null;
  const match = OUTPUT_KEY.exec(key);
  if (!match) return null;
  const suffix = match[4];
  if (
    suffix.split("/").some((segment) =>
      !segment || segment === "." || segment === ".."
    )
  ) return null;
  return {
    storageKey: key,
    userId: match[1],
    agentId: match[2],
    runId: match[3],
  };
}

function batchLimit(
  value: number | undefined,
  fallback: number,
  field: string,
  minimum = 1,
): number {
  const limit = value ?? fallback;
  if (
    !Number.isSafeInteger(limit) || limit < minimum || limit > MAX_BATCH_LIMIT
  ) {
    throw new Error(
      `${field} must be between ${minimum} and ${MAX_BATCH_LIMIT}`,
    );
  }
  return limit;
}

function reconciliationTimes(
  now: Date,
  minAgeMs: number | undefined,
): { now: string; cutoff: string } {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("clock returned an invalid date");
  }
  const age = minAgeMs ?? DEFAULT_MIN_AGE_MS;
  if (
    !Number.isSafeInteger(age) || age < MIN_RECONCILIATION_AGE_MS ||
    age > MAX_RECONCILIATION_AGE_MS
  ) {
    throw new Error("minAgeMs must be between 5 minutes and 30 days");
  }
  return {
    now: now.toISOString(),
    cutoff: new Date(now.getTime() - age).toISOString(),
  };
}

function artifactBucket(
  deps: ComputeArtifactReconcilerDeps,
): ArtifactReconciliationBucket {
  const bucket = deps.bucket ?? globalThis.__env?.COMPUTE_ARTIFACTS;
  if (
    !bucket || typeof bucket.list !== "function" ||
    typeof bucket.delete !== "function"
  ) throw new Error("Compute artifact bucket is unavailable");
  return bucket as ArtifactReconciliationBucket;
}

async function deleteAfterTombstone(input: {
  candidate: { artifactId: string; stateVersion: string };
  storageKey: string;
  times: { now: string; cutoff: string };
  bucket: ArtifactReconciliationBucket;
  tombstone: NonNullable<ComputeArtifactReconcilerDeps["tombstone"]>;
  confirmObjectDeleted: NonNullable<
    ComputeArtifactReconcilerDeps["confirmObjectDeleted"]
  >;
}): Promise<"deleted" | "skipped"> {
  const tombstoned = await input.tombstone({
    artifactId: input.candidate.artifactId,
    expectedStateVersion: input.candidate.stateVersion,
    ...input.times,
  });
  if (tombstoned.skipped) return "skipped";
  // SQL returns the authoritative reservation key. A mismatched caller key is
  // never deleted; it indicates a stale or malformed R2 classification.
  if (tombstoned.storageKey !== input.storageKey) return "skipped";
  await input.bucket.delete(tombstoned.storageKey);
  await input.confirmObjectDeleted({
    artifactId: tombstoned.artifactId,
    storageKey: tombstoned.storageKey,
    deletedAt: input.times.now,
  });
  return "deleted";
}

async function purgeTombstonedObject(input: {
  artifactId: string;
  storageKey: string;
  deletedAt: string;
  bucket: ArtifactReconciliationBucket;
  confirmObjectDeleted: NonNullable<
    ComputeArtifactReconcilerDeps["confirmObjectDeleted"]
  >;
}): Promise<void> {
  await input.bucket.delete(input.storageKey);
  await input.confirmObjectDeleted({
    artifactId: input.artifactId,
    storageKey: input.storageKey,
    deletedAt: input.deletedAt,
  });
}

/**
 * One bounded minute-cron pass. Database tombstones are authoritative and R2
 * deletion is compensation: no valid ready row, active retry, or ready input
 * alias is ever removed by this path.
 */
export async function runComputeArtifactReconciliationCycle(
  input: {
    pendingLimit?: number;
    retentionLimit?: number;
    purgeLimit?: number;
    objectLimit?: number;
    minAgeMs?: number;
  } = {},
  deps: ComputeArtifactReconcilerDeps = {},
): Promise<ComputeArtifactReconciliationResult> {
  const pendingLimit = batchLimit(
    input.pendingLimit,
    DEFAULT_PENDING_LIMIT,
    "pendingLimit",
  );
  const objectLimit = batchLimit(
    input.objectLimit,
    DEFAULT_OBJECT_LIMIT,
    "objectLimit",
  );
  const retentionLimit = batchLimit(
    input.retentionLimit,
    DEFAULT_PENDING_LIMIT,
    "retentionLimit",
    2,
  );
  const purgeLimit = batchLimit(
    input.purgeLimit,
    DEFAULT_PENDING_LIMIT,
    "purgeLimit",
  );
  const times = reconciliationTimes(
    (deps.clock ?? (() => new Date()))(),
    input.minAgeMs,
  );
  const db = databaseDeps(deps);
  const bucket = artifactBucket(deps);
  const listPending = deps.listPending ??
    ((value) => listStalePendingComputeArtifacts(value, db));
  const listExpired = deps.listExpired ??
    ((value) => listExpiredComputeArtifacts(value, db));
  const listUnpurged = deps.listUnpurged ??
    ((value) => listUnpurgedComputeArtifacts(value, db));
  const tombstone = deps.tombstone ??
    ((value) => tombstoneStalePendingComputeArtifact(value, db));
  const tombstoneExpired = deps.tombstoneExpired ??
    ((value) => tombstoneExpiredComputeArtifact(value, db));
  const confirmObjectDeleted = deps.confirmObjectDeleted ??
    ((value) => confirmComputeArtifactObjectDeleted(value, db));
  const getCursor = deps.getCursor ??
    (() => getComputeArtifactReconciliationCursor(db));
  const advanceCursor = deps.advanceCursor ??
    ((value) => advanceComputeArtifactReconciliationCursor(value, db));
  const classifyObject = deps.classifyObject ??
    ((value) => classifyComputeArtifactObject(value, db));

  const result: ComputeArtifactReconciliationResult = {
    unpurgedCandidates: 0,
    pendingCandidates: 0,
    expiredCandidates: 0,
    objectsScanned: 0,
    tombstoned: 0,
    aliasesReleased: 0,
    objectsDeleted: 0,
    skipped: 0,
    failed: 0,
    cursorAdvanced: false,
  };

  // Retry the authoritative DB backlog first. R2 delete is idempotent, and the
  // quota is not released until the exact confirmation commits.
  const unpurged = await listUnpurged({ ...times, limit: purgeLimit });
  result.unpurgedCandidates = unpurged.length;
  for (const candidate of unpurged) {
    try {
      await purgeTombstonedObject({
        artifactId: candidate.artifactId,
        storageKey: candidate.storageKey,
        deletedAt: times.now,
        bucket,
        confirmObjectDeleted,
      });
      result.objectsDeleted += 1;
    } catch {
      result.failed += 1;
    }
  }

  // Release terminal input aliases before considering their expired source.
  // SQL locks make a concurrent admission either establish its pin first or
  // observe the source tombstone and fail closed.
  const expired = await listExpired({ ...times, limit: retentionLimit });
  result.expiredCandidates = expired.length;
  for (const candidate of expired) {
    try {
      const tombstoned = await tombstoneExpired({
        artifactId: candidate.artifactId,
        expectedStateVersion: candidate.stateVersion,
        ...times,
      });
      if (tombstoned.skipped) {
        result.skipped += 1;
        continue;
      }
      if (tombstoned.storageKey !== candidate.storageKey) {
        result.skipped += 1;
        continue;
      }
      result.tombstoned += 1;
      if (!tombstoned.deleteObject) {
        result.aliasesReleased += 1;
        continue;
      }
      await purgeTombstonedObject({
        artifactId: tombstoned.artifactId,
        storageKey: tombstoned.storageKey,
        deletedAt: times.now,
        bucket,
        confirmObjectDeleted,
      });
      result.objectsDeleted += 1;
    } catch {
      result.failed += 1;
    }
  }

  const pending = await listPending({ ...times, limit: pendingLimit });
  result.pendingCandidates = pending.length;
  for (const candidate of pending) {
    try {
      const outcome = await deleteAfterTombstone({
        candidate: {
          artifactId: candidate.artifactId,
          stateVersion: candidate.stateVersion,
        },
        storageKey: candidate.storageKey,
        times,
        bucket,
        tombstone,
        confirmObjectDeleted,
      });
      if (outcome === "deleted") {
        result.tombstoned += 1;
        result.objectsDeleted += 1;
      } else result.skipped += 1;
    } catch {
      // A tombstone with a failed R2 delete remains safe. The object scan sees
      // the durable deleted row on its next pass and retries idempotently.
      result.failed += 1;
    }
  }

  const cursor = await getCursor();
  const listed = await bucket.list({
    prefix: ARTIFACT_PREFIX,
    limit: objectLimit,
    ...(cursor.cursor ? { cursor: cursor.cursor } : {}),
  });
  result.objectsScanned = listed.objects.length;
  const cutoffMs = Date.parse(times.cutoff);
  for (const object of listed.objects) {
    const uploaded = object.uploaded instanceof Date
      ? object.uploaded.getTime()
      : Number.NaN;
    if (!Number.isFinite(uploaded)) {
      result.failed += 1;
      continue;
    }
    if (uploaded > cutoffMs) {
      result.skipped += 1;
      continue;
    }
    const identity = computeOutputObjectIdentity(object.key);
    if (!identity) {
      // This sweeper owns only canonical output keys. Inputs and unknown keys
      // remain for the bucket lifecycle/operator policy, never guessed here.
      result.skipped += 1;
      continue;
    }
    try {
      const disposition = await classifyObject(identity);
      if (disposition.disposition === "keep") {
        result.skipped += 1;
        continue;
      }
      if (disposition.disposition === "delete") {
        if (disposition.artifactId) {
          await purgeTombstonedObject({
            artifactId: disposition.artifactId,
            storageKey: identity.storageKey,
            deletedAt: times.now,
            bucket,
            confirmObjectDeleted,
          });
        } else {
          await bucket.delete(identity.storageKey);
        }
        result.objectsDeleted += 1;
        continue;
      }
      if (Date.parse(disposition.artifactUpdatedAt) > cutoffMs) {
        result.skipped += 1;
        continue;
      }
      const outcome = await deleteAfterTombstone({
        candidate: {
          artifactId: disposition.artifactId,
          stateVersion: disposition.stateVersion,
        },
        storageKey: identity.storageKey,
        times,
        bucket,
        tombstone,
        confirmObjectDeleted,
      });
      if (outcome === "deleted") {
        result.tombstoned += 1;
        result.objectsDeleted += 1;
      } else result.skipped += 1;
    } catch {
      result.failed += 1;
    }
  }

  let cursorUsable = true;
  if (listed.truncated && !listed.cursor) {
    cursorUsable = false;
    result.failed += 1;
  }
  if (cursorUsable) {
    try {
      // Advance even when one object failed. The object remains in R2 (or in
      // the authoritative DB tombstone backlog) and is retried after the
      // bounded scan wraps to the beginning. Pinning the page cursor on a
      // permanently malformed/undeletable object would starve every later
      // page forever.
      await advanceCursor({
        expectedStateVersion: cursor.stateVersion,
        cursor: listed.truncated ? listed.cursor! : null,
      });
      result.cursorAdvanced = true;
    } catch {
      // Concurrent cron overlap repeats at most one safe/idempotent page.
      result.failed += 1;
    }
  }

  if (result.tombstoned > 0 || result.objectsDeleted > 0 || result.failed > 0) {
    console.info("[COMPUTE] Artifact reconciliation cycle", result);
  }
  return result;
}
