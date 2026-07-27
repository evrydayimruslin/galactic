import type { App, VersionMetadata } from '../../shared/types/index.ts';

export interface BundleLineageUpdate {
  versionMetadata: VersionMetadata[];
  changed: boolean;
}

type LineageApp = Pick<
  App,
  | 'id'
  | 'owner_id'
  | 'current_version'
  | 'version_metadata'
  | 'updated_at'
>;

export interface BundleLineageStore {
  compareAndSwapVersionMetadata(input: {
    appId: string;
    ownerId: string;
    expectedUpdatedAt: string;
    expectedCurrentVersion: string | null;
    versionMetadata: VersionMetadata[];
  }): Promise<boolean>;
  findById(appId: string): Promise<LineageApp | null>;
}

export class BundleLineageConflictError extends Error {
  constructor() {
    super(
      'The live Agent changed while bundle lineage was being recorded; retry the upload.',
    );
    this.name = 'BundleLineageConflictError';
  }
}

/**
 * Attach staged-bundle lineage to the metadata row created for an Agent's
 * initial version. New-Agent uploads use a separate persistence path from
 * existing-version uploads, so keeping this step explicit prevents the initial
 * gx.stage -> gx.upload transition from silently dropping its bundle identity.
 */
export function withInitialVersionBundleLineage(
  metadata: VersionMetadata,
  bundleId?: string,
): VersionMetadata {
  return bundleId ? { ...metadata, bundle_id: bundleId } : metadata;
}

/**
 * Attach a content-addressed builder bundle to the latest matching live
 * metadata row. Deduplicated uploads do not create a new version, so lineage
 * must be recorded on the existing live row instead.
 *
 * The source-hash check is deliberate: it prevents a stale retry from
 * associating a bundle with a live version that changed after admission.
 */
export function withLiveVersionBundleLineage(
  versionMetadata: VersionMetadata[] | null | undefined,
  currentVersion: string | null | undefined,
  sourceHash: string,
  bundleId: string,
): BundleLineageUpdate {
  const metadata = Array.isArray(versionMetadata) ? versionMetadata : [];

  for (let index = metadata.length - 1; index >= 0; index -= 1) {
    const entry = metadata[index];
    if (
      entry.version !== currentVersion ||
      entry.source_hash !== sourceHash
    ) {
      continue;
    }
    if (entry.bundle_id === bundleId) {
      return { versionMetadata: metadata, changed: false };
    }

    const updated = [...metadata];
    updated[index] = { ...entry, bundle_id: bundleId };
    return { versionMetadata: updated, changed: true };
  }

  return { versionMetadata: metadata, changed: false };
}

/**
 * Persist lineage with optimistic concurrency. A losing writer reloads the
 * latest metadata and retries, preserving any concurrently appended versions.
 */
export async function persistDeduplicatedBundleLineage(input: {
  app: LineageApp;
  ownerId: string;
  sourceHash: string;
  bundleId: string;
  store: BundleLineageStore;
  maxAttempts?: number;
}): Promise<{ changed: boolean }> {
  const expectedVersion = input.app.current_version;
  let candidate = input.app;
  const maxAttempts = input.maxAttempts ?? 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (
      candidate.owner_id !== input.ownerId ||
      candidate.current_version !== expectedVersion
    ) {
      throw new BundleLineageConflictError();
    }
    const lineage = withLiveVersionBundleLineage(
      candidate.version_metadata,
      expectedVersion,
      input.sourceHash,
      input.bundleId,
    );
    if (!lineage.changed) {
      const recorded = [...(candidate.version_metadata || [])].reverse().find(
        (entry) =>
          entry.version === expectedVersion &&
          entry.source_hash === input.sourceHash,
      );
      if (recorded?.bundle_id === input.bundleId) {
        return { changed: false };
      }
      throw new BundleLineageConflictError();
    }

    const updated = await input.store.compareAndSwapVersionMetadata({
      appId: candidate.id,
      ownerId: input.ownerId,
      expectedUpdatedAt: candidate.updated_at,
      expectedCurrentVersion: expectedVersion,
      versionMetadata: lineage.versionMetadata,
    });
    if (updated) return { changed: true };

    const reloaded = await input.store.findById(candidate.id);
    if (!reloaded) throw new BundleLineageConflictError();
    candidate = reloaded;
  }

  throw new BundleLineageConflictError();
}
