import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";

import { callerCanUseLegacyExecutionRoute } from "./request-caller-context.ts";

Deno.test("legacy execution route policy: run/http reject signed actor contexts", () => {
  assertEquals(
    callerCanUseLegacyExecutionRoute({
      authState: "authenticated",
      authSource: "routine_actor",
    }),
    false,
  );
  assertEquals(
    callerCanUseLegacyExecutionRoute({
      authState: "authenticated",
      authSource: "sandbox_actor",
    }),
    false,
  );
  assertEquals(
    callerCanUseLegacyExecutionRoute({
      authState: "authenticated",
      authSource: "api_token",
    }),
    true,
  );
  assertEquals(
    callerCanUseLegacyExecutionRoute({
      authState: "anonymous",
      authSource: undefined,
    }),
    true,
  );
});
