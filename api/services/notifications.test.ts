import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  createNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  sweepExpiredNotifications,
} from "./notifications.ts";

const NOW = new Date("2026-07-08T12:00:00.000Z");

function installEnv() {
  const original = globalThis.__env;
  globalThis.__env = {
    ...(original || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  return () => {
    globalThis.__env = original;
  };
}

interface Captured {
  url: string;
  method: string;
  prefer: string | null;
  body: unknown;
}

function capturingFetch(
  respond: (c: Captured) => Response,
): { fetchFn: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Captured = {
      url: input.toString(),
      method: init?.method || "GET",
      prefer: (init?.headers as Record<string, string> | undefined)?.["Prefer"] ??
        null,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    return respond(c);
  }) as typeof fetch;
  return { fetchFn, calls };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

Deno.test("createNotification inserts idempotently (ignore-duplicates) and returns the row", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() =>
      jsonResponse([{
        id: "n1",
        user_id: "u1",
        agent_id: "a1",
        kind: "routine_paused",
        severity: "critical",
        title: "X was paused",
        body: "reason",
        entity_type: "routine",
        entity_id: "r1",
        action_url: null,
        delivered_channels: [],
        created_at: NOW.toISOString(),
        read_at: null,
      }])
    );
    const row = await createNotification({
      userId: "u1",
      agentId: "a1",
      kind: "routine_paused",
      severity: "critical",
      title: "X was paused",
      body: "reason",
      entityType: "routine",
      entityId: "r1",
      dedupeKey: "routine_paused:r1:2026-07-08T12:00:00.000Z",
    }, { fetchFn });

    assertEquals(row?.id, "n1");
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "POST");
    assert(calls[0].url.includes("/user_notifications"));
    // The idempotency guard: on-conflict-do-nothing.
    assert(calls[0].prefer?.includes("resolution=ignore-duplicates"));
    const body = calls[0].body as Record<string, unknown>;
    assertEquals(body.dedupe_key, "routine_paused:r1:2026-07-08T12:00:00.000Z");
    assertEquals(body.severity, "critical");
    assertEquals(body.agent_id, "a1");
  } finally {
    restore();
  }
});

Deno.test("createNotification returns null on a duplicate (empty representation)", async () => {
  const restore = installEnv();
  try {
    const { fetchFn } = capturingFetch(() => jsonResponse([]));
    const row = await createNotification({
      userId: "u1",
      kind: "routine_paused",
      title: "dup",
      dedupeKey: "k",
    }, { fetchFn });
    assertEquals(row, null);
  } finally {
    restore();
  }
});

Deno.test("createNotification is best-effort — swallows errors and returns null", async () => {
  const restore = installEnv();
  try {
    const { fetchFn } = capturingFetch(() =>
      new Response("boom", { status: 500 })
    );
    const row = await createNotification({
      userId: "u1",
      kind: "routine_paused",
      title: "x",
      dedupeKey: "k",
    }, { fetchFn });
    assertEquals(row, null);
  } finally {
    restore();
  }
});

Deno.test("listNotifications builds a newest-first, user-scoped query with unread filter", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() => jsonResponse([]));
    await listNotifications("u1", { unreadOnly: true, limit: 10 }, { fetchFn });
    const url = calls[0].url;
    assert(url.includes("user_id=eq.u1"));
    assert(url.includes("order=created_at.desc"));
    assert(url.includes("limit=10"));
    assert(url.includes("read_at=is.null"));
  } finally {
    restore();
  }
});

Deno.test("listNotifications clamps limit to [1,200]", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() => jsonResponse([]));
    await listNotifications("u1", { limit: 9999 }, { fetchFn });
    assert(calls[0].url.includes("limit=200"));
  } finally {
    restore();
  }
});

Deno.test("notification reads and unread counts can be scoped to one Agent", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch((call) =>
      call.url.includes("select=id")
        ? new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json", "Content-Range": "0-0/0" },
        })
        : jsonResponse([])
    );
    const { countUnread } = await import("./notifications.ts");
    await listNotifications("u1", { agentId: "a1" }, { fetchFn });
    await countUnread("u1", { agentId: "a1" }, { fetchFn });
    assert(calls.every((call) => call.url.includes("agent_id=eq.a1")));
  } finally {
    restore();
  }
});

Deno.test("markNotificationsRead patches only the owner's unread rows and counts them", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() =>
      jsonResponse([{ id: "a" }, { id: "b" }])
    );
    const n = await markNotificationsRead("u1", ["a", "b"], { fetchFn });
    assertEquals(n, 2);
    const url = calls[0].url;
    assertEquals(calls[0].method, "PATCH");
    assert(url.includes("user_id=eq.u1"));
    assert(url.includes("id=in.(a,b)"));
    assert(url.includes("read_at=is.null")); // never re-touch already-read rows
    assertEquals((calls[0].body as Record<string, unknown>).read_at !== undefined, true);
  } finally {
    restore();
  }
});

Deno.test("markNotificationsRead with no ids is a no-op (no request)", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() => jsonResponse([]));
    assertEquals(await markNotificationsRead("u1", [], { fetchFn }), 0);
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test("markNotificationsRead respects the Agent filter for selected ids", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() => jsonResponse([{ id: "a" }]));
    const n = await markNotificationsRead(
      "u1",
      ["a"],
      { agentId: "agent-1" },
      { fetchFn },
    );
    assertEquals(n, 1);
    assert(calls[0].url.includes("user_id=eq.u1"));
    assert(calls[0].url.includes("agent_id=eq.agent-1"));
    assert(calls[0].url.includes("id=in.(a)"));
  } finally {
    restore();
  }
});

Deno.test("markAllNotificationsRead patches all unread rows for the owner", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() => jsonResponse([{ id: "a" }]));
    const n = await markAllNotificationsRead("u1", { fetchFn });
    assertEquals(n, 1);
    assert(calls[0].url.includes("user_id=eq.u1"));
    assert(calls[0].url.includes("read_at=is.null"));
  } finally {
    restore();
  }
});

Deno.test("markAllNotificationsRead respects the Agent filter", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() => jsonResponse([{ id: "a" }]));
    const n = await markAllNotificationsRead("u1", { agentId: "agent-1" }, { fetchFn });
    assertEquals(n, 1);
    assert(calls[0].url.includes("agent_id=eq.agent-1"));
  } finally {
    restore();
  }
});

Deno.test("sweepExpiredNotifications deletes rows older than the 90-day cutoff", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() => jsonResponse([{ id: "old" }]));
    const n = await sweepExpiredNotifications(NOW, { fetchFn });
    assertEquals(n, 1);
    assertEquals(calls[0].method, "DELETE");
    // cutoff = NOW - 90d = 2026-04-09T12:00:00.000Z
    assert(calls[0].url.includes("created_at=lt."));
    assert(calls[0].url.includes("2026-04-09T12%3A00%3A00.000Z"));
    // Never delete a still-UNREAD critical alert: only rows that are read OR
    // non-critical are swept.
    assert(
      decodeURIComponent(calls[0].url).includes(
        "or=(read_at.not.is.null,severity.neq.critical)",
      ),
      "sweep must preserve unread criticals",
    );
  } finally {
    restore();
  }
});
