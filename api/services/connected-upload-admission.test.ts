import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  countConnectedStagedVersions,
  decideConnectedUploadAdmission,
  MAX_CONNECTED_NON_LIVE_VERSIONS,
  retainedConnectedStagedVersionBytes,
  validateConnectedUploadFileSet,
} from "./connected-upload-admission.ts";
import {
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_SIZE_BYTES,
} from "../../shared/types/index.ts";

Deno.test("connected upload admission enforces file count, extension, and UTF-8 byte limits", () => {
  assertEquals(
    validateConnectedUploadFileSet([
      { path: "index.ts", content: "export const emoji = '🪐';" },
      { path: "manifest.json", content: "{}" },
    ]).totalBytes,
    new TextEncoder().encode("export const emoji = '🪐';{}").byteLength,
  );
  assertThrows(
    () =>
      validateConnectedUploadFileSet([{ path: "binary.exe", content: "x" }]),
    Error,
    "File type not allowed",
  );
  assertThrows(
    () =>
      validateConnectedUploadFileSet(
        Array.from({ length: MAX_FILES_PER_UPLOAD + 1 }, (_, index) => ({
          path: `${index}.ts`,
          content: "",
        })),
      ),
    Error,
    "Maximum",
  );
  assertThrows(
    () =>
      validateConnectedUploadFileSet([{
        path: "large.txt",
        content: "a".repeat(MAX_UPLOAD_SIZE_BYTES + 1),
      }]),
    Error,
    "exceeds",
  );
});

Deno.test("connected upload admission bounds and accounts retained staged versions", () => {
  assertEquals(MAX_CONNECTED_NON_LIVE_VERSIONS, 3);
  const live = {
    version: "1.0.0",
    created_at: "2026-07-14T12:00:00.000Z",
    size_bytes: 999,
  };
  const staged = (
    version: string,
    createdAt: string,
    sizeBytes: number | string,
  ) => ({
    version,
    created_at: createdAt,
    size_bytes: sizeBytes,
    source_hash: `${version}-hash`,
    test_attestation: { source_hash: `${version}-hash` },
  });
  const metadata = [
    // Legacy and previously promoted releases are history, not staged drafts.
    {
      version: "0.9.0",
      created_at: "2026-07-13T12:00:00.000Z",
      size_bytes: 500,
    },
    live,
    staged("1.1.0", "2026-07-14T13:00:00.000Z", 10),
    staged("1.2.0", "2026-07-14T14:00:00.000Z", "20"),
    staged("1.1.0", "2026-07-14T15:00:00.000Z", 15),
    // A hash without a source-bound gx.test proof is legacy, not a candidate.
    {
      version: "legacy",
      created_at: "2026-07-14T16:00:00.000Z",
      size_bytes: 700,
      source_hash: "legacy-hash",
    },
  ];
  assertEquals(
    countConnectedStagedVersions(metadata, "1.0.0"),
    2,
  );
  assertEquals(
    retainedConnectedStagedVersionBytes(metadata, "1.0.0"),
    35,
  );
});

Deno.test("legacy non-live release history does not exhaust connected staged admission", () => {
  const metadata = Array.from({ length: 142 }, (_, index) => ({
    version: `1.0.${index}`,
    created_at: new Date(Date.UTC(2026, 5, 1, 0, index)).toISOString(),
    size_bytes: 9701,
    ...(index > 60 ? { source_hash: "legacy-source-hash" } : {}),
  }));

  assertEquals(countConnectedStagedVersions(metadata, "1.0.1"), 0);
  assertEquals(
    retainedConnectedStagedVersionBytes(metadata, "1.0.1"),
    0,
  );
});

Deno.test("verified identical live redeploy wins before the staged-version ceiling", () => {
  assertEquals(
    decideConnectedUploadAdmission({
      verifiedIdenticalLiveDenoRedeploy: true,
      enforceStagedVersionLimit: true,
      retainedNonLiveVersions: MAX_CONNECTED_NON_LIVE_VERSIONS,
    }),
    "deduplicate",
  );
  assertEquals(
    decideConnectedUploadAdmission({
      verifiedIdenticalLiveDenoRedeploy: false,
      enforceStagedVersionLimit: true,
      retainedNonLiveVersions: MAX_CONNECTED_NON_LIVE_VERSIONS,
    }),
    "staged_version_limit",
  );
  assertEquals(
    decideConnectedUploadAdmission({
      verifiedIdenticalLiveDenoRedeploy: false,
      enforceStagedVersionLimit: false,
      retainedNonLiveVersions: MAX_CONNECTED_NON_LIVE_VERSIONS,
    }),
    "stage",
  );
});
