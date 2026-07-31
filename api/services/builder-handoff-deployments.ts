import type {
  LaunchCandidateDeploymentReceipt,
  LaunchCandidateDeployResponse,
  LaunchCandidateInvitation,
  LaunchCandidateStatus,
  LaunchCandidateTarget,
} from "../../shared/contracts/launch.ts";
import { resolveManifestEnvSchema } from "../../shared/contracts/manifest.ts";
import type { VersionMetadata } from "../../shared/types/index.ts";
import { getEnv } from "../lib/env.ts";
import {
  BuilderHandoffCandidateArchiveError,
  type BuilderHandoffCandidateArchiveExpectedBinding,
  type BuilderHandoffCandidateArchiveStore,
  type BuilderHandoffCandidateDeploymentSnapshot,
  type BuilderHandoffVerifiedCandidateArchiveManifest,
  loadBuilderHandoffCandidateDeploymentSnapshot,
  loadVerifiedBuilderHandoffCandidateArchiveManifest,
} from "./builder-handoff-candidate-archive.ts";
import {
  BUILDER_HANDOFF_RECENT_PROMOTED_LIMIT,
  BUILDER_HANDOFF_RECENT_PROMOTED_WINDOW_MS,
  BUILDER_HANDOFF_UPLOADED_CANDIDATE_LIMIT,
  type BuilderHandoffSessionRecord,
  getBuilderHandoffSessionForOwner,
  listBuilderHandoffCandidateSessions,
} from "./builder-handoff-sessions.ts";
import {
  loadLiveExecutedBundle,
  loadReleaseExecutedBundle,
  putLiveExecutedBundle,
  putReleaseExecutedBundle,
  verifyExecutedBundle,
} from "./executed-bundle.ts";
import { findPersistedTestAttestation } from "./test-attestation.ts";
import { interfaceArtifactPrefixForApp } from "./interface-artifacts.ts";
import { normalizeRoutineSchedule } from "./routine-schedule.ts";
import {
  normalizeRoutineBudgetPolicy,
  routineCapabilitiesFromManifest,
} from "./routines.ts";
import {
  createR2Service,
  type FileUpload,
  type R2Service,
  StorageObjectNotFoundError,
} from "./storage.ts";
import {
  buildVersionMetadataEntry,
  buildVersionTrustMetadata,
  canonicalJson,
  sha256Hex,
} from "./trust.ts";
import { type D1Status, provisionAndMigrate } from "./upload-pipeline.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const REVIEW_REVISION_PREFIX = "gxr1:";
const DEPLOYMENT_PHASE_RANK: Record<DeploymentPhase, number> = {
  claimed: 0,
  archive_verified: 1,
  artifacts_started: 2,
  artifacts_verified: 3,
  migrations_started: 4,
  migrations_verified: 5,
  live_bundle_started: 6,
  live_bundle_verified: 7,
  committed: 8,
};

type DeploymentPhase =
  | "claimed"
  | "archive_verified"
  | "artifacts_started"
  | "artifacts_verified"
  | "migrations_started"
  | "migrations_verified"
  | "live_bundle_started"
  | "live_bundle_verified"
  | "committed";

interface CandidateTargetAppRow {
  id: string;
  owner_id: string;
  slug: string | null;
  name: string | null;
  visibility: string | null;
  current_version: string | null;
  manifest: unknown;
  version_metadata: VersionMetadata[] | null;
  deleted_at: string | null;
  release_generation?: number | string | null;
}

type CandidateDeploymentStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "stale"
  | "repair_required";

interface CandidateDeploymentRow {
  id: string;
  sessionId: string;
  ownerId: string;
  targetAppId: string;
  status: CandidateDeploymentStatus;
  phase: DeploymentPhase;
  version: string;
  response: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  completedAt: string | null;
}

interface DeploymentRpcResult {
  code: string;
  deployment_id: string;
  status: string;
  phase: string;
  lease_expires_at?: string | null;
  app_id: string;
  version: string;
  replayed: boolean;
  requires_reconciliation?: boolean;
  release_id?: string;
  release_generation?: number | string;
  lease_token?: string;
  app_slug?: string;
  app_name?: string;
}

interface BuilderHandoffDeploymentObjectStore
  extends BuilderHandoffCandidateArchiveStore {
  listFiles(prefix: string): Promise<string[]>;
}

type BuilderHandoffDeploymentErrorCode =
  | "invalid_request"
  | "invalid_response"
  | "not_found"
  | "membership_required"
  | "stale"
  | "conflict"
  | "archive_invalid"
  | "materialization_failed"
  | "repair_required"
  | "service_unavailable";

export class BuilderHandoffDeploymentError extends Error {
  constructor(
    readonly code: BuilderHandoffDeploymentErrorCode,
    message: string,
    readonly status: number,
    readonly causeCode?: string,
  ) {
    super(message);
    this.name = "BuilderHandoffDeploymentError";
  }
}

interface BuilderHandoffDeploymentDependencies {
  archiveStore: BuilderHandoffDeploymentObjectStore;
  listSessions: typeof listBuilderHandoffCandidateSessions;
  getSession: typeof getBuilderHandoffSessionForOwner;
  fetchFn: typeof fetch;
  loadInvitation: typeof loadVerifiedBuilderHandoffCandidateArchiveManifest;
  loadSnapshot: typeof loadBuilderHandoffCandidateDeploymentSnapshot;
  putLiveBundle: typeof putLiveExecutedBundle;
  loadLiveBundle: typeof loadLiveExecutedBundle;
  provisionAndMigrate: typeof provisionAndMigrate;
  randomUUID: () => string;
}

export interface BuilderHandoffDeploymentServiceOptions
  extends Partial<BuilderHandoffDeploymentDependencies> {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  now?: () => Date;
}

interface DeployBuilderHandoffCandidateInput {
  ownerId: string;
  candidateId: string;
  idempotencyKey: string;
  archiveDigest: string;
  releaseDigest: string;
  reviewRevision: string;
}

interface CandidateInvitationContext {
  invitation: LaunchCandidateInvitation;
  session: BuilderHandoffSessionRecord;
  summary: BuilderHandoffVerifiedCandidateArchiveManifest;
}

function dependencies(
  options: BuilderHandoffDeploymentServiceOptions,
): BuilderHandoffDeploymentDependencies {
  return {
    archiveStore: options.archiveStore ??
      (createR2Service() as BuilderHandoffDeploymentObjectStore),
    listSessions: options.listSessions ?? listBuilderHandoffCandidateSessions,
    getSession: options.getSession ?? getBuilderHandoffSessionForOwner,
    fetchFn: options.fetchFn ?? fetch,
    loadInvitation: options.loadInvitation ??
      loadVerifiedBuilderHandoffCandidateArchiveManifest,
    loadSnapshot: options.loadSnapshot ??
      loadBuilderHandoffCandidateDeploymentSnapshot,
    putLiveBundle: options.putLiveBundle ?? putLiveExecutedBundle,
    loadLiveBundle: options.loadLiveBundle ?? loadLiveExecutedBundle,
    provisionAndMigrate: options.provisionAndMigrate ?? provisionAndMigrate,
    randomUUID: options.randomUUID ?? (() => crypto.randomUUID()),
  };
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new BuilderHandoffDeploymentError(
      "invalid_request",
      `${field} must be a UUID`,
      400,
    );
  }
  return value.toLowerCase();
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new BuilderHandoffDeploymentError(
      "invalid_request",
      `${field} must be a lowercase SHA-256 digest`,
      400,
    );
  }
  return value;
}

function requireIdempotencyKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw new BuilderHandoffDeploymentError(
      "invalid_request",
      "idempotencyKey must be 8 to 128 safe characters",
      400,
    );
  }
  return value;
}

function serviceConfig(options: BuilderHandoffDeploymentServiceOptions): {
  supabaseUrl: string;
  serviceRoleKey: string;
} {
  const supabaseUrl = options.supabaseUrl ?? getEnv("SUPABASE_URL");
  const serviceRoleKey = options.serviceRoleKey ??
    getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new BuilderHandoffDeploymentError(
      "service_unavailable",
      "Candidate deployment persistence is not configured",
      503,
    );
  }
  return {
    supabaseUrl: supabaseUrl.replace(/\/+$/, ""),
    serviceRoleKey,
  };
}

function serviceHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

function rowObject(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" && !Array.isArray(row)
    ? row as Record<string, unknown>
    : null;
}

function invalidDeploymentResponse(
  message = "Candidate deployment persistence returned an invalid response",
): BuilderHandoffDeploymentError {
  return new BuilderHandoffDeploymentError(
    "invalid_response",
    message,
    503,
  );
}

function responseUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw invalidDeploymentResponse(
      `Candidate deployment persistence returned an invalid ${field}`,
    );
  }
  return value.toLowerCase();
}

function responseText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidDeploymentResponse(
      `Candidate deployment persistence returned an invalid ${field}`,
    );
  }
  return value;
}

function responseNullableText(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  return value === null ? null : responseText(value, field, maxLength);
}

function responseNullableDate(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw invalidDeploymentResponse(
      `Candidate deployment persistence returned an invalid ${field}`,
    );
  }
  return value;
}

function parseCandidateDeploymentRow(
  value: unknown,
  session: BuilderHandoffSessionRecord,
): CandidateDeploymentRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidDeploymentResponse();
  }
  const row = value as Record<string, unknown>;
  const statuses: readonly CandidateDeploymentStatus[] = [
    "in_progress",
    "completed",
    "failed",
    "stale",
    "repair_required",
  ];
  const phases: readonly DeploymentPhase[] = [
    "claimed",
    "archive_verified",
    "artifacts_started",
    "artifacts_verified",
    "migrations_started",
    "migrations_verified",
    "live_bundle_started",
    "live_bundle_verified",
    "committed",
  ];
  if (
    typeof row.status !== "string" ||
    !statuses.includes(row.status as CandidateDeploymentStatus) ||
    typeof row.phase !== "string" ||
    !phases.includes(row.phase as DeploymentPhase)
  ) {
    throw invalidDeploymentResponse(
      "Candidate deployment persistence returned an invalid lifecycle",
    );
  }
  const response = row.response === null
    ? null
    : row.response && typeof row.response === "object" &&
        !Array.isArray(row.response)
    ? row.response as Record<string, unknown>
    : (() => {
      throw invalidDeploymentResponse(
        "Candidate deployment persistence returned an invalid receipt",
      );
    })();
  const parsed: CandidateDeploymentRow = {
    id: responseUuid(row.id, "deployment ID"),
    sessionId: responseUuid(row.session_id, "session ID"),
    ownerId: responseUuid(row.owner_id, "owner ID"),
    targetAppId: responseUuid(row.target_app_id, "target Agent ID"),
    status: row.status as CandidateDeploymentStatus,
    phase: row.phase as DeploymentPhase,
    version: responseText(row.version, "version", 64),
    response,
    errorCode: responseNullableText(row.error_code, "error code", 128),
    errorMessage: responseNullableText(
      row.error_message,
      "error message",
      2_000,
    ),
    completedAt: responseNullableDate(row.completed_at, "completion time"),
  };
  if (
    parsed.sessionId !== session.id ||
    parsed.ownerId !== session.ownerId ||
    parsed.targetAppId !== session.targetAppId ||
    parsed.version !== session.uploadedVersion ||
    !/^\d+\.\d+\.\d+$/u.test(parsed.version)
  ) {
    throw invalidDeploymentResponse(
      "Candidate deployment persistence returned inconsistent identity",
    );
  }
  const completed = parsed.status === "completed";
  const hasCommittedShape = parsed.phase === "committed" &&
    parsed.response !== null &&
    parsed.completedAt !== null &&
    parsed.errorCode === null &&
    parsed.errorMessage === null;
  const hasNonCommittedShape = parsed.phase !== "committed" &&
    parsed.response === null &&
    parsed.completedAt === null;
  if (
    (completed && !hasCommittedShape) ||
    (!completed && !hasNonCommittedShape)
  ) {
    throw invalidDeploymentResponse(
      "Candidate deployment persistence returned an inconsistent terminal state",
    );
  }
  return parsed;
}

function committedDeploymentReceipt(
  deployment: CandidateDeploymentRow,
  session: BuilderHandoffSessionRecord,
): LaunchCandidateDeploymentReceipt {
  const response = deployment.response;
  if (
    deployment.status !== "completed" ||
    deployment.phase !== "committed" ||
    !deployment.completedAt ||
    !response ||
    session.status !== "promoted" ||
    !session.promotedAt ||
    Date.parse(session.promotedAt) !== Date.parse(deployment.completedAt)
  ) {
    throw invalidDeploymentResponse(
      "Promoted candidate is missing its committed deployment receipt",
    );
  }
  const deploymentId = responseUuid(
    response.deployment_id,
    "receipt deployment ID",
  );
  const appId = responseUuid(response.app_id, "receipt Agent ID");
  const version = responseText(response.version, "receipt version", 64);
  const slug = responseText(response.app_slug, "receipt Agent slug", 200);
  const name = responseText(response.app_name, "receipt Agent name", 300);
  if (
    deploymentId !== deployment.id ||
    appId !== deployment.targetAppId ||
    version !== deployment.version ||
    response.status !== "completed" ||
    response.phase !== "committed" ||
    response.setup_required !== true
  ) {
    throw invalidDeploymentResponse(
      "Committed candidate receipt does not match its deployment",
    );
  }
  return {
    deploymentId,
    completedAt: deployment.completedAt,
    agent: {
      id: appId,
      slug,
      name,
      version,
      setupRequired: true,
    },
  };
}

function rpcCauseCode(value: unknown): string | undefined {
  let serialized = "";
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  return serialized.match(
    /(?:BUILDER_HANDOFF_DEPLOYMENT|M7_DEPLOYMENT|PRO_SUBSCRIPTION)_[A-Z_]+/,
  )?.[0];
}

function rpcError(
  payload: unknown,
  fallback: string,
): BuilderHandoffDeploymentError {
  const causeCode = rpcCauseCode(payload);
  if (causeCode?.includes("PRO_SUBSCRIPTION")) {
    return new BuilderHandoffDeploymentError(
      "membership_required",
      "An active Galactic membership ($20/month) is required to deploy this Agent.",
      402,
      causeCode,
    );
  }
  if (causeCode?.includes("STALE") || causeCode?.includes("BASE_MISMATCH")) {
    return new BuilderHandoffDeploymentError(
      "stale",
      "This Agent changed after the candidate was built. Create a fresh handoff and review the new candidate.",
      409,
      causeCode,
    );
  }
  if (causeCode?.includes("NOT_FOUND") || causeCode?.includes("OWNER")) {
    return new BuilderHandoffDeploymentError(
      "not_found",
      "Candidate not found",
      404,
      causeCode,
    );
  }
  if (causeCode?.includes("REPAIR")) {
    return new BuilderHandoffDeploymentError(
      "repair_required",
      "Deployment reached a recoverable partial state and requires reconciliation.",
      409,
      causeCode,
    );
  }
  if (
    causeCode?.includes("CONFLICT") ||
    causeCode?.includes("IDEMPOTENCY") ||
    causeCode?.includes("LEASE")
  ) {
    return new BuilderHandoffDeploymentError(
      "conflict",
      "This deployment is already in progress or the idempotency key was reused for a different request.",
      409,
      causeCode,
    );
  }
  return new BuilderHandoffDeploymentError(
    "service_unavailable",
    fallback,
    503,
    causeCode,
  );
}

async function callRpc(
  name: string,
  request: Record<string, unknown>,
  options: BuilderHandoffDeploymentServiceOptions,
  deps: BuilderHandoffDeploymentDependencies,
): Promise<Record<string, unknown>> {
  const config = serviceConfig(options);
  let response: Response;
  try {
    response = await deps.fetchFn(
      `${config.supabaseUrl}/rest/v1/rpc/${name}`,
      {
        method: "POST",
        headers: serviceHeaders(config.serviceRoleKey),
        body: JSON.stringify({ p_request: request }),
      },
    );
  } catch {
    throw new BuilderHandoffDeploymentError(
      "service_unavailable",
      "Candidate deployment persistence is temporarily unavailable",
      503,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw rpcError(
      payload,
      "Candidate deployment persistence rejected the operation",
    );
  }
  const row = rowObject(payload);
  if (!row) {
    throw new BuilderHandoffDeploymentError(
      "service_unavailable",
      "Candidate deployment persistence returned an invalid response",
      503,
    );
  }
  return row;
}

function deploymentResult(row: Record<string, unknown>): DeploymentRpcResult {
  const code = typeof row.code === "string" ? row.code : "";
  if (
    typeof row.deployment_id !== "string" ||
    typeof row.app_id !== "string"
  ) {
    const normalized = code.toLowerCase();
    if (normalized.includes("pro_subscription")) {
      throw new BuilderHandoffDeploymentError(
        "membership_required",
        "An active Galactic membership ($20/month) is required to deploy this Agent.",
        402,
        code,
      );
    }
    if (
      normalized.includes("not_found") ||
      normalized.includes("owner_not_found")
    ) {
      throw new BuilderHandoffDeploymentError(
        "not_found",
        "Candidate not found",
        404,
        code,
      );
    }
    if (
      normalized.includes("stale") ||
      normalized.includes("lineage") ||
      normalized.includes("base_generation")
    ) {
      throw new BuilderHandoffDeploymentError(
        "stale",
        "This Agent changed after the candidate was built. Create a fresh handoff and review the new candidate.",
        409,
        code,
      );
    }
    if (
      normalized.includes("repair") ||
      normalized.includes("partial")
    ) {
      throw new BuilderHandoffDeploymentError(
        "repair_required",
        "Deployment reached a recoverable partial state and requires reconciliation.",
        409,
        code,
      );
    }
    if (
      normalized.includes("conflict") ||
      normalized.includes("mismatch") ||
      normalized.includes("lease") ||
      normalized.includes("in_progress")
    ) {
      throw new BuilderHandoffDeploymentError(
        "conflict",
        "This deployment is already in progress or the idempotency key was reused for a different request.",
        409,
        code,
      );
    }
    throw new BuilderHandoffDeploymentError(
      "service_unavailable",
      "Candidate deployment persistence returned an invalid state",
      503,
      code || undefined,
    );
  }
  const deploymentId = requireUuid(row.deployment_id, "deployment_id");
  const appId = requireUuid(row.app_id, "app_id");
  if (
    !code ||
    typeof row.status !== "string" ||
    typeof row.phase !== "string" ||
    typeof row.version !== "string" ||
    typeof row.replayed !== "boolean"
  ) {
    throw new BuilderHandoffDeploymentError(
      "service_unavailable",
      "Candidate deployment persistence returned an invalid state",
      503,
    );
  }
  return {
    code,
    deployment_id: deploymentId,
    status: row.status,
    phase: row.phase,
    app_id: appId,
    version: row.version,
    replayed: row.replayed,
    requires_reconciliation: row.requires_reconciliation === true,
    lease_expires_at: typeof row.lease_expires_at === "string"
      ? row.lease_expires_at
      : null,
    release_id: typeof row.release_id === "string" ? row.release_id : undefined,
    release_generation: typeof row.release_generation === "number" ||
        typeof row.release_generation === "string"
      ? row.release_generation
      : undefined,
    lease_token: typeof row.lease_token === "string"
      ? row.lease_token
      : undefined,
    app_slug: typeof row.app_slug === "string" ? row.app_slug : undefined,
    app_name: typeof row.app_name === "string" ? row.app_name : undefined,
  };
}

function expectedBinding(
  session: BuilderHandoffSessionRecord,
): BuilderHandoffCandidateArchiveExpectedBinding {
  if (
    session.intent === "connect" ||
    !session.targetAppId ||
    !session.bundleId ||
    !session.sourceHash ||
    !session.attestationId ||
    !session.attestationDigest ||
    !session.documentDigest ||
    !session.reportDigest ||
    !session.releaseDigest ||
    !session.candidateArchiveDigest ||
    !session.candidateArchiveBytes ||
    !session.candidateArchiveObjects ||
    !session.uploadedVersion
  ) {
    throw new BuilderHandoffDeploymentError(
      "archive_invalid",
      "Candidate session is missing immutable release evidence",
      422,
    );
  }
  return {
    ownerId: session.ownerId,
    sessionId: session.id,
    candidateSetId: session.candidateSetId,
    targetAgentId: session.targetAppId,
    intent: session.intent,
    baseVersion: session.baseVersion,
    baseSourceHash: session.baseSourceHash,
    baseReleaseDigest: session.baseReleaseDigest,
    baseStateDigest: session.baseStateDigest,
    bundleId: session.bundleId,
    sourceHash: session.sourceHash,
    attestationId: session.attestationId,
    attestationDigest: session.attestationDigest,
    documentDigest: session.documentDigest,
    reportDigest: session.reportDigest,
    releaseDigest: session.releaseDigest,
    archiveDigest: session.candidateArchiveDigest,
    archiveByteCount: session.candidateArchiveBytes,
    archiveObjectCount: session.candidateArchiveObjects,
    version: session.uploadedVersion,
  };
}

async function readTargetApp(
  ownerId: string,
  appId: string,
  options: BuilderHandoffDeploymentServiceOptions,
  deps: BuilderHandoffDeploymentDependencies,
): Promise<CandidateTargetAppRow | null> {
  const config = serviceConfig(options);
  const query = new URLSearchParams({
    id: `eq.${appId}`,
    owner_id: `eq.${ownerId}`,
    select:
      "id,owner_id,slug,name,visibility,current_version,manifest,version_metadata,deleted_at,release_generation",
    limit: "1",
  });
  let response: Response;
  try {
    response = await deps.fetchFn(
      `${config.supabaseUrl}/rest/v1/apps?${query.toString()}`,
      { headers: serviceHeaders(config.serviceRoleKey) },
    );
  } catch {
    throw new BuilderHandoffDeploymentError(
      "service_unavailable",
      "Candidate target state is temporarily unavailable",
      503,
    );
  }
  if (!response.ok) {
    throw new BuilderHandoffDeploymentError(
      "service_unavailable",
      "Candidate target state is temporarily unavailable",
      503,
    );
  }
  const payload = await response.json().catch(() => null);
  return Array.isArray(payload)
    ? payload[0] as CandidateTargetAppRow | undefined ?? null
    : null;
}

async function readCandidateDeployment(
  session: BuilderHandoffSessionRecord,
  options: BuilderHandoffDeploymentServiceOptions,
  deps: BuilderHandoffDeploymentDependencies,
): Promise<CandidateDeploymentRow | null> {
  const config = serviceConfig(options);
  const query = new URLSearchParams({
    session_id: `eq.${session.id}`,
    owner_id: `eq.${session.ownerId}`,
    select:
      "id,session_id,owner_id,target_app_id,status,phase,version,response,error_code,error_message,completed_at",
    limit: "1",
  });
  let response: Response;
  try {
    response = await deps.fetchFn(
      `${config.supabaseUrl}/rest/v1/builder_handoff_deployments?${query.toString()}`,
      { headers: serviceHeaders(config.serviceRoleKey) },
    );
  } catch {
    throw new BuilderHandoffDeploymentError(
      "service_unavailable",
      "Candidate deployment state is temporarily unavailable",
      503,
    );
  }
  if (!response.ok) {
    throw new BuilderHandoffDeploymentError(
      "service_unavailable",
      "Candidate deployment state is temporarily unavailable",
      503,
    );
  }
  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload) || payload.length > 1) {
    throw invalidDeploymentResponse(
      "Candidate deployment persistence returned an invalid deployment list",
    );
  }
  return payload.length === 0
    ? null
    : parseCandidateDeploymentRow(payload[0], session);
}

async function currentBaseStateDigest(
  row: CandidateTargetAppRow,
): Promise<string | null> {
  if (!row.current_version) return null;
  const authoritative = [...(row.version_metadata || [])].reverse().find(
    (entry) => entry?.version === row.current_version,
  );
  const proof = authoritative
    ? findPersistedTestAttestation([authoritative], row.current_version)
    : null;
  const releaseDigest = proof?.attestation.schema_version === 2
    ? proof.attestation.qualification.release_digest
    : null;
  const sourceHash = typeof authoritative?.source_hash === "string" &&
      SHA256_PATTERN.test(authoritative.source_hash)
    ? authoritative.source_hash
    : null;
  let manifest: unknown = row.manifest ?? null;
  if (typeof manifest === "string") {
    try {
      manifest = JSON.parse(manifest);
    } catch {
      // The M6 snapshot deliberately hashes an invalid stored string as-is.
    }
  }
  return await sha256Hex(canonicalJson({
    app_id: row.id,
    current_version: row.current_version,
    source_hash: sourceHash,
    release_digest: releaseDigest,
    manifest,
  }));
}

async function invitationTarget(
  session: BuilderHandoffSessionRecord,
  options: BuilderHandoffDeploymentServiceOptions,
  deps: BuilderHandoffDeploymentDependencies,
): Promise<{
  target: LaunchCandidateTarget;
  stale: boolean;
  blocker: LaunchCandidateInvitation["blocker"];
}> {
  if (session.intent === "agent") {
    return {
      target: {
        kind: "new_agent",
        reservedAgentId: session.targetAppId!,
      },
      stale: false,
      blocker: null,
    };
  }
  const baseReleaseGeneration = releaseGeneration(session);
  const missingReliableLineage = baseReleaseGeneration === null;
  const row = await readTargetApp(
    session.ownerId,
    session.targetAppId!,
    options,
    deps,
  );
  const stateDigest = row ? await currentBaseStateDigest(row) : null;
  const currentReleaseGeneration = typeof row?.release_generation === "number"
    ? row.release_generation
    : typeof row?.release_generation === "string" &&
        /^\d+$/.test(row.release_generation)
    ? Number(row.release_generation)
    : null;
  const stale = !row ||
    row.deleted_at !== null ||
    row.visibility !== "private" ||
    row.current_version !== session.baseVersion ||
    missingReliableLineage ||
    currentReleaseGeneration !== baseReleaseGeneration ||
    stateDigest !== session.baseStateDigest;
  return {
    target: {
      kind: "extension",
      agentId: session.targetAppId!,
      agentSlug: row?.slug ?? null,
      agentName: row?.name || row?.slug || "Unavailable Agent",
      baseLineage: {
        version: session.baseVersion!,
        sourceHash: session.baseSourceHash,
        releaseDigest: session.baseReleaseDigest,
        stateDigest: session.baseStateDigest!,
      },
      currentVersion: row?.current_version ?? null,
      lineageStatus: stale ? "stale" : "current",
    },
    stale,
    blocker: missingReliableLineage
      ? {
        code: "candidate_base_generation_missing",
        message:
          "This extension candidate predates reliable release lineage. Create a fresh handoff.",
      }
      : stale
      ? {
        code: "candidate_base_stale",
        message:
          "This Agent changed after the candidate was built. Create a fresh handoff before deploying.",
      }
      : null,
  };
}

async function candidateReviewRevision(input: {
  session: BuilderHandoffSessionRecord;
  summary: BuilderHandoffVerifiedCandidateArchiveManifest;
  target: LaunchCandidateTarget;
}): Promise<string> {
  return REVIEW_REVISION_PREFIX + await sha256Hex(canonicalJson({
    schema_version: 1,
    handoff_id: input.session.id,
    status_version: input.session.statusVersion,
    archive: input.summary.archive,
    candidate: input.summary.candidate,
    release: input.summary.release,
    evidence: input.summary.evidence,
    deployment_ready: input.summary.deploymentReady,
    target: input.target,
  }));
}

async function invitationForSession(
  session: BuilderHandoffSessionRecord,
  options: BuilderHandoffDeploymentServiceOptions,
  deps: BuilderHandoffDeploymentDependencies,
): Promise<CandidateInvitationContext> {
  if (session.intent === "connect") {
    throw new BuilderHandoffDeploymentError(
      "archive_invalid",
      "Inspection-only handoffs cannot contain deployment candidates",
      422,
    );
  }
  let summary: BuilderHandoffVerifiedCandidateArchiveManifest;
  try {
    summary = await deps.loadInvitation(
      deps.archiveStore,
      expectedBinding(session),
    );
  } catch (error) {
    if (error instanceof BuilderHandoffCandidateArchiveError) {
      throw new BuilderHandoffDeploymentError(
        "archive_invalid",
        error.message,
        422,
      );
    }
    throw error;
  }
  const targetState = await invitationTarget(session, options, deps);
  const deployment = await readCandidateDeployment(session, options, deps);
  let status: LaunchCandidateStatus = "ready";
  let blocker = targetState.blocker;
  let deploymentReceipt: LaunchCandidateDeploymentReceipt | null = null;
  if (session.status === "promoted") {
    if (!deployment) {
      throw invalidDeploymentResponse(
        "Promoted candidate has no durable deployment record",
      );
    }
    deploymentReceipt = committedDeploymentReceipt(deployment, session);
    status = "deployed";
    blocker = null;
  } else if (deployment?.status === "completed") {
    throw invalidDeploymentResponse(
      "Uploaded candidate has an unpromoted completed deployment",
    );
  } else if (!summary.deploymentReady) {
    status = "blocked";
    blocker = {
      code: "candidate_resubmission_required",
      message:
        "This candidate predates deployable V2 evidence. Submit the exact tested release again.",
    };
  } else if (targetState.stale) {
    status = "stale";
  } else if (
    deployment?.status === "in_progress"
  ) {
    status = "deploying";
  } else if (
    deployment?.status === "repair_required" ||
    deployment?.status === "failed"
  ) {
    status = "blocked";
    blocker = {
      code: deployment.errorCode || "candidate_deployment_blocked",
      message: deployment.errorMessage ||
        "This deployment needs reconciliation before it can continue.",
    };
  }
  const reviewRevision = await candidateReviewRevision({
    session,
    summary,
    target: targetState.target,
  });
  const invitation: LaunchCandidateInvitation = {
    id: session.id,
    handoffId: session.id,
    intent: session.intent,
    status,
    target: targetState.target,
    archive: summary.archive,
    release: summary.release,
    evidence: summary.evidence,
    deploymentReady: status === "deployed" ? false : summary.deploymentReady,
    blocker,
    deployment: deploymentReceipt,
    reviewRevision,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  return { invitation, session, summary };
}

function invitationProjectionNow(
  options: BuilderHandoffDeploymentServiceOptions,
): Date {
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new BuilderHandoffDeploymentError(
      "invalid_request",
      "Candidate invitation requires a valid server time",
      400,
    );
  }
  return new Date(now.getTime());
}

function isRecentPromotedSession(
  session: BuilderHandoffSessionRecord,
  now: Date,
): boolean {
  if (session.status !== "promoted" || !session.promotedAt) return false;
  const promotedAt = Date.parse(session.promotedAt);
  return Number.isFinite(promotedAt) &&
    promotedAt >= now.getTime() - BUILDER_HANDOFF_RECENT_PROMOTED_WINDOW_MS &&
    promotedAt <= now.getTime() + 60_000;
}

export async function listBuilderHandoffCandidateInvitations(
  ownerId: string,
  options: BuilderHandoffDeploymentServiceOptions = {},
): Promise<LaunchCandidateInvitation[]> {
  const normalizedOwnerId = requireUuid(ownerId, "ownerId");
  const deps = dependencies(options);
  const sessions = await deps.listSessions(normalizedOwnerId, {
    fetchFn: deps.fetchFn,
    supabaseUrl: options.supabaseUrl,
    serviceRoleKey: options.serviceRoleKey,
    now: options.now,
  });
  if (
    sessions.some((session) =>
      session.status !== "uploaded" && session.status !== "promoted"
    )
  ) {
    throw invalidDeploymentResponse(
      "Candidate session persistence returned an invalid candidate cohort",
    );
  }
  const now = invitationProjectionNow(options);
  const uploaded = sessions.filter((session) => session.status === "uploaded");
  const promoted = sessions.filter((session) =>
    isRecentPromotedSession(session, now)
  );
  if (
    uploaded.length > BUILDER_HANDOFF_UPLOADED_CANDIDATE_LIMIT ||
    promoted.length > BUILDER_HANDOFF_RECENT_PROMOTED_LIMIT
  ) {
    throw invalidDeploymentResponse(
      "Candidate session persistence exceeded its bounded projection",
    );
  }
  const candidateSessions = [...uploaded, ...promoted];
  const results = await Promise.allSettled(
    candidateSessions.map((session) =>
      invitationForSession(session, options, deps)
    ),
  );
  return results.map((result, index) => {
    if (result.status === "fulfilled") return result.value.invitation;
    const session = candidateSessions[index];
    const error = result.reason;
    if (!(error instanceof BuilderHandoffDeploymentError)) throw error;
    return {
      id: session.id,
      handoffId: session.id,
      intent: session.intent as Exclude<typeof session.intent, "connect">,
      status: "blocked",
      target: session.intent === "agent"
        ? {
          kind: "new_agent",
          reservedAgentId: session.targetAppId!,
        }
        : {
          kind: "extension",
          agentId: session.targetAppId!,
          agentSlug: null,
          agentName: "Unavailable Agent",
          baseLineage: {
            version: session.baseVersion!,
            sourceHash: session.baseSourceHash,
            releaseDigest: session.baseReleaseDigest,
            stateDigest: session.baseStateDigest!,
          },
          currentVersion: null,
          lineageStatus: "stale",
        },
      archive: {
        digest: session.candidateArchiveDigest!,
        byteCount: session.candidateArchiveBytes!,
        objectCount: session.candidateArchiveObjects!,
      },
      release: {
        version: session.uploadedVersion!,
        name: "Unavailable candidate",
        description: null,
        functions: [],
        interfaces: [],
        routines: [],
        settings: [],
        network: [],
        compute: null,
        permissions: [],
      },
      evidence: {
        bundleId: session.bundleId!,
        sourceHash: session.sourceHash!,
        attestationId: session.attestationId!,
        attestationDigest: session.attestationDigest!,
        documentDigest: session.documentDigest!,
        reportDigest: session.reportDigest!,
        releaseDigest: session.releaseDigest!,
        qualification: {
          profile: "basic",
          document_digest: session.documentDigest!,
          release_digest: session.releaseDigest!,
          report_digest: session.reportDigest!,
          compiler_revision: "unavailable",
          runtime_revision: "unavailable",
          policy_revision: "unavailable",
          cases: {
            declared: 0,
            required: 0,
            passed: 0,
            optional_failed: 0,
          },
          functions: { declared: 0, exercised: 0 },
          effects: { declared: 0, exercised: 0, untested: 0 },
        },
      },
      deploymentReady: false,
      blocker: { code: error.code, message: error.message },
      deployment: null,
      reviewRevision: `${REVIEW_REVISION_PREFIX}${"0".repeat(64)}`,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    } satisfies LaunchCandidateInvitation;
  });
}

export async function getBuilderHandoffCandidateInvitation(
  ownerId: string,
  candidateId: string,
  options: BuilderHandoffDeploymentServiceOptions = {},
): Promise<LaunchCandidateInvitation | null> {
  const normalizedOwnerId = requireUuid(ownerId, "ownerId");
  const normalizedCandidateId = requireUuid(candidateId, "candidateId");
  const deps = dependencies(options);
  const session = await deps.getSession(
    normalizedOwnerId,
    normalizedCandidateId,
    {
      fetchFn: deps.fetchFn,
      supabaseUrl: options.supabaseUrl,
      serviceRoleKey: options.serviceRoleKey,
      now: options.now,
    },
  );
  if (!session) return null;
  if (
    session.status === "promoted" &&
    !isRecentPromotedSession(session, invitationProjectionNow(options))
  ) {
    return null;
  }
  if (session.status !== "uploaded" && session.status !== "promoted") {
    return null;
  }
  return (await invitationForSession(session, options, deps)).invitation;
}

function releaseGeneration(
  session: BuilderHandoffSessionRecord,
): number | null {
  const value = (session as BuilderHandoffSessionRecord & {
    baseReleaseGeneration?: number | null;
  }).baseReleaseGeneration;
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function safeSlug(name: string, appId: string): string {
  const base = name.toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "agent";
  return `${base}-${appId.replace(/-/g, "").slice(0, 8)}`;
}

async function retainExactObject(
  store: BuilderHandoffDeploymentObjectStore,
  key: string,
  file: FileUpload,
): Promise<void> {
  let existing: Uint8Array | null = null;
  try {
    existing = await store.fetchFile(key);
  } catch (error) {
    if (!(error instanceof StorageObjectNotFoundError)) {
      throw new BuilderHandoffDeploymentError(
        "service_unavailable",
        `Immutable deployment object could not be read before write: ${key}`,
        503,
      );
    }
    existing = null;
  }
  const expectedDigest = await sha256Hex(file.content);
  if (existing) {
    if (await sha256Hex(existing) !== expectedDigest) {
      throw new BuilderHandoffDeploymentError(
        "repair_required",
        `Immutable deployment object already exists with different bytes: ${key}`,
        409,
      );
    }
    return;
  }
  await store.uploadFile(key, file);
  const retained = await store.fetchFile(key).catch(() => null);
  if (
    !retained ||
    retained.byteLength !== file.content.byteLength ||
    await sha256Hex(retained) !== expectedDigest
  ) {
    throw new BuilderHandoffDeploymentError(
      "materialization_failed",
      `Deployment object could not be verified after write: ${key}`,
      503,
    );
  }
}

async function retainReleaseArtifacts(
  store: BuilderHandoffDeploymentObjectStore,
  appId: string,
  releaseDigest: string,
  snapshot: BuilderHandoffCandidateDeploymentSnapshot,
): Promise<{ storageKey: string; storageBytes: number }> {
  const storageKey = `apps/${appId}/releases/${releaseDigest}/`;
  const expectedKeys = new Set(
    snapshot.releaseArtifacts.map((file) => `${storageKey}${file.name}`),
  );
  const existingKeys = await store.listFiles(storageKey);
  const foreign = existingKeys.filter((key) => !expectedKeys.has(key));
  if (foreign.length > 0) {
    throw new BuilderHandoffDeploymentError(
      "repair_required",
      "The reserved immutable version prefix already contains unexpected objects.",
      409,
    );
  }
  await Promise.all(
    snapshot.releaseArtifacts.map((file) =>
      retainExactObject(store, `${storageKey}${file.name}`, file)
    ),
  );
  await Promise.all(
    snapshot.interfaceArtifacts.map((file) =>
      retainExactObject(
        store,
        `${interfaceArtifactPrefixForApp(appId)}${file.name}`,
        file,
      )
    ),
  );
  const finalKeys = await store.listFiles(storageKey);
  if (
    finalKeys.length !== expectedKeys.size ||
    finalKeys.some((key) => !expectedKeys.has(key))
  ) {
    throw new BuilderHandoffDeploymentError(
      "materialization_failed",
      "The immutable release object set could not be verified.",
      503,
    );
  }
  return {
    storageKey,
    storageBytes: snapshot.releaseArtifacts.reduce(
      (total, file) => total + file.content.byteLength,
      0,
    ),
  };
}

async function retainReleaseExecutable(
  appId: string,
  version: string,
  releaseDigest: string,
  code: string,
): Promise<string> {
  try {
    return await putReleaseExecutedBundle({
      appId,
      version,
      releaseDigest,
      esmCode: code,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const collision = detail.includes("different bytes");
    throw new BuilderHandoffDeploymentError(
      collision ? "repair_required" : "materialization_failed",
      collision
        ? "The canonical release executable already contains different bytes."
        : "The canonical release executable could not be signed and verified.",
      collision ? 409 : 503,
    );
  }
}

function setupPlan(
  snapshot: BuilderHandoffCandidateDeploymentSnapshot,
  randomUUID: () => string,
): { routines: Array<Record<string, unknown>> } {
  return {
    routines: (snapshot.manifest.routines ?? []).map((routine, index) => ({
      id: requireUuid(randomUUID(), `routine ${index + 1} id`),
      template_id: routine.id,
      template_version: snapshot.manifest.version,
      name: routine.label,
      description: routine.description ?? null,
      handler_function: routine.handler,
      schedule: normalizeRoutineSchedule(
        routine.default_schedule ?? { every_minutes: 5 },
      ),
      config: routine.default_config ?? {},
      budget_policy: normalizeRoutineBudgetPolicy(
        routine.budget_defaults ?? {},
      ),
      approval_policy: routine.approval_policy ?? {},
      max_concurrency: 1,
      capabilities: routineCapabilitiesFromManifest(routine.capabilities).map(
        (capability) => ({ ...capability, approved: false }),
      ),
      metadata: {
        source: "builder_handoff_deployment",
        launch_managed: true,
        launch_role: index === 0 ? "primary" : "routine",
        launch_primary: index === 0,
        template_label: routine.label,
        approval_confirmed: false,
        approval_source: "account_session_required",
      },
    })),
  };
}

function skillsMarkdown(
  snapshot: BuilderHandoffCandidateDeploymentSnapshot,
): string | null {
  const file = snapshot.releaseArtifacts.find((candidate) =>
    candidate.name === "skills.md"
  );
  if (!file) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.content);
  } catch {
    throw new BuilderHandoffDeploymentError(
      "archive_invalid",
      "The retained skills.md is not valid UTF-8.",
      422,
    );
  }
}

async function fence(
  phase: Exclude<DeploymentPhase, "claimed" | "committed">,
  state: DeploymentRpcResult,
  ownerId: string,
  leaseToken: string,
  verifiedBaseStateDigest: string | null,
  options: BuilderHandoffDeploymentServiceOptions,
  deps: BuilderHandoffDeploymentDependencies,
): Promise<DeploymentRpcResult> {
  return deploymentResult(
    await callRpc(
      "fence_builder_handoff_deployment",
      {
        deployment_id: state.deployment_id,
        owner_id: ownerId,
        lease_token: leaseToken,
        phase,
        verified_base_state_digest: verifiedBaseStateDigest,
      },
      options,
      deps,
    ),
  );
}

async function bestEffortFail(
  state: DeploymentRpcResult,
  ownerId: string,
  leaseToken: string,
  phase: DeploymentPhase,
  error: unknown,
  options: BuilderHandoffDeploymentServiceOptions,
  deps: BuilderHandoffDeploymentDependencies,
): Promise<void> {
  const known = error instanceof BuilderHandoffDeploymentError ? error : null;
  const afterSideEffects = !["claimed", "archive_verified"].includes(phase);
  const rawErrorCode = known?.causeCode || known?.code ||
    "candidate_deployment_failed";
  const errorCode = rawErrorCode.toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128) || "candidate_deployment_failed";
  try {
    await callRpc(
      "fail_builder_handoff_deployment",
      {
        deployment_id: state.deployment_id,
        owner_id: ownerId,
        lease_token: leaseToken,
        status: afterSideEffects || known?.code === "repair_required"
          ? "repair_required"
          : known?.code === "stale"
          ? "stale"
          : "failed",
        phase,
        error_code: errorCode,
        error_message: error instanceof Error
          ? error.message.slice(0, 500)
          : "Candidate deployment failed",
      },
      options,
      deps,
    );
  } catch {
    // The original failure is more useful. A later retry reconciles the lease.
  }
}

async function loadStrictDeploymentSnapshot(
  session: BuilderHandoffSessionRecord,
  deps: BuilderHandoffDeploymentDependencies,
): Promise<BuilderHandoffCandidateDeploymentSnapshot> {
  try {
    return await deps.loadSnapshot(
      deps.archiveStore,
      expectedBinding(session),
    );
  } catch (error) {
    if (error instanceof BuilderHandoffCandidateArchiveError) {
      throw new BuilderHandoffDeploymentError(
        "archive_invalid",
        error.message,
        422,
      );
    }
    throw error;
  }
}

async function verifyReconciliationState(
  state: DeploymentRpcResult,
  snapshot: BuilderHandoffCandidateDeploymentSnapshot,
  deps: BuilderHandoffDeploymentDependencies,
): Promise<void> {
  if (!(state.phase in DEPLOYMENT_PHASE_RANK)) {
    throw new BuilderHandoffDeploymentError(
      "repair_required",
      "Deployment reconciliation returned an unknown phase.",
      409,
    );
  }
  const phaseRank = DEPLOYMENT_PHASE_RANK[state.phase as DeploymentPhase];
  if (phaseRank < DEPLOYMENT_PHASE_RANK.artifacts_started) return;

  const releaseDigest = snapshot.verifiedManifest.evidence.releaseDigest;
  const releasePrefix = `apps/${state.app_id}/releases/${releaseDigest}/`;
  const expectedRelease = new Map(
    snapshot.releaseArtifacts.map((file) => [
      `${releasePrefix}${file.name}`,
      file,
    ]),
  );
  const existingKeys = await deps.archiveStore.listFiles(releasePrefix);
  if (existingKeys.some((key) => !expectedRelease.has(key))) {
    throw new BuilderHandoffDeploymentError(
      "repair_required",
      "Deployment storage contains an object outside the frozen release.",
      409,
    );
  }
  for (const key of existingKeys) {
    const expected = expectedRelease.get(key)!;
    const actual = await deps.archiveStore.fetchFile(key).catch(() => null);
    if (
      !actual ||
      actual.byteLength !== expected.content.byteLength ||
      await sha256Hex(actual) !== await sha256Hex(expected.content)
    ) {
      throw new BuilderHandoffDeploymentError(
        "repair_required",
        `Deployment storage diverged from the frozen release: ${key}`,
        409,
      );
    }
  }
  if (
    phaseRank >= DEPLOYMENT_PHASE_RANK.artifacts_verified &&
    existingKeys.length !== expectedRelease.size
  ) {
    throw new BuilderHandoffDeploymentError(
      "repair_required",
      "Deployment storage is incomplete after its verified-artifacts fence.",
      409,
    );
  }

  for (const file of snapshot.interfaceArtifacts) {
    const key = `${interfaceArtifactPrefixForApp(state.app_id)}${file.name}`;
    const actual = await deps.archiveStore.fetchFile(key).catch(() => null);
    if (
      actual !== null &&
      (
        actual.byteLength !== file.content.byteLength ||
        await sha256Hex(actual) !== await sha256Hex(file.content)
      )
    ) {
      throw new BuilderHandoffDeploymentError(
        "repair_required",
        `Interface storage diverged from the frozen release: ${key}`,
        409,
      );
    }
    if (
      phaseRank >= DEPLOYMENT_PHASE_RANK.artifacts_verified &&
      actual === null
    ) {
      throw new BuilderHandoffDeploymentError(
        "repair_required",
        `Interface storage is incomplete after its verified-artifacts fence: ${key}`,
        409,
      );
    }
  }

  if (phaseRank >= DEPLOYMENT_PHASE_RANK.artifacts_verified) {
    const retained = await loadReleaseExecutedBundle(
      state.app_id,
      releaseDigest,
    );
    const verdict = retained.code === null ? null : await verifyExecutedBundle({
      appId: state.app_id,
      esmCode: retained.code,
      attestation: retained.attestation,
      expectedVersion: state.version,
      expectedReleaseDigest: releaseDigest,
    });
    if (
      retained.code !== snapshot.executable.code ||
      verdict?.status !== "ok"
    ) {
      throw new BuilderHandoffDeploymentError(
        "repair_required",
        "The retained release executable no longer matches its signed frozen release.",
        409,
      );
    }
  }

  if (phaseRank >= DEPLOYMENT_PHASE_RANK.live_bundle_started) {
    const live = await deps.loadLiveBundle(state.app_id);
    if (
      live.code !== null &&
      (
        live.code !== snapshot.executable.code ||
        (live.attestation !== null &&
          live.attestation.version !== state.version)
      )
    ) {
      throw new BuilderHandoffDeploymentError(
        "repair_required",
        "The live executable diverged while deployment reconciliation was pending.",
        409,
      );
    }
    if (
      phaseRank >= DEPLOYMENT_PHASE_RANK.live_bundle_verified &&
      (
        live.code !== snapshot.executable.code ||
        live.attestation?.version !== state.version
      )
    ) {
      throw new BuilderHandoffDeploymentError(
        "repair_required",
        "The live executable is incomplete after its verified-bundle fence.",
        409,
      );
    }
  }
}

function completedResponse(
  candidateId: string,
  result: DeploymentRpcResult,
  fallback: { slug: string; name: string },
): LaunchCandidateDeployResponse {
  const completed = result.status === "completed" ||
    result.status === "committed" ||
    result.phase === "committed" ||
    result.code === "committed" ||
    result.code === "already_committed";
  return {
    success: completed,
    candidateId,
    deploymentId: result.deployment_id,
    status: completed ? "completed" : "pending",
    replayed: result.replayed,
    agent: completed
      ? {
        id: result.app_id,
        slug: result.app_slug || fallback.slug,
        name: result.app_name || fallback.name,
        version: result.version,
        setupRequired: true,
      }
      : null,
    message: completed
      ? "Agent deployed privately. Complete setup before explicitly activating it."
      : "Deployment is safely in progress. Retry with the same idempotency key to reconcile it.",
    generatedAt: new Date().toISOString(),
  };
}

export async function deployBuilderHandoffCandidate(
  input: DeployBuilderHandoffCandidateInput,
  options: BuilderHandoffDeploymentServiceOptions = {},
): Promise<LaunchCandidateDeployResponse> {
  const ownerId = requireUuid(input.ownerId, "ownerId");
  const candidateId = requireUuid(input.candidateId, "candidateId");
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const requestedArchiveDigest = requireDigest(
    input.archiveDigest,
    "archiveDigest",
  );
  const requestedReleaseDigest = requireDigest(
    input.releaseDigest,
    "releaseDigest",
  );
  if (
    typeof input.reviewRevision !== "string" ||
    !new RegExp(`^${REVIEW_REVISION_PREFIX}[a-f0-9]{64}$`).test(
      input.reviewRevision,
    )
  ) {
    throw new BuilderHandoffDeploymentError(
      "invalid_request",
      "reviewRevision is invalid",
      400,
    );
  }

  const deps = dependencies(options);
  const session = await deps.getSession(ownerId, candidateId, {
    fetchFn: deps.fetchFn,
    supabaseUrl: options.supabaseUrl,
    serviceRoleKey: options.serviceRoleKey,
  });
  if (
    !session ||
    (session.status !== "uploaded" && session.status !== "promoted")
  ) {
    throw new BuilderHandoffDeploymentError(
      "not_found",
      "Candidate not found",
      404,
    );
  }
  const promotedReplay = session.status === "promoted";
  let invitation: LaunchCandidateInvitation | null = null;
  if (promotedReplay) {
    // A commit promotes the handoff in the same transaction that stores the
    // completed response. A lost HTTP response must therefore be able to
    // reach the database's existing-deployment replay branch without
    // re-reading the now-changed live target or mutable deployment bytes.
    expectedBinding(session);
    if (
      session.candidateArchiveDigest !== requestedArchiveDigest ||
      session.releaseDigest !== requestedReleaseDigest
    ) {
      throw new BuilderHandoffDeploymentError(
        "stale",
        "The completed deployment does not match the reviewed candidate.",
        409,
      );
    }
  } else {
    const invitationContext = await invitationForSession(
      session,
      options,
      deps,
    );
    invitation = invitationContext.invitation;
    if (
      invitation.reviewRevision !== input.reviewRevision ||
      invitation.archive.digest !== requestedArchiveDigest ||
      invitation.evidence.releaseDigest !== requestedReleaseDigest
    ) {
      throw new BuilderHandoffDeploymentError(
        "stale",
        "The candidate changed after it was reviewed. Review the latest invitation and try again.",
        409,
      );
    }
    if (
      !invitation.deploymentReady ||
      invitation.status === "stale" ||
      invitation.status === "blocked"
    ) {
      throw new BuilderHandoffDeploymentError(
        invitation.status === "stale" ? "stale" : "archive_invalid",
        invitation.blocker?.message || "This candidate is not deployable.",
        invitation.status === "stale" ? 409 : 422,
        invitation.blocker?.code,
      );
    }
  }

  const baseReleaseGeneration = releaseGeneration(session);
  if (session.intent !== "agent" && baseReleaseGeneration === null) {
    throw new BuilderHandoffDeploymentError(
      "stale",
      "This extension candidate predates reliable release lineage. Create a fresh handoff.",
      409,
    );
  }
  const leaseToken = requireUuid(deps.randomUUID(), "leaseToken");
  const requestPayload = {
    owner_id: ownerId,
    session_id: session.id,
    candidate_archive_digest: requestedArchiveDigest,
    release_digest: requestedReleaseDigest,
    target_app_id: session.targetAppId,
    version: session.uploadedVersion,
    base_state_digest: session.baseStateDigest,
    base_release_generation: baseReleaseGeneration,
    review_revision: input.reviewRevision,
  };
  const requestFingerprint = await sha256Hex(canonicalJson(requestPayload));
  let state = deploymentResult(
    await callRpc(
      "claim_builder_handoff_deployment",
      {
        ...requestPayload,
        idempotency_key: idempotencyKey,
        request_fingerprint: requestFingerprint,
        lease_token: leaseToken,
      },
      options,
      deps,
    ),
  );
  const fallbackName = invitation?.release.name || "Deployed Agent";
  const fallbackAgent = {
    slug: invitation?.target.kind === "extension" &&
        invitation.target.agentSlug
      ? invitation.target.agentSlug
      : safeSlug(fallbackName, state.app_id),
    name: fallbackName,
  };
  if (
    state.status === "completed" ||
    state.status === "committed" ||
    state.phase === "committed" ||
    state.code === "already_committed"
  ) {
    return completedResponse(candidateId, state, fallbackAgent);
  }
  if (
    state.status === "repair_required" ||
    state.status === "failed" ||
    state.status === "stale"
  ) {
    throw new BuilderHandoffDeploymentError(
      state.status === "stale" ? "stale" : "repair_required",
      state.status === "stale"
        ? "This Agent changed after the candidate was built. Create a fresh handoff and review the new candidate."
        : "This deployment needs reconciliation before it can continue.",
      409,
      state.code,
    );
  }
  if (promotedReplay) {
    throw new BuilderHandoffDeploymentError(
      "repair_required",
      "The promoted candidate has no matching completed deployment result.",
      409,
      state.code,
    );
  }
  if (
    state.code === "in_progress" &&
    state.replayed &&
    !state.requires_reconciliation
  ) {
    return completedResponse(candidateId, state, fallbackAgent);
  }

  let activeLeaseToken = state.lease_token || leaseToken;
  let reconciledSnapshot:
    | BuilderHandoffCandidateDeploymentSnapshot
    | undefined;
  if (state.requires_reconciliation) {
    reconciledSnapshot = await loadStrictDeploymentSnapshot(session, deps);
    await verifyReconciliationState(state, reconciledSnapshot, deps);
    const reconciledLease = requireUuid(
      deps.randomUUID(),
      "reconciliation leaseToken",
    );
    state = deploymentResult(
      await callRpc(
        "reconcile_builder_handoff_deployment_lease",
        {
          deployment_id: state.deployment_id,
          owner_id: ownerId,
          new_lease_token: reconciledLease,
          request_fingerprint: requestFingerprint,
          observed_phase: state.phase,
          external_state_verified: true,
        },
        options,
        deps,
      ),
    );
    activeLeaseToken = state.lease_token || reconciledLease;
  }

  let phase: DeploymentPhase = "claimed";
  try {
    const snapshot = reconciledSnapshot ??
      await loadStrictDeploymentSnapshot(session, deps);
    state = await fence(
      "archive_verified",
      state,
      ownerId,
      activeLeaseToken,
      session.baseStateDigest,
      options,
      deps,
    );
    phase = "archive_verified";

    state = await fence(
      "artifacts_started",
      state,
      ownerId,
      activeLeaseToken,
      session.baseStateDigest,
      options,
      deps,
    );
    phase = "artifacts_started";
    const retained = await retainReleaseArtifacts(
      deps.archiveStore,
      state.app_id,
      session.releaseDigest!,
      snapshot,
    );
    const executableKey = await retainReleaseExecutable(
      state.app_id,
      state.version,
      session.releaseDigest!,
      snapshot.executable.code,
    );
    state = await fence(
      "artifacts_verified",
      state,
      ownerId,
      activeLeaseToken,
      session.baseStateDigest,
      options,
      deps,
    );
    phase = "artifacts_verified";

    let d1: D1Status = {
      provisioned: false,
      status: "skipped",
      migrations_applied: 0,
      migrations_skipped: 0,
      migration_errors: [],
    };
    if (snapshot.migrations.length > 0) {
      state = await fence(
        "migrations_started",
        state,
        ownerId,
        activeLeaseToken,
        session.baseStateDigest,
        options,
        deps,
      );
      phase = "migrations_started";
      d1 = await deps.provisionAndMigrate(state.app_id, snapshot.migrations);
      if (d1.status !== "ready" || d1.error) {
        throw new BuilderHandoffDeploymentError(
          "repair_required",
          `Database setup failed: ${d1.error || "unknown migration error"}`,
          409,
        );
      }
      state = await fence(
        "migrations_verified",
        state,
        ownerId,
        activeLeaseToken,
        session.baseStateDigest,
        options,
        deps,
      );
      phase = "migrations_verified";
    }

    state = await fence(
      "live_bundle_started",
      state,
      ownerId,
      activeLeaseToken,
      session.baseStateDigest,
      options,
      deps,
    );
    phase = "live_bundle_started";
    await deps.putLiveBundle({
      appId: state.app_id,
      version: state.version,
      esmCode: snapshot.executable.code,
    });
    const live = await deps.loadLiveBundle(state.app_id);
    if (
      live.code !== snapshot.executable.code ||
      live.attestation?.version !== state.version
    ) {
      throw new BuilderHandoffDeploymentError(
        "repair_required",
        "The live executable could not be read back with the expected release identity.",
        409,
      );
    }
    state = await fence(
      "live_bundle_verified",
      state,
      ownerId,
      activeLeaseToken,
      session.baseStateDigest,
      options,
      deps,
    );
    phase = "live_bundle_verified";

    const manifestJson = canonicalJson(snapshot.manifest);
    const versionTrust = await buildVersionTrustMetadata({
      appId: state.app_id,
      version: state.version,
      runtime: "deno",
      manifest: snapshot.manifest,
      files: snapshot.releaseArtifacts,
      executable: snapshot.executable.code,
      testAttestation: snapshot.testAttestation,
      storageKey: retained.storageKey,
    });
    const metadata = buildVersionMetadataEntry(
      state.version,
      retained.storageBytes,
      versionTrust,
      session.sourceHash!,
      snapshot.testAttestation,
      session.bundleId!,
    );
    const releaseProvenance = {
      schema_version: 1,
      session_id: session.id,
      archive_digest: session.candidateArchiveDigest,
      release_digest: session.releaseDigest,
      source_hash: session.sourceHash,
      document_digest: session.documentDigest,
      report_digest: session.reportDigest,
      attestation_id: session.attestationId,
      attestation_digest: session.attestationDigest,
      executable_digest: snapshot.executable.sha256,
      executable_key: executableKey,
      compiled_spec: snapshot.manifest,
      invitation_projection: invitation,
      d1,
    };
    const appPayload = {
      slug: fallbackAgent.slug,
      name: snapshot.manifest.name,
      description: snapshot.manifest.description ?? null,
      storage_key: retained.storageKey,
      executable_key: executableKey,
      storage_bytes: retained.storageBytes,
      exports: [...snapshot.exports],
      manifest: manifestJson,
      env_schema: resolveManifestEnvSchema(snapshot.manifest),
      skills_md: skillsMarkdown(snapshot),
    };
    const setup = setupPlan(snapshot, deps.randomUUID);
    const commitFingerprint = await sha256Hex(canonicalJson({
      app: appPayload,
      version_metadata: metadata,
      release_provenance: releaseProvenance,
      setup,
    }));
    state = deploymentResult(
      await callRpc(
        "commit_builder_handoff_deployment",
        {
          deployment_id: state.deployment_id,
          owner_id: ownerId,
          lease_token: activeLeaseToken,
          commit_fingerprint: commitFingerprint,
          app: appPayload,
          version_metadata: metadata,
          release_provenance: releaseProvenance,
          setup,
        },
        options,
        deps,
      ),
    );
    phase = "committed";
    return completedResponse(candidateId, state, fallbackAgent);
  } catch (error) {
    await bestEffortFail(
      state,
      ownerId,
      activeLeaseToken,
      phase,
      error,
      options,
      deps,
    );
    if (error instanceof BuilderHandoffDeploymentError) throw error;
    throw new BuilderHandoffDeploymentError(
      phase === "claimed" || phase === "archive_verified"
        ? "materialization_failed"
        : "repair_required",
      error instanceof Error ? error.message : "Candidate deployment failed",
      phase === "claimed" || phase === "archive_verified" ? 503 : 409,
    );
  }
}
