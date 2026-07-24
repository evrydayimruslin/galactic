import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  verifyApiComputeBootstrapHistory,
} from "./verify-api-compute-bootstrap-history.mjs";

const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-23T12:00:00.000Z");

function policy(overrides = {}) {
  return {
    schema_version: 1,
    repository: "evrydayimruslin/galactic",
    expires_at: "2026-08-31T00:00:00.000Z",
    environments: {
      production: {
        api_worker: "ultralight-api",
        compute_worker: "galactic-compute",
        allow_bootstrap_without_compute_worker: true,
      },
      staging: {
        api_worker: "ultralight-api-staging",
        compute_worker: "galactic-compute-staging",
        allow_bootstrap_without_compute_worker: true,
      },
    },
    ...overrides,
  };
}

function version(id = VERSION_ID, bindings = []) {
  return {
    id,
    resources: { bindings },
  };
}

function inventory(ids = [VERSION_ID, SECOND_VERSION_ID]) {
  return {
    success: true,
    errors: [],
    result: {
      items: ids.map((id) => ({ id })),
    },
  };
}

function verify(overrides = {}) {
  return verifyApiComputeBootstrapHistory({
    target: "production",
    repository: "evrydayimruslin/galactic",
    activeVersionId: VERSION_ID,
    policy: policy(),
    inventory: inventory(),
    versions: [
      version(VERSION_ID),
      version(SECOND_VERSION_ID, [{
        type: "plain_text",
        name: "COMPUTE_ENABLED",
        text: "0",
      }]),
    ],
    now: NOW,
    ...overrides,
  });
}

test("accepts explicit unexpired policy and retained admission-off history", () => {
  assert.deepEqual(verify(), {
    deployableVersions: 2,
    expiresAt: "2026-08-31T00:00:00.000Z",
  });
});

test("validates the exact staging target", () => {
  assert.deepEqual(
    verify({
      target: "staging",
      activeVersionId: VERSION_ID,
    }),
    {
      deployableVersions: 2,
      expiresAt: "2026-08-31T00:00:00.000Z",
    },
  );
});

test("checked-in bootstrap policy approves only the reviewed targets", () => {
  const checkedInPolicy = JSON.parse(
    readFileSync(
      new URL("../../api/compute-bootstrap-policy.json", import.meta.url),
      "utf8",
    ),
  );
  for (const target of ["production", "staging"]) {
    assert.equal(
      verify({
        target,
        policy: checkedInPolicy,
      }).deployableVersions,
      2,
    );
  }
  assert.deepEqual(
    Object.keys(checkedInPolicy.environments).sort(),
    ["production", "staging"],
  );
});

for (
  const [name, overrides] of [
    [
      "wrong repository",
      { repository: "someone/else" },
    ],
    [
      "expired policy",
      { now: new Date("2026-08-31T00:00:00.000Z") },
    ],
    [
      "unapproved target",
      {
        policy: policy({
          environments: {
            production: {
              api_worker: "ultralight-api",
              compute_worker: "galactic-compute",
              allow_bootstrap_without_compute_worker: false,
            },
          },
        }),
      },
    ],
    [
      "active version missing from inventory",
      { activeVersionId: "33333333-3333-4333-8333-333333333333" },
    ],
    [
      "malformed inventory",
      { inventory: { success: true, errors: [], result: { items: [] } } },
    ],
    [
      "duplicate inventory IDs",
      { inventory: inventory([VERSION_ID, VERSION_ID]) },
    ],
    [
      "incomplete version details",
      { versions: [version(VERSION_ID)] },
    ],
    [
      "version detail absent from inventory",
      {
        inventory: inventory([VERSION_ID]),
        versions: [version(SECOND_VERSION_ID)],
      },
    ],
    [
      "duplicate version history",
      { versions: [version(), version()] },
    ],
    [
      "retained Compute Plane",
      {
        versions: [
          version(VERSION_ID, [{
            type: "service",
            name: "COMPUTE_PLANE",
            service: "galactic-compute",
          }]),
        ],
      },
    ],
    [
      "retained enabled admission",
      {
        versions: [
          version(VERSION_ID, [{
            type: "plain_text",
            name: "COMPUTE_ENABLED",
            text: "1",
          }]),
        ],
      },
    ],
    [
      "retained malformed admission binding",
      {
        versions: [
          version(VERSION_ID, [{
            type: "secret_text",
            name: "COMPUTE_ENABLED",
          }]),
        ],
      },
    ],
    [
      "retained version without binding inventory",
      {
        versions: [{
          id: VERSION_ID,
          resources: {},
        }],
      },
    ],
  ]
) {
  test(`fails closed on ${name}`, () => {
    assert.throws(
      () => verify(overrides),
      /bootstrap history is invalid/u,
    );
  });
}
