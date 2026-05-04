import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import {
  getVersionStorageBytes,
  reclaimAppStorage,
  recordUploadStorage,
} from "./storage-quota.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

async function withMockedEnvAndFetch(
  handler: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const globalWithEnv = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const previousEnv = globalWithEnv.__env;
  const previousFetch = globalThis.fetch;

  globalWithEnv.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  };
  globalThis.fetch = handler as typeof fetch;

  try {
    await fn();
  } finally {
    globalThis.fetch = previousFetch;
    globalWithEnv.__env = previousEnv;
  }
}

Deno.test("storage accounting: live uploads call delta RPC and parse accounting row", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  await withMockedEnvAndFetch(
    async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        body: JSON.parse(String(init?.body || "{}")),
      });

      return Response.json([{
        previous_bytes: 40,
        new_bytes: 123,
        delta_bytes: 83,
        user_storage_used_bytes: 1000,
      }]);
    },
    async () => {
      const result = await recordUploadStorage("user-1", "app-1", "1.0.0", 123.9);

      assertEquals(calls.length, 1);
      assertEquals(calls[0].url, "https://supabase.test/rest/v1/rpc/set_app_storage_bytes");
      assertEquals(calls[0].body, {
        p_user_id: "user-1",
        p_app_id: "app-1",
        p_size_bytes: 123,
      });
      assertEquals(result, {
        previous_bytes: 40,
        new_bytes: 123,
        delta_bytes: 83,
        user_storage_used_bytes: 1000,
      });
    },
  );
});

Deno.test("storage accounting: reclaim app storage parses scalar RPC responses", async () => {
  await withMockedEnvAndFetch(
    async (input, init) => {
      assertEquals(String(input), "https://supabase.test/rest/v1/rpc/reclaim_app_storage");
      assertEquals(JSON.parse(String(init?.body || "{}")), {
        p_user_id: "user-1",
        p_app_id: "app-1",
      });
      return Response.json(512);
    },
    async () => {
      assertEquals(await reclaimAppStorage("user-1", "app-1"), 512);
    },
  );
});

Deno.test("storage accounting: version metadata lookup uses latest matching entry", () => {
  assertEquals(
    getVersionStorageBytes([
      { version: "1.0.0", size_bytes: 100 },
      { version: "2.0.0", size_bytes: 250 },
      { version: "1.0.0", size_bytes: 125 },
    ], "1.0.0"),
    125,
  );

  assertEquals(getVersionStorageBytes([{ version: "1.0.0", size_bytes: -1 }], "1.0.0"), null);
  assertEquals(getVersionStorageBytes(null, "1.0.0"), null);
});
