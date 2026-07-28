import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260728120000_pro_weekly_only_capacity.sql",
    import.meta.url,
  ),
);

Deno.test("Pro weekly-only migration keeps unpaid accounts as an internal no-access sentinel", () => {
  assertStringIncludes(
    migration,
    "SELECT u.id, 'free', COALESCE(u.created_at, now())",
  );
  assertStringIncludes(
    migration,
    "purchasable = (code = 'pro')",
  );
  assertStringIncludes(
    migration,
    "WHEN code = 'pro' THEN 2000",
  );
  assertStringIncludes(
    migration,
    "WHEN subscriptions.status = 'active' THEN 'pro'",
  );
  assertStringIncludes(
    migration,
    "IF p_plan_code IS DISTINCT FROM 'pro' THEN",
  );
});

Deno.test("Pro weekly-only migration makes the compatibility burst non-binding", () => {
  assertStringIncludes(
    migration,
    "SET burst_limit_light = weekly_limit_light",
  );
  assertStringIncludes(
    migration,
    "CASE WHEN p_status = 'active' THEN 'pro' ELSE 'free' END",
  );
});

Deno.test("Pro weekly-only migration pauses managed routines when paid access ends", () => {
  assertStringIncludes(
    migration,
    "'code', 'pro_subscription_required'",
  );
  assertEquals(
    migration.includes("v_free_agent_id"),
    false,
  );
});
