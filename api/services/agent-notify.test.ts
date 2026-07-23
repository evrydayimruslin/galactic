import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";
import {
  AGENT_NOTIFY_DAILY_CAP,
  notifyOwnerFromAgent,
} from "./agent-notify.ts";

type EnvGlobal = typeof globalThis & { __env?: Record<string, unknown> };

function withEnv() {
  const g = globalThis as EnvGlobal;
  const previous = g.__env;
  g.__env = {
    ...(previous || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  };
  return () => {
    g.__env = previous;
  };
}

// Mock fetch: GET on user_notifications = the rate-cap count (content-range
// total), POST = the insert (returns rows, [] = duplicate).
function mockFetch(state: {
  countTotal: number | "error";
  insertRows?: unknown[];
}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (method === "GET") {
      if (state.countTotal === "error") {
        return new Response("boom", { status: 500 });
      }
      return new Response("[]", {
        status: 200,
        headers: { "content-range": `0-0/${state.countTotal}` },
      });
    }
    return new Response(JSON.stringify(state.insertRows ?? [{ id: "n-1" }]), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

Deno.test("agent notify: missing title / dedupe_key / bad severity throw", async () => {
  const restore = withEnv();
  try {
    const { fetchFn } = mockFetch({ countTotal: 0 });
    await assertRejects(
      () =>
        notifyOwnerFromAgent("app-1", "user-1", { dedupe_key: "k" }, {
          fetchFn,
        }),
      Error,
      "title",
    );
    await assertRejects(
      () =>
        notifyOwnerFromAgent("app-1", "user-1", { title: "Hi" }, { fetchFn }),
      Error,
      "dedupe_key",
    );
    await assertRejects(
      () =>
        notifyOwnerFromAgent("app-1", "user-1", {
          title: "Hi",
          dedupe_key: "k",
          severity: "urgent",
        }, { fetchFn }),
      Error,
      "severity",
    );
  } finally {
    restore();
  }
});

Deno.test("agent notify: writes a namespaced, app-attributed agent_report", async () => {
  const restore = withEnv();
  try {
    const { fetchFn, calls } = mockFetch({ countTotal: 3 });
    const result = await notifyOwnerFromAgent("app-1", "user-1", {
      title: "Digest ready",
      body: "2 anomalies found",
      severity: "warning",
      dedupe_key: "digest:2026-07-09",
    }, { fetchFn });

    assertEquals(result, { created: true });
    const insert = calls.find((c) => c.method === "POST")!;
    const body = insert.body as Record<string, unknown>;
    assertEquals(body.p_user_id, "user-1");
    assertEquals(body.p_kind, "agent_report");
    assertEquals(body.p_severity, "warning");
    assertEquals(body.p_title, "Digest ready");
    assertEquals(body.p_entity_type, "app");
    assertEquals(body.p_entity_id, "app-1");
    // Host-namespaced: an app can never collide with another app's (or a
    // platform kind's) dedupe keys.
    assertEquals(
      body.p_dedupe_key,
      "agent_report:app-1:digest:2026-07-09",
    );
  } finally {
    restore();
  }
});

Deno.test("agent notify: daily cap returns rate_limited without inserting", async () => {
  const restore = withEnv();
  try {
    const { fetchFn, calls } = mockFetch({
      countTotal: AGENT_NOTIFY_DAILY_CAP,
    });
    const result = await notifyOwnerFromAgent("app-1", "user-1", {
      title: "Spam",
      dedupe_key: "k",
    }, { fetchFn });

    assertEquals(result, { created: false, reason: "rate_limited" });
    assertEquals(calls.some((c) => c.method === "POST"), false);
  } finally {
    restore();
  }
});

Deno.test("agent notify: unreadable count fails CLOSED (treated as capped)", async () => {
  const restore = withEnv();
  try {
    const { fetchFn, calls } = mockFetch({ countTotal: "error" });
    const result = await notifyOwnerFromAgent("app-1", "user-1", {
      title: "Hi",
      dedupe_key: "k",
    }, { fetchFn });

    assertEquals(result, { created: false, reason: "rate_limited" });
    assertEquals(calls.some((c) => c.method === "POST"), false);
  } finally {
    restore();
  }
});

Deno.test("agent notify: duplicate dedupe key is a soft no-op", async () => {
  const restore = withEnv();
  try {
    // ignore-duplicates returns an empty representation on conflict.
    const { fetchFn } = mockFetch({ countTotal: 1, insertRows: [] });
    const result = await notifyOwnerFromAgent("app-1", "user-1", {
      title: "Hi",
      dedupe_key: "same-event",
    }, { fetchFn });

    assertEquals(result, { created: false, reason: "duplicate" });
  } finally {
    restore();
  }
});
