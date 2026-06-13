import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import type { AppManifest } from "../../shared/contracts/manifest.ts";
import {
  INTERFACE_MAX_BYTES,
  InterfaceArtifactError,
  interfaceArtifactPrefixForApp,
  prepareInterfaceArtifacts,
} from "./interface-artifacts.ts";

const encoder = new TextEncoder();

function baseManifest(overrides: Record<string, unknown> = {}): AppManifest {
  return {
    name: "Interface App",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    functions: { listItems: { description: "List items" } },
    ...overrides,
  } as AppManifest;
}

async function sha256Hex(content: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(content));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("interface artifacts: returns null when manifest declares no interfaces", async () => {
  assertEquals(
    await prepareInterfaceArtifacts({ manifest: null, files: [] }),
    null,
  );
  assertEquals(
    await prepareInterfaceArtifacts({ manifest: baseManifest(), files: [] }),
    null,
  );
  assertEquals(
    await prepareInterfaceArtifacts({
      manifest: baseManifest({ interfaces: [] }),
      files: [],
    }),
    null,
  );
});

Deno.test("interface artifacts: stamps content hash and stages a content-addressed copy", async () => {
  const html = encoder.encode("<!doctype html><h1>Dashboard</h1>");
  const expectedHash = await sha256Hex(html);
  const manifest = baseManifest({
    interfaces: [{
      id: "dashboard",
      label: "Dashboard",
      entry: "interfaces/dashboard.html",
      functions: ["listItems"],
    }],
  });

  const prep = await prepareInterfaceArtifacts({
    manifest,
    files: [
      { name: "index.ts", content: encoder.encode("export {}") },
      { name: "interfaces/dashboard.html", content: html },
    ],
  });

  assertEquals(prep?.manifest.interfaces?.[0].hash, expectedHash);
  assertEquals(prep?.artifacts, [{
    name: `${expectedHash}.html`,
    content: html,
    contentType: "text/html; charset=utf-8",
  }]);
  // Input manifest is not mutated — stamping returns a copy.
  assertEquals(manifest.interfaces?.[0].hash, undefined);
});

Deno.test("interface artifacts: overwrites developer-supplied hash", async () => {
  const html = encoder.encode("<p>hi</p>");
  const expectedHash = await sha256Hex(html);
  const prep = await prepareInterfaceArtifacts({
    manifest: baseManifest({
      interfaces: [{
        id: "a",
        label: "A",
        entry: "a.html",
        functions: ["listItems"],
        hash: "deadbeef".repeat(8), // never trusted
      }],
    }),
    files: [{ name: "a.html", content: html }],
  });
  assertEquals(prep?.manifest.interfaces?.[0].hash, expectedHash);
});

Deno.test("interface artifacts: dedupes identical entries into one artifact", async () => {
  const html = encoder.encode("<p>shared</p>");
  const expectedHash = await sha256Hex(html);
  const prep = await prepareInterfaceArtifacts({
    manifest: baseManifest({
      interfaces: [
        { id: "a", label: "A", entry: "ui.html", functions: ["listItems"] },
        { id: "b", label: "B", entry: "ui.html", functions: ["listItems"] },
      ],
    }),
    files: [{ name: "ui.html", content: html }],
  });
  assertEquals(prep?.artifacts.length, 1);
  assertEquals(prep?.manifest.interfaces?.map((i) => i.hash), [
    expectedHash,
    expectedHash,
  ]);
});

Deno.test("interface artifacts: rejects entries missing from the upload", async () => {
  await assertRejects(
    () =>
      prepareInterfaceArtifacts({
        manifest: baseManifest({
          interfaces: [{
            id: "ghost",
            label: "Ghost",
            entry: "missing.html",
            functions: ["listItems"],
          }],
        }),
        files: [{ name: "index.ts", content: encoder.encode("export {}") }],
      }),
    InterfaceArtifactError,
    'Interface "ghost" entry file not found in upload: missing.html',
  );
});

Deno.test("interface artifacts: rejects oversize entries", async () => {
  await assertRejects(
    () =>
      prepareInterfaceArtifacts({
        manifest: baseManifest({
          interfaces: [{
            id: "big",
            label: "Big",
            entry: "big.html",
            functions: ["listItems"],
          }],
        }),
        files: [{
          name: "big.html",
          content: new Uint8Array(INTERFACE_MAX_BYTES + 1),
        }],
      }),
    InterfaceArtifactError,
    "at most",
  );
});

Deno.test("interface artifacts: hashing is deterministic so re-uploads are idempotent", async () => {
  const html = encoder.encode("<p>stable</p>");
  const manifest = baseManifest({
    interfaces: [{
      id: "a",
      label: "A",
      entry: "a.html",
      functions: ["listItems"],
    }],
  });
  const first = await prepareInterfaceArtifacts({
    manifest,
    files: [{ name: "a.html", content: html }],
  });
  const second = await prepareInterfaceArtifacts({
    manifest,
    files: [{ name: "a.html", content: new Uint8Array(html) }],
  });
  assertEquals(first?.artifacts[0].name, second?.artifacts[0].name);
});

Deno.test("interface artifacts: per-app prefix shape", () => {
  assertEquals(
    interfaceArtifactPrefixForApp("app-123"),
    "interfaces/app-123/",
  );
});
