import { type ReactElement, useState } from "react";

import { launchApi } from "../lib/api";
import { getLaunchAuthToken } from "../lib/auth";
import type { LaunchNavigate } from "../lib/navigation";
import { NebulaPublicShell } from "./nebula-fleet";
import { useSignInModal } from "./sign-in-modal";

import "./device-login.css";

const USER_CODE_RE = /^[A-Za-z2-9]{4}-?[A-Za-z2-9]{4}$/;

export function normalizeDeviceUserCode(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  if (!USER_CODE_RE.test(trimmed)) return null;
  const bare = trimmed.replace("-", "");
  return `${bare.slice(0, 4)}-${bare.slice(4)}`;
}

/**
 * WO-F4: /device — the human half of the device grant. The code may arrive
 * via ?code= for convenience, but approval is ALWAYS an explicit click
 * inside an authenticated session; nothing confirms from a URL alone.
 */
export function DeviceLoginPage({
  initialCode,
  navigate,
}: {
  initialCode?: string;
  navigate: LaunchNavigate;
}): ReactElement {
  const openSignIn = useSignInModal();
  const [code, setCode] = useState(initialCode ?? "");
  const [state, setState] = useState<
    "idle" | "busy" | "approved" | "error"
  >("idle");
  const [message, setMessage] = useState("");
  const signedIn = (() => {
    try {
      return Boolean(getLaunchAuthToken());
    } catch {
      return false;
    }
  })();

  const approve = async () => {
    const normalized = normalizeDeviceUserCode(code);
    if (!normalized) {
      setState("error");
      setMessage("Codes look like ABCD-EFGH.");
      return;
    }
    setState("busy");
    setMessage("");
    try {
      await launchApi.deviceApprove(normalized);
      setState("approved");
    } catch (cause) {
      setState("error");
      setMessage(
        cause instanceof Error ? cause.message : "The code was not accepted.",
      );
    }
  };

  return (
    <NebulaPublicShell>
      <header className="neb-topbar-shell">
        <div className="neb-topbar neb-preauth-topbar">
          <button
            className="neb-wordmark"
            onClick={() => navigate("/")}
            type="button"
          >
            galactic
          </button>
          {!signedIn
            ? (
              <button
                className="neb-preauth-signin"
                onClick={openSignIn}
                type="button"
              >
                Sign in
              </button>
            )
            : null}
        </div>
      </header>
      <main className="neb-app neb-device-app">
        <section aria-labelledby="device-heading" className="neb-device-panel">
          <p className="neb-funnel-eyebrow">Device login</p>
          <h1 id="device-heading">Link your terminal</h1>
          {state === "approved"
            ? (
              <p className="neb-device-lede">
                Approved. Return to your terminal — the key arrives there,
                and only there.
              </p>
            )
            : (
              <>
                <p className="neb-device-lede">
                  Your terminal showed a short code. Confirm it here and the
                  CLI receives a standard API key — the key itself never
                  appears in the browser.
                </p>
                <div className="neb-device-row">
                  <input
                    aria-label="Device code"
                    autoComplete="off"
                    maxLength={9}
                    onChange={(event) => setCode(event.currentTarget.value)}
                    placeholder="ABCD-EFGH"
                    spellCheck={false}
                    value={code}
                  />
                  {signedIn
                    ? (
                      <button
                        disabled={state === "busy"}
                        onClick={() => void approve()}
                        type="button"
                      >
                        {state === "busy" ? "Approving…" : "Approve"}
                      </button>
                    )
                    : (
                      <button onClick={openSignIn} type="button">
                        Sign in to approve
                      </button>
                    )}
                </div>
                {message
                  ? (
                    <p className="neb-device-error" role="alert">
                      {message}
                    </p>
                  )
                  : null}
              </>
            )}
        </section>
      </main>
    </NebulaPublicShell>
  );
}
