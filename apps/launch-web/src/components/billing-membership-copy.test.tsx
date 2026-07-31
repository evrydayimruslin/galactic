import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LaunchSubscriptionResponse } from "../../../../shared/contracts/launch.ts";
import { BillingSettings } from "./nebula-fleet";

function subscription(
  active: boolean,
): LaunchSubscriptionResponse {
  return {
    canManage: active,
    canSubscribe: !active,
    cancelAtPeriodEnd: false,
    capacity: {
      activeAgentLimit: null,
      generatedAt: "2026-07-30T00:00:00.000Z",
      nextEligibleAt: null,
      plan: "pro",
      state: "available",
      weekly: {
        resetsAt: "2026-08-03T00:00:00.000Z",
        state: "available",
        usedPercent: 0,
      },
    },
    currency: "usd",
    currentPeriodEnd: active ? "2026-08-30T00:00:00.000Z" : null,
    generatedAt: "2026-07-30T00:00:00.000Z",
    hasActiveSubscription: active,
    interval: "month",
    plan: "pro",
    planName: "Galactic membership",
    priceCents: 2_000,
    status: active ? "active" : "inactive",
  };
}

describe("membership funnel copy", () => {
  it("makes payment an unlock rather than an automatic deployment", () => {
    const markup = renderToStaticMarkup(
      <BillingSettings
        setError={vi.fn()}
        subscription={subscription(false)}
      />,
    );

    expect(markup).toContain("$20/month");
    expect(markup).toContain("Start membership — $20/month");
    expect(markup).toContain(
      "Membership unlocks deployment. Nothing is deployed until you confirm.",
    );
    expect(markup).not.toContain("upload or run Agents");
  });

  it("keeps post-payment deployment manual and setup paused", () => {
    const markup = renderToStaticMarkup(
      <BillingSettings
        setError={vi.fn()}
        subscription={subscription(true)}
      />,
    );

    expect(markup).toContain("Membership active.");
    expect(markup).toContain("Deployment stays manual");
    expect(markup).toContain("starts private");
    expect(markup).toContain("ongoing behavior paused");
  });
});
