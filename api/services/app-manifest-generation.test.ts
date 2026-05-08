import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertExists } from "https://deno.land/std@0.210.0/assert/assert_exists.ts";

import {
  generateManifestFromParseResult,
  hydrateManifestForSource,
  resolveStoredManifestCoverage,
  upsertManifestUploadFile,
} from "./app-manifest-generation.ts";
import { parseTypeScript } from "./parser.ts";
import { validateManifest } from "../../shared/contracts/manifest.ts";

Deno.test("manifest generation: uses entry filename when building contracts from source", async () => {
  const parseResult = await parseTypeScript(
    "export async function greet(name: string) { return `hi ${name}`; }",
    "functions.ts",
  );

  const manifest = generateManifestFromParseResult(
    { name: "Greeting App", slug: "greeting-app" },
    parseResult,
    "1.2.3",
    { entryFileName: "functions.ts" },
  );

  assertEquals(manifest.entry.functions, "functions.ts");
  assertExists(manifest.functions?.greet);
  assertEquals(manifest.version, "1.2.3");
});

Deno.test("manifest generation: preserves rich uploaded manifests and merges missing source functions", async () => {
  const hydrated = await hydrateManifestForSource({
    app: { name: "Planner", slug: "planner" },
    existingManifest: {
      name: "Planner",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "planner.ts" },
      functions: {
        listTasks: {
          description: "List all tasks",
        },
      },
    },
    sourceCode: [
      "export async function listTasks() { return []; }",
      "export async function addTask(title: string) { return { ok: true, title }; }",
    ].join("\n"),
    filename: "planner.ts",
    version: "2.0.0",
  });

  assertEquals(hydrated.source, "merged");
  assertEquals(hydrated.manifest.version, "2.0.0");
  assertEquals(
    hydrated.manifest.functions?.listTasks?.description,
    "List all tasks",
  );
  assertExists(hydrated.manifest.functions?.addTask);
});

Deno.test("manifest generation: rebuilds stored manifest coverage from source when manifest.json is missing", async () => {
  const stored = await resolveStoredManifestCoverage({
    app: { name: "Search", slug: "search" },
    fetchTextFile: async (path) => {
      if (path.endsWith("_source_index.ts")) {
        return "export async function search(query: string) { return [{ query }]; }";
      }
      throw new Error(`missing: ${path}`);
    },
    storageKey: "apps/app-123/1.0.0/",
    version: "1.0.0",
  });

  assertEquals(stored.source, "generated");
  assertExists(stored.manifest?.functions?.search);
  assertExists(stored.manifestJson);
});

Deno.test("manifest generation: upsertManifestUploadFile replaces stale manifest payloads", () => {
  const files = upsertManifestUploadFile(
    [
      { name: "manifest.json", content: "old" },
      { name: "index.ts", content: "code" },
    ],
    {
      name: "Search",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      functions: {
        search: { description: "Search things" },
      },
    },
    (manifestJson) => ({ name: "manifest.json", content: manifestJson }),
  );

  assertEquals(files.length, 2);
  assertEquals(files[1].name, "manifest.json");
  assertExists(files[1].content.includes('"search"'));
});

Deno.test("manifest validation: command cards are native, fixed-size, and read-only", () => {
  const valid = validateManifest({
    name: "Command Widgets",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    functions: {
      widget_overview_ui: { description: "Render the full widget" },
      widget_overview_data: { description: "Fetch widget and card data" },
    },
    widgets: [
      {
        id: "overview",
        label: "Overview",
        cards: [
          {
            id: "queue",
            label: "Queue",
            size: "2x1",
            render: "native",
            data_view: "queue",
            dependencies: [{
              app: "email-ops",
              functions: ["list_drafts"],
              access: "read",
            }],
          },
        ],
      },
    ],
  });

  assertEquals(valid.valid, true);
  assertEquals(valid.errors, []);

  const invalid = validateManifest({
    name: "Command Widgets",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    widgets: [
      {
        id: "overview",
        label: "Overview",
        cards: [
          {
            id: "queue",
            label: "Queue",
            size: "wide",
            render: "iframe",
            dependencies: [{
              app: "email-ops",
              functions: ["send_email"],
              access: "write",
            }],
          },
        ],
      },
    ],
  });

  assertEquals(invalid.valid, false);
  assertEquals(
    invalid.errors.some((error) => error.path.endsWith(".size")),
    true,
  );
  assertEquals(
    invalid.errors.some((error) => error.path.endsWith(".render")),
    true,
  );
  assertEquals(
    invalid.errors.some((error) => error.path.endsWith(".access")),
    true,
  );
});
