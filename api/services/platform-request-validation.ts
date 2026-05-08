import { formatLight, MIN_WITHDRAWAL_LIGHT } from "../../shared/types/index.ts";
import { getEnv } from "../lib/env.ts";
import { getBillingConfig } from "./billing-config.ts";
import {
  ensurePlainObject,
  normalizeOptionalString,
  normalizeRequiredString,
  readJsonObject,
  RequestValidationError,
} from "./request-validation.ts";
import type { BillingAddressInput } from "./billing-addresses.ts";

const ALLOWED_CHECKOUT_SOURCES = new Set(["web", "desktop"]);
const ALLOWED_UPLOAD_VISIBILITIES = new Set(["private", "unlisted", "public"]);
const ALLOWED_UPLOAD_APP_TYPES = new Set(["mcp", "skill"]);
const ALLOWED_PROGRAMMATIC_APP_TYPES = new Set(["mcp"]);
const MAX_HOSTING_CHECKOUT_CENTS = 500_000;
const MAX_UPLOAD_NAME_LENGTH = 120;
const MAX_UPLOAD_DESCRIPTION_LENGTH = 5_000;
const MAX_UPLOAD_SLUG_LENGTH = 80;
const MAX_FUNCTIONS_ENTRY_LENGTH = 120;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPABASE_PROJECT_REF_REGEX = /^[a-z0-9-]{6,64}$/;
const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/;
const APP_SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const FUNCTIONS_ENTRY_REGEX = /^[A-Za-z0-9._-]+\.(ts|tsx|js|jsx)$/;

export interface ValidatedSupabaseOauthConnectPayload {
  projectRef: string;
  appId?: string;
}

export interface ValidatedAppSupabaseConfigPayload {
  configId: string | null;
}

export interface ValidatedHostingCheckoutPayload {
  amountCents: number;
  source: "web" | "desktop";
}

export interface ValidatedWalletFundingPayload {
  amountCents: number;
  source: "web" | "desktop";
  termsAccepted: true;
  billingAddress?: BillingAddressInput;
}

export interface ValidatedWireFundingPayload {
  amountCents: number;
  source: "web" | "desktop";
  termsAccepted: true;
  billingAddress?: BillingAddressInput;
}

export interface ValidatedBillingAddressPayload {
  billingAddress: BillingAddressInput;
}

export interface ValidatedConnectOnboardPayload {
  country: string;
}

export interface ValidatedWithdrawalPayload {
  amountLight: number;
  termsAccepted: true;
}

export interface ValidatedEarningsConversionPayload {
  amountLight: number | null;
  convertAll: boolean;
  termsAccepted: true;
}

export interface ValidatedEarningsAutoAddPayload {
  enabled: boolean;
  termsAccepted?: true;
}

export interface ValidatedUploadFormMetadata {
  name: string | null;
  description: string | null;
  appType: "mcp" | "skill" | null;
  functionsEntry: string | null;
}

export interface UploadOptionInput {
  name?: unknown;
  slug?: unknown;
  description?: unknown;
  visibility?: unknown;
  app_type?: unknown;
  functions_entry?: unknown;
  gap_id?: unknown;
}

export interface ValidatedUploadOptions {
  name?: string;
  slug?: string;
  description?: string;
  visibility?: "private" | "unlisted" | "public";
  app_type?: "mcp";
  functions_entry?: string;
  gap_id?: string;
}

function normalizeRequiredUuid(value: unknown, field: string): string {
  const normalized = normalizeOptionalString(value, field, { maxLength: 128 });
  if (!normalized) {
    throw new RequestValidationError(`Missing ${field}`);
  }
  if (!UUID_REGEX.test(normalized)) {
    throw new RequestValidationError(`${field} must be a valid UUID`);
  }
  return normalized;
}

function normalizeOptionalUuid(
  value: unknown,
  field: string,
): string | undefined {
  const normalized = normalizeOptionalString(value, field, { maxLength: 128 });
  if (!normalized) {
    return undefined;
  }
  if (!UUID_REGEX.test(normalized)) {
    throw new RequestValidationError(`${field} must be a valid UUID`);
  }
  return normalized;
}

function normalizeRequiredInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    throw new RequestValidationError(`${field} must be an integer`);
  }
  return value;
}

function normalizeRequiredPositiveNumber(
  value: unknown,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RequestValidationError(`${field} must be a positive number`);
  }
  return value;
}

function normalizeOptionalUploadText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  return normalizeOptionalString(value, field, { maxLength });
}

function normalizeFunctionsEntry(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value, "functions_entry", {
    maxLength: MAX_FUNCTIONS_ENTRY_LENGTH,
  });
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("/") || normalized.includes("\\")) {
    throw new RequestValidationError(
      "functions_entry must be a filename, not a path",
    );
  }
  if (!FUNCTIONS_ENTRY_REGEX.test(normalized)) {
    throw new RequestValidationError(
      "functions_entry must be a .ts, .tsx, .js, or .jsx filename",
    );
  }
  return normalized;
}

function normalizeUploadVisibility(
  value: unknown,
): "private" | "unlisted" | "public" | undefined {
  const normalized = normalizeOptionalString(value, "visibility");
  if (!normalized) {
    return undefined;
  }
  if (!ALLOWED_UPLOAD_VISIBILITIES.has(normalized)) {
    throw new RequestValidationError(
      'visibility must be "private", "unlisted", or "public"',
    );
  }
  return normalized as "private" | "unlisted" | "public";
}

function normalizeUploadSlug(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value, "slug", {
    maxLength: MAX_UPLOAD_SLUG_LENGTH,
  });
  if (!normalized) {
    return undefined;
  }
  if (!APP_SLUG_REGEX.test(normalized)) {
    throw new RequestValidationError(
      'slug must be lowercase alphanumeric with hyphens (for example "email-ops")',
    );
  }
  return normalized;
}

function normalizeSupabaseProjectRef(value: unknown): string {
  const normalized = normalizeOptionalString(value, "project_ref", {
    maxLength: 64,
  });
  if (!normalized) {
    throw new RequestValidationError("project_ref is required");
  }
  if (!SUPABASE_PROJECT_REF_REGEX.test(normalized)) {
    throw new RequestValidationError(
      "project_ref must be a lowercase project reference",
    );
  }
  return normalized;
}

export async function validateSupabaseOauthConnectRequest(
  request: Request,
): Promise<ValidatedSupabaseOauthConnectPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["project_ref", "app_id"],
  });

  return {
    projectRef: normalizeSupabaseProjectRef(body.project_ref),
    appId: normalizeOptionalUuid(body.app_id, "app_id"),
  };
}

export async function validateAppSupabaseConfigRequest(
  request: Request,
): Promise<ValidatedAppSupabaseConfigPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["config_id"],
  });

  if (body.config_id === null || body.config_id === undefined) {
    return { configId: null };
  }

  return {
    configId: normalizeOptionalUuid(body.config_id, "config_id") ?? null,
  };
}

export async function assertOwnedSupabaseConfig(
  userId: string,
  configId: string,
): Promise<void> {
  const supabaseUrl = getEnv("SUPABASE_URL");
  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  const response = await fetch(
    `${supabaseUrl}/rest/v1/user_supabase_configs?id=eq.${configId}&user_id=eq.${userId}&select=id&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to verify Supabase configuration ownership: ${await response
        .text()}`,
    );
  }

  const rows = await response.json() as Array<{ id: string }>;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new RequestValidationError("Supabase configuration not found", 404);
  }
}

async function validateFundingAmountRequest(
  request: Request,
  options: {
    requireTerms?: boolean;
    minimumCents?: number;
    allowBillingAddress?: boolean;
  } = {},
): Promise<{
  amountCents: number;
  source: "web" | "desktop";
  termsAccepted?: true;
  billingAddress?: BillingAddressInput;
}> {
  const body = await readJsonObject(request, {
    allowedKeys: [
      "amount_cents",
      "source",
      ...(options.requireTerms ? ["terms_accepted"] : []),
      ...(options.allowBillingAddress ? ["billing_address"] : []),
    ],
  });

  const amountCents = normalizeRequiredInteger(
    body.amount_cents,
    "amount_cents",
  );
  const minimumCents = options.minimumCents ?? 500;
  if (amountCents < minimumCents) {
    throw new RequestValidationError(
      `amount_cents must be at least ${minimumCents} ($${
        (minimumCents / 100).toFixed(2)
      } minimum deposit)`,
    );
  }
  if (amountCents > MAX_HOSTING_CHECKOUT_CENTS) {
    throw new RequestValidationError(
      `amount_cents must be ${MAX_HOSTING_CHECKOUT_CENTS} or less ($${
        (MAX_HOSTING_CHECKOUT_CENTS / 100).toFixed(2)
      } max deposit)`,
    );
  }

  const source = normalizeOptionalString(body.source, "source") || "web";
  if (!ALLOWED_CHECKOUT_SOURCES.has(source)) {
    throw new RequestValidationError('source must be "web" or "desktop"');
  }

  if (options.requireTerms && body.terms_accepted !== true) {
    throw new RequestValidationError(
      "terms_accepted must be true to add Light",
    );
  }

  return {
    amountCents,
    source: source as "web" | "desktop",
    ...(options.requireTerms ? { termsAccepted: true as const } : {}),
    ...(options.allowBillingAddress && body.billing_address !== undefined
      ? {
        billingAddress: validateBillingAddressValue(
          body.billing_address,
          "billing_address",
        ),
      }
      : {}),
  };
}

export function validateBillingAddressValue(
  value: unknown,
  field = "billing_address",
): BillingAddressInput {
  const body = ensurePlainObject(value, `${field} must be an object`);
  const name = normalizeOptionalString(body.name, `${field}.name`, {
    maxLength: 160,
  });
  const line1 = normalizeRequiredString(body.line1, `${field}.line1`, {
    maxLength: 200,
  });
  const line2 = normalizeOptionalString(body.line2, `${field}.line2`, {
    maxLength: 200,
  });
  const city = normalizeRequiredString(body.city, `${field}.city`, {
    maxLength: 120,
  });
  const state = normalizeOptionalString(body.state, `${field}.state`, {
    maxLength: 120,
  });
  const postalCode = normalizeRequiredString(
    body.postal_code,
    `${field}.postal_code`,
    { maxLength: 32 },
  );
  const country = normalizeRequiredString(body.country, `${field}.country`, {
    maxLength: 2,
  }).toUpperCase();

  if (!COUNTRY_CODE_REGEX.test(country)) {
    throw new RequestValidationError(
      `${field}.country must be a two-letter ISO country code`,
    );
  }
  if ((country === "US" || country === "CA") && !state) {
    throw new RequestValidationError(
      `${field}.state is required for US and CA addresses`,
    );
  }

  return {
    ...(name ? { name } : {}),
    line1,
    ...(line2 ? { line2 } : {}),
    city,
    ...(state ? { state } : {}),
    postalCode,
    country,
  };
}

export async function validateBillingAddressRequest(
  request: Request,
): Promise<ValidatedBillingAddressPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["billing_address"],
  });
  return {
    billingAddress: validateBillingAddressValue(body.billing_address),
  };
}

export async function validateHostingCheckoutRequest(
  request: Request,
): Promise<ValidatedHostingCheckoutPayload> {
  return await validateFundingAmountRequest(request);
}

export async function validateWalletFundingRequest(
  request: Request,
): Promise<ValidatedWalletFundingPayload> {
  const billingConfig = await getBillingConfig();
  return await validateFundingAmountRequest(request, {
    requireTerms: true,
    minimumCents: billingConfig.cardMinimumCents,
    allowBillingAddress: true,
  }) as ValidatedWalletFundingPayload;
}

export async function validateWireFundingRequest(
  request: Request,
): Promise<ValidatedWireFundingPayload> {
  const billingConfig = await getBillingConfig();
  return await validateFundingAmountRequest(request, {
    requireTerms: true,
    minimumCents: billingConfig.wireMinimumCents,
    allowBillingAddress: true,
  }) as ValidatedWireFundingPayload;
}

export async function validateConnectOnboardRequest(
  request: Request,
): Promise<ValidatedConnectOnboardPayload> {
  const body = await readJsonObject(request, {
    allowEmptyBody: true,
    allowedKeys: ["country"],
  });

  const country = normalizeOptionalString(body.country, "country", {
    maxLength: 8,
  });
  if (!country) {
    return { country: "US" };
  }

  const normalizedCountry = country.toUpperCase();
  if (!COUNTRY_CODE_REGEX.test(normalizedCountry)) {
    throw new RequestValidationError(
      "country must be a two-letter ISO country code",
    );
  }

  return { country: normalizedCountry };
}

export async function validateWithdrawalRequest(
  request: Request,
): Promise<ValidatedWithdrawalPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["amount_light", "terms_accepted"],
  });

  const amountLight = normalizeRequiredInteger(
    body.amount_light,
    "amount_light",
  );
  if (amountLight < MIN_WITHDRAWAL_LIGHT) {
    throw new RequestValidationError(
      `amount_light must be at least ${MIN_WITHDRAWAL_LIGHT} (${
        formatLight(MIN_WITHDRAWAL_LIGHT)
      } minimum withdrawal)`,
    );
  }
  if (body.terms_accepted !== true) {
    throw new RequestValidationError(
      "terms_accepted must be true to request a payout",
    );
  }

  return { amountLight, termsAccepted: true };
}

export async function validateEarningsConversionRequest(
  request: Request,
): Promise<ValidatedEarningsConversionPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["amount_light", "all", "terms_accepted"],
  });

  if (body.terms_accepted !== true) {
    throw new RequestValidationError(
      "terms_accepted must be true to add earnings to balance",
    );
  }

  if (body.all !== undefined && typeof body.all !== "boolean") {
    throw new RequestValidationError("all must be a boolean");
  }

  const convertAll = body.all === true;
  if (convertAll && body.amount_light !== undefined) {
    throw new RequestValidationError(
      "amount_light cannot be combined with all=true",
    );
  }

  if (convertAll) {
    return { amountLight: null, convertAll: true, termsAccepted: true };
  }

  if (body.amount_light === undefined) {
    throw new RequestValidationError(
      "amount_light is required unless all=true",
    );
  }

  return {
    amountLight: normalizeRequiredPositiveNumber(
      body.amount_light,
      "amount_light",
    ),
    convertAll: false,
    termsAccepted: true,
  };
}

export async function validateEarningsAutoAddRequest(
  request: Request,
): Promise<ValidatedEarningsAutoAddPayload> {
  const body = await readJsonObject(request, {
    allowedKeys: ["enabled", "terms_accepted"],
  });

  if (typeof body.enabled !== "boolean") {
    throw new RequestValidationError("enabled must be a boolean");
  }

  if (body.enabled === true && body.terms_accepted !== true) {
    throw new RequestValidationError(
      "terms_accepted must be true to auto-add future earnings to balance",
    );
  }

  return body.enabled
    ? { enabled: true, termsAccepted: true }
    : { enabled: false };
}

export function validateUploadFormMetadata(input: {
  name?: unknown;
  description?: unknown;
  app_type?: unknown;
  functions_entry?: unknown;
}): ValidatedUploadFormMetadata {
  const name =
    normalizeOptionalUploadText(input.name, "name", MAX_UPLOAD_NAME_LENGTH) ??
      null;
  const description = normalizeOptionalUploadText(
    input.description,
    "description",
    MAX_UPLOAD_DESCRIPTION_LENGTH,
  ) ?? null;

  const appTypeValue = normalizeOptionalString(input.app_type, "app_type");
  if (appTypeValue && !ALLOWED_UPLOAD_APP_TYPES.has(appTypeValue)) {
    throw new RequestValidationError('app_type must be "mcp" or "skill"');
  }

  return {
    name,
    description,
    appType: (appTypeValue as "mcp" | "skill" | undefined) ?? null,
    functionsEntry: normalizeFunctionsEntry(input.functions_entry) ?? null,
  };
}

export function validateProgrammaticUploadOptions(
  options: UploadOptionInput,
): ValidatedUploadOptions {
  const name = normalizeOptionalUploadText(
    options.name,
    "name",
    MAX_UPLOAD_NAME_LENGTH,
  );
  const description = normalizeOptionalUploadText(
    options.description,
    "description",
    MAX_UPLOAD_DESCRIPTION_LENGTH,
  );
  const visibility = normalizeUploadVisibility(options.visibility);
  const slug = normalizeUploadSlug(options.slug);
  const functionsEntry = normalizeFunctionsEntry(options.functions_entry);
  const appTypeValue = normalizeOptionalString(options.app_type, "app_type");

  if (appTypeValue && !ALLOWED_PROGRAMMATIC_APP_TYPES.has(appTypeValue)) {
    throw new RequestValidationError(
      'app_type must be "mcp" for programmatic uploads',
    );
  }

  return {
    ...(name ? { name } : {}),
    ...(slug ? { slug } : {}),
    ...(description ? { description } : {}),
    ...(visibility ? { visibility } : {}),
    ...(appTypeValue ? { app_type: appTypeValue as "mcp" } : {}),
    ...(functionsEntry ? { functions_entry: functionsEntry } : {}),
    ...(options.gap_id !== undefined && options.gap_id !== null
      ? { gap_id: normalizeRequiredUuid(options.gap_id, "gap_id") }
      : {}),
  };
}
