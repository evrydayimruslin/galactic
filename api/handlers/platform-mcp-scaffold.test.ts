import { assertEquals } from 'https://deno.land/std@0.210.0/assert/assert_equals.ts';
import { assertExists } from 'https://deno.land/std@0.210.0/assert/assert_exists.ts';
import { assertStringIncludes } from 'https://deno.land/std@0.210.0/assert/assert_string_includes.ts';

import { executeScaffold } from './platform-mcp.ts';

Deno.test('platform scaffold: policy flag adds policy file and manifest hook', () => {
  const scaffold = executeScaffold({
    name: 'Policy App',
    description: 'A deployable app with custom policy',
    policy: true,
    storage: 'kv',
  }) as {
    files: Array<{ path: string; content: string }>;
    next_steps: string[];
  };

  const byPath = new Map(scaffold.files.map((file) => [file.path, file]));
  const index = byPath.get('index.ts')?.content;
  const policy = byPath.get('policy.ts')?.content;
  const manifestJson = byPath.get('manifest.json')?.content;

  assertExists(index);
  assertExists(policy);
  assertExists(manifestJson);
  assertStringIncludes(index, 'export { planAccess } from "./policy.ts";');
  assertStringIncludes(policy, 'ToolAccessPolicyFunction');
  assertStringIncludes(policy, 'policy.static.price_light');
  // First-class skills are retired: scaffold output must not teach them.
  assertEquals(policy.toLowerCase().includes('skill'), false);
  assertEquals(
    'skills' in (JSON.parse(manifestJson) as Record<string, unknown>),
    false,
  );

  const manifest = JSON.parse(manifestJson) as {
    access_policy?: { mode?: string; module?: string; export?: string };
  };
  assertEquals(manifest.access_policy, {
    mode: 'module',
    module: 'policy.ts',
    export: 'planAccess',
  });
  assertEquals(
    scaffold.next_steps.some((step) => step.includes('Edit policy.ts')),
    true,
  );
  assertEquals(
    scaffold.next_steps.some((step) => step.toLowerCase().includes('skill')),
    false,
  );
});
