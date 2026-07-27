import type { FileUpload } from './storage.ts';
import { canonicalJson, sha256Hex } from './trust.ts';

const REVISION_PREFIX = 'gxp1_';
const DEFAULT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_CAPSULE_BYTES = 2 * 1024 * 1024;

export interface ProjectCapsuleStore {
  uploadFile(key: string, file: FileUpload): Promise<void>;
  fetchTextFile(key: string): Promise<string>;
  deleteFile(key: string): Promise<void>;
}

export interface ProjectCapsuleCleanupStore extends ProjectCapsuleStore {
  listFilesPage(
    prefix: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ keys: string[]; nextCursor: string | null }>;
}

export interface ProjectCapsuleSnapshot {
  schema_version: 1;
  identity: Record<string, unknown>;
  directive: Record<string, unknown> | null;
  release: Record<string, unknown>;
  functions: unknown[];
  data_schema: Record<string, unknown>;
  routines: unknown[];
  access: Record<string, unknown>;
  model_policy: Record<string, unknown>;
  settings: Record<string, unknown>;
  recent_failures: unknown[];
  files: unknown[];
  bundle: Record<string, unknown> | null;
}

export type ProjectCapsuleResponse =
  | {
    view: 'coding_capsule';
    app_id: string;
    revision: string;
    revision_created_at: string;
    revision_expires_at: string;
    capsule: ProjectCapsuleSnapshot;
  }
  | {
    view: 'coding_capsule';
    app_id: string;
    revision: string;
    revision_created_at: string;
    revision_expires_at: string;
    since_revision: string;
    not_modified: true;
    delta: Record<string, never>;
    removed_paths: [];
  }
  | {
    view: 'coding_capsule';
    app_id: string;
    revision: string;
    revision_created_at: string;
    revision_expires_at: string;
    since_revision: string;
    not_modified: false;
    delta: Record<string, unknown>;
    removed_paths: string[];
  };

interface PersistedCapsule {
  schema_version: 1;
  owner_id: string;
  app_id: string;
  revision: string;
  created_at: string;
  expires_at: string;
  capsule: ProjectCapsuleSnapshot;
}

export class ProjectCapsuleError extends Error {
  constructor(
    public readonly code:
      | 'invalid_revision'
      | 'revision_not_found'
      | 'app_not_live'
      | 'liveness_unavailable'
      | 'capsule_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectCapsuleError';
  }
}

const CLEANUP_PAGE_SIZE = 250;
const CLEANUP_DELETE_CONCURRENCY = 16;
const DELETE_ATTEMPTS = 3;

async function deleteWithRetry(
  store: Pick<ProjectCapsuleStore, 'deleteFile'>,
  key: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt += 1) {
    try {
      await store.deleteFile(key);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function assertLive(
  check: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!check) return;
  try {
    await check();
  } catch (error) {
    throw error instanceof ProjectCapsuleError ? error : new ProjectCapsuleError(
      'app_not_live',
      `Agent lifecycle changed while creating its coding capsule: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function storageSegment(value: string): string {
  return encodeURIComponent(value);
}

function revisionKey(ownerId: string, appId: string, revision: string): string {
  return `${revisionPrefix(ownerId, appId)}${revision}.json`;
}

function revisionPrefix(ownerId: string, appId: string): string {
  return `project-capsules/${storageSegment(ownerId)}/${storageSegment(appId)}/`;
}

function retentionSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RETENTION_SECONDS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ProjectCapsuleError(
      'invalid_revision',
      'Project revision retention must be a positive number',
    );
  }
  return Math.min(MAX_RETENTION_SECONDS, Math.floor(value));
}

function validateRevision(revision: unknown): string {
  if (
    typeof revision !== 'string' ||
    !new RegExp(`^${REVISION_PREFIX}[a-f0-9]{64}$`).test(revision)
  ) {
    throw new ProjectCapsuleError(
      'invalid_revision',
      'since_revision must be a valid Galactic project revision',
    );
  }
  return revision;
}

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function stableCapsuleSet<T>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function pointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function diffValues(
  before: unknown,
  after: unknown,
  path: string,
  removed: string[],
): unknown {
  if (canonicalJson(before) === canonicalJson(after)) return undefined;
  if (!isPlainObject(before) || !isPlainObject(after)) return after;

  const deltaEntries: Array<[string, unknown]> = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const childPath = `${path}/${pointerSegment(key)}`;
    if (!Object.hasOwn(after, key)) {
      removed.push(childPath);
      continue;
    }
    if (!Object.hasOwn(before, key)) {
      deltaEntries.push([key, after[key]]);
      continue;
    }
    const child = diffValues(before[key], after[key], childPath, removed);
    if (child !== undefined) deltaEntries.push([key, child]);
  }
  return deltaEntries.length > 0 ? Object.fromEntries(deltaEntries) : undefined;
}

export function diffProjectCapsules(
  before: ProjectCapsuleSnapshot,
  after: ProjectCapsuleSnapshot,
): { delta: Record<string, unknown>; removed_paths: string[] } {
  const removed: string[] = [];
  const changed = diffValues(before, after, '', removed);
  return {
    delta: isPlainObject(changed) ? changed : { capsule: changed },
    removed_paths: removed.sort(),
  };
}

async function loadRevision(
  store: ProjectCapsuleStore,
  ownerId: string,
  appId: string,
  revision: string,
  now: Date,
): Promise<PersistedCapsule> {
  const parsedRevision = validateRevision(revision);
  let raw: string;
  try {
    raw = await store.fetchTextFile(
      revisionKey(ownerId, appId, parsedRevision),
    );
  } catch {
    throw new ProjectCapsuleError(
      'revision_not_found',
      'Project revision was not found; request a full coding capsule',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProjectCapsuleError(
      'revision_not_found',
      'Project revision is unavailable; request a full coding capsule',
    );
  }
  if (!isPlainObject(value)) {
    throw new ProjectCapsuleError(
      'revision_not_found',
      'Project revision is unavailable; request a full coding capsule',
    );
  }
  const persisted = value as unknown as PersistedCapsule;
  if (
    persisted.schema_version !== 1 ||
    persisted.owner_id !== ownerId ||
    persisted.app_id !== appId ||
    persisted.revision !== parsedRevision ||
    typeof persisted.created_at !== 'string' ||
    !Number.isFinite(Date.parse(persisted.created_at)) ||
    typeof persisted.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(persisted.expires_at)) ||
    !isPlainObject(persisted.capsule)
  ) {
    throw new ProjectCapsuleError(
      'revision_not_found',
      'Project revision is unavailable; request a full coding capsule',
    );
  }
  const computedRevision = `${REVISION_PREFIX}${await sha256Hex(
    canonicalJson(persisted.capsule),
  )}`;
  if (computedRevision !== parsedRevision) {
    throw new ProjectCapsuleError(
      'revision_not_found',
      'Project revision failed integrity verification; request a full coding capsule',
    );
  }
  if (Date.parse(persisted.expires_at) <= now.getTime()) {
    throw new ProjectCapsuleError(
      'revision_not_found',
      'Project revision has expired; request a full coding capsule',
    );
  }
  return persisted;
}

export async function deleteProjectCapsulesForApp(
  store: ProjectCapsuleCleanupStore,
  ownerId: string,
  appId: string,
): Promise<number> {
  const prefix = revisionPrefix(ownerId, appId);
  let deleted = 0;
  while (true) {
    // Always re-read the first bounded page. Advancing an object-store cursor
    // while deleting can skip keys when page boundaries shift.
    const page = await store.listFilesPage(prefix, {
      limit: CLEANUP_PAGE_SIZE,
    });
    if (page.keys.length === 0) return deleted;
    if (page.keys.some((key) => !key.startsWith(prefix))) {
      throw new Error('Project capsule cleanup returned an out-of-scope key');
    }
    for (
      let offset = 0;
      offset < page.keys.length;
      offset += CLEANUP_DELETE_CONCURRENCY
    ) {
      const batch = page.keys.slice(
        offset,
        offset + CLEANUP_DELETE_CONCURRENCY,
      );
      await Promise.all(batch.map((key) => deleteWithRetry(store, key)));
      deleted += batch.length;
    }
  }
}

export async function projectCapsuleResponse(
  store: ProjectCapsuleStore,
  input: {
    ownerId: string;
    appId: string;
    capsule: ProjectCapsuleSnapshot;
    sinceRevision?: string;
    now?: Date;
    retentionSeconds?: number;
    /**
     * Rechecked immediately around publication. This liveness fence plus a
     * compensating delete closes every soft-delete/cleanup interleaving without
     * keeping a database transaction open across object storage.
     */
    assertAppLive?: () => Promise<void>;
  },
): Promise<ProjectCapsuleResponse> {
  const now = input.now ?? new Date();
  const canonicalCapsule = canonicalJson(input.capsule);
  const capsuleBytes = new TextEncoder().encode(canonicalCapsule).byteLength;
  if (capsuleBytes > MAX_CAPSULE_BYTES) {
    throw new ProjectCapsuleError(
      'capsule_too_large',
      `Coding capsule exceeds the ${MAX_CAPSULE_BYTES}-byte limit`,
    );
  }
  const revision = `${REVISION_PREFIX}${await sha256Hex(canonicalCapsule)}`;
  let previousRevision: string | undefined;
  let previous: PersistedCapsule | undefined;
  if (input.sinceRevision) {
    previousRevision = validateRevision(input.sinceRevision);
    if (previousRevision === revision) {
      const current = await loadRevision(
        store,
        input.ownerId,
        input.appId,
        previousRevision,
        now,
      );
      await assertLive(input.assertAppLive);
      return {
        view: 'coding_capsule',
        app_id: input.appId,
        revision,
        revision_created_at: current.created_at,
        revision_expires_at: current.expires_at,
        since_revision: previousRevision,
        not_modified: true,
        delta: {},
        removed_paths: [],
      };
    }
    previous = await loadRevision(
      store,
      input.ownerId,
      input.appId,
      previousRevision,
      now,
    );
  }
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + retentionSeconds(input.retentionSeconds) * 1000,
  ).toISOString();
  const persisted: PersistedCapsule = {
    schema_version: 1,
    owner_id: input.ownerId,
    app_id: input.appId,
    revision,
    created_at: createdAt,
    expires_at: expiresAt,
    capsule: input.capsule,
  };
  const key = revisionKey(input.ownerId, input.appId, revision);
  await assertLive(input.assertAppLive);
  await store.uploadFile(key, {
    name: `${revision}.json`,
    content: new TextEncoder().encode(JSON.stringify(persisted)),
    contentType: 'application/json',
  });
  try {
    await assertLive(input.assertAppLive);
  } catch (error) {
    try {
      await deleteWithRetry(store, key);
    } catch (cleanupError) {
      throw new ProjectCapsuleError(
        'app_not_live',
        `Agent lifecycle changed and capsule rollback failed: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
      );
    }
    throw error;
  }

  if (!input.sinceRevision) {
    return {
      view: 'coding_capsule',
      app_id: input.appId,
      revision,
      revision_created_at: createdAt,
      revision_expires_at: expiresAt,
      capsule: input.capsule,
    };
  }
  const { delta, removed_paths } = diffProjectCapsules(
    previous!.capsule,
    input.capsule,
  );
  return {
    view: 'coding_capsule',
    app_id: input.appId,
    revision,
    revision_created_at: createdAt,
    revision_expires_at: expiresAt,
    since_revision: previousRevision!,
    not_modified: false,
    delta,
    removed_paths,
  };
}
