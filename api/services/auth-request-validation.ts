import {
  normalizeOptionalString,
  normalizeRequiredString,
  normalizeStringArray,
  readFormUrlEncodedOrJsonObject,
  readJsonObject,
  RequestValidationError,
} from "./request-validation.ts";
export { RequestValidationError } from "./request-validation.ts";

const PKCE_ALLOWED_METHODS = new Set(["S256"]);
const DYNAMIC_CLIENT_GRANT_TYPES = new Set(["authorization_code"]);
const DYNAMIC_CLIENT_RESPONSE_TYPES = new Set(["code"]);
const TOKEN_ENDPOINT_AUTH_METHODS = new Set(["none", "client_secret_post"]);
const DISALLOWED_REDIRECT_PROTOCOLS = new Set(["javascript:", "data:"]);
const MAX_SCOPE_LENGTH = 512;
const MAX_TOKEN_LENGTH = 8192;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SLUG_REGEX = /^(?:[a-z0-9]|[a-z0-9][a-z0-9/-]{0,254}[a-z0-9])$/;

export interface SessionBootstrapPayload {
  accessToken?: string;
  refreshToken?: string;
}

export interface RefreshPayload {
  refreshToken?: string;
}

export interface DynamicClientRegistrationPayload {
  clientName?: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_post";
}

export interface OAuthAuthorizeQuery {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  state: string;
  scope: string;
}

export interface OAuthTokenExchangePayload {
  clientId?: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  grantType: "authorization_code";
  redirectUri?: string;
}

export interface OAuthRevocationPayload {
  token: string;
  tokenTypeHint?: string;
}

export interface EmbedBridgeExchangePayload {
  bridgeToken: string;
}

export interface PageShareExchangePayload {
  ownerId: string;
  slug: string;
  shareToken: string;
}

export interface PasswordAuthPayload {
  email: string;
  mode: "sign_in" | "sign_up";
  nextPath: string;
  password: string;
}

export interface MagicLinkAuthPayload {
  email: string;
  nextPath: string;
}

export interface MagicLinkVerifyPayload {
  tokenHash: string;
}

function normalizeAuthEmail(value: unknown): string {
  const email = normalizeRequiredString(value, "email", {
    maxLength: 254,
  });
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
    email.includes("\r") ||
    email.includes("\n")
  ) {
    throw new RequestValidationError("Enter a valid email address");
  }
  return email;
}

function normalizeLaunchNextPath(value: unknown): string {
  const nextPath = normalizeOptionalString(value, "next", {
    maxLength: 2048,
  }) || "/account";
  if (
    !nextPath.startsWith("/") ||
    nextPath.startsWith("//") ||
    nextPath.includes("\\")
  ) {
    throw new RequestValidationError("next must be a local path");
  }
  return nextPath;
}

function assertValidRedirectUri(uri: string, field: string, oauthErrorCode?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new RequestValidationError(`${field} must be a valid URL`, 400, oauthErrorCode);
  }

  if (DISALLOWED_REDIRECT_PROTOCOLS.has(parsed.protocol)) {
    throw new RequestValidationError(`${field} uses an unsupported URL scheme`, 400, oauthErrorCode);
  }
  if (parsed.username || parsed.password) {
    throw new RequestValidationError(`${field} must not contain embedded credentials`, 400, oauthErrorCode);
  }
  return uri;
}

function normalizePkceCodeChallenge(value: unknown): string {
  const challenge = normalizeRequiredString(value, "code_challenge");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) {
    throw new RequestValidationError("code_challenge must be 43-128 URL-safe characters");
  }
  return challenge;
}

function normalizePkceCodeVerifier(value: unknown, oauthErrorCode?: string): string {
  const verifier = normalizeRequiredString(value, "code_verifier", {
    oauthErrorCode,
  });
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    throw new RequestValidationError(
      "code_verifier must be 43-128 URL-safe characters",
      400,
      oauthErrorCode,
    );
  }
  return verifier;
}

export async function validateSessionBootstrapRequest(request: Request): Promise<SessionBootstrapPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["access_token", "refresh_token"],
  });

  const accessToken = normalizeOptionalString(body.access_token, "access_token", {
    maxLength: MAX_TOKEN_LENGTH,
  });
  const refreshToken = normalizeOptionalString(body.refresh_token, "refresh_token", {
    maxLength: MAX_TOKEN_LENGTH,
  });

  if (!accessToken && !refreshToken) {
    throw new RequestValidationError("Missing access_token or refresh_token");
  }

  return { accessToken, refreshToken };
}

export async function validateRefreshRequest(request: Request): Promise<RefreshPayload> {
  const body = await readJsonObject(request, {
    allowEmptyBody: true,
    allowedKeys: ["refresh_token"],
  });

  return {
    refreshToken: normalizeOptionalString(body.refresh_token, "refresh_token", {
      maxLength: MAX_TOKEN_LENGTH,
    }),
  };
}

export async function validateSignoutRequest(request: Request): Promise<void> {
  const body = await readJsonObject(request, {
    allowEmptyBody: true,
    allowedKeys: ["scope"],
  });

  const scope = normalizeOptionalString(body.scope, "scope");
  if (scope && scope !== "local") {
    throw new RequestValidationError('scope must be "local" when provided');
  }
}

export async function validateEmbedBridgeExchangeRequest(
  request: Request,
): Promise<EmbedBridgeExchangePayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["bridge_token"],
  });

  return {
    bridgeToken: normalizeRequiredString(body.bridge_token, "bridge_token", {
      maxLength: MAX_TOKEN_LENGTH,
    }),
  };
}

export async function validatePageShareExchangeRequest(
  request: Request,
): Promise<PageShareExchangePayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["owner_id", "slug", "share_token"],
  });

  return {
    ownerId: (() => {
      const ownerId = normalizeRequiredString(body.owner_id, "owner_id", {
        maxLength: 128,
      });
      if (!UUID_REGEX.test(ownerId)) {
        throw new RequestValidationError("owner_id must be a valid UUID");
      }
      return ownerId;
    })(),
    slug: (() => {
      const slug = normalizeRequiredString(body.slug, "slug", {
        maxLength: 256,
      });
      if (!PAGE_SLUG_REGEX.test(slug)) {
        throw new RequestValidationError("slug must use lowercase letters, numbers, hyphens, or nested path segments");
      }
      return slug;
    })(),
    shareToken: normalizeRequiredString(body.share_token, "share_token", {
      maxLength: MAX_TOKEN_LENGTH,
    }),
  };
}

export async function validatePasswordAuthRequest(
  request: Request,
): Promise<PasswordAuthPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["email", "mode", "next", "password"],
  });

  const email = normalizeAuthEmail(body.email);

  const mode = normalizeRequiredString(body.mode, "mode");
  if (mode !== "sign_in" && mode !== "sign_up") {
    throw new RequestValidationError(
      'mode must be either "sign_in" or "sign_up"',
    );
  }

  const password = normalizeOptionalString(body.password, "password", {
    maxLength: 1024,
    trim: false,
  });
  if (!password) {
    throw new RequestValidationError("Missing password");
  }
  if (mode === "sign_up" && password.length < 8) {
    throw new RequestValidationError(
      "Password must be at least 8 characters",
    );
  }

  const nextPath = normalizeLaunchNextPath(body.next);

  return {
    email,
    mode,
    nextPath,
    password,
  };
}

export async function validateMagicLinkAuthRequest(
  request: Request,
): Promise<MagicLinkAuthPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["email", "next"],
  });
  return {
    email: normalizeAuthEmail(body.email),
    nextPath: normalizeLaunchNextPath(body.next),
  };
}

export async function validateMagicLinkVerifyRequest(
  request: Request,
): Promise<MagicLinkVerifyPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["token_hash"],
  });
  return {
    tokenHash: normalizeRequiredString(body.token_hash, "token_hash", {
      maxLength: MAX_TOKEN_LENGTH,
    }),
  };
}

export async function validateDynamicClientRegistrationRequest(
  request: Request,
): Promise<DynamicClientRegistrationPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: [
      "client_name",
      "redirect_uris",
      "grant_types",
      "response_types",
      "token_endpoint_auth_method",
    ],
  });

  const redirectUris = normalizeStringArray(body.redirect_uris, "redirect_uris").map((uri) =>
    assertValidRedirectUri(uri, "redirect_uri")
  );
  const grantTypes = body.grant_types === undefined
    ? ["authorization_code"]
    : normalizeStringArray(body.grant_types, "grant_types", {
      allowedValues: DYNAMIC_CLIENT_GRANT_TYPES,
    });
  const responseTypes = body.response_types === undefined
    ? ["code"]
    : normalizeStringArray(body.response_types, "response_types", {
      allowedValues: DYNAMIC_CLIENT_RESPONSE_TYPES,
    });
  const tokenEndpointAuthMethod = normalizeOptionalString(
    body.token_endpoint_auth_method,
    "token_endpoint_auth_method",
  ) || "none";

  if (!TOKEN_ENDPOINT_AUTH_METHODS.has(tokenEndpointAuthMethod)) {
    throw new RequestValidationError(
      `token_endpoint_auth_method must be one of: ${Array.from(TOKEN_ENDPOINT_AUTH_METHODS).join(", ")}`,
    );
  }

  return {
    clientName: normalizeOptionalString(body.client_name, "client_name", {
      maxLength: 200,
    }),
    redirectUris,
    grantTypes,
    responseTypes,
    tokenEndpointAuthMethod: tokenEndpointAuthMethod as "none" | "client_secret_post",
  };
}

export function validateAuthorizeQuery(url: URL): OAuthAuthorizeQuery {
  const clientId = normalizeRequiredString(url.searchParams.get("client_id"), "client_id");
  const redirectUri = assertValidRedirectUri(
    normalizeRequiredString(url.searchParams.get("redirect_uri"), "redirect_uri"),
    "redirect_uri",
  );
  const codeChallenge = normalizePkceCodeChallenge(url.searchParams.get("code_challenge"));
  const codeChallengeMethod = normalizeOptionalString(
    url.searchParams.get("code_challenge_method"),
    "code_challenge_method",
  ) || "S256";

  if (!PKCE_ALLOWED_METHODS.has(codeChallengeMethod)) {
    throw new RequestValidationError(
      `code_challenge_method must be one of: ${Array.from(PKCE_ALLOWED_METHODS).join(", ")}`,
    );
  }

  const scope = normalizeOptionalString(url.searchParams.get("scope"), "scope", {
    maxLength: MAX_SCOPE_LENGTH,
  }) || "mcp:read mcp:write";

  return {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: codeChallengeMethod as "S256",
    state: normalizeOptionalString(url.searchParams.get("state"), "state", {
      maxLength: MAX_SCOPE_LENGTH,
      trim: false,
    }) || "",
    scope,
  };
}

export async function validateOAuthTokenExchangeRequest(
  request: Request,
): Promise<OAuthTokenExchangePayload> {
  const body = await readFormUrlEncodedOrJsonObject(request, {
    allowedKeys: [
      "grant_type",
      "code",
      "code_verifier",
      "redirect_uri",
      "client_id",
      "client_secret",
    ],
  });

  const grantType = normalizeRequiredString(body.grant_type, "grant_type", {
    oauthErrorCode: "invalid_request",
  });
  if (grantType !== "authorization_code") {
    throw new RequestValidationError(
      "Only authorization_code grant is supported",
      400,
      "unsupported_grant_type",
    );
  }

  const redirectUri = normalizeOptionalString(body.redirect_uri, "redirect_uri", {
    oauthErrorCode: "invalid_request",
  });
  if (redirectUri) {
    assertValidRedirectUri(redirectUri, "redirect_uri", "invalid_request");
  }

  return {
    grantType: "authorization_code",
    code: normalizeRequiredString(body.code, "code", {
      oauthErrorCode: "invalid_request",
      maxLength: 256,
    }),
    codeVerifier: normalizePkceCodeVerifier(body.code_verifier, "invalid_request"),
    redirectUri,
    clientId: normalizeOptionalString(body.client_id, "client_id", {
      oauthErrorCode: "invalid_request",
      maxLength: 255,
    }),
    clientSecret: normalizeOptionalString(body.client_secret, "client_secret", {
      oauthErrorCode: "invalid_request",
      maxLength: 4096,
    }),
  };
}

export async function validateOAuthRevocationRequest(
  request: Request,
): Promise<OAuthRevocationPayload> {
  const body = await readFormUrlEncodedOrJsonObject(request, {
    allowedKeys: ["token", "token_type_hint"],
  });

  return {
    token: normalizeRequiredString(body.token, "token", {
      oauthErrorCode: "invalid_request",
      maxLength: MAX_TOKEN_LENGTH,
    }),
    tokenTypeHint: normalizeOptionalString(body.token_type_hint, "token_type_hint", {
      oauthErrorCode: "invalid_request",
      maxLength: 64,
    }),
  };
}
