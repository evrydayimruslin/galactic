import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertThrows } from "https://deno.land/std@0.210.0/assert/assert_throws.ts";
import {
  _executionContextRegistrySize,
  assertExecutionContext,
  deregisterExecutionContext,
  registerExecutionContext,
  resolveExecutionContext,
} from "./execution-context-registry.ts";

function entry(receiptId: string, execId: string) {
  return {
    aiExecutionId: execId,
    appId: "app-1",
    functionName: "fn-1",
    cloudOperationMetering: {
      payerUserId: "payer-1",
      source: "run",
      receiptId,
      metadata: { runtime_cloud_hold_id: `hold-${receiptId}` },
      // deno-lint-ignore no-explicit-any
    } as any,
    cloudOperationBillingConfig: null,
    callerContextToken: null,
  };
}

Deno.test("registry: register → resolve round-trips the context", () => {
  const h = registerExecutionContext(entry("r1", "exec-1"));
  const ctx = resolveExecutionContext(h);
  assert(ctx);
  assertEquals(ctx!.aiExecutionId, "exec-1");
  // Attribution fields resolve per-call (never via frozen isolate props).
  assertEquals(ctx!.appId, "app-1");
  assertEquals(ctx!.functionName, "fn-1");
  assertEquals(
    (ctx!.cloudOperationMetering as { receiptId: string }).receiptId,
    "r1",
  );
  deregisterExecutionContext(h);
});

Deno.test("registry: handles are unforgeable — distinct + not the executionId", () => {
  const a = registerExecutionContext(entry("r1", "exec-1"));
  const b = registerExecutionContext(entry("r2", "exec-2"));
  assert(a !== b);
  // Handle is not the executionId (so a leaked executionId can't be replayed as a handle).
  assert(!a.includes("exec-1"));
  assert(a.length >= 32, "handle should be high-entropy");
  deregisterExecutionContext(a);
  deregisterExecutionContext(b);
});

Deno.test("registry: unknown / null handle → null (fail-closed, no debit)", () => {
  assertEquals(resolveExecutionContext("does-not-exist"), null);
  assertEquals(resolveExecutionContext(null), null);
  assertEquals(resolveExecutionContext(undefined), null);
  assertEquals(resolveExecutionContext(""), null);
});

Deno.test("registry: deregister removes the entry → later resolve fails closed (replay defense)", () => {
  const h = registerExecutionContext(entry("r1", "exec-1"));
  assert(resolveExecutionContext(h));
  deregisterExecutionContext(h);
  assertEquals(resolveExecutionContext(h), null, "replay after deregister → null");
});

Deno.test("registry: concurrent executions resolve independently (no cross-talk)", () => {
  const hA = registerExecutionContext(entry("rA", "exec-A"));
  const hB = registerExecutionContext(entry("rB", "exec-B"));
  // Interleaved resolves — each handle yields only its own context.
  assertEquals(
    (resolveExecutionContext(hA)!.cloudOperationMetering as { receiptId: string })
      .receiptId,
    "rA",
  );
  assertEquals(
    (resolveExecutionContext(hB)!.cloudOperationMetering as { receiptId: string })
      .receiptId,
    "rB",
  );
  // Deregistering A does not affect B.
  deregisterExecutionContext(hA);
  assertEquals(resolveExecutionContext(hA), null);
  assert(resolveExecutionContext(hB));
  deregisterExecutionContext(hB);
});

Deno.test("registry: deregister is idempotent + no leak after paired register/deregister", () => {
  const before = _executionContextRegistrySize();
  const h = registerExecutionContext(entry("r1", "exec-1"));
  assertEquals(_executionContextRegistrySize(), before + 1);
  deregisterExecutionContext(h);
  deregisterExecutionContext(h); // idempotent
  assertEquals(_executionContextRegistrySize(), before);
});

Deno.test("assertExecutionContext: not required → no-op regardless of handle", () => {
  assertExecutionContext(undefined, false);
  assertExecutionContext(undefined, undefined);
  assertExecutionContext("garbage", false);
});

Deno.test("assertExecutionContext: required + live handle → passes", () => {
  const h = registerExecutionContext(entry("r1", "exec-1"));
  assertExecutionContext(h, true);
  deregisterExecutionContext(h);
});

Deno.test("registry: host RPC resolution emits only its owning capacity marker", () => {
  const receiptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const messages: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => messages.push(parts.map(String).join(" "));
  const h = registerExecutionContext({
    ...entry(receiptId, "exec-capacity"),
    capacityReceiptId: receiptId,
  });
  try {
    assert(resolveExecutionContext(h));
    assertEquals(messages, [
      `GALACTIC_CAPACITY_EXECUTION_V1 {"receipt_id":"${receiptId}"}`,
    ]);
  } finally {
    deregisterExecutionContext(h);
    console.log = originalLog;
  }
});

Deno.test("assertExecutionContext: required + missing/forged/expired handle → throws (operation refused)", () => {
  // Missing entirely (direct-binding bypass that omits the handle).
  assertThrows(() => assertExecutionContext(undefined, true));
  assertThrows(() => assertExecutionContext(null, true));
  // Forged (never registered).
  assertThrows(() => assertExecutionContext("forged-handle", true));
  // Expired / replayed after the execution deregistered.
  const h = registerExecutionContext(entry("r1", "exec-1"));
  deregisterExecutionContext(h);
  assertThrows(() => assertExecutionContext(h, true));
});
