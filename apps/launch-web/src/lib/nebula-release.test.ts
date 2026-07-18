import { describe, expect, it } from "vitest";

import type {
  LaunchAgentHomeActionRequest,
  LaunchAgentHomeResponse,
} from "../../../../shared/contracts/launch.ts";
import {
  createReleaseCandidateReviewToken,
  createReleasePromotionRequest,
  createSafeReleasePromotionStorage,
  currentReleaseSnapshotFromError,
  executeReleasePromotionWithRecovery,
  getOrCreateReleasePromotionIdempotencyKey,
  recoverableReleaseActionFromError,
  releaseCandidateMatchesReview,
  releaseReviewLabel,
  releasePromotionStorageKey,
  shouldRetainAgentHomeOverride,
  shouldRetainReleasePromotionAttempt,
  shortReleaseFingerprint,
} from "./nebula-release";

const FIRST_KEY = "11111111-1111-4111-8111-111111111111";
const SECOND_KEY = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function releaseSnapshot(
  overrides: Partial<LaunchAgentHomeResponse> = {},
): LaunchAgentHomeResponse {
  return {
    revision: `ah1:${AGENT_ID}:7`,
    release: {
      live: null,
      candidate: {
        version: "2.2.0",
        sourceFingerprint: "abcdef0123456789",
        uploadedAt: "2026-07-17T19:00:00.000Z",
        testedAt: "2026-07-17T19:01:00.000Z",
        authorityChanges: [],
        reviewStatus: "ready",
        canPromote: true,
      },
      candidateCount: 1,
    },
    actions: { canPromoteCandidate: true },
    ...overrides,
  } as LaunchAgentHomeResponse;
}

describe("Nebula release promotion", () => {
  it("builds an exact-version, revision-fenced owner promotion request", () => {
    const idempotencyKey = "11111111-1111-4111-8111-111111111111";
    const snapshot = releaseSnapshot();
    const review = createReleaseCandidateReviewToken(AGENT_ID, snapshot)!;
    expect(createReleasePromotionRequest(AGENT_ID, snapshot, review, idempotencyKey))
      .toEqual({
        action: "promote_candidate",
        expectedRevision: `ah1:${AGENT_ID}:7`,
        idempotencyKey,
        version: "2.2.0",
      });
  });

  it("refuses stale reviews and candidates the API says cannot be promoted", () => {
    const snapshot = releaseSnapshot();
    const review = createReleaseCandidateReviewToken(AGENT_ID, snapshot)!;
    expect(createReleasePromotionRequest(AGENT_ID, snapshot, {
      ...review,
      version: "2.1.0",
    }, FIRST_KEY)).toBeNull();
    const blocked = releaseSnapshot({
      actions: {
        ...releaseSnapshot().actions,
        canPromoteCandidate: false,
      },
    });
    expect(createReleasePromotionRequest(
      AGENT_ID,
      blocked,
      createReleaseCandidateReviewToken(AGENT_ID, blocked)!,
      FIRST_KEY,
    )).toBeNull();
  });

  it("invalidates review on revision, artifact, authority diff, or Agent changes", () => {
    const snapshot = releaseSnapshot();
    const review = createReleaseCandidateReviewToken(AGENT_ID, snapshot)!;
    expect(releaseCandidateMatchesReview(AGENT_ID, snapshot, review)).toBe(true);
    expect(releaseCandidateMatchesReview(AGENT_ID, {
      ...snapshot,
      revision: `ah1:${AGENT_ID}:8`,
    }, review)).toBe(false);
    expect(releaseCandidateMatchesReview("agent-2", snapshot, review)).toBe(false);
    expect(releaseCandidateMatchesReview(AGENT_ID, {
      ...snapshot,
      release: {
        ...snapshot.release,
        candidate: {
          ...snapshot.release.candidate!,
          authorityChanges: [{ change: "added", path: "network", label: "Network" }],
        },
      },
    }, review)).toBe(false);
  });

  it("formats review state and fingerprints for the compact Settings surface", () => {
    expect(releaseReviewLabel("owner_review_required")).toBe("Owner review required");
    expect(shortReleaseFingerprint("abcdef0123456789")).toBe("abcdef012345…");
    expect(shortReleaseFingerprint(null)).toBeNull();
  });

  it("persists and reuses one idempotency key for browser retries", () => {
    const storage = memoryStorage();
    const storageKey = releasePromotionStorageKey("agent-1", "2.2.0");
    expect(getOrCreateReleasePromotionIdempotencyKey(
      storage,
      storageKey,
      () => FIRST_KEY,
    )).toBe(FIRST_KEY);
    expect(getOrCreateReleasePromotionIdempotencyKey(
      storage,
      storageKey,
      () => SECOND_KEY,
    )).toBe(FIRST_KEY);
  });

  it("falls back to memory when browser session storage throws", () => {
    const throwingStorage = {
      getItem: () => { throw new DOMException("denied", "SecurityError"); },
      removeItem: () => { throw new DOMException("denied", "SecurityError"); },
      setItem: () => { throw new DOMException("denied", "SecurityError"); },
    };
    const storage = createSafeReleasePromotionStorage(throwingStorage);
    storage.setItem("attempt", FIRST_KEY);
    expect(storage.getItem("attempt")).toBe(FIRST_KEY);
    storage.removeItem("attempt");
    expect(storage.getItem("attempt")).toBeNull();
  });

  it("retains ambiguous attempts and clears deterministic terminal failures", () => {
    expect(shouldRetainReleasePromotionAttempt(new TypeError("network lost")))
      .toBe(true);
    expect(shouldRetainReleasePromotionAttempt({
      status: 409,
      code: "ACTION_PENDING",
    })).toBe(true);
    expect(shouldRetainReleasePromotionAttempt({
      status: 409,
      code: "AGENT_HOME_ACTION_RECOVERY_REQUIRED",
    })).toBe(true);
    expect(shouldRetainReleasePromotionAttempt({ status: 503 })).toBe(true);
    expect(shouldRetainReleasePromotionAttempt({ status: 400 })).toBe(false);
    expect(shouldRetainReleasePromotionAttempt({
      status: 409,
      responseBody: { terminal: true },
    })).toBe(false);
  });

  it("extracts the exact durable owner action from a recovery response", () => {
    expect(recoverableReleaseActionFromError({
      status: 409,
      responseBody: {
        recovery: {
          action: "pause",
          idempotencyKey: SECOND_KEY,
          requestPayload: { action: "pause" },
        },
      },
    })).toEqual({ action: "pause", idempotencyKey: SECOND_KEY });
  });

  it("reconciles a lost prior action before promoting the unchanged reviewed artifact", async () => {
    const snapshot = releaseSnapshot();
    const review = createReleaseCandidateReviewToken(AGENT_ID, snapshot)!;
    const recovered = {
      ...snapshot,
      revision: `ah1:${AGENT_ID}:8`,
    };
    const promoted = {
      ...recovered,
      revision: `ah1:${AGENT_ID}:9`,
      release: {
        live: {
          ...snapshot.release.candidate!,
          promotedAt: "2026-07-17T20:00:00.000Z",
          executedVersion: "2.2.0",
          integrity: "verified" as const,
        },
        candidate: null,
        candidateCount: 0,
      },
    };
    const calls: unknown[] = [];
    const result = await executeReleasePromotionWithRecovery({
      agentId: AGENT_ID,
      idempotencyKey: FIRST_KEY,
      review,
      snapshot,
      storage: memoryStorage(),
      call: async (request) => {
        calls.push(request);
        if (calls.length === 1) {
          throw {
            status: 409,
            code: "AGENT_HOME_ACTION_RECOVERY_REQUIRED",
            responseBody: {
              recovery: {
                action: "pause",
                idempotencyKey: SECOND_KEY,
                requestPayload: { action: "pause" },
              },
            },
          };
        }
        if (calls.length === 2) return recovered;
        return promoted;
      },
    });
    expect(result).toBe(promoted);
    expect(calls).toEqual([
      {
        action: "promote_candidate",
        expectedRevision: `ah1:${AGENT_ID}:7`,
        idempotencyKey: FIRST_KEY,
        version: "2.2.0",
      },
      {
        action: "pause",
        expectedRevision: `ah1:${AGENT_ID}:7`,
        idempotencyKey: SECOND_KEY,
      },
      {
        action: "promote_candidate",
        expectedRevision: `ah1:${AGENT_ID}:8`,
        idempotencyKey: FIRST_KEY,
        version: "2.2.0",
      },
    ]);
  });

  it("replays a stored recovery before promotion after an ambiguous recovery failure", async () => {
    const snapshot = releaseSnapshot();
    const review = createReleaseCandidateReviewToken(AGENT_ID, snapshot)!;
    const storage = memoryStorage();
    const requests: unknown[] = [];
    const recovered = { ...snapshot, revision: `ah1:${AGENT_ID}:8` };
    const promoted = {
      ...recovered,
      revision: `ah1:${AGENT_ID}:9`,
      release: {
        live: {
          ...snapshot.release.candidate!,
          promotedAt: "2026-07-17T20:00:00.000Z",
          executedVersion: "2.2.0",
          integrity: "verified" as const,
        },
        candidate: null,
        candidateCount: 0,
      },
    };
    const call = async (request: LaunchAgentHomeActionRequest) => {
      requests.push(request);
      if (requests.length === 1) {
        throw {
          status: 409,
          code: "AGENT_HOME_ACTION_RECOVERY_REQUIRED",
          responseBody: {
            recovery: {
              action: "pause",
              idempotencyKey: SECOND_KEY,
              requestPayload: { action: "pause" },
            },
          },
        };
      }
      if (requests.length === 2) throw { status: 503 };
      if (requests.length === 3) return recovered;
      return promoted;
    };
    await expect(executeReleasePromotionWithRecovery({
      agentId: AGENT_ID,
      idempotencyKey: FIRST_KEY,
      review,
      snapshot,
      storage,
      call,
    })).rejects.toEqual({ status: 503 });
    expect(storage.length).toBe(1);

    const result = await executeReleasePromotionWithRecovery({
      agentId: AGENT_ID,
      idempotencyKey: FIRST_KEY,
      review,
      snapshot,
      storage,
      call,
    });
    expect(result).toBe(promoted);
    expect(requests).toEqual([
      {
        action: "promote_candidate",
        expectedRevision: `ah1:${AGENT_ID}:7`,
        idempotencyKey: FIRST_KEY,
        version: "2.2.0",
      },
      {
        action: "pause",
        expectedRevision: `ah1:${AGENT_ID}:7`,
        idempotencyKey: SECOND_KEY,
      },
      {
        action: "pause",
        expectedRevision: `ah1:${AGENT_ID}:7`,
        idempotencyKey: SECOND_KEY,
      },
      {
        action: "promote_candidate",
        expectedRevision: `ah1:${AGENT_ID}:8`,
        idempotencyKey: FIRST_KEY,
        version: "2.2.0",
      },
    ]);
    expect(storage.length).toBe(0);
  });

  it("does not let a later-generated stale snapshot replace a confirmed mutation", () => {
    const optimistic = {
      ...releaseSnapshot(),
      revision: `ah1:${AGENT_ID}:9`,
      generatedAt: "2026-07-17T20:00:00.000Z",
    };
    const stale = {
      ...releaseSnapshot(),
      revision: `ah1:${AGENT_ID}:8`,
      generatedAt: "2026-07-17T21:00:00.000Z",
    };
    const current = { ...optimistic, generatedAt: "2026-07-17T22:00:00.000Z" };
    expect(shouldRetainAgentHomeOverride(AGENT_ID, optimistic, stale)).toBe(true);
    expect(shouldRetainAgentHomeOverride(AGENT_ID, optimistic, current)).toBe(false);
  });

  it("adopts a complete current snapshot from a revision conflict", () => {
    const current = {
      ...releaseSnapshot(),
      generatedAt: "2026-07-17T20:00:00.000Z",
      agent: { id: "agent-1" },
      state: { lifecycle: "paused" },
    } as unknown as LaunchAgentHomeResponse;
    expect(currentReleaseSnapshotFromError({
      status: 412,
      responseBody: { current },
    })).toBe(current);
    expect(currentReleaseSnapshotFromError({
      status: 412,
      responseBody: { current: { revision: "incomplete" } },
    })).toBeNull();
  });
});
