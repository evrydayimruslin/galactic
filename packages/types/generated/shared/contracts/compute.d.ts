/** The only manifest/runtime permission that admits Galactic Compute. */
export declare const COMPUTE_EXEC_PERMISSION: "compute:exec";
/**
 * Compute profiles are immutable, versioned platform contracts. Callers never
 * provide an image name or digest directly.
 */
export declare const COMPUTE_PROFILES: readonly ["developer-v1"];
export type ComputeProfile = typeof COMPUTE_PROFILES[number];
export declare const DEFAULT_COMPUTE_PROFILE: ComputeProfile;
/**
 * V1 async jobs are driven by a push Queue consumer with a 15-minute wall
 * limit. Eight minutes leaves the reserved 195s startup envelope plus bounded
 * artifact/finalization/destruction time inside that hard platform boundary.
 */
export declare const COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS = 480000;
/**
 * Aggregate input/output artifact budget exposed by developer-v1. The first
 * production body uses Cloudflare standard-1 storage, so this deliberately
 * leaves most of the writable disk for the image, browser profiles, office
 * conversions, package caches, and command scratch space. The executor also
 * verifies live free space before it copies any input object into a body.
 */
export declare const COMPUTE_V1_MAX_ARTIFACT_BYTES = 1073741824;
/** Ready output bytes remain available for this fixed v1 retention window. */
export declare const COMPUTE_V1_ARTIFACT_RETENTION_DAYS = 30;
/** Hard per-owner physical retained-output quota; input aliases count zero. */
export declare const COMPUTE_V1_RETAINED_OUTPUT_MAX_BYTES = 10737418240;
export declare const COMPUTE_V1_RETAINED_OUTPUT_MAX_OBJECTS = 10000;
/**
 * Immutable semantic catalog baked into the developer-v1 image. These labels
 * are disclosure/admission identifiers, not package names or install input.
 * Unknown IDs fail closed in v1; signed extension packs are a later protocol.
 */
export declare const DEVELOPER_V1_COMPUTE_TOOLS: readonly ["shell", "browser", "office", "media", "pdf", "ocr", "data", "databases", "transfer", "git", "coding.claude", "coding.codex", "galactic"];
export type DeveloperV1ComputeTool = typeof DEVELOPER_V1_COMPUTE_TOOLS[number];
/**
 * Semantic tool identifiers name capabilities from the platform tool catalog,
 * not packages, binaries, image tags, or arbitrary install instructions. The
 * catalog performs the final existence check; this grammar keeps declarations
 * canonical and safe to hash before that resolution exists.
 */
export type ComputeToolId = string;
export declare const COMPUTE_TOOL_ID_PATTERN: RegExp;
export declare const COMPUTE_MAX_TOOLS = 32;
export declare const COMPUTE_MAX_TOOL_ID_LENGTH = 64;
export declare const COMPUTE_MAX_SECRETS = 50;
export declare function isComputeProfile(value: unknown): value is ComputeProfile;
export declare function isComputeToolId(value: unknown): value is ComputeToolId;
export declare function isDeveloperV1ComputeTool(value: unknown): value is DeveloperV1ComputeTool;
/** Owner-reviewed ceiling for compute requests made by this Agent. */
export interface ManifestComputeConfig {
    profile: ComputeProfile;
    tools: ComputeToolId[];
    /**
     * Agent secret NAMES eligible for explicit delivery to a one-shot body.
     * Values never belong in a manifest or compute request.
     */
    secrets?: string[];
}
/** Parse an already-declared manifest compute ceiling defensively. */
export declare function normalizeManifestComputeConfig(value: unknown): ManifestComputeConfig | null;
export type ComputeExecutionMode = 'sync' | 'async';
export interface ComputeInputArtifact {
    artifact_id: string;
    mount_path: string;
}
export interface ComputeArtifact {
    artifact_id: string;
    path: string;
    size_bytes: number;
    sha256: string;
    /** Exact control-plane expiry. Admission and downloads fail after this time. */
    expires_at: string;
}
/** Start one disposable, durable compute run. */
export interface ComputeRequest {
    argv: [string, ...string[]];
    /** Semantic capabilities required by this run. */
    tools: ComputeToolId[];
    profile?: ComputeProfile;
    /** Explicit Agent secret names; raw values are never accepted here. */
    secrets?: string[];
    mode?: ComputeExecutionMode;
    cwd?: string;
    stdin?: string;
    timeout_ms?: number;
    input_artifacts?: ComputeInputArtifact[];
    capture_paths?: string[];
}
export type ComputeRunStatus = 'queued' | 'reserving' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'settlement_pending';
export interface ComputeRun {
    run_id: string;
    receipt_id: string;
    status: ComputeRunStatus;
    profile: ComputeProfile;
    tools: ComputeToolId[];
    created_at: string;
    started_at?: string;
    finished_at?: string;
    exit_code?: number;
    stdout?: string;
    stderr?: string;
    artifacts?: ComputeArtifact[];
    error?: string;
}
export interface ComputeSyncResult extends ComputeRun {
    async: false;
    status: 'completed' | 'failed' | 'cancelled' | 'settlement_pending';
}
export interface ComputeAcceptedResult extends ComputeRun {
    async: true;
    status: 'queued' | 'reserving' | 'starting' | 'running';
}
export type ComputeResult = ComputeSyncResult | ComputeAcceptedResult;
/**
 * Callable in-Agent binding: `galactic.compute(request)`. Status and
 * cancellation stay namespaced on that same function object.
 */
export interface ComputeBinding {
    (request: ComputeRequest): Promise<ComputeResult>;
    get(runId: string): Promise<ComputeRun>;
    cancel(runId: string): Promise<ComputeRun>;
}
