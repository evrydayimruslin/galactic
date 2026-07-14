import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";

import { callerCanUseHttpExecutionRoute } from "./http.ts";

Deno.test("http actor policy: signed actor contexts are rejected", () => {
  assertEquals(
    callerCanUseHttpExecutionRoute({
      authState: "authenticated",
      authSource: "routine_actor",
    }),
    false,
  );
  assertEquals(
    callerCanUseHttpExecutionRoute({
      authState: "authenticated",
      authSource: "sandbox_actor",
    }),
    false,
  );
  assertEquals(
    callerCanUseHttpExecutionRoute({
      authState: "authenticated",
      authSource: "supabase",
    }),
    true,
  );
});
