import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import type { ResolvedInferenceRoute } from "./inference-route.ts";
import {
  buildActiveWidgetContextBlock,
  buildFlashCallTelemetryContext,
  callFlashText,
  runFlashBroker,
  shouldSkipHeavyPromptForPureSystemAgentDelegation,
} from "./flash-broker.ts";

function makeRoute(): ResolvedInferenceRoute {
  return {
    billingMode: "light",
    provider: "ultralight",
    upstreamProvider: "deepseek",
    baseUrl: "https://api.deepseek.test",
    apiKey: "deepseek-key",
    model: "deepseek-v4-flash",
    canonicalModelId: "ultralight/deepseek-v4-flash",
    billingModelId: "ultralight/deepseek-v4-flash",
    keySource: "platform_deepseek",
    billingSource: "platform_deepseek_direct",
    shouldRequireBalance: true,
    shouldDebitLight: true,
  };
}

Deno.test("flash broker telemetry: absent broker telemetry keeps Flash calls uninstrumented", () => {
  assertEquals(
    buildFlashCallTelemetryContext(undefined, {
      userId: "user-1",
      userEmail: "user@example.com",
      conversationId: "conversation-1",
    }),
    undefined,
  );
});

Deno.test("flash broker telemetry: shapes broker context for downstream Flash calls", () => {
  assertEquals(
    buildFlashCallTelemetryContext(
      {
        traceId: "00000000-0000-4000-8000-000000000001",
        conversationId: "conversation-from-capture",
        source: "orchestrate",
      },
      {
        userId: "user-1",
        userEmail: "user@example.com",
        conversationId: "conversation-from-request",
      },
    ),
    {
      userId: "user-1",
      userEmail: "user@example.com",
      traceId: "00000000-0000-4000-8000-000000000001",
      conversationId: "conversation-from-capture",
      source: "orchestrate",
    },
  );
});

Deno.test("flash broker telemetry: request conversation id and default source are fallback values", () => {
  assertEquals(
    buildFlashCallTelemetryContext(
      {
        traceId: "00000000-0000-4000-8000-000000000002",
      },
      {
        userId: "user-2",
        userEmail: "second@example.com",
        conversationId: "conversation-from-request",
      },
    ),
    {
      userId: "user-2",
      userEmail: "second@example.com",
      traceId: "00000000-0000-4000-8000-000000000002",
      conversationId: "conversation-from-request",
      source: "orchestrate",
    },
  );
});

Deno.test("flash broker: active widget context block summarizes visible UI state", () => {
  const block = buildActiveWidgetContextBlock([{
    surfaceId: "surface-email-window",
    kind: "window",
    appId: "app-email",
    appSlug: "email",
    appName: "Email",
    widgetId: "inbox",
    widgetName: "Inbox",
    status: "ready",
    snapshot: {
      widget_id: "inbox",
      title: "Inbox approval queue",
      current_view: "draft-review",
      summary: "A draft reply is selected and ready for review.",
      visible_components: [{
        id: "draft-editor",
        type: "editor",
        label: "Draft editor",
        purpose: "Shows the selected draft text",
        data_refs: [{ type: "draft", id: "draft-123", label: "ACME follow-up" }],
        actions: ["approve_draft"],
      }],
      selected_entities: [{ type: "thread", id: "thread-9", label: "ACME" }],
      enabled_actions: ["approve_draft"],
    },
    actions: [{
      id: "approve_draft",
      label: "Approve draft",
      mode: "write",
      confirmation: "user",
      mcp: { function: "email_approve_draft" },
    }, {
      id: "show_draft_editor",
      label: "Show draft editor",
      mode: "ui",
      confirmation: "none",
      ui: { command: "focus", component_id: "draft-editor" },
    }],
    recentEvents: [{
      kind: "navigation",
      label: "Opened draft review",
      turn_id: "turn-widget-1",
    }],
    recentEventSummary: "navigation - Opened draft review",
    recentEventCount: 1,
    updatedAt: 1_714_000_000_000,
  }]);

  assertEquals(block.includes("## Active Agentic Surface Context"), true);
  assertEquals(block.includes("Inbox approval queue"), true);
  assertEquals(block.includes("Draft editor"), true);
  assertEquals(block.includes("approve_draft"), true);
  assertEquals(block.includes("email_approve_draft"), true);
  assertEquals(block.includes("ui:focus(draft-editor)"), true);
  assertEquals(block.includes("Recent event summary (1 recorded)"), true);
  assertEquals(block.includes("turn=turn-widget-1"), true);
});

Deno.test("flash broker: active surface context block summarizes generated interfaces", () => {
  const block = buildActiveWidgetContextBlock([{
    surfaceId: "generated-interface-1",
    surfaceType: "generated_interface",
    kind: "generated_interface",
    appId: "generated-interface",
    appSlug: "generated-interface",
    appName: "Generated Interface",
    widgetId: "approval_control_room",
    widgetName: "Approval control room",
    interfaceId: "approval_control_room",
    interfaceTitle: "Approval control room",
    interfaceMode: "temporary",
    status: "ready",
    snapshot: {
      surface_type: "generated_interface",
      widget_id: "approval_control_room",
      interface_id: "approval_control_room",
      title: "Approval control room",
      current_view: "generated_interface",
      visible_components: [{
        id: "approvals-table",
        type: "table",
        label: "Approvals",
        data_refs: [{ type: "context_source", id: "email_queue" }],
        actions: ["send_approval"],
        state: { selected_row_index: 1 },
      }],
      selected_entities: [{
        type: "selected_row",
        id: "approvals-table:1",
        label: "Approvals",
        value: { subject: "ACME budget" },
      }],
      pending_edits: [{
        field: "reply.message",
        label: "Message",
        value: "Looks good.",
        dirty: true,
      }],
      enabled_actions: ["send_approval"],
    },
    actions: [{
      id: "send_approval",
      label: "Send approval",
      mode: "write",
      confirmation: "user",
      mcp: { function: "email_send_approval" },
    }],
    recentEvents: [{
      kind: "user",
      action_id: "select_entity",
      label: "Selected Approvals row 2",
    }],
    recentEventSummary: "user - action=select_entity - Selected Approvals row 2",
    recentEventCount: 1,
  }]);

  assertEquals(block.includes("Surface: generated_interface"), true);
  assertEquals(block.includes("Interface mode: temporary"), true);
  assertEquals(block.includes("Selected entities"), true);
  assertEquals(block.includes("ACME budget"), true);
  assertEquals(block.includes("Pending edits"), true);
  assertEquals(block.includes("Declared interface actions"), true);
  assertEquals(block.includes("email_send_approval"), true);
});

Deno.test("flash broker routing: pure system-agent delegations skip Heavy prompt construction", () => {
  assertEquals(
    shouldSkipHeavyPromptForPureSystemAgentDelegation({
      mode: "write",
      relevantApps: [],
      actionFunctions: [],
      systemAgentDelegations: [{
        agentType: "tool_builder",
        task: "Build a weather MCP.",
      }],
    }),
    true,
  );
  assertEquals(
    shouldSkipHeavyPromptForPureSystemAgentDelegation({
      mode: "read",
      systemAgentDelegations: [{
        agentType: "platform_manager",
        task: "Explain API key setup.",
      }],
    }),
    true,
  );
});

Deno.test("flash broker routing: mixed system-agent delegations still use normal prompt path", () => {
  assertEquals(
    shouldSkipHeavyPromptForPureSystemAgentDelegation({
      mode: "write",
      relevantApps: [{ slug: "app-email", scope: "draft approval" }],
      actionFunctions: [],
      systemAgentDelegations: [{
        agentType: "tool_builder",
        task: "Also consider building a helper.",
      }],
    }),
    false,
  );
  assertEquals(
    shouldSkipHeavyPromptForPureSystemAgentDelegation({
      mode: "write",
      relevantApps: [],
      actionFunctions: ["app_email_send"],
      systemAgentDelegations: [{
        agentType: "tool_marketer",
        task: "Search for email tools.",
      }],
    }),
    false,
  );
  assertEquals(
    shouldSkipHeavyPromptForPureSystemAgentDelegation({
      mode: "write",
      relevantApps: [],
      actionFunctions: [],
      conversationSearch: "previous auth work",
      systemAgentDelegations: [{
        agentType: "tool_marketer",
        task: "Search for auth tools.",
      }],
    }),
    false,
  );
  assertEquals(
    shouldSkipHeavyPromptForPureSystemAgentDelegation({
      mode: "write",
      relevantApps: [],
      actionFunctions: [],
      systemAgentDelegations: [{
        agentType: "tool_builder",
        task: "Build a helper.",
      }, {
        agentType: "unknown_agent",
        task: "Do something outside known system-agent routing.",
      }],
    }),
    false,
  );
});

Deno.test("flash broker routing: pure system-agent delegations avoid Stage 2 and prompt builder calls", async () => {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const providerRequests: Array<Record<string, unknown>> = [];

  const functionIndex = {
    functions: {
      weather_read: {
        appId: "app-weather",
        appSlug: "weather",
        fnName: "read",
        description: "[Weather] Read saved weather data",
        params: {},
        returns: "weather rows",
        conventions: [],
        dependsOn: [],
      },
    },
    widgets: [],
    contextSources: [],
    types: "",
    updatedAt: "2026-05-06T12:00:00.000Z",
  };

  globalThis.__env = {
    CHAT_CAPTURE_ENABLED: "false",
    FN_INDEX: {
      get: (key: string) =>
        Promise.resolve(key === "user:user-1" ? functionIndex : null),
      put: () => Promise.resolve(undefined),
    },
  } as unknown as typeof globalThis.__env;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;

    if (url === "https://api.deepseek.test/chat/completions") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      providerRequests.push(body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  mode: "write",
                  directResponse: "",
                  relevantApps: [],
                  actionFunctions: [],
                  systemAgentDelegations: [{
                    agentType: "tool_builder",
                    task: "Build a weather MCP.",
                  }],
                  conversationSearch: "",
                  contextQuery: "",
                  updatedSummary:
                    "User wants a new weather MCP built by the tool builder.",
                  reasoning:
                    "No installed function handles MCP construction, so delegate.",
                }),
              },
            }],
            usage: {
              prompt_tokens: 24,
              completion_tokens: 12,
              total_tokens: 36,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    return Promise.resolve(new Response("unexpected fetch", { status: 500 }));
  }) as typeof fetch;

  try {
    const events = [];
    for await (
      const event of runFlashBroker(
        "Build me a weather MCP",
        "user-1",
        "flash@example.com",
        [],
        "deepseek-v4-flash",
        "deepseek-v4-pro",
        { weather: { access: "all" } },
        [],
        undefined,
        undefined,
        "conversation-1",
        undefined,
        undefined,
        makeRoute(),
      )
    ) {
      events.push(event);
    }

    assertEquals(providerRequests.length, 1);
    assertEquals(events.some((event) => event.type === "magnifying"), false);
    assertEquals(events.some((event) => event.type === "constructing"), false);
    assertEquals(events.some((event) => event.type === "prompt_ready"), false);

    const done = events.find((event) => event.type === "done");
    if (!done || done.type !== "done") {
      throw new Error("Expected Flash broker to emit a done event");
    }

    assertEquals(done.result.needsTool, false);
    assertEquals(done.result.directResponse, "");
    assertEquals(done.result.prompt, "");
    assertEquals(done.result.systemAgentDelegations, [{
      agentType: "tool_builder",
      task: "Build a weather MCP.",
      originalPrompt: "Build me a weather MCP",
    }]);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});

Deno.test("flash broker telemetry: callFlashText records Flash invocation snapshots", async () => {
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
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
    calls.push({
      method: init?.method || "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });

    if (url === "https://api.deepseek.test/chat/completions") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              finish_reason: "stop",
              message: { content: "Found the answer." },
            }],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 4,
              total_tokens: 16,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

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
    const content = await callFlashText(
      "deepseek-v4-flash",
      "system",
      "user",
      makeRoute(),
      {
        telemetry: {
          userId: "00000000-0000-4000-8000-000000000001",
          userEmail: "flash@example.com",
          traceId: "00000000-0000-4000-8000-000000000004",
          conversationId: "conversation-flash-text",
          source: "orchestrate",
        },
        taskId: "flash_broker.read_response",
        inputFeatures: {
          projectContext: "package.json",
          conversationHistory: [{ role: "user", content: "question" }],
        },
        metadata: {
          mode: "read",
        },
      },
    );

    assertEquals(content, "Found the answer.");

    const providerCall = calls.find((call) =>
      call.url === "https://api.deepseek.test/chat/completions"
    );
    assertEquals(
      (providerCall?.body as { model?: string }).model,
      "deepseek-v4-flash",
    );

    const invocationInsert = calls.find((call) =>
      call.method === "POST" && call.url.includes("/llm_invocations")
    );
    const invocationBody = invocationInsert?.body as {
      phase?: string;
      metadata?: {
        tier?: string;
        component_id?: string;
        schema_id?: string;
        input_features?: { has_project_context?: boolean };
      };
    };
    assertEquals(invocationBody.phase, "flash_broker.read_response");
    assertEquals(invocationBody.metadata?.tier, "flash");
    assertEquals(
      invocationBody.metadata?.component_id,
      "flash_broker.read_response",
    );
    assertEquals(
      invocationBody.metadata?.schema_id,
      "flash_broker.read_response.v1",
    );
    assertEquals(
      invocationBody.metadata?.input_features?.has_project_context,
      true,
    );

    const snapshotInserts = calls.filter((call) =>
      call.method === "POST" && call.url.includes("/llm_context_snapshots")
    );
    assertEquals(
      snapshotInserts.map((call) =>
        (call.body as { snapshot_type?: string }).snapshot_type
      ),
      [
        "llm_request",
        "llm_response",
      ],
    );
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});
