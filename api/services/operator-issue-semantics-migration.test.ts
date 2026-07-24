// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260724100000_operator_issue_semantics.sql",
    import.meta.url,
  ),
);

Deno.test("operator issue semantics classifies usage exhaustion as a report", () => {
  const canonicalKinds =
    "'agent_report',\n      'routine_budget_exhausted',\n      'routine_report',\n      'routine_summary'";
  assertStringIncludes(migration, canonicalKinds);
  assertEquals(migration.match(/'routine_budget_exhausted'/gu)?.length, 4);
  assertStringIncludes(
    migration,
    "NEW.requires_action := NEW.item_class = 'incident'",
  );
  assertStringIncludes(
    migration,
    "v_item_class text := CASE",
  );
});

Deno.test("operator issue semantics converts only active legacy budget incidents", () => {
  assertStringIncludes(
    migration,
    "incident.lifecycle_state IN ('open', 'snoozed')",
  );
  assertStringIncludes(
    migration,
    "WHERE kind = 'routine_budget_exhausted'\n  AND item_class = 'incident'\n  AND lifecycle_state IN ('open', 'snoozed')",
  );
  assertStringIncludes(migration, "item_class = 'report'");
  assertStringIncludes(migration, "requires_action = false");
  assertStringIncludes(migration, "lifecycle_state = 'open'");
  assertStringIncludes(migration, "snoozed_until = NULL");
  assertStringIncludes(migration, "resolved_at = NULL");
  assertStringIncludes(migration, "archived_at = NULL");
});

Deno.test("operator issue semantics retains exact kind-based classification", () => {
  assertEquals(migration.includes("title ILIKE"), false);
  assertEquals(migration.includes("body ILIKE"), false);
  assertEquals(migration.includes("action_url LIKE"), false);
  assertStringIncludes(
    migration,
    "p_user_id::text || E'\\x1f' || btrim(p_dedupe_key)",
  );
  assertStringIncludes(migration, "notification_agent_owner_mismatch");
});
