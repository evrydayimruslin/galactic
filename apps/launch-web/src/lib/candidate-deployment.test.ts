import { describe, expect, it } from "vitest";

import type {
  LaunchCandidateInvitation,
  LaunchSubscriptionResponse,
} from "../../../../shared/contracts/launch.ts";
import {
  candidateDeployButtonLabel,
  candidateDeploymentStorageKey,
  candidateInvitationHero,
  clearMembershipCheckoutKey,
  getOrCreateCandidateDeploymentKey,
  getOrCreateMembershipCheckoutKey,
  hasActiveDeploymentMembership,
  isCandidateDeploymentEligible,
  MEMBERSHIP_CHECKOUT_IDEMPOTENCY_KEY,
  MEMBERSHIP_CHECKOUT_SELECTION_KEY,
  needsCandidateDeploymentReconciliation,
  persistMembershipCandidateSelection,
  restoreMembershipCandidateSelection,
  retainMembershipCheckoutKeyAfterFailure,
  shouldReloadAfterCandidateDeployment,
} from "./candidate-deployment";

const CANDIDATE = {
  blocker: null,
  deploymentReady: true,
  evidence: {
    releaseDigest: "a".repeat(64),
  },
  id: "candidate-1",
  status: "ready",
  target: {
    kind: "new_agent",
    reservedAgentId: "agent-1",
  },
} as LaunchCandidateInvitation;

describe("candidate deployment client boundary", () => {
  it("uses exact invitation grammar and selected-Agent copy", () => {
    expect(candidateInvitationHero(1)).toBe(
      "1 Agent is built, not deployed",
    );
    expect(candidateInvitationHero(2)).toBe(
      "2 Agents are built, not deployed",
    );
    expect(candidateDeployButtonLabel(1)).toBe("Deploy 1 selected Agent");
    expect(candidateDeployButtonLabel(2)).toBe("Deploy 2 selected Agents");
  });

  it("fails closed when membership is absent or unknown", () => {
    expect(hasActiveDeploymentMembership(undefined)).toBe(false);
    expect(hasActiveDeploymentMembership({
      hasActiveSubscription: false,
    } as LaunchSubscriptionResponse)).toBe(false);
    expect(hasActiveDeploymentMembership({
      hasActiveSubscription: true,
    } as LaunchSubscriptionResponse)).toBe(true);
  });

  it("blocks stale, unqualified, and server-blocked candidates", () => {
    expect(isCandidateDeploymentEligible(CANDIDATE)).toBe(true);
    expect(isCandidateDeploymentEligible({
      ...CANDIDATE,
      status: "deploying",
    })).toBe(true);
    expect(isCandidateDeploymentEligible({
      ...CANDIDATE,
      deploymentReady: false,
    })).toBe(false);
    expect(isCandidateDeploymentEligible({
      ...CANDIDATE,
      blocker: { code: "blocked", message: "Blocked" },
    })).toBe(false);
    expect(isCandidateDeploymentEligible({
      ...CANDIDATE,
      target: {
        agentId: "agent-1",
        agentName: "Agent",
        agentSlug: "agent",
        baseLineage: {
          releaseDigest: null,
          sourceHash: null,
          stateDigest: "b".repeat(64),
          version: "1.0.0",
        },
        currentVersion: "1.1.0",
        kind: "extension",
        lineageStatus: "stale",
      },
    })).toBe(false);
  });

  it("keeps pending deployments in reconciliation until the durable list catches up", () => {
    expect(needsCandidateDeploymentReconciliation(CANDIDATE)).toBe(false);
    expect(needsCandidateDeploymentReconciliation(CANDIDATE, "pending")).toBe(
      true,
    );
    expect(needsCandidateDeploymentReconciliation(CANDIDATE, "deploying")).toBe(
      true,
    );
    expect(needsCandidateDeploymentReconciliation({
      ...CANDIDATE,
      status: "deploying",
    }, "failed")).toBe(true);
    expect(needsCandidateDeploymentReconciliation(CANDIDATE, "failed")).toBe(
      false,
    );

    expect(shouldReloadAfterCandidateDeployment(["pending"])).toBe(true);
    expect(shouldReloadAfterCandidateDeployment(["completed"])).toBe(true);
    expect(shouldReloadAfterCandidateDeployment(["failed"])).toBe(false);
  });

  it("persists and reuses one key for a lost deployment response", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";

    expect(getOrCreateCandidateDeploymentKey(
      storage,
      CANDIDATE,
      () => first,
    )).toBe(first);
    expect(getOrCreateCandidateDeploymentKey(
      storage,
      CANDIDATE,
      () => second,
    )).toBe(first);
    expect(values.get(candidateDeploymentStorageKey(CANDIDATE))).toBe(first);
  });

  it("persists one checkout key until the server outcome is terminal", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";

    expect(getOrCreateMembershipCheckoutKey(storage, () => first)).toBe(first);
    expect(getOrCreateMembershipCheckoutKey(storage, () => second)).toBe(first);
    expect(values.get(MEMBERSHIP_CHECKOUT_IDEMPOTENCY_KEY)).toBe(first);

    clearMembershipCheckoutKey(storage);
    expect(values.has(MEMBERSHIP_CHECKOUT_IDEMPOTENCY_KEY)).toBe(false);
  });

  it("retains checkout keys only when the result may be ambiguous", () => {
    expect(retainMembershipCheckoutKeyAfterFailure(
      new Error("network disconnected"),
    )).toBe(true);
    expect(retainMembershipCheckoutKeyAfterFailure({ status: 503 })).toBe(true);
    expect(retainMembershipCheckoutKeyAfterFailure({ status: 409 })).toBe(true);
    expect(retainMembershipCheckoutKeyAfterFailure({ status: 400 })).toBe(
      false,
    );
  });

  it("restores only the exact reviewed candidate selection after checkout", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const eligible = new Set(["candidate-1", "candidate-2"]);

    persistMembershipCandidateSelection(
      storage,
      "candidate-1:r1|candidate-2:r1",
      new Set(["candidate-2"]),
    );
    expect(values.has(MEMBERSHIP_CHECKOUT_SELECTION_KEY)).toBe(true);
    expect(restoreMembershipCandidateSelection(
      storage,
      "candidate-1:r1|candidate-2:r1",
      eligible,
    )).toEqual(new Set(["candidate-2"]));
    expect(restoreMembershipCandidateSelection(
      storage,
      "candidate-1:r1|candidate-2:r1",
      eligible,
      new Set(["candidate-1"]),
    )).toEqual(new Set(["candidate-2", "candidate-1"]));
    expect(restoreMembershipCandidateSelection(
      storage,
      "candidate-1:r2|candidate-2:r1",
      eligible,
    )).toBeNull();

    values.set(
      MEMBERSHIP_CHECKOUT_SELECTION_KEY,
      JSON.stringify({
        ids: ["candidate-2", "candidate-not-eligible"],
        signature: "candidate-1:r1|candidate-2:r1",
      }),
    );
    expect(restoreMembershipCandidateSelection(
      storage,
      "candidate-1:r1|candidate-2:r1",
      eligible,
    )).toEqual(new Set(["candidate-2"]));
  });
});
