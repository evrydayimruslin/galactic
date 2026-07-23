import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import type { NotificationInput } from "./notifications.ts";
import {
  eventIncidentDedupeKey,
  grantApprovalIncidentDedupeKey,
  missingSettingIncidentDedupeKey,
  recordGrantApprovalIncident,
  recordMissingSettingIncidents,
  resolveConfiguredSettingIncidents,
  resolveEventDeliveryIncidents,
  resolveRoutineRecoveryIncidents,
  routineActivationIncidentDedupeKey,
  routineCapacityIncidentDedupeKey,
  routinePauseIncidentDedupeKey,
  setupRequiredIncidentDedupeKey,
} from "./notification-recovery.ts";

Deno.test("notification recovery: configuration resolves only exact owner-scoped keys", async () => {
  const calls: Array<{
    userId: string;
    dedupeKey: string;
    reason: string;
  }> = [];
  const count = await resolveConfiguredSettingIncidents(
    {
      userId: "owner-1",
      agentId: "agent-1",
      configuredSettingKeys: ["GMAIL_TOKEN", "GMAIL_TOKEN", "MAILBOX"],
      fullyConfigured: true,
    },
    {
      resolveIncidentFn: (userId, dedupeKey, reason) => {
        calls.push({ userId, dedupeKey, reason });
        return Promise.resolve(1);
      },
    },
  );

  assertEquals(count, 3);
  assertEquals(calls.map(({ userId, dedupeKey }) => ({ userId, dedupeKey })), [
    {
      userId: "owner-1",
      dedupeKey: missingSettingIncidentDedupeKey(
        "agent-1",
        "GMAIL_TOKEN",
      ),
    },
    {
      userId: "owner-1",
      dedupeKey: missingSettingIncidentDedupeKey("agent-1", "MAILBOX"),
    },
    {
      userId: "owner-1",
      dedupeKey: setupRequiredIncidentDedupeKey("agent-1"),
    },
  ]);
  assertEquals(
    calls.some((call) =>
      "read_at" in (call as unknown as Record<string, unknown>)
    ),
    false,
  );
});

Deno.test("notification recovery: routine keys mirror their exact producers", async () => {
  const calls: string[] = [];
  const count = await resolveRoutineRecoveryIncidents(
    {
      userId: "owner-1",
      routineId: "routine-1",
      metadata: {
        capacity_blocked: { cap_basis_points: 2750 },
        auto_pause: {
          reason: "activation_validation_failed",
          at: "2026-07-23T12:00:00.000Z",
        },
      },
      reason: "successful_wake",
    },
    {
      resolveIncidentFn: (_userId, dedupeKey) => {
        calls.push(dedupeKey);
        return Promise.resolve(1);
      },
    },
  );

  assertEquals(count, 3);
  assertEquals(calls, [
    routineActivationIncidentDedupeKey("routine-1"),
    routineCapacityIncidentDedupeKey("routine-1", 2750),
    routinePauseIncidentDedupeKey(
      "routine-1",
      "2026-07-23T12:00:00.000Z",
    ),
  ]);
});

Deno.test("notification recovery: a successful delivery resolves every prior delivery condition, not dispatch", async () => {
  const calls: string[] = [];
  await resolveEventDeliveryIncidents("owner-1", "delivery-1", {
    resolveIncidentFn: (_userId, dedupeKey) => {
      calls.push(dedupeKey);
      return Promise.resolve(1);
    },
  });
  assertEquals(calls, [
    eventIncidentDedupeKey("event_delivery_failed", "delivery-1"),
    eventIncidentDedupeKey("event_delivery_blocked", "delivery-1"),
    eventIncidentDedupeKey("event_delivery_waiting", "delivery-1"),
  ]);
});

Deno.test("notification recovery: missing-setting and grant producers use canonical incident identities", async () => {
  const notifications: NotificationInput[] = [];
  const createNotificationFn = (input: NotificationInput) => {
    notifications.push(input);
    return Promise.resolve({
      id: `notification-${notifications.length}`,
    } as never);
  };

  assertEquals(
    await recordMissingSettingIncidents(
      {
        userId: "owner-1",
        agentId: "agent-1",
        missingSettingKeys: ["GMAIL_TOKEN"],
      },
      { createNotificationFn },
    ),
    1,
  );
  assertEquals(
    await recordGrantApprovalIncident(
      {
        userId: "owner-1",
        grantId: "grant-1",
        callerAgentId: "agent-1",
        targetAgentId: "agent-2",
        targetFunction: "send_reply",
        mode: "call",
      },
      { createNotificationFn },
    ),
    true,
  );

  assertEquals(
    notifications[0].dedupeKey,
    missingSettingIncidentDedupeKey(
      "agent-1",
      "GMAIL_TOKEN",
    ),
  );
  assertEquals(notifications[0].entityType, "setting");
  assertEquals(notifications[0].entityId, "GMAIL_TOKEN");
  assertMatch(notifications[0].actionUrl ?? "", /pane=access/);

  assertEquals(
    notifications[1].dedupeKey,
    grantApprovalIncidentDedupeKey("grant-1"),
  );
  assertEquals(notifications[1].entityType, "grant");
  assertEquals(notifications[1].entityId, "grant-1");
  assertMatch(notifications[1].actionUrl ?? "", /item=grant%3Agrant-1/);
});
