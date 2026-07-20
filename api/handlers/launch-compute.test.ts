import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.210.0/assert/mod.ts';

import {
  type ComputeLaunchRunSummary,
  type ComputeLaunchService,
  ComputeLaunchServiceError,
  type ComputeLaunchSettingsMutation,
  type ComputeLaunchSettingsView,
  handleLaunchComputeRoute,
} from './launch-compute.ts';
import { handleLaunch } from './launch.ts';
import { LAUNCH_API_ROUTES } from '../../shared/contracts/launch.ts';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = '99999999-9999-4999-8999-999999999999';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_AGENT_ID = '44444444-4444-4444-8444-444444444444';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const ARTIFACT_ID = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-07-19T12:00:00.000Z';

function settingsView(): ComputeLaunchSettingsView {
  return {
    settings: {
      enabled: true,
      profile: 'developer-v1',
      allowedTools: ['browser', 'git'],
      secretBindings: [{
        name: 'GITHUB_TOKEN',
        delivery: { kind: 'env', envName: 'GH_TOKEN' },
        configured: true,
        version: '3',
        updatedAt: '2026-07-18T11:00:00.000Z',
      }],
      authorityRules: [
        {
          callerFunction: 'research',
          decision: 'always',
          action: 'platform.call',
          target: { functionName: 'gx.upload' },
          version: '2',
        },
        {
          callerFunction: 'research',
          decision: 'always',
          action: 'agents.call',
          target: {
            agentId: TARGET_AGENT_ID,
            functionName: 'summarize',
          },
          version: '1',
        },
      ],
      limits: {
        maxTimeoutMs: 480_000,
        maxConcurrency: 2,
        maxArtifactBytes: 100_000_000,
        maxArtifacts: 20,
      },
      manifestCeiling: {
        enabled: true,
        profile: 'developer-v1',
        tools: ['browser', 'git', 'shell'],
        secrets: ['GITHUB_TOKEN', 'NPM_TOKEN'],
      },
      ownerConfirmedAt: '2026-07-18T10:00:00.000Z',
      updatedAt: '2026-07-18T10:00:00.000Z',
    },
    revision: '7',
  };
}

function runSummary(): ComputeLaunchRunSummary {
  return {
    runId: RUN_ID,
    receiptId: null,
    receiptUrl: null,
    billingMode: 'wallet',
    status: 'running',
    agentId: AGENT_ID,
    agentName: 'Researcher',
    functionName: 'research',
    createdAt: '2026-07-19T11:59:00.000Z',
    startedAt: '2026-07-19T11:59:01.000Z',
    finishedAt: null,
    usage: {
      reserved: 10,
      actual: null,
      trueUp: null,
      unit: 'work units',
    },
    exitCode: null,
    infraFailure: null,
    artifacts: [{
      id: ARTIFACT_ID,
      name: 'report.csv',
      sizeBytes: 8,
      expiresAt: '2099-07-20T00:00:00.000Z',
      url: 'https://public-r2.example/private-bucket/object-key?signature=secret',
    }],
    cancellable: true,
  };
}

function service(
  overrides: Partial<ComputeLaunchService> = {},
): ComputeLaunchService {
  return {
    resolveAgent: () => Promise.resolve({ id: AGENT_ID, ownerUserId: OWNER_ID }),
    getSettings: () => Promise.resolve(settingsView()),
    putSettings: () => Promise.resolve(settingsView()),
    listRuns: () => Promise.resolve({ runs: [runSummary()], nextCursor: null }),
    cancelRun: () => Promise.resolve({ ...runSummary(), status: 'cancelled' }),
    downloadArtifact: () =>
      Promise.resolve({
        body: 'artifact',
        contentType: 'text/plain',
        contentLength: 8,
        fileName: 'report.csv',
      }),
    ...overrides,
  };
}

function authenticate(
  authSource = 'supabase',
  id = OWNER_ID,
): () => Promise<{ id: string; authSource: string }> {
  return () => Promise.resolve({ id, authSource });
}

function computeRequest(
  path: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return new Request(`https://api.test${path}`, { ...init, headers });
}

function validPutBody(): Record<string, unknown> {
  return {
    expectedRevision: 7,
    ownerConfirmed: true,
    settings: {
      enabled: true,
      profile: 'developer-v1',
      allowedTools: ['git', 'browser'],
      secretBindings: [{
        name: 'GITHUB_TOKEN',
        delivery: { kind: 'env', envName: 'GH_TOKEN' },
      }],
      authorityRules: [
        {
          callerFunction: 'research',
          decision: 'always',
          action: 'agents.call',
          target: {
            agentId: TARGET_AGENT_ID,
            functionName: 'summarize',
          },
        },
        {
          callerFunction: 'research',
          decision: 'always',
          action: 'platform.call',
          target: { functionName: 'gx.upload' },
        },
      ],
      limits: {
        maxTimeoutMs: 480_000,
        maxConcurrency: 2,
        maxArtifactBytes: 100_000_000,
        maxArtifacts: 20,
      },
    },
  };
}

Deno.test('launch Compute route is owner-session only, private, and secret-safe', async () => {
  const view = settingsView();
  (view.settings.secretBindings[0] as unknown as Record<string, unknown>)
    .value = 'must-never-leak';
  (view as unknown as Record<string, unknown>).rawProviderKey = 'must-never-leak-either';

  const response = await handleLaunch(
    computeRequest(`/api/launch/agents/my-agent/compute/settings`),
    {
      compute: {
        service: service({ getSettings: () => Promise.resolve(view) }),
        authenticate: authenticate(),
        now: () => new Date(NOW),
      },
    },
  );

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('Cache-Control'), 'private, no-store');
  assertEquals(response.headers.get('Vary'), 'Cookie, Authorization');
  const bodyText = await response.text();
  assert(!bodyText.includes('must-never-leak'));
  const body = JSON.parse(bodyText) as Record<string, unknown>;
  assertEquals(body.generatedAt, NOW);
  assertEquals(body.revision, '7');
  assertEquals(
    ((body.settings as Record<string, unknown>).authorityRules as unknown[])
      .length,
    2,
  );
});

Deno.test('launch Compute rejects unauthenticated, API-token, actor, and non-owner callers', async () => {
  let resolutions = 0;
  const countedService = service({
    resolveAgent: () => {
      resolutions++;
      return Promise.resolve({ id: AGENT_ID, ownerUserId: OWNER_ID });
    },
  });

  const unauthenticated = await handleLaunchComputeRoute(
    computeRequest(`/api/launch/agents/${AGENT_ID}/compute/settings`),
    `/api/launch/agents/${AGENT_ID}/compute/settings`,
    {
      service: countedService,
      authenticate: () => Promise.reject(new Error('no session')),
    },
  );
  assertEquals(unauthenticated.status, 401);

  for (const source of ['api_token', 'actor_token', 'compute_lease']) {
    const response = await handleLaunchComputeRoute(
      computeRequest(`/api/launch/agents/${AGENT_ID}/compute/settings`),
      `/api/launch/agents/${AGENT_ID}/compute/settings`,
      { service: countedService, authenticate: authenticate(source) },
    );
    assertEquals(response.status, 403);
  }
  assertEquals(resolutions, 0);

  let getSettingsCalls = 0;
  const nonOwner = await handleLaunchComputeRoute(
    computeRequest(`/api/launch/agents/${AGENT_ID}/compute/settings`),
    `/api/launch/agents/${AGENT_ID}/compute/settings`,
    {
      authenticate: authenticate('supabase', OTHER_OWNER_ID),
      service: service({
        getSettings: () => {
          getSettingsCalls++;
          return Promise.resolve(settingsView());
        },
      }),
    },
  );
  assertEquals(nonOwner.status, 404);
  assertEquals(getSettingsCalls, 0);
  assertEquals(nonOwner.headers.get('Cache-Control'), 'private, no-store');
});

Deno.test('launch Compute PUT canonicalizes a whole confirmed CAS settings document', async () => {
  let mutation: ComputeLaunchSettingsMutation | null = null;
  const response = await handleLaunchComputeRoute(
    computeRequest(`/api/launch/agents/${AGENT_ID}/compute/settings`, {
      method: 'PUT',
      body: JSON.stringify(validPutBody()),
    }),
    `/api/launch/agents/${AGENT_ID}/compute/settings`,
    {
      authenticate: authenticate(),
      service: service({
        putSettings: (input) => {
          mutation = input.mutation;
          return Promise.resolve(settingsView());
        },
      }),
      now: () => new Date(NOW),
    },
  );

  assertEquals(response.status, 200);
  assertEquals(mutation?.expectedRevision, '7');
  assertEquals(mutation?.ownerConfirmed, true);
  assertEquals(mutation?.settings.allowedTools, ['browser', 'git']);
  assertEquals(
    mutation?.settings.authorityRules.map((rule) => rule.action),
    ['agents.call', 'platform.call'],
  );
  assertEquals(
    mutation?.settings.authorityRules[0],
    {
      callerFunction: 'research',
      decision: 'always',
      action: 'agents.call',
      target: {
        agentId: TARGET_AGENT_ID,
        functionName: 'summarize',
      },
    },
  );
});

Deno.test('launch Compute PUT rejects values, unconfirmed authority, manifest escapes, and wildcard rules', async () => {
  const cases: Array<{
    mutate: (body: Record<string, unknown>) => void;
    code: string;
  }> = [
    {
      mutate: (body) => {
        body.ownerConfirmed = false;
      },
      code: 'OWNER_CONFIRMATION_REQUIRED',
    },
    {
      mutate: (body) => {
        const settings = body.settings as Record<string, unknown>;
        const binding = (settings.secretBindings as Array<Record<string, unknown>>)[0];
        binding.value = 'raw-secret';
      },
      code: 'INVALID_BODY',
    },
    {
      mutate: (body) => {
        const settings = body.settings as Record<string, unknown>;
        settings.allowedTools = ['browser', 'root-shell'];
      },
      code: 'TOOLS_OUTSIDE_MANIFEST',
    },
    {
      mutate: (body) => {
        const settings = body.settings as Record<string, unknown>;
        settings.secretBindings = [{
          name: 'UNDECLARED',
          delivery: { kind: 'env', envName: 'UNDECLARED' },
        }];
      },
      code: 'SECRET_OUTSIDE_MANIFEST',
    },
    {
      mutate: (body) => {
        const settings = body.settings as Record<string, unknown>;
        settings.authorityRules = [{
          callerFunction: 'research',
          decision: 'always',
          action: 'platform.call',
          target: { functionName: 'gx.*' },
        }];
      },
      code: 'INVALID_AUTHORITY_RULE',
    },
    {
      mutate: (body) => {
        const settings = body.settings as Record<string, unknown>;
        const limits = settings.limits as Record<string, unknown>;
        limits.maxArtifactBytes = 1_073_741_825;
      },
      code: 'INVALID_SETTINGS',
    },
  ];

  for (const testCase of cases) {
    const body = validPutBody();
    testCase.mutate(body);
    const response = await handleLaunchComputeRoute(
      computeRequest(`/api/launch/agents/${AGENT_ID}/compute/settings`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
      `/api/launch/agents/${AGENT_ID}/compute/settings`,
      { authenticate: authenticate(), service: service() },
    );
    const payload = await response.json() as { code?: string };
    assertEquals(payload.code, testCase.code);
    assertEquals(response.status, 400);
  }

  const mediaType = await handleLaunchComputeRoute(
    computeRequest(`/api/launch/agents/${AGENT_ID}/compute/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(validPutBody()),
    }),
    `/api/launch/agents/${AGENT_ID}/compute/settings`,
    { authenticate: authenticate(), service: service() },
  );
  assertEquals(mediaType.status, 415);
});

Deno.test('launch Compute run pagination and cancellation are strict and projected', async () => {
  let pageInput: { limit: number; cursor: string | null } | null = null;
  let cancelledRunId: string | null = null;
  let downloadInput: {
    runId: string;
    artifactId: string;
    agentId: string;
    userId: string;
  } | null = null;
  const run = runSummary();
  (run as unknown as Record<string, unknown>).argv = ['secret-bearing-command'];
  const routeService = service({
    listRuns: (input) => {
      pageInput = { limit: input.limit, cursor: input.cursor };
      return Promise.resolve({ runs: [run], nextCursor: 'next_page' });
    },
    cancelRun: (input) => {
      cancelledRunId = input.runId;
      return Promise.resolve({ ...runSummary(), status: 'cancelled' });
    },
    downloadArtifact: (input) => {
      downloadInput = input;
      return Promise.resolve({
        body: 'artifact',
        contentType: 'text/plain',
        contentLength: 8,
        fileName: 'report.csv',
      });
    },
  });

  const list = await handleLaunchComputeRoute(
    computeRequest(
      `/api/launch/agents/${AGENT_ID}/compute/runs?limit=25&cursor=page_1`,
    ),
    `/api/launch/agents/${AGENT_ID}/compute/runs`,
    {
      authenticate: authenticate(),
      service: routeService,
      now: () => new Date(NOW),
    },
  );
  assertEquals(list.status, 200);
  assertEquals(pageInput, { limit: 25, cursor: 'page_1' });
  const listText = await list.text();
  assert(!listText.includes('secret-bearing-command'));
  assert(!listText.includes('public-r2.example'));
  assert(!listText.includes('private-bucket'));
  const listBody = JSON.parse(listText) as Record<string, unknown>;
  assertEquals(listBody.next_cursor, 'next_page');
  assertEquals(listBody.generatedAt, NOW);
  const projectedRun = (listBody.runs as Array<Record<string, unknown>>)[0];
  const projectedArtifact = (projectedRun.artifacts as Array<
    Record<string, unknown>
  >)[0];
  assertEquals(
    projectedArtifact.url,
    `/api/launch/agents/${AGENT_ID}/compute/runs/${RUN_ID}/artifacts/${ARTIFACT_ID}`,
  );

  for (
    const query of ['?limit=0', '?cursor=%2A', '?limit=1&limit=2', '?other=1']
  ) {
    const response = await handleLaunchComputeRoute(
      computeRequest(`/api/launch/agents/${AGENT_ID}/compute/runs${query}`),
      `/api/launch/agents/${AGENT_ID}/compute/runs`,
      { authenticate: authenticate(), service: routeService },
    );
    assertEquals(response.status, 400);
  }

  const cancel = await handleLaunchComputeRoute(
    computeRequest(
      `/api/launch/agents/${AGENT_ID}/compute/runs/${RUN_ID}/cancel`,
      { method: 'POST', body: '{}' },
    ),
    `/api/launch/agents/${AGENT_ID}/compute/runs/${RUN_ID}/cancel`,
    { authenticate: authenticate(), service: routeService },
  );
  assertEquals(cancel.status, 200);
  assertEquals(cancelledRunId, RUN_ID);
  assertEquals((await cancel.json() as { status: string }).status, 'cancelled');

  const invalidCancel = await handleLaunchComputeRoute(
    computeRequest(
      `/api/launch/agents/${AGENT_ID}/compute/runs/not-a-uuid/cancel`,
      { method: 'POST', body: '{}' },
    ),
    `/api/launch/agents/${AGENT_ID}/compute/runs/not-a-uuid/cancel`,
    { authenticate: authenticate(), service: routeService },
  );
  assertEquals(invalidCancel.status, 400);

  const invalidCancelBody = await handleLaunchComputeRoute(
    computeRequest(
      `/api/launch/agents/${AGENT_ID}/compute/runs/${RUN_ID}/cancel`,
      { method: 'POST', body: JSON.stringify({ reason: 'owner' }) },
    ),
    `/api/launch/agents/${AGENT_ID}/compute/runs/${RUN_ID}/cancel`,
    { authenticate: authenticate(), service: routeService },
  );
  assertEquals(invalidCancelBody.status, 400);

  const download = await handleLaunchComputeRoute(
    computeRequest(
      `/api/launch/agents/${AGENT_ID}/compute/runs/${RUN_ID}/artifacts/${ARTIFACT_ID}`,
    ),
    `/api/launch/agents/${AGENT_ID}/compute/runs/${RUN_ID}/artifacts/${ARTIFACT_ID}`,
    { authenticate: authenticate(), service: routeService },
  );
  assertEquals(download.status, 200);
  assertEquals(download.headers.get('Cache-Control'), 'private, no-store');
  assertEquals(download.headers.get('Content-Type'), 'text/plain');
  assertStringIncludes(
    download.headers.get('Content-Disposition') || '',
    'report.csv',
  );
  assertEquals(await download.text(), 'artifact');
  assertEquals(downloadInput, {
    userId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    artifactId: ARTIFACT_ID,
  });
});

Deno.test('launch Compute maps recognized service conflicts without leaking unknown details', async () => {
  const conflict = await handleLaunchComputeRoute(
    computeRequest(`/api/launch/agents/${AGENT_ID}/compute/settings`),
    `/api/launch/agents/${AGENT_ID}/compute/settings`,
    {
      authenticate: authenticate(),
      service: service({
        getSettings: () =>
          Promise.reject(
            new ComputeLaunchServiceError({
              code: 'COMPUTE_REVISION_CONFLICT',
              status: 409,
              message: 'Settings changed: provider-key-must-not-leak',
            }),
          ),
      }),
    },
  );
  assertEquals(conflict.status, 409);
  const conflictBody = await conflict.text();
  assert(!conflictBody.includes('provider-key-must-not-leak'));
  assertEquals(
    (JSON.parse(conflictBody) as { code: string }).code,
    'COMPUTE_REVISION_CONFLICT',
  );
});

Deno.test('launch status, route catalog, and OpenAPI publish the owner Compute surface', async () => {
  for (
    const route of [
      'GET /api/launch/agents/:id/compute/settings',
      'PUT /api/launch/agents/:id/compute/settings',
      'GET /api/launch/agents/:id/compute/runs',
      'POST /api/launch/agents/:id/compute/runs/:runId/cancel',
      'GET /api/launch/agents/:id/compute/runs/:runId/artifacts/:artifactId',
    ] as const
  ) {
    assert(LAUNCH_API_ROUTES.includes(route));
  }

  const status = await handleLaunch(
    computeRequest('/api/launch/status'),
  );
  const statusBody = await status.json() as {
    endpoints: Record<string, string>;
  };
  assertStringIncludes(
    statusBody.endpoints.agentComputeSettings,
    '/compute/settings',
  );
  assertStringIncludes(statusBody.endpoints.agentComputeRuns, '/compute/runs');
  assertStringIncludes(statusBody.endpoints.agentComputeCancel, '/cancel');
  assertStringIncludes(
    statusBody.endpoints.agentComputeArtifact,
    '/artifacts/',
  );

  const openApi = await handleLaunch(
    computeRequest('/api/launch/openapi.json'),
  );
  const spec = await openApi.json() as {
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  };
  assert(spec.paths['/api/launch/agents/{id}/compute/settings']);
  assert(spec.paths['/api/launch/agents/{id}/compute/runs']);
  assert(spec.paths['/api/launch/agents/{id}/compute/runs/{runId}/cancel']);
  assert(
    spec.paths[
      '/api/launch/agents/{id}/compute/runs/{runId}/artifacts/{artifactId}'
    ],
  );
  assert(spec.components.schemas.ComputeLaunchAuthorityRule);
  assert(spec.components.schemas.ComputeLaunchAuthorityRuleMutation);
});
