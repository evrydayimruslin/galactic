import type { Env } from "../lib/env.ts";
import { getEnv } from "../lib/env.ts";
import {
  isComputeCredentialIsolated,
  isComputeOperatorTokenUsable,
} from "./compute-credential-isolation.ts";

export type ComputeEmergencyStopAuthorization =
  | { status: "authorized"; operatorReference: string }
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
  // Both operands are SHA-256 digests, so this loop always compares 32 bytes.
  // Do not replace it with string equality: this credential guards the global
  // Compute stop/release lane exposed at the public API edge.
  let difference = left.length ^ right.length;
  for (let index = 0; index < 32; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer ([^\s]+)$/u);
  return match?.[1] ?? "";
}

function digestHex(digest: Uint8Array): string {
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Authenticate the dedicated global Compute stop/release credential.
 *
 * The database audit actor is derived from the configured credential digest,
 * never from request JSON. Rotating the credential therefore creates a new,
 * stable, non-secret actor fingerprint without exposing the credential itself.
 */
export async function authenticateComputeEmergencyStopOperator(
  request: Request,
  env: Partial<Env> = getEnv(),
): Promise<ComputeEmergencyStopAuthorization> {
  const expected = typeof env.COMPUTE_EMERGENCY_STOP_TOKEN === "string"
    ? env.COMPUTE_EMERGENCY_STOP_TOKEN
    : "";
  const supplied = bearerToken(request);

  // Hash both sides before deciding whether the supplied credential matches.
  // The equality operation below is fixed-width even for malformed input.
  const [expectedDigest, suppliedDigest] = await Promise.all([
    sha256(expected),
    sha256(supplied),
  ]);

  if (
    !isComputeOperatorTokenUsable(expected) ||
    !isComputeCredentialIsolated(env, "COMPUTE_EMERGENCY_STOP_TOKEN")
  ) return { status: "unavailable" };
  const digestMatches = fixedTimeEqual(expectedDigest, suppliedDigest);
  if (!isComputeOperatorTokenUsable(supplied) || !digestMatches) {
    return { status: "unauthorized" };
  }

  return {
    status: "authorized",
    operatorReference: `compute-emergency-stop:sha256:${
      digestHex(expectedDigest)
    }`,
  };
}
