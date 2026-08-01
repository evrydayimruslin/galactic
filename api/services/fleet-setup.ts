import type {
  LaunchAgentHomeResponse,
  LaunchFleetInferenceReadiness,
  LaunchFleetSetupResponse,
  LaunchReleaseInferenceRequirements,
} from "../../shared/contracts/launch.ts";
import type {
  ActiveBYOKProvider,
  BYOKConfig,
} from "../../shared/types/index.ts";
import { BYOK_VALIDATION_POLICY_VERSION } from "./byok-validation.ts";
import {
  compatibleInferenceProviders,
  providerSupportsInferenceOperations,
} from "./release-inference-requirements.ts";

interface FleetSetupAgentInput {
  id: string;
  slug: string;
  name: string;
  deploymentState: string | null;
  activeReleaseDigest: string | null;
  inference: LaunchReleaseInferenceRequirements;
  home: LaunchAgentHomeResponse | null;
  unavailableReason?: string | null;
}

interface FleetSetupByokInput {
  enabled: boolean;
  primaryProvider: ActiveBYOKProvider | null;
  configs: BYOKConfig[];
}

function inferenceReadiness(
  operations: LaunchReleaseInferenceRequirements["operations"],
  byok: FleetSetupByokInput,
): LaunchFleetInferenceReadiness {
  const compatible = compatibleInferenceProviders(operations);
  if (compatible.length === 0) return "unsupported";
  const provider = byok.primaryProvider;
  const config = provider
    ? byok.configs.find((candidate) =>
      candidate.provider === provider && candidate.has_key
    )
    : null;
  if (!byok.enabled || !provider || !config) return "missing";
  if (!providerSupportsInferenceOperations(provider, operations)) {
    return "needs_validation";
  }
  const validation = config.validation;
  if (
    !validation ||
    validation.policy_version !== BYOK_VALIDATION_POLICY_VERSION ||
    validation.provider !== provider ||
    !operations.every((operation) =>
      validation.operations.includes(operation)
    ) ||
    (operations.includes("generate") &&
      (config.model || "") !== (validation.model || ""))
  ) return "needs_validation";
  return "ready";
}

export function buildFleetSetupResponse(
  input: {
    agents: FleetSetupAgentInput[];
    byok: FleetSetupByokInput;
    generatedAt?: string;
  },
): LaunchFleetSetupResponse {
  const pending = input.agents.filter((agent) =>
    agent.deploymentState === "setup_required"
  );
  const operations = [
    ...new Set(pending.flatMap((agent) => agent.inference.operations)),
  ].sort((left, right) =>
    (left === "generate" ? 0 : 1) - (right === "generate" ? 0 : 1)
  );
  const compatibleProviderIds = compatibleInferenceProviders(operations);
  const inference = operations.length === 0 ? null : {
    id: "account:byok" as const,
    required: true as const,
    operations,
    functions: pending.flatMap((agent) =>
      agent.inference.functions.map((fn) => ({
        agentId: agent.id,
        agentSlug: agent.slug,
        agentName: agent.name,
        functionName: fn.name,
        operations: fn.operations,
      }))
    ),
    compatibleProviderIds,
    configuredProviderId: input.byok.primaryProvider,
    readiness: inferenceReadiness(operations, input.byok),
  };

  const agents = pending.map((agent) => ({
    agent: { id: agent.id, slug: agent.slug, name: agent.name },
    deploymentState: "setup_required" as const,
    activeReleaseDigest: agent.activeReleaseDigest,
    homeRevision: agent.home?.revision || null,
    requirements: agent.home?.setup.requirements || [],
    canActivate: Boolean(
      agent.activeReleaseDigest && agent.home?.setup.ready &&
        agent.home.actions.canActivate &&
        (!agent.inference.required || inference?.readiness === "ready"),
    ),
    syncing: !agent.home || !agent.activeReleaseDigest,
    unavailableReason: agent.home && agent.activeReleaseDigest
      ? null
      : agent.unavailableReason ||
        (agent.activeReleaseDigest
          ? "Setup status is still syncing"
          : "The deployed release is still being finalized"),
  }));

  return {
    agents,
    inference,
    pendingAgentCount: agents.length,
    readyToActivateCount: agents.filter((agent) => agent.canActivate).length,
    generatedAt: input.generatedAt || new Date().toISOString(),
  };
}
