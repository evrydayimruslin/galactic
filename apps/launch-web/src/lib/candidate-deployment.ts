import type {
  LaunchCandidateInvitation,
  LaunchSubscriptionResponse,
} from "../../../../shared/contracts/launch.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const MEMBERSHIP_CHECKOUT_IDEMPOTENCY_KEY =
  "galactic:membership-checkout-idempotency";
export const MEMBERSHIP_CHECKOUT_SELECTION_KEY =
  "galactic:membership-checkout-selection";

export interface CandidateAttemptStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export function candidateDeploymentStorageKey(
  candidate: Pick<LaunchCandidateInvitation, "id" | "evidence">,
): string {
  return `galactic:candidate-deployment:${candidate.id}:${candidate.evidence.releaseDigest}`;
}

export function getOrCreateCandidateDeploymentKey(
  storage: CandidateAttemptStorage | null,
  candidate: Pick<LaunchCandidateInvitation, "id" | "evidence">,
  createKey: () => string,
): string {
  const storageKey = candidateDeploymentStorageKey(candidate);
  try {
    const stored = storage?.getItem(storageKey);
    if (stored && UUID_PATTERN.test(stored)) return stored;
  } catch {
    // A hardened browser may deny sessionStorage. Same-request idempotency is
    // still preserved by the key returned below.
  }
  const created = createKey();
  if (!UUID_PATTERN.test(created)) {
    throw new Error("Candidate deployment requires a UUID idempotency key.");
  }
  try {
    storage?.setItem(storageKey, created);
  } catch {
    // The request can still proceed; the backend remains replay-safe.
  }
  return created;
}

export function clearCandidateDeploymentKey(
  storage: CandidateAttemptStorage | null,
  candidate: Pick<LaunchCandidateInvitation, "id" | "evidence">,
): void {
  try {
    storage?.removeItem(candidateDeploymentStorageKey(candidate));
  } catch {
    // A completed deployment does not depend on browser storage cleanup.
  }
}

export function getOrCreateMembershipCheckoutKey(
  storage: CandidateAttemptStorage | null,
  createKey: () => string,
): string {
  try {
    const stored = storage?.getItem(MEMBERSHIP_CHECKOUT_IDEMPOTENCY_KEY);
    if (stored && UUID_PATTERN.test(stored)) return stored;
  } catch {
    // A fresh key below still keeps this individual request replay-safe.
  }
  const created = createKey();
  if (!UUID_PATTERN.test(created)) {
    throw new Error("Membership checkout requires a UUID idempotency key.");
  }
  try {
    storage?.setItem(MEMBERSHIP_CHECKOUT_IDEMPOTENCY_KEY, created);
  } catch {
    // The request can still proceed; durable replay recovery is unavailable.
  }
  return created;
}

export function clearMembershipCheckoutKey(
  storage: CandidateAttemptStorage | null,
): void {
  try {
    storage?.removeItem(MEMBERSHIP_CHECKOUT_IDEMPOTENCY_KEY);
  } catch {
    // Terminal server state does not depend on browser cleanup.
  }
}

export function retainMembershipCheckoutKeyAfterFailure(
  reason: unknown,
): boolean {
  if (!reason || typeof reason !== "object" || !("status" in reason)) {
    return true;
  }
  const status = (reason as { status?: unknown }).status;
  return typeof status !== "number" || status === 409 || status >= 500;
}

export function restoreMembershipCandidateSelection(
  storage: CandidateAttemptStorage | null,
  signature: string,
  eligibleIds: ReadonlySet<string>,
): Set<string> | null {
  try {
    const raw = storage?.getItem(MEMBERSHIP_CHECKOUT_SELECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ids?: unknown; signature?: unknown };
    if (
      parsed.signature !== signature ||
      !Array.isArray(parsed.ids) ||
      !parsed.ids.every((id) => typeof id === "string")
    ) return null;
    return new Set(parsed.ids.filter((id) => eligibleIds.has(id)));
  } catch {
    return null;
  }
}

export function persistMembershipCandidateSelection(
  storage: CandidateAttemptStorage | null,
  signature: string,
  selectedIds: ReadonlySet<string>,
): void {
  try {
    storage?.setItem(
      MEMBERSHIP_CHECKOUT_SELECTION_KEY,
      JSON.stringify({ ids: [...selectedIds], signature }),
    );
  } catch {
    // Selection falls back to every eligible candidate after the return.
  }
}

export function hasActiveDeploymentMembership(
  subscription: LaunchSubscriptionResponse | undefined,
): boolean {
  return subscription?.hasActiveSubscription === true;
}

export function isCandidateDeploymentEligible(
  candidate: LaunchCandidateInvitation,
): boolean {
  return candidate.deploymentReady &&
    (candidate.status === "ready" || candidate.status === "deploying") &&
    candidate.blocker === null &&
    (candidate.target.kind !== "extension" ||
      candidate.target.lineageStatus === "current");
}

export function candidateInvitationHero(count: number): string {
  return count === 1
    ? "1 Agent is built, not deployed"
    : `${count} Agents are built, not deployed`;
}

export function candidateDeployButtonLabel(selectedCount: number): string {
  return `Deploy ${selectedCount} selected ${
    selectedCount === 1 ? "Agent" : "Agents"
  }`;
}
