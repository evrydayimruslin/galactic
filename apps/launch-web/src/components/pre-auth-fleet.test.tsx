import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LaunchNavigate } from "../lib/navigation";
import { PRE_AUTH_ADD_AGENT_HREF, PreAuthFleetHome } from "./pre-auth-fleet";
import { SignInModalProvider } from "./sign-in-modal";

describe("pre-auth fleet home", () => {
  it("is the blank member fleet with one planning slot and two examples", () => {
    const navigate = vi.fn() as LaunchNavigate;

    const markup = renderToStaticMarkup(
      <SignInModalProvider>
        <PreAuthFleetHome navigate={navigate} />
      </SignInModalProvider>,
    );

    expect(markup).toContain("No agents yet");
    expect(markup).toContain("You don&#x27;t need an account to plan one.");
    expect(markup).toContain("seven questions, all optional");
    expect(PRE_AUTH_ADD_AGENT_HREF).toBe(
      "/connect?intent=agent&source=fleet-card",
    );
    expect(markup).toContain(
      'href="/connect?intent=agent&amp;source=fleet-card"',
    );
    expect(markup.match(/aria-label="Example:/gu)).toHaveLength(2);
    expect(markup).toContain("Email Drafter Agent");
    expect(markup).toContain("Invoice Chaser Agent");
    expect(markup).toContain(">Sign in</button>");
    expect(markup).not.toContain("Search");
    expect(markup).not.toContain("Alerts");
    expect(markup).not.toContain("Settings");
  });
});
