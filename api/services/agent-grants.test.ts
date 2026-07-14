import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import {
  createGrant,
  createPendingGrantProposal,
  recordGrantSpend,
  resolveCallerGrant,
} from "./agent-grants.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

type Handler = (url: URL, init: RequestInit | undefined) => Response;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withMockedDb<T>(
  handler: Handler,
  fn: () => Promise<T>,
): Promise<T> {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  } as typeof globalThis.__env;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.__env = previousEnv;
    globalThis.fetch = previousFetch;
  }
}

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "grant-1",
    user_id: "user-1",
    caller_app_id: "app-caller",
    caller_function: null,
    slot: null,
    target_app_id: "app-target",
    target_function: "getStock",
    mode: "call",
    status: "active",
    monthly_cap_credits: 500,
    spent_credits_period: 0,
    period_start: new Date(Date.UTC(2026, 5, 1)).toISOString(),
    constraints: {},
    created_by: "user",
    created_at: new Date(Date.UTC(2026, 5, 1)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 5, 1)).toISOString(),
    ...overrides,
  };
}

const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);

Deno.test("resolveCallerGrant: active grant allows the call", async () => {
  await withMockedDb(
    () => jsonResponse([grantRow()]),
    async () => {
      const result = await resolveCallerGrant({
        userId: "user-1",
        callerAppId: "app-caller",
        callerFunction: "processOrder",
        targetAppId: "app-target",
        targetFunction: "getStock",
        nowMs: NOW,
      });
      assertEquals(result.allowed, true);
      assertEquals(result.grant?.id, "grant-1");
    },
  );
});

Deno.test("resolveCallerGrant: a caller_function-narrowed grant only applies to that function", async () => {
  const narrowed = grantRow({ caller_function: "processOrder" });
  // Matches when the caller function matches.
  await withMockedDb(
    () => jsonResponse([narrowed]),
    async () => {
      const ok = await resolveCallerGrant({
        userId: "user-1",
        callerAppId: "app-caller",
        callerFunction: "processOrder",
        targetAppId: "app-target",
        targetFunction: "getStock",
        nowMs: NOW,
      });
      assertEquals(ok.allowed, true);
    },
  );
  // Denied for a different caller function.
  await withMockedDb(
    () => jsonResponse([narrowed]),
    async () => {
      const denied = await resolveCallerGrant({
        userId: "user-1",
        callerAppId: "app-caller",
        callerFunction: "generateReport",
        targetAppId: "app-target",
        targetFunction: "getStock",
        nowMs: NOW,
      });
      assertEquals(denied.allowed, false);
      assertEquals(denied.reason, "no_grant");
    },
  );
});

Deno.test("resolveCallerGrant: a pending grant denies with reason pending", async () => {
  await withMockedDb(
    () => jsonResponse([grantRow({ status: "pending" })]),
    async () => {
      const result = await resolveCallerGrant({
        userId: "user-1",
        callerAppId: "app-caller",
        callerFunction: null,
        targetAppId: "app-target",
        targetFunction: "getStock",
        nowMs: NOW,
      });
      assertEquals(result.allowed, false);
      assertEquals(result.reason, "pending");
      assertEquals(result.pendingRequestId, "grant-1");
    },
  );
});

Deno.test("resolveCallerGrant: cap reached in the current period denies", async () => {
  await withMockedDb(
    () =>
      jsonResponse([
        grantRow({
          monthly_cap_credits: 500,
          spent_credits_period: 500,
          period_start: new Date(Date.UTC(2026, 5, 1)).toISOString(),
        }),
      ]),
    async () => {
      const result = await resolveCallerGrant({
        userId: "user-1",
        callerAppId: "app-caller",
        callerFunction: null,
        targetAppId: "app-target",
        targetFunction: "getStock",
        nowMs: NOW,
      });
      assertEquals(result.allowed, false);
      assertEquals(result.reason, "cap_exceeded");
    },
  );
});

Deno.test("resolveCallerGrant: spend from a prior month does not count against the cap", async () => {
  await withMockedDb(
    () =>
      jsonResponse([
        grantRow({
          monthly_cap_credits: 500,
          spent_credits_period: 500,
          // period_start is in April; NOW is in June ⇒ window rolled, effective spend 0.
          period_start: new Date(Date.UTC(2026, 3, 1)).toISOString(),
        }),
      ]),
    async () => {
      const result = await resolveCallerGrant({
        userId: "user-1",
        callerAppId: "app-caller",
        callerFunction: null,
        targetAppId: "app-target",
        targetFunction: "getStock",
        nowMs: NOW,
      });
      assertEquals(result.allowed, true);
    },
  );
});

Deno.test("resolveCallerGrant: no matching grant denies with no_grant", async () => {
  await withMockedDb(
    () => jsonResponse([]),
    async () => {
      const result = await resolveCallerGrant({
        userId: "user-1",
        callerAppId: "app-caller",
        callerFunction: null,
        targetAppId: "app-target",
        targetFunction: "getStock",
        nowMs: NOW,
      });
      assertEquals(result.allowed, false);
      assertEquals(result.reason, "no_grant");
    },
  );
});

Deno.test("createGrant: rejects when the user can't call the target function (safety invariant)", async () => {
  const handler: Handler = (url) => {
    if (url.pathname.endsWith("/apps")) {
      const id = url.searchParams.get("id")?.replace("eq.", "");
      if (id === "app-caller") {
        return jsonResponse([{
          id: "app-caller",
          owner_id: "user-1",
          visibility: "private",
        }]);
      }
      // Target is private and owned by someone else.
      return jsonResponse([{
        id: "app-target",
        owner_id: "other-user",
        visibility: "private",
      }]);
    }
    if (url.pathname.endsWith("/user_app_library")) return jsonResponse([]);
    // No user_app_permissions row ⇒ user cannot call the target.
    if (url.pathname.endsWith("/user_app_permissions")) return jsonResponse([]);
    return jsonResponse([]);
  };
  await withMockedDb(handler, async () => {
    await assertRejects(
      () =>
        createGrant("user-1", {
          callerAppId: "app-caller",
          targetAppId: "app-target",
          targetFunction: "getStock",
        }),
      Error,
      "cannot grant access to a function you cannot call",
    );
  });
});

Deno.test("createGrant: rejects when the user neither owns nor installed the caller", async () => {
  const handler: Handler = (url) => {
    if (url.pathname.endsWith("/apps")) {
      const id = url.searchParams.get("id")?.replace("eq.", "");
      return jsonResponse([{
        id,
        owner_id: "other-user",
        visibility: "public",
      }]);
    }
    // Not installed.
    if (url.pathname.endsWith("/user_app_library")) return jsonResponse([]);
    return jsonResponse([]);
  };
  await withMockedDb(handler, async () => {
    await assertRejects(
      () =>
        createGrant("user-1", {
          callerAppId: "app-caller",
          targetAppId: "app-target",
          targetFunction: "getStock",
        }),
      Error,
      "Agents you own or have installed",
    );
  });
});

Deno.test("createGrant: allows wiring an installed caller to a public target and applies the default cap", async () => {
  let insertedCap: unknown = "unset";
  const handler: Handler = (url, init) => {
    if (url.pathname.endsWith("/apps")) {
      const id = url.searchParams.get("id")?.replace("eq.", "");
      if (id === "app-caller") {
        return jsonResponse([{
          id: "app-caller",
          owner_id: "other-user",
          visibility: "public",
        }]);
      }
      return jsonResponse([{
        id: "app-target",
        owner_id: "other-user",
        visibility: "public",
      }]);
    }
    // Caller is installed.
    if (url.pathname.endsWith("/user_app_library")) {
      return jsonResponse([{ app_id: "app-caller" }]);
    }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body))[0];
      insertedCap = body.monthly_cap_credits;
      return jsonResponse([grantRow({
        caller_app_id: "app-caller",
        target_app_id: "app-target",
        monthly_cap_credits: body.monthly_cap_credits,
      })]);
    }
    return jsonResponse([]);
  };
  await withMockedDb(handler, async () => {
    const grant = await createGrant("user-1", {
      callerAppId: "app-caller",
      targetAppId: "app-target",
      targetFunction: "getStock",
    });
    assert(grant.id.length > 0);
    // Default monthly cap applied when not specified.
    assertEquals(insertedCap, 5000);
  });
});

Deno.test("createGrant: re-proposing an active grant never resets the spend window", async () => {
  // A capped agent must not be able to launder its monthly cap by re-running
  // createGrant with identical params (which previously merge-duplicated over
  // its own active row and zeroed spent_credits_period).
  let sawSpendResetInsert = false;
  let patchedFields: Record<string, unknown> | null = null;
  const handler: Handler = (url, init) => {
    if (url.pathname.endsWith("/apps")) {
      return jsonResponse([{
        id: url.searchParams.get("id")?.includes("caller")
          ? "app-caller"
          : "app-target",
        owner_id: "user-1",
        visibility: "public",
      }]);
    }
    if (url.pathname.endsWith("/user_app_library")) {
      return jsonResponse([{ app_id: "app-caller" }]);
    }
    // The pre-check read: an ACTIVE grant with accumulated spend already exists.
    if (url.pathname.endsWith("/agent_function_grants") && !init?.method) {
      return jsonResponse([grantRow({
        id: "grant-1",
        caller_app_id: "app-caller",
        target_app_id: "app-target",
        target_function: "getStock",
        status: "active",
        spent_credits_period: 4000,
        monthly_cap_credits: 5000,
      })]);
    }
    if (url.pathname.endsWith("/agent_function_grants") && init?.method === "POST") {
      const body = JSON.parse(String(init.body))[0];
      if (body.spent_credits_period === 0) sawSpendResetInsert = true;
      return jsonResponse([grantRow(body)]);
    }
    if (url.pathname.endsWith("/agent_function_grants") && init?.method === "PATCH") {
      patchedFields = JSON.parse(String(init.body));
      return jsonResponse([grantRow({
        id: "grant-1",
        status: "active",
        spent_credits_period: 4000,
      })]);
    }
    return jsonResponse([]);
  };
  await withMockedDb(handler, async () => {
    const grant = await createGrant("user-1", {
      callerAppId: "app-caller",
      targetAppId: "app-target",
      targetFunction: "getStock",
    });
    // The active row was PATCHed (cap only), not re-inserted with zeroed spend.
    assertEquals(sawSpendResetInsert, false);
    assert(patchedFields !== null);
    assertEquals("spent_credits_period" in (patchedFields ?? {}), false);
    assertEquals("period_start" in (patchedFields ?? {}), false);
    assertEquals(grant.spentCreditsPeriod, 4000);
  });
});

Deno.test("createGrant: rejects a self-referential grant", async () => {
  await withMockedDb(
    () => jsonResponse([]),
    async () => {
      await assertRejects(
        () =>
          createGrant("user-1", {
            callerAppId: "app-x",
            targetAppId: "app-x",
            targetFunction: "doThing",
          }),
        Error,
        "its own functions",
      );
    },
  );
});

Deno.test("createPendingGrantProposal: API-key wiring stays pending until owner approval", async () => {
  let inserted: Record<string, unknown> | null = null;
  let prefer = "";
  const handler: Handler = (url, init) => {
    if (url.pathname.endsWith("/apps")) {
      return jsonResponse([{
        id: url.searchParams.get("id")?.includes("caller")
          ? "app-caller"
          : "app-target",
        owner_id: "user-1",
        visibility: "private",
        slug: null,
      }]);
    }
    if (url.pathname.endsWith("/agent_function_grants") && !init?.method) {
      return jsonResponse([]);
    }
    if (url.pathname.endsWith("/agent_function_grants") && init?.method === "POST") {
      inserted = JSON.parse(String(init.body))[0];
      prefer = new Headers(init.headers).get("Prefer") || "";
      return jsonResponse([grantRow(inserted)]);
    }
    return jsonResponse([]);
  };

  await withMockedDb(handler, async () => {
    const grant = await createPendingGrantProposal("user-1", {
      callerAppId: "app-caller",
      targetAppId: "app-target",
      targetFunction: "getStock",
      monthlyCapCredits: 25,
    });
    assertEquals(grant.status, "pending");
    assertEquals(inserted?.status, "pending");
    assertEquals(inserted?.monthly_cap_credits, 25);
    assert(prefer.includes("ignore-duplicates"));
  });
});

Deno.test("createPendingGrantProposal: connected keys cannot wire public or cross-owner Agents", async () => {
  for (const forbidden of ["public", "cross-owner"] as const) {
    const handler: Handler = (url) => {
      if (url.pathname.endsWith("/apps")) {
        const isCaller = url.searchParams.get("id")?.includes("caller") === true;
        return jsonResponse([{
          id: isCaller ? "app-caller" : "app-target",
          owner_id: forbidden === "cross-owner" && !isCaller
            ? "user-2"
            : "user-1",
          visibility: forbidden === "public" && !isCaller
            ? "public"
            : "private",
          slug: null,
        }]);
      }
      return jsonResponse([]);
    };

    await withMockedDb(handler, async () => {
      await assertRejects(
        () =>
          createPendingGrantProposal("user-1", {
            callerAppId: "app-caller",
            targetAppId: "app-target",
            targetFunction: "read",
          }),
        Error,
        "private Agents owned by this account",
      );
    });
  }
});

Deno.test("recordGrantSpend: delegates to the atomic increment RPC", async () => {
  let rpcUrl: string | null = null;
  let rpcBody: Record<string, unknown> | null = null;
  const handler: Handler = (url, init) => {
    rpcUrl = url.pathname;
    rpcBody = JSON.parse(String(init?.body));
    return jsonResponse(150);
  };
  await withMockedDb(handler, async () => {
    await recordGrantSpend("grant-1", 30, NOW);
    // Routes to the atomic RPC (not a racy read-modify-write PATCH).
    assertEquals(rpcUrl, "/rest/v1/rpc/increment_agent_grant_spend");
    assertEquals(rpcBody?.p_grant_id, "grant-1");
    assertEquals(rpcBody?.p_amount, 30);
    assert(typeof rpcBody?.p_now === "string");
  });
});

Deno.test("recordGrantSpend: ignores non-positive charges without hitting the DB", async () => {
  let called = false;
  const handler: Handler = () => {
    called = true;
    return jsonResponse(0);
  };
  await withMockedDb(handler, async () => {
    await recordGrantSpend("grant-1", 0, NOW);
    await recordGrantSpend("grant-1", -5, NOW);
    assertEquals(called, false);
  });
});
