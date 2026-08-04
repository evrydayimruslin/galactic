import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LaunchNavigate } from "../lib/navigation";
import { resolveLaunchRoute } from "../lib/routes";
import { DeviceLoginPage, normalizeDeviceUserCode } from "./device-login";
import { SignInModalProvider } from "./sign-in-modal";

describe("device login page", () => {
  it("routes /device and normalizes user codes strictly", () => {
    expect(resolveLaunchRoute("/device").definition.key).toBe("device");
    expect(normalizeDeviceUserCode(" abcd-efgh ")).toBe("ABCD-EFGH");
    expect(normalizeDeviceUserCode("abcdefgh")).toBe("ABCD-EFGH");
    expect(normalizeDeviceUserCode("abc")).toBe(null);
    expect(normalizeDeviceUserCode("abcd-efg0")).toBe(null);
  });

  it("prefills the code but only ever approves on an explicit click", () => {
    const markup = renderToStaticMarkup(
      <SignInModalProvider>
        <DeviceLoginPage
          initialCode="ABCD-EFGH"
          navigate={vi.fn() as LaunchNavigate}
        />
      </SignInModalProvider>,
    );
    expect(markup).toContain('value="ABCD-EFGH"');
    expect(markup).toContain("Sign in to approve");
    expect(markup).toContain("the key itself never");
    expect(markup).not.toContain("Approved.");
  });
});
