// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const reconciliation = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260723110000_expired_snooze_search_reconciliation.sql",
    import.meta.url,
  ),
);
const searchProducers = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260723104000_agent_search_projection_producers.sql",
    import.meta.url,
  ),
);

Deno.test("expired snooze reconciliation is bounded, concurrent-safe, and idempotent", () => {
  assertStringIncludes(
    reconciliation,
    "CREATE OR REPLACE FUNCTION public.reopen_expired_attention_snoozes",
  );
  assertStringIncludes(
    reconciliation,
    "p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500",
  );
  assertStringIncludes(reconciliation, "LIMIT p_limit");
  assertStringIncludes(reconciliation, "FOR UPDATE SKIP LOCKED");
  assertStringIncludes(
    reconciliation,
    "notifications.snoozed_until <= now()",
  );
  assertStringIncludes(reconciliation, "lifecycle_state = 'open'");
  assertStringIncludes(reconciliation, "snoozed_until = NULL");
  assertStringIncludes(reconciliation, "RETURN v_reopened");
});

Deno.test("expired snooze reconciliation delegates identifier-only Search enqueue to the owner guard", () => {
  assertStringIncludes(
    searchProducers,
    "CREATE OR REPLACE FUNCTION public.enqueue_attention_search_reconciliation",
  );
  assertStringIncludes(searchProducers, "apps.owner_id = NEW.user_id");
  assertStringIncludes(searchProducers, "'search_document'");
  assertStringIncludes(searchProducers, "'notification'");
  assertEquals(reconciliation.includes("notifications.title"), false);
  assertEquals(reconciliation.includes("notifications.body"), false);
  assertEquals(reconciliation.includes("notifications.entity_id"), false);
  assertEquals(reconciliation.includes("notifications.action_url"), false);
});

Deno.test("expired snooze maintenance is service-role only", () => {
  assertStringIncludes(
    reconciliation,
    "FROM PUBLIC, anon, authenticated, service_role",
  );
  assertStringIncludes(
    reconciliation,
    "TO service_role",
  );
});
