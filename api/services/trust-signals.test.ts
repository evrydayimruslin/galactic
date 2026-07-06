// Tests for isPublisherVerified — the fail-closed + freshness semantics that
// gate the "verified publisher" badge on both the website and MCP inspect.
// (Extracted from launch.ts in the honest-trust-card unification; these behaviors
// were previously untested.)

import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import { isPublisherVerified } from "./trust-signals.ts";

const HOUR = 60 * 60 * 1000;

// deno-lint-ignore no-explicit-any
const g = globalThis as any;

async function withEnvAndFetch(
  env: Record<string, string> | null,
  fetchImpl: typeof fetch,
  run: () => Promise<void>,
) {
  const origEnv = g.__env;
  const origFetch = g.fetch;
  g.__env = env;
  g.fetch = fetchImpl;
  try {
    await run();
  } finally {
    g.__env = origEnv;
    g.fetch = origFetch;
  }
}

function usersResponse(row: unknown): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(row === null ? [] : [row]), { status: 200 }),
    );
}

const CONFIGURED = {
  SUPABASE_URL: "https://db.example",
  SUPABASE_SERVICE_ROLE_KEY: "svc-key",
};

Deno.test("isPublisherVerified: null/empty owner is unverified (no I/O)", async () => {
  await withEnvAndFetch(CONFIGURED, () => {
    throw new Error("should not fetch for a null owner");
  }, async () => {
    assertEquals(await isPublisherVerified(null), false);
    assertEquals(await isPublisherVerified(undefined), false);
    assertEquals(await isPublisherVerified(""), false);
  });
});

Deno.test("isPublisherVerified: fails closed when Supabase is not configured", async () => {
  await withEnvAndFetch({}, () => {
    throw new Error("should not fetch without config");
  }, async () => {
    assertEquals(await isPublisherVerified("owner-1"), false);
  });
});

Deno.test("isPublisherVerified: verified + fresh snapshot => true", async () => {
  await withEnvAndFetch(
    CONFIGURED,
    usersResponse({
      stripe_connect_verified: true,
      stripe_connect_synced_at: new Date().toISOString(),
    }),
    async () => {
      assertEquals(await isPublisherVerified("owner-1"), true);
    },
  );
});

Deno.test("isPublisherVerified: verified but stale (>48h) => false", async () => {
  await withEnvAndFetch(
    CONFIGURED,
    usersResponse({
      stripe_connect_verified: true,
      stripe_connect_synced_at: new Date(Date.now() - 49 * HOUR).toISOString(),
    }),
    async () => {
      assertEquals(await isPublisherVerified("owner-1"), false);
    },
  );
});

Deno.test("isPublisherVerified: not connect-verified => false", async () => {
  await withEnvAndFetch(
    CONFIGURED,
    usersResponse({
      stripe_connect_verified: false,
      stripe_connect_synced_at: new Date().toISOString(),
    }),
    async () => {
      assertEquals(await isPublisherVerified("owner-1"), false);
    },
  );
});

Deno.test("isPublisherVerified: missing snapshot timestamp => false", async () => {
  await withEnvAndFetch(
    CONFIGURED,
    usersResponse({
      stripe_connect_verified: true,
      stripe_connect_synced_at: null,
    }),
    async () => {
      assertEquals(await isPublisherVerified("owner-1"), false);
    },
  );
});

Deno.test("isPublisherVerified: a lookup error fails closed", async () => {
  await withEnvAndFetch(
    CONFIGURED,
    () => Promise.reject(new Error("network down")),
    async () => {
      assertEquals(await isPublisherVerified("owner-1"), false);
    },
  );
});
