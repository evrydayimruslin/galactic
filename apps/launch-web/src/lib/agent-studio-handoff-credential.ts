import type {
  AgentStudioHandoffCredentialRequest,
  AgentStudioHandoffCredentialResult,
} from "../components/agent-studio/agent-studio-handoff-model";
import {
  isAgentStudioHandoffBearerToken,
  isAgentStudioHandoffPlatformMcpUrl,
  isAgentStudioHandoffUuid,
} from "../components/agent-studio/agent-studio-handoff-model";
import {
  launchApi,
  type LaunchApiClient,
} from "./api";

type HandoffClient = Pick<LaunchApiClient, "createHandoff">;

const DEFAULT_HANDOFF_CLIENT: HandoffClient = {
  createHandoff: launchApi.createHandoff.bind(launchApi),
};
const HANDOFF_TTL_MS = 1_800_000;
const HANDOFF_TIMESTAMP_TOLERANCE_MS = 30_000;

/**
 * Convert the public launch handoff contract into the stricter UI contract.
 *
 * The adapter deliberately fails closed when the server returns a broader,
 * longer-lived, or differently-targeted credential than the handoff UI asked
 * for. New-Agent handoffs stay disabled until AS-BE-002 can bind a credential
 * to exactly one created Agent.
 */
export async function createStudioHandoffCredential(
  request: AgentStudioHandoffCredentialRequest,
  client: HandoffClient = DEFAULT_HANDOFF_CLIENT,
): Promise<AgentStudioHandoffCredentialResult> {
  if (request.requestedTtlSeconds !== 1_800) {
    return {
      message: "Galactic only issues 30-minute Studio handoff credentials.",
      status: "unavailable",
    };
  }
  if (request.intent === "agent") {
    return {
      message:
        "New-Agent handoffs are waiting for durable single-create binding. No broader key was issued.",
      status: "unavailable",
    };
  }
  if (
    request.description !== request.description.trim() ||
    (request.intent !== "connect" && !request.description) ||
    request.description.length > 4_000 ||
    (request.intent === "connect"
      ? request.targetAgentId !== null
      : !request.targetAgentId ||
        !isAgentStudioHandoffUuid(request.targetAgentId))
  ) {
    return {
      message:
        "Galactic received a malformed Studio handoff request. No credential was issued.",
      status: "unavailable",
    };
  }

  try {
    const response = await client.createHandoff(
      {
        description: request.description,
        intent: request.intent,
      },
      request.targetAgentId,
    );
    const handoffCreatedAt = Date.parse(response.handoff.createdAt);
    const credentialCreatedAt = Date.parse(response.credential.createdAt);
    const expiresAt = Date.parse(response.credential.expiresAt);
    const generatedAt = Date.parse(response.generatedAt);
    const returnedTtlMs = expiresAt - credentialCreatedAt;
    if (
      response.success !== true ||
      response.handoff.intent !== request.intent ||
      response.handoff.status !== "created" ||
      response.handoff.description !== request.description ||
      !isAgentStudioHandoffUuid(response.handoff.id) ||
      response.handoff.id !== response.credential.id ||
      response.handoff.createdAt !== response.credential.createdAt ||
      response.handoff.expiresAt !== response.credential.expiresAt ||
      !Number.isFinite(handoffCreatedAt) ||
      !Number.isFinite(credentialCreatedAt) ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(generatedAt) ||
      expiresAt <= credentialCreatedAt ||
      Math.abs(returnedTtlMs - HANDOFF_TTL_MS) >
        HANDOFF_TIMESTAMP_TOLERANCE_MS ||
      generatedAt < credentialCreatedAt - HANDOFF_TIMESTAMP_TOLERANCE_MS ||
      generatedAt > credentialCreatedAt + HANDOFF_TIMESTAMP_TOLERANCE_MS ||
      !Array.isArray(response.credential.scopes) ||
      !isAgentStudioHandoffBearerToken(
        response.credential.plaintextToken,
      ) ||
      response.credential.tokenPrefix.length !== 8 ||
      response.credential.tokenPrefix !==
        response.credential.plaintextToken.slice(0, 8) ||
      !isAgentStudioHandoffPlatformMcpUrl(response.platformMcpUrl)
    ) {
      return {
        message:
          "Galactic returned an inconsistent handoff contract. No prompt was copied.",
        status: "unavailable",
      };
    }
    const expectedScopes = [
      "apps:read",
      "agents:build",
      `handoff:${request.intent}`,
    ].sort();
    const actualScopes = [...response.credential.scopes].sort();
    if (
      actualScopes.length !== expectedScopes.length ||
      actualScopes.some((scope, index) => scope !== expectedScopes[index])
    ) {
      return {
        message:
          "Galactic returned a broader or malformed handoff scope. No prompt was copied.",
        status: "unavailable",
      };
    }
    if (request.intent === "connect") {
      if (
        response.handoff.target.kind !== "workspace" ||
        (response.credential.appIds !== null &&
          response.credential.appIds.length > 0)
      ) {
        return {
          message:
            "Galactic did not return the requested workspace handoff scope.",
          status: "unavailable",
        };
      }
      return {
        bearerToken: response.credential.plaintextToken,
        expiresAt: response.credential.expiresAt,
        platformMcpUrl: response.platformMcpUrl,
        scope: { kind: "workspace" },
        sessionId: response.handoff.id,
        status: "issued",
      };
    }

    const targetAgentId = request.targetAgentId;
    if (
      !targetAgentId ||
      response.handoff.target.kind !== "agent" ||
      response.handoff.target.agentId !== targetAgentId ||
      response.credential.appIds?.length !== 1 ||
      response.credential.appIds[0] !== targetAgentId
    ) {
      return {
        message:
          "Galactic did not return a credential for this exact Agent. No prompt was copied.",
        status: "unavailable",
      };
    }
    return {
      bearerToken: response.credential.plaintextToken,
      expiresAt: response.credential.expiresAt,
      platformMcpUrl: response.platformMcpUrl,
      scope: { agentId: targetAgentId, kind: "agent" },
      sessionId: response.handoff.id,
      status: "issued",
    };
  } catch (reason) {
    return {
      message: reason instanceof Error ? reason.message : String(reason),
      status: "unavailable",
    };
  }
}
