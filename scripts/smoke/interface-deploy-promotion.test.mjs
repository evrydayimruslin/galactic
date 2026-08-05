import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  collectInterfaceDeploySourceFiles,
  INTERFACE_DEPLOY_SOURCE_EXTENSIONS,
} from "./interface-deploy-source-files.mjs";
import {
  computeRawSourceHash,
  fixtureRefreshPlan,
  nextFixtureVersion,
  promotionAction,
  reviewedPromotionConfig,
  reviewedFixtureProfile,
  validatePromotedComputeFixture,
  validateReviewedComputeManifest,
  validateReviewedComputeSource,
  validateReviewedFixtureIdentity,
  validateStagedPromotion,
} from "./interface-deploy-promotion.mjs";

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERSION = "1.4.3";
const SOURCE_HASH = "c".repeat(64);
const COMPUTE_FIXTURE_SOURCE = await readFile(
  new URL("../../examples/interface-demo/index.ts", import.meta.url),
  "utf8",
);
const CERTIFICATION_DOCUMENT = await readFile(
  new URL("../../examples/compute-certification/galactic.yaml", import.meta.url),
  "utf8",
);
const COMPUTE_AUTHORITY = {
  level: "read",
  effects: { "compute.execute": "free" },
};

test("reviewed Compute certification collection includes its V2 YAML contract", () => {
  const directory = fileURLToPath(
    new URL("../../examples/compute-certification/", import.meta.url),
  );
  const files = collectInterfaceDeploySourceFiles(directory);

  assert.ok(INTERFACE_DEPLOY_SOURCE_EXTENSIONS.includes(".yaml"));
  assert.deepEqual(
    files.map((file) => file.path),
    ["galactic.yaml", "index.ts"],
  );
  assert.equal(files[0].content, CERTIFICATION_DOCUMENT);
});
const CERTIFICATION_MANIFEST = {
  name: "Compute Certification",
  version: "1.0.0",
  description:
    "Private release-only Agent for certifying Galactic Compute admission and isolation.",
  type: "mcp",
  entry: { functions: "index.ts" },
  permissions: ["compute:exec"],
  compute: {
    profile: "developer-v1",
    tools: ["browser", "shell"],
    secrets: [],
  },
  functions: {
    fixture_identity: {
      description:
        "Returns deterministic fixture identity and scenario metadata without starting Compute.",
      parameters: {},
      returns: {
        type: "object",
        description: "Fixed certification fixture metadata",
      },
      authority: { level: "read", effects: {} },
    },
    run_compute_certification: {
      description:
        "Starts, reads, or cancels one fixed Galactic Compute certification scenario.",
      parameters: {
        action: {
          type: "string",
          description: "Closed operation: start, status, or cancel",
          required: true,
          enum: ["start", "status", "cancel"],
        },
        scenario: {
          type: "string",
          description: "Reviewed scenario id; required only for start",
          required: false,
          enum: [
            "sync_toolchain",
            "async_echo",
            "browser_https",
            "artifact_producer",
            "artifact_consumer",
            "exit_23",
            "timeout",
            "cancellable",
            "https_egress_boundaries",
            "raw_tcp_denied",
          ],
        },
        marker: {
          type: "string",
          description:
            "Canonical public release marker; accepted only by async_echo",
          required: false,
        },
        artifact_id: {
          type: "string",
          description:
            "Existing Compute artifact UUID; accepted only by artifact_consumer",
          required: false,
        },
        expected_sha256: {
          type: "string",
          description:
            "Expected lowercase SHA-256; accepted only by artifact_consumer",
          required: false,
        },
        run_id: {
          type: "string",
          description: "Compute run UUID; required only for status or cancel",
          required: false,
        },
      },
      returns: {
        type: "object",
        description:
          "Raw public Compute start, status, or cancellation projection",
      },
      authority: COMPUTE_AUTHORITY,
      spend: { compute: "free" },
      uses_compute: true,
    },
    run_compute_policy_probe: {
      description:
        "Starts one fixed bounded Compute probe for managed-routine policy certification.",
      parameters: {},
      returns: {
        type: "object",
        description: "Raw public Compute start projection",
      },
      authority: COMPUTE_AUTHORITY,
      spend: { compute: "free" },
      uses_compute: true,
    },
  },
  routines: [{
    id: "compute_policy_probe",
    label: "Compute policy certification",
    description:
      "Paused managed-routine target for certifying the Policy Pillar before Compute admission.",
    handler: "run_compute_policy_probe",
    default_schedule: { every_minutes: 60 },
    config_schema: {},
    default_config: {},
  }],
};
const MANIFEST = {
  permissions: ["compute:exec"],
  compute: {
    profile: "developer-v1",
    tools: ["shell"],
    secrets: [],
  },
  functions: {
    run_compute_smoke: { uses_compute: true },
  },
};

function reviewedArgs(overrides = {}) {
  return new Map(Object.entries({
    "--promote-reviewed": true,
    "--reviewed-permission": "compute:exec",
    "--reviewed-function": "run_compute_smoke",
    "--reviewed-compute-profile": "developer-v1",
    "--reviewed-compute-tools": "shell",
    "--reviewed-compute-secrets": "none",
    ...overrides,
  }));
}

function certificationArgs(overrides = {}) {
  return new Map(Object.entries({
    "--promote-reviewed": true,
    "--reviewed-fixture": "compute-certification",
    "--reviewed-permission": "compute:exec",
    "--reviewed-function": "run_compute_certification",
    "--reviewed-compute-profile": "developer-v1",
    "--reviewed-compute-tools": "browser,shell",
    "--reviewed-compute-secrets": "none",
    ...overrides,
  }));
}

function home({
  candidate = VERSION,
  live = VERSION,
  integrity = "verified",
  candidateSourceHash = SOURCE_HASH,
  liveSourceHash = SOURCE_HASH,
  candidateCount = candidate ? 1 : 0,
} = {}) {
  return {
    agent: { id: APP_ID },
    revision: "agent-home-v1:fixture",
    release: {
      candidate: candidate
        ? {
          version: candidate,
          canPromote: true,
          sourceFingerprint: candidateSourceHash,
        }
        : null,
      candidateCount,
      live: live
        ? {
          version: live,
          sourceFingerprint: liveSourceHash,
          executedVersion: live,
          integrity,
        }
        : null,
    },
  };
}

test("reviewed promotion requires every exact authority acknowledgement", () => {
  const config = reviewedPromotionConfig({
    args: reviewedArgs(),
    ownerAccessToken: "short-lived-owner-token",
    appId: APP_ID,
    allowCreate: false,
  });
  assert.equal(config.enabled, true);
  for (const [flag, value] of reviewedArgs()) {
    if (flag === "--promote-reviewed") continue;
    assert.throws(
      () =>
        reviewedPromotionConfig({
          args: reviewedArgs({ [flag]: `${value}-changed` }),
          ownerAccessToken: "short-lived-owner-token",
          appId: APP_ID,
          allowCreate: false,
        }),
      new RegExp(flag, "u"),
    );
  }
  assert.throws(
    () =>
      reviewedPromotionConfig({
        args: reviewedArgs(),
        ownerAccessToken: "",
        appId: APP_ID,
        allowCreate: false,
      }),
    /GALACTIC_OWNER_ACCESS_TOKEN/u,
  );
});

test("named certification promotion is closed over its exact directory and authority", () => {
  const config = reviewedPromotionConfig({
    args: certificationArgs(),
    ownerAccessToken: "short-lived-owner-token",
    appId: APP_ID,
    allowCreate: false,
    directory: "examples/compute-certification",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.fixture.name, "compute-certification");
  assert.deepEqual(config.fixture.tools, ["browser", "shell"]);
  assert.deepEqual(config.fixture.sourcePaths, ["galactic.yaml", "index.ts"]);
  assert.throws(
    () =>
      reviewedPromotionConfig({
        args: certificationArgs(),
        ownerAccessToken: "short-lived-owner-token",
        appId: APP_ID,
        allowCreate: false,
        directory: "examples/interface-demo",
      }),
    /requires --dir examples\/compute-certification/u,
  );
  assert.throws(
    () =>
      reviewedPromotionConfig({
        args: certificationArgs({ "--reviewed-compute-tools": "shell" }),
        ownerAccessToken: "short-lived-owner-token",
        appId: APP_ID,
        allowCreate: false,
        directory: "examples/compute-certification",
      }),
    /--reviewed-compute-tools/u,
  );
  assert.throws(() => reviewedFixtureProfile("caller-controlled"), /Unknown/u);
});

test("reviewed builder upload chooses above every retained version", () => {
  assert.equal(
    nextFixtureVersion({
      current_version: "1.0.0",
      versions: ["1.0.0", "1.4.2", "1.0.1", "not-semver"],
    }),
    VERSION,
  );
  assert.equal(nextFixtureVersion({ versions: [] }), "1.0.1");
});

test("raw source fingerprint matches the canonical path/content algorithm", () => {
  const files = [
    { path: "z.ts", content: "export const z = 1;" },
    { path: "manifest.json", content: "{}" },
  ];
  assert.equal(
    computeRawSourceHash(files),
    computeRawSourceHash([...files].reverse()),
  );
  assert.equal(
    computeRawSourceHash(files),
    "e519aaba0de640ad8768b7c6a95dcd0605dea18ad0983a0e959a11cb978f6b3d",
  );
  assert.notEqual(
    computeRawSourceHash(files),
    computeRawSourceHash([
      files[0],
      { path: "manifest.json", content: '{"changed":true}' },
    ]),
  );
});

test("Compute smoke fixture uses the scanner-safe direct echo command", () => {
  assert.match(COMPUTE_FIXTURE_SOURCE, /argv:\s*\[\s*"cat"\s*\]/u);
  assert.doesNotMatch(COMPUTE_FIXTURE_SOURCE, /node:fs|fs\.readFileSync/u);
});

test("refresh reuses exact live, promotes exact candidate, and never deletes full unrelated drafts", () => {
  const app = {
    id: APP_ID,
    current_version: "1.0.0",
    versions: ["1.0.0", "1.4.2"],
  };
  assert.deepEqual(
    fixtureRefreshPlan({
      app,
      home: home({ candidate: null, live: "1.0.0" }),
      appId: APP_ID,
      sourceHash: SOURCE_HASH,
    }),
    { action: "reuse_live", version: "1.0.0" },
  );
  assert.deepEqual(
    fixtureRefreshPlan({
      app,
      home: home({
        live: "1.0.0",
        liveSourceHash: "d".repeat(64),
      }),
      appId: APP_ID,
      sourceHash: SOURCE_HASH,
    }),
    { action: "promote_candidate", version: VERSION },
  );
  const unrelatedHome = home({
    live: "1.0.0",
    liveSourceHash: "d".repeat(64),
    candidateSourceHash: "e".repeat(64),
    candidateCount: 2,
  });
  assert.deepEqual(
    fixtureRefreshPlan({
      app,
      home: unrelatedHome,
      appId: APP_ID,
      sourceHash: SOURCE_HASH,
    }),
    { action: "upload", version: VERSION },
  );
  assert.throws(
    () =>
      fixtureRefreshPlan({
        app,
        home: { ...unrelatedHome, release: {
          ...unrelatedHome.release,
          candidateCount: 3,
        } },
        appId: APP_ID,
        sourceHash: SOURCE_HASH,
      }),
    /Refusing to delete or bypass owner drafts/u,
  );
});

test("reviewed manifest fails closed on extra authority, tools, or secrets", () => {
  assert.equal(validateReviewedComputeManifest(MANIFEST), MANIFEST);
  for (const manifest of [
    { ...MANIFEST, permissions: ["compute:exec", "net"] },
    { ...MANIFEST, compute: { ...MANIFEST.compute, tools: ["shell", "git"] } },
    { ...MANIFEST, compute: { ...MANIFEST.compute, secrets: ["API_KEY"] } },
    {
      ...MANIFEST,
      functions: { run_compute_smoke: { uses_compute: false } },
    },
  ]) {
    assert.throws(() => validateReviewedComputeManifest(manifest));
  }
});

test("certification contract, compiled manifest, and deterministic identity are exact", () => {
  assert.equal(
    validateReviewedComputeSource(
      CERTIFICATION_DOCUMENT,
      "compute-certification",
    ),
    CERTIFICATION_DOCUMENT,
  );
  assert.equal(
    validateReviewedComputeManifest(
      CERTIFICATION_MANIFEST,
      "compute-certification",
    ),
    CERTIFICATION_MANIFEST,
  );
  const identity = {
    fixture: "galactic-compute-certification",
    schema_version: 1,
    scenarios: [
      "sync_toolchain",
      "async_echo",
      "browser_https",
      "artifact_producer",
      "artifact_consumer",
      "exit_23",
      "timeout",
      "cancellable",
      "https_egress_boundaries",
      "raw_tcp_denied",
    ],
    deterministic_artifact_sha256:
      "6ad9b8ea5280658dc4b229a2b6180d530c4d3824b541d218266ea6049e8b763b",
  };
  assert.equal(
    validateReviewedFixtureIdentity(identity, "compute-certification"),
    identity,
  );
  assert.throws(
    () =>
      validateReviewedComputeSource(
        `${CERTIFICATION_DOCUMENT}\n# unreviewed drift\n`,
        "compute-certification",
      ),
    /galactic\.yaml content drifted/u,
  );
  assert.throws(
    () =>
      validateReviewedComputeManifest({
        ...CERTIFICATION_MANIFEST,
        routines: [{ ...CERTIFICATION_MANIFEST.routines[0], handler: "other" }],
      }, "compute-certification"),
    /routine declaration drifted/u,
  );
  assert.throws(
    () =>
      validateReviewedComputeManifest({
        ...CERTIFICATION_MANIFEST,
        description: "Different reviewed fixture",
      }, "compute-certification"),
    /manifest content drifted/u,
  );
  assert.throws(
    () =>
      validateReviewedFixtureIdentity(
        { ...identity, scenarios: [] },
        "compute-certification",
      ),
    /identity scenarios/u,
  );
});

test("promotion is bound to the exact staged tested candidate", () => {
  const snapshot = home({ live: "1.0.0" });
  assert.equal(
    validateStagedPromotion({
      upload: {
        app_id: APP_ID,
        version: VERSION,
        live_version: "1.0.0",
        is_live: false,
      },
      home: snapshot,
      appId: APP_ID,
      version: VERSION,
      sourceHash: SOURCE_HASH,
    }),
    snapshot,
  );
  assert.deepEqual(promotionAction(snapshot, VERSION, ACTION_ID), {
    action: "promote_candidate",
    expectedRevision: snapshot.revision,
    idempotencyKey: ACTION_ID,
    version: VERSION,
  });
  assert.throws(() =>
    validateStagedPromotion({
      upload: {
        app_id: APP_ID,
        version: VERSION,
        live_version: VERSION,
        is_live: true,
      },
      home: snapshot,
      appId: APP_ID,
      version: VERSION,
    })
  );
});

test("postcondition proves live executable, function, and disabled ceiling", () => {
  const base = {
    app: {
      id: APP_ID,
      visibility: "private",
      current_version: VERSION,
      manifest: JSON.stringify(MANIFEST),
      exports: ["get_greeting", "run_compute_smoke"],
    },
    home: home({ candidate: null }),
    functions: {
      agent: { id: APP_ID },
      functions: [{ name: "run_compute_smoke" }],
    },
    settings: {
      settings: {
        enabled: false,
        manifestCeiling: {
          enabled: true,
          profile: "developer-v1",
          tools: ["shell"],
          secrets: [],
        },
      },
    },
    appId: APP_ID,
    version: VERSION,
    sourceHash: SOURCE_HASH,
  };
  assert.doesNotThrow(() => validatePromotedComputeFixture(base));
  assert.throws(() =>
    validatePromotedComputeFixture({
      ...base,
      settings: {
        settings: {
          ...base.settings.settings,
          enabled: true,
        },
      },
    })
  );
  assert.throws(() =>
    validatePromotedComputeFixture({
      ...base,
      home: home({ candidate: null, integrity: "unverified" }),
    })
  );
});

test("certification postcondition binds exact exports, ceiling, and identity", () => {
  const identity = {
    fixture: "galactic-compute-certification",
    schema_version: 1,
    scenarios: [
      "sync_toolchain",
      "async_echo",
      "browser_https",
      "artifact_producer",
      "artifact_consumer",
      "exit_23",
      "timeout",
      "cancellable",
      "https_egress_boundaries",
      "raw_tcp_denied",
    ],
    deterministic_artifact_sha256:
      "6ad9b8ea5280658dc4b229a2b6180d530c4d3824b541d218266ea6049e8b763b",
  };
  const exports = [
    "fixture_identity",
    "run_compute_certification",
    "run_compute_policy_probe",
  ];
  const base = {
    app: {
      id: APP_ID,
      visibility: "private",
      current_version: VERSION,
      manifest: CERTIFICATION_MANIFEST,
      exports,
    },
    home: home({ candidate: null }),
    functions: {
      agent: { id: APP_ID },
      functions: exports.map((name) => ({ name })),
    },
    settings: {
      settings: {
        enabled: false,
        manifestCeiling: {
          enabled: true,
          profile: "developer-v1",
          tools: ["browser", "shell"],
          secrets: [],
        },
      },
    },
    appId: APP_ID,
    version: VERSION,
    sourceHash: SOURCE_HASH,
    fixtureName: "compute-certification",
    identity,
  };
  assert.doesNotThrow(() => validatePromotedComputeFixture(base));
  assert.throws(() =>
    validatePromotedComputeFixture({
      ...base,
      app: { ...base.app, exports: exports.slice(1) },
    }),
  /export list/u);
  assert.throws(() =>
    validatePromotedComputeFixture({
      ...base,
      identity: { ...identity, deterministic_artifact_sha256: "0".repeat(64) },
    }),
  /identity drifted/u);
});
