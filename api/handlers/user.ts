// User Settings Handler
// Handles user profile, BYOK configuration, and API token management

import { error, json } from "./response.ts";
import { authenticate } from "./auth.ts";
import { createUserService, type UserProfile } from "../services/user.ts";
import { validateAPIKey } from "../services/ai.ts";
import {
  type ActiveBYOKProvider,
  BYOK_PROVIDERS,
  type BYOKProviderInfo,
  COMBINED_FREE_TIER_BYTES,
  formatLight,
  isActiveBYOKProvider,
  type Tier,
} from "../../shared/types/index.ts";
import {
  createToken,
  listTokens,
  revokeAllTokens,
  revokeToken,
} from "../services/tokens.ts";
import { createAppsService } from "../services/apps.ts";
import { decryptEnvVar, encryptEnvVar } from "../services/envvars.ts";
import { unsuspendContent } from "../services/hosting-billing.ts";
import { getEnv } from "../lib/env.ts";
import {
  getSensitiveRouteClientKey,
  withSensitiveRouteRateLimit,
} from "../services/sensitive-route-rate-limit.ts";
import {
  buildAllowedPermissionSet,
  normalizeFunctionNamedRows,
  normalizePermissionNamedRows,
} from "../services/mcp-function-names.ts";
import { logLegacyPermissionNameCompatibility } from "../services/permission-name-telemetry.ts";
import { RequestValidationError } from "../services/request-validation.ts";
import {
  getDecryptedPlatformSupabase,
  getDecryptedSupabaseConfig,
  getSupabaseEnv,
  listSupabaseConfigs,
} from "../services/user-supabase-configs.ts";
export {
  getDecryptedPlatformSupabase,
  getDecryptedSupabaseConfig,
  listSupabaseConfigs,
} from "../services/user-supabase-configs.ts";
import {
  validateBillingAddressRequest,
  validateConnectOnboardRequest,
  validateEarningsAutoAddRequest,
  validateEarningsConversionRequest,
  validateHostingCheckoutRequest,
  validateSupabaseOauthConnectRequest,
  validateWalletFundingRequest,
  validateWireFundingRequest,
  validateWithdrawalRequest,
} from "../services/platform-request-validation.ts";
import {
  validateMarketplaceAskRequest,
  validateMarketplaceBidActionRequest,
  validateMarketplaceBidRequest,
  validateMarketplaceBuyRequest,
  validateMarketplaceMetricsVisibilityRequest,
} from "../services/marketplace-request-validation.ts";
import { createServerLogger } from "../services/logging.ts";
import { isValidModelId } from "../services/model-validation.ts";
import {
  getBillingConfig,
  usdCentsToLight,
} from "../services/billing-config.ts";
import {
  buildStripeDepositFailure,
  buildStripeDepositFinalization,
  buildStripeDepositPending,
  buildStripeDepositReversal,
  claimStripeEvent,
  finalizeLightDeposit,
  finishStripeEvent,
  markLightDepositFailed,
  recordLightDepositReversal,
  recordPendingLightDeposit,
  type StripeWebhookEvent,
} from "../services/stripe-deposits.ts";
import {
  createWalletExpressPaymentIntent,
  WalletFundingError,
} from "../services/stripe-wallet-funding.ts";
import {
  createWireTransferPaymentIntent,
  WireFundingError,
} from "../services/stripe-wire-funding.ts";
import {
  type BillingAddressInput,
  getCurrentBillingAddress,
  publicBillingAddress,
  updateStripeCustomerBillingAddress,
  upsertCurrentBillingAddress,
  type UserBillingAddressProfile,
} from "../services/billing-addresses.ts";

const stripeLogger = createServerLogger("STRIPE");
const userLogger = createServerLogger("USER");

type JsonRecord = Record<string, unknown>;
type UserProfileUpdates = Partial<
  Pick<
    UserProfile,
    "display_name" | "country" | "featured_app_id" | "profile_slug"
  >
>;

interface PublicProfileRow {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  country: string | null;
  tier: string;
  featured_app_id: string | null;
  created_at: string;
}

interface PublicProfileFeaturedAppRow {
  id: string;
  name: string;
  slug: string;
}

interface PublicProfileAcquisitionRow {
  sale_price_light: number;
  created_at: string;
  apps: {
    name?: string;
    slug?: string;
  } | null;
}

interface ConversationEmbeddingBody {
  conversationId?: string;
  conversationName?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

interface SystemAgentStatesBody {
  states?: unknown[];
}

interface CommandDashboardMetadataBody {
  dashboard_key?: unknown;
  title?: unknown;
  description?: unknown;
  icon?: unknown;
  sort_order?: unknown;
  is_default?: unknown;
  layout?: unknown;
}

interface UserProfilePatchBody {
  display_name?: string | null;
  country?: string | null;
  featured_app_id?: string | null;
}

interface ByokCreateBody {
  provider?: string;
  api_key?: string;
  model?: string;
  validate?: boolean;
}

interface ByokUpdateBody {
  api_key?: string;
  model?: string;
  validate?: boolean;
}

interface ByokPrimaryBody {
  provider?: string;
}

interface TokenCreateBody {
  name?: string;
  expires_in_days?: number;
  app_ids?: string[];
  function_names?: string[];
}

interface SupabaseConfigCreateBody {
  name?: string;
  url?: string;
  anon_key?: string;
  service_key?: string;
}

interface PermissionGrant {
  function_name: string;
  allowed: boolean;
  allowed_args?: Record<string, unknown> | null;
}

interface PermissionGrantBody {
  email?: string;
  user_id?: string;
  permissions?: PermissionGrant[];
}

type GrantedUserSummary = JsonRecord & {
  email: string | null;
  display_name: string | null;
  function_count: number;
  status?: string;
};

interface HostingBalanceRow {
  balance_light: number | null;
  escrow_light: number | null;
  deposit_balance_light: number | null;
  earned_balance_light: number | null;
  escrow_deposit_light: number | null;
  escrow_earned_light: number | null;
  hosting_last_billed_at: string | null;
  auto_add_earnings_to_balance: boolean | null;
  auto_topup_enabled: boolean | null;
  auto_topup_threshold_light: number | null;
  auto_topup_amount_light: number | null;
  auto_topup_last_failed_at: string | null;
  stripe_customer_id: string | null;
}

interface StripeCustomerRow {
  stripe_customer_id: string | null;
  email: string;
}

interface StripeConnectStatusRow {
  stripe_connect_account_id: string | null;
  stripe_connect_onboarded: boolean;
  stripe_connect_payouts_enabled: boolean;
  total_earned_light: number;
  earned_balance_light: number | null;
}

interface StripeConnectWithdrawRow extends StripeConnectStatusRow {
  balance_light: number;
  escrow_light: number;
}

interface EarningsBalanceRow {
  balance_light: number | null;
  deposit_balance_light: number | null;
  earned_balance_light: number | null;
  total_earned_light: number | null;
  auto_add_earnings_to_balance: boolean | null;
}

interface EarningsConversionRpcRow {
  conversion_id: string;
  converted_light: number;
  deposit_balance_light: number;
  earned_balance_light: number;
  balance_light: number;
}

async function readJsonBody<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function readJsonRows<T>(response: Response): Promise<T[]> {
  const payload = await readJsonResponse<unknown>(response);
  return Array.isArray(payload) ? payload as T[] : [];
}

async function readFirstJsonRow<T>(response: Response): Promise<T | null> {
  const [row] = await readJsonRows<T>(response);
  return row ?? null;
}

async function getOrCreateStripeCustomerForUser(
  userId: string,
  stripeSecretKey: string,
): Promise<{ stripeCustomerId: string; email: string | null }> {
  const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
    getSupabaseEnv();
  const userDataRes = await fetch(
    `${sbUrl}/rest/v1/users?id=eq.${userId}&select=stripe_customer_id,email`,
    {
      headers: {
        "apikey": sbKey,
        "Authorization": `Bearer ${sbKey}`,
      },
    },
  );
  if (!userDataRes.ok) throw new Error("Failed to read user");
  const userData = await readFirstJsonRow<StripeCustomerRow>(
    userDataRes,
  );
  let stripeCustomerId = userData?.stripe_customer_id || null;
  const email = userData?.email || null;

  if (stripeCustomerId) {
    return { stripeCustomerId, email };
  }

  const custRes = await fetch("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      "email": email || "",
      "metadata[user_id]": userId,
      "metadata[platform]": "ultralight",
    }).toString(),
  });

  if (!custRes.ok) {
    console.error(
      "[STRIPE] Customer creation failed:",
      await custRes.text(),
    );
    throw new Error("Failed to create payment profile");
  }

  const customer = await custRes.json() as { id: string };
  stripeCustomerId = customer.id;

  await fetch(
    `${sbUrl}/rest/v1/users?id=eq.${userId}`,
    {
      method: "PATCH",
      headers: {
        "apikey": sbKey,
        "Authorization": `Bearer ${sbKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({ stripe_customer_id: stripeCustomerId }),
    },
  );

  return { stripeCustomerId, email };
}

async function ensureBillingAddressForFunding(input: {
  userId: string;
  billingAddress?: BillingAddressInput;
  source: "wallet_funding" | "wire_funding";
  stripeSecretKey: string;
  stripeCustomerId: string;
}): Promise<UserBillingAddressProfile> {
  const profile = input.billingAddress
    ? await upsertCurrentBillingAddress({
      userId: input.userId,
      address: input.billingAddress,
      source: input.source,
      stripeCustomerId: input.stripeCustomerId,
    })
    : await getCurrentBillingAddress(input.userId);

  if (!profile) {
    throw new RequestValidationError(
      "billing_address is required before adding Light",
      400,
    );
  }

  try {
    await updateStripeCustomerBillingAddress({
      stripeSecretKey: input.stripeSecretKey,
      stripeCustomerId: input.stripeCustomerId,
      profile,
    });
  } catch (err) {
    stripeLogger.warn("Failed to sync billing address to Stripe customer", {
      user_id: input.userId,
      stripe_customer_id: input.stripeCustomerId,
      error: err,
    });
  }

  return profile;
}

function isTier(value: unknown): value is Tier {
  return value === "free" ||
    value === "fun" ||
    value === "pro" ||
    value === "scale" ||
    value === "enterprise";
}

function toTier(value: unknown): Tier {
  return isTier(value) ? value : "free";
}

function getByokProviderEntry(
  value: unknown,
): { provider: ActiveBYOKProvider; info: BYOKProviderInfo } | null {
  if (!isActiveBYOKProvider(value)) {
    return null;
  }

  const info = BYOK_PROVIDERS[value];
  return { provider: value, info };
}

function normalizeOptionalModel(value: unknown): string | undefined | Response {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    return error("model must be a string", 400);
  }
  if (!isValidModelId(value)) {
    return error(
      `Invalid model ID format: ${value}. Expected a provider-native model ID`,
      400,
    );
  }
  return value;
}

function getFnIndexBinding(): KVNamespace | null {
  return globalThis.__env?.FN_INDEX ?? null;
}

export async function handleUser(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ============================================
  // UNAUTHENTICATED ROUTES (webhooks)
  // ============================================

  // POST /api/webhooks/stripe — handle Stripe webhook events
  // Verified by webhook signature, no auth token needed.
  // Idempotent: deduplicates by Stripe event ID in the durable Stripe event ledger.
  if (path === "/api/webhooks/stripe" && method === "POST") {
    try {
      const STRIPE_WEBHOOK_SECRET = getEnv("STRIPE_WEBHOOK_SECRET");

      if (!STRIPE_WEBHOOK_SECRET) {
        return error("Stripe webhooks not configured", 503);
      }

      const rawBody = await request.text();
      const signature = request.headers.get("stripe-signature") || "";

      // Verify webhook signature
      const verified = await verifyStripeSignature(
        rawBody,
        signature,
        STRIPE_WEBHOOK_SECRET,
      );
      if (!verified) {
        return error("Invalid webhook signature", 400);
      }

      const event = JSON.parse(rawBody) as StripeWebhookEvent;
      const claim = await claimStripeEvent(event);
      if (!claim.claimed) {
        stripeLogger.info("Skipping already claimed Stripe webhook event", {
          event_id: event.id,
          event_type: event.type,
          status: claim.status,
          process_attempts: claim.processAttempts,
        });
        return json({
          received: true,
          duplicate: true,
          status: claim.status,
        });
      }

      let handled = false;
      try {
        const pendingDeposit = buildStripeDepositPending(event);
        if (pendingDeposit) {
          await recordPendingLightDeposit(pendingDeposit);
          handled = true;
          stripeLogger.info("Recorded pending Light deposit", {
            event_id: event.id,
            event_type: event.type,
            user_id: pendingDeposit.userId,
            amount_cents: pendingDeposit.requestedAmountCents,
            funding_method: pendingDeposit.fundingMethod,
          });
        }

        const finalDeposit = buildStripeDepositFinalization(event);
        if (finalDeposit) {
          const result = await finalizeLightDeposit(finalDeposit);
          handled = true;
          if (
            (result.creditedLight || 0) > 0 &&
            (result.previousBalanceLight || 0) <= 0
          ) {
            await unsuspendContent(finalDeposit.userId);
          }
          stripeLogger.info("Finalized Light deposit", {
            event_id: event.id,
            event_type: event.type,
            user_id: finalDeposit.userId,
            amount_cents: finalDeposit.amountCents,
            amount_light: result.creditedLight || 0,
            funding_method: finalDeposit.fundingMethod,
            status: result.status,
            already_finalized: result.alreadyFinalized || false,
          });
        }

        const failedDeposit = buildStripeDepositFailure(event);
        if (failedDeposit) {
          await markLightDepositFailed(failedDeposit);
          handled = true;
          stripeLogger.warn("Marked Light deposit failed", {
            event_id: event.id,
            event_type: event.type,
            user_id: failedDeposit.userId || null,
            funding_method: failedDeposit.fundingMethod,
            failure_code: failedDeposit.failureCode || null,
          });
        }

        const reversal = buildStripeDepositReversal(event);
        if (reversal) {
          const result = await recordLightDepositReversal(reversal);
          handled = true;
          stripeLogger.warn("Recorded Light deposit reversal", {
            event_id: event.id,
            event_type: event.type,
            reason: reversal.reason,
            amount_cents: reversal.amountCents,
            recovered_light: result?.recoveredLight || 0,
            unrecovered_light: result?.unrecoveredLight || 0,
          });
        }

        // Handle account.updated (Connect onboarding status changes)
        if (event.type === "account.updated") {
          const account = event.data.object as {
            id: string;
            details_submitted?: boolean;
            payouts_enabled?: boolean;
          };

          if (account.id) {
            const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } =
              getSupabaseEnv();
            await fetch(
              `${SUPABASE_URL}/rest/v1/users?stripe_connect_account_id=eq.${account.id}`,
              {
                method: "PATCH",
                headers: {
                  "apikey": SUPABASE_SERVICE_ROLE_KEY,
                  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                  "Content-Type": "application/json",
                  "Prefer": "return=minimal",
                },
                body: JSON.stringify({
                  stripe_connect_onboarded: account.details_submitted || false,
                  stripe_connect_payouts_enabled: account.payouts_enabled ||
                    false,
                }),
              },
            );
            handled = true;
            stripeLogger.info("Updated Stripe Connect account state", {
              event_id: event.id,
              account_id: account.id,
              payouts_enabled: account.payouts_enabled || false,
              details_submitted: account.details_submitted || false,
            });
          }
        }

        // Handle payout.paid (money arrived in developer's bank)
        if (event.type === "payout.paid") {
          const payout = event.data.object as { id: string };
          const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
          await fetch(
            `${SUPABASE_URL}/rest/v1/payouts?stripe_payout_id=eq.${payout.id}`,
            {
              method: "PATCH",
              headers: {
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
              },
              body: JSON.stringify({
                status: "paid",
                completed_at: new Date().toISOString(),
                stripe_payout_status: "succeeded",
                stripe_payout_completed_at: new Date().toISOString(),
                processor_claimed_at: null,
              }),
            },
          );
          handled = true;
          stripeLogger.info("Marked payout as paid", {
            event_id: event.id,
            payout_id: payout.id,
          });
        }

        // Handle payout.failed (payout to bank failed — refund balance)
        if (event.type === "payout.failed") {
          const payout = event.data.object as {
            id: string;
            failure_message?: string;
          };
          const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
          const sbHeaders = {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          };

          // Find the payout record by stripe_payout_id
          const payoutRes = await fetch(
            `${SUPABASE_URL}/rest/v1/payouts?stripe_payout_id=eq.${payout.id}&status=eq.processing&select=id`,
            { headers: sbHeaders },
          );
          if (payoutRes.ok) {
            const payoutRows = await payoutRes.json() as Array<{ id: string }>;
            for (const p of payoutRows) {
              await fetch(`${SUPABASE_URL}/rest/v1/rpc/fail_payout_refund`, {
                method: "POST",
                headers: { ...sbHeaders, "Content-Type": "application/json" },
                body: JSON.stringify({
                  p_payout_id: p.id,
                  p_failure_reason: payout.failure_message || "payout_failed",
                }),
              });
            }
          }
          handled = true;
          stripeLogger.warn("Processed failed payout refund path", {
            event_id: event.id,
            payout_id: payout.id,
            failure_message: payout.failure_message || "unknown reason",
          });
        }

        // Handle transfer.reversed (transfer from platform to connected account reversed)
        if (event.type === "transfer.reversed") {
          const transfer = event.data.object as { id: string };
          const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
          const sbHeaders = {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          };

          // Find payout record by transfer ID and refund
          const payoutRes = await fetch(
            `${SUPABASE_URL}/rest/v1/payouts?stripe_transfer_id=eq.${transfer.id}&status=in.(pending,processing)&select=id`,
            { headers: sbHeaders },
          );
          if (payoutRes.ok) {
            const payoutRows = await payoutRes.json() as Array<{ id: string }>;
            for (const p of payoutRows) {
              await fetch(`${SUPABASE_URL}/rest/v1/rpc/fail_payout_refund`, {
                method: "POST",
                headers: { ...sbHeaders, "Content-Type": "application/json" },
                body: JSON.stringify({
                  p_payout_id: p.id,
                  p_failure_reason: "transfer_reversed",
                }),
              });
            }
          }
          handled = true;
          stripeLogger.warn("Processed transfer reversal", {
            event_id: event.id,
            transfer_id: transfer.id,
          });
        }

        await finishStripeEvent(event.id, handled ? "processed" : "ignored", {
          event_type: event.type,
          handled,
        });
      } catch (processingErr) {
        await finishStripeEvent(
          event.id,
          "failed",
          { event_type: event.type },
          processingErr instanceof Error
            ? processingErr.message
            : "Unknown Stripe webhook processing error",
        );
        throw processingErr;
      }

      return json({ received: true });
    } catch (err) {
      stripeLogger.error("Webhook processing failed", { error: err });
      return error("Webhook processing failed", 500);
    }
  }

  // ============================================
  // SUPABASE OAUTH CALLBACK (unauthenticated — redirect from Supabase)
  // Auth is validated via stored state → user_id mapping
  // ============================================
  if (path === "/api/user/supabase/oauth/callback" && method === "GET") {
    return withSensitiveRouteRateLimit(
      getSensitiveRouteClientKey(request),
      "user:supabase_oauth_callback",
      async () => {
        try {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const errorParam = url.searchParams.get("error");

          if (errorParam) {
            const desc = url.searchParams.get("error_description") ||
              errorParam;
            return new Response(getOAuthCallbackHtml(false, desc), {
              headers: { "Content-Type": "text/html" },
            });
          }

          if (!code || !state) {
            return new Response(
              getOAuthCallbackHtml(false, "Missing code or state"),
              {
                headers: { "Content-Type": "text/html" },
              },
            );
          }

          // Look up stored state
          const { SUPABASE_URL: SB_URL, SUPABASE_SERVICE_ROLE_KEY: SB_KEY } =
            getSupabaseEnv();
          const stateRes = await fetch(
            `${SB_URL}/rest/v1/supabase_oauth_state?state=eq.${state}&select=user_id,code_verifier`,
            {
              headers: {
                "apikey": SB_KEY,
                "Authorization": `Bearer ${SB_KEY}`,
              },
            },
          );
          const stateRows = await stateRes.json();
          if (!Array.isArray(stateRows) || stateRows.length === 0) {
            return new Response(
              getOAuthCallbackHtml(false, "Invalid or expired state"),
              {
                headers: { "Content-Type": "text/html" },
              },
            );
          }

          const { user_id: oauthUserId, code_verifier: codeVerifier } =
            stateRows[0];

          // Clean up state row
          await fetch(
            `${SB_URL}/rest/v1/supabase_oauth_state?state=eq.${state}`,
            {
              method: "DELETE",
              headers: {
                "apikey": SB_KEY,
                "Authorization": `Bearer ${SB_KEY}`,
              },
            },
          );

          // Exchange code for tokens
          const clientId = getEnv("SUPABASE_MGMT_OAUTH_CLIENT_ID");
          const clientSecret = getEnv("SUPABASE_MGMT_OAUTH_CLIENT_SECRET");
          const baseUrl = `${url.protocol}//${url.host}`;
          const redirectUri = `${baseUrl}/api/user/supabase/oauth/callback`;

          const tokenRes = await fetch(
            "https://api.supabase.com/v1/oauth/token",
            {
              method: "POST",
              headers: {
                "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`),
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code: code,
                redirect_uri: redirectUri,
                code_verifier: codeVerifier,
              }).toString(),
            },
          );

          if (!tokenRes.ok) {
            const errText = await tokenRes.text();
            console.error("Supabase token exchange failed:", errText);
            return new Response(
              getOAuthCallbackHtml(false, "Token exchange failed"),
              {
                headers: { "Content-Type": "text/html" },
              },
            );
          }

          const tokens = await tokenRes.json() as {
            access_token: string;
            refresh_token: string;
            expires_in: number;
            token_type: string;
          };

          // Encrypt and store tokens
          const encAccessToken = await encryptEnvVar(tokens.access_token);
          const encRefreshToken = await encryptEnvVar(tokens.refresh_token);
          const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
            .toISOString();

          // Upsert (unique on user_id)
          await fetch(`${SB_URL}/rest/v1/user_supabase_oauth`, {
            method: "POST",
            headers: {
              "apikey": SB_KEY,
              "Authorization": `Bearer ${SB_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "resolution=merge-duplicates",
            },
            body: JSON.stringify({
              user_id: oauthUserId,
              access_token_encrypted: encAccessToken,
              refresh_token_encrypted: encRefreshToken,
              token_expires_at: expiresAt,
              updated_at: new Date().toISOString(),
            }),
          });

          return new Response(getOAuthCallbackHtml(true, ""), {
            headers: { "Content-Type": "text/html" },
          });
        } catch (err) {
          console.error("Supabase OAuth callback error:", err);
          return new Response(getOAuthCallbackHtml(false, "Internal error"), {
            headers: { "Content-Type": "text/html" },
          });
        }
      },
    );
  }

  // ============================================
  // PUBLIC PROFILE
  // ============================================

  // GET /api/user/profile/:slug — Public user profile data
  const profileMatch = path.match(/^\/api\/user\/profile\/([a-z0-9_-]+)$/);
  if (profileMatch && method === "GET") {
    const slug = profileMatch[1];
    try {
      const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
        getSupabaseEnv();
      const headers = { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` };

      // Look up user by profile_slug or by UUID
      const isUuid =
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          slug,
        );
      const userFilter = isUuid ? `id=eq.${slug}` : `profile_slug=eq.${slug}`;
      const userRes = await fetch(
        `${sbUrl}/rest/v1/users?${userFilter}&select=id,display_name,avatar_url,country,tier,featured_app_id,created_at`,
        { headers },
      );
      if (!userRes.ok) return error("Failed to fetch profile", 500);
      const users = await readJsonRows<PublicProfileRow>(userRes);
      if (!users.length) return error("Profile not found", 404);
      const profile = users[0];

      // Fetch stats, published apps, and acquisitions in parallel
      const [statsRes, publishedRes, acquisitionsRes, featuredRes] =
        await Promise.all([
          fetch(`${sbUrl}/rest/v1/rpc/get_user_profile_stats`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ p_user_id: profile.id }),
          }),
          fetch(
            `${sbUrl}/rest/v1/apps?owner_id=eq.${profile.id}&visibility=eq.public&deleted_at=is.null` +
              `&select=id,name,slug,description,runs_30d,current_version,first_published_at` +
              `&order=runs_30d.desc&limit=50`,
            { headers },
          ),
          fetch(
            `${sbUrl}/rest/v1/app_sales?buyer_id=eq.${profile.id}&select=id,sale_price_light,created_at,apps(name,slug)` +
              `&order=created_at.desc&limit=50`,
            { headers },
          ),
          profile.featured_app_id
            ? fetch(
              `${sbUrl}/rest/v1/apps?id=eq.${profile.featured_app_id}&select=id,name,slug`,
              { headers },
            )
            : Promise.resolve(null),
        ]);

      const stats = statsRes.ok
        ? await readJsonResponse<
          {
            lifetime_gross_light: number;
            published_count: number;
            acquired_count: number;
          }
        >(statsRes)
        : { lifetime_gross_light: 0, published_count: 0, acquired_count: 0 };
      const published = publishedRes.ok
        ? await readJsonRows<{
          id: string;
          name: string;
          slug: string;
          description: string | null;
          runs_30d: number;
          current_version: string;
          first_published_at: string | null;
        }>(publishedRes)
        : [];
      const acquisitionsRaw = acquisitionsRes.ok
        ? await readJsonRows<PublicProfileAcquisitionRow>(acquisitionsRes)
        : [];
      let featuredApp = null;
      if (featuredRes && featuredRes.ok) {
        const fa = await readJsonRows<PublicProfileFeaturedAppRow>(featuredRes);
        if (fa.length) {
          featuredApp = { id: fa[0].id, name: fa[0].name, slug: fa[0].slug };
        }
      }

      const acquisitions = acquisitionsRaw.map((a) => {
        const app = a.apps;
        return {
          app_name: app?.name || "Unknown",
          app_slug: app?.slug || "",
          price_light: a.sale_price_light,
          acquired_at: a.created_at,
        };
      });

      return json({
        id: profile.id,
        display_name: profile.display_name,
        avatar_url: profile.avatar_url,
        country: profile.country,
        tier: profile.tier,
        created_at: profile.created_at,
        stats,
        featured_app: featuredApp,
        published,
        acquisitions,
      });
    } catch (err) {
      console.error("Profile fetch error:", err);
      return error("Failed to fetch profile", 500);
    }
  }

  // ============================================
  // AUTHENTICATED ROUTES
  // ============================================

  // All remaining user endpoints require authentication
  let userId: string;
  try {
    const auth = await authenticate(request);
    userId = auth.id;
  } catch (err) {
    return error("Authentication required", 401);
  }

  const userService = createUserService();

  // ============================================
  // POST /api/user/conversation-embedding - Embed conversation for semantic search
  // ============================================
  if (path === "/api/user/conversation-embedding" && method === "POST") {
    try {
      const body = await readJsonBody<ConversationEmbeddingBody>(request);
      const { conversationId, conversationName, summary, metadata } = body;

      if (!conversationId || !summary || summary.length < 20) {
        return error("conversationId and summary (min 20 chars) required", 400);
      }

      // Generate embedding
      const { createEmbeddingService, storeConversationEmbedding } =
        await import(
          "../services/embedding.ts"
        );
      const embeddingService = createEmbeddingService();
      if (!embeddingService) {
        return error("Embedding service unavailable", 503);
      }
      const { embedding } = await embeddingService.embed(
        summary.slice(0, 4000),
      );

      // Store in Supabase
      await storeConversationEmbedding(
        userId,
        conversationId,
        conversationName || "Untitled",
        summary,
        metadata || {},
        embedding,
      );

      // Update topics hint in KV
      const fnIndex = getFnIndexBinding();
      if (fnIndex) {
        try {
          const existing =
            (await fnIndex.get(`conversation-topics:${userId}`, "json") as {
              count: number;
              recent: Array<
                {
                  id: string;
                  name: string;
                  timestamp: number;
                  entities: string[];
                }
              >;
            }) || { count: 0, recent: [] };
          const recent = (existing.recent || []).filter((r: { id: string }) =>
            r.id !== conversationId
          );
          recent.unshift({
            id: conversationId,
            name: conversationName || "Untitled",
            timestamp: Date.now(),
            entities: ((metadata?.entities || []) as string[]).slice(0, 10),
          });
          await fnIndex.put(
            `conversation-topics:${userId}`,
            JSON.stringify({
              count: Math.max(existing.count || 0, recent.length),
              recent: recent.slice(0, 10),
            }),
          );
        } catch (kvErr) {
          userLogger.warn("Failed to update conversation topics KV", {
            user_id: userId,
            conversation_id: conversationId,
            error: kvErr,
          });
        }
      }

      return json({ ok: true });
    } catch (err) {
      userLogger.error("Conversation embedding failed", {
        user_id: userId,
        error: err,
      });
      return error("Failed to embed conversation", 500);
    }
  }

  // ============================================
  // PUT /api/user/system-agent-states - Sync system agent states for Flash context
  // ============================================
  if (path === "/api/user/system-agent-states" && method === "PUT") {
    try {
      const body = await readJsonBody<SystemAgentStatesBody>(request);
      const states = body.states;
      if (!Array.isArray(states)) {
        return error("states must be an array", 400);
      }
      const fnIndex = getFnIndexBinding();
      if (fnIndex) {
        await fnIndex.put(`system-agents:${userId}`, JSON.stringify(states));
      }
      return json({ ok: true });
    } catch (err) {
      userLogger.error("Failed to sync system agent states", {
        user_id: userId,
        error: err,
      });
      return error("Failed to sync system agent states", 500);
    }
  }

  // ============================================
  // GET /api/user/command-widgets - Installed widget/card inventory
  // ============================================
  if (path === "/api/user/command-widgets" && method === "GET") {
    try {
      const { getFunctionIndex, rebuildFunctionIndex } = await import(
        "../services/function-index.ts"
      );
      let index = await getFunctionIndex(userId);
      if (!index) {
        index = await rebuildFunctionIndex(userId);
      }
      return json({
        widgets: index.widgets || [],
        updated_at: index.updatedAt,
      });
    } catch (err) {
      userLogger.error("Failed to load command widget inventory", {
        user_id: userId,
        error: err,
      });
      return error("Failed to load command widget inventory", 500);
    }
  }

  // ============================================
  // GET/POST/PATCH/DELETE /api/user/command-dashboards - Saved Command dashboards catalog
  // ============================================
  if (path === "/api/user/command-dashboards" && method === "GET") {
    try {
      const { listCommandDashboardLayouts } = await import(
        "../services/command-dashboard.ts"
      );
      return json(await listCommandDashboardLayouts(userId));
    } catch (err) {
      userLogger.error("Failed to list command dashboards", {
        user_id: userId,
        error: err,
      });
      return error(
        err instanceof Error
          ? err.message
          : "Failed to list command dashboards",
        400,
      );
    }
  }

  if (path === "/api/user/command-dashboards" && method === "POST") {
    try {
      const body = await readJsonBody<CommandDashboardMetadataBody>(request);
      const { createCommandDashboardLayout } = await import(
        "../services/command-dashboard.ts"
      );
      return json(await createCommandDashboardLayout(userId, body));
    } catch (err) {
      userLogger.error("Failed to create command dashboard", {
        user_id: userId,
        error: err,
      });
      return error(
        err instanceof Error
          ? err.message
          : "Failed to create command dashboard",
        400,
      );
    }
  }

  if (path.startsWith("/api/user/command-dashboards/") && method === "PATCH") {
    try {
      const dashboardKey = decodeURIComponent(
        path.slice("/api/user/command-dashboards/".length),
      );
      const body = await readJsonBody<CommandDashboardMetadataBody>(request);
      const { updateCommandDashboardMetadata } = await import(
        "../services/command-dashboard.ts"
      );
      return json(
        await updateCommandDashboardMetadata(userId, dashboardKey, body),
      );
    } catch (err) {
      userLogger.error("Failed to update command dashboard", {
        user_id: userId,
        error: err,
      });
      return error(
        err instanceof Error
          ? err.message
          : "Failed to update command dashboard",
        400,
      );
    }
  }

  if (path.startsWith("/api/user/command-dashboards/") && method === "DELETE") {
    try {
      const dashboardKey = decodeURIComponent(
        path.slice("/api/user/command-dashboards/".length),
      );
      const { deleteCommandDashboardLayout } = await import(
        "../services/command-dashboard.ts"
      );
      return json(await deleteCommandDashboardLayout(userId, dashboardKey));
    } catch (err) {
      userLogger.error("Failed to delete command dashboard", {
        user_id: userId,
        error: err,
      });
      return error(
        err instanceof Error
          ? err.message
          : "Failed to delete command dashboard",
        400,
      );
    }
  }

  // ============================================
  // GET/PUT /api/user/command-dashboard - Server-synced Command layout
  // ============================================
  if (path === "/api/user/command-dashboard" && method === "GET") {
    try {
      const { getCommandDashboardLayout } = await import(
        "../services/command-dashboard.ts"
      );
      const dashboard = await getCommandDashboardLayout(
        userId,
        url.searchParams.get("dashboard_key"),
      );
      return json(dashboard);
    } catch (err) {
      userLogger.error("Failed to load command dashboard layout", {
        user_id: userId,
        error: err,
      });
      return error(
        err instanceof Error
          ? err.message
          : "Failed to load command dashboard layout",
        400,
      );
    }
  }

  if (path === "/api/user/command-dashboard" && method === "PUT") {
    try {
      const body = await readJsonBody<CommandDashboardMetadataBody>(request);
      if (body.layout === undefined) {
        return error("layout is required", 400);
      }
      const { upsertCommandDashboardLayout } = await import(
        "../services/command-dashboard.ts"
      );
      const dashboard = await upsertCommandDashboardLayout(
        userId,
        body.dashboard_key || url.searchParams.get("dashboard_key"),
        body.layout,
        body,
      );
      return json(dashboard);
    } catch (err) {
      userLogger.error("Failed to save command dashboard layout", {
        user_id: userId,
        error: err,
      });
      return error(
        err instanceof Error
          ? err.message
          : "Failed to save command dashboard layout",
        400,
      );
    }
  }

  // ============================================
  // GET /api/user - Get user profile
  //
  // Augments the hot-path `userService.getUser` payload with two
  // self-only fields that ProfileView reads:
  //   - `created_at`   — drives the "active since X" sub-line
  //   - `stats`        — B14: exact counts of apps published + apps
  //                      acquired, joined via the existing
  //                      `get_user_profile_stats` RPC (also used by
  //                      the public author profile handler above).
  // Both fetches are best-effort: a 4xx/5xx from Supabase falls back
  // to undefined so the FE's pre-B14 proxies (earnings.by_app.length
  // for published, 0 for acquired) keep working.
  // ============================================
  if (path === "/api/user" && method === "GET") {
    try {
      const user = await userService.getUser(userId);
      if (!user) {
        return error("User not found", 404);
      }
      const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
        getSupabaseEnv();
      const headers = {
        "apikey": sbKey,
        "Authorization": `Bearer ${sbKey}`,
      };
      const [createdRes, statsRes] = await Promise.all([
        fetch(
          `${sbUrl}/rest/v1/users?id=eq.${userId}&select=created_at`,
          { headers },
        ),
        fetch(`${sbUrl}/rest/v1/rpc/get_user_profile_stats`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ p_user_id: userId }),
        }),
      ]);

      let createdAt: string | undefined;
      if (createdRes.ok) {
        const row = await readFirstJsonRow<{ created_at: string | null }>(
          createdRes,
        );
        createdAt = row?.created_at ?? undefined;
      }

      let stats:
        | { published_app_count: number; acquired_app_count: number }
        | undefined;
      if (statsRes.ok) {
        const rpc = await readJsonResponse<
          {
            published_count?: number;
            acquired_count?: number;
          }
        >(statsRes);
        stats = {
          published_app_count: rpc.published_count ?? 0,
          acquired_app_count: rpc.acquired_count ?? 0,
        };
      }

      return json({ ...user, created_at: createdAt, stats });
    } catch (err) {
      userLogger.error("Failed to get user profile", {
        user_id: userId,
        error: err,
      });
      return error("Failed to get user profile", 500);
    }
  }

  // ============================================
  // PATCH /api/user - Update user profile
  // ============================================
  if (path === "/api/user" && method === "PATCH") {
    try {
      const body = await readJsonBody<UserProfilePatchBody>(request);
      const { display_name, country, featured_app_id } = body;

      const updates: UserProfileUpdates = {};
      if (display_name !== undefined) {
        updates.display_name = display_name;
        // Auto-generate profile_slug from display_name
        if (display_name) {
          updates.profile_slug = display_name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 40);
        }
      }
      if (country !== undefined) {
        // Validate 2-letter ISO code or null
        if (
          country !== null &&
          (typeof country !== "string" || !/^[A-Z]{2}$/i.test(country))
        ) {
          return error(
            "Country must be a 2-letter ISO code (e.g. US, JP, BR) or null",
            400,
          );
        }
        updates.country = country ? country.toUpperCase() : null;
      }
      if (featured_app_id !== undefined) {
        if (featured_app_id !== null) {
          // Validate the app belongs to this user
          const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
            getSupabaseEnv();
          const appRes = await fetch(
            `${sbUrl}/rest/v1/apps?id=eq.${featured_app_id}&owner_id=eq.${userId}&deleted_at=is.null&select=id`,
            {
              headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` },
            },
          );
          const ownedApps = appRes.ok
            ? await readJsonRows<{ id: string }>(appRes)
            : [];
          if (!appRes.ok || ownedApps.length === 0) {
            return error("Featured app must be an app you own", 400);
          }
        }
        updates.featured_app_id = featured_app_id;
      }

      const user = await userService.updateUser(userId, updates);
      return json(user);
    } catch (err) {
      console.error("Update user error:", err);
      return error("Failed to update user profile", 500);
    }
  }

  // ============================================
  // GET /api/user/byok - Get BYOK configs
  // ============================================
  if (path === "/api/user/byok" && method === "GET") {
    try {
      const user = await userService.getUser(userId);
      if (!user) {
        return error("User not found", 404);
      }

      return json({
        enabled: user.byok_enabled,
        primary_provider: user.byok_provider,
        configs: user.byok_configs,
        available_providers: Object.values(BYOK_PROVIDERS).map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          protocol: p.protocol,
          baseUrl: p.baseUrl,
          defaultModel: p.defaultModel,
          models: p.models,
          capabilities: p.capabilities,
          apiKeyPrefix: p.apiKeyPrefix,
          docsUrl: p.docsUrl,
          apiKeyUrl: p.apiKeyUrl,
        })),
      });
    } catch (err) {
      console.error("Get BYOK error:", err);
      return error("Failed to get BYOK configuration", 500);
    }
  }

  // ============================================
  // POST /api/user/byok - Add BYOK provider
  // ============================================
  if (path === "/api/user/byok" && method === "POST") {
    return withSensitiveRouteRateLimit(userId, "user:byok_create", async () => {
      try {
        const body = await readJsonBody<ByokCreateBody>(request);
        const { provider, api_key, model, validate = true } = body;
        const providerEntry = getByokProviderEntry(provider);
        const normalizedModel = normalizeOptionalModel(model);
        if (normalizedModel instanceof Response) return normalizedModel;

        // Validate provider
        if (!providerEntry) {
          return error(
            "Invalid provider. Must be one of: " +
              Object.keys(BYOK_PROVIDERS).join(", "),
            400,
          );
        }

        // Validate API key is provided
        if (
          !api_key || typeof api_key !== "string" || api_key.trim().length === 0
        ) {
          return error("API key is required", 400);
        }

        // Optionally validate the API key works
        if (validate) {
          try {
            await validateAPIKey(providerEntry.provider, api_key.trim());
          } catch (validationErr) {
            return error(
              `API key validation failed: ${
                validationErr instanceof Error
                  ? validationErr.message
                  : "Invalid key"
              }`,
              400,
            );
          }
        }

        // Add the provider
        const config = await userService.addBYOKProvider(
          userId,
          providerEntry.provider,
          api_key.trim(),
          normalizedModel,
        );

        return json({
          success: true,
          config,
          message: `${providerEntry.info.name} configured successfully`,
        });
      } catch (err) {
        console.error("Add BYOK error:", err);
        return error("Failed to add BYOK provider", 500);
      }
    });
  }

  // ============================================
  // PATCH /api/user/byok/:provider - Update BYOK provider
  // ============================================
  const byokMatch = path.match(/^\/api\/user\/byok\/([a-z]+)$/);
  if (byokMatch && method === "PATCH") {
    const providerEntry = getByokProviderEntry(byokMatch[1]);

    if (!providerEntry) {
      return error("Invalid provider", 400);
    }
    const { provider, info: providerInfo } = providerEntry;

    return withSensitiveRouteRateLimit(userId, "user:byok_update", async () => {
      try {
        const body = await readJsonBody<ByokUpdateBody>(request);
        const { api_key, model, validate = true } = body;
        const normalizedModel = normalizeOptionalModel(model);
        if (normalizedModel instanceof Response) return normalizedModel;

        if (api_key !== undefined && typeof api_key !== "string") {
          return error("api_key must be a string", 400);
        }
        const normalizedApiKey = api_key?.trim();
        if (api_key !== undefined && !normalizedApiKey) {
          return error("API key must not be empty", 400);
        }

        // If updating API key, validate it
        if (normalizedApiKey && validate) {
          try {
            await validateAPIKey(provider, normalizedApiKey);
          } catch (validationErr) {
            return error(
              `API key validation failed: ${
                validationErr instanceof Error
                  ? validationErr.message
                  : "Invalid key"
              }`,
              400,
            );
          }
        }

        const config = await userService.updateBYOKProvider(userId, provider, {
          apiKey: normalizedApiKey,
          model: normalizedModel,
        });

        return json({
          success: true,
          config,
          message: `${providerInfo.name} updated successfully`,
        });
      } catch (err) {
        console.error("Update BYOK error:", err);
        if (err instanceof Error && err.message.includes("not configured")) {
          return error(err.message, 400);
        }
        return error("Failed to update BYOK provider", 500);
      }
    });
  }

  // ============================================
  // DELETE /api/user/byok/:provider - Remove BYOK provider
  // ============================================
  if (byokMatch && method === "DELETE") {
    const providerEntry = getByokProviderEntry(byokMatch[1]);

    if (!providerEntry) {
      return error("Invalid provider", 400);
    }
    const { provider, info: providerInfo } = providerEntry;

    return withSensitiveRouteRateLimit(userId, "user:byok_delete", async () => {
      try {
        await userService.removeBYOKProvider(userId, provider);

        return json({
          success: true,
          message: `${providerInfo.name} removed`,
        });
      } catch (err) {
        console.error("Remove BYOK error:", err);
        return error("Failed to remove BYOK provider", 500);
      }
    });
  }

  // ============================================
  // POST /api/user/byok/primary - Set primary provider
  // ============================================
  if (path === "/api/user/byok/primary" && method === "POST") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:byok_primary",
      async () => {
        try {
          const body = await readJsonBody<ByokPrimaryBody>(request);
          const providerEntry = getByokProviderEntry(body.provider);

          if (!providerEntry) {
            return error("Invalid provider", 400);
          }

          await userService.setPrimaryProvider(userId, providerEntry.provider);

          return json({
            success: true,
            message: `${providerEntry.info.name} set as primary provider`,
          });
        } catch (err) {
          console.error("Set primary provider error:", err);
          if (err instanceof Error && err.message.includes("not configured")) {
            return error(err.message, 400);
          }
          return error("Failed to set primary provider", 500);
        }
      },
    );
  }

  // ============================================
  // API TOKENS
  // ============================================

  // GET /api/user/tokens - List all tokens
  if (path === "/api/user/tokens" && method === "GET") {
    try {
      const tokens = await listTokens(userId);
      return json({
        tokens: tokens.map((t) => ({
          id: t.id,
          name: t.name,
          token_prefix: t.token_prefix,
          plaintext_token: t.plaintext_token || null,
          scopes: t.scopes,
          app_ids: t.app_ids,
          function_names: t.function_names,
          last_used_at: t.last_used_at,
          expires_at: t.expires_at,
          created_at: t.created_at,
        })),
      });
    } catch (err) {
      userLogger.error("Failed to list API tokens", {
        user_id: userId,
        error: err,
      });
      return error("Failed to list tokens", 500);
    }
  }

  // POST /api/user/tokens - Create a new token
  if (path === "/api/user/tokens" && method === "POST") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:token_create",
      async () => {
        try {
          const body = await readJsonBody<TokenCreateBody>(request);
          const { name, expires_in_days, app_ids, function_names } = body;

          if (!name || typeof name !== "string" || name.trim().length === 0) {
            return error("Token name is required", 400);
          }

          if (name.length > 50) {
            return error("Token name must be 50 characters or less", 400);
          }

          // Validate expires_in_days if provided
          if (expires_in_days !== undefined) {
            if (
              typeof expires_in_days !== "number" || expires_in_days < 1 ||
              expires_in_days > 365
            ) {
              return error("expires_in_days must be between 1 and 365", 400);
            }
          }

          // Validate token scoping (Pro feature — accepts but stores for all tiers)
          if (
            app_ids !== undefined &&
            (!Array.isArray(app_ids) ||
              app_ids.some((id: unknown) => typeof id !== "string"))
          ) {
            return error("app_ids must be an array of strings", 400);
          }
          if (
            function_names !== undefined &&
            (!Array.isArray(function_names) ||
              function_names.some((n: unknown) => typeof n !== "string"))
          ) {
            return error("function_names must be an array of strings", 400);
          }

          const result = await createToken(userId, name.trim(), {
            expiresInDays: expires_in_days,
            app_ids: app_ids || undefined,
            function_names: function_names || undefined,
          });

          return json({
            success: true,
            token: {
              id: result.token.id,
              name: result.token.name,
              token_prefix: result.token.token_prefix,
              app_ids: result.token.app_ids,
              function_names: result.token.function_names,
              expires_at: result.token.expires_at,
              created_at: result.token.created_at,
            },
            // IMPORTANT: This is the only time the full token is returned!
            plaintext_token: result.plaintext_token,
            message:
              "Token created. Copy it now - you won't be able to see it again!",
          });
        } catch (err) {
          console.error("Create token error:", err);
          if (err instanceof Error && err.message.includes("already exists")) {
            return error(err.message, 409);
          }
          if (
            err instanceof Error && err.message.includes("Token limit reached")
          ) {
            return error(err.message, 403);
          }
          return error("Failed to create token", 500);
        }
      },
    );
  }

  // DELETE /api/user/tokens/:id - Revoke a specific token
  const tokenMatch = path.match(/^\/api\/user\/tokens\/([a-f0-9-]+)$/);
  if (tokenMatch && method === "DELETE") {
    const tokenId = tokenMatch[1];

    return withSensitiveRouteRateLimit(
      userId,
      "user:token_delete",
      async () => {
        try {
          await revokeToken(userId, tokenId);
          return json({
            success: true,
            message: "Token revoked",
          });
        } catch (err) {
          console.error("Revoke token error:", err);
          return error("Failed to revoke token", 500);
        }
      },
    );
  }

  // DELETE /api/user/tokens - Revoke all tokens
  if (path === "/api/user/tokens" && method === "DELETE") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:token_delete_all",
      async () => {
        try {
          const count = await revokeAllTokens(userId);
          return json({
            success: true,
            revoked_count: count,
            message: `Revoked ${count} token(s)`,
          });
        } catch (err) {
          console.error("Revoke all tokens error:", err);
          return error("Failed to revoke tokens", 500);
        }
      },
    );
  }

  // ============================================
  // PLATFORM SUPABASE CONFIG
  // ============================================

  // GET /api/user/supabase - List all saved Supabase servers
  if (path === "/api/user/supabase" && method === "GET") {
    try {
      const configs = await listSupabaseConfigs(userId);
      return json({ configs });
    } catch (err) {
      console.error("List Supabase configs error:", err);
      return error("Failed to list Supabase configurations", 500);
    }
  }

  // POST /api/user/supabase - Create a new saved Supabase server
  if (path === "/api/user/supabase" && method === "POST") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:supabase_create",
      async () => {
        try {
          const body = await readJsonBody<SupabaseConfigCreateBody>(request);
          const { name, url: supabaseUrl, anon_key, service_key } = body;

          if (!name || typeof name !== "string" || name.trim().length === 0) {
            return error("Server name is required", 400);
          }
          if (name.length > 100) {
            return error("Server name must be 100 characters or less", 400);
          }
          if (!supabaseUrl || typeof supabaseUrl !== "string") {
            return error("Supabase URL is required", 400);
          }
          try {
            new URL(supabaseUrl);
          } catch {
            return error("Invalid Supabase URL", 400);
          }
          if (!anon_key || typeof anon_key !== "string") {
            return error("Anon key is required", 400);
          }

          const encryptedAnonKey = await encryptEnvVar(anon_key.trim());
          const encryptedServiceKey = service_key
            ? await encryptEnvVar(service_key.trim())
            : null;

          const { SUPABASE_URL: SB_URL, SUPABASE_SERVICE_ROLE_KEY: SB_KEY } =
            getSupabaseEnv();

          const response = await fetch(
            `${SB_URL}/rest/v1/user_supabase_configs`,
            {
              method: "POST",
              headers: {
                "apikey": SB_KEY,
                "Authorization": `Bearer ${SB_KEY}`,
                "Content-Type": "application/json",
                "Prefer": "return=representation",
              },
              body: JSON.stringify({
                user_id: userId,
                name: name.trim(),
                supabase_url: supabaseUrl.trim(),
                anon_key_encrypted: encryptedAnonKey,
                service_key_encrypted: encryptedServiceKey,
              }),
            },
          );

          if (!response.ok) {
            const text = await response.text();
            if (text.includes("unique") || text.includes("duplicate")) {
              return error(
                `A server named "${name.trim()}" already exists`,
                409,
              );
            }
            throw new Error(`Failed to create: ${text}`);
          }

          const created = await readJsonResponse<
            | {
              id: string;
              name: string;
              supabase_url: string;
              service_key_encrypted: string | null;
              created_at: string;
            }
            | Array<{
              id: string;
              name: string;
              supabase_url: string;
              service_key_encrypted: string | null;
              created_at: string;
            }>
          >(response);
          const config = Array.isArray(created) ? created[0] : created;

          return json({
            success: true,
            config: {
              id: config.id,
              name: config.name,
              supabase_url: config.supabase_url,
              has_service_key: !!config.service_key_encrypted,
              created_at: config.created_at,
            },
          });
        } catch (err) {
          console.error("Create Supabase config error:", err);
          if (err instanceof Error && err.message.includes("already exists")) {
            return error(err.message, 409);
          }
          return error("Failed to save Supabase configuration", 500);
        }
      },
    );
  }

  // DELETE /api/user/supabase/:id - Delete a saved Supabase server
  const supabaseDeleteMatch = path.match(
    /^\/api\/user\/supabase\/([a-f0-9-]+)$/,
  );
  if (supabaseDeleteMatch && method === "DELETE") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:supabase_delete",
      async () => {
        try {
          const configId = supabaseDeleteMatch[1];
          const { SUPABASE_URL: SB_URL, SUPABASE_SERVICE_ROLE_KEY: SB_KEY } =
            getSupabaseEnv();

          // Verify ownership
          const checkRes = await fetch(
            `${SB_URL}/rest/v1/user_supabase_configs?id=eq.${configId}&user_id=eq.${userId}&select=id`,
            {
              headers: {
                "apikey": SB_KEY,
                "Authorization": `Bearer ${SB_KEY}`,
              },
            },
          );
          const checkData = await readJsonRows<{ id: string }>(checkRes);
          if (!Array.isArray(checkData) || checkData.length === 0) {
            return error("Configuration not found", 404);
          }

          // Delete (cascade will SET NULL on apps.supabase_config_id)
          const response = await fetch(
            `${SB_URL}/rest/v1/user_supabase_configs?id=eq.${configId}&user_id=eq.${userId}`,
            {
              method: "DELETE",
              headers: {
                "apikey": SB_KEY,
                "Authorization": `Bearer ${SB_KEY}`,
              },
            },
          );

          if (!response.ok) {
            throw new Error(`Failed to delete: ${await response.text()}`);
          }

          return json({ success: true, message: "Supabase server removed" });
        } catch (err) {
          console.error("Delete Supabase config error:", err);
          return error("Failed to delete Supabase configuration", 500);
        }
      },
    );
  }

  // ============================================
  // SUPABASE MANAGEMENT API OAUTH
  // "Connect Supabase" flow — lets users authorize Ultralight
  // to read their Supabase projects and auto-wire credentials
  // ============================================

  // GET /api/user/supabase/oauth/authorize — Initiate OAuth flow
  if (path === "/api/user/supabase/oauth/authorize" && method === "GET") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:supabase_oauth_authorize",
      async () => {
        try {
          const clientId = getEnv("SUPABASE_MGMT_OAUTH_CLIENT_ID");
          if (!clientId) {
            return error("Supabase OAuth not configured", 501);
          }

          const baseUrl = `${url.protocol}//${url.host}`;
          const redirectUri = `${baseUrl}/api/user/supabase/oauth/callback`;

          // Generate PKCE code_verifier (43-128 chars, URL-safe)
          const verifierBytes = new Uint8Array(32);
          crypto.getRandomValues(verifierBytes);
          const codeVerifier = btoa(String.fromCharCode(...verifierBytes))
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

          // Generate code_challenge = BASE64URL(SHA256(code_verifier))
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(codeVerifier),
          );
          const codeChallenge = btoa(
            String.fromCharCode(...new Uint8Array(digest)),
          )
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

          // Generate random state
          const stateBytes = new Uint8Array(16);
          crypto.getRandomValues(stateBytes);
          const state = Array.from(stateBytes).map((b) =>
            b.toString(16).padStart(2, "0")
          ).join("");

          // Store state + verifier for callback validation
          const { SUPABASE_URL: SB_URL, SUPABASE_SERVICE_ROLE_KEY: SB_KEY } =
            getSupabaseEnv();
          await fetch(`${SB_URL}/rest/v1/supabase_oauth_state`, {
            method: "POST",
            headers: {
              "apikey": SB_KEY,
              "Authorization": `Bearer ${SB_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "return=minimal",
            },
            body: JSON.stringify({
              state: state,
              user_id: userId,
              code_verifier: codeVerifier,
            }),
          });

          const authUrl = `https://api.supabase.com/v1/oauth/authorize?` +
            `client_id=${encodeURIComponent(clientId)}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&response_type=code` +
            `&state=${state}` +
            `&code_challenge=${codeChallenge}` +
            `&code_challenge_method=S256`;

          return json({ url: authUrl });
        } catch (err) {
          console.error("Supabase OAuth authorize error:", err);
          return error("Failed to initiate Supabase OAuth", 500);
        }
      },
    );
  }

  // GET /api/user/supabase/oauth/status — Check if user has OAuth connected
  if (path === "/api/user/supabase/oauth/status" && method === "GET") {
    try {
      const { SUPABASE_URL: SB_URL, SUPABASE_SERVICE_ROLE_KEY: SB_KEY } =
        getSupabaseEnv();
      const res = await fetch(
        `${SB_URL}/rest/v1/user_supabase_oauth?user_id=eq.${userId}&select=id,token_expires_at`,
        { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } },
      );
      const rows = await readJsonRows<{ id: string; token_expires_at: string }>(
        res,
      );
      const connected = Array.isArray(rows) && rows.length > 0;
      return json({ connected: connected });
    } catch {
      return json({ connected: false });
    }
  }

  // GET /api/user/supabase/oauth/projects — List user's Supabase projects via Management API
  if (path === "/api/user/supabase/oauth/projects" && method === "GET") {
    try {
      const accessToken = await getSupabaseMgmtToken(userId);
      if (!accessToken) {
        return error(
          "Supabase account not connected. Please connect first.",
          401,
        );
      }

      const projRes = await fetch("https://api.supabase.com/v1/projects", {
        headers: { "Authorization": `Bearer ${accessToken}` },
      });

      if (!projRes.ok) {
        console.error("Supabase Management API error:", await projRes.text());
        return error("Failed to fetch Supabase projects", 502);
      }

      const projects = await projRes.json() as Array<{
        id: string;
        name: string;
        region: string;
        organization_id: string;
        created_at: string;
        status: string;
      }>;

      return json({
        projects: projects
          .filter((p: { status: string }) =>
            p.status === "ACTIVE_HEALTHY" || p.status === "ACTIVE_UNHEALTHY" ||
            !p.status
          )
          .map((
            p: {
              id: string;
              name: string;
              region: string;
              organization_id: string;
            },
          ) => ({
            ref: p.id,
            name: p.name,
            region: p.region,
            organization_id: p.organization_id,
            url: `https://${p.id}.supabase.co`,
          })),
      });
    } catch (err) {
      console.error("List Supabase projects error:", err);
      return error("Failed to list Supabase projects", 500);
    }
  }

  // POST /api/user/supabase/oauth/connect — Wire a Supabase project to an app
  if (path === "/api/user/supabase/oauth/connect" && method === "POST") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:supabase_oauth_connect",
      async () => {
        try {
          const { projectRef, appId } =
            await validateSupabaseOauthConnectRequest(request);

          const accessToken = await getSupabaseMgmtToken(userId);
          if (!accessToken) {
            return error("Supabase account not connected", 401);
          }

          // Fetch API keys from Management API
          const keysRes = await fetch(
            `https://api.supabase.com/v1/projects/${projectRef}/api-keys`,
            {
              headers: { "Authorization": `Bearer ${accessToken}` },
            },
          );

          if (!keysRes.ok) {
            console.error("Fetch API keys error:", await keysRes.text());
            return error("Failed to fetch project API keys", 502);
          }

          const apiKeys = await keysRes.json() as Array<{
            name: string;
            api_key: string;
          }>;

          // Find anon and service_role keys
          const anonKeyObj = apiKeys.find((k: { name: string }) =>
            k.name === "anon"
          );
          const serviceKeyObj = apiKeys.find((k: { name: string }) =>
            k.name === "service_role"
          );

          if (!anonKeyObj) {
            return error("Could not find anon key for this project", 404);
          }

          const supabaseUrl = `https://${projectRef}.supabase.co`;
          const anonKey = anonKeyObj.api_key;
          const serviceKey = serviceKeyObj?.api_key;

          // Encrypt keys
          const encryptedAnonKey = await encryptEnvVar(anonKey);
          const encryptedServiceKey = serviceKey
            ? await encryptEnvVar(serviceKey)
            : null;

          // Fetch project name for the config name
          const projRes = await fetch("https://api.supabase.com/v1/projects", {
            headers: { "Authorization": `Bearer ${accessToken}` },
          });
          const projects = await projRes.json() as Array<
            { id: string; name: string }
          >;
          const project = projects.find((p: { id: string }) =>
            p.id === projectRef
          );
          const configName = project ? project.name : projectRef;

          // Create or update user_supabase_configs entry
          const { SUPABASE_URL: SB_URL, SUPABASE_SERVICE_ROLE_KEY: SB_KEY } =
            getSupabaseEnv();

          // Check if config already exists for this URL
          const existingRes = await fetch(
            `${SB_URL}/rest/v1/user_supabase_configs?user_id=eq.${userId}&supabase_url=eq.${
              encodeURIComponent(supabaseUrl)
            }&select=id`,
            {
              headers: {
                "apikey": SB_KEY,
                "Authorization": `Bearer ${SB_KEY}`,
              },
            },
          );
          const existing = await readJsonRows<{ id: string }>(existingRes);
          let configId: string;

          if (Array.isArray(existing) && existing.length > 0) {
            // Update existing config with fresh keys
            configId = existing[0].id;
            await fetch(
              `${SB_URL}/rest/v1/user_supabase_configs?id=eq.${configId}`,
              {
                method: "PATCH",
                headers: {
                  "apikey": SB_KEY,
                  "Authorization": `Bearer ${SB_KEY}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  anon_key_encrypted: encryptedAnonKey,
                  service_key_encrypted: encryptedServiceKey,
                  updated_at: new Date().toISOString(),
                }),
              },
            );
          } else {
            // Create new config
            const createRes = await fetch(
              `${SB_URL}/rest/v1/user_supabase_configs`,
              {
                method: "POST",
                headers: {
                  "apikey": SB_KEY,
                  "Authorization": `Bearer ${SB_KEY}`,
                  "Content-Type": "application/json",
                  "Prefer": "return=representation",
                },
                body: JSON.stringify({
                  user_id: userId,
                  name: configName,
                  supabase_url: supabaseUrl,
                  anon_key_encrypted: encryptedAnonKey,
                  service_key_encrypted: encryptedServiceKey,
                }),
              },
            );

            if (!createRes.ok) {
              throw new Error(
                `Failed to create config: ${await createRes.text()}`,
              );
            }

            const created = await readJsonResponse<
              { id: string } | Array<{ id: string }>
            >(createRes);
            configId = Array.isArray(created) ? created[0].id : created.id;
          }

          // Optionally assign to app
          if (appId) {
            const appsService = createAppsService();
            const app = await appsService.findById(appId);
            if (!app || app.owner_id !== userId) {
              return error("App not found", 404);
            }

            await appsService.update(appId, {
              supabase_config_id: configId,
              supabase_enabled: true,
              supabase_url: null,
              supabase_anon_key_encrypted: null,
              supabase_service_key_encrypted: null,
            });
          }

          // Invalidate cached servers list
          return json({
            success: true,
            config: {
              id: configId,
              name: configName,
              supabase_url: supabaseUrl,
              has_service_key: !!serviceKey,
            },
          });
        } catch (err) {
          if (err instanceof RequestValidationError) {
            return error(err.message, err.status);
          }
          console.error("Supabase OAuth connect error:", err);
          return error("Failed to wire Supabase project", 500);
        }
      },
    );
  }

  // DELETE /api/user/supabase/oauth/disconnect — Remove OAuth tokens
  if (path === "/api/user/supabase/oauth/disconnect" && method === "DELETE") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:supabase_oauth_disconnect",
      async () => {
        try {
          const { SUPABASE_URL: SB_URL, SUPABASE_SERVICE_ROLE_KEY: SB_KEY } =
            getSupabaseEnv();
          await fetch(
            `${SB_URL}/rest/v1/user_supabase_oauth?user_id=eq.${userId}`,
            {
              method: "DELETE",
              headers: {
                "apikey": SB_KEY,
                "Authorization": `Bearer ${SB_KEY}`,
              },
            },
          );
          return json({
            success: true,
            message: "Supabase account disconnected",
          });
        } catch (err) {
          console.error("Supabase OAuth disconnect error:", err);
          return error("Failed to disconnect Supabase account", 500);
        }
      },
    );
  }

  // ============================================
  // GET /api/user/usage - Get weekly usage stats
  // ============================================
  if (path === "/api/user/usage" && method === "GET") {
    try {
      const { getWeeklyUsage } = await import("../services/weekly-calls.ts");
      const user = await userService.getUser(userId);
      const tier = toTier(user?.tier);
      const usage = await getWeeklyUsage(userId, tier);
      return json({
        count: usage.count,
      });
    } catch (err) {
      console.error("Get usage error:", err);
      return error("Failed to get usage stats", 500);
    }
  }

  // ============================================
  // GET /api/user/call-log - Get recent MCP call logs
  // ============================================
  if (path === "/api/user/call-log" && method === "GET") {
    try {
      const { getRecentCalls } = await import("../services/call-logger.ts");
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const since = url.searchParams.get("since") || undefined;
      const appId = url.searchParams.get("app_id") || undefined;
      const logs = await getRecentCalls(userId, {
        limit: Math.min(limit, 200),
        since,
        appId,
      });
      return json({ logs });
    } catch (err) {
      console.error("Get call log error:", err);
      return error("Failed to get call logs", 500);
    }
  }

  // ============================================
  // PERMISSIONS: Per-User App Permissions (Model B)
  // ============================================

  const permsMatch = path.match(/^\/api\/user\/permissions\/([a-f0-9-]+)$/);

  // GET /api/user/permissions/:appId - Get granted users + their permissions for an app
  if (permsMatch && method === "GET") {
    try {
      const appId = permsMatch[1];
      const targetUserId = url.searchParams.get("user_id");
      const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();

      // Verify caller owns this app
      const appsService = createAppsService();
      const app = await appsService.findById(appId);
      if (!app || app.owner_id !== userId) {
        return error("App not found", 404);
      }

      if (targetUserId) {
        // Get permissions for a specific user on this app
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/user_app_permissions?app_id=eq.${appId}&granted_to_user_id=eq.${targetUserId}&select=id,function_name,allowed,allowed_args`,
          {
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
          },
        );
        if (!response.ok) throw new Error(await response.text());
        const permissionRows = await response.json() as Array<{
          function_name: string;
          allowed: boolean;
          allowed_args?: unknown;
        }>;
        logLegacyPermissionNameCompatibility({
          surface: "user_permissions_api",
          appId,
          appSlug: app.slug,
          actorUserId: userId,
          ownerUserId: app.owner_id,
          rows: permissionRows,
        });
        const permissions = normalizeFunctionNamedRows(
          app.slug,
          permissionRows,
        );
        return json({ permissions });
      } else {
        // Get all granted users for this app using the RPC
        const rpcRes = await fetch(
          `${SUPABASE_URL}/rest/v1/rpc/get_app_granted_users`,
          {
            method: "POST",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ p_app_id: appId }),
          },
        );
        if (!rpcRes.ok) throw new Error(await rpcRes.text());
        const users = await readJsonRows<GrantedUserSummary>(rpcRes);

        // Also fetch pending invites
        const pendingRes = await fetch(
          `${SUPABASE_URL}/rest/v1/pending_permissions?app_id=eq.${appId}&allowed=eq.true&select=invited_email,function_name`,
          {
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
          },
        );
        let pendingUsers: Array<
          {
            email: string;
            display_name: null;
            function_count: number;
            status: string;
          }
        > = [];
        if (pendingRes.ok) {
          const pendingPermissionRows = await pendingRes.json() as Array<
            { invited_email: string; function_name: string }
          >;
          logLegacyPermissionNameCompatibility({
            surface: "user_pending_permissions_api",
            appId,
            appSlug: app.slug,
            actorUserId: userId,
            ownerUserId: app.owner_id,
            rows: pendingPermissionRows,
          });
          const pendingRows = normalizeFunctionNamedRows(
            app.slug,
            pendingPermissionRows,
          );
          const pendingMap = new Map<
            string,
            {
              email: string;
              display_name: null;
              functions: Set<string>;
              status: string;
            }
          >();
          for (const row of pendingRows) {
            if (!pendingMap.has(row.invited_email)) {
              pendingMap.set(row.invited_email, {
                email: row.invited_email,
                display_name: null,
                functions: new Set<string>(),
                status: "pending",
              });
            }
            pendingMap.get(row.invited_email)!.functions.add(row.function_name);
          }
          pendingUsers = Array.from(
            pendingMap.values(),
            ({ email, display_name, functions, status }) => ({
              email,
              display_name,
              function_count: functions.size,
              status,
            }),
          );
        }

        return json({ users: [...users, ...pendingUsers] });
      }
    } catch (err) {
      console.error("Get permissions error:", err);
      return error("Failed to get permissions", 500);
    }
  }

  // PUT /api/user/permissions/:appId - Set permissions for a user on an app
  if (permsMatch && method === "PUT") {
    try {
      const appId = permsMatch[1];
      const body = await readJsonBody<PermissionGrantBody>(request);
      const { email, user_id: targetUserId, permissions: permsList } = body;

      if (!Array.isArray(permsList)) {
        return error("permissions array required", 400);
      }
      if (email !== undefined && typeof email !== "string") {
        return error("email must be a string", 400);
      }
      if (targetUserId !== undefined && typeof targetUserId !== "string") {
        return error("user_id must be a string", 400);
      }

      const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();

      // Verify caller owns this app
      const appsService = createAppsService();
      const app = await appsService.findById(appId);
      if (!app || app.owner_id !== userId) {
        return error("App not found", 404);
      }

      // Resolve target user: either by user_id or email
      let resolvedUserId = targetUserId;
      if (!resolvedUserId && email) {
        const userRes = await fetch(
          `${SUPABASE_URL}/rest/v1/users?email=eq.${
            encodeURIComponent(email)
          }&select=id,tier`,
          {
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
          },
        );
        if (!userRes.ok) throw new Error(await userRes.text());
        const userRows = await readJsonRows<{ id: string; tier: string }>(
          userRes,
        );
        if (userRows.length === 0) {
          // User doesn't exist — create pending invite
          const effectivePermsList = normalizePermissionNamedRows(
            app.slug,
            permsList as Array<{ function_name: string; allowed: boolean }>,
          );
          const pendingRows = effectivePermsList.map((
            p: { function_name: string; allowed: boolean },
          ) => ({
            app_id: appId,
            invited_email: email.toLowerCase(),
            granted_by_user_id: userId,
            function_name: p.function_name,
            allowed: !!p.allowed,
          }));
          // Delete existing pending for this email+app
          await fetch(
            `${SUPABASE_URL}/rest/v1/pending_permissions?invited_email=eq.${
              encodeURIComponent(email.toLowerCase())
            }&app_id=eq.${appId}`,
            {
              method: "DELETE",
              headers: {
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              },
            },
          );
          // Insert pending rows
          const hasAnyAllowed = pendingRows.some((p: { allowed: boolean }) =>
            p.allowed
          );
          if (hasAnyAllowed) {
            await fetch(
              `${SUPABASE_URL}/rest/v1/pending_permissions`,
              {
                method: "POST",
                headers: {
                  "apikey": SUPABASE_SERVICE_ROLE_KEY,
                  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                  "Content-Type": "application/json",
                  "Prefer": "resolution=merge-duplicates",
                },
                body: JSON.stringify(
                  pendingRows.filter((p: { allowed: boolean }) => p.allowed),
                ),
              },
            );
          }
          return json({
            success: true,
            message: "Invite created (user has not signed up yet)",
            status: "pending",
            email,
          });
        }
        resolvedUserId = userRows[0].id;
      }

      if (!resolvedUserId) {
        return error("email or user_id is required", 400);
      }

      // Can't grant permissions to yourself (owner already has full access)
      if (resolvedUserId === userId) {
        return error("Cannot set permissions for the app owner", 400);
      }

      // Granular per-function permissions — available to all users
      const effectivePermsList = normalizePermissionNamedRows(
        app.slug,
        permsList as Array<
          {
            function_name: string;
            allowed: boolean;
            allowed_args?: Record<string, unknown> | null;
          }
        >,
      );

      // Delete existing permissions for this user+app
      await fetch(
        `${SUPABASE_URL}/rest/v1/user_app_permissions?granted_to_user_id=eq.${resolvedUserId}&app_id=eq.${appId}`,
        {
          method: "DELETE",
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        },
      );

      // Insert new permissions
      if (effectivePermsList.length > 0) {
        const rows = effectivePermsList.map((
          p: {
            function_name: string;
            allowed: boolean;
            allowed_args?: Record<string, unknown> | null;
          },
        ) => ({
          app_id: appId,
          granted_to_user_id: resolvedUserId,
          granted_by_user_id: userId,
          function_name: p.function_name,
          allowed: !!p.allowed,
          ...(p.allowed_args ? { allowed_args: p.allowed_args } : {}),
        }));

        const insertRes = await fetch(
          `${SUPABASE_URL}/rest/v1/user_app_permissions`,
          {
            method: "POST",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(rows),
          },
        );

        if (!insertRes.ok) throw new Error(await insertRes.text());
      }

      // Invalidate permission cache for this user+app
      getPermissionCache().invalidateByUserAndApp(resolvedUserId, appId);

      return json({
        success: true,
        message: "Permissions saved",
        user_id: resolvedUserId,
        granular: true,
      });
    } catch (err) {
      console.error("Set permissions error:", err);
      if (err instanceof Error && err.message.includes("No user found")) {
        return error(err.message, 404);
      }
      return error("Failed to save permissions", 500);
    }
  }

  // DELETE /api/user/permissions/:appId - Revoke all permissions for a user on an app
  if (permsMatch && method === "DELETE") {
    try {
      const appId = permsMatch[1];
      const targetUserId = url.searchParams.get("user_id");
      const pendingEmail = url.searchParams.get("email");
      const isPending = url.searchParams.get("pending") === "true";

      const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();

      // Verify caller owns this app
      const appsService = createAppsService();
      const app = await appsService.findById(appId);
      if (!app || app.owner_id !== userId) {
        return error("App not found", 404);
      }

      // Revoke pending invite by email
      if (isPending && pendingEmail) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/pending_permissions?invited_email=eq.${
            encodeURIComponent(pendingEmail.toLowerCase())
          }&app_id=eq.${appId}`,
          {
            method: "DELETE",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
          },
        );
        return json({ success: true, message: "Pending invite revoked" });
      }

      if (!targetUserId) {
        return error("user_id query parameter required", 400);
      }

      // Delete all permissions for this user+app
      await fetch(
        `${SUPABASE_URL}/rest/v1/user_app_permissions?granted_to_user_id=eq.${targetUserId}&app_id=eq.${appId}`,
        {
          method: "DELETE",
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        },
      );

      // Invalidate permission cache for this user+app
      getPermissionCache().invalidateByUserAndApp(targetUserId, appId);

      return json({ success: true, message: "User access revoked" });
    } catch (err) {
      console.error("Revoke permissions error:", err);
      return error("Failed to revoke permissions", 500);
    }
  }

  // ============================================
  // BILLING TRANSACTIONS
  // ============================================

  // GET /api/user/transactions — transaction history with current charge rate
  if (path === "/api/user/transactions" && method === "GET") {
    try {
      const user = await authenticate(request);
      const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
        getSupabaseEnv();
      const sbHeaders = { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` };

      const url = new URL(request.url);
      const limit = Math.min(
        parseInt(url.searchParams.get("limit") || "50", 10),
        100,
      );
      const offset = parseInt(url.searchParams.get("offset") || "0", 10);
      const category = url.searchParams.get("category");

      // Fetch transactions
      let query =
        `${sbUrl}/rest/v1/billing_transactions?user_id=eq.${user.id}&order=created_at.desc&limit=${limit}&offset=${offset}`;
      if (category) query += `&category=eq.${category}`;

      const [txRes, countRes] = await Promise.all([
        fetch(query, { headers: { ...sbHeaders, "Prefer": "count=exact" } }),
        // Calculate current storage-at-rest rate from account counters + content.
        Promise.all([
          fetch(
            `${sbUrl}/rest/v1/content?owner_id=eq.${user.id}&type=in.(page,memory_md,library_md)&select=type,size`,
            { headers: sbHeaders },
          ),
          fetch(
            `${sbUrl}/rest/v1/users?id=eq.${user.id}&select=storage_used_bytes,data_storage_used_bytes,d1_storage_bytes,storage_limit_bytes`,
            { headers: sbHeaders },
          ),
        ]),
      ]);

      const typedTransactions = txRes.ok
        ? await readJsonRows<JsonRecord>(txRes)
        : [];
      const totalHeader = txRes.headers.get("content-range");
      const total = totalHeader
        ? parseInt(totalHeader.split("/")[1] || "0", 10)
        : typedTransactions.length;

      const [contentRes, userDataRes] = countRes;
      let contentBytes = 0;
      let contentCount = 0;
      if (contentRes.ok) {
        const contentRows = await contentRes.json() as Array<{
          type: string | null;
          size: number | null;
        }>;
        contentCount = contentRows.length;
        contentBytes = contentRows.reduce(
          (sum: number, row: { size: number | null }) => sum + (row.size || 0),
          0,
        );
      }

      let sourceBytes = 0;
      let dataBytes = 0;
      let d1Bytes = 0;
      let combinedBytes = contentBytes;
      let overageBytes = 0;
      const billingConfig = await getBillingConfig();
      let freeBytes = billingConfig.storageFreeBytes;
      if (userDataRes.ok) {
        const [ud] = await userDataRes.json() as Array<
          {
            storage_used_bytes: number;
            data_storage_used_bytes: number;
            d1_storage_bytes?: number;
            storage_limit_bytes: number;
          }
        >;
        if (ud) {
          sourceBytes = ud.storage_used_bytes || 0;
          dataBytes = ud.data_storage_used_bytes || 0;
          d1Bytes = ud.d1_storage_bytes || 0;
          combinedBytes = sourceBytes + dataBytes + d1Bytes + contentBytes;
          freeBytes = billingConfig.storageFreeBytes ||
            ud.storage_limit_bytes || COMBINED_FREE_TIER_BYTES;
          overageBytes = Math.max(0, combinedBytes - freeBytes);
        }
      }

      const bytesPerMb = 1024 * 1024;
      const bytesPerGb = 1024 * bytesPerMb;
      const storageOverageGb = overageBytes / bytesPerGb;
      const storageLightPerMonth = storageOverageGb *
        billingConfig.storageLightPerGbMonth;
      const storageLightPerHour = storageLightPerMonth / (30 * 24);
      const storageLightPerDay = storageLightPerMonth / 30;
      const storageOverageMb = overageBytes / bytesPerMb;

      return json({
        transactions: typedTransactions,
        total,
        current_rate: {
          storage_combined_mb: Math.round((combinedBytes / bytesPerMb) * 100) /
            100,
          storage_content_mb: Math.round((contentBytes / bytesPerMb) * 100) /
            100,
          storage_source_mb: Math.round((sourceBytes / bytesPerMb) * 100) /
            100,
          storage_user_data_mb: Math.round((dataBytes / bytesPerMb) * 100) /
            100,
          storage_d1_mb: Math.round((d1Bytes / bytesPerMb) * 100) / 100,
          storage_content_items: contentCount,
          storage_free_mb: Math.round((freeBytes / bytesPerMb) * 100) / 100,
          storage_overage_mb: Math.round(storageOverageMb * 100) / 100,
          storage_overage_gb: Math.round(storageOverageGb * 10000) / 10000,
          storage_rate_light_per_gb_month: billingConfig.storageLightPerGbMonth,
          cloud_unit_light_per_1k: billingConfig.cloudUnitLightPer1k,
          storage_light_per_hour: Math.round(storageLightPerHour * 10000) /
            10000,
          storage_light_per_day: Math.round(storageLightPerDay * 10000) /
            10000,
          storage_light_per_month: Math.round(storageLightPerMonth * 10000) /
            10000,
          hosting_mb: 0,
          hosting_apps: 0,
          hosting_rate_light_per_mb_hour: 0,
          hosting_light_per_hour: Math.round(storageLightPerHour * 10000) /
            10000,
          data_overage_mb: Math.round(storageOverageMb * 100) / 100,
          data_rate_light_per_mb_hour: 0,
          data_overage_light_per_hour: Math.round(storageLightPerHour * 10000) /
            10000,
          estimated_daily_light: Math.round(
            storageLightPerDay * 100,
          ) / 100,
          estimated_monthly_light: Math.round(
            storageLightPerMonth * 100,
          ) / 100,
        },
      });
    } catch (err) {
      console.error("Transactions error:", err);
      return error("Failed to load transactions", 500);
    }
  }

  // ============================================
  // HOSTING BALANCE
  // ============================================

  // GET /api/user/hosting — get Light balance, usage, and auto-topup settings
  if (path === "/api/user/hosting" && method === "GET") {
    try {
      const user = await authenticate(request);
      const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
        getSupabaseEnv();
      const userRes = await fetch(
        `${sbUrl}/rest/v1/users?id=eq.${user.id}&select=balance_light,escrow_light,deposit_balance_light,earned_balance_light,escrow_deposit_light,escrow_earned_light,hosting_last_billed_at,auto_add_earnings_to_balance,auto_topup_enabled,auto_topup_threshold_light,auto_topup_amount_light,auto_topup_last_failed_at,stripe_customer_id`,
        {
          headers: {
            "apikey": sbKey,
            "Authorization": `Bearer ${sbKey}`,
          },
        },
      );
      if (!userRes.ok) throw new Error("Failed to read user");
      const rows = await readJsonRows<HostingBalanceRow>(userRes);
      if (rows.length === 0) return error("User not found", 404);
      const ud = rows[0];

      return json({
        balance_light: ud.balance_light ?? 0,
        spendable_balance_light: ud.balance_light ?? 0,
        escrow_light: ud.escrow_light ?? 0,
        deposit_balance_light: ud.deposit_balance_light ?? 0,
        earned_balance_light: ud.earned_balance_light ?? 0,
        convertible_earnings_light: ud.earned_balance_light ?? 0,
        escrow_deposit_light: ud.escrow_deposit_light ?? 0,
        escrow_earned_light: ud.escrow_earned_light ?? 0,
        withdrawable_earnings_light: ud.earned_balance_light ?? 0,
        auto_add_earnings_to_balance: ud.auto_add_earnings_to_balance ?? false,
        hosting_last_billed_at: ud.hosting_last_billed_at ?? null,
        auto_topup: {
          enabled: false,
          threshold_light: ud.auto_topup_threshold_light ?? 100,
          amount_light: ud.auto_topup_amount_light ?? 1000,
          last_failed_at: ud.auto_topup_last_failed_at ?? null,
        },
        has_payment_method: !!ud.stripe_customer_id,
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : "Unauthorized", 401);
    }
  }

  // PATCH /api/user/hosting/auto-topup — legacy saved-payment auto top-up is disabled.
  if (path === "/api/user/hosting/auto-topup" && method === "PATCH") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:hosting_auto_topup_update",
      async () => {
        try {
          const user = await authenticate(request);
          const body = await request.json() as {
            enabled?: boolean;
          };

          const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
            getSupabaseEnv();

          if (body.enabled !== false) {
            return error(
              "Automatic top-up is disabled. Add Light with Apple Pay / Google Pay or wire transfer.",
              410,
            );
          }

          const update = {
            auto_topup_enabled: false,
            auto_topup_last_failed_at: null,
          };

          const updateRes = await fetch(
            `${sbUrl}/rest/v1/users?id=eq.${user.id}`,
            {
              method: "PATCH",
              headers: {
                "apikey": sbKey,
                "Authorization": `Bearer ${sbKey}`,
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
              },
              body: JSON.stringify(update),
            },
          );

          if (!updateRes.ok) {
            throw new Error("Failed to update auto top-up settings");
          }

          return json({ success: true, updated: update });
        } catch (err) {
          if (err instanceof SyntaxError) {
            return error("Invalid JSON body", 400);
          }
          return error(
            err instanceof Error ? err.message : "Unauthorized",
            401,
          );
        }
      },
    );
  }

  // GET /api/user/billing-address — current buyer tax-location profile
  if (path === "/api/user/billing-address" && method === "GET") {
    try {
      const user = await authenticate(request);
      const profile = await getCurrentBillingAddress(user.id);
      return json({
        billing_address: publicBillingAddress(profile),
        has_billing_address: !!profile,
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : "Unauthorized", 401);
    }
  }

  // PUT /api/user/billing-address — save a new current billing address version
  if (path === "/api/user/billing-address" && method === "PUT") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:billing_address_update",
      async () => {
        try {
          const user = await authenticate(request);
          const { billingAddress } = await validateBillingAddressRequest(
            request,
          );
          const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
          let stripeCustomerId: string | null = null;
          if (stripeSecretKey) {
            const customer = await getOrCreateStripeCustomerForUser(
              user.id,
              stripeSecretKey,
            );
            stripeCustomerId = customer.stripeCustomerId;
          }

          const profile = await upsertCurrentBillingAddress({
            userId: user.id,
            address: billingAddress,
            source: "manual",
            stripeCustomerId,
          });

          if (stripeSecretKey && stripeCustomerId) {
            try {
              await updateStripeCustomerBillingAddress({
                stripeSecretKey,
                stripeCustomerId,
                profile,
              });
            } catch (err) {
              stripeLogger.warn(
                "Failed to sync billing address to Stripe customer",
                {
                  user_id: user.id,
                  stripe_customer_id: stripeCustomerId,
                  error: err,
                },
              );
            }
          }

          return json({
            billing_address: publicBillingAddress(profile),
            has_billing_address: true,
          });
        } catch (err) {
          if (err instanceof RequestValidationError) {
            return error(err.message, err.status);
          }
          return error(
            err instanceof Error
              ? err.message
              : "Failed to save billing address",
            500,
          );
        }
      },
    );
  }

  // POST /api/user/wallet/express-checkout-intent — Apple Pay / Google Pay Light funding
  // Body: { amount_cents: number, source?: 'web' | 'desktop', terms_accepted: true }
  // Returns a Stripe PaymentIntent client secret for the Express Checkout Element.
  if (
    path === "/api/user/wallet/express-checkout-intent" && method === "POST"
  ) {
    return withSensitiveRouteRateLimit(
      userId,
      "user:wallet_express_checkout",
      async () => {
        try {
          const user = await authenticate(request);
          const { amountCents, source, termsAccepted, billingAddress } =
            await validateWalletFundingRequest(request);

          const STRIPE_SECRET_KEY = getEnv("STRIPE_SECRET_KEY");
          if (!STRIPE_SECRET_KEY) {
            return error(
              "Stripe wallet funding is not configured yet.",
              503,
            );
          }

          const { stripeCustomerId, email } =
            await getOrCreateStripeCustomerForUser(
              user.id,
              STRIPE_SECRET_KEY,
            );
          const billingProfile = await ensureBillingAddressForFunding({
            userId: user.id,
            billingAddress,
            source: "wallet_funding",
            stripeSecretKey: STRIPE_SECRET_KEY,
            stripeCustomerId,
          });
          const intent = await createWalletExpressPaymentIntent({
            userId: user.id,
            stripeCustomerId,
            email,
            amountCents,
            source,
            termsAccepted,
            billingAddressId: billingProfile.id,
            billingAddressVersion: billingProfile.version,
          });

          return json({
            publishable_key: intent.publishableKey,
            client_secret: intent.clientSecret,
            payment_intent_id: intent.paymentIntentId,
            stripe_customer_id: intent.stripeCustomerId,
            amount_cents: intent.amountCents,
            light_amount: intent.lightAmount,
            wallet_light_per_usd: intent.lightPerUsd,
            billing_config_version: intent.billingConfigVersion,
            billing_address: publicBillingAddress(billingProfile),
          });
        } catch (err) {
          if (err instanceof RequestValidationError) {
            return error(err.message, err.status);
          }
          if (err instanceof WalletFundingError) {
            return error(err.message, err.status);
          }
          return error(
            err instanceof Error ? err.message : "Wallet funding failed",
            500,
          );
        }
      },
    );
  }

  // POST /api/user/wallet/wire-transfer-intent — Stripe customer-balance wire funding
  // Body: { amount_cents: number, source?: 'web' | 'desktop', terms_accepted: true }
  // Returns bank-transfer instructions for the confirmed PaymentIntent.
  if (path === "/api/user/wallet/wire-transfer-intent" && method === "POST") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:wallet_wire_transfer",
      async () => {
        try {
          const user = await authenticate(request);
          const { amountCents, source, termsAccepted, billingAddress } =
            await validateWireFundingRequest(request);

          const STRIPE_SECRET_KEY = getEnv("STRIPE_SECRET_KEY");
          if (!STRIPE_SECRET_KEY) {
            return error(
              "Stripe wire funding is not configured yet.",
              503,
            );
          }

          const { stripeCustomerId, email } =
            await getOrCreateStripeCustomerForUser(
              user.id,
              STRIPE_SECRET_KEY,
            );
          const billingProfile = await ensureBillingAddressForFunding({
            userId: user.id,
            billingAddress,
            source: "wire_funding",
            stripeSecretKey: STRIPE_SECRET_KEY,
            stripeCustomerId,
          });
          const intent = await createWireTransferPaymentIntent({
            userId: user.id,
            stripeCustomerId,
            email,
            amountCents,
            source,
            termsAccepted,
            billingAddressId: billingProfile.id,
            billingAddressVersion: billingProfile.version,
          });

          return json({
            payment_intent_id: intent.paymentIntentId,
            stripe_customer_id: intent.stripeCustomerId,
            amount_cents: intent.amountCents,
            light_amount: intent.lightAmount,
            wire_light_per_usd: intent.lightPerUsd,
            billing_config_version: intent.billingConfigVersion,
            status: intent.status,
            instructions: intent.instructions,
            billing_address: publicBillingAddress(billingProfile),
          });
        } catch (err) {
          if (err instanceof RequestValidationError) {
            return error(err.message, err.status);
          }
          if (err instanceof WireFundingError) {
            return error(err.message, err.status);
          }
          return error(
            err instanceof Error ? err.message : "Wire funding failed",
            500,
          );
        }
      },
    );
  }

  // POST /api/user/hosting/checkout — disabled legacy funding bridge.
  if (path === "/api/user/hosting/checkout" && method === "POST") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:hosting_checkout",
      async () => {
        try {
          await authenticate(request);
          await validateHostingCheckoutRequest(request);
          return error(
            "Legacy Checkout funding is disabled. Use Wallet Apple Pay / Google Pay funding.",
            410,
          );
        } catch (err) {
          if (err instanceof RequestValidationError) {
            return error(err.message, err.status);
          }
          return error(
            err instanceof Error ? err.message : "Unauthorized",
            401,
          );
        }
      },
    );
  }

  // GET /api/user/earnings — aggregate earnings across all owned apps
  // Returns: { total_earned_light, period_earned_light, total_withdrawn_light, withdrawable_light, by_app: [...], recent: [...] }
  if (path === "/api/user/earnings" && method === "GET") {
    try {
      const user = await authenticate(request);
      const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
        getSupabaseEnv();
      const headers = {
        "apikey": sbKey,
        "Authorization": `Bearer ${sbKey}`,
      };

      const url = new URL(request.url);
      const period = url.searchParams.get("period") || "30d";
      let periodDays = 30;
      if (period === "7d") periodDays = 7;
      else if (period === "90d") periodDays = 90;
      else if (period === "all") periodDays = 3650;

      const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000)
        .toISOString();

      const [periodRes, lifetimeRes, recentRes, payoutsRes, userBalanceRes] =
        await Promise.all(
          [
            fetch(
              `${sbUrl}/rest/v1/transfers?to_user_id=eq.${user.id}&created_at=gte.${cutoff}&select=amount_light,app_id,function_name,reason,created_at&order=created_at.asc&limit=10000`,
              { headers },
            ),
            fetch(
              `${sbUrl}/rest/v1/transfers?to_user_id=eq.${user.id}&select=amount_light`,
              { headers: { ...headers, "Prefer": "count=exact" } },
            ),
            fetch(
              `${sbUrl}/rest/v1/transfers?to_user_id=eq.${user.id}&select=amount_light,app_id,function_name,reason,created_at&order=created_at.desc&limit=10`,
              { headers },
            ),
            // Total withdrawals including held (for withdrawable calculation)
            fetch(
              `${sbUrl}/rest/v1/payouts?user_id=eq.${user.id}&status=in.(held,pending,processing,paid)&select=amount_light`,
              { headers },
            ),
            fetch(
              `${sbUrl}/rest/v1/users?id=eq.${user.id}&select=balance_light,deposit_balance_light,total_earned_light,earned_balance_light,auto_add_earnings_to_balance`,
              { headers },
            ),
          ],
        );

      if (!periodRes.ok || !lifetimeRes.ok || !recentRes.ok) {
        throw new Error("Failed to query transfers");
      }

      const periodTransfersRaw = await periodRes.json() as Array<{
        amount_light: number;
        app_id: string | null;
        function_name: string | null;
        reason: string;
        created_at: string;
      }>;
      const lifetimeTransfers = await lifetimeRes.json() as Array<
        { amount_light: number }
      >;
      const recentTransfersRaw = await recentRes.json() as Array<{
        amount_light: number;
        app_id: string | null;
        function_name: string | null;
        reason: string;
        created_at: string;
      }>;
      const userBalance = userBalanceRes.ok
        ? await readFirstJsonRow<
          EarningsBalanceRow
        >(
          userBalanceRes,
        )
        : null;
      const isEarningTransfer = (t: { reason?: string }) =>
        t.reason !== "withdrawal" && t.reason !== "withdrawal_refund";
      const periodTransfers = periodTransfersRaw.filter(isEarningTransfer);
      const recentTransfers = recentTransfersRaw.filter(isEarningTransfer);

      const transferTotalEarnedLight = lifetimeTransfers.reduce(
        (sum, t) => sum + t.amount_light,
        0,
      );
      const totalEarnedLight = userBalance?.total_earned_light ??
        transferTotalEarnedLight;
      const periodEarnedLight = periodTransfers.reduce(
        (sum, t) => sum + t.amount_light,
        0,
      );

      // Calculate total withdrawn and withdrawable
      let totalWithdrawnLight = 0;
      if (payoutsRes.ok) {
        const payouts = await payoutsRes.json() as Array<
          { amount_light: number }
        >;
        totalWithdrawnLight = payouts.reduce(
          (sum, p) => sum + p.amount_light,
          0,
        );
      }
      const earnedBalanceLight = userBalance?.earned_balance_light ?? Math.max(
        0,
        totalEarnedLight - totalWithdrawnLight,
      );
      const withdrawableLight = Math.min(
        earnedBalanceLight,
        Math.max(0, totalEarnedLight - totalWithdrawnLight),
      );

      // By-app breakdown
      const appMap = new Map<
        string,
        { earned_light: number; call_count: number }
      >();
      for (const t of periodTransfers) {
        const key = t.app_id || "unknown";
        const entry = appMap.get(key) || { earned_light: 0, call_count: 0 };
        entry.earned_light += t.amount_light;
        entry.call_count += 1;
        appMap.set(key, entry);
      }
      const byApp = Array.from(appMap.entries())
        .map(([app_id, data]) => ({ app_id, ...data }))
        .sort((a, b) => b.earned_light - a.earned_light);

      return json({
        total_earned_light: totalEarnedLight,
        balance_light: userBalance?.balance_light ?? 0,
        spendable_balance_light: userBalance?.balance_light ?? 0,
        deposit_balance_light: userBalance?.deposit_balance_light ?? 0,
        earned_balance_light: earnedBalanceLight,
        convertible_earnings_light: earnedBalanceLight,
        total_withdrawn_light: totalWithdrawnLight,
        withdrawable_light: withdrawableLight,
        auto_add_earnings_to_balance:
          userBalance?.auto_add_earnings_to_balance ?? false,
        period,
        period_earned_light: periodEarnedLight,
        period_transfers: periodTransfers.length,
        by_app: byApp,
        recent: recentTransfers.map((t) => ({
          amount_light: t.amount_light,
          app_id: t.app_id,
          function_name: t.function_name,
          reason: t.reason,
          created_at: t.created_at,
        })),
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : "Unauthorized", 401);
    }
  }

  // POST /api/user/earnings/convert-to-balance — convert creator earnings into spendable Light balance
  // Body: { amount_light: number, terms_accepted: true } or { all: true, terms_accepted: true }
  if (path === "/api/user/earnings/convert-to-balance" && method === "POST") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:earnings_convert",
      async () => {
        try {
          const user = await authenticate(request);
          const { amountLight, convertAll } =
            await validateEarningsConversionRequest(request);
          const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
            getSupabaseEnv();
          const sbHeaders = {
            "apikey": sbKey,
            "Authorization": `Bearer ${sbKey}`,
          };

          let targetAmount = amountLight;
          if (convertAll) {
            const userRes = await fetch(
              `${sbUrl}/rest/v1/users?id=eq.${user.id}&select=earned_balance_light`,
              { headers: sbHeaders },
            );
            if (!userRes.ok) throw new Error("Failed to read earnings");
            const userData = await readFirstJsonRow<
              { earned_balance_light: number | null }
            >(userRes);
            targetAmount = userData?.earned_balance_light ?? 0;
          }

          if (!targetAmount || targetAmount <= 0) {
            return error(
              "No creator earnings are available to add to balance",
              400,
            );
          }

          const rpcRes = await fetch(
            `${sbUrl}/rest/v1/rpc/convert_earnings_to_deposit`,
            {
              method: "POST",
              headers: {
                ...sbHeaders,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                p_user_id: user.id,
                p_amount_light: targetAmount,
                p_source: "manual",
                p_reference_table: "users",
                p_reference_id: user.id,
                p_metadata: { source: "api" },
              }),
            },
          );

          if (!rpcRes.ok) {
            const rpcErr = await rpcRes.text();
            if (rpcErr.includes("Conversion exceeds earnings")) {
              return error(
                "Conversion exceeds available creator earnings",
                400,
              );
            }
            return error("Failed to add earnings to balance", 500);
          }

          const rows = await readJsonRows<EarningsConversionRpcRow>(rpcRes);
          const conversion = rows[0];
          if (!conversion) {
            return error("Failed to add earnings to balance", 500);
          }

          return json({
            success: true,
            conversion_id: conversion.conversion_id,
            converted_light: conversion.converted_light,
            balance_light: conversion.balance_light,
            spendable_balance_light: conversion.balance_light,
            deposit_balance_light: conversion.deposit_balance_light,
            earned_balance_light: conversion.earned_balance_light,
            convertible_earnings_light: conversion.earned_balance_light,
          });
        } catch (err) {
          if (err instanceof RequestValidationError) {
            return error(err.message, err.status);
          }
          return error(
            err instanceof Error
              ? err.message
              : "Failed to add earnings to balance",
            500,
          );
        }
      },
    );
  }

  // PATCH /api/user/earnings/auto-add — toggle automatic conversion of future creator earnings
  if (path === "/api/user/earnings/auto-add" && method === "PATCH") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:earnings_auto_add",
      async () => {
        try {
          const user = await authenticate(request);
          const { enabled } = await validateEarningsAutoAddRequest(request);
          const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
            getSupabaseEnv();

          const updateRes = await fetch(
            `${sbUrl}/rest/v1/users?id=eq.${user.id}`,
            {
              method: "PATCH",
              headers: {
                "apikey": sbKey,
                "Authorization": `Bearer ${sbKey}`,
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
              },
              body: JSON.stringify({
                auto_add_earnings_to_balance: enabled,
              }),
            },
          );

          if (!updateRes.ok) {
            throw new Error("Failed to update earnings auto-add setting");
          }

          return json({
            success: true,
            auto_add_earnings_to_balance: enabled,
          });
        } catch (err) {
          if (err instanceof RequestValidationError) {
            return error(err.message, err.status);
          }
          return error(
            err instanceof Error
              ? err.message
              : "Failed to update earnings auto-add setting",
            500,
          );
        }
      },
    );
  }

  // ============================================
  // STRIPE CONNECT ENDPOINTS
  // ============================================

  // POST /api/user/connect/onboard — create or resume Stripe Connect onboarding
  // Returns: { onboarding_url: string, account_id: string }
  if (path === "/api/user/connect/onboard" && method === "POST") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:connect_onboard",
      async () => {
        try {
          const user = await authenticate(request);
          const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
            getSupabaseEnv();
          const { country } = await validateConnectOnboardRequest(request);

          // Get user's current connect state + email
          const userRes = await fetch(
            `${sbUrl}/rest/v1/users?id=eq.${user.id}&select=stripe_connect_account_id,email`,
            {
              headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` },
            },
          );
          if (!userRes.ok) throw new Error("Failed to read user");
          const userData = await readFirstJsonRow<
            StripeCustomerRow & { stripe_connect_account_id: string | null }
          >(userRes);

          const {
            createConnectedAccount,
            createOnboardingLink,
          } = await import("../services/stripe-connect.ts");

          let accountId = userData?.stripe_connect_account_id;

          // Create a new connected account if none exists
          if (!accountId) {
            const result = await createConnectedAccount(
              userData?.email || "",
              user.id,
              country,
            );
            accountId = result.account_id;

            // Save the account ID to DB
            await fetch(`${sbUrl}/rest/v1/users?id=eq.${user.id}`, {
              method: "PATCH",
              headers: {
                "apikey": sbKey,
                "Authorization": `Bearer ${sbKey}`,
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
              },
              body: JSON.stringify({ stripe_connect_account_id: accountId }),
            });
          }

          const BASE_URL = getEnv("BASE_URL");

          const link = await createOnboardingLink(
            accountId,
            `${BASE_URL}/wallet?connect=complete`,
            `${BASE_URL}/wallet?connect=refresh`,
          );

          return json({
            onboarding_url: link.url,
            account_id: accountId,
          });
        } catch (err) {
          if (err instanceof RequestValidationError) {
            return error(err.message, err.status);
          }
          const status = (err as Error & { status?: number }).status || 500;
          return error(
            err instanceof Error ? err.message : "Failed to start onboarding",
            status,
          );
        }
      },
    );
  }

  // GET /api/user/connect/status — check Stripe Connect onboarding status
  // Returns: { connected, onboarded, payouts_enabled, account_id, country, default_currency, withdrawable_earnings_light }
  if (path === "/api/user/connect/status" && method === "GET") {
    try {
      const user = await authenticate(request);
      const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
        getSupabaseEnv();
      const sbHeaders = { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` };

      const userRes = await fetch(
        `${sbUrl}/rest/v1/users?id=eq.${user.id}&select=stripe_connect_account_id,stripe_connect_onboarded,stripe_connect_payouts_enabled,total_earned_light,earned_balance_light`,
        { headers: sbHeaders },
      );
      if (!userRes.ok) throw new Error("Failed to read user");
      const userData = await readFirstJsonRow<StripeConnectStatusRow>(userRes);

      if (!userData?.stripe_connect_account_id) {
        return json({
          connected: false,
          onboarded: false,
          payouts_enabled: false,
          account_id: null,
          country: null,
          default_currency: null,
          withdrawable_earnings_light: 0,
        });
      }

      // Calculate withdrawable earnings = total earned - total withdrawn (incl. held)
      const payoutsRes = await fetch(
        `${sbUrl}/rest/v1/payouts?user_id=eq.${user.id}&status=in.(held,pending,processing,paid)&select=amount_light`,
        { headers: sbHeaders },
      );
      let totalWithdrawn = 0;
      if (payoutsRes.ok) {
        const payouts = await payoutsRes.json() as Array<
          { amount_light: number }
        >;
        totalWithdrawn = payouts.reduce((sum, p) => sum + p.amount_light, 0);
      }
      const lifetimeRemaining = Math.max(
        0,
        (userData.total_earned_light || 0) - totalWithdrawn,
      );
      const withdrawableEarnings = Math.min(
        userData.earned_balance_light ?? lifetimeRemaining,
        lifetimeRemaining,
      );

      // If already fully set up, return cached values + earnings
      if (
        userData.stripe_connect_onboarded &&
        userData.stripe_connect_payouts_enabled
      ) {
        // Still fetch account status for country/currency info
        let country: string | null = null;
        let defaultCurrency: string | null = null;
        try {
          const { getAccountStatus } = await import(
            "../services/stripe-connect.ts"
          );
          const connectStatus = await getAccountStatus(
            userData.stripe_connect_account_id,
          );
          country = connectStatus.country || null;
          defaultCurrency = connectStatus.default_currency || null;
        } catch { /* Stripe unavailable */ }

        return json({
          connected: true,
          onboarded: true,
          payouts_enabled: true,
          account_id: userData.stripe_connect_account_id,
          country: country,
          default_currency: defaultCurrency,
          is_cross_border: country !== null && country !== "US",
          withdrawable_earnings_light: withdrawableEarnings,
        });
      }

      // Otherwise refresh from Stripe API
      try {
        const { getAccountStatus } = await import(
          "../services/stripe-connect.ts"
        );
        const connectStatus = await getAccountStatus(
          userData.stripe_connect_account_id,
        );

        // Update cached status in DB if changed
        if (
          connectStatus.onboarded !== userData.stripe_connect_onboarded ||
          connectStatus.payouts_enabled !==
            userData.stripe_connect_payouts_enabled
        ) {
          await fetch(`${sbUrl}/rest/v1/users?id=eq.${user.id}`, {
            method: "PATCH",
            headers: {
              ...sbHeaders,
              "Content-Type": "application/json",
              "Prefer": "return=minimal",
            },
            body: JSON.stringify({
              stripe_connect_onboarded: connectStatus.onboarded,
              stripe_connect_payouts_enabled: connectStatus.payouts_enabled,
            }),
          });
        }

        return json({
          connected: true,
          onboarded: connectStatus.onboarded,
          payouts_enabled: connectStatus.payouts_enabled,
          details_submitted: connectStatus.details_submitted,
          account_id: userData.stripe_connect_account_id,
          country: connectStatus.country || null,
          default_currency: connectStatus.default_currency || null,
          is_cross_border: connectStatus.country !== undefined &&
            connectStatus.country !== "US",
          withdrawable_earnings_light: withdrawableEarnings,
        });
      } catch (stripeErr) {
        // Stripe unavailable — return cached values
        return json({
          connected: true,
          onboarded: userData.stripe_connect_onboarded,
          payouts_enabled: userData.stripe_connect_payouts_enabled,
          account_id: userData.stripe_connect_account_id,
          country: null,
          default_currency: null,
          withdrawable_earnings_light: withdrawableEarnings,
        });
      }
    } catch (err) {
      const status = (err as Error & { status?: number }).status || 500;
      return error(
        err instanceof Error ? err.message : "Failed to check connect status",
        status,
      );
    }
  }

  // POST /api/user/connect/withdraw — request a withdrawal to connected bank
  // Body: { amount_light: number } (minimum MIN_WITHDRAWAL_LIGHT)
  // Only earned funds (tool_call, page_view, marketplace_sale) can be withdrawn — deposits cannot.
  // Withdrawals are scheduled into the next eligible monthly payout run.
  // Platform fee is already taken on internal earning transfers, not on withdrawal.
  if (path === "/api/user/connect/withdraw" && method === "POST") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:connect_withdraw",
      async () => {
        try {
          const user = await authenticate(request);
          const { amountLight } = await validateWithdrawalRequest(request);

          const {
            estimatePayoutFee,
            getAccountStatus,
          } = await import("../services/stripe-connect.ts");
          const {
            buildPayoutPolicyMessage,
            calculateNextPayoutSchedule,
          } = await import("../services/payout-policy.ts");

          const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
            getSupabaseEnv();
          const sbHeaders = {
            "apikey": sbKey,
            "Authorization": `Bearer ${sbKey}`,
          };

          // Verify user has a connected, onboarded account with payouts enabled
          const userRes = await fetch(
            `${sbUrl}/rest/v1/users?id=eq.${user.id}&select=stripe_connect_account_id,stripe_connect_onboarded,stripe_connect_payouts_enabled,balance_light,escrow_light,total_earned_light,earned_balance_light`,
            { headers: sbHeaders },
          );
          if (!userRes.ok) throw new Error("Failed to read user");
          const userData = await readFirstJsonRow<StripeConnectWithdrawRow>(
            userRes,
          );

          if (
            !userData?.stripe_connect_account_id ||
            !userData?.stripe_connect_payouts_enabled
          ) {
            return error(
              "Connect your bank account first. Use the Wallet page to complete Stripe onboarding.",
              400,
            );
          }

          // Earnings-only withdrawal check (defense-in-depth — RPC also validates)
          const payoutsRes = await fetch(
            `${sbUrl}/rest/v1/payouts?user_id=eq.${user.id}&status=in.(held,pending,processing,paid)&select=amount_light`,
            { headers: sbHeaders },
          );
          let totalWithdrawn = 0;
          if (payoutsRes.ok) {
            const payouts = await payoutsRes.json() as Array<
              { amount_light: number }
            >;
            totalWithdrawn = payouts.reduce(
              (sum, p) => sum + p.amount_light,
              0,
            );
          }
          const lifetimeRemaining = Math.max(
            0,
            (userData.total_earned_light || 0) - totalWithdrawn,
          );
          const withdrawableEarnings = Math.min(
            userData.earned_balance_light ?? lifetimeRemaining,
            lifetimeRemaining,
          );

          if (withdrawableEarnings < amountLight) {
            return error(
              `Only creator earnings can be paid out (purchased Light cannot be cashed out). ` +
                `You have ${
                  formatLight(withdrawableEarnings)
                } in payout-eligible earnings.`,
              400,
            );
          }

          const billingConfig = await getBillingConfig();

          // Detect cross-border for Stripe fee estimation
          let isCrossBorder = false;
          try {
            const connectStatus = await getAccountStatus(
              userData.stripe_connect_account_id,
            );
            isCrossBorder = connectStatus.country !== undefined &&
              connectStatus.country !== "US";
          } catch { /* Stripe unavailable — assume domestic */ }

          // Calculate Stripe fee estimate (Stripe fees are in USD cents)
          const estimate = estimatePayoutFee(
            amountLight,
            isCrossBorder,
            billingConfig.payoutLightPerUsd,
          );

          const payoutSchedule = calculateNextPayoutSchedule(new Date());

          // Atomic debit + held payout record creation + earnings validation.
          // Balance is debited immediately; Stripe transfer happens in the
          // scheduled monthly payout run.
          const rpcRes = await fetch(
            `${sbUrl}/rest/v1/rpc/create_payout_record`,
            {
              method: "POST",
              headers: {
                ...sbHeaders,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                p_user_id: user.id,
                p_amount_light: amountLight,
                p_gross_cents: estimate.gross_usd_cents,
                p_stripe_fee_cents: estimate.stripe_fee_cents,
                p_fee_estimate_cents: estimate.fee_estimate_cents,
                p_net_cents: estimate.net_cents,
                p_light_per_usd_snapshot: billingConfig.payoutLightPerUsd,
                p_billing_config_version: billingConfig.version,
                p_release_at: payoutSchedule.releaseAt.toISOString(),
                p_scheduled_payout_date: payoutSchedule.scheduledPayoutDate,
                p_payout_cutoff_at: payoutSchedule.payoutCutoffAt
                  .toISOString(),
                p_payout_policy_version: payoutSchedule.payoutPolicyVersion,
              }),
            },
          );

          if (!rpcRes.ok) {
            const rpcErr = await rpcRes.text();
            console.error("[CONNECT] create_payout_record RPC failed:", rpcErr);
            if (rpcErr.includes("Insufficient")) {
              return error("Insufficient balance for payout request", 400);
            }
            if (rpcErr.includes("exceeds earnings")) {
              return error(
                "Payout request exceeds earned funds. Only creator earnings can be paid out; purchased Light cannot be cashed out.",
                400,
              );
            }
            return error("Failed to create payout record", 500);
          }

          const payoutId = await rpcRes.json();

          const feeBreakdown = isCrossBorder
            ? `Stripe fee: $${
              (estimate.stripe_fee_cents / 100).toFixed(2)
            } (incl. 2% FX)`
            : `Stripe fee: $${(estimate.stripe_fee_cents / 100).toFixed(2)}`;

          return json({
            success: true,
            payout_id: payoutId,
            amount_light: amountLight,
            gross_usd_cents: estimate.gross_usd_cents,
            estimated_stripe_fee_cents: estimate.stripe_fee_cents,
            fee_pass_through_cents: estimate.fee_estimate_cents,
            estimated_net_cents: estimate.net_cents,
            light_per_usd_snapshot: billingConfig.payoutLightPerUsd,
            billing_config_version: billingConfig.version,
            is_cross_border: isCrossBorder,
            status: "held",
            release_at: payoutSchedule.releaseAt.toISOString(),
            scheduled_payout_date: payoutSchedule.scheduledPayoutDate,
            payout_cutoff_at: payoutSchedule.payoutCutoffAt.toISOString(),
            payout_policy_version: payoutSchedule.payoutPolicyVersion,
            request_cutoff_days: payoutSchedule.requestCutoffDays,
            message:
              `Payout request for ${formatLight(amountLight)} submitted. ` +
              `${feeBreakdown}. ` +
              `Estimated bank deposit: ~$${
                (estimate.net_cents / 100).toFixed(2)
              }. ` +
              `Stripe fees are deducted from payout proceeds. ` +
              buildPayoutPolicyMessage(payoutSchedule),
          });
        } catch (err) {
          if (err instanceof RequestValidationError) {
            return error(err.message, err.status);
          }
          const status = (err as Error & { status?: number }).status || 500;
          return error(
            err instanceof Error ? err.message : "Payout request failed",
            status,
          );
        }
      },
    );
  }

  // GET /api/user/connect/liability — retired global liability view.
  // Use /api/admin/payouts/reconciliation with the service-role admin token.
  if (path === "/api/user/connect/liability" && method === "GET") {
    return error(
      "Global payout liability is available only through admin reconciliation.",
      403,
    );
  }

  // GET /api/user/connect/payouts — payout history
  if (path === "/api/user/connect/payouts" && method === "GET") {
    try {
      const user = await authenticate(request);
      const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
        getSupabaseEnv();
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);

      const payoutsRes = await fetch(
        `${sbUrl}/rest/v1/payouts?user_id=eq.${user.id}&select=*&order=created_at.desc&limit=${
          Math.min(limit, 100)
        }`,
        { headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` } },
      );

      if (!payoutsRes.ok) throw new Error("Failed to query payouts");
      const payouts = await payoutsRes.json();

      return json({ payouts });
    } catch (err) {
      return error(
        err instanceof Error ? err.message : "Failed to get payouts",
        500,
      );
    }
  }

  // ============================================
  // MARKETPLACE ENDPOINTS
  // ============================================

  // GET /api/marketplace/listing/:appId — listing + active bids for an app
  if (path.startsWith("/api/marketplace/listing/") && method === "GET") {
    try {
      const appId = path.replace("/api/marketplace/listing/", "");
      if (!appId) return error("Missing app ID", 400);
      const { getListing } = await import("../services/marketplace.ts");
      const listing = await getListing(appId, userId);
      return json(listing);
    } catch (err) {
      const status = (err as Error & { status?: number }).status || 500;
      return error(
        err instanceof Error ? err.message : "Failed to get listing",
        status,
      );
    }
  }

  // POST /api/marketplace/bid — place a bid
  if (path === "/api/marketplace/bid" && method === "POST") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:marketplace_bid",
      async () => {
        try {
          const body = await validateMarketplaceBidRequest(request);
          const { placeBid } = await import("../services/marketplace.ts");
          const result = await placeBid(
            userId,
            body.appId,
            body.amountLight,
            body.message,
            body.expiresInHours,
          );
          return json(result);
        } catch (err) {
          const status = (err as Error & { status?: number }).status || 500;
          return error(
            err instanceof Error ? err.message : "Failed to place bid",
            status,
          );
        }
      },
    );
  }

  // POST /api/marketplace/ask — set ask price
  if (path === "/api/marketplace/ask" && method === "POST") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:marketplace_ask",
      async () => {
        try {
          const body = await validateMarketplaceAskRequest(request);
          const { setAskPrice } = await import("../services/marketplace.ts");
          const result = await setAskPrice(
            userId,
            body.appId,
            body.priceLight,
            body.floorLight,
            body.instantBuy,
            body.note,
          );
          return json(result);
        } catch (err) {
          const status = (err as Error & { status?: number }).status || 500;
          return error(
            err instanceof Error ? err.message : "Failed to set ask price",
            status,
          );
        }
      },
    );
  }

  // POST /api/marketplace/accept — accept a bid
  if (path === "/api/marketplace/accept" && method === "POST") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:marketplace_accept",
      async () => {
        try {
          const body = await validateMarketplaceBidActionRequest(request);
          const { acceptBid } = await import("../services/marketplace.ts");
          const result = await acceptBid(userId, body.bidId);
          return json(result);
        } catch (err) {
          const status = (err as Error & { status?: number }).status || 500;
          return error(
            err instanceof Error ? err.message : "Failed to accept bid",
            status,
          );
        }
      },
    );
  }

  // POST /api/marketplace/reject — reject a bid
  if (path === "/api/marketplace/reject" && method === "POST") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:marketplace_reject",
      async () => {
        try {
          const body = await validateMarketplaceBidActionRequest(request);
          const { rejectBid } = await import("../services/marketplace.ts");
          await rejectBid(userId, body.bidId);
          return json({
            success: true,
            message: "Bid rejected. Escrow refunded to bidder.",
          });
        } catch (err) {
          const status = (err as Error & { status?: number }).status || 500;
          return error(
            err instanceof Error ? err.message : "Failed to reject bid",
            status,
          );
        }
      },
    );
  }

  // POST /api/marketplace/cancel — cancel own bid
  if (path === "/api/marketplace/cancel" && method === "POST") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:marketplace_cancel",
      async () => {
        try {
          const body = await validateMarketplaceBidActionRequest(request);
          const { cancelBid } = await import("../services/marketplace.ts");
          await cancelBid(userId, body.bidId);
          return json({
            success: true,
            message: "Bid cancelled. Escrow refunded.",
          });
        } catch (err) {
          const status = (err as Error & { status?: number }).status || 500;
          return error(
            err instanceof Error ? err.message : "Failed to cancel bid",
            status,
          );
        }
      },
    );
  }

  // POST /api/marketplace/acquire — instant acquisition
  // /api/marketplace/buy remains as a compatibility alias for existing clients.
  if (
    (path === "/api/marketplace/acquire" || path === "/api/marketplace/buy") &&
    method === "POST"
  ) {
    return withSensitiveRouteRateLimit(
      userId,
      "user:marketplace_buy",
      async () => {
        try {
          const body = await validateMarketplaceBuyRequest(request);
          const { buyNow } = await import("../services/marketplace.ts");
          const result = await buyNow(userId, body.appId);
          return json(result);
        } catch (err) {
          const status = (err as Error & { status?: number }).status || 500;
          return error(
            err instanceof Error ? err.message : "Failed to acquire app",
            status,
          );
        }
      },
    );
  }

  // GET /api/marketplace/offers — incoming + outgoing offers
  if (path === "/api/marketplace/offers" && method === "GET") {
    try {
      const appId = url.searchParams.get("app_id") || undefined;
      const { getOffers } = await import("../services/marketplace.ts");
      const offers = await getOffers(userId, appId);
      return json(offers);
    } catch (err) {
      const status = (err as Error & { status?: number }).status || 500;
      return error(
        err instanceof Error ? err.message : "Failed to get offers",
        status,
      );
    }
  }

  // GET /api/marketplace/history — sale history
  if (path === "/api/marketplace/history" && method === "GET") {
    try {
      const appId = url.searchParams.get("app_id") || undefined;
      const { getHistory } = await import("../services/marketplace.ts");
      const history = await getHistory(appId, userId);
      return json(history);
    } catch (err) {
      const status = (err as Error & { status?: number }).status || 500;
      return error(
        err instanceof Error ? err.message : "Failed to get history",
        status,
      );
    }
  }

  // PATCH /api/marketplace/metrics-visibility — toggle show_metrics on a listing (owner only)
  if (path === "/api/marketplace/metrics-visibility" && method === "PATCH") {
    return withSensitiveRouteRateLimit(
      userId,
      "user:marketplace_metrics_visibility",
      async () => {
        try {
          const body = await validateMarketplaceMetricsVisibilityRequest(
            request,
          );
          const appId = body.appId;
          const showMetrics = body.showMetrics;

          const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
          const headers: Record<string, string> = {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          };

          // Verify ownership
          const appCheck = await fetch(
            `${SUPABASE_URL}/rest/v1/apps?id=eq.${appId}&owner_id=eq.${userId}&select=id`,
            { headers },
          );
          const appRows = appCheck.ok
            ? await readJsonRows<{ id: string }>(appCheck)
            : [];
          if (appRows.length === 0) {
            return error("App not found or not owned by you", 403);
          }

          // Update listing
          const updateRes = await fetch(
            `${SUPABASE_URL}/rest/v1/app_listings?app_id=eq.${appId}`,
            {
              method: "PATCH",
              headers: {
                ...headers,
                "Content-Type": "application/json",
                "Prefer": "return=representation",
              },
              body: JSON.stringify({ show_metrics: showMetrics }),
            },
          );

          if (!updateRes.ok) {
            // Listing may not exist yet — create it
            const createRes = await fetch(
              `${SUPABASE_URL}/rest/v1/app_listings`,
              {
                method: "POST",
                headers: {
                  ...headers,
                  "Content-Type": "application/json",
                  "Prefer": "return=representation",
                },
                body: JSON.stringify({
                  app_id: appId,
                  owner_id: userId,
                  show_metrics: showMetrics,
                }),
              },
            );
            if (!createRes.ok) {
              return error("Failed to update metrics visibility", 500);
            }
          }

          return json({ app_id: appId, show_metrics: showMetrics });
        } catch (err) {
          return error(
            err instanceof Error
              ? err.message
              : "Failed to update metrics visibility",
            500,
          );
        }
      },
    );
  }

  // GET /api/marketplace/metrics/:appId — get app metrics (if show_metrics enabled or owner)
  if (path.startsWith("/api/marketplace/metrics/") && method === "GET") {
    try {
      const appId = path.replace("/api/marketplace/metrics/", "");
      if (!appId) return error("Missing app ID", 400);

      const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
      const headers: Record<string, string> = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      };

      // Check if metrics are enabled or caller is owner
      const [listingRes, appRes] = await Promise.all([
        fetch(
          `${SUPABASE_URL}/rest/v1/app_listings?app_id=eq.${appId}&select=show_metrics`,
          { headers },
        ),
        fetch(
          `${SUPABASE_URL}/rest/v1/apps?id=eq.${appId}&select=owner_id`,
          { headers },
        ),
      ]);

      const listings = listingRes.ok
        ? await readJsonRows<{ show_metrics: boolean | null }>(listingRes)
        : [];
      const apps = appRes.ok
        ? await readJsonRows<{ owner_id: string }>(appRes)
        : [];
      const isOwner = apps[0]?.owner_id === userId;
      const metricsEnabled = listings[0]?.show_metrics === true;

      if (!isOwner && !metricsEnabled) {
        return error("Metrics are not enabled for this app", 403);
      }

      const { getAppMetrics } = await import("../services/marketplace.ts");
      const metrics = await getAppMetrics(appId);
      return json(metrics);
    } catch (err) {
      return error(
        err instanceof Error ? err.message : "Failed to get metrics",
        500,
      );
    }
  }

  // GET /api/marketplace/receipt/:receiptId — lookup a sale or bid receipt for an involved user
  if (path.startsWith("/api/marketplace/receipt/") && method === "GET") {
    try {
      const receiptId = path.replace("/api/marketplace/receipt/", "");
      if (!receiptId) return error("Missing receipt ID", 400);

      const { getMarketplaceReceipt } = await import(
        "../services/marketplace.ts"
      );
      const receipt = await getMarketplaceReceipt(userId, receiptId);
      return json(receipt);
    } catch (err) {
      const status = (err as Error & { status?: number }).status || 500;
      return error(
        err instanceof Error ? err.message : "Failed to get receipt",
        status,
      );
    }
  }

  return error("User endpoint not found", 404);
}

// ============================================
// Stripe webhook signature verification
// ============================================

/**
 * Verify a Stripe webhook signature using HMAC-SHA256.
 * This avoids needing the Stripe SDK — just raw crypto.
 */
async function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  try {
    // Parse the signature header: t=timestamp,v1=signature
    const parts = signatureHeader.split(",").reduce((acc, part) => {
      const [key, value] = part.split("=");
      acc[key] = value;
      return acc;
    }, {} as Record<string, string>);

    const timestamp = parts["t"];
    const expectedSig = parts["v1"];

    if (!timestamp || !expectedSig) return false;

    // Check timestamp tolerance (5 minutes)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

    // Compute expected signature
    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(signedPayload),
    );
    const computedSig = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return computedSig === expectedSig;
  } catch (err) {
    console.error("[STRIPE] Signature verification failed:", err);
    return false;
  }
}

// Legacy aliases for backward compatibility during migration
export async function getUserPlatformSupabase(userId: string) {
  const configs = await listSupabaseConfigs(userId);
  const first = configs[0];
  return {
    configured: !!first,
    url: first?.supabase_url || null,
    has_anon_key: !!first,
    has_service_key: first?.has_service_key || false,
  };
}

// ============================================
// Supabase Management API OAuth helpers
// ============================================

/**
 * Get a valid Supabase Management API access token for the user.
 * Automatically refreshes if expired.
 * Returns null if user hasn't connected their Supabase account.
 */
async function getSupabaseMgmtToken(userId: string): Promise<string | null> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_supabase_oauth?user_id=eq.${userId}&select=*`,
    {
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );

  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const row = rows[0];
  const accessToken = await decryptEnvVar(row.access_token_encrypted);
  const refreshToken = await decryptEnvVar(row.refresh_token_encrypted);
  const expiresAt = new Date(row.token_expires_at);

  // If token is still valid (with 5 min buffer), use it
  if (expiresAt.getTime() > Date.now() + 5 * 60 * 1000) {
    return accessToken;
  }

  // Token expired — refresh it
  const clientId = getEnv("SUPABASE_MGMT_OAUTH_CLIENT_ID");
  const clientSecret = getEnv("SUPABASE_MGMT_OAUTH_CLIENT_SECRET");

  const tokenRes = await fetch("https://api.supabase.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!tokenRes.ok) {
    console.error("Supabase token refresh failed:", await tokenRes.text());
    // Token revoked or invalid — clean up
    await fetch(
      `${SUPABASE_URL}/rest/v1/user_supabase_oauth?user_id=eq.${userId}`,
      {
        method: "DELETE",
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    return null;
  }

  const tokens = await tokenRes.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  // Update stored tokens
  const encAccess = await encryptEnvVar(tokens.access_token);
  const encRefresh = await encryptEnvVar(tokens.refresh_token);
  const newExpiry = new Date(Date.now() + tokens.expires_in * 1000)
    .toISOString();

  await fetch(
    `${SUPABASE_URL}/rest/v1/user_supabase_oauth?user_id=eq.${userId}`,
    {
      method: "PATCH",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        access_token_encrypted: encAccess,
        refresh_token_encrypted: encRefresh,
        token_expires_at: newExpiry,
        updated_at: new Date().toISOString(),
      }),
    },
  );

  return tokens.access_token;
}

/**
 * Generate the HTML page returned in the OAuth callback popup.
 * On success: sends postMessage to parent window and closes.
 * On failure: shows error message with close button.
 */
function getOAuthCallbackHtml(success: boolean, errorMessage: string): string {
  if (success) {
    return `<!DOCTYPE html><html><head><title>Connected</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5;}
.card{text-align:center;padding:40px;border-radius:12px;background:#171717;border:1px solid #262626;}
.check{font-size:48px;margin-bottom:16px;}
h2{margin:0 0 8px;font-size:20px;}
p{color:#a3a3a3;margin:0;font-size:14px;}</style></head>
<body><div class="card"><div class="check">&#10003;</div><h2>Supabase Connected</h2><p>This window will close automatically...</p></div>
<script>
if(window.opener){window.opener.postMessage({type:'supabase-oauth-success'},'*');}
setTimeout(function(){window.close();},1500);
</script></body></html>`;
  }

  return `<!DOCTYPE html><html><head><title>Error</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5;}
.card{text-align:center;padding:40px;border-radius:12px;background:#171717;border:1px solid #262626;}
.x{font-size:48px;margin-bottom:16px;color:#ef4444;}
h2{margin:0 0 8px;font-size:20px;}
p{color:#a3a3a3;margin:0 0 20px;font-size:14px;}
button{background:#262626;color:#e5e5e5;border:1px solid #404040;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;}</style></head>
<body><div class="card"><div class="x">&#10007;</div><h2>Connection Failed</h2><p>${errorMessage}</p><button onclick="window.close()">Close</button></div>
</body></html>`;
}

// ============================================
// Helper: Check if user has access to a private app
// Used by MCP handlers for runtime permission enforcement
//
// Logic:
// - Owner always has full access (returns null = no restrictions)
// - For non-owners on private apps: returns Set of allowed function names
// - Empty set means user has no granted permissions (denied by default)
// - null means no restrictions (owner, or non-private app)
// ============================================

import type { PermissionRow } from "../../shared/types/index.ts";
import { getPermissionCache } from "../services/permission-cache.ts";

/** Result of getPermissionsForUser — includes constraint rows for runtime enforcement */
export interface PermissionsResult {
  allowed: Set<string>;
  /** Raw permission rows with constraint data (for IP/time/budget/expiry checks) */
  rows: PermissionRow[];
}

export async function getPermissionsForUser(
  callerUserId: string,
  appId: string,
  appOwnerId: string,
  appVisibility: string,
  appSlug: string,
): Promise<PermissionsResult | null> {
  // Owner always has full access
  if (callerUserId === appOwnerId) {
    return null; // No restrictions
  }

  // Published and unlisted apps: open to all authenticated users
  if (appVisibility === "public" || appVisibility === "unlisted") {
    return null; // No restrictions
  }

  // Check permission cache first
  const cache = getPermissionCache();
  const cached = cache.get(callerUserId, appId);
  if (cached) {
    return { allowed: cached.allowed, rows: cached.rows };
  }

  // Cache miss: fetch from Supabase
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/user_app_permissions?granted_to_user_id=eq.${callerUserId}&app_id=eq.${appId}&select=function_name,allowed,allowed_ips,time_window,budget_limit,budget_used,budget_period,expires_at,allowed_args,created_at,updated_at,granted_by_user_id,app_id,granted_to_user_id`,
    {
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );

  if (!response.ok) {
    console.error("Failed to fetch user permissions:", await response.text());
    return { allowed: new Set<string>(), rows: [] }; // On error, deny access for safety
  }

  const rows = await response.json() as PermissionRow[];
  logLegacyPermissionNameCompatibility({
    surface: "runtime_permission_fetch",
    appId,
    appSlug,
    actorUserId: callerUserId,
    ownerUserId: appOwnerId,
    rows,
  });

  // If no permission rows exist, this user has no access to this private app
  if (rows.length === 0) {
    // Cache the empty result too — prevents repeated DB calls for unauthorized users
    cache.set(callerUserId, appId, new Set<string>(), []);
    return { allowed: new Set<string>(), rows: [] };
  }

  const allowed = buildAllowedPermissionSet(appSlug, rows);

  // Store in cache
  cache.set(callerUserId, appId, allowed, rows);

  return { allowed, rows };
}
