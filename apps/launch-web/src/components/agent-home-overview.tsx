import {
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  LaunchAgentHomeAction,
  LaunchAgentHomeActionRequest,
  LaunchAgentHomeAuthorityItem,
  LaunchAgentHomeBudget,
  LaunchAgentHomeHealth,
  LaunchAgentHomeLifecycleState,
  LaunchAgentHomeRequirement,
  LaunchAgentHomeResponse,
  LaunchAgentHomeRun,
} from "../../../../shared/contracts/launch.ts";
import {
  launchApi,
  LaunchApiRequestError,
} from "../lib/api";
import { Button, Card, Mono, Pill } from "./launch-chrome";

interface AgentHomeOverviewProps {
  agentId: string;
  home?: LaunchAgentHomeResponse;
  loadError?: string;
  reload: () => void;
}

interface IdentityDraft {
  name: string;
  description: string;
}

interface ResponsibilityDraft {
  mission: string;
  cadenceMinutes: string;
}

interface BudgetDraft {
  perRun: string;
  daily: string;
  monthly: string;
  callsPerRun: string;
}

type MutationKey =
  | "identity"
  | "responsibility"
  | "budget"
  | `setting:${string}`
  | `remove:${string}`
  | `approve:${string}`
  | `action:${LaunchAgentHomeAction}`;

type ResetSection = "identity" | "responsibility" | "budget";

const AUTHORITY_ORDER: LaunchAgentHomeAuthorityItem["kind"][] = [
  "function",
  "agent_call",
  "network",
  "ai",
  "storage",
  "memory",
  "compute",
  "reporting",
  "other",
];

const AUTHORITY_LABELS: Record<LaunchAgentHomeAuthorityItem["kind"], string> = {
  function: "Exposed functions",
  agent_call: "Agent calls",
  network: "Network destinations",
  ai: "AI inference",
  storage: "Storage",
  memory: "Memory",
  compute: "Compute",
  reporting: "Reporting",
  other: "Other authority",
};

function identityDraft(home: LaunchAgentHomeResponse | null): IdentityDraft {
  return {
    name: home?.agent.name ?? "",
    description: home?.agent.description ?? "",
  };
}

function responsibilityDraft(
  home: LaunchAgentHomeResponse | null,
): ResponsibilityDraft {
  return {
    mission: home?.responsibility.mission ?? "",
    cadenceMinutes: home?.responsibility.cadence
      ? String(home.responsibility.cadence.intervalSeconds / 60)
      : "",
  };
}

function budgetDraft(budget: LaunchAgentHomeBudget | null | undefined): BudgetDraft {
  return {
    perRun: budget ? String(budget.ceilings.perRun) : "",
    daily: budget ? String(budget.ceilings.daily) : "",
    monthly: budget ? String(budget.ceilings.monthly) : "",
    callsPerRun: budget ? String(budget.ceilings.callsPerRun) : "",
  };
}

function isIdentityDirty(
  draft: IdentityDraft,
  home: LaunchAgentHomeResponse,
): boolean {
  return draft.name.trim() !== home.agent.name ||
    draft.description.trim() !== (home.agent.description ?? "");
}

function isResponsibilityDirty(
  draft: ResponsibilityDraft,
  home: LaunchAgentHomeResponse,
): boolean {
  if (!home.responsibility.cadence) return false;
  return draft.mission.trim() !== home.responsibility.mission ||
    draft.cadenceMinutes !==
      String(home.responsibility.cadence.intervalSeconds / 60);
}

function isBudgetDirty(
  draft: BudgetDraft,
  home: LaunchAgentHomeResponse,
): boolean {
  const budget = home.budget;
  if (!budget) return false;
  return draft.perRun !== String(budget.ceilings.perRun) ||
    draft.daily !== String(budget.ceilings.daily) ||
    draft.monthly !== String(budget.ceilings.monthly) ||
    draft.callsPerRun !== String(budget.ceilings.callsPerRun);
}

function statusLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function lifecycleTone(value: LaunchAgentHomeLifecycleState) {
  if (value === "active") return "green" as const;
  if (value === "needs_setup" || value === "paused") return "amber" as const;
  return "default" as const;
}

function healthTone(value: LaunchAgentHomeHealth) {
  if (value === "healthy") return "green" as const;
  if (value === "degraded") return "amber" as const;
  if (value === "failing") return "red" as const;
  return "default" as const;
}

function runTone(status: LaunchAgentHomeRun["status"]) {
  if (status === "succeeded") return "green" as const;
  if (status === "failed" || status === "cancelled") return "red" as const;
  if (status === "skipped") return "amber" as const;
  return "default" as const;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${Math.max(0, Math.round(value))} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function absoluteTime(value: string | null): string {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function relativeTime(value: string | null): string {
  if (!value) return "Not yet";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const delta = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(delta) < 60) return formatter.format(delta, "second");
  if (Math.abs(delta) < 3600) return formatter.format(Math.round(delta / 60), "minute");
  if (Math.abs(delta) < 86400) return formatter.format(Math.round(delta / 3600), "hour");
  return formatter.format(Math.round(delta / 86400), "day");
}

function TimeValue({ value }: { value: string | null }): ReactElement {
  if (!value) return <span>Not yet</span>;
  return (
    <time dateTime={value} title={absoluteTime(value)}>
      {relativeTime(value)}
      <span className="sr-only"> ({absoluteTime(value)})</span>
    </time>
  );
}

function safeInputType(requirement: LaunchAgentHomeRequirement): string {
  if (requirement.secret) return "password";
  return requirement.input === "email" || requirement.input === "url" ||
      requirement.input === "tel" || requirement.input === "number"
    ? requirement.input
    : "text";
}

function apiMessage(err: unknown): string {
  return err instanceof Error && err.message
    ? err.message
    : "The Agent home could not be updated.";
}

function isStaleRevision(err: unknown): boolean {
  const code = err instanceof LaunchApiRequestError
    ? err.code?.toLowerCase() ?? null
    : null;
  return err instanceof LaunchApiRequestError &&
    (code === "stale_revision" || code === "revision_conflict" ||
      code === "agent_home_revision_conflict" ||
      err.status === 412 ||
      (err.status === 409 && /revision|changed elsewhere|stale/iu.test(err.message)));
}

function currentHomeFromError(err: unknown): LaunchAgentHomeResponse | null {
  if (!(err instanceof LaunchApiRequestError) || !err.responseBody ||
    typeof err.responseBody !== "object") return null;
  const current = (err.responseBody as { current?: unknown }).current;
  if (!current || typeof current !== "object") return null;
  const candidate = current as Partial<LaunchAgentHomeResponse>;
  return typeof candidate.revision === "string" &&
      typeof candidate.generatedAt === "string" && candidate.agent !== undefined &&
      candidate.state !== undefined
    ? current as LaunchAgentHomeResponse
    : null;
}

function retainActionIdempotencyKey(err: unknown): boolean {
  // A transport failure or server-side/pending outcome may have happened after
  // the action began. Retrying with the same key preserves at-most-once
  // reconciliation behavior. Deterministic client/conflict failures are safe to correct and
  // submit as a new attempt with a fresh revision and key.
  if (!(err instanceof LaunchApiRequestError)) return true;
  if (
    err.responseBody && typeof err.responseBody === "object" &&
    (err.responseBody as { terminal?: unknown }).terminal === true
  ) return false;
  const code = err.code?.toLowerCase() ?? "";
  if (code.includes("pending") || code.includes("in_progress")) return true;
  return err.status >= 500 || err.status === 408 || err.status === 425 ||
    err.status === 429;
}

function recoverableActionFromError(
  err: unknown,
): Omit<LaunchAgentHomeActionRequest, "expectedRevision"> | null {
  if (!(err instanceof LaunchApiRequestError) || !err.responseBody ||
    typeof err.responseBody !== "object") return null;
  const recovery = (err.responseBody as { recovery?: unknown }).recovery;
  if (!recovery || typeof recovery !== "object") return null;
  const candidate = recovery as {
    idempotencyKey?: unknown;
    action?: unknown;
    requestPayload?: unknown;
  };
  if (
    typeof candidate.idempotencyKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
      .test(candidate.idempotencyKey) ||
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

function actionAttemptSignature(input: {
  action: LaunchAgentHomeAction;
  capabilityIds?: string[];
  version?: string;
}): string {
  return JSON.stringify([
    input.action,
    input.capabilityIds ? [...input.capabilityIds].sort() : null,
    input.version ?? null,
  ]);
}

function isAgentHomeSnapshot(value: unknown): value is LaunchAgentHomeResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LaunchAgentHomeResponse>;
  return typeof candidate.revision === "string" &&
    typeof candidate.generatedAt === "string" &&
    Boolean(candidate.agent) && Boolean(candidate.state);
}

export function AgentHomeOverview({
  agentId,
  home,
  loadError,
  reload,
}: AgentHomeOverviewProps): ReactElement {
  const [snapshot, setSnapshot] = useState<LaunchAgentHomeResponse | null>(
    home ?? null,
  );
  const snapshotRef = useRef<LaunchAgentHomeResponse | null>(home ?? null);
  const [identity, setIdentity] = useState(() => identityDraft(home ?? null));
  const [responsibility, setResponsibility] = useState(() =>
    responsibilityDraft(home ?? null)
  );
  const [budget, setBudget] = useState(() => budgetDraft(home?.budget));
  const [settingValues, setSettingValues] = useState<Record<string, string>>({});
  const [removeConfirmation, setRemoveConfirmation] = useState<string | null>(null);
  const [promotionConfirmation, setPromotionConfirmation] = useState(false);
  const [busy, setBusy] = useState<MutationKey | null>(null);
  const [emergencyPausing, setEmergencyPausing] = useState(false);
  const mutationInFlightRef = useRef(false);
  const actionAttemptsRef = useRef(new Map<string, string>());
  const [notice, setNotice] = useState<{
    tone: "success" | "error" | "conflict";
    message: string;
  } | null>(null);
  const [awaitingConflictRefresh, setAwaitingConflictRefresh] = useState(false);

  // Adopt a revalidated snapshot without destroying a draft the owner was
  // already editing. Clean forms track the server; dirty forms remain intact.
  useEffect(() => {
    if (!home) return;
    const previous = snapshotRef.current;
    const keepIdentity = previous ? isIdentityDirty(identity, previous) : false;
    const keepResponsibility = previous
      ? isResponsibilityDirty(responsibility, previous)
      : false;
    const keepBudget = previous ? isBudgetDirty(budget, previous) : false;
    snapshotRef.current = home;
    setSnapshot(home);
    if (!keepIdentity) setIdentity(identityDraft(home));
    if (!keepResponsibility) setResponsibility(responsibilityDraft(home));
    if (!keepBudget) setBudget(budgetDraft(home.budget));
    setAwaitingConflictRefresh(false);
  }, [home?.generatedAt, home?.revision]);

  // Agent Home is an operating surface, not a static settings page. Revalidate
  // quickly while work is queued/running and at a quieter cadence while an
  // Agent is active. Draft preservation above keeps polling from clobbering edits.
  useEffect(() => {
    const current = snapshotRef.current;
    if (!current) return;
    const busyExecution = current.state.execution === "queued" ||
      current.state.execution === "running";
    if (!busyExecution && current.state.lifecycle !== "active") return;
    const refresh = () => {
      if (
        document.visibilityState === "visible" &&
        !mutationInFlightRef.current
      ) reload();
    };
    const timer = window.setInterval(refresh, busyExecution ? 4_000 : 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload, snapshot?.state.execution, snapshot?.state.lifecycle]);

  const applySnapshot = (
    next: LaunchAgentHomeResponse,
    reset: ResetSection | null = null,
    clearedSetting?: string,
  ) => {
    const previous = snapshotRef.current;
    const keepIdentity = previous ? isIdentityDirty(identity, previous) : false;
    const keepResponsibility = previous
      ? isResponsibilityDirty(responsibility, previous)
      : false;
    const keepBudget = previous ? isBudgetDirty(budget, previous) : false;
    snapshotRef.current = next;
    setSnapshot(next);
    if (reset === "identity" || !keepIdentity) setIdentity(identityDraft(next));
    if (reset === "responsibility" || !keepResponsibility) {
      setResponsibility(responsibilityDraft(next));
    }
    if (reset === "budget" || !keepBudget) setBudget(budgetDraft(next.budget));
    if (clearedSetting) {
      setSettingValues((current) => ({ ...current, [clearedSetting]: "" }));
    }
    setRemoveConfirmation(null);
    setPromotionConfirmation(false);
    // Keep the session route cache fresh for a later revisit. The mutation
    // response is already canonical, so this revalidation never blocks paint.
    reload();
  };

  const failMutation = (err: unknown) => {
    if (isStaleRevision(err)) {
      setNotice({
        tone: "conflict",
        message:
          "This Agent changed elsewhere. Refreshing the latest state now; your unsaved fields are preserved for review.",
      });
      const current = currentHomeFromError(err);
      if (current) {
        applySnapshot(current);
      } else {
        setAwaitingConflictRefresh(true);
        reload();
      }
      return;
    }
    setNotice({ tone: "error", message: apiMessage(err) });
  };

  const mutate = async (
    key: MutationKey,
    operation: (revision: string) => Promise<LaunchAgentHomeResponse>,
    options: { reset?: ResetSection; clearedSetting?: string; success: string },
  ) => {
    const current = snapshotRef.current;
    if (!current || mutationInFlightRef.current || awaitingConflictRefresh) return;
    mutationInFlightRef.current = true;
    setBusy(key);
    setNotice(null);
    try {
      const next = await operation(current.revision);
      applySnapshot(next, options.reset ?? null, options.clearedSetting);
      setNotice({ tone: "success", message: options.success });
    } catch (err) {
      failMutation(err);
    } finally {
      mutationInFlightRef.current = false;
      setBusy(null);
    }
  };

  const emergencyPause = async () => {
    if (emergencyPausing) return;
    setEmergencyPausing(true);
    setNotice(null);
    try {
      // The minimal owner-only routine endpoint is intentionally independent
      // of Home aggregation and promotion/action leases. Pausing must remain
      // available during the exact outage or partial repair that made this
      // page unhealthy.
      await launchApi.pauseAgentHome(agentId);
      setNotice({ tone: "success", message: "Agent paused." });
      reload();
    } catch (err) {
      setNotice({
        tone: "error",
        message: `${apiMessage(err)} Retry Pause to confirm the stop request.`,
      });
    } finally {
      setEmergencyPausing(false);
    }
  };

  const groupedAuthority = useMemo(() => {
    const groups = new Map<
      LaunchAgentHomeAuthorityItem["kind"],
      LaunchAgentHomeAuthorityItem[]
    >();
    for (const item of snapshot?.authority.items ?? []) {
      const group = groups.get(item.kind) ?? [];
      group.push(item);
      groups.set(item.kind, group);
    }
    return AUTHORITY_ORDER.flatMap((kind) => {
      const items = groups.get(kind);
      return items?.length ? [{ kind, items }] : [];
    });
  }, [snapshot?.authority.items]);

  if (!snapshot) {
    if (loadError) {
      return (
        <Card className="agent-home-load-state" tone="subtle">
          <div role="alert">
            <p className="section-label">Agent home unavailable</p>
            <p>{loadError}</p>
          </div>
          {notice
            ? (
              <div
                className={`agent-home-notice ${notice.tone}`}
                role={notice.tone === "success" ? "status" : "alert"}
              >
                {notice.message}
              </div>
            )
            : null}
          <div className="agent-home-actions">
            <Button onClick={reload} size="sm" variant="secondary">Retry</Button>
            <Button
              disabled={emergencyPausing}
              onClick={() => void emergencyPause()}
              size="sm"
              variant="secondary"
            >
              {emergencyPausing ? "Pausing…" : "Pause Agent"}
            </Button>
          </div>
        </Card>
      );
    }
    return (
      <div className="agent-home-pending">
        <Card className="agent-home-load-state" tone="subtle">
          <div role="status">
            <p className="section-label">Loading Agent home</p>
            <p>
              Runtime details are still loading. Emergency Pause remains
              available independently.
            </p>
          </div>
          {notice
            ? (
              <div
                className={`agent-home-notice ${notice.tone}`}
                role={notice.tone === "success" ? "status" : "alert"}
              >
                {notice.message}
              </div>
            )
            : null}
          <div className="agent-home-actions">
            <Button
              disabled={emergencyPausing}
              onClick={() => void emergencyPause()}
              size="sm"
              variant="secondary"
            >
              {emergencyPausing ? "Pausing…" : "Pause Agent"}
            </Button>
          </div>
        </Card>
        <div
          className="agent-home-skeleton"
          aria-busy="true"
          aria-label="Loading Agent home"
        >
          {[0, 1, 2, 3].map((key) => (
            <Card key={key} className="agent-home-skeleton-card">
              <span className="sr-only">Loading section</span>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const identityDirty = isIdentityDirty(identity, snapshot);
  const responsibilityDirty = isResponsibilityDirty(responsibility, snapshot);
  const budgetDirty = isBudgetDirty(budget, snapshot);
  const unsavedRoutine = responsibilityDirty || budgetDirty;
  const settings = snapshot.setup.requirements.filter((item) =>
    item.kind === "setting" && item.settingKey
  );
  const candidate = snapshot.release.candidate;
  const mutationDisabled = Boolean(busy) || awaitingConflictRefresh;

  const saveIdentity = () => {
    const name = identity.name.trim();
    if (!name) {
      setNotice({ tone: "error", message: "Agent name cannot be empty." });
      return;
    }
    void mutate(
      "identity",
      (expectedRevision) =>
        launchApi.updateAgentHomeIdentity(agentId, {
          expectedRevision,
          name,
          description: identity.description.trim() || null,
        }),
      { reset: "identity", success: "Identity saved." },
    );
  };

  const saveResponsibility = () => {
    const minutes = Number(responsibility.cadenceMinutes);
    const intervalSeconds = minutes * 60;
    if (!Number.isFinite(minutes) || minutes < 1 || !Number.isSafeInteger(intervalSeconds)) {
      setNotice({
        tone: "error",
        message: "Cadence must be a whole number of seconds and at least one minute.",
      });
      return;
    }
    void mutate(
      "responsibility",
      (expectedRevision) =>
        launchApi.updateAgentHomeRoutine(agentId, {
          expectedRevision,
          mission: responsibility.mission.trim() || null,
          intervalSeconds,
        }),
      { reset: "responsibility", success: "Responsibility saved." },
    );
  };

  const saveBudget = () => {
    const values = {
      maxLightPerRun: Number(budget.perRun),
      maxLightPerDay: Number(budget.daily),
      maxLightPerMonth: Number(budget.monthly),
      maxCallsPerRun: Number(budget.callsPerRun),
    };
    if (
      Object.values(values).some((value) => !Number.isFinite(value)) ||
      values.maxLightPerRun < 0 || values.maxLightPerDay < values.maxLightPerRun ||
      values.maxLightPerMonth < values.maxLightPerDay ||
      !Number.isSafeInteger(values.maxCallsPerRun) || values.maxCallsPerRun < 1
    ) {
      setNotice({
        tone: "error",
        message:
          "Use non-negative ceilings with per-run ≤ daily ≤ monthly and at least one call per run.",
      });
      return;
    }
    void mutate(
      "budget",
      (expectedRevision) =>
        launchApi.updateAgentHomeRoutine(agentId, {
          expectedRevision,
          budgets: values,
        }),
      { reset: "budget", success: "Budget ceilings saved." },
    );
  };

  const updateSetting = (requirement: LaunchAgentHomeRequirement, remove = false) => {
    const key = requirement.settingKey;
    if (!key) return;
    const value = settingValues[key] ?? "";
    if (!remove && value.length === 0) {
      setNotice({ tone: "error", message: `Enter a value for ${requirement.label}.` });
      return;
    }
    void mutate(
      remove ? `remove:${key}` : `setting:${key}`,
      (expectedRevision) =>
        launchApi.updateAgentHomeSettings(agentId, {
          expectedRevision,
          values: { [key]: remove ? null : value },
        }),
      {
        clearedSetting: key,
        success: remove
          ? `${requirement.label} removed.`
          : `${requirement.label} ${requirement.configured ? "replaced" : "connected"}.`,
      },
    );
  };

  const runAction = (
    action: LaunchAgentHomeAction,
    options: { capabilityIds?: string[]; version?: string; success: string },
  ) => {
    if (unsavedRoutine && action !== "promote_candidate") {
      setNotice({
        tone: "error",
        message: "Save mission, cadence, and budget changes before changing runtime state.",
      });
      return;
    }
    const attemptSignature = actionAttemptSignature({ action, ...options });
    const persistedAttemptKey =
      `galactic:agent-home:${agentId}:action:${attemptSignature}`;
    // Keep the UUID after an ambiguous failure so a user retry cannot perform
    // the same owner action twice. Success clears it; a different payload is a
    // distinct attempt and receives its own key.
    const storedKey = window.sessionStorage.getItem(persistedAttemptKey);
    const idempotencyKey = actionAttemptsRef.current.get(attemptSignature) ??
      (storedKey &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
            .test(storedKey)
        ? storedKey
        : null) ??
      crypto.randomUUID();
    actionAttemptsRef.current.set(attemptSignature, idempotencyKey);
    window.sessionStorage.setItem(persistedAttemptKey, idempotencyKey);
    const clearAttempt = () => {
      actionAttemptsRef.current.delete(attemptSignature);
      window.sessionStorage.removeItem(persistedAttemptKey);
    };
    void mutate(
      `action:${action}`,
      async (expectedRevision) => {
        try {
          const next = await launchApi.actOnAgentHome(agentId, {
            action,
            expectedRevision,
            idempotencyKey,
            ...(options.capabilityIds
              ? { capabilityIds: options.capabilityIds }
              : {}),
            ...(options.version ? { version: options.version } : {}),
          });
          if (!isAgentHomeSnapshot(next)) {
            throw new Error(
              "The action is still being reconciled. Retry to check the same request safely.",
            );
          }
          clearAttempt();
          return next;
        } catch (err) {
          const recovery = recoverableActionFromError(err);
          if (recovery) {
            // The original browser session disappeared after starting a
            // durable action. Reissue that exact stored request first; the
            // backend reconciles it under its original key. Only after it is
            // terminal do we submit the owner's current intent at the fresh
            // revision returned by recovery.
            const recoverySignature = actionAttemptSignature(recovery);
            const recoveryStorageKey =
              `galactic:agent-home:${agentId}:action:${recoverySignature}`;
            actionAttemptsRef.current.set(
              recoverySignature,
              recovery.idempotencyKey,
            );
            window.sessionStorage.setItem(
              recoveryStorageKey,
              recovery.idempotencyKey,
            );
            let recoveryCompleted = false;
            try {
              const recovered = await launchApi.actOnAgentHome(agentId, {
                ...recovery,
                expectedRevision,
              });
              recoveryCompleted = true;
              actionAttemptsRef.current.delete(recoverySignature);
              window.sessionStorage.removeItem(recoveryStorageKey);
              const next = await launchApi.actOnAgentHome(agentId, {
                action,
                expectedRevision: recovered.revision,
                idempotencyKey,
                ...(options.capabilityIds
                  ? { capabilityIds: options.capabilityIds }
                  : {}),
                ...(options.version ? { version: options.version } : {}),
              });
              clearAttempt();
              return next;
            } catch (recoveryError) {
              if (!retainActionIdempotencyKey(recoveryError)) {
                actionAttemptsRef.current.delete(recoverySignature);
                window.sessionStorage.removeItem(recoveryStorageKey);
                // Once recovery completed, a deterministic failure belongs to
                // the newly submitted current action. Clear its terminal key
                // so the owner can correct state and make a genuinely new
                // attempt instead of replaying the stored failure forever.
                if (recoveryCompleted) clearAttempt();
              }
              throw recoveryError;
            }
          }
          if (!retainActionIdempotencyKey(err)) {
            clearAttempt();
          }
          throw err;
        }
      },
      { success: options.success },
    );
  };

  return (
    <div className="agent-home-overview" aria-busy={mutationDisabled}>
      <Card className="agent-home-state-card">
        <div className="agent-home-card-head">
          <div>
            <p className="section-label">Agent state</p>
            <div className="agent-home-statuses" aria-label="Agent status">
              <Pill tone={lifecycleTone(snapshot.state.lifecycle)}>
                Lifecycle: {statusLabel(snapshot.state.lifecycle)}
              </Pill>
              <Pill tone={snapshot.state.execution === "running"
                ? "green"
                : snapshot.state.execution === "queued"
                ? "amber"
                : "default"}
              >
                Execution: {snapshot.state.execution}
              </Pill>
              <Pill tone={healthTone(snapshot.state.health)}>
                Health: {snapshot.state.health}
              </Pill>
            </div>
          </div>
          <div className="agent-home-actions" aria-label="Runtime controls">
            {snapshot.actions.canActivate
              ? (
                <Button
                  disabled={mutationDisabled || unsavedRoutine}
                  onClick={() => runAction("activate", { success: "Agent activated." })}
                  size="sm"
                >
                  {busy === "action:activate" ? "Activating…" : "Activate"}
                </Button>
              )
              : null}
            <Button
              disabled={!snapshot.actions.canRunNow || mutationDisabled || unsavedRoutine}
              onClick={() => runAction("run_now", { success: "Run queued." })}
              size="sm"
              variant="secondary"
            >
              {busy === "action:run_now" ? "Queuing…" : "Run now"}
            </Button>
            <Button
              disabled={emergencyPausing}
              onClick={() => void emergencyPause()}
              size="sm"
              variant="secondary"
            >
              {emergencyPausing ? "Pausing…" : "Pause"}
            </Button>
          </div>
        </div>
        <dl className="agent-home-timing">
          <div><dt>Next wake</dt><dd><TimeValue value={snapshot.state.nextRunAt} /></dd></div>
          <div><dt>Last wake</dt><dd><TimeValue value={snapshot.state.lastRunAt} /></dd></div>
          <div><dt>Last success</dt><dd><TimeValue value={snapshot.state.lastSuccessAt} /></dd></div>
          <div><dt>Failures</dt><dd>{snapshot.state.failureCount}</dd></div>
        </dl>
        {snapshot.state.blockers.length > 0
          ? (
            <section className="agent-home-blockers" aria-labelledby="agent-home-blockers-title">
              <h3 id="agent-home-blockers-title">Setup blockers</h3>
              {snapshot.state.blockers.map((blocker) => (
                <div key={`${blocker.code}:${blocker.message}`}>
                  <Mono>{statusLabel(blocker.code)}</Mono>
                  <span>{blocker.message}</span>
                </div>
              ))}
            </section>
          )
          : (
            <p className="agent-home-ready-note">
              {snapshot.setup.ready ? "Setup complete." : "No runtime blocker reported."}
            </p>
          )}
      </Card>

      {notice
        ? (
          <div
            className={`agent-home-notice ${notice.tone}`}
            role={notice.tone === "success" ? "status" : "alert"}
            aria-live={notice.tone === "success" ? "polite" : "assertive"}
          >
            {notice.message}
          </div>
        )
        : null}

      <Card className="agent-home-editor-card">
        <div className="agent-home-card-head">
          <div>
            <p className="section-label">Identity</p>
            <p className="muted-note">The package identity shown to you and your connected agents.</p>
          </div>
          <Pill tone="green">Private · owner only</Pill>
        </div>
        <div className="agent-home-form-grid">
          <label className="agent-home-field">
            <span>Name</span>
            <input
              disabled={!snapshot.actions.canEditIdentity || mutationDisabled}
              onChange={(event) => setIdentity((current) => ({ ...current, name: event.target.value }))}
              value={identity.name}
            />
          </label>
          <label className="agent-home-field agent-home-field-wide">
            <span>Package description</span>
            <textarea
              disabled={!snapshot.actions.canEditIdentity || mutationDisabled}
              onChange={(event) =>
                setIdentity((current) => ({ ...current, description: event.target.value }))}
              rows={3}
              value={identity.description}
            />
          </label>
        </div>
        <div className="agent-home-save-row">
          <Button
            disabled={!identityDirty || !snapshot.actions.canEditIdentity || mutationDisabled}
            onClick={saveIdentity}
            size="sm"
          >
            {busy === "identity" ? "Saving…" : "Save identity"}
          </Button>
        </div>
      </Card>

      <Card className="agent-home-editor-card">
        <div className="agent-home-card-head">
          <div>
            <p className="section-label">Ongoing responsibility</p>
            <p className="muted-note">What this Agent owns, when it wakes, and where it reports.</p>
          </div>
          {snapshot.responsibility.cadence
            ? <Pill>{snapshot.responsibility.cadence.label}</Pill>
            : <Pill tone="amber">No routine proposal</Pill>}
        </div>
        {snapshot.responsibility.cadence
          ? (
            <>
              <label className="agent-home-field">
                <span>Mission</span>
                <textarea
                  disabled={!snapshot.actions.canEditRoutine || mutationDisabled}
                  onChange={(event) =>
                    setResponsibility((current) => ({ ...current, mission: event.target.value }))}
                  rows={4}
                  value={responsibility.mission}
                />
              </label>
              <div className="agent-home-form-grid">
                <label className="agent-home-field">
                  <span>Cadence (minutes)</span>
                  <input
                    disabled={!snapshot.actions.canEditRoutine || mutationDisabled}
                    min="1"
                    onChange={(event) =>
                      setResponsibility((current) => ({
                        ...current,
                        cadenceMinutes: event.target.value,
                      }))}
                    step="1"
                    type="number"
                    value={responsibility.cadenceMinutes}
                  />
                </label>
                <div className="agent-home-readonly-field">
                  <span>Reporting destination</span>
                  <strong>{snapshot.responsibility.reporting.label}</strong>
                  <small>Milestones, anomalies, and pause notices stay in Galactic.</small>
                </div>
              </div>
              <div className="agent-home-save-row">
                <Button
                  disabled={!responsibilityDirty || !snapshot.actions.canEditRoutine || mutationDisabled}
                  onClick={saveResponsibility}
                  size="sm"
                >
                  {busy === "responsibility" ? "Saving…" : "Save responsibility"}
                </Button>
              </div>
            </>
          )
          : (
            <p className="agent-home-empty-copy">
              Ask your connected coding agent to scaffold this private Agent with
              <Mono> gx.download(full_time: true)</Mono>, test it, and upload a paused proposal for review.
            </p>
          )}
      </Card>

      <Card className="agent-home-settings-card">
        <div className="agent-home-card-head">
          <div>
            <p className="section-label">Data sources &amp; secrets</p>
            <p className="muted-note">Values are encrypted, write-only, and never returned to this page.</p>
          </div>
          <Pill tone={settings.some((item) => item.blocking) ? "amber" : "green"}>
            {settings.some((item) => item.blocking) ? "Setup required" : "Ready"}
          </Pill>
        </div>
        {settings.length === 0
          ? <p className="agent-home-empty-copy">This Agent declares no owner-provided data or secrets.</p>
          : (
            <div className="agent-home-setting-list">
              {settings.map((requirement) => {
                const key = requirement.settingKey!;
                const inputId = `agent-home-setting-${requirement.id.replace(/[^a-z0-9_-]/giu, "-")}`;
                const descriptionId = `${inputId}-description`;
                const confirmingRemove = removeConfirmation === key;
                return (
                  <div className="agent-home-setting-row" key={requirement.id}>
                    <div className="agent-home-setting-copy">
                      <label htmlFor={inputId}>
                        {requirement.label}{requirement.required ? " *" : ""}
                      </label>
                      <p id={descriptionId}>
                        {requirement.description || requirement.help ||
                          (requirement.destination
                            ? `Only sent to ${requirement.destination}.`
                            : "Owner-provided runtime setting.")}
                      </p>
                      {requirement.destination
                        ? <small>Only sent to <Mono>{requirement.destination}</Mono>.</small>
                        : null}
                    </div>
                    <div className="agent-home-setting-control">
                      <div className="agent-home-setting-status">
                        <Pill tone={requirement.configured ? "green" : requirement.blocking ? "amber" : "default"}>
                          {requirement.configured ? "Configured" : "Missing"}
                        </Pill>
                        <span>
                          {requirement.settingScope === "agent"
                            ? "Agent-wide"
                            : "This account"}
                        </span>
                        {requirement.secret ? <span>Secret</span> : null}
                      </div>
                      <input
                        aria-describedby={descriptionId}
                        autoComplete={requirement.secret ? "new-password" : "off"}
                        disabled={!snapshot.actions.canManageSettings || mutationDisabled}
                        id={inputId}
                        onChange={(event) =>
                          setSettingValues((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }))}
                        placeholder={requirement.configured
                          ? "Enter a replacement"
                          : requirement.placeholder || "Enter value"}
                        type={safeInputType(requirement)}
                        value={settingValues[key] ?? ""}
                      />
                      <div className="agent-home-setting-actions">
                        {requirement.actions.includes(
                            requirement.configured ? "replace" : "set",
                          )
                          ? (
                            <Button
                              disabled={!snapshot.actions.canManageSettings || mutationDisabled ||
                                (settingValues[key] ?? "").length === 0}
                              onClick={() => updateSetting(requirement)}
                              size="sm"
                            >
                              {busy === `setting:${key}`
                                ? "Saving…"
                                : requirement.configured
                                ? "Replace"
                                : "Connect"}
                            </Button>
                          )
                          : null}
                        {requirement.configured && requirement.actions.includes("remove")
                          ? confirmingRemove
                            ? (
                              <>
                                <Button
                                  disabled={mutationDisabled}
                                  onClick={() => updateSetting(requirement, true)}
                                  size="sm"
                                  variant="secondary"
                                >
                                  {busy === `remove:${key}` ? "Removing…" : "Confirm removal"}
                                </Button>
                                <button
                                  className="agent-home-text-button"
                                  disabled={mutationDisabled}
                                  onClick={() => setRemoveConfirmation(null)}
                                  type="button"
                                >
                                  Cancel
                                </button>
                              </>
                            )
                            : (
                              <button
                                className="agent-home-text-button"
                                disabled={mutationDisabled}
                                onClick={() => setRemoveConfirmation(key)}
                                type="button"
                              >
                                Remove
                              </button>
                            )
                          : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
      </Card>

      <Card className="agent-home-authority-card">
        <div className="agent-home-card-head">
          <div>
            <p className="section-label">Allowed actions</p>
            <p className="muted-note">The complete requested, approved, and effective authority envelope.</p>
          </div>
          <Pill>{snapshot.authority.items.length} items</Pill>
        </div>
        {groupedAuthority.length === 0
          ? <p className="agent-home-empty-copy">This Agent currently requests no runtime authority.</p>
          : (
            <div className="agent-home-authority-groups">
              {groupedAuthority.map(({ kind, items }) => (
                <AuthorityGroup
                  approve={(item) =>
                    runAction("approve_capabilities", {
                      capabilityIds: [item.actionId!],
                      success: `${item.label} approved.`,
                    })}
                  busy={busy}
                  canApprove={snapshot.actions.canApproveCapabilities}
                  disabled={mutationDisabled}
                  items={items}
                  key={kind}
                  kind={kind}
                />
              ))}
            </div>
          )}
      </Card>

      {snapshot.capacity
        ? (
          <Card className="agent-home-budget-card">
            <div className="agent-home-card-head">
              <div>
                <p className="section-label">Shared account capacity</p>
                <p className="muted-note">
                  Every active Agent on this account contributes to the same burst and weekly windows.
                </p>
              </div>
              <Pill tone={snapshot.capacity.state === "waiting"
                ? "amber"
                : snapshot.capacity.state === "low"
                ? "default"
                : "green"}
              >
                {snapshot.capacity.state}
              </Pill>
            </div>
            <div className="agent-home-budget-table-wrap">
              <table className="agent-home-budget-table">
                <caption className="sr-only">Shared account capacity windows</caption>
                <thead><tr><th scope="col">Window</th><th scope="col">State</th><th scope="col">Resets</th></tr></thead>
                <tbody>
                  <tr><th scope="row">Five hours</th><td>{snapshot.capacity.burst.state}</td><td>{absoluteTime(snapshot.capacity.burst.resetsAt)}</td></tr>
                  <tr><th scope="row">Weekly</th><td>{snapshot.capacity.weekly.state}</td><td>{absoluteTime(snapshot.capacity.weekly.resetsAt)}</td></tr>
                </tbody>
              </table>
            </div>
            {snapshot.capacity.state === "waiting"
              ? (
                <p className="muted-note" role="status">
                  This Agent remains active. Its missed wakes are coalesced and resume automatically at {absoluteTime(
                    snapshot.capacity.nextEligibleAt,
                  )}.
                </p>
              )
              : null}
          </Card>
        )
        : null}

      <Card className="agent-home-budget-card">
        <div className="agent-home-card-head">
          <div>
            <p className="section-label">Cost &amp; rate limits</p>
            <p className="muted-note">Hard work ceilings are reserved before execution. Manual runs count too.</p>
          </div>
          <Pill>Work units</Pill>
        </div>
        {snapshot.budget
          ? (
            <>
              <div className="agent-home-budget-table-wrap">
                <table className="agent-home-budget-table">
                  <caption className="sr-only">Agent budget ceilings and current usage</caption>
                  <thead><tr><th scope="col">Window</th><th scope="col">Used</th><th scope="col">Ceiling</th></tr></thead>
                  <tbody>
                    <tr><th scope="row">Last run</th><td>{formatNumber(snapshot.budget.usage.lastRun)} units</td><td>{formatNumber(snapshot.budget.ceilings.perRun)} units</td></tr>
                    <tr><th scope="row" title={`Window starts ${absoluteTime(snapshot.budget.usage.dayStartedAt)}`}>Today (UTC)</th><td>{formatNumber(snapshot.budget.usage.daily)} units</td><td>{formatNumber(snapshot.budget.ceilings.daily)} units</td></tr>
                    <tr><th scope="row" title={`Window starts ${absoluteTime(snapshot.budget.usage.monthStartedAt)}`}>This month (UTC)</th><td>{formatNumber(snapshot.budget.usage.monthly)} units</td><td>{formatNumber(snapshot.budget.ceilings.monthly)} units</td></tr>
                    <tr><th scope="row">Calls / last run</th><td>{formatNumber(snapshot.budget.usage.lastRunCalls)} calls</td><td>{formatNumber(snapshot.budget.ceilings.callsPerRun)} calls</td></tr>
                  </tbody>
                </table>
              </div>
              <div className="agent-home-budget-inputs">
                {([
                  ["perRun", "Work units / run", false],
                  ["daily", "Work units / day", false],
                  ["monthly", "Work units / month", false],
                  ["callsPerRun", "Calls / run", true],
                ] as const).map(([key, label, integer]) => (
                  <label className="agent-home-field" key={key}>
                    <span>{label}</span>
                    <input
                      disabled={!snapshot.actions.canEditRoutine || mutationDisabled}
                      min={integer ? "1" : "0"}
                      onChange={(event) =>
                        setBudget((current) => ({ ...current, [key]: event.target.value }))}
                      step={integer ? "1" : "any"}
                      type="number"
                      value={budget[key]}
                    />
                  </label>
                ))}
              </div>
              <div className="agent-home-save-row">
                <Button
                  disabled={!budgetDirty || !snapshot.actions.canEditRoutine || mutationDisabled}
                  onClick={saveBudget}
                  size="sm"
                >
                  {busy === "budget" ? "Saving…" : "Save ceilings"}
                </Button>
              </div>
            </>
          )
          : <p className="agent-home-empty-copy">Budget controls appear when a routine proposal exists.</p>}
      </Card>

      <Card className="agent-home-release-card">
        <div className="agent-home-card-head">
          <div>
            <p className="section-label">Running code</p>
            <p className="muted-note">The deployed version and latest exact-tested candidate.</p>
          </div>
          {snapshot.release.candidateCount > 1
            ? <Pill>{snapshot.release.candidateCount} staged</Pill>
            : null}
        </div>
        <div className="agent-home-release-grid">
          <section aria-labelledby="agent-home-live-release">
            <h3 id="agent-home-live-release">Live</h3>
            {snapshot.release.live
              ? (
                <ReleaseVersion
                  executedVersion={snapshot.release.live.executedVersion}
                  fingerprint={snapshot.release.live.sourceFingerprint}
                  integrity={snapshot.release.live.integrity}
                  label={snapshot.release.live.version}
                  timestamp={snapshot.release.live.promotedAt || snapshot.release.live.uploadedAt}
                  timestampLabel="Promoted"
                  versionLabel="Declared version"
                />
              )
              : <p className="agent-home-empty-copy">No live version.</p>}
          </section>
          <section aria-labelledby="agent-home-candidate-release">
            <h3 id="agent-home-candidate-release">Latest candidate</h3>
            {candidate
              ? (
                <>
                  <ReleaseVersion
                    fingerprint={candidate.sourceFingerprint}
                    label={candidate.version}
                    timestamp={candidate.testedAt || candidate.uploadedAt}
                    timestampLabel={candidate.testedAt ? "Tested" : "Uploaded"}
                    versionLabel="Candidate version"
                  />
                  <Pill tone={candidate.reviewStatus === "ready"
                    ? "green"
                    : candidate.reviewStatus === "owner_review_required"
                    ? "amber"
                    : "red"}
                  >
                    {statusLabel(candidate.reviewStatus)}
                  </Pill>
                  {candidate.authorityChanges.length > 0
                    ? (
                      <ul className="agent-home-release-changes">
                        {candidate.authorityChanges.map((change) => (
                          <li key={`${change.change}:${change.path}`}>
                            <Pill tone={change.change === "added"
                              ? "amber"
                              : change.change === "removed"
                              ? "green"
                              : "default"}
                            >
                              {change.change}
                            </Pill>
                            <span>{change.label}</span>
                          </li>
                        ))}
                      </ul>
                    )
                    : <p className="muted-note">No authority change from live.</p>}
                  {promotionConfirmation
                    ? (
                      <div className="agent-home-promotion-confirm" role="group" aria-label="Confirm promotion">
                        <p>Promote this exact tested version and make it live?</p>
                        <div>
                          <Button
                            disabled={!candidate.canPromote || !snapshot.actions.canPromoteCandidate || mutationDisabled}
                            onClick={() =>
                              runAction("promote_candidate", {
                                version: candidate.version,
                                success: `Version ${candidate.version} promoted.`,
                              })}
                            size="sm"
                          >
                            {busy === "action:promote_candidate" ? "Promoting…" : "Confirm promotion"}
                          </Button>
                          <button
                            className="agent-home-text-button"
                            disabled={mutationDisabled}
                            onClick={() => setPromotionConfirmation(false)}
                            type="button"
                          >Cancel</button>
                        </div>
                      </div>
                    )
                    : (
                      <Button
                        disabled={!candidate.canPromote || !snapshot.actions.canPromoteCandidate || mutationDisabled}
                        onClick={() => setPromotionConfirmation(true)}
                        size="sm"
                        variant="secondary"
                      >
                        {candidate.reviewStatus === "owner_review_required"
                          ? "Review & promote"
                          : "Promote update"}
                      </Button>
                    )}
                </>
              )
              : <p className="agent-home-empty-copy">No staged candidate.</p>}
          </section>
        </div>
      </Card>

      <Card className="agent-home-runs-card">
        <div className="agent-home-card-head">
          <div>
            <p className="section-label">Recent runs</p>
            <p className="muted-note">The latest five wakes, including manual runs.</p>
          </div>
        </div>
        {snapshot.recentRuns.length === 0
          ? <p className="agent-home-empty-copy">No wakes have been recorded yet.</p>
          : (
            <div className="agent-home-run-list">
              {snapshot.recentRuns.slice(0, 5).map((run) => (
                <article className="agent-home-run-row" key={run.id}>
                  <div className="agent-home-run-state">
                    <Pill tone={runTone(run.status)}>{run.status}</Pill>
                    <TimeValue value={run.startedAt || run.createdAt} />
                  </div>
                  <div className="agent-home-run-summary">
                    <strong>{run.summary || (run.errorCode
                      ? statusLabel(run.errorCode)
                      : `${statusLabel(run.trigger)} run`)}</strong>
                    <span>{statusLabel(run.trigger)} · {formatDuration(run.durationMs)}</span>
                  </div>
                  <div className="agent-home-run-usage">
                    <Mono>{formatNumber(run.workUnits)} work units</Mono>
                    <Mono>{formatNumber(run.calls)} calls</Mono>
                  </div>
                </article>
              ))}
            </div>
          )}
      </Card>
    </div>
  );
}

function AuthorityGroup({
  approve,
  busy,
  canApprove,
  disabled,
  items,
  kind,
}: {
  approve: (item: LaunchAgentHomeAuthorityItem) => void;
  busy: MutationKey | null;
  canApprove: boolean;
  disabled: boolean;
  items: LaunchAgentHomeAuthorityItem[];
  kind: LaunchAgentHomeAuthorityItem["kind"];
}): ReactElement {
  const [open, setOpen] = useState(
    items.some((item) => !item.approved || !item.effective),
  );
  return (
    <details
      className="agent-home-authority-group"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary>
        <span>{AUTHORITY_LABELS[kind]}</span>
        <Mono>{items.length}</Mono>
      </summary>
      <div className="agent-home-authority-list">
        {items.map((item) => (
          <div className="agent-home-authority-row" key={item.id}>
            <div>
              <strong>{item.label}</strong>
              {item.target ? <Mono>{item.target}</Mono> : null}
              {item.purpose ? <p>{item.purpose}</p> : null}
            </div>
            <div className="agent-home-authority-state">
              {item.badges.map((badge) => (
                <span className={`function-badge ${badge.toLowerCase()}`} key={badge}>
                  {badge}
                </span>
              ))}
              <Pill tone={item.requested ? "default" : "amber"}>
                {item.requested ? "Requested" : "Not requested"}
              </Pill>
              <Pill tone={item.approved ? "green" : "amber"}>
                {item.approved ? "Approved" : "Pending"}
              </Pill>
              <Pill tone={item.effective ? "green" : "default"}>
                {item.effective ? "Effective" : "Inactive"}
              </Pill>
              <Mono>Basis: {statusLabel(item.approvalBasis)}</Mono>
              {item.source === "routine" && item.actionId && !item.approved
                ? (
                  <Button
                    disabled={!canApprove || disabled}
                    onClick={() => approve(item)}
                    size="sm"
                    variant="secondary"
                  >
                    {busy === "action:approve_capabilities" ? "Approving…" : "Approve"}
                  </Button>
                )
                : null}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function ReleaseVersion({
  executedVersion,
  fingerprint,
  integrity,
  label,
  timestamp,
  timestampLabel,
  versionLabel,
}: {
  executedVersion?: string | null;
  fingerprint: string | null;
  integrity?: "verified" | "unverified" | "unknown";
  label: string;
  timestamp: string | null;
  timestampLabel: string;
  versionLabel: string;
}): ReactElement {
  const clipped = fingerprint && fingerprint.length > 16
    ? `${fingerprint.slice(0, 12)}…${fingerprint.slice(-4)}`
    : fingerprint;
  return (
    <>
      <dl className="agent-home-release-version">
        <div><dt>{versionLabel}</dt><dd><Mono>{label}</Mono></dd></div>
        {executedVersion !== undefined
          ? (
            <div>
              <dt>Executing version</dt>
              <dd><Mono>{executedVersion || "Unavailable"}</Mono></dd>
            </div>
          )
          : null}
        <div>
          <dt>Source</dt>
          <dd title={fingerprint || undefined}><Mono>{clipped || "Unavailable"}</Mono></dd>
        </div>
        <div><dt>{timestampLabel}</dt><dd><TimeValue value={timestamp} /></dd></div>
      </dl>
      {integrity
        ? (
          <div className={`agent-home-integrity ${integrity}`}>
            <Pill tone={integrity === "verified"
              ? "green"
              : integrity === "unverified"
              ? "red"
              : "amber"}
            >
              Runtime integrity: {integrity}
            </Pill>
            {integrity === "unverified"
              ? <span role="alert">Execution is blocked until the deployed bytes match their attestation.</span>
              : integrity === "unknown"
              ? <span>Execution remains blocked until runtime integrity can be verified.</span>
              : null}
          </div>
        )
        : null}
    </>
  );
}
