import { describe, expect, it } from "vitest";

import { overviewSectionBuckets } from "./overview-section-order";

describe("overviewSectionBuckets", () => {
  it("puts populated alerts and interfaces above identity and populated activity below it", () => {
    expect(overviewSectionBuckets({
      hasUnreadAlerts: true,
      hasFavoriteInterfaces: true,
      hasRecentActivity: true,
    })).toEqual({
      beforeIdentity: ["alerts", "interfaces"],
      afterIdentity: ["recentActivity"],
    });
  });

  it("omits every empty section", () => {
    expect(overviewSectionBuckets({
      hasUnreadAlerts: false,
      hasFavoriteInterfaces: false,
      hasRecentActivity: false,
    })).toEqual({
      beforeIdentity: [],
      afterIdentity: [],
    });
  });

  it("keeps populated content and omits empty peers", () => {
    expect(overviewSectionBuckets({
      hasUnreadAlerts: false,
      hasFavoriteInterfaces: true,
      hasRecentActivity: false,
    })).toEqual({
      beforeIdentity: ["interfaces"],
      afterIdentity: [],
    });
  });
});
