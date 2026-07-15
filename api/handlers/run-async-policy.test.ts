import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";

import { callerCanUseRunAsyncDispatch } from "./run.ts";

Deno.test("run async policy: signed actor contexts cannot escape into a durable job", () => {
  assertEquals(
    callerCanUseRunAsyncDispatch({
      authSource: "routine_actor",
      authState: "authenticated",
    }),
    false,
  );
  assertEquals(
    callerCanUseRunAsyncDispatch({
      authSource: "sandbox_actor",
      authState: "authenticated",
    }),
    false,
  );
  assertEquals(
    callerCanUseRunAsyncDispatch({
      authSource: "api_token",
      authState: "authenticated",
    }),
    true,
  );
  assertEquals(
    callerCanUseRunAsyncDispatch({
      authSource: "supabase",
      authState: "authenticated",
    }),
    true,
  );
});
