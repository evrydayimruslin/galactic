import {
  type FormEvent,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  LaunchAgentManagedRoutineActionRequest,
  LaunchAgentManagedRoutineUpdateRequest,
  LaunchAgentRoutineAction,
  LaunchAgentRoutineOverview,
  LaunchAgentRoutinesResponse,
} from "../../../../../shared/contracts/launch.ts";
import { launchApi } from "../../lib/api";
import {
  clearStudioActionKey,
  getOrCreateStudioActionKey,
  retainIdempotencyKeyAfterFailure,
} from "../../lib/agent-studio-state";
import { StudioPageHeader } from "./agent-studio-overview";

import "./agent-studio-routines.css";

export interface AgentStudioRoutineStarter {
  description: string;
  name: string;
}

export interface AgentStudioRoutinesClient {
  actOnAgentManagedRoutine: typeof launchApi.actOnAgentManagedRoutine;
  agentRoutines: typeof launchApi.agentRoutines;
  updateAgentManagedRoutine: typeof launchApi.updateAgentManagedRoutine;
}

export interface AgentStudioRoutinesProps {
  agentIdOrSlug: string;
  agentName: string;
  client?: AgentStudioRoutinesClient;
  error?: string;
  itemId?: string | null;
  onAddRoutine: (starter?: AgentStudioRoutineStarter) => void;
  onChanged?: (response: LaunchAgentRoutinesResponse) => void;
  onOpenRoutine: (routineId: string | null) => void;
  routines?: LaunchAgentRoutinesResponse;
}

const ROUTINE_STARTERS: readonly AgentStudioRoutineStarter[] = [
  {
    name: "Check for new work every 15 minutes",
    description:
      "Wake every 15 minutes during business hours, inspect what is new, and prepare the actions that are safe to take.",
  },
  {
    name: "Send me a daily digest",
    description:
      "At 6pm each day, summarize what was handled, what changed, and anything that still needs me.",
  },
];

type RoutineAction = Extract<
  LaunchAgentRoutineAction,
  "activate" | "pause" | "run_now"
>;

export interface AgentStudioRoutineDraft {
  description: string;
  expression: string;
  intervalMinutes: string;
  kind: "cron" | "interval";
  mission: string;
  name: string;
  timezone: string;
}

function defaultRoutinesClient(): AgentStudioRoutinesClient {
  return {
    actOnAgentManagedRoutine:
      launchApi.actOnAgentManagedRoutine.bind(launchApi),
    agentRoutines: launchApi.agentRoutines.bind(launchApi),
    updateAgentManagedRoutine:
      launchApi.updateAgentManagedRoutine.bind(launchApi),
  };
}

export function routineActionRequest(
  expectedRevision: string,
  action: RoutineAction,
  idempotencyKey: string,
): LaunchAgentManagedRoutineActionRequest {
  return { action, expectedRevision, idempotencyKey };
}

export function routineUpdateRequest(
  expectedRevision: string,
  draft: AgentStudioRoutineDraft,
): LaunchAgentManagedRoutineUpdateRequest {
  const requestedMinutes = Number(draft.intervalMinutes);
  const intervalSeconds = Number.isFinite(requestedMinutes)
    ? Math.max(60, Math.round(requestedMinutes * 60))
    : 60;
  return {
    description: draft.description.trim() || null,
    expectedRevision,
    mission: draft.mission.trim() || null,
    name: draft.name.trim(),
    schedule: draft.kind === "interval"
      ? {
        intervalSeconds,
        kind: "interval",
      }
      : {
        expression: draft.expression.trim(),
        kind: "cron",
        timezone: draft.timezone.trim() || "UTC",
      },
  };
}

export function AgentStudioRoutines({
  agentIdOrSlug,
  agentName,
  client,
  error: loadError = "",
  itemId,
  onAddRoutine,
  onChanged,
  onOpenRoutine,
  routines,
}: AgentStudioRoutinesProps): ReactElement {
  const api = useMemo(() => client ?? defaultRoutinesClient(), [client]);
  const [current, setCurrent] = useState(routines);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const agentGeneration = useRef(0);
  const actionIdempotencyKeys = useRef(new Map<string, string>());

  useEffect(() => {
    agentGeneration.current += 1;
    setCurrent(routines);
    setBusyId(null);
    setError("");
    return () => {
      agentGeneration.current += 1;
    };
  }, [agentIdOrSlug, routines]);

  const refresh = async (
    generation: number,
  ): Promise<LaunchAgentRoutinesResponse | null> => {
    const next = await api.agentRoutines(agentIdOrSlug);
    if (generation !== agentGeneration.current) return null;
    setCurrent(next);
    onChanged?.(next);
    return next;
  };

  const act = async (
    routine: LaunchAgentRoutineOverview,
    action: RoutineAction,
  ) => {
    if (!current || busyId) return;
    const generation = agentGeneration.current;
    const revision = current.revision;
    const attemptKey = `${agentIdOrSlug}:routine:${routine.id}:${action}`;
    const idempotencyKey = getOrCreateStudioActionKey(
      attemptKey,
      actionIdempotencyKeys.current,
    );
    setBusyId(routine.id);
    setError("");
    try {
      await api.actOnAgentManagedRoutine(
        agentIdOrSlug,
        routine.id,
        routineActionRequest(revision, action, idempotencyKey),
      );
      await refresh(generation);
      clearStudioActionKey(attemptKey, actionIdempotencyKeys.current);
    } catch (reason) {
      if (generation === agentGeneration.current) {
        if (!retainIdempotencyKeyAfterFailure(reason)) {
          clearStudioActionKey(attemptKey, actionIdempotencyKeys.current);
        }
        setError(errorMessage(reason));
      }
    } finally {
      if (generation === agentGeneration.current) setBusyId(null);
    }
  };

  const save = async (
    routine: LaunchAgentRoutineOverview,
    draft: AgentStudioRoutineDraft,
  ): Promise<boolean> => {
    if (!current || busyId) return false;
    const generation = agentGeneration.current;
    const revision = current.revision;
    setBusyId(routine.id);
    setError("");
    try {
      await api.updateAgentManagedRoutine(
        agentIdOrSlug,
        routine.id,
        routineUpdateRequest(revision, draft),
      );
      return Boolean(await refresh(generation));
    } catch (reason) {
      if (generation === agentGeneration.current) {
        setError(errorMessage(reason));
      }
      return false;
    } finally {
      if (generation === agentGeneration.current) setBusyId(null);
    }
  };

  const selected = current?.routines.find((routine) =>
    routine.id === itemId
  ) ?? null;
  const staleItem = Boolean(current && itemId && !selected);

  return (
    <section className="agent-studio-screen agent-studio-routines">
      <StudioPageHeader
        description={`When ${agentName} wakes up on its own. Without a routine it only acts when something calls it.`}
        title="Routines"
      />

      <button
        className="agent-studio-routine-add"
        disabled={Boolean(busyId)}
        onClick={() => onAddRoutine()}
        type="button"
      >
        + Add routine
      </button>

      {error || loadError
        ? (
          <p className="agent-studio-routine-error" role="alert">
            {error || loadError}
          </p>
        )
        : null}

      {!current && !loadError
        ? (
          <div className="agent-studio-routine-loading" role="status">
            Loading routines…
          </div>
        )
        : null}

      {current?.routines.length
        ? (
          <div className="agent-studio-routine-list">
            {current.routines.map((routine) => (
              <RoutineCard
                busy={busyId === routine.id}
                editing={selected?.id === routine.id}
                key={`${routine.id}:${current.revision}`}
                locked={Boolean(busyId)}
                onAction={(action) => void act(routine, action)}
                onClose={() => onOpenRoutine(null)}
                onEdit={() => onOpenRoutine(routine.id)}
                onSave={(draft) => save(routine, draft)}
                routine={routine}
              />
            ))}
          </div>
        )
        : null}

      {current?.routines.length === 0
        ? (
          <RoutineEmptyState
            agentName={agentName}
            onChoose={onAddRoutine}
          />
        )
        : null}

      {staleItem
        ? (
          <div className="agent-studio-routine-stale" role="status">
            <p>This routine is no longer published by the live Agent.</p>
            <button onClick={() => onOpenRoutine(null)} type="button">
              Return to Routines
            </button>
          </div>
        )
        : null}

      <p className="agent-studio-routine-contract">
        Adding a routine changes the Agent release. Galactic will hand the
        request to your coding agent; existing routines can be scheduled,
        paused, and run here.
      </p>
    </section>
  );
}

function RoutineCard({
  busy,
  editing,
  locked,
  onAction,
  onClose,
  onEdit,
  onSave,
  routine,
}: {
  busy: boolean;
  editing: boolean;
  locked: boolean;
  onAction: (action: RoutineAction) => void;
  onClose: () => void;
  onEdit: () => void;
  onSave: (draft: AgentStudioRoutineDraft) => Promise<boolean>;
  routine: LaunchAgentRoutineOverview;
}): ReactElement {
  const active = routine.status === "active";
  const canToggle = active
    ? routine.actions.canPause
    : routine.actions.canActivate;
  const toggleAction: RoutineAction = active ? "pause" : "activate";

  return (
    <article
      aria-busy={busy || undefined}
      className={`agent-studio-routine-card${
        active ? "" : " inactive"
      }${routine.health === "error" ? " failing" : ""}`}
      data-routine-id={routine.id}
    >
      <header>
        <div>
          <div className="agent-studio-routine-title">
            <strong>{routine.name}</strong>
            {routine.role === "primary" ? <span>Primary</span> : null}
          </div>
          <p>{routine.schedule.label}</p>
        </div>
        <button
          aria-label={`${active ? "Pause" : "Activate"} ${routine.name}`}
          aria-pressed={active}
          className={`agent-studio-routine-switch${active ? " on" : ""}`}
          disabled={locked || !canToggle}
          onClick={() => onAction(toggleAction)}
          title={canToggle
            ? `${active ? "Pause" : "Activate"} routine`
            : "This release does not permit that action"}
          type="button"
        >
          <span />
        </button>
      </header>
      {routine.description ? <p className="description">{routine.description}</p> : null}
      {routine.errorReason || routine.autoPauseReason
        ? (
          <p className="agent-studio-routine-warning">
            {routine.errorReason ?? routine.autoPauseReason}
          </p>
        )
        : null}
      {routine.blockers.length
        ? (
          <ul
            aria-label={`${routine.name} blockers`}
            className="agent-studio-routine-blockers"
          >
            {routine.blockers.map((blocker) => (
              <li key={`${blocker.code}:${blocker.message}`}>
                <strong>{blocker.code.replaceAll("_", " ")}</strong>
                <span>{blocker.message}</span>
              </li>
            ))}
          </ul>
        )
        : null}
      <div className="agent-studio-routine-details">
        <div>
          <span>Next</span>
          <strong className={active ? "" : "muted"}>
            {active
              ? routine.nextRunAt
                ? formatRelativeFuture(routine.nextRunAt)
                : "Waiting for its next event"
              : routine.status}
          </strong>
        </div>
        <div>
          <span>Last</span>
          <strong>
            {routine.lastRunAt
              ? formatRelativePast(routine.lastRunAt)
              : "Never run"}
          </strong>
        </div>
        <div className="calls">
          <span>Calls</span>
          <div>
            {routine.capabilities.length
              ? routine.capabilities.map((capability) => (
                <code key={capability.id}>{capability.functionName}</code>
              ))
              : <em>No declared calls</em>}
          </div>
        </div>
        <div className="actions">
          <button disabled={locked} onClick={onEdit} type="button">
            Edit
          </button>
          <button
            disabled={locked || !routine.actions.canRunNow}
            onClick={() => onAction("run_now")}
            type="button"
          >
            {busy ? "Working…" : "Run now"}
          </button>
        </div>
      </div>
      {editing
        ? (
          <RoutineEditor
            busy={locked}
            onClose={onClose}
            onSave={onSave}
            routine={routine}
          />
        )
        : null}
    </article>
  );
}

function RoutineEditor({
  busy,
  onClose,
  onSave,
  routine,
}: {
  busy: boolean;
  onClose: () => void;
  onSave: (draft: AgentStudioRoutineDraft) => Promise<boolean>;
  routine: LaunchAgentRoutineOverview;
}): ReactElement {
  const [draft, setDraft] = useState<AgentStudioRoutineDraft>(() => ({
    description: routine.description ?? "",
    expression: routine.schedule.kind === "cron"
      ? routine.schedule.expression
      : "0 9 * * 1-5",
    intervalMinutes: routine.schedule.kind === "interval"
      ? String(routine.schedule.intervalSeconds / 60)
      : "15",
    kind: routine.schedule.kind,
    mission: routine.mission,
    name: routine.name,
    timezone: routine.schedule.kind === "cron"
      ? routine.schedule.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  }));
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim() || submitting || busy) return;
    setSubmitting(true);
    const saved = await onSave(draft);
    setSubmitting(false);
    if (saved) onClose();
  };

  return (
    <form
      aria-label={`Edit ${routine.name}`}
      className="agent-studio-routine-editor"
      onSubmit={(event) => void submit(event)}
    >
      <div className="agent-studio-routine-editor-grid">
        <label>
          <span>Name</span>
          <input
            onChange={(event) =>
              setDraft((value) => ({
                ...value,
                name: event.currentTarget.value,
              }))}
            required
            value={draft.name}
          />
        </label>
        <label>
          <span>Description</span>
          <input
            onChange={(event) =>
              setDraft((value) => ({
                ...value,
                description: event.currentTarget.value,
              }))}
            value={draft.description}
          />
        </label>
        <label className="wide">
          <span>Mission</span>
          <textarea
            onChange={(event) =>
              setDraft((value) => ({
                ...value,
                mission: event.currentTarget.value,
              }))}
            rows={3}
            value={draft.mission}
          />
        </label>
        <label>
          <span>Schedule type</span>
          <select
            onChange={(event) =>
              setDraft((value) => ({
                ...value,
                kind: event.currentTarget
                  .value as AgentStudioRoutineDraft["kind"],
              }))}
            value={draft.kind}
          >
            <option value="interval">Interval</option>
            <option value="cron">Cron</option>
          </select>
        </label>
        {draft.kind === "interval"
          ? (
            <label>
              <span>Every (minutes)</span>
              <input
                min="1"
                onChange={(event) =>
                  setDraft((value) => ({
                    ...value,
                    intervalMinutes: event.currentTarget.value,
                  }))}
                required
                type="number"
                value={draft.intervalMinutes}
              />
            </label>
          )
          : (
            <>
              <label>
                <span>Five-field cron</span>
                <input
                  className="mono"
                  onChange={(event) =>
                    setDraft((value) => ({
                      ...value,
                      expression: event.currentTarget.value,
                    }))}
                  required
                  value={draft.expression}
                />
              </label>
              <label>
                <span>IANA timezone</span>
                <input
                  className="mono"
                  onChange={(event) =>
                    setDraft((value) => ({
                      ...value,
                      timezone: event.currentTarget.value,
                    }))}
                  required
                  value={draft.timezone}
                />
              </label>
            </>
          )}
      </div>
      <p>
        {routine.nextOccurrences.length
          ? `Current next runs: ${
            routine.nextOccurrences.map((item) =>
              new Date(item).toLocaleString()
            ).join(" · ")
          }`
          : "Galactic computes the next occurrences after save."}
      </p>
      <div className="agent-studio-routine-editor-actions">
        <button disabled={busy || submitting} onClick={onClose} type="button">
          Cancel
        </button>
        <button
          disabled={busy || submitting || !draft.name.trim()}
          type="submit"
        >
          {busy || submitting ? "Saving…" : "Save routine"}
        </button>
      </div>
    </form>
  );
}

function RoutineEmptyState({
  agentName,
  onChoose,
}: {
  agentName: string;
  onChoose: (starter?: AgentStudioRoutineStarter) => void;
}): ReactElement {
  return (
    <div className="agent-studio-routine-empty">
      <section>
        <strong>No routines yet.</strong>
        <p>
          Most Agents start with one of these. Pick one to describe it to your
          coding agent, or write your own.
        </p>
      </section>
      <div>
        {ROUTINE_STARTERS.map((starter) => (
          <button
            key={starter.name}
            onClick={() =>
              onChoose({
                ...starter,
                description: starter.description.replace(
                  "the Agent",
                  agentName,
                ),
              })}
            type="button"
          >
            <strong>{starter.name}</strong>
            <span>{starter.description}</span>
            <em>Use this →</em>
          </button>
        ))}
      </div>
    </div>
  );
}

function formatRelativePast(iso: string): string {
  const distance = timeDistance(iso);
  return distance === "now" ? "Just now" : `${distance} ago`;
}

function formatRelativeFuture(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return "Scheduled";
  if (timestamp <= Date.now()) return "Due now";
  return `in ${timeDistance(iso, timestamp - Date.now())}`;
}

function timeDistance(
  iso: string,
  knownDistance?: number,
): string {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(
    0,
    Math.round((knownDistance ?? Date.now() - timestamp) / 1000),
  );
  if (seconds < 30) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
