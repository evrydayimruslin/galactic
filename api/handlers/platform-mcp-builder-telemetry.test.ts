import {
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  sourceBearingBuilderLogInput,
  sourceBearingBuilderLogOutput,
} from "./platform-mcp.ts";

const BUNDLE_ID = `gxb1_${"a".repeat(64)}`;
const SOURCE_DIGEST = "b".repeat(64);
const DOCUMENT_DIGEST = "c".repeat(64);
const REPORT_DIGEST = "d".repeat(64);
const RELEASE_DIGEST = "e".repeat(64);
const SOURCE_CONTENT = "export const run = () => process.env.PRIVATE_TOKEN;\n";
const ENV_CONTENT = "PRIVATE_TOKEN=gx_do_not_log_this_value";
const RAW_TOKEN = "gx_do_not_log_this_value";
const TEST_ATTESTATION = "gxt2.do-not-log-this-attestation";

Deno.test("platform MCP builder telemetry: input keeps paths and identities without source or credentials", () => {
  const redacted = sourceBearingBuilderLogInput("ul.upload", {
    files: [
      { path: "src/index.ts", content: SOURCE_CONTENT },
      { path: ".env", content: ENV_CONTENT },
      { name: "legacy-name.ts", content: `const token="${RAW_TOKEN}"` },
    ],
    bundle_id: BUNDLE_ID,
    app_id: "agent-1",
    test_attestation: TEST_ATTESTATION,
    token: RAW_TOKEN,
    description: SOURCE_CONTENT,
  });
  const serialized = JSON.stringify(redacted);

  assertEquals(redacted, {
    _redacted: true,
    _source: "builder",
    tool: "ul.upload",
    file_count: 3,
    file_paths: ["src/index.ts", ".env", "legacy-name.ts"],
    bundle_id: BUNDLE_ID,
    app_id: "agent-1",
    has_test_attestation: true,
  });
  assertStringIncludes(serialized, "src/index.ts");
  assertStringIncludes(serialized, ".env");
  assertStringIncludes(serialized, BUNDLE_ID);
  assertFalse(serialized.includes(SOURCE_CONTENT));
  assertFalse(serialized.includes(ENV_CONTENT));
  assertFalse(serialized.includes(RAW_TOKEN));
  assertFalse(serialized.includes(TEST_ATTESTATION));
});

Deno.test("platform MCP builder telemetry: output keeps digests and coverage without raw artifacts or attestation", () => {
  const redacted = sourceBearingBuilderLogOutput("ul.test", {
    success: true,
    status: "qualified",
    bundle_id: BUNDLE_ID,
    source_hash: SOURCE_DIGEST,
    document_digest: DOCUMENT_DIGEST,
    report_digest: REPORT_DIGEST,
    release_digest: RELEASE_DIGEST,
    test_attestation: TEST_ATTESTATION,
    source: SOURCE_CONTENT,
    files: [{ path: ".env", content: ENV_CONTENT }],
    token: RAW_TOKEN,
    conformance: {
      coverage: {
        cases: { declared: 2, passed: 2 },
        functions: { declared: 2, exercised: 1 },
        effects: { declared: 1, exercised: 1, untested: 0 },
      },
      raw_case_input: ENV_CONTENT,
    },
  });
  const serialized = JSON.stringify(redacted);

  assertEquals(redacted, {
    _redacted: true,
    _source: "builder",
    tool: "ul.test",
    has_test_attestation: true,
    success: true,
    status: "qualified",
    bundle_id: BUNDLE_ID,
    source_hash: SOURCE_DIGEST,
    document_digest: DOCUMENT_DIGEST,
    report_digest: REPORT_DIGEST,
    release_digest: RELEASE_DIGEST,
    coverage: {
      cases: { declared: 2, passed: 2 },
      functions: { declared: 2, exercised: 1 },
      effects: { declared: 1, exercised: 1, untested: 0 },
    },
  });
  for (
    const digest of [
      SOURCE_DIGEST,
      DOCUMENT_DIGEST,
      REPORT_DIGEST,
      RELEASE_DIGEST,
    ]
  ) {
    assertStringIncludes(serialized, digest);
  }
  assertFalse(serialized.includes(SOURCE_CONTENT));
  assertFalse(serialized.includes(ENV_CONTENT));
  assertFalse(serialized.includes(RAW_TOKEN));
  assertFalse(serialized.includes(TEST_ATTESTATION));
});

Deno.test("platform MCP builder telemetry: download and scaffold never retain generated source", () => {
  for (const tool of ["ul.download", "ul.scaffold"]) {
    const input = sourceBearingBuilderLogInput(tool, {
      name: SOURCE_CONTENT,
      description: ENV_CONTENT,
      token: RAW_TOKEN,
      test_attestation: TEST_ATTESTATION,
    });
    const output = sourceBearingBuilderLogOutput(tool, {
      success: true,
      status: "generated",
      source_hash: SOURCE_DIGEST,
      file_count: 2,
      files: [
        { path: "index.ts", content: SOURCE_CONTENT },
        { path: ".env", content: ENV_CONTENT },
      ],
      test_attestation: TEST_ATTESTATION,
      token: RAW_TOKEN,
    });
    const serialized = JSON.stringify({ input, output });

    assertEquals(input, {
      _redacted: true,
      _source: "builder",
      tool,
      file_count: 0,
      file_paths: [],
      has_test_attestation: true,
    });
    assertEquals(output, {
      _redacted: true,
      _source: "builder",
      tool,
      has_test_attestation: true,
      success: true,
      status: "generated",
      source_hash: SOURCE_DIGEST,
      file_count: 2,
    });
    assertStringIncludes(serialized, SOURCE_DIGEST);
    assertFalse(serialized.includes(SOURCE_CONTENT));
    assertFalse(serialized.includes(ENV_CONTENT));
    assertFalse(serialized.includes(RAW_TOKEN));
    assertFalse(serialized.includes(TEST_ATTESTATION));
  }
});
