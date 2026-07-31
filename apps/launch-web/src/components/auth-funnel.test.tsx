import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LaunchNavigate } from "../lib/navigation";
import {
  AuthFunnelApp,
  authFunnelHref,
  authFunnelStepFromSearch,
  shouldAutoLoadCandidateReview,
} from "./auth-funnel";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth funnel", () => {
  it("resolves addressable phases without dropping unrelated funnel context", () => {
    const location = {
      pathname: "/connect",
      search:
        "?intent=agent&source=fleet-card&subscription=return&subscription_attempt=opaque",
    };
    expect(authFunnelStepFromSearch("?step=handoff")).toBe("handoff");
    expect(authFunnelStepFromSearch("?step=review")).toBe("review");
    expect(authFunnelStepFromSearch("?step=unknown")).toBe("plan");
    expect(authFunnelHref(location, "plan")).toBe(
      "/connect?intent=agent&source=fleet-card",
    );
    expect(authFunnelHref(location, "handoff")).toBe(
      "/connect?intent=agent&source=fleet-card&step=handoff",
    );
  });

  it("renders the complete all-optional planning ballot", () => {
    const markup = renderToStaticMarkup(
      <AuthFunnelApp
        location={{
          pathname: "/connect",
          search: "?intent=agent&source=fleet-card",
        }}
        navigate={vi.fn() as LaunchNavigate}
        signedIn={false}
      />,
    );

    expect(markup).toContain("Let&#x27;s plan your own agent");
    expect(markup).toContain("Seven rows, all optional");
    expect(markup).toContain("I know what to build");
    expect(markup).toContain("Wake on a schedule");
    expect(markup).toContain("Keep records");
    expect(markup).toContain("Show pages to humans");
    expect(markup).toContain("Take actions");
    expect(markup).toContain("Run heavier compute");
    expect(markup).toContain("Call AI on your key");
    expect(markup).toContain("Done — write my prompt");
    expect(markup).toContain('aria-expanded="true"');
  });

  it("uses passwordless account gating and never exposes a bearer in markup", () => {
    const markup = renderToStaticMarkup(
      <AuthFunnelApp
        location={{
          pathname: "/connect",
          search: "?intent=agent&step=handoff",
        }}
        navigate={vi.fn() as LaunchNavigate}
        signedIn={false}
      />,
    );

    expect(markup).toContain("Untitled Agent is planned. Hand it off.");
    expect(markup).toContain("Create your account");
    expect(markup).toContain("key completes the prompt");
    expect(markup).toContain("Still waiting");
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain("Password");
    expect(markup).not.toContain("gx_");
  });

  it("auto-loads review once and waits for a manual retry after errors", () => {
    const baseline = {
      error: "",
      hasResponse: false,
      loading: false,
      signedIn: true,
      step: "review" as const,
    };
    expect(shouldAutoLoadCandidateReview(baseline)).toBe(true);
    expect(shouldAutoLoadCandidateReview({
      ...baseline,
      error: "Candidate API unavailable",
    })).toBe(false);
    expect(shouldAutoLoadCandidateReview({
      ...baseline,
      loading: true,
    })).toBe(false);
    expect(shouldAutoLoadCandidateReview({
      ...baseline,
      hasResponse: true,
    })).toBe(false);
  });
});
