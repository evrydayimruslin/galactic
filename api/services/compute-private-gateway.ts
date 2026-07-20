import type { UserContext } from "../runtime/sandbox.ts";
import { handleTrustedComputePlatformMcp } from "../handlers/platform-mcp.ts";
import { createUserService, type UserProfile } from "./user.ts";
import { canonicalPlatformMcpToolName } from "./platform-mcp-authorization.ts";
import {
  executeComputeAgentFunction,
  type ComputeAgentCallPrincipal,
} from "./compute/agent-call-executor.ts";
import {
  ComputeAuthorityValidationError,
  requireComputeFunctionName,
} from "./compute/authority.ts";
import {
  confirmComputeArtifactObjectDeleted,
  getComputeRunInputArtifactBySource,
  getComputeArtifact,
  registerComputeArtifact,
  transitionComputeArtifact,
} from "./compute/artifacts.ts";
import {
  type ComputeDatabaseDeps,
  ComputeControlPlaneError,
} from "./compute/database.ts";
import {
  getComputeRun,
  getComputeRunBudget,
  getComputeRunReceipt,
} from "./compute/runs.ts";
import {
  introspectComputeJobToken,
  listComputeJobTokenAuthorities,
  type ComputeJobTokenAuthoritySnapshot,
  type ComputeJobTokenIntrospection,
} from "./compute/tokens.ts";
import type {
  ComputeArtifact,
  ComputeAuthority,
  ComputeRun,
  ComputeRunBudgetReservation,
  ComputeRunReceipt,
} from "./compute/types.ts";
import type {
  ComputePlatformGatewayPrincipal,
  TrustedComputeAgentFunctionCall,
} from "./compute-platform-gateway.ts";
import {
  handleComputeInternalRequest,
  type ComputeInternalRouteDeps,
} from "./compute/internal-routes.ts";
import { materializeComputeRunSecrets } from "./compute-secret-materializer.ts";

const PRIVATE_HOST = "galactic.internal";
const PRIVATE_PREFIX = "/v1";
const MAX_MCP_BODY_BYTES = 1024 * 1024;
const MAX_TOKEN_HEADER_BYTES = 16 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MEDIA_TYPE_PATTERN =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type TokenInput = { token: string; containerId: string };
type ExactTokenInput = TokenInput & { authority: ComputeAuthority | unknown };

type ArtifactBucket = Pick<R2Bucket, "get" | "put" | "delete">;

export interface ComputePrivateGatewayDeps extends ComputeDatabaseDeps {
  artifactBucket?: ArtifactBucket;
  createUuid?: () => string;
  introspectPrincipal?: (
    input: TokenInput,
    deps: ComputeDatabaseDeps,
  ) => Promise<ComputeJobTokenAuthoritySnapshot>;
  authorizeExact?: (
    input: ExactTokenInput,
    deps: ComputeDatabaseDeps,
  ) => Promise<ComputeJobTokenIntrospection>;
  getRun?: (
    input: {
      runId: string;
      userId: string;
      agentId: string;
      callerFunction: string;
    },
    deps: ComputeDatabaseDeps,
  ) => Promise<ComputeRun | null>;
  getBudget?: (
    input: {
      runId: string;
      userId: string;
      agentId: string;
      callerFunction: string;
    },
    deps: ComputeDatabaseDeps,
  ) => Promise<ComputeRunBudgetReservation | null>;
  getReceipt?: (
    input: {
      runId: string;
      userId: string;
      agentId: string;
      callerFunction: string;
    },
    deps: ComputeDatabaseDeps,
  ) => Promise<ComputeRunReceipt | null>;
  getInputArtifact?: typeof getComputeRunInputArtifactBySource;
  getArtifact?: typeof getComputeArtifact;
  registerArtifact?: typeof registerComputeArtifact;
  transitionArtifact?: typeof transitionComputeArtifact;
  confirmArtifactObjectDeleted?: typeof confirmComputeArtifactObjectDeleted;
  resolveUser?: (userId: string) => Promise<UserContext | null>;
  dispatchPlatformMcp?: (
    request: Request,
    principal: ComputePlatformGatewayPrincipal,
  ) => Promise<Response>;
  dispatchAgentFunction?: (
    call: TrustedComputeAgentFunctionCall,
    principal: ComputeAgentCallPrincipal,
    deps: {
      authorizeExact(input: {
        targetAgentId: string;
        functionName: string;
      }): Promise<boolean>;
    },
  ) => Promise<unknown>;
}

export interface ComputeLifecycleGatewayDeps extends ComputeInternalRouteDeps {
  internalRequestHandler?: typeof handleComputeInternalRequest;
}

interface AuthorizedPrincipal {
  runId: string;
  agentId: string;
  userId: string;
  callerFunction: string;
  expiresAt: string;
}

interface GatewayIdentity extends TokenInput {
  request: Request;
  url: URL;
}

function json(value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

function gatewayError(
  error: string,
  status: number,
  message?: string,
): Response {
  return json({ error, ...(message ? { message } : {}) }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactBearer(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  if (value.length > MAX_TOKEN_HEADER_BYTES) return null;
  const match = /^Bearer ([^\s,]+)$/u.exec(value);
  return match?.[1] ?? null;
}

function trustedContainerId(request: Request): string | null {
  const value = request.headers.get("x-galactic-container-id")?.trim() ?? "";
  if (
    value.length < 1 || value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) return null;
  return value;
}

function identity(request: Request): GatewayIdentity | Response {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" || url.hostname !== PRIVATE_HOST ||
    !url.pathname.startsWith(`${PRIVATE_PREFIX}/`)
  ) return gatewayError("not_found", 404);
  const token = exactBearer(request);
  const containerId = trustedContainerId(request);
  if (!token || !containerId) {
    return gatewayError("compute_job_unauthorized", 401);
  }
  return { request, url, token, containerId };
}

function requiredPrincipal(
  decision: ComputeJobTokenIntrospection,
): AuthorizedPrincipal | Response {
  if (!decision.allowed) {
    return gatewayError(
      decision.code === "authority_denied"
        ? "compute_authority_denied"
        : "compute_job_unauthorized",
      decision.code === "authority_denied" ? 403 : 401,
    );
  }
  if (
    !decision.runId || !decision.agentId || !decision.userId ||
    !decision.callerFunction || !decision.expiresAt
  ) return gatewayError("compute_principal_invalid", 503);
  return {
    runId: decision.runId,
    agentId: decision.agentId,
    userId: decision.userId,
    callerFunction: decision.callerFunction,
    expiresAt: decision.expiresAt,
  };
}

function samePrincipal(
  left: AuthorizedPrincipal,
  right: AuthorizedPrincipal,
): boolean {
  return left.runId === right.runId && left.agentId === right.agentId &&
    left.userId === right.userId &&
    left.callerFunction === right.callerFunction;
}

function databaseDeps(deps: ComputePrivateGatewayDeps): ComputeDatabaseDeps {
  return {
    fetchFn: deps.fetchFn,
    supabaseUrl: deps.supabaseUrl,
    serviceRoleKey: deps.serviceRoleKey,
    tokenPepper: deps.tokenPepper,
    now: deps.now,
  };
}

async function authorize(
  identity: GatewayIdentity,
  authority: ComputeAuthority,
  deps: ComputePrivateGatewayDeps,
): Promise<AuthorizedPrincipal | Response> {
  const decision = await (deps.authorizeExact ?? introspectComputeJobToken)(
    {
      token: identity.token,
      containerId: identity.containerId,
      authority,
    },
    databaseDeps(deps),
  );
  return requiredPrincipal(decision);
}

function principalOwnerInput(principal: AuthorizedPrincipal) {
  return {
    runId: principal.runId,
    userId: principal.userId,
    agentId: principal.agentId,
    callerFunction: principal.callerFunction,
  };
}

function userProfileContext(profile: UserProfile | null): UserContext | null {
  if (!profile) return null;
  return {
    id: profile.id,
    email: profile.email,
    displayName: profile.display_name,
    avatarUrl: profile.avatar_url,
    tier: profile.tier,
    provisional: false,
  };
}

async function defaultResolveUser(userId: string): Promise<UserContext | null> {
  return userProfileContext(await createUserService().getUser(userId));
}

async function readBoundedBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new ComputeControlPlaneError({
        code: "COMPUTE_REQUEST_TOO_LARGE",
        status: 413,
        message: "The private Compute request is too large.",
      });
    }
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("request body too large").catch(() => undefined);
        throw new ComputeControlPlaneError({
          code: "COMPUTE_REQUEST_TOO_LARGE",
          status: 413,
          message: "The private Compute request is too large.",
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function safeMcpRequest(original: Request, body: Uint8Array): Request {
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["MCP-Protocol-Version", "Mcp-Session-Id"]) {
    const value = original.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Request("https://compute-gateway.internal/mcp/platform", {
    method: "POST",
    headers,
    body: body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer,
  });
}

function emptyConstraints(authority: ComputeAuthority): boolean {
  return Object.keys(authority.constraints ?? {}).length === 0;
}

function allowedPlatformFunctions(
  snapshot: ComputeJobTokenAuthoritySnapshot,
): string[] {
  return snapshot.authorities.flatMap(({ authority }) =>
    authority.action === "platform.call" && emptyConstraints(authority)
      ? [authority.target.functionName]
      : []
  );
}

async function handleMcp(
  identity: GatewayIdentity,
  deps: ComputePrivateGatewayDeps,
): Promise<Response> {
  if (identity.request.method !== "POST") {
    return gatewayError("method_not_allowed", 405);
  }
  const bytes = await readBoundedBytes(identity.request, MAX_MCP_BODY_BYTES);
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return gatewayError("invalid_json", 400);
  }
  if (!isRecord(envelope)) return gatewayError("invalid_json_rpc", 400);

  const snapshot = await (
    deps.introspectPrincipal ?? listComputeJobTokenAuthorities
  )({ token: identity.token, containerId: identity.containerId }, databaseDeps(deps));
  const snapshotPrincipal = requiredPrincipal(snapshot.principal);
  if (snapshotPrincipal instanceof Response) return snapshotPrincipal;

  const method = typeof envelope.method === "string" ? envelope.method : "";
  if (method === "tools/call") {
    const params = isRecord(envelope.params) ? envelope.params : null;
    const requestedName = typeof params?.name === "string" ? params.name : "";
    if (requestedName) {
      let functionName: string;
      try {
        functionName = requireComputeFunctionName(
          canonicalPlatformMcpToolName(requestedName),
          "platformFunction",
        );
      } catch {
        return gatewayError("compute_authority_denied", 403);
      }
      const exact = await authorize(identity, {
        action: "platform.call",
        target: { kind: "platform_function", functionName },
        constraints: {},
      }, deps);
      if (exact instanceof Response) return exact;
      if (!samePrincipal(snapshotPrincipal, exact)) {
        return gatewayError("compute_principal_changed", 401);
      }
    }
  }

  const user = await (deps.resolveUser ?? defaultResolveUser)(
    snapshotPrincipal.userId,
  );
  if (!user || user.id !== snapshotPrincipal.userId) {
    return gatewayError("compute_principal_unavailable", 503);
  }
  const run = await (deps.getRun ?? getComputeRun)(
    principalOwnerInput(snapshotPrincipal),
    databaseDeps(deps),
  );
  if (!run) return gatewayError("compute_principal_unavailable", 503);

  const executeAgent = async (
    call: TrustedComputeAgentFunctionCall,
  ): Promise<unknown> => {
    const exactPrincipal: ComputeAgentCallPrincipal = {
      userId: snapshotPrincipal.userId,
      user,
      sourceAgentId: snapshotPrincipal.agentId,
      capacityAgentId: run.capacityAgentId,
      callerFunction: snapshotPrincipal.callerFunction,
      executionId: run.executionId ?? `compute:${snapshotPrincipal.runId}`,
    };
    const agentDeps = {
      authorizeExact: async (target: {
        targetAgentId: string;
        functionName: string;
      }): Promise<boolean> => {
        const exact = await authorize(identity, {
          action: "agents.call",
          target: {
            kind: "agent_function",
            agentId: target.targetAgentId,
            functionName: target.functionName,
          },
          constraints: {},
        }, deps);
        return !(exact instanceof Response) &&
          samePrincipal(snapshotPrincipal, exact);
      },
    };
    return await (deps.dispatchAgentFunction ?? executeComputeAgentFunction)(
      call,
      exactPrincipal,
      agentDeps,
    );
  };

  return await (deps.dispatchPlatformMcp ?? handleTrustedComputePlatformMcp)(
    safeMcpRequest(identity.request, bytes),
    {
      userId: snapshotPrincipal.userId,
      user,
      allowedPlatformFunctions: allowedPlatformFunctions(snapshot),
      executeAgentFunction: executeAgent,
      computeAttribution: {
        runId: snapshotPrincipal.runId,
        sourceAgentId: snapshotPrincipal.agentId,
        capacityAgentId: run.capacityAgentId,
        callerFunction: snapshotPrincipal.callerFunction,
      },
    },
  );
}

function budgetProjection(budget: ComputeRunBudgetReservation): unknown {
  return {
    run_id: budget.runId,
    billing_mode: budget.billingMode,
    rate_version: budget.rateVersion,
    rate_light_per_ms: budget.rateLightPerMs,
    reserved_wall_ms: budget.reservedWallMs,
    reserved_light: budget.reservedLight,
    actual_wall_ms: budget.actualWallMs,
    actual_light: budget.actualLight,
    released_light: budget.releasedLight,
    status: budget.status,
    expires_at: budget.expiresAt,
  };
}

async function handleBudget(
  identity: GatewayIdentity,
  deps: ComputePrivateGatewayDeps,
): Promise<Response> {
  if (identity.request.method !== "GET") {
    return gatewayError("method_not_allowed", 405);
  }
  const principal = await authorize(identity, {
    action: "budget.read",
    target: { kind: "run" },
    constraints: {},
  }, deps);
  if (principal instanceof Response) return principal;
  const budget = await (deps.getBudget ?? getComputeRunBudget)(
    principalOwnerInput(principal),
    databaseDeps(deps),
  );
  return budget
    ? json(budgetProjection(budget))
    : gatewayError("compute_budget_unavailable", 404);
}

function receiptProjection(
  run: ComputeRun,
  receipt: ComputeRunReceipt | null,
): unknown {
  if (!receipt) {
    return {
      receipt_id: run.receiptId,
      run_id: run.id,
      status: run.state,
      terminal: false,
      created_at: run.createdAt,
    };
  }
  return {
    receipt_id: receipt.id,
    run_id: receipt.runId,
    status: receipt.outcome,
    terminal: true,
    billing_mode: receipt.billingMode,
    capacity_settlement_status: receipt.capacitySettlementStatus,
    rate_version: receipt.rateVersion,
    worker_wall_ms: receipt.workerWallMs,
    teardown_allowance_ms: receipt.teardownAllowanceMs,
    billed_wall_ms: receipt.billedWallMs,
    reserved_light: receipt.reservedLight,
    actual_light: receipt.actualLight,
    released_light: receipt.releasedLight,
    created_at: receipt.createdAt,
  };
}

async function handleReceipt(
  identity: GatewayIdentity,
  deps: ComputePrivateGatewayDeps,
): Promise<Response> {
  if (identity.request.method !== "GET") {
    return gatewayError("method_not_allowed", 405);
  }
  const principal = await authorize(identity, {
    action: "receipts.read",
    target: { kind: "run" },
    constraints: {},
  }, deps);
  if (principal instanceof Response) return principal;
  const owner = principalOwnerInput(principal);
  const run = await (deps.getRun ?? getComputeRun)(owner, databaseDeps(deps));
  if (!run) return gatewayError("compute_run_not_found", 404);
  const receipt = await (deps.getReceipt ?? getComputeRunReceipt)(
    owner,
    databaseDeps(deps),
  );
  return json(receiptProjection(run, receipt));
}

function exactArtifactId(pathname: string): string | null {
  const match = /^\/v1\/artifacts\/([^/]+)$/u.exec(pathname);
  if (!match) return null;
  let value: string;
  try {
    value = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function artifactBucket(deps: ComputePrivateGatewayDeps): ArtifactBucket | null {
  const bucket = deps.artifactBucket ?? globalThis.__env?.COMPUTE_ARTIFACTS;
  return bucket && typeof bucket.get === "function" &&
      typeof bucket.put === "function" && typeof bucket.delete === "function"
    ? bucket
    : null;
}

function downloadHeaders(artifact: ComputeArtifact, size: number): Headers {
  return new Headers({
    "content-type": artifact.mediaType,
    "content-length": String(size),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    ...(artifact.sha256 ? { "x-galactic-sha256": artifact.sha256 } : {}),
  });
}

function r2ObjectSha256(object: R2Object): string | null {
  const digest = object.checksums?.sha256;
  if (!digest) return null;
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function handleArtifactGet(
  identity: GatewayIdentity,
  artifactId: string,
  deps: ComputePrivateGatewayDeps,
): Promise<Response> {
  if (identity.request.method !== "GET") {
    return gatewayError("method_not_allowed", 405);
  }
  if (identity.request.headers.has("range")) {
    return gatewayError("range_not_supported", 416);
  }
  const principal = await authorize(identity, {
    action: "artifacts.read",
    target: { kind: "run_input" },
    constraints: {},
  }, deps);
  if (principal instanceof Response) return principal;
  const artifact = await (
    deps.getInputArtifact ?? getComputeRunInputArtifactBySource
  )({
    sourceArtifactId: artifactId,
    ...principalOwnerInput(principal),
  }, databaseDeps(deps));
  if (
    !artifact || artifact.direction !== "input" || artifact.state !== "ready" ||
    !artifact.sha256 || artifact.sizeBytes === null
  ) return gatewayError("compute_input_artifact_not_found", 404);
  const bucket = artifactBucket(deps);
  if (!bucket) return gatewayError("compute_artifacts_unavailable", 503);
  const object = await bucket.get(artifact.storageKey);
  if (!object) return gatewayError("compute_artifact_storage_mismatch", 503);
  if (
    String(object.size) !== artifact.sizeBytes ||
    r2ObjectSha256(object) !== artifact.sha256
  ) {
    await object.body.cancel("artifact metadata mismatch").catch(() => undefined);
    return gatewayError("compute_artifact_storage_mismatch", 503);
  }
  return new Response(object.body, {
    status: 200,
    headers: downloadHeaders(artifact, object.size),
  });
}

function requiredContentLength(request: Request): number | null {
  const raw = request.headers.get("content-length") ?? "";
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function artifactName(url: URL): string | null {
  if ([...url.searchParams.keys()].some((key) => key !== "name")) return null;
  const name = url.searchParams.get("name")?.trim() ?? "";
  if (
    name.length < 1 || name.length > 512 || name.startsWith("/") ||
    name.includes("\\") || /[\u0000-\u001f\u007f]/u.test(name) ||
    name.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) return null;
  return name;
}

function uploadStream(
  request: Request,
  expectedBytes: number,
  maxBytes: number,
): ReadableStream<Uint8Array> | Uint8Array {
  if (!request.body) {
    if (expectedBytes !== 0) throw new Error("artifact body is missing");
    return new Uint8Array();
  }
  let seen = 0;
  const bounded = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > expectedBytes || seen > maxBytes) {
        throw new Error("artifact body exceeds its declared size");
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (seen !== expectedBytes) {
        throw new Error("artifact body does not match its declared size");
      }
    },
  });
  return request.body.pipeThrough(bounded);
}

function artifactStorageKey(
  principal: AuthorizedPrincipal,
  artifactId: string,
): string {
  return `compute-v1/${principal.userId}/${principal.agentId}/${principal.runId}/outputs/gx-${artifactId}`;
}

async function reconcileFailedArtifactUpload(input: {
  artifact: ComputeArtifact;
  principal: AuthorizedPrincipal;
  bucket: ArtifactBucket;
  deps: ComputePrivateGatewayDeps;
  sha256: string;
  size: number;
}): Promise<ComputeArtifact | null> {
  // A ready CAS may have committed even when its response was lost. Re-read
  // before deleting bytes; DB state is authoritative for compensation.
  let current: ComputeArtifact | null = null;
  try {
    current = await (input.deps.getArtifact ?? getComputeArtifact)({
      artifactId: input.artifact.id,
      ...principalOwnerInput(input.principal),
    }, databaseDeps(input.deps));
  } catch {
    return null;
  }
  if (
    current?.state === "ready" && current.sha256 === input.sha256 &&
    current.sizeBytes === String(input.size)
  ) return current;
  if (current?.state === "pending") {
    try {
      current = await (input.deps.transitionArtifact ?? transitionComputeArtifact)({
        artifactId: current.id,
        ...principalOwnerInput(input.principal),
        expectedState: "pending",
        expectedStateVersion: current.stateVersion,
        toState: "deleted",
      }, databaseDeps(input.deps));
    } catch {
      return null;
    }
  }
  if (current?.state === "deleted") {
    try {
      await input.bucket.delete(current.storageKey);
      await (
        input.deps.confirmArtifactObjectDeleted ??
          confirmComputeArtifactObjectDeleted
      )({
        artifactId: current.id,
        storageKey: current.storageKey,
        deletedAt: new Date().toISOString(),
      }, databaseDeps(input.deps));
    } catch {
      // The database-owned unpurged scan retries the exact idempotent delete and
      // confirmation. Quota remains charged until that confirmation commits.
    }
  }
  return null;
}

function artifactUploadResponse(artifact: ComputeArtifact, status = 201): Response {
  return json({
    artifact_id: artifact.id,
    name: artifact.logicalName,
    media_type: artifact.mediaType,
    sha256: artifact.sha256,
    size_bytes: artifact.sizeBytes === null ? null : Number(artifact.sizeBytes),
    state: artifact.state,
    expires_at: artifact.expiresAt,
  }, status);
}

async function handleArtifactPut(
  identity: GatewayIdentity,
  deps: ComputePrivateGatewayDeps,
): Promise<Response> {
  if (identity.request.method !== "PUT") {
    return gatewayError("method_not_allowed", 405);
  }
  const name = artifactName(identity.url);
  const size = requiredContentLength(identity.request);
  const sha256 = identity.request.headers.get("x-galactic-sha256")
    ?.trim().toLowerCase() ?? "";
  const idempotencyKey = identity.request.headers.get(
    "x-galactic-idempotency-key",
  )?.trim().toLowerCase() ?? "";
  const mediaType = identity.request.headers.get("content-type")
    ?.trim().toLowerCase() ?? "application/octet-stream";
  if (
    !name || size === null || !SHA256_PATTERN.test(sha256) ||
    !UUID_PATTERN.test(idempotencyKey) ||
    mediaType.length > 255 || !MEDIA_TYPE_PATTERN.test(mediaType)
  ) return gatewayError("invalid_artifact_upload", 400);

  const principal = await authorize(identity, {
    action: "artifacts.write",
    target: { kind: "run_output" },
    constraints: {},
  }, deps);
  if (principal instanceof Response) return principal;
  const run = await (deps.getRun ?? getComputeRun)(
    principalOwnerInput(principal),
    databaseDeps(deps),
  );
  if (!run || run.state !== "running") {
    return gatewayError("compute_outputs_frozen", 409);
  }
  const maxBytes = Number(run.policyLimits.maxArtifactBytes);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || size > maxBytes) {
    return gatewayError("compute_artifact_limit_exceeded", 413);
  }
  const bucket = artifactBucket(deps);
  if (!bucket) return gatewayError("compute_artifacts_unavailable", 503);

  const createUuid = deps.createUuid ?? (() => crypto.randomUUID());
  const artifactId = createUuid();
  if (!UUID_PATTERN.test(artifactId)) {
    return gatewayError("compute_artifacts_unavailable", 503);
  }
  const storageKey = artifactStorageKey(principal, artifactId.toLowerCase());
  const registered = await (deps.registerArtifact ?? registerComputeArtifact)({
    artifactId,
    idempotencyKey,
    ...principalOwnerInput(principal),
    storageKey,
    direction: "output",
    logicalName: name,
    mediaType,
    sha256,
    sizeBytes: size,
  }, databaseDeps(deps));
  if (registered.replayed) {
    if (
      registered.artifact.state === "ready" &&
      registered.artifact.sha256 === sha256 &&
      registered.artifact.sizeBytes === String(size)
    ) return artifactUploadResponse(registered.artifact, 200);
    if (registered.artifact.state !== "pending") {
      return gatewayError("compute_artifact_idempotency_conflict", 409);
    }
  }

  try {
    const body = uploadStream(identity.request, size, maxBytes);
    // On an idempotent retry the database may return an existing pending row
    // whose artifact id/storage key differs from this request's newly proposed
    // values. The reserved row is authoritative: writing to the proposal and
    // then marking the existing row ready would orphan the uploaded bytes.
    await bucket.put(registered.artifact.storageKey, body, {
      sha256,
      httpMetadata: { contentType: mediaType },
      customMetadata: {
        run_id: principal.runId,
        artifact_id: registered.artifact.id,
        sha256,
      },
    });
    const ready = await (deps.transitionArtifact ?? transitionComputeArtifact)({
      artifactId: registered.artifact.id,
      ...principalOwnerInput(principal),
      expectedState: "pending",
      expectedStateVersion: registered.artifact.stateVersion,
      toState: "ready",
      sha256,
      sizeBytes: size,
    }, databaseDeps(deps));
    return artifactUploadResponse(ready);
  } catch {
    const committed = await reconcileFailedArtifactUpload({
      artifact: registered.artifact,
      principal,
      bucket,
      deps,
      sha256,
      size,
    });
    if (committed) return artifactUploadResponse(committed, 200);
    return gatewayError("compute_artifact_upload_failed", 502);
  }
}

function controlPlaneError(error: unknown): Response {
  if (error instanceof ComputeAuthorityValidationError) {
    return gatewayError("compute_authority_denied", 403);
  }
  if (error instanceof ComputeControlPlaneError) {
    return gatewayError(
      error.code,
      error.status,
      error.status < 500 ? error.message : undefined,
    );
  }
  return gatewayError("compute_gateway_unavailable", 503);
}

/**
 * Private body-to-control-plane router. This function is safe to expose only
 * through the named ComputeControlPlane service binding: the body still needs
 * its opaque job bearer and the Compute Worker overwrites container identity.
 */
export async function handleComputePrivateGatewayRequest(
  request: Request,
  deps: ComputePrivateGatewayDeps = {},
): Promise<Response> {
  const resolved = identity(request);
  if (resolved instanceof Response) return resolved;
  try {
    if (resolved.url.pathname === "/v1/mcp/platform") {
      return await handleMcp(resolved, deps);
    }
    if (resolved.url.pathname === "/v1/budget") {
      return await handleBudget(resolved, deps);
    }
    if (resolved.url.pathname === "/v1/receipts/current") {
      return await handleReceipt(resolved, deps);
    }
    if (resolved.url.pathname === "/v1/artifacts") {
      return await handleArtifactPut(resolved, deps);
    }
    const artifactId = exactArtifactId(resolved.url.pathname);
    if (artifactId) return await handleArtifactGet(resolved, artifactId, deps);
    return gatewayError("not_found", 404);
  } catch (error) {
    return controlPlaneError(error);
  }
}

function terminalLifecyclePath(pathname: string): boolean {
  return /^\/internal\/compute\/runs\/[0-9a-f-]{36}\/(complete|fail|cancel-observed)$/iu
    .test(pathname);
}

function normalizedWorkerReceipt(value: unknown): unknown | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.receipt_id === "string" &&
    typeof value.run_id === "string" && typeof value.status === "string"
  ) return value;
  const outcome = typeof value.outcome === "string" ? value.outcome : "";
  if (
    typeof value.id !== "string" || typeof value.runId !== "string" ||
    !["succeeded", "failed", "cancelled", "expired", "revoked"].includes(outcome)
  ) return null;
  return {
    receipt_id: value.id,
    run_id: value.runId,
    status: outcome === "succeeded" || outcome === "cancelled"
      ? outcome
      : "failed",
  };
}

/**
 * Lifecycle half of the named service entrypoint. Its trust is structural: it
 * is never reachable from the API Worker's default fetch export, and the body
 * proxy accepts only /v1/*. Bearer-bearing requests are rejected to prevent a
 * future routing change from turning this into a confused-deputy seam.
 */
export async function handleTrustedComputeLifecycleRequest(
  request: Request,
  deps: ComputeLifecycleGatewayDeps = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" || url.hostname !== PRIVATE_HOST ||
    !url.pathname.startsWith("/internal/compute/runs/")
  ) return gatewayError("not_found", 404);
  if (
    request.headers.has("authorization") ||
    request.headers.has("x-galactic-container-id")
  ) return gatewayError("service_binding_required", 403);

  const internalHandler = deps.internalRequestHandler ??
    handleComputeInternalRequest;
  const response = await internalHandler(request, {
    ...deps,
    // The named WorkerEntrypoint is the verifier. This closure is deliberately
    // installed after spreading deps so no caller can weaken the boundary.
    verifyServiceBindingRequest: () => true,
    materializeSecretValues: deps.materializeSecretValues ??
      materializeComputeRunSecrets,
  });
  if (!response.ok || !terminalLifecyclePath(url.pathname)) return response;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return gatewayError("compute_lifecycle_invalid_response", 502);
  }
  const receipt = normalizedWorkerReceipt(payload);
  return receipt
    ? json(receipt, response.status)
    : gatewayError("compute_lifecycle_invalid_response", 502);
}
