import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import {
  checkPublishDeposit,
  checkPublisherPublishReadiness,
  checkVisibilityAllowed,
} from "./tier-enforcement.ts";
import { invalidateBillingConfigCache } from "./billing-config.ts";

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
  // Each test mocks its own billing config — the 60s in-isolate cache must
  // not carry a previous test's config across.
  invalidateBillingConfigCache();

  try {
    await fn();
  } finally {
    globalThis.fetch = previousFetch;
    globalWithEnv.__env = previousEnv;
    invalidateBillingConfigCache();
  }
}

Deno.test("tier enforcement: publish gate bypasses when disabled by billing config", async () => {
  await runSerial(async () => {
    const calls: string[] = [];

    await withMockedEnvAndFetch(
      async (input) => {
        const url = String(input);
        calls.push(url);

        if (url.includes("/platform_billing_config")) {
          return Response.json([{
            id: "singleton",
            version: 22,
            publish_deposit_enabled: false,
          }]);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
      async () => {
        assertEquals(await checkPublishDeposit("user-1"), null);
        assertEquals(
          calls.some((url) => url.includes("/rest/v1/users?")),
          false,
        );
      },
    );
  });
});

Deno.test("tier enforcement: publish gate blocks on low balance first", async () => {
  await runSerial(async () => {
    const calls: string[] = [];

    await withMockedEnvAndFetch(
      async (input) => {
        const url = String(input);
        calls.push(url);

        if (url.includes("/platform_billing_config")) {
          return Response.json([{
            id: "singleton",
            version: 22,
            publish_deposit_enabled: true,
            publisher_min_publish_balance_light: 1000,
          }]);
        }

        if (url.includes("/rest/v1/users?")) {
          return Response.json([{ balance_light: 100 }]);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
      async () => {
        const result = await checkPublishDeposit("user-1");

        assertEquals(
          result,
          "Publishing requires at least $10.00 in spendable credits before a non-private tool can go live. Current balance: $1.00. Add credits from Wallet to go live.",
        );
        assertEquals(
          calls.some((url) => url.includes("/rest/v1/user_billing_addresses?")),
          false,
        );
      },
    );
  });
});

function payoutsBillingConfig(): Response {
  return Response.json([{
    id: "singleton",
    version: 22,
    publish_deposit_enabled: true,
    publisher_min_publish_balance_light: 1000,
  }]);
}

Deno.test("tier enforcement: public publish requires Connect payouts even with balance", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async (input) => {
        const url = String(input);
        if (url.includes("/platform_billing_config")) {
          return payoutsBillingConfig();
        }
        if (url.includes("/rest/v1/users?")) {
          return Response.json([
            { balance_light: 1250, stripe_connect_payouts_enabled: false },
          ]);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
      async () => {
        const readiness = await checkPublisherPublishReadiness("user-1", {
          visibility: "public",
        });
        assertEquals(readiness.allowed, false);
        assertEquals(readiness.block?.reason, "connect_payouts_required");
        assertEquals(readiness.block?.status, 402);
      },
    );
  });
});

Deno.test("tier enforcement: public publish passes when Connect payouts enabled", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async (input) => {
        const url = String(input);
        if (url.includes("/platform_billing_config")) {
          return payoutsBillingConfig();
        }
        if (url.includes("/rest/v1/users?")) {
          return Response.json([
            { balance_light: 1250, stripe_connect_payouts_enabled: true },
          ]);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
      async () => {
        const readiness = await checkPublisherPublishReadiness("user-1", {
          visibility: "public",
        });
        assertEquals(readiness.allowed, true);
        assertEquals(readiness.block, undefined);
      },
    );
  });
});

Deno.test("tier enforcement: unlisted needs only balance, not Connect payouts", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async (input) => {
        const url = String(input);
        if (url.includes("/platform_billing_config")) {
          return payoutsBillingConfig();
        }
        if (url.includes("/rest/v1/users?")) {
          return Response.json([
            { balance_light: 1250, stripe_connect_payouts_enabled: false },
          ]);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
      async () => {
        const readiness = await checkPublisherPublishReadiness("user-1", {
          visibility: "unlisted",
        });
        assertEquals(readiness.allowed, true);
      },
    );
  });
});

Deno.test("tier enforcement: pre-gate public agents are grandfathered past Connect", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async (input) => {
        const url = String(input);
        if (url.includes("/platform_billing_config")) {
          return payoutsBillingConfig();
        }
        if (url.includes("/rest/v1/users?")) {
          return Response.json([
            { balance_light: 1250, stripe_connect_payouts_enabled: false },
          ]);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
      async () => {
        const readiness = await checkPublisherPublishReadiness("user-1", {
          visibility: "public",
          appConnectGateExempt: true,
        });
        assertEquals(readiness.allowed, true);
      },
    );
  });
});

Deno.test("tier enforcement: publish readiness exposes structured balance details", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async (input) => {
        const url = String(input);

        if (url.includes("/platform_billing_config")) {
          return Response.json([{
            id: "singleton",
            version: 22,
            publish_deposit_enabled: true,
            publisher_min_publish_balance_light: 1500,
          }]);
        }

        if (url.includes("/rest/v1/users?")) {
          return Response.json([{ balance_light: 1000 }]);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
      async () => {
        const readiness = await checkPublisherPublishReadiness("user-1");

        assertEquals(readiness.allowed, false);
        assertEquals(readiness.requiredLight, 1500);
        assertEquals(readiness.currentBalanceLight, 1000);
        assertEquals(readiness.block?.reason, "insufficient_publish_balance");
        assertEquals(readiness.block?.status, 402);
        assertEquals(
          readiness.block?.nextAction,
          "Add credits from Wallet to go live.",
        );
      },
    );
  });
});

Deno.test("tier enforcement: visibility remains ungated by tier", () => {
  assertEquals(checkVisibilityAllowed("free", "public"), null);
  assertEquals(checkVisibilityAllowed("free", "unlisted"), null);
  assertEquals(checkVisibilityAllowed("pro", "private"), null);
});
