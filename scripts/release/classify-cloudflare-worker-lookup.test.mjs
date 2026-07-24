import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyCloudflareWorkerLookup,
} from "./classify-cloudflare-worker-lookup.mjs";

test("classifies a successful Worker lookup as bound", () => {
  assert.equal(
    classifyCloudflareWorkerLookup(200, {
      success: true,
      errors: [],
      result: {
        deployments: [{
          id: "deployment-1",
          versions: [{ version_id: "version-1", percentage: 100 }],
        }],
      },
    }),
    "bound",
  );
});

test("classifies only exact Cloudflare Worker-not-found as bootstrap", () => {
  assert.equal(
    classifyCloudflareWorkerLookup(404, {
      success: false,
      errors: [{ code: 10007, message: "Worker not found" }],
      result: null,
    }),
    "bootstrap",
  );
});

for (
  const [name, status, payload] of [
    [
      "authentication failure",
      403,
      { success: false, errors: [{ code: 10000 }], result: null },
    ],
    [
      "rate limit",
      429,
      { success: false, errors: [{ code: 1015 }], result: null },
    ],
    [
      "wrong missing-Worker status",
      500,
      { success: false, errors: [{ code: 10007 }], result: null },
    ],
    [
      "multiple errors",
      404,
      {
        success: false,
        errors: [{ code: 10007 }, { code: 10000 }],
        result: null,
      },
    ],
    [
      "success with errors",
      200,
      { success: true, errors: [{ code: 10007 }], result: [] },
    ],
  ]
) {
  test(`fails closed on ${name}`, () => {
    assert.throws(
      () => classifyCloudflareWorkerLookup(status, payload),
      /failed closed/u,
    );
  });
}

test("fails closed on malformed response state", () => {
  assert.throws(
    () => classifyCloudflareWorkerLookup(200, null),
    /malformed JSON/u,
  );
  assert.throws(
    () =>
      classifyCloudflareWorkerLookup(99, {
        success: true,
        errors: [],
        result: { deployments: [] },
      }),
    /invalid HTTP status/u,
  );
  assert.throws(
    () =>
      classifyCloudflareWorkerLookup(200, {
        success: true,
        result: { deployments: [] },
      }),
    /malformed JSON/u,
  );
});

for (
  const [name, status, payload] of [
    [
      "empty deployment result",
      200,
      { success: true, errors: [], result: { deployments: [] } },
    ],
    [
      "array deployment result",
      200,
      { success: true, errors: [], result: [] },
    ],
    [
      "deployment without versions",
      200,
      {
        success: true,
        errors: [],
        result: { deployments: [{ id: "deployment-1", versions: [] }] },
      },
    ],
    [
      "string missing-Worker code",
      404,
      {
        success: false,
        errors: [{ code: "10007" }],
        result: null,
      },
    ],
    [
      "missing-Worker response with a result",
      404,
      {
        success: false,
        errors: [{ code: 10007 }],
        result: { deployments: [] },
      },
    ],
  ]
) {
  test(`fails closed on ${name}`, () => {
    assert.throws(
      () => classifyCloudflareWorkerLookup(status, payload),
      /failed closed/u,
    );
  });
}

test("CLI-style partial HTTP status input is invalid", () => {
  assert.throws(
    () =>
      classifyCloudflareWorkerLookup(Number("404junk"), {
        success: false,
        errors: [{ code: 10007 }],
        result: null,
      }),
    /invalid HTTP status/u,
  );
});
