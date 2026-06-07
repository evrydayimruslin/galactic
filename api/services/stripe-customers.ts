import type { BillingAddressInput } from "./billing-addresses.ts";
import {
  getCurrentBillingAddress,
  updateStripeCustomerBillingAddress,
  upsertCurrentBillingAddress,
  type UserBillingAddressProfile,
} from "./billing-addresses.ts";
import { RequestValidationError } from "./request-validation.ts";
import { getSupabaseEnv } from "./user-supabase-configs.ts";

interface StripeCustomerRow {
  stripe_customer_id: string | null;
  email: string | null;
}

async function readJsonRows<T>(response: Response): Promise<T[]> {
  const payload = await response.json() as unknown;
  return Array.isArray(payload) ? payload as T[] : [];
}

export async function getOrCreateStripeCustomerForUser(
  userId: string,
  stripeSecretKey: string,
): Promise<{ stripeCustomerId: string; email: string | null }> {
  const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
    getSupabaseEnv();
  const userDataRes = await fetch(
    `${sbUrl}/rest/v1/users?id=eq.${
      encodeURIComponent(userId)
    }&select=stripe_customer_id,email`,
    {
      headers: {
        "apikey": sbKey,
        "Authorization": `Bearer ${sbKey}`,
      },
    },
  );
  if (!userDataRes.ok) {
    throw new Error("Failed to read user");
  }
  const [userData] = await readJsonRows<StripeCustomerRow>(userDataRes);
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

  await fetch(`${sbUrl}/rest/v1/users?id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: {
      "apikey": sbKey,
      "Authorization": `Bearer ${sbKey}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({ stripe_customer_id: stripeCustomerId }),
  });

  return { stripeCustomerId, email };
}

export async function ensureBillingAddressForFunding(input: {
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
    console.error("[STRIPE] Failed to sync billing address:", err);
    throw new Error("Failed to update payment profile billing address");
  }

  return profile;
}
