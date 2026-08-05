import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  fetchProjectAuthKeys,
  fetchStagingProjectAuthKeys,
  mintOwnerSession,
  mintStagingOwnerSession,
  obtainOwnerSession,
  obtainStagingOwnerSession,
  OWNER_ACCESS_TOKEN_ENV,
  OWNER_SESSION_TARGET_ENV,
  PRODUCTION_API_BASE,
  PRODUCTION_SUPABASE_PROJECT_REF,
  PRODUCTION_SUPABASE_URL,
  resolveSmokeOwner,
  runWithOwnerSession,
  runWithStagingOwnerSession,
  STAGING_API_BASE,
  STAGING_SUPABASE_PROJECT_REF,
  STAGING_SUPABASE_URL,
} from "./with-staging-owner-session.mjs";

const PROJECT_REF = STAGING_SUPABASE_PROJECT_REF;
const OWNER_ID = "7a2f16e1-c578-4c9b-9db7-6b3f49703fe0";
const AGENT_ID = "da122721-e66b-4d3e-b107-b9841c7f7162";
const SESSION_ID = "8725bcf0-2189-4701-98f2-ee652ed3cfb5";
const CANDIDATE_API_VERSION_ID = "12345678-1234-1234-1234-123456789abc";
const STAGING_VERSION_OVERRIDE =
  `ultralight-api-staging="${CANDIDATE_API_VERSION_ID}"`;
const OWNER_EMAIL = "owner@example.test";
const NOW_MS = 1_800_000_000_000;
const SUPABASE_URL = STAGING_SUPABASE_URL;
const PRODUCTION_PROJECT_REF = PRODUCTION_SUPABASE_PROJECT_REF;
const PRODUCTION_SUPABASE = PRODUCTION_SUPABASE_URL;

function jwt(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

const ANON_KEY = jwt({ ref: PROJECT_REF, role: "anon" });
const SERVICE_ROLE_KEY = jwt({
  ref: PROJECT_REF,
  role: "service_role",
});
const PRODUCTION_ANON_KEY = jwt({
  ref: PRODUCTION_PROJECT_REF,
  role: "anon",
});
const PRODUCTION_SERVICE_ROLE_KEY = jwt({
  ref: PRODUCTION_PROJECT_REF,
  role: "service_role",
});

function ownerAccessToken(overrides = {}) {
  return jwt({
    sub: OWNER_ID,
    role: "authenticated",
    aud: "authenticated",
    session_id: SESSION_ID,
    iss: `${SUPABASE_URL}/auth/v1`,
    exp: Math.floor(NOW_MS / 1000) + 3600,
    ...overrides,
  });
}

function productionOwnerAccessToken(overrides = {}) {
  return jwt({
    sub: OWNER_ID,
    role: "authenticated",
    aud: "authenticated",
    session_id: SESSION_ID,
    iss: `${PRODUCTION_SUPABASE}/auth/v1`,
    exp: Math.floor(NOW_MS / 1000) + 3600,
    ...overrides,
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successFetch({
  accessToken = ownerAccessToken(),
  adminUser = { id: OWNER_ID, email: OWNER_EMAIL },
  generatedUser = { id: OWNER_ID, email: OWNER_EMAIL },
  verifiedUser = { id: OWNER_ID, email: OWNER_EMAIL },
  verificationType = "recovery",
  logoutStatus = 204,
} = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method || "GET",
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(init.body) : null,
    });
    const authorization = calls.at(-1).headers.get("authorization");
    if (
      url === `${STAGING_API_BASE}/auth/user` &&
      authorization === "Bearer gx_smoke-secret"
    ) {
      return jsonResponse({
        id: OWNER_ID,
        email: OWNER_EMAIL,
        authSource: "api_token",
        provisional: false,
      });
    }
    if (url === `${STAGING_API_BASE}/api/launch/agents/${AGENT_ID}`) {
      return jsonResponse({
        agent: {
          id: AGENT_ID,
          relationship: "owner",
          visibility: "private",
          owner: { userId: OWNER_ID },
        },
      });
    }
    if (
      url ===
        `https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`
    ) {
      return jsonResponse([
        { name: "anon", type: "legacy", api_key: ANON_KEY },
        {
          name: "service_role",
          type: "legacy",
          api_key: SERVICE_ROLE_KEY,
        },
      ]);
    }
    if (
      url ===
        `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(OWNER_ID)}`
    ) {
      if (adminUser instanceof Response) return adminUser;
      return jsonResponse(adminUser);
    }
    if (url === `${SUPABASE_URL}/auth/v1/admin/generate_link`) {
      return jsonResponse({
        ...generatedUser,
        hashed_token: "single-use-token-hash",
        verification_type: verificationType,
      });
    }
    if (url === `${SUPABASE_URL}/auth/v1/verify`) {
      return jsonResponse({
        access_token: accessToken,
        refresh_token: "discarded-refresh-token",
        user: verifiedUser,
      });
    }
    if (url === `${SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: OWNER_ID, email: OWNER_EMAIL });
    }
    if (url === `${SUPABASE_URL}/auth/v1/logout?scope=local`) {
      return new Response(null, { status: logoutStatus });
    }
    if (url === `${STAGING_API_BASE}/auth/user`) {
      return jsonResponse({
        id: OWNER_ID,
        email: OWNER_EMAIL,
        authSource: "supabase",
      });
    }
    throw new Error(`unexpected test URL: ${url}`);
  };
  return { fetchImpl, calls };
}

function productionSuccessFetch() {
  const accessToken = productionOwnerAccessToken();
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method: init.method || "GET",
      headers,
      body: init.body ? JSON.parse(init.body) : null,
    });
    const authorization = headers.get("authorization");
    if (
      url === `${PRODUCTION_API_BASE}/auth/user` &&
      authorization === "Bearer gx_production-smoke-secret"
    ) {
      return jsonResponse({
        id: OWNER_ID,
        email: OWNER_EMAIL,
        authSource: "api_token",
        provisional: false,
      });
    }
    if (
      url ===
        `${PRODUCTION_API_BASE}/api/launch/agents/${AGENT_ID}` &&
      authorization === "Bearer gx_production-smoke-secret"
    ) {
      return jsonResponse({
        agent: {
          id: AGENT_ID,
          relationship: "owner",
          visibility: "private",
          owner: { userId: OWNER_ID },
        },
      });
    }
    if (
      url ===
        `https://api.supabase.com/v1/projects/${PRODUCTION_PROJECT_REF}/api-keys?reveal=true`
    ) {
      return jsonResponse([
        { name: "anon", type: "legacy", api_key: PRODUCTION_ANON_KEY },
        {
          name: "service_role",
          type: "legacy",
          api_key: PRODUCTION_SERVICE_ROLE_KEY,
        },
      ]);
    }
    if (
      url ===
        `${PRODUCTION_SUPABASE}/auth/v1/admin/users/${
          encodeURIComponent(OWNER_ID)
        }`
    ) {
      return jsonResponse({ id: OWNER_ID, email: OWNER_EMAIL });
    }
    if (url === `${PRODUCTION_SUPABASE}/auth/v1/admin/generate_link`) {
      return jsonResponse({
        id: OWNER_ID,
        email: OWNER_EMAIL,
        hashed_token: "production-single-use-token-hash",
        verification_type: "recovery",
      });
    }
    if (url === `${PRODUCTION_SUPABASE}/auth/v1/verify`) {
      return jsonResponse({
        access_token: accessToken,
        refresh_token: "discarded-production-refresh-token",
        user: { id: OWNER_ID, email: OWNER_EMAIL },
      });
    }
    if (url === `${PRODUCTION_SUPABASE}/auth/v1/user`) {
      return jsonResponse({ id: OWNER_ID, email: OWNER_EMAIL });
    }
    if (
      url === `${PRODUCTION_API_BASE}/auth/user` &&
      authorization === `Bearer ${accessToken}`
    ) {
      return jsonResponse({
        id: OWNER_ID,
        email: OWNER_EMAIL,
        authSource: "supabase",
      });
    }
    if (url === `${PRODUCTION_SUPABASE}/auth/v1/logout?scope=local`) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected production test URL: ${url}`);
  };
  return { fetchImpl, calls, accessToken };
}

test("mints one owner session through the exact single-use exchange", async () => {
  const { fetchImpl, calls } = successFetch();
  const session = await obtainStagingOwnerSession({
    managementAccessToken: "management-secret",
    projectRef: PROJECT_REF,
    apiToken: "gx_smoke-secret",
    smokeAgentId: AGENT_ID,
    apiVersionId: CANDIDATE_API_VERSION_ID,
    fetchImpl,
    now: () => NOW_MS,
  });

  assert.equal(session.accessToken, ownerAccessToken());
  assert.equal(
    session.expiresAt,
    new Date((Math.floor(NOW_MS / 1000) + 3600) * 1000).toISOString(),
  );
  assert.equal(
    calls.filter((call) =>
      call.url === `${SUPABASE_URL}/auth/v1/admin/generate_link`
    ).length,
    1,
  );
  assert.equal(
    calls.filter((call) =>
      call.url === `${SUPABASE_URL}/auth/v1/verify`
    ).length,
    1,
  );

  const generate = calls.find((call) =>
    call.url.endsWith("/auth/v1/admin/generate_link")
  );
  const adminLookup = calls.find((call) =>
    call.url.includes("/auth/v1/admin/users/")
  );
  assert.equal(adminLookup.method, "GET");
  assert.equal(adminLookup.headers.get("apikey"), SERVICE_ROLE_KEY);
  assert.equal(
    adminLookup.headers.get("authorization"),
    `Bearer ${SERVICE_ROLE_KEY}`,
  );
  assert.ok(calls.indexOf(adminLookup) < calls.indexOf(generate));
  assert.deepEqual(generate.body, {
    type: "recovery",
    email: OWNER_EMAIL,
  });
  assert.equal(generate.headers.get("apikey"), SERVICE_ROLE_KEY);
  assert.equal(
    generate.headers.get("authorization"),
    `Bearer ${SERVICE_ROLE_KEY}`,
  );

  const verify = calls.find((call) => call.url.endsWith("/auth/v1/verify"));
  assert.deepEqual(verify.body, {
    type: "recovery",
    token_hash: "single-use-token-hash",
  });
  assert.equal(verify.headers.get("apikey"), ANON_KEY);
  assert.equal(verify.headers.has("authorization"), false);

  const management = calls.find((call) =>
    call.url.includes("api.supabase.com")
  );
  assert.equal(
    management.headers.get("authorization"),
    "Bearer management-secret",
  );
  assert.equal(
    calls.find((call) =>
      call.url === `${STAGING_API_BASE}/auth/user` &&
      call.headers.get("authorization") === `Bearer ${session.accessToken}`
    ).headers.get("authorization"),
    `Bearer ${session.accessToken}`,
  );
  const galacticCalls = calls.filter((call) =>
    call.url.startsWith(STAGING_API_BASE)
  );
  assert.equal(galacticCalls.length, 3);
  assert.equal(
    galacticCalls.every((call) =>
      call.headers.get("cloudflare-workers-version-overrides") ===
        STAGING_VERSION_OVERRIDE
    ),
    true,
  );
  assert.equal(
    calls.filter((call) => !call.url.startsWith(STAGING_API_BASE)).every(
      (call) =>
        !call.headers.has("cloudflare-workers-version-overrides"),
    ),
    true,
  );
  await session.revoke();
  const logout = calls.filter((call) =>
    call.url === `${SUPABASE_URL}/auth/v1/logout?scope=local`
  );
  assert.equal(logout.length, 1);
  assert.equal(logout[0].method, "POST");
  assert.equal(logout[0].headers.get("apikey"), ANON_KEY);
  assert.equal(
    logout[0].headers.get("authorization"),
    `Bearer ${session.accessToken}`,
  );
  await session.revoke();
  assert.equal(
    calls.filter((call) =>
      call.url === `${SUPABASE_URL}/auth/v1/logout?scope=local`
    ).length,
    1,
  );
});

test("mints the production owner session only through pinned production origins", async () => {
  const { fetchImpl, calls, accessToken } = productionSuccessFetch();
  const session = await obtainOwnerSession({
    target: "production",
    managementAccessToken: "production-management-secret",
    projectRef: PRODUCTION_PROJECT_REF,
    apiToken: "gx_production-smoke-secret",
    smokeAgentId: AGENT_ID,
    fetchImpl,
    now: () => NOW_MS,
  });

  assert.equal(session.accessToken, accessToken);
  assert.equal(
    calls.some((call) => call.url.startsWith(STAGING_API_BASE)),
    false,
  );
  assert.equal(
    calls.some((call) => call.url.startsWith(STAGING_SUPABASE_URL)),
    false,
  );
  assert.equal(
    calls.some((call) => call.url.includes(STAGING_SUPABASE_PROJECT_REF)),
    false,
  );
  assert.equal(
    calls.filter((call) =>
      call.url === `${PRODUCTION_API_BASE}/auth/user`
    ).length,
    2,
  );
  await session.revoke();
  assert.equal(
    calls.filter((call) =>
      call.url === `${PRODUCTION_SUPABASE}/auth/v1/logout?scope=local`
    ).length,
    1,
  );
});

test("generic owner bootstrap rejects cross-target origins and projects before fetching", async () => {
  const cases = [
    () =>
      resolveSmokeOwner({
        target: "production",
        apiBase: STAGING_API_BASE,
        apiToken: "gx_production-smoke-secret",
        smokeAgentId: AGENT_ID,
        fetchImpl: forbiddenFetch,
      }),
    () =>
      fetchProjectAuthKeys({
        target: "production",
        managementAccessToken: "production-management-secret",
        projectRef: STAGING_SUPABASE_PROJECT_REF,
        fetchImpl: forbiddenFetch,
      }),
    () =>
      mintOwnerSession({
        target: "production",
        owner: { id: OWNER_ID, email: OWNER_EMAIL },
        apiBase: PRODUCTION_API_BASE,
        supabaseUrl: STAGING_SUPABASE_URL,
        anonKey: PRODUCTION_ANON_KEY,
        serviceRoleKey: PRODUCTION_SERVICE_ROLE_KEY,
        fetchImpl: forbiddenFetch,
        now: () => NOW_MS,
      }),
  ];
  let fetchCalls = 0;
  async function forbiddenFetch() {
    fetchCalls += 1;
    return jsonResponse({});
  }
  for (const runCase of cases) {
    await assert.rejects(runCase(), /pinned production|production project/u);
  }
  assert.equal(fetchCalls, 0);
});

test("owner bootstrap rejects a malformed Worker version override before fetching", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    resolveSmokeOwner({
      apiToken: "gx_smoke-secret",
      smokeAgentId: AGENT_ID,
      apiVersionId: 'invalid-version\" , injected="value',
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse({});
      },
    }),
    /Worker version id is invalid/u,
  );
  assert.equal(fetchCalls, 0);
});

test("zero-create gate stops when the exact auth user does not exist", async () => {
  const { fetchImpl, calls } = successFetch({
    adminUser: new Response(
      JSON.stringify({ message: "user not found", secret: "never-log-this" }),
      { status: 404 },
    ),
  });
  await assert.rejects(
    obtainStagingOwnerSession({
      managementAccessToken: "management-secret",
      projectRef: PROJECT_REF,
      apiToken: "gx_smoke-secret",
      smokeAgentId: AGENT_ID,
      fetchImpl,
      now: () => NOW_MS,
    }),
    (error) => {
      assert.match(error.message, /existence verification failed \(HTTP 404\)/u);
      assert.doesNotMatch(error.message, /never-log-this/u);
      return true;
    },
  );
  assert.equal(
    calls.some((call) => call.url.endsWith("/admin/generate_link")),
    false,
  );
  assert.equal(calls.some((call) => call.url.endsWith("/verify")), false);
  assert.equal(calls.some((call) => call.url.includes("/logout")), false);
});

test("zero-create gate rejects an auth user with a different id or email", async () => {
  for (
    const adminUser of [
      {
        id: "1c035a91-4819-4ff0-a302-2f41275984dc",
        email: OWNER_EMAIL,
      },
      { id: OWNER_ID, email: "different@example.test" },
    ]
  ) {
    const { fetchImpl, calls } = successFetch({ adminUser });
    await assert.rejects(
      obtainStagingOwnerSession({
        managementAccessToken: "management-secret",
        projectRef: PROJECT_REF,
        apiToken: "gx_smoke-secret",
        smokeAgentId: AGENT_ID,
        fetchImpl,
        now: () => NOW_MS,
      }),
      /auth user did not match/u,
    );
    assert.equal(
      calls.some((call) => call.url.endsWith("/admin/generate_link")),
      false,
    );
  }
});

test("requires the recovery exchange to return the exact owner", async () => {
  const { fetchImpl, calls } = successFetch({ verifiedUser: null });
  await assert.rejects(
    mintStagingOwnerSession({
      owner: { id: OWNER_ID, email: OWNER_EMAIL },
      supabaseUrl: SUPABASE_URL,
      anonKey: ANON_KEY,
      serviceRoleKey: SERVICE_ROLE_KEY,
      fetchImpl,
      now: () => NOW_MS,
    }),
    /did not return the exact owner/u,
  );
  assert.equal(
    calls.filter((call) =>
      call.url === `${SUPABASE_URL}/auth/v1/logout?scope=local`
    ).length,
    1,
  );
  assert.equal(
    calls.filter((call) => call.url === `${STAGING_API_BASE}/auth/user`).length,
    0,
  );
});

test("requires recovery data to name the exact existing owner", async () => {
  for (
    const overrides of [
      { verificationType: "magiclink" },
      {
        generatedUser: {
          id: "1c035a91-4819-4ff0-a302-2f41275984dc",
          email: OWNER_EMAIL,
        },
      },
      {
        generatedUser: {
          id: OWNER_ID,
          email: "different@example.test",
        },
      },
    ]
  ) {
    const { fetchImpl, calls } = successFetch(overrides);
    await assert.rejects(
      mintStagingOwnerSession({
        owner: { id: OWNER_ID, email: OWNER_EMAIL },
        supabaseUrl: SUPABASE_URL,
        anonKey: ANON_KEY,
        serviceRoleKey: SERVICE_ROLE_KEY,
        fetchImpl,
        now: () => NOW_MS,
      }),
      /unexpected identity/u,
    );
    assert.equal(calls.some((call) => call.url.endsWith("/verify")), false);
    assert.equal(calls.some((call) => call.url.includes("/logout")), false);
  }
});

test("fails before privileged key lookup when the fixture owner mismatches", async () => {
  const { fetchImpl: baseFetch, calls } = successFetch();
  const fetchImpl = async (input, init) => {
    const response = await baseFetch(input, init);
    if (String(input).includes("/api/launch/agents/")) {
      return jsonResponse({
        agent: {
          id: AGENT_ID,
          relationship: "installed",
          owner: {
            userId: "1c035a91-4819-4ff0-a302-2f41275984dc",
          },
        },
      });
    }
    return response;
  };

  await assert.rejects(
    obtainStagingOwnerSession({
      managementAccessToken: "management-secret",
      projectRef: PROJECT_REF,
      apiToken: "gx_smoke-secret",
      smokeAgentId: AGENT_ID,
      fetchImpl,
      now: () => NOW_MS,
    }),
    /not owned by the smoke-token identity/u,
  );
  assert.equal(calls.some((call) => call.url.includes("api.supabase.com")), false);
});

test("requires unambiguous legacy keys bound to the exact project", async () => {
  const wrongProjectKey = jwt({
    ref: "aaaaaaaaaaaaaaaaaaaa",
    role: "service_role",
  });
  const fetchImpl = async () =>
    jsonResponse([
      { name: "anon", type: "legacy", api_key: ANON_KEY },
      {
        name: "service_role",
        type: "legacy",
        api_key: wrongProjectKey,
      },
    ]);
  await assert.rejects(
    fetchStagingProjectAuthKeys({
      managementAccessToken: "management-secret",
      projectRef: PROJECT_REF,
      fetchImpl,
    }),
    /does not belong to the staging project/u,
  );

  await assert.rejects(
    fetchStagingProjectAuthKeys({
      managementAccessToken: "management-secret",
      projectRef: PROJECT_REF,
      fetchImpl: async () =>
        jsonResponse([
          { name: "anon", type: "legacy", api_key: ANON_KEY },
        ]),
    }),
    /exactly one legacy service_role/u,
  );
});

test("rejects a miswired non-staging Supabase project before any request", async () => {
  let fetchCalled = false;
  await assert.rejects(
    fetchStagingProjectAuthKeys({
      managementAccessToken: "management-secret",
      projectRef: "aaaaaaaaaaaaaaaaaaaa",
      fetchImpl: async () => {
        fetchCalled = true;
        return jsonResponse([]);
      },
    }),
    /pinned staging project/u,
  );
  assert.equal(fetchCalled, false);
});

test("never includes an upstream secret response in errors", async () => {
  const leaked = "service-role-must-not-appear";
  await assert.rejects(
    fetchStagingProjectAuthKeys({
      managementAccessToken: "management-secret",
      projectRef: PROJECT_REF,
      fetchImpl: async () =>
        new Response(JSON.stringify({ api_key: leaked }), { status: 403 }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 403/u);
      assert.doesNotMatch(error.message, new RegExp(leaked, "u"));
      assert.doesNotMatch(error.message, /api_key/u);
      return true;
    },
  );
});

test("rejects a validly shaped JWT for the wrong owner", async () => {
  const { fetchImpl, calls } = successFetch({
    accessToken: ownerAccessToken({
      sub: "1c035a91-4819-4ff0-a302-2f41275984dc",
    }),
  });
  await assert.rejects(
    mintStagingOwnerSession({
      owner: { id: OWNER_ID, email: OWNER_EMAIL },
      supabaseUrl: SUPABASE_URL,
      anonKey: ANON_KEY,
      serviceRoleKey: SERVICE_ROLE_KEY,
      fetchImpl,
      now: () => NOW_MS,
    }),
    /unexpected identity claims/u,
  );
  assert.equal(
    calls.filter((call) =>
      call.url === `${SUPABASE_URL}/auth/v1/logout?scope=local`
    ).length,
    1,
  );
});

test("requires authenticated audience and a session id in the owner JWT", async () => {
  for (
    const overrides of [
      { aud: "anon" },
      { session_id: undefined },
      { session_id: "not-a-uuid" },
    ]
  ) {
    const { fetchImpl, calls } = successFetch({
      accessToken: ownerAccessToken(overrides),
    });
    await assert.rejects(
      mintStagingOwnerSession({
        owner: { id: OWNER_ID, email: OWNER_EMAIL },
        supabaseUrl: SUPABASE_URL,
        anonKey: ANON_KEY,
        serviceRoleKey: SERVICE_ROLE_KEY,
        fetchImpl,
        now: () => NOW_MS,
      }),
      /unexpected identity claims/u,
    );
    assert.equal(
      calls.filter((call) =>
        call.url === `${SUPABASE_URL}/auth/v1/logout?scope=local`
      ).length,
      1,
    );
  }
});

test("rejects expired or overly long owner sessions", async () => {
  for (
    const exp of [
      Math.floor(NOW_MS / 1000) - 1,
      Math.floor(NOW_MS / 1000) + (3 * 60 * 60),
    ]
  ) {
    const { fetchImpl } = successFetch({
      accessToken: ownerAccessToken({ exp }),
    });
    await assert.rejects(
      mintStagingOwnerSession({
        owner: { id: OWNER_ID, email: OWNER_EMAIL },
        supabaseUrl: SUPABASE_URL,
        anonKey: ANON_KEY,
        serviceRoleKey: SERVICE_ROLE_KEY,
        fetchImpl,
        now: () => NOW_MS,
      }),
      /short-lived TTL/u,
    );
  }
});

test("passes the bearer only in the child environment, never argv", async () => {
  const token = ownerAccessToken();
  let invocation;
  let passedEnv;
  let revokeCalls = 0;
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options };
    passedEnv = { ...options.env };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };

  const result = await runWithStagingOwnerSession(
    {
      accessToken: token,
      expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
      revoke: async () => {
        revokeCalls += 1;
      },
    },
    "node",
    ["owner-smoke.mjs", "--safe-arg"],
    {
      spawnImpl,
      baseEnv: {
        SAFE_BASE: "yes",
        PATH: "/safe/bin",
        ULTRALIGHT_TOKEN: "gx_required-smoke-token",
        GALACTIC_SMOKE_APP_ID: AGENT_ID,
        SUPABASE_ACCESS_TOKEN: "supabase-management-secret",
        SUPABASE_STAGING_PROJECT_ID: PROJECT_REF,
        CLOUDFLARE_API_TOKEN: "cloudflare-secret",
        GITHUB_TOKEN: "github-secret",
        DATABASE_COOKIE: "database-cookie",
      },
    },
  );

  assert.equal(result, 0);
  assert.equal(invocation.command, "node");
  assert.deepEqual(invocation.args, ["owner-smoke.mjs", "--safe-arg"]);
  assert.equal(invocation.args.includes(token), false);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.SAFE_BASE, "yes");
  assert.equal(invocation.options.env.PATH, "/safe/bin");
  assert.equal(passedEnv[OWNER_ACCESS_TOKEN_ENV], token);
  assert.equal(
    passedEnv.ULTRALIGHT_TOKEN,
    "gx_required-smoke-token",
  );
  assert.equal(passedEnv.GALACTIC_SMOKE_APP_ID, AGENT_ID);
  assert.equal(passedEnv[OWNER_SESSION_TARGET_ENV], "staging");
  for (
    const name of [
      "SUPABASE_ACCESS_TOKEN",
      "SUPABASE_STAGING_PROJECT_ID",
      "CLOUDFLARE_API_TOKEN",
      "GITHUB_TOKEN",
      "DATABASE_COOKIE",
    ]
  ) {
    assert.equal(Object.hasOwn(passedEnv, name), false, name);
  }
  assert.equal(Object.hasOwn(passedEnv, "GALACTIC_OWNER_ID"), false);
  assert.equal(
    Object.hasOwn(passedEnv, "GALACTIC_OWNER_SESSION_EXPIRES_AT"),
    false,
  );
  // The helper scrubs its retained env object after spawn. A real child has
  // already received its OS-level copy at that point.
  assert.equal(invocation.options.env[OWNER_ACCESS_TOKEN_ENV], "");
  assert.equal(invocation.options.env[OWNER_SESSION_TARGET_ENV], "");
  assert.equal(invocation.options.env.ULTRALIGHT_TOKEN, "");
  assert.equal(invocation.options.env.GALACTIC_SMOKE_APP_ID, "");
  assert.equal(process.env[OWNER_ACCESS_TOKEN_ENV], undefined);
  assert.equal(revokeCalls, 1);
});

test("generic child runner injects production target and preserves nonsecret release metadata", async () => {
  let passedEnv;
  let revokeCalls = 0;
  const spawnImpl = (_command, _args, options) => {
    passedEnv = { ...options.env };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const result = await runWithOwnerSession(
    {
      accessToken: productionOwnerAccessToken(),
      revoke: async () => {
        revokeCalls += 1;
      },
    },
    "node",
    ["scripts/smoke/compute-admitted-smoke.mjs"],
    {
      target: "production",
      spawnImpl,
      baseEnv: {
        PATH: "/safe/bin",
        ULTRALIGHT_TOKEN: "gx_production-smoke-secret",
        GALACTIC_SMOKE_APP_ID: AGENT_ID,
        SUPABASE_ACCESS_TOKEN: "management-secret",
        SUPABASE_PRODUCTION_PROJECT_ID: PRODUCTION_PROJECT_REF,
        COMPUTE_RELEASE_SHA: "a".repeat(40),
        COMPUTE_RELEASE_RUN_ID: "123456",
        COMPUTE_RELEASE_EVIDENCE_DIR: "/tmp/release-evidence",
        GALACTIC_SMOKE_FIXTURE: "compute-certification",
        COMPUTE_CERTIFICATION_API_VERSION_ID: CANDIDATE_API_VERSION_ID,
      },
    },
  );
  assert.equal(result, 0);
  assert.equal(passedEnv[OWNER_SESSION_TARGET_ENV], "production");
  assert.equal(
    passedEnv[OWNER_ACCESS_TOKEN_ENV],
    productionOwnerAccessToken(),
  );
  assert.equal(passedEnv.COMPUTE_RELEASE_SHA, "a".repeat(40));
  assert.equal(passedEnv.COMPUTE_RELEASE_RUN_ID, "123456");
  assert.equal(
    passedEnv.COMPUTE_RELEASE_EVIDENCE_DIR,
    "/tmp/release-evidence",
  );
  assert.equal(
    passedEnv.GALACTIC_SMOKE_FIXTURE,
    "compute-certification",
  );
  assert.equal(
    passedEnv.COMPUTE_CERTIFICATION_API_VERSION_ID,
    CANDIDATE_API_VERSION_ID,
  );
  assert.equal(
    Object.hasOwn(passedEnv, "SUPABASE_PRODUCTION_PROJECT_ID"),
    false,
  );
  assert.equal(revokeCalls, 1);
});

test("fails closed and revokes when a required child smoke variable is absent", async () => {
  let spawnCalled = false;
  let revokeCalls = 0;
  await assert.rejects(
    runWithStagingOwnerSession(
      {
        accessToken: ownerAccessToken(),
        revoke: async () => {
          revokeCalls += 1;
        },
      },
      "node",
      ["owner-smoke.mjs"],
      {
        spawnImpl: () => {
          spawnCalled = true;
          return new EventEmitter();
        },
        baseEnv: { ULTRALIGHT_TOKEN: "gx_required-smoke-token" },
      },
    ),
    /GALACTIC_SMOKE_APP_ID is required/u,
  );
  assert.equal(spawnCalled, false);
  assert.equal(revokeCalls, 1);
});

test("locally revokes the session when the child cannot start", async () => {
  let revokeCalls = 0;
  await assert.rejects(
    runWithStagingOwnerSession(
      {
        accessToken: ownerAccessToken(),
        revoke: async () => {
          revokeCalls += 1;
        },
      },
      "missing-owner-smoke",
      [],
      {
        spawnImpl: () => {
          throw new Error("fake spawn detail");
        },
        baseEnv: {
          ULTRALIGHT_TOKEN: "gx_required-smoke-token",
          GALACTIC_SMOKE_APP_ID: AGENT_ID,
        },
      },
    ),
    /Could not start owner-session child command/u,
  );
  assert.equal(revokeCalls, 1);
});

test("local logout does not assume the stateless access JWT is immediately invalid", async () => {
  const { fetchImpl, calls } = successFetch();
  const session = await mintStagingOwnerSession({
    owner: { id: OWNER_ID, email: OWNER_EMAIL },
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    serviceRoleKey: SERVICE_ROLE_KEY,
    fetchImpl,
    now: () => NOW_MS,
  });
  await session.revoke();
  assert.equal(
    calls.filter((call) =>
      call.url === `${SUPABASE_URL}/auth/v1/logout?scope=local`
    ).length,
    1,
  );
  assert.equal(
    calls.filter((call) => call.url === `${STAGING_API_BASE}/auth/user`).length,
    1,
  );
});

test("local logout fails closed on an unexpected Supabase response", async () => {
  const { fetchImpl } = successFetch({ logoutStatus: 500 });
  const session = await mintStagingOwnerSession({
    owner: { id: OWNER_ID, email: OWNER_EMAIL },
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    serviceRoleKey: SERVICE_ROLE_KEY,
    fetchImpl,
    now: () => NOW_MS,
  });
  await assert.rejects(
    session.revoke(),
    /local owner-session cleanup failed \(HTTP 500\)/u,
  );
});
