import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type {
  LaunchAgentHomeAuthorityItem,
  LaunchNetworkDisclosure,
} from "../../shared/contracts/launch.ts";
import { buildAgentAccessProjection } from "./agent-access.ts";

function networkAuthority(
  overrides: Partial<LaunchAgentHomeAuthorityItem> = {},
): LaunchAgentHomeAuthorityItem {
  return {
    id: "network:mail.google.com",
    actionId: null,
    kind: "network",
    direction: "outbound",
    label: "Gmail",
    target: "mail.google.com",
    access: "execute",
    source: "manifest",
    requested: true,
    approved: true,
    approvalBasis: "live_release",
    effective: true,
    required: true,
    purpose: "Read and send email.",
    badges: ["Write"],
    ...overrides,
  };
}

const disclosure: LaunchNetworkDisclosure = {
  destinations: [{
    host: "mail.google.com",
    label: "Gmail",
    description: "Read and send email.",
    credentials: [{
      key: "GMAIL_TOKEN",
      label: "Gmail token",
      required: true,
      connected: true,
    }],
  }],
  general_settings: [{
    key: "OPERATOR_LANGUAGE",
    label: "Operator language",
    description: null,
    input: "text",
    required: true,
    secret: false,
    group: "Preferences",
    connected: true,
  }],
};

Deno.test("agent access: groups endpoint credentials with effective authority", () => {
  const projection = buildAgentAccessProjection({
    disclosure,
    authority: [networkAuthority()],
    consumers: [{
      authorityId: "network:mail.google.com",
      consumer: {
        kind: "function",
        id: "check_inbox",
        label: "check_inbox",
      },
    }],
  });
  const gmail = projection.groups.find((group) =>
    group.target === "mail.google.com"
  );
  assert(gmail);
  assertEquals(gmail.credentials, [{
    key: "GMAIL_TOKEN",
    label: "Gmail token",
    required: true,
    configured: true,
  }]);
  assertEquals(gmail.consumers.map((item) => item.id), ["check_inbox"]);
  assertEquals(gmail.configured, true);
  assertEquals(gmail.effective, true);
});

Deno.test("agent access: required missing credential is configured false and never carries a value", () => {
  const missing: LaunchNetworkDisclosure = {
    ...disclosure,
    destinations: [{
      ...disclosure.destinations[0]!,
      credentials: [{
        key: "GMAIL_TOKEN",
        label: "Gmail token",
        required: true,
        connected: false,
      }],
    }],
  };
  const projection = buildAgentAccessProjection({
    disclosure: missing,
    authority: [networkAuthority()],
  });
  assertEquals(projection.configured, false);
  assertEquals(projection.effective, false);
  const encoded = JSON.stringify(projection);
  assertEquals(encoded.includes("secret-value"), false);
  assertEquals(encoded.includes('"value"'), false);
});

Deno.test("agent access: owner grant ids focus the matching read-only authority only", () => {
  const projection = buildAgentAccessProjection({
    disclosure: { destinations: [], general_settings: [] },
    authority: [networkAuthority({
      id: "routine:capability-1",
      actionId: "capability-1",
      kind: "agent_call",
      label: "mail-agent.send_reply",
      target: "22222222-2222-4222-8222-222222222222",
      source: "routine",
    })],
    grants: [{
      id: "33333333-3333-4333-8333-333333333333",
      callerApp: {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "email-ops",
        name: "email-ops",
      },
      targetApp: {
        id: "22222222-2222-4222-8222-222222222222",
        slug: "mail-agent",
        name: "Mail Agent",
      },
      callerFunction: null,
      slot: null,
      targetFunction: "send_reply",
      topic: null,
      mode: "call",
      status: "pending",
      monthlyCapCredits: 5000,
      spentCreditsPeriod: 0,
      periodStart: "2026-07-01T00:00:00.000Z",
      createdBy: "auto_request",
      updatedAt: "2026-07-23T12:00:00.000Z",
    }],
  });
  assertEquals(
    projection.groups[0]?.authority[0]?.actionId,
    "33333333-3333-4333-8333-333333333333",
  );
});

Deno.test("agent access: disclosed network without effective authority is fail-closed", () => {
  const projection = buildAgentAccessProjection({
    disclosure,
    authority: [],
  });
  const gmail = projection.groups.find((group) =>
    group.target === "mail.google.com"
  );
  assertEquals(gmail?.effective, false);
  assertEquals(projection.effective, false);
});

Deno.test("agent access: consumers are included only from explicit bindings", () => {
  const projection = buildAgentAccessProjection({
    disclosure,
    authority: [networkAuthority()],
  });
  assertEquals(
    projection.groups.flatMap((group) => group.consumers),
    [],
  );
});
