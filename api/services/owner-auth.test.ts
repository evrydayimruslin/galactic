// Owner-actor token security tests (Slice B.1). The gxo_ token must: round-trip
// mint->verify; fail on tamper / wrong-secret / expiry; be accepted ONLY for the
// configured platform owner (authenticateInternalAdmin); fail closed when the
// owner id is unset; and be REJECTED outright by the central authenticateRequest
// (so it is inert on every normal route).

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";
import {
  authenticateInternalAdmin,
  createOwnerActorToken,
  isOwnerActorToken,
  OWNER_ACTOR_TOKEN_PREFIX,
  verifyOwnerActorToken,
} from "./owner-auth.ts";
import { authenticateRequest } from "./request-auth.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NOT_OWNER = "22222222-2222-4222-8222-222222222222";
const SECRET = "owner-secret-xyz";

async function withEnv<T>(
  env: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const prev = globalThis.__env;
  globalThis.__env = { ...(prev || {}), ...env } as typeof globalThis.__env;
  try {
    return await fn();
  } finally {
    globalThis.__env = prev;
  }
}

function bearer(token: string): Request {
  return new Request("https://api.test/api/admin/internal/defaults", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

Deno.test("owner-auth: mint -> verify roundtrip carries the owner user_id", async () => {
  await withEnv({ OWNER_ACTOR_TOKEN_SECRET: SECRET }, async () => {
    const { token, claims } = await createOwnerActorToken({ userId: OWNER });
    assert(token.startsWith(OWNER_ACTOR_TOKEN_PREFIX));
    assert(isOwnerActorToken(token));
    assertEquals(claims.user_id, OWNER);
    const verified = await verifyOwnerActorToken(token);
    assert(verified);
    assertEquals(verified!.claims.user_id, OWNER);
  });
});

Deno.test("owner-auth: a tampered token fails verification", async () => {
  await withEnv({ OWNER_ACTOR_TOKEN_SECRET: SECRET }, async () => {
    const { token } = await createOwnerActorToken({ userId: OWNER });
    const tampered = token.slice(0, -2) + (token.endsWith("a") ? "bb" : "aa");
    assertEquals(await verifyOwnerActorToken(tampered), null);
  });
});

Deno.test("owner-auth: a token signed with a different secret fails", async () => {
  const minted = await withEnv(
    { OWNER_ACTOR_TOKEN_SECRET: SECRET },
    () => createOwnerActorToken({ userId: OWNER }),
  );
  await withEnv({ OWNER_ACTOR_TOKEN_SECRET: "a-different-secret" }, async () => {
    assertEquals(await verifyOwnerActorToken(minted.token), null);
  });
});

Deno.test("owner-auth: an expired token fails verification", async () => {
  await withEnv({ OWNER_ACTOR_TOKEN_SECRET: SECRET }, async () => {
    const now = 1_700_000_000_000;
    const { token } = await createOwnerActorToken({
      userId: OWNER,
      expiresInSeconds: 60,
      nowMs: now,
    });
    assertEquals(await verifyOwnerActorToken(token, now + 61_000), null);
  });
});

Deno.test("authenticateInternalAdmin: accepts the platform owner's token", async () => {
  await withEnv(
    { OWNER_ACTOR_TOKEN_SECRET: SECRET, PLATFORM_OWNER_USER_ID: OWNER },
    async () => {
      const { token } = await createOwnerActorToken({ userId: OWNER });
      assertEquals(await authenticateInternalAdmin(bearer(token)), OWNER);
    },
  );
});

Deno.test("authenticateInternalAdmin: rejects a valid token whose user is NOT the owner", async () => {
  await withEnv(
    { OWNER_ACTOR_TOKEN_SECRET: SECRET, PLATFORM_OWNER_USER_ID: OWNER },
    async () => {
      const { token } = await createOwnerActorToken({ userId: NOT_OWNER });
      assertEquals(await authenticateInternalAdmin(bearer(token)), null);
    },
  );
});

Deno.test("authenticateInternalAdmin: fail-closed when PLATFORM_OWNER_USER_ID is unset", async () => {
  await withEnv(
    { OWNER_ACTOR_TOKEN_SECRET: SECRET, PLATFORM_OWNER_USER_ID: "" },
    async () => {
      const { token } = await createOwnerActorToken({ userId: OWNER });
      assertEquals(await authenticateInternalAdmin(bearer(token)), null);
    },
  );
});

Deno.test("authenticateInternalAdmin: rejects non-owner-actor and empty bearers", async () => {
  await withEnv(
    { OWNER_ACTOR_TOKEN_SECRET: SECRET, PLATFORM_OWNER_USER_ID: OWNER },
    async () => {
      assertEquals(await authenticateInternalAdmin(bearer("gx_some_api_token")), null);
      assertEquals(await authenticateInternalAdmin(bearer("")), null);
    },
  );
});

Deno.test("authenticateRequest: rejects an owner-actor token outright (inert on normal routes)", async () => {
  await withEnv(
    { OWNER_ACTOR_TOKEN_SECRET: SECRET, PLATFORM_OWNER_USER_ID: OWNER },
    async () => {
      const { token } = await createOwnerActorToken({ userId: OWNER });
      await assertRejects(
        () => authenticateRequest(bearer(token)),
        Error,
        "Owner actor tokens are not valid",
      );
    },
  );
});
