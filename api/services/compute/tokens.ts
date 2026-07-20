import { getEnv } from "../../lib/env.ts";
import {
  authorityToDatabaseValue,
  authorityFromDatabaseValue,
  canonicalizeComputeAuthority,
} from "./authority.ts";
import {
  callComputeRpc,
  type ComputeDatabaseDeps,
  firstComputeRow,
  requiredString,
} from "./database.ts";
import type { ComputeAuthority } from "./types.ts";

export const COMPUTE_JOB_TOKEN_PREFIX = "gxc_v1_";
export const COMPUTE_JOB_TOKEN_AUDIENCE = "gx-private-v1";

const TOKEN_PATTERN =
  /^gxc_v1_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i;

export interface PreparedComputeJobToken {
  token: string;
  lookupId: string;
  digest: string;
}

export interface ComputeJobTokenIntrospection {
  allowed: boolean;
  code:
    | "ok"
    | "token_invalid"
    | "token_expired"
    | "token_revoked"
    | "audience_mismatch"
    | "container_mismatch"
    | "run_not_active"
    | "agent_not_active"
    | "policy_changed"
    | "authority_denied";
  runId: string | null;
  agentId: string | null;
  userId: string | null;
  callerFunction: string | null;
  authorityId: string | null;
  expiresAt: string | null;
}

function tokenPepper(deps: ComputeDatabaseDeps): string {
  const pepper = deps.tokenPepper ?? getEnv("COMPUTE_JOB_TOKEN_PEPPER");
  if (!pepper || pepper.length < 32) {
    throw new Error(
      "COMPUTE_JOB_TOKEN_PEPPER must contain at least 32 characters",
    );
  }
  return pepper;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function computeJobTokenDigest(
  token: string,
  pepper: string,
): Promise<string> {
  if (pepper.length < 32) throw new Error("token pepper is too short");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  return bytesToHex(new Uint8Array(signature));
}

export function parseComputeJobToken(token: string): {
  lookupId: string;
  secret: string;
} | null {
  if (typeof token !== "string") return null;
  const match = token.match(TOKEN_PATTERN);
  if (!match) return null;
  return { lookupId: match[1].toLowerCase(), secret: match[2] };
}

export async function prepareComputeJobToken(
  deps: ComputeDatabaseDeps = {},
): Promise<PreparedComputeJobToken> {
  const lookupId = crypto.randomUUID();
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const token = `${COMPUTE_JOB_TOKEN_PREFIX}${lookupId}.${
    bytesToBase64Url(secretBytes)
  }`;
  return {
    token,
    lookupId,
    digest: await computeJobTokenDigest(token, tokenPepper(deps)),
  };
}

export async function verifyPreparedComputeJobToken(
  token: string,
  expectedDigest: string,
  pepper: string,
): Promise<boolean> {
  if (!parseComputeJobToken(token) || !/^[0-9a-f]{64}$/i.test(expectedDigest)) {
    return false;
  }
  const actual = await computeJobTokenDigest(token, pepper);
  if (actual.length !== expectedDigest.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^
      expectedDigest.toLowerCase().charCodeAt(index);
  }
  return difference === 0;
}

function optionalResponseString(
  row: Record<string, unknown>,
  field: string,
): string | null {
  const value = row[field];
  return typeof value === "string" && value ? value : null;
}

export async function introspectComputeJobToken(input: {
  token: string;
  /** Trusted container identity supplied by the private container gateway. */
  containerId: string;
  authority: ComputeAuthority | unknown;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeJobTokenIntrospection> {
  const parsed = parseComputeJobToken(input.token);
  if (!parsed) {
    return {
      allowed: false,
      code: "token_invalid",
      runId: null,
      agentId: null,
      userId: null,
      callerFunction: null,
      authorityId: null,
      expiresAt: null,
    };
  }
  if (
    typeof input.containerId !== "string" || !input.containerId.trim() ||
    input.containerId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(input.containerId)
  ) throw new Error("containerId is invalid");
  const containerId = input.containerId.trim();
  const authority = authorityToDatabaseValue(
    canonicalizeComputeAuthority(input.authority),
  );
  const digest = await computeJobTokenDigest(input.token, tokenPepper(deps));
  const payload = await callComputeRpc("authorize_compute_job_token", {
    p_lookup_id: parsed.lookupId,
    p_token_digest: digest,
    p_audience: COMPUTE_JOB_TOKEN_AUDIENCE,
    p_container_id: containerId,
    p_action: authority.action,
    p_resource_kind: authority.resource_kind,
    p_target_agent_id: authority.target_agent_id,
    p_target_function: authority.target_function,
    p_constraints: authority.constraints,
  }, deps);
  const row = firstComputeRow(payload, "Compute job token introspection");
  const code = requiredString(
    row,
    "code",
    "Compute job token introspection",
  ) as ComputeJobTokenIntrospection["code"];
  return {
    allowed: row.allowed === true,
    code,
    runId: optionalResponseString(row, "run_id"),
    agentId: optionalResponseString(row, "agent_id"),
    userId: optionalResponseString(row, "user_id"),
    callerFunction: optionalResponseString(row, "caller_function"),
    authorityId: optionalResponseString(row, "authority_id"),
    expiresAt: optionalResponseString(row, "expires_at"),
  };
}

function invalidIntrospection(): ComputeJobTokenIntrospection {
  return {
    allowed: false,
    code: "token_invalid",
    runId: null,
    agentId: null,
    userId: null,
    callerFunction: null,
    authorityId: null,
    expiresAt: null,
  };
}

function mapIntrospection(row: Record<string, unknown>): ComputeJobTokenIntrospection {
  return {
    allowed: row.allowed === true,
    code: requiredString(
      row,
      "code",
      "Compute job token introspection",
    ) as ComputeJobTokenIntrospection["code"],
    runId: optionalResponseString(row, "run_id"),
    agentId: optionalResponseString(row, "agent_id"),
    userId: optionalResponseString(row, "user_id"),
    callerFunction: optionalResponseString(row, "caller_function"),
    authorityId: optionalResponseString(row, "authority_id"),
    expiresAt: optionalResponseString(row, "expires_at"),
  };
}

function exactContainerId(value: unknown): string {
  if (
    typeof value !== "string" || !value.trim() || value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) throw new Error("containerId is invalid");
  return value.trim();
}

async function tokenVerifierInput(input: {
  token: string;
  containerId: string;
}, deps: ComputeDatabaseDeps): Promise<{
  lookupId: string;
  digest: string;
  containerId: string;
} | null> {
  const parsed = parseComputeJobToken(input.token);
  if (!parsed) return null;
  return {
    lookupId: parsed.lookupId,
    digest: await computeJobTokenDigest(input.token, tokenPepper(deps)),
    containerId: exactContainerId(input.containerId),
  };
}

export async function introspectComputeJobTokenPrincipal(input: {
  token: string;
  containerId: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeJobTokenIntrospection> {
  const verifier = await tokenVerifierInput(input, deps);
  if (!verifier) return invalidIntrospection();
  const payload = await callComputeRpc("introspect_compute_job_token", {
    p_lookup_id: verifier.lookupId,
    p_token_digest: verifier.digest,
    p_audience: COMPUTE_JOB_TOKEN_AUDIENCE,
    p_container_id: verifier.containerId,
  }, deps);
  return mapIntrospection(
    firstComputeRow(payload, "Compute job token principal introspection"),
  );
}

export interface ComputeJobTokenAuthoritySnapshot {
  principal: ComputeJobTokenIntrospection;
  authorities: Array<{ id: string; authority: ComputeAuthority }>;
}

export async function listComputeJobTokenAuthorities(input: {
  token: string;
  containerId: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeJobTokenAuthoritySnapshot> {
  const verifier = await tokenVerifierInput(input, deps);
  if (!verifier) return { principal: invalidIntrospection(), authorities: [] };
  const payload = await callComputeRpc("list_compute_job_token_authorities", {
    p_lookup_id: verifier.lookupId,
    p_token_digest: verifier.digest,
    p_audience: COMPUTE_JOB_TOKEN_AUDIENCE,
    p_container_id: verifier.containerId,
  }, deps);
  const row = firstComputeRow(payload, "List Compute job token authorities");
  const principal = mapIntrospection(row);
  const authorities = Array.isArray(row.authorities)
    ? row.authorities.map((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Compute authority snapshot returned an invalid row");
      }
      const authorityRow = value as Record<string, unknown>;
      return {
        id: requiredString(authorityRow, "id", "Compute authority snapshot"),
        authority: authorityFromDatabaseValue(authorityRow),
      };
    })
    : [];
  return { principal, authorities };
}
