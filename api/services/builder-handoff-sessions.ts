import { getEnv } from "../lib/env.ts";

export const BUILDER_HANDOFF_TTL_SECONDS = 3_600;
export const BUILDER_HANDOFF_DESCRIPTION_MAX_LENGTH = 4_000;
export const BUILDER_HANDOFF_UPLOADED_CANDIDATE_LIMIT = 10;
export const BUILDER_HANDOFF_RECENT_PROMOTED_LIMIT = 10;
export const BUILDER_HANDOFF_RECENT_PROMOTED_WINDOW_MS = 7 * 24 * 60 * 60 *
  1_000;
/**
 * Keep the durable handoff lookup inside the same public authentication
 * latency class as API-token authentication. Cloudflare fetch can otherwise
 * inherit a roughly minute-long network timeout.
 */
export const BUILDER_HANDOFF_AUTH_TIMEOUT_MS = 8_000;
const BUILDER_HANDOFF_AUTH_TIMEOUT_MAX_MS = 9_000;

const BUILDER_HANDOFF_SESSION_SELECT = [
  "id",
  "token_id",
  "owner_id",
  "candidate_set_id",
  "intent",
  "target_app_id",
  "base_version",
  "base_source_hash",
  "base_release_digest",
  "base_state_digest",
  "base_release_generation",
  "status",
  "status_version",
  "lineage_revision",
  "description_sha256",
  "bundle_id",
  "source_hash",
  "attestation_id",
  "attestation_digest",
  "document_digest",
  "report_digest",
  "release_digest",
  "candidate_archive_digest",
  "candidate_archive_bytes",
  "candidate_archive_objects",
  "uploaded_app_id",
  "uploaded_version",
  "created_at",
  "expires_at",
  "updated_at",
  "connected_at",
  "staged_at",
  "tested_at",
  "uploaded_at",
  "promoted_at",
  "credential_revoked_at",
  "terminal_at",
].join(",");

/**
 * Temporary read compatibility for a PostgREST schema cache that has not yet
 * learned the M7 lineage column. This is intentionally limited to candidate
 * review list/detail reads. A legacy row is always projected with a null
 * generation so it cannot acquire deployment authority from the fallback.
 */
const BUILDER_HANDOFF_SESSION_LEGACY_SELECT = BUILDER_HANDOFF_SESSION_SELECT
  .split(",").filter((field) => field !== "base_release_generation").join(",");

export const BUILDER_HANDOFF_INTENTS = [
  "agent",
  "interface",
  "function",
  "routine",
  "connect",
] as const;

export const BUILDER_HANDOFF_STATUSES = [
  "created",
  "connected",
  "staged",
  "tested",
  "uploaded",
  "promoted",
  "cancelled",
  "rejected",
  "revoked",
  "expired",
] as const;

export const BUILDER_HANDOFF_TERMINAL_STATUSES = [
  "cancelled",
  "rejected",
  "revoked",
  "expired",
] as const;

export type BuilderHandoffIntent = typeof BUILDER_HANDOFF_INTENTS[number];
export type BuilderHandoffStatus = typeof BUILDER_HANDOFF_STATUSES[number];
export type BuilderHandoffTerminalStatus =
  typeof BUILDER_HANDOFF_TERMINAL_STATUSES[number];
export type BuilderHandoffAdvanceEvent =
  | "stage"
  | "test"
  | "upload"
  | "promote";

export interface BuilderHandoffSessionRecord {
  id: string;
  tokenId: string;
  ownerId: string;
  candidateSetId: string;
  intent: BuilderHandoffIntent;
  targetAppId: string | null;
  baseVersion: string | null;
  baseSourceHash: string | null;
  baseReleaseDigest: string | null;
  baseStateDigest: string | null;
  baseReleaseGeneration: number | null;
  status: BuilderHandoffStatus;
  statusVersion: number;
  lineageRevision: number;
  descriptionSha256: string;
  bundleId: string | null;
  sourceHash: string | null;
  attestationId: string | null;
  attestationDigest: string | null;
  documentDigest: string | null;
  reportDigest: string | null;
  releaseDigest: string | null;
  candidateArchiveDigest: string | null;
  candidateArchiveBytes: number | null;
  candidateArchiveObjects: number | null;
  uploadedAppId: string | null;
  uploadedVersion: string | null;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  connectedAt: string | null;
  stagedAt: string | null;
  testedAt: string | null;
  uploadedAt: string | null;
  promotedAt: string | null;
  credentialRevokedAt: string | null;
  terminalAt: string | null;
}

/**
 * Safe durable projection for launch/UI code. The owner and ephemeral token
 * mapping remain server-side; no plaintext description is persisted.
 */
export type BuilderHandoffSessionProjection = Omit<
  BuilderHandoffSessionRecord,
  "ownerId" | "tokenId"
>;

export interface BuilderHandoffCredential {
  id: string;
  tokenPrefix: string;
  plaintextToken: string;
  scopes: string[];
  appIds: string[] | null;
  createdAt: string;
  expiresAt: string;
}

interface CreateBuilderHandoffSessionBase {
  ownerId: string;
  description: string;
  now?: Date | string;
}

export type CreateBuilderHandoffSessionInput =
  | (CreateBuilderHandoffSessionBase & {
    intent: "agent";
    targetAppId?: never;
  })
  | (CreateBuilderHandoffSessionBase & {
    intent: "interface" | "function" | "routine";
    targetAppId: string;
    baseVersion: string;
    baseSourceHash: string | null;
    baseReleaseDigest: string | null;
    baseStateDigest: string;
    baseReleaseGeneration: number;
  })
  | (CreateBuilderHandoffSessionBase & {
    intent: "connect";
    targetAppId?: never;
  });

export interface AuthenticateBuilderHandoffSessionInput {
  ownerId: string;
  tokenId: string;
  scopes: string[];
  now?: Date | string;
}

interface AdvanceBuilderHandoffSessionBase {
  ownerId: string;
  tokenId: string;
  now?: Date | string;
}

export type AdvanceBuilderHandoffSessionInput =
  | (AdvanceBuilderHandoffSessionBase & {
    event: "stage";
    bundleId: string;
    sourceHash: string;
  })
  | (AdvanceBuilderHandoffSessionBase & {
    event: "test";
    bundleId: string;
    sourceHash: string;
    attestationId: string;
    attestationDigest: string;
    documentDigest: string;
    reportDigest: string;
    releaseDigest: string;
  })
  | (AdvanceBuilderHandoffSessionBase & {
    event: "upload";
    bundleId: string;
    sourceHash: string;
    attestationId: string;
    attestationDigest: string;
    documentDigest: string;
    reportDigest: string;
    releaseDigest: string;
    archiveDigest: string;
    archiveByteCount: number;
    archiveObjectCount: number;
    appId: string;
    version: string;
  })
  | (AdvanceBuilderHandoffSessionBase & {
    event: "promote";
    appId: string;
    releaseDigest: string;
    version: string;
  });

export interface TerminateBuilderHandoffSessionInput {
  ownerId: string;
  tokenId: string;
  status: BuilderHandoffTerminalStatus;
  now?: Date | string;
}

export interface BuilderHandoffSessionServiceOptions {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  randomUUID?: () => string;
  randomBytes?: (length: number) => Uint8Array;
  /** Focused-test override; production callers remain capped at 9 seconds. */
  authenticationTimeoutMs?: number;
  diagnostic?: (diagnostic: BuilderHandoffSessionDiagnostic) => void;
}

type BuilderHandoffSessionDiagnostic =
  | {
    event:
      | "promoted_history_row_omitted"
      | "promoted_history_query_suppressed";
    code: BuilderHandoffSessionErrorCode;
  }
  | { event: "legacy_session_select_used" };

export type BuilderHandoffSessionErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "expired"
  | "consumed"
  | "conflict"
  | "quota_exceeded"
  | "service_unavailable"
  | "invalid_response";

export class BuilderHandoffSessionError extends Error {
  constructor(
    public readonly code: BuilderHandoffSessionErrorCode,
    message: string,
    public readonly rpcCode?: string,
  ) {
    super(message);
    this.name = "BuilderHandoffSessionError";
  }
}

/**
 * True only when the transition is known not to have committed. Transport
 * failures and malformed success responses are deliberately excluded because
 * Postgres may already reference the candidate archive.
 */
export function isDefinitiveBuilderHandoffTransitionRejection(
  error: unknown,
): error is BuilderHandoffSessionError {
  return error instanceof BuilderHandoffSessionError &&
    error.code !== "service_unavailable" &&
    error.code !== "invalid_response";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BUNDLE_ID_PATTERN = /^gxb1_[0-9a-f]{64}$/;
const TOKEN_PREFIX_PATTERN = /^gx_[0-9a-f]{5}$/;
const ACTIVE_AUTH_STATUSES = new Set<BuilderHandoffStatus>([
  "connected",
  "staged",
  "tested",
]);
const TERMINAL_STATUS_SET = new Set<BuilderHandoffStatus>(
  BUILDER_HANDOFF_TERMINAL_STATUSES,
);
const INTENT_SET = new Set<string>(BUILDER_HANDOFF_INTENTS);
const STATUS_SET = new Set<string>(BUILDER_HANDOFF_STATUSES);

function fixedScopes(intent: BuilderHandoffIntent): string[] {
  return ["apps:read", "agents:build", `handoff:${intent}`];
}

/**
 * Recognizes the exact descriptive scope set for a Builder handoff. This does
 * not grant authority by itself: callers must also resolve the durable session
 * mapping through authenticateBuilderHandoffSession on every request.
 */
export function isBuilderHandoffScopeSet(
  scopes: readonly string[] | null | undefined,
  expectedIntent?: BuilderHandoffIntent,
): boolean {
  if (!Array.isArray(scopes) || scopes.length !== 3) return false;
  const unique = new Set(scopes);
  if (
    unique.size !== 3 ||
    !unique.has("apps:read") ||
    !unique.has("agents:build")
  ) {
    return false;
  }
  const handoffScopes = scopes.filter((scope) => scope.startsWith("handoff:"));
  if (handoffScopes.length !== 1) return false;
  const intent = handoffScopes[0].slice("handoff:".length);
  return INTENT_SET.has(intent) &&
    (expectedIntent === undefined || intent === expectedIntent);
}

export function projectBuilderHandoffSession(
  session: BuilderHandoffSessionRecord,
): BuilderHandoffSessionProjection {
  const { ownerId: _ownerId, tokenId: _tokenId, ...projection } = session;
  return projection;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new BuilderHandoffSessionError(
      "invalid_request",
      `Builder handoff requires a valid ${field}`,
    );
  }
  return value.toLowerCase();
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new BuilderHandoffSessionError(
      "invalid_request",
      `Builder handoff requires a lowercase SHA-256 ${field}`,
    );
  }
  return value;
}

function requireBundleId(value: unknown): string {
  if (typeof value !== "string" || !BUNDLE_ID_PATTERN.test(value)) {
    throw new BuilderHandoffSessionError(
      "invalid_request",
      "Builder handoff requires a valid staged bundle ID",
    );
  }
  return value;
}

function requireBoundedText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new BuilderHandoffSessionError(
      "invalid_request",
      `Builder handoff requires a valid ${field}`,
    );
  }
  return value;
}

function resolveNow(
  inputNow: Date | string | undefined,
  options: BuilderHandoffSessionServiceOptions,
): Date {
  const value = inputNow === undefined
    ? (options.now?.() ?? new Date())
    : inputNow instanceof Date
    ? new Date(inputNow.getTime())
    : new Date(inputNow);
  if (!Number.isFinite(value.getTime())) {
    throw new BuilderHandoffSessionError(
      "invalid_request",
      "Builder handoff requires a valid server time",
    );
  }
  return value;
}

function randomBytes(
  length: number,
  options: BuilderHandoffSessionServiceOptions,
): Uint8Array {
  const value = options.randomBytes
    ? options.randomBytes(length)
    : crypto.getRandomValues(new Uint8Array(length));
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new BuilderHandoffSessionError(
      "invalid_request",
      "Builder handoff random source returned invalid bytes",
    );
  }
  return new Uint8Array(value);
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Hex(
  value: string,
  keyMaterial: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );
  return bytesToHex(new Uint8Array(signature));
}

function serviceConfig(options: BuilderHandoffSessionServiceOptions): {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchFn: typeof fetch;
} {
  const supabaseUrl = options.supabaseUrl ?? getEnv("SUPABASE_URL");
  const serviceRoleKey = options.serviceRoleKey ??
    getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new BuilderHandoffSessionError(
      "service_unavailable",
      "Builder handoff persistence is not configured",
    );
  }
  return {
    supabaseUrl: supabaseUrl.replace(/\/+$/, ""),
    serviceRoleKey,
    fetchFn: options.fetchFn ?? fetch,
  };
}

function rpcErrorCode(value: unknown): string | undefined {
  let serialized = "";
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  return serialized.match(/BUILDER_HANDOFF_[A-Z_]+/)?.[0];
}

function mapRpcFailure(
  code: string | undefined,
): BuilderHandoffSessionErrorCode {
  if (!code) return "service_unavailable";
  if (
    code === "BUILDER_HANDOFF_ARCHIVE_QUOTA_EXCEEDED" ||
    code === "BUILDER_HANDOFF_SESSION_LIMIT"
  ) {
    return "quota_exceeded";
  }
  if (
    code.endsWith("_INVALID") ||
    code === "BUILDER_HANDOFF_CLOCK_INVALID" ||
    code === "BUILDER_HANDOFF_EXPIRY_INVALID"
  ) {
    return "invalid_request";
  }
  if (code.endsWith("_NOT_FOUND") || code.endsWith("_UNAUTHORIZED")) {
    return "unauthorized";
  }
  if (code === "BUILDER_HANDOFF_TERMINAL" || code.endsWith("_COMPLETED")) {
    return "consumed";
  }
  return "conflict";
}

function rpcFailureMessage(code: string | undefined): string {
  if (code === "BUILDER_HANDOFF_SESSION_LIMIT") {
    return "At most 10 active or pending coding-agent handoffs are allowed";
  }
  if (code === "BUILDER_HANDOFF_ARCHIVE_QUOTA_EXCEEDED") {
    return "Pending coding-agent candidate archives cannot exceed 100 MB";
  }
  return "Builder handoff persistence rejected the operation";
}

async function callRpc(
  name: string,
  body: Record<string, unknown>,
  options: BuilderHandoffSessionServiceOptions,
  timeoutMs?: number,
): Promise<unknown> {
  const config = serviceConfig(options);
  // Cloudflare's global fetch is receiver-sensitive. Calling the stored
  // transport as config.fetchFn(...) binds `this` to config and throws an
  // Illegal invocation before the handoff RPC reaches PostgREST.
  const fetchFn = config.fetchFn;
  const abortController = timeoutMs === undefined
    ? undefined
    : new AbortController();
  const operation = (async (): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchFn(
        `${config.supabaseUrl}/rest/v1/rpc/${name}`,
        {
          method: "POST",
          headers: {
            apikey: config.serviceRoleKey,
            Authorization: `Bearer ${config.serviceRoleKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          ...(abortController ? { signal: abortController.signal } : {}),
        },
      );
    } catch {
      throw new BuilderHandoffSessionError(
        "service_unavailable",
        "Builder handoff persistence is temporarily unavailable",
      );
    }

    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      const code = rpcErrorCode(payload);
      throw new BuilderHandoffSessionError(
        mapRpcFailure(code),
        rpcFailureMessage(code),
        code,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new BuilderHandoffSessionError(
        "invalid_response",
        "Builder handoff persistence returned invalid JSON",
      );
    }
  })();

  if (timeoutMs === undefined) return await operation;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      abortController!.abort();
      reject(
        new BuilderHandoffSessionError(
          "service_unavailable",
          "Builder handoff persistence is temporarily unavailable",
        ),
      );
    }, timeoutMs);
  });
  try {
    // The race is intentional even though the real fetch honors AbortSignal:
    // it also bounds a broken/custom fetch implementation that ignores abort.
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function authenticationTimeoutMs(
  options: BuilderHandoffSessionServiceOptions,
): number {
  const configured = options.authenticationTimeoutMs;
  if (
    configured === undefined ||
    !Number.isFinite(configured) ||
    configured < 1
  ) {
    return BUILDER_HANDOFF_AUTH_TIMEOUT_MS;
  }
  return Math.min(
    Math.floor(configured),
    BUILDER_HANDOFF_AUTH_TIMEOUT_MAX_MS,
  );
}

function emitBuilderHandoffSessionDiagnostic(
  options: BuilderHandoffSessionServiceOptions,
  diagnostic: BuilderHandoffSessionDiagnostic,
): void {
  try {
    if (options.diagnostic) {
      options.diagnostic(diagnostic);
      return;
    }
    // Diagnostic fields are closed enums. Never include the row, endpoint,
    // response payload, status, or thrown message in this signal.
    console.warn(
      "[BUILDER_HANDOFF] Candidate persistence diagnostic",
      diagnostic,
    );
  } catch {
    // Observability is best-effort and cannot change invitation availability.
  }
}

function rowObject(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  return row as Record<string, unknown>;
}

function responseUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      `Builder handoff persistence returned an invalid ${field}`,
    );
  }
  return value.toLowerCase();
}

function responseNullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : responseUuid(value, field);
}

function responseDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      `Builder handoff persistence returned an invalid ${field}`,
    );
  }
  return value;
}

function responseNullableDigest(value: unknown, field: string): string | null {
  return value === null ? null : responseDigest(value, field);
}

function responseDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      `Builder handoff persistence returned an invalid ${field}`,
    );
  }
  return value;
}

function responseNullableDate(value: unknown, field: string): string | null {
  return value === null ? null : responseDate(value, field);
}

function responseInteger(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      `Builder handoff persistence returned an invalid ${field}`,
    );
  }
  return Number(parsed);
}

function responseNullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : responseInteger(value, field);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      `Builder handoff persistence returned an invalid ${field}`,
    );
  }
  return value;
}

function parseSession(value: unknown): BuilderHandoffSessionRecord {
  const row = rowObject(value);
  if (!row) {
    throw new BuilderHandoffSessionError(
      "unauthorized",
      "Builder handoff session was not found",
    );
  }
  const id = responseUuid(row.id, "session ID");
  const tokenId = responseUuid(row.token_id, "token ID");
  const ownerId = responseUuid(row.owner_id, "owner ID");
  const candidateSetId = responseUuid(
    row.candidate_set_id,
    "candidate-set ID",
  );
  if (
    typeof row.intent !== "string" ||
    !INTENT_SET.has(row.intent)
  ) {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      "Builder handoff persistence returned an invalid intent",
    );
  }
  const intent = row.intent as BuilderHandoffIntent;
  const targetAppId = responseNullableUuid(
    row.target_app_id,
    "target Agent ID",
  );
  if (
    id !== tokenId ||
    id === candidateSetId ||
    (targetAppId !== null &&
      (targetAppId === id || targetAppId === candidateSetId)) ||
    (intent === "connect" ? targetAppId !== null : targetAppId === null)
  ) {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      "Builder handoff persistence returned inconsistent identities",
    );
  }
  if (typeof row.status !== "string" || !STATUS_SET.has(row.status)) {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      "Builder handoff persistence returned an invalid status",
    );
  }
  const status = row.status as BuilderHandoffStatus;
  const createdAt = responseDate(row.created_at, "creation time");
  const expiresAt = responseDate(row.expires_at, "expiry");
  if (
    Date.parse(expiresAt) - Date.parse(createdAt) !==
      BUILDER_HANDOFF_TTL_SECONDS * 1_000
  ) {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      "Builder handoff persistence changed the exact 60-minute expiry",
    );
  }

  const record: BuilderHandoffSessionRecord = {
    id,
    tokenId,
    ownerId,
    candidateSetId,
    intent,
    targetAppId,
    baseVersion: nullableString(row.base_version, "base version"),
    baseSourceHash: responseNullableDigest(
      row.base_source_hash,
      "base source hash",
    ),
    baseReleaseDigest: responseNullableDigest(
      row.base_release_digest,
      "base release digest",
    ),
    baseStateDigest: responseNullableDigest(
      row.base_state_digest,
      "base state digest",
    ),
    baseReleaseGeneration: responseNullableInteger(
      row.base_release_generation,
      "base release generation",
    ),
    status,
    statusVersion: responseInteger(row.status_version, "status version"),
    lineageRevision: responseInteger(
      row.lineage_revision,
      "lineage revision",
    ),
    descriptionSha256: responseDigest(
      row.description_sha256,
      "description digest",
    ),
    bundleId: nullableString(row.bundle_id, "bundle ID"),
    sourceHash: responseNullableDigest(row.source_hash, "source hash"),
    attestationId: nullableString(row.attestation_id, "attestation ID"),
    attestationDigest: responseNullableDigest(
      row.attestation_digest,
      "attestation digest",
    ),
    documentDigest: responseNullableDigest(
      row.document_digest,
      "document digest",
    ),
    reportDigest: responseNullableDigest(row.report_digest, "report digest"),
    releaseDigest: responseNullableDigest(
      row.release_digest,
      "release digest",
    ),
    candidateArchiveDigest: responseNullableDigest(
      row.candidate_archive_digest,
      "candidate archive digest",
    ),
    candidateArchiveBytes: responseNullableInteger(
      row.candidate_archive_bytes,
      "candidate archive byte count",
    ),
    candidateArchiveObjects: responseNullableInteger(
      row.candidate_archive_objects,
      "candidate archive object count",
    ),
    uploadedAppId: responseNullableUuid(
      row.uploaded_app_id,
      "uploaded Agent ID",
    ),
    uploadedVersion: nullableString(row.uploaded_version, "uploaded version"),
    createdAt,
    expiresAt,
    updatedAt: responseDate(row.updated_at, "update time"),
    connectedAt: responseNullableDate(row.connected_at, "connection time"),
    stagedAt: responseNullableDate(row.staged_at, "stage time"),
    testedAt: responseNullableDate(row.tested_at, "test time"),
    uploadedAt: responseNullableDate(row.uploaded_at, "upload time"),
    promotedAt: responseNullableDate(row.promoted_at, "promotion time"),
    credentialRevokedAt: responseNullableDate(
      row.credential_revoked_at,
      "credential revocation time",
    ),
    terminalAt: responseNullableDate(row.terminal_at, "terminal time"),
  };
  validateSessionShape(record);
  return record;
}

function validateSessionShape(session: BuilderHandoffSessionRecord): void {
  const hasBaseLineage = session.intent === "interface" ||
      session.intent === "function" ||
      session.intent === "routine"
    ? session.baseVersion !== null &&
      /^\d+\.\d+\.\d+$/.test(session.baseVersion) &&
      session.baseStateDigest !== null &&
      // M7 deliberately preserved pre-M7 extension handoffs with a null
      // generation so the invitation can tell the owner to rebuild them.
      // Creation and deployment still require an exact generation; rejecting
      // the row here would make one legacy candidate hide the entire cohort.
      (session.baseReleaseGeneration === null ||
        session.baseReleaseGeneration >= 0)
    : session.baseVersion === null &&
      session.baseSourceHash === null &&
      session.baseReleaseDigest === null &&
      session.baseStateDigest === null &&
      session.baseReleaseGeneration === null;
  const hasStagedLineage = session.lineageRevision >= 1 &&
    session.bundleId !== null &&
    BUNDLE_ID_PATTERN.test(session.bundleId) &&
    session.sourceHash !== null &&
    session.stagedAt !== null;
  const hasTestedLineage = hasStagedLineage &&
    session.attestationId !== null &&
    session.attestationId.length >= 1 &&
    session.attestationId.length <= 128 &&
    session.attestationDigest !== null &&
    session.documentDigest !== null &&
    session.reportDigest !== null &&
    session.releaseDigest !== null &&
    session.testedAt !== null;
  const hasUploadedLineage = hasTestedLineage &&
    session.targetAppId !== null &&
    session.uploadedAppId === session.targetAppId &&
    session.uploadedVersion !== null &&
    /^\d+\.\d+\.\d+$/.test(session.uploadedVersion) &&
    session.candidateArchiveDigest !== null &&
    session.candidateArchiveBytes !== null &&
    session.candidateArchiveBytes > 0 &&
    session.candidateArchiveBytes <= 104_857_600 &&
    session.candidateArchiveObjects !== null &&
    session.candidateArchiveObjects > 0 &&
    session.candidateArchiveObjects <= 256 &&
    session.uploadedAt !== null &&
    session.credentialRevokedAt !== null;

  let valid = true;
  if (session.status === "created" || session.status === "connected") {
    valid = session.lineageRevision === 0 &&
      session.bundleId === null &&
      session.sourceHash === null &&
      session.attestationId === null &&
      session.attestationDigest === null &&
      session.documentDigest === null &&
      session.reportDigest === null &&
      session.releaseDigest === null &&
      session.candidateArchiveDigest === null &&
      session.candidateArchiveBytes === null &&
      session.candidateArchiveObjects === null &&
      session.uploadedAppId === null &&
      session.uploadedVersion === null &&
      session.credentialRevokedAt === null;
  } else if (session.status === "staged") {
    valid = hasStagedLineage &&
      session.attestationId === null &&
      session.attestationDigest === null &&
      session.documentDigest === null &&
      session.reportDigest === null &&
      session.releaseDigest === null &&
      session.candidateArchiveDigest === null &&
      session.candidateArchiveBytes === null &&
      session.candidateArchiveObjects === null &&
      session.uploadedAppId === null &&
      session.uploadedVersion === null &&
      session.credentialRevokedAt === null;
  } else if (session.status === "tested") {
    valid = hasTestedLineage &&
      session.uploadedAppId === null &&
      session.uploadedVersion === null &&
      session.candidateArchiveDigest === null &&
      session.candidateArchiveBytes === null &&
      session.candidateArchiveObjects === null &&
      session.credentialRevokedAt === null;
  } else if (session.status === "uploaded") {
    valid = hasUploadedLineage && session.promotedAt === null;
  } else if (session.status === "promoted") {
    valid = hasUploadedLineage && session.promotedAt !== null;
  } else {
    valid = session.terminalAt !== null &&
      session.credentialRevokedAt !== null;
  }
  if (!hasBaseLineage || !valid) {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      "Builder handoff persistence returned an inconsistent lifecycle",
    );
  }
}

function randomUuid(
  options: BuilderHandoffSessionServiceOptions,
  used: Set<string>,
): string {
  const generate = options.randomUUID ?? (() => crypto.randomUUID());
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = requireUuid(generate(), "generated UUID");
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new BuilderHandoffSessionError(
    "invalid_request",
    "Builder handoff random source repeated an identity",
  );
}

function validateDescription(
  value: unknown,
  intent: BuilderHandoffIntent,
): string {
  if (typeof value !== "string") {
    throw new BuilderHandoffSessionError(
      "invalid_request",
      "Builder handoff description must be a string",
    );
  }
  const description = value.trim();
  if (intent !== "connect" && description.length === 0) {
    throw new BuilderHandoffSessionError(
      "invalid_request",
      "Builder handoff requires a description",
    );
  }
  if (description.length > BUILDER_HANDOFF_DESCRIPTION_MAX_LENGTH) {
    throw new BuilderHandoffSessionError(
      "invalid_request",
      `Builder handoff description must be ${BUILDER_HANDOFF_DESCRIPTION_MAX_LENGTH} characters or less`,
    );
  }
  return description;
}

function rpcNow(value: Date): string {
  return value.toISOString();
}

function ensureExpectedStatus(
  session: BuilderHandoffSessionRecord,
  expected: BuilderHandoffStatus,
): BuilderHandoffSessionRecord {
  if (session.status === "expired") {
    throw new BuilderHandoffSessionError(
      "expired",
      "Builder handoff credential has expired",
    );
  }
  if (
    TERMINAL_STATUS_SET.has(session.status) ||
    session.status === "uploaded" ||
    session.status === "promoted"
  ) {
    if (session.status !== expected) {
      throw new BuilderHandoffSessionError(
        "consumed",
        "Builder handoff credential has already been consumed",
      );
    }
  }
  if (session.status !== expected) {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      "Builder handoff persistence returned an unexpected status",
    );
  }
  return session;
}

export async function createBuilderHandoffSession(
  input: CreateBuilderHandoffSessionInput,
  options: BuilderHandoffSessionServiceOptions = {},
): Promise<{
  session: BuilderHandoffSessionRecord;
  credential: BuilderHandoffCredential;
}> {
  const ownerId = requireUuid(input.ownerId, "owner ID");
  if (!INTENT_SET.has(input.intent)) {
    throw new BuilderHandoffSessionError(
      "invalid_request",
      "Builder handoff intent is invalid",
    );
  }
  const description = validateDescription(input.description, input.intent);
  const now = resolveNow(input.now, options);
  const used = new Set<string>();
  const sessionId = randomUuid(options, used);
  const candidateSetId = randomUuid(options, used);
  const targetAppId = input.intent === "agent"
    ? randomUuid(options, used)
    : input.intent === "connect"
    ? null
    : requireUuid(input.targetAppId, "target Agent ID");
  if (
    input.intent !== "agent" &&
    targetAppId !== null &&
    used.has(targetAppId)
  ) {
    throw new BuilderHandoffSessionError(
      "invalid_request",
      "Builder handoff target identity conflicts with its session",
    );
  }
  const baseVersion = input.intent === "interface" ||
      input.intent === "function" ||
      input.intent === "routine"
    ? requireBoundedText(input.baseVersion, "base version")
    : null;
  if (baseVersion !== null && !/^\d+\.\d+\.\d+$/.test(baseVersion)) {
    throw new BuilderHandoffSessionError(
      "invalid_request",
      "Builder handoff requires a canonical x.y.z base version",
    );
  }
  const baseSourceHash = input.intent === "interface" ||
      input.intent === "function" ||
      input.intent === "routine"
    ? input.baseSourceHash === null
      ? null
      : requireDigest(input.baseSourceHash, "base source hash")
    : null;
  const baseReleaseDigest = input.intent === "interface" ||
      input.intent === "function" ||
      input.intent === "routine"
    ? input.baseReleaseDigest === null
      ? null
      : requireDigest(input.baseReleaseDigest, "base release digest")
    : null;
  const baseStateDigest = input.intent === "interface" ||
      input.intent === "function" ||
      input.intent === "routine"
    ? requireDigest(input.baseStateDigest, "base state digest")
    : null;
  const baseReleaseGeneration = input.intent === "interface" ||
      input.intent === "function" ||
      input.intent === "routine"
    ? input.baseReleaseGeneration
    : null;
  if (
    baseReleaseGeneration !== null &&
    (!Number.isSafeInteger(baseReleaseGeneration) ||
      baseReleaseGeneration < 0)
  ) {
    throw new BuilderHandoffSessionError(
      "invalid_request",
      "Builder handoff requires a non-negative base release generation",
    );
  }

  const plaintextToken = `gx_${bytesToHex(randomBytes(16, options))}`;
  const tokenSalt = bytesToHex(randomBytes(16, options));
  const tokenHash = await hmacSha256Hex(plaintextToken, tokenSalt);
  const descriptionSha256 = await sha256Hex(description);
  const scopes = fixedScopes(input.intent);

  const payload = await callRpc("create_builder_handoff_session", {
    p_owner_id: ownerId,
    p_session_id: sessionId,
    p_candidate_set_id: candidateSetId,
    p_intent: input.intent,
    p_target_app_id: targetAppId,
    p_base_version: baseVersion,
    p_base_source_hash: baseSourceHash,
    p_base_release_digest: baseReleaseDigest,
    p_base_state_digest: baseStateDigest,
    p_base_release_generation: baseReleaseGeneration,
    p_token_prefix: plaintextToken.slice(0, 8),
    p_token_hash: tokenHash,
    p_token_salt: tokenSalt,
    p_description_sha256: descriptionSha256,
    p_now: rpcNow(now),
  }, options);
  const session = ensureExpectedStatus(parseSession(payload), "created");
  if (
    session.id !== sessionId ||
    session.ownerId !== ownerId ||
    session.candidateSetId !== candidateSetId ||
    session.intent !== input.intent ||
    session.targetAppId !== targetAppId ||
    session.baseVersion !== baseVersion ||
    session.baseSourceHash !== baseSourceHash ||
    session.baseReleaseDigest !== baseReleaseDigest ||
    session.baseStateDigest !== baseStateDigest ||
    session.baseReleaseGeneration !== baseReleaseGeneration ||
    session.descriptionSha256 !== descriptionSha256 ||
    Date.parse(session.createdAt) !== now.getTime()
  ) {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      "Builder handoff persistence changed the creation identity",
    );
  }

  return {
    session,
    credential: {
      id: session.id,
      tokenPrefix: plaintextToken.slice(0, 8),
      plaintextToken,
      scopes,
      appIds: targetAppId === null ? null : [targetAppId],
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    },
  };
}

export async function authenticateBuilderHandoffSession(
  input: AuthenticateBuilderHandoffSessionInput,
  options: BuilderHandoffSessionServiceOptions = {},
): Promise<BuilderHandoffSessionRecord> {
  const ownerId = requireUuid(input.ownerId, "owner ID");
  const tokenId = requireUuid(input.tokenId, "token ID");
  if (!isBuilderHandoffScopeSet(input.scopes)) {
    throw new BuilderHandoffSessionError(
      "unauthorized",
      "Builder handoff scope set is invalid",
    );
  }
  const payload = await callRpc(
    "authenticate_builder_handoff_session",
    {
      p_owner_id: ownerId,
      p_token_id: tokenId,
      p_scopes: [...input.scopes],
      p_now: rpcNow(resolveNow(input.now, options)),
    },
    options,
    authenticationTimeoutMs(options),
  );
  const session = parseSession(payload);
  if (
    session.ownerId !== ownerId ||
    session.tokenId !== tokenId ||
    !isBuilderHandoffScopeSet(input.scopes, session.intent)
  ) {
    throw new BuilderHandoffSessionError(
      "unauthorized",
      "Builder handoff session does not match the credential",
    );
  }
  if (session.status === "expired") {
    throw new BuilderHandoffSessionError(
      "expired",
      "Builder handoff credential has expired",
    );
  }
  if (!ACTIVE_AUTH_STATUSES.has(session.status)) {
    throw new BuilderHandoffSessionError(
      "consumed",
      "Builder handoff credential is no longer active",
    );
  }
  return session;
}

async function readBuilderHandoffSessionRows(
  query: URLSearchParams,
  options: BuilderHandoffSessionServiceOptions,
  invalidRowPolicy: "reject" | "omit" = "reject",
  allowLegacyCandidateSelect = false,
): Promise<BuilderHandoffSessionRecord[]> {
  const config = serviceConfig(options);
  // Keep the stored Cloudflare transport receiver-free for candidate reads,
  // matching the RPC path above.
  const fetchFn = config.fetchFn;
  const request = async (requestQuery: URLSearchParams): Promise<Response> => {
    try {
      return await fetchFn(
        `${config.supabaseUrl}/rest/v1/builder_handoff_sessions?${requestQuery.toString()}`,
        {
          headers: {
            apikey: config.serviceRoleKey,
            Authorization: `Bearer ${config.serviceRoleKey}`,
          },
        },
      );
    } catch {
      throw new BuilderHandoffSessionError(
        "service_unavailable",
        "Builder handoff persistence is temporarily unavailable",
      );
    }
  };

  let response = await request(query);
  let usedLegacyCandidateSelect = false;
  // PostgREST reports an unknown selected column as a 400. Do not amplify
  // authentication, rate-limit, or infrastructure failures with a retry.
  if (response.status === 400 && allowLegacyCandidateSelect) {
    const legacyQuery = new URLSearchParams(query);
    legacyQuery.set("select", BUILDER_HANDOFF_SESSION_LEGACY_SELECT);
    response = await request(legacyQuery);
    usedLegacyCandidateSelect = true;
  }
  if (!response.ok) {
    throw new BuilderHandoffSessionError(
      "service_unavailable",
      "Builder handoff persistence is temporarily unavailable",
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      "Builder handoff persistence returned invalid JSON",
    );
  }
  if (!Array.isArray(payload)) {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      "Builder handoff persistence returned an invalid session list",
    );
  }
  const rows: unknown[] = usedLegacyCandidateSelect
    ? payload.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return value;
      }
      return {
        ...(value as Record<string, unknown>),
        base_release_generation: null,
      };
    })
    : payload;
  let sessions: BuilderHandoffSessionRecord[];
  if (invalidRowPolicy === "reject") {
    sessions = rows.map(parseSession);
  } else {
    sessions = [];
    for (const row of rows) {
      try {
        sessions.push(parseSession(row));
      } catch (error) {
        // Promoted rows are recovery receipts, never deployment authority. A
        // malformed historical receipt must not hide valid receipts or an
        // actionable uploaded candidate, while every other read remains strict.
        if (error instanceof BuilderHandoffSessionError) {
          emitBuilderHandoffSessionDiagnostic(options, {
            event: "promoted_history_row_omitted",
            code: error.code,
          });
          continue;
        }
        throw error;
      }
    }
  }
  if (usedLegacyCandidateSelect) {
    emitBuilderHandoffSessionDiagnostic(options, {
      event: "legacy_session_select_used",
    });
  }
  return sessions;
}

/**
 * Owner-control-plane read used by the membership invitation. This service
 * deliberately reads the durable session table with the service role rather
 * than exposing a client-selectable RLS query.
 */
export async function listUploadedBuilderHandoffSessions(
  ownerId: string,
  options: BuilderHandoffSessionServiceOptions = {},
): Promise<BuilderHandoffSessionRecord[]> {
  const query = uploadedBuilderHandoffSessionsQuery(
    requireUuid(ownerId, "owner ID"),
  );
  return await readBuilderHandoffSessionRows(query, options);
}

function uploadedBuilderHandoffSessionsQuery(ownerId: string): URLSearchParams {
  return new URLSearchParams({
    owner_id: `eq.${ownerId}`,
    status: "eq.uploaded",
    select: BUILDER_HANDOFF_SESSION_SELECT,
    order: "uploaded_at.asc,id.asc",
    limit: String(BUILDER_HANDOFF_UPLOADED_CANDIDATE_LIMIT),
  });
}

/**
 * Bounded owner-control-plane projection for candidate review and recovery.
 *
 * Uploaded candidates and recent completed handoffs are queried separately so
 * deployment receipts can never crowd an actionable candidate out of the
 * invitation limit. Promoted history is both time- and count-bounded.
 */
export async function listBuilderHandoffCandidateSessions(
  ownerId: string,
  options: BuilderHandoffSessionServiceOptions = {},
): Promise<BuilderHandoffSessionRecord[]> {
  const normalizedOwnerId = requireUuid(ownerId, "owner ID");
  const now = resolveNow(undefined, options);
  const promotedAfter = new Date(
    now.getTime() - BUILDER_HANDOFF_RECENT_PROMOTED_WINDOW_MS,
  ).toISOString();
  const promotedBefore = new Date(now.getTime() + 60_000).toISOString();
  const promotedQuery = new URLSearchParams({
    owner_id: `eq.${normalizedOwnerId}`,
    status: "eq.promoted",
    promoted_at: `gte.${promotedAfter}`,
    select: BUILDER_HANDOFF_SESSION_SELECT,
    order: "promoted_at.desc,id.desc",
    limit: String(BUILDER_HANDOFF_RECENT_PROMOTED_LIMIT),
  });
  promotedQuery.append("promoted_at", `lte.${promotedBefore}`);
  const [uploaded, promoted] = await Promise.all([
    readBuilderHandoffSessionRows(
      uploadedBuilderHandoffSessionsQuery(normalizedOwnerId),
      options,
      "reject",
      true,
    ),
    readBuilderHandoffSessionRows(promotedQuery, options, "omit", true).catch(
      (error: unknown) => {
        // Recent promoted history only restores deployment receipts in the
        // invitation. Keep the authoritative uploaded-candidate read strict,
        // but do not let a transient/malformed history response take every
        // actionable candidate offline.
        if (
          error instanceof BuilderHandoffSessionError &&
          (error.code === "service_unavailable" ||
            error.code === "invalid_response")
        ) {
          emitBuilderHandoffSessionDiagnostic(options, {
            event: "promoted_history_query_suppressed",
            code: error.code,
          });
          return [];
        }
        throw error;
      },
    ),
  ]);
  return [...uploaded, ...promoted];
}

export async function getBuilderHandoffSessionForOwner(
  ownerId: string,
  sessionId: string,
  options: BuilderHandoffSessionServiceOptions = {},
): Promise<BuilderHandoffSessionRecord | null> {
  const query = new URLSearchParams({
    owner_id: `eq.${requireUuid(ownerId, "owner ID")}`,
    id: `eq.${requireUuid(sessionId, "session ID")}`,
    select: BUILDER_HANDOFF_SESSION_SELECT,
    limit: "1",
  });
  return (await readBuilderHandoffSessionRows(
    query,
    options,
    "reject",
    true,
  ))[0] ?? null;
}

function advanceBody(
  input: AdvanceBuilderHandoffSessionInput,
  options: BuilderHandoffSessionServiceOptions,
): Record<string, unknown> {
  const common: Record<string, unknown> = {
    p_owner_id: requireUuid(input.ownerId, "owner ID"),
    p_token_id: requireUuid(input.tokenId, "token ID"),
    p_event: input.event,
    p_bundle_id: null,
    p_source_hash: null,
    p_attestation_id: null,
    p_attestation_digest: null,
    p_document_digest: null,
    p_report_digest: null,
    p_release_digest: null,
    p_archive_digest: null,
    p_archive_bytes: null,
    p_archive_objects: null,
    p_app_id: null,
    p_version: null,
    p_now: rpcNow(resolveNow(input.now, options)),
  };
  if (input.event === "promote") {
    common.p_app_id = requireUuid(input.appId, "uploaded Agent ID");
    common.p_release_digest = requireDigest(
      input.releaseDigest,
      "release digest",
    );
    common.p_version = requireBoundedText(input.version, "uploaded version");
    return common;
  }

  common.p_bundle_id = requireBundleId(input.bundleId);
  common.p_source_hash = requireDigest(input.sourceHash, "source hash");
  if (input.event === "stage") return common;

  common.p_attestation_id = requireBoundedText(
    input.attestationId,
    "attestation ID",
  );
  common.p_attestation_digest = requireDigest(
    input.attestationDigest,
    "attestation digest",
  );
  common.p_document_digest = requireDigest(
    input.documentDigest,
    "document digest",
  );
  common.p_report_digest = requireDigest(input.reportDigest, "report digest");
  common.p_release_digest = requireDigest(
    input.releaseDigest,
    "release digest",
  );
  if (input.event === "upload") {
    if (
      !Number.isSafeInteger(input.archiveByteCount) ||
      input.archiveByteCount < 1 ||
      input.archiveByteCount > 104_857_600 ||
      !Number.isSafeInteger(input.archiveObjectCount) ||
      input.archiveObjectCount < 1 ||
      input.archiveObjectCount > 256
    ) {
      throw new BuilderHandoffSessionError(
        "invalid_request",
        "Builder handoff candidate archive size is invalid",
      );
    }
    common.p_archive_digest = requireDigest(
      input.archiveDigest,
      "candidate archive digest",
    );
    common.p_archive_bytes = input.archiveByteCount;
    common.p_archive_objects = input.archiveObjectCount;
    common.p_app_id = requireUuid(input.appId, "uploaded Agent ID");
    common.p_version = requireBoundedText(input.version, "uploaded version");
  }
  return common;
}

export async function advanceBuilderHandoffSession(
  input: AdvanceBuilderHandoffSessionInput,
  options: BuilderHandoffSessionServiceOptions = {},
): Promise<BuilderHandoffSessionRecord> {
  const payload = await callRpc(
    "advance_builder_handoff_session",
    advanceBody(input, options),
    options,
  );
  const expected: Record<
    BuilderHandoffAdvanceEvent,
    BuilderHandoffStatus
  > = {
    stage: "staged",
    test: "tested",
    upload: "uploaded",
    promote: "promoted",
  };
  return ensureExpectedStatus(parseSession(payload), expected[input.event]);
}

export async function terminateBuilderHandoffSession(
  input: TerminateBuilderHandoffSessionInput,
  options: BuilderHandoffSessionServiceOptions = {},
): Promise<BuilderHandoffSessionRecord> {
  if (
    !BUILDER_HANDOFF_TERMINAL_STATUSES.includes(
      input.status as BuilderHandoffTerminalStatus,
    )
  ) {
    throw new BuilderHandoffSessionError(
      "invalid_request",
      "Builder handoff terminal status is invalid",
    );
  }
  const payload = await callRpc("terminate_builder_handoff_session", {
    p_owner_id: requireUuid(input.ownerId, "owner ID"),
    p_token_id: requireUuid(input.tokenId, "token ID"),
    p_status: input.status,
    p_now: rpcNow(resolveNow(input.now, options)),
  }, options);
  const session = parseSession(payload);
  if (session.status !== input.status && session.status !== "expired") {
    throw new BuilderHandoffSessionError(
      "invalid_response",
      "Builder handoff persistence returned an unexpected terminal status",
    );
  }
  return session;
}
