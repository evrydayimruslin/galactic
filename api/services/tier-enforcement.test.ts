import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import {
  checkPublishDeposit,
  checkPublisherPublishReadiness,
  checkVisibilityAllowed,
} from "./tier-enforcement.ts";

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

Deno.test("tier enforcement: publish gate checks balance before address", async () => {
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
          "Publishing requires at least ✦1000 spendable credits before a non-private tool can go live. Current balance: ✦100. Add credits from Wallet to go live.",
        );
        assertEquals(
          calls.some((url) => url.includes("/rest/v1/user_billing_addresses?")),
          false,
        );
      },
    );
  });
});

Deno.test("tier enforcement: publish gate requires billing address with sufficient balance", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async (input) => {
        const url = String(input);

        if (url.includes("/platform_billing_config")) {
          return Response.json([{
            id: "singleton",
            version: 22,
            publish_deposit_enabled: true,
            publisher_min_publish_balance_light: 1000,
          }]);
        }

        if (url.includes("/rest/v1/users?")) {
          return Response.json([{ balance_light: 1250 }]);
        }

        if (url.includes("/rest/v1/user_billing_addresses?")) {
          return Response.json([]);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
      async () => {
        const result = await checkPublishDeposit("user-1");

        assertEquals(
          result,
          "Publishing requires a saved billing address after meeting the ✦1000 minimum. Current balance: ✦1250. Save a billing address before going live.",
        );
      },
    );
  });
});

Deno.test("tier enforcement: publish gate passes with balance and billing address", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async (input) => {
        const url = String(input);

        if (url.includes("/platform_billing_config")) {
          return Response.json([{
            id: "singleton",
            version: 22,
            publish_deposit_enabled: true,
            publisher_min_publish_balance_light: 1000,
          }]);
        }

        if (url.includes("/rest/v1/users?")) {
          return Response.json([{ balance_light: 1250 }]);
        }

        if (url.includes("/rest/v1/user_billing_addresses?")) {
          return Response.json([{ id: "billing-address-1" }]);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
      async () => {
        assertEquals(await checkPublishDeposit("user-1"), null);
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
