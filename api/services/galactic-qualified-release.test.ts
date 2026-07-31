import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  GALACTIC_BASIC_POLICY_REVISION,
  GALACTIC_COMPILER_REVISION,
  GALACTIC_RUNTIME_CONTRACT_REVISION,
} from "./galactic-release-identity.ts";
import {
  assertQualificationMatchesPreparedRelease,
  computePreparedPipelineReleaseIdentity,
} from "./galactic-qualified-release.ts";

const SOURCE_HASH = "a".repeat(64);
const DOCUMENT_DIGEST = "b".repeat(64);
const prepared = {
  sourceHash: SOURCE_HASH,
  documentDigest: DOCUMENT_DIGEST,
  filesToUpload: [
    { name: "galactic.yaml", content: "kind: Agent\n" },
    { name: "manifest.json", content: "{}" },
  ],
  interfaceArtifacts: [
    { name: `${"c".repeat(64)}.html`, content: "<p>hello</p>" },
  ],
  esmBundledCode: "export const run=()=>1;",
};

Deno.test("prepared release qualification binds compiled files, interfaces, and executable", async () => {
  const identity = await computePreparedPipelineReleaseIdentity(prepared);
  const qualification = {
    profile: "basic" as const,
    document_digest: DOCUMENT_DIGEST,
    release_digest: identity.release_digest,
    report_digest: "d".repeat(64),
    compiler_revision: GALACTIC_COMPILER_REVISION,
    runtime_revision: GALACTIC_RUNTIME_CONTRACT_REVISION,
    policy_revision: GALACTIC_BASIC_POLICY_REVISION,
    cases: {
      declared: 1,
      required: 1,
      passed: 1,
      optional_failed: 0,
    },
    functions: { declared: 1, exercised: 1 },
    effects: { declared: 0, exercised: 0, untested: 0 },
  };

  assertEquals(
    await assertQualificationMatchesPreparedRelease({
      qualification,
      prepared,
    }),
    identity,
  );

  await assertRejects(
    () =>
      assertQualificationMatchesPreparedRelease({
        qualification,
        prepared: {
          ...prepared,
          esmBundledCode: "export const run=()=>2;",
        },
      }),
    Error,
    "prepared release differs",
  );
});

Deno.test("prepared release qualification rejects stale compiler policy", async () => {
  const identity = await computePreparedPipelineReleaseIdentity(prepared);
  await assertRejects(
    () =>
      assertQualificationMatchesPreparedRelease({
        qualification: {
          profile: "basic",
          document_digest: DOCUMENT_DIGEST,
          release_digest: identity.release_digest,
          report_digest: "d".repeat(64),
          compiler_revision: "old-compiler",
          runtime_revision: GALACTIC_RUNTIME_CONTRACT_REVISION,
          policy_revision: GALACTIC_BASIC_POLICY_REVISION,
          cases: {
            declared: 1,
            required: 1,
            passed: 1,
            optional_failed: 0,
          },
          functions: { declared: 1, exercised: 1 },
          effects: { declared: 0, exercised: 0, untested: 0 },
        },
        prepared,
      }),
    Error,
    "different Galactic contract",
  );
});
