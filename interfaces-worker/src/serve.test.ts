import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertStringIncludes } from "https://deno.land/std@0.210.0/assert/assert_string_includes.ts";

import {
  buildContentSecurityPolicy,
  handleInterfaceRequest,
  type InterfaceWorkerEnv,
  parseInterfacePath,
} from "./serve.ts";

const APP_ID = "0f8b6f0a-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
const HASH = "a".repeat(64);
const VALID_PATH = `/i/${APP_ID}/${HASH}`;

function fakeEnv(
  objects: Record<string, string> = {},
  vars: Partial<InterfaceWorkerEnv> = {},
): InterfaceWorkerEnv {
  return {
    R2_BUCKET: {
      get(key: string) {
        if (!(key in objects)) return Promise.resolve(null);
        const body = new Response(objects[key]).body;
        return Promise.resolve({ body });
      },
      head(key: string) {
        return Promise.resolve(key in objects ? {} : null);
      },
    },
    FRAME_ANCESTORS: "https://launch.example",
    ...vars,
  };
}

function req(path: string, method = "GET"): Request {
  return new Request(`https://interfaces.example${path}`, { method });
}

Deno.test("interfaces worker: path parser accepts only /i/{uuid}/{sha256}", () => {
  assertEquals(parseInterfacePath(VALID_PATH), {
    key: `interfaces/${APP_ID}/${HASH}.html`,
  });

  const rejected = [
    "/", // root
    `/i/${APP_ID}`, // missing hash
    `/i/${APP_ID}/${HASH}/extra`, // extra segment
    `/i/${APP_ID}/${HASH}.html`, // suffix not part of the URL shape
    `/i/${APP_ID.toUpperCase()}/${HASH}`, // uppercase uuid
    `/i/${APP_ID}/${HASH.slice(0, 63)}`, // short hash
    `/i/${APP_ID}/${HASH.slice(0, 63)}G`, // non-hex char
    `/i/not-a-uuid/${HASH}`,
    `/i/../${APP_ID}/${HASH}`, // traversal shape
    `/i/${APP_ID}/%2e%2e`, // encoded traversal stays encoded and fails hex
    `/x/${APP_ID}/${HASH}`, // wrong prefix
  ];
  for (const path of rejected) {
    assertEquals(parseInterfacePath(path), null, `expected reject: ${path}`);
  }
});

Deno.test("interfaces worker: serves stored HTML with the full security header suite", async () => {
  const env = fakeEnv({
    [`interfaces/${APP_ID}/${HASH}.html`]: "<!doctype html><p>hi</p>",
  });
  const response = await handleInterfaceRequest(req(VALID_PATH), env);

  assertEquals(response.status, 200);
  assertEquals(await response.text(), "<!doctype html><p>hi</p>");
  assertEquals(
    response.headers.get("Content-Type"),
    "text/html; charset=utf-8",
  );
  assertEquals(
    response.headers.get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
  assertEquals(response.headers.get("X-Content-Type-Options"), "nosniff");
  assertEquals(response.headers.get("Referrer-Policy"), "no-referrer");
  assertEquals(response.headers.get("X-Robots-Tag"), "noindex");
  assertEquals(
    response.headers.get("Cross-Origin-Resource-Policy"),
    "cross-origin",
  );
  assertEquals(response.headers.get("Set-Cookie"), null);

  const csp = response.headers.get("Content-Security-Policy") ?? "";
  assertStringIncludes(csp, "sandbox allow-scripts allow-forms");
  assertStringIncludes(csp, "default-src 'none'");
  assertStringIncludes(csp, "base-uri 'none'");
  assertStringIncludes(csp, "form-action 'none'");
  assertStringIncludes(csp, "frame-ancestors https://launch.example");
});

Deno.test("interfaces worker: HEAD returns headers without a body", async () => {
  const env = fakeEnv({
    [`interfaces/${APP_ID}/${HASH}.html`]: "<p>hi</p>",
  });
  const response = await handleInterfaceRequest(req(VALID_PATH, "HEAD"), env);
  assertEquals(response.status, 200);
  assertEquals(response.body, null);
  assertEquals(
    response.headers.get("Content-Type"),
    "text/html; charset=utf-8",
  );
});

Deno.test("interfaces worker: missing object is an uncached 404", async () => {
  const response = await handleInterfaceRequest(req(VALID_PATH), fakeEnv());
  assertEquals(response.status, 404);
  assertEquals(response.headers.get("Cache-Control"), "no-store");
  assertEquals(response.headers.get("X-Content-Type-Options"), "nosniff");
  assertEquals(response.headers.get("Set-Cookie"), null);
});

Deno.test("interfaces worker: invalid paths 404 without touching storage", async () => {
  const env: InterfaceWorkerEnv = {
    R2_BUCKET: {
      get() {
        throw new Error("storage must not be reached for invalid paths");
      },
      head() {
        throw new Error("storage must not be reached for invalid paths");
      },
    },
  };
  for (
    const path of [
      `/i/${APP_ID}/nothash`,
      `/interfaces/${APP_ID}/${HASH}.html`, // raw key shape is not a route
      `/apps/${APP_ID}/1.0.0/index.ts`, // bundle path must never resolve (I1)
    ]
  ) {
    const response = await handleInterfaceRequest(req(path), env);
    assertEquals(response.status, 404, `expected 404: ${path}`);
  }
});

Deno.test("interfaces worker: non-GET/HEAD methods get 405 with Allow", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await handleInterfaceRequest(
      req(VALID_PATH, method),
      fakeEnv(),
    );
    assertEquals(response.status, 405);
    assertEquals(response.headers.get("Allow"), "GET, HEAD");
  }
});

Deno.test("interfaces worker: root responds 204 with no body", async () => {
  const response = await handleInterfaceRequest(req("/"), fakeEnv());
  assertEquals(response.status, 204);
  assertEquals(response.body, null);
});

Deno.test("interfaces worker: missing FRAME_ANCESTORS fails closed to 'none'", async () => {
  const env = fakeEnv(
    { [`interfaces/${APP_ID}/${HASH}.html`]: "<p>hi</p>" },
    { FRAME_ANCESTORS: undefined },
  );
  const response = await handleInterfaceRequest(req(VALID_PATH), env);
  assertStringIncludes(
    response.headers.get("Content-Security-Policy") ?? "",
    "frame-ancestors 'none'",
  );
  assertEquals(buildContentSecurityPolicy("   "), buildContentSecurityPolicy(""));
});
