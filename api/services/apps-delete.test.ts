import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import { AppsService } from "./apps.ts";
import { AppDeletionConflictError } from "./apps.ts";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

Deno.test("owned app deletion calls the atomic service-role RPC", async () => {
  const originalFetch = globalThis.fetch;
  let request: Request | null = null;
  globalThis.fetch = (input, init) => {
    request = new Request(input, init);
    return Promise.resolve(Response.json([{
      deleted: true,
      reclaimed_bytes: "4096",
    }]));
  };
  try {
    const service = new AppsService({
      url: "https://database.example",
      serviceKey: "service-role-test-key",
    });
    const result = await service.softDeleteOwned(
      APP_ID,
      USER_ID,
      "2026-07-20T12:00:00.000Z",
    );
    assertEquals(result, { deleted: true, reclaimedBytes: 4096 });
    const captured = request as Request | null;
    if (!captured) throw new Error("expected RPC request");
    assertEquals(
      captured.url,
      "https://database.example/rest/v1/rpc/soft_delete_owned_app",
    );
    assertEquals(captured.method, "POST");
    assertEquals(
      captured.headers.get("authorization"),
      "Bearer service-role-test-key",
    );
    assertEquals(await captured.json(), {
      p_user_id: USER_ID,
      p_app_id: APP_ID,
      p_deleted_at: "2026-07-20T12:00:00.000Z",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("owned app deletion rejects malformed RPC results", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(Response.json([{
      deleted: true,
      reclaimed_bytes: "not-a-number",
    }]));
  try {
    const service = new AppsService({
      url: "https://database.example",
      serviceKey: "service-role-test-key",
    });
    await assertRejects(
      () => service.softDeleteOwned(APP_ID, USER_ID),
      Error,
      "invalid result",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("owned app deletion retries lock contention then returns a conflict", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = () => {
    attempts += 1;
    return Promise.resolve(Response.json({ code: "40001" }, { status: 500 }));
  };
  try {
    const service = new AppsService({
      url: "https://database.example",
      serviceKey: "service-role-test-key",
    });
    await assertRejects(
      () => service.softDeleteOwned(APP_ID, USER_ID),
      AppDeletionConflictError,
    );
    assertEquals(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
