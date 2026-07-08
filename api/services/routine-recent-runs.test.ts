import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import { fetchRecentRunsForApp } from "./routine-recent-runs.ts";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installEnv() {
  const originalEnv = globalThis.__env;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  return () => {
    globalThis.__env = originalEnv;
  };
}

Deno.test("recent runs: scopes every query to (app, user) and assembles steps", async () => {
  const restoreEnv = installEnv();
  const urls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/rest/v1/user_routines")) {
      // The routine list must be pinned to BOTH the app and the user.
      assert(url.includes("composer_app_id=eq.app-1"));
      assert(url.includes("user_id=eq.user-A"));
      return jsonResponse([{ id: "routine-1", name: "Inbox loop" }]);
    }
    if (url.includes("/rest/v1/routine_runs")) {
      assert(url.includes("routine_id=in.(routine-1)"));
      assert(url.includes("user_id=eq.user-A"));
      assert(url.includes("limit=5"));
      return jsonResponse([{
        id: "run-1",
        routine_id: "routine-1",
        status: "succeeded",
        trigger: "scheduled",
        started_at: "2026-07-07T12:00:00.000Z",
        completed_at: "2026-07-07T12:00:04.000Z",
        duration_ms: 4000,
        total_light: 2.5,
        summary: "Routine handler completed successfully.",
        error: null,
      }]);
    }
    if (url.includes("/rest/v1/routine_run_steps")) {
      assert(url.includes("run_id=in.(run-1)"));
      assert(url.includes("user_id=eq.user-A"));
      return jsonResponse([{
        run_id: "run-1",
        step_index: 1,
        function_name: "galactic.ai",
        status: "succeeded",
        duration_ms: 900,
        cost_light: 0,
        args_preview: { prompt: "Goal: triage inbox…" },
        result_preview: { response: "Plan: archive 3, reply 1" },
        error: null,
        metadata: { kind: "ai_exchange", model: "deepseek-v4-flash" },
      }]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const { runs } = await fetchRecentRunsForApp("app-1", "user-A", 5, {
      fetchFn,
    });
    assertEquals(runs.length, 1);
    assertEquals(runs[0].routine_name, "Inbox loop");
    assertEquals(runs[0].steps.length, 1);
    assertEquals(runs[0].steps[0].function_name, "galactic.ai");
    assertEquals(
      (runs[0].steps[0].result_preview as Record<string, unknown>).response,
      "Plan: archive 3, reply 1",
    );
    assertEquals(urls.length, 3);
  } finally {
    restoreEnv();
  }
});

Deno.test("recent runs: clamps limit and returns empty without routines", async () => {
  const restoreEnv = installEnv();
  let runsUrl = "";
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/rest/v1/user_routines")) {
      return jsonResponse([{ id: "routine-1", name: null }]);
    }
    if (url.includes("/rest/v1/routine_runs")) {
      runsUrl = url;
      return jsonResponse([]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    // Oversized limit clamps to the ceiling (20).
    const { runs } = await fetchRecentRunsForApp("app-1", "user-A", 5000, {
      fetchFn,
    });
    assertEquals(runs, []);
    assert(runsUrl.includes("limit=20"));

    // No routines → no further queries, empty result.
    const none = await fetchRecentRunsForApp("app-2", "user-A", 5, {
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input);
        assert(url.includes("/rest/v1/user_routines"));
        return jsonResponse([]);
      }) as typeof fetch,
    });
    assertEquals(none.runs, []);
  } finally {
    restoreEnv();
  }
});
