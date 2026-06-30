import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { generateUniqueSlug, parsePackageName, slugifyName } from "./upload.ts";

Deno.test("slugifyName: name -> legible slug", () => {
  assertEquals(slugifyName("Story Builder"), "story-builder");
  assertEquals(slugifyName("  Hello, World!  "), "hello-world");
  assertEquals(slugifyName("a--b__c"), "a-b-c");
  assertEquals(slugifyName("123"), "123");
  assertEquals(slugifyName("MixedCASE Tool"), "mixedcase-tool");
});

Deno.test("slugifyName: strips diacritics", () => {
  assertEquals(slugifyName("Café Münchën"), "cafe-munchen");
});

Deno.test("slugifyName: empty when no usable alphanumerics", () => {
  assertEquals(slugifyName("!!!"), "");
  assertEquals(slugifyName("   "), "");
});

Deno.test("slugifyName: caps length with no trailing hyphen", () => {
  assertEquals(slugifyName("a".repeat(40)).length, 30);
  const s = slugifyName("word ".repeat(10));
  assertEquals(s.endsWith("-"), false);
  assertEquals(s.length <= 30, true);
});

Deno.test("parsePackageName", () => {
  assertEquals(parsePackageName('{"name":"My Pkg"}'), "My Pkg");
  assertEquals(parsePackageName('{"version":"1"}'), null);
  assertEquals(parsePackageName('{"name":"   "}'), null);
  assertEquals(parsePackageName("not json"), null);
  assertEquals(parsePackageName(undefined), null);
});

// ── generateUniqueSlug — stub env + the global slug-existence lookup ──

async function withTakenSlugs<T>(
  taken: Set<string>,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  } as typeof globalThis.__env;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://supabase.test/rest/v1/apps")) {
      const slug = (new URL(url).searchParams.get("slug") || "").replace(
        /^eq\./,
        "",
      );
      const exists = taken.has(slug);
      return Promise.resolve(
        new Response(JSON.stringify(exists ? [{ id: "x" }] : []), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("[]", { status: 200 }));
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
}

Deno.test("generateUniqueSlug: free name resolves to the bare slug", async () => {
  await withTakenSlugs(new Set(), async () => {
    assertEquals(await generateUniqueSlug("Story Builder"), "story-builder");
  });
});

Deno.test("generateUniqueSlug: collision appends -2, -3 …", async () => {
  await withTakenSlugs(new Set(["story-builder"]), async () => {
    assertEquals(await generateUniqueSlug("Story Builder"), "story-builder-2");
  });
  await withTakenSlugs(new Set(["story-builder", "story-builder-2"]), async () => {
    assertEquals(await generateUniqueSlug("Story Builder"), "story-builder-3");
  });
});

Deno.test("generateUniqueSlug: empty name falls back to app- form", async () => {
  await withTakenSlugs(new Set(), async () => {
    const s = await generateUniqueSlug(null);
    assertEquals(s.startsWith("app-"), true);
  });
});
