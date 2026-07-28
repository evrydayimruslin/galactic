import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";
import { CloudUsageRpcError } from "./cloud-usage.ts";
import { createR2Service, type FileUpload } from "./storage.ts";

class FakeR2Object {
  constructor(private readonly value: Uint8Array) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.value.buffer.slice(
      this.value.byteOffset,
      this.value.byteOffset + this.value.byteLength,
    ) as ArrayBuffer;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.value);
  }
}

class FakeR2Bucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly events: string[] = [];

  async put(
    key: string,
    value: Uint8Array,
    _options?: unknown,
  ): Promise<void> {
    this.events.push(`put:${key}`);
    this.objects.set(key, value);
  }

  async get(key: string): Promise<FakeR2Object | null> {
    this.events.push(`get:${key}`);
    const value = this.objects.get(key);
    return value ? new FakeR2Object(value) : null;
  }

  async delete(key: string): Promise<void> {
    this.events.push(`delete:${key}`);
    this.objects.delete(key);
  }

  async list(
    options: { prefix?: string; cursor?: string; limit?: number } = {},
  ): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }> {
    this.events.push(`list:${options.prefix ?? ""}`);
    const prefix = options.prefix ?? "";
    const allKeys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    const start = options.cursor
      ? Math.max(0, allKeys.findIndex((key) => key > options.cursor!))
      : 0;
    const keys = allKeys.slice(start, start + (options.limit ?? 1000));
    const truncated = start + keys.length < allKeys.length;
    return {
      objects: keys.map((key) => ({ key })),
      truncated,
      ...(truncated && keys.length > 0 ? { cursor: keys.at(-1)! } : {}),
    };
  }
}

const TEST_METERING = {
  payerUserId: "00000000-0000-0000-0000-000000000101",
  sponsorUserId: null,
  callerUserId: "00000000-0000-0000-0000-000000000102",
  ownerUserId: "00000000-0000-0000-0000-000000000103",
  appId: "00000000-0000-0000-0000-000000000201",
  functionName: "handler",
  receiptId: "receipt-storage-test",
  source: "test",
  metadata: { test_case: "storage" },
};

async function withR2Env(
  bucket: FakeR2Bucket,
  fn: () => Promise<void>,
): Promise<void> {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    ...(previousEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    R2_BUCKET: bucket as unknown as R2Bucket,
  } as typeof globalThis.__env;

  try {
    await fn();
  } finally {
    globalThis.__env = previousEnv;
  }
}

function okDebitFetch(
  calls: Array<{ url: string; body: Record<string, unknown> }>,
  events: string[],
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    calls.push({ url, body });
    events.push(`debit:${body.p_metadata?.operation}`);
    const amount = Number(body.p_amount_light);

    return Promise.resolve(
      new Response(
        JSON.stringify([{
          event_id: crypto.randomUUID(),
          old_balance: 10,
          new_balance: 10 - amount,
          amount_debited: amount,
          deposit_debited: amount,
          earned_debited: 0,
        }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;
}

Deno.test("R2 service meters upload before touching the bucket", async () => {
  const bucket = new FakeR2Bucket();
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const events: string[] = [];

  await withR2Env(bucket, async () => {
    const r2 = createR2Service({
      metering: TEST_METERING,
      billingConfig: {
        version: 44,
        cloudUnitLightPer1k: 2,
        r2OpsPerCloudUnit: 2,
        kvOpsPerCloudUnit: 1,
      },
      fetchFn: okDebitFetch(calls, events),
    });
    const file: FileUpload = {
      name: "index.js",
      content: new TextEncoder().encode("export default {}"),
      contentType: "application/javascript",
    };

    await r2.uploadFile("apps/app-1/1/index.js", file);

    assertEquals(events, ["debit:put"]);
    assertEquals(bucket.events, ["put:apps/app-1/1/index.js"]);
    assertEquals(
      calls[0].url,
      "https://supabase.example/rest/v1/rpc/debit_cloud_usage",
    );
    assertEquals(calls[0].body.p_resource, "r2_operation");
    assertEquals(calls[0].body.p_units, 1);
    assertEquals(calls[0].body.p_cloud_units, 1);
    assertEquals(calls[0].body.p_amount_light, 0.002);
    assertEquals(calls[0].body.p_billing_config_version, 44);
    assertEquals(calls[0].body.p_metadata, {
      test_case: "storage",
      key: "apps/app-1/1/index.js",
      operation: "put",
      operations_per_cloud_unit: 2,
    });
  });
});

Deno.test("R2 service blocks the bucket operation when metering debit fails", async () => {
  const bucket = new FakeR2Bucket();

  await withR2Env(bucket, async () => {
    const r2 = createR2Service({
      metering: TEST_METERING,
      fetchFn: (() =>
        Promise.resolve(
          new Response("Insufficient available balance", { status: 400 }),
        )) as typeof fetch,
    });

    await assertRejects(
      () =>
        r2.uploadFile("apps/app-1/1/index.js", {
          name: "index.js",
          content: new TextEncoder().encode("export default {}"),
          contentType: "application/javascript",
        }),
      CloudUsageRpcError,
    );
    assertEquals(bucket.events, []);
    assertEquals(bucket.objects.size, 0);
  });
});

Deno.test("R2 service meters reads, deletes, and listings", async () => {
  const bucket = new FakeR2Bucket();
  bucket.objects.set("apps/app-1/data/a.json", new TextEncoder().encode("a"));
  bucket.objects.set("apps/app-1/data/b.json", new TextEncoder().encode("b"));
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const events: string[] = [];

  await withR2Env(bucket, async () => {
    const r2 = createR2Service({
      metering: TEST_METERING,
      fetchFn: okDebitFetch(calls, events),
    });

    assertEquals(await r2.fetchTextFile("apps/app-1/data/a.json"), "a");
    assertEquals(await r2.listFiles("apps/app-1/data/"), [
      "apps/app-1/data/a.json",
      "apps/app-1/data/b.json",
    ]);
    await r2.deleteFile("apps/app-1/data/a.json");

    assertEquals(events, ["debit:get", "debit:list", "debit:delete"]);
    assertEquals(bucket.events, [
      "get:apps/app-1/data/a.json",
      "list:apps/app-1/data/",
      "delete:apps/app-1/data/a.json",
    ]);
    assertEquals(
      calls.map((call) =>
        (call.body.p_metadata as Record<string, unknown>).operation
      ),
      ["get", "list", "delete"],
    );
  });
});

Deno.test("R2 service exposes bounded file-list pages", async () => {
  const bucket = new FakeR2Bucket();
  bucket.objects.set("capsules/a.json", new Uint8Array());
  bucket.objects.set("capsules/b.json", new Uint8Array());
  bucket.objects.set("capsules/c.json", new Uint8Array());

  await withR2Env(bucket, async () => {
    const r2 = createR2Service();
    const first = await r2.listFilesPage("capsules/", { limit: 2 });
    assertEquals(first.keys, ["capsules/a.json", "capsules/b.json"]);
    assertEquals(typeof first.nextCursor, "string");
    const second = await r2.listFilesPage("capsules/", {
      limit: 2,
      cursor: first.nextCursor!,
    });
    assertEquals(second, {
      keys: ["capsules/c.json"],
      nextCursor: null,
    });
  });
});
