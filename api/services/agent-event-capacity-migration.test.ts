import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migrationUrl = new URL(
  "../../supabase/migrations/20260717160000_agent_event_capacity_deferral.sql",
  import.meta.url,
);
const migration = await Deno.readTextFile(migrationUrl);

Deno.test("reactive-event capacity migration follows the Agent Home CAS migration", () => {
  const name = migrationUrl.pathname.split("/").at(-1) ?? "";
  const prefix = Number(name.slice(0, 14));
  assert(prefix >= 20260717160000);
});

Deno.test("reactive events persist root capacity attribution additively", () => {
  assertStringIncludes(
    migration,
    "ADD COLUMN IF NOT EXISTS capacity_agent_id uuid",
  );
  assertStringIncludes(
    migration,
    "SET capacity_agent_id = apps.id",
  );
  assertStringIncludes(migration, "apps.id = events.emitter_app_id");
  assertStringIncludes(migration, "apps.owner_id = events.user_id");
  assertStringIncludes(migration, "ON DELETE SET NULL NOT VALID");
  assertEquals(
    /ALTER\s+COLUMN\s+capacity_agent_id\s+SET\s+NOT\s+NULL/i.test(migration),
    false,
    "historical event history must not make rollout or rollback unsafe",
  );
});

Deno.test("only durable capacity waits extend event and delivery state", () => {
  assertStringIncludes(
    migration,
    "'pending', 'delivering', 'waiting', 'delivered', 'failed'",
  );
  assertStringIncludes(
    migration,
    "'pending', 'waiting', 'delivered', 'failed', 'denied'",
  );
  assertStringIncludes(
    migration,
    "status <> 'waiting' OR next_eligible_at IS NOT NULL",
  );
  assertStringIncludes(migration, "'capacity_waiting'");
  assertStringIncludes(migration, "'agent_cap_waiting'");
  assertStringIncludes(migration, "'agent_cap_too_low_for_request'");
});

Deno.test("due waits are indexed without weakening per-event idempotency", async () => {
  assertStringIncludes(migration, "agent_events_capacity_wait_idx");
  assertStringIncludes(migration, "agent_event_deliveries_capacity_wait_idx");
  const original = await Deno.readTextFile(
    new URL(
      "../../supabase/migrations/20260610190000_agent_event_bus.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(
    original,
    "ON public.agent_event_deliveries (event_id, grant_id)",
  );
  assertEquals(
    /DROP\s+INDEX[\s\S]*agent_event_deliveries_unique/i.test(migration),
    false,
  );
});
