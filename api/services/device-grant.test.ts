import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  approveDeviceAuthorization,
  DEVICE_KEY_SCOPES,
  DeviceGrantError,
  mintDeviceAuthorization,
  pollDeviceAuthorization,
} from "./device-grant.ts";

const NOW = new Date("2026-08-03T23:30:00.000Z");
const DEVICE_CODE = "ab".repeat(32);

interface StubState {
  requests: Array<{ method: string; url: string; body: unknown }>;
  rows: Record<string, unknown>[];
  patchRows?: Record<string, unknown>[];
  mintError?: Error;
}

function options(state: StubState) {
  return {
    supabaseUrl: "https://supabase.example.test",
    serviceRoleKey: "service-role-test-key",
    now: () => NOW,
    randomUUID: () => "00000000-0000-4000-8000-0000000000aa",
    randomBytes: (length: number) => {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) bytes[index] = index + 1;
      return bytes;
    },
    fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string"
        ? JSON.parse(init.body)
        : undefined;
      state.requests.push({ method, url, body });
      if (method === "POST") return Response.json([body]);
      if (method === "PATCH") {
        return Response.json(state.patchRows ?? [{ id: "auth-1" }]);
      }
      return Response.json(state.rows);
    }) as typeof fetch,
    mintKey: (userId: string, name: string, opts: unknown) => {
      state.requests.push({
        method: "MINT",
        url: `${userId}:${name}`,
        body: opts,
      });
      if (state.mintError) return Promise.reject(state.mintError);
      // deno-lint-ignore no-explicit-any
      return Promise.resolve({ plaintext_token: "gx_devicekey123" } as any);
    },
  };
}

Deno.test("mint produces a well-formed pairing and stores only the hash", async () => {
  const state: StubState = { requests: [], rows: [] };
  const minted = await mintDeviceAuthorization(options(state));
  assertMatch(minted.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assertMatch(minted.deviceCode, /^[0-9a-f]{64}$/);
  assertEquals(minted.pollIntervalSeconds, 3);
  assertEquals(
    Date.parse(minted.expiresAt) - NOW.getTime(),
    10 * 60 * 1_000,
  );
  const insert = state.requests[0].body as Record<string, unknown>;
  assertEquals(String(insert.device_code_hash).length, 64);
  assert(insert.device_code_hash !== minted.deviceCode);
});

Deno.test("approve confirms a pending code once and refuses the rest", async () => {
  const happy: StubState = {
    requests: [],
    rows: [{
      id: "auth-1",
      status: "pending",
      expires_at: "2026-08-03T23:39:00.000Z",
    }],
  };
  const result = await approveDeviceAuthorization(
    { userCode: "abcd-efgh", userId: "user-1" },
    options(happy),
  );
  assertEquals(result.approved, true);
  const patch = happy.requests.find((entry) => entry.method === "PATCH");
  assert(patch && patch.url.includes("status=eq.pending"));

  const expired: StubState = {
    requests: [],
    rows: [{
      id: "auth-1",
      status: "pending",
      expires_at: "2026-08-03T23:29:00.000Z",
    }],
  };
  const expiredRejection = await assertRejects(
    () =>
      approveDeviceAuthorization(
        { userCode: "ABCD-EFGH", userId: "user-1" },
        options(expired),
      ),
    DeviceGrantError,
  );
  assertEquals((expiredRejection as DeviceGrantError).code, "expired");

  const resolved: StubState = {
    requests: [],
    rows: [{
      id: "auth-1",
      status: "approved",
      expires_at: "2026-08-03T23:39:00.000Z",
    }],
  };
  const resolvedRejection = await assertRejects(
    () =>
      approveDeviceAuthorization(
        { userCode: "ABCD-EFGH", userId: "user-1" },
        options(resolved),
      ),
    DeviceGrantError,
  );
  assertEquals(
    (resolvedRejection as DeviceGrantError).code,
    "already_resolved",
  );
});

Deno.test("poll waits, then exchanges exactly once for a standard-scope key", async () => {
  const pending: StubState = {
    requests: [],
    rows: [{
      id: "auth-1",
      status: "pending",
      expires_at: "2026-08-03T23:39:00.000Z",
      approved_by: null,
    }],
  };
  const wait = await pollDeviceAuthorization(
    { deviceCode: DEVICE_CODE },
    options(pending),
  );
  assertEquals(wait.status, "pending");

  const approved: StubState = {
    requests: [],
    rows: [{
      id: "auth-1",
      status: "approved",
      expires_at: "2026-08-03T23:39:00.000Z",
      approved_by: "user-1",
    }],
  };
  const complete = await pollDeviceAuthorization(
    { deviceCode: DEVICE_CODE },
    options(approved),
  );
  assertEquals(complete.status, "complete");
  if (complete.status === "complete") {
    assertEquals(complete.plaintextToken, "gx_devicekey123");
    assertEquals(complete.scopes, DEVICE_KEY_SCOPES);
  }
  const claim = approved.requests.find((entry) => entry.method === "PATCH");
  const mint = approved.requests.find((entry) => entry.method === "MINT");
  assert(claim && mint, "claims before minting");
  assert(
    approved.requests.indexOf(claim) < approved.requests.indexOf(mint),
    "the exactly-once claim precedes key minting",
  );

  const raced: StubState = {
    requests: [],
    rows: [{
      id: "auth-1",
      status: "approved",
      expires_at: "2026-08-03T23:39:00.000Z",
      approved_by: "user-1",
    }],
    patchRows: [],
  };
  const racedRejection = await assertRejects(
    () =>
      pollDeviceAuthorization({ deviceCode: DEVICE_CODE }, options(raced)),
    DeviceGrantError,
  );
  assertEquals((racedRejection as DeviceGrantError).code, "already_resolved");
});

Deno.test("a non-member approval maps to membership_required", async () => {
  const state: StubState = {
    requests: [],
    rows: [{
      id: "auth-1",
      status: "approved",
      expires_at: "2026-08-03T23:39:00.000Z",
      approved_by: "user-1",
    }],
    mintError: new Error("Active Pro subscription required"),
  };
  const rejection = await assertRejects(
    () => pollDeviceAuthorization({ deviceCode: DEVICE_CODE }, options(state)),
    DeviceGrantError,
  );
  assertEquals((rejection as DeviceGrantError).code, "membership_required");
});
