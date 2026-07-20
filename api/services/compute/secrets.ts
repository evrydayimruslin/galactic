import {
  requireComputeCallerFunction,
  requireComputeUuid,
} from "./authority.ts";
import {
  callComputeRpc,
  type ComputeDatabaseDeps,
  firstComputeRow,
  integerString,
  queryComputeRows,
  requiredString,
} from "./database.ts";
import type {
  ComputeSecretBinding,
  ComputeSecretDelivery,
} from "./types.ts";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_ENV_PREFIXES = ["GX_", "GALACTIC_", "ULTRALIGHT_"];
export const COMPUTE_RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "GALACTIC_AGENT_TOKEN",
  "GALACTIC_HUMAN_TOKEN",
  "GALACTIC_PLATFORM_KEY",
  "GALACTIC_API_KEY",
  "GALACTIC_GATEWAY_URL",
  "GALACTIC_JOB_TOKEN_FILE",
  "GALACTIC_RUN_ID",
  "GALACTIC_LEASE_ID",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
]);

export function isComputeReservedEnvName(name: string): boolean {
  return COMPUTE_RESERVED_ENV_NAMES.has(name) ||
    RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export interface PutComputeSecretBindingInput {
  bindingId?: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  name: string;
  variableName: string;
  delivery: ComputeSecretDelivery;
  expiresAt?: string | null;
  expectedAuthorityEpoch?: string | number | bigint;
}

export interface ComputeAgentWideSecretBindingInput {
  name: string;
  variableName: string;
  delivery: ComputeSecretDelivery;
  expiresAt: string | null;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) throw new Error(`${field} contains unsupported field ${unexpected}`);
}

function exactText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (
    !normalized || normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) throw new Error(`${field} is invalid`);
  return normalized;
}

function canonicalDelivery(value: unknown): ComputeSecretDelivery {
  const delivery = asRecord(value, "delivery");
  if (delivery.kind === "raw_env") {
    onlyKeys(delivery, ["kind", "envName"], "delivery");
    const envName = delivery.envName;
    if (
      typeof envName !== "string" ||
      !ENV_NAME_PATTERN.test(envName) ||
      isComputeReservedEnvName(envName)
    ) throw new Error("raw env name is invalid or platform-reserved");
    return { kind: "raw_env", envName };
  }
  if (delivery.kind === "raw_file") {
    onlyKeys(delivery, ["kind", "fileName"], "delivery");
    if (
      typeof delivery.fileName !== "string" ||
      !FILE_NAME_PATTERN.test(delivery.fileName) ||
      delivery.fileName === "." || delivery.fileName === ".." ||
      delivery.fileName.toLowerCase().includes("job-token")
    ) throw new Error("raw file name must be a safe basename");
    return { kind: "raw_file", fileName: delivery.fileName };
  }
  throw new Error("delivery.kind must be raw_env or raw_file");
}

export function canonicalizeComputeAgentWideSecretBinding(
  value: unknown,
): ComputeAgentWideSecretBindingInput {
  const input = asRecord(value, "secret binding");
  onlyKeys(input, [
    "name",
    "variableName",
    "delivery",
    "expiresAt",
  ], "secret binding");
  const variableName = input.variableName;
  if (
    typeof variableName !== "string" ||
    !ENV_NAME_PATTERN.test(variableName) ||
    isComputeReservedEnvName(variableName)
  ) throw new Error("variableName is invalid or platform-reserved");
  return {
    name: exactText(input.name, "name", 128),
    variableName,
    delivery: canonicalDelivery(input.delivery),
    expiresAt: canonicalExpiry(input.expiresAt),
  };
}

function canonicalExpiry(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("expiresAt must be an ISO timestamp or null");
  }
  return new Date(value).toISOString();
}

function positiveEpoch(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value);
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error("expectedAuthorityEpoch must be a positive integer");
  }
  return BigInt(normalized).toString();
}

export function canonicalizeComputeSecretBindingInput(
  value: unknown,
): PutComputeSecretBindingInput {
  const input = asRecord(value, "binding");
  onlyKeys(input, [
    "bindingId",
    "userId",
    "agentId",
    "callerFunction",
    "name",
    "variableName",
    "delivery",
    "expiresAt",
    "expectedAuthorityEpoch",
  ], "binding");
  return {
    ...(input.bindingId === undefined
      ? {}
      : { bindingId: requireComputeUuid(input.bindingId, "bindingId") }),
    userId: requireComputeUuid(input.userId, "userId"),
    agentId: requireComputeUuid(input.agentId, "agentId"),
    callerFunction: requireComputeCallerFunction(input.callerFunction),
    name: exactText(input.name, "name", 128),
    variableName: (() => {
      const variableName = input.variableName;
      if (
        typeof variableName !== "string" ||
        !ENV_NAME_PATTERN.test(variableName) ||
        isComputeReservedEnvName(variableName)
      ) throw new Error("variableName is invalid or platform-reserved");
      return variableName;
    })(),
    delivery: canonicalDelivery(input.delivery),
    expiresAt: canonicalExpiry(input.expiresAt),
    ...(input.expectedAuthorityEpoch === undefined
      ? {}
      : {
        expectedAuthorityEpoch: positiveEpoch(input.expectedAuthorityEpoch) ??
          undefined,
      }),
  };
}

export function mapComputeSecretBindingRow(
  row: Record<string, unknown>,
): ComputeSecretBinding {
  const operation = "Compute secret binding";
  const deliveryKind = requiredString(row, "delivery", operation);
  let delivery: ComputeSecretDelivery;
  if (deliveryKind === "raw_env") {
    delivery = {
      kind: "raw_env",
      envName: requiredString(row, "env_name", operation),
    };
  } else if (deliveryKind === "raw_file") {
    delivery = {
      kind: "raw_file",
      fileName: requiredString(row, "file_name", operation),
    };
  } else {
    throw new Error("Compute secret binding returned an invalid delivery");
  }
  return {
    id: requiredString(row, "id", operation),
    userId: requiredString(row, "user_id", operation),
    agentId: requiredString(row, "agent_id", operation),
    callerFunction: requiredString(row, "caller_function", operation),
    name: requiredString(row, "name", operation),
    variableName: requiredString(row, "variable_name", operation),
    delivery,
    status: row.status === "revoked" ? "revoked" : "active",
    bindingVersion: integerString(row, "binding_version", operation),
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
    createdAt: requiredString(row, "created_at", operation),
    updatedAt: requiredString(row, "updated_at", operation),
  };
}

export async function putComputeSecretBinding(
  input: PutComputeSecretBindingInput | unknown,
  deps: ComputeDatabaseDeps = {},
): Promise<ComputeSecretBinding> {
  const binding = canonicalizeComputeSecretBindingInput(input);
  const deliveryKind = binding.delivery.kind;
  const payload = await callComputeRpc("put_compute_agent_secret_binding", {
    p_binding_id: binding.bindingId ?? null,
    p_user_id: binding.userId,
    p_agent_id: binding.agentId,
    p_caller_function: binding.callerFunction,
    p_name: binding.name,
    p_variable_name: binding.variableName,
    p_delivery: deliveryKind,
    p_env_name: deliveryKind === "raw_env" ? binding.delivery.envName : null,
    p_file_name: deliveryKind === "raw_file" ? binding.delivery.fileName : null,
    p_expires_at: binding.expiresAt ?? null,
    p_expected_authority_epoch: positiveEpoch(binding.expectedAuthorityEpoch),
  }, deps);
  return mapComputeSecretBindingRow(firstComputeRow(payload, "Put Compute secret binding"));
}

export async function revokeComputeSecretBinding(input: {
  bindingId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  expectedBindingVersion: string | number | bigint;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeSecretBinding> {
  const payload = await callComputeRpc("revoke_compute_agent_secret_binding", {
    p_binding_id: requireComputeUuid(input.bindingId, "bindingId"),
    p_user_id: requireComputeUuid(input.userId, "userId"),
    p_agent_id: requireComputeUuid(input.agentId, "agentId"),
    p_caller_function: requireComputeCallerFunction(input.callerFunction),
    p_expected_binding_version: positiveEpoch(input.expectedBindingVersion),
  }, deps);
  return mapComputeSecretBindingRow(firstComputeRow(payload, "Revoke Compute secret binding"));
}

export async function getActiveComputeSecretBindingByName(input: {
  userId: string;
  agentId: string;
  callerFunction: string;
  name: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeSecretBinding | null> {
  const userId = requireComputeUuid(input.userId, "userId");
  const agentId = requireComputeUuid(input.agentId, "agentId");
  const callerFunction = requireComputeCallerFunction(input.callerFunction);
  const name = exactText(input.name, "name", 128);
  const rows = await queryComputeRows(
    `compute_agent_secret_bindings?user_id=eq.${encodeURIComponent(userId)}` +
      `&agent_id=eq.${encodeURIComponent(agentId)}` +
      `&caller_function=eq.${encodeURIComponent(callerFunction)}` +
      `&name=eq.${encodeURIComponent(name)}&status=eq.active` +
      `&or=(expires_at.is.null,expires_at.gt.${encodeURIComponent((deps.now ?? new Date()).toISOString())})` +
      `&select=*&limit=1`,
    deps,
  );
  return rows[0] ? mapComputeSecretBindingRow(rows[0]) : null;
}

export async function listComputeSecretBindings(input: {
  userId: string;
  agentId: string;
  callerFunction: string;
  includeRevoked?: boolean;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeSecretBinding[]> {
  const filters = [
    `user_id=eq.${encodeURIComponent(requireComputeUuid(input.userId, "userId"))}`,
    `agent_id=eq.${encodeURIComponent(requireComputeUuid(input.agentId, "agentId"))}`,
    `caller_function=eq.${encodeURIComponent(requireComputeCallerFunction(input.callerFunction))}`,
    "select=*",
    "order=name.asc",
  ];
  if (!input.includeRevoked) filters.push("status=eq.active");
  const rows = await queryComputeRows(
    `compute_agent_secret_bindings?${filters.join("&")}`,
    deps,
  );
  return rows.map(mapComputeSecretBindingRow);
}
