import { assertEquals, assertRejects } from 'jsr:@std/assert';
import {
  resolveStagedBundle,
  stageBundle,
  type StagedBundleAdmissionRequest,
  StagedBundleError,
  type StagedBundleStore,
} from './staged-bundles.ts';
import type { FileUpload } from './storage.ts';
import { sha256Hex } from './trust.ts';

class MemoryBundleStore implements StagedBundleStore {
  readonly values = new Map<string, Uint8Array>();
  readonly uploads: string[] = [];

  async uploadFile(key: string, file: FileUpload): Promise<void> {
    this.uploads.push(key);
    this.values.set(key, file.content.slice());
  }

  async fetchTextFile(key: string): Promise<string> {
    const value = this.values.get(key);
    if (!value) throw new Error(`File not found: ${key}`);
    return new TextDecoder().decode(value);
  }

  async fetchFile(key: string): Promise<Uint8Array> {
    const value = this.values.get(key);
    if (!value) throw new Error(`File not found: ${key}`);
    return value.slice();
  }
}

class LifecycleBundleStore extends MemoryBundleStore {
  readonly uploadedAt = new Map<string, number>();
  private nowMs = 0;

  constructor(private readonly lifecycleMs: number) {
    super();
  }

  setNow(now: Date): void {
    this.nowMs = now.getTime();
  }

  override async uploadFile(key: string, file: FileUpload): Promise<void> {
    await super.uploadFile(key, file);
    this.uploadedAt.set(key, this.nowMs);
  }

  private expireObjects(): void {
    for (const [storedKey, uploadedAt] of this.uploadedAt) {
      if (this.nowMs - uploadedAt >= this.lifecycleMs) {
        this.values.delete(storedKey);
        this.uploadedAt.delete(storedKey);
      }
    }
  }

  override async fetchTextFile(key: string): Promise<string> {
    this.expireObjects();
    return await super.fetchTextFile(key);
  }

  override async fetchFile(key: string): Promise<Uint8Array> {
    this.expireObjects();
    return await super.fetchFile(key);
  }
}

Deno.test('stageBundle is content-addressed and idempotent', async () => {
  const store = new MemoryBundleStore();
  const now = new Date('2026-07-27T12:00:00.000Z');
  const input = {
    ownerId: 'user-1',
    files: [
      { path: 'manifest.json', content: '{"name":"invoice-agent"}' },
      { path: 'index.ts', content: 'export const answer = 42;' },
    ],
    now,
  };

  const first = await stageBundle(store, input);
  const uploadsAfterFirst = store.uploads.length;
  const second = await stageBundle(store, {
    ...input,
    now: new Date('2026-07-27T12:05:00.000Z'),
  });

  assertEquals(first.bundle_id, second.bundle_id);
  assertEquals(first.source_hash, second.source_hash);
  assertEquals(first.created_at, second.created_at);
  assertEquals(store.uploads.length, uploadsAfterFirst);
  assertEquals(first.bundle_id.startsWith('gxb1_'), true);
});

Deno.test('incremental stage uploads changes and reuses unchanged base files', async () => {
  const store = new MemoryBundleStore();
  const base = await stageBundle(store, {
    ownerId: 'user-1',
    files: [
      { path: 'manifest.json', content: '{"name":"agent"}' },
      { path: 'index.ts', content: 'export const version = 1;' },
      { path: 'old.ts', content: 'export const old = true;' },
    ],
    now: new Date('2026-07-27T12:00:00.000Z'),
  });
  const uploadsBeforeDelta = store.uploads.length;

  const delta = await stageBundle(store, {
    ownerId: 'user-1',
    baseBundleId: base.bundle_id,
    files: [{ path: 'index.ts', content: 'export const version = 2;' }],
    deletePaths: ['old.ts'],
    now: new Date('2026-07-27T12:10:00.000Z'),
  });
  const resolved = await resolveStagedBundle(store, {
    ownerId: 'user-1',
    bundleId: delta.bundle_id,
    now: new Date('2026-07-27T12:11:00.000Z'),
  });

  assertEquals(delta.changed_files, ['index.ts']);
  assertEquals(delta.reused_files, ['manifest.json']);
  assertEquals(delta.deleted_files, ['old.ts']);
  assertEquals(resolved.files, [
    { path: 'index.ts', content: 'export const version = 2;' },
    { path: 'manifest.json', content: '{"name":"agent"}' },
  ]);
  const deltaUploads = store.uploads.slice(uploadsBeforeDelta);
  assertEquals(deltaUploads.length, 3); // both live blobs + manifest
  assertEquals(
    deltaUploads.slice(0, -1).every((key) => key.includes('/blobs/')),
    true,
  );
  assertEquals(
    deltaUploads.at(-1)?.endsWith(`/bundles/${delta.bundle_id}.json`),
    true,
  );
});

Deno.test('staged bundles preserve byte-exact wasm through incremental resolution', async () => {
  const store = new MemoryBundleStore();
  const wasmBytes = new Uint8Array([0, 97, 255, 128]);
  const base = await stageBundle(store, {
    ownerId: 'user-1',
    files: [
      { path: 'index.ts', content: 'export const version = 1;' },
      { path: 'module.wasm', content: 'AGH/gA==', encoding: 'base64' },
    ],
  });

  const delta = await stageBundle(store, {
    ownerId: 'user-1',
    baseBundleId: base.bundle_id,
    files: [{ path: 'index.ts', content: 'export const version = 2;' }],
  });
  const resolved = await resolveStagedBundle(store, {
    ownerId: 'user-1',
    bundleId: delta.bundle_id,
  });
  const wasm = resolved.files.find((file) => file.path === 'module.wasm');
  const wasmHash = await sha256Hex(wasmBytes);

  assertEquals(wasm?.bytes, wasmBytes);
  assertEquals(delta.size_bytes, wasmBytes.byteLength + 25);
  assertEquals(
    store.uploads.some((key) => key.endsWith(`/blobs/${wasmHash}`)),
    true,
  );
  assertEquals(
    [...store.values.entries()].some(([, bytes]) =>
      bytes.length === wasmBytes.length &&
      bytes.every((byte, index) => byte === wasmBytes[index])
    ),
    true,
  );
});

Deno.test('incremental stages renew unchanged blobs across lifecycle windows', async () => {
  const lifecycleMs = 7 * 24 * 60 * 60 * 1000;
  const store = new LifecycleBundleStore(lifecycleMs);
  const startMs = Date.parse('2026-07-01T00:00:00.000Z');
  const start = new Date(startMs);
  store.setNow(start);
  let current = await stageBundle(store, {
    ownerId: 'user-1',
    files: [
      { path: 'stable.ts', content: 'export const stable = true;' },
      { path: 'index.ts', content: 'export const revision = 0;' },
    ],
    now: start,
  });

  // Each delta arrives before its 24-hour base lease expires. By the eighth
  // delta the original stable blob is older than the R2 lifecycle window, so
  // resolution succeeds only if every newer manifest renewed that blob.
  for (let revision = 1; revision <= 8; revision += 1) {
    const now = new Date(startMs + revision * 23 * 60 * 60 * 1000);
    store.setNow(now);
    current = await stageBundle(store, {
      ownerId: 'user-1',
      baseBundleId: current.bundle_id,
      files: [{
        path: 'index.ts',
        content: `export const revision = ${revision};`,
      }],
      now,
    });
  }

  const resolveAt = new Date(startMs + (8 * 23 + 1) * 60 * 60 * 1000);
  store.setNow(resolveAt);
  const resolved = await resolveStagedBundle(store, {
    ownerId: 'user-1',
    bundleId: current.bundle_id,
    now: resolveAt,
  });
  assertEquals(resolved.files, [
    { path: 'index.ts', content: 'export const revision = 8;' },
    { path: 'stable.ts', content: 'export const stable = true;' },
  ]);
});

Deno.test('stageBundle stores identical contents once and publishes the manifest last', async () => {
  const store = new MemoryBundleStore();
  const staged = await stageBundle(store, {
    ownerId: 'user-1',
    files: [
      { path: 'a.ts', content: 'export const shared = true;' },
      { path: 'b.ts', content: 'export const shared = true;' },
    ],
  });

  assertEquals(staged.file_count, 2);
  assertEquals(store.uploads.length, 2);
  assertEquals(store.uploads[0].includes('/blobs/'), true);
  assertEquals(
    store.uploads[1].endsWith(`/bundles/${staged.bundle_id}.json`),
    true,
  );
});

Deno.test('stageBundle never publishes a manifest after a blob write fails', async () => {
  class FailingBlobStore extends MemoryBundleStore {
    override uploadFile(key: string, file: FileUpload): Promise<void> {
      if (key.includes('/blobs/')) {
        return Promise.reject(new Error('injected blob failure'));
      }
      return super.uploadFile(key, file);
    }
  }

  const store = new FailingBlobStore();
  let releases = 0;
  await assertRejects(
    () =>
      stageBundle(store, {
        ownerId: 'user-1',
        files: [{ path: 'index.ts', content: 'export default 1;' }],
        admit: () =>
          Promise.resolve({
            release: () => {
              releases += 1;
              return Promise.resolve();
            },
          }),
      }),
    Error,
    'blob failure',
  );
  assertEquals(
    store.uploads.some((key) => key.includes('/bundles/')),
    false,
  );
  assertEquals(releases, 1);
});

Deno.test('stageBundle releases only its admission after publication failure', async () => {
  class FailingManifestStore extends MemoryBundleStore {
    override uploadFile(key: string, file: FileUpload): Promise<void> {
      if (key.includes('/bundles/')) {
        return Promise.reject(new Error('injected manifest failure'));
      }
      return super.uploadFile(key, file);
    }
  }

  const store = new FailingManifestStore();
  let releases = 0;
  const error = await assertRejects(
    () =>
      stageBundle(store, {
        ownerId: 'user-1',
        files: [{ path: 'index.ts', content: 'export default 1;' }],
        admit: () =>
          Promise.resolve({
            release: () => {
              releases += 1;
              return Promise.reject(new Error('injected release failure'));
            },
          }),
      }),
    Error,
    'manifest failure',
  );

  assertEquals(error.message, 'injected manifest failure');
  assertEquals(releases, 1);
  assertEquals(
    store.uploads.some((key) => key.includes('/bundles/')),
    false,
  );
});

Deno.test('stageBundle keeps admission when a manifest write commits before throwing', async () => {
  class AmbiguousManifestStore extends MemoryBundleStore {
    override async uploadFile(key: string, file: FileUpload): Promise<void> {
      await super.uploadFile(key, file);
      if (key.includes('/bundles/')) {
        throw new Error('ambiguous manifest response');
      }
    }
  }

  const store = new AmbiguousManifestStore();
  let releases = 0;
  const staged = await stageBundle(store, {
    ownerId: 'user-1',
    files: [{ path: 'index.ts', content: 'export default 1;' }],
    admit: () =>
      Promise.resolve({
        release: () => {
          releases += 1;
          return Promise.resolve();
        },
      }),
  });

  assertEquals(releases, 0);
  assertEquals(
    (await resolveStagedBundle(store, {
      ownerId: 'user-1',
      bundleId: staged.bundle_id,
    })).manifest.bundle_id,
    staged.bundle_id,
  );
});

Deno.test('stageBundle retains its admission after successful publication', async () => {
  const store = new MemoryBundleStore();
  let releases = 0;
  await stageBundle(store, {
    ownerId: 'user-1',
    files: [{ path: 'index.ts', content: 'export default 1;' }],
    admit: () =>
      Promise.resolve({
        release: () => {
          releases += 1;
          return Promise.resolve();
        },
      }),
  });
  assertEquals(releases, 0);
});

Deno.test('stageBundle admission runs before writes and is skipped for an idempotent retry', async () => {
  const store = new MemoryBundleStore();
  const admissions: StagedBundleAdmissionRequest[] = [];
  const input = {
    ownerId: 'user-1',
    files: [{ path: 'index.ts', content: 'export default 1;' }],
    now: new Date('2026-07-27T12:00:00.000Z'),
    admit: (request: StagedBundleAdmissionRequest) => {
      assertEquals(store.uploads, []);
      admissions.push(request);
      return Promise.resolve();
    },
  };

  const first = await stageBundle(store, input);
  const uploadCount = store.uploads.length;
  await stageBundle(store, {
    ...input,
    now: new Date('2026-07-27T12:05:00.000Z'),
  });

  assertEquals(admissions.length, 1);
  assertEquals(admissions[0].bundleId, first.bundle_id);
  assertEquals(admissions[0].objects.length, 2);
  assertEquals(
    admissions[0].objects.some((object) => object.objectId === `manifest:${first.bundle_id}`),
    true,
  );
  assertEquals(store.uploads.length, uploadCount);
});

Deno.test('stageBundle writes nothing when storage admission rejects', async () => {
  const store = new MemoryBundleStore();
  await assertRejects(
    () =>
      stageBundle(store, {
        ownerId: 'user-1',
        files: [{ path: 'index.ts', content: 'export default 1;' }],
        admit: () => Promise.reject(new Error('owner quota exceeded')),
      }),
    Error,
    'quota exceeded',
  );
  assertEquals(store.uploads, []);
  assertEquals(store.values.size, 0);
});

Deno.test('staged bundles are owner-scoped and expire', async () => {
  const store = new MemoryBundleStore();
  const bundle = await stageBundle(store, {
    ownerId: 'user-1',
    files: [{ path: 'index.ts', content: 'export default 1;' }],
    now: new Date('2026-07-27T12:00:00.000Z'),
    retentionSeconds: 60,
  });

  await assertRejects(
    () =>
      resolveStagedBundle(store, {
        ownerId: 'user-2',
        bundleId: bundle.bundle_id,
        now: new Date('2026-07-27T12:00:30.000Z'),
      }),
    StagedBundleError,
    'not found',
  );
  await assertRejects(
    () =>
      resolveStagedBundle(store, {
        ownerId: 'user-1',
        bundleId: bundle.bundle_id,
        now: new Date('2026-07-27T12:01:00.000Z'),
      }),
    StagedBundleError,
    'expired',
  );
});

Deno.test('staged bundle resolution verifies the content-addressed manifest', async () => {
  const store = new MemoryBundleStore();
  const bundle = await stageBundle(store, {
    ownerId: 'user-1',
    files: [{ path: 'index.ts', content: 'export default 1;' }],
  });
  const manifestKey = store.uploads.find((key) =>
    key.endsWith(`/bundles/${bundle.bundle_id}.json`)
  );
  if (!manifestKey) throw new Error('manifest was not stored');
  const manifest = JSON.parse(await store.fetchTextFile(manifestKey));
  manifest.files[0].path = 'renamed.ts';
  store.values.set(
    manifestKey,
    new TextEncoder().encode(JSON.stringify(manifest)),
  );

  await assertRejects(
    () =>
      resolveStagedBundle(store, {
        ownerId: 'user-1',
        bundleId: bundle.bundle_id,
      }),
    StagedBundleError,
    'content-address',
  );
});

Deno.test('stageBundle rejects conflicting and empty deltas', async () => {
  const store = new MemoryBundleStore();
  const base = await stageBundle(store, {
    ownerId: 'user-1',
    files: [{ path: 'index.ts', content: 'export default 1;' }],
  });

  await assertRejects(
    () =>
      stageBundle(store, {
        ownerId: 'user-1',
        baseBundleId: base.bundle_id,
        files: [{ path: 'index.ts', content: 'export default 2;' }],
        deletePaths: ['index.ts'],
      }),
    StagedBundleError,
    'changed and deleted',
  );
  await assertRejects(
    () =>
      stageBundle(store, {
        ownerId: 'user-1',
        baseBundleId: base.bundle_id,
        deletePaths: ['index.ts'],
      }),
    StagedBundleError,
    'cannot be empty',
  );
});

Deno.test('stageBundle normalizes source admission failures as invalid_stage', async () => {
  const invalidCases = [
    [{ path: '../index.ts', content: 'export default 1;' }],
    [{ path: 'index.ts', content: '%%%', encoding: 'base64' }],
    [{ path: 'index.exe', content: 'not allowed' }],
    Array.from({ length: 51 }, (_, index) => ({
      path: `file-${index}.ts`,
      content: '',
    })),
    [{
      path: 'large.ts',
      content: 'x'.repeat(50 * 1024 * 1024 + 1),
    }],
  ];

  for (const files of invalidCases) {
    const error = await assertRejects(
      () =>
        stageBundle(new MemoryBundleStore(), {
          ownerId: 'user-1',
          files,
        }),
      StagedBundleError,
    );
    assertEquals(error.code, 'invalid_stage');
  }

  const deleteError = await assertRejects(
    () =>
      stageBundle(new MemoryBundleStore(), {
        ownerId: 'user-1',
        baseBundleId: `gxb1_${'a'.repeat(64)}`,
        deletePaths: ['../index.ts'],
      }),
    StagedBundleError,
  );
  assertEquals(deleteError.code, 'invalid_stage');
});
