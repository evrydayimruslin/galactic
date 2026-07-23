// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

async function migration(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../../supabase/migrations/${name}`, import.meta.url),
  );
}

const preferences = await migration(
  "20260723100000_agent_operator_preferences.sql",
);
const attention = await migration(
  "20260723101000_notification_attention_lifecycle.sql",
);
const projections = await migration(
  "20260723102000_agent_operator_projections.sql",
);
const search = await migration(
  "20260723103000_agent_search_documents.sql",
);
const searchProducers = await migration(
  "20260723104000_agent_search_projection_producers.sql",
);
const ownerAttention = await migration(
  "20260723105000_owner_attention_snapshot.sql",
);

Deno.test("Operator preferences use owner-scoped revision CAS and zero-based positions", () => {
  assertStringIncludes(
    preferences,
    "fleet_position IS NULL OR fleet_position >= 0",
  );
  assertStringIncludes(preferences, "position >= 0");
  assertStringIncludes(preferences, ")::integer - 1 AS fleet_position");
  assertStringIncludes(preferences, "requested.position::integer - 1");
  assertStringIncludes(preferences, "fleet_preference_revision_conflict");
  assertStringIncludes(preferences, "agent_preference_revision_conflict");
  assertStringIncludes(preferences, "FOR UPDATE");
  assertStringIncludes(preferences, "pg_advisory_xact_lock");
  assertStringIncludes(preferences, "replace_user_fleet_shortcuts");
  assertStringIncludes(
    preferences,
    "get_user_agent_interface_favorites_snapshot",
  );
  assertStringIncludes(preferences, "get_user_fleet_preferences_snapshot");
  assertStringIncludes(
    preferences,
    "revision token and the exact preference rows it certifies",
  );
});

Deno.test("Interface Favorites distinguish first contact from explicit empty", () => {
  assertStringIncludes(preferences, "favorites_initialized_at timestamptz");
  assertStringIncludes(
    preferences,
    "IF v_preference.favorites_initialized_at IS NULL THEN",
  );
  assertStringIncludes(
    preferences,
    "v_first_interface := p_manifest_interface_ids[1]",
  );
  assertStringIncludes(preferences, "favorites_initialized_at = now()");
  assertStringIncludes(
    preferences,
    "array_agg(interface_id ORDER BY position),\n    ARRAY[]::text[]",
  );
});

Deno.test("Attention separates reports from incident lifecycle and protects evidence", () => {
  assertStringIncludes(attention, "item_class IN ('report', 'incident')");
  assertStringIncludes(
    attention,
    "lifecycle_state IN ('open', 'snoozed', 'resolved', 'archived')",
  );
  assertStringIncludes(attention, "reading an incident never resolves it");
  assertStringIncludes(attention, "notification_raw_evidence_immutable");
  assertStringIncludes(
    attention,
    "CREATE OR REPLACE FUNCTION public.create_user_notification_episode",
  );
  assertStringIncludes(attention, "pg_advisory_xact_lock");
  assertStringIncludes(
    attention,
    "user_notifications_user_report_dedupe_key",
  );
  assertStringIncludes(
    attention,
    "user_notifications_user_active_incident_dedupe_key",
  );
  assertStringIncludes(
    attention,
    "kind IN ('agent_report', 'routine_report', 'routine_summary')",
  );
  assertEquals(
    attention.includes(
      "kind IN ('agent_report', 'routine_report', 'routine_summary', 'routine_budget_exhausted')",
    ),
    false,
  );
  assertStringIncludes(attention, "ON DELETE RESTRICT NOT VALID");
  assertStringIncludes(
    attention,
    "operator_projection_event_generation_seq",
  );
  assertStringIncludes(attention, "enqueue_generation bigint NOT NULL");
  assertStringIncludes(
    attention,
    "CREATE OR REPLACE FUNCTION public.prune_operator_projection_jobs",
  );
  assertStringIncludes(attention, "p_retention_days NOT BETWEEN 30 AND 3650");
  assertStringIncludes(attention, "p_limit NOT BETWEEN 1 AND 1000");
  assertStringIncludes(
    attention,
    "GRANT EXECUTE ON FUNCTION public.prune_operator_projection_jobs",
  );
  assertStringIncludes(
    attention,
    "REVOKE ALL ON FUNCTION public.prune_operator_projection_jobs",
  );
  assertStringIncludes(attention, "notification_brief_owner_mismatch");
  assertStringIncludes(attention, "operator_projection_source_owner_mismatch");

  const outboxStart = attention.indexOf(
    "CREATE TABLE public.operator_projection_jobs",
  );
  const outboxEnd = attention.indexOf(
    "CREATE INDEX operator_projection_jobs_claim_idx",
  );
  const outbox = attention.slice(outboxStart, outboxEnd);
  assert(outboxStart >= 0 && outboxEnd > outboxStart);
  assertEquals(
    /\b(body|payload|ciphertext|secret_value)\b/i.test(outbox),
    false,
  );
});

Deno.test("Attention actions use one camelCase evidence-bound schema and account reads stay owner-scoped", () => {
  for (
    const parameter of [
      "'agentId'",
      "'settingKey'",
      "'releaseId'",
      "'routineId'",
      "'grantId'",
    ]
  ) {
    assertStringIncludes(ownerAttention, parameter);
  }
  for (
    const legacyParameter of [
      "action_parameters->'agent_id'",
      "action_parameters->'setting_key'",
      "action_parameters->'release_id'",
      "action_parameters->'routine_id'",
      "action_parameters->'grant_id'",
    ]
  ) {
    assertStringIncludes(ownerAttention, legacyParameter);
  }
  assertStringIncludes(
    ownerAttention,
    "notification_briefs_canonical_action_parameters_check",
  );
  assertStringIncludes(
    ownerAttention,
    "CREATE OR REPLACE FUNCTION public.get_owner_attention_snapshot",
  );
  assertStringIncludes(ownerAttention, "agent.owner_id = p_user_id");
  assertStringIncludes(ownerAttention, "agent.visibility = 'private'");
  assertStringIncludes(ownerAttention, "agent.deleted_at IS NULL");
  assertStringIncludes(
    ownerAttention,
    "LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 200)",
  );
  assertStringIncludes(
    ownerAttention,
    "count(*) FILTER (\n        WHERE item_class = 'incident'",
  );
  assertStringIncludes(
    ownerAttention,
    "REVOKE ALL ON FUNCTION public.get_owner_attention_snapshot",
  );
  assertStringIncludes(
    ownerAttention,
    "GRANT EXECUTE ON FUNCTION public.get_owner_attention_snapshot",
  );
  assertEquals(ownerAttention.includes("p_agent_ids"), false);
});

Deno.test("Fleet v2 is additive, strict, zero-based, and activity is bounded", () => {
  assertStringIncludes(
    projections,
    "CREATE OR REPLACE FUNCTION public.get_launch_fleet_snapshot(\n  p_user_id uuid,\n  p_include_operator_fields boolean",
  );
  assertStringIncludes(projections, "working_exclusion_reason text");
  for (
    const reason of [
      "no_live_release",
      "no_enabled_routine",
      "setup_required",
      "error",
      "paused",
      "disabled",
    ]
  ) {
    assertStringIncludes(projections, `'${reason}'`);
  }
  assertStringIncludes(
    projections,
    ")::integer - 1 AS effective_fleet_position",
  );
  assertStringIncludes(
    projections,
    "count(*) FILTER (WHERE projected.is_working_ready)",
  );
  assertStringIncludes(projections, "p_recent_limit integer DEFAULT 3");
  assertStringIncludes(projections, "LIMIT p_recent_limit");
  assertEquals(
    (projections.match(/p_recent_limit integer DEFAULT 3/g) ?? []).length,
    1,
  );
});

Deno.test("Agent navigation documents are private, safe, and destination-first", () => {
  assertStringIncludes(search, "FOREIGN KEY (user_id, agent_id)");
  assertStringIncludes(search, "REFERENCES public.apps(owner_id, id)");
  assertStringIncludes(search, "apps.owner_id = p_user_id");
  assertStringIncludes(search, "documents.user_id = p_user_id");
  assertStringIncludes(search, "route LIKE '/agents/%'");
  assertStringIncludes(
    search,
    "embedding_status IN ('none', 'pending', 'ready', 'failed', 'disabled')",
  );
  assertStringIncludes(
    search,
    "REVOKE ALL ON TABLE public.agent_search_documents",
  );
  assertStringIncludes(
    search,
    "GRANT ALL ON TABLE public.agent_search_documents TO service_role",
  );

  const tableStart = search.indexOf(
    "CREATE TABLE public.agent_search_documents",
  );
  const tableEnd = search.indexOf(
    "CREATE INDEX agent_search_documents_owner_agent_idx",
  );
  const table = search.slice(tableStart, tableEnd);
  assert(tableStart >= 0 && tableEnd > tableStart);
  assertEquals(
    /\b(secret_value|encrypted_value|run_arguments|run_results|raw_content)\b/i
      .test(table),
    false,
  );
});

Deno.test("Search projection producers cover safe static metadata and bounded run history", () => {
  for (
    const sourceType of [
      "routine_run",
      "compute_run",
    ]
  ) {
    assertStringIncludes(searchProducers, `'${sourceType}'`);
  }
  assertStringIncludes(
    searchProducers,
    "JOIN public.user_routines AS routines",
  );
  assertStringIncludes(
    searchProducers,
    "runs.agent_id IS NOT DISTINCT FROM NEW.agent_id",
  );
  for (
    const appColumn of [
      "manifest",
      "env_schema",
      "declared_permissions",
      "current_version_promoted_at",
    ]
  ) {
    assertStringIncludes(searchProducers, appColumn);
  }
  assertStringIncludes(searchProducers, "WHERE runs.source_rank <= 50");
  assertStringIncludes(
    searchProducers,
    "CREATE OR REPLACE FUNCTION public.enqueue_attention_search_reconciliation",
  );
  assertStringIncludes(
    searchProducers,
    "CREATE TABLE public.agent_search_subject_revisions",
  );
  assertStringIncludes(
    searchProducers,
    "CREATE TABLE public.agent_search_source_revisions",
  );
  assertStringIncludes(
    searchProducers,
    "CREATE TRIGGER record_agent_search_source_generation",
  );
  assertStringIncludes(
    searchProducers,
    "agent_search_subject_revisions.enqueue_generation <",
  );
  assertStringIncludes(
    searchProducers,
    "enqueue_attention_search_tombstone_on_notification_delete",
  );
  assertStringIncludes(
    searchProducers,
    "enqueue_routine_search_tombstones_before_delete",
  );
  assertStringIncludes(
    searchProducers,
    "DELETE FROM public.agent_search_subject_revisions",
  );
  assertEquals(
    (searchProducers.match(/WHERE runs\.source_rank <= 50/g) ?? []).length,
    2,
  );

  const appSourceStart = searchProducers.indexOf(
    "IF TG_TABLE_NAME = 'apps' THEN",
  );
  const appSourceEnd = searchProducers.indexOf(
    "ELSIF TG_TABLE_NAME = 'user_routines' THEN",
  );
  const appSource = searchProducers.slice(appSourceStart, appSourceEnd);
  assert(appSourceStart >= 0 && appSourceEnd > appSourceStart);
  assertEquals(/\bNEW\.env_vars\b/.test(appSource), false);

  const runSourceStart = searchProducers.indexOf(
    "CREATE OR REPLACE FUNCTION public.enqueue_agent_search_run_projection()",
  );
  const runSourceEnd = searchProducers.indexOf(
    "CREATE TRIGGER enqueue_agent_search_projection_on_routine_run",
  );
  const runSource = searchProducers.slice(runSourceStart, runSourceEnd);
  assert(runSourceStart >= 0 && runSourceEnd > runSourceStart);
  assertEquals(
    /\b(summary|error|run_config|execution_request|stdout|stderr)\b/i.test(
      runSource,
    ),
    false,
  );
});
