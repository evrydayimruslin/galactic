import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LaunchNavigate } from "../lib/navigation";
import {
  PRE_AUTH_ADD_AGENT_HREF,
  PRE_AUTH_FUNNEL_COMMAND,
  PreAuthFleetHome,
} from "./pre-auth-fleet";
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

  it("leads with the terminal golden path — command, price, no-account promise", () => {
    const navigate = vi.fn() as LaunchNavigate;

    const markup = renderToStaticMarkup(
      <SignInModalProvider>
        <PreAuthFleetHome navigate={navigate} />
      </SignInModalProvider>,
    );

    expect(PRE_AUTH_FUNNEL_COMMAND).toContain("npx galacticconnection new");
    expect(markup).toContain("npx galacticconnection new");
    expect(markup).toContain("$20/month when you deploy");
    expect(markup).toContain("free to plan and build");
    expect(markup).toContain("No account needed");
    expect(markup).toContain('aria-label="Copy the command"');
    // The hero joins the funnel; the browser plan stays the second door.
    expect(markup).toContain("seven questions, all optional");
  });
});
