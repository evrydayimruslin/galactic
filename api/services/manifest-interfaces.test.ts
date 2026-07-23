import { assertEquals } from 'https://deno.land/std@0.210.0/assert/assert_equals.ts';

import { type AppManifest, validateManifest } from '../../shared/contracts/manifest.ts';

function baseManifest(overrides: Record<string, unknown> = {}): AppManifest {
  return {
    name: 'Interface App',
    version: '1.0.0',
    type: 'mcp',
    entry: { functions: 'index.ts' },
    functions: {
      listItems: {
        description: 'List items',
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      addItem: { description: 'Add an item' },
    },
    ...overrides,
  } as AppManifest;
}

function interfaceErrors(result: ReturnType<typeof validateManifest>) {
  return result.errors.filter((e) => e.path.startsWith('interfaces'));
}

Deno.test('manifest interfaces: accepts multiple valid declarations', () => {
  const result = validateManifest(baseManifest({
    interfaces: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        description: 'Live overview',
        entry: 'interfaces/dashboard.html',
        functions: ['listItems', 'addItem'],
        read_models: {
          listItems: {
            fresh_for_ms: 10_000,
            stale_for_ms: 120_000,
            prefetch_args: { limit: 20 },
          },
        },
        min_height: 320,
      },
      {
        id: 'settings',
        label: 'Settings',
        entry: 'interfaces/settings.html',
        functions: ['listItems'],
        hash: 'f'.repeat(64),
      },
    ],
  }));

  assertEquals(result.valid, true);
  assertEquals(interfaceErrors(result), []);
  assertEquals(
    result.warnings.filter((w) => w.startsWith('Interface')),
    [],
  );
});

Deno.test('manifest interfaces: absent field validates exactly like today', () => {
  const result = validateManifest(baseManifest());
  assertEquals(result.valid, true);
  assertEquals(interfaceErrors(result), []);
});

Deno.test('manifest interfaces: rejects non-array value', () => {
  const result = validateManifest(baseManifest({ interfaces: {} }));
  assertEquals(result.valid, false);
  assertEquals(interfaceErrors(result), [
    { path: 'interfaces', message: 'interfaces must be an array' },
  ]);
});

Deno.test('manifest interfaces: rejects bad ids, duplicates, and missing label', () => {
  const result = validateManifest(baseManifest({
    interfaces: [
      // Bad id (leading digit) + missing label.
      { id: '1bad', entry: 'ui.html', functions: ['listItems'] },
      { id: 'ok', label: 'A', entry: 'a.html', functions: ['listItems'] },
      // Duplicate id.
      { id: 'ok', label: 'B', entry: 'b.html', functions: ['listItems'] },
    ],
  }));

  assertEquals(result.valid, false);
  const paths = interfaceErrors(result).map((e) => e.path);
  assertEquals(paths.includes('interfaces.0.id'), true);
  assertEquals(paths.includes('interfaces.0.label'), true);
  assertEquals(paths.includes('interfaces.2.id'), true);
});

Deno.test('manifest interfaces: rejects unsafe entry paths', () => {
  const badEntries = [
    '/absolute.html', // leading slash
    '../escape.html', // traversal
    'a/../b.html', // embedded traversal
    'a//b.html', // empty segment
    'back\\slash.html', // backslash
    'not-html.js', // wrong extension
    '', // empty
  ];
  const result = validateManifest(baseManifest({
    interfaces: badEntries.map((entry, i) => ({
      id: `iface${i}`,
      label: `Iface ${i}`,
      entry,
      functions: ['listItems'],
    })),
  }));

  assertEquals(result.valid, false);
  const entryErrorPaths = interfaceErrors(result).map((e) => e.path);
  badEntries.forEach((_, i) => {
    assertEquals(
      entryErrorPaths.includes(`interfaces.${i}.entry`),
      true,
      `expected entry error for "${badEntries[i]}"`,
    );
  });
  // Nested relative paths without traversal remain fine.
  const ok = validateManifest(baseManifest({
    interfaces: [{
      id: 'nested',
      label: 'Nested',
      entry: 'ui/sub/page.html',
      functions: ['listItems'],
    }],
  }));
  assertEquals(interfaceErrors(ok), []);
});

Deno.test('manifest interfaces: requires a non-empty functions allowlist', () => {
  const result = validateManifest(baseManifest({
    interfaces: [
      { id: 'a', label: 'A', entry: 'a.html', functions: [] },
      { id: 'b', label: 'B', entry: 'b.html', functions: ['listItems', ''] },
      { id: 'c', label: 'C', entry: 'c.html' },
    ],
  }));

  assertEquals(result.valid, false);
  const paths = interfaceErrors(result).map((e) => e.path);
  assertEquals(paths, [
    'interfaces.0.functions',
    'interfaces.1.functions',
    'interfaces.2.functions',
  ]);
});

Deno.test('manifest interfaces: warns (not errors) on allowlisted functions missing from the manifest', () => {
  const result = validateManifest(baseManifest({
    interfaces: [{
      id: 'dashboard',
      label: 'Dashboard',
      entry: 'ui.html',
      functions: ['listItems', 'ghostFunction'],
    }],
  }));

  assertEquals(result.valid, true);
  assertEquals(interfaceErrors(result), []);
  assertEquals(result.warnings, [
    'Interface "dashboard" allowlists missing function "ghostFunction".',
  ]);
});

Deno.test('manifest interfaces: rejects invalid min_height and non-string hash', () => {
  const result = validateManifest(baseManifest({
    interfaces: [
      {
        id: 'a',
        label: 'A',
        entry: 'a.html',
        functions: ['listItems'],
        min_height: -5,
      },
      {
        id: 'b',
        label: 'B',
        entry: 'b.html',
        functions: ['listItems'],
        min_height: Number.NaN,
      },
      {
        id: 'c',
        label: 'C',
        entry: 'c.html',
        functions: ['listItems'],
        hash: 123,
      },
    ],
  }));

  assertEquals(result.valid, false);
  assertEquals(interfaceErrors(result).map((e) => e.path), [
    'interfaces.0.min_height',
    'interfaces.1.min_height',
    'interfaces.2.hash',
  ]);
});

Deno.test('manifest interfaces: read models require explicit read-only function metadata', () => {
  const result = validateManifest(baseManifest({
    functions: {
      inbox_snapshot: {
        description: 'Advance the inbox cursor despite its read-looking name',
        annotations: { readOnlyHint: false },
      },
      safe_snapshot: {
        description: 'Read current inbox state',
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
    },
    interfaces: [{
      id: 'inbox',
      label: 'Inbox',
      entry: 'inbox.html',
      functions: ['inbox_snapshot', 'safe_snapshot'],
      read_models: {
        inbox_snapshot: {
          fresh_for_ms: 20_000,
          stale_for_ms: 300_000,
          prefetch_args: {},
        },
        safe_snapshot: {
          fresh_for_ms: 20_000,
          stale_for_ms: 300_000,
        },
      },
    }],
  }));

  assertEquals(result.valid, false);
  assertEquals(
    interfaceErrors(result).some((error) =>
      error.path === 'interfaces.0.read_models.inbox_snapshot' &&
      error.message.includes('readOnlyHint=true')
    ),
    true,
  );
  assertEquals(
    interfaceErrors(result).some((error) =>
      error.path === 'interfaces.0.read_models.safe_snapshot'
    ),
    false,
  );
});

Deno.test('manifest interfaces: read model freshness bounds fail closed', () => {
  const result = validateManifest(baseManifest({
    interfaces: [{
      id: 'inbox',
      label: 'Inbox',
      entry: 'inbox.html',
      functions: ['listItems'],
      read_models: {
        listItems: {
          fresh_for_ms: 500,
          stale_for_ms: 400,
          prefetch_args: [],
          surprise: true,
        },
      },
    }],
  }));

  assertEquals(result.valid, false);
  assertEquals(interfaceErrors(result).map((error) => error.path), [
    'interfaces.0.read_models.listItems.fresh_for_ms',
    'interfaces.0.read_models.listItems.stale_for_ms',
    'interfaces.0.read_models.listItems.prefetch_args',
    'interfaces.0.read_models.listItems',
  ]);
});
