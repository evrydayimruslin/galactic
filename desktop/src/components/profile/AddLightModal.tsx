// AddLightModal — two-column "Order Summary Split" Add-Light flow.
//
// Ports `AddLightSplit` from handoff/mockups/add-light-flows.jsx, with
// the rates locked to the design's screenshot:
//
//   Earnings → Balance  →  100 ✦/$  (internal transfer, instant, 1:1)
//   Bank wire (ACH)     →   99 ✦/$  (clears in 1–3 business days)
//   Apple / Google Pay  →   95 ✦/$  (~2s — requires Stripe.js wallet UI)
//
// All three methods hit real BE today:
//   - convertEarningsToBalance → /api/user/earnings/convert-to-balance
//   - createWireTransferIntent → /api/user/wallet/wire-transfer-intent
//   - createWalletExpressIntent → /api/user/wallet/express-checkout-intent
//
// The Apple/Google Pay flow creates a real PaymentIntent on the BE but
// completing the wallet payment requires Stripe.js Elements, which
// isn't loaded today. The modal surfaces the PaymentIntent details +
// a clear pointer at the follow-up (DESIGN-FOLLOWUPS B15). Earnings +
// Wire flows are end-to-end functional.

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import Modal from '../ui/Modal';
import StripePaymentPanel from './StripePaymentPanel';
import {
  convertEarningsToBalance,
  createWalletExpressIntent,
  createWireTransferIntent,
  type UserEarnings,
  type UserHosting,
} from '../../lib/api';
import { formatLightWhole as formatLight } from '../../lib/format';

interface AddLightModalProps {
  hosting: UserHosting | null;
  earnings: UserEarnings | null;
  onClose: () => void;
  /** Called after a successful conversion / payment intent. Parent should
   *  refetch hosting + transactions + earnings. */
  onSuccess?: () => void;
}

type Method = 'earnings' | 'wire' | 'wallet';

interface MethodOption {
  id: Method;
  title: string;
  subtitle: string;
  badge: string;
  rate: number; // ✦ per $1 USD
  rateLabel: string;
}

// Per the mockup spec + screenshot.
const METHODS: MethodOption[] = [
  {
    id: 'earnings',
    title: 'Transfer from Earnings',
    subtitle: 'Ultralight-only · 1:1, no fees',
    badge: 'INSTANT',
    rate: 100,
    rateLabel: '✦100 per $1',
  },
  {
    id: 'wire',
    title: 'Bank wire (ACH)',
    subtitle: 'Clears in 1–3 business days',
    badge: '1–3D',
    rate: 99,
    rateLabel: '✦99 per $1',
  },
  {
    id: 'wallet',
    title: 'Apple Pay or Google Pay',
    subtitle: 'Charged to your default wallet',
    badge: '~2S',
    rate: 95,
    rateLabel: '✦95 per $1',
  },
];

const PRESET_USD = [10, 25, 100, 500];

// ── Helpers ──────────────────────────────────────────────────────────

function formatUSD(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}


// ── AddLightModal ────────────────────────────────────────────────────

export default function AddLightModal({ hosting, earnings, onClose, onSuccess }: AddLightModalProps) {
  const [amountUsd, setAmountUsd] = useState<number>(50);
  const [method, setMethod] = useState<Method>('wallet');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<null | {
    kind: 'earnings' | 'wire' | 'wallet';
    light: number;
    wireInstructions?: Record<string, unknown> | null;
    paymentIntentId?: string;
  }>(null);
  // Wallet checkout intermediate state — after the intent is created
  // but before the user has confirmed payment in the embedded Stripe
  // Payment Element. Cleared on success / back.
  const [checkout, setCheckout] = useState<null | {
    publishableKey: string;
    clientSecret: string;
    paymentIntentId: string;
    light: number;
    amountCents: number;
  }>(null);

  const methodOption = METHODS.find((m) => m.id === method)!;
  const amountCents = Math.max(0, Math.round(amountUsd * 100));
  const lightReceived = useMemo(
    () => Math.round((amountCents / 100) * methodOption.rate),
    [amountCents, methodOption.rate],
  );

  // Earnings cap — can't transfer more than available earnings (1:1).
  const earningsAvailableLight = earnings?.withdrawable_light ?? 0;
  const earningsAvailableUsd = earningsAvailableLight / 100; // 1:1 at 100 ✦/$
  const earningsCapExceeded = method === 'earnings' && lightReceived > earningsAvailableLight;

  const ctaLabel = (() => {
    if (submitting) return 'Processing…';
    if (method === 'earnings') return `Transfer ✦${formatLight(lightReceived)}`;
    if (method === 'wire') return `Continue to wire instructions`;
    return `Pay ${formatUSD(amountCents)}`;
  })();

  const onSubmit = async () => {
    if (submitting || amountCents <= 0 || earningsCapExceeded) return;
    setSubmitting(true);
    setError(null);
    try {
      if (method === 'earnings') {
        const result = await convertEarningsToBalance({
          amountLight: lightReceived,
          termsAccepted: true,
        });
        if (!result.ok) {
          setError(result.errorMessage || 'Conversion failed.');
          return;
        }
        setSuccess({ kind: 'earnings', light: result.converted_light ?? lightReceived });
        onSuccess?.();
        return;
      }
      if (method === 'wire') {
        const result = await createWireTransferIntent({
          amountCents,
          termsAccepted: true,
        });
        if (!result.ok) {
          setError(result.errorMessage || 'Failed to start wire transfer.');
          return;
        }
        setSuccess({
          kind: 'wire',
          light: result.light_amount ?? lightReceived,
          wireInstructions: result.bank_transfer_instructions ?? null,
          paymentIntentId: result.payment_intent_id,
        });
        onSuccess?.();
        return;
      }
      // wallet (Apple/Google Pay + card via Stripe Payment Element)
      const result = await createWalletExpressIntent({
        amountCents,
        termsAccepted: true,
      });
      if (!result.ok) {
        setError(result.errorMessage || 'Failed to start wallet checkout.');
        return;
      }
      if (!result.publishable_key || !result.client_secret || !result.payment_intent_id) {
        setError('Wallet checkout response is missing payment credentials.');
        return;
      }
      // Stash the intent details and let the StripePaymentPanel take
      // over rendering. Success state is set once the panel reports
      // the PaymentIntent reached `succeeded` / `processing`.
      setCheckout({
        publishableKey: result.publishable_key,
        clientSecret: result.client_secret,
        paymentIntentId: result.payment_intent_id,
        light: result.light_amount ?? lightReceived,
        amountCents,
      });
    } finally {
      setSubmitting(false);
    }
  };

  // Success state — clean confirmation
  if (success) {
    return (
      <Modal onClose={onClose} surface="plain" radius="xl" maxWidth="3xl" maxHeight="tall">
        <SuccessView
          state={success}
          method={methodOption}
          onClose={onClose}
        />
      </Modal>
    );
  }

  // Wallet checkout — Stripe Payment Element mounts here after the
  // PaymentIntent is created. Stays inside the same Modal chrome so
  // the user never feels like they've left Ultralight.
  if (checkout) {
    return (
      <Modal onClose={onClose} surface="plain" radius="xl" maxWidth="md" maxHeight="tall">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 rounded-full text-ul-text-muted hover:bg-ul-bg-hover flex items-center justify-center cursor-pointer z-10"
          title="Close"
        >
          <X className="w-4 h-4" strokeWidth={1.5} />
        </button>
        <div className="p-7">
          <StripePaymentPanel
            publishableKey={checkout.publishableKey}
            clientSecret={checkout.clientSecret}
            lightAmount={checkout.light}
            amountCents={checkout.amountCents}
            onComplete={(paymentIntentId) => {
              // The BE webhook actually credits Light; this just flips
              // the modal to the confirmation view so the user sees the
              // sale lock in. Balance will refresh on the parent's
              // onSuccess refetch.
              setCheckout(null);
              setSuccess({
                kind: 'wallet',
                light: checkout.light,
                paymentIntentId,
              });
              onSuccess?.();
            }}
            onCancel={() => setCheckout(null)}
          />
        </div>
      </Modal>
    );
  }

  // Main two-column form
  return (
    <Modal onClose={onClose} surface="plain" radius="xl" maxWidth="3xl" maxHeight="tall">
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 w-8 h-8 rounded-full text-ul-text-muted hover:bg-ul-bg-hover flex items-center justify-center cursor-pointer z-10"
        title="Close"
      >
        <X className="w-4 h-4" strokeWidth={1.5} />
      </button>
      <div className="flex-1 overflow-y-auto grid grid-cols-[1.4fr_1fr]">
        {/* LEFT — amount + chips + method picker */}
        <div className="p-6 border-r border-ul-border">
          <div className="text-h3 font-bold tracking-tight text-ul-text mb-1">
            Add Light to Balance
          </div>
          <div className="text-caption text-ul-text-secondary leading-relaxed mb-5">
            Enter what you'll pay; we'll show how much Light you receive at your method's rate.
          </div>

          {/* Amount input */}
          <div className="mb-3">
            <label className="text-micro font-mono text-ul-text-muted uppercase tracking-widest block mb-2">
              You pay
            </label>
            <div className="flex items-center gap-2 border border-ul-border rounded-md px-3.5 py-2.5 bg-ul-bg">
              <span className="text-h3 font-mono font-medium">$</span>
              <input
                type="number"
                value={amountUsd}
                onChange={(e) => setAmountUsd(Math.max(0, Number(e.target.value) || 0))}
                min={1}
                step={1}
                className="flex-1 border-none outline-none text-h3 font-mono font-bold tabular-nums bg-transparent"
              />
              <span className="text-caption text-ul-text-muted font-mono">USD</span>
            </div>
          </div>

          {/* Preset chips */}
          <div className="flex gap-1.5 mb-5">
            {PRESET_USD.map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => setAmountUsd(amt)}
                className={`px-2.5 py-1 rounded-sm text-caption font-medium border transition-colors ${
                  amountUsd === amt
                    ? 'border-ul-text bg-ul-bg-active text-ul-text'
                    : 'border-ul-border bg-ul-bg text-ul-text-secondary hover:bg-ul-bg-hover'
                }`}
              >
                ${amt}
              </button>
            ))}
          </div>

          {/* Method picker */}
          <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest mb-2">
            Pay with
          </div>
          <div className="flex flex-col gap-2">
            {METHODS.map((m) => {
              const selected = m.id === method;
              const disabled = m.id === 'earnings' && earningsAvailableLight === 0;
              return (
                <label
                  key={m.id}
                  className={`flex items-center gap-3 px-3.5 py-2.5 border rounded-md cursor-pointer transition-colors ${
                    selected ? 'border-ul-text bg-ul-bg-active' : 'border-ul-border bg-ul-bg hover:bg-ul-bg-hover'
                  } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <input
                    type="radio"
                    name="method"
                    checked={selected}
                    onChange={() => !disabled && setMethod(m.id)}
                    disabled={disabled}
                    className="cursor-pointer"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-caption font-semibold text-ul-text">{m.title}</span>
                      <span className="text-nano font-mono uppercase tracking-widest text-ul-text-muted bg-ul-bg-active px-1 py-px rounded-xs">
                        {m.badge}
                      </span>
                    </div>
                    <div className="text-nano text-ul-text-secondary">
                      {m.id === 'earnings'
                        ? `Available ✦${formatLight(earningsAvailableLight)} · Ultralight-only · 1:1, no fees`
                        : m.subtitle + ' · ' + m.rateLabel}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {/* RIGHT — order summary */}
        <div className="p-6 bg-ul-bg-raised flex flex-col">
          <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest mb-2.5">
            Order summary
          </div>
          <div className="flex items-baseline justify-between mb-2">
            <div className="text-body font-semibold">You pay</div>
            <div className="font-mono text-body tabular-nums">{formatUSD(amountCents)}</div>
          </div>
          <div className="flex items-baseline justify-between mb-3 text-caption">
            <div className="text-ul-text-muted">Rate · {methodOption.title}</div>
            <div className="font-mono text-ul-text-muted tabular-nums">+{methodOption.rate} per $1</div>
          </div>
          <div className="border-t border-ul-border my-2" />
          <div className="flex items-baseline justify-between mb-5">
            <div className="text-body font-semibold">You receive</div>
            <div className="font-mono text-h3 font-bold tabular-nums text-ul-text">
              ✦ {formatLight(lightReceived)}
            </div>
          </div>

          {earningsCapExceeded && (
            <div className="mb-3 px-3 py-2 border border-ul-error/30 bg-ul-error-soft rounded-md text-caption text-ul-error">
              Insufficient earnings · max ${earningsAvailableUsd.toFixed(2)}
            </div>
          )}

          {error && (
            <div className="mb-3 px-3 py-2 border border-ul-error/30 bg-ul-error-soft rounded-md text-caption text-ul-error">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting || amountCents <= 0 || earningsCapExceeded}
            className="bg-ul-text text-white border-none px-4 py-3 rounded-md text-body font-medium cursor-pointer hover:bg-ul-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {ctaLabel}
          </button>
          <div className="text-nano font-mono text-ul-text-muted mt-3 uppercase tracking-widest flex items-center gap-1.5">
            <span aria-hidden="true">🔒</span> Secure checkout · Powered by Stripe
          </div>
          <div className="text-nano text-ul-text-muted mt-3 leading-relaxed">
            No sales tax. Tax is collected only when Light is spent on individual tools.
          </div>

          {/* Current balance summary, helpful context */}
          {hosting?.balance_light !== undefined && (
            <div className="mt-auto pt-4 border-t border-ul-border text-nano font-mono text-ul-text-muted">
              Current balance ✦{formatLight(hosting.balance_light)}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Wire instructions ────────────────────────────────────────────────

// Whitelisted view over the BE-returned bank_transfer_instructions blob.
// The response type permits `[k: string]: unknown` extras, so a raw
// JSON.stringify could leak internal/test-only fields the BE didn't intend
// for the user. We render only the fields we know are safe to display,
// with human labels.
const WIRE_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'bank_name',      label: 'Bank name' },
  { key: 'account_number', label: 'Account number' },
  { key: 'routing_number', label: 'Routing number' },
  { key: 'swift_code',     label: 'SWIFT code' },
  { key: 'reference',      label: 'Reference (required)' },
];

function WireInstructionsTable({ instructions }: { instructions: Record<string, unknown> }) {
  const rows = WIRE_FIELDS
    .map((f) => ({ ...f, value: instructions[f.key] }))
    .filter((r) => typeof r.value === 'string' && r.value.length > 0);
  if (rows.length === 0) {
    return (
      <div className="text-caption text-ul-text-muted font-mono">
        Bank details unavailable — contact support.
      </div>
    );
  }
  return (
    <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1.5 m-0">
      {rows.map((r) => (
        <div key={r.key} className="contents">
          <dt className="text-nano font-mono text-ul-text-muted uppercase tracking-wider self-center">
            {r.label}
          </dt>
          <dd className="text-caption font-mono text-ul-text m-0 break-all">
            {String(r.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── Success view ─────────────────────────────────────────────────────

function SuccessView({
  state,
  method,
  onClose,
}: {
  state: { kind: 'earnings' | 'wire' | 'wallet'; light: number; wireInstructions?: Record<string, unknown> | null; paymentIntentId?: string };
  method: MethodOption;
  onClose: () => void;
}) {
  const isEarnings = state.kind === 'earnings';
  const isWire = state.kind === 'wire';
  const isWallet = state.kind === 'wallet';
  return (
    <div className="p-8">
      <div className="text-h2 font-bold tracking-tight text-ul-text mb-2">
        {isEarnings
          ? `Transferred ✦${formatLight(state.light)}`
          : isWire
            ? 'Wire transfer ready'
            : 'Almost there'}
      </div>
      <div className="text-small text-ul-text-secondary leading-relaxed mb-5 max-w-prose">
        {isEarnings && (
          <>Your earnings have been moved into your spendable Light balance. 1:1, no fees.</>
        )}
        {isWire && (
          <>
            Your purchase of <strong className="font-mono">✦{formatLight(state.light)}</strong> is
            reserved. Complete the wire from your bank using the instructions below. Light credits
            on receipt — usually 1–3 business days.
          </>
        )}
        {isWallet && (
          <>
            Your <strong className="font-mono">✦{formatLight(state.light)}</strong> purchase is
            confirmed. Stripe is settling the wallet charge — Light typically credits within seconds.
            The platform webhook handles the receipt; refresh your balance shortly to see it land.
          </>
        )}
      </div>

      {isWire && state.wireInstructions && (
        <div className="bg-ul-bg-raised border border-ul-border rounded-md p-4 mb-5 text-caption">
          <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest mb-2">
            Wire instructions
          </div>
          <WireInstructionsTable instructions={state.wireInstructions} />
        </div>
      )}

      {state.paymentIntentId && (
        <div className="text-nano font-mono text-ul-text-muted mb-5">
          PaymentIntent: {state.paymentIntentId}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onClose}
          className="bg-ul-text text-white border-none px-4 py-2.5 rounded-md text-caption font-medium cursor-pointer hover:bg-ul-accent-hover"
        >
          Done
        </button>
        <div className="text-nano text-ul-text-muted self-center ml-2">
          via {method.title} · {method.rateLabel}
        </div>
      </div>
    </div>
  );
}
