import type {
  LaunchInterfaceReadModelSummary,
  LaunchInterfaceSummary,
} from '../../../../shared/contracts/launch';

export interface InterfacePrefetch {
  args: Record<string, unknown>;
  artifactHash: string;
  functionName: string;
  interfaceId: string;
  readModel: LaunchInterfaceReadModelSummary;
  releaseVersion: string;
}

/** Returns cache authority only for this exact live Interface/function pair. */
export function interfaceReadModel(
  iface: LaunchInterfaceSummary,
  functionName: string,
): LaunchInterfaceReadModelSummary | null {
  if (!iface.releaseVersion || !iface.artifactHash) return null;
  return iface.readModels?.find((model) =>
    model.functionName === functionName &&
    iface.functions.includes(functionName)
  ) ?? null;
}

/**
 * Lists only explicitly opted-in automatic reads. Function names and
 * readOnly-looking descriptions are intentionally ignored.
 */
export function interfacePrefetches(
  interfaces: readonly LaunchInterfaceSummary[],
): InterfacePrefetch[] {
  const prefetches: InterfacePrefetch[] = [];
  for (const iface of interfaces) {
    if (!iface.releaseVersion || !iface.artifactHash) continue;
    for (const readModel of iface.readModels ?? []) {
      if (
        readModel.prefetchArgs === undefined ||
        !iface.functions.includes(readModel.functionName)
      ) {
        continue;
      }
      prefetches.push({
        args: readModel.prefetchArgs,
        artifactHash: iface.artifactHash,
        functionName: readModel.functionName,
        interfaceId: iface.id,
        readModel,
        releaseVersion: iface.releaseVersion,
      });
    }
  }
  return prefetches;
}
