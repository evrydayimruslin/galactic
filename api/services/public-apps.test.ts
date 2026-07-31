import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import type { App } from '../../shared/types/index.ts';
import {
  PUBLIC_APP_RESPONSE_FIELDS,
  PUBLIC_APP_RESPONSE_SELECT,
  PUBLIC_APP_SERVING_SELECT,
  toPublicAppResponse,
} from './public-apps.ts';

const FORBIDDEN_PUBLIC_FIELDS = [
  'env_vars',
  'env_schema',
  'supabase_anon_key_encrypted',
  'supabase_service_key_encrypted',
  'supabase_config_id',
  'draft_storage_key',
  'draft_version',
  'draft_uploaded_at',
  'draft_exports',
  'last_build_logs',
  'last_build_error',
  'storage_key',
];

Deno.test('Public app contract: JSON response allowlist excludes secret and draft fields', () => {
  const fullApp = {
    id: 'app_123',
    owner_id: 'user_123',
    slug: 'email-ops',
    name: 'Email Ops',
    description: 'Manage inboxes',
    icon_url: '/icons/email.png',
    visibility: 'public',
    download_access: 'public',
    current_version: '1.2.3',
    likes: 12,
    dislikes: 1,
    total_runs: 42,
    category: 'ops',
    tags: ['email', 'automation'],
    screenshots: ['apps/app_123/screens/1.png'],
    long_description: 'Long form docs',
    skills_md: '# Email Ops',
    skills_parsed: { functions: [], permissions: [] },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    env_vars: { SECRET: 'encrypted' },
    env_schema: { SECRET: { scope: 'per_user', required: true } },
    storage_key: 'apps/app_123/1.2.3/',
    manifest: '{"functions":{}}',
    exports: ['handler'],
    supabase_anon_key_encrypted: 'anon',
    supabase_service_key_encrypted: 'service',
    supabase_config_id: 'cfg_123',
    draft_storage_key: 'drafts/app_123/',
    draft_version: '1.2.4-draft',
    draft_uploaded_at: '2026-01-03T00:00:00Z',
    draft_exports: ['draftHandler'],
    last_build_logs: [{ time: '2026-01-01T00:00:00Z', level: 'info', message: 'ok' }],
    last_build_error: 'boom',
  } as unknown as App;

  const publicApp = toPublicAppResponse(fullApp);
  const publicKeys = Object.keys(publicApp).sort();

  assertEquals(publicKeys, [...PUBLIC_APP_RESPONSE_FIELDS].sort());

  for (const forbiddenField of FORBIDDEN_PUBLIC_FIELDS) {
    assert(!(forbiddenField in (publicApp as Record<string, unknown>)));
  }
});

Deno.test('Public app contract: select allowlists never request secret columns on public routes', () => {
  for (const forbiddenField of FORBIDDEN_PUBLIC_FIELDS) {
    assert(!PUBLIC_APP_RESPONSE_SELECT.includes(forbiddenField));
    if (forbiddenField !== 'storage_key') {
      assert(!PUBLIC_APP_SERVING_SELECT.includes(forbiddenField));
    }
  }

  assert(PUBLIC_APP_SERVING_SELECT.includes('storage_key'));
  assert(PUBLIC_APP_SERVING_SELECT.includes('deployment_state'));
});
