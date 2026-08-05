import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyWorkerVersionResponseHeader,
  GALACTIC_WORKER_VERSION_HEADER,
  workerVersionId,
} from "./worker-version-metadata.ts";

const VERSION_ID = "12345678-1234-1234-1234-123456789abc";

Deno.test("worker version metadata accepts only a canonical Cloudflare version id", () => {
  assertEquals(
    workerVersionId({ CF_VERSION_METADATA: { id: VERSION_ID } }),
    VERSION_ID,
  );
  for (const id of [undefined, "", "not-a-version", VERSION_ID.toUpperCase()]) {
    assertEquals(workerVersionId({ CF_VERSION_METADATA: { id } }), null);
  }
});

Deno.test("worker version response attestation is emitted only for override requests", () => {
  const headers = new Headers();
  applyWorkerVersionResponseHeader(
    headers,
    new Request("https://example.com"),
    { CF_VERSION_METADATA: { id: VERSION_ID } },
  );
  assertEquals(headers.get(GALACTIC_WORKER_VERSION_HEADER), null);

  applyWorkerVersionResponseHeader(
    headers,
    new Request("https://example.com", {
      headers: {
        "Cloudflare-Workers-Version-Overrides":
          `ultralight-api-staging="${VERSION_ID}"`,
      },
    }),
    { CF_VERSION_METADATA: { id: VERSION_ID } },
  );
  assertEquals(headers.get(GALACTIC_WORKER_VERSION_HEADER), VERSION_ID);
});

Deno.test("worker version response attestation fails closed on missing metadata", () => {
  const headers = new Headers();
  applyWorkerVersionResponseHeader(
    headers,
    new Request("https://example.com", {
      headers: {
        "Cloudflare-Workers-Version-Overrides":
          `ultralight-api-staging="${VERSION_ID}"`,
      },
    }),
    {},
  );
  assertEquals(headers.get(GALACTIC_WORKER_VERSION_HEADER), null);
});
