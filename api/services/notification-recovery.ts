// Canonical notification incident keys and lifecycle recovery helpers.
//
// Recovery is intentionally exact: callers name the owner and the same
// dedupe key that created the incident. We never resolve by kind, Agent, or a
// broad prefix, and read_at remains an entirely separate concern.

import {
  createNotification,
  type NotificationInput,
  type NotificationRow,
  resolveNotificationIncidentByDedupe,
} from "./notifications.ts";

export type NotificationIncidentResolver = (
  userId: string,
  dedupeKey: string,
  resolutionReason: string,
) => Promise<number>;

type NotificationCreator = (
  input: NotificationInput,
) => Promise<NotificationRow | null>;

interface IncidentRecoveryDeps {
  resolveIncidentFn?: NotificationIncidentResolver;
}

interface IncidentCreationDeps {
  createNotificationFn?: NotificationCreator;
}

interface IncidentResolution {
  dedupeKey: string;
  reason: string;
}

function normalizedSegment(value: string): string {
  return value.trim();
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map(normalizedSegment).filter((value) => value.length > 0)),
  );
}

export function missingSettingIncidentDedupeKey(
  agentId: string,
  settingKey: string,
): string {
  return `agent_missing_setting:${normalizedSegment(agentId)}:${
    normalizedSegment(settingKey)
  }`;
}

export function setupRequiredIncidentDedupeKey(agentId: string): string {
  return `agent_setup_required:${normalizedSegment(agentId)}`;
}

export function grantApprovalIncidentDedupeKey(grantId: string): string {
  return `agent_grant_approval:${normalizedSegment(grantId)}`;
}

export function routineActivationIncidentDedupeKey(
  routineId: string,
): string {
  return `routine_activation_blocked:${normalizedSegment(routineId)}`;
}

export function routineCapacityIncidentDedupeKey(
  routineId: string,
  capBasisPoints: number | string | null | undefined,
): string {
  const cap = capBasisPoints === null || capBasisPoints === undefined ||
      String(capBasisPoints).trim().length === 0
    ? "unknown"
    : String(capBasisPoints).trim();
  return `routine_capacity_too_low:${normalizedSegment(routineId)}:${cap}`;
}

export function routinePauseIncidentDedupeKey(
  routineId: string,
  pausedAt: string,
): string {
  return `routine_paused:${normalizedSegment(routineId)}:${
    normalizedSegment(pausedAt)
  }`;
}

type EventIncidentKind =
  | "event_dispatch_failed"
  | "event_delivery_failed"
  | "event_delivery_blocked"
  | "event_delivery_waiting";

export function eventIncidentDedupeKey(
  kind: EventIncidentKind,
  eventOrDeliveryId: string,
): string {
  return `${kind}:${normalizedSegment(eventOrDeliveryId)}`;
}

async function resolveExactIncidents(
  userId: string,
  incidents: readonly IncidentResolution[],
  deps: IncidentRecoveryDeps = {},
): Promise<number> {
  const ownerId = userId.trim();
  if (!ownerId) return 0;

  const resolver = deps.resolveIncidentFn ??
    ((owner, dedupeKey, reason) =>
      resolveNotificationIncidentByDedupe(owner, dedupeKey, reason));
  const unique = new Map<string, IncidentResolution>();
  for (const incident of incidents) {
    const dedupeKey = incident.dedupeKey.trim();
    const reason = incident.reason.trim();
    if (!dedupeKey || !reason || unique.has(dedupeKey)) continue;
    unique.set(dedupeKey, { dedupeKey, reason });
  }

  const counts = await Promise.all(
    Array.from(unique.values()).map(async ({ dedupeKey, reason }) => {
      try {
        return await resolver(ownerId, dedupeKey, reason);
      } catch {
        // Recovery notifications are best-effort and must never roll back the
        // successful configuration, approval, wake, or delivery that proved
        // the incident is no longer current.
        return 0;
      }
    }),
  );
  return counts.reduce((total, count) => total + count, 0);
}

export async function recordMissingSettingIncidents(
  input: {
    userId: string;
    agentId: string;
    missingSettingKeys: readonly string[];
  },
  deps: IncidentCreationDeps = {},
): Promise<number> {
  const userId = input.userId.trim();
  const agentId = input.agentId.trim();
  if (!userId || !agentId) return 0;

  const creator = deps.createNotificationFn ??
    ((notification) => createNotification(notification));
  const rows = await Promise.all(
    uniqueNonEmpty(input.missingSettingKeys).map(async (settingKey) => {
      try {
        return await creator({
          userId,
          agentId,
          kind: "agent_missing_setting",
          severity: "warning",
          title: "A required setting is missing",
          body:
            `This Agent cannot run work that requires ${settingKey} until its owner configures it.`,
          entityType: "setting",
          entityId: settingKey,
          actionUrl: `/agents/${encodeURIComponent(agentId)}?pane=access&item=${
            encodeURIComponent(`setting:${settingKey}`)
          }`,
          dedupeKey: missingSettingIncidentDedupeKey(agentId, settingKey),
        });
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((row) => row !== null).length;
}

export async function resolveConfiguredSettingIncidents(
  input: {
    userId: string;
    agentId: string;
    configuredSettingKeys: readonly string[];
    fullyConfigured?: boolean;
  },
  deps: IncidentRecoveryDeps = {},
): Promise<number> {
  const incidents: IncidentResolution[] = uniqueNonEmpty(
    input.configuredSettingKeys,
  ).map((settingKey) => ({
    dedupeKey: missingSettingIncidentDedupeKey(input.agentId, settingKey),
    reason: "The required setting is now configured.",
  }));
  if (input.fullyConfigured) {
    incidents.push({
      dedupeKey: setupRequiredIncidentDedupeKey(input.agentId),
      reason: "All required Agent settings are now configured.",
    });
  }
  return await resolveExactIncidents(input.userId, incidents, deps);
}

export async function recordGrantApprovalIncident(
  input: {
    userId: string;
    grantId: string;
    callerAgentId: string;
    targetAgentId: string;
    targetFunction: string;
    mode: "call" | "subscribe";
  },
  deps: IncidentCreationDeps = {},
): Promise<boolean> {
  const userId = input.userId.trim();
  const grantId = input.grantId.trim();
  const callerAgentId = input.callerAgentId.trim();
  if (!userId || !grantId || !callerAgentId) return false;

  const creator = deps.createNotificationFn ??
    ((notification) => createNotification(notification));
  try {
    const row = await creator({
      userId,
      agentId: callerAgentId,
      kind: "agent_grant_approval_required",
      severity: "warning",
      title: "Agent access approval required",
      body: input.mode === "subscribe"
        ? `Review this Agent's request to deliver events to ${input.targetFunction} on ${input.targetAgentId}.`
        : `Review this Agent's request to call ${input.targetFunction} on ${input.targetAgentId}.`,
      entityType: "grant",
      entityId: grantId,
      actionUrl: `/agents/${
        encodeURIComponent(callerAgentId)
      }?pane=access&item=${encodeURIComponent(`grant:${grantId}`)}`,
      dedupeKey: grantApprovalIncidentDedupeKey(grantId),
    });
    return row !== null;
  } catch {
    return false;
  }
}

export async function resolveGrantApprovalIncident(
  userId: string,
  grantId: string,
  outcome: "approved" | "rejected" | "revoked" = "approved",
  deps: IncidentRecoveryDeps = {},
): Promise<number> {
  return await resolveExactIncidents(userId, [{
    dedupeKey: grantApprovalIncidentDedupeKey(grantId),
    reason: `The Agent access request was ${outcome}.`,
  }], deps);
}

function recordValue(
  value: unknown,
  key: string,
): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export async function resolveRoutineRecoveryIncidents(
  input: {
    userId: string;
    routineId: string;
    metadata?: Record<string, unknown> | null;
    reason: "resumed" | "successful_wake";
  },
  deps: IncidentRecoveryDeps = {},
): Promise<number> {
  const reason = input.reason === "successful_wake"
    ? "The routine recovered after a successful wake."
    : "The routine resumed after its activation blockers were revalidated.";
  const incidents: IncidentResolution[] = [];

  const capacityBlocked = recordValue(input.metadata, "capacity_blocked");
  if (
    capacityBlocked && typeof capacityBlocked === "object" &&
    !Array.isArray(capacityBlocked)
  ) {
    incidents.push({
      dedupeKey: routineCapacityIncidentDedupeKey(
        input.routineId,
        recordValue(capacityBlocked, "cap_basis_points") as
          | number
          | string
          | null
          | undefined,
      ),
      reason,
    });
  }

  const autoPause = recordValue(input.metadata, "auto_pause");
  if (
    recordValue(autoPause, "reason") === "activation_validation_failed"
  ) {
    incidents.unshift({
      dedupeKey: routineActivationIncidentDedupeKey(input.routineId),
      reason,
    });
  }
  const pausedAt = recordValue(autoPause, "at");
  if (typeof pausedAt === "string" && pausedAt.trim()) {
    incidents.push({
      dedupeKey: routinePauseIncidentDedupeKey(input.routineId, pausedAt),
      reason,
    });
  }

  return await resolveExactIncidents(input.userId, incidents, deps);
}

export async function resolveEventDispatchIncident(
  userId: string,
  eventId: string,
  deps: IncidentRecoveryDeps = {},
): Promise<number> {
  return await resolveExactIncidents(userId, [{
    dedupeKey: eventIncidentDedupeKey("event_dispatch_failed", eventId),
    reason: "The event was dispatched successfully on a later attempt.",
  }], deps);
}

export async function resolveEventDeliveryIncidents(
  userId: string,
  deliveryId: string,
  deps: IncidentRecoveryDeps = {},
): Promise<number> {
  return await resolveExactIncidents(
    userId,
    [
      "event_delivery_failed",
      "event_delivery_blocked",
      "event_delivery_waiting",
    ].map((kind) => ({
      dedupeKey: eventIncidentDedupeKey(
        kind as Exclude<EventIncidentKind, "event_dispatch_failed">,
        deliveryId,
      ),
      reason: "The event delivery succeeded on a later attempt.",
    })),
    deps,
  );
}
