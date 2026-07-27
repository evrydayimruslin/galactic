import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

describe("AuthCallbackPage", () => {
  it("uses the Nebula refresh loader instead of a completion popup", async () => {
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      location: {
        origin: "https://connectgalactic.com",
      },
    });
    const { AuthCallbackPage } = await import("../App");
    const markup = renderToStaticMarkup(createElement(AuthCallbackPage, {
      location: {
        pathname: "/session/complete",
        search: "?next=%2Fconnect&session=refresh",
      },
    }));

    expect(markup).toContain("nebula-root");
    expect(markup).toContain("neb-fleet-loading");
    expect(markup).toContain("Refreshing session");
    expect(markup).toContain("Connect AI");
    expect(markup).not.toContain("Finishing sign in");
    expect(markup).not.toContain("auth-callback-panel");
    vi.unstubAllGlobals();
  });
});
