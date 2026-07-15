import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

const budgetMigration = await Deno.readTextFile(new URL(
  "../../supabase/migrations/20260714160000_routine_hard_budget_admission.sql",
  import.meta.url,
));

const metadataMigration = await Deno.readTextFile(new URL(
  "../../supabase/migrations/20260714161000_routine_metadata_integrity.sql",
  import.meta.url,
));

const agentHomeMigration = await Deno.readTextFile(new URL(
  "../../supabase/migrations/20260714162000_agent_home_revision.sql",
  import.meta.url,
));

const plpgsqlConflictPolicyMigration = await Deno.readTextFile(new URL(
  "../../supabase/migrations/20260714163000_launch_p2_plpgsql_conflict_policy.sql",
  import.meta.url,
));

Deno.test("routine budget migration: expired in-flight work is charged conservatively", () => {
  assertStringIncludes(
    budgetMigration,
    "actual_light = reservations.reserved_light",
  );
  assertStringIncludes(
    budgetMigration,
    "SET total_light = runs.total_light + expired_by_run.finalized_light",
  );
  assertStringIncludes(
    budgetMigration,
    "WHERE reservations.routine_id = p_routine_id",
  );
  assertEquals(
    budgetMigration.includes(
      "SET status = 'released', updated_at = now()\n  WHERE routine_run_id",
    ),
    false,
  );
  assertEquals(
    budgetMigration.includes(
      "status = 'reserved' AND expires_at > now()",
    ),
    false,
  );
});

Deno.test("routine metadata migration: unique index excludes historical launch rows", () => {
  assertStringIncludes(
    metadataMigration,
    "metadata->>'launch_primary' = 'true'",
  );
  assertEquals(
    metadataMigration.includes(
      "metadata->>'source' = 'ul.routine'",
    ),
    false,
  );
  assertStringIncludes(metadataMigration, "'launch_primary'");
  assertStringIncludes(
    metadataMigration,
    "FROM PUBLIC, anon, authenticated",
  );
});

Deno.test("Agent Home migration revokes PUBLIC from authoritative budget RPCs", () => {
  const compactMigration = agentHomeMigration.replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
  for (
    const signature of [
      "reserve_routine_run_budget(uuid, uuid, uuid, text, text, double precision, timestamp with time zone)",
      "settle_routine_run_budget_reservation(uuid, uuid, double precision, boolean)",
      "release_routine_run_budget_reservation(uuid, uuid)",
      "record_routine_call_contribution(uuid, uuid, uuid, uuid, text, text, text, uuid, text, integer, double precision, jsonb, jsonb, jsonb, jsonb)",
    ]
  ) {
    assertStringIncludes(
      compactMigration,
      `REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`,
      signature,
    );
  }
});

Deno.test("P2 migration pins table-column resolution for TABLE-returning launch RPCs", () => {
  assertStringIncludes(
    plpgsqlConflictPolicyMigration,
    "public.reserve_routine_run_budget(uuid,uuid,uuid,text,text,double precision,timestamp with time zone)",
  );
  assertStringIncludes(
    plpgsqlConflictPolicyMigration,
    "public.claim_agent_home_action(uuid,uuid,bigint,text,text,jsonb)",
  );
  assertStringIncludes(
    plpgsqlConflictPolicyMigration,
    "#variable_conflict use_column",
  );
  assertStringIncludes(
    plpgsqlConflictPolicyMigration,
    "IF v_fixed = v_definition THEN",
  );
});
