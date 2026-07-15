import {
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  isAccountSessionAuthSource,
  matchesServiceCredential,
} from "./control-plane-auth.ts";

Deno.test("control-plane auth: legacy REST mutations require a Supabase account session", () => {
  assertEquals(isAccountSessionAuthSource("supabase"), true);
  assertEquals(isAccountSessionAuthSource("api_token"), false);
  assertEquals(isAccountSessionAuthSource("routine_actor"), false);
  assertEquals(isAccountSessionAuthSource("sandbox_actor"), false);
  assertEquals(isAccountSessionAuthSource(undefined), false);
});

Deno.test("control-plane auth: global artifact upload accepts only the exact service credential", () => {
  assertEquals(matchesServiceCredential("service-key", "service-key"), true);
  assertEquals(matchesServiceCredential("service-key-x", "service-key"), false);
  assertEquals(matchesServiceCredential("service-kex", "service-key"), false);
  assertEquals(matchesServiceCredential("", "service-key"), false);
  assertEquals(matchesServiceCredential("service-key", ""), false);
});
