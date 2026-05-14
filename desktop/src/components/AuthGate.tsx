// Auth gate — Google OAuth via system browser.
// OAuth flow: opens system browser → user signs in with Google → desktop polls for token.

import { useState, useRef, useCallback, useEffect } from 'react';
import { setToken as storeToken, ensureApiBaseAvailable } from '../lib/storage';
import {
  buildDesktopLoginUrl,
  generateSessionSecret,
  openAuthUrl,
  sha256Hex,
  type DesktopOAuthOptions,
} from '../lib/auth';
import E3Mark from './ui/E3Mark';

interface AuthGateProps {
  onAuthenticated: () => void;
}

type AuthMode = 'choose' | 'oauth-polling';

export default function AuthGate({ onAuthenticated }: AuthGateProps) {
  const [mode, setMode] = useState<AuthMode>('choose');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionSecretRef = useRef<string>('');

  const storageErrorMessage = 'Unable to save your sign-in token securely on this device. Please try again.';

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  function formatStartOAuthError(error: unknown): string {
    const fallback = 'Unable to start Google sign-in. Please try again.';
    if (!(error instanceof Error) || !error.message) return fallback;

    if (import.meta.env.DEV) {
      return `Unable to start Google sign-in. ${error.message}`;
    }

    return fallback;
  }

  // ── Google OAuth flow ──
  const startOAuth = useCallback(async (options: DesktopOAuthOptions = {}) => {
    try {
      stopPolling();
      const sessionId = crypto.randomUUID();
      const sessionSecret = generateSessionSecret();
      const sessionSecretHash = await sha256Hex(sessionSecret);
      sessionSecretRef.current = sessionSecret;
      const base = await ensureApiBaseAvailable();
      const loginUrl = buildDesktopLoginUrl(
        base,
        sessionId,
        sessionSecretHash,
        options,
      );

      // Open system browser for Google OAuth
      await openAuthUrl(loginUrl);

      setMode('oauth-polling');
      setError('');
      setLoading(true);

      // Poll for token every 2 seconds, timeout after 5 minutes
      const startTime = Date.now();
      pollRef.current = setInterval(async () => {
        // Timeout after 5 minutes
        if (Date.now() - startTime > 5 * 60 * 1000) {
          stopPolling();
          sessionSecretRef.current = '';
          setLoading(false);
          setError('Sign-in timed out. Please try again.');
          setMode('choose');
          return;
        }

        try {
          const pollUrl = new URL(`${base}/auth/desktop-poll`);
          pollUrl.searchParams.set('session_id', sessionId);
          pollUrl.searchParams.set('session_secret', sessionSecretRef.current);
          const res = await fetch(pollUrl.toString());
          const data = await res.json();

          if (data.status === 'complete' && data.token) {
            stopPolling();
            sessionSecretRef.current = '';
            try {
              await storeToken(data.token);
              onAuthenticated();
            } catch {
              setLoading(false);
              setError(storageErrorMessage);
              setMode('choose');
            }
          }
        } catch {
          // Network error — keep polling
        }
      }, 2000);
    } catch (error) {
      console.error('[auth] Failed to start desktop OAuth', error);
      sessionSecretRef.current = '';
      setLoading(false);
      setMode('choose');
      setError(formatStartOAuthError(error));
    }
  }, [onAuthenticated, stopPolling]);

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  const cancelOAuth = useCallback(() => {
    stopPolling();
    sessionSecretRef.current = '';
    setLoading(false);
    setError('');
    setMode('choose');
  }, [stopPolling]);

  return (
    <div className="flex items-center justify-center h-full bg-white">
      <div className="w-full max-w-sm px-6">
        {/* Constellation lockup — same language as the onboarding welcome screen. */}
        <div className="text-center mb-10 flex flex-col items-center">
          <div className="inline-flex items-center gap-2 mb-3">
            <span className="inline-flex" style={{ marginTop: 3 }}>
              <E3Mark size={36} color="#0a0a0a" />
            </span>
            <span className="font-bold leading-none tracking-[-0.03em] text-ul-text" style={{ fontSize: 30 }}>
              Ultralight
            </span>
          </div>
          <p className="text-small text-ul-text-muted">
            {mode === 'oauth-polling'
              ? 'Complete sign-in in your browser'
              : 'Sign in to get started'}
          </p>
        </div>

        {/* ── Main sign-in options ── */}
        {mode === 'choose' && (
          <div className="space-y-3">
            <button
              onClick={() => void startOAuth()}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Sign in with Google
            </button>

            <button
              onClick={() => void startOAuth({ forceAccountSelection: true })}
              className="btn-secondary w-full"
            >
              Use another account
            </button>

            {error && <p className="text-small text-ul-error text-center">{error}</p>}
          </div>
        )}

        {/* ── OAuth polling state ── */}
        {mode === 'oauth-polling' && (
          <div className="text-center space-y-4">
            <div className="mx-auto w-8 h-8 border-2 border-ul-border border-t-ul-text rounded-full animate-spin" />
            <p className="text-small text-ul-text-secondary">
              Waiting for sign-in to complete in your browser...
            </p>
            {error && <p className="text-small text-ul-error">{error}</p>}
            <button
              onClick={() => void startOAuth()}
              className="btn-secondary w-full"
            >
              Open sign-in page again
            </button>
            <button
              onClick={cancelOAuth}
              className="text-small text-ul-text-muted underline cursor-pointer"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Help text */}
        {mode === 'choose' && (
          <p className="text-caption text-ul-text-muted text-center mt-6">
            We’ll open Google sign-in in your default browser and bring you back
            here once authentication completes.
          </p>
        )}
      </div>
    </div>
  );
}
