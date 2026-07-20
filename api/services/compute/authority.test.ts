import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authorityToDatabaseValue,
  canonicalizeComputeAuthorities,
  canonicalizeComputeAuthority,
  ComputeAuthorityValidationError,
  requireComputeCallerFunction,
} from "./authority.ts";

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";

Deno.test("compute authority preserves one exact Agent/function pair", () => {
  const authority = canonicalizeComputeAuthority({
    action: "agents.call",
    target: {
      kind: "agent_function",
      agentId: AGENT_A.toUpperCase(),
      functionName: "build.release",
    },
    constraints: { maxCalls: 3 },
  });
  assertEquals(authority, {
    action: "agents.call",
    target: {
      kind: "agent_function",
      agentId: AGENT_A,
      functionName: "build.release",
    },
    constraints: { maxCalls: 3 },
  });
  assertEquals(authorityToDatabaseValue(authority), {
    action: "agents.call",
    resource_kind: "agent_function",
    target_agent_id: AGENT_A,
    target_function: "build.release",
    constraints: { maxCalls: 3 },
  });
});

Deno.test("compute authority only accepts the six exact v1 actions", () => {
  for (const value of [
    {
      action: "agents.call",
      target: { kind: "agent_function", agentId: AGENT_A, functionName: "*" },
    },
    {
      action: "agents.call",
      target: {
        kind: "agent_function",
        agentIds: [AGENT_A, AGENT_B],
        functionNames: ["f", "g"],
      },
    },
    {
      action: "agents.read",
      target: { kind: "agent", agentId: AGENT_A },
    },
    {
      action: "credentials.proxy",
      target: { kind: "provider", provider: "openai" },
    },
    {
      action: "inference.call",
      target: { kind: "provider_model", provider: "openai", model: "gpt" },
    },
    {
      action: "unknown.action",
      target: { kind: "run" },
    },
  ]) {
    assertThrows(
      () => canonicalizeComputeAuthority(value),
      ComputeAuthorityValidationError,
    );
  }
});

Deno.test("compute authority rejects manual caller for Agent-initiated Compute", () => {
  assertThrows(
    () => requireComputeCallerFunction("$manual"),
    ComputeAuthorityValidationError,
  );
});

Deno.test("compute authority enforces the fixed target kind for every built-in", () => {
  for (const value of [
    { action: "artifacts.read", target: { kind: "run_output" } },
    { action: "artifacts.write", target: { kind: "run_input" } },
    { action: "budget.read", target: { kind: "run_input" } },
    { action: "receipts.read", target: { kind: "run_output" } },
    {
      action: "platform.call",
      target: { kind: "agent_function", functionName: "deploy" },
    },
  ]) {
    assertThrows(
      () => canonicalizeComputeAuthority(value),
      ComputeAuthorityValidationError,
    );
  }
});

Deno.test("compute authority canonical list is stable and deduplicated", () => {
  const first = {
    action: "agents.call",
    target: {
      kind: "agent_function",
      agentId: AGENT_B,
      functionName: "run",
    },
  };
  const second = {
    action: "platform.call",
    target: { kind: "platform_function", functionName: "artifacts.get" },
  };
  assertEquals(canonicalizeComputeAuthorities([first, second, first]), [
    {
      action: "agents.call",
      target: {
        kind: "agent_function",
        agentId: AGENT_B,
        functionName: "run",
      },
      constraints: {},
    },
    {
      action: "platform.call",
      target: { kind: "platform_function", functionName: "artifacts.get" },
      constraints: {},
    },
  ]);
});
