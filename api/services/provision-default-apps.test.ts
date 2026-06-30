// Tests for default-install seeding (provisionDefaultApps). The defaults come
// from the owner's private Defaults Manager Agent (injected here via
// readSourceDefaults so the seeding logic is exercised without R2). Forward-only:
// seeds only the new user's library, validated live+installable, one batched
// upsert, never app_likes.

import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { provisionDefaultApps } from "./request-auth.ts";

const SB_URL = "https://supabase.test";

interface Call {
  method: string;
  url: string;
  body?: string;
}

async function withFetch(
  handler: (url: string, init?: RequestInit) => Response,
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const g = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const prevEnv = g.__env;
  const prevFetch = globalThis.fetch;
  const calls: Call[] = [];
  g.__env = {
    ...(prevEnv || {}),
    SUPABASE_URL: SB_URL,
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? String(init.body) : undefined,
    });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = prevFetch;
    g.__env = prevEnv;
  }
}

const APP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APP_PRIVATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

Deno.test("provisionDefaultApps: seeds the library from the source list, keeping only live+installable, in one batched upsert", async () => {
  await withFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (url.includes("/rest/v1/apps") && method === "GET") {
      // Validation: only A and B are live + public/unlisted (PRIVATE excluded).
      return Response.json([{ id: APP_A }, { id: APP_B }]);
    }
    if (url.includes("/rest/v1/user_app_library") && method === "POST") {
      return new Response("{}", { status: 201 });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }, async (calls) => {
    await provisionDefaultApps("user-1", {
      readSourceDefaults: () =>
        Promise.resolve([
          { app_id: APP_A, badge: "Starter" },
          { app_id: APP_B },
          { app_id: APP_PRIVATE },
        ]),
    });

    // Never fabricates a like on signup.
    assertEquals(
      calls.some((c) => c.url.includes("/rest/v1/app_likes")),
      false,
    );

    // Validation query is keyed on id and filters installable.
    const appsQuery = calls.find((c) =>
      c.url.includes("/rest/v1/apps") && c.method === "GET"
    );
    assertEquals(Boolean(appsQuery), true);
    assertEquals(
      appsQuery!.url.includes("visibility=in.(public,unlisted)"),
      true,
    );
    assertEquals(
      appsQuery!.url.includes(`id=in.(${APP_A},${APP_B},${APP_PRIVATE})`),
      true,
    );

    // Exactly one batched upsert, only the installable ids.
    const lib = calls.filter((c) =>
      c.url.includes("/rest/v1/user_app_library") && c.method === "POST"
    );
    assertEquals(lib.length, 1);
    const rows = JSON.parse(lib[0].body!) as Array<
      { user_id: string; app_id: string; source: string }
    >;
    assertEquals(rows, [
      { user_id: "user-1", app_id: APP_A, source: "default" },
      { user_id: "user-1", app_id: APP_B, source: "default" },
    ]);
  });
});

Deno.test("provisionDefaultApps: empty source list seeds nothing (no fetches)", async () => {
  await withFetch(() => {
    throw new Error("no fetch expected for an empty source list");
  }, async (calls) => {
    await provisionDefaultApps("user-1", {
      readSourceDefaults: () => Promise.resolve([]),
    });
    assertEquals(calls.length, 0);
  });
});

Deno.test("provisionDefaultApps: every source app unpublished -> no library write", async () => {
  await withFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (url.includes("/rest/v1/apps") && method === "GET") {
      return Response.json([]); // none currently live/installable
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }, async (calls) => {
    await provisionDefaultApps("user-1", {
      readSourceDefaults: () => Promise.resolve([{ app_id: APP_A }]),
    });
    assertEquals(
      calls.some((c) => c.url.includes("/rest/v1/user_app_library")),
      false,
    );
  });
});
