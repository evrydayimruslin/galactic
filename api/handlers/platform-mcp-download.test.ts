import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { executeDownload } from "./platform-mcp.ts";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const VERSION = "1.0.0";

function fakeR2(files: Readonly<Record<string, Uint8Array>>): R2Bucket {
  return {
    list: ({ prefix }: { prefix?: string }) =>
      Promise.resolve({
        objects: Object.keys(files)
          .filter((key) => key.startsWith(prefix ?? ""))
          .map((key) => ({ key })),
        truncated: false,
      }),
    get: (key: string) => {
      const bytes = files[key];
      if (!bytes) return Promise.resolve(null);
      return Promise.resolve({
        arrayBuffer: () =>
          Promise.resolve(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
          ),
      });
    },
  } as unknown as R2Bucket;
}

Deno.test(
  "gx.download: existing Agent returns exact galactic.yaml and omits compiled manifest",
  async () => {
    const authoredYaml = [
      "# Preserve this authored comment and whitespace exactly.",
      "apiVersion: agents.connectgalactic.com/v1alpha1",
      "kind: Agent",
      "metadata: { name: exact-source }  ",
      "",
    ].join("\r\n");
    const authoredSource = 'export function run() { return "authored"; }\n';
    const compiledManifest = JSON.stringify({
      name: "server-derived",
      functions: { run: {} },
    });
    const prefix = `apps/${APP_ID}/${VERSION}/`;
    const encode = (value: string) => new TextEncoder().encode(value);
    const files = {
      [`${prefix}_source_index.ts`]: encode(authoredSource),
      [`${prefix}index.ts`]: encode('var run=()=>"compiled";'),
      [`${prefix}index.esm.js`]: encode(
        'export const run=()=>"compiled";',
      ),
      [`${prefix}galactic.yaml`]: encode(authoredYaml),
      [`${prefix}manifest.json`]: encode(compiledManifest),
    };

    const previousEnv = globalThis.__env;
    const previousFetch = globalThis.fetch;
    globalThis.__env = {
      SUPABASE_URL: "https://download.supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "download-service-role",
      R2_BUCKET: fakeR2(files),
    } as unknown as typeof globalThis.__env;
    globalThis.fetch = (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : input.url,
      );
      assertEquals(url.pathname, "/rest/v1/apps");
      assertEquals(url.searchParams.get("id"), `eq.${APP_ID}`);
      return Promise.resolve(
        Response.json([{
          id: APP_ID,
          owner_id: OWNER_ID,
          slug: "exact-source",
          name: "Exact Source",
          visibility: "private",
          download_access: "owner",
          current_version: VERSION,
          version_metadata: [],
        }]),
      );
    };

    try {
      const result = await executeDownload(OWNER_ID, {
        app_id: APP_ID,
      }) as {
        files: Array<{ path: string; content: string }>;
        file_count: number;
      };
      const byPath = new Map(
        result.files.map((file) => [file.path, file.content]),
      );

      assertEquals(result.file_count, 2);
      assertEquals([...byPath.keys()].sort(), ["galactic.yaml", "index.ts"]);
      assertEquals(byPath.get("galactic.yaml"), authoredYaml);
      assertEquals(byPath.get("index.ts"), authoredSource);
      assertEquals(byPath.has("manifest.json"), false);
      assertEquals(
        result.files.some((file) => file.content === compiledManifest),
        false,
      );
    } finally {
      globalThis.fetch = previousFetch;
      globalThis.__env = previousEnv;
    }
  },
);
