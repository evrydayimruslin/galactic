import { requireComputeUuid } from "./authority.ts";
import {
  type ComputeDatabaseDeps,
  ComputeControlPlaneError,
} from "./database.ts";
import {
  claimComputeRun,
  completeComputeRun,
  failComputeRun,
  getComputeRunSecretDescriptors,
  heartbeatComputeRun,
  prepareComputeRunLease,
  type PreparedComputeSecretDescriptor,
} from "./runs.ts";
import { getComputeRunByIdInternal } from "./runs.ts";
import {
  getComputeArtifact,
  registerComputeArtifact,
  transitionComputeArtifact,
} from "./artifacts.ts";
import type { ComputeRun } from "./types.ts";
import { introspectComputeJobToken } from "./tokens.ts";

const INTERNAL_HOST = "galactic.internal";
const MAX_INTERNAL_BODY_BYTES = 4 * 1024 * 1024;

export interface ComputeInternalRouteDeps extends ComputeDatabaseDeps {
  /** Must validate a non-spoofable Worker service-binding request. */
  verifyServiceBindingRequest?: (request: Request) => boolean | Promise<boolean>;
  /** Resolve exact Agent Variable names inside the trusted host, never SQL/body code. */
  materializeSecretValues?: (input: {
    run: ComputeRun;
    descriptors: readonly PreparedComputeSecretDescriptor[];
  }) => Promise<Array<{
    bindingId: string;
    bindingVersion: string | number | bigint;
    value: string;
  }>>;
  /** Trusted ops hook; failures are swallowed after durable terminalization. */
  onWorkerFailure?: (event: {
    runId: string;
    userId: string;
    agentId: string;
    callerFunction: string;
    receiptId: string;
    outcome: "failed" | "cancelled";
    code: string;
  }) => void | Promise<void>;
  /** Best-effort alert hook after a valid terminal request cannot settle. */
  onSettlementPending?: (event: { runId: string }) => void | Promise<void>;
}

const MAX_SECRET_VALUE_BYTES = 1024 * 1024;
const MAX_TOTAL_SECRET_BYTES = 4 * 1024 * 1024;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function record(value: unknown, field = "request body"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_INTERNAL_BODY_BYTES) {
    throw new Error("request body is too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_INTERNAL_BODY_BYTES) {
    throw new Error("request body is too large");
  }
  return record(JSON.parse(text || "{}"));
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function integer(value: unknown, field: string): string | number {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${field} is required`);
  }
  return value;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) throw new Error("Bearer job token is required");
  return string(authorization.slice(7), "job token");
}

function trustedContainerId(request: Request): string {
  return string(request.headers.get("x-galactic-container-id"), "x-galactic-container-id");
}

function runPath(pathname: string): { runId: string; action: string } | null {
  const match = pathname.match(
    /^\/internal\/compute\/runs\/([0-9a-f-]{36})\/(claim|prepare-lease|heartbeat|reserve-output|commit-output|abandon-output|output-status|complete|fail|cancel-observed)$/i,
  );
  return match ? { runId: requireComputeUuid(match[1], "runId"), action: match[2] } : null;
}

async function exactWorkerRun(
  runId: string,
  leaseId: string,
  deps: ComputeInternalRouteDeps,
  requireWritable = true,
): Promise<ComputeRun> {
  const run = await getComputeRunByIdInternal(runId, deps);
  if (
    !run || run.leaseId !== leaseId || run.state !== "running" ||
    (requireWritable && run.stopRequestedAt !== null)
  ) {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_LEASE_MISMATCH",
      message: "The worker output request does not belong to an active lease.",
      status: 409,
    });
  }
  return run;
}

function workerArtifact(artifact: {
  id: string;
  state: string;
  stateVersion: string;
  storageKey: string;
  sha256: string | null;
  sizeBytes: string | null;
}): unknown {
  return {
    artifact_id: artifact.id,
    state: artifact.state,
    state_version: artifact.stateVersion,
    object_key: artifact.storageKey,
    sha256: artifact.sha256,
    size_bytes: artifact.sizeBytes === null ? null : Number(artifact.sizeBytes),
  };
}

function workerClaim(claim: Awaited<ReturnType<typeof claimComputeRun>>): unknown {
  if (!claim.claimed) return claim;
  const { run } = claim;
  return {
    claimed: true,
    recovered: claim.recovered,
    run: {
      run_id: run.id,
      receipt_id: run.receiptId,
      account_id: run.userId,
      agent_id: run.agentId,
      function_name: run.callerFunction,
      execution_id: run.executionId,
      profile: run.profile,
      environment_digest: run.environmentDigest,
      argv: run.request.argv,
      cwd: run.request.cwd,
      stdin: run.request.stdin.kind === "text" ? run.request.stdin.text : null,
      timeout_ms: run.request.timeoutMs,
      capture_paths: claim.capturePaths,
      max_artifacts: run.policyLimits.maxArtifacts,
      max_artifact_bytes: Number(run.policyLimits.maxArtifactBytes),
      input_artifacts: claim.inputArtifacts.map((artifact) => ({
        artifact_id: artifact.artifactId,
        object_key: artifact.storageKey,
        path: artifact.mountPath,
        sha256: artifact.sha256,
        size_bytes: Number(artifact.sizeBytes),
      })),
      toolpacks: [],
      started_at: run.startedAt,
      lease_expires_at: run.expiresAt,
    },
  };
}

async function materializeWorkerSecrets(
  deps: ComputeInternalRouteDeps,
  run: ComputeRun,
  descriptors: readonly PreparedComputeSecretDescriptor[],
): Promise<Array<{
  binding_id: string;
  version: number;
  destination: { kind: "env"; name: string } | { kind: "file"; path: string };
  value: string;
}>> {
  if (!deps.materializeSecretValues) {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_SECRET_MATERIALIZER_MISSING",
      message: "The trusted Compute secret materializer is unavailable.",
      status: 503,
    });
  }
  let materialized: Awaited<ReturnType<NonNullable<typeof deps.materializeSecretValues>>>;
  try {
    materialized = await deps.materializeSecretValues({ run, descriptors });
  } catch {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_SECRET_MATERIALIZATION_FAILED",
      message: "One or more declared Agent Variables could not be materialized.",
      status: 503,
    });
  }
  if (!Array.isArray(materialized) || materialized.length !== descriptors.length) {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_SECRET_MATERIALIZATION_FAILED",
      message: "The trusted secret materializer returned an incomplete binding set.",
      status: 503,
    });
  }
  const byId = new Map<string, (typeof materialized)[number]>();
  for (const value of materialized) {
    if (!value || typeof value !== "object" || typeof value.bindingId !== "string" ||
      byId.has(value.bindingId)) {
      throw new ComputeControlPlaneError({
        code: "COMPUTE_SECRET_MATERIALIZATION_FAILED",
        message: "The trusted secret materializer returned duplicate or invalid bindings.",
        status: 503,
      });
    }
    byId.set(value.bindingId, value);
  }
  let totalBytes = 0;
  const destinations = new Set<string>();
  return descriptors.map((descriptor) => {
    const value = byId.get(descriptor.bindingId);
    const version = value === undefined ? NaN : Number(value.bindingVersion);
    if (
      value === undefined || String(value.bindingVersion) !== descriptor.bindingVersion ||
      !Number.isSafeInteger(version) || version < 1 || typeof value.value !== "string"
    ) {
      throw new ComputeControlPlaneError({
        code: "COMPUTE_SECRET_MATERIALIZATION_FAILED",
        message: "The trusted secret materializer returned a mismatched binding.",
        status: 503,
      });
    }
    const bytes = new TextEncoder().encode(value.value).byteLength;
    totalBytes += bytes;
    if (bytes > MAX_SECRET_VALUE_BYTES || totalBytes > MAX_TOTAL_SECRET_BYTES) {
      throw new ComputeControlPlaneError({
        code: "COMPUTE_SECRET_MATERIALIZATION_FAILED",
        message: "The materialized Agent Variables exceed the private lease limits.",
        status: 503,
      });
    }
    const destination = descriptor.delivery.kind === "raw_env"
      ? { kind: "env" as const, name: descriptor.delivery.envName }
      : { kind: "file" as const, path: descriptor.delivery.fileName };
    const destinationKey = destination.kind === "env"
      ? `env:${destination.name}`
      : `file:${destination.path}`;
    if (destinations.has(destinationKey)) {
      throw new ComputeControlPlaneError({
        code: "COMPUTE_SECRET_MATERIALIZATION_FAILED",
        message: "Declared Agent Variables have duplicate lease destinations.",
        status: 503,
      });
    }
    destinations.add(destinationKey);
    return {
      binding_id: descriptor.bindingId,
      version,
      destination,
      value: value.value,
    };
  });
}

/** Unwired private adapter; callers must supply an infrastructure verifier. */
export async function handleComputeInternalRequest(
  request: Request,
  deps: ComputeInternalRouteDeps = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== INTERNAL_HOST) return json({ error: "not_found" }, 404);
  if (!deps.verifyServiceBindingRequest) {
    return json({ error: "service_binding_verifier_missing" }, 503);
  }
  if (!(await deps.verifyServiceBindingRequest(request))) {
    return json({ error: "service_binding_required" }, 403);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const payload = await body(request);
    if (url.pathname === "/internal/compute/gateway") {
      const decision = await introspectComputeJobToken({
        token: bearerToken(request),
        containerId: trustedContainerId(request),
        authority: payload.authority,
      }, deps);
      return json(decision, decision.allowed ? 200 : 403);
    }

    const route = runPath(url.pathname);
    if (!route) return json({ error: "not_found" }, 404);
    switch (route.action) {
      case "claim":
        return json(workerClaim(await claimComputeRun({ runId: route.runId }, deps)));
      case "prepare-lease": {
        const containerId = string(payload.container_id, "container_id");
        const snapshot = await getComputeRunSecretDescriptors({
          runId: route.runId,
          containerId,
        }, deps);
        const secrets = await materializeWorkerSecrets(
          deps,
          snapshot.run,
          snapshot.secretDescriptors,
        );
        const prepared = await prepareComputeRunLease({
          runId: route.runId,
          containerId,
          expectedSecretDescriptors: snapshot.secretDescriptors,
          replaceExistingToken: snapshot.run.state === "running" ||
            payload.replace_existing_token === true,
        }, deps);
        if (!prepared.token) {
          return json({ error: "one_time_token_already_delivered" }, 409);
        }
        return json({
          lease_id: prepared.run.leaseId,
          job_token: prepared.token,
          expires_at: prepared.tokenExpiresAt,
          reserved_wall_ms: Number(prepared.budget.reservedWallMs),
          gateway_url: "https://galactic.internal/v1",
          secrets,
        });
      }
      case "heartbeat": {
        const run = await heartbeatComputeRun({
          runId: route.runId,
          leaseId: string(payload.lease_id, "lease_id"),
        }, deps);
        return json({
          cancelled: run.state !== "running" || run.stopRequestedAt !== null,
          expires_at: run.expiresAt,
        });
      }
      case "reserve-output": {
        const leaseId = string(payload.lease_id, "lease_id");
        const run = await exactWorkerRun(route.runId, leaseId, deps);
        const artifactId = string(payload.artifact_id, "artifact_id");
        const registered = await registerComputeArtifact({
          artifactId,
          idempotencyKey: artifactId,
          runId: run.id,
          userId: run.userId,
          agentId: run.agentId,
          callerFunction: run.callerFunction,
          storageKey: string(payload.object_key, "object_key"),
          direction: "output",
          logicalName: string(payload.path, "path"),
          mediaType: string(payload.media_type, "media_type"),
          sha256: string(payload.sha256, "sha256"),
          sizeBytes: integer(payload.size_bytes, "size_bytes"),
        }, deps);
        return json({
          ...workerArtifact(registered.artifact) as Record<string, unknown>,
          replayed: registered.replayed,
        });
      }
      case "output-status": {
        const leaseId = string(payload.lease_id, "lease_id");
        const run = await exactWorkerRun(route.runId, leaseId, deps, false);
        const artifact = await getComputeArtifact({
          artifactId: string(payload.artifact_id, "artifact_id"),
          runId: run.id,
          userId: run.userId,
          agentId: run.agentId,
          callerFunction: run.callerFunction,
        }, deps);
        return artifact ? json(workerArtifact(artifact)) : json({ error: "not_found" }, 404);
      }
      case "commit-output":
      case "abandon-output": {
        const leaseId = string(payload.lease_id, "lease_id");
        const run = await exactWorkerRun(
          route.runId,
          leaseId,
          deps,
          route.action === "commit-output",
        );
        const artifactId = string(payload.artifact_id, "artifact_id");
        let artifact = await getComputeArtifact({
          artifactId,
          runId: run.id,
          userId: run.userId,
          agentId: run.agentId,
          callerFunction: run.callerFunction,
        }, deps);
        if (!artifact) return json({ error: "not_found" }, 404);
        if (route.action === "commit-output") {
          const sha256 = string(payload.sha256, "sha256");
          const sizeBytes = String(integer(payload.size_bytes, "size_bytes"));
          if (artifact.state === "ready") {
            if (artifact.sha256 !== sha256 || artifact.sizeBytes !== sizeBytes) {
              throw new ComputeControlPlaneError({
                code: "COMPUTE_ARTIFACT_CONFLICT",
                message: "The output artifact committed with different metadata.",
                status: 409,
              });
            }
            return json(workerArtifact(artifact));
          }
          artifact = await transitionComputeArtifact({
            artifactId,
            runId: run.id,
            userId: run.userId,
            agentId: run.agentId,
            callerFunction: run.callerFunction,
            expectedState: "pending",
            expectedStateVersion: artifact.stateVersion,
            toState: "ready",
            sha256,
            sizeBytes,
          }, deps);
        } else if (artifact.state === "pending") {
          artifact = await transitionComputeArtifact({
            artifactId,
            runId: run.id,
            userId: run.userId,
            agentId: run.agentId,
            callerFunction: run.callerFunction,
            expectedState: "pending",
            expectedStateVersion: artifact.stateVersion,
            toState: "deleted",
          }, deps);
        }
        return json(workerArtifact(artifact));
      }
      case "complete": {
        const metrics = record(payload.metrics, "metrics");
        const outputs = Array.isArray(payload.outputs) ? payload.outputs.map((value) => {
          const output = record(value, "output");
          return {
            artifactId: string(output.artifact_id, "artifact_id"),
            path: string(output.path, "path"),
            storageKey: string(output.object_key, "object_key"),
            sha256: string(output.sha256, "sha256"),
            sizeBytes: integer(output.size_bytes, "size_bytes"),
            mediaType: string(output.media_type, "media_type"),
            archive: output.archive as "none" | "tar.gz",
          };
        }) : [];
        let result: Awaited<ReturnType<typeof completeComputeRun>>;
        try {
          result = await completeComputeRun({
            runId: route.runId,
            leaseId: string(payload.lease_id, "lease_id"),
            workerWallMs: integer(metrics.wall_ms, "metrics.wall_ms"),
            exitCode: Number(payload.exit_code),
            stdout: typeof payload.stdout === "string" ? payload.stdout : "",
            stderr: typeof payload.stderr === "string" ? payload.stderr : "",
            stdoutBytes: integer(metrics.stdout_bytes, "metrics.stdout_bytes"),
            stderrBytes: integer(metrics.stderr_bytes, "metrics.stderr_bytes"),
            stdoutTruncated: metrics.stdout_truncated === true,
            stderrTruncated: metrics.stderr_truncated === true,
            metrics,
            outputs,
          }, deps);
        } catch (error) {
          await Promise.resolve(deps.onSettlementPending?.({
            runId: route.runId,
          })).catch(() => undefined);
          throw error;
        }
        return json(result.receipt);
      }
      case "fail": {
        const metrics = payload.metrics === undefined
          ? null
          : record(payload.metrics, "metrics");
        let result: Awaited<ReturnType<typeof failComputeRun>>;
        try {
          result = await failComputeRun({
            runId: route.runId,
            leaseId: typeof payload.lease_id === "string" ? payload.lease_id : null,
            workerWallMs: metrics?.wall_ms as string | number | undefined,
            code: string(payload.code, "code"),
            message: string(payload.message, "message"),
            metrics,
          }, deps);
        } catch (error) {
          await Promise.resolve(deps.onSettlementPending?.({
            runId: route.runId,
          })).catch(() => undefined);
          throw error;
        }
        if (!result.receipt) throw new Error("Worker failure returned no receipt");
        await Promise.resolve(deps.onWorkerFailure?.({
          runId: result.run.id,
          userId: result.run.userId,
          agentId: result.run.agentId,
          callerFunction: result.run.callerFunction,
          receiptId: result.receipt.id,
          outcome: result.run.state === "cancelled" ? "cancelled" : "failed",
          code: string(payload.code, "code"),
        })).catch(() => undefined);
        return json(result.receipt);
      }
      case "cancel-observed": {
        const result = await failComputeRun({
          runId: route.runId,
          leaseId: string(payload.lease_id, "lease_id"),
          code: "cancelled",
          message: "Cancellation observed by Compute Worker.",
        }, deps);
        if (!result.receipt) throw new Error("Worker cancellation returned no receipt");
        await Promise.resolve(deps.onWorkerFailure?.({
          runId: result.run.id,
          userId: result.run.userId,
          agentId: result.run.agentId,
          callerFunction: result.run.callerFunction,
          receiptId: result.receipt.id,
          outcome: "cancelled",
          code: "cancelled",
        })).catch(() => undefined);
        return json(result.receipt);
      }
      default:
        return json({ error: "not_found" }, 404);
    }
  } catch (error) {
    if (error instanceof ComputeControlPlaneError) {
      return json({ error: error.code, message: error.message }, error.status);
    }
    return json({
      error: "invalid_request",
      message: error instanceof Error ? error.message : "Invalid request.",
    }, 400);
  }
}
