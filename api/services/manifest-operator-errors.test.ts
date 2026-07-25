// deno-lint-ignore-file no-import-prefix

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  getManifestOperatorError,
  validateManifest,
} from "../../shared/contracts/manifest.ts";

function manifest(operatorErrors: unknown): Record<string, unknown> {
  return {
    name: "Operator diagnostics",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    functions: {
      tick: {
        description: "Runs one wake.",
      },
    },
    operator_errors: operatorErrors,
  };
}

Deno.test("manifest operator errors accept only bounded diagnostic metadata", () => {
  const input = manifest({
    UPSTREAM_TIMEOUT: {
      summary: "  The configured service did not respond.  ",
      detail: "  Verify the connection before running once.  ",
      retryable: true,
      suggested_actions: ["open_logs", "inspect_run", "open_routine"],
    },
  });
  assertEquals(validateManifest(input).valid, true);
  assertEquals(getManifestOperatorError(input as never, "UPSTREAM_TIMEOUT"), {
    summary: "The configured service did not respond.",
    detail: "Verify the connection before running once.",
    retryable: true,
    suggested_actions: ["open_logs", "inspect_run", "open_routine"],
  });
});

Deno.test("manifest operator errors reject privileged intent and unknown fields", () => {
  for (
    const declaration of [
      {
        summary: "Pay now.",
        suggested_actions: ["run_once"],
      },
      {
        summary: "Approve access.",
        action: "approve",
      },
      {
        summary: "Open this route.",
        url: "/account/billing",
      },
      {
        summary: "Duplicate.",
        suggested_actions: ["open_logs", "open_logs"],
      },
    ]
  ) {
    const result = validateManifest(manifest({
      EXPECTED_FAILURE: declaration,
    }));
    assertEquals(result.valid, false);
    assertExists(
      result.errors.find((entry) =>
        entry.path.startsWith("operator_errors.EXPECTED_FAILURE")
      ),
    );
    assertEquals(
      getManifestOperatorError(
        manifest({ EXPECTED_FAILURE: declaration }) as never,
        "EXPECTED_FAILURE",
      ),
      null,
      "runtime lookup must fail closed even for invalid stored manifests",
    );
  }
});

Deno.test("manifest operator errors enforce code, text, and collection bounds", () => {
  const tooMany = Object.fromEntries(
    Array.from({ length: 101 }, (_, index) => [
      `ERROR_${index}`,
      { summary: `Error ${index}` },
    ]),
  );
  const result = validateManifest(manifest({
    "not-uppercase": { summary: "Invalid code." },
    EMPTY: { summary: " " },
    TOO_LONG: { summary: "x".repeat(241) },
    ...tooMany,
  }));

  assertEquals(result.valid, false);
  assertExists(
    result.errors.find((entry) => entry.path === "operator_errors"),
  );
  assertExists(
    result.errors.find((entry) =>
      entry.path === "operator_errors.not-uppercase"
    ),
  );
  assertExists(
    result.errors.find((entry) =>
      entry.path === "operator_errors.EMPTY.summary"
    ),
  );
  assertExists(
    result.errors.find((entry) =>
      entry.path === "operator_errors.TOO_LONG.summary"
    ),
  );
});
