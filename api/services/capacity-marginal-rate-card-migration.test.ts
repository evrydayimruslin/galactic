import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260717171000_capacity_marginal_rate_card.sql",
    import.meta.url,
  ),
);

Deno.test("capacity rate card pins current Cloudflare marginal rates without rewriting wallet weights", () => {
  assertStringIncludes(migration, "capacity_rate_card_version = 1");
  assertStringIncludes(
    migration,
    "capacity_d1_read_light_per_million_rows = 0.1",
  );
  assertStringIncludes(
    migration,
    "capacity_d1_write_light_per_million_rows = 100",
  );
  assertStringIncludes(
    migration,
    "capacity_kv_read_light_per_million_operations = 50",
  );
  assertStringIncludes(
    migration,
    "capacity_kv_write_light_per_million_operations = 500",
  );
  assertStringIncludes(
    migration,
    "capacity_kv_delete_light_per_million_operations = 500",
  );
  assertStringIncludes(
    migration,
    "capacity_kv_list_light_per_million_operations = 500",
  );
  assertStringIncludes(
    migration,
    "capacity_r2_class_a_light_per_million_operations = 450",
  );
  assertStringIncludes(
    migration,
    "capacity_r2_class_b_light_per_million_operations = 36",
  );
  assertStringIncludes(
    migration,
    "capacity_r2_delete_light_per_million_operations = 0",
  );
  assertStringIncludes(
    migration,
    "capacity_queue_light_per_million_operations = 40",
  );

  const update = migration.slice(
    migration.indexOf("UPDATE public.platform_billing_config"),
  );
  assertEquals(update.includes("d1_read_rows_per_cloud_unit ="), false);
  assertEquals(update.includes("d1_write_rows_per_cloud_unit ="), false);
  assertEquals(update.includes("r2_ops_per_cloud_unit ="), false);
  assertEquals(update.includes("kv_ops_per_cloud_unit ="), false);
  assertStringIncludes(
    migration,
    "EVENT consumer cost is allocated once per pass, never per subscriber",
  );
  assertStringIncludes(
    migration,
    "Telemetry, settlement-recovery, and EVENT cycles with no settlement receipt remain platform reconciliation overhead",
  );
  assertStringIncludes(
    migration,
    "capacity_queue_light_per_million_operations < 'Infinity'::double precision",
  );
  assertStringIncludes(
    migration,
    "capacity_d1_read_light_per_million_rows < 'Infinity'::double precision",
  );
});
