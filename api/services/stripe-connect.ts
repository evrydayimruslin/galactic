// Stripe Connect Service
// Handles Express account lifecycle, transfers, and payouts.
// All Stripe API calls use raw fetch — no SDK dependency.
// Gracefully handles missing API keys (throws 503 with descriptive message).
// Internal ledger is in Light (✦); Stripe boundary uses USD cents.

import { getEnv } from '../lib/env.ts';
import { LIGHT_PER_DOLLAR_PAYOUT } from '../../shared/types/index.ts';
import { lightToUsdCents as convertLightToUsdCents } from './billing-config.ts';

// ============================================
// TYPES
// ============================================

export interface ConnectAccountStatus {
  account_id: string | null;
  onboarded: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  charges_enabled?: boolean;
  country?: string;
  default_currency?: string;
  // E2 — verification state, outstanding onboarding requirements, and the
  // verified seller address (captured from the Connect account once submitted).
  verification_status?: string | null;
  requirements_currently_due?: string[];
  requirements_past_due?: string[];
  requirements_disabled_reason?: string | null;
  address?: ConnectAccountAddress | null;
}

export interface ConnectAccountAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

export interface PayoutEstimate {
  gross_light: number; // Light deducted from balance
  gross_usd_cents: number; // USD cents equivalent (light / 100 * 100)
  stripe_fee_cents: number; // estimated Stripe payout fee (in USD cents)
  fee_estimate_cents: number; // alias persisted on payout records
  net_cents: number; // estimated bank deposit (in USD cents)
}

export interface TransferResult {
  transfer_id: string;
  amount_cents: number;
  response: unknown;
}

export interface PayoutResult {
  payout_id: string;
  amount_cents: number;
  response: unknown;
}

export interface StripeRequestOptions {
  idempotencyKey?: string;
  metadata?: Record<string, string>;
}

export interface StripeBalanceSummary {
  available_cents: number;
  pending_cents: number;
}

export class StripeConnectRequestError extends Error {
  status: number;
  responseText: string;

  constructor(message: string, status: number, responseText: string) {
    super(message);
    this.name = 'StripeConnectRequestError';
    this.status = status;
    this.responseText = responseText;
  }
}

// ============================================
// CONSTANTS
// ============================================

// Stripe Express Standard payout fee: 0.25% + $0.25
export const PAYOUT_FEE_PERCENT = 0.0025;
export const PAYOUT_FEE_FIXED_CENTS = 25;

// Cross-border FX fee: 2% on transfers to non-USD connected accounts
export const CROSS_BORDER_FX_PERCENT = 0.02;

// ============================================
// HELPERS
// ============================================

function getStripeKey(): string {
  return getEnv('STRIPE_SECRET_KEY');
}

function ensureStripeKey(): string {
  const key = getStripeKey();
  if (!key) {
    throw Object.assign(
      new Error(
        'Stripe is not configured. Payouts will be available soon.',
      ),
      { status: 503 },
    );
  }
  return key;
}

/** Convert a Light amount to USD cents at the payout rate (100 Light/$1). */
export function lightToUsdCents(
  amountLight: number,
  lightPerUsd = LIGHT_PER_DOLLAR_PAYOUT,
): number {
  return convertLightToUsdCents(amountLight, lightPerUsd);
}

/**
 * Estimate the Stripe payout fee for a given withdrawal in Light.
 * Converts Light to USD at payout rate, then calculates Stripe fees in USD cents.
 * Cross-border payouts (non-US connected accounts) incur an additional 2% FX fee.
 */
export function estimatePayoutFee(
  amountLight: number,
  isCrossBorder = false,
  lightPerUsd = LIGHT_PER_DOLLAR_PAYOUT,
): PayoutEstimate {
  const grossCents = lightToUsdCents(amountLight, lightPerUsd);
  let feeCents = Math.ceil(
    grossCents * PAYOUT_FEE_PERCENT + PAYOUT_FEE_FIXED_CENTS,
  );
  if (isCrossBorder) {
    feeCents += Math.ceil(grossCents * CROSS_BORDER_FX_PERCENT);
  }
  return {
    gross_light: amountLight,
    gross_usd_cents: grossCents,
    stripe_fee_cents: feeCents,
    fee_estimate_cents: feeCents,
    net_cents: Math.max(0, grossCents - feeCents),
  };
}

// ============================================
// 1. CREATE CONNECTED ACCOUNT
// Creates a Stripe Express account with manual payout schedule.
// ============================================

export async function createConnectedAccount(
  email: string,
  userId: string,
  country: string = 'US',
): Promise<{ account_id: string }> {
  const STRIPE_KEY = ensureStripeKey();

  const res = await fetch('https://api.stripe.com/v1/accounts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'type': 'express',
      'country': country,
      'email': email,
      'capabilities[transfers][requested]': 'true',
      'metadata[user_id]': userId,
      'metadata[platform]': 'ultralight',
      'settings[payouts][schedule][interval]': 'manual',
    }).toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[CONNECT] Account creation failed:', err);
    throw new Error('Failed to create connected account');
  }

  const account = await res.json() as { id: string };
  return { account_id: account.id };
}

// ============================================
// 2. CREATE ONBOARDING LINK
// Generates a Stripe-hosted onboarding URL for the Express account.
// Developer completes KYC, links bank account, etc. on Stripe's UI.
// ============================================

export async function createOnboardingLink(
  accountId: string,
  returnUrl: string,
  refreshUrl: string,
): Promise<{ url: string; expires_at: number }> {
  const STRIPE_KEY = ensureStripeKey();

  const res = await fetch('https://api.stripe.com/v1/account_links', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'account': accountId,
      'type': 'account_onboarding',
      'return_url': returnUrl,
      'refresh_url': refreshUrl,
    }).toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[CONNECT] Onboarding link creation failed:', err);
    throw new Error('Failed to create onboarding link');
  }

  const link = await res.json() as { url: string; expires_at: number };
  return { url: link.url, expires_at: link.expires_at };
}

// ============================================
// 3. GET ACCOUNT STATUS
// Checks whether onboarding is complete and payouts are enabled.
// ============================================

export async function getAccountStatus(
  accountId: string,
): Promise<ConnectAccountStatus> {
  const STRIPE_KEY = ensureStripeKey();

  const res = await fetch(
    `https://api.stripe.com/v1/accounts/${encodeURIComponent(accountId)}`,
    {
      headers: { 'Authorization': `Bearer ${STRIPE_KEY}` },
    },
  );

  if (!res.ok) {
    const err = await res.text();
    console.error('[CONNECT] Account status check failed:', err);
    throw new Error('Failed to check account status');
  }

  const account = await res.json() as {
    id: string;
    details_submitted: boolean;
    charges_enabled: boolean;
    payouts_enabled: boolean;
    country: string;
    default_currency: string;
    requirements?: {
      currently_due?: string[] | null;
      past_due?: string[] | null;
      disabled_reason?: string | null;
    } | null;
    individual?: {
      address?: ConnectAccountAddress | null;
      verification?: { status?: string | null } | null;
    } | null;
    company?: {
      address?: ConnectAccountAddress | null;
      verification?: { status?: string | null } | null;
    } | null;
  };

  // Express/Custom accounts return `requirements`, `individual`, and `company`
  // on the account object by default (no expand needed). business_type decides
  // which of individual/company is populated.
  const party = account.individual ?? account.company ?? null;

  return {
    account_id: account.id,
    onboarded: account.details_submitted,
    payouts_enabled: account.payouts_enabled,
    details_submitted: account.details_submitted,
    charges_enabled: account.charges_enabled,
    country: account.country,
    default_currency: account.default_currency,
    verification_status: party?.verification?.status ?? null,
    requirements_currently_due: account.requirements?.currently_due ?? [],
    requirements_past_due: account.requirements?.past_due ?? [],
    requirements_disabled_reason: account.requirements?.disabled_reason ?? null,
    address: party?.address ?? null,
  };
}

// ============================================
// 4. CREATE TRANSFER
// Moves money from the platform Stripe balance to a connected account.
// Transfers are free — no Stripe fee.
// ============================================

export async function createTransfer(
  amountCents: number,
  accountId: string,
  metadata: Record<string, string> = {},
  options: StripeRequestOptions = {},
): Promise<TransferResult> {
  const STRIPE_KEY = ensureStripeKey();

  // Stripe transfers deal in integers (whole cents)
  const transferAmount = Math.round(amountCents);

  const params = new URLSearchParams({
    'amount': String(transferAmount),
    'currency': 'usd',
    'destination': accountId,
  });

  for (const [k, v] of Object.entries(metadata)) {
    params.set(`metadata[${k}]`, v);
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${STRIPE_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  const res = await fetch('https://api.stripe.com/v1/transfers', {
    method: 'POST',
    headers,
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[CONNECT] Transfer creation failed:', err);
    throw new StripeConnectRequestError(
      'Failed to create transfer to connected account',
      res.status,
      err,
    );
  }

  const transfer = await res.json() as { id: string; amount: number };
  return {
    transfer_id: transfer.id,
    amount_cents: transfer.amount,
    response: transfer,
  };
}

// ============================================
// 5. CREATE PAYOUT
// Triggers a payout from the connected account to their linked bank.
// Uses Stripe-Account header to act on behalf of the connected account.
// Stripe deducts its payout fee (0.25% + $0.25) from the amount.
// ============================================

export async function createPayout(
  amountCents: number,
  accountId: string,
  options: StripeRequestOptions = {},
): Promise<PayoutResult> {
  const STRIPE_KEY = ensureStripeKey();

  const payoutAmount = Math.round(amountCents);
  const params = new URLSearchParams({
    'amount': String(payoutAmount),
    'currency': 'usd',
  });
  for (const [k, v] of Object.entries(options.metadata || {})) {
    params.set(`metadata[${k}]`, v);
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${STRIPE_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Account': accountId,
  };
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  const res = await fetch('https://api.stripe.com/v1/payouts', {
    method: 'POST',
    headers,
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[CONNECT] Payout creation failed:', err);
    throw new StripeConnectRequestError(
      'Failed to create payout to bank account',
      res.status,
      err,
    );
  }

  const payout = await res.json() as { id: string; amount: number };
  return {
    payout_id: payout.id,
    amount_cents: payout.amount,
    response: payout,
  };
}

// ============================================
// 6. GET CONNECTED BALANCE
// Checks the available and pending balance in a connected account.
// ============================================

export async function getConnectedBalance(
  accountId: string,
): Promise<StripeBalanceSummary> {
  const STRIPE_KEY = ensureStripeKey();

  const res = await fetch('https://api.stripe.com/v1/balance', {
    headers: {
      'Authorization': `Bearer ${STRIPE_KEY}`,
      'Stripe-Account': accountId,
    },
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[CONNECT] Balance check failed:', err);
    throw new Error('Failed to check connected account balance');
  }

  const balance = await res.json() as {
    available: Array<{ amount: number; currency: string }>;
    pending: Array<{ amount: number; currency: string }>;
  };

  const usdAvailable = balance.available.find((b) => b.currency === 'usd');
  const usdPending = balance.pending.find((b) => b.currency === 'usd');

  return {
    available_cents: usdAvailable?.amount || 0,
    pending_cents: usdPending?.amount || 0,
  };
}

// ============================================
// 7. GET PLATFORM BALANCE
// Used by admin reconciliation to compare payout liabilities against
// platform-side Stripe funds available for transfers.
// ============================================

export async function getPlatformBalance(): Promise<StripeBalanceSummary> {
  const STRIPE_KEY = ensureStripeKey();

  const res = await fetch('https://api.stripe.com/v1/balance', {
    headers: {
      'Authorization': `Bearer ${STRIPE_KEY}`,
    },
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[CONNECT] Platform balance check failed:', err);
    throw new StripeConnectRequestError(
      'Failed to check platform Stripe balance',
      res.status,
      err,
    );
  }

  const balance = await res.json() as {
    available: Array<{ amount: number; currency: string }>;
    pending: Array<{ amount: number; currency: string }>;
  };

  const usdAvailable = balance.available.find((b) => b.currency === 'usd');
  const usdPending = balance.pending.find((b) => b.currency === 'usd');

  return {
    available_cents: usdAvailable?.amount || 0,
    pending_cents: usdPending?.amount || 0,
  };
}
