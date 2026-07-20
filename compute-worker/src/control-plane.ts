import type {
  ClaimComputeRunResponse,
  CompleteComputeRunRequest,
  ComputeControlPlaneBinding,
  ComputeRunReceipt,
  FailComputeRunRequest,
  PreparedComputeLease,
  ComputeOutputArtifact,
  ComputeWorkerArtifactState,
} from "./contracts";

const INTERNAL_ORIGIN = "https://galactic.internal";
const CONTROL_PLANE_REQUEST_TIMEOUT_MS = 30_000;

/** The server may have committed even though no response crossed the binding. */
export class ControlPlaneTransportError extends Error {
  readonly operation: string;

  constructor(operation: string, options?: ErrorOptions) {
    super(`control plane ${operation} response was not observed`, options);
    this.name = "ControlPlaneTransportError";
    this.operation = operation;
  }
}

export class ControlPlaneClient {
  readonly #binding: ComputeControlPlaneBinding;
  readonly #runId: string;

  constructor(binding: ComputeControlPlaneBinding, runId: string) {
    this.#binding = binding;
    this.#runId = runId;
  }

  claim(): Promise<ClaimComputeRunResponse> {
    return this.#post<ClaimComputeRunResponse>("claim", {});
  }

  prepareLease(containerId: string): Promise<PreparedComputeLease> {
    return this.#post<PreparedComputeLease>("prepare-lease", {
      container_id: containerId,
    });
  }

  heartbeat(leaseId: string): Promise<{ cancelled: boolean; expires_at: string }> {
    return this.#post("heartbeat", { lease_id: leaseId });
  }

  reserveOutput(
    leaseId: string,
    artifact: ComputeOutputArtifact,
  ): Promise<ComputeWorkerArtifactState> {
    return this.#post("reserve-output", {
      lease_id: leaseId,
      artifact_id: artifact.artifact_id,
      path: artifact.path,
      object_key: artifact.object_key,
      sha256: artifact.sha256,
      size_bytes: artifact.size_bytes,
      media_type: artifact.media_type,
    });
  }

  commitOutput(
    leaseId: string,
    artifact: ComputeOutputArtifact,
  ): Promise<ComputeWorkerArtifactState> {
    return this.#post("commit-output", {
      lease_id: leaseId,
      artifact_id: artifact.artifact_id,
      sha256: artifact.sha256,
      size_bytes: artifact.size_bytes,
    });
  }

  abandonOutput(
    leaseId: string,
    artifactId: string,
  ): Promise<ComputeWorkerArtifactState> {
    return this.#post("abandon-output", {
      lease_id: leaseId,
      artifact_id: artifactId,
    });
  }

  outputStatus(
    leaseId: string,
    artifactId: string,
  ): Promise<ComputeWorkerArtifactState> {
    return this.#post("output-status", {
      lease_id: leaseId,
      artifact_id: artifactId,
    });
  }

  complete(body: CompleteComputeRunRequest): Promise<ComputeRunReceipt> {
    return this.#post("complete", body);
  }

  fail(body: FailComputeRunRequest): Promise<ComputeRunReceipt> {
    return this.#post("fail", body);
  }

  cancelObserved(leaseId: string): Promise<void> {
    return this.#post<void>("cancel-observed", { lease_id: leaseId });
  }

  async #post<T>(operation: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.#binding.fetch(
        `${INTERNAL_ORIGIN}/internal/compute/runs/${encodeURIComponent(this.#runId)}/${operation}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(CONTROL_PLANE_REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      throw new ControlPlaneTransportError(operation, { cause: error });
    }
    if (!response.ok) {
      // A private control-plane error body can contain validation input or
      // materialization diagnostics. Never reflect it into queue logs or a run
      // failure receipt; operation + status are sufficient for retry policy.
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`control plane ${operation} failed (${response.status})`);
    }
    if (response.status === 204) return undefined as T;
    try {
      return await response.json<T>();
    } catch (error) {
      // A malformed/truncated body is also commit-ambiguous. Callers must not
      // infer that the operation failed merely because its response could not
      // be consumed.
      throw new ControlPlaneTransportError(operation, { cause: error });
    }
  }
}
