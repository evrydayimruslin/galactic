import {
  createContext,
  type FormEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import {
  buildLaunchSignInUrl,
  recordLaunchAuthDiagnostic,
  requestLaunchMagicLink,
} from "../lib/auth";
import { Wordmark } from "./launch-chrome";

type SignInModalView = "email" | "check_email";
type AuthenticationMethod = "email" | "google" | null;

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
  const [view, setView] = useState<SignInModalView>("email");
  const [authenticating, setAuthenticating] =
    useState<AuthenticationMethod>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleGoogle = () => {
    if (authenticating) return;
    setAuthenticating("google");
    setError("");
    recordLaunchAuthDiagnostic({
      nextPath: `${window.location.pathname}${window.location.search}`,
      status: "redirecting",
    });
    window.location.href = buildLaunchSignInUrl();
  };

  const handleEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (authenticating || view === "check_email") return;

    setAuthenticating("email");
    setError("");
    try {
      await requestLaunchMagicLink(email.trim());
      setView("check_email");
      setAuthenticating(null);
    } catch (err) {
      setAuthenticating(null);
      setError(
        err instanceof Error
          ? err.message
          : "Unable to authenticate. Please try again.",
      );
    }
  };

  const editEmail = () => {
    setView("email");
    setError("");
  };

  const isBusy = authenticating !== null;

  return (
    <div
      className="signin-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-label={view === "check_email"
          ? "Check your inbox"
          : "Sign in"}
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
          {view === "check_email"
            ? (
              <div className="signin-confirmation">
                <div className="signin-mail-icon" aria-hidden="true">
                  <MailIcon />
                </div>
                <div>
                  <h2 className="signin-heading">Check your inbox</h2>
                  <p>
                    We sent a one-time sign-in link to{" "}
                    <strong>{email}</strong>. It expires in one hour.
                  </p>
                  <p>
                    Open the email, then press the confirmation button to
                    continue to Galactic.
                  </p>
                </div>
                <button
                  className="signin-secondary"
                  onClick={editEmail}
                  type="button"
                >
                  Use another email
                </button>
              </div>
            )
            : (
              <>
                <div className="signin-intro">
                  <h2 className="signin-heading">
                    Sign in to Galactic
                  </h2>
                  <p>
                    Continue with Google or receive a one-time link by email.
                  </p>
                </div>

                <button
                  className="signin-google"
                  disabled={isBusy}
                  onClick={handleGoogle}
                  type="button"
                >
                  {authenticating === "google"
                    ? (
                      <>
                        <span
                          className="signin-spinner dark"
                          aria-hidden="true"
                        />
                        Opening Google…
                      </>
                    )
                    : (
                      <>
                        <GoogleG color="currentColor" />
                        Continue with Google
                      </>
                    )}
                </button>

                <div className="signin-divider">
                  <span>or</span>
                </div>

                <form className="signin-form" onSubmit={handleEmail}>
                  <label htmlFor="signin-email">Email</label>
                  <input
                    autoComplete="email"
                    autoFocus
                    disabled={isBusy}
                    id="signin-email"
                    inputMode="email"
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    required
                    type="email"
                    value={email}
                  />
                  {error
                    ? (
                      <p className="signin-error" role="alert">
                        {error}
                      </p>
                    )
                    : null}
                  <button
                    className="signin-submit"
                    disabled={isBusy}
                    type="submit"
                  >
                    {authenticating === "email"
                      ? (
                        <>
                          <span className="signin-spinner" aria-hidden="true" />
                          Sending link…
                        </>
                      )
                      : "Email me a sign-in link"}
                  </button>
                </form>

                <p className="signin-note">
                  By continuing, you agree to our <a href="/terms">Terms</a>{" "}
                  and <a href="/privacy">Privacy Policy</a>.
                </p>
              </>
            )}
        </div>
      </div>
    </div>
  );
}

function MailIcon(): ReactElement {
  return (
    <svg
      fill="none"
      height={22}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.7}
      viewBox="0 0 24 24"
      width={22}
    >
      <path d="M4 6h16v12H4z" />
      <path d="m4 7 8 6 8-6" />
    </svg>
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
