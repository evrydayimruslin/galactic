import type {
  LaunchAgentAttentionItem,
  LaunchGlobalAttentionAgentCount,
  LaunchGlobalAttentionEntry,
  LaunchGlobalAttentionResponse,
} from "../../../../shared/contracts/launch.ts";

export interface GlobalAttentionAgentGroup {
  agent: LaunchGlobalAttentionEntry["agent"];
  items: LaunchAgentAttentionItem[];
}

export function globalAttentionEntryMatches(
  entry: LaunchGlobalAttentionEntry,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    entry.agent.name,
    entry.agent.slug,
    entry.item.brief.headline,
    entry.item.brief.impact,
    entry.item.brief.context,
    entry.item.brief.recommendedNextMove,
    entry.item.raw.kind,
    entry.item.raw.title,
    entry.item.raw.body,
  ].filter(Boolean).join(" ").toLowerCase().includes(normalized);
}

export function groupGlobalAttentionEntries(
  entries: readonly LaunchGlobalAttentionEntry[],
): GlobalAttentionAgentGroup[] {
  const groups = new Map<string, GlobalAttentionAgentGroup>();
  for (const entry of entries) {
    const existing = groups.get(entry.agent.id);
    if (existing) {
      existing.items.push(entry.item);
    } else {
      groups.set(entry.agent.id, {
        agent: entry.agent,
        items: [entry.item],
      });
    }
  }
  return [...groups.values()];
}

export function exactGlobalAttentionCountAfterAgentChange(
  exactCount: number,
  previousAgentCount: number,
  nextAgentCount: number,
): number {
  return Math.max(0, exactCount + nextAgentCount - previousAgentCount);
}

export function globalAttentionAgentCountMap(
  counts: readonly LaunchGlobalAttentionAgentCount[],
): Map<string, LaunchGlobalAttentionAgentCount> {
  return new Map(counts.map((item) => [item.agent.id, item]));
}

export function appendGlobalAttentionPage(
  current: LaunchGlobalAttentionResponse,
  next: LaunchGlobalAttentionResponse,
): LaunchGlobalAttentionResponse {
  const entriesByNotificationId = new Map(
    current.entries.map((entry) => [entry.item.notificationId, entry]),
  );
  for (const entry of next.entries) {
    if (!entriesByNotificationId.has(entry.item.notificationId)) {
      entriesByNotificationId.set(entry.item.notificationId, entry);
    }
  }
  return {
    ...next,
    entries: [...entriesByNotificationId.values()],
  };
}
