import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearInterfaceReadCache,
  resetInterfaceReadCacheForTests,
  runInterfaceCallWithCache,
} from './interface-read-cache';

afterEach(resetInterfaceReadCacheForTests);

const LIVE_READ_SCOPE = {
  artifactHash: 'a'.repeat(64),
  interfaceId: 'inbox',
  readModel: {
    functionName: 'inbox_snapshot',
    freshForMs: 20_000,
    staleForMs: 5 * 60_000,
  },
  releaseVersion: '1.2.3',
};

describe('Interface read cache', () => {
  it('deduplicates a cold read and reuses its fresh result', async () => {
    const execute = vi.fn(async () => ({ success: true, result: { total: 4 } }));
    const options = {
      agentId: 'agent-a',
      args: { limit: 50, status: 'active' },
      execute,
      functionName: 'inbox_snapshot',
      now: () => 1_000,
      ownerScope: 'owner-a',
      ...LIVE_READ_SCOPE,
    };

    const [first, second] = await Promise.all([
      runInterfaceCallWithCache(options),
      runInterfaceCallWithCache({ ...options, args: { status: 'active', limit: 50 } }),
    ]);
    const third = await runInterfaceCallWithCache(options);

    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('returns stale data immediately and refreshes it in the background', async () => {
    let now = 1_000;
    const execute = vi.fn()
      .mockResolvedValueOnce({ success: true, result: { total: 4 } })
      .mockResolvedValueOnce({ success: true, result: { total: 6 } });
    const options = {
      agentId: 'agent-b',
      args: { status: 'active' },
      execute,
      functionName: 'inbox_snapshot',
      now: () => now,
      ownerScope: 'owner-a',
      ...LIVE_READ_SCOPE,
    };
    await runInterfaceCallWithCache(options);
    now += 21_000;

    expect(await runInterfaceCallWithCache(options)).toEqual({
      success: true,
      result: { total: 4 },
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(await runInterfaceCallWithCache(options)).toEqual({
      success: true,
      result: { total: 6 },
    });
  });

  it('invalidates cached reads when a write runs', async () => {
    const read = vi.fn(async () => ({ success: true, result: { total: 4 } }));
    const readOptions = {
      agentId: 'agent-c',
      args: {},
      execute: read,
      functionName: 'inbox_overview',
      now: () => 1_000,
      ownerScope: 'owner-a',
      ...LIVE_READ_SCOPE,
      readModel: {
        ...LIVE_READ_SCOPE.readModel,
        functionName: 'inbox_overview',
      },
    };
    await runInterfaceCallWithCache(readOptions);
    await runInterfaceCallWithCache({
      agentId: 'agent-c',
      args: { action: 'send' },
      execute: async () => ({ success: true, result: { sent: true } }),
      functionName: 'conversation_act',
      ownerScope: 'owner-a',
      artifactHash: LIVE_READ_SCOPE.artifactHash,
      interfaceId: LIVE_READ_SCOPE.interfaceId,
      readModel: null,
      releaseVersion: LIVE_READ_SCOPE.releaseVersion,
    });
    await runInterfaceCallWithCache(readOptions);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never reuses a read model across authenticated owners', async () => {
    const firstOwnerRead = vi.fn(async () => ({
      success: true,
      result: { subject: 'owner-a-only' },
    }));
    const secondOwnerRead = vi.fn(async () => ({
      success: true,
      result: { subject: 'owner-b-only' },
    }));
    const shared = {
      agentId: 'transferred-agent',
      args: {},
      functionName: 'inbox_snapshot',
      now: () => 1_000,
      ...LIVE_READ_SCOPE,
    };

    expect(
      await runInterfaceCallWithCache({
        ...shared,
        execute: firstOwnerRead,
        ownerScope: 'owner-a',
      }),
    ).toEqual({ success: true, result: { subject: 'owner-a-only' } });
    expect(
      await runInterfaceCallWithCache({
        ...shared,
        execute: secondOwnerRead,
        ownerScope: 'owner-b',
      }),
    ).toEqual({ success: true, result: { subject: 'owner-b-only' } });

    expect(firstOwnerRead).toHaveBeenCalledOnce();
    expect(secondOwnerRead).toHaveBeenCalledOnce();
  });

  it('purges private read models when the auth session changes', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ success: true, result: { total: 4 } })
      .mockResolvedValueOnce({ success: true, result: { total: 7 } });
    const options = {
      agentId: 'agent-session',
      args: {},
      execute,
      functionName: 'inbox_overview',
      now: () => 1_000,
      ownerScope: 'owner-a',
      ...LIVE_READ_SCOPE,
      readModel: {
        ...LIVE_READ_SCOPE.readModel,
        functionName: 'inbox_overview',
      },
    };

    await runInterfaceCallWithCache(options);
    clearInterfaceReadCache();
    expect(await runInterfaceCallWithCache(options)).toEqual({
      success: true,
      result: { total: 7 },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('cannot repopulate a new session from an older in-flight read', async () => {
    let resolveOld:
      | ((value: {
        result: { owner: string };
        success: true;
      }) => void)
      | undefined;
    const oldRead = new Promise<{
      result: { owner: string };
      success: true;
    }>((resolve) => {
      resolveOld = resolve;
    });
    const options = {
      agentId: 'agent-race',
      args: {},
      functionName: 'inbox_overview',
      now: () => 1_000,
      ownerScope: 'owner-a',
      ...LIVE_READ_SCOPE,
      readModel: {
        ...LIVE_READ_SCOPE.readModel,
        functionName: 'inbox_overview',
      },
    };
    const pendingOld = runInterfaceCallWithCache({
      ...options,
      execute: () => oldRead,
    });

    clearInterfaceReadCache();
    const newRead = vi.fn(async () => ({
      success: true as const,
      result: { owner: 'new-session' },
    }));
    expect(
      await runInterfaceCallWithCache({ ...options, execute: newRead }),
    ).toEqual({ success: true, result: { owner: 'new-session' } });

    resolveOld?.({ success: true, result: { owner: 'old-session' } });
    await pendingOld;
    expect(
      await runInterfaceCallWithCache({ ...options, execute: newRead }),
    ).toEqual({ success: true, result: { owner: 'new-session' } });
    expect(newRead).toHaveBeenCalledOnce();
  });

  it('bypasses private caching when no authenticated owner is available', async () => {
    const execute = vi.fn(async () => ({
      success: true,
      result: { total: 4 },
    }));
    const options = {
      agentId: 'agent-signed-out',
      args: {},
      execute,
      functionName: 'inbox_overview',
      ownerScope: null,
      ...LIVE_READ_SCOPE,
      readModel: {
        ...LIVE_READ_SCOPE.readModel,
        functionName: 'inbox_overview',
      },
    };

    await runInterfaceCallWithCache(options);
    await runInterfaceCallWithCache(options);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('never caches a mutating function merely because it is named inbox_snapshot', async () => {
    const execute = vi.fn(async () => ({
      success: true,
      result: { mutationCount: execute.mock.calls.length },
    }));
    const options = {
      agentId: 'agent-mutation',
      args: {},
      artifactHash: LIVE_READ_SCOPE.artifactHash,
      execute,
      functionName: 'inbox_snapshot',
      interfaceId: LIVE_READ_SCOPE.interfaceId,
      ownerScope: 'owner-a',
      readModel: null,
      releaseVersion: LIVE_READ_SCOPE.releaseVersion,
    };

    await runInterfaceCallWithCache(options);
    await runInterfaceCallWithCache(options);

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('scopes valid explicit read models by release, Interface, and artifact', async () => {
    const execute = vi.fn(async () => ({
      success: true,
      result: { call: execute.mock.calls.length },
    }));
    const options = {
      agentId: 'agent-release',
      args: {},
      execute,
      functionName: 'inbox_snapshot',
      now: () => 1_000,
      ownerScope: 'owner-a',
      ...LIVE_READ_SCOPE,
    };

    await runInterfaceCallWithCache(options);
    await runInterfaceCallWithCache(options);
    await runInterfaceCallWithCache({
      ...options,
      releaseVersion: '1.2.4',
    });
    await runInterfaceCallWithCache({
      ...options,
      interfaceId: 'report',
    });
    await runInterfaceCallWithCache({
      ...options,
      artifactHash: 'b'.repeat(64),
    });

    expect(execute).toHaveBeenCalledTimes(4);
  });
});
