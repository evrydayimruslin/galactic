import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  validateRolloutState,
  verifyRolloutFencedState,
  verifyRolloutLivePair,
  verifyRolloutPromotedPair,
  verifyRolloutRevalidatedOffAnchor,
  verifyRolloutRevertedPair,
  verifyRolloutUploadedApi,
  verifyWranglerVersionDeployOutput,
} from './verify-api-compute-rollout-state.mjs';

const IDS = Object.freeze({
  offApi: '11111111-1111-4111-8111-111111111111',
  candidateApi: '22222222-2222-4222-8222-222222222222',
  otherApi: '33333333-3333-4333-8333-333333333333',
  compute: '44444444-4444-4444-8444-444444444444',
  otherCompute: '55555555-5555-4555-8555-555555555555',
  offApiDeployment: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  candidateApiDeployment: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  revertedApiDeployment: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  computeDeployment: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  otherDeployment: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
});
const OWNER_ID = '66666666-6666-4666-8666-666666666666';
const AGENT_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_OWNER_ID = '88888888-8888-4888-8888-888888888888';
const OTHER_AGENT_ID = '99999999-9999-4999-8999-999999999999';
const CANARY_PAIR = `${OWNER_ID}/${AGENT_ID}`;
const OTHER_CANARY_PAIR = `${OTHER_OWNER_ID}/${OTHER_AGENT_ID}`;
const ENVIRONMENT_DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const API_ETAG = 'api-script-etag-v0.4.96';
const COMPUTE_ETAG = 'compute-script-etag-a8031c9b';
const OFF_TAG = `api-${'1'.repeat(40)}`;
const CANDIDATE_TAG = `api-${'2'.repeat(40)}`;
const COMPUTE_TAG = `compute-${'3'.repeat(40)}`;

const TARGETS = Object.freeze({
  production: Object.freeze({
    apiWorker: 'ultralight-api',
    computeWorker: 'galactic-compute',
    computeQueue: 'galactic-compute',
    artifactBucket: 'galactic-compute-artifacts',
    sessionWorker: 'galactic-gx-test-session',
  }),
  staging: Object.freeze({
    apiWorker: 'ultralight-api-staging',
    computeWorker: 'galactic-compute-staging',
    computeQueue: 'galactic-compute-staging',
    artifactBucket: 'galactic-compute-artifacts-staging',
    sessionWorker: 'galactic-gx-test-session-staging',
  }),
});

const DISPATCH = Object.freeze({
  repository: 'evrydayimruslin/galactic',
  workflow_run_id: '123456789',
  run_attempt: '1',
  git_sha: '4'.repeat(40),
});
const OTHER_DISPATCH = Object.freeze({
  ...DISPATCH,
  workflow_run_id: '987654321',
});

const STATE_KEYS = [
  'api',
  'canary_allowlist',
  'compute',
  'dispatch',
  'environment_digest',
  'kind',
  'phase',
  'policy',
  'schema_version',
  'source_api_version_id',
  'target',
  'verified',
].sort();
const WORKER_STATE_KEYS = [
  'code_etag',
  'compatibility_sha256',
  'deployment_id',
  'version_id',
  'version_tag',
  'worker',
].sort();
const DISPATCH_KEYS = [
  'git_sha',
  'repository',
  'run_attempt',
  'workflow_run_id',
].sort();

function clone(value) {
  return structuredClone(value);
}

function status(versionId, deploymentId) {
  return {
    id: deploymentId,
    versions: [{ version_id: versionId, percentage: 100 }],
  };
}

function wranglerDeployRecords({
  worker = 'ultralight-api-staging',
  environment = 'staging',
  versionId = IDS.candidateApi,
  deploymentId = IDS.candidateApiDeployment,
} = {}) {
  return [
    {
      type: 'wrangler-session',
      version: 1,
      wrangler_version: '4.112.0',
      command_line_args: [
        'versions',
        'deploy',
        `${versionId}@100%`,
        '--name',
        worker,
        '--env',
        environment,
        '--yes',
      ],
      log_file_path: '/tmp/wrangler.log',
      timestamp: '2026-08-04T12:00:00.000Z',
    },
    {
      type: 'version-deploy',
      version: 1,
      worker_name: worker,
      worker_tag: 'reviewed-worker-tag',
      deployment_id: deploymentId,
      // Wrangler 4.112.0 serializes its Map as an empty JSON object. The live
      // deployment status is the authoritative subsequent 100% traffic fence.
      version_traffic: {},
      timestamp: '2026-08-04T12:00:01.000Z',
    },
  ];
}

function wranglerDeployContent(records = wranglerDeployRecords()) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function policyValues(policy, canaryAllowlist) {
  if (policy === 'off') {
    return { enabled: '0', rolloutMode: 'canary', canaryAllowlist: '' };
  }
  if (policy === 'canary') {
    return {
      enabled: '1',
      rolloutMode: 'canary',
      canaryAllowlist,
    };
  }
  if (policy === 'global') {
    return { enabled: '1', rolloutMode: 'global', canaryAllowlist: '' };
  }
  throw new Error(`unsupported test policy ${policy}`);
}

function apiVersion({
  target = 'production',
  id = IDS.offApi,
  tag = OFF_TAG,
  policy = 'off',
  canaryAllowlist = policy === 'canary' ? CANARY_PAIR : '',
  environmentDigest = ENVIRONMENT_DIGEST,
  etag = API_ETAG,
} = {}) {
  const names = TARGETS[target];
  const values = policyValues(policy, canaryAllowlist);
  return {
    id,
    annotations: { 'workers/tag': tag },
    resources: {
      script: { etag, handlers: ['fetch'], placement_mode: 'smart' },
      bindings: [
        {
          type: 'plain_text',
          name: 'COMPUTE_ENABLED',
          text: values.enabled,
        },
        {
          type: 'plain_text',
          name: 'COMPUTE_ENVIRONMENT_DIGEST',
          text: environmentDigest,
        },
        {
          type: 'plain_text',
          name: 'COMPUTE_ROLLOUT_MODE',
          text: values.rolloutMode,
        },
        {
          type: 'plain_text',
          name: 'COMPUTE_CANARY_ALLOWLIST',
          text: values.canaryAllowlist,
        },
        {
          type: 'service',
          name: 'COMPUTE_PLANE',
          service: names.computeWorker,
          entrypoint: 'ComputePlane',
        },
        {
          type: 'queue',
          name: 'COMPUTE_QUEUE',
          queue_name: names.computeQueue,
        },
        {
          type: 'r2_bucket',
          name: 'COMPUTE_ARTIFACTS',
          bucket_name: names.artifactBucket,
        },
        {
          type: 'durable_object_namespace',
          name: 'GX_TEST_SESSION',
          class_name: 'GxTestSession',
          script_name: names.sessionWorker,
        },
        {
          type: 'plain_text',
          name: 'UNCHANGED_API_SETTING',
          text: 'stable',
        },
        { type: 'secret_text', name: 'API_SIGNING_SECRET' },
      ],
      script_runtime: {
        exports: {
          default: { type: 'service-worker' },
          GxTestSession: {
            type: 'durable-object',
            storage: 'sqlite',
            state: 'created',
          },
        },
      },
    },
  };
}

function computeVersion({
  target = 'production',
  id = IDS.compute,
  tag = COMPUTE_TAG,
  environmentDigest = ENVIRONMENT_DIGEST,
  etag = COMPUTE_ETAG,
} = {}) {
  const names = TARGETS[target];
  return {
    id,
    annotations: { 'workers/tag': tag },
    resources: {
      script: { etag, handlers: ['queue'], placement_mode: 'smart' },
      bindings: [
        {
          type: 'plain_text',
          name: 'COMPUTE_ENVIRONMENT_DIGEST',
          text: environmentDigest,
        },
        {
          type: 'service',
          name: 'CONTROL_PLANE',
          service: names.apiWorker,
          entrypoint: 'ComputeControlPlane',
        },
        {
          type: 'r2_bucket',
          name: 'COMPUTE_ARTIFACTS',
          bucket_name: names.artifactBucket,
        },
        {
          type: 'plain_text',
          name: 'UNCHANGED_COMPUTE_SETTING',
          text: 'stable',
        },
        { type: 'secret_text', name: 'RUNPOD_API_KEY' },
      ],
      script_runtime: {
        exports: {
          ComputePlane: { type: 'worker-entrypoint' },
        },
      },
    },
  };
}

function binding(version, name) {
  const found = version.resources.bindings.find((row) => row.name === name);
  assert.ok(found, `fixture binding ${name} must exist`);
  return found;
}

function livePair({
  target = 'production',
  policy = 'off',
  canaryAllowlist = policy === 'canary' ? CANARY_PAIR : '',
  apiId = IDS.offApi,
  apiTag = OFF_TAG,
  apiDeploymentId = IDS.offApiDeployment,
  computeId = IDS.compute,
  computeTag = COMPUTE_TAG,
  computeDeploymentId = IDS.computeDeployment,
  environmentDigest = ENVIRONMENT_DIGEST,
} = {}) {
  return {
    apiStatus: status(apiId, apiDeploymentId),
    apiVersion: apiVersion({
      target,
      id: apiId,
      tag: apiTag,
      policy,
      canaryAllowlist,
      environmentDigest,
    }),
    computeStatus: status(computeId, computeDeploymentId),
    computeVersion: computeVersion({
      target,
      id: computeId,
      tag: computeTag,
      environmentDigest,
    }),
  };
}

function captureOff(target = 'production', dispatch = DISPATCH) {
  const pair = livePair({ target });
  return verifyRolloutLivePair({
    target,
    phase: 'captured',
    expectedPolicy: 'off',
    expectedCanaryAllowlist: '',
    expectedApiTag: OFF_TAG,
    ...pair,
    dispatch,
  });
}

function inspectPolicy({
  target = 'production',
  policy = 'canary',
  canaryAllowlist = policy === 'canary' ? CANARY_PAIR : '',
  dispatch = DISPATCH,
} = {}) {
  return verifyRolloutLivePair({
    target,
    phase: 'inspected',
    ...livePair({ target, policy, canaryAllowlist }),
    dispatch,
  });
}

function uploadCandidate({
  target = 'production',
  baseline = captureOff(target),
  policy = 'canary',
  canaryAllowlist = policy === 'canary' ? CANARY_PAIR : '',
  uploadedVersion = apiVersion({
    target,
    id: IDS.candidateApi,
    tag: CANDIDATE_TAG,
    policy,
    canaryAllowlist,
  }),
  expectedVersionId = IDS.candidateApi,
  expectedVersionTag = CANDIDATE_TAG,
  dispatch = DISPATCH,
} = {}) {
  return verifyRolloutUploadedApi({
    target,
    baselineState: baseline,
    uploadedVersion,
    expectedVersionId,
    expectedVersionTag,
    expectedPolicy: policy,
    expectedCanaryAllowlist: canaryAllowlist,
    dispatch,
  });
}

function promotedInputs({
  target = 'production',
  policy = 'canary',
  canaryAllowlist = policy === 'canary' ? CANARY_PAIR : '',
} = {}) {
  return livePair({
    target,
    policy,
    canaryAllowlist,
    apiId: IDS.candidateApi,
    apiTag: CANDIDATE_TAG,
    apiDeploymentId: IDS.candidateApiDeployment,
  });
}

function promoteCandidate({
  target = 'production',
  candidate = uploadCandidate({ target }),
  policy = candidate.policy,
  canaryAllowlist = candidate.canary_allowlist.join(','),
  pair = promotedInputs({ target, policy, canaryAllowlist }),
  dispatch = DISPATCH,
} = {}) {
  return verifyRolloutPromotedPair({
    target,
    candidateState: candidate,
    expectedApiDeploymentId: IDS.candidateApiDeployment,
    ...pair,
    dispatch,
  });
}

function assertExactState(state) {
  assert.deepEqual(Object.keys(state).sort(), STATE_KEYS);
  assert.deepEqual(Object.keys(state.api).sort(), WORKER_STATE_KEYS);
  assert.deepEqual(Object.keys(state.compute).sort(), WORKER_STATE_KEYS);
  assert.deepEqual(Object.keys(state.dispatch).sort(), DISPATCH_KEYS);
  assert.deepEqual(validateRolloutState(state), state);
}

for (const target of ['staging', 'production']) {
  test(`completes ${target} OFF -> canary -> OFF capture/upload/promote/fence/revalidate/revert`, () => {
    const baseline = captureOff(target);
    assert.equal(baseline.phase, 'captured');
    assert.equal(baseline.policy, 'off');
    assert.equal(baseline.source_api_version_id, null);
    assertExactState(baseline);

    const candidate = uploadCandidate({ target, baseline });
    assert.equal(candidate.phase, 'uploaded');
    assert.equal(candidate.api.deployment_id, null);
    assert.equal(candidate.source_api_version_id, IDS.offApi);
    assert.deepEqual(candidate.canary_allowlist, [CANARY_PAIR]);
    assertExactState(candidate);

    const pair = promotedInputs({ target });
    const promoted = promoteCandidate({ target, candidate, pair });
    assert.equal(promoted.phase, 'promoted');
    assert.equal(promoted.api.deployment_id, IDS.candidateApiDeployment);
    assert.equal(promoted.source_api_version_id, IDS.offApi);
    assertExactState(promoted);

    const fenced = verifyRolloutFencedState({
      expectedState: promoted,
      ...pair,
      dispatch: DISPATCH,
    });
    assert.equal(fenced.phase, 'fenced');
    assert.equal(fenced.source_api_version_id, IDS.offApi);
    assertExactState(fenced);

    const revalidated = verifyRolloutRevalidatedOffAnchor({
      priorAnchorState: baseline,
      currentState: fenced,
      offApiVersion: apiVersion({ target }),
      dispatch: DISPATCH,
    });
    assert.equal(revalidated.phase, 'revalidated');
    assert.equal(revalidated.policy, 'off');
    assert.equal(revalidated.api.deployment_id, null);
    assert.equal(revalidated.source_api_version_id, IDS.candidateApi);
    assertExactState(revalidated);

    const revertedPair = livePair({
      target,
      apiDeploymentId: IDS.revertedApiDeployment,
    });
    const reverted = verifyRolloutRevertedPair({
      target,
      anchorState: revalidated,
      expectedApiDeploymentId: IDS.revertedApiDeployment,
      ...revertedPair,
      dispatch: DISPATCH,
    });
    assert.equal(reverted.phase, 'reverted');
    assert.equal(reverted.policy, 'off');
    assert.equal(reverted.source_api_version_id, IDS.candidateApi);
    assertExactState(reverted);
  });
}

for (const target of ['staging', 'production']) {
  test(`accepts ${target} inspected canary -> global and inspected enabled -> OFF transitions`, () => {
    const inspectedCanary = inspectPolicy({ target, policy: 'canary' });
    const globalCandidate = uploadCandidate({
      target,
      baseline: inspectedCanary,
      policy: 'global',
      canaryAllowlist: '',
      uploadedVersion: apiVersion({
        target,
        id: IDS.candidateApi,
        tag: CANDIDATE_TAG,
        policy: 'global',
      }),
    });
    assert.equal(globalCandidate.policy, 'global');
    assert.equal(globalCandidate.source_api_version_id, IDS.offApi);
    assertExactState(globalCandidate);

    const globalPair = promotedInputs({ target, policy: 'global' });
    const promotedGlobal = promoteCandidate({
      target,
      candidate: globalCandidate,
      pair: globalPair,
    });
    const fencedGlobal = verifyRolloutFencedState({
      expectedState: promotedGlobal,
      ...globalPair,
      dispatch: DISPATCH,
    });
    assert.equal(fencedGlobal.policy, 'global');
    assertExactState(fencedGlobal);

    const canaryOffCandidate = uploadCandidate({
      target,
      baseline: inspectedCanary,
      policy: 'off',
      canaryAllowlist: '',
      uploadedVersion: apiVersion({
        target,
        id: IDS.candidateApi,
        tag: CANDIDATE_TAG,
        policy: 'off',
      }),
    });
    assert.equal(canaryOffCandidate.policy, 'off');
    assertExactState(canaryOffCandidate);

    const inspectedGlobal = inspectPolicy({ target, policy: 'global' });
    const globalOffCandidate = uploadCandidate({
      target,
      baseline: inspectedGlobal,
      policy: 'off',
      canaryAllowlist: '',
      uploadedVersion: apiVersion({
        target,
        id: IDS.candidateApi,
        tag: CANDIDATE_TAG,
        policy: 'off',
      }),
    });
    assert.equal(globalOffCandidate.policy, 'off');
    assertExactState(globalOffCandidate);
  });
}

test('rejects every upload transition outside the explicit rollout matrix', () => {
  const capturedOff = captureOff();
  const inspectedOff = clone(capturedOff);
  inspectedOff.phase = 'inspected';
  const inspectedCanary = inspectPolicy({ policy: 'canary' });
  const inspectedGlobal = inspectPolicy({ policy: 'global' });
  const promotedCanary = promoteCandidate();
  const cases = [
    ['captured OFF -> OFF', capturedOff, 'off'],
    ['captured OFF -> global', capturedOff, 'global'],
    ['inspected OFF -> canary', inspectedOff, 'canary'],
    ['inspected canary -> canary', inspectedCanary, 'canary'],
    ['inspected global -> canary', inspectedGlobal, 'canary'],
    ['inspected global -> global', inspectedGlobal, 'global'],
    ['promoted canary -> OFF', promotedCanary, 'off'],
  ];
  for (const [label, baseline, policy] of cases) {
    const canaryAllowlist = policy === 'canary' ? CANARY_PAIR : '';
    assert.throws(
      () =>
        uploadCandidate({
          baseline,
          policy,
          canaryAllowlist,
          uploadedVersion: apiVersion({
            id: IDS.otherApi,
            tag: `api-${'5'.repeat(40)}`,
            policy,
            canaryAllowlist,
          }),
          expectedVersionId: IDS.otherApi,
          expectedVersionTag: `api-${'5'.repeat(40)}`,
        }),
      /upload transition .* is not allowed/u,
      label,
    );
  }
});

test('accepts exact staging and explicit-empty-environment production Wrangler deploy evidence', () => {
  for (
    const [worker, environment] of [
      ['ultralight-api-staging', 'staging'],
      ['ultralight-api', ''],
    ]
  ) {
    const records = wranglerDeployRecords({ worker, environment });
    assert.equal(
      verifyWranglerVersionDeployOutput({
        content: wranglerDeployContent(records),
        expectedWorker: worker,
        expectedEnvironment: environment,
        expectedVersionId: IDS.candidateApi,
      }),
      IDS.candidateApiDeployment,
    );
  }
});

for (
  const [label, mutate, pattern] of [
    [
      'missing session record',
      (records) => records.splice(0, 1),
      /exactly one session record and one version-deploy record/u,
    ],
    [
      'extra output record',
      (records) => records.push({ type: 'unexpected' }),
      /exactly one session record and one version-deploy record/u,
    ],
    [
      'reversed record order',
      (records) => records.reverse(),
      /session record does not describe the exact versions deploy/u,
    ],
    [
      'wrong session command',
      (records) => records[0].command_line_args.splice(0, 2, 'deploy', 'now'),
      /session record does not describe the exact versions deploy/u,
    ],
    [
      'dry-run command',
      (records) => records[0].command_line_args.push('--dry-run'),
      /session record does not describe the exact versions deploy/u,
    ],
    [
      'wrong candidate percentage',
      (records) => records[0].command_line_args[2] = `${IDS.candidateApi}@99%`,
      /session record does not describe the exact versions deploy/u,
    ],
    [
      'duplicate candidate',
      (records) => records[0].command_line_args.push(`${IDS.candidateApi}@100%`),
      /session record does not describe the exact versions deploy/u,
    ],
    [
      'missing environment',
      (records) => records[0].command_line_args.splice(5, 2),
      /session record does not describe the exact versions deploy/u,
    ],
    [
      'wrong environment',
      (records) => records[0].command_line_args[6] = 'production',
      /session record does not describe the exact versions deploy/u,
    ],
    [
      'duplicate Worker flag',
      (records) => records[0].command_line_args.push('--name', 'other-worker'),
      /session record does not describe the exact versions deploy/u,
    ],
    [
      'wrong deployment Worker',
      (records) => records[1].worker_name = 'other-worker',
      /version-deploy record does not match the reviewed command/u,
    ],
    [
      'forged traffic map',
      (records) => records[1].version_traffic = { [IDS.otherApi]: 100 },
      /version-deploy record does not match the reviewed command/u,
    ],
    [
      'split traffic map',
      (records) => {
        records[1].version_traffic = {
          [IDS.candidateApi]: 90,
          [IDS.otherApi]: 10,
        };
      },
      /version-deploy record does not match the reviewed command/u,
    ],
    [
      'malformed deployment ID',
      (records) => records[1].deployment_id = 'not-a-deployment-id',
      /Wrangler deployment id is not a canonical version UUID/u,
    ],
    [
      'wrong deployment record type',
      (records) => records[1].type = 'version-upload',
      /version-deploy record does not match the reviewed command/u,
    ],
  ]
) {
  test(`rejects Wrangler deploy evidence with a ${label}`, () => {
    const records = wranglerDeployRecords();
    mutate(records);
    assert.throws(
      () =>
        verifyWranglerVersionDeployOutput({
          content: wranglerDeployContent(records),
          expectedWorker: 'ultralight-api-staging',
          expectedEnvironment: 'staging',
          expectedVersionId: IDS.candidateApi,
        }),
      pattern,
    );
  });
}

test('rejects malformed or non-NDJSON Wrangler deploy evidence', () => {
  assert.throws(
    () =>
      verifyWranglerVersionDeployOutput({
        content: '{not-json}\n',
        expectedWorker: 'ultralight-api-staging',
        expectedEnvironment: 'staging',
        expectedVersionId: IDS.candidateApi,
      }),
    /not valid NDJSON/u,
  );
  assert.throws(
    () =>
      verifyWranglerVersionDeployOutput({
        content: wranglerDeployContent(),
        expectedWorker: 'ultralight-api-staging',
        expectedEnvironment: 'staging',
        expectedVersionId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }),
    /deployed API version id is not a canonical version UUID/u,
  );
});

test('rejects split API or Compute traffic instead of sampling one version', () => {
  for (const worker of ['api', 'compute']) {
    const pair = livePair();
    const selected = worker === 'api' ? pair.apiStatus : pair.computeStatus;
    selected.versions = [
      { version_id: selected.versions[0].version_id, percentage: 90 },
      { version_id: IDS.otherCompute, percentage: 10 },
    ];
    assert.throws(
      () =>
        verifyRolloutLivePair({
          target: 'production',
          phase: 'captured',
          ...pair,
          dispatch: DISPATCH,
        }),
      new RegExp(
        `${worker === 'api' ? 'API' : 'Compute'} deployment must contain exactly one version`,
        'u',
      ),
    );
  }
});

test('rejects API and Compute deployment ID drift at a fence', () => {
  const expected = captureOff();
  for (const worker of ['api', 'compute']) {
    const pair = livePair();
    const selected = worker === 'api' ? pair.apiStatus : pair.computeStatus;
    selected.id = IDS.otherDeployment;
    assert.throws(
      () =>
        verifyRolloutFencedState({
          expectedState: expected,
          ...pair,
          dispatch: DISPATCH,
        }),
      new RegExp(`${worker === 'api' ? 'API' : 'Compute'} deployment id changed`, 'u'),
    );
  }
});

test('rejects malformed deployment, version, source, and dispatch IDs', () => {
  const malformedLive = livePair();
  malformedLive.apiStatus.id = IDS.offApiDeployment.toUpperCase();
  assert.throws(
    () =>
      verifyRolloutLivePair({
        target: 'production',
        phase: 'captured',
        ...malformedLive,
        dispatch: DISPATCH,
      }),
    /API deployment id is not a canonical version UUID/u,
  );

  const malformedVersion = livePair();
  malformedVersion.computeStatus.versions[0].version_id = 'not-a-version-id';
  assert.throws(
    () =>
      verifyRolloutLivePair({
        target: 'production',
        phase: 'captured',
        ...malformedVersion,
        dispatch: DISPATCH,
      }),
    /Compute deployed version id is not a canonical version UUID/u,
  );

  const malformedState = captureOff();
  malformedState.source_api_version_id = 'not-a-version-id';
  assert.throws(
    () => validateRolloutState(malformedState),
    /source API version id is malformed/u,
  );

  assert.throws(
    () => captureOff('production', { ...DISPATCH, workflow_run_id: '01' }),
    /GITHUB_RUN_ID is malformed/u,
  );
});

test('rejects a live policy that differs from the requested state', () => {
  assert.throws(
    () =>
      verifyRolloutLivePair({
        target: 'production',
        phase: 'captured',
        expectedPolicy: 'off',
        ...livePair({ policy: 'global' }),
        dispatch: DISPATCH,
      }),
    /API policy does not match the requested off state/u,
  );
});

for (
  const [label, canaryAllowlist] of [
    [
      'uppercase',
      'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/' +
      'BBBBBBBB-BBBB-4BBB-BBBB-BBBBBBBBBBBB',
    ],
    ['duplicate', `${CANARY_PAIR},${CANARY_PAIR}`],
    ['space-padded', ` ${CANARY_PAIR}`],
    ['extra', `${CANARY_PAIR},${OTHER_CANARY_PAIR}`],
  ]
) {
  test(`rejects a ${label} canary allowlist`, () => {
    const pair = livePair({ policy: 'canary', canaryAllowlist });
    assert.throws(
      () =>
        verifyRolloutLivePair({
          target: 'production',
          phase: 'inspected',
          expectedPolicy: 'canary',
          expectedCanaryAllowlist: canaryAllowlist,
          ...pair,
          dispatch: DISPATCH,
        }),
      /exactly one canonical owner\/Agent pair/u,
    );
  });
}

test('rejects API script-byte drift during vars-only upload', () => {
  const uploadedVersion = apiVersion({
    id: IDS.candidateApi,
    tag: CANDIDATE_TAG,
    policy: 'canary',
    etag: 'different-api-script-etag',
  });
  assert.throws(
    () => uploadCandidate({ uploadedVersion }),
    /uploaded API changed Worker script bytes/u,
  );
});

for (
  const [label, mutate] of [
    [
      'plain-text value',
      (version) => {
        binding(version, 'UNCHANGED_API_SETTING').text = 'drifted';
      },
    ],
    [
      'binding type',
      (version) => {
        binding(version, 'UNCHANGED_API_SETTING').type = 'json';
      },
    ],
    [
      'added binding',
      (version) => {
        version.resources.bindings.push({
          type: 'plain_text',
          name: 'UNREVIEWED_SETTING',
          text: 'present',
        });
      },
    ],
    [
      'removed binding',
      (version) => {
        version.resources.bindings = version.resources.bindings.filter(
          (row) => row.name !== 'UNCHANGED_API_SETTING',
        );
      },
    ],
  ]
) {
  test(`rejects non-policy API ${label} drift during upload`, () => {
    const uploadedVersion = apiVersion({
      id: IDS.candidateApi,
      tag: CANDIDATE_TAG,
      policy: 'canary',
    });
    mutate(uploadedVersion);
    assert.throws(
      () => uploadCandidate({ uploadedVersion }),
      /uploaded API changed non-policy Worker resources/u,
    );
  });
}

test('rejects secret-name drift during vars-only upload', () => {
  const uploadedVersion = apiVersion({
    id: IDS.candidateApi,
    tag: CANDIDATE_TAG,
    policy: 'canary',
  });
  binding(uploadedVersion, 'API_SIGNING_SECRET').name = 'OTHER_SIGNING_SECRET';
  assert.throws(
    () => uploadCandidate({ uploadedVersion }),
    /uploaded API changed non-policy Worker resources/u,
  );
});

for (
  const [label, mutate] of [
    [
      'handler metadata',
      (version) => {
        version.resources.script.handlers = ['fetch', 'queue'];
      },
    ],
    [
      'placement metadata',
      (version) => {
        version.resources.script.placement_mode = 'off';
      },
    ],
    [
      'unknown resource metadata',
      (version) => {
        version.resources.unreviewed_execution_setting = { enabled: true };
      },
    ],
  ]
) {
  test(`rejects API ${label} drift during vars-only upload`, () => {
    const uploadedVersion = apiVersion({
      id: IDS.candidateApi,
      tag: CANDIDATE_TAG,
      policy: 'canary',
    });
    mutate(uploadedVersion);
    assert.throws(
      () => uploadCandidate({ uploadedVersion }),
      /uploaded API changed non-policy Worker resources/u,
    );
  });
}

for (
  const [label, mutate, pattern] of [
    [
      'GxTestSession export removal',
      (version) => {
        delete version.resources.script_runtime.exports.GxTestSession;
      },
      /GxTestSession export/u,
    ],
    [
      'GxTestSession ownership transfer',
      (version) => {
        version.resources.script_runtime.exports.GxTestSession.transfer_from = 'old-worker';
      },
      /does not retain the source-owned SQLite GxTestSession export/u,
    ],
    [
      'GxTestSession storage drift',
      (version) => {
        version.resources.script_runtime.exports.GxTestSession.storage = 'durable-object';
      },
      /does not retain the source-owned SQLite GxTestSession export/u,
    ],
    [
      'GX_TEST_SESSION binding drift',
      (version) => {
        binding(version, 'GX_TEST_SESSION').script_name = 'wrong-session-worker';
      },
      /GX_TEST_SESSION binding does not match production/u,
    ],
  ]
) {
  test(`rejects ${label}`, () => {
    const uploadedVersion = apiVersion({
      id: IDS.candidateApi,
      tag: CANDIDATE_TAG,
      policy: 'canary',
    });
    mutate(uploadedVersion);
    assert.throws(
      () => uploadCandidate({ uploadedVersion }),
      pattern,
    );
  });
}

test('normalizes absent versus created GxTestSession state without masking export drift', () => {
  const baselinePair = livePair();
  delete baselinePair.apiVersion.resources.script_runtime.exports.GxTestSession
    .state;
  const baseline = verifyRolloutLivePair({
    target: 'production',
    phase: 'captured',
    expectedPolicy: 'off',
    ...baselinePair,
    dispatch: DISPATCH,
  });
  assert.doesNotThrow(() => uploadCandidate({ baseline }));
});

test('rejects API/Compute environment digest disagreement and upload digest drift', () => {
  const mismatchedLive = livePair();
  binding(
    mismatchedLive.computeVersion,
    'COMPUTE_ENVIRONMENT_DIGEST',
  ).text = OTHER_DIGEST;
  assert.throws(
    () =>
      verifyRolloutLivePair({
        target: 'production',
        phase: 'captured',
        ...mismatchedLive,
        dispatch: DISPATCH,
      }),
    /API and Compute environment digests differ/u,
  );

  const uploadedVersion = apiVersion({
    id: IDS.candidateApi,
    tag: CANDIDATE_TAG,
    policy: 'canary',
    environmentDigest: OTHER_DIGEST,
  });
  assert.throws(
    () => uploadCandidate({ uploadedVersion }),
    /uploaded API changed the Compute environment digest/u,
  );
});

test('rejects the all-zero bootstrap digest in live and serialized evidence', () => {
  const zeroDigest = `sha256:${'0'.repeat(64)}`;
  const pair = livePair({ environmentDigest: zeroDigest });
  assert.throws(
    () =>
      verifyRolloutLivePair({
        target: 'production',
        phase: 'captured',
        ...pair,
        dispatch: DISPATCH,
      }),
    /Compute environment digest is not a canonical sha256 digest/u,
  );

  const state = captureOff();
  state.environment_digest = zeroDigest;
  assert.throws(
    () => validateRolloutState(state),
    /rollout state environment digest is not a canonical sha256 digest/u,
  );
});

test('rejects Compute version ID drift during promotion', () => {
  const candidate = uploadCandidate();
  const pair = promotedInputs();
  pair.computeStatus.versions[0].version_id = IDS.otherCompute;
  pair.computeVersion.id = IDS.otherCompute;
  assert.throws(
    () => promoteCandidate({ candidate, pair }),
    /Compute deployment version changed/u,
  );
});

test('rejects Compute tag drift during promotion', () => {
  const candidate = uploadCandidate();
  const pair = promotedInputs();
  pair.computeVersion.annotations['workers/tag'] = `compute-${'9'.repeat(40)}`;
  assert.throws(
    () => promoteCandidate({ candidate, pair }),
    /Compute tag changed|promoted API\/Compute bytes or compatibility changed/u,
  );
});

test('rejects Compute script-byte drift during promotion', () => {
  const candidate = uploadCandidate();
  const pair = promotedInputs();
  pair.computeVersion.resources.script.etag = 'different-compute-etag';
  assert.throws(
    () => promoteCandidate({ candidate, pair }),
    /promoted API\/Compute bytes or compatibility changed/u,
  );
});

test('rejects Compute binding drift during promotion', () => {
  const candidate = uploadCandidate();
  const pair = promotedInputs();
  binding(pair.computeVersion, 'UNCHANGED_COMPUTE_SETTING').text = 'drifted';
  assert.throws(
    () => promoteCandidate({ candidate, pair }),
    /promoted API\/Compute bytes or compatibility changed/u,
  );
});

test('rejects Compute execution-metadata drift during promotion', () => {
  const candidate = uploadCandidate();
  const pair = promotedInputs();
  pair.computeVersion.resources.script.handlers = ['queue', 'fetch'];
  assert.throws(
    () => promoteCandidate({ candidate, pair }),
    /promoted API\/Compute bytes or compatibility changed/u,
  );
});

test('rejects Compute control-plane and artifact target drift', () => {
  for (const name of ['CONTROL_PLANE', 'COMPUTE_ARTIFACTS']) {
    const pair = livePair();
    if (name === 'CONTROL_PLANE') {
      binding(pair.computeVersion, name).service = 'ultralight-api-staging';
    } else {
      binding(pair.computeVersion, name).bucket_name = 'galactic-compute-artifacts-staging';
    }
    assert.throws(
      () =>
        verifyRolloutLivePair({
          target: 'production',
          phase: 'captured',
          ...pair,
          dispatch: DISPATCH,
        }),
      new RegExp(`${name} binding does not match production`, 'u'),
    );
  }
});

test('rejects an API candidate tag or identity that differs from upload evidence', () => {
  const candidate = uploadCandidate();

  const wrongTag = promotedInputs();
  wrongTag.apiVersion.annotations['workers/tag'] = `api-${'8'.repeat(40)}`;
  assert.throws(
    () => promoteCandidate({ candidate, pair: wrongTag }),
    /API tag does not match/u,
  );

  const wrongId = promotedInputs();
  wrongId.apiStatus.versions[0].version_id = IDS.otherApi;
  wrongId.apiVersion.id = IDS.otherApi;
  assert.throws(
    () => promoteCandidate({ candidate, pair: wrongId }),
    /API deployment version changed/u,
  );
});

test('rejects target changes and target-specific binding crossovers', () => {
  const productionBaseline = captureOff('production');
  assert.throws(
    () =>
      uploadCandidate({
        target: 'staging',
        baseline: productionBaseline,
        uploadedVersion: apiVersion({
          target: 'staging',
          id: IDS.candidateApi,
          tag: CANDIDATE_TAG,
          policy: 'canary',
        }),
      }),
    /upload baseline target changed/u,
  );

  assert.throws(
    () =>
      verifyRolloutLivePair({
        target: 'staging',
        phase: 'captured',
        ...livePair({ target: 'production' }),
        dispatch: DISPATCH,
      }),
    /binding does not match staging/u,
  );

  assert.throws(
    () =>
      verifyRolloutLivePair({
        target: 'preview',
        phase: 'captured',
        ...livePair(),
        dispatch: DISPATCH,
      }),
    /unsupported target preview/u,
  );
});

test('rejects cross-dispatch upload baselines, promoted candidates, and rollback anchors', () => {
  const oldBaseline = captureOff('production', OTHER_DISPATCH);
  assert.throws(
    () => uploadCandidate({ baseline: oldBaseline, dispatch: DISPATCH }),
    /upload baseline was not captured in this workflow dispatch/u,
  );

  const oldCandidate = uploadCandidate({
    baseline: oldBaseline,
    dispatch: OTHER_DISPATCH,
  });
  assert.throws(
    () => promoteCandidate({ candidate: oldCandidate, dispatch: DISPATCH }),
    /promoted candidate is not an upload from this dispatch/u,
  );

  assert.throws(
    () =>
      verifyRolloutRevertedPair({
        target: 'production',
        anchorState: oldBaseline,
        expectedApiDeploymentId: IDS.revertedApiDeployment,
        ...livePair({ apiDeploymentId: IDS.revertedApiDeployment }),
        dispatch: DISPATCH,
      }),
    /rollback anchor was not verified as OFF in this dispatch/u,
  );
});

test('rejects a fence that would relabel stale evidence as current-dispatch state', () => {
  const stale = captureOff('production', OTHER_DISPATCH);
  assert.throws(
    () =>
      verifyRolloutFencedState({
        expectedState: stale,
        ...livePair(),
        dispatch: DISPATCH,
      }),
    /fenced state was not captured in this workflow dispatch/u,
  );
});

test('fences only live states, never uploaded or revalidated evidence', () => {
  const uploaded = uploadCandidate();
  const promoted = promoteCandidate({ candidate: uploaded });
  const fenced = verifyRolloutFencedState({
    expectedState: promoted,
    ...promotedInputs(),
    dispatch: DISPATCH,
  });
  const revalidated = verifyRolloutRevalidatedOffAnchor({
    priorAnchorState: captureOff(),
    currentState: fenced,
    offApiVersion: apiVersion(),
    dispatch: DISPATCH,
  });
  for (const state of [uploaded, revalidated]) {
    assert.throws(
      () =>
        verifyRolloutFencedState({
          expectedState: state,
          ...promotedInputs(),
          dispatch: DISPATCH,
        }),
      new RegExp(`rollout ${state.phase} state is not a live fence source`, 'u'),
    );
  }
});

test('rejects a cross-dispatch prior OFF anchor during revalidation', () => {
  const prior = captureOff('production', OTHER_DISPATCH);
  const promoted = promoteCandidate();
  const current = verifyRolloutFencedState({
    expectedState: promoted,
    ...promotedInputs(),
    dispatch: DISPATCH,
  });
  assert.throws(
    () =>
      verifyRolloutRevalidatedOffAnchor({
        priorAnchorState: prior,
        currentState: current,
        offApiVersion: apiVersion(),
        dispatch: DISPATCH,
      }),
    /rollback anchor.*this dispatch|rollback anchor.*dispatch/u,
  );
});

test('requires captured anchor evidence and a just-fenced current state for revalidation', () => {
  const promoted = promoteCandidate();
  const fenced = verifyRolloutFencedState({
    expectedState: promoted,
    ...promotedInputs(),
    dispatch: DISPATCH,
  });

  const inspectedAnchor = captureOff();
  inspectedAnchor.phase = 'inspected';
  assert.throws(
    () =>
      verifyRolloutRevalidatedOffAnchor({
        priorAnchorState: inspectedAnchor,
        currentState: fenced,
        offApiVersion: apiVersion(),
        dispatch: DISPATCH,
      }),
    /rollback anchor is not a captured admission-OFF state/u,
  );

  assert.throws(
    () =>
      verifyRolloutRevalidatedOffAnchor({
        priorAnchorState: captureOff(),
        currentState: promoted,
        offApiVersion: apiVersion(),
        dispatch: DISPATCH,
      }),
    /current rollout state is not the just-fenced live state/u,
  );
});

test('requires exact candidate-to-anchor API and Compute lineage during revalidation', () => {
  const prior = captureOff();
  const promoted = promoteCandidate();
  const current = verifyRolloutFencedState({
    expectedState: promoted,
    ...promotedInputs(),
    dispatch: DISPATCH,
  });
  const cases = [
    [
      'source API identity',
      (state) => state.source_api_version_id = IDS.otherApi,
      /does not descend from the rollback anchor/u,
    ],
    [
      'API code ETag',
      (state) => state.api.code_etag = 'drifted-api-etag',
      /incompatible with the current API\/Compute pair/u,
    ],
    [
      'API compatibility',
      (state) => state.api.compatibility_sha256 = 'f'.repeat(64),
      /incompatible with the current API\/Compute pair/u,
    ],
    [
      'Compute deployment',
      (state) => state.compute.deployment_id = IDS.otherDeployment,
      /incompatible with the current API\/Compute pair/u,
    ],
    [
      'enabled policy',
      (state) => {
        state.policy = 'off';
        state.canary_allowlist = [];
      },
      /current fenced rollout is not admission-enabled/u,
    ],
  ];
  for (const [label, mutate, pattern] of cases) {
    const drifted = clone(current);
    mutate(drifted);
    assert.throws(
      () =>
        verifyRolloutRevalidatedOffAnchor({
          priorAnchorState: prior,
          currentState: drifted,
          offApiVersion: apiVersion(),
          dispatch: DISPATCH,
        }),
      pattern,
      label,
    );
  }
});

test('accepts only a same-dispatch uploaded OFF version as a direct rollback anchor', () => {
  const baseline = inspectPolicy({ policy: 'canary' });
  const uploadedOff = uploadCandidate({
    baseline,
    policy: 'off',
    canaryAllowlist: '',
    uploadedVersion: apiVersion({
      id: IDS.candidateApi,
      tag: CANDIDATE_TAG,
      policy: 'off',
    }),
  });
  const revertedPair = livePair({
    policy: 'off',
    apiId: IDS.candidateApi,
    apiTag: CANDIDATE_TAG,
    apiDeploymentId: IDS.revertedApiDeployment,
  });
  const reverted = verifyRolloutRevertedPair({
    target: 'production',
    anchorState: uploadedOff,
    expectedApiDeploymentId: IDS.revertedApiDeployment,
    ...revertedPair,
    dispatch: DISPATCH,
  });
  assert.equal(reverted.phase, 'reverted');
  assert.equal(reverted.api.version_id, IDS.candidateApi);
  assert.equal(reverted.policy, 'off');

  const staleUploadedOff = clone(uploadedOff);
  staleUploadedOff.dispatch = clone(OTHER_DISPATCH);
  assert.throws(
    () =>
      verifyRolloutRevertedPair({
        target: 'production',
        anchorState: staleUploadedOff,
        expectedApiDeploymentId: IDS.revertedApiDeployment,
        ...revertedPair,
        dispatch: DISPATCH,
      }),
    /rollback anchor was not verified as OFF in this dispatch/u,
  );
});

test('rejects candidate API identity equal to its rollback anchor', () => {
  const baseline = captureOff();
  assert.throws(
    () =>
      uploadCandidate({
        baseline,
        uploadedVersion: apiVersion({
          id: IDS.offApi,
          tag: CANDIDATE_TAG,
          policy: 'canary',
        }),
        expectedVersionId: IDS.offApi,
      }),
    /uploaded API version must be distinct from its baseline/u,
  );
});

test('enforces phase-specific API deployment and source-version semantics', () => {
  const captured = captureOff();
  const inspected = inspectPolicy({ policy: 'canary' });
  const uploaded = uploadCandidate();
  const promoted = promoteCandidate({ candidate: uploaded });
  const fenced = verifyRolloutFencedState({
    expectedState: promoted,
    ...promotedInputs(),
    dispatch: DISPATCH,
  });
  const revalidated = verifyRolloutRevalidatedOffAnchor({
    priorAnchorState: captured,
    currentState: fenced,
    offApiVersion: apiVersion(),
    dispatch: DISPATCH,
  });
  const cases = [
    [
      'uploaded deployment',
      uploaded,
      (state) => state.api.deployment_id = IDS.otherDeployment,
      /rollout uploaded API deployment state is invalid/u,
    ],
    [
      'revalidated deployment',
      revalidated,
      (state) => state.api.deployment_id = IDS.otherDeployment,
      /rollout revalidated API deployment state is invalid/u,
    ],
    [
      'captured source',
      captured,
      (state) => state.source_api_version_id = IDS.otherApi,
      /rollout captured source API version id must be empty/u,
    ],
    [
      'inspected source',
      inspected,
      (state) => state.source_api_version_id = IDS.otherApi,
      /rollout inspected source API version id must be empty/u,
    ],
    [
      'uploaded source omission',
      uploaded,
      (state) => state.source_api_version_id = null,
      /rollout uploaded source API version id is required/u,
    ],
    [
      'promoted source omission',
      promoted,
      (state) => state.source_api_version_id = null,
      /rollout promoted source API version id is required/u,
    ],
    [
      'revalidated source omission',
      revalidated,
      (state) => state.source_api_version_id = null,
      /rollout revalidated source API version id is required/u,
    ],
    [
      'candidate equal to source',
      uploaded,
      (state) => state.source_api_version_id = state.api.version_id,
      /source and candidate API version ids must be distinct/u,
    ],
  ];
  for (const [label, original, mutate, pattern] of cases) {
    const state = clone(original);
    mutate(state);
    assert.throws(() => validateRolloutState(state), pattern, label);
  }

  const undeployedCapture = clone(captured);
  undeployedCapture.api.deployment_id = null;
  assert.throws(
    () => validateRolloutState(undeployedCapture),
    /rollout API state deployment id is missing/u,
  );
});

test('enforces the exact rollout, worker, and dispatch evidence schemas', () => {
  const valid = captureOff();
  assertExactState(valid);

  for (
    const [label, mutate] of [
      [
        'top-level extra',
        (state) => {
          state.unreviewed = true;
        },
      ],
      [
        'top-level omission',
        (state) => {
          delete state.source_api_version_id;
        },
      ],
      [
        'API extra',
        (state) => {
          state.api.unreviewed = true;
        },
      ],
      [
        'Compute omission',
        (state) => {
          delete state.compute.version_tag;
        },
      ],
      [
        'dispatch extra',
        (state) => {
          state.dispatch.actor = 'automation';
        },
      ],
    ]
  ) {
    const state = clone(valid);
    mutate(state);
    assert.throws(
      () => validateRolloutState(state),
      /unexpected shape/u,
      label,
    );
  }

  for (
    const [label, mutate] of [
      ['wrong schema', (state) => state.schema_version = 2],
      ['wrong kind', (state) => state.kind = 'other'],
      ['not verified', (state) => state.verified = false],
      ['wrong phase', (state) => state.phase = 'pending'],
      ['removed soak phase', (state) => state.phase = 'soak'],
      ['wrong policy', (state) => state.policy = 'enabled'],
    ]
  ) {
    const state = clone(valid);
    mutate(state);
    assert.throws(
      () => validateRolloutState(state),
      /metadata is invalid/u,
      label,
    );
  }
});
