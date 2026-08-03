import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  persistEffectEvents,
  readRunEffectEvents,
} from "./effect-event-store.ts";

async function withMockedDb<T>(
  handler: (url: URL, init?: RequestInit) => Response,
  fn: () => Promise<T>,
): Promise<{ result: T; bodies: unknown[] }> {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.__env = {
    ...(previousEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  } as typeof globalThis.__env;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    return handler(
      new URL(typeof input === "string" ? input : input.toString()),
      init,
    );
  }) as typeof fetch;
  try {
    return { result: await fn(), bodies };
  } finally {
    globalThis.__env = previousEnv;
    globalThis.fetch = previousFetch;
  }
}

Deno.test("witness store: persists a seq-ordered batch with lineage keys", async () => {
  const { result, bodies } = await withMockedDb(
    () => new Response("[]", { status: 201 }),
    () =>
      persistEffectEvents({
        userId: "user-1",
        appId: "app-1",
        executionId: "exec-1",
        runId: "run-1",
        receiptId: "receipt-1",
        events: [
          {
            kind: "db_mutation",
            channel: "d1:conversations",
            outcome: "insert:1",
            attestation: "attested",
          },
          {
            kind: "function_completed",
            channel: "function:handle_inbox",
            outcome: "ok in 420ms",
            attestation: "attested",
          },
        ],
      }),
  );
  assertEquals(result, 2);
  const rows = bodies[0] as Array<Record<string, unknown>>;
  assertEquals(rows.map((r) => r.seq), [0, 1]);
  assertEquals(rows[0].run_id, "run-1");
  assertEquals(rows[0].receipt_id, "receipt-1");
  assertEquals(rows[1].kind, "function_completed");
});

Deno.test("witness store: a persist failure logs and returns 0 — never throws into settlement", async () => {
  const { result } = await withMockedDb(
    () => new Response("boom", { status: 500 }),
    () =>
      persistEffectEvents({
        userId: "user-1",
        appId: "app-1",
        executionId: "exec-1",
        events: [{ kind: "db_mutation", attestation: "attested" }],
      }),
  );
  assertEquals(result, 0);
});

Deno.test("witness store: run projection maps rows owner-safely, ordered", async () => {
  const { result } = await withMockedDb(
    (url) => {
      assert(url.searchParams.get("run_id") === "eq.run-1");
      assert(url.searchParams.get("user_id") === "eq.user-1");
      return new Response(
        JSON.stringify([{
          execution_id: "exec-1",
          seq: 0,
          kind: "evidence",
          channel: "galactic.evidence",
          target_digest: "https://mail.example/sent/123",
          outcome: "Sent reply",
          attestation: "app_claimed",
          evidence: [{ kind: "external_url" }],
          created_at: "2026-08-03T10:00:00.000Z",
        }]),
        { status: 200 },
      );
    },
    () => readRunEffectEvents("user-1", "app-1", "run-1"),
  );
  assertEquals(result[0].attestation, "app_claimed");
  assertEquals(result[0].targetDigest, "https://mail.example/sent/123");
});
