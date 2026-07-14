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
});
