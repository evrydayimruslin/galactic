// Deep link router — listens for `ultralight://...` URLs delivered by the
// Rust side (`src-tauri/src/lib.rs`) and routes them to in-app views.
//
// Supported schemes (v1):
//   ultralight://app/:id                → navigate to app store view
//   ultralight://app/:id?ref_claim=...  → navigate and redeem referral claim
//
// Future:
//   ultralight://chat/new?prompt=...    → open new chat
//   ultralight://agent/:id              → focus an agent
//
// Pending queue: deep links can fire BEFORE the auth gate has resolved
// (cold-start from a browser click while Ultralight wasn't running). We
// queue them until `ready === true`, then drain in arrival order.

import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { claimReferralToken } from '../lib/api';

/** Event emitted by Rust on every deep-link URL reception. */
const DEEP_LINK_EVENT = 'ul://deep-link';

export interface DeepLinkNavigator {
  navigateToToolDetail: (appId: string, appName?: string) => void;
}

/**
 * Parse an `ultralight://...` URL into a known in-app navigation intent.
 * Returns null for unknown / malformed URLs (caller should log & ignore).
 */
export function parseDeepLink(
  raw: string,
): { kind: 'tool-detail'; appId: string; referralClaimToken?: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'ultralight:') return null;

  // `ultralight://app/:id` parses as:
  //   protocol = "ultralight:"
  //   host     = "app"
  //   pathname = "/:id"
  if (parsed.host === 'app') {
    // Strip leading slash, take first segment only so `ultralight://app/xyz/?foo` works.
    const appId = parsed.pathname.replace(/^\//, '').split('/')[0];
    const referralClaimToken = parsed.searchParams.get('ref_claim') || undefined;
    if (appId) return { kind: 'tool-detail', appId, referralClaimToken };
  }

  return null;
}

/**
 * Subscribe to deep-link events and route them to the given navigator once
 * `ready` flips true. URLs received before ready are queued and drained
 * in order on the ready transition.
 *
 * @param nav   Navigator object with `navigateToToolDetail` (typically the
 *              result of `useAppState()`).
 * @param ready Gate that prevents routing during the pre-auth checking
 *              phase. Pass `authenticated && !checking` from App.tsx.
 */
export function useDeepLink(nav: DeepLinkNavigator, ready: boolean): void {
  // Ref so the listener always sees the latest ready state without re-subscribing.
  const readyRef = useRef(ready);
  const navRef = useRef(nav);
  const queueRef = useRef<string[]>([]);

  // Keep refs in sync with current props on every render
  readyRef.current = ready;
  navRef.current = nav;

  // Route a single URL to the appropriate view. No-op on unknown schemes.
  const route = (url: string) => {
    const intent = parseDeepLink(url);
    if (!intent) {
      console.warn('[deep-link] ignoring unknown URL:', url);
      return;
    }
    if (intent.kind === 'tool-detail') {
      navRef.current.navigateToToolDetail(intent.appId);
      if (intent.referralClaimToken) {
        claimReferralToken(intent.referralClaimToken).catch((err) => {
          console.warn('[deep-link] failed to claim referral:', err);
        });
      }
    }
  };

  // Single effect: subscribe on mount, unsubscribe on unmount. The
  // listener handles both queue-on-arrival (if not ready) and immediate
  // routing (if ready). Ready-transition draining is handled by a second
  // effect below.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    listen<string>(DEEP_LINK_EVENT, (event) => {
      const url = typeof event.payload === 'string' ? event.payload : '';
      if (!url) return;
      if (!readyRef.current) {
        queueRef.current.push(url);
        return;
      }
      route(url);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        console.warn('[deep-link] failed to subscribe:', err);
      });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
    // Intentional: empty deps. We subscribe once and use refs for latest values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drain any queued URLs when `ready` flips true. Arrival order preserved.
  useEffect(() => {
    if (!ready) return;
    if (queueRef.current.length === 0) return;
    const drained = queueRef.current.splice(0);
    for (const url of drained) {
      route(url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
}
