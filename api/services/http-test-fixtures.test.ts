import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  findHttpTestFixture,
  HTTP_TEST_FIXTURE_LIMITS,
  HttpTestFixtureRequestError,
  HttpTestFixtureValidationError,
  materializeHttpTestFixtureResponse,
  resolveHttpTestFixtureConfig,
  sha256HttpTestFixtureBody,
} from "./http-test-fixtures.ts";

function rawFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "read-inbox",
    kind: "raw",
    request: {
      method: "get",
      url: "HTTPS://EXAMPLE.com:443/messages?label=todo&label=later",
    },
    response: {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Fixture": " inbox ",
      },
      body_text: '{"messages":[]}',
    },
    ...overrides,
  };
}

Deno.test("HTTP fixtures normalize exact method, WHATWG URL, and headers", () => {
  const fixtures = resolveHttpTestFixtureConfig([rawFixture()]);
  assertEquals(fixtures, [
    {
      id: "read-inbox",
      kind: "raw",
      request: {
        method: "GET",
        url: "https://example.com/messages?label=todo&label=later",
      },
      response: {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-fixture": "inbox",
        },
        body_text: '{"messages":[]}',
      },
    },
  ]);
});

Deno.test("HTTP fixtures require credential keys only for credential entries", () => {
  const credential = resolveHttpTestFixtureConfig([
    rawFixture({
      id: "gmail-read",
      kind: "credential",
      credential_key: "GMAIL_TOKEN",
    }),
  ]);
  assertEquals(credential?.[0].credential_key, "GMAIL_TOKEN");

  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({ kind: "credential" }),
      ]),
    HttpTestFixtureValidationError,
    "credential_key is required",
  );
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({ credential_key: "GMAIL_TOKEN" }),
      ]),
    HttpTestFixtureValidationError,
    "allowed only when kind is credential",
  );
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({
          kind: "credential",
          credential_key: "GMAIL_TOKEN",
          request: {
            method: "GET",
            url: "http://example.com/messages",
          },
        }),
      ]),
    HttpTestFixtureValidationError,
    "must use https for a credential fixture",
  );
});

Deno.test("HTTP fixtures reject duplicate IDs and unsupported fields", () => {
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture(),
        rawFixture(),
      ]),
    HttpTestFixtureValidationError,
    "duplicates fixture id",
  );
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({ template: "{{request.url}}" }),
      ]),
    HttpTestFixtureValidationError,
    "template is not supported",
  );
});

Deno.test("HTTP fixtures are bounded and explicit empty arrays are invalid", () => {
  assertThrows(
    () => resolveHttpTestFixtureConfig([]),
    HttpTestFixtureValidationError,
    "at least one",
  );
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig(
        Array.from(
          { length: HTTP_TEST_FIXTURE_LIMITS.max_entries + 1 },
          (_, index) => rawFixture({ id: `fixture-${index}` }),
        ),
      ),
    HttpTestFixtureValidationError,
    "at most 32",
  );
  assertEquals(resolveHttpTestFixtureConfig(undefined), null);
});

Deno.test("HTTP fixtures enforce one aggregate normalized-config bound", () => {
  const body = "x".repeat(900 * 1024);
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig(
        Array.from(
          { length: 5 },
          (_, index) =>
            rawFixture({
              id: `large-${index}`,
              response: {
                status: 200,
                headers: {},
                body_text: body,
              },
            }),
        ),
      ),
    HttpTestFixtureValidationError,
    "exceeds the 4 MiB aggregate",
  );
});

Deno.test("HTTP fixtures reject unsafe URLs, redirects, and framing headers", () => {
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({
          request: { method: "GET", url: "file:///etc/passwd" },
        }),
      ]),
    HttpTestFixtureValidationError,
    "must use http or https",
  );
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({
          request: {
            method: "GET",
            url: "https://user:pass@example.com/messages",
          },
        }),
      ]),
    HttpTestFixtureValidationError,
    "must not contain user information",
  );
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({
          request: {
            method: "GET",
            url: "https://@example.com/messages",
          },
        }),
      ]),
    HttpTestFixtureValidationError,
    "must not contain user information",
  );
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({
          request: {
            method: "GET",
            url: "https://example.com/messages#",
          },
        }),
      ]),
    HttpTestFixtureValidationError,
    "must not contain a fragment",
  );
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({
          response: {
            status: 302,
            headers: {},
            body_text: "",
          },
        }),
      ]),
    HttpTestFixtureValidationError,
    "must not be a redirect",
  );
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({
          response: {
            status: 200,
            headers: { "Content-Length": "4" },
            body_text: "body",
          },
        }),
      ]),
    HttpTestFixtureValidationError,
    "is not allowed",
  );
});

Deno.test("HTTP fixture normalization preserves prototype-named response headers", () => {
  const headers = JSON.parse(
    '{"__proto__":"fixture","constructor":"safe"}',
  ) as Record<string, string>;
  const fixtures = resolveHttpTestFixtureConfig([
    rawFixture({
      response: {
        status: 200,
        headers,
        body_text: "ok",
      },
    }),
  ])!;

  assertEquals(fixtures[0].response.headers["__proto__"], "fixture");
  assertEquals(fixtures[0].response.headers["constructor"], "safe");
  assertEquals(Object.keys(fixtures[0].response.headers), [
    "__proto__",
    "constructor",
  ]);
});

Deno.test("HTTP fixtures require exactly one bounded canonical body form", () => {
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({
          response: {
            status: 200,
            headers: {},
            body_text: "text",
            body_base64: "dGV4dA==",
          },
        }),
      ]),
    HttpTestFixtureValidationError,
    "exactly one",
  );
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({
          response: { status: 200, headers: {} },
        }),
      ]),
    HttpTestFixtureValidationError,
    "exactly one",
  );
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({
          response: {
            status: 200,
            headers: {},
            body_base64: "not base64",
          },
        }),
      ]),
    HttpTestFixtureValidationError,
    "canonical padded base64",
  );
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({
          response: {
            status: 200,
            headers: {},
            body_text: "x".repeat(
              HTTP_TEST_FIXTURE_LIMITS.max_response_body_bytes + 1,
            ),
          },
        }),
      ]),
    HttpTestFixtureValidationError,
    "exceeds the 1 MiB",
  );
});

Deno.test("HTTP fixtures validate lowercase request-body digests", () => {
  assertThrows(
    () =>
      resolveHttpTestFixtureConfig([
        rawFixture({
          request: {
            method: "POST",
            url: "https://example.com/messages",
            body_sha256: "A".repeat(64),
          },
        }),
      ]),
    HttpTestFixtureValidationError,
    "lowercase SHA-256",
  );
});

Deno.test("HTTP fixture matching is ordered, exact, and kind-scoped", async () => {
  const fixtures = resolveHttpTestFixtureConfig([
    rawFixture({
      id: "first",
      request: { method: "GET", url: "https://example.com/items?a=1&b=2" },
      response: { status: 200, headers: {}, body_text: "first" },
    }),
    rawFixture({
      id: "second",
      request: { method: "GET", url: "https://example.com/items?a=1&b=2" },
      response: { status: 200, headers: {}, body_text: "second" },
    }),
  ])!;

  assertEquals(
    (
      await findHttpTestFixture(fixtures, {
        kind: "raw",
        request: new Request("https://EXAMPLE.com:443/items?a=1&b=2"),
      })
    )?.id,
    "first",
  );
  assertEquals(
    await findHttpTestFixture(fixtures, {
      kind: "raw",
      request: new Request("https://example.com/items?b=2&a=1"),
    }),
    null,
  );
  assertEquals(
    await findHttpTestFixture(fixtures, {
      kind: "credential",
      credentialKey: "API_TOKEN",
      request: new Request("https://example.com/items?a=1&b=2"),
    }),
    null,
  );
});

Deno.test("HTTP fixtures match the SHA-256 of exact request-body bytes", async () => {
  const digest = await sha256HttpTestFixtureBody(
    new Uint8Array([0, 1, 2, 255]),
  );
  const fixtures = resolveHttpTestFixtureConfig([
    rawFixture({
      id: "binary-body",
      request: {
        method: "POST",
        url: "https://example.com/upload",
        body_sha256: digest,
      },
    }),
  ])!;

  assertEquals(
    (
      await findHttpTestFixture(fixtures, {
        kind: "raw",
        request: new Request("https://example.com/upload", {
          method: "POST",
          body: new Uint8Array([0, 1, 2, 255]),
        }),
      })
    )?.id,
    "binary-body",
  );
  assertEquals(
    await findHttpTestFixture(fixtures, {
      kind: "raw",
      request: new Request("https://example.com/upload", {
        method: "POST",
        body: new Uint8Array([0, 1, 2, 254]),
      }),
    }),
    null,
  );
});

Deno.test("HTTP fixture matching enforces the credential key", async () => {
  const fixtures = resolveHttpTestFixtureConfig([
    rawFixture({
      id: "credentialed",
      kind: "credential",
      credential_key: "CRM_TOKEN",
    }),
  ])!;
  const request = () =>
    new Request(
      "https://example.com/messages?label=todo&label=later",
    );

  assertEquals(
    (
      await findHttpTestFixture(fixtures, {
        kind: "credential",
        credentialKey: "CRM_TOKEN",
        request: request(),
      })
    )?.id,
    "credentialed",
  );
  assertEquals(
    await findHttpTestFixture(fixtures, {
      kind: "credential",
      credentialKey: "OTHER_TOKEN",
      request: request(),
    }),
    null,
  );
  await assertRejects(
    () =>
      findHttpTestFixture(fixtures, {
        kind: "credential",
        request: request(),
      }),
    HttpTestFixtureRequestError,
    "requires a valid credential key",
  );
});

Deno.test("HTTP fixture request hashing rejects bodies beyond the bound", async () => {
  const fixtures = resolveHttpTestFixtureConfig([
    rawFixture({
      request: {
        method: "POST",
        url: "https://example.com/upload",
        body_sha256: "0".repeat(64),
      },
    }),
  ])!;

  await assertRejects(
    () =>
      findHttpTestFixture(fixtures, {
        kind: "raw",
        request: new Request("https://example.com/upload", {
          method: "POST",
          body: new Uint8Array(
            HTTP_TEST_FIXTURE_LIMITS.max_request_body_bytes + 1,
          ),
        }),
      }),
    HttpTestFixtureRequestError,
    "exceeds 256 KiB",
  );
});

Deno.test("HTTP fixture matching enforces the request-body bound without a digest constraint", async () => {
  const fixtures = resolveHttpTestFixtureConfig([
    rawFixture({
      request: {
        method: "POST",
        url: "https://example.com/upload",
      },
    }),
  ])!;

  await assertRejects(
    () =>
      findHttpTestFixture(fixtures, {
        kind: "raw",
        request: new Request("https://example.com/upload", {
          method: "POST",
          body: new Uint8Array(
            HTTP_TEST_FIXTURE_LIMITS.max_request_body_bytes + 1,
          ),
        }),
      }),
    HttpTestFixtureRequestError,
    "exceeds 256 KiB",
  );
});

Deno.test("HTTP fixture matching enforces the request-body bound on a miss", async () => {
  const fixtures = resolveHttpTestFixtureConfig([
    rawFixture({
      request: {
        method: "POST",
        url: "https://example.com/expected",
      },
    }),
  ])!;

  await assertRejects(
    () =>
      findHttpTestFixture(fixtures, {
        kind: "raw",
        request: new Request("https://example.com/unmatched", {
          method: "POST",
          body: new Uint8Array(
            HTTP_TEST_FIXTURE_LIMITS.max_request_body_bytes + 1,
          ),
        }),
      }),
    HttpTestFixtureRequestError,
    "exceeds 256 KiB",
  );
});

Deno.test("HTTP fixture response materialization preserves exact bytes", async () => {
  const textFixture = resolveHttpTestFixtureConfig([
    rawFixture({
      response: {
        status: 418,
        headers: { "Content-Type": "application/json" },
        body_text: '{"ok":true}',
      },
    }),
  ])![0];
  const textResponse = materializeHttpTestFixtureResponse(textFixture);
  assertEquals(textResponse.status, 418);
  assertEquals(textResponse.headers.get("content-type"), "application/json");
  assertEquals(await textResponse.text(), '{"ok":true}');

  const binaryFixture = resolveHttpTestFixtureConfig([
    rawFixture({
      response: {
        status: 200,
        headers: {},
        body_base64: "AAEC/w==",
      },
    }),
  ])![0];
  const binaryResponse = materializeHttpTestFixtureResponse(binaryFixture);
  assertEquals(
    new Uint8Array(await binaryResponse.arrayBuffer()),
    new Uint8Array([0, 1, 2, 255]),
  );
  assertEquals(binaryResponse.headers.get("content-type"), null);
});
