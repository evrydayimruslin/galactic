export const AUTH_SERVICE_UNAVAILABLE = "AUTH_SERVICE_UNAVAILABLE";
export const AUTH_API_TOKEN_INVALID = "AUTH_API_TOKEN_INVALID";
export const AUTH_TOKEN_EXPIRED = "AUTH_TOKEN_EXPIRED";

type ApiTokenAuthenticationFailure = "invalid" | "expired";

/**
 * A caller-controlled API key failed verification. These errors are safe to
 * expose as a 401, but intentionally never include the key, its prefix, or a
 * database error.
 */
export class ApiTokenAuthenticationError extends Error {
  readonly code: typeof AUTH_API_TOKEN_INVALID | typeof AUTH_TOKEN_EXPIRED;
  readonly status = 401;
  readonly reason: ApiTokenAuthenticationFailure;

  constructor(reason: ApiTokenAuthenticationFailure) {
    super(reason === "expired" ? "API token has expired" : "Invalid API token");
    this.name = "ApiTokenAuthenticationError";
    this.reason = reason;
    this.code = reason === "expired"
      ? AUTH_TOKEN_EXPIRED
      : AUTH_API_TOKEN_INVALID;
  }
}

/**
 * Token verification could not reach or trust its authoritative store. This
 * must never be downgraded to an invalid-credential verdict: clients can retry
 * a 503, while minting/replacing a valid credential would not help.
 */
export class AuthServiceUnavailableError extends Error {
  readonly code = AUTH_SERVICE_UNAVAILABLE;
  readonly status = 503;

  constructor() {
    super("Authentication service is temporarily unavailable");
    this.name = "AuthServiceUnavailableError";
  }
}

function errorCode(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as { code?: unknown }).code;
}

export function isApiTokenAuthenticationError(
  value: unknown,
): value is ApiTokenAuthenticationError {
  const code = errorCode(value);
  return value instanceof ApiTokenAuthenticationError ||
    code === AUTH_API_TOKEN_INVALID || code === AUTH_TOKEN_EXPIRED;
}

function isAuthServiceUnavailableError(
  value: unknown,
): value is AuthServiceUnavailableError {
  return value instanceof AuthServiceUnavailableError ||
    errorCode(value) === AUTH_SERVICE_UNAVAILABLE;
}

interface PublicAuthenticationError {
  status: 401 | 503;
  type:
    | typeof AUTH_API_TOKEN_INVALID
    | typeof AUTH_TOKEN_EXPIRED
    | typeof AUTH_SERVICE_UNAVAILABLE;
  message: string;
}

/** Canonical, secret-free projection for HTTP/JSON-RPC boundaries. */
export function classifyPublicAuthenticationError(
  value: unknown,
): PublicAuthenticationError | null {
  if (isAuthServiceUnavailableError(value)) {
    return {
      status: 503,
      type: AUTH_SERVICE_UNAVAILABLE,
      message: "Authentication service is temporarily unavailable",
    };
  }
  if (!isApiTokenAuthenticationError(value)) return null;
  const code = errorCode(value);
  if (code === AUTH_TOKEN_EXPIRED) {
    return {
      status: 401,
      type: AUTH_TOKEN_EXPIRED,
      message: "API token has expired",
    };
  }
  return {
    status: 401,
    type: AUTH_API_TOKEN_INVALID,
    message: "Invalid API token",
  };
}
