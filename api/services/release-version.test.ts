import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  isCanonicalAppVersion,
  nextCanonicalAppPatchVersion,
  validateManifest,
} from "../../shared/contracts/manifest.ts";
import { initialReleaseVersionState } from "./release-version.ts";

Deno.test("release versions: only bounded canonical x.y.z values are storage-safe", () => {
  for (const version of ["0.0.0", "1.2.3", "999999999.0.42"]) {
    assert(isCanonicalAppVersion(version), version);
  }
  for (
    const version of [
      "latest",
      "1",
      "1.2",
      "01.2.3",
      "1.2.3-beta",
      " 1.2.3",
      "1.2.3/../../latest",
      "1000000000.0.0",
    ]
  ) {
    assertEquals(isCanonicalAppVersion(version), false, version);
  }
});

Deno.test("release versions: manifest-derived versions reject reserved KV aliases", () => {
  const base = {
    name: "Persistent Agent",
    type: "mcp",
    entry: { functions: "index.ts" },
    functions: {},
  };
  assertEquals(validateManifest({ ...base, version: "2.7.4" }).valid, true);
  const invalid = validateManifest({ ...base, version: "latest" });
  assertEquals(invalid.valid, false);
  assert(
    invalid.errors.some((entry) =>
      entry.path === "version" && entry.message.includes("canonical")
    ),
  );
});

Deno.test("release versions: custom new-app version initializes every live pointer consistently", () => {
  assertEquals(initialReleaseVersionState("2.7.4"), {
    current_version: "2.7.4",
    versions: ["2.7.4"],
  });
  assertEquals(nextCanonicalAppPatchVersion("2.7.4"), "2.7.5");
  assertEquals(nextCanonicalAppPatchVersion("legacy"), "1.0.1");
});
