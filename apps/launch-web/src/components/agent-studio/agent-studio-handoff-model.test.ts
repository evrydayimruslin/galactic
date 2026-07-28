import { describe, expect, it } from "vitest";

import {
  agentStudioHandoffMcpServerName,
  buildAgentStudioHandoffPrompt,
  credentialRequestFor,
  descriptionIsReady,
  handoffCredentialNeedsRenewal,
  validateHandoffCredential,
} from "./agent-studio-handoff-model";

const target = {
  id: "53e6d85e-f5c2-4778-a284-05889778356b",
  name: "email-ops",
};
const sessionId = "7a8c99b7-2875-4a6a-9490-8f03c99587c1";
const platformMcpUrl = "https://api.galactic.dev/mcp/platform";
const bearerToken = "gx_0123456789abcdef0123456789abcdef";
const expiresAt = "2026-07-27T12:30:00.000Z";

describe("Agent Studio coding-agent handoff model", () => {
  it("gates structural prompts on a description while keeping Connect optional", () => {
    expect(descriptionIsReady("interface", "   ")).toBe(false);
    expect(descriptionIsReady("function", "Look up a room")).toBe(true);
    expect(descriptionIsReady("routine", "")).toBe(false);
    expect(descriptionIsReady("agent", "")).toBe(false);
    expect(descriptionIsReady("connect", "")).toBe(true);
  });

  it("requests an exact Agent UUID and a 30-minute scoped credential", () => {
    expect(credentialRequestFor("interface", target)).toEqual({
      description: "",
      intent: "interface",
      requestedTtlSeconds: 1_800,
      targetAgentId: target.id,
    });
    expect(() =>
      credentialRequestFor("interface", {
        id: "email-ops",
        name: "email-ops",
      })
    ).toThrow(/exact Agent UUID/);
  });

  it("refuses a credential for another Agent or a long-lived API key", () => {
    const now = Date.parse("2026-07-27T12:00:00.000Z");
    const request = credentialRequestFor("function", target);
    expect(() =>
      validateHandoffCredential(
        {
          bearerToken,
          expiresAt: "2026-07-27T12:30:00.000Z",
          platformMcpUrl,
          scope: {
            agentId: "8e145394-8055-46e0-8361-fe0204cc8123",
            kind: "agent",
          },
          sessionId,
          status: "issued",
        },
        request,
        now,
      )
    ).toThrow(/different Agent/);
    expect(() =>
      validateHandoffCredential(
        {
          bearerToken,
          expiresAt: "2026-08-26T12:00:00.000Z",
          platformMcpUrl,
          scope: { agentId: target.id, kind: "agent" },
          sessionId,
          status: "issued",
        },
        request,
        now,
      )
    ).toThrow(/long-lived credential/);
  });

  it("renews cached credentials before fewer than two safe minutes remain", () => {
    const expiresAt = "2026-07-27T12:30:00.000Z";
    expect(handoffCredentialNeedsRenewal(
      { expiresAt },
      Date.parse("2026-07-27T12:27:59.999Z"),
    )).toBe(false);
    expect(handoffCredentialNeedsRenewal(
      { expiresAt },
      Date.parse("2026-07-27T12:28:00.000Z"),
    )).toBe(true);
    expect(handoffCredentialNeedsRenewal(
      { expiresAt: "not-a-date" },
      Date.parse("2026-07-27T12:00:00.000Z"),
    )).toBe(true);
  });

  it("validates the non-secret session ID and platform MCP endpoint", () => {
    const request = credentialRequestFor("interface", target);
    const baseCredential = {
      bearerToken,
      expiresAt: "2026-07-27T12:30:00.000Z",
      platformMcpUrl,
      scope: { agentId: target.id, kind: "agent" as const },
      sessionId,
      status: "issued" as const,
    };
    expect(() =>
      validateHandoffCredential(
        { ...baseCredential, sessionId: "handoff-token-1" },
        request,
        Date.parse("2026-07-27T12:00:00.000Z"),
      )
    ).toThrow(/session ID/);
    expect(() =>
      validateHandoffCredential(
        {
          ...baseCredential,
          platformMcpUrl: "https://api.galactic.dev/mcp/platform?leak=true",
        },
        request,
        Date.parse("2026-07-27T12:00:00.000Z"),
      )
    ).toThrow(/MCP endpoint/);
    expect(() =>
      validateHandoffCredential(
        {
          ...baseCredential,
          bearerToken: 'gx_unsafe"; open -a Calculator',
        },
        request,
        Date.parse("2026-07-27T12:00:00.000Z"),
      )
    ).toThrow(/malformed handoff credential/);
  });

  it("builds against the exact UUID and immutable Milestone 1 workflow", () => {
    const prompt = buildAgentStudioHandoffPrompt({
      bearerToken,
      description: "A queue of drafts I can approve.",
      expiresAt,
      intent: "interface",
      platformMcpUrl,
      sessionId,
      target,
    });
    const serverName = agentStudioHandoffMcpServerName(sessionId);

    expect(prompt).toContain(`id: ${target.id}`);
    expect(prompt).toContain(`app_id: "${target.id}"`);
    expect(prompt).toContain("gx.project");
    expect(prompt).toContain("gx.stage({ files })");
    expect(prompt).toContain("gx.test({ bundle_id })");
    expect(prompt).toContain("gx.upload");
    expect(prompt).toContain("A queue of drafts I can approve.");
    expect(prompt).toContain(`Bearer ${bearerToken}`);
    expect(prompt).toContain(
      `claude mcp add --transport http --scope user ${serverName}`,
    );
    expect(prompt).toContain(`"mcpServers":{"${serverName}"`);
    expect(prompt).toContain("Claude Code command (run this in a shell)");
    expect(prompt).toContain("Portable HTTP MCP client configuration");
    expect(prompt).toContain("do not run it as a shell command");
    expect(prompt).toContain(
      "An MCP server entry saved by the client does not expire automatically",
    );
    expect(prompt).toContain(`The bearer token expires at ${expiresAt}`);
    expect(prompt).toContain("cannot authenticate after the token expires");
    expect(prompt).not.toContain("30 days");
  });

  it("uses the same MCP server name every time for the same handoff session", () => {
    const options = {
      bearerToken,
      description: "",
      expiresAt,
      intent: "connect" as const,
      platformMcpUrl,
      sessionId,
      target: null,
    };
    const first = buildAgentStudioHandoffPrompt(options);
    const second = buildAgentStudioHandoffPrompt(options);

    expect(first).toBe(second);
    expect(first.match(new RegExp(
      agentStudioHandoffMcpServerName(sessionId),
      "g",
    ))).toHaveLength(2);
    expect(first).not.toContain("MCP entry expire");
  });

  it("keeps an unfinished required description visibly open in the prompt", () => {
    const prompt = buildAgentStudioHandoffPrompt({
      bearerToken,
      description: "",
      expiresAt,
      intent: "routine",
      platformMcpUrl,
      sessionId,
      target,
    });

    expect(prompt).toContain("your description goes here");
    expect(prompt).not.toContain("nothing in particular");
  });
});
