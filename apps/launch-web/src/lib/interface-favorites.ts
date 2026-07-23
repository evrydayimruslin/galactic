import type { LaunchAgentPreferences } from "../../../../shared/contracts/launch.ts";

const INTERFACE_FAVORITES_PREFIX = "ultralight.launch.interfaceFavorites.v1";

function storageKey(agentId: string): string {
  return `${INTERFACE_FAVORITES_PREFIX}:${encodeURIComponent(agentId)}`;
}

export function readInterfaceFavorites(
  storage: Pick<Storage, "getItem">,
  agentId: string,
  availableIds: string[],
): string[] {
  const available = new Set(availableIds);
  try {
    const raw = storage.getItem(storageKey(agentId));
    if (raw === null) return availableIds.slice(0, 3);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return availableIds.slice(0, 3);
    return [...new Set(parsed.filter((id): id is string => typeof id === "string" && available.has(id)))];
  } catch {
    return availableIds.slice(0, 3);
  }
}

export function writeInterfaceFavorites(
  storage: Pick<Storage, "setItem">,
  agentId: string,
  favoriteIds: string[],
): void {
  try {
    storage.setItem(storageKey(agentId), JSON.stringify([...new Set(favoriteIds)]));
  } catch {
    // Favorites remain usable for this session when storage is unavailable.
  }
}

/**
 * Returns only an explicitly persisted legacy selection. A missing or corrupt
 * value is not treated as a preference: the server owns first-interface
 * onboarding and preserves an explicitly empty server selection.
 */
export function readLegacyInterfaceFavoritesForMigration(
  storage: Pick<Storage, "getItem">,
  agentId: string,
  availableIds: readonly string[],
): string[] | null {
  const available = new Set(availableIds);
  try {
    const raw = storage.getItem(storageKey(agentId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return [
      ...new Set(
        parsed.filter((id): id is string =>
          typeof id === "string" && available.has(id)
        ),
      ),
    ];
  } catch {
    return null;
  }
}

export function clearLegacyInterfaceFavorites(
  storage: Pick<Storage, "removeItem">,
  agentId: string,
): void {
  try {
    storage.removeItem(storageKey(agentId));
  } catch {
    // A failed cleanup is harmless: server initialization prevents replay.
  }
}

export function shouldMigrateLegacyInterfaceFavorites(
  preferences: Pick<
    LaunchAgentPreferences,
    "favoriteInterfaceIds" | "favoritesExplicit"
  >,
  legacyIds: readonly string[],
): boolean {
  if (preferences.favoritesExplicit) return false;
  return legacyIds.length !== preferences.favoriteInterfaceIds.length ||
    legacyIds.some((id, index) =>
      preferences.favoriteInterfaceIds[index] !== id
    );
}

export function shouldApplyInterfaceFavoritesRead(options: {
  mounted: boolean;
  readGeneration: number;
  currentReadGeneration: number;
  mutationGeneration: number;
  currentMutationGeneration: number;
}): boolean {
  return options.mounted &&
    options.readGeneration === options.currentReadGeneration &&
    options.mutationGeneration === options.currentMutationGeneration;
}
