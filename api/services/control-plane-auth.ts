import type { RequestAuthSource } from "./request-auth.ts";

/**
 * Legacy REST management routes predate scoped Connect keys. They do not carry
 * the gx.test attestation or action-level authorization used by Platform MCP,
 * so only a real Galactic account session may use them. Connected agents keep
 * their bounded build/operate path through gx.*.
 */
export function isAccountSessionAuthSource(
  source: RequestAuthSource | string | null | undefined,
): boolean {
  return source === "supabase";
}

/** Constant-time comparison for the service credential on global artifact writes. */
export function matchesServiceCredential(
  presented: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!presented || !expected || presented.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < presented.length; index++) {
    diff |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}
