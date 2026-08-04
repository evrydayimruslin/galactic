import type { Env } from "../lib/env.ts";

export type ComputePrivilegedCredential =
  | "SUPABASE_SERVICE_ROLE_KEY"
  | "COMPUTE_EMERGENCY_STOP_TOKEN"
  | "COMPUTE_CERTIFICATION_TOKEN"
  | "COMPUTE_JOB_TOKEN_PEPPER";

const COMPUTE_PRIVILEGED_CREDENTIALS: readonly ComputePrivilegedCredential[] = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "COMPUTE_EMERGENCY_STOP_TOKEN",
  "COMPUTE_CERTIFICATION_TOKEN",
  "COMPUTE_JOB_TOKEN_PEPPER",
];

const MIN_PRIVILEGED_CREDENTIAL_BYTES = 32;
const MAX_OPERATOR_TOKEN_BYTES = 512;
const OPERATOR_TOKEN_PATTERN = /^[A-Za-z0-9._~+\/-]+={0,2}$/u;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** The exact configuration shape shared by both operator bearer lanes. */
export function isComputeOperatorTokenUsable(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = byteLength(value);
  return length >= MIN_PRIVILEGED_CREDENTIAL_BYTES &&
    length <= MAX_OPERATOR_TOKEN_BYTES && OPERATOR_TOKEN_PATTERN.test(value);
}

function configuredValue(
  env: Partial<Env>,
  name: ComputePrivilegedCredential,
): string {
  const value = env[name];
  return typeof value === "string" ? value : "";
}

/**
 * A privileged credential is usable only when no other privileged lane has
 * the same non-empty value. This request-independent configuration guard keeps
 * a leaked read-only probe bearer from also authenticating to an admin,
 * emergency-stop, or worker-token authority.
 */
export function isComputeCredentialIsolated(
  env: Partial<Env>,
  name: ComputePrivilegedCredential,
): boolean {
  const expected = configuredValue(env, name);
  if (expected.length === 0) return true;
  return COMPUTE_PRIVILEGED_CREDENTIALS.every((candidate) =>
    candidate === name || configuredValue(env, candidate) !== expected
  );
}

/**
 * Admission is safe only when every privileged Compute lane has an independent
 * configured credential. Checking the complete set here prevents a collision
 * between two operator lanes from leaving job admission apparently ready.
 */
export function computePrivilegedCredentialsReady(
  env: Partial<Env>,
): { configured: boolean; isolated: boolean } {
  const values = COMPUTE_PRIVILEGED_CREDENTIALS.map((name) =>
    configuredValue(env, name)
  );
  return {
    configured: configuredValue(env, "SUPABASE_SERVICE_ROLE_KEY").length >=
        MIN_PRIVILEGED_CREDENTIAL_BYTES &&
      isComputeOperatorTokenUsable(env.COMPUTE_EMERGENCY_STOP_TOKEN) &&
      isComputeOperatorTokenUsable(env.COMPUTE_CERTIFICATION_TOKEN) &&
      configuredValue(env, "COMPUTE_JOB_TOKEN_PEPPER").length >=
        MIN_PRIVILEGED_CREDENTIAL_BYTES,
    isolated: new Set(values.filter((value) => value.length > 0)).size ===
      values.filter((value) => value.length > 0).length,
  };
}
