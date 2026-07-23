export interface FleetRevisionCarrier {
  fleetRevision?: string;
}

export interface FleetPreferenceRevisionCarrier {
  revision: string;
  updatedAt: string;
}

/**
 * Fleet order and keyboard preferences share one server-side CAS token.
 * Keep both client projections on the revision returned by either mutation so
 * the next write never needs a refetch merely to avoid a false conflict.
 */
export function withSharedFleetRevision<
  T extends FleetRevisionCarrier,
>(
  fleet: T | undefined,
  revision: string,
): T | undefined {
  return fleet ? { ...fleet, fleetRevision: revision } : fleet;
}

export function withSharedPreferenceRevision<
  T extends FleetPreferenceRevisionCarrier,
>(
  preferences: T | null,
  revision: string,
  updatedAt: string,
): T | null {
  return preferences ? { ...preferences, revision, updatedAt } : preferences;
}

/**
 * A preferences GET may have started before an order/shortcut mutation. Its
 * values are still useful, but its old revision must not roll the shared CAS
 * token backward after that mutation commits.
 */
export function reconcileFleetPreferenceRead<
  T extends FleetPreferenceRevisionCarrier,
>(
  preferences: T,
  requestedAtMutationGeneration: number,
  currentMutationGeneration: number,
  latestRevision: string | null,
): T {
  return requestedAtMutationGeneration !== currentMutationGeneration &&
      latestRevision
    ? { ...preferences, revision: latestRevision }
    : preferences;
}
