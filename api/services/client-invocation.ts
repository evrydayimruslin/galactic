import { LAUNCH_CLIENT_INVOCATION_ARG } from "../../shared/contracts/launch.ts";

export const CLIENT_INVOCATION_ID_MIN_LENGTH = 8;
export const CLIENT_INVOCATION_ID_MAX_LENGTH = 128;

/** Present-but-unusable `_invocation_id`: the caller relies on this id for
 * exactly-once dispatch, so silently ignoring a malformed one would reopen
 * the double-execution window it exists to close. Handlers map this to a
 * caller error, never a 500. */
export class InvalidClientInvocationIdError extends Error {
  constructor(reason: string) {
    super(`Invalid ${LAUNCH_CLIENT_INVOCATION_ARG}: ${reason}`);
    this.name = "InvalidClientInvocationIdError";
  }
}

/**
 * Extract and strip the reserved `_invocation_id` argument.
 *
 * Mirrors the `_async` convention (platform routing, never function input) —
 * call this beside the `_async` strip, before ANY execution branch sees the
 * args. Returns null when absent; throws InvalidClientInvocationIdError when
 * present but not a string of 8–128 characters.
 */
export function extractClientInvocationId(
  args: Record<string, unknown>,
): string | null {
  if (!(LAUNCH_CLIENT_INVOCATION_ARG in args)) return null;
  const raw = args[LAUNCH_CLIENT_INVOCATION_ARG];
  delete args[LAUNCH_CLIENT_INVOCATION_ARG];
  if (typeof raw !== "string") {
    throw new InvalidClientInvocationIdError("must be a string");
  }
  if (
    raw.length < CLIENT_INVOCATION_ID_MIN_LENGTH ||
    raw.length > CLIENT_INVOCATION_ID_MAX_LENGTH
  ) {
    throw new InvalidClientInvocationIdError(
      `length must be between ${CLIENT_INVOCATION_ID_MIN_LENGTH} and ${CLIENT_INVOCATION_ID_MAX_LENGTH} characters`,
    );
  }
  return raw;
}
