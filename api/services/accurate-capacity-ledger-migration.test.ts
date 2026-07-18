import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260717170000_accurate_capacity_resource_ledger.sql",
    import.meta.url,
  ),
);

Deno.test("accurate capacity ledger separates concurrency admission from economic settlement", () => {
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.reserve_account_capacity_v3",
  );
  assertStringIncludes(
    migration,
    "p_account_concurrency_limit integer DEFAULT 4",
  );
  assertStringIncludes(
    migration,
    "p_agent_concurrency_limit integer DEFAULT 2",
  );
  assertStringIncludes(migration, "p_ai_concurrency_limit integer DEFAULT 2");
  assertStringIncludes(
    migration,
    "p_routine_concurrency_limit integer DEFAULT 1",
  );
  assertStringIncludes(migration, "p_routine_run_id uuid DEFAULT NULL");
  assertStringIncludes(migration, "'concurrency_waiting'::text");
  assertStringIncludes(migration, "reservations.status = 'reserved'");
  assertStringIncludes(migration, "reservations.expires_at > p_now");
  assertStringIncludes(
    migration,
    "LEAST(v_retry_at, p_now + interval '15 seconds')",
  );
  assertStringIncludes(
    migration,
    "reservations.metadata->>'routine_run_id' IS DISTINCT FROM",
  );
});

Deno.test("accurate capacity ledger pins facts and never prices timeout or wall duration", () => {
  assertStringIncludes(
    migration,
    "CREATE TABLE IF NOT EXISTS public.capacity_execution_settlements",
  );
  assertStringIncludes(
    migration,
    "CREATE TABLE IF NOT EXISTS public.capacity_resource_events",
  );
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.settle_account_capacity_resources",
  );
  assertStringIncludes(migration, "billing_config_version integer NOT NULL");
  assertStringIncludes(migration, "worker_ms_per_cloud_unit integer NOT NULL");
  assertStringIncludes(
    migration,
    "cloud_unit_light_per_1k double precision NOT NULL",
  );
  const settlementSql = migration.slice(
    migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.settle_account_capacity_resources",
    ),
    migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.record_observed_capacity_cpu",
    ),
  );
  assertEquals(settlementSql.includes("p_timeout"), false);
  assertEquals(settlementSql.includes("p_duration"), false);
  assertEquals(settlementSql.includes("p_wall_time"), false);
  assertStringIncludes(
    settlementSql,
    "v_res.status NOT IN ('reserved', 'expired')",
  );
  assertStringIncludes(settlementSql, "'recovered_after_expiry'");
  assertStringIncludes(settlementSql, "Explicitly released leases");
  assertStringIncludes(migration, "executed_at timestamp with time zone NOT NULL");
  assertStringIncludes(
    settlementSql,
    "(p_executed_at AT TIME ZONE 'UTC')::date",
  );
  assertStringIncludes(
    settlementSql,
    "v_existing.executed_at IS DISTINCT FROM p_executed_at",
  );
});

Deno.test("resource settlement validates and canonically replays every economic input", () => {
  const settlementSql = migration.slice(
    migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.settle_account_capacity_resources",
    ),
    migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.reconcile_capacity_settlement_attribution",
    ),
  );
  assertStringIncludes(
    settlementSql,
    "jsonb_array_length(COALESCE(p_resource_facts, '[]'::jsonb)) > 1024",
  );
  assertStringIncludes(
    settlementSql,
    "octet_length(COALESCE(p_resource_facts, '[]'::jsonb)::text) > 16384",
  );
  assertStringIncludes(
    settlementSql,
    "jsonb_typeof(v_fact->'amountLight') IS DISTINCT FROM 'number'",
  );
  assertStringIncludes(
    settlementSql,
    "v_fact_sum > p_operation_light",
  );
  assertStringIncludes(
    settlementSql,
    "COALESCE(facts.value->'metadata', '{}'::jsonb)::text",
  );
  assertStringIncludes(
    settlementSql,
    "v_existing.resource_facts IS DISTINCT FROM v_canonical_facts",
  );
  assertStringIncludes(
    settlementSql,
    "v_existing.worker_request_light_per_invocation IS DISTINCT FROM",
  );
  assertStringIncludes(
    settlementSql,
    "Capacity settlement pinned economic input mismatch",
  );
  // Repeated queue/R2 tuples are legitimate. Canonical sorting preserves all
  // tuples; it must never reject a duplicate resource class.
  assertEquals(settlementSql.includes("v_event_resource = ANY"), false);
});

Deno.test("expired settlement recovery never releases another active reservation", () => {
  assertStringIncludes(
    migration,
    "WHEN v_res.status = 'reserved' THEN v_res.reserved_light",
  );
  assertStringIncludes(
    migration,
    "windows.reserved_light - v_reserved_release",
  );
});

Deno.test("capacity ledger rejects non-finite floats and fractional request counts", () => {
  assertStringIncludes(
    migration,
    "worker_request_count = floor(worker_request_count)",
  );
  assertStringIncludes(
    migration,
    "worker_request_count < 'Infinity'::double precision",
  );
  assertStringIncludes(
    migration,
    "amount_light < 'Infinity'::double precision",
  );
  assertStringIncludes(
    migration,
    "cpu_time_ms < 'Infinity'::double precision",
  );
});

Deno.test("accurate capacity ledger dedups stable workers and CPU observations", () => {
  assertStringIncludes(
    migration,
    "PRIMARY KEY (user_id, worker_identity_key, usage_day)",
  );
  assertStringIncludes(
    migration,
    "ON CONFLICT (user_id, worker_identity_key, usage_day) DO NOTHING",
  );
  assertStringIncludes(migration, "event_key text NOT NULL UNIQUE");
  assertStringIncludes(
    migration,
    "WHERE events.event_key = 'cpu:' || p_observation_id",
  );
  assertStringIncludes(
    migration,
    "ON public.capacity_resource_events(settlement_id, source)",
  );
  assertStringIncludes(
    migration,
    "duplicate_observations = settlements.duplicate_observations + 1",
  );
});

Deno.test("CPU settlement completes only after every expected Worker source", () => {
  assertStringIncludes(migration, "expected_cpu_sources text[] NOT NULL");
  assertStringIncludes(migration, "observed_cpu_sources text[] NOT NULL");
  assertStringIncludes(migration, "p_dynamic_worker_invoked boolean");
  assertStringIncludes(
    migration,
    "Dynamic Worker request requires a created identity",
  );
  assertStringIncludes(
    migration,
    "p_worker_load_mode = 'none'",
  );
  assertStringIncludes(migration, "p_expected_cpu_sources text[]");
  assertStringIncludes(
    migration,
    "'cloudflare_tail_parent', 'cloudflare_dynamic_tail'",
  );
  assertStringIncludes(
    migration,
    "v_settlement.expected_cpu_sources <@ v_observed_cpu_sources",
  );
  assertStringIncludes(
    migration,
    "WHERE status <> 'final' AND created_at < now() - p_pending_age",
  );
  assertStringIncludes(migration, "'missing_cpu_sources'");
});

Deno.test("Tail observations persist before correlation and reconcile with bounded backoff", () => {
  assertStringIncludes(
    migration,
    "CREATE TABLE IF NOT EXISTS public.capacity_cpu_observation_inbox",
  );
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.ingest_capacity_cpu_observation",
  );
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.reconcile_capacity_cpu_observations",
  );
  assertStringIncludes(migration, "'settlement_not_ready'");
  assertStringIncludes(migration, "FOR UPDATE SKIP LOCKED");
  assertStringIncludes(migration, "interval '1 hour'");
  assertStringIncludes(migration, "status IN ('pending', 'applied')");
  assertStringIncludes(
    migration,
    "ON CONFLICT ON CONSTRAINT capacity_cpu_observation_inbox_pkey DO NOTHING",
  );
  assertStringIncludes(
    migration,
    "CONSTRAINT capacity_cpu_observation_final_check CHECK (final)",
  );
  assertStringIncludes(migration, "final boolean NOT NULL,");
  assertEquals(
    migration.split(
      "IF p_final IS DISTINCT FROM true THEN\n    RAISE EXCEPTION 'CPU observation must be final'",
    ).length - 1,
    2,
  );
  assertEquals(
    migration.split("p_final boolean DEFAULT false").length - 1,
    2,
  );
  assertStringIncludes(
    migration,
    "OR v_inbox.final IS DISTINCT FROM p_final THEN",
  );
});

Deno.test("observed CPU is continuous, wall time is diagnostic, and original windows are updated", () => {
  assertStringIncludes(
    migration,
    "v_cpu_light := (p_cpu_time_ms / v_settlement.worker_ms_per_cloud_unit)",
  );
  assertStringIncludes(migration, "'wall_time_ms', p_wall_time_ms");
  assertStringIncludes(
    migration,
    "SET used_light = windows.used_light + v_cpu_light",
  );
  assertStringIncludes(
    migration,
    "SET actual_light = COALESCE(reservations.actual_light, 0) + v_cpu_light",
  );
});

Deno.test("deferred settlements reconcile receipts and routine accounting by idempotent delta", () => {
  assertStringIncludes(migration, "attributed_light double precision");
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.reconcile_capacity_settlement_attribution",
  );
  assertStringIncludes(
    migration,
    "SET infra_charge_light = v_settlement.total_light",
  );
  assertStringIncludes(
    migration,
    "SET total_light = runs.total_light + v_delta_light",
  );
  assertStringIncludes(
    migration,
    "actual_light = GREATEST(",
  );
  assertStringIncludes(migration, "last_error = 'attribution_not_ready'");
  assertStringIncludes(migration, "'attribution_pending_count'");
  assertStringIncludes(
    migration,
    "settlements.attributed_light < settlements.total_light",
  );
  assertStringIncludes(
    migration,
    "FROM public.reconcile_capacity_settlement_attribution(",
  );
  assertStringIncludes(
    migration,
    "AND EXISTS (\n        SELECT 1\n        FROM public.mcp_call_logs AS logs",
  );
  assertStringIncludes(
    migration,
    "AND budgets.status IN ('settled', 'released')",
  );
  assertStringIncludes(
    migration,
    "SET attributed_light = v_settlement.total_light",
  );
});

Deno.test("capacity attribution validates metadata UUIDs and prefers typed routine relations", () => {
  const attributionSql = migration.slice(
    migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.reconcile_capacity_settlement_attribution",
    ),
    migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.settle_routine_run_budget_reservation",
    ),
  );
  assertStringIncludes(
    attributionSql,
    "IF v_log_run_id IS NOT NULL THEN\n    v_routine_run_id := v_log_run_id;",
  );
  assertStringIncludes(
    attributionSql,
    "ELSIF v_metadata_run_id_text ~*",
  );
  assertStringIncludes(
    attributionSql,
    "AND attribution_context.routine_run_id_valid",
  );
  assertStringIncludes(
    attributionSql,
    "WHERE steps.run_id = attribution_context.routine_run_id",
  );
  assertEquals(
    attributionSql.includes(
      "NULLIF(v_reservation.metadata->>'routine_run_id', '')::uuid",
    ),
    false,
  );
  assertEquals(
    attributionSql.includes(
      "capacity_reservations.metadata->>'routine_run_id', ''\n              )::uuid",
    ),
    false,
  );
});

Deno.test("capacity economics reconciliation is private and business-readable", () => {
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.get_capacity_reconciliation_summary",
  );
  assertStringIncludes(migration, "'pending_old_count'");
  assertStringIncludes(migration, "'duplicate_observations'");
  assertStringIncludes(migration, "'observed_cpu_ms'");
  assertStringIncludes(migration, "'observed_wall_time_ms'");
  assertStringIncludes(migration, "'dynamic_worker_daily_identities'");
  assertStringIncludes(migration, "'inbox_pending_count'");
  assertStringIncludes(migration, "'inbox_oldest_pending_at'");
  assertStringIncludes(migration, "'inbox_error_count'");
  assertStringIncludes(
    migration,
    "FROM PUBLIC, anon, authenticated",
  );
  assertStringIncludes(migration, "TO service_role");
});
