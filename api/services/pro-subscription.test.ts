import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  hasActiveProSubscription,
  ProSubscriptionCheckUnavailableError,
  ProSubscriptionRequiredError,
  requireActiveProSubscription,
} from "./pro-subscription.ts";

function entitlementFetch(
  payload: unknown,
  status = 200,
): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof fetch;
}

const dbDeps = {
  supabaseUrl: "https://supabase.example",
  serviceRoleKey: "service-role",
};

Deno.test("Pro subscription gate is a no-op until enabled", async () => {
  assertEquals(
    await hasActiveProSubscription("user-1", {
      enabled: false,
      ...dbDeps,
      fetchFn: (() => {
        throw new Error("must not fetch");
      }) as typeof fetch,
    }),
    true,
  );
  assertEquals(
    await hasActiveProSubscription("user-1", {
      enabled: true,
      ...dbDeps,
      fetchFn: entitlementFetch([{
        plan_code: "max_5x",
        subscription_status: "active",
      }]),
    }),
    true,
  );
});

Deno.test("Pro subscription gate admits only active Pro", async () => {
  assertEquals(
    await hasActiveProSubscription("user-1", {
      enabled: true,
      ...dbDeps,
      fetchFn: entitlementFetch([{
        plan_code: "pro",
        subscription_status: "active",
      }]),
    }),
    true,
  );

  for (
    const row of [
      { plan_code: "free", subscription_status: "active" },
      { plan_code: "pro", subscription_status: "trialing" },
      { plan_code: "pro", subscription_status: "past_due" },
      { plan_code: "pro", subscription_status: "canceled" },
      null,
    ]
  ) {
    await assertRejects(
      () =>
        requireActiveProSubscription("user-1", {
          enabled: true,
          ...dbDeps,
          fetchFn: entitlementFetch(row ? [row] : []),
        }),
      ProSubscriptionRequiredError,
    );
  }
});

Deno.test("Pro subscription gate fails closed when entitlement lookup fails", async () => {
  await assertRejects(
    () =>
      requireActiveProSubscription("user-1", {
        enabled: true,
        ...dbDeps,
        fetchFn: entitlementFetch({ message: "down" }, 503),
      }),
    ProSubscriptionCheckUnavailableError,
  );
});
