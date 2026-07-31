import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  computeGalacticReleaseIdentity,
  computePreparedArtifactDigest,
  computeQualificationReportDigest,
} from "./galactic-release-identity.ts";
import { compareCanonicalStrings } from "./canonical-order.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

Deno.test("digest ordering is locale-independent UTF-16 code-unit order", () => {
  const values = ["é.ts", "z.ts", "A.ts", "ä.ts"];
  assertEquals(
    values.sort(compareCanonicalStrings),
    ["A.ts", "z.ts", "ä.ts", "é.ts"],
  );
});

Deno.test("Galactic release identity is deterministic across artifact order", async () => {
  const left = await computeGalacticReleaseIdentity({
    sourceHash: HASH_A,
    documentDigest: HASH_B,
    artifacts: [
      { name: "index.esm.js", content: "export const run=()=>1;" },
      { name: "galactic.yaml", content: "kind: Agent\n" },
    ],
    executable: "export const run=()=>1;",
  });
  const right = await computeGalacticReleaseIdentity({
    sourceHash: HASH_A,
    documentDigest: HASH_B,
    artifacts: [
      { name: "galactic.yaml", content: "kind: Agent\n" },
      { name: "index.esm.js", content: "export const run=()=>1;" },
    ],
    executable: "export const run=()=>1;",
  });

  assertEquals(left, right);
  assertEquals(/^[a-f0-9]{64}$/.test(left.release_digest), true);
});

Deno.test("Galactic release identity changes with every bound layer", async () => {
  const base = {
    sourceHash: HASH_A,
    documentDigest: HASH_B,
    artifacts: [{ name: "index.ts", content: "export const run=()=>1;" }],
    executable: "export const run=()=>1;",
  };
  const identity = await computeGalacticReleaseIdentity(base);

  for (
    const changed of [
      { ...base, sourceHash: "c".repeat(64) },
      { ...base, documentDigest: "d".repeat(64) },
      {
        ...base,
        artifacts: [{
          name: "index.ts",
          content: "export const run=()=>2;",
        }],
      },
      { ...base, executable: "export const run=()=>2;" },
      { ...base, compilerRevision: "compiler/next" },
      { ...base, runtimeRevision: "runtime/next" },
    ]
  ) {
    const next = await computeGalacticReleaseIdentity(changed);
    assertEquals(next.release_digest === identity.release_digest, false);
  }
});

Deno.test("prepared artifact digest rejects duplicate paths", async () => {
  await assertRejects(
    () =>
      computePreparedArtifactDigest([
        { name: "index.ts", content: "one" },
        { name: "index.ts", content: "two" },
      ]),
    Error,
    "Duplicate prepared release artifact",
  );
});

Deno.test("release identity rejects malformed digests and revisions", async () => {
  const base = {
    sourceHash: HASH_A,
    documentDigest: HASH_B,
    artifacts: [{ name: "index.ts", content: "export const run=()=>1;" }],
    executable: "export const run=()=>1;",
  };
  await assertRejects(
    () => computeGalacticReleaseIdentity({ ...base, sourceHash: "not-a-hash" }),
    Error,
    "sourceHash must be a lowercase SHA-256 digest",
  );
  await assertRejects(
    () =>
      computeGalacticReleaseIdentity({
        ...base,
        runtimeRevision: " runtime/1",
      }),
    Error,
    "runtimeRevision is not a valid protocol revision",
  );
});

Deno.test("qualification report digest is canonical over object key order", async () => {
  assertEquals(
    await computeQualificationReportDigest({
      passed: true,
      coverage: { cases: 2, functions: 1 },
    }),
    await computeQualificationReportDigest({
      coverage: { functions: 1, cases: 2 },
      passed: true,
    }),
  );
});
