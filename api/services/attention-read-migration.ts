import { getEnv } from '../lib/env.ts';
import type {
  LaunchAgentAttentionItem,
  LaunchAgentAttentionProjection,
  LaunchAttentionReadSource,
  LaunchGlobalAttentionResponse,
  LaunchOperatorAttentionProjection,
  LaunchOperatorConditionCode,
} from '../../shared/contracts/launch.ts';
import { isOperatorAttentionCursor } from './operator-item-reader.ts';

const OPERATOR_ATTENTION_READ_MODE_ENV = 'OPERATOR_ATTENTION_READ_MODE';

type OperatorAttentionReadMode = 'legacy' | 'shadow' | 'canonical';
type AttentionReadSurface = 'account' | 'agent';

type AttentionParityReason =
  | 'canonical_unavailable'
  | 'legacy_unavailable'
  | 'canonical_only_expected'
  | 'legacy_unmapped_expected'
  | 'mapped_condition_missing_canonical'
  | 'mapped_condition_missing_legacy'
  | 'aggregate_count_difference'
  | 'decision_semantics_expected'
  | 'page_item_comparison_skipped';

interface AttentionSemanticComparison {
  status: 'match' | 'expected_difference' | 'drift' | 'unavailable';
  reasons: AttentionParityReason[];
  legacy: {
    openCount: number;
    requiresDecisionCount: number;
    mappedConditions: number;
    unmappedConditions: number;
  } | null;
  canonical: {
    openCount: number;
    requiresDecisionCount: number;
    mappedConditionProjections: number;
    canonicalOnlyConditions: number;
  } | null;
}

type LegacyAttention =
  | LaunchAgentAttentionProjection
  | LaunchGlobalAttentionResponse;

interface AttentionReadMigrationDependencies<
  TLegacy extends LegacyAttention,
> {
  mode?: OperatorAttentionReadMode;
  cursor?: string | null;
  readLegacy: (cursor: string | null) => Promise<TLegacy>;
  readCanonical: (
    cursor: string | null,
  ) => Promise<LaunchOperatorAttentionProjection>;
  buildLegacyFallback?: (
    canonical: LaunchOperatorAttentionProjection,
  ) => TLegacy;
  log?: (event: Record<string, unknown>) => void;
}

const LEGACY_KIND_TO_CONDITION = new Map<
  string,
  LaunchOperatorConditionCode
>([
  ['routine_paused', 'ROUTINE_PAUSED_AFTER_FAILURES'],
  ['routine_budget_exhausted', 'ROUTINE_USAGE_EXHAUSTED'],
]);

const SHADOW_COMPARABLE_CODES = new Set<LaunchOperatorConditionCode>([
  'ROUTINE_PAUSED_AFTER_FAILURES',
  'ROUTINE_USAGE_EXHAUSTED',
]);

function legacyItems(value: LegacyAttention): LaunchAgentAttentionItem[] {
  if ('entries' in value) return value.entries.map((entry) => entry.item);
  return value.items;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mappedLegacyConditions(items: readonly LaunchAgentAttentionItem[]) {
  const mapped = new Map<string, number>();
  let unmapped = 0;
  for (const item of items) {
    const code = LEGACY_KIND_TO_CONDITION.get(item.raw.kind);
    if (!code) {
      unmapped += 1;
      continue;
    }
    increment(mapped, `${item.agentId}:${code}`);
  }
  return { mapped, unmapped };
}

function mappedCanonicalConditions(
  value: LaunchOperatorAttentionProjection,
) {
  const mapped = new Map<string, number>();
  let canonicalOnly = 0;
  for (const entry of value.items) {
    const code = entry.item.diagnosis.code;
    if (!SHADOW_COMPARABLE_CODES.has(code)) {
      canonicalOnly += 1;
      continue;
    }
    for (const affected of entry.item.affectedAgents) {
      increment(mapped, `${affected.agentId}:${code}`);
    }
  }
  return { mapped, canonicalOnly };
}

function mapDeficit(
  expected: ReadonlyMap<string, number>,
  actual: ReadonlyMap<string, number>,
): number {
  let deficit = 0;
  for (const [key, count] of expected) {
    deficit += Math.max(0, count - (actual.get(key) ?? 0));
  }
  return deficit;
}

/**
 * Semantic comparison intentionally ignores titles, bodies, URLs, and raw
 * item equality. Only explicitly mapped legacy kinds are compared, and shared
 * canonical conditions are expanded to affected-Agent projections first.
 */
export function compareAttentionSemantics(
  legacy: LegacyAttention | null,
  canonical: LaunchOperatorAttentionProjection | null,
  comparePageItems = true,
): AttentionSemanticComparison {
  if (!legacy || !canonical) {
    const reasons: AttentionParityReason[] = [];
    if (!legacy) reasons.push('legacy_unavailable');
    if (!canonical) reasons.push('canonical_unavailable');
    return {
      status: 'unavailable',
      reasons,
      legacy: legacy
        ? {
          openCount: legacy.openCount,
          requiresDecisionCount: legacy.requiresDecisionCount,
          mappedConditions: 0,
          unmappedConditions: legacyItems(legacy).length,
        }
        : null,
      canonical: canonical
        ? {
          openCount: canonical.openCount,
          requiresDecisionCount: canonical.requiresDecisionCount,
          mappedConditionProjections: 0,
          canonicalOnlyConditions: canonical.items.length,
        }
        : null,
    };
  }

  const legacyProjection = mappedLegacyConditions(legacyItems(legacy));
  const canonicalProjection = mappedCanonicalConditions(canonical);
  const reasons = new Set<AttentionParityReason>();
  if (comparePageItems) {
    if (
      mapDeficit(legacyProjection.mapped, canonicalProjection.mapped) > 0
    ) {
      reasons.add('mapped_condition_missing_canonical');
    }
    if (
      mapDeficit(canonicalProjection.mapped, legacyProjection.mapped) > 0
    ) {
      reasons.add('mapped_condition_missing_legacy');
    }
  } else {
    reasons.add('page_item_comparison_skipped');
  }
  if (canonicalProjection.canonicalOnly > 0) {
    reasons.add('canonical_only_expected');
  }
  if (legacyProjection.unmapped > 0) {
    reasons.add('legacy_unmapped_expected');
  }
  if (legacy.openCount !== canonical.openCount) {
    reasons.add('aggregate_count_difference');
  }
  if (
    legacy.requiresDecisionCount !== canonical.requiresDecisionCount
  ) {
    reasons.add('decision_semantics_expected');
  }
  const drift = reasons.has('mapped_condition_missing_canonical') ||
    reasons.has('mapped_condition_missing_legacy');
  const reasonList = [...reasons];
  return {
    status: drift ? 'drift' : reasonList.length > 0 ? 'expected_difference' : 'match',
    reasons: reasonList,
    legacy: {
      openCount: legacy.openCount,
      requiresDecisionCount: legacy.requiresDecisionCount,
      mappedConditions: [...legacyProjection.mapped.values()].reduce(
        (total, count) => total + count,
        0,
      ),
      unmappedConditions: legacyProjection.unmapped,
    },
    canonical: {
      openCount: canonical.openCount,
      requiresDecisionCount: canonical.requiresDecisionCount,
      mappedConditionProjections: [
        ...canonicalProjection.mapped.values(),
      ].reduce((total, count) => total + count, 0),
      canonicalOnlyConditions: canonicalProjection.canonicalOnly,
    },
  };
}

export function resolveOperatorAttentionReadMode(
  raw = getEnv(OPERATOR_ATTENTION_READ_MODE_ENV),
): OperatorAttentionReadMode {
  return raw === 'shadow' || raw === 'canonical' ? raw : 'legacy';
}

function migrationLog(
  log: ((event: Record<string, unknown>) => void) | undefined,
  surface: AttentionReadSurface,
  mode: OperatorAttentionReadMode,
  source: LaunchAttentionReadSource,
  comparison: AttentionSemanticComparison,
  fallbackReason: string | null,
): void {
  (log ?? console.info)({
    event: 'operator_attention_read_comparison',
    surface,
    mode,
    source,
    status: comparison.status,
    reasons: comparison.reasons,
    fallbackReason,
    legacy: comparison.legacy,
    canonical: comparison.canonical,
  });
}

/**
 * Executes the guarded dual-read migration.
 *
 * - legacy: canonical storage is not touched (instant rollback);
 * - shadow: legacy is required, canonical is best-effort and compared;
 * - canonical: canonical is preferred, but a read failure falls back to a
 *   healthy legacy response instead of taking Attention down.
 *
 * Cursor formats are deliberately distinct. A legacy cursor keeps using the
 * legacy source during canonical rollout so already-open clients remain safe.
 */
export async function readAttentionWithMigration<
  TLegacy extends LegacyAttention,
>(
  surface: AttentionReadSurface,
  dependencies: AttentionReadMigrationDependencies<TLegacy>,
): Promise<TLegacy> {
  const mode = dependencies.mode ?? resolveOperatorAttentionReadMode();
  const cursor = dependencies.cursor ?? null;
  if (mode === 'legacy') {
    return await dependencies.readLegacy(cursor);
  }

  const legacyCursor = isOperatorAttentionCursor(cursor) ? null : cursor;
  const canonicalCursor = cursor && !isOperatorAttentionCursor(cursor) ? null : cursor;
  const [legacyResult, canonicalResult] = await Promise.allSettled([
    dependencies.readLegacy(legacyCursor),
    dependencies.readCanonical(canonicalCursor),
  ]);
  const legacy = legacyResult.status === 'fulfilled' ? legacyResult.value : null;
  const canonical = canonicalResult.status === 'fulfilled' ? canonicalResult.value : null;
  const comparison = compareAttentionSemantics(
    legacy,
    canonical,
    cursor === null,
  );

  if (mode === 'shadow') {
    if (legacyResult.status === 'rejected') throw legacyResult.reason;
    const requiredLegacy = legacyResult.value;
    migrationLog(
      dependencies.log,
      surface,
      mode,
      'legacy',
      comparison,
      canonical ? null : 'canonical_read_failed',
    );
    return {
      ...requiredLegacy,
      readSource: 'legacy',
      ...(canonical ? { operatorItems: canonical } : {}),
    };
  }

  // An old client may follow a legacy cursor after the rollout flag flips.
  // Preserve its pagination source for that request instead of returning the
  // first canonical page under an unrelated cursor.
  if (cursor && !isOperatorAttentionCursor(cursor) && legacy) {
    migrationLog(
      dependencies.log,
      surface,
      mode,
      'legacy',
      comparison,
      'legacy_cursor_compatibility',
    );
    return {
      ...legacy,
      readSource: 'legacy',
      ...(canonical ? { operatorItems: canonical } : {}),
    };
  }

  if (canonical && legacy) {
    migrationLog(
      dependencies.log,
      surface,
      mode,
      'canonical',
      comparison,
      null,
    );
    return {
      ...legacy,
      readSource: 'canonical',
      operatorItems: canonical,
    };
  }
  if (canonical && dependencies.buildLegacyFallback) {
    migrationLog(
      dependencies.log,
      surface,
      mode,
      'canonical',
      comparison,
      'legacy_read_failed',
    );
    return {
      ...dependencies.buildLegacyFallback(canonical),
      readSource: 'canonical',
      operatorItems: canonical,
    };
  }
  if (legacy) {
    migrationLog(
      dependencies.log,
      surface,
      mode,
      'legacy',
      comparison,
      'canonical_read_failed',
    );
    return { ...legacy, readSource: 'legacy' };
  }
  // Both sources failed, or only canonical succeeded without a caller-supplied
  // compatibility shell. The handler's established error mapping remains.
  if (legacyResult.status === 'rejected') throw legacyResult.reason;
  if (canonicalResult.status === 'rejected') throw canonicalResult.reason;
  throw new Error('Attention read migration could not select a source.');
}
