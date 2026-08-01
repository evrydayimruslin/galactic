import type { AppManifest } from "../../shared/contracts/manifest.ts";
import type {
  LaunchInferenceOperation,
  LaunchReleaseInferenceRequirements,
} from "../../shared/contracts/launch.ts";
import {
  ACTIVE_BYOK_PROVIDER_IDS,
  type ActiveBYOKProvider,
  BYOK_PROVIDERS,
} from "../../shared/types/index.ts";

const OPERATION_ORDER: Record<LaunchInferenceOperation, number> = {
  generate: 0,
  embed: 1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedOperations(
  operations: Iterable<LaunchInferenceOperation>,
): LaunchInferenceOperation[] {
  return [...new Set(operations)].sort((left, right) =>
    OPERATION_ORDER[left] - OPERATION_ORDER[right]
  );
}

function exactFunctionOperations(value: unknown): LaunchInferenceOperation[] {
  if (!isRecord(value)) return [];
  const authority = isRecord(value.authority) ? value.authority : null;
  const effects = authority && isRecord(authority.effects)
    ? authority.effects
    : null;
  if (!effects) return [];

  const operations: LaunchInferenceOperation[] = [];
  if (Object.hasOwn(effects, "inference.generate")) operations.push("generate");
  if (Object.hasOwn(effects, "inference.embed")) operations.push("embed");
  return operations;
}

/**
 * Builds the account setup requirements from the exact compiled release.
 * galactic.yaml authority effects win; legacy manifests retain a conservative
 * permission/uses_inference fallback until every release is document-backed.
 */
export function deriveReleaseInferenceRequirements(
  manifest: AppManifest | null | undefined,
): LaunchReleaseInferenceRequirements {
  if (!manifest) return { required: false, operations: [], functions: [] };

  const permissions = new Set(manifest.permissions ?? []);
  const functions = Object.entries(manifest.functions ?? {}).map(
    ([name, fn]) => {
      const exact = exactFunctionOperations(fn);
      if (exact.length > 0) return { name, operations: exact };

      const operations: LaunchInferenceOperation[] = [];
      if (fn.uses_inference) {
        if (permissions.has("ai:embed")) operations.push("embed");
        if (permissions.has("ai:call") || operations.length === 0) {
          operations.push("generate");
        }
      }
      return { name, operations: sortedOperations(operations) };
    },
  ).filter((fn) => fn.operations.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));

  // A legacy manifest may declare inference at app level without annotating a
  // function. Keep that requirement visible instead of silently treating it
  // as credential-free.
  if (functions.length === 0) {
    const operations: LaunchInferenceOperation[] = [];
    if (permissions.has("ai:call")) operations.push("generate");
    if (permissions.has("ai:embed")) operations.push("embed");
    if (operations.length > 0) {
      functions.push({
        name: "release",
        operations: sortedOperations(operations),
      });
    }
  }

  const operations = sortedOperations(
    functions.flatMap((fn) => fn.operations),
  );
  return { required: operations.length > 0, operations, functions };
}

export function providerSupportsInferenceOperations(
  provider: ActiveBYOKProvider,
  operations: readonly LaunchInferenceOperation[],
): boolean {
  const capabilities = BYOK_PROVIDERS[provider].capabilities;
  return operations.every((operation) =>
    operation === "generate" ? capabilities.chat : capabilities.embeddings
  );
}

export function compatibleInferenceProviders(
  operations: readonly LaunchInferenceOperation[],
): ActiveBYOKProvider[] {
  return ACTIVE_BYOK_PROVIDER_IDS.filter((provider) =>
    providerSupportsInferenceOperations(provider, operations)
  );
}
