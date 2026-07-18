import type {
  LaunchAgentHomeAction,
  LaunchAgentHomeActionRequest,
  LaunchAgentHomeResponse,
} from "../../../../shared/contracts/launch.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RELEASE_PROMOTION_MEMORY = new Map<string, string>();

export interface ReleasePromotionStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

interface RequestErrorLike {
  code?: unknown;
  responseBody?: unknown;
  status?: unknown;
}

export interface ReleaseCandidateReviewToken {
  agentId: string;
  releaseSignature: string;
  revision: string;
  sourceFingerprint: string | null;
  version: string;
}

export type RecoverableReleaseAction = Omit<
  LaunchAgentHomeActionRequest,
  "expectedRevision"
>;

export function releaseReviewLabel(
  status: NonNullable<LaunchAgentHomeResponse["release"]["candidate"]>["reviewStatus"],
): string {
  switch (status) {
    case "ready":
      return "Ready to promote";
    case "owner_review_required":
      return "Owner review required";
    case "unavailable":
      return "Not ready";
  }
}

export function shortReleaseFingerprint(value: string | null): string | null {
  if (!value) return null;
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

export function releasePromotionStorageKey(
  agentId: string,
  version: string,
): string {
  return `galactic:agent-home:${agentId}:action:promote_candidate:${version}`;
}

export function releaseRecoveryStorageKey(
  agentId: string,
): string {
  return `galactic:agent-home:${agentId}:action:pending-recovery`;
}

/**
 * Browsers may deny sessionStorage in hardened/private contexts. Keep an
 * in-memory mirror so the owner can still promote safely in this tab, while
 * best-effort persistence preserves the key across a reload when available.
 */
export function createSafeReleasePromotionStorage(
  primary: ReleasePromotionStorage | null,
  memory = RELEASE_PROMOTION_MEMORY,
): ReleasePromotionStorage {
  return {
    getItem(key) {
      try {
        const stored = primary?.getItem(key) ?? null;
        if (stored !== null) memory.set(key, stored);
        return stored ?? memory.get(key) ?? null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    removeItem(key) {
      memory.delete(key);
      try {
        primary?.removeItem(key);
      } catch {
        // The in-memory copy is already cleared.
      }
    },
    setItem(key, value) {
      memory.set(key, value);
      try {
        primary?.setItem(key, value);
      } catch {
        // The in-memory copy still provides same-tab at-most-once retries.
      }
    },
  };
}

/**
 * Reuse the same action key after a lost response or server-side pending
 * outcome. That lets the Agent Home action lease reconcile at-most-once work
 * instead of treating a browser retry as a second promotion.
 */
export function getOrCreateReleasePromotionIdempotencyKey(
  storage: ReleasePromotionStorage,
  storageKey: string,
  createKey: () => string,
): string {
  const stored = storage.getItem(storageKey);
  if (stored && UUID_PATTERN.test(stored)) return stored;
  const created = createKey();
  if (!UUID_PATTERN.test(created)) {
    throw new Error("Release promotion requires a UUID idempotency key.");
  }
  storage.setItem(storageKey, created);
  return created;
}

export function shouldRetainReleasePromotionAttempt(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const candidate = error as RequestErrorLike;
  if (typeof candidate.status !== "number") return true;
  if (
    candidate.responseBody && typeof candidate.responseBody === "object" &&
    (candidate.responseBody as { terminal?: unknown }).terminal === true
  ) return false;
  const code = typeof candidate.code === "string"
    ? candidate.code.toLowerCase()
    : "";
  if (
    code.includes("pending") || code.includes("in_progress") ||
    code === "agent_home_action_recovery_required"
  ) return true;
  return candidate.status >= 500 || candidate.status === 408 ||
    candidate.status === 425 || candidate.status === 429;
}

function normalizeRecoverableReleaseAction(
  value: unknown,
): RecoverableReleaseAction | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    action?: unknown;
    idempotencyKey?: unknown;
    requestPayload?: unknown;
  };
  if (
    typeof candidate.idempotencyKey !== "string" ||
    !UUID_PATTERN.test(candidate.idempotencyKey) ||
    typeof candidate.action !== "string" ||
    ![
      "approve_capabilities",
      "activate",
      "pause",
      "run_now",
      "promote_candidate",
    ].includes(candidate.action) ||
    !candidate.requestPayload || typeof candidate.requestPayload !== "object"
  ) return null;

  const action = candidate.action as LaunchAgentHomeAction;
  const payload = candidate.requestPayload as {
    capabilityIds?: unknown;
    version?: unknown;
  };
  const capabilityIds = Array.isArray(payload.capabilityIds) &&
      payload.capabilityIds.every((id) => typeof id === "string" && id.length > 0)
    ? payload.capabilityIds as string[]
    : [];
  const version = typeof payload.version === "string" && payload.version.length > 0
    ? payload.version
    : null;
  if (action === "approve_capabilities" && capabilityIds.length === 0) return null;
  if (action === "promote_candidate" && !version) return null;
  return {
    action,
    idempotencyKey: candidate.idempotencyKey,
    ...(action === "approve_capabilities" ? { capabilityIds } : {}),
    ...(action === "promote_candidate" ? { version: version! } : {}),
  };
}

export function recoverableReleaseActionFromError(
  error: unknown,
): RecoverableReleaseAction | null {
  if (!error || typeof error !== "object") return null;
  const body = (error as RequestErrorLike).responseBody;
  if (!body || typeof body !== "object") return null;
  return normalizeRecoverableReleaseAction(
    (body as { recovery?: unknown }).recovery,
  );
}

function storedReleaseRecovery(
  storage: ReleasePromotionStorage,
  storageKey: string,
): RecoverableReleaseAction | null {
  const raw = storage.getItem(storageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid recovery");
    const action = parsed as RecoverableReleaseAction;
    const normalized = normalizeRecoverableReleaseAction({
      action: action.action,
      idempotencyKey: action.idempotencyKey,
      requestPayload: {
        capabilityIds: action.capabilityIds,
        version: action.version,
      },
    });
    if (normalized) return normalized;
  } catch {
    // Fall through and discard invalid or obsolete browser state.
  }
  storage.removeItem(storageKey);
  return null;
}

export function currentReleaseSnapshotFromError(
  error: unknown,
): LaunchAgentHomeResponse | null {
  if (!error || typeof error !== "object") return null;
  const body = (error as RequestErrorLike).responseBody;
  if (!body || typeof body !== "object") return null;
  const current = (body as { current?: unknown }).current;
  if (!current || typeof current !== "object") return null;
  const candidate = current as Partial<LaunchAgentHomeResponse>;
  return typeof candidate.revision === "string" &&
      typeof candidate.generatedAt === "string" &&
      Boolean(candidate.agent) && Boolean(candidate.state)
    ? current as LaunchAgentHomeResponse
    : null;
}

function revisionCounter(
  revision: string,
  agentId: string,
): bigint | null {
  const parts = revision.split(":");
  if (parts.length !== 3 || parts[0] !== "ah1" || !/^[1-9][0-9]*$/u.test(parts[2])) {
    return null;
  }
  try {
    if (decodeURIComponent(parts[1]) !== agentId) return null;
    return BigInt(parts[2]);
  } catch {
    return null;
  }
}

/** True only while the fetched snapshot is known to be older than the mutation response. */
export function shouldRetainAgentHomeOverride(
  agentId: string,
  optimistic: LaunchAgentHomeResponse,
  upstream: LaunchAgentHomeResponse,
): boolean {
  if (optimistic.revision === upstream.revision) return false;
  const optimisticRevision = revisionCounter(optimistic.revision, agentId);
  const upstreamRevision = revisionCounter(upstream.revision, agentId);
  if (optimisticRevision !== null && upstreamRevision !== null) {
    return upstreamRevision < optimisticRevision;
  }
  // Opaque future revision formats remain fenced: do not replace a confirmed
  // mutation with a non-equivalent snapshot merely because it was fetched later.
  return JSON.stringify(upstream.release) !== JSON.stringify(optimistic.release) ||
    upstream.agent.name !== optimistic.agent.name ||
    upstream.agent.description !== optimistic.agent.description;
}

export function createReleaseCandidateReviewToken(
  agentId: string,
  snapshot: LaunchAgentHomeResponse,
): ReleaseCandidateReviewToken | null {
  const candidate = snapshot.release.candidate;
  if (!candidate) return null;
  return {
    agentId,
    releaseSignature: JSON.stringify({
      authorityChanges: candidate.authorityChanges,
      canPromote: candidate.canPromote,
      live: snapshot.release.live,
      reviewStatus: candidate.reviewStatus,
      sourceFingerprint: candidate.sourceFingerprint,
      version: candidate.version,
    }),
    revision: snapshot.revision,
    sourceFingerprint: candidate.sourceFingerprint,
    version: candidate.version,
  };
}

export function releaseCandidateArtifactMatchesReview(
  agentId: string,
  snapshot: LaunchAgentHomeResponse,
  review: ReleaseCandidateReviewToken,
): boolean {
  const current = createReleaseCandidateReviewToken(agentId, snapshot);
  return current !== null && current.agentId === review.agentId &&
    current.version === review.version &&
    current.sourceFingerprint === review.sourceFingerprint &&
    current.releaseSignature === review.releaseSignature;
}

export function releaseCandidateMatchesReview(
  agentId: string,
  snapshot: LaunchAgentHomeResponse,
  review: ReleaseCandidateReviewToken,
): boolean {
  const candidate = snapshot.release.candidate;
  return candidate !== null && review.revision === snapshot.revision &&
    releaseCandidateArtifactMatchesReview(agentId, snapshot, review);
}

/**
 * Builds the exact owner-session promotion request only while the reviewed
 * version is still the promotable candidate in this snapshot. The API repeats
 * these checks against `expectedRevision`; keeping them here prevents a stale
 * confirmation control from submitting a different candidate.
 */
export function createReleasePromotionRequest(
  agentId: string,
  snapshot: LaunchAgentHomeResponse,
  review: ReleaseCandidateReviewToken,
  idempotencyKey: string,
): LaunchAgentHomeActionRequest | null {
  const candidate = snapshot.release.candidate;
  if (
    !candidate ||
    !releaseCandidateMatchesReview(agentId, snapshot, review) ||
    !candidate.canPromote ||
    !snapshot.actions.canPromoteCandidate
  ) {
    return null;
  }
  return {
    action: "promote_candidate",
    expectedRevision: snapshot.revision,
    idempotencyKey,
    version: candidate.version,
  };
}

class ReleasePromotionReviewExpiredError extends Error {
  readonly code = "RELEASE_PROMOTION_REVIEW_EXPIRED";
  readonly status = 409;
  readonly responseBody: { current: LaunchAgentHomeResponse };

  constructor(message: string, current: LaunchAgentHomeResponse) {
    super(message);
    this.name = "ReleasePromotionReviewExpiredError";
    this.responseBody = { current };
  }
}

/**
 * Completes an exact owner promotion, first reconciling a durable action whose
 * browser key was lost. Recovery may advance the revision, but the current
 * promotion is resumed only when the reviewed artifact, authority diff, and
 * live baseline are byte-for-byte unchanged.
 */
export async function executeReleasePromotionWithRecovery(input: {
  agentId: string;
  call: (request: LaunchAgentHomeActionRequest) => Promise<LaunchAgentHomeResponse>;
  idempotencyKey: string;
  review: ReleaseCandidateReviewToken;
  snapshot: LaunchAgentHomeResponse;
  storage: ReleasePromotionStorage;
}): Promise<LaunchAgentHomeResponse> {
  const request = createReleasePromotionRequest(
    input.agentId,
    input.snapshot,
    input.review,
    input.idempotencyKey,
  );
  if (!request) {
    throw new ReleasePromotionReviewExpiredError(
      "That candidate changed or is no longer ready. Review the latest release before promoting.",
      input.snapshot,
    );
  }
  const recoveryStorageKey = releaseRecoveryStorageKey(input.agentId);
  const reconcileRecovery = async (
    recovery: RecoverableReleaseAction,
  ): Promise<LaunchAgentHomeResponse> => {
    try {
      const recovered = await input.call({
        ...recovery,
        expectedRevision: input.snapshot.revision,
      });
      input.storage.removeItem(recoveryStorageKey);
      if (
        recovered.release.live?.version === input.review.version &&
        recovered.release.live.sourceFingerprint === input.review.sourceFingerprint
      ) {
        return recovered;
      }
      if (
        !releaseCandidateArtifactMatchesReview(
          input.agentId,
          recovered,
          input.review,
        )
      ) {
        throw new ReleasePromotionReviewExpiredError(
          "The release changed while an earlier action was recovered. Review the current candidate before promoting.",
          recovered,
        );
      }
      const recoveredRequest = createReleasePromotionRequest(
        input.agentId,
        recovered,
        { ...input.review, revision: recovered.revision },
        input.idempotencyKey,
      );
      if (!recoveredRequest) {
        throw new ReleasePromotionReviewExpiredError(
          "The recovered release is no longer promotable. Review its current state before trying again.",
          recovered,
        );
      }
      return await input.call(recoveredRequest);
    } catch (recoveryError) {
      if (!shouldRetainReleasePromotionAttempt(recoveryError)) {
        input.storage.removeItem(recoveryStorageKey);
      }
      throw recoveryError;
    }
  };

  // An earlier browser attempt may have lost the response while reconciling a
  // different durable owner action. Replay that exact stored request before a
  // new promotion so the action lease cannot strand this UI until expiry.
  const pendingRecovery = storedReleaseRecovery(
    input.storage,
    recoveryStorageKey,
  );
  if (pendingRecovery) return await reconcileRecovery(pendingRecovery);

  try {
    return await input.call(request);
  } catch (initialError) {
    const recovery = recoverableReleaseActionFromError(initialError);
    if (!recovery) throw initialError;
    input.storage.setItem(recoveryStorageKey, JSON.stringify(recovery));
    return await reconcileRecovery(recovery);
  }
}
