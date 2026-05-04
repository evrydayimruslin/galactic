import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { checkRateLimit } from "./ratelimit.ts";
import { checkStorageQuota } from "./storage-quota.ts";
import { checkDataQuota } from "./data-quota.ts";
import { checkAndIncrementWeeklyCalls } from "./weekly-calls.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

let testQueue = Promise.resolve();

async function runSerial(fn: () => Promise<void>): Promise<void> {
  const run = testQueue.then(fn, fn);
  testQueue = run.catch(() => {});
  await run;
}

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

Deno.test("Rate limit enforcement: backend failures stay fail-open by default", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async () => new Response("rpc unavailable", { status: 503 }),
      async () => {
        const result = await checkRateLimit(
          "11111111-1111-1111-1111-111111111111",
          "chat:stream",
          undefined,
          undefined,
          { mode: "fail_open", resource: "chat stream" },
        );

        assertEquals(result.allowed, true);
        assertEquals(result.reason, "service_unavailable");
      },
    );
  });
});

Deno.test("Rate limit enforcement: backend failures can fail closed for high-cost paths", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async () => new Response("rpc unavailable", { status: 503 }),
      async () => {
        const result = await checkRateLimit(
          "22222222-2222-2222-2222-222222222222",
          "chat:stream",
          undefined,
          undefined,
          { mode: "fail_closed", resource: "chat stream" },
        );

        assertEquals(result.allowed, false);
        assertEquals(result.reason, "service_unavailable");
      },
    );
  });
});

Deno.test("Rate limit enforcement: in-memory buckets still report real limit exhaustion", async () => {
  const key = `anon-${crypto.randomUUID()}`;
  const first = await checkRateLimit(key, "discover", 1, 1);
  const second = await checkRateLimit(key, "discover", 1, 1);

  assertEquals(first.allowed, true);
  assertEquals(second.allowed, false);
  assertEquals(second.reason, "limit_exceeded");
});

Deno.test("Storage soft caps: backend failures do not block uploads", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async () => new Response("db unavailable", { status: 503 }),
      async () => {
        const openResult = await checkStorageQuota("user-1", 1024, {
          mode: "fail_open",
          resource: "test upload",
        });
        const closedResult = await checkStorageQuota("user-1", 1024, {
          mode: "fail_closed",
          resource: "test upload",
        });

        assertEquals(openResult.allowed, true);
        assertEquals(openResult.reason, "service_unavailable");
        assertEquals(closedResult.allowed, true);
        assertEquals(closedResult.reason, "service_unavailable");
      },
    );
  });
});

Deno.test("Storage soft caps: projected overages are reported without blocking", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async () =>
        new Response(JSON.stringify([{
          storage_used_bytes: 104_857_590,
          data_storage_used_bytes: 20,
        }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      async () => {
        const result = await checkStorageQuota("user-1", 15, {
          mode: "fail_closed",
          resource: "strict upload",
        });

        assertEquals(result.allowed, true);
        assertEquals(result.over_soft_cap, true);
        assertEquals(result.reason, undefined);
      },
    );
  });
});

Deno.test("Data soft caps: overages and backend failures do not block writes", async () => {
  await runSerial(async () => {
    let callCount = 0;
    await withMockedEnvAndFetch(
      async () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify([{
            allowed: false,
            source_used_bytes: 50,
            data_used_bytes: 75,
            combined_used_bytes: 125,
            limit_bytes: 100,
            remaining_bytes: 0,
            has_hosting_balance: false,
          }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("rpc unavailable", { status: 503 });
      },
      async () => {
        const denied = await checkDataQuota("user-1", 50, {
          mode: "fail_closed",
          resource: "test write",
        });
        const unavailable = await checkDataQuota("user-1", 50, {
          mode: "fail_closed",
          resource: "test write",
        });

        assertEquals(denied.allowed, true);
        assertEquals(denied.over_soft_cap, true);
        assertEquals(denied.reason, undefined);
        assertEquals(unavailable.allowed, true);
        assertEquals(unavailable.reason, "service_unavailable");
      },
    );
  });
});

Deno.test("Weekly call enforcement: high-cost paths can fail closed when the backend is unavailable", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async () => new Response("rpc unavailable", { status: 503 }),
      async () => {
        const result = await checkAndIncrementWeeklyCalls(
          "33333333-3333-3333-3333-333333333333",
          "free",
          { mode: "fail_closed", resource: "weekly limit" },
        );

        assertEquals(result.allowed, false);
        assertEquals(result.reason, "service_unavailable");
        assertEquals(result.limit > 0, true);
      },
    );
  });
});

Deno.test("Storage soft caps: missing usage rows do not block strict upload paths", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      async () => {
        const result = await checkStorageQuota("user-1", 2048, {
          mode: "fail_closed",
          resource: "strict upload",
        });

        assertEquals(result.allowed, true);
        assertEquals(result.reason, "service_unavailable");
        assert(result.remaining_bytes > 0);
      },
    );
  });
});
