import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  countConnectedNonLiveVersions,
  MAX_CONNECTED_NON_LIVE_VERSIONS,
  retainedNonLiveVersionBytes,
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
    () => validateConnectedUploadFileSet([{ path: "binary.exe", content: "x" }]),
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
  assertEquals(
    countConnectedNonLiveVersions(
      ["1.0.0", "1.1.0", "1.1.0", "1.2.0", "1.3.0"],
      "1.0.0",
    ),
    3,
  );
  assertEquals(
    retainedNonLiveVersionBytes(
      [
        { version: "1.0.0", size_bytes: 999 },
        { version: "1.1.0", size_bytes: 10 },
        { version: "1.2.0", size_bytes: "20" },
        { version: "1.1.0", size_bytes: 15 },
        { version: "bad", size_bytes: -1 },
      ],
      "1.0.0",
    ),
    35,
  );
});
