import type { Env } from "../lib/env.ts";
import { getEnv } from "../lib/env.ts";
import {
  isComputeCredentialIsolated,
  isComputeOperatorTokenUsable,
} from "./compute-credential-isolation.ts";

const PRINCIPAL_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

export interface ComputeCertificationPrincipal {
  ownerId: string;
  agentId: string;
  entry: string;
}

export type ComputeCertificationAuthorization =
  | {
    status: "authorized";
    credentialReference: string;
    rateLimitKey: string;
    principal: ComputeCertificationPrincipal;
  }
  | { status: "unauthorized" }
  | { status: "unavailable" };

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function sha256(value: string): Promise<Uint8Array> {
  const encoded = bytes(value);
  const copy = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(copy).set(encoded);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
}

function fixedTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < 32; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization") ?? "";
  return authorization.match(/^Bearer ([^\s]+)$/u)?.[1] ?? "";
}

function digestHex(digest: Uint8Array): string {
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function rateLimitUuid(digest: Uint8Array): string {
  const derived = digest.slice(0, 16);
  derived[6] = (derived[6] & 0x0f) | 0x80;
  derived[8] = (derived[8] & 0x3f) | 0x80;
  const hex = digestHex(derived);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20, 32)}`;
}

function certificationPrincipal(
  env: Partial<Env>,
): ComputeCertificationPrincipal | null {
  const raw = typeof env.COMPUTE_CERTIFICATION_PRINCIPAL === "string"
    ? env.COMPUTE_CERTIFICATION_PRINCIPAL.trim().toLowerCase()
    : "";
  const match = raw.match(PRINCIPAL_PATTERN);
  if (!match) return null;
  return { ownerId: match[1], agentId: match[2], entry: raw };
}

/**
 * Authenticate the read-only deployed-certification lane.
 *
 * This credential is deliberately independent from the destructive global
 * emergency-stop credential. A scheduled probe can therefore inspect only a
 * bounded, sanitized persistence snapshot and cannot stop or release Compute.
 */
export async function authenticateComputeCertification(
  request: Request,
  env: Partial<Env> = getEnv(),
): Promise<ComputeCertificationAuthorization> {
  const expected = typeof env.COMPUTE_CERTIFICATION_TOKEN === "string"
    ? env.COMPUTE_CERTIFICATION_TOKEN
    : "";
  const supplied = bearerToken(request);
  const principal = certificationPrincipal(env);
  const [expectedDigest, suppliedDigest] = await Promise.all([
    sha256(expected),
    sha256(supplied),
  ]);

  if (
    !isComputeOperatorTokenUsable(expected) || !principal ||
    !isComputeCredentialIsolated(env, "COMPUTE_CERTIFICATION_TOKEN")
  ) return { status: "unavailable" };
  if (
    !isComputeOperatorTokenUsable(supplied) ||
    !fixedTimeEqual(expectedDigest, suppliedDigest)
  ) {
    return { status: "unauthorized" };
  }

  return {
    status: "authorized",
    credentialReference: `compute-certification:sha256:${
      digestHex(expectedDigest)
    }`,
    rateLimitKey: rateLimitUuid(expectedDigest),
    principal,
  };
}
