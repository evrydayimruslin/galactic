import type {
  ComputeResult as PublicComputeResult,
  ComputeRun as PublicComputeRun,
} from "../../shared/contracts/compute.ts";
import type { App } from "../../shared/types/index.ts";
import type { Env } from "../lib/env.ts";
import { getEnv } from "../lib/env.ts";
import type {
  ComputeAdmissionInput,
  ComputeControlPlaneAdapter,
  ComputeRunLookupInput,
} from "../src/bindings/compute-control-plane-adapter.ts";
import { PublicComputeControlPlaneError } from "../src/bindings/compute-control-plane-adapter.ts";
import { createAppsService } from "./apps.ts";
import { requireComputeAdmissionConfig } from "./compute/config.ts";
import {
  ComputeManifestError,
  resolveLiveComputeManifestAuthority,
} from "./compute/manifest.ts";
import {
  getComputeAgentPolicy,
  listComputeAgentPolicyRules,
} from "./compute/policies.ts";
import {
  admitComputeRun,
  getComputeRunView,
  requestComputeRunCancellation,
  terminalizeComputeRunCancellation,
  type AdmittedComputeRun,
  type ComputeRunView,
} from "./compute/runs.ts";
import { listComputeSecretBindings } from "./compute/secrets.ts";
import type {
  ComputeAgentPolicy,
  ComputeAgentPolicyRule,
  ComputeSecretBinding,
} from "./compute/types.ts";
import { ComputeControlPlaneError } from "./compute/database.ts";
import {
  computeDirectiveHash,
  computeRunExpiresAt,
  computeSyncRunExpiresAt,
  ComputePublicRequestError,
  isComputeRunTerminal,
  normalizePublicComputeRequest,
  projectPublicComputeResult,
  projectPublicComputeRun,
  selectComputeRunAuthorities,
} from "./compute-public.ts";

const COMPUTE_DISPATCH_VERSION = 1 as const;

type ComputeApp = Pick<
  App,
  "id" | "owner_id" | "current_version" | "manifest"
>;

export interface ComputeOrchestratorDeps {
  env?: Partial<Env>;
  now?: () => Date;
  findAgent?: (agentId: string) => Promise<ComputeApp | null>;
  getPolicy?: (input: {
    userId: string;
    agentId: string;
  }) => Promise<ComputeAgentPolicy | null>;
  listPolicyRules?: (input: {
    userId: string;
    agentId: string;
    callerFunction: string;
  }) => Promise<ComputeAgentPolicyRule[]>;
  listSecretBindings?: (input: {
    userId: string;
    agentId: string;
    callerFunction: string;
  }) => Promise<ComputeSecretBinding[]>;
  admitRun?: (input: Parameters<typeof admitComputeRun>[0]) => Promise<AdmittedComputeRun>;
  getRunView?: (
    input: Parameters<typeof getComputeRunView>[0],
  ) => Promise<ComputeRunView | null>;
  cancelRunAfterDestroy?: (input: ComputeRunLookupInput) => Promise<ComputeRunView>;
  enqueue?: (
    message: { version: 1; run_id: string },
    options?: { delaySeconds?: number },
  ) => Promise<void>;
  execute?: (message: { version: 1; run_id: string }) => Promise<unknown>;
}

function publicError(code: string, message: string): PublicComputeControlPlaneError {
  return new PublicComputeControlPlaneError(code, message);
}

function expectedPublicError(error: unknown): PublicComputeControlPlaneError | null {
  if (error instanceof PublicComputeControlPlaneError) return error;
  if (error instanceof ComputePublicRequestError || error instanceof ComputeManifestError) {
    return publicError(error.code, error.message);
  }
  if (error instanceof ComputeControlPlaneError) {
    const safe = new Set([
      "COMPUTE_POLICY_NOT_ENABLED",
      "COMPUTE_POLICY_LIMIT_EXCEEDED",
      "COMPUTE_SECRET_BINDING_NOT_USABLE",
      "COMPUTE_INPUT_ARTIFACT_NOT_READY",
      "COMPUTE_INPUT_ARTIFACT_EXPIRED",
      "COMPUTE_ARTIFACT_LIMIT_EXCEEDED",
      "COMPUTE_ARTIFACT_STORAGE_QUOTA_EXCEEDED",
      "COMPUTE_AUTHORITY_DENIED",
      "COMPUTE_IDEMPOTENCY_CONFLICT",
      "COMPUTE_EXECUTION_CALL_LIMIT",
      "COMPUTE_ADMISSION_BACKLOG_LIMIT",
      "COMPUTE_ADMISSION_RATE_LIMIT",
      "COMPUTE_INSUFFICIENT_BUDGET",
      "COMPUTE_CONCURRENCY_LIMIT",
      "COMPUTE_RUN_NOT_FOUND",
      "COMPUTE_RUN_CONFLICT",
    ]);
    if (safe.has(error.code)) {
      return publicError(error.code, error.message);
    }
  }
  return null;
}

function activePolicy(policy: ComputeAgentPolicy | null): ComputeAgentPolicy {
  if (
    !policy || !policy.enabled || policy.state !== "active" ||
    !policy.ownerConfirmedAt
  ) {
    throw publicError(
      "COMPUTE_POLICY_NOT_ENABLED",
      "The Agent owner has not enabled Galactic Compute for this Agent.",
    );
  }
  return policy;
}

function defaultDeps(input: ComputeOrchestratorDeps): Required<
  Pick<
    ComputeOrchestratorDeps,
    | "now"
    | "findAgent"
    | "getPolicy"
    | "listPolicyRules"
    | "listSecretBindings"
    | "admitRun"
    | "getRunView"
    | "enqueue"
    | "execute"
  >
> & Pick<ComputeOrchestratorDeps, "cancelRunAfterDestroy"> & { env: Partial<Env> } {
  const env = input.env ?? getEnv();
  return {
    env,
    now: input.now ?? (() => new Date()),
    findAgent: input.findAgent ?? ((agentId) => createAppsService().findById(agentId)),
    getPolicy: input.getPolicy ?? ((value) => getComputeAgentPolicy(value)),
    listPolicyRules: input.listPolicyRules ?? ((value) =>
      listComputeAgentPolicyRules(value)),
    listSecretBindings: input.listSecretBindings ?? ((value) =>
      listComputeSecretBindings(value)),
    admitRun: input.admitRun ?? ((value) => admitComputeRun(value)),
    getRunView: input.getRunView ?? ((value) => getComputeRunView(value)),
    cancelRunAfterDestroy: input.cancelRunAfterDestroy,
    enqueue: input.enqueue ?? (async (message, options) => {
      if (!env.COMPUTE_QUEUE) throw new Error("Compute queue is unavailable");
      await env.COMPUTE_QUEUE.send(message, options);
    }),
    execute: input.execute ?? (async (message) => {
      if (!env.COMPUTE_PLANE) throw new Error("Compute plane is unavailable");
      return await env.COMPUTE_PLANE.executeRun(message);
    }),
  };
}

async function exactView(
  deps: ReturnType<typeof defaultDeps>,
  input: ComputeRunLookupInput,
): Promise<ComputeRunView> {
  const view = await deps.getRunView(input);
  if (!view) {
    throw publicError("COMPUTE_RUN_NOT_FOUND", "Compute run not found.");
  }
  return view;
}

async function safelyCancelAfterBodyDestroy(
  deps: ReturnType<typeof defaultDeps>,
  input: ComputeRunLookupInput,
): Promise<ComputeRunView> {
  if (deps.cancelRunAfterDestroy) return await deps.cancelRunAfterDestroy(input);

  let view = await exactView(deps, input);
  if (isComputeRunTerminal(view.run)) return view;
  const fenced = await requestComputeRunCancellation({
    ...input,
    reason: "owner_or_agent_cancelled",
  });
  if (isComputeRunTerminal(fenced.run)) return await exactView(deps, input);

  const bodyMayExist = fenced.run.state === "provisioning" ||
    fenced.run.state === "running";
  if (bodyMayExist) {
    if (!deps.env.COMPUTE_PLANE) {
      throw publicError("COMPUTE_UNAVAILABLE", "Galactic Compute is unavailable.");
    }
    // The stop fence is visible to claim/prepare/heartbeat before this call.
    // Settlement is impossible until deterministic destruction succeeds.
    await deps.env.COMPUTE_PLANE.cancelRun({
      version: COMPUTE_DISPATCH_VERSION,
      run_id: fenced.run.id,
    });
  }
  await terminalizeComputeRunCancellation({
    ...input,
    expectedStateVersion: fenced.run.stateVersion,
    bodyDestroyed: bodyMayExist,
  });
  return await exactView(deps, input);
}

export function createComputeControlPlaneAdapter(
  input: ComputeOrchestratorDeps = {},
): ComputeControlPlaneAdapter {
  const deps = defaultDeps(input);

  return {
    async admitComputeRun(admission: ComputeAdmissionInput): Promise<PublicComputeResult> {
      try {
        const config = requireComputeAdmissionConfig(deps.env);
        const runtime = await deps.env.COMPUTE_PLANE!.runtimeIdentity();
        if (
          runtime?.profile !== "developer-v1" ||
          runtime.environmentDigest !== config.environmentDigest
        ) {
          throw publicError(
            "COMPUTE_RUNTIME_IDENTITY_MISMATCH",
            "The deployed Compute plane does not match the configured immutable environment.",
          );
        }
        if (
          config.rolloutMode === "canary" &&
          !config.canaryAllowlist.includes(
            `${admission.userId}/${admission.agentId}`,
          )
        ) {
          throw publicError(
            "COMPUTE_ROLLOUT_DENIED",
            "Galactic Compute is not enabled for this Agent in the current rollout.",
          );
        }
        const app = await deps.findAgent(admission.agentId);
        if (!app) {
          throw publicError("COMPUTE_AGENT_NOT_FOUND", "Agent not found.");
        }
        const manifest = resolveLiveComputeManifestAuthority({
          app,
          ownerUserId: admission.userId,
          callerFunction: admission.callerFunction,
        });
        const scope = {
          userId: admission.userId,
          agentId: admission.agentId,
          callerFunction: admission.callerFunction,
        };
        const [policyValue, rules, bindings] = await Promise.all([
          deps.getPolicy(scope),
          deps.listPolicyRules(scope),
          deps.listSecretBindings(scope),
        ]);
        const policy = activePolicy(policyValue);
        const normalized = normalizePublicComputeRequest({
          request: admission.request,
          manifest: manifest.config,
          manifestRevision: manifest.revision,
          policy,
          callerFunction: admission.callerFunction,
          secretBindings: bindings,
          now: deps.now(),
        });
        const now = deps.now();
        const admitted = await deps.admitRun({
          idempotencyKey: admission.idempotencyKey,
          userId: admission.userId,
          agentId: admission.agentId,
          callerFunction: admission.callerFunction,
          executionId: admission.executionId,
          directiveHash: await computeDirectiveHash({
            callerFunction: admission.callerFunction,
            request: normalized.executionRequest,
          }),
          environmentDigest: config.environmentDigest,
          billingMode: admission.billingMode,
          capacityAgentId: admission.capacityAgentId,
          request: normalized.executionRequest,
          manifestCeiling: normalized.manifestCeiling,
          expiresAt: normalized.mode === "sync"
            ? computeSyncRunExpiresAt({
              now,
              timeoutMs: normalized.executionRequest.timeoutMs,
              executionDeadlineAtMs: admission.executionDeadlineAtMs,
            })
            : computeRunExpiresAt(
              now,
              normalized.executionRequest.timeoutMs,
            ),
          authorities: selectComputeRunAuthorities(
            rules,
            admission.callerFunction,
          ),
        });

        const ownerScope = {
          ...scope,
          executionId: admission.executionId,
          runId: admitted.run.id,
        };
        if (isComputeRunTerminal(admitted.run)) {
          const terminal = await exactView(deps, ownerScope);
          return projectPublicComputeResult({
            ...terminal,
            requestedMode: normalized.mode,
            now: deps.now(),
          });
        }

        const message = {
          version: COMPUTE_DISPATCH_VERSION,
          run_id: admitted.run.id,
        } as const;
        let dispatchError: unknown = null;
        let durablyQueued = false;
        try {
          // Queue every run, including sync. The direct RPC is the latency path;
          // the at-least-once queue closes the admitted-but-not-started window.
          await deps.enqueue(
            message,
            normalized.mode === "sync" ? { delaySeconds: 5 } : undefined,
          );
          durablyQueued = true;
        } catch (error) {
          dispatchError = error;
        }

        if (normalized.mode === "sync") {
          try {
            await deps.execute(message);
          } catch (error) {
            dispatchError ??= error;
          }
          const view = await exactView(deps, ownerScope);
          return projectPublicComputeResult({
            ...view,
            requestedMode: normalized.mode,
            now: deps.now(),
          });
        }
        const view = await exactView(deps, ownerScope);
        if (dispatchError !== null) {
          console.error(JSON.stringify({
            event: "compute.dispatch_deferred_to_recovery",
            run_id: admitted.run.id,
            durably_queued: durablyQueued,
          }));
        }
        // Admission is the point of no return. Once a reservation exists, the
        // minute recovery dispatcher owns eventual delivery. Always give the
        // caller its durable run handle instead of throwing while a hidden run
        // may execute later.
        return projectPublicComputeResult({
          ...view,
          requestedMode: normalized.mode,
          now: deps.now(),
        });
      } catch (error) {
        throw expectedPublicError(error) ?? error;
      }
    },

    async getComputeRunForAgent(lookup: ComputeRunLookupInput): Promise<PublicComputeRun> {
      try {
        return projectPublicComputeRun({
          ...await exactView(deps, lookup),
          now: deps.now(),
        });
      } catch (error) {
        throw expectedPublicError(error) ?? error;
      }
    },

    async cancelComputeRunForAgent(lookup: ComputeRunLookupInput): Promise<PublicComputeRun> {
      try {
        return projectPublicComputeRun({
          ...await safelyCancelAfterBodyDestroy(deps, lookup),
          now: deps.now(),
        });
      } catch (error) {
        throw expectedPublicError(error) ?? error;
      }
    },
  };
}
