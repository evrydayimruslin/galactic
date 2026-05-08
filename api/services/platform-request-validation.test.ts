import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import {
  assertOwnedSupabaseConfig,
  validateAppSupabaseConfigRequest,
  validateBillingAddressRequest,
  validateConnectOnboardRequest,
  validateEarningsAutoAddRequest,
  validateEarningsConversionRequest,
  validateHostingCheckoutRequest,
  validateProgrammaticUploadOptions,
  validateSupabaseOauthConnectRequest,
  validateUploadFormMetadata,
  validateWalletFundingRequest,
  validateWireFundingRequest,
  validateWithdrawalRequest,
} from "./platform-request-validation.ts";
import { RequestValidationError } from "./request-validation.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

let testQueue = Promise.resolve();

async function runSerial(fn: () => Promise<void>): Promise<void> {
  const run = testQueue.then(fn, fn);
  testQueue = run.catch(() => {});
  await run;
}

async function withMockedEnvAndFetch(
  handler: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const globalWithEnv = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const previousEnv = globalWithEnv.__env;
  const previousFetch = globalThis.fetch;

  globalWithEnv.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  };
  globalThis.fetch = handler as typeof fetch;

  try {
    await fn();
  } finally {
    globalThis.fetch = previousFetch;
    globalWithEnv.__env = previousEnv;
  }
}

Deno.test("platform request validation: Supabase OAuth connect validates project and app ids", async () => {
  const payload = await validateSupabaseOauthConnectRequest(
    new Request("https://example.com/api/user/supabase/oauth/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_ref: "projref123",
        app_id: "11111111-1111-4111-8111-111111111111",
      }),
    }),
  );

  assertEquals(payload.projectRef, "projref123");
  assertEquals(payload.appId, "11111111-1111-4111-8111-111111111111");

  await assertRejects(
    () =>
      validateSupabaseOauthConnectRequest(
        new Request("https://example.com/api/user/supabase/oauth/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project_ref: "Not Safe" }),
        }),
      ),
    RequestValidationError,
    "project_ref must be a lowercase project reference",
  );
});

Deno.test("platform request validation: app Supabase config request allows null and rejects invalid config ids", async () => {
  const payload = await validateAppSupabaseConfigRequest(
    new Request("https://example.com/api/apps/app-1/supabase", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config_id: null }),
    }),
  );

  assertEquals(payload, { configId: null });

  await assertRejects(
    () =>
      validateAppSupabaseConfigRequest(
        new Request("https://example.com/api/apps/app-1/supabase", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config_id: "not-a-uuid" }),
        }),
      ),
    RequestValidationError,
    "config_id must be a valid UUID",
  );
});

Deno.test("platform request validation: hosting checkout enforces source and max deposit bounds", async () => {
  const payload = await validateHostingCheckoutRequest(
    new Request("https://example.com/api/user/hosting/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_cents: 1500, source: "desktop" }),
    }),
  );

  assertEquals(payload, { amountCents: 1500, source: "desktop" });

  await assertRejects(
    () =>
      validateHostingCheckoutRequest(
        new Request("https://example.com/api/user/hosting/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount_cents: 500001 }),
        }),
      ),
    RequestValidationError,
    "max deposit",
  );
});

Deno.test("platform request validation: wallet funding reuses deposit bounds", async () => {
  const payload = await validateWalletFundingRequest(
    new Request("https://example.com/api/user/wallet/express-checkout-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount_cents: 2500,
        source: "web",
        terms_accepted: true,
        billing_address: {
          name: "Ada Lovelace",
          line1: "123 Compute Way",
          city: "New York",
          state: "NY",
          postal_code: "10001",
          country: "us",
        },
      }),
    }),
  );

  assertEquals(payload, {
    amountCents: 2500,
    source: "web",
    termsAccepted: true,
    billingAddress: {
      name: "Ada Lovelace",
      line1: "123 Compute Way",
      city: "New York",
      state: "NY",
      postalCode: "10001",
      country: "US",
    },
  });

  await assertRejects(
    () =>
      validateWalletFundingRequest(
        new Request(
          "https://example.com/api/user/wallet/express-checkout-intent",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount_cents: 2499, terms_accepted: true }),
          },
        ),
      ),
    RequestValidationError,
    "minimum deposit",
  );

  await assertRejects(
    () =>
      validateWalletFundingRequest(
        new Request(
          "https://example.com/api/user/wallet/express-checkout-intent",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount_cents: 2500 }),
          },
        ),
      ),
    RequestValidationError,
    "terms_accepted must be true",
  );
});

Deno.test("platform request validation: billing address requires US region", async () => {
  const payload = await validateBillingAddressRequest(
    new Request("https://example.com/api/user/billing-address", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        billing_address: {
          line1: "123 Compute Way",
          city: "New York",
          state: "NY",
          postal_code: "10001",
          country: "us",
        },
      }),
    }),
  );

  assertEquals(payload.billingAddress.country, "US");
  assertEquals(payload.billingAddress.postalCode, "10001");

  await assertRejects(
    () =>
      validateBillingAddressRequest(
        new Request("https://example.com/api/user/billing-address", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            billing_address: {
              line1: "123 Compute Way",
              city: "New York",
              postal_code: "10001",
              country: "US",
            },
          }),
        }),
      ),
    RequestValidationError,
    "state is required",
  );
});

Deno.test("platform request validation: wire funding reuses deposit bounds", async () => {
  const payload = await validateWireFundingRequest(
    new Request("https://example.com/api/user/wallet/wire-transfer-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount_cents: 50000,
        source: "desktop",
        terms_accepted: true,
      }),
    }),
  );

  assertEquals(payload, {
    amountCents: 50000,
    source: "desktop",
    termsAccepted: true,
  });

  await assertRejects(
    () =>
      validateWireFundingRequest(
        new Request(
          "https://example.com/api/user/wallet/wire-transfer-intent",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              amount_cents: 2499,
              terms_accepted: true,
            }),
          },
        ),
      ),
    RequestValidationError,
    "minimum deposit",
  );

  await assertRejects(
    () =>
      validateWireFundingRequest(
        new Request(
          "https://example.com/api/user/wallet/wire-transfer-intent",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              amount_cents: 500001,
              terms_accepted: true,
            }),
          },
        ),
      ),
    RequestValidationError,
    "max deposit",
  );

  await assertRejects(
    () =>
      validateWireFundingRequest(
        new Request(
          "https://example.com/api/user/wallet/wire-transfer-intent",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount_cents: 50000 }),
          },
        ),
      ),
    RequestValidationError,
    "terms_accepted must be true",
  );
});

Deno.test("platform request validation: connect onboard defaults to US and normalizes country codes", async () => {
  const defaultPayload = await validateConnectOnboardRequest(
    new Request("https://example.com/api/user/connect/onboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    }),
  );
  assertEquals(defaultPayload, { country: "US" });

  const normalizedPayload = await validateConnectOnboardRequest(
    new Request("https://example.com/api/user/connect/onboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ country: "ca" }),
    }),
  );
  assertEquals(normalizedPayload, { country: "CA" });
});

Deno.test("platform request validation: withdrawal request enforces integer minimum", async () => {
  const payload = await validateWithdrawalRequest(
    new Request("https://example.com/api/user/connect/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_light: 5000, terms_accepted: true }),
    }),
  );
  assertEquals(payload, { amountLight: 5000, termsAccepted: true });

  await assertRejects(
    () =>
      validateWithdrawalRequest(
        new Request("https://example.com/api/user/connect/withdraw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount_light: 4999, terms_accepted: true }),
        }),
      ),
    RequestValidationError,
    "minimum withdrawal",
  );

  await assertRejects(
    () =>
      validateWithdrawalRequest(
        new Request("https://example.com/api/user/connect/withdraw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount_light: 5000 }),
        }),
      ),
    RequestValidationError,
    "terms_accepted must be true",
  );
});

Deno.test("platform request validation: earnings conversion allows fractional Light and requires terms", async () => {
  const payload = await validateEarningsConversionRequest(
    new Request("https://example.com/api/user/earnings/convert-to-balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_light: 12.345, terms_accepted: true }),
    }),
  );
  assertEquals(payload, {
    amountLight: 12.345,
    convertAll: false,
    termsAccepted: true,
  });

  const allPayload = await validateEarningsConversionRequest(
    new Request("https://example.com/api/user/earnings/convert-to-balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true, terms_accepted: true }),
    }),
  );
  assertEquals(allPayload, {
    amountLight: null,
    convertAll: true,
    termsAccepted: true,
  });

  await assertRejects(
    () =>
      validateEarningsConversionRequest(
        new Request(
          "https://example.com/api/user/earnings/convert-to-balance",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount_light: 1 }),
          },
        ),
      ),
    RequestValidationError,
    "terms_accepted must be true",
  );

  await assertRejects(
    () =>
      validateEarningsConversionRequest(
        new Request(
          "https://example.com/api/user/earnings/convert-to-balance",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount_light: -1, terms_accepted: true }),
          },
        ),
      ),
    RequestValidationError,
    "amount_light must be a positive number",
  );
});

Deno.test("platform request validation: earnings auto-add requires terms when enabling", async () => {
  assertEquals(
    await validateEarningsAutoAddRequest(
      new Request("https://example.com/api/user/earnings/auto-add", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, terms_accepted: true }),
      }),
    ),
    { enabled: true, termsAccepted: true },
  );

  assertEquals(
    await validateEarningsAutoAddRequest(
      new Request("https://example.com/api/user/earnings/auto-add", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    ),
    { enabled: false },
  );

  await assertRejects(
    () =>
      validateEarningsAutoAddRequest(
        new Request("https://example.com/api/user/earnings/auto-add", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }),
      ),
    RequestValidationError,
    "terms_accepted must be true",
  );
});

Deno.test("platform request validation: upload metadata rejects invalid app types and path traversal entry hints", () => {
  const metadata = validateUploadFormMetadata({
    name: "  Email Ops  ",
    description: "  Useful helper  ",
    app_type: "mcp",
    functions_entry: "functions.ts",
  });

  assertEquals(metadata, {
    name: "Email Ops",
    description: "Useful helper",
    appType: "mcp",
    functionsEntry: "functions.ts",
  });

  try {
    validateUploadFormMetadata({
      app_type: "agent",
      functions_entry: "../functions.ts",
    });
    throw new Error("Expected invalid upload metadata to be rejected");
  } catch (err) {
    if (!(err instanceof RequestValidationError)) throw err;
    assertEquals(err.message, 'app_type must be "mcp" or "skill"');
  }
});

Deno.test("platform request validation: programmatic upload options validate slug, gap id, and visibility", () => {
  const options = validateProgrammaticUploadOptions({
    name: "  Email Ops  ",
    slug: "email-ops",
    visibility: "unlisted",
    app_type: "mcp",
    functions_entry: "index.ts",
    gap_id: "22222222-2222-4222-8222-222222222222",
  });

  assertEquals(options, {
    name: "Email Ops",
    slug: "email-ops",
    visibility: "unlisted",
    app_type: "mcp",
    functions_entry: "index.ts",
    gap_id: "22222222-2222-4222-8222-222222222222",
  });

  try {
    validateProgrammaticUploadOptions({
      slug: "Email Ops",
    });
    throw new Error("Expected invalid slug to be rejected");
  } catch (err) {
    if (!(err instanceof RequestValidationError)) throw err;
    assertEquals(
      err.message,
      'slug must be lowercase alphanumeric with hyphens (for example "email-ops")',
    );
  }
});

Deno.test("platform request validation: owned Supabase config lookup rejects missing rows", async () => {
  await runSerial(async () => {
    let capturedUrl = "";
    await withMockedEnvAndFetch(
      async (input) => {
        capturedUrl = String(input);
        return new Response(JSON.stringify([{ id: "cfg-1" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      async () => {
        await assertOwnedSupabaseConfig(
          "11111111-1111-4111-8111-111111111111",
          "33333333-3333-4333-8333-333333333333",
        );
        assertEquals(
          capturedUrl,
          "https://supabase.test/rest/v1/user_supabase_configs?id=eq.33333333-3333-4333-8333-333333333333&user_id=eq.11111111-1111-4111-8111-111111111111&select=id&limit=1",
        );
      },
    );

    await withMockedEnvAndFetch(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      async () => {
        await assertRejects(
          () =>
            assertOwnedSupabaseConfig(
              "11111111-1111-4111-8111-111111111111",
              "33333333-3333-4333-8333-333333333333",
            ),
          RequestValidationError,
          "Supabase configuration not found",
        );
      },
    );
  });
});
