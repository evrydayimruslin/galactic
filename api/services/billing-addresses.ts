import { getEnv } from "../lib/env.ts";

export interface BillingAddressInput {
  name?: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

export interface UserBillingAddressProfile extends BillingAddressInput {
  id: string;
  userId: string;
  version: number;
  isCurrent: boolean;
  source: string;
  stripeCustomerId?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserBillingAddressRow {
  id: string;
  user_id: string;
  version: number;
  is_current: boolean;
  name?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  state?: string | null;
  postal_code: string;
  country: string;
  source: string;
  stripe_customer_id?: string | null;
  created_at: string;
  updated_at: string;
}

function dbHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

function rpcUrl(name: string): string {
  return `${getEnv("SUPABASE_URL")}/rest/v1/rpc/${name}`;
}

function tableUrl(table: string): string {
  return `${getEnv("SUPABASE_URL")}/rest/v1/${table}`;
}

function normalizeRow(row: UserBillingAddressRow): UserBillingAddressProfile {
  return {
    id: row.id,
    userId: row.user_id,
    version: row.version,
    isCurrent: row.is_current,
    name: row.name || undefined,
    line1: row.line1,
    line2: row.line2 || undefined,
    city: row.city,
    state: row.state || undefined,
    postalCode: row.postal_code,
    country: row.country,
    source: row.source,
    stripeCustomerId: row.stripe_customer_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function publicBillingAddress(
  profile: UserBillingAddressProfile | null,
): Record<string, unknown> | null {
  if (!profile) return null;
  return {
    id: profile.id,
    version: profile.version,
    name: profile.name ?? null,
    line1: profile.line1,
    line2: profile.line2 ?? null,
    city: profile.city,
    state: profile.state ?? null,
    postal_code: profile.postalCode,
    country: profile.country,
    source: profile.source,
    updated_at: profile.updatedAt,
  };
}

export async function getCurrentBillingAddress(
  userId: string,
): Promise<UserBillingAddressProfile | null> {
  const url = `${tableUrl("user_billing_addresses")}?user_id=eq.${
    encodeURIComponent(userId)
  }&is_current=eq.true&select=*&order=version.desc&limit=1`;
  const res = await fetch(url, { headers: dbHeaders() });
  if (!res.ok) {
    throw new Error(`Failed to read billing address: ${await res.text()}`);
  }
  const rows = await res.json() as UserBillingAddressRow[];
  return rows[0] ? normalizeRow(rows[0]) : null;
}

export async function hasCurrentBillingAddress(
  userId: string,
): Promise<boolean> {
  const url = `${tableUrl("user_billing_addresses")}?user_id=eq.${
    encodeURIComponent(userId)
  }&is_current=eq.true&select=id&limit=1`;
  const res = await fetch(url, { headers: dbHeaders() });
  if (!res.ok) {
    throw new Error(`Failed to verify billing address: ${await res.text()}`);
  }
  const rows = await res.json() as Array<{ id: string }>;
  return rows.length > 0;
}

export async function upsertCurrentBillingAddress(input: {
  userId: string;
  address: BillingAddressInput;
  source: "manual" | "wallet_funding" | "wire_funding" | "stripe_customer";
  stripeCustomerId?: string | null;
}): Promise<UserBillingAddressProfile> {
  const res = await fetch(rpcUrl("upsert_current_user_billing_address"), {
    method: "POST",
    headers: dbHeaders(),
    body: JSON.stringify({
      p_user_id: input.userId,
      p_name: input.address.name || null,
      p_line1: input.address.line1,
      p_line2: input.address.line2 || null,
      p_city: input.address.city,
      p_state: input.address.state || null,
      p_postal_code: input.address.postalCode,
      p_country: input.address.country,
      p_source: input.source,
      p_stripe_customer_id: input.stripeCustomerId || null,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to save billing address: ${await res.text()}`);
  }
  const payload = await res.json() as
    | UserBillingAddressRow
    | UserBillingAddressRow[];
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (!row) throw new Error("Billing address upsert returned no row");
  return normalizeRow(row);
}

export async function updateStripeCustomerBillingAddress(input: {
  stripeSecretKey: string;
  stripeCustomerId: string;
  profile: UserBillingAddressProfile;
}): Promise<void> {
  const params = new URLSearchParams({
    "address[line1]": input.profile.line1,
    "address[city]": input.profile.city,
    "address[postal_code]": input.profile.postalCode,
    "address[country]": input.profile.country,
    "metadata[ultralight_billing_address_id]": input.profile.id,
    "metadata[ultralight_billing_address_version]": String(
      input.profile.version,
    ),
  });

  if (input.profile.name) params.set("name", input.profile.name);
  if (input.profile.line2) params.set("address[line2]", input.profile.line2);
  if (input.profile.state) params.set("address[state]", input.profile.state);

  const res = await fetch(
    `https://api.stripe.com/v1/customers/${
      encodeURIComponent(input.stripeCustomerId)
    }`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${input.stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );

  if (!res.ok) {
    throw new Error(
      `Failed to update Stripe customer address: ${await res.text()}`,
    );
  }
}
