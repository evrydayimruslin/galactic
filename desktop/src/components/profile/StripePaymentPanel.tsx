// StripePaymentPanel — mounts Stripe's Payment Element inside our
// AddLightModal so users complete Apple/Google Pay (and other available
// payment methods) without bouncing through a browser.
//
// We use Stripe's Payment Element rather than the older
// PaymentRequestButton because it auto-detects which methods the device
// actually supports (Apple Pay if the WKWebView is entitled, Google Pay
// on supported platforms, Link, and card as a universal fallback) and
// renders the right UI for each. One mount, every payment surface
// available on this machine.
//
// Caller passes the PaymentIntent details from the BE
// (`createWalletExpressIntent`) and gets a single `onComplete(piId)`
// callback when payment succeeds. Cancel / error states surface inline;
// the modal stays open so the user can retry without re-creating the
// intent.

import { useEffect, useRef, useState } from 'react';
import type { Stripe, StripeElements, StripePaymentElement } from '@stripe/stripe-js';
import { getStripe } from '../../lib/stripe';
import { formatLightPrecise as formatLight } from '../../lib/format';

interface StripePaymentPanelProps {
  publishableKey: string;
  clientSecret: string;
  /** Light amount the user is purchasing — surfaced in the panel header. */
  lightAmount: number;
  /** Dollar cost — surfaced beside the Light amount. */
  amountCents: number;
  /** Fires with the PaymentIntent id when payment succeeds. The BE webhook
   *  is the source of truth for crediting Light; this callback just flips
   *  the AddLightModal to its success state. */
  onComplete: (paymentIntentId: string) => void;
  /** Fires when the user backs out before paying. */
  onCancel: () => void;
}

type Phase = 'loading' | 'ready' | 'confirming' | 'error';

export default function StripePaymentPanel({
  publishableKey,
  clientSecret,
  lightAmount,
  amountCents,
  onComplete,
  onCancel,
}: StripePaymentPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const paymentElementRef = useRef<StripePaymentElement | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);

  // Mount sequence: load Stripe → create Elements with the client secret →
  // mount the Payment Element into our ref'd container. Cleanup unmounts
  // on dependency change so a re-mounted panel doesn't double-bind.
  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setError(null);

    getStripe(publishableKey)
      .then((stripe) => {
        if (cancelled) return;
        stripeRef.current = stripe;

        const elements = stripe.elements({
          clientSecret,
          appearance: {
            theme: 'stripe',
            variables: {
              // Match our token palette so the embedded form blends with
              // the rest of the modal rather than reading as a third-party
              // takeover.
              colorPrimary: '#0a0a0a',
              colorText: '#0a0a0a',
              colorTextSecondary: '#555555',
              colorTextPlaceholder: '#999999',
              colorBackground: '#ffffff',
              colorDanger: '#ef4444',
              borderRadius: '8px',
              fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            },
          },
        });
        elementsRef.current = elements;

        const paymentElement = elements.create('payment', {
          layout: 'tabs',
        });
        paymentElement.on('ready', () => {
          if (!cancelled) setPhase('ready');
        });
        paymentElement.on('loaderror', (e) => {
          if (cancelled) return;
          setError(e?.error?.message ?? 'Failed to load payment form.');
          setPhase('error');
        });

        if (containerRef.current) {
          paymentElement.mount(containerRef.current);
          paymentElementRef.current = paymentElement;
        }
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load Stripe.');
        setPhase('error');
      });

    return () => {
      cancelled = true;
      try {
        paymentElementRef.current?.unmount();
      } catch {
        // unmount can throw if the element is already gone — ignore
      }
      paymentElementRef.current = null;
      elementsRef.current = null;
    };
  }, [publishableKey, clientSecret]);

  const handleConfirm = async () => {
    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    if (!stripe || !elements) return;
    setPhase('confirming');
    setError(null);

    // We submit the Element to surface client-side validation errors
    // before hitting confirmPayment.
    const { error: submitError } = await elements.submit();
    if (submitError) {
      setError(submitError.message ?? 'Please check your payment details.');
      setPhase('ready');
      return;
    }

    // `redirect: 'if_required'` keeps the user inside the modal for
    // cards + wallets (which never need redirect) and only sends them
    // out for redirect-only methods (some EU bank transfers). For our
    // Apple/Google Pay scope, redirect is effectively never triggered.
    const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
      elements,
      clientSecret,
      confirmParams: {
        return_url: `${window.location.origin}/payment-return`,
      },
      redirect: 'if_required',
    });

    if (confirmError) {
      setError(confirmError.message ?? 'Payment failed.');
      setPhase('ready');
      return;
    }

    if (paymentIntent?.status === 'succeeded') {
      onComplete(paymentIntent.id);
      return;
    }

    if (paymentIntent?.status === 'processing') {
      // Some methods (e.g. ACH) settle async; the BE webhook will credit
      // Light when Stripe confirms. From the user's perspective, treat
      // this as "we got it" — the modal flips to success and the credit
      // lands shortly.
      onComplete(paymentIntent.id);
      return;
    }

    // requires_action / requires_payment_method / etc. — surface and
    // let the user try again with a different method.
    setError(
      `Payment didn't complete (status: ${paymentIntent?.status ?? 'unknown'}). Try again or pick a different method.`,
    );
    setPhase('ready');
  };

  return (
    <div className="flex flex-col">
      <div className="text-nano font-mono uppercase tracking-[0.1em] text-ul-text-muted mb-2">
        Wallet checkout
      </div>
      <div className="flex items-baseline gap-3 mb-5">
        <span className="text-h2 font-bold tracking-tight">
          ${(amountCents / 100).toFixed(2)}
        </span>
        <span className="text-caption text-ul-text-secondary">
          for <strong className="font-mono text-ul-text">✦{formatLight(lightAmount)}</strong>
        </span>
      </div>

      {phase === 'loading' && (
        <div className="text-caption text-ul-text-muted py-8 text-center">
          Loading payment options…
        </div>
      )}

      {/* The Payment Element mounts into this container regardless of
          phase so it can transition phase=loading → ready as Stripe
          finishes initialising. We just toggle its visibility. */}
      <div
        ref={containerRef}
        style={{ display: phase === 'ready' || phase === 'confirming' ? 'block' : 'none' }}
      />

      {error && (
        <div className="mt-4 px-3.5 py-2.5 border border-ul-error/30 bg-ul-error-soft rounded-md text-caption text-ul-error">
          {error}
        </div>
      )}

      <div className="flex gap-2 mt-5">
        <button
          type="button"
          onClick={onCancel}
          disabled={phase === 'confirming'}
          className="px-3.5 py-2.5 bg-ul-bg text-ul-text border border-ul-border rounded-md text-caption font-medium cursor-pointer hover:bg-ul-bg-hover disabled:opacity-60"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={phase !== 'ready'}
          className="flex-1 px-3.5 py-2.5 bg-ul-text text-white border-none rounded-md text-body font-medium cursor-pointer hover:bg-ul-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {phase === 'confirming'
            ? 'Confirming…'
            : phase === 'loading'
              ? 'Loading…'
              : `Pay $${(amountCents / 100).toFixed(2)}`}
        </button>
      </div>

      <div className="mt-3 text-nano font-mono text-ul-text-muted leading-relaxed">
        Powered by Stripe. Your card / wallet details never touch Ultralight servers.
      </div>
    </div>
  );
}
