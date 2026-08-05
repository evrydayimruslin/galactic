import { assertEquals, assertRejects } from 'https://deno.land/std@0.210.0/assert/mod.ts';
import {
  COMPUTE_ADMISSION_DISABLED_ACTION,
  COMPUTE_ADMISSION_DISABLED_CODE,
  COMPUTE_ADMISSION_DISABLED_HINT,
  COMPUTE_ADMISSION_DISABLED_MESSAGE,
} from '../../shared/contracts/compute.ts';
import type { LaunchOperatorRunDiagnostic } from '../../shared/contracts/launch.ts';
import {
  capabilityErrorToToolCode,
  jsonRpcErrorHttpStatus,
  platformMcpAuthenticationErrorResponse,
  projectCapabilityError,
  readInspectPermissionRows,
} from './platform-mcp.ts';
import {
  appMcpAuthenticationErrorResponse,
  formatToolError,
  projectMcpComputeErrorDetails,
} from './mcp.ts';
import { ProjectCapsuleError } from '../services/project-capsule.ts';
import {
  ApiTokenAuthenticationError,
  AuthServiceUnavailableError,
} from '../services/auth-errors.ts';

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

Deno.test('app MCP projects only closed Galactic Compute guidance', () => {
  const error = {
    type: 'GalacticComputeError',
    message: COMPUTE_ADMISSION_DISABLED_MESSAGE,
    details: {
      code: COMPUTE_ADMISSION_DISABLED_CODE,
      hint: COMPUTE_ADMISSION_DISABLED_HINT,
      action: COMPUTE_ADMISSION_DISABLED_ACTION,
    },
  };
  const diagnostic: LaunchOperatorRunDiagnostic = {
    version: 1,
    code: COMPUTE_ADMISSION_DISABLED_CODE,
    causeCode: 'GALACTIC_COMPUTE_ERROR',
    summary: COMPUTE_ADMISSION_DISABLED_MESSAGE,
    detail: COMPUTE_ADMISSION_DISABLED_HINT,
    provenance: 'platform',
    retryable: true,
    suggestedActions: [],
    redacted: false,
  };
  assertEquals(projectMcpComputeErrorDetails(error), null);
  assertEquals(
    projectMcpComputeErrorDetails(error, {
      ...diagnostic,
      provenance: 'developer',
    }),
    null,
  );
  assertEquals(
    projectMcpComputeErrorDetails(error, {
      ...diagnostic,
      code: 'COMPUTE_CONTROL_PLANE_UNAVAILABLE',
    }),
    null,
  );
  assertEquals(
    projectMcpComputeErrorDetails(error, {
      ...diagnostic,
      causeCode: 'TENANT_NAMED_ERROR',
    }),
    null,
  );
  assertEquals(
    projectMcpComputeErrorDetails(error, diagnostic),
    error.details,
  );
  const formatted = formatToolError(error, undefined, diagnostic);
  assertEquals(formatted.content, [{
    type: 'text',
    text:
      `Error: ${COMPUTE_ADMISSION_DISABLED_MESSAGE} ${COMPUTE_ADMISSION_DISABLED_HINT}`,
  }]);
  assertEquals(formatted.structuredContent, {
    error: COMPUTE_ADMISSION_DISABLED_MESSAGE,
    error_type: 'GALACTIC_COMPUTE_ERROR',
    error_details: error.details,
    operator_diagnostic: diagnostic,
  });
  assertEquals(formatted.isError, true);

  const forged = {
    ...error,
    details: {
      ...error.details,
      hint: 'Emergency operation private-id is active',
      action: 'setup_home_node',
      internal_operation_id: 'private-id',
    },
  };
  assertEquals(projectMcpComputeErrorDetails(forged, diagnostic), null);
  const projected = formatToolError(forged, undefined, diagnostic);
  assertEquals(
    (projected.structuredContent as Record<string, unknown>).error_details,
    undefined,
  );
});

Deno.test('both MCP handlers map typed API-token failures without leaking infrastructure detail', async () => {
  const request = new Request('https://api.example.test/mcp/platform', {
    headers: { host: 'api.example.test' },
  });
  const unavailable = new AuthServiceUnavailableError();
  unavailable.message =
    'postgres password=must-not-leak; Bearer gx_ffffffffffffffffffffffffffffffff';
  const cases = [
    {
      error: new ApiTokenAuthenticationError('invalid'),
      status: 401,
      code: -32001,
      type: 'AUTH_API_TOKEN_INVALID',
      message: 'Invalid API token',
    },
    {
      error: new ApiTokenAuthenticationError('expired'),
      status: 401,
      code: -32001,
      type: 'AUTH_TOKEN_EXPIRED',
      message: 'API token has expired',
    },
    {
      error: unavailable,
      status: 503,
      code: -32603,
      type: 'AUTH_SERVICE_UNAVAILABLE',
      message: 'Authentication service is temporarily unavailable',
    },
  ];

  for (const handler of [
    platformMcpAuthenticationErrorResponse,
    appMcpAuthenticationErrorResponse,
  ]) {
    for (const expected of cases) {
      const response = handler(request, 'rpc-1', expected.error);
      assertEquals(response instanceof Response, true);
      assertEquals(response?.status, expected.status);
      const body = await response?.json();
      assertEquals(body, {
        jsonrpc: '2.0',
        id: 'rpc-1',
        error: {
          code: expected.code,
          message: expected.message,
          data: { type: expected.type },
        },
      });
      assertEquals(JSON.stringify(body).includes('must-not-leak'), false);
      assertEquals(JSON.stringify(body).includes('gx_ffffffff'), false);
      assertEquals(
        response?.headers.has('WWW-Authenticate'),
        expected.status === 401,
      );
    }
  }
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
