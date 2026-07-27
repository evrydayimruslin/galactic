import { describe, expect, it, vi } from "vitest";

import { signOutToConnect } from "./sign-out-transition";

describe("signOutToConnect", () => {
  it("opens Connect before clearing the authenticated session", async () => {
    const sequence: string[] = [];
    const navigate = vi.fn(() => {
      sequence.push("navigate");
    });
    const signOut = vi.fn(async () => {
      sequence.push("sign-out");
    });

    await signOutToConnect(navigate, signOut);

    expect(sequence).toEqual(["navigate", "sign-out"]);
    expect(navigate).toHaveBeenCalledWith("/connect", {
      replace: true,
      scroll: "preserve",
    });
  });
});
