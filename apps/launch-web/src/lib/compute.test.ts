import { describe, expect, it } from 'vitest';

import {
  computeRunDuration,
  type ComputeSettingsDraft,
  computeSettingsRequest,
  isComputeEndpointUnavailable,
  type LaunchComputeManifestCeiling,
  type LaunchComputeRunSummary,
  mergeComputeRunHistory,
  safeComputeLink,
} from './compute';

const ceiling: LaunchComputeManifestCeiling = {
  enabled: true,
  profile: 'developer-v1',
  tools: ['browser', 'shell'],
  secrets: ['GITHUB_TOKEN', 'NPM_TOKEN'],
};

const draft: ComputeSettingsDraft = {
  enabled: true,
  profile: 'developer-v1',
  allowedTools: ['shell', 'browser', 'browser'],
  secretBindings: [
    {
      name: 'NPM_TOKEN',
      delivery: { kind: 'file', path: '/run/galactic/secrets/npm-token' },
    },
    {
      name: 'GITHUB_TOKEN',
      delivery: { kind: 'env', envName: 'GH_TOKEN' },
    },
  ],
  authorityRules: [
    {
      callerFunction: 'research',
      decision: 'always',
      action: 'platform.call',
      target: { functionName: 'gx.upload' },
    },
  ],
  maxTimeoutMs: '480000',
  maxConcurrency: '2',
  maxArtifactBytes: '100000000',
  maxArtifacts: '20',
};

describe('computeSettingsRequest', () => {
  it('builds a revision-fenced, owner-confirmed narrowing request', () => {
    const result = computeSettingsRequest(draft, ceiling, '7');

    expect(result.errors).toEqual([]);
    expect(result.request).toEqual({
      expectedRevision: '7',
      ownerConfirmed: true,
      settings: {
        enabled: true,
        profile: 'developer-v1',
        allowedTools: ['browser', 'shell'],
        secretBindings: [
          {
            name: 'GITHUB_TOKEN',
            delivery: { kind: 'env', envName: 'GH_TOKEN' },
          },
          {
            name: 'NPM_TOKEN',
            delivery: { kind: 'file', path: '/run/galactic/secrets/npm-token' },
          },
        ],
        authorityRules: [
          {
            callerFunction: 'research',
            decision: 'always',
            action: 'platform.call',
            target: { functionName: 'gx.upload' },
          },
        ],
        limits: {
          maxTimeoutMs: 480000,
          maxConcurrency: 2,
          maxArtifactBytes: 100000000,
          maxArtifacts: 20,
        },
      },
    });
  });

  it('refuses tools and secret names outside the manifest ceiling', () => {
    const result = computeSettingsRequest(
      {
        ...draft,
        allowedTools: ['browser', 'agents.deploy'],
        secretBindings: [{
          name: 'UNDECLARED_KEY',
          delivery: { kind: 'env', envName: 'UNDECLARED_KEY' },
        }],
      },
      ceiling,
      '7',
    );

    expect(result.request).toBeNull();
    expect(result.errors.join(' ')).toContain('outside this Agent release');
    expect(result.errors.join(' ')).toContain('not declared');
  });

  it('allows protected secret files only directly under the fixed directory', () => {
    const result = computeSettingsRequest(
      {
        ...draft,
        secretBindings: [{
          name: 'NPM_TOKEN',
          delivery: { kind: 'file', path: '/run/galactic/secrets/../token' },
        }],
      },
      ceiling,
      '7',
    );

    expect(result.request).toBeNull();
    expect(result.errors).toContain(
      'File destination for “NPM_TOKEN” must be directly under /run/galactic/secrets/.',
    );
  });

  it('reserves control-plane environment and job-token destinations', () => {
    const result = computeSettingsRequest(
      {
        ...draft,
        secretBindings: [
          {
            name: 'GITHUB_TOKEN',
            delivery: { kind: 'env', envName: 'GALACTIC_JOB_TOKEN' },
          },
          {
            name: 'NPM_TOKEN',
            delivery: {
              kind: 'file',
              path: '/run/galactic/secrets/job-token-copy',
            },
          },
        ],
      },
      ceiling,
      '7',
    );

    expect(result.request).toBeNull();
    expect(result.errors.join(' ')).toContain('Environment destination');
    expect(result.errors.join(' ')).toContain('must be directly under');
  });

  it('requires positive whole-number limits and an authority revision', () => {
    const result = computeSettingsRequest(
      {
        ...draft,
        maxConcurrency: '1.5',
        maxArtifacts: '0',
      },
      ceiling,
      '',
    );

    expect(result.request).toBeNull();
    expect(result.errors).toContain('Compute settings revision is unavailable.');
    expect(result.errors).toContain('Maximum concurrency must be a positive whole number.');
    expect(result.errors).toContain('Maximum artifacts must be a positive whole number.');
  });

  it('rejects timeouts above the v1 Queue-backed execution ceiling', () => {
    const result = computeSettingsRequest(
      {
        ...draft,
        maxTimeoutMs: '480001',
      },
      ceiling,
      '7',
    );

    expect(result.request).toBeNull();
    expect(result.errors).toContain(
      'Maximum timeout cannot exceed 480000 ms in developer-v1.',
    );
  });

  it('rejects artifact budgets above the developer-v1 disk-safe ceiling', () => {
    const result = computeSettingsRequest(
      {
        ...draft,
        maxArtifactBytes: '1073741825',
      },
      ceiling,
      '7',
    );

    expect(result.request).toBeNull();
    expect(result.errors).toContain(
      'Maximum artifact bytes cannot exceed 1073741824 in developer-v1.',
    );
  });

  it('requires exact, unique platform and Agent authority targets', () => {
    const result = computeSettingsRequest(
      {
        ...draft,
        authorityRules: [
          {
            callerFunction: 'research',
            decision: 'always',
            action: 'platform.call',
            target: { functionName: 'gx.*' },
          },
          {
            callerFunction: 'research',
            decision: 'always',
            action: 'agents.call',
            target: { agentId: 'agent-slug', functionName: 'summarize*' },
          },
          {
            callerFunction: 'research',
            decision: 'never',
            action: 'platform.call',
            target: { functionName: 'gx.*' },
          },
        ],
      },
      ceiling,
      '7',
    );

    expect(result.request).toBeNull();
    expect(result.errors.join(' ')).toContain('one exact gx. or ul. prefixed function');
    expect(result.errors.join(' ')).toContain('exact Agent UUID');
    expect(result.errors.join(' ')).toContain('one exact function');
    expect(result.errors.join(' ')).toContain('listed more than once');
  });

  it('accepts an exact Agent and function pair for one caller', () => {
    const result = computeSettingsRequest(
      {
        ...draft,
        authorityRules: [{
          callerFunction: 'research',
          decision: 'always',
          action: 'agents.call',
          target: {
            agentId: '44444444-4444-4444-8444-444444444444',
            functionName: 'summarize',
          },
        }],
      },
      ceiling,
      '7',
    );

    expect(result.errors).toEqual([]);
    expect(result.request?.settings.authorityRules).toEqual([{
      callerFunction: 'research',
      decision: 'always',
      action: 'agents.call',
      target: {
        agentId: '44444444-4444-4444-8444-444444444444',
        functionName: 'summarize',
      },
    }]);
  });
});

describe('Compute UI fail-closed helpers', () => {
  it('recognizes only explicit unavailable endpoint responses', () => {
    expect(isComputeEndpointUnavailable({ status: 404 })).toBe(true);
    expect(isComputeEndpointUnavailable({ status: 501 })).toBe(true);
    expect(isComputeEndpointUnavailable({ code: 'compute_unavailable' })).toBe(true);
    expect(isComputeEndpointUnavailable({ status: 403 })).toBe(false);
    expect(isComputeEndpointUnavailable(new Error('network failed'))).toBe(false);
  });

  it('rejects non-HTTPS artifact and receipt links', () => {
    expect(safeComputeLink('/api/launch/compute/artifacts/a')).toBe(
      '/api/launch/compute/artifacts/a',
    );
    expect(safeComputeLink('https://artifacts.example/a')).toBe(
      'https://artifacts.example/a',
    );
    expect(safeComputeLink('javascript:alert(1)')).toBeNull();
    expect(safeComputeLink('http://artifacts.example/a')).toBeNull();
    expect(safeComputeLink('//artifacts.example/a')).toBeNull();
  });

  it('computes duration only from valid non-negative timestamps', () => {
    const run = {
      runId: 'run-1',
      receiptId: 'receipt-1',
      receiptUrl: null,
      billingMode: 'wallet',
      status: 'completed',
      agentId: 'agent-1',
      agentName: 'Researcher',
      functionName: 'research',
      createdAt: '2026-07-19T12:00:00.000Z',
      startedAt: '2026-07-19T12:00:01.000Z',
      finishedAt: '2026-07-19T12:00:04.500Z',
      usage: { reserved: 10, actual: 7, trueUp: -3, unit: 'work units' },
      exitCode: 0,
      infraFailure: null,
      artifacts: [],
      cancellable: false,
    } satisfies LaunchComputeRunSummary;

    expect(computeRunDuration(run)).toBe(3500);
    expect(computeRunDuration({ ...run, finishedAt: 'invalid' })).toBeNull();
    expect(computeRunDuration({
      ...run,
      finishedAt: '2026-07-19T11:59:00.000Z',
    })).toBeNull();
  });

  it('merges polling updates without dropping owner-loaded history', () => {
    const run = {
      runId: 'run-2',
      receiptId: 'receipt-2',
      receiptUrl: null,
      billingMode: 'wallet',
      status: 'running',
      agentId: 'agent-1',
      agentName: 'Researcher',
      functionName: 'research',
      createdAt: '2026-07-19T12:00:02.000Z',
      startedAt: '2026-07-19T12:00:03.000Z',
      finishedAt: null,
      usage: { reserved: 10, actual: null, trueUp: null, unit: 'work units' },
      exitCode: null,
      infraFailure: null,
      artifacts: [],
      cancellable: true,
    } satisfies LaunchComputeRunSummary;
    const older = {
      ...run,
      runId: 'run-1',
      receiptId: 'receipt-1',
      status: 'completed',
      createdAt: '2026-07-19T12:00:01.000Z',
      finishedAt: '2026-07-19T12:00:04.000Z',
      usage: { reserved: 10, actual: 8, trueUp: -2, unit: 'work units' },
      exitCode: 0,
      cancellable: false,
    } satisfies LaunchComputeRunSummary;
    const newest = {
      ...run,
      runId: 'run-3',
      receiptId: 'receipt-3',
      createdAt: '2026-07-19T12:00:03.000Z',
    } satisfies LaunchComputeRunSummary;
    const completed = {
      ...run,
      status: 'completed',
      finishedAt: '2026-07-19T12:00:05.000Z',
      usage: { reserved: 10, actual: 9, trueUp: -1, unit: 'work units' },
      exitCode: 0,
      cancellable: false,
    } satisfies LaunchComputeRunSummary;

    const result = mergeComputeRunHistory([run, older], [newest, completed]);

    expect(result.map((candidate) => candidate.runId)).toEqual([
      'run-3',
      'run-2',
      'run-1',
    ]);
    expect(result[1]).toEqual(completed);
  });
});
