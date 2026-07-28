import { assertEquals, assertRejects } from 'https://deno.land/std@0.210.0/assert/mod.ts';
import {
  deleteProjectCapsulesForApp,
  ProjectCapsuleError,
  projectCapsuleResponse,
  type ProjectCapsuleSnapshot,
  type ProjectCapsuleStore,
  stableCapsuleSet,
} from './project-capsule.ts';
import type { FileUpload } from './storage.ts';

class MemoryCapsuleStore implements ProjectCapsuleStore {
  readonly values = new Map<string, Uint8Array>();
  readonly listLimits: number[] = [];
  maxConcurrentDeletes = 0;
  private concurrentDeletes = 0;

  async uploadFile(key: string, file: FileUpload): Promise<void> {
    this.values.set(key, file.content.slice());
  }

  async fetchTextFile(key: string): Promise<string> {
    const value = this.values.get(key);
    if (!value) throw new Error('not found');
    return new TextDecoder().decode(value);
  }

  async listFilesPage(
    prefix: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<{ keys: string[]; nextCursor: string | null }> {
    const limit = options.limit ?? 1000;
    this.listLimits.push(limit);
    const allKeys = [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = options.cursor
      ? Math.max(0, allKeys.findIndex((key) => key > options.cursor!))
      : 0;
    const keys = allKeys.slice(start, start + limit);
    return {
      keys,
      nextCursor: start + keys.length < allKeys.length ? keys.at(-1) ?? null : null,
    };
  }

  async deleteFile(key: string): Promise<void> {
    this.concurrentDeletes += 1;
    this.maxConcurrentDeletes = Math.max(
      this.maxConcurrentDeletes,
      this.concurrentDeletes,
    );
    await Promise.resolve();
    try {
      this.values.delete(key);
    } finally {
      this.concurrentDeletes -= 1;
    }
  }
}

function capsule(
  overrides: Partial<ProjectCapsuleSnapshot> = {},
): ProjectCapsuleSnapshot {
  return {
    schema_version: 1,
    identity: { name: 'Invoice Agent', slug: 'invoice-agent' },
    directive: { mission: 'Reconcile invoices.' },
    release: { live: '1.0.0', candidate: null },
    functions: [{ name: 'reconcile', parameters: { type: 'object' } }],
    data_schema: { backend: 'd1', tables: ['invoices'] },
    routines: [{ id: 'routine-1', status: 'active' }],
    access: { visibility: 'private', permissions: [] },
    model_policy: { default: 'platform', overrides: [] },
    settings: { required: ['ERP_KEY'], connected: ['ERP_KEY'] },
    recent_failures: [],
    files: [{ path: 'index.ts', sha256: 'a'.repeat(64) }],
    bundle: null,
    ...overrides,
  };
}

Deno.test('project capsule revisions are content-addressed and stable', async () => {
  const store = new MemoryCapsuleStore();
  const first = await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule(),
  });
  const second = await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule(),
  });

  assertEquals(first.revision, second.revision);
  assertEquals(first.revision.startsWith('gxp1_'), true);
});

Deno.test('project capsule set projections keep revisions stable across database row order', async () => {
  const firstStore = new MemoryCapsuleStore();
  const secondStore = new MemoryCapsuleStore();
  const firstRows = [{ id: 'b', status: 'active' }, {
    id: 'a',
    status: 'active',
  }];
  const secondRows = [...firstRows].reverse();

  const first = await projectCapsuleResponse(firstStore, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule({ routines: stableCapsuleSet(firstRows) }),
  });
  const second = await projectCapsuleResponse(secondStore, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule({ routines: stableCapsuleSet(secondRows) }),
  });

  assertEquals(first.revision, second.revision);
});

Deno.test('project capsule revisions preserve own __proto__ keys without collisions', async () => {
  const store = new MemoryCapsuleStore();
  const ordinary = await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule({ identity: { name: 'Invoice Agent' } }),
  });
  const identityWithProto = JSON.parse(
    '{"name":"Invoice Agent","__proto__":{"marker":"owned"}}',
  ) as Record<string, unknown>;
  const withProto = await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule({ identity: identityWithProto }),
  });

  assertEquals(Object.hasOwn(identityWithProto, '__proto__'), true);
  assertEquals(ordinary.revision === withProto.revision, false);
  assertEquals(
    (Object.prototype as Record<string, unknown>).marker,
    undefined,
  );
});

Deno.test('project capsule returns compact nested deltas and removed paths', async () => {
  const store = new MemoryCapsuleStore();
  const first = await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule(),
  });
  const updated = capsule({
    directive: { mission: 'Reconcile and escalate invoices.' },
    settings: { required: [], connected: [] },
    recent_failures: [{ function_name: 'reconcile', at: '2026-07-27' }],
  });
  const delta = await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: updated,
    sinceRevision: first.revision,
  });

  if (!('not_modified' in delta)) {
    throw new Error('expected a delta response');
  }
  assertEquals(delta.not_modified, false);
  if (delta.not_modified === false) {
    assertEquals(delta.delta, {
      directive: { mission: 'Reconcile and escalate invoices.' },
      recent_failures: [{
        function_name: 'reconcile',
        at: '2026-07-27',
      }],
      settings: { connected: [], required: [] },
    });
    assertEquals(delta.removed_paths, []);
  }

  const removed = await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule({ directive: null }),
    sinceRevision: first.revision,
  });
  if (!('not_modified' in removed)) {
    throw new Error('expected a delta response');
  }
  assertEquals(removed.not_modified, false);
  if (removed.not_modified === false) {
    assertEquals(removed.delta, { directive: null });
  }
});

Deno.test('project capsule deltas preserve own __proto__ keys without prototype mutation', async () => {
  const store = new MemoryCapsuleStore();
  const firstIdentity = JSON.parse(
    '{"name":"Invoice Agent","__proto__":{"marker":"before"}}',
  ) as Record<string, unknown>;
  const nextIdentity = JSON.parse(
    '{"name":"Invoice Agent","__proto__":{"marker":"after"}}',
  ) as Record<string, unknown>;
  const first = await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule({ identity: firstIdentity }),
  });
  const changed = await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule({ identity: nextIdentity }),
    sinceRevision: first.revision,
  });
  if (!('delta' in changed) || changed.not_modified) {
    throw new Error('expected a changed delta');
  }
  const identityDelta = changed.delta.identity as Record<string, unknown>;

  assertEquals(Object.hasOwn(identityDelta, '__proto__'), true);
  assertEquals(identityDelta['__proto__'], { marker: 'after' });
  assertEquals(
    (Object.prototype as Record<string, unknown>).marker,
    undefined,
  );
});

Deno.test('project capsule reports unchanged revisions without a payload', async () => {
  const store = new MemoryCapsuleStore();
  const first = await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule(),
  });
  const unchanged = await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule(),
    sinceRevision: first.revision,
  });

  assertEquals(unchanged, {
    view: 'coding_capsule',
    app_id: 'app-1',
    revision: first.revision,
    revision_created_at: first.revision_created_at,
    revision_expires_at: first.revision_expires_at,
    since_revision: first.revision,
    not_modified: true,
    delta: {},
    removed_paths: [],
  });
});

Deno.test('project capsule rejects expired revisions even when content is unchanged', async () => {
  const store = new MemoryCapsuleStore();
  const first = await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule(),
    now: new Date('2026-07-27T00:00:00Z'),
    retentionSeconds: 60,
  });

  await assertRejects(
    () =>
      projectCapsuleResponse(store, {
        ownerId: 'owner-1',
        appId: 'app-1',
        capsule: capsule(),
        sinceRevision: first.revision,
        now: new Date('2026-07-27T00:01:01Z'),
      }),
    ProjectCapsuleError,
    'expired',
  );
});

Deno.test('project capsule cleanup deletes only one owner/app prefix', async () => {
  const store = new MemoryCapsuleStore();
  await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule(),
  });
  await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-2',
    capsule: capsule({ identity: { name: 'Other' } }),
  });

  assertEquals(
    await deleteProjectCapsulesForApp(store, 'owner-1', 'app-1'),
    1,
  );
  assertEquals(
    [...store.values.keys()].some((key) => key.includes('/app-1/')),
    false,
  );
  assertEquals(
    [...store.values.keys()].some((key) => key.includes('/app-2/')),
    true,
  );
});

Deno.test('project capsule cleanup bounds pages and delete concurrency for large histories', async () => {
  const store = new MemoryCapsuleStore();
  const prefix = 'project-capsules/owner-1/app-1/';
  for (let index = 0; index < 1201; index++) {
    store.values.set(
      `${prefix}gxp1_${String(index).padStart(64, '0')}.json`,
      new Uint8Array(),
    );
  }
  store.values.set(
    `project-capsules/owner-1/app-2/gxp1_${'f'.repeat(64)}.json`,
    new Uint8Array(),
  );

  assertEquals(
    await deleteProjectCapsulesForApp(store, 'owner-1', 'app-1'),
    1201,
  );
  assertEquals(
    [...store.values.keys()],
    [`project-capsules/owner-1/app-2/gxp1_${'f'.repeat(64)}.json`],
  );
  assertEquals(store.listLimits.every((limit) => limit === 250), true);
  assertEquals(store.listLimits.length >= 6, true);
  assertEquals(store.maxConcurrentDeletes <= 16, true);
  assertEquals(store.maxConcurrentDeletes > 1, true);
});

Deno.test('project capsule liveness fence prevents a pre-publication write', async () => {
  const store = new MemoryCapsuleStore();
  await assertRejects(
    () =>
      projectCapsuleResponse(store, {
        ownerId: 'owner-1',
        appId: 'app-1',
        capsule: capsule(),
        assertAppLive: () => Promise.reject(new Error('deleted')),
      }),
    ProjectCapsuleError,
    'lifecycle changed',
  );
  assertEquals(store.values.size, 0);
});

Deno.test('project capsule liveness fence rolls back a deletion race after upload', async () => {
  const store = new MemoryCapsuleStore();
  let checks = 0;
  await assertRejects(
    () =>
      projectCapsuleResponse(store, {
        ownerId: 'owner-1',
        appId: 'app-1',
        capsule: capsule(),
        assertAppLive: () => {
          checks += 1;
          return checks === 1
            ? Promise.resolve()
            : Promise.reject(new Error('deleted during publication'));
        },
      }),
    ProjectCapsuleError,
    'lifecycle changed',
  );
  assertEquals(checks, 2);
  assertEquals(store.values.size, 0);
});

Deno.test('project capsule rejects oversized snapshots before storage', async () => {
  const store = new MemoryCapsuleStore();
  await assertRejects(
    () =>
      projectCapsuleResponse(store, {
        ownerId: 'owner-1',
        appId: 'app-1',
        capsule: capsule({
          recent_failures: [{ detail: 'x'.repeat(2 * 1024 * 1024) }],
        }),
      }),
    ProjectCapsuleError,
    '2097152-byte limit',
  );
  assertEquals(store.values.size, 0);
});

Deno.test('project capsule revisions are owner and app scoped', async () => {
  const store = new MemoryCapsuleStore();
  const first = await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule(),
  });

  await assertRejects(
    () =>
      projectCapsuleResponse(store, {
        ownerId: 'owner-2',
        appId: 'app-1',
        capsule: capsule({ identity: { name: 'Changed' } }),
        sinceRevision: first.revision,
      }),
    ProjectCapsuleError,
    'not found',
  );
});

Deno.test('project capsule deltas verify persisted revision integrity', async () => {
  const store = new MemoryCapsuleStore();
  const first = await projectCapsuleResponse(store, {
    ownerId: 'owner-1',
    appId: 'app-1',
    capsule: capsule(),
  });
  const revisionEntry = [...store.values.entries()].find(([key]) =>
    key.endsWith(`/${first.revision}.json`)
  );
  if (!revisionEntry) throw new Error('revision was not stored');
  const [revisionKey, raw] = revisionEntry;
  const persisted = JSON.parse(new TextDecoder().decode(raw));
  persisted.capsule.identity.name = 'Tampered';
  store.values.set(
    revisionKey,
    new TextEncoder().encode(JSON.stringify(persisted)),
  );

  await assertRejects(
    () =>
      projectCapsuleResponse(store, {
        ownerId: 'owner-1',
        appId: 'app-1',
        capsule: capsule({ identity: { name: 'Changed' } }),
        sinceRevision: first.revision,
      }),
    ProjectCapsuleError,
    'integrity',
  );
});
