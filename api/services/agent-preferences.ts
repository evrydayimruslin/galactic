import type {
  LaunchAgentPreferences,
  LaunchAgentPreferencesUpdateRequest,
  LaunchFleetOrderUpdateRequest,
} from "../../shared/contracts/launch.ts";

const INTERFACE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const MAX_FAVORITE_INTERFACES = 100;
const MAX_FLEET_AGENTS = 1_000;

export class AgentPreferencesValidationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "AgentPreferencesValidationError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new AgentPreferencesValidationError(
      `Unknown fields: ${unknown.join(", ")}`,
      unknown[0]!,
    );
  }
}

export function validateAgentPreferencesUpdate(
  value: unknown,
): LaunchAgentPreferencesUpdateRequest {
  const body = record(value);
  if (!body) {
    throw new AgentPreferencesValidationError(
      "Preferences request must be an object",
      "$",
    );
  }
  rejectUnknown(body, [
    "expectedRevision",
    "favoriteInterfaceIds",
    "favoritesInitialized",
  ]);
  if (
    typeof body.expectedRevision !== "string" ||
    body.expectedRevision.length === 0 ||
    body.expectedRevision.length > 200 ||
    body.expectedRevision.trim() !== body.expectedRevision
  ) {
    throw new AgentPreferencesValidationError(
      "expectedRevision must be a non-empty canonical string",
      "expectedRevision",
    );
  }
  if (body.favoritesInitialized !== true) {
    throw new AgentPreferencesValidationError(
      "favoritesInitialized must be true",
      "favoritesInitialized",
    );
  }
  if (
    !Array.isArray(body.favoriteInterfaceIds) ||
    body.favoriteInterfaceIds.length > MAX_FAVORITE_INTERFACES
  ) {
    throw new AgentPreferencesValidationError(
      `favoriteInterfaceIds must contain at most ${MAX_FAVORITE_INTERFACES} ids`,
      "favoriteInterfaceIds",
    );
  }
  const favoriteInterfaceIds: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < body.favoriteInterfaceIds.length; index += 1) {
    const id = body.favoriteInterfaceIds[index];
    if (typeof id !== "string" || !INTERFACE_ID_RE.test(id)) {
      throw new AgentPreferencesValidationError(
        "Favorite Interface ids must be canonical manifest Interface ids",
        `favoriteInterfaceIds.${index}`,
      );
    }
    if (seen.has(id)) {
      throw new AgentPreferencesValidationError(
        "Favorite Interface ids must be unique",
        `favoriteInterfaceIds.${index}`,
      );
    }
    seen.add(id);
    favoriteInterfaceIds.push(id);
  }
  return {
    expectedRevision: body.expectedRevision,
    favoriteInterfaceIds,
    favoritesInitialized: true,
  };
}

/**
 * Seeds exactly one favorite only before the owner has initialized their
 * preference. An initialized empty list is preserved as an intentional choice.
 */
export function initializeAgentInterfaceFavorites(
  preferences: LaunchAgentPreferences,
  availableInterfaceIds: readonly string[],
): LaunchAgentPreferences {
  if (preferences.favoritesInitialized) return { ...preferences };
  const first = availableInterfaceIds.find((id) => INTERFACE_ID_RE.test(id));
  if (!first) return { ...preferences };
  return {
    ...preferences,
    favoriteInterfaceIds: [first],
    favoritesInitialized: true,
    favoritesExplicit: false,
  };
}

export function validateFleetOrderUpdate(
  value: unknown,
  ownedAgentIds?: ReadonlySet<string>,
): LaunchFleetOrderUpdateRequest {
  const body = record(value);
  if (!body) {
    throw new AgentPreferencesValidationError(
      "Fleet order request must be an object",
      "$",
    );
  }
  rejectUnknown(body, ["agentIds", "expectedRevision"]);
  if (
    typeof body.expectedRevision !== "string" ||
    body.expectedRevision.length === 0 ||
    body.expectedRevision.length > 200 ||
    body.expectedRevision.trim() !== body.expectedRevision
  ) {
    throw new AgentPreferencesValidationError(
      "expectedRevision must be a non-empty canonical string",
      "expectedRevision",
    );
  }
  if (
    !Array.isArray(body.agentIds) ||
    body.agentIds.length > MAX_FLEET_AGENTS
  ) {
    throw new AgentPreferencesValidationError(
      `agentIds must contain at most ${MAX_FLEET_AGENTS} ids`,
      "agentIds",
    );
  }
  const agentIds: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < body.agentIds.length; index += 1) {
    const id = body.agentIds[index];
    if (
      typeof id !== "string" || id.length === 0 || id.length > 128 ||
      id.trim() !== id
    ) {
      throw new AgentPreferencesValidationError(
        "Agent ids must be non-empty canonical strings",
        `agentIds.${index}`,
      );
    }
    if (seen.has(id)) {
      throw new AgentPreferencesValidationError(
        "Agent ids must be unique",
        `agentIds.${index}`,
      );
    }
    if (ownedAgentIds && !ownedAgentIds.has(id)) {
      throw new AgentPreferencesValidationError(
        "Fleet order may contain only owner-visible Agents",
        `agentIds.${index}`,
      );
    }
    seen.add(id);
    agentIds.push(id);
  }
  if (
    ownedAgentIds &&
    (agentIds.length !== ownedAgentIds.size ||
      [...ownedAgentIds].some((id) => !seen.has(id)))
  ) {
    throw new AgentPreferencesValidationError(
      "Fleet order must include every owner-visible Agent exactly once",
      "agentIds",
    );
  }
  return { agentIds, expectedRevision: body.expectedRevision };
}
