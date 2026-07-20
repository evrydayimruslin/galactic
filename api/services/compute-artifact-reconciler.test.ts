import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type ComputeArtifactObjectDisposition,
  computeOutputObjectIdentity,
  type PendingComputeArtifactCandidate,
  runComputeArtifactReconciliationCycle,
  type TombstoneComputeArtifactResult,
} from "./compute-artifact-reconciler.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const ARTIFACT_A = "44444444-4444-4444-8444-444444444444";
const ARTIFACT_B = "55555555-5555-4555-8555-555555555555";
const ARTIFACT_C = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-07-20T12:00:00.000Z");
const OLD = new Date("2026-07-20T11:00:00.000Z");

function key(artifactId: string): string {
  return `compute-v1/${USER_ID}/${AGENT_ID}/${RUN_ID}/outputs/0-${artifactId}-report.pdf`;
}

function pending(
  artifactId = ARTIFACT_A,
): PendingComputeArtifactCandidate {
  return {
    artifactId,
    runId: RUN_ID,
    userId: USER_ID,
    agentId: AGENT_ID,
    callerFunction: "develop",
    storageKey: key(artifactId),
    sha256: "a".repeat(64),
    sizeBytes: "3",
    stateVersion: "1",
    artifactUpdatedAt: OLD.toISOString(),
    runState: "failed",
    stopRequestedAt: "2026-07-20T11:30:00.000Z",
  };
}

function deleted(
  artifactId: string,
  storageKey = key(artifactId),
): TombstoneComputeArtifactResult {
  return {
    skipped: false,
    artifactId,
    storageKey,
    state: "deleted",
    stateVersion: "2",
    replayed: false,
  };
}

function idleRetentionDeps() {
  return {
    listExpired: () => Promise.resolve([]),
    listUnpurged: () => Promise.resolve([]),
    confirmObjectDeleted: () => Promise.resolve({ replayed: false }),
  };
}

Deno.test("Compute object identity accepts only canonical scoped output keys", () => {
  assertEquals(computeOutputObjectIdentity(key(ARTIFACT_A)), {
    storageKey: key(ARTIFACT_A),
    userId: USER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
  });
  assertEquals(
    computeOutputObjectIdentity(
      `compute-v1/${USER_ID}/${AGENT_ID}/${RUN_ID}/inputs/${ARTIFACT_A}`,
    ),
    null,
  );
  assertEquals(
    computeOutputObjectIdentity(
      `compute-v1/${USER_ID}/${AGENT_ID}/${RUN_ID}/outputs/../secret`,
    ),
    null,
  );
  assertEquals(
    computeOutputObjectIdentity(key(ARTIFACT_A).toUpperCase()),
    null,
  );
});

Deno.test("retention reconciliation reserves progress for both directions", async () => {
  await assertRejects(
    () => runComputeArtifactReconciliationCycle({ retentionLimit: 1 }),
    Error,
    "retentionLimit must be between 2 and 500",
  );
});

Deno.test("artifact reconciler tombstones before deletion and advances one clean page", async () => {
  const readyKey = key("66666666-6666-4666-8666-666666666666");
  const pendingKey = key(ARTIFACT_B);
  const orphanKey = key("77777777-7777-4777-8777-777777777777");
  const activeKey = key("88888888-8888-4888-8888-888888888888");
  const inputKey =
    `compute-v1/${USER_ID}/${AGENT_ID}/${RUN_ID}/inputs/input-object`;
  const events: string[] = [];
  const dispositions = new Map<string, ComputeArtifactObjectDisposition>([
    [readyKey, { disposition: "keep", reason: "ready_artifact" }],
    [pendingKey, {
      disposition: "tombstone",
      reason: "pending_run_stopped",
      artifactId: ARTIFACT_B,
      stateVersion: "4",
      artifactUpdatedAt: OLD.toISOString(),
    }],
    [orphanKey, {
      disposition: "delete",
      reason: "run_missing",
      artifactId: null,
    }],
    [activeKey, { disposition: "keep", reason: "unreferenced_active_run" }],
  ]);
  const result = await runComputeArtifactReconciliationCycle({}, {
    ...idleRetentionDeps(),
    clock: () => NOW,
    bucket: {
      list: (options) => {
        assertEquals(options, {
          prefix: "compute-v1/",
          limit: 100,
          cursor: "page-a",
        });
        return Promise.resolve({
          objects: [readyKey, pendingKey, orphanKey, activeKey, inputKey].map(
            (storageKey) => ({ key: storageKey, uploaded: OLD }),
          ),
          truncated: true,
          cursor: "page-b",
        });
      },
      delete: (storageKey) => {
        events.push(`delete:${storageKey}`);
        return Promise.resolve();
      },
    },
    listPending: () => Promise.resolve([pending()]),
    tombstone: (input) => {
      events.push(`tombstone:${input.artifactId}`);
      return Promise.resolve(deleted(input.artifactId));
    },
    getCursor: () => Promise.resolve({ cursor: "page-a", stateVersion: "9" }),
    advanceCursor: (input) => {
      events.push(`cursor:${input.expectedStateVersion}:${input.cursor}`);
      return Promise.resolve({ cursor: input.cursor, stateVersion: "10" });
    },
    classifyObject: (identity) => {
      const disposition = dispositions.get(identity.storageKey);
      if (!disposition) throw new Error("unexpected object classification");
      return Promise.resolve(disposition);
    },
  });

  assertEquals(events, [
    `tombstone:${ARTIFACT_A}`,
    `delete:${key(ARTIFACT_A)}`,
    `tombstone:${ARTIFACT_B}`,
    `delete:${pendingKey}`,
    `delete:${orphanKey}`,
    "cursor:9:page-b",
  ]);
  assertEquals(result, {
    unpurgedCandidates: 0,
    pendingCandidates: 1,
    expiredCandidates: 0,
    objectsScanned: 5,
    tombstoned: 2,
    aliasesReleased: 0,
    objectsDeleted: 3,
    skipped: 3,
    failed: 0,
    cursorAdvanced: true,
  });
});

Deno.test("object deletion failure advances the page and retries after scan wrap", async () => {
  let advanced = false;
  const orphanKey = key(ARTIFACT_A);
  const result = await runComputeArtifactReconciliationCycle({}, {
    ...idleRetentionDeps(),
    clock: () => NOW,
    bucket: {
      list: () =>
        Promise.resolve({
          objects: [{ key: orphanKey, uploaded: OLD }],
          truncated: true,
          cursor: "next-page",
        }),
      delete: () => Promise.reject(new Error("R2 unavailable")),
    },
    listPending: () => Promise.resolve([]),
    getCursor: () =>
      Promise.resolve({ cursor: "current-page", stateVersion: "2" }),
    advanceCursor: () => {
      advanced = true;
      return Promise.resolve({ cursor: "next-page", stateVersion: "3" });
    },
    classifyObject: () =>
      Promise.resolve({
        disposition: "delete",
        reason: "run_missing",
        artifactId: null,
      }),
  });
  assertEquals(advanced, true);
  assertEquals(result.failed, 1);
  assertEquals(result.objectsDeleted, 0);
  assertEquals(result.cursorAdvanced, true);
});

Deno.test("recent objects are never classified or deleted", async () => {
  let classified = false;
  let deletedObject = false;
  const result = await runComputeArtifactReconciliationCycle({}, {
    ...idleRetentionDeps(),
    clock: () => NOW,
    bucket: {
      list: () =>
        Promise.resolve({
          objects: [{
            key: key(ARTIFACT_A),
            uploaded: new Date("2026-07-20T11:59:00.000Z"),
          }],
          truncated: false,
        }),
      delete: () => {
        deletedObject = true;
        return Promise.resolve();
      },
    },
    listPending: () => Promise.resolve([]),
    getCursor: () => Promise.resolve({ cursor: null, stateVersion: "1" }),
    advanceCursor: ({ cursor }) => {
      assertEquals(cursor, null);
      return Promise.resolve({ cursor: null, stateVersion: "2" });
    },
    classifyObject: () => {
      classified = true;
      return Promise.resolve({ disposition: "keep", reason: "unexpected" });
    },
  });
  assertEquals(classified, false);
  assertEquals(deletedObject, false);
  assertEquals(result.skipped, 1);
  assertEquals(result.cursorAdvanced, true);
});

Deno.test("a mismatched tombstone key cannot delete either object", async () => {
  let deletes = 0;
  const result = await runComputeArtifactReconciliationCycle({}, {
    ...idleRetentionDeps(),
    clock: () => NOW,
    bucket: {
      list: () => Promise.resolve({ objects: [], truncated: false }),
      delete: () => {
        deletes += 1;
        return Promise.resolve();
      },
    },
    listPending: () => Promise.resolve([pending()]),
    tombstone: () => Promise.resolve(deleted(ARTIFACT_A, key(ARTIFACT_B))),
    getCursor: () => Promise.resolve({ cursor: null, stateVersion: "1" }),
    advanceCursor: () => Promise.resolve({ cursor: null, stateVersion: "2" }),
    classifyObject: () =>
      Promise.resolve({
        disposition: "keep",
        reason: "unused",
      }),
  });
  assertEquals(deletes, 0);
  assertEquals(result.skipped, 1);
  assertEquals(result.failed, 0);
});

Deno.test("a pending candidate that committed during the sweep is retained", async () => {
  let deletes = 0;
  const result = await runComputeArtifactReconciliationCycle({}, {
    ...idleRetentionDeps(),
    clock: () => NOW,
    bucket: {
      list: () => Promise.resolve({ objects: [], truncated: false }),
      delete: () => {
        deletes += 1;
        return Promise.resolve();
      },
    },
    listPending: () => Promise.resolve([pending()]),
    tombstone: () =>
      Promise.resolve({
        skipped: true,
        reason: "candidate_changed",
      }),
    getCursor: () => Promise.resolve({ cursor: null, stateVersion: "1" }),
    advanceCursor: () => Promise.resolve({ cursor: null, stateVersion: "2" }),
    classifyObject: () =>
      Promise.resolve({
        disposition: "keep",
        reason: "unused",
      }),
  });
  assertEquals(deletes, 0);
  assertEquals(result.skipped, 1);
  assertEquals(result.failed, 0);
});

Deno.test("a truncated R2 page without a cursor fails closed", async () => {
  let advanced = false;
  const result = await runComputeArtifactReconciliationCycle({}, {
    ...idleRetentionDeps(),
    clock: () => NOW,
    bucket: {
      list: () => Promise.resolve({ objects: [], truncated: true }),
      delete: () => Promise.resolve(),
    },
    listPending: () => Promise.resolve([]),
    getCursor: () => Promise.resolve({ cursor: null, stateVersion: "1" }),
    advanceCursor: () => {
      advanced = true;
      return Promise.resolve({ cursor: null, stateVersion: "2" });
    },
    classifyObject: () =>
      Promise.resolve({
        disposition: "keep",
        reason: "unused",
      }),
  });
  assertEquals(advanced, false);
  assertEquals(result.failed, 1);
  assertEquals(result.cursorAdvanced, false);
  assert(result.objectsScanned === 0);
});

Deno.test("retention releases aliases and confirms R2 deletion before physical quota", async () => {
  const events: string[] = [];
  const sourceKey = key(ARTIFACT_C);
  const result = await runComputeArtifactReconciliationCycle({}, {
    clock: () => NOW,
    bucket: {
      list: () => Promise.resolve({ objects: [], truncated: false }),
      delete: (storageKey) => {
        events.push(`delete:${storageKey}`);
        return Promise.resolve();
      },
    },
    listUnpurged: () =>
      Promise.resolve([{
        artifactId: ARTIFACT_A,
        storageKey: key(ARTIFACT_A),
        stateVersion: "3",
        artifactUpdatedAt: OLD.toISOString(),
      }]),
    listExpired: () =>
      Promise.resolve([{
        artifactId: ARTIFACT_B,
        runId: RUN_ID,
        userId: USER_ID,
        agentId: AGENT_ID,
        callerFunction: "develop",
        storageKey: sourceKey,
        direction: "input",
        stateVersion: "1",
        expiresAt: OLD.toISOString(),
        retentionProtectedUntil: null,
        runState: "succeeded",
        runFinishedAt: OLD.toISOString(),
      }, {
        artifactId: ARTIFACT_C,
        runId: RUN_ID,
        userId: USER_ID,
        agentId: AGENT_ID,
        callerFunction: "develop",
        storageKey: sourceKey,
        direction: "output",
        stateVersion: "2",
        expiresAt: OLD.toISOString(),
        retentionProtectedUntil: null,
        runState: "succeeded",
        runFinishedAt: OLD.toISOString(),
      }]),
    tombstoneExpired: (input) => {
      events.push(`tombstone:${input.artifactId}`);
      const direction = input.artifactId === ARTIFACT_B ? "input" : "output";
      return Promise.resolve({
        skipped: false as const,
        artifactId: input.artifactId,
        storageKey: sourceKey,
        direction,
        state: "deleted" as const,
        stateVersion: direction === "input" ? "2" : "3",
        deleteObject: direction === "output",
        replayed: false,
      });
    },
    confirmObjectDeleted: (input) => {
      events.push(`confirm:${input.artifactId}:${input.storageKey}`);
      return Promise.resolve({ replayed: false });
    },
    listPending: () => Promise.resolve([]),
    tombstone: () => Promise.reject(new Error("unused")),
    getCursor: () => Promise.resolve({ cursor: null, stateVersion: "1" }),
    advanceCursor: () => Promise.resolve({ cursor: null, stateVersion: "2" }),
    classifyObject: () =>
      Promise.resolve({ disposition: "keep", reason: "unused" }),
  });

  assertEquals(events, [
    `delete:${key(ARTIFACT_A)}`,
    `confirm:${ARTIFACT_A}:${key(ARTIFACT_A)}`,
    `tombstone:${ARTIFACT_B}`,
    `tombstone:${ARTIFACT_C}`,
    `delete:${sourceKey}`,
    `confirm:${ARTIFACT_C}:${sourceKey}`,
  ]);
  assertEquals(result.unpurgedCandidates, 1);
  assertEquals(result.expiredCandidates, 2);
  assertEquals(result.aliasesReleased, 1);
  assertEquals(result.tombstoned, 2);
  assertEquals(result.objectsDeleted, 2);
  assertEquals(result.failed, 0);
});
