import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.210.0/assert/mod.ts';
import type { ComputeResult, ComputeRun } from '../../../shared/contracts/compute.ts';
import {
  deregisterExecutionContext,
  registerExecutionContext,
} from '../../services/execution-context-registry.ts';
import {
  type ComputeBindingProps,
  createComputeBindingOperations,
  deriveComputeIdempotencyKey,
} from './compute-binding-core.ts';
import {
  type ComputeAdmissionInput,
  type ComputeControlPlaneAdapter,
  type ComputeRunLookupInput,
  PublicComputeControlPlaneError,
} from './compute-control-plane-adapter.ts';

const PROPS: ComputeBindingProps = {
  userId: '00000000-0000-4000-8000-000000000001',
  agentId: '00000000-0000-4000-8000-000000000002',
};

function registerHandle(
  appId = PROPS.agentId,
  functionName = 'build_report',
): string {
  return registerExecutionContext({
    aiExecutionId: '00000000-0000-4000-8000-000000000003',
    appId,
    functionName,
    cloudOperationMetering: null,
    cloudOperationBillingConfig: null,
    callerContextToken: null,
    executionDeadlineAtMs: Date.now() + 300_000,
  });
}

function publicRun(status: ComputeRun['status'] = 'completed'): ComputeRun {
  return {
    run_id: '00000000-0000-4000-8000-000000000004',
    receipt_id: '00000000-0000-4000-8000-000000000005',
    status,
    profile: 'developer-v1',
    tools: ['cli.duckdb'],
    created_at: '2026-07-19T00:00:00.000Z',
    ...(status === 'completed'
      ? {
        started_at: '2026-07-19T00:00:01.000Z',
        finished_at: '2026-07-19T00:00:02.000Z',
        exit_code: 0,
        stdout: 'ok\n',
        stderr: '',
        artifacts: [{
          artifact_id: '00000000-0000-4000-8000-000000000006',
          path: 'out/report.csv',
          size_bytes: 12,
          sha256: 'a'.repeat(64),
          expires_at: '2099-07-19T00:00:00.000Z',
        }],
      }
      : {}),
  };
}

Deno.test('compute binding: admission idempotency is stable per parent call index', async () => {
  const executionId = '00000000-0000-4000-8000-000000000003';
  const first = await deriveComputeIdempotencyKey(executionId, 1);
  assertEquals(await deriveComputeIdempotencyKey(executionId, 1), first);
  assert(first !== await deriveComputeIdempotencyKey(executionId, 2));
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(
        first,
      ),
  );
});

Deno.test('compute binding: host identity wins and private response fields are stripped', async () => {
  let admission: ComputeAdmissionInput | null = null;
  const adapter: ComputeControlPlaneAdapter = {
    admitComputeRun: (input) => {
      admission = input;
      return Promise.resolve({
        ...publicRun(),
        async: false,
        lease_token: 'gxc_private_lease_token',
        platform_key: 'must-not-enter-body',
      } as unknown as ComputeResult);
    },
    getComputeRunForAgent: () => Promise.resolve(publicRun()),
    cancelComputeRunForAgent: () => Promise.resolve(publicRun('cancelled')),
  };
  const handle = registerHandle();
  try {
    const result = await createComputeBindingOperations(PROPS, adapter).call(
      {
        argv: ['duckdb', '-c', 'select 1'],
        profile: 'developer-v1',
        tools: ['cli.duckdb'],
        secrets: ['WAREHOUSE'],
        mode: 'sync',
        cwd: '/workspace',
        timeout_ms: 5_000,
        input_artifacts: [{
          artifact_id: '00000000-0000-4000-8000-000000000007',
          mount_path: 'input/data.csv',
        }],
        capture_paths: ['out/report.csv'],
      },
      handle,
      1,
    );

    const captured = admission as ComputeAdmissionInput | null;
    assert(captured, 'admission adapter was not invoked');
    assertEquals(captured.userId, PROPS.userId);
    assertEquals(captured.agentId, PROPS.agentId);
    assertEquals(captured.callerFunction, 'build_report');
    assertEquals(captured.billingMode, 'wallet');
    assertEquals(captured.capacityAgentId, PROPS.agentId);
    assertEquals(
      captured.executionId,
      '00000000-0000-4000-8000-000000000003',
    );
    assert(
      Number.isFinite(captured.executionDeadlineAtMs) &&
        captured.executionDeadlineAtMs > Date.now(),
    );
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        .test(
          captured.idempotencyKey,
        ),
    );
    assertEquals(captured.request, {
      argv: ['duckdb', '-c', 'select 1'],
      tools: ['cli.duckdb'],
      profile: 'developer-v1',
      mode: 'sync',
      cwd: '/workspace',
      timeout_ms: 5_000,
      secrets: ['WAREHOUSE'],
      capture_paths: ['out/report.csv'],
      input_artifacts: [{
        artifact_id: '00000000-0000-4000-8000-000000000007',
        mount_path: 'input/data.csv',
      }],
    });
    assertEquals(result, { ...publicRun(), async: false });
    assertEquals('lease_token' in result, false);
    assertEquals('platform_key' in result, false);
  } finally {
    deregisterExecutionContext(handle);
  }
});

Deno.test('compute binding: subscription capacity preserves trusted root Agent attribution', async () => {
  let admission: ComputeAdmissionInput | null = null;
  const adapter: ComputeControlPlaneAdapter = {
    admitComputeRun: (input) => {
      admission = input;
      return Promise.resolve({ ...publicRun(), async: true });
    },
    getComputeRunForAgent: () => Promise.resolve(publicRun()),
    cancelComputeRunForAgent: () => Promise.resolve(publicRun('cancelled')),
  };
  const rootAgentId = '00000000-0000-4000-8000-000000000099';
  const handle = registerExecutionContext({
    aiExecutionId: '00000000-0000-4000-8000-000000000003',
    appId: PROPS.agentId,
    functionName: 'build_report',
    capacityReceiptId: '00000000-0000-4000-8000-000000000098',
    capacityAgentId: rootAgentId,
    cloudOperationMetering: { capacityMeter: { addLight() {} } } as never,
    cloudOperationBillingConfig: null,
    callerContextToken: null,
    executionDeadlineAtMs: Date.now() + 300_000,
  });
  try {
    await createComputeBindingOperations(PROPS, adapter).call(
      { argv: ['true'], tools: [] },
      handle,
      1,
    );
    const captured = admission as ComputeAdmissionInput | null;
    assert(captured);
    assertEquals(captured.billingMode, 'subscription_capacity');
    assertEquals(captured.capacityAgentId, rootAgentId);
  } finally {
    deregisterExecutionContext(handle);
  }
});

Deno.test('compute binding: unsupported request and artifact fields fail closed', async () => {
  const adapter: ComputeControlPlaneAdapter = {
    admitComputeRun: () => Promise.resolve({ ...publicRun(), async: false }),
    getComputeRunForAgent: () => Promise.resolve(publicRun()),
    cancelComputeRunForAgent: () => Promise.resolve(publicRun()),
  };
  const handle = registerHandle();
  try {
    await assertRejects(
      () => createComputeBindingOperations(PROPS, adapter).call({
        argv: ['true'],
        tools: ['shell'],
        raw_provider_key: 'sk-provider',
      }, handle, 1),
      Error,
      'control plane unavailable',
    );
    await assertRejects(
      () => createComputeBindingOperations(PROPS, adapter).call({
        argv: ['true'],
        tools: ['shell'],
        input_artifacts: [{
          artifact_id: '00000000-0000-4000-8000-000000000007',
          mount_path: 'input/data.csv',
          storage_key: 'private/r2/key',
        }],
      }, handle, 2),
      Error,
      'control plane unavailable',
    );
  } finally {
    deregisterExecutionContext(handle);
  }
});

Deno.test('compute binding: get/cancel are scoped to the current Agent execution', async () => {
  const lookups: Array<{ method: string; input: ComputeRunLookupInput }> = [];
  const adapter: ComputeControlPlaneAdapter = {
    admitComputeRun: () => Promise.resolve({ ...publicRun(), async: false }),
    getComputeRunForAgent: (input) => {
      lookups.push({ method: 'get', input });
      return Promise.resolve(publicRun('running'));
    },
    cancelComputeRunForAgent: (input) => {
      lookups.push({ method: 'cancel', input });
      return Promise.resolve(publicRun('cancelled'));
    },
  };
  const handle = registerHandle();
  try {
    const binding = createComputeBindingOperations(PROPS, adapter);
    await binding.get('run-a', handle);
    await binding.cancel('run-a', handle);
    assertEquals(lookups, [
      {
        method: 'get',
        input: {
          ...PROPS,
          callerFunction: 'build_report',
          executionId: '00000000-0000-4000-8000-000000000003',
          runId: 'run-a',
        },
      },
      {
        method: 'cancel',
        input: {
          ...PROPS,
          callerFunction: 'build_report',
          executionId: '00000000-0000-4000-8000-000000000003',
          runId: 'run-a',
        },
      },
    ]);
  } finally {
    deregisterExecutionContext(handle);
  }
});

Deno.test('compute binding: missing, expired, and cross-Agent handles fail closed', async () => {
  const adapter: ComputeControlPlaneAdapter = {
    admitComputeRun: () => Promise.resolve({ ...publicRun(), async: false }),
    getComputeRunForAgent: () => Promise.resolve(publicRun()),
    cancelComputeRunForAgent: () => Promise.resolve(publicRun()),
  };
  const binding = createComputeBindingOperations(PROPS, adapter);
  await assertRejects(
    () => binding.call({ argv: ['true'], tools: [] }, undefined, 1),
    Error,
    'execution context',
  );

  const expired = registerHandle();
  deregisterExecutionContext(expired);
  await assertRejects(
    () => binding.get('run-a', expired),
    Error,
    'execution context',
  );

  const otherAgent = registerHandle(
    '00000000-0000-4000-8000-000000000099',
  );
  try {
    await assertRejects(
      () => binding.cancel('run-a', otherAgent),
      Error,
      'does not belong to this Agent',
    );
  } finally {
    deregisterExecutionContext(otherAgent);
  }
});

Deno.test('compute binding: unexpected service errors cannot leak private details', async () => {
  const privateFailure: ComputeControlPlaneAdapter = {
    admitComputeRun: () => {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY=private-value');
    },
    getComputeRunForAgent: () => Promise.resolve(publicRun()),
    cancelComputeRunForAgent: () => Promise.resolve(publicRun()),
  };
  const handle = registerHandle();
  try {
    const error = await assertRejects(
      () =>
        createComputeBindingOperations(PROPS, privateFailure).call(
          { argv: ['true'], tools: [] },
          handle,
          1,
        ),
      Error,
      'control plane unavailable',
    );
    assertEquals(error.message.includes('private-value'), false);

    const publicFailure: ComputeControlPlaneAdapter = {
      ...privateFailure,
      admitComputeRun: () => {
        throw new PublicComputeControlPlaneError(
          'COMPUTE_PERMISSION_DENIED',
          'Compute permission was denied.',
        );
      },
    };
    await assertRejects(
      () =>
        createComputeBindingOperations(PROPS, publicFailure).call(
          { argv: ['true'], tools: [] },
          handle,
          1,
        ),
      Error,
      'COMPUTE_PERMISSION_DENIED',
    );
  } finally {
    deregisterExecutionContext(handle);
  }
});
