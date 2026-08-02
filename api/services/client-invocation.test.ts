import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertThrows } from "https://deno.land/std@0.210.0/assert/assert_throws.ts";

import {
  CLIENT_INVOCATION_ID_MAX_LENGTH,
  CLIENT_INVOCATION_ID_MIN_LENGTH,
  extractClientInvocationId,
  InvalidClientInvocationIdError,
} from "./client-invocation.ts";

Deno.test("absent _invocation_id returns null and leaves args untouched", () => {
  const args: Record<string, unknown> = { prompt: "hello", _async: true };
  assertEquals(extractClientInvocationId(args), null);
  assertEquals(args, { prompt: "hello", _async: true });
});

Deno.test("valid _invocation_id is returned and stripped from args", () => {
  const args: Record<string, unknown> = {
    prompt: "hello",
    _invocation_id: "7f1e6f0a-2b3c-4d5e-8f90-123456789abc",
  };
  assertEquals(
    extractClientInvocationId(args),
    "7f1e6f0a-2b3c-4d5e-8f90-123456789abc",
  );
  // The reserved key must never reach function input.
  assert(!("_invocation_id" in args));
  assertEquals(args, { prompt: "hello" });
});

Deno.test("boundary lengths are accepted", () => {
  const min = "a".repeat(CLIENT_INVOCATION_ID_MIN_LENGTH);
  const max = "b".repeat(CLIENT_INVOCATION_ID_MAX_LENGTH);
  assertEquals(extractClientInvocationId({ _invocation_id: min }), min);
  assertEquals(extractClientInvocationId({ _invocation_id: max }), max);
});

Deno.test("present-but-invalid _invocation_id throws (never silently ignored)", () => {
  // Silently dropping a malformed id would reopen the double-execution
  // window the id exists to close — the caller must learn immediately.
  assertThrows(
    () => extractClientInvocationId({ _invocation_id: 42 }),
    InvalidClientInvocationIdError,
    "must be a string",
  );
  assertThrows(
    () => extractClientInvocationId({ _invocation_id: "short" }),
    InvalidClientInvocationIdError,
    "length",
  );
  assertThrows(
    () =>
      extractClientInvocationId({
        _invocation_id: "x".repeat(CLIENT_INVOCATION_ID_MAX_LENGTH + 1),
      }),
    InvalidClientInvocationIdError,
    "length",
  );
});

Deno.test("invalid values are still stripped so no branch can leak them", () => {
  const args: Record<string, unknown> = { _invocation_id: 42, keep: true };
  assertThrows(() => extractClientInvocationId(args));
  assert(!("_invocation_id" in args));
  assertEquals(args, { keep: true });
});
