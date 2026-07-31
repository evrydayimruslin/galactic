import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SignInModal } from "./sign-in-modal";

describe("passwordless sign-in modal", () => {
  it("offers Google and a one-time email link without a password field", () => {
    const markup = renderToStaticMarkup(<SignInModal onClose={vi.fn()} />);

    expect(markup).toContain("Sign in to Galactic");
    expect(markup).toContain("Continue with Google");
    expect(markup).toContain("Email me a sign-in link");
    expect(markup).toContain('type="email"');
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain("Create an account");
  });
});
