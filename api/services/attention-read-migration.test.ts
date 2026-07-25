// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import type {
  LaunchAgentAttentionItem,
  LaunchAgentAttentionProjection,
  LaunchOperatorAttentionProjection,
  LaunchOperatorConditionCode,
} from '../../shared/contracts/launch.ts';
import {
  compareAttentionSemantics,
  readAttentionWithMigration,
  resolveOperatorAttentionReadMode,
} from './attention-read-migration.ts';
import { formatOperatorAttentionCursor } from './operator-item-reader.ts';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const DETECTED_AT = '2026-07-24T18:00:00.000Z';

function legacy(
  kind = 'routine_paused',
  openCount = 1,
  requiresDecisionCount = 0,
): LaunchAgentAttentionProjection {
  return {
    items: [{
      id: 'legacy-item',
      notificationId: '33333333-3333-4333-8333-333333333333',
      agentId: AGENT_ID,
      type: 'incident',
      severity: 'warning',
      requiresAction: true,
      incidentCode: null,
      lifecycle: {
        state: 'open',
        readAt: null,
        stateChangedAt: DETECTED_AT,
        snoozedUntil: null,
        resolvedAt: null,
        resolutionReason: null,
        archivedAt: null,
      },
      brief: {
        headline: 'Legacy copy can change',
        impact: null,
        context: null,
        recommendedNextMove: null,
        requiresDecision: requiresDecisionCount > 0,
        confidence: null,
        evidence: [],
      },
      actions: [],
      occurredAt: DETECTED_AT,
      enrichment: {
        status: 'raw',
        version: null,
        generatedAt: null,
      },
      raw: { kind, title: 'Arbitrary legacy title', body: null },
    } as LaunchAgentAttentionItem],
    openCount,
    requiresDecisionCount,
    nextCursor: null,
    available: true,
    unavailableReason: null,
  };
}

function canonical(
  code: LaunchOperatorConditionCode = 'ROUTINE_PAUSED_AFTER_FAILURES',
  openCount = 1,
  requiresDecisionCount = 0,
): LaunchOperatorAttentionProjection {
  return {
    contractVersion: '2026-07-24.operator-issues.1',
    items: [{
      item: {
        id: ITEM_ID,
        conditionKey: 'routine:condition',
        itemClass: 'issue',
        scope: {
          kind: 'routine',
          agentId: AGENT_ID,
          routineId: '44444444-4444-4444-8444-444444444444',
        },
        severity: 'warning',
        diagnosis: {
          code,
          causeCode: null,
          summary: 'Canonical diagnosis',
          detail: null,
          provenance: 'platform',
          evidence: [],
        },
        affectedAgents: [{ agentId: AGENT_ID, blocking: true }],
        remediations: [{
          id: 'routine:condition:remediation:open_routine',
          key: 'open_routine',
          label: 'Open routine',
          description: null,
          presentation: 'navigate',
          requiredAuthority: 'agent_operate',
          sideEffect: 'none',
          target: {
            kind: 'routine',
            agentId: AGENT_ID,
            routineId: '44444444-4444-4444-8444-444444444444',
          },
        }],
        requiresAction: true,
        requiresDecision: requiresDecisionCount > 0,
        ordering: { sourceOrdinal: 0, dependsOnConditionKeys: [] },
        recovery: {
          mode: 'revalidate_condition',
          mayRecoverAutomatically: true,
          resumesScheduledWork: false,
        },
        detectedAt: DETECTED_AT,
      },
      attention: {
        state: 'open',
        readAt: null,
        snoozedUntil: null,
        dismissedAt: null,
      },
    }],
    agentCounts: [{
      agent: { id: AGENT_ID, slug: 'agent', name: 'Agent' },
      openCount,
      requiresDecisionCount,
      blockingCount: openCount,
    }],
    openCount,
    requiresDecisionCount,
    blockingCount: openCount,
    nextCursor: null,
    available: true,
    unavailableReason: null,
    generatedAt: DETECTED_AT,
  };
}

Deno.test('Attention shadow comparison uses typed kind mappings, never copy parsing', () => {
  assertEquals(compareAttentionSemantics(legacy(), canonical()), {
    status: 'match',
    reasons: [],
    legacy: {
      openCount: 1,
      requiresDecisionCount: 0,
      mappedConditions: 1,
      unmappedConditions: 0,
    },
    canonical: {
      openCount: 1,
      requiresDecisionCount: 0,
      mappedConditionProjections: 1,
      canonicalOnlyConditions: 0,
    },
  });
});

Deno.test('Attention shadow comparison classifies canonical setup and corrected decisions as expected differences', () => {
  const setup = canonical('ACCOUNT_BYOK_MISSING', 1, 0);
  const result = compareAttentionSemantics(
    legacy('legacy_setup_copy', 2, 1),
    setup,
  );
  assertEquals(result.status, 'expected_difference');
  assertEquals(result.reasons, [
    'canonical_only_expected',
    'legacy_unmapped_expected',
    'aggregate_count_difference',
    'decision_semantics_expected',
  ]);
});

Deno.test('Attention shadow comparison reports mapped coverage gaps as drift', () => {
  const result = compareAttentionSemantics(legacy(), {
    ...canonical(),
    items: [],
    openCount: 0,
    blockingCount: 0,
  });
  assertEquals(result.status, 'drift');
  assertEquals(
    result.reasons.includes('mapped_condition_missing_canonical'),
    true,
  );
  const paged = compareAttentionSemantics(
    legacy(),
    { ...canonical(), items: [] },
    false,
  );
  assertEquals(paged.status, 'expected_difference');
  assertEquals(paged.reasons.includes('page_item_comparison_skipped'), true);
});

Deno.test('Attention read mode is fail-closed to legacy', () => {
  assertEquals(resolveOperatorAttentionReadMode(''), 'legacy');
  assertEquals(resolveOperatorAttentionReadMode('CANONICAL'), 'legacy');
  assertEquals(resolveOperatorAttentionReadMode('shadow'), 'shadow');
  assertEquals(resolveOperatorAttentionReadMode('canonical'), 'canonical');
});

Deno.test('legacy mode is an instant rollback that never touches canonical storage', async () => {
  let canonicalReads = 0;
  const result = await readAttentionWithMigration<
    LaunchAgentAttentionProjection
  >('agent', {
    mode: 'legacy',
    readLegacy: () => Promise.resolve(legacy()),
    readCanonical: () => {
      canonicalReads += 1;
      return Promise.resolve(canonical());
    },
  });
  assertEquals(result.readSource, undefined);
  assertEquals(result.operatorItems, undefined);
  assertEquals(canonicalReads, 0);
});

Deno.test('shadow mode isolates canonical failures and records bounded comparison telemetry', async () => {
  const events: Array<Record<string, unknown>> = [];
  const result = await readAttentionWithMigration<
    LaunchAgentAttentionProjection
  >('agent', {
    mode: 'shadow',
    readLegacy: () => Promise.resolve(legacy()),
    readCanonical: () => Promise.reject(new Error('database unavailable')),
    log: (event) => events.push(event),
  });
  assertEquals(result.readSource, 'legacy');
  assertEquals(result.operatorItems, undefined);
  assertEquals(events.length, 1);
  assertEquals(events[0]?.fallbackReason, 'canonical_read_failed');
  assertEquals(events[0]?.canonicalFailureStage, 'unexpected_error');
  assertEquals(JSON.stringify(events).includes('database unavailable'), false);
});

Deno.test('canonical mode selects canonical data and falls back safely on failure', async () => {
  const selected = await readAttentionWithMigration<
    LaunchAgentAttentionProjection
  >('agent', {
    mode: 'canonical',
    readLegacy: () => Promise.resolve(legacy()),
    readCanonical: () => Promise.resolve(canonical()),
    log: () => {},
  });
  assertEquals(selected.readSource, 'canonical');
  assertEquals(selected.operatorItems?.items[0]?.item.id, ITEM_ID);

  const fallback = await readAttentionWithMigration<
    LaunchAgentAttentionProjection
  >('agent', {
    mode: 'canonical',
    readLegacy: () => Promise.resolve(legacy()),
    readCanonical: () => Promise.reject(new Error('canonical down')),
    log: () => {},
  });
  assertEquals(fallback.readSource, 'legacy');
  assertEquals(fallback.operatorItems, undefined);
});

Deno.test('canonical mode survives a legacy outage with an explicit compatibility shell', async () => {
  const result = await readAttentionWithMigration<
    LaunchAgentAttentionProjection
  >('agent', {
    mode: 'canonical',
    readLegacy: () => Promise.reject(new Error('legacy down')),
    readCanonical: () => Promise.resolve(canonical()),
    buildLegacyFallback: () => ({
      items: [],
      openCount: 0,
      requiresDecisionCount: 0,
      available: false,
      unavailableReason: 'temporarily_unavailable',
    }),
    log: () => {},
  });
  assertEquals(result.readSource, 'canonical');
  assertEquals(result.available, false);
  assertEquals(result.operatorItems?.available, true);
});

Deno.test('canonical rollout honors an already-issued legacy cursor', async () => {
  let legacyCursor: string | null = null;
  let canonicalCursor: string | null = 'not-called';
  const result = await readAttentionWithMigration<
    LaunchAgentAttentionProjection
  >('agent', {
    mode: 'canonical',
    cursor: 'attention-v1.legacy-page',
    readLegacy: (cursor) => {
      legacyCursor = cursor;
      return Promise.resolve(legacy());
    },
    readCanonical: (cursor) => {
      canonicalCursor = cursor;
      return Promise.resolve(canonical());
    },
    log: () => {},
  });
  assertEquals(legacyCursor, 'attention-v1.legacy-page');
  assertEquals(canonicalCursor, null);
  assertEquals(result.readSource, 'legacy');

  const operatorCursor = formatOperatorAttentionCursor({
    sourceKey: 'setup.agent',
    sourceOrdinal: 0,
    detectedAt: DETECTED_AT,
    itemId: ITEM_ID,
  });
  let receivedCanonicalCursor: string | null = null;
  await readAttentionWithMigration<LaunchAgentAttentionProjection>(
    'agent',
    {
      mode: 'canonical',
      cursor: operatorCursor,
      readLegacy: () => Promise.resolve(legacy()),
      readCanonical: (cursor) => {
        receivedCanonicalCursor = cursor;
        return Promise.resolve(canonical());
      },
      log: () => {},
    },
  );
  assertEquals(receivedCanonicalCursor, operatorCursor);
});

Deno.test('shadow mode still requires the established legacy read', async () => {
  await assertRejects(
    () =>
      readAttentionWithMigration<LaunchAgentAttentionProjection>('agent', {
        mode: 'shadow',
        readLegacy: () => Promise.reject(new Error('legacy down')),
        readCanonical: () => Promise.resolve(canonical()),
        log: () => {},
      }),
    Error,
    'legacy down',
  );
});
