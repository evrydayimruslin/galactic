import { assert, assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  classifyApiTokenCompatibility,
  getUserFromTokenForAuthentication,
  isTokenVerdictCacheFresh,
  observeBestEffortTokenWrite,
  resetTokensSupabaseClientForTesting,
  resolveTokenExpiry,
  runBoundedAuthRead,
  validateToken,
  verifyApiTokenRecord,
} from "./tokens.ts";
import {
  AUTH_API_TOKEN_INVALID,
  AUTH_SERVICE_UNAVAILABLE,
  AUTH_TOKEN_EXPIRED,
  classifyPublicAuthenticationError,
} from "./auth-errors.ts";

Deno.test("tokens: classifies canonical salted rows", () => {
  assertEquals(
    classifyApiTokenCompatibility({
      token_salt: "salt-123",
      plaintext_token: "ul_abcdef0123456789abcdef0123456789",
    }),
    "canonical",
  );
});

Deno.test("tokens: classifies canonical rows that no longer retain plaintext", () => {
  assertEquals(
    classifyApiTokenCompatibility({
      token_salt: "salt-123",
      plaintext_token: null,
    }),
    "canonical_missing_plaintext",
  );
});

Deno.test("tokens: classifies legacy rows that can be backfilled from plaintext", () => {
  assertEquals(
    classifyApiTokenCompatibility({
      token_salt: null,
      plaintext_token: "ul_abcdef0123456789abcdef0123456789",
    }),
    "legacy_backfillable_from_plaintext",
  );
});

Deno.test("tokens: classifies unrecoverable legacy rows", () => {
  assertEquals(
    classifyApiTokenCompatibility({
      token_salt: null,
      plaintext_token: null,
    }),
    "legacy_unrecoverable",
  );
});

Deno.test("tokens: verifies canonical salted rows without migration", async () => {
  const token = "ul_abcdef0123456789abcdef0123456789";
  const canonical = await verifyApiTokenRecord(token, {
    token_hash: "ignored",
    token_salt: "salt-123",
    plaintext_token: token,
  });

  assertEquals(canonical.state, "canonical");
  assertEquals(canonical.valid, false);
  assertEquals(canonical.reason, "hash_mismatch");
});

Deno.test("tokens: verifies canonical salted rows when the stored hash matches", async () => {
  const token = "ul_abcdef0123456789abcdef0123456789";
  const salted = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("salt-123"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", salted, new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(sig)).map((byte) => byte.toString(16).padStart(2, "0")).join("");

  const canonical = await verifyApiTokenRecord(token, {
    token_hash: tokenHash,
    token_salt: "salt-123",
    plaintext_token: null,
  });

  assertEquals(canonical.state, "canonical_missing_plaintext");
  assertEquals(canonical.valid, true);
  assertEquals(canonical.canonical_update, undefined);
});

Deno.test("tokens: verifies legacy plaintext rows and returns a canonical backfill payload", async () => {
  const token = "ul_abcdef0123456789abcdef0123456789";
  const verification = await verifyApiTokenRecord(token, {
    token_hash: "legacy-hash-no-longer-used",
    token_salt: null,
    plaintext_token: token,
  });

  assertEquals(verification.state, "legacy_backfillable_from_plaintext");
  assertEquals(verification.valid, true);
  assert(!!verification.canonical_update);
  assertEquals(typeof verification.canonical_update?.token_salt, "string");
  assertEquals(typeof verification.canonical_update?.token_hash, "string");
  assertEquals(verification.canonical_update?.token_salt.length, 32);
  assertEquals(verification.canonical_update?.token_hash.length, 64);
});

Deno.test("tokens: rejects legacy rows when plaintext does not match", async () => {
  const verification = await verifyApiTokenRecord("ul_abcdef0123456789abcdef0123456789", {
    token_hash: "legacy-hash-no-longer-used",
    token_salt: null,
    plaintext_token: "ul_deadbeefdeadbeefdeadbeefdeadbeef",
  });

  assertEquals(verification.state, "legacy_backfillable_from_plaintext");
  assertEquals(verification.valid, false);
  assertEquals(verification.reason, "plaintext_mismatch");
});

Deno.test("tokens: rejects unrecoverable legacy rows without token material", async () => {
  const verification = await verifyApiTokenRecord("ul_abcdef0123456789abcdef0123456789", {
    token_hash: "legacy-hash-no-longer-used",
    token_salt: null,
    plaintext_token: null,
  });

  assertEquals(verification.state, "legacy_unrecoverable");
  assertEquals(verification.valid, false);
  assertEquals(verification.reason, "missing_token_material");
});

Deno.test("tokens: exact short-lived expiry is preserved without day rounding", () => {
  const now = new Date("2026-07-27T12:00:00.000Z");
  const expiresAt = new Date("2026-07-27T12:30:00.000Z");
  assertEquals(
    resolveTokenExpiry({ expiresAt }, now),
    "2026-07-27T12:30:00.000Z",
  );
});

Deno.test("tokens: exact expiry fails closed when stale or ambiguous", () => {
  const now = new Date("2026-07-27T12:00:00.000Z");
  for (
    const options of [
      { expiresAt: new Date("2026-07-27T11:59:59.000Z") },
      {
        expiresAt: new Date("2026-07-27T12:30:00.000Z"),
        expiresInDays: 1,
      },
    ]
  ) {
    let message = "";
    try {
      resolveTokenExpiry(options, now);
    } catch (reason) {
      message = reason instanceof Error ? reason.message : String(reason);
    }
    assert(message.length > 0);
  }
});

Deno.test("tokens: cached verdict cannot outlive the token's exact expiry", () => {
  const cachedAt = Date.parse("2026-07-27T12:00:00.000Z");
  const expiresAt = "2026-07-27T12:00:30.000Z";
  assertEquals(
    isTokenVerdictCacheFresh(
      cachedAt,
      expiresAt,
      Date.parse("2026-07-27T12:00:29.999Z"),
    ),
    true,
  );
  assertEquals(
    isTokenVerdictCacheFresh(
      cachedAt,
      expiresAt,
      Date.parse("2026-07-27T12:00:30.000Z"),
    ),
    false,
  );
  assertEquals(
    isTokenVerdictCacheFresh(
      cachedAt,
      "not-a-date",
      Date.parse("2026-07-27T12:00:01.000Z"),
    ),
    false,
  );
});

Deno.test("tokens: bounded auth reads abort and safely consume a late rejection", async () => {
  let aborted = false;
  const query = {
    then: () => {
      throw new Error("the query must be armed with abortSignal first");
    },
    abortSignal(signal: AbortSignal) {
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          setTimeout(
            () => reject(new Error("late database password=must-not-leak")),
            5,
          );
        }, { once: true });
      });
    },
  };

  const failure = await capturedAuthError(() =>
    runBoundedAuthRead(() => query, 1)
  );
  assertEquals(classifyPublicAuthenticationError(failure), {
    status: 503,
    type: AUTH_SERVICE_UNAVAILABLE,
    message: "Authentication service is temporarily unavailable",
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assertEquals(aborted, true);
});

Deno.test("tokens: missing or malformed first-use database config is a redacted 503", async () => {
  const previousEnv = globalThis.__env;
  const token = `gx_${"6".repeat(32)}`;
  try {
    for (
      const config of [
        {
          SUPABASE_URL: "",
          SUPABASE_SERVICE_ROLE_KEY: "",
          forbidden: "supabaseUrl is required",
        },
        {
          SUPABASE_URL: "not-a-url-password=must-not-leak",
          SUPABASE_SERVICE_ROLE_KEY: "service-role-must-not-leak",
          forbidden: "must-not-leak",
        },
      ]
    ) {
      resetTokensSupabaseClientForTesting();
      globalThis.__env = {
        ...(previousEnv || {}),
        SUPABASE_URL: config.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: config.SUPABASE_SERVICE_ROLE_KEY,
      } as typeof globalThis.__env;

      const failure = await capturedAuthError(() =>
        getUserFromTokenForAuthentication(token)
      );
      const projected = classifyPublicAuthenticationError(failure);
      assertEquals(projected, {
        status: 503,
        type: AUTH_SERVICE_UNAVAILABLE,
        message: "Authentication service is temporarily unavailable",
      });
      assertEquals(JSON.stringify(projected).includes(config.forbidden), false);
      if (config.SUPABASE_SERVICE_ROLE_KEY) {
        assertEquals(
          JSON.stringify(projected).includes(config.SUPABASE_SERVICE_ROLE_KEY),
          false,
        );
      }
    }
  } finally {
    globalThis.__env = previousEnv;
    resetTokensSupabaseClientForTesting();
  }
});

Deno.test("tokens: best-effort maintenance writes contain and redact failures", async () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    observeBestEffortTokenWrite(
      Promise.reject(
        new Error(
          "postgres password=must-not-leak; gx_ffffffffffffffffffffffffffffffff",
        ),
      ),
      "last_used_update",
    );
    observeBestEffortTokenWrite(
      Promise.resolve({
        error: { message: "service role secret=also-must-not-leak" },
      }),
      "canonical_hash_backfill",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    console.warn = originalWarn;
  }

  assertEquals(warnings.sort(), [
    "[TOKEN] Canonical token hash backfill unavailable",
    "[TOKEN] Token last-used update unavailable",
  ]);
  assertEquals(warnings.join(" ").includes("must-not-leak"), false);
  assertEquals(warnings.join(" ").includes("gx_ffffffff"), false);
});

Deno.test({
  name: "tokens: legacy hash backfill never blocks the authoritative owner read",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const previousFetch = globalThis.fetch;
    const previousEnv = globalThis.__env;
    globalThis.__env = {
      ...(previousEnv || {}),
      SUPABASE_URL: "https://supabase-legacy-backfill.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
    } as typeof globalThis.__env;

    const token = `gx_${"7".repeat(32)}`;
    let releaseBackfill: (response: Response) => void = () => {};
    const backfillGate = new Promise<Response>((resolve) => {
      releaseBackfill = resolve;
    });
    let markOwnerRead: () => void = () => {};
    const ownerRead = new Promise<void>((resolve) => {
      markOwnerRead = resolve;
    });

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input));
      const method = request?.method ?? init?.method ?? "GET";
      if (url.pathname.endsWith("/rest/v1/user_api_tokens")) {
        if (method === "GET") {
          return Response.json({
            id: "legacy-token-id",
            user_id: "legacy-owner-id",
            token_hash: "legacy-unused-hash",
            token_salt: null,
            plaintext_token: token,
            scopes: ["*"],
            app_ids: null,
            function_names: null,
            expires_at: null,
          });
        }
        const body = JSON.parse(
          request
            ? await request.clone().text()
            : String(init?.body ?? "{}"),
        ) as Record<string, unknown>;
        if (typeof body.token_salt === "string") return await backfillGate;
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/rest/v1/users")) {
        markOwnerRead();
        return Response.json({
          id: "legacy-owner-id",
          email: "legacy@example.com",
          tier: "pro",
          provisional: false,
          last_active_at: null,
        });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    }) as typeof fetch;

    try {
      const authentication = getUserFromTokenForAuthentication(token);
      let ownerReadTimeout: ReturnType<typeof setTimeout> | undefined;
      const ownerReadWon = await Promise.race([
        ownerRead.then(() => true),
        new Promise<false>((resolve) => {
          ownerReadTimeout = setTimeout(() => resolve(false), 100);
        }),
      ]);
      if (ownerReadTimeout !== undefined) clearTimeout(ownerReadTimeout);
      releaseBackfill(new Response(null, { status: 204 }));
      const user = await authentication;
      assertEquals(
        ownerReadWon,
        true,
        "owner read must begin without waiting for the migration write",
      );
      assertEquals(user.id, "legacy-owner-id");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      globalThis.fetch = previousFetch;
      globalThis.__env = previousEnv;
    }
  },
});

async function matchingAuthTokenRow(
  token: string,
  expiresAt: string | null,
): Promise<Record<string, unknown>> {
  const salt = `salt-${token.slice(3, 11)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  return {
    id: `token-${token.slice(3, 11)}`,
    user_id: "user-auth-taxonomy",
    token_hash: Array.from(new Uint8Array(signature))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
    token_salt: salt,
    plaintext_token: null,
    scopes: ["*"],
    app_ids: null,
    function_names: null,
    expires_at: expiresAt,
  };
}

async function capturedAuthError(task: () => Promise<unknown>): Promise<unknown> {
  try {
    await task();
  } catch (error) {
    return error;
  }
  throw new Error("Expected authentication to fail");
}

Deno.test({
  name: "tokens: invalid, expired, and unavailable authentication remain distinct",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const previousFetch = globalThis.fetch;
    const previousEnv = globalThis.__env;
    globalThis.__env = {
      ...(previousEnv || {}),
      SUPABASE_URL: "https://supabase-auth-taxonomy.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
    } as typeof globalThis.__env;

    const missingToken = `gx_${"a".repeat(32)}`;
    const expiredToken = `gx_${"b".repeat(32)}`;
    const unavailableToken = `gx_${"c".repeat(32)}`;
    const invalidResponseToken = `gx_${"d".repeat(32)}`;
    const userUnavailableToken = `gx_${"e".repeat(32)}`;
    const hashMismatchToken = `gx_${"9".repeat(32)}`;
    const rows = new Map<string, Record<string, unknown>>([
      [
        expiredToken.slice(0, 8),
        await matchingAuthTokenRow(
          expiredToken,
          new Date(Date.now() - 60_000).toISOString(),
        ),
      ],
      [
        userUnavailableToken.slice(0, 8),
        await matchingAuthTokenRow(
          userUnavailableToken,
          new Date(Date.now() + 60_000).toISOString(),
        ),
      ],
      [
        hashMismatchToken.slice(0, 8),
        {
          ...(await matchingAuthTokenRow(
            hashMismatchToken,
            new Date(Date.now() + 60_000).toISOString(),
          )),
          token_hash: "0".repeat(64),
        },
      ],
    ]);

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input));
      const method = request?.method ?? init?.method ?? "GET";
      if (url.pathname.endsWith("/rest/v1/user_api_tokens")) {
        if (method === "PATCH") return new Response(null, { status: 204 });
        const prefix = url.searchParams.get("token_prefix")?.replace(/^eq\./u, "") ?? "";
        if (prefix === unavailableToken.slice(0, 8)) {
          return Response.json(
            { message: "database password=must-not-leak" },
            { status: 503 },
          );
        }
        if (prefix === invalidResponseToken.slice(0, 8)) {
          return Response.json({ unexpected: true });
        }
        const row = rows.get(prefix);
        if (row) return Response.json(row);
        return Response.json(
          {
            code: "PGRST116",
            message: "JSON object requested, multiple (or no) rows returned",
            details: "The result contains 0 rows",
          },
          { status: 406 },
        );
      }
      if (url.pathname.endsWith("/rest/v1/users")) {
        return Response.json(
          { message: "upstream user query unavailable" },
          { status: 503 },
        );
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    }) as typeof fetch;

    try {
      const malformed = await capturedAuthError(() =>
        getUserFromTokenForAuthentication("gx_short")
      );
      assertEquals(classifyPublicAuthenticationError(malformed), {
        status: 401,
        type: AUTH_API_TOKEN_INVALID,
        message: "Invalid API token",
      });

      const missing = await capturedAuthError(() =>
        getUserFromTokenForAuthentication(missingToken)
      );
      assertEquals(classifyPublicAuthenticationError(missing)?.type, AUTH_API_TOKEN_INVALID);
      assertEquals(
        await validateToken(missingToken),
        null,
        "compatibility callers retain null for an actual invalid token",
      );

      const hashMismatch = await capturedAuthError(() =>
        getUserFromTokenForAuthentication(hashMismatchToken)
      );
      assertEquals(
        classifyPublicAuthenticationError(hashMismatch)?.type,
        AUTH_API_TOKEN_INVALID,
      );

      const expired = await capturedAuthError(() =>
        getUserFromTokenForAuthentication(expiredToken)
      );
      assertEquals(classifyPublicAuthenticationError(expired), {
        status: 401,
        type: AUTH_TOKEN_EXPIRED,
        message: "API token has expired",
      });

      const compatibilityUnavailable = await capturedAuthError(() =>
        validateToken(unavailableToken)
      );
      assertEquals(classifyPublicAuthenticationError(compatibilityUnavailable), {
        status: 503,
        type: AUTH_SERVICE_UNAVAILABLE,
        message: "Authentication service is temporarily unavailable",
      });

      for (const token of [
        invalidResponseToken,
        userUnavailableToken,
      ]) {
        const unavailable = await capturedAuthError(() =>
          getUserFromTokenForAuthentication(token)
        );
        const projected = classifyPublicAuthenticationError(unavailable);
        assertEquals(projected, {
          status: 503,
          type: AUTH_SERVICE_UNAVAILABLE,
          message: "Authentication service is temporarily unavailable",
        });
        assertEquals(JSON.stringify(projected).includes(token), false);
        assertEquals(JSON.stringify(projected).includes("password"), false);
      }
    } finally {
      globalThis.fetch = previousFetch;
      globalThis.__env = previousEnv;
    }
  },
});
