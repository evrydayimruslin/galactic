import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260720124500_compute_capacity_conservation.sql",
    import.meta.url,
  ),
);

function functionBody(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`missing SQL function: ${name}`);
  const next = migration.indexOf(
    "\nCREATE OR REPLACE FUNCTION public.",
    start + 1,
  );
  return migration.slice(start, next < 0 ? migration.length : next);
}

Deno.test("Compute admission persists immutable trusted billing attribution", () => {
  const admission = functionBody("admit_compute_run");
  assertStringIncludes(admission, "p_billing_mode text");
  assertStringIncludes(admission, "p_capacity_agent_id uuid");
  assertStringIncludes(admission, "app.owner_id = p_user_id");
  assertStringIncludes(admission, "app.deleted_at IS NULL");
  assertStringIncludes(admission, "FOR SHARE");
  assertStringIncludes(admission, "COMPUTE_IDEMPOTENCY_CONFLICT");
  assertStringIncludes(
    admission,
    "v_run.billing_mode IS DISTINCT FROM p_billing_mode",
  );
  assertStringIncludes(
    admission,
    "v_run.capacity_agent_id IS DISTINCT FROM p_capacity_agent_id",
  );
  assertStringIncludes(migration, "admit_compute_run_capacity_impl");
  assertStringIncludes(
    migration,
    "FROM PUBLIC, anon, authenticated, service_role",
  );
});

Deno.test("Compute budgets have exactly one wallet or capacity backing", () => {
  assertStringIncludes(migration, "compute_budget_backing_check");
  assertStringIncludes(migration, "billing_mode = 'wallet'");
  assertStringIncludes(migration, "hold_id IS NOT NULL");
  assertStringIncludes(migration, "capacity_reservation_id IS NULL");
  assertStringIncludes(migration, "billing_mode = 'subscription_capacity'");
  assertStringIncludes(migration, "hold_id IS NULL");
  assertStringIncludes(migration, "capacity_reservation_id IS NOT NULL");

  const budgetTrigger = functionBody("fill_compute_budget_billing_context");
  assertStringIncludes(budgetTrigger, "NEW.billing_mode := v_run.billing_mode");
  assertStringIncludes(budgetTrigger, "NEW.hold_id := NULL");
  assertStringIncludes(
    budgetTrigger,
    "Wallet Compute budget requires a cloud usage hold",
  );
});

Deno.test("subscription lease reserves the complete bounded amount and independent concurrency", () => {
  const prepare = functionBody("prepare_compute_run_lease");
  assertStringIncludes(prepare, "v_timeout_ms + 195000 + 15000");
  assertStringIncludes(
    prepare,
    "v_reserved_wall_ms * 0.000002056",
  );
  assertStringIncludes(prepare, "public.reserve_account_capacity_v3(");
  assertStringIncludes(prepare, "v_run.capacity_agent_id");
  assertStringIncludes(prepare, "'nested_concurrency', 'independent_compute_lease'");
  assertStringIncludes(prepare, "COMPUTE_INSUFFICIENT_BUDGET");
  assertStringIncludes(prepare, "COMPUTE_CONCURRENCY_LIMIT");
  const defaultReserve = (30_000 + 195_000 + 15_000) * 0.000002056;
  assertEquals(defaultReserve, 0.49344);

  const reserve = prepare.indexOf("public.reserve_account_capacity_v3(");
  const budget = prepare.indexOf(
    "INSERT INTO public.compute_run_budget_reservations",
  );
  const lease = prepare.lastIndexOf(
    "public.prepare_compute_run_lease_capacity_impl(",
  );
  assert(reserve >= 0 && budget > reserve && lease > budget);
});

Deno.test("terminal economics keep wallet holds isolated and true-up full subscription actual", () => {
  const transition = functionBody("transition_compute_run");
  assertStringIncludes(transition, "v_budget.billing_mode IS DISTINCT FROM v_run.billing_mode");
  assertStringIncludes(transition, "IF v_run.billing_mode = 'wallet' THEN");
  assertStringIncludes(transition, "public.release_cloud_usage_hold(");
  assertStringIncludes(transition, "public.settle_cloud_usage_hold(");
  assertStringIncludes(transition, "status = 'settlement_pending'");
  assertStringIncludes(
    transition,
    "v_actual_light :=\n          (v_billed_wall_ms * v_budget.rate_light_per_ms)::numeric(28,12)",
  );
  assertStringIncludes(
    transition,
    "v_released_light := GREATEST(",
  );
  assertStringIncludes(migration, "DROP CONSTRAINT compute_budget_amount_check");
  assertStringIncludes(migration, "DROP CONSTRAINT compute_receipt_amount_check");
  assertStringIncludes(
    migration,
    "released_light = GREATEST(reserved_light - actual_light, 0)",
  );

  const subscriptionBranch = transition.slice(
    transition.indexOf("ELSE\n        v_billed_wall_ms := p_worker_wall_ms;"),
    transition.indexOf("END IF;\n      IF v_run.billing_mode = 'wallet' THEN"),
  );
  assertFalse(subscriptionBranch.includes("LEAST("));
});

Deno.test("capacity settlement is exact, replayable after expiry, and never settles release", () => {
  const settle = functionBody("settle_compute_capacity_reservation");
  assertStringIncludes(settle, "FOR UPDATE");
  assertStringIncludes(
    settle,
    "hashtextextended('account_capacity:' || p_user_id::text, 0)",
  );
  assertStringIncludes(settle, "v_res.status NOT IN ('reserved', 'expired')");
  assertStringIncludes(
    settle,
    "WHEN v_res.status = 'reserved' THEN v_res.reserved_light",
  );
  assertStringIncludes(settle, "used_light + v_actual::double precision");
  assertStringIncludes(settle, "v_res.actual_light::numeric(28,12) IS DISTINCT FROM v_actual");
  assertStringIncludes(settle, "v_receipt.actual_light IS DISTINCT FROM v_actual");
  assertFalse(settle.includes("v_actual > v_budget.reserved_light"));
  assertStringIncludes(settle, "capacity_settlement_status = 'settled'");
});

Deno.test("pre-body receipts need no capacity settlement and pending receipts remain durable", () => {
  const receiptTrigger = functionBody("fill_compute_receipt_billing_context");
  assertStringIncludes(
    receiptTrigger,
    "WHEN v_run.capacity_reservation_id IS NULL THEN 'not_applicable'",
  );
  assertStringIncludes(receiptTrigger, "ELSE 'pending'");

  const pending = functionBody("list_pending_compute_capacity_settlements");
  assertStringIncludes(pending, "p_limit NOT BETWEEN 1 AND 500");
  assertStringIncludes(pending, "capacity_settlement_status = 'pending'");
  assertStringIncludes(pending, "ORDER BY receipt.created_at, receipt.id");
  assertStringIncludes(
    migration,
    "REVOKE ALL ON FUNCTION public.list_pending_compute_capacity_settlements(integer)",
  );
  assertStringIncludes(
    migration,
    "GRANT EXECUTE ON FUNCTION public.list_pending_compute_capacity_settlements(integer)\n  TO service_role",
  );
});
