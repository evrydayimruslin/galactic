import { describe, expect, it } from "vitest";

import {
  dismissLaunchWorkspace,
  resolveLaunchNavigationTarget,
} from "./navigation";

describe("resolveLaunchNavigationTarget", () => {
  it("keeps query-only destinations on the current Agent route", () => {
    const target = resolveLaunchNavigationTarget(
      "?pane=routines&item=check_inbox",
      "https://connectgalactic.com/agents/email-ops?pane=overview",
    );

    expect(`${target.pathname}${target.search}`).toBe(
      "/agents/email-ops?pane=routines&item=check_inbox",
    );
  });

  it("still resolves root-relative and external destinations", () => {
    expect(
      resolveLaunchNavigationTarget(
        "/?panel=alerts",
        "https://connectgalactic.com/agents/email-ops",
      ).href,
    ).toBe("https://connectgalactic.com/?panel=alerts");
    expect(
      resolveLaunchNavigationTarget(
        "https://billing.example.test/session",
        "https://connectgalactic.com/agents/email-ops",
      ).href,
    ).toBe("https://billing.example.test/session");
  });

  it("dismisses focused workspaces by replacing their history entry", () => {
    const calls: Array<[string, { replace?: boolean } | undefined]> = [];
    const navigate = (
      to: string,
      options?: { replace?: boolean },
    ) => calls.push([to, options]);

    dismissLaunchWorkspace(navigate);
    dismissLaunchWorkspace(navigate, true);

    expect(calls).toEqual([
      ["/", { replace: true }],
      ["/?panel=alerts", { replace: true }],
    ]);
  });
});
