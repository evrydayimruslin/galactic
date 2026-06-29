// Connect verification (Phase 1 trust identity) tests. Proves "verified" is
// STRICTER than payouts_enabled: an account that is nominally payable but has
// outstanding/overdue requirements or a disabled_reason is NOT verified, so the
// public badge never over-states.

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import {
  computeConnectVerified,
  verifiedFromStripeAccount,
} from "./connect-verification.ts";

Deno.test("connect-verify: payable + clean = verified", () => {
  assert(
    computeConnectVerified({
      payouts_enabled: true,
      currently_due: [],
      past_due: [],
      disabled_reason: null,
    }),
  );
});

Deno.test("connect-verify: payouts disabled = not verified", () => {
  assert(!computeConnectVerified({ payouts_enabled: false }));
  assert(!computeConnectVerified({ payouts_enabled: null }));
  assert(!computeConnectVerified({}));
});

Deno.test("connect-verify: payable but flagged = not verified", () => {
  // currently_due outstanding
  assert(
    !computeConnectVerified({
      payouts_enabled: true,
      currently_due: ["individual.id_number"],
    }),
  );
  // past_due
  assert(
    !computeConnectVerified({ payouts_enabled: true, past_due: ["external_account"] }),
  );
  // disabled_reason set
  assert(
    !computeConnectVerified({
      payouts_enabled: true,
      disabled_reason: "requirements.past_due",
    }),
  );
});

Deno.test("connect-verify: from raw Stripe account object", () => {
  assert(
    verifiedFromStripeAccount({
      payouts_enabled: true,
      requirements: { currently_due: [], past_due: [], disabled_reason: null },
    }),
  );
  assert(
    !verifiedFromStripeAccount({
      payouts_enabled: true,
      requirements: { currently_due: ["company.tax_id"], past_due: [], disabled_reason: null },
    }),
  );
  // Missing requirements object (payable, nothing flagged) => verified.
  assert(verifiedFromStripeAccount({ payouts_enabled: true }));
  assert(!verifiedFromStripeAccount({ payouts_enabled: false }));
});
