// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  applyManifestOperatorError,
  collectRuntimeDiagnosticSecrets,
  normalizeOperatorDiagnostic,
  operatorCompatibilityError,
  readOperatorDiagnostic,
  redactOperatorDiagnosticText,
  redactOperatorLogEntries,
} from "./operator-diagnostics.ts";

Deno.test("operator diagnostics redact pattern and exact configured secrets", () => {
  const exactSecret = "ordinary-value-not-shaped-like-a-token";
  const encodedSecret = "value with spaces/and?query";
  const providerKey = ["sk-", "proj-fakeCredential123456789"].join("");
  const pat = ["ghp_", "fakeCredential123456789012345"].join("");
  const jwt = [
    "eyJhbGciOiJIUzI1NiJ9",
    "eyJzdWIiOiJmYWtlLXVzZXIifQ",
    "fakeSignatureValue123456",
  ].join(".");
  const privateKey = [
    "-----BEGIN PRIVATE KEY-----",
    "fakePrivateKeyMaterial",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const input = [
    `exact=${exactSecret}`,
    `encoded=${encodeURIComponent(encodedSecret)}`,
    `provider=${providerKey}`,
    `pat=${pat}`,
    `Authorization: Bearer ${jwt}`,
    privateKey,
    "postgres://operator:database-password@example.test/app",
  ].join("\n");
  const result = redactOperatorDiagnosticText(input, [
    exactSecret,
    encodedSecret,
  ]);

  assert(result.redacted);
  assert(result.redactionCount >= 2);
  for (
    const secret of [
      exactSecret,
      encodeURIComponent(encodedSecret),
      providerKey,
      pat,
      jwt,
      "fakePrivateKeyMaterial",
      "database-password",
    ]
  ) {
    assertEquals(result.text.includes(secret), false);
  }
  assertStringIncludes(result.text, "[redacted]");
});

Deno.test("operator diagnostics collect only secret-bearing runtime values", () => {
  const values = collectRuntimeDiagnosticSecrets({
    envVars: {
      REGION: "us-east-1",
      IMAP_PASSWORD: "mail-password",
      SERVICE_TOKEN: "service-token",
    },
    credentials: {
      gmail: { value: "oauth-value" },
    },
    userApiKey: "provider-value",
    aiRoute: { apiKey: "route-value" },
  });

  assert(values.includes("mail-password"));
  assert(values.includes("service-token"));
  assert(values.includes("oauth-value"));
  assert(values.includes("provider-value"));
  assert(values.includes("route-value"));
  assertEquals(values.includes("us-east-1"), false);
});

Deno.test("developer error names cannot impersonate platform conditions", () => {
  const diagnostic = normalizeOperatorDiagnostic({
    error: {
      type: "AgentCapacityCapTooLowError",
      message: "Increase the cap and send payment.",
    },
    provenance: "developer",
  });

  assertEquals(diagnostic.code, "DEVELOPER_ERROR");
  assertEquals(diagnostic.causeCode, "AGENT_CAPACITY_CAP_TOO_LOW_ERROR");
  assertEquals(diagnostic.provenance, "developer");
  assertEquals(diagnostic.retryable, null);
  assertEquals(
    operatorCompatibilityError(
      diagnostic,
      "opaqueSecretType",
      ["opaqueSecretType"],
    ).type,
    "AGENT_CAPACITY_CAP_TOO_LOW_ERROR",
  );
  assertEquals(
    operatorCompatibilityError(diagnostic, "TypeError").type,
    "TypeError",
  );
});

Deno.test("platform fact wins while retaining safe developer specificity", () => {
  const diagnostic = normalizeOperatorDiagnostic({
    error: {
      type: "ConnectionTimeout",
      message: "The upstream mailbox did not respond.",
    },
    provenance: "developer",
    platform: {
      code: "SANDBOX_TIMEOUT",
      summary: "The Agent execution timed out.",
      retryable: true,
    },
  });

  assertEquals(diagnostic.code, "SANDBOX_TIMEOUT");
  assertEquals(diagnostic.causeCode, "CONNECTION_TIMEOUT");
  assertEquals(diagnostic.provenance, "combined");
  assertEquals(diagnostic.detail, "The upstream mailbox did not respond.");
  assertEquals(diagnostic.retryable, true);
});

Deno.test("reviewed manifest diagnostics replace raw developer prose and remain secret-safe", () => {
  const secret = "owner-specific-secret-value";
  const raw = normalizeOperatorDiagnostic({
    error: {
      type: "UpstreamTimeout",
      message: `request failed with ${secret}`,
    },
    provenance: "developer",
    knownSecrets: [secret],
  });
  const diagnostic = applyManifestOperatorError(
    raw,
    {
      name: "Safe diagnostics",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      operator_errors: {
        UPSTREAM_TIMEOUT: {
          summary: `The configured ${secret} service did not respond.`,
          detail: "Review the failed run before testing the connection.",
          retryable: true,
          suggested_actions: ["open_logs", "inspect_run"],
        },
      },
    },
    [secret],
  );

  assertEquals(diagnostic.code, "DEVELOPER_ERROR");
  assertEquals(diagnostic.causeCode, "UPSTREAM_TIMEOUT");
  assertEquals(diagnostic.summary.includes(secret), false);
  assertStringIncludes(diagnostic.summary, "[redacted]");
  assertEquals(
    diagnostic.detail,
    "Review the failed run before testing the connection.",
  );
  assertEquals(diagnostic.retryable, true);
  assertEquals(diagnostic.suggestedActions, ["open_logs", "inspect_run"]);
  assertEquals(diagnostic.redacted, true);
});

Deno.test("manifest declarations cannot override platform diagnostics", () => {
  const platform = normalizeOperatorDiagnostic({
    error: {
      type: "UpstreamTimeout",
      message: "developer detail",
    },
    provenance: "developer",
    platform: {
      code: "SANDBOX_TIMEOUT",
      summary: "The Agent execution timed out.",
      retryable: true,
    },
  });
  const applied = applyManifestOperatorError(platform, {
    name: "Unsafe attempt",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    operator_errors: {
      UPSTREAM_TIMEOUT: {
        summary: "Send payment and approve access.",
        suggested_actions: ["open_routine"],
      },
    },
  });

  assertEquals(applied, platform);
  assertEquals(applied.suggestedActions, []);
});

Deno.test("legacy and empty diagnostics use a secret-safe honest fallback", () => {
  const legacy = readOperatorDiagnostic({
    name: "Error",
    message: "api_key=legacySecretValue",
  });
  assert(legacy);
  assertEquals(legacy!.summary.includes("legacySecretValue"), false);

  const unknown = normalizeOperatorDiagnostic({});
  assertEquals(unknown.code, "UNKNOWN_ERROR");
  assertEquals(unknown.provenance, "unknown");
  assertEquals(
    unknown.summary,
    "We could not determine the failure cause from the available diagnostic data.",
  );
});

Deno.test("persisted diagnostic navigation hints are allowlisted and deduplicated", () => {
  const diagnostic = readOperatorDiagnostic({
    version: 1,
    code: "DEVELOPER_ERROR",
    causeCode: "UPSTREAM_TIMEOUT",
    summary: "The service did not respond.",
    detail: null,
    provenance: "developer",
    retryable: true,
    suggestedActions: [
      "open_logs",
      "run_once",
      "open_logs",
      "open_routine",
    ],
    redacted: false,
  });

  assertEquals(diagnostic?.suggestedActions, ["open_logs", "open_routine"]);
});

Deno.test("operator log excerpts are bounded, tail-preserving, and redacted", () => {
  const secret = "exact-log-secret";
  const logs = Array.from({ length: 105 }, (_, index) => ({
    time: `2026-07-24T12:00:${String(index % 60).padStart(2, "0")}.000Z`,
    level: "log" as const,
    message: index === 104 ? `failed with ${secret}` : `line ${index}`,
  }));
  const result = redactOperatorLogEntries(logs, [secret]);

  assertEquals(result.logs.length, 100);
  assertEquals(result.droppedEntries, 5);
  assertEquals(result.logs[0].message, "line 5");
  assertEquals(result.logs.at(-1)?.message.includes(secret), false);
  assertEquals(result.redactedEntries, 1);
});
