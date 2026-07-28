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
    request = new Request(
      input instanceof Request ? input.url : String(input),
      init as RequestInit | undefined,
    );
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

Deno.test("owner slug lookup excludes soft-deleted apps", async () => {
  const originalFetch = globalThis.fetch;
  let request: Request | null = null;
  globalThis.fetch = (input, init) => {
    request = new Request(
      input instanceof Request ? input.url : String(input),
      init as RequestInit | undefined,
    );
    return Promise.resolve(Response.json([]));
  };
  try {
    const service = new AppsService({
      url: "https://database.example",
      serviceKey: "service-role-test-key",
    });
    assertEquals(await service.findBySlug(USER_ID, "invoice-agent"), null);
    const captured = request as Request | null;
    if (!captured) throw new Error("expected app lookup request");
    const url = new URL(captured.url);
    assertEquals(url.searchParams.get("owner_id"), `eq.${USER_ID}`);
    assertEquals(url.searchParams.get("slug"), "eq.invoice-agent");
    assertEquals(url.searchParams.get("deleted_at"), "is.null");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("version metadata CAS is owner-scoped and excludes deleted apps", async () => {
  const originalFetch = globalThis.fetch;
  let request: Request | null = null;
  globalThis.fetch = (input, init) => {
    request = new Request(
      input instanceof Request ? input.url : String(input),
      init as RequestInit | undefined,
    );
    return Promise.resolve(Response.json([]));
  };
  try {
    const service = new AppsService({
      url: "https://database.example",
      serviceKey: "service-role-test-key",
    });
    assertEquals(
      await service.compareAndSwapVersionMetadata({
        appId: APP_ID,
        ownerId: USER_ID,
        expectedUpdatedAt: "2026-07-27T00:00:00.000Z",
        expectedCurrentVersion: "1.0.0",
        versionMetadata: [],
      }),
      false,
    );
    const captured = request as Request | null;
    if (!captured) throw new Error("expected metadata CAS request");
    const url = new URL(captured.url);
    assertEquals(url.searchParams.get("id"), `eq.${APP_ID}`);
    assertEquals(url.searchParams.get("owner_id"), `eq.${USER_ID}`);
    assertEquals(url.searchParams.get("deleted_at"), "is.null");
    assertEquals(url.searchParams.get("current_version"), "eq.1.0.0");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
