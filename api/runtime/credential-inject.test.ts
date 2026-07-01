import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertThrows } from "https://deno.land/std@0.210.0/assert/assert_throws.ts";

import type { ResolvedCredential } from "../../shared/contracts/env.ts";
import { prepareCredentialRequest } from "../src/bindings/credential-inject.ts";

function bearerCreds(): Record<string, ResolvedCredential> {
  return {
    API_KEY: {
      value: "sk-secret",
      credential: { destination: "api.openai.com", inject: { as: "bearer" } },
    },
  };
}

Deno.test("credential-inject: bearer attaches Authorization and preserves method", () => {
  const prepared = prepareCredentialRequest(
    "API_KEY",
    "https://api.openai.com/v1/chat",
    { method: "post", body: "{}" },
    bearerCreds(),
  );
  assertEquals(prepared.headers["Authorization"], "Bearer sk-secret");
  assertEquals(prepared.method, "POST");
  assertEquals(prepared.body, "{}");
});

Deno.test("credential-inject: header inject with prefix", () => {
  const creds: Record<string, ResolvedCredential> = {
    KEY: {
      value: "abc",
      credential: {
        destination: "api.x.com",
        inject: { as: "header", name: "X-Api-Key", prefix: "Token " },
      },
    },
  };
  const prepared = prepareCredentialRequest("KEY", "https://api.x.com/", undefined, creds);
  assertEquals(prepared.headers["X-Api-Key"], "Token abc");
});

Deno.test("credential-inject: basic auth pulls username from another credential", () => {
  const creds: Record<string, ResolvedCredential> = {
    PASS: {
      value: "pw",
      credential: {
        destination: "api.x.com",
        inject: { as: "basic", username_env: "USER" },
      },
    },
    USER: { value: "alice" },
  };
  const prepared = prepareCredentialRequest("PASS", "https://api.x.com/", undefined, creds);
  assertEquals(prepared.headers["Authorization"], "Basic " + btoa("alice:pw"));
});

Deno.test("credential-inject: query inject adds the secret as a query param", () => {
  const creds: Record<string, ResolvedCredential> = {
    K: {
      value: "qv",
      credential: {
        destination: "api.x.com",
        inject: { as: "query", name: "api_key" },
      },
    },
  };
  const prepared = prepareCredentialRequest("K", "https://api.x.com/data", undefined, creds);
  assertEquals(new URL(prepared.url).searchParams.get("api_key"), "qv");
});

Deno.test("credential-inject: refuses to send the secret to a different host", () => {
  // The exfil attempt — point the credential at an attacker host.
  assertThrows(
    () =>
      prepareCredentialRequest(
        "API_KEY",
        "https://attacker.tld/collect",
        undefined,
        bearerCreds(),
      ),
    Error,
    "only valid for",
  );
});

Deno.test("credential-inject: wildcard destination matches subdomains", () => {
  const creds: Record<string, ResolvedCredential> = {
    K: {
      value: "v",
      credential: { destination: "*.example.com", inject: { as: "bearer" } },
    },
  };
  const prepared = prepareCredentialRequest("K", "https://api.example.com/x", undefined, creds);
  assertEquals(prepared.headers["Authorization"], "Bearer v");
});

Deno.test("credential-inject: unknown credential key throws", () => {
  assertThrows(
    () => prepareCredentialRequest("NOPE", "https://api.openai.com/", undefined, bearerCreds()),
    Error,
    "Unknown credential",
  );
});

Deno.test("credential-inject: a per-user secret with no credential binding cannot be used", () => {
  // A per-user secret that isn't a declared credential is unusable via this path
  // (and it never reaches the sandbox either) — no way to read its value.
  const creds: Record<string, ResolvedCredential> = { RAW: { value: "leak" } };
  assertThrows(
    () => prepareCredentialRequest("RAW", "https://api.x.com/", undefined, creds),
    Error,
    "no network binding",
  );
});

Deno.test("credential-inject: non-http scheme is rejected", () => {
  assertThrows(
    () => prepareCredentialRequest("API_KEY", "file:///etc/passwd", undefined, bearerCreds()),
    Error,
  );
});
