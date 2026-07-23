export type OverviewConditionalSection = "alerts" | "interfaces" | "recentActivity";

export interface OverviewSectionBuckets {
  beforeIdentity: OverviewConditionalSection[];
  afterIdentity: OverviewConditionalSection[];
}

export function overviewSectionBuckets(input: {
  hasUnreadAlerts: boolean;
  hasFavoriteInterfaces: boolean;
  hasRecentActivity: boolean;
}): OverviewSectionBuckets {
  return {
    beforeIdentity: [
      ...(input.hasUnreadAlerts ? ["alerts" as const] : []),
      ...(input.hasFavoriteInterfaces ? ["interfaces" as const] : []),
    ],
    afterIdentity: input.hasRecentActivity ? ["recentActivity"] : [],
  };
}
