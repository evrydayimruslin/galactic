// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  MAX_OPERATOR_PROJECTION_REDACTION_INPUT_CHARS,
  OPERATOR_PROJECTION_REDACTION,
  redactOperatorProjectionText,
} from "./operator-projection-redaction.ts";

Deno.test("operator projection redaction: preserves ordinary navigation text", () => {
  const input =
    "email-ops could not check Gmail. Open Access and configure the Gmail credential.";
  assertEquals(redactOperatorProjectionText(input), input);
});

Deno.test("operator projection redaction: removes Galactic, secret-key, bearer, and JWT tokens", () => {
  // Assemble credential-shaped fixtures at runtime so repository secret
  // scanners do not mistake deliberately fake regression data for live keys.
  const galactic = ["gx_", "exampleconnectiontoken123456789"].join("");
  const provider = ["sk-", "proj-exampleSecretValue123456"].join("");
  const bearer = ["bearer", "SecretValue123456"].join("");
  const jwt = [
    "eyJhbGciOiJIUzI1NiJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "signatureValue123456",
  ].join(".");
  const input = [
    `Galactic ${galactic}`,
    `provider ${provider}`,
    `Authorization: Bearer ${bearer}`,
    `JWT ${jwt}`,
  ].join("\n");
  const result = redactOperatorProjectionText(input);

  assertEquals(result.includes(galactic), false);
  assertEquals(result.includes(provider), false);
  assertEquals(result.includes(bearer), false);
  assertEquals(result.includes(jwt.split(".")[0]!), false);
  assertStringIncludes(result, "Galactic [redacted]");
  assertStringIncludes(result, "Authorization: Bearer [redacted]");
});

Deno.test("operator projection redaction: preserves URL destinations while removing userinfo and sensitive queries", () => {
  const input =
    "Open postgresql://operator:database-password@db.example.test/inbox " +
    "then https://api.example.test/check?access_token=urlSecret123456&view=summary.";
  const result = redactOperatorProjectionText(input);

  assertStringIncludes(
    result,
    "postgresql://[redacted]@db.example.test/inbox",
  );
  assertStringIncludes(
    result,
    "https://api.example.test/check?access_token=[redacted]&view=summary.",
  );
  assertEquals(result.includes("database-password"), false);
  assertEquals(result.includes("urlSecret123456"), false);
});

Deno.test("operator projection redaction: handles common connection-string and structured secret fields", () => {
  const input = [
    'Password="database password"',
    "client_secret: 'oauth-client-secret'",
    "DATABASE_URL=postgres://db.example.test/private",
    '{"api_key":"json-api-secret","safe":"visible"}',
    "Server=db.example.test;User ID=operator;Password=sql-password;Database=inbox",
  ].join("\n");
  const result = redactOperatorProjectionText(input);

  assertStringIncludes(result, 'Password="[redacted]"');
  assertStringIncludes(result, "client_secret: '[redacted]'");
  assertStringIncludes(result, "DATABASE_URL=[redacted]");
  assertStringIncludes(result, '"api_key":"[redacted]"');
  assertStringIncludes(result, '"safe":"visible"');
  assertStringIncludes(
    result,
    "Server=db.example.test;User ID=operator;Password=[redacted];Database=inbox",
  );
});

Deno.test("operator projection redaction: removes complete and truncated private-key blocks", () => {
  const complete = [
    "Credential failed:",
    "-----BEGIN PRIVATE KEY-----",
    "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=",
    "-----END PRIVATE KEY-----",
    "Open Access to replace it.",
  ].join("\n");
  const truncated = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1wcml2YXRlLWtleQ==",
  ].join("\n");

  assertEquals(
    redactOperatorProjectionText(complete),
    "Credential failed:\n[redacted private key]\nOpen Access to replace it.",
  );
  assertEquals(
    redactOperatorProjectionText(truncated),
    "[redacted private key]",
  );
});

Deno.test("operator projection redaction: removes common hosted-provider tokens", () => {
  const values = [
    ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
    ["github_pat_", "exampleTokenValue1234567890"].join(""),
    ["ghp_", "exampleTokenValue123456789012345"].join(""),
    ["xoxb-", "example-token-value-123456"].join(""),
    ["AIza", "SyExampleGoogleApiCredential123456"].join(""),
  ];
  const result = redactOperatorProjectionText(values.join(" "));

  for (const value of values) assertEquals(result.includes(value), false);
  assertEquals(
    result.split(OPERATOR_PROJECTION_REDACTION).length - 1,
    values.length,
  );
});

Deno.test("operator projection redaction: is deterministic and idempotent", () => {
  const input = "Bearer bearerSecretValue123456 and token=another-secret-value";
  const once = redactOperatorProjectionText(input);

  assertEquals(redactOperatorProjectionText(input), once);
  assertEquals(redactOperatorProjectionText(once), once);
});

Deno.test("operator projection redaction: caps pathological model output before scanning", () => {
  const result = redactOperatorProjectionText(
    "A".repeat(MAX_OPERATOR_PROJECTION_REDACTION_INPUT_CHARS + 50_000),
  );

  assertEquals(
    result.length,
    MAX_OPERATOR_PROJECTION_REDACTION_INPUT_CHARS + " …[truncated]".length,
  );
  assertEquals(result.endsWith(" …[truncated]"), true);
});
