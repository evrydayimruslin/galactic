import {
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  "../supabase/migrations/20260804190000_compute_certification_snapshot.sql",
);

Deno.test("Compute certification snapshot is bounded, stable, and service-role-only", () => {
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.get_compute_certification_snapshot(\n" +
      "  p_owner_id uuid,\n" +
      "  p_agent_id uuid,\n" +
      "  p_run_ids uuid[],\n" +
      "  p_since timestamptz\n" +
      ") RETURNS jsonb",
  );
  assertStringIncludes(migration, "LANGUAGE plpgsql\nSTABLE\nSECURITY DEFINER");
  assertStringIncludes(migration, "SET search_path = public");
  assertStringIncludes(migration, "cardinality(p_run_ids) < 1");
  assertStringIncludes(migration, "cardinality(p_run_ids) > 20");
  assertStringIncludes(migration, "FROM unnest(p_run_ids) AS requested(id)");
  assertStringIncludes(migration, "HAVING count(*) > 1");
  assertStringIncludes(migration, "p_since > v_now");
  assertStringIncludes(migration, "p_since < v_now - interval '24 hours'");
  assertStringIncludes(migration, "WITH ORDINALITY");
  assertStringIncludes(migration, "WHERE run.user_id = p_owner_id");
  assertStringIncludes(migration, "AND run.agent_id = p_agent_id");
  assertStringIncludes(
    migration,
    "AND run.created_at >= p_since AND run.created_at <= v_now",
  );
  assertStringIncludes(migration, "LIMIT 100");
  assertStringIncludes(
    migration,
    "FROM PUBLIC, anon, authenticated, service_role",
  );
  assertStringIncludes(migration, ") TO service_role;");
  assertStringIncludes(migration, "NOTIFY pgrst, 'reload schema'");
});

Deno.test("Compute certification projects exact canary identity and persistence invariants", () => {
  for (
    const projectedField of [
      "schema_version",
      "generated_at",
      "owner_id",
      "agent_id",
      "since",
      "latch_state",
      "requested_run_count",
      "selected_run_count",
      "runs",
      "health",
      "violations",
      "run_id",
      "receipt_id",
      "caller_function",
      "state",
      "state_version",
      "billing_mode",
      "capacity_agent_id",
      "environment_digest",
      "directive_hash",
      "request_hash",
      "cardinality",
      "backing",
      "budget",
      "receipt",
      "terminal_active_token_count",
      "artifacts",
      "reserved_light",
      "actual_light",
      "released_light",
      "rate_version",
      "rate_light_per_ms",
      "actual_wall_ms",
      "reserved_wall_ms",
      "teardown_allowance_ms",
      "capacity_settlement_status",
      "artifact_id",
      "sha256",
      "size_bytes",
      "object_deleted",
    ]
  ) {
    assertStringIncludes(migration, `'${projectedField}'`);
  }
  assertStringIncludes(migration, "budget.reserved_light::text");
  assertStringIncludes(migration, "receipt.worker_wall_ms::text");
  assertStringIncludes(migration, "artifact.state_version::text");
  assertStringIncludes(migration, "v_budget_accounting_valid");
  assertStringIncludes(migration, "v_receipt_accounting_valid");
  assertStringIncludes(
    migration,
    "budget.actual_light + budget.released_light =",
  );
  assertStringIncludes(
    migration,
    "receipt.actual_light + receipt.released_light =",
  );
  assertStringIncludes(migration, "v_receipt_matches_budget_hold");
  assertStringIncludes(migration, "v_receipt_matches_run_capacity");
  assertStringIncludes(migration, "v_budget_matches_run_capacity");
  assertStringIncludes(
    migration,
    "v_receipt_cloud_usage_event =\n                (v_receipt->>'worker_wall_ms' IS NOT NULL)",
  );
  assertStringIncludes(
    migration,
    "(v_run.started_at IS NOT NULL OR v_run.state = 'succeeded')",
  );
  assertStringIncludes(migration, "AND v_token_rows >= 1");
  assertStringIncludes(migration, "'compute-rate-v1'");
  assertStringIncludes(migration, "(v_budget->>'rate_light_per_ms')::numeric");
  assertStringIncludes(migration, "(v_receipt->>'billed_wall_ms')::bigint");
  assertStringIncludes(
    migration,
    "v_budget->>'status' = 'settlement_pending'\n                  AND v_receipt->>'capacity_settlement_status' = 'pending'",
  );
});

Deno.test("Compute certification proves authoritative wallet and capacity backing", () => {
  assertStringIncludes(migration, "FROM public.cloud_usage_holds AS hold");
  assertStringIncludes(migration, "FROM public.cloud_usage_events AS event");
  assertStringIncludes(
    migration,
    "FROM public.account_capacity_reservations AS reservation",
  );
  assertStringIncludes(migration, "hold.payer_user_id = v_run.user_id");
  assertStringIncludes(migration, "hold.app_id = v_run.agent_id");
  assertStringIncludes(migration, "hold.source = 'galactic_compute'");
  assertStringIncludes(migration, "hold.resource = 'worker_execution'");
  assertStringIncludes(migration, "hold.metadata->>'run_id' = v_run.id::text");
  assertStringIncludes(
    migration,
    "hold.settlement_event_id = receipt.cloud_usage_event_id",
  );
  assertStringIncludes(
    migration,
    "event.amount_light::numeric(28,12) = receipt.actual_light",
  );
  assertStringIncludes(migration, "reservation.user_id = v_run.user_id");
  assertStringIncludes(
    migration,
    "reservation.capacity_agent_id = v_run.capacity_agent_id",
  );
  assertStringIncludes(
    migration,
    "reservation.metadata->>'compute_run_id' = v_run.id::text",
  );
  assertStringIncludes(migration, "reservation.status = 'settled'");
  assertStringIncludes(
    migration,
    "reservation.actual_light::numeric(28,12) =\n                budget.actual_light",
  );
});

Deno.test("Compute certification sanitizes the emergency latch to state only", () => {
  assertStringIncludes(
    migration,
    "WHERE operation.status IN ('active', 'completed')",
  );
  assertStringIncludes(migration, "v_latch_state := COALESCE");
  assertStringIncludes(migration, "'latch_state', v_latch_state");
  assertFalse(migration.includes("'operation_id'"));
  assertFalse(migration.includes("operation.id"));
});

Deno.test("Compute certification health mirrors every reconciliation danger", () => {
  for (
    const healthField of [
      "stale_nonterminal_runs",
      "old_settlement_pending",
      "terminal_reserved_budgets",
      "receipt_mismatches",
      "terminal_active_tokens",
      "dlq_fenced_runs",
      "stale_pending_artifacts",
      "unreconciled_deleted_outputs",
      "terminal_input_aliases",
    ]
  ) {
    assertStringIncludes(migration, `'${healthField}'`);
  }
  assertStringIncludes(migration, "run.claim_expires_at <= v_now");
  assertStringIncludes(
    migration,
    "receipt.capacity_settlement_status = 'pending'",
  );
  assertStringIncludes(migration, "budget.status = 'reserved'");
  assertStringIncludes(migration, "token.status = 'active'");
  assertStringIncludes(
    migration,
    "run.state NOT IN (\n          'succeeded', 'failed', 'cancelled', 'expired', 'revoked'\n        )\n        AND receipt.id IS NOT NULL",
  );
  assertStringIncludes(migration, "run.stop_fence_owner = 'dispatch_dlq'");
  assertStringIncludes(migration, "artifact.updated_at <= v_cutoff");
  assertStringIncludes(migration, "artifact.object_deleted_at IS NULL");
  assertStringIncludes(
    migration,
    "COALESCE(run.finished_at, run.updated_at) <= v_cutoff",
  );
  for (
    const violation of [
      "DLQ_FENCED_RUNS",
      "OLD_SETTLEMENT_PENDING",
      "RECEIPT_MISMATCHES",
      "STALE_NONTERMINAL_RUNS",
      "STALE_PENDING_ARTIFACTS",
      "TERMINAL_ACTIVE_TOKENS",
      "TERMINAL_INPUT_ALIASES",
      "TERMINAL_RESERVED_BUDGETS",
      "UNRECONCILED_DELETED_OUTPUTS",
    ]
  ) {
    assertStringIncludes(migration, `'${violation}'`);
  }
});

Deno.test("Compute certification never serializes execution or infrastructure secrets", () => {
  assertFalse(migration.includes("to_jsonb(v_run)"));
  assertFalse(migration.includes("to_jsonb(run)"));
  for (
    const forbiddenJsonKey of [
      "execution_request",
      "argv",
      "stdout",
      "stderr",
      "terminal_error",
      "storage_key",
      "claim_id",
      "container_id",
      "token_digest",
      "credentials",
      "secret",
    ]
  ) {
    assertFalse(migration.includes(`'${forbiddenJsonKey}'`));
  }
});
