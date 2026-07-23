import { describe, expect, it } from 'vitest';

import type { LaunchInterfaceSummary } from '../../../../shared/contracts/launch';
import { interfacePrefetches, interfaceReadModel } from './interface-read-models';

function interfaceSummary(
  overrides: Partial<LaunchInterfaceSummary> = {},
): LaunchInterfaceSummary {
  return {
    id: 'inbox',
    label: 'Inbox',
    url: 'https://interfaces.connectgalactic.com/i/agent/hash',
    functions: ['inbox_snapshot'],
    artifactHash: 'a'.repeat(64),
    releaseVersion: '1.2.3',
    ...overrides,
  };
}

describe('Interface read-model authority', () => {
  it("does not infer cache or prefetch authority from inbox_snapshot's name", () => {
    const iface = interfaceSummary();

    expect(interfaceReadModel(iface, 'inbox_snapshot')).toBeNull();
    expect(interfacePrefetches([iface])).toEqual([]);
  });

  it('returns an explicit live read model and its exact prefetch arguments', () => {
    const readModel = {
      functionName: 'inbox_snapshot',
      freshForMs: 20_000,
      staleForMs: 300_000,
      prefetchArgs: { limit: 50, status: 'active' },
    };
    const iface = interfaceSummary({ readModels: [readModel] });

    expect(interfaceReadModel(iface, 'inbox_snapshot')).toEqual(readModel);
    expect(interfacePrefetches([iface])).toEqual([{
      args: { limit: 50, status: 'active' },
      artifactHash: 'a'.repeat(64),
      functionName: 'inbox_snapshot',
      interfaceId: 'inbox',
      readModel,
      releaseVersion: '1.2.3',
    }]);
  });

  it('fails closed when live release identity is absent', () => {
    const iface = interfaceSummary({
      releaseVersion: null,
      readModels: [{
        functionName: 'inbox_snapshot',
        freshForMs: 20_000,
        staleForMs: 300_000,
        prefetchArgs: {},
      }],
    });

    expect(interfaceReadModel(iface, 'inbox_snapshot')).toBeNull();
    expect(interfacePrefetches([iface])).toEqual([]);
  });
});
