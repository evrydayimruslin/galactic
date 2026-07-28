import { describe, expect, it, vi } from "vitest";

import type {
  LaunchHandoffCreateResponse,
} from "../../../../shared/contracts/launch.ts";
import { createStudioHandoffCredential } from "./agent-studio-handoff-credential";

const AGENT_ID = "53e6d85e-f5c2-4778-a284-05889778356b";
const SESSION_ID = "7a8c99b7-2875-4a6a-9490-8f03c99587c1";
const CREATED_AT = "2026-07-27T12:00:00.000Z";
const EXPIRES_AT = "2026-07-27T12:30:00.000Z";
const PLATFORM_MCP_URL = "https://api.galactic.dev/mcp/platform";
const PLAINTEXT_TOKEN = "gx_0123456789abcdef0123456789abcdef";

function response(options: {
  appIds: string[] | null;
  intent: "connect" | "interface";
  scopes?: string[];
  target: LaunchHandoffCreateResponse["handoff"]["target"];
}): LaunchHandoffCreateResponse {
  return {
    credential: {
      appIds: options.appIds,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      id: SESSION_ID,
      plaintextToken: PLAINTEXT_TOKEN,
      scopes: options.scopes ??
        ["apps:read", "agents:build", `handoff:${options.intent}`],
      tokenPrefix: PLAINTEXT_TOKEN.slice(0, 8),
    },
    generatedAt: CREATED_AT,
    handoff: {
      createdAt: CREATED_AT,
      description: options.intent === "connect"
        ? ""
        : "Build a review screen.",
      expiresAt: EXPIRES_AT,
      id: SESSION_ID,
      intent: options.intent,
      status: "created",
      target: options.target,
    },
    message: "Created",
    platformMcpUrl: PLATFORM_MCP_URL,
    success: true,
  };
}

describe("createStudioHandoffCredential", () => {
  it("does not issue a broader new-Agent key before single-create binding exists", async () => {
    const createHandoff = vi.fn();
    await expect(createStudioHandoffCredential({
      description: "Own reservation replies.",
      intent: "agent",
      requestedTtlSeconds: 1_800,
      targetAgentId: null,
    }, { createHandoff })).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(createHandoff).not.toHaveBeenCalled();
  });

  it("maps an exact Agent-scoped extension credential", async () => {
    const createHandoff = vi.fn(async () =>
      response({
        appIds: [AGENT_ID],
        intent: "interface",
        target: {
          agentId: AGENT_ID,
          agentName: "Email Ops",
          kind: "agent",
        },
      }));
    const result = await createStudioHandoffCredential({
      description: "Build a review screen.",
      intent: "interface",
      requestedTtlSeconds: 1_800,
      targetAgentId: AGENT_ID,
    }, { createHandoff });

    expect(createHandoff).toHaveBeenCalledWith({
      description: "Build a review screen.",
      intent: "interface",
    }, AGENT_ID);
    expect(result).toEqual({
      bearerToken: PLAINTEXT_TOKEN,
      expiresAt: EXPIRES_AT,
      platformMcpUrl: PLATFORM_MCP_URL,
      scope: { agentId: AGENT_ID, kind: "agent" },
      sessionId: SESSION_ID,
      status: "issued",
    });
  });

  it("fails closed when the server targets a different Agent", async () => {
    const otherId = "8e145394-8055-46e0-8361-fe0204cc8123";
    const createHandoff = vi.fn(async () =>
      response({
        appIds: [otherId],
        intent: "interface",
        target: {
          agentId: otherId,
          agentName: "Other Agent",
          kind: "agent",
        },
      }));
    await expect(createStudioHandoffCredential({
      description: "Build a review screen.",
      intent: "interface",
      requestedTtlSeconds: 1_800,
      targetAgentId: AGENT_ID,
    }, { createHandoff })).resolves.toMatchObject({
      message: expect.stringMatching(/exact Agent/),
      status: "unavailable",
    });
  });

  it("fails closed when the server returns broader or duplicate scopes", async () => {
    for (
      const scopes of [
        [
          "apps:read",
          "agents:build",
          "agents:operate",
          "handoff:interface",
        ],
        [
          "apps:read",
          "agents:build",
          "handoff:interface",
          "handoff:interface",
        ],
      ]
    ) {
      const createHandoff = vi.fn(async () =>
        response({
          appIds: [AGENT_ID],
          intent: "interface",
          scopes,
          target: { agentId: AGENT_ID, agentName: "Email Ops", kind: "agent" },
        }));
      await expect(createStudioHandoffCredential({
        description: "Build a review screen.",
        intent: "interface",
        requestedTtlSeconds: 1_800,
        targetAgentId: AGENT_ID,
      }, { createHandoff })).resolves.toMatchObject({
        message: expect.stringMatching(/broader or malformed/),
        status: "unavailable",
      });
    }
  });

  it("fails closed when receipt identity, lifecycle, token, or MCP endpoint drift", async () => {
    const exactResponse = () =>
      response({
        appIds: [AGENT_ID],
        intent: "interface",
        target: {
          agentId: AGENT_ID,
          agentName: "Email Ops",
          kind: "agent",
        },
      });
    const malformedResponses = [
      (() => {
        const candidate = exactResponse();
        candidate.handoff.description = "A different request.";
        return candidate;
      })(),
      (() => {
        const candidate = exactResponse();
        candidate.credential.id = "8e145394-8055-46e0-8361-fe0204cc8123";
        return candidate;
      })(),
      (() => {
        const candidate = exactResponse();
        candidate.credential.expiresAt = "2026-07-27T13:30:00.000Z";
        candidate.handoff.expiresAt = candidate.credential.expiresAt;
        return candidate;
      })(),
      (() => {
        const candidate = exactResponse();
        candidate.credential.tokenPrefix = "not-a-pr";
        return candidate;
      })(),
      (() => {
        const candidate = exactResponse();
        candidate.credential.plaintextToken =
          'gx_0123456789abcdef01234567"; open -a X';
        candidate.credential.tokenPrefix =
          candidate.credential.plaintextToken.slice(0, 8);
        return candidate;
      })(),
      (() => {
        const candidate = exactResponse();
        candidate.platformMcpUrl = "https://evil.example/mcp/platform?token=x";
        return candidate;
      })(),
    ];

    for (const candidate of malformedResponses) {
      const createHandoff = vi.fn(async () => candidate);
      await expect(createStudioHandoffCredential({
        description: "Build a review screen.",
        intent: "interface",
        requestedTtlSeconds: 1_800,
        targetAgentId: AGENT_ID,
      }, { createHandoff })).resolves.toMatchObject({
        message: expect.stringMatching(/inconsistent handoff contract/),
        status: "unavailable",
      });
    }
  });

  it("maps a workspace-scoped Connect credential without app restrictions", async () => {
    const createHandoff = vi.fn(async () =>
      response({
        appIds: null,
        intent: "connect",
        target: { kind: "workspace" },
      }));
    await expect(createStudioHandoffCredential({
      description: "",
      intent: "connect",
      requestedTtlSeconds: 1_800,
      targetAgentId: null,
    }, { createHandoff })).resolves.toEqual({
      bearerToken: PLAINTEXT_TOKEN,
      expiresAt: EXPIRES_AT,
      platformMcpUrl: PLATFORM_MCP_URL,
      scope: { kind: "workspace" },
      sessionId: SESSION_ID,
      status: "issued",
    });
  });
});
