import type {
  LaunchAgentActivityItem,
  LaunchAgentActivityKind,
  LaunchAgentActivityPreview,
  LaunchAgentEvidenceReference,
  LaunchAgentRoutineOverview,
  LaunchNavigationTarget,
} from "../../shared/contracts/launch.ts";

export interface AgentActivityCandidate {
  kind: Exclude<LaunchAgentActivityKind, "scheduled_run" | "routine_run">;
  sourceId: string;
  title: string;
  summary?: string | null;
  status: string;
  occurredAt?: string | null;
  scheduledAt?: string | null;
  routineId?: string | null;
  destination?: LaunchNavigationTarget | null;
  evidence?: LaunchAgentEvidenceReference[];
}

export interface AgentActivityInput {
  agentSlug: string;
  now: Date;
  routines: readonly LaunchAgentRoutineOverview[];
  additionalItems?: readonly AgentActivityCandidate[];
}

function validIso(value: string | null | undefined): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

function routineDestination(
  agentSlug: string,
  routineId: string,
): LaunchNavigationTarget {
  return {
    href: `/agents/${encodeURIComponent(agentSlug)}?pane=routines&item=${
      encodeURIComponent(routineId)
    }`,
    pane: "routines",
    itemId: routineId,
  };
}

function runDestination(
  agentSlug: string,
  routineId: string,
): LaunchNavigationTarget {
  return routineDestination(agentSlug, routineId);
}

function scheduledItem(
  agentSlug: string,
  routine: LaunchAgentRoutineOverview,
  scheduledAt: string,
): LaunchAgentActivityItem {
  const destination = routineDestination(agentSlug, routine.id);
  return {
    id: `scheduled:${routine.id}:${scheduledAt}`,
    kind: "scheduled_run",
    phase: "up_next",
    title: routine.name,
    summary: routine.mission || null,
    status: "scheduled",
    occurredAt: null,
    scheduledAt,
    routineId: routine.id,
    sourceId: `${routine.id}:${scheduledAt}`,
    destination,
    evidence: [{
      kind: "schedule",
      sourceId: `${routine.id}:${scheduledAt}`,
      label: routine.schedule.label,
      observedAt: scheduledAt,
      destination,
    }],
  };
}

function runItem(
  agentSlug: string,
  routine: LaunchAgentRoutineOverview,
  run: LaunchAgentRoutineOverview["recentRuns"][number],
): LaunchAgentActivityItem {
  const destination = runDestination(agentSlug, routine.id);
  const active = run.status === "queued" || run.status === "running";
  return {
    id: `run:${run.id}`,
    kind: "routine_run",
    phase: active ? "now" : "recent",
    title: routine.name,
    summary: run.summary,
    status: run.status,
    occurredAt: validIso(run.completedAt) || validIso(run.startedAt) ||
      validIso(run.createdAt),
    scheduledAt: null,
    routineId: routine.id,
    sourceId: run.id,
    destination,
    evidence: [{
      kind: "run",
      sourceId: run.id,
      label: `${routine.name} run`,
      observedAt: validIso(run.completedAt) || validIso(run.startedAt) ||
        validIso(run.createdAt),
      destination,
    }],
  };
}

function additionalItem(
  candidate: AgentActivityCandidate,
): LaunchAgentActivityItem {
  const occurredAt = validIso(candidate.occurredAt);
  const scheduledAt = validIso(candidate.scheduledAt);
  const active = candidate.status === "queued" ||
    candidate.status === "running" ||
    candidate.status === "in_progress";
  const phase = active ? "now" : scheduledAt ? "up_next" : "recent";
  return {
    id: `${candidate.kind}:${candidate.sourceId}`,
    kind: candidate.kind,
    phase,
    title: candidate.title,
    summary: candidate.summary || null,
    status: candidate.status,
    occurredAt,
    scheduledAt,
    routineId: candidate.routineId || null,
    sourceId: candidate.sourceId,
    destination: candidate.destination || null,
    evidence: [...(candidate.evidence || [])],
  };
}

function itemTimestamp(item: LaunchAgentActivityItem): number {
  const value = item.occurredAt || item.scheduledAt;
  return value ? Date.parse(value) : 0;
}

function preferItem(
  left: LaunchAgentActivityItem,
  right: LaunchAgentActivityItem,
): LaunchAgentActivityItem {
  const phaseRank = { now: 3, up_next: 2, recent: 1 };
  if (phaseRank[right.phase] !== phaseRank[left.phase]) {
    return phaseRank[right.phase] > phaseRank[left.phase] ? right : left;
  }
  return itemTimestamp(right) > itemTimestamp(left) ? right : left;
}

export function buildAgentActivityPreview(
  input: AgentActivityInput,
): LaunchAgentActivityPreview {
  const nowMs = input.now.getTime();
  const candidates: LaunchAgentActivityItem[] = [];

  for (const routine of input.routines) {
    const scheduleEffective = routine.status === "active" &&
      (routine.health === "active" || routine.health === "running") &&
      routine.blockers.length === 0;
    if (scheduleEffective) {
      const occurrences = new Set(
        [routine.nextRunAt, ...routine.nextOccurrences]
          .map(validIso)
          .filter((value): value is string =>
            typeof value === "string" && Date.parse(value) > nowMs
          ),
      );
      for (const scheduledAt of occurrences) {
        candidates.push(scheduledItem(input.agentSlug, routine, scheduledAt));
      }
    }
    for (const run of routine.recentRuns) {
      candidates.push(runItem(input.agentSlug, routine, run));
    }
  }
  for (const item of input.additionalItems || []) {
    candidates.push(additionalItem(item));
  }

  const deduped = new Map<string, LaunchAgentActivityItem>();
  for (const item of candidates) {
    const existing = deduped.get(item.id);
    deduped.set(item.id, existing ? preferItem(existing, item) : item);
  }
  const values = [...deduped.values()];
  const upNext =
    values.filter((item) =>
      item.phase === "up_next" && item.scheduledAt &&
      Date.parse(item.scheduledAt) > nowMs
    ).sort((left, right) =>
      itemTimestamp(left) - itemTimestamp(right) ||
      left.id.localeCompare(right.id)
    )[0] || null;
  const now = values.filter((item) => item.phase === "now")
    .sort((left, right) =>
      itemTimestamp(right) - itemTimestamp(left) ||
      left.id.localeCompare(right.id)
    )
    .slice(0, 3);
  const recent = values.filter((item) => item.phase === "recent")
    .sort((left, right) =>
      itemTimestamp(right) - itemTimestamp(left) ||
      left.id.localeCompare(right.id)
    )
    .slice(0, 3);
  const items = [...now, ...(upNext ? [upNext] : []), ...recent];

  return {
    upNext,
    now,
    recent,
    items,
    generatedAt: input.now.toISOString(),
  };
}

/**
 * Attention is the canonical place for unresolved incidents and unread
 * reports. Remove those exact notification sources from the compact Overview
 * Activity projection without changing full-history chronology.
 */
export function excludeAgentActivitySources(
  activity: LaunchAgentActivityPreview,
  sourceIds: ReadonlySet<string>,
): LaunchAgentActivityPreview {
  const keep = (item: LaunchAgentActivityItem) => !sourceIds.has(item.sourceId);
  const upNext = activity.upNext && keep(activity.upNext)
    ? activity.upNext
    : null;
  const now = activity.now.filter(keep);
  const recent = activity.recent.filter(keep);
  return {
    ...activity,
    upNext,
    now,
    recent,
    items: [...now, ...(upNext ? [upNext] : []), ...recent],
  };
}
