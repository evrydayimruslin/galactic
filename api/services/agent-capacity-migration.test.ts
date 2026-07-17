import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260717130000_agent_capacity_foundation.sql",
    import.meta.url,
  ),
);

Deno.test("P2.3 Agent capacity migration is additive and feature-gate rollback safe", () => {
  assertStringIncludes(
    migration,
    "CREATE TABLE IF NOT EXISTS public.agent_capacity_policies",
  );
  assertStringIncludes(
    migration,
    "CREATE TABLE IF NOT EXISTS public.agent_capacity_windows",
  );
  assertStringIncludes(
    migration,
    "ADD COLUMN IF NOT EXISTS capacity_agent_id uuid",
  );
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.reserve_account_capacity_v2",
  );
  assertStringIncludes(
    migration,
    "reservations have capacity_agent_id NULL",
  );
});

Deno.test("P2.3 Agent admission locks account then Agent windows and reports blockers", () => {
  const accountBurstLock = migration.indexOf(
    "SELECT windows.* INTO v_account_burst",
  );
  const accountWeekLock = migration.indexOf(
    "SELECT windows.* INTO v_account_week",
  );
  const agentBurstLock = migration.indexOf(
    "SELECT windows.* INTO v_agent_burst",
  );
  const agentWeekLock = migration.indexOf("SELECT windows.* INTO v_agent_week");
  if (
    !(accountBurstLock < accountWeekLock && accountWeekLock < agentBurstLock &&
      agentBurstLock < agentWeekLock)
  ) {
    throw new Error("capacity windows are not locked in deterministic order");
  }
  assertStringIncludes(migration, "'agent_cap_waiting'");
  assertStringIncludes(migration, "'agent_cap_too_low_for_request'");
  assertStringIncludes(migration, "p_reserve_light > v_agent_burst_limit");
  assertStringIncludes(
    migration,
    "v_agent_burst.used_light + v_agent_burst.reserved_light",
  );
  assertStringIncludes(
    migration,
    "hashtextextended('account_capacity:' || p_user_id::text, 0)",
  );
  assertStringIncludes(
    migration,
    "ON CONFLICT ON CONSTRAINT agent_capacity_windows_pkey\n  DO NOTHING",
  );
  assertStringIncludes(
    migration,
    "CREATE INDEX IF NOT EXISTS idx_account_capacity_reservations_user_active",
  );
  if (
    migration.includes(
      "DO UPDATE SET cap_basis_points = EXCLUDED.cap_basis_points",
    )
  ) {
    throw new Error(
      "Agent rows must not be updated before account rows are locked",
    );
  }
});

Deno.test("P2.3 settlement, release, and expiry update both ledgers", () => {
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.reap_expired_account_capacity",
  );
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.settle_account_capacity",
  );
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.release_account_capacity",
  );
  assertStringIncludes(
    migration,
    "UPDATE public.agent_capacity_windows AS windows",
  );
  assertStringIncludes(
    migration,
    "used_light = windows.used_light + p_actual_light",
  );
});

Deno.test("P2.3 capacity policies are owner-scoped and default to 100 percent", () => {
  assertStringIncludes(migration, "COALESCE(policies.cap_basis_points, 10000)");
  assertStringIncludes(migration, "apps.owner_id = p_user_id");
  assertStringIncludes(migration, "cap_basis_points BETWEEN 1 AND 10000");
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.set_agent_capacity_policy",
  );
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.get_agent_capacity_status",
  );
  assertStringIncludes(
    migration,
    "Free Agent capacity is fixed at 100 percent",
  );
  if (migration.includes("v_ent.plan_code = 'free' AND")) {
    throw new Error(
      "Free policy mutation must be rejected even at 100 percent",
    );
  }
});

Deno.test("P2.3 Agent capacity tables are RLS-protected internal state", () => {
  assertStringIncludes(
    migration,
    "ALTER TABLE public.agent_capacity_policies ENABLE ROW LEVEL SECURITY",
  );
  assertStringIncludes(
    migration,
    "ALTER TABLE public.agent_capacity_windows ENABLE ROW LEVEL SECURITY",
  );
  assertStringIncludes(
    migration,
    "REVOKE ALL ON TABLE public.agent_capacity_policies\n  FROM PUBLIC, anon, authenticated",
  );
  assertStringIncludes(
    migration,
    "REVOKE ALL ON TABLE public.agent_capacity_windows\n  FROM PUBLIC, anon, authenticated",
  );
  assertStringIncludes(
    migration,
    "GRANT ALL ON TABLE public.agent_capacity_policies TO service_role",
  );
  assertStringIncludes(
    migration,
    "GRANT ALL ON TABLE public.agent_capacity_windows TO service_role",
  );
});
