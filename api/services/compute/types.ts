export const COMPUTE_PROFILE = "developer-v1" as const;

export const COMPUTE_ACTIONS = [
  "artifacts.read",
  "artifacts.write",
  "budget.read",
  "receipts.read",
  "platform.call",
  "agents.call",
] as const;

export type ComputeAction = typeof COMPUTE_ACTIONS[number];

export const COMPUTE_RUN_STATES = [
  "admitted",
  "queued",
  "provisioning",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "revoked",
] as const;

export type ComputeRunState = typeof COMPUTE_RUN_STATES[number];

export type ComputeBillingMode = "wallet" | "subscription_capacity";

export type ComputeCapacitySettlementStatus =
  | "not_applicable"
  | "pending"
  | "settled";

export const COMPUTE_TERMINAL_RUN_STATES = [
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "revoked",
] as const satisfies readonly ComputeRunState[];

export type ComputeTerminalRunState =
  typeof COMPUTE_TERMINAL_RUN_STATES[number];

/** v1 has no asynchronous approval state machine: every rule is explicit. */
export type ComputeAuthorityDecision = "always" | "never";

export type ComputeAuthority =
  | {
    action: "artifacts.read";
    target: { kind: "run_input" };
    constraints?: Record<string, unknown>;
  }
  | {
    action: "artifacts.write";
    target: { kind: "run_output" };
    constraints?: Record<string, unknown>;
  }
  | {
    action: "budget.read" | "receipts.read";
    target: { kind: "run" };
    constraints?: Record<string, unknown>;
  }
  | {
    action: "platform.call";
    target: { kind: "platform_function"; functionName: string };
    constraints?: Record<string, unknown>;
  }
  | {
    action: "agents.call";
    target: {
      kind: "agent_function";
      agentId: string;
      functionName: string;
    };
    constraints?: Record<string, unknown>;
  };

export interface ComputeAuthorityDatabaseValue {
  action: ComputeAction;
  resource_kind:
    | "run"
    | "run_input"
    | "run_output"
    | "platform_function"
    | "agent_function";
  target_agent_id: string | null;
  target_function: string | null;
  constraints: Record<string, unknown>;
}

export interface ComputeAgentPolicy {
  userId: string;
  agentId: string;
  enabled: boolean;
  profile: typeof COMPUTE_PROFILE;
  state: "active" | "paused" | "revoked";
  allowedTools: string[];
  maxTimeoutMs: number;
  maxConcurrency: number;
  maxArtifactBytes: string;
  maxArtifacts: number;
  authorityEpoch: string;
  revision: string;
  ownerConfirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComputeAgentPolicyRule {
  id: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  decision: ComputeAuthorityDecision;
  authority: ComputeAuthority;
  ruleVersion: string;
  authorityEpoch: string;
  createdAt: string;
  updatedAt: string;
}

export interface ComputeRun {
  id: string;
  receiptId: string;
  leaseId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  executionId: string | null;
  directiveHash: string;
  profile: typeof COMPUTE_PROFILE;
  environmentDigest: string;
  billingMode: ComputeBillingMode;
  capacityAgentId: string;
  capacityReservationId: string | null;
  request: ComputeExecutionRequest;
  manifestCeiling: ComputeManifestCeiling;
  policyLimits: ComputePolicyLimitsSnapshot;
  authorityEpoch: string;
  state: ComputeRunState;
  stateVersion: string;
  expiresAt: string;
  stopRequestedAt: string | null;
  stopReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  terminalReason: string | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  stdoutBytes: string | null;
  stderrBytes: string | null;
  stdoutTruncated: boolean | null;
  stderrTruncated: boolean | null;
  executionMetrics: Record<string, unknown> | null;
  terminalError: string | null;
  createdAt: string;
  updatedAt: string;
}

export const DEVELOPER_V1_TOOL_IDS = [
  "shell",
  "browser",
  "office",
  "media",
  "pdf",
  "ocr",
  "data",
  "databases",
  "transfer",
  "git",
  "coding.claude",
  "coding.codex",
  "galactic",
] as const;

export type DeveloperV1ToolId = typeof DEVELOPER_V1_TOOL_IDS[number];

export interface ComputeToolSelection {
  id: string;
}

export interface ComputeManifestCeiling {
  allowedTools: string[];
  maxTimeoutMs: number;
  revision: string;
}

export interface ComputePolicyLimitsSnapshot {
  allowedTools: string[];
  maxTimeoutMs: number;
  maxConcurrency: number;
  maxArtifactBytes: string;
  maxArtifacts: number;
  revision: string;
}

export interface ComputeExecutionRequest {
  argv: string[];
  tools: ComputeToolSelection[];
  secretBindingIds: string[];
  cwd: string;
  stdin:
    | { kind: "none" }
    | { kind: "text"; text: string };
  capturePaths: string[];
  inputArtifacts: Array<{ artifactId: string; mountPath: string }>;
  timeoutMs: number;
}

export interface ComputeRunBudgetReservation {
  id: string;
  runId: string;
  billingMode: ComputeBillingMode;
  holdId: string | null;
  capacityAgentId: string;
  capacityReservationId: string | null;
  rateVersion: "compute-rate-v1";
  rateLightPerMs: number;
  reservedWallMs: string;
  reservedLight: number;
  actualWallMs: string | null;
  actualLight: number;
  releasedLight: number;
  status: "reserved" | "settlement_pending" | "settled" | "released";
  expiresAt: string;
}

export interface ComputeRunReceipt {
  id: string;
  runId: string;
  userId: string;
  agentId: string;
  billingMode: ComputeBillingMode;
  holdId: string | null;
  capacityAgentId: string;
  capacityReservationId: string | null;
  capacitySettlementStatus: ComputeCapacitySettlementStatus;
  cloudUsageEventId: string | null;
  outcome: "succeeded" | "failed" | "cancelled" | "expired" | "revoked";
  rateVersion: "compute-rate-v1";
  workerWallMs: string | null;
  teardownAllowanceMs: string;
  billedWallMs: string;
  reservedLight: number;
  actualLight: number;
  releasedLight: number;
  createdAt: string;
}

export interface ComputeRunAuthorityRecord {
  id: string;
  runId: string;
  authority: ComputeAuthority;
  sourceKind: "builtin" | "policy";
  sourcePolicyRuleId: string | null;
  sourceVersion: string | null;
}

export type ComputeSecretDelivery =
  | { kind: "raw_env"; envName: string }
  | { kind: "raw_file"; fileName: string };

export interface ComputeSecretBinding {
  id: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  name: string;
  variableName: string;
  delivery: ComputeSecretDelivery;
  status: "active" | "revoked";
  bindingVersion: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComputeArtifact {
  id: string;
  runId: string;
  userId: string;
  sourceArtifactId: string | null;
  direction: "input" | "output";
  mountPath: string | null;
  logicalName: string;
  mediaType: string;
  storageKey: string;
  sha256: string | null;
  sizeBytes: string | null;
  state: "pending" | "ready" | "deleted";
  stateVersion: string;
  expiresAt: string | null;
  retentionProtectedUntil: string | null;
  objectDeletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
