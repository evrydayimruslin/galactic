// parseDeliveryOutcome: the event bus's interpretation of a delivery
// invocation's JSON-RPC body. The load-bearing case: execution failures are
// tool RESULTS with isError (not JSON-RPC errors) and must NOT count as
// delivered.
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { parseDeliveryOutcome } from "./mcp.ts";
import type { JsonRpcResponse } from "../../shared/contracts/jsonrpc.ts";

const RECEIPT = "0b6f6f1e-4f3a-4a8e-9a51-0c2f5d9b7e21";

function rpc(result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: 1, result } as JsonRpcResponse;
}

Deno.test("delivery outcome: JSON-RPC error → failed, message surfaced", () => {
  const outcome = parseDeliveryOutcome(
    {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32009, message: "Insufficient balance" },
    } as JsonRpcResponse,
  );
  assertEquals(outcome.success, false);
  assertEquals(outcome.error, "Insufficient balance");
});

Deno.test("delivery outcome: structured account-capacity denial is safely deferrable", () => {
  const outcome = parseDeliveryOutcome(
    {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32010,
        message: "Account capacity is waiting",
        data: {
          type: "capacity_waiting",
          retry_at: "2026-07-17T18:00:00.000Z",
          capacity_agent_id: "agent-root",
          binding_constraint: "account",
        },
      },
    } as JsonRpcResponse,
  );
  assertEquals(outcome.success, false);
  assertEquals(outcome.admission, {
    code: "capacity_waiting",
    nextEligibleAt: "2026-07-17T18:00:00.000Z",
    capacityAgentId: "agent-root",
    bindingConstraint: "account",
  });
});

Deno.test("delivery outcome: capacity-looking data on another error code stays terminal", () => {
  const outcome = parseDeliveryOutcome(
    {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32603,
        message: "Handler failed",
        data: {
          type: "capacity_waiting",
          retry_at: "2026-07-17T18:00:00.000Z",
        },
      },
    } as JsonRpcResponse,
  );
  assertEquals(outcome.success, false);
  assertEquals(outcome.admission, undefined);
});

Deno.test("delivery outcome: too-small Agent cap is structured but has no reset", () => {
  const outcome = parseDeliveryOutcome(
    {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32010,
        message: "Increase this Agent's cap",
        data: {
          type: "agent_cap_too_low_for_request",
          retry_at: null,
          capacity_agent_id: "agent-root",
          binding_constraint: "agent",
        },
      },
    } as JsonRpcResponse,
  );
  assertEquals(outcome.admission, {
    code: "agent_cap_too_low_for_request",
    nextEligibleAt: null,
    capacityAgentId: "agent-root",
    bindingConstraint: "agent",
  });
});

Deno.test("delivery outcome: isError tool result → FAILED (not delivered), receipt kept", () => {
  const outcome = parseDeliveryOutcome(rpc({
    isError: true,
    content: [{ type: "text", text: "Error: handler exploded" }],
    structuredContent: { error: "handler exploded", receipt_id: RECEIPT },
  }));
  assertEquals(outcome.success, false);
  assertEquals(outcome.error, "handler exploded");
  // A failed handler still executed and billed — the receipt link survives.
  assertEquals(outcome.receiptId, RECEIPT);
});

Deno.test("delivery outcome: isError without structuredContent falls back to content text", () => {
  const outcome = parseDeliveryOutcome(rpc({
    isError: true,
    content: [{ type: "text", text: "Error: aborted" }],
  }));
  assertEquals(outcome.success, false);
  assertEquals(outcome.error, "Error: aborted");
  assertEquals(outcome.receiptId, null);
});

Deno.test("delivery outcome: success result → delivered with receipt from structuredContent", () => {
  const outcome = parseDeliveryOutcome(rpc({
    isError: false,
    content: [{ type: "text", text: "ok" }],
    structuredContent: { shipped: true, receipt_id: RECEIPT },
  }));
  assertEquals(outcome.success, true);
  assertEquals(outcome.receiptId, RECEIPT);
});

Deno.test("delivery outcome: async-promotion envelope → failed (handler did not complete)", () => {
  const outcome = parseDeliveryOutcome(rpc({
    isError: false,
    content: [{ type: "text", text: "promoted" }],
    structuredContent: {
      _async: true,
      job_id: "job-1",
      receipt_id: RECEIPT,
      status: "running",
    },
  }));
  assertEquals(outcome.success, false);
  assertEquals(
    outcome.error,
    "Delivery handler exceeded the synchronous execution window",
  );
  assertEquals(outcome.receiptId, RECEIPT);
});

Deno.test("delivery outcome: tenant result echoing only _async:true is NOT misclassified", () => {
  // attachExecutionReceipt spreads tenant results into structuredContent —
  // a partial echo must not look like the platform promotion envelope.
  const outcome = parseDeliveryOutcome(rpc({
    isError: false,
    content: [{ type: "text", text: "ok" }],
    structuredContent: { _async: true, receipt_id: RECEIPT },
  }));
  assertEquals(outcome.success, true);
  assertEquals(outcome.receiptId, RECEIPT);
});

Deno.test("delivery outcome: JSON-RPC error with receipt in error.data keeps the link", () => {
  const outcome = parseDeliveryOutcome(
    {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32009,
        message: "Insufficient balance",
        data: { type: "LIGHT_REQUIRED", receipt_id: RECEIPT },
      },
    } as JsonRpcResponse,
  );
  assertEquals(outcome.success, false);
  assertEquals(outcome.receiptId, RECEIPT);
});

Deno.test("delivery outcome: non-uuid receipt candidates are rejected", () => {
  const outcome = parseDeliveryOutcome(rpc({
    isError: false,
    structuredContent: { receipt_id: "rec_launch_demo" },
  }));
  assertEquals(outcome.success, true);
  assertEquals(outcome.receiptId, null);
});
