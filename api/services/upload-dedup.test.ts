// Upload dedup: a re-upload of byte-identical files must not mint a new version
// (redeploy-loop version spam). These pin the hash + lookup that drive the
// early-exit in executeUpload.

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import {
  computeUploadSourceHash,
  getLatestVersionSourceHash,
} from "./trust.ts";
import type { App, VersionMetadata } from "../../shared/types/index.ts";

const FILES = [
  { path: "index.ts", content: "export function run() { return 1; }" },
  { path: "manifest.json", content: '{"functions":{"run":{}}}' },
];

Deno.test("dedup hash: identical file-sets hash identically, regardless of order", async () => {
  const a = await computeUploadSourceHash(FILES);
  const b = await computeUploadSourceHash([...FILES].reverse());
  assertEquals(a, b, "order must not matter (sorted by path)");
});

Deno.test("dedup hash: a content change flips the hash", async () => {
  const base = await computeUploadSourceHash(FILES);
  const changed = await computeUploadSourceHash([
    { path: "index.ts", content: "export function run() { return 2; }" },
    FILES[1],
  ]);
  assert(base !== changed, "code change must change the hash");
});

Deno.test("dedup hash: a manifest-only change flips the hash (file-set, not code-only)", async () => {
  const base = await computeUploadSourceHash(FILES);
  const manifestChanged = await computeUploadSourceHash([
    FILES[0],
    { path: "manifest.json", content: '{"functions":{"run":{"description":"x"}}}' },
  ]);
  assert(base !== manifestChanged, "manifest.json is part of the file-set");
});

Deno.test("dedup hash: adding or removing a file flips the hash", async () => {
  const base = await computeUploadSourceHash(FILES);
  const withExtra = await computeUploadSourceHash([
    ...FILES,
    { path: "policy.ts", content: "export const planAccess = () => ({});" },
  ]);
  assert(base !== withExtra, "a new file must change the hash");
});

Deno.test("getLatestVersionSourceHash: returns the LIVE version's stored hash only", () => {
  const app = {
    current_version: "1.1",
    version_metadata: [
      { version: "1.0", size_bytes: 1, created_at: "", source_hash: "hash-old" },
      { version: "1.1", size_bytes: 1, created_at: "", source_hash: "hash-live" },
    ] as VersionMetadata[],
  } as Pick<App, "current_version" | "version_metadata">;
  assertEquals(getLatestVersionSourceHash(app), "hash-live");
});

Deno.test("getLatestVersionSourceHash: null when the live version predates the feature", () => {
  const app = {
    current_version: "1.0",
    version_metadata: [
      { version: "1.0", size_bytes: 1, created_at: "" }, // no source_hash
    ] as VersionMetadata[],
  } as Pick<App, "current_version" | "version_metadata">;
  assertEquals(getLatestVersionSourceHash(app), null);
});

Deno.test("getLatestVersionSourceHash: null when there is no metadata", () => {
  const app = { current_version: "1.0", version_metadata: null } as Pick<
    App,
    "current_version" | "version_metadata"
  >;
  assertEquals(getLatestVersionSourceHash(app), null);
});
