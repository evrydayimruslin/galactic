import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import { readRetainedGalacticManifest } from "./library.ts";

const STORAGE_KEY = "apps/app-qualified/1.0.0/";
const VALID_MANIFEST = JSON.stringify({
  name: "Qualified Agent",
  version: "1.0.0",
  type: "mcp",
  entry: { functions: "index.ts" },
  functions: {
    inspect: { description: "Inspect a fixture." },
  },
});

function reader(input: {
  keys?: string[];
  manifest?: string;
  listError?: Error;
  manifestError?: Error;
}) {
  return {
    listFiles: (_prefix: string): Promise<string[]> =>
      input.listError
        ? Promise.reject(input.listError)
        : Promise.resolve(input.keys ?? []),
    fetchTextFile: (_key: string): Promise<string> =>
      input.manifestError
        ? Promise.reject(input.manifestError)
        : Promise.resolve(input.manifest ?? VALID_MANIFEST),
  };
}

Deno.test("library manifest: legacy releases may use source hydration", async () => {
  assertEquals(
    await readRetainedGalacticManifest(
      STORAGE_KEY,
      reader({ keys: [`${STORAGE_KEY}_source_index.ts`] }),
    ),
    null,
  );
});

Deno.test("library manifest: galactic.yaml retains exact compiled bytes", async () => {
  const retained = await readRetainedGalacticManifest(
    STORAGE_KEY,
    reader({
      keys: [
        `${STORAGE_KEY}galactic.yaml`,
        `${STORAGE_KEY}manifest.json`,
      ],
    }),
  );
  assertEquals(retained?.json, VALID_MANIFEST);
  assertEquals(retained?.manifest.name, "Qualified Agent");
});

Deno.test("library manifest: galactic.yaml never falls back on storage failure", async () => {
  await assertRejects(
    () =>
      readRetainedGalacticManifest(
        STORAGE_KEY,
        reader({ listError: new Error("transient list failure") }),
      ),
    Error,
    "transient list failure",
  );
  await assertRejects(
    () =>
      readRetainedGalacticManifest(
        STORAGE_KEY,
        reader({
          keys: [`${STORAGE_KEY}galactic.yaml`],
          manifestError: new Error("transient read failure"),
        }),
      ),
    Error,
    "missing its compiled manifest.json",
  );
});

Deno.test("library manifest: galactic.yaml never falls back on malformed or invalid manifest", async () => {
  const keys = [`${STORAGE_KEY}galactic.yaml`];
  await assertRejects(
    () =>
      readRetainedGalacticManifest(
        STORAGE_KEY,
        reader({ keys, manifest: "{" }),
      ),
    Error,
    "malformed compiled manifest.json",
  );
  await assertRejects(
    () =>
      readRetainedGalacticManifest(
        STORAGE_KEY,
        reader({ keys, manifest: JSON.stringify({ name: "Incomplete" }) }),
      ),
    Error,
    "invalid compiled manifest.json",
  );
});
