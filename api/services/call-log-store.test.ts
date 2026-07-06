import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";
import {
  buildCallLogObjectKey,
  persistPreparedCallLogs,
  CALL_LOG_MAX_BYTES,
  CallLogForbidden,
  CallLogNotFound,
  prepareCallLogCapture,
  readCallLogsByReceipt,
  sweepExpiredCallLogs,
  truncateLogsToTail,
} from "./call-log-store.ts";
import type { LogEntry } from "../../shared/types/index.ts";

function entry(message: string, level: LogEntry["level"] = "log"): LogEntry {
  return { time: "2026-07-06T00:00:00.000Z", level, message };
}

// ---------- pure helpers ----------

Deno.test("call-log store: object key is deterministic per (app, receipt)", () => {
  assertEquals(
    buildCallLogObjectKey("app-1", "rcpt-1"),
    "call-logs/app-1/rcpt-1.json",
  );
});

Deno.test("call-log store: truncation keeps the TAIL and marks what it dropped", () => {
  const logs = Array.from({ length: 5000 }, (_, i) => entry(`line ${i} ${"x".repeat(100)}`));
  const bounded = truncateLogsToTail(logs);
  assert(bounded.truncated, "should be marked truncated");
  assert(bounded.droppedEntries > 0, "should drop oldest entries");
  assert(bounded.bytes <= CALL_LOG_MAX_BYTES, "stays under the cap");
  // The LAST line survives (the crash is at the end); the first is dropped.
  assertEquals(bounded.entries.at(-1)?.message.startsWith("line 4999"), true);
  assertEquals(bounded.entries[0]?.message.startsWith("line 0 "), false);
});

Deno.test("call-log store: one giant line is clipped, not allowed to eat the budget", () => {
  const logs = [entry("small before"), entry("y".repeat(100_000)), entry("small after")];
  const bounded = truncateLogsToTail(logs);
  assert(bounded.truncated);
  assertEquals(bounded.entries.length, 3, "all three entries survive once the line is clipped");
  assert(bounded.entries[1].message.includes("[line clipped]"));
  assertEquals(bounded.entries.at(-1)?.message, "small after");
});

Deno.test("call-log store: prepare returns null when there is nothing to store", () => {
  assertEquals(prepareCallLogCapture({ appId: "a", receiptId: "r", logs: [] }), null);
  assertEquals(prepareCallLogCapture({ appId: "a", receiptId: "r", logs: undefined }), null);
  assertEquals(prepareCallLogCapture({ appId: undefined, receiptId: "r", logs: [entry("x")] }), null);
  assertEquals(prepareCallLogCapture({ appId: "a", receiptId: undefined, logs: [entry("x")] }), null);
});

Deno.test("call-log store: prepare produces pointer + parseable payload", () => {
  const prepared = prepareCallLogCapture({
    appId: "app-9",
    receiptId: "rcpt-9",
    logs: [entry("hello"), entry("boom", "error")],
  });
  assert(prepared);
  assertEquals(prepared!.objectKey, "call-logs/app-9/rcpt-9.json");
  const payload = JSON.parse(prepared!.body);
  assertEquals(payload.receipt_id, "rcpt-9");
  assertEquals(payload.logs.length, 2);
  assertEquals(payload.logs[1].level, "error");
  assert(prepared!.bytes > 0);
});

// ---------- read + sweep (mocked env) ----------

type EnvGlobal = typeof globalThis & { __env?: Record<string, unknown> };

class FakeR2 {
  store = new Map<string, string>();
  deletes: string[] = [];
  // deno-lint-ignore no-explicit-any
  async get(key: string): Promise<any> {
    const v = this.store.get(key);
    return v === undefined ? null : { text: () => Promise.resolve(v) };
  }
  async put(key: string, body: string): Promise<void> {
    this.store.set(key, body);
  }
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.store.delete(key);
  }
}

async function withEnv<T>(
  fetchMock: typeof fetch,
  r2: FakeR2,
  fn: () => Promise<T>,
): Promise<T> {
  const g = globalThis as EnvGlobal;
  const prevEnv = g.__env;
  const prevFetch = globalThis.fetch;
  g.__env = {
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "srk",
    R2_BUCKET: r2,
  };
  globalThis.fetch = fetchMock;
  try {
    return await fn();
  } finally {
    g.__env = prevEnv;
    globalThis.fetch = prevFetch;
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

const LOG_ROW = {
  id: "rcpt-1",
  app_id: "app-1",
  user_id: "enduser-1",
  function_name: "search",
  success: false,
  created_at: "2026-07-06T00:00:00Z",
  error_message: "boom",
  log_object_key: "call-logs/app-1/rcpt-1.json",
  log_bytes: 64,
};

Deno.test("call-log read: owner gets logs and the read is audited FIRST", async () => {
  const r2 = new FakeR2();
  r2.store.set(
    "call-logs/app-1/rcpt-1.json",
    JSON.stringify({ truncated: false, dropped_entries: 0, logs: [entry("boom", "error")] }),
  );
  const audits: unknown[] = [];
  await withEnv(
    (async (input: Request | URL | string, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/rest/v1/mcp_call_logs?id=eq.rcpt-1")) return jsonResponse([LOG_ROW]);
      if (url.includes("/rest/v1/apps?id=eq.app-1")) {
        return jsonResponse([{ id: "app-1", owner_id: "owner-1" }]);
      }
      if (url.includes("/rest/v1/support_data_access_log")) {
        audits.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    r2,
    async () => {
      const result = await readCallLogsByReceipt({
        callerUserId: "owner-1",
        receiptId: "rcpt-1",
      });
      assertEquals(result.logs.length, 1);
      assertEquals(result.logs[0].message, "boom");
      assertEquals(result.error_message, "boom");
      assertEquals(audits.length, 1);
      const audit = audits[0] as Record<string, unknown>;
      assertEquals(audit.action, "log_read");
      assertEquals(audit.accessor_user_id, "owner-1");
    },
  );
});

Deno.test("call-log read: non-owner is refused", async () => {
  const r2 = new FakeR2();
  await withEnv(
    (async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/rest/v1/mcp_call_logs?id=eq.rcpt-1")) return jsonResponse([LOG_ROW]);
      if (url.includes("/rest/v1/apps?id=eq.app-1")) {
        return jsonResponse([{ id: "app-1", owner_id: "owner-1" }]);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    r2,
    async () => {
      await assertRejects(
        () => readCallLogsByReceipt({ callerUserId: "someone-else", receiptId: "rcpt-1" }),
        CallLogForbidden,
      );
    },
  );
});

Deno.test("call-log read: audit failure blocks the data (fail-closed)", async () => {
  const r2 = new FakeR2();
  r2.store.set(
    "call-logs/app-1/rcpt-1.json",
    JSON.stringify({ logs: [entry("secret")] }),
  );
  await withEnv(
    (async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/rest/v1/mcp_call_logs?id=eq.rcpt-1")) return jsonResponse([LOG_ROW]);
      if (url.includes("/rest/v1/apps?id=eq.app-1")) {
        return jsonResponse([{ id: "app-1", owner_id: "owner-1" }]);
      }
      if (url.includes("/rest/v1/support_data_access_log")) {
        return new Response("db down", { status: 500 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    r2,
    async () => {
      await assertRejects(
        () => readCallLogsByReceipt({ callerUserId: "owner-1", receiptId: "rcpt-1" }),
        Error,
        "audit write failed",
      );
    },
  );
});

Deno.test("call-log read: swept/absent logs -> not found", async () => {
  const r2 = new FakeR2();
  await withEnv(
    (async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/rest/v1/mcp_call_logs?id=eq.rcpt-1")) {
        return jsonResponse([{ ...LOG_ROW, log_object_key: null }]);
      }
      if (url.includes("/rest/v1/apps?id=eq.app-1")) {
        return jsonResponse([{ id: "app-1", owner_id: "owner-1" }]);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    r2,
    async () => {
      await assertRejects(
        () => readCallLogsByReceipt({ callerUserId: "owner-1", receiptId: "rcpt-1" }),
        CallLogNotFound,
      );
    },
  );
});

Deno.test("call-log persist: pointer PATCHes on only after blob + debit succeed", async () => {
  const r2 = new FakeR2();
  const patches: Array<Record<string, unknown>> = [];
  const adjustments: number[] = [];
  const prepared = prepareCallLogCapture({
    appId: "app-1", receiptId: "rcpt-1", logs: [entry("hi")],
  })!;
  await withEnv(
    (async (input: Request | URL | string, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/rpc/adjust_data_storage")) {
        adjustments.push(JSON.parse(String(init?.body)).p_delta_bytes);
        return jsonResponse([{ new_bytes: 1, combined_bytes: 1, storage_limit: 2, over_limit: false }]);
      }
      if (init?.method === "PATCH" && url.includes("mcp_call_logs?id=eq.rcpt-1")) {
        patches.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    r2,
    async () => {
      await persistPreparedCallLogs(prepared, "owner-1");
      assertEquals(r2.store.has(prepared.objectKey), true, "blob written");
      assertEquals(adjustments, [prepared.bytes], "owner debited once");
      assertEquals(patches.length, 1);
      assertEquals(patches[0].log_object_key, prepared.objectKey);
      assertEquals(patches[0].log_bytes, prepared.bytes, "bytes recorded = bytes debited");
    },
  );
});

Deno.test("call-log persist: debit failure -> pointer lands with log_bytes NULL (sweep credits nothing)", async () => {
  const r2 = new FakeR2();
  const patches: Array<Record<string, unknown>> = [];
  const prepared = prepareCallLogCapture({
    appId: "app-1", receiptId: "rcpt-2", logs: [entry("hi")],
  })!;
  await withEnv(
    (async (input: Request | URL | string, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/rpc/adjust_data_storage")) {
        return new Response("rpc down", { status: 500 });
      }
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    r2,
    async () => {
      await persistPreparedCallLogs(prepared, "owner-1");
      assertEquals(patches.length, 1, "pointer still lands (logs readable)");
      assertEquals(patches[0].log_bytes, null, "no debit -> no bytes -> sweep credits nothing");
    },
  );
});

Deno.test("call-log persist: pointer PATCH failure compensates the debit and deletes the blob", async () => {
  const r2 = new FakeR2();
  const adjustments: number[] = [];
  const prepared = prepareCallLogCapture({
    appId: "app-1", receiptId: "rcpt-3", logs: [entry("hi")],
  })!;
  await withEnv(
    (async (input: Request | URL | string, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/rpc/adjust_data_storage")) {
        adjustments.push(JSON.parse(String(init?.body)).p_delta_bytes);
        return jsonResponse([{ new_bytes: 1, combined_bytes: 1, storage_limit: 2, over_limit: false }]);
      }
      if (init?.method === "PATCH") return new Response("db down", { status: 500 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    r2,
    async () => {
      await persistPreparedCallLogs(prepared, "owner-1");
      assertEquals(adjustments, [prepared.bytes, -prepared.bytes], "debit compensated");
      assertEquals(r2.store.has(prepared.objectKey), false, "blob removed");
    },
  );
});

Deno.test("call-log prepare: malformed log entries never throw (hot-path safety)", () => {
  const prepared = prepareCallLogCapture({
    appId: "app-1",
    receiptId: "rcpt-x",
    // deno-lint-ignore no-explicit-any
    logs: [null, 42, { level: "log" }] as any,
  });
  // Whatever it decides to keep, the call must not throw.
  assert(prepared === null || typeof prepared.body === "string");
});

Deno.test("call-log sweep: deletes blobs, clears pointers, credits the owner's bytes back", async () => {
  const r2 = new FakeR2();
  r2.store.set("call-logs/app-1/old-1.json", "{}");
  r2.store.set("call-logs/app-1/old-2.json", "{}");
  const patched: string[] = [];
  const adjustments: Array<{ user: string; delta: number }> = [];
  await withEnv(
    (async (input: Request | URL | string, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("log_object_key=not.is.null")) {
        return jsonResponse([
          { id: "old-1", app_id: "app-1", log_object_key: "call-logs/app-1/old-1.json", log_bytes: 100 },
          { id: "old-2", app_id: "app-1", log_object_key: "call-logs/app-1/old-2.json", log_bytes: 50 },
        ]);
      }
      if (init?.method === "PATCH" && url.includes("id=in.(old-1,old-2)")) {
        patched.push(url);
        return new Response(null, { status: 204 });
      }
      if (url.includes("/rest/v1/apps?id=in.(app-1)")) {
        return jsonResponse([{ id: "app-1", owner_id: "owner-1" }]);
      }
      if (url.includes("/rpc/adjust_data_storage")) {
        const body = JSON.parse(String(init?.body));
        adjustments.push({ user: body.p_user_id, delta: body.p_delta_bytes });
        return jsonResponse([{ new_bytes: 0, combined_bytes: 0, storage_limit: 1, over_limit: false }]);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    r2,
    async () => {
      const result = await sweepExpiredCallLogs();
      assertEquals(result.deleted, 2);
      assertEquals(result.reclaimedBytes, 150);
      assertEquals(result.errors, 0);
      assertEquals(r2.deletes.length, 2);
      assertEquals(patched.length, 1);
      assertEquals(adjustments, [{ user: "owner-1", delta: -150 }]);
    },
  );
});
