export const COMPUTE_MESSAGE_VERSION = 1 as const;
export const COMPUTE_PROFILE = "developer-v1" as const;

export interface ComputeDispatchMessage {
  version: typeof COMPUTE_MESSAGE_VERSION;
  run_id: string;
}

export interface ComputeInputArtifact {
  artifact_id: string;
  object_key: string;
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface ComputeToolpack {
  /** Reserved for a future signed-pack protocol; developer-v1 rejects all entries. */
  name: string;
  version: string;
  object_key: string;
  sha256: string;
  size_bytes: number;
}

export interface ComputeSecretBinding {
  binding_id: string;
  version: number;
  destination:
    | { kind: "env"; name: string }
    | { kind: "file"; path: string };
  /**
   * Present only on the private control-plane response after the configured
   * vault/Variables resolver has materialized this exact declared binding.
   * It is never persisted in compute_runs or included in a receipt.
   */
  value: string;
}

export interface ClaimedComputeRun {
  run_id: string;
  account_id: string;
  agent_id: string;
  function_name: string;
  execution_id: string | null;
  profile: typeof COMPUTE_PROFILE;
  environment_digest: string;
  argv: [string, ...string[]];
  cwd: string;
  stdin: string | null;
  timeout_ms: number;
  capture_paths: string[];
  max_artifacts: number;
  max_artifact_bytes: number;
  input_artifacts: ComputeInputArtifact[];
  toolpacks: ComputeToolpack[];
  /** Original body start, present when a stale live claim is being recovered. */
  started_at: string | null;
  lease_expires_at: string;
}

export type ClaimComputeRunResponse =
  | {
    claimed: false;
    reason: "not_found" | "already_claimed" | "cancelled" | "busy";
  }
  | {
    claimed: true;
    /** True only for a live provisioning/running claim resumed after coordinator loss. */
    recovered: boolean;
    run: ClaimedComputeRun;
  };

export interface PreparedComputeLease {
  lease_id: string;
  job_token: string;
  expires_at: string;
  reserved_wall_ms: number;
  gateway_url: "https://galactic.internal/v1";
  secrets: ComputeSecretBinding[];
}

export interface ComputeOutputArtifact {
  artifact_id: string;
  path: string;
  object_key: string;
  sha256: string;
  size_bytes: number;
  media_type: string;
  archive: "none" | "tar.gz";
}

export interface ComputeWorkerArtifactState {
  artifact_id: string;
  state: "pending" | "ready" | "deleted";
  state_version: string;
  object_key: string;
  sha256: string | null;
  size_bytes: number | null;
  replayed?: boolean;
}

export interface ComputeExecutionMetrics {
  started_at: string;
  finished_at: string;
  wall_ms: number;
  container_placement_id: string | null;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

export interface CompleteComputeRunRequest {
  lease_id: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  outputs: ComputeOutputArtifact[];
  metrics: ComputeExecutionMetrics;
}

export interface FailComputeRunRequest {
  lease_id?: string;
  code:
    | "cancelled"
    | "deadline_exceeded"
    | "image_unavailable"
    | "artifact_error"
    | "secret_error"
    | "execution_error"
    | "internal_error";
  message: string;
  metrics?: Partial<ComputeExecutionMetrics>;
}

export interface ComputeRunReceipt {
  receipt_id: string;
  run_id: string;
  status: "succeeded" | "failed" | "cancelled";
}

export interface ComputeCancelRequest {
  run_id: string;
}

export interface ComputeControlPlaneBinding extends Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ComputeSandboxStub {
  createSession(options?: {
    id?: string;
    name?: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
    isolation?: boolean;
    commandTimeoutMs?: number;
  }): Promise<ComputeExecutionSession>;
  deleteSession(sessionId: string): Promise<unknown>;
  destroy(): Promise<void>;
  getContainerPlacementId(): Promise<string | null | undefined>;
}

export interface ComputeCoordinatorStub {
  executeCoordinated(message: unknown): Promise<ComputeRunReceipt | null>;
  cancelCoordinated(message: unknown): Promise<{ destroyed: true }>;
}

export interface ComputeExecutionSession {
  readonly id: string;
  exec(
    command: string,
    options?: {
      timeout?: number;
      env?: Record<string, string | undefined>;
      cwd?: string;
      signal?: AbortSignal;
      origin?: "user" | "internal";
    },
  ): Promise<{
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { encoding?: string },
  ): Promise<unknown>;
  readFile(
    path: string,
    options?: { encoding?: "utf-8" | "utf8" | "base64" },
  ): Promise<{ content: string; size?: number }>;
  readFileStream(path: string): Promise<ReadableStream<Uint8Array>>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
}

export interface ComputeArtifactBucket {
  get(key: string): Promise<{
    body: ReadableStream<Uint8Array>;
    size: number;
    httpMetadata?: { contentType?: string };
  } | null>;
  put(
    key: string,
    value: ReadableStream<Uint8Array> | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      /** R2 must reject a body stream that no longer matches its frozen hash. */
      sha256?: string;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export interface Env {
  COMPUTE_STANDARD: DurableObjectNamespace;
  COMPUTE_ARTIFACTS: ComputeArtifactBucket;
  CONTROL_PLANE: ComputeControlPlaneBinding;
  ENVIRONMENT: "production" | "staging" | "development";
  COMPUTE_ENVIRONMENT_DIGEST: string;
  MAX_OUTPUT_BYTES?: string;
  HEARTBEAT_INTERVAL_MS?: string;
}
