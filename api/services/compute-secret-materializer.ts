import type { App } from "../../shared/types/index.ts";
import { createAppsService } from "./apps.ts";
import { resolveAppEnvVars } from "./app-runtime-resources.ts";
import type { PreparedComputeSecretDescriptor } from "./compute/runs.ts";
import type { ComputeRun } from "./compute/types.ts";

type ComputeSecretApp = Pick<App, "id" | "owner_id" | "env_vars">;

export interface ComputeSecretMaterializerDeps {
  findAgent?: (agentId: string) => Promise<ComputeSecretApp | null>;
  resolveAgentVariables?: (
    app: Pick<ComputeSecretApp, "env_vars">,
  ) => Promise<Record<string, string>>;
}

export interface MaterializedComputeSecret {
  bindingId: string;
  bindingVersion: string;
  value: string;
}

/**
 * Resolve only the immutable secret descriptors already snapshotted for a run.
 *
 * This executes in the API Worker, never in the Compute Worker or body. The
 * returned values are intended solely for the private prepare-lease response;
 * callers must not persist, log, or include them in receipts. In particular,
 * the function never returns the Agent's complete Variables map.
 */
export async function materializeComputeRunSecrets(
  input: {
    run: ComputeRun;
    descriptors: readonly PreparedComputeSecretDescriptor[];
  },
  deps: ComputeSecretMaterializerDeps = {},
): Promise<MaterializedComputeSecret[]> {
  if (input.descriptors.length === 0) return [];

  const findAgent = deps.findAgent ?? ((agentId: string) =>
    createAppsService().findById(agentId));
  const resolveAgentVariables = deps.resolveAgentVariables ?? ((app) =>
    resolveAppEnvVars(app));

  const app = await findAgent(input.run.agentId);
  if (
    !app || app.id !== input.run.agentId ||
    app.owner_id !== input.run.userId
  ) {
    throw new Error("Compute Agent Variables are unavailable for this run.");
  }

  const variables = await resolveAgentVariables(app);
  const descriptorIds = new Set<string>();
  const variableNames = new Set<string>();
  const materialized: MaterializedComputeSecret[] = [];

  for (const descriptor of input.descriptors) {
    if (
      descriptorIds.has(descriptor.bindingId) ||
      variableNames.has(descriptor.variableName)
    ) {
      throw new Error("Compute secret snapshot contains duplicate bindings.");
    }
    descriptorIds.add(descriptor.bindingId);
    variableNames.add(descriptor.variableName);

    const value = variables[descriptor.variableName];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("A declared Compute Agent Variable is unavailable.");
    }
    materialized.push({
      bindingId: descriptor.bindingId,
      bindingVersion: descriptor.bindingVersion,
      value,
    });
  }

  return materialized;
}
