// deno-lint-ignore-file no-import-prefix require-await
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  OperatorRunInspectionError,
  readOperatorRoutineRunDetail,
  readOperatorRoutineRunLogExcerpt,
} from "./operator-run-inspection.ts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ROUTINE_ID = "22222222-2222-4222-8222-222222222222";
const RECEIPT_ID = "33333333-3333-4333-8333-333333333333";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installEnv() {
  const original = globalThis.__env;
  globalThis.__env = {
    ...(original ?? {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  };
  return () => {
    globalThis.__env = original;
  };
}

function runRow() {
  return {
    id: RUN_ID,
    routine_id: ROUTINE_ID,
    user_id: "owner-1",
    status: "failed",
    trigger: "scheduled",
    trace_id: "trace-1",
    started_at: "2026-07-24T12:00:00.000Z",
    completed_at: "2026-07-24T12:00:03.000Z",
    duration_ms: 3000,
    total_light: 4.5,
    summary: "Routine handler failed.",
    error: {
      version: 1,
      code: "DEVELOPER_ERROR",
      causeCode: "CONNECTION_TIMEOUT",
      summary: "The mailbox did not respond.",
      detail: null,
      provenance: "developer",
      retryable: null,
      suggestedActions: [],
      redacted: false,
    },
  };
}

Deno.test("operator run detail is owner/Agent scoped and excludes raw previews", async () => {
  const restore = installEnv();
  const urls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/routine_runs?")) {
      assert(url.includes(`id=eq.${RUN_ID}`));
      assert(url.includes("user_id=eq.owner-1"));
      return jsonResponse([runRow()]);
    }
    if (url.includes("/user_routines?")) {
      assert(url.includes(`id=eq.${ROUTINE_ID}`));
      assert(url.includes("user_id=eq.owner-1"));
      assert(url.includes("composer_app_id=eq.agent-1"));
      return jsonResponse([{
        id: ROUTINE_ID,
        name: "Inbox loop",
        status: "paused",
      }]);
    }
    if (url.includes("/routine_run_steps?")) {
      assert(url.includes(`run_id=eq.${RUN_ID}`));
      assert(url.includes("user_id=eq.owner-1"));
      assertEquals(url.includes("args_preview"), false);
      assertEquals(url.includes("result_preview"), false);
      return jsonResponse([{
        id: "step-1",
        run_id: RUN_ID,
        step_index: 0,
        function_name: "checkInbox",
        status: "failed",
        duration_ms: 3000,
        cost_light: 4.5,
        receipt_id: RECEIPT_ID,
        error: {
          message: "Failure included opaqueConfiguredSecret",
        },
        started_at: "2026-07-24T12:00:00.000Z",
        completed_at: "2026-07-24T12:00:03.000Z",
      }]);
    }
    if (url.includes("/mcp_call_logs?")) {
      assert(url.includes(`routine_run_id=eq.${RUN_ID}`));
      assert(url.includes("user_id=eq.owner-1"));
      assert(url.includes("app_id=eq.agent-1"));
      return jsonResponse([{
        id: RECEIPT_ID,
        function_name: "checkInbox",
        created_at: "2026-07-24T12:00:00.000Z",
        log_object_key: "call-logs/agent-1/receipt.json",
      }]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const detail = await readOperatorRoutineRunDetail({
      userId: "owner-1",
      agent: { id: "agent-1", slug: "inbox", name: "Inbox" },
      runId: RUN_ID,
      knownSecrets: ["opaqueConfiguredSecret"],
    }, {
      fetchFn,
      now: () => new Date("2026-07-24T13:00:00.000Z"),
    });

    assertEquals(detail.agent.id, "agent-1");
    assertEquals(detail.routine.status, "paused");
    assertEquals(detail.run.usage, 4.5);
    assertEquals(detail.diagnostic?.causeCode, "CONNECTION_TIMEOUT");
    assertEquals(detail.steps.length, 1);
    assertEquals(
      detail.steps[0].diagnostic?.summary.includes(
        "opaqueConfiguredSecret",
      ),
      false,
    );
    assertEquals(detail.logReceipts[0].logsAvailable, true);
    assertEquals(
      "argsPreview" in (detail.steps[0] as unknown as Record<string, unknown>),
      false,
    );
    assertEquals(urls.length, 4);
  } finally {
    restore();
  }
});

Deno.test("operator run detail hides runs outside the resolved Agent", async () => {
  const restore = installEnv();
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/routine_runs?")) return jsonResponse([runRow()]);
    if (url.includes("/user_routines?")) return jsonResponse([]);
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const error = await assertRejects(
      () =>
        readOperatorRoutineRunDetail({
          userId: "owner-1",
          agent: { id: "other-agent", slug: "other", name: "Other" },
          runId: RUN_ID,
        }, { fetchFn }),
      OperatorRunInspectionError,
    );
    assertEquals(error.status, 404);
    assertEquals(error.code, "routine_run_not_found");
  } finally {
    restore();
  }
});

Deno.test("operator log excerpt binds receipt to run and returns only redacted logs", async () => {
  const restore = installEnv();
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/routine_runs?")) return jsonResponse([runRow()]);
    if (url.includes("/user_routines?")) {
      return jsonResponse([{
        id: ROUTINE_ID,
        name: "Inbox loop",
        status: "paused",
      }]);
    }
    if (url.includes("/mcp_call_logs?")) {
      return jsonResponse([{
        id: RECEIPT_ID,
        function_name: "checkInbox",
        created_at: "2026-07-24T12:00:00.000Z",
        log_object_key: "call-logs/agent-1/receipt.json",
      }]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  let readReceipt = "";

  try {
    const excerpt = await readOperatorRoutineRunLogExcerpt({
      userId: "owner-1",
      agentId: "agent-1",
      runId: RUN_ID,
      receiptId: RECEIPT_ID,
      knownSecrets: ["opaqueErrorSecret", "opaqueLogSecret"],
    }, {
      fetchFn,
      readCallLogsFn: async (params) => {
        readReceipt = params.receiptId;
        return {
          receipt_id: RECEIPT_ID,
          app_id: "agent-1",
          function_name: "checkInbox",
          success: false,
          created_at: "2026-07-24T12:00:00.000Z",
          error_message: "Failure opaqueErrorSecret",
          truncated: false,
          dropped_entries: 0,
          logs: [{
            time: "2026-07-24T12:00:02.000Z",
            level: "error",
            message: "Failure opaqueLogSecret",
          }],
        };
      },
    });

    assertEquals(readReceipt, RECEIPT_ID);
    assertEquals(excerpt.logs.length, 1);
    assertEquals(excerpt.logs[0].message.includes("opaqueLogSecret"), false);
    assertEquals(excerpt.error?.includes("opaqueErrorSecret"), false);
    assertEquals(excerpt.redactedEntries, 1);
  } finally {
    restore();
  }
});

Deno.test("operator log excerpt rejects a receipt not linked to the run", async () => {
  const restore = installEnv();
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/routine_runs?")) return jsonResponse([runRow()]);
    if (url.includes("/user_routines?")) {
      return jsonResponse([{
        id: ROUTINE_ID,
        name: "Inbox loop",
        status: "paused",
      }]);
    }
    if (url.includes("/mcp_call_logs?")) return jsonResponse([]);
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const error = await assertRejects(
      () =>
        readOperatorRoutineRunLogExcerpt({
          userId: "owner-1",
          agentId: "agent-1",
          runId: RUN_ID,
          receiptId: RECEIPT_ID,
        }, { fetchFn }),
      OperatorRunInspectionError,
    );
    assertEquals(error.status, 404);
    assertEquals(error.code, "routine_run_logs_not_found");
  } finally {
    restore();
  }
});
