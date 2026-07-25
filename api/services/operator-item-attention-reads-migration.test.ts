// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const migration = await Deno.readTextFile(
  new URL(
    '../../supabase/migrations/20260724120000_operator_item_attention_reads.sql',
    import.meta.url,
  ),
);

Deno.test('canonical Attention read returns page and exact counts from one materialized snapshot', () => {
  assertStringIncludes(
    migration,
    'CREATE OR REPLACE FUNCTION public.get_operator_attention_page',
  );
  assertStringIncludes(migration, 'visible_items AS MATERIALIZED');
  assertStringIncludes(migration, 'page_candidates AS MATERIALIZED');
  assertStringIncludes(migration, 'per_agent_counts jsonb');
  assertStringIncludes(migration, 'requires_decision_count bigint');
  assertStringIncludes(migration, 'blocking_count bigint');
  assertStringIncludes(
    migration,
    '(SELECT count(*) FROM page_candidates) > requested.page_limit',
  );
});

Deno.test('canonical Attention read is owner/private scoped and preserves account fanout', () => {
  assertStringIncludes(migration, 'agent.owner_id = p_user_id');
  assertStringIncludes(migration, "agent.visibility = 'private'");
  assertStringIncludes(migration, 'agent.deleted_at IS NULL');
  assertStringIncludes(migration, 'item.user_id = p_user_id');
  assertStringIncludes(
    migration,
    '(p_agent_id IS NULL OR affected.agent_id = p_agent_id)',
  );
  assertStringIncludes(migration, "'affectedAgents'");
  assertStringIncludes(migration, "'agentId', affected.agent_id");
});

Deno.test('canonical Attention presentation filters dismissals and future snoozes without recovering conditions', () => {
  assertStringIncludes(migration, "attention.state = 'open'");
  assertStringIncludes(
    migration,
    'attention.snoozed_until <= requested.observed_now',
  );
  assertStringIncludes(
    migration,
    '-- Expired snoozes become visible without mutating presentation state.',
  );
  assertEquals(migration.includes('UPDATE public.operator_items'), false);
  assertEquals(migration.includes('recovered_at ='), false);
});

Deno.test('canonical Attention read orders only by trusted source metadata and never parses prose', () => {
  assertStringIncludes(migration, 'visible.source_key ASC');
  assertStringIncludes(migration, 'visible.source_ordinal ASC');
  assertStringIncludes(migration, 'visible.detected_at ASC');
  assertEquals(migration.includes('title ILIKE'), false);
  assertEquals(migration.includes("diagnosis->>'summary'"), false);
  assertEquals(migration.includes('remediations->>'), false);
});

Deno.test('canonical Attention read RPC remains service-role only and rollback additive', () => {
  assertStringIncludes(migration, 'STABLE');
  assertStringIncludes(migration, 'SECURITY DEFINER');
  assertStringIncludes(
    migration,
    'FROM PUBLIC, anon, authenticated, service_role',
  );
  assertStringIncludes(migration, 'TO service_role');
  assertEquals(migration.includes('DROP TABLE'), false);
  assertEquals(migration.includes('DROP FUNCTION'), false);
  assertEquals(migration.includes('ALTER TABLE'), false);
});
