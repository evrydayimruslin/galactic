import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260717120000_multi_routine_agent_activation.sql",
    import.meta.url,
  ),
);

Deno.test("multi-routine migration preserves one optional primary without limiting managed siblings", () => {
  assertStringIncludes(migration, "'launch_managed', true");
  assertStringIncludes(migration, "'launch_role', 'primary'");
  assertStringIncludes(
    migration,
    "CREATE UNIQUE INDEX idx_user_routines_one_launch_primary",
  );
  assertStringIncludes(
    migration,
    "metadata->>'launch_role' = 'primary'",
  );
  assertEquals(
    migration.includes(
      "CREATE UNIQUE INDEX idx_user_routines_one_launch_primary\n  ON public.user_routines (user_id, composer_app_id)\n  WHERE deleted_at IS NULL\n    AND composer_app_id IS NOT NULL\n    AND metadata->>'launch_managed' = 'true';",
    ),
    false,
    "the unique index must not cover ordinary launch-managed sibling routines",
  );
});

Deno.test("multi-routine migration protects every launch lifecycle marker", () => {
  for (
    const key of [
      "'launch_managed'",
      "'launch_role'",
      "'launch_primary'",
    ]
  ) {
    assertStringIncludes(migration, key);
  }
  assertStringIncludes(
    migration,
    "FROM PUBLIC, anon, authenticated",
  );
});

Deno.test("multi-routine Free activation is grouped by Agent and releases only after the last sibling", () => {
  assertStringIncludes(
    migration,
    "GROUP BY routines.user_id, routines.composer_app_id",
  );
  assertStringIncludes(
    migration,
    "GROUP BY routines.composer_app_id",
  );
  assertStringIncludes(
    migration,
    "routines.composer_app_id IS DISTINCT FROM v_free_agent_id",
  );
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.release_agent_activation_slot",
  );
  assertStringIncludes(
    migration,
    "routines.status = 'active'",
  );
  assertStringIncludes(migration, "FOR UPDATE;");
});

Deno.test("multi-routine resume makes slot claim and lifecycle activation one locked transaction", () => {
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.activate_managed_routine_with_slot",
  );
  assertStringIncludes(
    migration,
    "SELECT entitlements.*",
  );
  assertStringIncludes(
    migration,
    "SET free_agent_id = v_app_id",
  );
  assertStringIncludes(
    migration,
    "SET status = 'active'",
  );
  assertStringIncludes(
    migration,
    "'active_agent_limit'::text",
  );
  assertStringIncludes(
    migration,
    "GRANT EXECUTE ON FUNCTION public.activate_managed_routine_with_slot",
  );
});

Deno.test("multi-routine activation locks entitlement then owner-private Agent then routine", () => {
  const start = migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.activate_managed_routine_with_slot(",
  );
  const end = migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.release_agent_activation_slot(",
    start,
  );
  const sql = migration.slice(start, end);
  const entitlementLock = sql.indexOf(
    "FROM public.account_entitlements AS entitlements",
  );
  const agentLock = sql.indexOf("FROM public.apps AS apps", entitlementLock);
  const routineLock = sql.indexOf(
    "SELECT routines.*\n    INTO v_routine",
    agentLock,
  );
  assert(
    entitlementLock >= 0 && agentLock > entitlementLock &&
      routineLock > agentLock,
    "activation must lock entitlement, Agent, then routine to match Agent Home CAS",
  );
  assertStringIncludes(sql, "apps.owner_id = p_user_id");
  assertStringIncludes(sql, "apps.visibility = 'private'");
  assertStringIncludes(sql, "apps.deleted_at IS NULL");
  assertStringIncludes(sql.slice(agentLock, routineLock), "FOR UPDATE;");
});

Deno.test("subscription downgrade locks affected Agents before bulk routine pause", () => {
  const start = migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.project_account_subscription(",
  );
  const sql = migration.slice(start);
  const entitlementLock = sql.indexOf(
    "FROM public.account_entitlements AS entitlements",
  );
  const candidateSnapshot = sql.indexOf(
    "SELECT grouped.composer_app_id",
    entitlementLock,
  );
  const entitlementWrite = sql.indexOf(
    "INSERT INTO public.account_entitlements (",
  );
  const agentLock = sql.indexOf("PERFORM apps.id", entitlementWrite);
  const pause = sql.indexOf(
    "UPDATE public.user_routines AS routines",
    agentLock,
  );
  assert(
    entitlementLock >= 0 && candidateSnapshot > entitlementLock &&
      entitlementWrite > candidateSnapshot,
    "downgrade candidate selection must be serialized by the entitlement lock",
  );
  assert(
    entitlementWrite >= 0 && agentLock > entitlementWrite && pause > agentLock,
    "downgrade must lock Agent rows before pause updates fire revision triggers",
  );
  assertStringIncludes(sql.slice(agentLock, pause), "ORDER BY apps.id");
  assertStringIncludes(sql.slice(agentLock, pause), "FOR UPDATE;");
});
