import { describe, expect, it } from "vitest";

import { reconcileCollapsibleRouteTarget } from "./collapsible-state";

describe("targeted collapsible state", () => {
  it("reopens a manually closed section when Back restores its target", () => {
    let open = reconcileCollapsibleRouteTarget(
      false,
      null,
      "release:2.4.0",
    );
    expect(open).toBe(true);

    // The operator may still close the section while remaining on this URL.
    open = false;
    expect(
      reconcileCollapsibleRouteTarget(
        open,
        "release:2.4.0",
        "release:2.4.0",
      ),
    ).toBe(false);

    // Forward navigation removes the target; Back reintroduces it.
    open = reconcileCollapsibleRouteTarget(open, "release:2.4.0", null);
    expect(open).toBe(false);
    open = reconcileCollapsibleRouteTarget(open, null, "release:2.4.0");
    expect(open).toBe(true);
  });

  it("reopens when history selects a different item in the same section", () => {
    expect(
      reconcileCollapsibleRouteTarget(
        false,
        "release:2.3.0",
        "release:2.4.0",
      ),
    ).toBe(true);
  });
});
