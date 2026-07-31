import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  HTTP_TEST_EXECUTION_LIMITS,
  TestRuntimeStateStore,
} from "./test-state-store.ts";
import {
  MAX_UL_TEST_OBSERVED_EFFECTS,
  UL_TEST_BLOCKED_EFFECTS,
  UL_TEST_OBSERVED_EFFECTS,
  type UlTestObservedEffect,
} from "./ul-test-runtime.ts";

Deno.test("gx.test sessions preserve local DATA semantics and stay isolated", () => {
  const first = new TestRuntimeStateStore();
  const second = new TestRuntimeStateStore();

  first.storeAppData("folder/item one", {
    rank: 2,
    nested: { value: "a" },
  });
  first.storeAppData("folder/item-two", {
    rank: 1,
    nested: { value: "b" },
  });

  assertEquals(first.listAppData("folder/"), [
    "folder/item-two",
    "folder/item_one",
  ]);
  assertEquals(second.loadAppData("folder/item one"), null);
  const loaded = first.loadAppData(
    "folder/item one",
  ) as { nested: { value: string } };
  loaded.nested.value = "mutated outside the store";
  assertEquals(first.loadAppData("folder/item one"), {
    rank: 2,
    nested: { value: "a" },
  });

  first.removeAppData("folder/item one");
  assertEquals(first.loadAppData("folder/item one"), null);
});

Deno.test("gx.test sessions keep Agent and user memory local and separate", () => {
  const first = new TestRuntimeStateStore();
  const second = new TestRuntimeStateStore();

  first.rememberMemory("agent", "inbox", { cursor: 4 });
  first.rememberMemory("user", "inbox", { cursor: 9 });

  assertEquals(first.recallMemory("agent", "inbox"), { cursor: 4 });
  assertEquals(first.recallMemory("user", "inbox"), { cursor: 9 });
  assertEquals(second.recallMemory("user", "inbox"), null);
});

Deno.test("gx.test sessions latch deduplicated blocked-effect kinds", () => {
  const state = new TestRuntimeStateStore();
  state.recordBlockedEffect("smtp");
  state.recordBlockedEffect("outbound_http");
  state.recordBlockedEffect("smtp");
  assertEquals(state.blockedEffects(), ["outbound_http", "smtp"]);
  assertEquals(state.observedEffects(), [
    "email.smtp.send",
    "network.http",
  ]);
});

Deno.test("gx.test sessions expose the complete bounded stable effect catalog", () => {
  const expected = [
    "agent.call",
    "compute.execute",
    "credential.http",
    "database.read",
    "database.write",
    "email.imap.read",
    "email.smtp.send",
    "event.publish",
    "inference.embed",
    "inference.generate",
    "memory.read",
    "memory.write",
    "network.http",
    "network.tcp",
    "notification.owner.write",
    "routine.read",
    "storage.delete",
    "storage.read",
    "storage.write",
  ];
  assertEquals(Object.values(UL_TEST_OBSERVED_EFFECTS).sort(), expected);
  assertEquals(MAX_UL_TEST_OBSERVED_EFFECTS, 19);

  const state = new TestRuntimeStateStore();
  for (const effect of Object.values(UL_TEST_OBSERVED_EFFECTS)) {
    state.recordObservedEffect(effect);
    state.recordObservedEffect(effect);
  }
  assertEquals(state.observedEffects(), expected);

  assertThrows(
    () =>
      state.recordObservedEffect(
        "storage.read:tenant-controlled-detail" as UlTestObservedEffect,
      ),
    Error,
    "unknown effect kind",
  );
});

Deno.test("gx.test blocked effects map to sanitized public effect IDs", () => {
  const state = new TestRuntimeStateStore();
  for (const effect of Object.values(UL_TEST_BLOCKED_EFFECTS)) {
    state.recordBlockedEffect(effect);
  }
  assertEquals(state.observedEffects(), [
    "agent.call",
    "credential.http",
    "email.imap.read",
    "email.smtp.send",
    "event.publish",
    "network.http",
    "network.tcp",
  ]);
});

Deno.test("gx.test sessions close fail-closed and bound values", () => {
  const closed = new TestRuntimeStateStore();
  closed.close();
  assertThrows(
    () => closed.loadAppData("key"),
    Error,
    "session is closed",
  );

  const bounded = new TestRuntimeStateStore();
  assertThrows(
    () =>
      bounded.storeAppData(
        "too-large",
        "x".repeat(1024 * 1024 + 1),
      ),
    Error,
    "exceeds 1 MiB",
  );
  assertThrows(
    () =>
      bounded.storeAppData(
        "x".repeat(4 * 1024 + 1),
        "small",
      ),
    Error,
    "key exceeds 4 KiB",
  );

  const binary = new ArrayBuffer(2 * 1024 * 1024);
  bounded.storeAppData("binary", binary);
  assertEquals(bounded.loadAppData("binary"), {});
});

Deno.test("gx.test sessions account for replacement, remove, and close", () => {
  const state = new TestRuntimeStateStore();
  assertEquals(state.sizeBytes(), 0);

  state.storeAppData("large", "x".repeat(256 * 1024));
  const firstSize = state.sizeBytes();
  assertEquals(firstSize > 0, true);

  state.storeAppData("large", "small");
  assertEquals(state.sizeBytes() < firstSize, true);

  state.removeAppData("large");
  assertEquals(state.sizeBytes(), 0);

  state.storeAppData("again", { ready: true });
  assertEquals(state.sizeBytes() > 0, true);
  state.close();
  assertEquals(state.isClosed(), true);
});

Deno.test("gx.test sessions enforce aggregate and namespace bounds", () => {
  const bytes = new TestRuntimeStateStore();
  for (let index = 0; index < 4; index += 1) {
    bytes.storeAppData(`large-${index}`, "x".repeat(1024 * 1024 - 32));
  }
  assertThrows(
    () => bytes.storeAppData("overflow", "x".repeat(256)),
    Error,
    "exceeds 4 MiB",
  );

  const keys = new TestRuntimeStateStore();
  for (let index = 0; index < 1_024; index += 1) {
    keys.storeAppData(`key-${index}`, index);
  }
  assertThrows(
    () => keys.storeAppData("one-too-many", true),
    Error,
    "key limit reached",
  );
});

Deno.test("gx.test sessions bound HTTP fixture attempts and aggregate exchange bytes", () => {
  const attempts = new TestRuntimeStateStore();
  for (
    let index = 0;
    index < HTTP_TEST_EXECUTION_LIMITS.max_attempts;
    index += 1
  ) {
    attempts.beginHttpFixtureAttempt();
  }
  assertThrows(
    () => attempts.beginHttpFixtureAttempt(),
    Error,
    "HTTP fixture attempt limit reached",
  );

  const bytes = new TestRuntimeStateStore();
  bytes.reserveHttpFixtureExchangeBytes(
    HTTP_TEST_EXECUTION_LIMITS.max_exchange_bytes - 1,
    1,
  );
  assertThrows(
    () => bytes.reserveHttpFixtureExchangeBytes(0, 1),
    Error,
    "exchange bytes exceed 8 MiB",
  );
  // A rejected reservation is atomic and does not partially advance the
  // counter. Zero-byte exchanges remain admissible at the exact ceiling.
  bytes.reserveHttpFixtureExchangeBytes(0, 0);
  assertThrows(
    () => new TestRuntimeStateStore().reserveHttpFixtureExchangeBytes(-1, 0),
    Error,
    "byte count is invalid",
  );
});
