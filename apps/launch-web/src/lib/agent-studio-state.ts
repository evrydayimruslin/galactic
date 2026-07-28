import type {
  LaunchAgentHomeResponse,
} from "../../../../shared/contracts/launch.ts";

export interface AgentStudioStatus {
  label: string;
  tone: "live" | "waiting" | "stopped";
}

export function shouldShowAgentSetup(
  home: LaunchAgentHomeResponse,
): boolean {
  const mode = home.operatingSummary?.mode;
  return !home.release.live ||
    mode === "no_live_release" ||
    mode === "no_enabled_routine" ||
    (
      home.state.lifecycle === "needs_setup" &&
      home.recentRuns.length === 0
    );
}

export function studioStatus(
  home: LaunchAgentHomeResponse | null | undefined,
): AgentStudioStatus {
  if (!home) return { label: "Loading", tone: "waiting" };
  if (
    home.state.lifecycle === "disabled" ||
    home.operatingSummary?.mode === "disabled"
  ) {
    return { label: "Disabled", tone: "stopped" };
  }
  if (
    home.state.health === "failing" ||
    home.operatingSummary?.mode === "error"
  ) {
    return { label: "Error", tone: "stopped" };
  }
  if (home.operatingSummary?.readiness.working) {
    return { label: "Live", tone: "live" };
  }
  if (
    home.state.lifecycle === "paused" ||
    home.operatingSummary?.mode === "paused"
  ) {
    return { label: "Paused", tone: "stopped" };
  }
  if (
    home.state.lifecycle === "needs_setup" ||
    home.operatingSummary?.mode === "no_live_release" ||
    home.operatingSummary?.mode === "no_enabled_routine" ||
    home.operatingSummary?.mode === "setup_required"
  ) {
    return { label: "Setup", tone: "waiting" };
  }
  return { label: "Waiting", tone: "waiting" };
}

/** Keep a request key only when the server outcome is unknown. */
export function retainIdempotencyKeyAfterFailure(reason: unknown): boolean {
  if (!reason || typeof reason !== "object" || !("status" in reason)) {
    return true;
  }
  const error = reason as {
    code?: unknown;
    responseBody?: unknown;
    status?: unknown;
  };
  if (
    error.responseBody &&
    typeof error.responseBody === "object" &&
    (error.responseBody as { terminal?: unknown }).terminal === false
  ) {
    return true;
  }
  if (
    typeof error.code === "string" &&
    (error.code.includes("STATUS_UNKNOWN") ||
      error.code.includes("ACTION_IN_PROGRESS"))
  ) {
    return true;
  }
  return typeof error.status !== "number" || error.status === 409 ||
    error.status >= 500;
}

const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function getOrCreateStudioActionKey(
  attemptSignature: string,
  memory: Map<string, string>,
): string {
  const storageKey = `galactic:agent-studio:action:${attemptSignature}`;
  let stored: string | null = null;
  try {
    stored = window.sessionStorage.getItem(storageKey);
  } catch {
    // The in-memory map still protects retries in this mounted session.
  }
  const key = memory.get(attemptSignature) ??
    (stored && IDEMPOTENCY_KEY_PATTERN.test(stored) ? stored : null) ??
    globalThis.crypto.randomUUID();
  memory.set(attemptSignature, key);
  try {
    window.sessionStorage.setItem(storageKey, key);
  } catch {
    // Keep the in-memory attempt.
  }
  return key;
}

export function clearStudioActionKey(
  attemptSignature: string,
  memory: Map<string, string>,
): void {
  memory.delete(attemptSignature);
  try {
    window.sessionStorage.removeItem(
      `galactic:agent-studio:action:${attemptSignature}`,
    );
  } catch {
    // The attempt is cleared in memory even when storage is unavailable.
  }
}
