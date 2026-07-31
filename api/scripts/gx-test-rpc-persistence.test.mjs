import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

function createHarness() {
  return createTestHarness({
    root: fileURLToPath(new URL("../", import.meta.url)),
    workers: [
      {
        config: {
          name: "gx-test-rpc-persistence-api",
          main: "test-fixtures/gx-test-rpc-persistence-worker.mjs",
          compatibility_date: "2026-03-01",
          compatibility_flags: ["nodejs_compat"],
          worker_loaders: [{
            binding: "LOADER",
          }],
          durable_objects: {
            bindings: [{
              name: "GX_TEST_SESSION",
              class_name: "GxTestSession",
              script_name: "gx-test-rpc-persistence-session",
            }],
          },
        },
      },
      {
        config: {
          name: "gx-test-rpc-persistence-session",
          main:
            "test-fixtures/gx-test-rpc-persistence-session-worker.mjs",
          compatibility_date: "2026-03-01",
          compatibility_flags: ["nodejs_compat"],
          exports: {
            GxTestSession: {
              type: "durable-object",
              storage: "sqlite",
            },
          },
        },
      },
    ],
  });
}

test("API -> external Durable Object -> test binding -> Worker Loader shares state", async () => {
  const server = createHarness();
  try {
    await server.listen();
    const response = await server.fetch("/persistent");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      transcript: [
        { binding_name: "first", effect: "storage.read" },
        { binding_name: "second", effect: "network.http" },
      ],
      postSealRejected: true,
    });

    const worker = server.getWorker("gx-test-rpc-persistence-api");
    await worker.evictDurableObject("GX_TEST_SESSION", {
      name: "gx-test-rpc-probe",
    });
    const reopenedResponse = await server.fetch("/reopened");
    assert.equal(reopenedResponse.status, 200);
    assert.deepEqual(
      await reopenedResponse.json(),
      { transcript: [] },
      "close() must delete the transcript before the object hibernates",
    );
  } finally {
    await server.close();
  }
});

test("workerd rejects the old transient RpcTarget-in-props graph", async () => {
  const server = createHarness();
  try {
    await server.listen();
    const response = await server.fetch("/transient");
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.rejected, true);
    assert.match(
      `${result.name}: ${result.message}`,
      /DataCloneError|not a persistent stub|cannot be serialized/i,
    );
  } finally {
    await server.close();
  }
});
