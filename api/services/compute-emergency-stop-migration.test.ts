import {
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  "../supabase/migrations/20260720120000_compute_emergency_stop.sql",
);
const statusMigration = await Deno.readTextFile(
  "../supabase/migrations/20260804130000_compute_emergency_stop_status.sql",
);

Deno.test("Compute emergency-stop SQL keeps admission and body destruction fail closed", () => {
  assertStringIncludes(
    migration,
    "WHERE status IN ('active', 'completed')",
  );
  assertStringIncludes(migration, "pg_advisory_xact_lock_shared");
  assertStringIncludes(
    migration,
    "deliberately touches no run row in this transaction",
  );
  assertStringIncludes(
    migration,
    "BEFORE UPDATE OF state ON public.compute_runs",
  );
  assertStringIncludes(
    migration,
    "(OLD.state IN ('admitted', 'queued') AND NEW.state = 'provisioning')",
  );
  assertStringIncludes(
    migration,
    "(OLD.state = 'provisioning' AND NEW.state = 'running')",
  );
  assertStringIncludes(
    migration,
    "p_body_destroyed IS DISTINCT FROM true",
  );
  assertStringIncludes(
    migration,
    "p_operation_id IS NULL OR p_run_id IS NULL",
  );
  assertStringIncludes(migration, "p_request_hash IS NULL");
  assertStringIncludes(migration, "p_limit IS NULL");
  assertStringIncludes(
    migration,
    "v_operation.request_hash IS DISTINCT FROM p_request_hash",
  );
  assertStringIncludes(
    migration,
    "v_operation.release_request_hash IS DISTINCT FROM p_request_hash",
  );
  assertFalse(migration.includes("AND NOT p_body_destroyed"));
});

Deno.test("Compute emergency-stop SQL is service-role-only and audit events are append-only", () => {
  assertStringIncludes(
    migration,
    "compute_emergency_stop_events is append-only",
  );
  assertStringIncludes(
    migration,
    "FROM PUBLIC, anon, authenticated, service_role",
  );
  assertStringIncludes(
    migration,
    "GRANT EXECUTE ON FUNCTION public.fence_compute_emergency_stop_batch",
  );
  assertStringIncludes(
    migration,
    "GRANT EXECUTE ON FUNCTION public.release_compute_emergency_stop",
  );
});

Deno.test("Compute emergency-stop target paths use one operation-to-target lock order", () => {
  const failure = migration.slice(
    migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.record_compute_emergency_stop_target_failure",
    ),
    migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.release_compute_emergency_stop",
    ),
  );
  const operationLock = failure.indexOf(
    "FROM public.compute_emergency_stop_operations AS operation",
  );
  const targetMutation = failure.indexOf(
    "UPDATE public.compute_emergency_stop_targets AS target",
  );
  assertFalse(operationLock < 0);
  assertFalse(targetMutation < 0);
  assertFalse(operationLock > targetMutation);
});

Deno.test("Compute emergency-stop status projection is sanitized and service-role-only", () => {
  assertStringIncludes(
    statusMigration,
    "CREATE OR REPLACE FUNCTION public.get_compute_emergency_stop_status()",
  );
  assertStringIncludes(statusMigration, "RETURNS jsonb");
  assertStringIncludes(statusMigration, "STABLE");
  assertStringIncludes(statusMigration, "SECURITY DEFINER");
  assertStringIncludes(statusMigration, "'schema_version', 1");
  assertStringIncludes(statusMigration, "'latch_state'");
  for (
    const projectedField of [
      "operation_id",
      "cutoff_at",
      "target_count",
      "terminalized_count",
      "pending_target_count",
      "created_at",
      "updated_at",
      "completed_at",
    ]
  ) {
    assertStringIncludes(statusMigration, `'${projectedField}'`);
  }
  assertStringIncludes(
    statusMigration,
    "WHERE operation.status IN ('active', 'completed')",
  );
  assertStringIncludes(
    statusMigration,
    "operation.target_count - operation.terminalized_count",
  );
  assertStringIncludes(
    statusMigration,
    "FROM PUBLIC, anon, authenticated, service_role",
  );
  assertStringIncludes(
    statusMigration,
    "TO service_role",
  );
  assertStringIncludes(statusMigration, "NOTIFY pgrst, 'reload schema'");
  for (
    const privateField of [
      "operator_reference",
      "reason",
      "request_hash",
      "release_request_hash",
      "release_operator_reference",
      "release_reason",
      "run_id",
      "last_error_code",
    ]
  ) {
    assertFalse(statusMigration.includes(`'${privateField}'`));
  }
});
