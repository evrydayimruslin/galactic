// Stripe.js loader — memoised per publishable key.
//
// `loadStripe` from `@stripe/stripe-js` fetches the actual Stripe.js
// bundle from js.stripe.com on first call and caches the resulting
// `Stripe` instance internally. We add a thin layer on top to:
//   • Memoise per publishable key (lets the BE rotate keys without us
//     reaching into the underlying SDK's internals).
//   • Surface the load failure as a Promise rejection callers can
//     branch on, rather than the SDK's null-Stripe-instance return.
//
// Used by StripePaymentPanel — and any future surface that needs Stripe
// (e.g. setup-intent flows for saved payment methods).

import { loadStripe, type Stripe } from '@stripe/stripe-js';

const cache = new Map<string, Promise<Stripe>>();

export async function getStripe(publishableKey: string): Promise<Stripe> {
  const existing = cache.get(publishableKey);
  if (existing) return existing;

  const promise = loadStripe(publishableKey).then((stripe) => {
    if (!stripe) {
      // Drop the cached Promise so a retry can happen on a fresh page.
      cache.delete(publishableKey);
      throw new Error('Stripe.js failed to load. Check your network connection.');
    }
    return stripe;
  });

  cache.set(publishableKey, promise);
  return promise;
}
