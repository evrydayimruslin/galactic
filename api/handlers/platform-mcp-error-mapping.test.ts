import { assertEquals, assertRejects } from 'jsr:@std/assert';
import {
  capabilityErrorToToolCode,
  jsonRpcErrorHttpStatus,
  projectCapabilityError,
  readInspectPermissionRows,
} from './platform-mcp.ts';
import { ProjectCapsuleError } from '../services/project-capsule.ts';

Deno.test('platform MCP maps capability admission failures to public JSON-RPC codes', () => {
  assertEquals(capabilityErrorToToolCode('rate_limited'), -32000);
  assertEquals(capabilityErrorToToolCode('quota_exceeded'), -32004);
  assertEquals(capabilityErrorToToolCode('conflict'), -32007);
  assertEquals(capabilityErrorToToolCode('internal'), -32603);
  assertEquals(
    jsonRpcErrorHttpStatus(capabilityErrorToToolCode('rate_limited')),
    429,
  );
  assertEquals(
    jsonRpcErrorHttpStatus(capabilityErrorToToolCode('quota_exceeded')),
    400,
  );
  assertEquals(
    jsonRpcErrorHttpStatus(capabilityErrorToToolCode('internal')),
    500,
  );
});

Deno.test('project permission projection fails closed when authoritative storage is unavailable', async () => {
  await assertRejects(
    () =>
      readInspectPermissionRows(
        new Response('unavailable', { status: 503 }),
        true,
      ),
    Error,
    'authoritative Agent permissions (503)',
  );
  assertEquals(
    await readInspectPermissionRows(
      new Response('unavailable', { status: 503 }),
      false,
    ),
    null,
  );
  await assertRejects(
    () =>
      readInspectPermissionRows(
        Response.json({ rows: [] }),
        true,
      ),
    Error,
    'invalid response',
  );
});

Deno.test('project maps client-correctable capsule errors and sanitizes infrastructure failures', () => {
  assertEquals(
    projectCapabilityError(
      new ProjectCapsuleError('revision_not_found', 'request a full capsule'),
    ).code,
    'invalid_input',
  );
  assertEquals(
    projectCapabilityError(
      new ProjectCapsuleError('app_not_live', 'Agent was deleted'),
    ).code,
    'conflict',
  );
  assertEquals(
    projectCapabilityError(
      new ProjectCapsuleError(
        'liveness_unavailable',
        'database credentials',
      ),
    ).message,
    'The coding capsule is temporarily unavailable',
  );
  assertEquals(
    projectCapabilityError(
      new ProjectCapsuleError('capsule_too_large', 'too large'),
    ).code,
    'quota_exceeded',
  );
  const internal = projectCapabilityError(
    new Error('postgres password should not leak'),
  );
  assertEquals(internal.code, 'internal');
  assertEquals(
    internal.message,
    'The coding capsule is temporarily unavailable',
  );
  assertEquals(internal.message.includes('postgres'), false);
});
