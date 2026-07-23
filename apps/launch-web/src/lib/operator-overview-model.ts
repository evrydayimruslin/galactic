import type {
  LaunchAgentHomeResponse,
  LaunchAgentAttentionItem,
  LaunchInterfaceSummary,
} from "../../../../shared/contracts/launch.ts";

export type OperatorOverviewSectionKind =
  | "attention"
  | "favorites"
  | "directive"
  | "activity"
  | "signals";

export interface OperatorOverviewModel {
  attention: LaunchAgentAttentionItem[];
  attentionCount: number;
  favoriteInterfaces: LaunchInterfaceSummary[];
  sectionOrder: OperatorOverviewSectionKind[];
  showActivity: boolean;
  showSignals: boolean;
}

function activityPopulated(home: LaunchAgentHomeResponse): boolean {
  const activity = home.activity;
  return Boolean(
    activity?.upNext ||
      activity?.now.length ||
      activity?.recent.length,
  );
}

function signalsPopulated(home: LaunchAgentHomeResponse): boolean {
  return Boolean(
    home.release.candidate ||
      home.capacity?.state === "low" ||
      home.capacity?.state === "waiting" ||
      home.agentCapacity?.state === "low" ||
      home.agentCapacity?.state === "waiting",
  );
}

/**
 * Canonical Overview ordering. Optional sections disappear when empty; the
 * Directive is the invariant anchor and is never displaced by placeholders.
 */
export function buildOperatorOverviewModel(
  home: LaunchAgentHomeResponse,
  interfaces: readonly LaunchInterfaceSummary[],
): OperatorOverviewModel {
  const attention = home.attention?.items ?? [];
  const attentionCount = home.attention?.openCount ?? attention.length;
  const byId = new Map(interfaces.map((item) => [item.id, item]));
  const favoriteInterfaces = (home.preferences?.favoriteInterfaceIds ?? [])
    .flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  const showActivity = activityPopulated(home);
  const showSignals = signalsPopulated(home);
  const sectionOrder: OperatorOverviewSectionKind[] = [];

  if (attentionCount > 0) {
    sectionOrder.push("attention");
  }
  if (favoriteInterfaces.length > 0) sectionOrder.push("favorites");
  sectionOrder.push("directive");
  if (showActivity) sectionOrder.push("activity");
  if (showSignals) sectionOrder.push("signals");

  return {
    attention,
    attentionCount,
    favoriteInterfaces,
    sectionOrder,
    showActivity,
    showSignals,
  };
}
