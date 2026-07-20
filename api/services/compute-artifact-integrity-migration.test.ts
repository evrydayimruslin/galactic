import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const integrity = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260720122000_compute_artifact_reconciliation_integrity.sql",
    import.meta.url,
  ),
);
const schema = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260719120000_compute_control_plane_schema.sql",
    import.meta.url,
  ),
);
const gateway = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260719123000_compute_gateway_artifact_rpcs.sql",
    import.meta.url,
  ),
);

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`missing SQL function: ${name}`);
  const next = sql.indexOf("\nCREATE OR REPLACE FUNCTION public.", start + 1);
  return sql.slice(start, next < 0 ? sql.length : next);
}

Deno.test("artifact ready CAS cannot change reserved integrity or identity", () => {
  assertStringIncludes(
    integrity,
    "compute_artifacts_output_reservation_shape_check",
  );
  assertStringIncludes(integrity, "COMPUTE_ARTIFACT_MIGRATION_BLOCKED");
  assertStringIncludes(
    integrity,
    "AND run.stop_requested_at IS NULL",
  );
  assertStringIncludes(integrity, ") NOT VALID;");
  assertStringIncludes(
    integrity,
    "VALIDATE CONSTRAINT compute_artifacts_output_reservation_shape_check",
  );
  const trigger = functionBody(
    integrity,
    "enforce_compute_artifact_immutability",
  );
  for (
    const immutable of [
      "NEW.run_id IS DISTINCT FROM OLD.run_id",
      "NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key",
      "NEW.logical_name IS DISTINCT FROM OLD.logical_name",
      "NEW.media_type IS DISTINCT FROM OLD.media_type",
      "NEW.storage_key IS DISTINCT FROM OLD.storage_key",
      "NEW.sha256 IS DISTINCT FROM OLD.sha256",
      "NEW.size_bytes IS DISTINCT FROM OLD.size_bytes",
    ]
  ) assertStringIncludes(trigger, immutable);
  const transition = functionBody(integrity, "transition_compute_artifact");
  assertStringIncludes(
    transition,
    "v_artifact.sha256 IS DISTINCT FROM p_sha256",
  );
  assertStringIncludes(
    transition,
    "v_artifact.size_bytes IS DISTINCT FROM p_size_bytes",
  );
  const update = transition.slice(
    transition.indexOf("UPDATE public.compute_artifacts"),
  );
  assertFalse(update.includes("sha256 ="));
  assertFalse(update.includes("size_bytes ="));
});

Deno.test("one per-run artifact cap aggregates inputs and outputs", () => {
  const register = functionBody(gateway, "register_compute_artifact");
  const liveCap = register.slice(
    register.indexOf("SELECT count(*)"),
    register.indexOf("-- Deleted attempts remain durable abuse accounting"),
  );
  assertStringIncludes(
    liveCap,
    "WHERE run_id = p_run_id AND state <> 'deleted'",
  );
  assertFalse(liveCap.includes("direction = 'output'"));
  assertStringIncludes(register, "p_sha256 IS NULL");
  assertStringIncludes(register, "p_size_bytes IS NULL");

  for (const sql of [gateway, integrity]) {
    const transition = functionBody(sql, "transition_compute_artifact");
    const readyCap = transition.slice(
      transition.indexOf("IF p_to_state = 'ready' THEN", 1),
      transition.indexOf("UPDATE public.compute_artifacts AS artifact"),
    );
    assertStringIncludes(
      readyCap,
      "WHERE run_id = p_run_id AND state <> 'deleted'",
    );
    assertFalse(readyCap.includes("direction = v_artifact.direction"));
    assertStringIncludes(
      readyCap,
      "Aggregate input/output artifacts exceed the owner-confirmed limits.",
    );
  }
});

Deno.test("DLQ fence ownership is persisted and never inferred from reason prefix", () => {
  assertStringIncludes(integrity, "ADD COLUMN stop_fence_owner text");
  const fence = functionBody(integrity, "fence_compute_dlq_run");
  const terminalize = functionBody(integrity, "terminalize_compute_dlq_run");
  for (const body of [fence, terminalize]) {
    assertStringIncludes(
      body,
      "stop_fence_owner IS DISTINCT FROM 'dispatch_dlq'",
    );
    assertFalse(body.includes("stop_reason NOT LIKE"));
    assertFalse(body.includes("stop_reason LIKE"));
  }
  assertStringIncludes(fence, "stop_fence_owner = 'dispatch_dlq'");
});

Deno.test("stale reconciliation owns only its own fence", () => {
  assertStringIncludes(
    integrity,
    "stop_reason = 'compute_lease_expired'",
  );
  assertStringIncludes(
    integrity,
    "SET stop_fence_owner = 'stale_reconciler'",
  );
  const list = functionBody(integrity, "list_stale_compute_runs");
  assertStringIncludes(list, "run.stop_requested_at IS NULL");
  assertStringIncludes(list, "run.stop_fence_owner = 'stale_reconciler'");

  const fence = functionBody(integrity, "fence_stale_compute_run");
  assertStringIncludes(
    fence,
    "v_run.stop_fence_owner IS DISTINCT FROM 'stale_reconciler'",
  );
  assertStringIncludes(fence, "'skip_reason', 'foreign_stop_fence'");
  assertStringIncludes(fence, "stop_fence_owner = 'stale_reconciler'");

  const terminalize = functionBody(integrity, "terminalize_stale_compute_run");
  assertStringIncludes(
    terminalize,
    "v_run.stop_fence_owner IS DISTINCT FROM 'stale_reconciler'",
  );
});

Deno.test("artifact reconciliation is old, bounded, stopped-run-only, and CAS tombstoned", () => {
  const list = functionBody(integrity, "list_stale_pending_compute_artifacts");
  assertStringIncludes(list, "p_limit NOT BETWEEN 1 AND 500");
  assertStringIncludes(list, "p_cutoff > p_now - interval '5 minutes'");
  assertStringIncludes(list, "artifact.updated_at <= p_cutoff");
  assertStringIncludes(list, "run.stop_requested_at IS NOT NULL");

  const tombstone = functionBody(
    integrity,
    "tombstone_stale_pending_compute_artifact",
  );
  assertStringIncludes(
    tombstone,
    "v_artifact.state_version IS DISTINCT FROM p_expected_state_version",
  );
  assertStringIncludes(tombstone, "v_artifact.updated_at > p_cutoff");
  assertStringIncludes(tombstone, "SET state = 'deleted'");
  assertStringIncludes(
    tombstone,
    "artifact.state_version = p_expected_state_version",
  );
});

Deno.test("R2 classification protects ready and input-referenced objects", () => {
  const classify = functionBody(integrity, "classify_compute_artifact_object");
  assertStringIncludes(classify, "v_artifact.state = 'ready'");
  assertStringIncludes(
    classify,
    "input_alias.source_artifact_id = v_artifact.id",
  );
  assertStringIncludes(classify, "input_alias.state = 'ready'");
  assertStringIncludes(classify, "'reason', 'ready_input_reference'");
  assertStringIncludes(classify, "'reason', 'unreferenced_active_run'");
  assertStringIncludes(classify, "'reason', 'unreferenced_stopped_run'");
});

Deno.test("operational scans have partial indexes and a durable cursor CAS", () => {
  for (
    const index of [
      "compute_runs_unclaimed_expiry_idx",
      "compute_runs_claim_expiry_idx",
      "compute_runs_claim_absolute_expiry_idx",
      "compute_runs_stopped_active_idx",
      "compute_job_tokens_active_expiry_idx",
      "compute_budget_reserved_expiry_idx",
      "compute_artifacts_pending_output_age_idx",
    ]
  ) assertStringIncludes(integrity, index);
  assertStringIncludes(
    integrity,
    "CREATE TABLE public.compute_artifact_reconciliation_cursors",
  );
  assertStringIncludes(
    functionBody(integrity, "advance_compute_artifact_reconciliation_cursor"),
    "v_cursor.state_version IS DISTINCT FROM p_expected_state_version",
  );
});

Deno.test("policy fence trigger is installed only after receipt table exists", () => {
  const receipts = schema.indexOf("CREATE TABLE public.compute_run_receipts");
  const trigger = schema.indexOf(
    "CREATE TRIGGER compute_policy_change_fences_runs",
  );
  assert(receipts >= 0);
  assert(trigger >= 0);
  assertEquals(receipts < trigger, true);
  assertEquals(
    schema.indexOf(
      "CREATE TRIGGER compute_policy_change_fences_runs",
      trigger + 1,
    ),
    -1,
  );
});
