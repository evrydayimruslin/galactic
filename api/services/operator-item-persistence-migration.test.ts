// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260724110000_operator_item_persistence.sql",
    import.meta.url,
  ),
);

Deno.test("operator item persistence separates condition, fanout, and presentation state", () => {
  assertStringIncludes(migration, "CREATE TABLE public.operator_items");
  assertStringIncludes(
    migration,
    "CREATE TABLE public.operator_item_affected_agents",
  );
  assertStringIncludes(
    migration,
    "CREATE TABLE public.operator_item_attention_states",
  );
  assertStringIncludes(
    migration,
    "CREATE TABLE public.operator_item_source_cursors",
  );
  assertStringIncludes(
    migration,
    "lifecycle_state IN ('active', 'recovered')",
  );
  assertStringIncludes(
    migration,
    "state IN ('open', 'snoozed', 'dismissed')",
  );
  assertStringIncludes(
    migration,
    "Dismissal does not recover the underlying operator item.",
  );
});

Deno.test("operator item episodes are unique only while active and preserve recovery history", () => {
  assertStringIncludes(
    migration,
    "CREATE UNIQUE INDEX operator_items_one_active_condition",
  );
  assertStringIncludes(
    migration,
    "WHERE lifecycle_state = 'active'",
  );
  assertStringIncludes(
    migration,
    "lifecycle_state = 'recovered'",
  );
  assertStringIncludes(
    migration,
    "recovery_reason = 'condition_not_observed'",
  );
  assertEquals(
    migration.includes(
      "UNIQUE (user_id, condition_key)",
    ),
    false,
  );
});

Deno.test("operator reconciliation is atomic, owner-scoped, and stale-snapshot fenced", () => {
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.reconcile_operator_items",
  );
  assertStringIncludes(migration, "SECURITY DEFINER");
  assertStringIncludes(migration, "pg_advisory_xact_lock");
  assertStringIncludes(migration, "FOR NO KEY UPDATE");
  assertStringIncludes(
    migration,
    "apps.owner_id = p_user_id",
  );
  assertStringIncludes(
    migration,
    "routines.user_id = p_user_id",
  );
  assertStringIncludes(
    migration,
    "runs.user_id = p_user_id",
  );
  assertStringIncludes(
    migration,
    "stale_operator_item_observation",
  );
  assertStringIncludes(
    migration,
    "conflicting_operator_item_observation",
  );
  assertStringIncludes(
    migration,
    "last_snapshot_hash ~ '^[0-9a-f]{64}$'",
  );
  assertStringIncludes(
    migration,
    "conflicting_operator_item_definition",
  );
  assertStringIncludes(
    migration,
    "operator_item_remediation_scope_mismatch",
  );
});

Deno.test("operator item storage enforces the closed semantic remediation registry", () => {
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.is_valid_operator_remediations",
  );
  assertStringIncludes(
    migration,
    "p_condition_key || ':remediation:' || v_key",
  );
  assertStringIncludes(
    migration,
    "v_target ?| ARRAY['url', 'href', 'actionUrl']",
  );
  assertStringIncludes(
    migration,
    "('approve_grant', 'inline', 'account_session',",
  );
  assertStringIncludes(
    migration,
    "('run_once', 'execute', 'agent_operate',",
  );
  assertStringIncludes(
    migration,
    "'routine_execution', 'routine')",
  );
});

Deno.test("operator item tables and mutations are service-role only", () => {
  for (
    const table of [
      "operator_items",
      "operator_item_affected_agents",
      "operator_item_attention_states",
      "operator_item_source_cursors",
    ]
  ) {
    assertStringIncludes(
      migration,
      `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`,
    );
    assertStringIncludes(
      migration,
      `REVOKE ALL ON TABLE public.${table}`,
    );
    assertStringIncludes(
      migration,
      `GRANT ALL ON TABLE public.${table} TO service_role`,
    );
  }
  assertStringIncludes(
    migration,
    "REVOKE ALL ON FUNCTION public.reconcile_operator_items(",
  );
  assertStringIncludes(
    migration,
    "REVOKE ALL ON FUNCTION public.apply_operator_item_attention_action(",
  );
  assertStringIncludes(migration, "FROM PUBLIC, anon, authenticated");
  assertStringIncludes(migration, "TO service_role");
});

Deno.test("Attention actions never write operator condition recovery", () => {
  const start = migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.apply_operator_item_attention_action",
  );
  const end = migration.indexOf(
    "REVOKE ALL ON FUNCTION public.reconcile_operator_items",
  );
  const attentionFunction = migration.slice(start, end);
  assertEquals(start >= 0 && end > start, true);
  assertStringIncludes(attentionFunction, "state = 'dismissed'");
  assertStringIncludes(attentionFunction, "dismissed_at = now()");
  assertEquals(
    attentionFunction.includes("UPDATE public.operator_items"),
    false,
  );
  assertEquals(attentionFunction.includes("recovered_at"), false);
});
