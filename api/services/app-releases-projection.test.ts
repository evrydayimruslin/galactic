import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import {
  listAgentReleases,
  resolveFunctionPolicyReleaseAuthority,
} from "./app-releases-projection.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

async function withMockedDb<T>(
  handler: (url: URL) => Response,
  fn: () => Promise<T>,
): Promise<T> {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  } as typeof globalThis.__env;
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(
      handler(new URL(typeof input === "string" ? input : input.toString())),
    )) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.__env = previousEnv;
    globalThis.fetch = previousFetch;
  }
}

Deno.test("listAgentReleases scopes to owner and orders by generation desc", async () => {
  const urls: URL[] = [];
  const releases = await withMockedDb(
    (url) => {
      urls.push(url);
      return new Response(
        JSON.stringify([
          {
            id: "rel-2",
            version: "2.1.0",
            release_generation: 2,
            storage_bytes: 2048,
            created_at: "2026-08-01T10:00:00.000Z",
          },
          {
            id: "rel-1",
            version: "2.0.0",
            release_generation: 1,
            storage_bytes: 1024,
            created_at: "2026-07-01T10:00:00.000Z",
          },
        ]),
        { status: 200 },
      );
    },
    () => listAgentReleases("user-1", "app-1"),
  );
  assertEquals(releases.length, 2);
  assertEquals(releases[0], {
    id: "rel-2",
    version: "2.1.0",
    releaseGeneration: 2,
    storageBytes: 2048,
    createdAt: "2026-08-01T10:00:00.000Z",
  });
  const url = urls[0];
  assert(url.pathname.endsWith("/rest/v1/app_releases"));
  // The explicit owner filter IS the authorization on this service-role table.
  assertEquals(url.searchParams.get("app_id"), "eq.app-1");
  assertEquals(url.searchParams.get("owner_id"), "eq.user-1");
  assertEquals(url.searchParams.get("order"), "release_generation.desc");
  // Read-only projection: digests, manifests, and storage keys stay server-side.
  const select = url.searchParams.get("select") ?? "";
  assert(!select.includes("digest"));
  assert(!select.includes("manifest"));
  assert(!select.includes("storage_key"));
});

Deno.test("listAgentReleases fails loudly on a database error", async () => {
  await withMockedDb(
    () => new Response("boom", { status: 500 }),
    () =>
      assertRejects(
        () => listAgentReleases("user-1", "app-1"),
        Error,
        "Failed to list agent releases",
      ),
  );
});

Deno.test("function policy authority prefers the immutable release ledger", () => {
  assertEquals(
    resolveFunctionPolicyReleaseAuthority([{
      id: "release-2",
      version: "2.0.0",
      releaseGeneration: 2,
      storageBytes: 2048,
      createdAt: "2026-08-02T12:00:00.000Z",
    }], {
      agentId: "agent-1",
      deploymentState: "legacy",
      currentVersion: "1.0.0",
      currentVersionPromotedAt: "2026-07-01T12:00:00.000Z",
      activeReleaseDigest: "a".repeat(64),
    }),
    {
      id: "release-2",
      version: "2.0.0",
      createdAt: "2026-08-02T12:00:00.000Z",
    },
  );
});

Deno.test("function policy authority fences a legacy Agent to its live promotion", () => {
  const source = {
    agentId: "agent-1",
    deploymentState: "legacy",
    currentVersion: "1.2.3",
    currentVersionPromotedAt: "2026-08-01T12:34:56.000Z",
    activeReleaseDigest: "b".repeat(64),
  };
  const authority = resolveFunctionPolicyReleaseAuthority([], source);
  assertEquals(authority, {
    id: `legacy:agent-1:1.2.3:${"b".repeat(64)}`,
    version: "1.2.3",
    createdAt: "2026-08-01T12:34:56.000Z",
  });
  assert(
    resolveFunctionPolicyReleaseAuthority([], {
      ...source,
      activeReleaseDigest: "c".repeat(64),
    })?.id !== authority?.id,
  );
});

Deno.test("legacy policy authority falls back to the promotion timestamp", () => {
  assertEquals(
    resolveFunctionPolicyReleaseAuthority([], {
      agentId: "agent-1",
      deploymentState: "legacy",
      currentVersion: "1.2.3",
      currentVersionPromotedAt: "2026-08-01T12:34:56Z",
      activeReleaseDigest: null,
    }),
    {
      id: "legacy:agent-1:1.2.3:2026-08-01T12%3A34%3A56.000Z",
      version: "1.2.3",
      createdAt: "2026-08-01T12:34:56.000Z",
    },
  );
});

Deno.test("function policy authority fails closed without a valid release source", () => {
  const source = {
    agentId: "agent-1",
    deploymentState: "ready",
    currentVersion: "1.2.3",
    currentVersionPromotedAt: "2026-08-01T12:34:56.000Z",
    activeReleaseDigest: null,
  };
  assertEquals(resolveFunctionPolicyReleaseAuthority([], source), null);
  assertEquals(
    resolveFunctionPolicyReleaseAuthority([], {
      ...source,
      deploymentState: "legacy",
      currentVersion: "",
    }),
    null,
  );
});
