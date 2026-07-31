import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";
import {
  validateEmbedBridgeExchangeRequest,
  validateMagicLinkAuthRequest,
  validateMagicLinkVerifyRequest,
  validatePageShareExchangeRequest,
  RequestValidationError,
  validateAuthorizeQuery,
  validateDynamicClientRegistrationRequest,
  validateOAuthRevocationRequest,
  validateOAuthTokenExchangeRequest,
  validatePasswordAuthRequest,
  validateRefreshRequest,
  validateSessionBootstrapRequest,
  validateSignoutRequest,
} from "./auth-request-validation.ts";

Deno.test("auth request validation: magic-link auth accepts only local continuations", async () => {
  const payload = await validateMagicLinkAuthRequest(
    new Request("https://example.com/auth/launch/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "person@example.com",
        next: "/agents?welcome=1",
      }),
    }),
  );
  assertEquals(payload, {
    email: "person@example.com",
    nextPath: "/agents?welcome=1",
  });

  await assertRejects(
    () =>
      validateMagicLinkAuthRequest(
        new Request("https://example.com/auth/launch/magic-link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "person@example.com",
            next: "https://attacker.example/steal",
          }),
        }),
      ),
    RequestValidationError,
    "next must be a local path",
  );
});

Deno.test("auth request validation: magic-link verification requires a token hash", async () => {
  assertEquals(
    await validateMagicLinkVerifyRequest(
      new Request("https://example.com/auth/launch/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token_hash: "one-time-token-hash" }),
      }),
    ),
    { tokenHash: "one-time-token-hash" },
  );
});

Deno.test("auth request validation: password auth validates mode, email, password, and next path", async () => {
  const payload = await validatePasswordAuthRequest(
    new Request("https://example.com/auth/launch/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "person@example.com",
        mode: "sign_up",
        next: "/agents?welcome=1",
        password: "correct horse battery staple",
      }),
    }),
  );

  assertEquals(payload, {
    email: "person@example.com",
    mode: "sign_up",
    nextPath: "/agents?welcome=1",
    password: "correct horse battery staple",
  });

  await assertRejects(
    () =>
      validatePasswordAuthRequest(
        new Request("https://example.com/auth/launch/password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "not-an-email",
            mode: "sign_in",
            password: "password",
          }),
        }),
      ),
    RequestValidationError,
    "Enter a valid email address",
  );

  await assertRejects(
    () =>
      validatePasswordAuthRequest(
        new Request("https://example.com/auth/launch/password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "person@example.com",
            mode: "sign_up",
            next: "https://attacker.example/steal",
            password: "valid-password",
          }),
        }),
      ),
    RequestValidationError,
    "next must be a local path",
  );
});

Deno.test("auth request validation: session bootstrap requires at least one token", async () => {
  await assertRejects(
    () =>
      validateSessionBootstrapRequest(
        new Request("https://example.com/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      ),
    RequestValidationError,
    "Missing access_token or refresh_token",
  );
});

Deno.test("auth request validation: session bootstrap trims tokens and rejects unknown keys", async () => {
  const payload = await validateSessionBootstrapRequest(
    new Request("https://example.com/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: "  access-token  ",
        refresh_token: "  refresh-token  ",
      }),
    }),
  );

  assertEquals(payload, {
    accessToken: "access-token",
    refreshToken: "refresh-token",
  });

  await assertRejects(
    () =>
      validateSessionBootstrapRequest(
        new Request("https://example.com/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            access_token: "token",
            unexpected: true,
          }),
        }),
      ),
    RequestValidationError,
    "Unsupported field(s): unexpected",
  );
});

Deno.test("auth request validation: refresh allows empty body for cookie clients", async () => {
  const payload = await validateRefreshRequest(
    new Request("https://example.com/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    }),
  );

  assertEquals(payload, { refreshToken: undefined });
});

Deno.test("auth request validation: signout rejects unsupported scope", async () => {
  await assertRejects(
    () =>
      validateSignoutRequest(
        new Request("https://example.com/auth/signout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: "global" }),
        }),
      ),
    RequestValidationError,
    'scope must be "local" when provided',
  );
});

Deno.test("auth request validation: embed bridge exchange requires bridge_token and rejects unknown keys", async () => {
  const payload = await validateEmbedBridgeExchangeRequest(
    new Request("https://example.com/auth/embed/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bridge_token: "ul_embed_token" }),
    }),
  );

  assertEquals(payload, { bridgeToken: "ul_embed_token" });

  await assertRejects(
    () =>
      validateEmbedBridgeExchangeRequest(
        new Request("https://example.com/auth/embed/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bridge_token: "token", unexpected: true }),
        }),
      ),
    RequestValidationError,
    "Unsupported field(s): unexpected",
  );
});

Deno.test("auth request validation: page share exchange validates owner, slug, and share token", async () => {
  const payload = await validatePageShareExchangeRequest(
    new Request("https://example.com/auth/page-share/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner_id: "11111111-1111-4111-8111-111111111111",
        slug: "launch-notes",
        share_token: "share-secret",
      }),
    }),
  );

  assertEquals(payload, {
    ownerId: "11111111-1111-4111-8111-111111111111",
    slug: "launch-notes",
    shareToken: "share-secret",
  });

  await assertRejects(
    () =>
      validatePageShareExchangeRequest(
        new Request("https://example.com/auth/page-share/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner_id: "not-a-uuid",
            slug: "launch-notes",
            share_token: "share-secret",
          }),
        }),
      ),
    RequestValidationError,
    "owner_id must be a valid UUID",
  );
});

Deno.test("auth request validation: client registration enforces supported OAuth fields", async () => {
  const payload = await validateDynamicClientRegistrationRequest(
    new Request("https://example.com/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Desktop Client",
        redirect_uris: ["myapp://oauth/callback", "https://example.com/callback"],
      }),
    }),
  );

  assertEquals(payload.redirectUris, ["myapp://oauth/callback", "https://example.com/callback"]);
  assertEquals(payload.grantTypes, ["authorization_code"]);
  assertEquals(payload.responseTypes, ["code"]);
  assertEquals(payload.tokenEndpointAuthMethod, "none");

  await assertRejects(
    () =>
      validateDynamicClientRegistrationRequest(
        new Request("https://example.com/oauth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            redirect_uris: ["https://example.com/callback"],
            grant_types: ["client_credentials"],
          }),
        }),
      ),
    RequestValidationError,
    'grant_types contains unsupported value "client_credentials"',
  );
});

Deno.test("auth request validation: authorize query enforces PKCE and redirect uri", () => {
  const query = validateAuthorizeQuery(
    new URL(
      "https://example.com/oauth/authorize?client_id=client-123&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0123456789-_~&state=abc",
    ),
  );

  assertEquals(query.clientId, "client-123");
  assertEquals(query.redirectUri, "https://example.com/callback");
  assertEquals(query.codeChallengeMethod, "S256");
  assertEquals(query.scope, "mcp:read mcp:write");

  try {
    validateAuthorizeQuery(
      new URL(
        "https://example.com/oauth/authorize?client_id=client-123&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0123456789-_~&code_challenge_method=plain",
      ),
    );
    throw new Error("Expected validateAuthorizeQuery to reject plain PKCE");
  } catch (err) {
    if (!(err instanceof RequestValidationError)) throw err;
    assertEquals(err.message, "code_challenge_method must be one of: S256");
  }
});

Deno.test("auth request validation: token exchange accepts form payloads and validates client_id", async () => {
  const payload = await validateOAuthTokenExchangeRequest(
    new Request("https://example.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "auth-code",
        code_verifier: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0123456789-_~",
        client_id: "client-123",
        redirect_uri: "https://example.com/callback",
      }).toString(),
    }),
  );

  assertEquals(payload.grantType, "authorization_code");
  assertEquals(payload.clientId, "client-123");

  await assertRejects(
    () =>
      validateOAuthTokenExchangeRequest(
        new Request("https://example.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            code: "auth-code",
            code_verifier: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0123456789-_~",
          }),
        }),
      ),
    RequestValidationError,
    "Only authorization_code grant is supported",
  );
});

Deno.test("auth request validation: revocation requires token", async () => {
  await assertRejects(
    () =>
      validateOAuthRevocationRequest(
        new Request("https://example.com/oauth/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      ),
    RequestValidationError,
    "Missing token",
  );
});
