import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  buildMcpCallLogInsertPayload,
  extractCallMeta,
} from "./call-logger.ts";

Deno.test("call logger: extracts widget action metadata without leaking meta args", () => {
  const result = extractCallMeta({
    conversation_id: "c1",
    action: "send",
    _user_query: "send it",
    _session_id: "session-1",
    _widget_pull: true,
    _widget_name: "email_inbox",
    _widget_interval_ms: 30000,
    _widget_pull_reason: "widget_action",
    _widget_action: true,
    _widget_surface_id: "surface-1",
    _widget_id: "email_inbox",
    _widget_action_id: "send_selected_draft",
    _widget_turn_id: "turn-1",
  });

  assertEquals(result.cleanArgs, {
    conversation_id: "c1",
    action: "send",
  });
  assertEquals(result.userQuery, "send it");
  assertEquals(result.sessionId, "session-1");
  assertEquals(result.widgetPull, {
    widgetName: "email_inbox",
    intervalMs: 30000,
    reason: "widget_action",
  });
  assertEquals(result.widgetAction, {
    surfaceId: "surface-1",
    widgetId: "email_inbox",
    actionId: "send_selected_draft",
    turnId: "turn-1",
  });
});

Deno.test("call logger: persists widget action audit columns", () => {
  const payload = buildMcpCallLogInsertPayload({
    userId: "user-1",
    appId: "app-email",
    appName: "Email",
    functionName: "email_send_draft",
    method: "tools/call",
    success: true,
    inputArgs: { draft_id: "draft-1" },
    outputResult: { ok: true },
    widgetAction: {
      surfaceId: "surface-1",
      widgetId: "email_inbox",
      actionId: "send_selected_draft",
      turnId: "turn-1",
    },
  });

  assertEquals(payload.widget_action, true);
  assertEquals(payload.widget_surface_id, "surface-1");
  assertEquals(payload.widget_id, "email_inbox");
  assertEquals(payload.widget_action_id, "send_selected_draft");
  assertEquals(payload.widget_turn_id, "turn-1");
  assertEquals(payload.input_args, { draft_id: "draft-1" });
});
