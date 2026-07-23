import type {
  LaunchAgentDirective,
  LaunchAgentEvidenceReference,
  LaunchAgentOperatingSummary,
  LaunchAgentRoutineOverview,
  LaunchAgentWorkingReadiness,
} from "../../shared/contracts/launch.ts";

export interface AgentOperatingStateInput {
  now: Date;
  hasLiveRelease: boolean;
  setupReady: boolean;
  routines: readonly LaunchAgentRoutineOverview[];
  capacityWaiting?: boolean;
  eventSubscriptionActive?: boolean;
}

export interface AgentDirectiveInput {
  routines: readonly LaunchAgentRoutineOverview[];
  reportingConfigured: boolean;
}

function orderedRoutines(
  routines: readonly LaunchAgentRoutineOverview[],
): LaunchAgentRoutineOverview[] {
  return [...routines].sort((left, right) => {
    if (left.role !== right.role) return left.role === "primary" ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

function isFailing(routine: LaunchAgentRoutineOverview): boolean {
  return routine.status === "error" || routine.health === "error";
}

function isBlocked(routine: LaunchAgentRoutineOverview): boolean {
  return routine.health === "needs_approval" || routine.blockers.length > 0;
}

function isHealthyActive(routine: LaunchAgentRoutineOverview): boolean {
  return routine.status === "active" &&
    (routine.health === "active" || routine.health === "running") &&
    !isBlocked(routine);
}

function latestActivityAt(
  routines: readonly LaunchAgentRoutineOverview[],
): string | null {
  const candidates = routines.flatMap((routine) => [
    routine.lastRunAt,
    ...routine.recentRuns.flatMap((run) => [
      run.completedAt,
      run.startedAt,
      run.createdAt,
    ]),
  ]).filter((value): value is string =>
    typeof value === "string" && Number.isFinite(Date.parse(value))
  );
  return candidates.sort((left, right) =>
    Date.parse(right) - Date.parse(left)
  )[0] || null;
}

function earliestNextRun(
  routines: readonly LaunchAgentRoutineOverview[],
): LaunchAgentRoutineOverview | null {
  return routines.filter((routine) =>
    isHealthyActive(routine) && routine.nextRunAt &&
    Number.isFinite(Date.parse(routine.nextRunAt))
  ).sort((left, right) =>
    Date.parse(left.nextRunAt!) - Date.parse(right.nextRunAt!) ||
    left.id.localeCompare(right.id)
  )[0] || null;
}

export function deriveAgentWorkingReadiness(
  input: Pick<
    AgentOperatingStateInput,
    "hasLiveRelease" | "setupReady" | "routines"
  >,
): LaunchAgentWorkingReadiness {
  const routines = orderedRoutines(input.routines);
  const active = routines.filter((routine) => routine.status === "active");
  const healthyActive = routines.filter(isHealthyActive);
  const failing = routines.some(isFailing);
  const blocked = routines.some(isBlocked);
  let exclusionReason: LaunchAgentWorkingReadiness["exclusionReason"] = null;

  if (!input.hasLiveRelease) exclusionReason = "no_live_release";
  else if (routines.length === 0) exclusionReason = "no_enabled_routine";
  else if (!input.setupReady || blocked) exclusionReason = "setup_required";
  else if (failing) exclusionReason = "error";
  else if (healthyActive.length > 0) exclusionReason = null;
  else if (routines.some((routine) => routine.status === "paused")) {
    exclusionReason = "paused";
  } else if (routines.every((routine) => routine.status === "disabled")) {
    exclusionReason = "disabled";
  } else exclusionReason = "disabled";

  return {
    working: exclusionReason === null,
    ready: exclusionReason === null,
    exclusionReason,
    activeRoutineCount: active.length,
    totalRoutineCount: routines.length,
  };
}

export function buildAgentDirective(
  input: AgentDirectiveInput,
): LaunchAgentDirective {
  const routines = orderedRoutines(input.routines);
  const primary = routines.find((routine) => routine.role === "primary") ||
    routines[0] || null;
  return {
    mission: primary?.mission || "",
    source: primary?.role === "primary"
      ? "primary_routine"
      : "managed_routines",
    sourceRoutineId: primary?.id || null,
    cadence: primary?.schedule || null,
    reporting: {
      kind: "galactic_inbox",
      label: "Galactic inbox",
      configured: input.reportingConfigured,
    },
  };
}

export function buildAgentOperatingSummary(
  input: AgentOperatingStateInput,
): LaunchAgentOperatingSummary {
  const routines = orderedRoutines(input.routines);
  const readiness = deriveAgentWorkingReadiness(input);
  const failing = routines.find(isFailing) || null;
  const blocked = routines.find(isBlocked) || null;
  const currentRun =
    routines.flatMap((routine) =>
      routine.recentRuns.map((run) => ({ routine, run }))
    ).filter((
      { run },
    ) => run.status === "running" || run.status === "queued")
      .sort((left, right) =>
        Date.parse(right.run.startedAt || right.run.createdAt) -
        Date.parse(left.run.startedAt || left.run.createdAt)
      )[0] || null;
  const running =
    routines.find((routine) =>
      isHealthyActive(routine) && routine.health === "running"
    ) || null;
  const scheduled = earliestNextRun(routines);
  const active = routines.find(isHealthyActive) || null;
  const paused = routines.find((routine) => routine.status === "paused") ||
    null;
  const disabled = routines.find((routine) => routine.status === "disabled") ||
    null;

  let mode: LaunchAgentOperatingSummary["mode"];
  let label: string;
  let detail: string | null = null;
  let basis: LaunchAgentRoutineOverview | null = null;

  if (!input.hasLiveRelease) {
    mode = "no_live_release";
    label = "Release required";
    detail = "Promote a verified release before this Agent works.";
  } else if (routines.length === 0) {
    mode = "no_enabled_routine";
    label = "Setup required";
    detail = "Configure a managed routine before this Agent works.";
  } else if (!input.setupReady) {
    mode = "setup_required";
    label = "Setup required";
    detail =
      "Complete the blocking setup requirements before this Agent works.";
  } else if (failing) {
    mode = "error";
    label = "Needs attention";
    detail = failing.errorReason || failing.autoPauseReason ||
      failing.blockers[0]?.message || null;
    basis = failing;
  } else if (blocked) {
    mode = "setup_required";
    label = "Setup required";
    detail = blocked.blockers[0]?.message ||
      (blocked.health === "needs_approval"
        ? "Owner approval is required before this routine can work."
        : null);
    basis = blocked;
  } else if (currentRun?.run.status === "running" || running) {
    mode = "running";
    label = "Working now";
    detail = currentRun?.routine.mission || running?.mission || null;
    basis = currentRun?.routine || running;
  } else if (currentRun?.run.status === "queued") {
    mode = "queued";
    label = "Queued";
    detail = currentRun.routine.mission || null;
    basis = currentRun.routine;
  } else if (input.capacityWaiting) {
    mode = "capacity_waiting";
    label = "Waiting for capacity";
    basis = active || scheduled;
  } else if (scheduled) {
    mode = "scheduled";
    label = "Watching on schedule";
    detail = scheduled.mission || null;
    basis = scheduled;
  } else if (input.eventSubscriptionActive && active) {
    mode = "event_waiting";
    label = "Waiting for an event";
    detail = active.mission || null;
    basis = active;
  } else if (active) {
    mode = "standing_by";
    label = "Standing by";
    detail = active.mission || null;
    basis = active;
  } else if (paused) {
    mode = "paused";
    label = "Paused";
    detail = paused.autoPauseReason || paused.errorReason || null;
    basis = paused;
  } else {
    mode = "disabled";
    label = routines.length === 0 ? "No routine configured" : "Disabled";
    basis = disabled;
  }

  const evidence: LaunchAgentEvidenceReference[] = [];
  if (currentRun) {
    evidence.push({
      kind: "run",
      sourceId: currentRun.run.id,
      label: `${currentRun.routine.name} run`,
      observedAt: currentRun.run.startedAt || currentRun.run.createdAt,
      destination: {
        href: `?pane=routines&item=${
          encodeURIComponent(currentRun.routine.id)
        }&run=${encodeURIComponent(currentRun.run.id)}`,
        pane: "routines",
        itemId: currentRun.routine.id,
      },
    });
  }
  if (basis) {
    evidence.push({
      kind: "routine",
      sourceId: basis.id,
      label: basis.name,
      observedAt: basis.lastRunAt,
      destination: {
        href: `?pane=routines&item=${encodeURIComponent(basis.id)}`,
        pane: "routines",
        itemId: basis.id,
      },
    });
    if (basis.nextRunAt) {
      evidence.push({
        kind: "schedule",
        sourceId: `${basis.id}:${basis.nextRunAt}`,
        label: basis.schedule.label,
        observedAt: basis.nextRunAt,
        destination: {
          href: `?pane=routines&item=${encodeURIComponent(basis.id)}`,
          pane: "routines",
          itemId: basis.id,
        },
      });
    }
  }

  return {
    mode,
    state: mode,
    label,
    detail,
    basis: readiness.exclusionReason
      ? "readiness"
      : currentRun
      ? "routine_run"
      : input.capacityWaiting
      ? "capacity"
      : scheduled
      ? "next_wake"
      : input.eventSubscriptionActive
      ? "subscription"
      : "routine",
    routineId: basis?.id || null,
    routineName: basis?.name || null,
    runId: currentRun?.run.id || null,
    nextEventAt: scheduled?.nextRunAt || null,
    lastObservedAt: latestActivityAt(routines),
    readiness,
    evidence,
    derivedAt: input.now.toISOString(),
  };
}
