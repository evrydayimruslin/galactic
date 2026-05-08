import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  createCommandDashboardLayout,
  listCommandDashboardLayouts,
  normalizeCommandDashboardLayout,
  normalizeDashboardKey,
} from "./command-dashboard.ts";

Deno.test("command dashboard: normalizes a pinned card layout", () => {
  const layout = normalizeCommandDashboardLayout({
    cards: [{
      instance_id: "inst-1",
      app_id: "app-1",
      app_slug: "email-ops",
      widget_id: "email_ops",
      card_id: "inbox_volume",
      position: { x: 2.8, y: 1.2 },
      size: "2x1",
      config: { view: "active" },
    }],
  }, "command_home");

  assertEquals(layout, {
    dashboard_key: "command_home",
    cards: [{
      instance_id: "inst-1",
      app_id: "app-1",
      app_slug: "email-ops",
      widget_id: "email_ops",
      card_id: "inbox_volume",
      position: { x: 2, y: 1 },
      size: "2x1",
      config: { view: "active" },
    }],
  });
});

Deno.test("command dashboard: rejects invalid dashboard keys and card sizes", () => {
  assertThrows(
    () => normalizeDashboardKey("Command Home!"),
    Error,
    "dashboard_key",
  );

  assertThrows(
    () =>
      normalizeCommandDashboardLayout({
        cards: [{
          app_id: "app-1",
          widget_id: "email_ops",
          card_id: "inbox_volume",
          size: "fluid",
        }],
      }),
    Error,
    "size",
  );
});

Deno.test("command dashboard: lists multiple saved layouts for one user", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        {
          dashboard_key: "work",
          title: "Work",
          description: "During the day",
          icon: "briefcase",
          sort_order: 1,
          is_default: true,
          layout: {
            dashboard_key: "work",
            cards: [{ instance_id: "a" }, { instance_id: "b" }],
          },
          created_at: "2026-05-08T00:00:00Z",
          updated_at: "2026-05-08T01:00:00Z",
        },
        {
          dashboard_key: "health",
          title: "Health",
          description: null,
          icon: "heart",
          sort_order: 2,
          is_default: false,
          layout: { dashboard_key: "health", cards: [] },
          created_at: "2026-05-08T00:00:00Z",
          updated_at: "2026-05-08T01:00:00Z",
        },
      ]),
      { headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  try {
    const result = await listCommandDashboardLayouts("user-1");
    assertEquals(
      result.dashboards.map((dashboard) => dashboard.dashboard_key),
      [
        "work",
        "health",
      ],
    );
    assertEquals(result.dashboards[0].card_count, 2);
    assertEquals(result.dashboards[0].is_default, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("command dashboard: creates a titled dashboard catalog row", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  const calls: Array<
    { url: string; init?: RequestInit; body?: Record<string, unknown> }
  > = [];
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: input.toString(), init, body });
    if (init?.method === "PATCH") {
      return new Response("[]", {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify([{
        dashboard_key: body.dashboard_key,
        title: body.title,
        description: body.description,
        icon: body.icon,
        sort_order: body.sort_order,
        is_default: body.is_default,
        layout: body.layout,
        created_at: "2026-05-08T00:00:00Z",
        updated_at: "2026-05-08T01:00:00Z",
      }]),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await createCommandDashboardLayout("user-1", {
      title: "Health",
      icon: "heart",
      sort_order: 2,
      is_default: true,
    });
    assertEquals(result.dashboard_key, "health");
    assertEquals(result.title, "Health");
    assertEquals(result.icon, "heart");
    assertEquals(result.is_default, true);
    assertEquals(calls.length, 2);
    assertEquals(calls[1].body?.dashboard_key, "health");
    assertEquals(calls[1].body?.layout, { dashboard_key: "health", cards: [] });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});
