import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(new URL(
  "../../supabase/migrations/20260715120000_subscription_capacity_foundation.sql",
  import.meta.url,
));
const capacityAmbiguityRepair = await Deno.readTextFile(new URL(
  "../../supabase/migrations/20260715121000_fix_capacity_plan_code_ambiguity.sql",
  import.meta.url,
));

Deno.test("P2.1 migration defines the plan and entitlement source of truth", () => {
  assertStringIncludes(migration, "CREATE TABLE IF NOT EXISTS public.billing_plans");
  assertStringIncludes(migration, "('free', 'Free', 0, 1, 1, 20, false, false)");
  assertStringIncludes(migration, "('pro', 'Pro', 2000, NULL, 5, 100, true, false)");
  assertStringIncludes(migration, "CREATE TABLE IF NOT EXISTS public.account_entitlements");
  assertStringIncludes(migration, "free_agent_id uuid REFERENCES public.apps(id)");
  assertStringIncludes(migration, "routines.metadata->>'launch_primary' = 'true'");
  assertStringIncludes(
    migration,
    "Paused when subscription capacity enabled the one active Agent Free plan.",
  );
});

Deno.test("P2.1 capacity reservations are idempotent, locked, and server-only", () => {
  assertStringIncludes(migration, "UNIQUE (user_id, idempotency_key)");
  assertStringIncludes(migration, "ON CONFLICT (user_id, idempotency_key) DO NOTHING");
  assertStringIncludes(migration, "CREATE OR REPLACE FUNCTION public.reserve_account_capacity");
  assertStringIncludes(migration, "WHERE plans.code = v_ent.plan_code");
  assertStringIncludes(migration, "CREATE OR REPLACE FUNCTION public.reap_expired_account_capacity");
  assertStringIncludes(migration, "FOR UPDATE;");
  assertStringIncludes(migration, "CREATE OR REPLACE FUNCTION public.settle_account_capacity");
  assertStringIncludes(migration, "REVOKE ALL ON FUNCTION public.reserve_account_capacity");
  assertStringIncludes(migration, "GRANT EXECUTE ON FUNCTION public.reserve_account_capacity");
});

Deno.test("P2.1 repairs the capacity plan lookup in already-migrated environments", () => {
  assertStringIncludes(capacityAmbiguityRepair, "pg_get_functiondef(v_signature)");
  assertStringIncludes(
    capacityAmbiguityRepair,
    "FROM public.billing_plans AS plans WHERE plans.code = v_ent.plan_code",
  );
});

Deno.test("P2.1 Stripe projection rejects stale events and enforces Free activation", () => {
  assertStringIncludes(migration, "CREATE OR REPLACE FUNCTION public.project_account_subscription");
  assertStringIncludes(migration, "p_event_created_at < v_existing_created_at");
  assertStringIncludes(migration, "Paused when the account returned to its one active Agent Free plan.");
  assertStringIncludes(migration, "CREATE OR REPLACE FUNCTION public.claim_agent_activation_slot");
  assertStringIncludes(migration, "RETURN QUERY SELECT false, 'active_agent_limit'");
});

Deno.test("P2.1 deferred wakes coalesce and attach atomically to the next run", () => {
  assertStringIncludes(migration, "CREATE TABLE IF NOT EXISTS public.deferred_routine_wakes");
  assertStringIncludes(migration, "deferred_wake_count = public.deferred_routine_wakes.deferred_wake_count + 1");
  assertStringIncludes(migration, "CREATE OR REPLACE FUNCTION public.attach_deferred_wake_to_run");
  assertStringIncludes(migration, "DELETE FROM public.deferred_routine_wakes");
  assert(
    migration.includes("'deferred_wake_count', v_wake.deferred_wake_count"),
    "the resumed run must report how many wakes were coalesced",
  );
});
