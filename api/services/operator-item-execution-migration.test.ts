import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260724130000_operator_item_execution.sql",
    import.meta.url,
  ),
);

Deno.test("M7 queue binds the durable action to one active canonical remediation", () => {
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.queue_operator_item_routine_run_once",
  );
  for (
    const invariant of [
      "v_existing.action <> 'operator_run_once'",
      "v_existing.request_payload IS DISTINCT FROM v_expected_payload",
      "AND lifecycle_state = 'active'",
      "v_existing_run.routine_id IS DISTINCT FROM p_routine_id",
      "v_existing_run.trigger IS DISTINCT FROM 'manual'",
      "v_existing_run.run_config IS DISTINCT FROM '{}'::jsonb",
      "v_existing_run.max_attempts <> 1",
      "v_existing_run.metadata IS DISTINCT FROM jsonb_build_object(",
      "v_item.diagnosis->>'code' <> 'ROUTINE_PAUSED_AFTER_FAILURES'",
      "v_item.recovery_mode <> 'successful_verification'",
      "v_item.source_key <> 'routine.health:' || p_routine_id::text",
      "v_remediation->>'key' <> 'run_once'",
      "v_remediation->>'requiredAuthority' <> 'agent_operate'",
      "v_remediation->>'sideEffect' <> 'routine_execution'",
      "AND status = 'paused'",
      "AND metadata->>'launch_primary' = 'true'",
      "AND affected.blocking",
    ]
  ) {
    assertStringIncludes(migration, invariant);
  }
});

Deno.test("M7 Run once is real, non-retrying work and never changes schedule state", () => {
  assertStringIncludes(migration, "'manual'");
  assertStringIncludes(migration, "'operator_item.run_once'");
  assertStringIncludes(migration, "max_attempts,");
  assertStringIncludes(migration, "\n    1,\n    p_request_id");
  assertEquals(
    migration.includes("UPDATE public.user_routines"),
    false,
  );
  assertEquals(
    migration.includes("status = 'active'"),
    false,
  );
});

Deno.test("M7 executor authorization fails closed on stale issue state", () => {
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.authorize_operator_item_routine_run_once",
  );
  assertStringIncludes(migration, "AND lifecycle_state = 'active'");
  assertStringIncludes(migration, "AND runs.trigger = 'manual'");
  assertStringIncludes(migration, "AND runs.run_config = '{}'::jsonb");
  assertStringIncludes(migration, "AND runs.max_attempts = 1");
  assertStringIncludes(
    migration,
    "AND runs.metadata = jsonb_build_object(",
  );
  assertStringIncludes(
    migration,
    "v_request.status IN ('in_progress', 'completed')",
  );
  assert(
    migration.includes(
      "REVOKE ALL ON FUNCTION public.authorize_operator_item_routine_run_once",
    ),
  );
});
