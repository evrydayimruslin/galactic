// Stripe.js loader for wallet top-up checkout. The publishable key comes from
// the top-up intent response (the facade owns Stripe configuration), so the
// web bundle needs no Stripe env vars. loadStripe injects Stripe's hosted
// script once; we additionally memoize per key so repeated checkouts reuse the
// same Stripe instance.
import { loadStripe, type Stripe } from "@stripe/stripe-js";

const instances = new Map<string, Promise<Stripe | null>>();

export function getStripe(publishableKey: string): Promise<Stripe | null> {
  let instance = instances.get(publishableKey);
  if (!instance) {
    instance = loadStripe(publishableKey);
    // Evict on failure so a transient script-load error (ad blocker toggled
    // off, network blip) can actually be retried instead of replaying the
    // cached rejection forever.
    instance.catch(() => {
      if (instances.get(publishableKey) === instance) {
        instances.delete(publishableKey);
      }
    });
    instances.set(publishableKey, instance);
  }
  return instance;
}

export type { Stripe, StripeElements } from "@stripe/stripe-js";
