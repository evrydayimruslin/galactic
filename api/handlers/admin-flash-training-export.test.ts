import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import { handleAdmin } from "./admin.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

async function withAdminFlashExportMocks<T>(fn: () => Promise<T>): Promise<T> {
  const previousFetch = globalThis.fetch;
  const previousEnv = globalThis.__env;
  const calls: Array<{ path: string; search: string; method: string }> = [];
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  } as typeof globalThis.__env;

  globalThis.fetch = (async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url,
    );
    calls.push({
      path: url.pathname,
      search: url.search,
      method: init?.method || "GET",
    });

    if (url.pathname === "/rest/v1/capture_access_audit") {
      assertEquals(init?.method, "POST");
      return new Response("", { status: 201 });
    }
    if (url.pathname === "/rest/v1/chat_threads") {
      return jsonRows([{
        conversation_id: "conv-1",
        anon_user_id: "anon-1",
        source: "chat_view",
        capture_region: "us",
        trace_id: "00000000-0000-4000-8000-000000000001",
        model_route: {},
        scope: {},
        metadata: {},
        created_at: "2026-05-06T12:00:00Z",
        updated_at: "2026-05-06T12:00:02Z",
        first_captured_at: "2026-05-06T12:00:00Z",
        last_captured_at: "2026-05-06T12:00:02Z",
      }]);
    }
    if (url.pathname === "/rest/v1/chat_messages") return jsonRows([]);
    if (url.pathname === "/rest/v1/chat_events") return jsonRows([]);
    if (url.pathname === "/rest/v1/capture_artifact_links") {
      return jsonRows([]);
    }
    if (url.pathname === "/rest/v1/llm_invocations") {
      return jsonRows([flashInvocationRow()]);
    }
    if (url.pathname === "/rest/v1/llm_context_snapshots") {
      return jsonRows([requestSnapshotRow(), responseSnapshotRow()]);
    }
    if (url.pathname === "/rest/v1/tool_invocations") return jsonRows([]);
    if (url.pathname === "/rest/v1/execution_failures") return jsonRows([]);
    if (url.pathname === "/rest/v1/training_annotations") {
      return jsonRows([trainingAnnotationRow()]);
    }
    return jsonRows([]);
  }) as typeof fetch;

  try {
    return await fn();
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
    assert(calls.some((call) => call.path === "/rest/v1/chat_threads"));
  }
}

Deno.test("admin flash training export: returns JSON dataset with summary metadata", async () => {
  await withAdminFlashExportMocks(async () => {
    const response = await handleAdmin(
      new Request(
        "https://example.com/api/admin/flash-training/export?format=json&filterMode=human_accepted&componentId=flash_broker.analyze&limit=25",
        {
          headers: { Authorization: "Bearer service-role-key" },
        },
      ),
    );

    assertEquals(response.status, 200);
    const body = await response.json() as {
      success: boolean;
      export: {
        response_format: string;
        dataset_format: string;
        include_tools: boolean;
        preview_only: boolean;
        capture_filters: { limit?: number };
      };
      flash_training: {
        example_count: number;
        filter: { mode: string; component_ids: string[] };
        examples: Array<{
          component_id: string;
          expected_output: unknown;
          training_candidate: boolean;
        }>;
      };
    };

    assertEquals(body.success, true);
    assertEquals(body.export.response_format, "json");
    assertEquals(body.export.dataset_format, "ultralight");
    assertEquals(body.export.include_tools, false);
    assertEquals(body.export.preview_only, true);
    assertEquals(body.export.capture_filters.limit, 25);
    assertEquals(body.flash_training.example_count, 1);
    assertEquals(body.flash_training.filter.mode, "human_accepted");
    assertEquals(body.flash_training.filter.component_ids, [
      "flash_broker.analyze",
    ]);
    assertEquals(
      body.flash_training.examples[0].component_id,
      "flash_broker.analyze",
    );
    assertEquals(body.flash_training.examples[0].training_candidate, true);
    assertEquals(body.flash_training.examples[0].expected_output, {
      mode: "write",
      needsTool: true,
    });
  });
});

Deno.test("admin flash training export: returns provider-compatible JSONL", async () => {
  await withAdminFlashExportMocks(async () => {
    const response = await handleAdmin(
      new Request(
        "https://example.com/api/admin/flash-training/export?format=jsonl&datasetFormat=openai_messages&includeTools=true",
        {
          headers: { Authorization: "Bearer service-role-key" },
        },
      ),
    );

    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get("Content-Type"),
      "application/x-ndjson; charset=utf-8",
    );
    assertStringIncludes(
      response.headers.get("Content-Disposition") || "",
      "flash-training-openai_messages.jsonl",
    );
    assertEquals(response.headers.get("X-Ultralight-Flash-Examples"), "1");

    const text = await response.text();
    const rows = text.trim().split("\n").map((line) => JSON.parse(line));
    assertEquals(rows.length, 1);
    assertEquals(rows[0].metadata.component_id, "flash_broker.analyze");
    assertEquals(rows[0].messages.at(-1), {
      role: "assistant",
      content: '{"mode":"write","needsTool":true}',
    });
    assertEquals(rows[0].tools.length, 1);
  });
});

Deno.test("admin flash training export: rejects invalid query parameters", async () => {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  } as typeof globalThis.__env;
  try {
    const response = await handleAdmin(
      new Request(
        "https://example.com/api/admin/flash-training/export?format=csv",
        {
          headers: { Authorization: "Bearer service-role-key" },
        },
      ),
    );
    assertEquals(response.status, 400);
    const body = await response.json() as { error: string };
    assertStringIncludes(body.error, "format must be one of");
  } finally {
    globalThis.__env = previousEnv;
  }
});

function flashInvocationRow() {
  return {
    id: "row-1",
    invocation_id: "flash-1",
    trace_id: "00000000-0000-4000-8000-000000000001",
    conversation_id: "conv-1",
    anon_user_id: "anon-1",
    source: "orchestrator",
    phase: "flash_broker.analyze",
    provider: "openrouter",
    requested_model: "deepseek/deepseek-v4-flash",
    resolved_model: "deepseek/deepseek-v4-flash",
    billing_mode: "light",
    key_source: "platform_openrouter",
    request_params: { temperature: 0 },
    context_snapshot_id: "snapshot-request",
    context_sha256: "request-sha",
    context_bytes: 256,
    context_message_count: 2,
    tool_schema_count: 1,
    started_at: "2026-05-06T12:00:01Z",
    completed_at: "2026-05-06T12:00:02Z",
    duration_ms: 1000,
    status: "success",
    finish_reason: "stop",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    cost_light: 0.001,
    error_type: null,
    error_message: null,
    metadata: {
      tier: "flash",
      component_id: "flash_broker.analyze",
      schema_id: "flash_broker.analyze.v1",
      output_shape: "json",
      capabilities: ["turn_mode_classification", "escalation_selection"],
      input_features: { conversation_history_count: 1 },
      output_labels: {
        parse_success: true,
        mode: "write",
        escalation_target: "heavy_codemode",
      },
    },
  };
}

function requestSnapshotRow() {
  return {
    id: "snapshot-request",
    invocation_id: "flash-1",
    trace_id: "00000000-0000-4000-8000-000000000001",
    conversation_id: "conv-1",
    anon_user_id: "anon-1",
    source: "orchestrator",
    snapshot_type: "llm_request",
    message_count: 2,
    tool_schema_count: 1,
    artifact_id: null,
    sha256: "request-sha",
    size_bytes: 256,
    text_preview: JSON.stringify({
      messages: [
        { role: "system", content: "You are Flash." },
        { role: "user", content: "Build a workflow." },
      ],
      tools: [{ type: "function", function: { name: "route" } }],
      request_params: { response_format: { type: "json_object" } },
    }),
    metadata: {},
    created_at: "2026-05-06T12:00:01Z",
  };
}

function responseSnapshotRow() {
  return {
    id: "snapshot-response",
    invocation_id: "flash-1",
    trace_id: "00000000-0000-4000-8000-000000000001",
    conversation_id: "conv-1",
    anon_user_id: "anon-1",
    source: "orchestrator",
    snapshot_type: "llm_response",
    message_count: 0,
    tool_schema_count: 0,
    artifact_id: null,
    sha256: "response-sha",
    size_bytes: 128,
    text_preview: JSON.stringify({
      status: "success",
      finish_reason: "stop",
      usage: { total_tokens: 15 },
      value: { mode: "write", needsTool: true },
    }),
    metadata: {},
    created_at: "2026-05-06T12:00:02Z",
  };
}

function trainingAnnotationRow() {
  return {
    id: "annotation-1",
    target_type: "llm_invocation",
    target_id: "flash-1",
    conversation_id: "conv-1",
    message_id: null,
    llm_invocation_id: "flash-1",
    tool_invocation_id: null,
    artifact_id: null,
    annotation_type: "quality",
    label: "accept",
    confidence: 1,
    payload: {},
    taxonomy_version: "manual.v1",
    classifier_model: null,
    classifier_version: null,
    status: "accepted",
    reviewed_by: "test",
    reviewed_at: "2026-05-06T12:00:03Z",
    metadata: {},
    created_at: "2026-05-06T12:00:03Z",
  };
}

function jsonRows(rows: unknown[]): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
