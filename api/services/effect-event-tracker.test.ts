import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  drainEffectEvents,
  recordEffectEvent,
} from "./effect-event-tracker.ts";

Deno.test("witness tracker: records, drains once, forgets", () => {
  recordEffectEvent("exec-1", {
    kind: "db_mutation",
    channel: "d1:conversations",
    outcome: "insert:1",
    attestation: "attested",
  });
  recordEffectEvent("exec-1", {
    kind: "notification",
    channel: "owner_inbox",
    outcome: "created",
    attestation: "attested",
  });
  const first = drainEffectEvents("exec-1");
  assertEquals(first.events.length, 2);
  assertEquals(first.events[0].kind, "db_mutation");
  // Drain forgets: a second drain is empty (settlement runs once).
  assertEquals(drainEffectEvents("exec-1").events.length, 0);
});

Deno.test("witness tracker: absent executionId is free and silent", () => {
  recordEffectEvent(null, {
    kind: "db_mutation",
    attestation: "attested",
  });
  recordEffectEvent(undefined, {
    kind: "db_mutation",
    attestation: "attested",
  });
  assertEquals(drainEffectEvents(null).events.length, 0);
});

Deno.test("witness tracker: cap appends an attested truncation marker — never a silent under-count", () => {
  for (let i = 0; i < 70; i++) {
    recordEffectEvent("exec-cap", {
      kind: "db_mutation",
      channel: "d1:t",
      outcome: `insert:${i}`,
      attestation: "attested",
    });
  }
  const drained = drainEffectEvents("exec-cap");
  assertEquals(drained.truncated, 10);
  assertEquals(drained.events.length, 61);
  const marker = drained.events[drained.events.length - 1];
  assertEquals(marker.kind, "non_action");
  assert(marker.outcome?.includes("10 further effects"));
});

Deno.test("witness tracker: clips oversized fields", () => {
  recordEffectEvent("exec-clip", {
    kind: "event_emit",
    channel: "x".repeat(500),
    outcome: "y".repeat(500),
    targetDigest: "z".repeat(500),
    attestation: "attested",
  });
  const [event] = drainEffectEvents("exec-clip").events;
  assertEquals(event.channel?.length, 120);
  assertEquals(event.outcome?.length, 200);
  assertEquals(event.targetDigest?.length, 200);
});
