import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  buildAgenticSurfaceActionTelemetryMetadata,
  buildWidgetActionTelemetryMetadata,
  createLlmInvocationTelemetrySession,
  recordToolInvocationTelemetry,
} from "./invocation-telemetry.ts";

Deno.test("invocation telemetry: shapes widget action metadata", () => {
  assertEquals(buildWidgetActionTelemetryMetadata({
    surfaceId: "surface-1",
    widgetId: "email_inbox",
    actionId: "send_selected_draft",
    turnId: "turn-1",
  }), {
    widget_action: true,
    widget_surface_id: "surface-1",
    widget_id: "email_inbox",
    widget_action_id: "send_selected_draft",
    widget_turn_id: "turn-1",
  });
});

Deno.test("invocation telemetry: shapes generated interface action metadata", () => {
  assertEquals(buildAgenticSurfaceActionTelemetryMetadata({
    surfaceId: "surface-generated",
    interfaceId: "email_interface",
    actionId: "send",
    turnId: "turn-1",
    componentId: "actions",
  }), {
    agentic_surface_action: true,
    agentic_surface_id: "surface-generated",
    agentic_interface_id: "email_interface",
    agentic_action_id: "send",
    agentic_turn_id: "turn-1",
    agentic_component_id: "actions",
  });
});

Deno.test("invocation telemetry: disabled flag prevents session creation", () => {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    CHAT_CAPTURE_ENABLED: "false",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  } as unknown as typeof globalThis.__env;

  try {
    const session = createLlmInvocationTelemetrySession({
      userId: "user-123",
      invocationId: "invocation-123",
      traceId: "00000000-0000-4000-8000-000000000001",
      source: "unit_test",
      phase: "chat_stream",
      messages: [{ role: "user", content: "hello" }],
    });

    assertEquals(session, null);
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("invocation telemetry: records LLM context snapshot and completion", async () => {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const calls: Array<
    { method: string; url: string; body: unknown; prefer: string | null }
  > = [];

  globalThis.__env = {
    CHAT_CAPTURE_ENABLED: "true",
    CHAT_CAPTURE_ARTIFACTS_ENABLED: "false",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    ANALYTICS_PEPPER_V1: "test-pepper",
  } as unknown as typeof globalThis.__env;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      method: init?.method || "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      prefer: headers?.Prefer || null,
    });

    if (url.includes("/llm_context_snapshots")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            { id: "00000000-0000-4000-8000-000000000010" },
          ]),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (init?.method === "PATCH") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(new Response("", { status: 201 }));
  }) as typeof fetch;

  try {
    const session = createLlmInvocationTelemetrySession({
      userId: "00000000-0000-4000-8000-000000000001",
      userEmail: "test@example.com",
      invocationId: "00000000-0000-4000-8000-000000000002",
      traceId: "00000000-0000-4000-8000-000000000002",
      conversationId: "conv-telemetry-test",
      source: "unit_test",
      phase: "chat_stream",
      provider: "openrouter",
      requestedModel: "openai/gpt-4o-mini",
      resolvedModel: "openai/gpt-4o-mini",
      billingMode: "light",
      keySource: "platform_openrouter",
      requestParams: { stream: true },
      messages: [{ role: "user", content: "hello" }],
      tools: [{
        type: "function",
        function: { name: "lookup", description: "Lookup", parameters: {} },
      }],
    });

    assert(session);
    session.start();
    await session.finish({
      status: "success",
      finishReason: "stop",
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      costLight: 0.01,
    });

    const invocationInsert = calls.find((call) =>
      call.method === "POST" && call.url.includes("/llm_invocations")
    );
    assert(invocationInsert);
    assertEquals(
      (invocationInsert.body as { invocation_id: string }).invocation_id,
      "00000000-0000-4000-8000-000000000002",
    );
    assertEquals(
      (invocationInsert.body as { context_message_count: number })
        .context_message_count,
      1,
    );
    assertEquals(
      (invocationInsert.body as { tool_schema_count: number })
        .tool_schema_count,
      1,
    );

    const snapshotInsert = calls.find((call) =>
      call.method === "POST" && call.url.includes("/llm_context_snapshots")
    );
    assert(snapshotInsert);
    assertEquals(
      (snapshotInsert.body as { source: string }).source,
      "unit_test",
    );
    assertEquals(
      (snapshotInsert.body as { message_count: number }).message_count,
      1,
    );

    const completionPatch = calls.find((call) =>
      call.method === "PATCH" &&
      call.url.includes("/llm_invocations") &&
      (call.body as { status?: string }).status === "success"
    );
    assert(completionPatch);
    assertEquals(
      (completionPatch.body as { finish_reason: string }).finish_reason,
      "stop",
    );
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});

Deno.test("invocation telemetry: records optional LLM response snapshots", async () => {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const calls: Array<
    { method: string; url: string; body: unknown; prefer: string | null }
  > = [];

  globalThis.__env = {
    CHAT_CAPTURE_ENABLED: "true",
    CHAT_CAPTURE_ARTIFACTS_ENABLED: "false",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    ANALYTICS_PEPPER_V1: "test-pepper",
  } as unknown as typeof globalThis.__env;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      method: init?.method || "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      prefer: headers?.Prefer || null,
    });

    if (url.includes("/llm_context_snapshots")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            { id: crypto.randomUUID() },
          ]),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (init?.method === "PATCH") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(new Response("", { status: 201 }));
  }) as typeof fetch;

  try {
    const session = createLlmInvocationTelemetrySession({
      userId: "00000000-0000-4000-8000-000000000001",
      invocationId: "00000000-0000-4000-8000-000000000003",
      traceId: "00000000-0000-4000-8000-000000000003",
      conversationId: "conv-response-snapshot-test",
      source: "unit_test",
      phase: "flash_broker.read_response",
      provider: "ultralight",
      requestedModel: "deepseek-v4-flash",
      resolvedModel: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }],
      metadata: { tier: "flash", component_id: "flash_broker.read_response" },
    });

    assert(session);
    session.start();
    await session.finish({
      status: "success",
      finishReason: "stop",
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      metadata: { output_labels: { nonempty_response: true } },
      responseSnapshot: {
        value: { raw_content: "Done." },
        metadata: {
          component_id: "flash_broker.read_response",
          output_labels: { nonempty_response: true },
        },
      },
    });

    const snapshotInserts = calls.filter((call) =>
      call.method === "POST" && call.url.includes("/llm_context_snapshots")
    );
    assertEquals(snapshotInserts.length, 2);
    assertEquals(
      (snapshotInserts[0].body as { snapshot_type?: string }).snapshot_type,
      "llm_request",
    );
    assertEquals(
      (snapshotInserts[1].body as { snapshot_type?: string }).snapshot_type,
      "llm_response",
    );
    assertEquals(
      (snapshotInserts[1].body as { source?: string }).source,
      "unit_test",
    );
    assertEquals(
      (snapshotInserts[1].body as { message_count?: number }).message_count,
      0,
    );
    assertEquals(
      (snapshotInserts[1].body as {
        metadata?: { output_labels?: { nonempty_response?: boolean } };
      }).metadata
        ?.output_labels?.nonempty_response,
      true,
    );
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});

Deno.test("invocation telemetry: records failed tool calls and failure rows", async () => {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ method: string; url: string; body: unknown }> = [];

  globalThis.__env = {
    CHAT_CAPTURE_ENABLED: "true",
    CHAT_CAPTURE_ARTIFACTS_ENABLED: "false",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    ANALYTICS_PEPPER_V1: "test-pepper",
  } as unknown as typeof globalThis.__env;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method || "GET",
      url: typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Promise.resolve(new Response("", { status: 201 }));
  }) as typeof fetch;

  try {
    await recordToolInvocationTelemetry({
      userId: "00000000-0000-4000-8000-000000000001",
      invocationId: "tool-invocation-1",
      traceId: "00000000-0000-4000-8000-000000000002",
      conversationId: "conv-tool-test",
      parentLlmInvocationId: "00000000-0000-4000-8000-000000000002",
      source: "unit_test",
      toolCallId: "call_123",
      toolName: "lookup",
      appId: "app-lookup",
      mcpId: "mcp-lookup",
      functionName: "lookup",
      receiptId: "00000000-0000-4000-8000-000000000401",
      routineId: "00000000-0000-4000-8000-000000000402",
      routineRunId: "00000000-0000-4000-8000-000000000403",
      args: { query: "ultralight" },
      result: { error: "boom" },
      status: "error",
      errorType: "ToolError",
      errorMessage: "boom",
      widgetAction: {
        surfaceId: "surface-1",
        widgetId: "email_inbox",
        actionId: "send_selected_draft",
        turnId: "turn-1",
      },
      agenticSurfaceAction: {
        surfaceId: "surface-generated",
        interfaceId: "email_interface",
        actionId: "send",
        turnId: "turn-agentic-1",
        componentId: "actions",
      },
    });

    const toolInsert = calls.find((call) =>
      call.method === "POST" && call.url.includes("/tool_invocations")
    );
    assert(toolInsert);
    assertEquals(
      (toolInsert.body as { tool_name: string }).tool_name,
      "lookup",
    );
    assertEquals((toolInsert.body as { status: string }).status, "error");
    assertEquals(
      (toolInsert.body as { args_preview: { query: string } }).args_preview
        .query,
      "ultralight",
    );
    assertEquals((toolInsert.body as { app_id: string }).app_id, "app-lookup");
    assertEquals((toolInsert.body as { mcp_id: string }).mcp_id, "mcp-lookup");
    assertEquals(
      (toolInsert.body as { receipt_id: string }).receipt_id,
      "00000000-0000-4000-8000-000000000401",
    );
    assertEquals(
      (toolInsert.body as { routine_id: string }).routine_id,
      "00000000-0000-4000-8000-000000000402",
    );
    assertEquals(
      (toolInsert.body as { routine_run_id: string }).routine_run_id,
      "00000000-0000-4000-8000-000000000403",
    );
    assertEquals(
      (toolInsert.body as { metadata: Record<string, unknown> }).metadata
        .widget_action_id,
      "send_selected_draft",
    );
    assertEquals(
      (toolInsert.body as { metadata: Record<string, unknown> }).metadata
        .agentic_action_id,
      "send",
    );

    const failureInsert = calls.find((call) =>
      call.method === "POST" && call.url.includes("/execution_failures")
    );
    assert(failureInsert);
    assertEquals(
      (failureInsert.body as { failure_type: string }).failure_type,
      "ToolError",
    );
    assertEquals(
      (failureInsert.body as { phase: string }).phase,
      "tool_invocation",
    );
    assertEquals(
      (failureInsert.body as { metadata: Record<string, unknown> }).metadata
        .routine_run_id,
      "00000000-0000-4000-8000-000000000403",
    );
    assertEquals(
      (failureInsert.body as { metadata: Record<string, unknown> }).metadata
        .widget_turn_id,
      "turn-1",
    );
    assertEquals(
      (failureInsert.body as { metadata: Record<string, unknown> }).metadata
        .agentic_turn_id,
      "turn-agentic-1",
    );
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});
