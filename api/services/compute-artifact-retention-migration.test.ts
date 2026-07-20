import {
  assert,
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260720124000_compute_artifact_retention.sql",
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

Deno.test("ready output retention is explicit and upgrade-safe", () => {
  assertStringIncludes(migration, "ADD COLUMN expires_at timestamptz");
  assertStringIncludes(
    migration,
    "ADD COLUMN retention_protected_until timestamptz",
  );
  assertStringIncludes(migration, "ADD COLUMN object_deleted_at timestamptz");
  assertStringIncludes(
    migration,
    "transaction_timestamp() + interval '30 days'",
  );
  assertStringIncludes(migration, "compute_artifacts_ready_expiry_check");
  assertStringIncludes(
    migration,
    "COMPUTE_ARTIFACT_RETENTION_MIGRATION_BLOCKED",
  );
  assertStringIncludes(
    migration,
    "source.direction IS DISTINCT FROM 'output'",
  );
});

Deno.test("input aliases are admitted once, pin a direct source, and can always release", () => {
  const trigger = functionBody("apply_compute_artifact_retention");
  assertStringIncludes(
    trigger,
    "NEW.direction = 'input' AND TG_OP = 'INSERT'",
  );
  assertStringIncludes(trigger, "v_source.direction IS DISTINCT FROM 'output'");
  assertStringIncludes(trigger, "v_source.state IS DISTINCT FROM 'ready'");
  assertStringIncludes(
    trigger,
    "v_source.expires_at <= clock_timestamp()",
  );
  assertStringIncludes(trigger, "FOR SHARE");
  // A ready -> deleted alias update must not re-check an already-expired
  // source or rewrite a migration-backfilled expiry.
  const inputBranch = trigger.slice(
    trigger.indexOf("NEW.direction = 'input'"),
    trigger.indexOf("ELSIF NEW.direction = 'output'"),
  );
  assertStringIncludes(inputBranch, "TG_OP = 'INSERT'");

  const tombstone = functionBody("tombstone_expired_compute_artifact");
  assertStringIncludes(tombstone, "v_artifact.direction = 'input'");
  assertStringIncludes(
    tombstone,
    "COALESCE(v_run.finished_at, v_run.updated_at) > p_cutoff",
  );
  assertFalse(
    tombstone.slice(
      tombstone.indexOf("IF v_artifact.direction = 'input'"),
      tombstone.indexOf("ELSIF v_artifact.direction = 'output'"),
    ).includes("v_artifact.expires_at"),
    "terminal aliases must release even after their source expiry",
  );
});

Deno.test("expired outputs remain pinned by aliases and active downloads", () => {
  const list = functionBody("list_expired_compute_artifacts");
  const tombstone = functionBody("tombstone_expired_compute_artifact");
  for (const body of [list, tombstone]) {
    assertStringIncludes(body, "input_alias.source_artifact_id = ");
    assertStringIncludes(body, "input_alias.state = 'ready'");
  }
  assertStringIncludes(list, "artifact.retention_protected_until");
  assertStringIncludes(tombstone, "v_artifact.retention_protected_until");
  assertStringIncludes(
    tombstone,
    "v_run.state NOT IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')",
  );

  const lease = functionBody("lease_compute_artifact_owner_download");
  assertStringIncludes(lease, "v_artifact.expires_at <= v_now");
  assertStringIncludes(lease, "v_now + interval '1 hour'");
  assertStringIncludes(lease, "FOR UPDATE");
});

Deno.test("retention batches cannot starve physical output deletion", () => {
  const list = functionBody("list_expired_compute_artifacts");
  assertStringIncludes(list, "p_limit NOT BETWEEN 2 AND 500");
  assertStringIncludes(list, "row_number() OVER");
  assertStringIncludes(list, "PARTITION BY eligible.direction");
  assertStringIncludes(list, "ORDER BY ranked.direction_rank");
  assertStringIncludes(
    list,
    "CASE ranked.direction WHEN 'input' THEN 0 ELSE 1 END",
  );
});

Deno.test("physical output quota is serialized and released only after exact R2 deletion", () => {
  assertStringIncludes(
    migration,
    "CREATE TABLE public.compute_artifact_owner_storage_quotas",
  );
  assertStringIncludes(migration, "max_object_count = 10000");
  assertStringIncludes(migration, "max_bytes = 10737418240");
  assertStringIncludes(migration, "compute_artifacts_unpurged_owner_quota_idx");
  const quota = functionBody("enforce_compute_artifact_owner_storage_quota");
  assertStringIncludes(quota, "WHERE quota.user_id = NEW.user_id");
  assertStringIncludes(quota, "FOR UPDATE");
  assertStringIncludes(quota, "artifact.direction = 'output'");
  assertStringIncludes(quota, "artifact.object_deleted_at IS NULL");
  assertStringIncludes(quota, "COMPUTE_ARTIFACT_STORAGE_QUOTA_EXCEEDED");

  const confirm = functionBody("confirm_compute_artifact_object_deleted");
  assertStringIncludes(confirm, "v_artifact.state <> 'deleted'");
  assertStringIncludes(
    confirm,
    "v_artifact.storage_key IS DISTINCT FROM p_storage_key",
  );
  assertStringIncludes(confirm, "SET object_deleted_at = p_deleted_at");

  const unpurged = functionBody("list_unpurged_compute_artifacts");
  assertStringIncludes(unpurged, "artifact.object_deleted_at IS NULL");
  assertStringIncludes(unpurged, "artifact.updated_at <= p_cutoff");
  assertStringIncludes(unpurged, "p_limit NOT BETWEEN 1 AND 500");
});

Deno.test("retention mutation RPCs are service-role only", () => {
  for (
    const signature of [
      "confirm_compute_artifact_object_deleted(\n  uuid, text, timestamptz\n)",
      "list_unpurged_compute_artifacts(\n  timestamptz, timestamptz, integer\n)",
      "lease_compute_artifact_owner_download(\n  uuid, uuid, uuid, uuid, text\n)",
      "list_expired_compute_artifacts(\n  timestamptz, timestamptz, integer\n)",
      "tombstone_expired_compute_artifact(\n  uuid, bigint, timestamptz, timestamptz\n)",
    ]
  ) {
    assertStringIncludes(
      migration,
      `REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`,
    );
    assertStringIncludes(
      migration,
      `GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`,
    );
  }
  assertFalse(migration.includes("TO anon"));
  assertFalse(migration.includes("TO authenticated"));
  assert(
    migration.indexOf(
      "REVOKE ALL ON FUNCTION public.confirm_compute_artifact_object_deleted",
    ) <
      migration.indexOf(
        "GRANT EXECUTE ON FUNCTION public.confirm_compute_artifact_object_deleted",
      ),
  );
});
