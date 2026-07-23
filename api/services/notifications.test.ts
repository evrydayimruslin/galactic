import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  classifyNotificationKind,
  countAttention,
  countUnread,
  createNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  resolveNotificationIncidentByDedupe,
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
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const c: Captured = {
      url: input.toString(),
      method: init?.method || "GET",
      prefer:
        (init?.headers as Record<string, string> | undefined)?.["Prefer"] ??
          null,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    return Promise.resolve(respond(c));
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

Deno.test("createNotification delegates atomic episode idempotency to the database and returns a new row", async () => {
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
    assert(calls[0].url.endsWith(
      "/rest/v1/rpc/create_user_notification_episode",
    ));
    const body = calls[0].body as Record<string, unknown>;
    assertEquals(
      body.p_dedupe_key,
      "routine_paused:r1:2026-07-08T12:00:00.000Z",
    );
    assertEquals(body.p_severity, "critical");
    assertEquals(body.p_agent_id, "a1");
    assertEquals(body.p_kind, "routine_paused");
  } finally {
    restore();
  }
});

Deno.test("notification classification is explicit and fails closed", async () => {
  assertEquals(classifyNotificationKind("agent_report"), "report");
  assertEquals(classifyNotificationKind("routine_report"), "report");
  assertEquals(classifyNotificationKind("routine_summary"), "report");
  assertEquals(
    classifyNotificationKind("routine_budget_exhausted"),
    "incident",
  );
  assertEquals(classifyNotificationKind("routine_paused"), "incident");
  assertEquals(classifyNotificationKind("unknown_new_kind"), "incident");

  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() => jsonResponse([]));
    await createNotification({
      userId: "u1",
      agentId: "a1",
      kind: "routine_budget_exhausted",
      severity: "info",
      title: "Daily budget report",
      dedupeKey: "routine_budget:r1:daily:window",
    }, { fetchFn });
    assertEquals(calls[0].body, {
      p_user_id: "u1",
      p_agent_id: "a1",
      p_kind: "routine_budget_exhausted",
      p_severity: "info",
      p_title: "Daily budget report",
      p_body: null,
      p_entity_type: null,
      p_entity_id: null,
      p_action_url: null,
      p_dedupe_key: "routine_budget:r1:daily:window",
    });
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

Deno.test("listNotifications preserves fields and filters canonical Attention", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() => jsonResponse([]));
    await listNotifications(
      "u1",
      { unreadOnly: true, limit: 10 },
      { fetchFn, now: NOW },
    );
    const url = calls[0].url;
    assert(url.includes("user_id=eq.u1"));
    assert(url.includes("order=created_at.desc"));
    assert(url.includes("limit=10"));
    assert(
      decodeURIComponent(url).includes(
        "or=(and(item_class.eq.incident,lifecycle_state.eq.open)," +
          "and(item_class.eq.incident,lifecycle_state.eq.snoozed," +
          `snoozed_until.lte.${NOW.toISOString()}),` +
          "and(item_class.eq.report,lifecycle_state.eq.open," +
          "read_at.is.null))",
      ),
    );
    // Existing consumers keep every legacy field while newer clients receive
    // lifecycle state additively.
    assert(
      url.includes(
        "id,user_id,agent_id,kind,severity,title,body,entity_type,entity_id," +
          "action_url,delivered_channels,created_at,read_at",
      ),
    );
    assert(url.includes("item_class,requires_action,lifecycle_state"));
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
          headers: {
            "Content-Type": "application/json",
            "Content-Range": "0-0/0",
          },
        })
        : jsonResponse([])
    );
    await listNotifications("u1", { agentId: "a1" }, { fetchFn });
    await countUnread("u1", { agentId: "a1" }, { fetchFn });
    assert(calls.every((call) => call.url.includes("agent_id=eq.a1")));
  } finally {
    restore();
  }
});

Deno.test("Attention count includes open and expired-snooze incidents plus unread reports", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() =>
      new Response("[]", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Range": "0-0/4",
        },
      })
    );
    assertEquals(await countAttention("u1", { fetchFn, now: NOW }), 4);
    // The legacy function name/response field is retained with canonical
    // Attention semantics.
    assertEquals(await countUnread("u1", { fetchFn, now: NOW }), 4);
    for (const call of calls) {
      const url = decodeURIComponent(call.url);
      assert(
        url.includes(
          "or=(and(item_class.eq.incident,lifecycle_state.eq.open)," +
            "and(item_class.eq.incident,lifecycle_state.eq.snoozed," +
            `snoozed_until.lte.${NOW.toISOString()}),` +
            "and(item_class.eq.report,lifecycle_state.eq.open," +
            "read_at.is.null))",
        ),
      );
    }
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
    assertEquals(calls[0].body, {
      read_at: (calls[0].body as Record<string, unknown>).read_at,
    });
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

Deno.test("incident recovery auto-resolves by owner-scoped dedupe without marking read", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() => jsonResponse(1));
    const count = await resolveNotificationIncidentByDedupe(
      "owner-1",
      "routine_paused:r1:event-1",
      "Routine recovered after a successful wake.",
      { fetchFn },
    );
    assertEquals(count, 1);
    assertEquals(calls.length, 1);
    assert(calls[0].url.endsWith(
      "/rest/v1/rpc/resolve_notification_incident_by_dedupe",
    ));
    assertEquals(calls[0].body, {
      p_user_id: "owner-1",
      p_dedupe_key: "routine_paused:r1:event-1",
      p_resolution_reason: "Routine recovered after a successful wake.",
    });
    assertEquals(
      "read_at" in (calls[0].body as Record<string, unknown>),
      false,
    );
  } finally {
    restore();
  }
});

Deno.test("markNotificationsRead respects the Agent filter for selected ids", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() =>
      jsonResponse([{ id: "a" }])
    );
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
    const { fetchFn, calls } = capturingFetch(() =>
      jsonResponse([{ id: "a" }])
    );
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
    const { fetchFn, calls } = capturingFetch(() =>
      jsonResponse([{ id: "a" }])
    );
    const n = await markAllNotificationsRead("u1", { agentId: "agent-1" }, {
      fetchFn,
    });
    assertEquals(n, 1);
    assert(calls[0].url.includes("agent_id=eq.agent-1"));
  } finally {
    restore();
  }
});

Deno.test("sweepExpiredNotifications deletes rows older than the 90-day cutoff", async () => {
  const restore = installEnv();
  try {
    const { fetchFn, calls } = capturingFetch(() =>
      jsonResponse([{ id: "old" }])
    );
    const n = await sweepExpiredNotifications(NOW, { fetchFn });
    assertEquals(n, 1);
    assertEquals(calls[0].method, "DELETE");
    // cutoff = NOW - 90d = 2026-04-09T12:00:00.000Z
    assert(calls[0].url.includes("created_at=lt."));
    assert(calls[0].url.includes("2026-04-09T12%3A00%3A00.000Z"));
    // Reading never makes an unresolved incident eligible for retention
    // deletion. Only resolved incidents and eligible informational reports
    // can be swept.
    assert(
      decodeURIComponent(calls[0].url).includes(
        "or=(and(item_class.eq.incident,lifecycle_state.eq.resolved)," +
          "and(item_class.eq.report,or(lifecycle_state.eq.archived," +
          "read_at.not.is.null,severity.neq.critical)))",
      ),
      "sweep must preserve unresolved incidents and unread critical reports",
    );
  } finally {
    restore();
  }
});
