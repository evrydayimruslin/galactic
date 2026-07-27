import { assertEquals, assertStrictEquals } from 'jsr:@std/assert';

import type { VersionMetadata } from '../../shared/types/index.ts';
import {
  persistDeduplicatedBundleLineage,
  withInitialVersionBundleLineage,
  withLiveVersionBundleLineage,
} from './upload-lineage.ts';

const HASH = 'a'.repeat(64);
const BUNDLE_ID = `gxb1_${'b'.repeat(64)}`;

Deno.test('initial staged Deno upload metadata persists bundle lineage', () => {
  const metadata: VersionMetadata = {
    version: '1.0.0',
    created_at: '2026-01-01T00:00:00.000Z',
    size_bytes: 10,
    source_hash: HASH,
  };

  assertEquals(
    withInitialVersionBundleLineage(metadata, BUNDLE_ID),
    { ...metadata, bundle_id: BUNDLE_ID },
  );
  assertStrictEquals(
    withInitialVersionBundleLineage(metadata),
    metadata,
  );
});

Deno.test('deduplicated bundle upload records lineage on the latest matching live row', () => {
  const metadata: VersionMetadata[] = [
    {
      version: '1.0.0',
      created_at: '2026-01-01T00:00:00.000Z',
      size_bytes: 10,
      source_hash: HASH,
      bundle_id: `gxb1_${'0'.repeat(64)}`,
    },
    {
      version: '1.1.0',
      created_at: '2026-01-02T00:00:00.000Z',
      size_bytes: 20,
      source_hash: HASH,
      test_attestation: {
        schema_version: 1,
        attestation_id: 'attestation',
        mode: 'deno_execution',
        source_hash: HASH,
        tested_at: '2026-01-02T00:00:00.000Z',
        token_expires_at: '2026-01-02T00:15:00.000Z',
        verified_at: '2026-01-02T00:00:01.000Z',
      },
    },
    {
      // Duplicate version rows can exist in legacy metadata. The latest
      // source-bearing row is the same one dedup lookup uses.
      version: '1.1.0',
      created_at: '2026-01-03T00:00:00.000Z',
      size_bytes: 21,
      source_hash: HASH,
    },
  ];

  const result = withLiveVersionBundleLineage(
    metadata,
    '1.1.0',
    HASH,
    BUNDLE_ID,
  );

  assertEquals(result.changed, true);
  assertEquals(result.versionMetadata[2], {
    ...metadata[2],
    bundle_id: BUNDLE_ID,
  });
  assertStrictEquals(result.versionMetadata[0], metadata[0]);
  assertStrictEquals(result.versionMetadata[1], metadata[1]);
  assertEquals(metadata[2].bundle_id, undefined);
});

Deno.test('bundle lineage update is idempotent and source-bound', () => {
  const metadata: VersionMetadata[] = [{
    version: '1.0.0',
    created_at: '2026-01-01T00:00:00.000Z',
    size_bytes: 10,
    source_hash: HASH,
    bundle_id: BUNDLE_ID,
  }];

  const repeated = withLiveVersionBundleLineage(
    metadata,
    '1.0.0',
    HASH,
    BUNDLE_ID,
  );
  assertEquals(repeated.changed, false);
  assertStrictEquals(repeated.versionMetadata, metadata);

  const stale = withLiveVersionBundleLineage(
    metadata,
    '1.0.0',
    'c'.repeat(64),
    `gxb1_${'d'.repeat(64)}`,
  );
  assertEquals(stale.changed, false);
  assertStrictEquals(stale.versionMetadata, metadata);
});

Deno.test('bundle lineage CAS reloads and preserves a concurrently appended version', async () => {
  const live: VersionMetadata = {
    version: '1.0.0',
    created_at: '2026-01-01T00:00:00.000Z',
    size_bytes: 10,
    source_hash: HASH,
  };
  const concurrent: VersionMetadata = {
    version: '1.1.0',
    created_at: '2026-01-01T00:01:00.000Z',
    size_bytes: 11,
    source_hash: 'c'.repeat(64),
  };
  const writes: VersionMetadata[][] = [];
  const writeOwners: string[] = [];
  let attempts = 0;

  const result = await persistDeduplicatedBundleLineage({
    app: {
      id: 'app-id',
      owner_id: 'owner-id',
      current_version: '1.0.0',
      version_metadata: [live],
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    ownerId: 'owner-id',
    sourceHash: HASH,
    bundleId: BUNDLE_ID,
    store: {
      compareAndSwapVersionMetadata(input) {
        writes.push(input.versionMetadata);
        writeOwners.push(input.ownerId);
        attempts += 1;
        return Promise.resolve(attempts === 2);
      },
      findById() {
        return Promise.resolve({
          id: 'app-id',
          owner_id: 'owner-id',
          current_version: '1.0.0',
          version_metadata: [live, concurrent],
          updated_at: '2026-01-01T00:01:00.000Z',
        });
      },
    },
  });

  assertEquals(result, { changed: true });
  assertEquals(writes.length, 2);
  assertEquals(writeOwners, ['owner-id', 'owner-id']);
  assertEquals(writes[1], [
    { ...live, bundle_id: BUNDLE_ID },
    concurrent,
  ]);
});
