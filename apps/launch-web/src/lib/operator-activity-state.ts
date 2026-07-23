import type {
  LaunchAgentActivityPreview,
} from "../../../../shared/contracts/launch.ts";

function uniqueById<T extends { id: string }>(
  items: readonly T[],
): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/**
 * Activity pages after the first contain only older recent events. Keep the
 * first page's deterministic Up next/Now projections while appending stable,
 * deduplicated history in server order.
 */
export function mergeAgentActivityPages(
  current: LaunchAgentActivityPreview | null,
  incoming: LaunchAgentActivityPreview,
): LaunchAgentActivityPreview {
  if (!current) return incoming;
  const upNext = current.upNext ?? incoming.upNext;
  const now = uniqueById([...current.now, ...incoming.now]);
  const recent = uniqueById([...current.recent, ...incoming.recent]);
  return {
    upNext,
    now,
    recent,
    items: uniqueById([
      ...(upNext ? [upNext] : []),
      ...now,
      ...recent,
    ]),
    generatedAt: incoming.generatedAt,
  };
}
