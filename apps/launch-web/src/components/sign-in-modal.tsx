import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import { buildLaunchSignInUrl, recordLaunchAuthDiagnostic } from "../lib/auth";
import { Wordmark } from "./launch-chrome";

type SignInModalView = "default" | "another";

const SignInModalContext = createContext<() => void>(() => {});

export function useSignInModal(): () => void {
  return useContext(SignInModalContext);
}

export function SignInModalProvider(
  { children }: { children: ReactNode },
): ReactElement {
  const [open, setOpen] = useState(false);
  const openModal = useCallback(() => setOpen(true), []);
  const closeModal = useCallback(() => setOpen(false), []);

  return (
    <SignInModalContext.Provider value={openModal}>
      {children}
      {open ? <SignInModal onClose={closeModal} /> : null}
    </SignInModalContext.Provider>
  );
}

function SignInModal({ onClose }: { onClose: () => void }): ReactElement {
  const [view, setView] = useState<SignInModalView>("default");
  const [authenticating, setAuthenticating] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleGoogle = () => {
    if (authenticating) return;
    setAuthenticating(true);
    recordLaunchAuthDiagnostic({
      nextPath: `${window.location.pathname}${window.location.search}`,
      status: "redirecting",
    });
    window.location.href = buildLaunchSignInUrl();
  };

  return (
    <div
      className="signin-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-label="Sign in"
        aria-modal="true"
        className="signin-modal"
        role="dialog"
      >
        <div className="signin-handle" aria-hidden="true">
          <span />
        </div>
        <button
          aria-label="Close sign-in"
          className="signin-close"
          onClick={onClose}
          type="button"
        >
          <CloseIcon />
        </button>
        <div className="signin-body">
          <Wordmark />
          {view === "another"
            ? <div className="signin-heading">Use another account</div>
            : null}
          <div className="signin-buttons">
            <button
              className={authenticating
                ? "signin-google authenticating"
                : "signin-google"}
              onClick={handleGoogle}
              type="button"
            >
              {authenticating
                ? (
                  <>
                    <span className="signin-spinner" aria-hidden="true" />
                    Opening Google…
                  </>
                )
                : (
                  <>
                    <GoogleG />
                    Sign in with Google
                  </>
                )}
            </button>
            {view === "another"
              ? (
                <button
                  className="signin-secondary back"
                  onClick={() => setView("default")}
                  type="button"
                >
                  ← Back
                </button>
              )
              : (
                <button
                  className="signin-secondary"
                  onClick={() => setView("another")}
                  type="button"
                >
                  Use another account
                </button>
              )}
          </div>
          <div className="signin-note">
            {authenticating
              ? "Complete sign-in in your browser."
              : "Sign in to use or deploy tools."}
          </div>
        </div>
      </div>
    </div>
  );
}

// Google "G" — white monochrome mark, matching the design AuthGate button.
function GoogleG({ size = 17, color = "#fff" }: {
  color?: string;
  size?: number;
}): ReactElement {
  return (
    <svg fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <path
        d="M21.6 12.2c0-.7-.06-1.35-.18-2H12v3.85h5.4a4.6 4.6 0 0 1-2 3v2.5h3.23c1.9-1.74 2.97-4.3 2.97-7.35z"
        fill={color}
        opacity="0.95"
      />
      <path
        d="M12 22c2.7 0 4.96-.9 6.62-2.43l-3.23-2.5c-.9.6-2.04.95-3.39.95-2.6 0-4.8-1.76-5.59-4.12H3.07v2.58A10 10 0 0 0 12 22z"
        fill={color}
        opacity="0.7"
      />
      <path
        d="M6.41 13.9a6 6 0 0 1 0-3.8V7.52H3.07a10 10 0 0 0 0 8.97l3.34-2.59z"
        fill={color}
        opacity="0.5"
      />
      <path
        d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.86-2.86C16.95 2.99 14.7 2 12 2A10 10 0 0 0 3.07 7.52l3.34 2.58C7.2 7.74 9.4 5.98 12 5.98z"
        fill={color}
        opacity="0.85"
      />
    </svg>
  );
}

function CloseIcon(): ReactElement {
  return (
    <svg
      fill="none"
      height={16}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
      width={16}
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
