import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { LaunchAgentPreferences } from "../../shared/contracts/launch.ts";
import {
  AgentPreferencesValidationError,
  initializeAgentInterfaceFavorites,
  validateAgentPreferencesUpdate,
  validateFleetOrderUpdate,
} from "./agent-preferences.ts";

function preferences(
  overrides: Partial<LaunchAgentPreferences> = {},
): LaunchAgentPreferences {
  return {
    agentId: "agent-1",
    favoriteInterfaceIds: [],
    favoritesInitialized: false,
    favoritesExplicit: false,
    revision: "prefs:1",
    updatedAt: null,
    ...overrides,
  };
}

Deno.test("agent preferences: validates canonical distinct Interface favorites", () => {
  assertEquals(
    validateAgentPreferencesUpdate({
      expectedRevision: "prefs:1",
      favoriteInterfaceIds: ["inbox", "daily_report"],
      favoritesInitialized: true,
    }),
    {
      expectedRevision: "prefs:1",
      favoriteInterfaceIds: ["inbox", "daily_report"],
      favoritesInitialized: true,
    },
  );
  assertThrows(
    () =>
      validateAgentPreferencesUpdate({
        expectedRevision: "prefs:1",
        favoriteInterfaceIds: ["inbox", "inbox"],
        favoritesInitialized: true,
      }),
    AgentPreferencesValidationError,
    "unique",
  );
});

Deno.test("agent preferences: seeds only the first Interface before initialization", () => {
  assertEquals(
    initializeAgentInterfaceFavorites(
      preferences(),
      ["inbox", "report", "teach"],
    ).favoriteInterfaceIds,
    ["inbox"],
  );
  assertEquals(
    initializeAgentInterfaceFavorites(
      preferences({
        favoritesInitialized: true,
        favoritesExplicit: true,
        favoriteInterfaceIds: [],
      }),
      ["inbox"],
    ).favoriteInterfaceIds,
    [],
  );
  assertEquals(
    initializeAgentInterfaceFavorites(preferences(), [])
      .favoritesInitialized,
    false,
  );
});

Deno.test("agent preferences: fleet order must be a complete owner-only permutation", () => {
  const owned = new Set(["agent-1", "agent-2"]);
  assertEquals(
    validateFleetOrderUpdate(
      { agentIds: ["agent-2", "agent-1"], expectedRevision: "fleet:1" },
      owned,
    ),
    { agentIds: ["agent-2", "agent-1"], expectedRevision: "fleet:1" },
  );
  assertThrows(
    () =>
      validateFleetOrderUpdate(
        { agentIds: ["agent-1"], expectedRevision: "fleet:1" },
        owned,
      ),
    AgentPreferencesValidationError,
    "every owner-visible Agent",
  );
  assertThrows(
    () =>
      validateFleetOrderUpdate(
        {
          agentIds: ["agent-1", "foreign"],
          expectedRevision: "fleet:1",
        },
        owned,
      ),
    AgentPreferencesValidationError,
    "owner-visible",
  );
});
