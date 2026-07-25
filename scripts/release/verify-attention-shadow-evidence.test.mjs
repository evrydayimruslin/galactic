import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  AttentionShadowEvidenceError,
  verifyAttentionShadowEvidence,
} from "./verify-attention-shadow-evidence.mjs";

const WORKER = "ultralight-api-staging";
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const SHA = "a".repeat(40);
const VERSION_TAG = `api-${SHA}`;
const SECRET_SENTINEL = "super-secret-never-copy";

function comparison({
  surface = "account",
  status = "match",
  reasons = [],
  fallbackReason = null,
  mode = "shadow",
  source = "legacy",
  legacy = {},
  canonical = {},
  ...overrides
} = {}) {
  return {
    event: "operator_attention_read_comparison",
    surface,
    mode,
    source,
    status,
    reasons,
    fallbackReason,
    legacy: {
      openCount: 1,
      requiresDecisionCount: 0,
      mappedConditions: 1,
      unmappedConditions: 0,
      ...legacy,
    },
    canonical: {
      openCount: 1,
      requiresDecisionCount: 0,
      mappedConditionProjections: 1,
      canonicalOnlyConditions: 0,
      ...canonical,
    },
    ...overrides,
  };
}

function envelope(telemetry, {
  timestamp = 1_721_920_000_000,
  logs = [],
  ...overrides
} = {}) {
  return {
    event: {
      request: {
        method: "GET",
        url: `https://staging.example.invalid/private?token=${SECRET_SENTINEL}`,
        headers: {
          authorization: `Bearer ${SECRET_SENTINEL}`,
        },
      },
      response: { status: 200 },
    },
    eventTimestamp: timestamp,
    logs: [
      {
        level: "info",
        message: [telemetry],
        timestamp,
      },
      {
        level: "log",
        message: [`unrelated=${SECRET_SENTINEL}`],
        timestamp,
      },
      ...logs,
    ],
    exceptions: [],
    diagnosticsChannelEvents: [],
    scriptName: WORKER,
    scriptVersion: {
      id: VERSION_ID,
      tag: VERSION_TAG,
      message: SECRET_SENTINEL,
    },
    outcome: "ok",
    executionModel: "stateless",
    truncated: false,
    cpuTime: 1,
    wallTime: 2,
    ...overrides,
  };
}

function capture(...values) {
  return values.map((value) => JSON.stringify(value, null, 4)).join("\n");
}

function options(overrides = {}) {
  return {
    expectedWorker: WORKER,
    expectedVersionId: VERSION_ID.toUpperCase(),
    expectedVersionTag: VERSION_TAG,
    ...overrides,
  };
}

function assertInvalid(input, expectedCode, verifierOptions = options()) {
  assert.throws(
    () => verifyAttentionShadowEvidence(input, verifierOptions),
    (error) =>
      error instanceof AttentionShadowEvidenceError &&
      error.code === expectedCode,
  );
}

test("sanitizes valid Wrangler JSON sequence evidence for both surfaces", () => {
  const account = envelope(comparison(), {
    timestamp: 1_721_920_000_000,
  });
  const agent = envelope(comparison({
    surface: "agent",
    status: "expected_difference",
    reasons: [
      "canonical_only_expected",
      "legacy_unmapped_expected",
      "aggregate_count_difference",
      "decision_semantics_expected",
    ],
    legacy: {
      openCount: 2,
      requiresDecisionCount: 1,
      unmappedConditions: 1,
    },
    canonical: {
      openCount: 3,
      requiresDecisionCount: 2,
      canonicalOnlyConditions: 2,
    },
  }), {
    timestamp: 1_721_920_001_000,
  });
  const evidence = verifyAttentionShadowEvidence(
    capture(account, agent),
    options(),
  );

  assert.equal(evidence.verified, true);
  assert.deepEqual(evidence.deployment, {
    worker: WORKER,
    version_id: VERSION_ID,
    version_tag: VERSION_TAG,
    git_sha: SHA,
  });
  assert.deepEqual(evidence.window, {
    first_event_timestamp: 1_721_920_000_000,
    last_event_timestamp: 1_721_920_001_000,
  });
  assert.equal(evidence.bounds.tail_events_examined, 2);
  assert.equal(evidence.bounds.telemetry_samples_examined, 2);
  assert.equal(evidence.surfaces.account.sample_count, 1);
  assert.equal(evidence.surfaces.account.statuses.match, 1);
  assert.equal(evidence.surfaces.agent.sample_count, 1);
  assert.equal(evidence.surfaces.agent.statuses.expected_difference, 1);
  assert.deepEqual(evidence.surfaces.agent.reasons, {
    canonical_only_expected: 1,
    legacy_unmapped_expected: 1,
    aggregate_count_difference: 1,
    decision_semantics_expected: 1,
  });
  assert.deepEqual(evidence.surfaces.agent.aggregate_counts, {
    legacy_open: 2,
    canonical_open: 3,
    legacy_requires_decision: 1,
    canonical_requires_decision: 2,
    legacy_mapped_conditions: 1,
    canonical_mapped_condition_projections: 1,
    legacy_unmapped_conditions: 1,
    canonical_only_conditions: 2,
  });
  assert.equal(JSON.stringify(evidence).includes(SECRET_SENTINEL), false);
  assert.equal(JSON.stringify(evidence).includes("authorization"), false);
  assert.equal(JSON.stringify(evidence).includes("private?token"), false);
});

test("ignores unrelated structured logs without copying them", () => {
  const unrelated = envelope(comparison(), {
    timestamp: 1_721_920_000_000,
    logs: [{
      level: "info",
      message: [{
        event: "another_event",
        private: SECRET_SENTINEL,
      }],
      timestamp: 1_721_920_000_000,
    }],
  });
  const evidence = verifyAttentionShadowEvidence(
    capture(unrelated, envelope(comparison({ surface: "agent" }))),
    options(),
  );
  assert.equal(evidence.bounds.telemetry_samples_examined, 2);
  assert.equal(JSON.stringify(evidence).includes(SECRET_SENTINEL), false);
});

test("supports repeat requirements while aggregating only safe counters", () => {
  const values = [
    envelope(comparison({ surface: "account" })),
    envelope(comparison({ surface: "account" })),
    envelope(comparison({ surface: "agent" })),
    envelope(comparison({ surface: "agent" })),
  ];
  const evidence = verifyAttentionShadowEvidence(
    capture(...values),
    options({ minSamplesPerSurface: 2 }),
  );
  assert.equal(evidence.surfaces.account.sample_count, 2);
  assert.equal(evidence.surfaces.agent.sample_count, 2);
});

test("requires both account and Agent surface coverage", () => {
  assertInvalid(
    capture(envelope(comparison())),
    "INSUFFICIENT_SURFACE_COVERAGE",
  );
});

for (
  const [name, overrides] of [
    ["wrong Worker", { scriptName: "other-worker" }],
    [
      "wrong version ID",
      {
        scriptVersion: {
          id: "22222222-2222-4222-8222-222222222222",
          tag: VERSION_TAG,
        },
      },
    ],
    [
      "wrong version tag",
      {
        scriptVersion: {
          id: VERSION_ID,
          tag: `api-${"b".repeat(40)}`,
        },
      },
    ],
  ]
) {
  test(`rejects a ${name} deployment fence`, () => {
    assertInvalid(
      capture(
        envelope(comparison(), overrides),
        envelope(comparison({ surface: "agent" })),
      ),
      "DEPLOYMENT_FENCE_MISMATCH",
    );
  });
}

for (
  const [name, telemetry, code] of [
    [
      "canonical source",
      comparison({ source: "canonical" }),
      "UNSAFE_READ_SELECTION",
    ],
    [
      "canonical mode",
      comparison({ mode: "canonical" }),
      "UNSAFE_READ_SELECTION",
    ],
    [
      "fallback",
      comparison({ fallbackReason: "canonical_read_failed" }),
      "READ_FALLBACK",
    ],
    [
      "drift",
      comparison({
        status: "drift",
        reasons: ["mapped_condition_missing_canonical"],
      }),
      "UNHEALTHY_COMPARISON",
    ],
    [
      "unavailable source",
      comparison({
        status: "unavailable",
        reasons: ["canonical_unavailable"],
      }),
      "UNHEALTHY_COMPARISON",
    ],
    [
      "skipped item comparison",
      comparison({
        status: "expected_difference",
        reasons: ["page_item_comparison_skipped"],
      }),
      "UNPROVEN_PARITY",
    ],
    [
      "unknown reason",
      comparison({
        status: "expected_difference",
        reasons: ["new_reason"],
      }),
      "UNKNOWN_REASON",
    ],
    [
      "mapped total mismatch",
      comparison({
        canonical: { mappedConditionProjections: 0 },
      }),
      "MAPPED_COUNT_MISMATCH",
    ],
    [
      "unknown field",
      comparison({ privateDiagnostic: SECRET_SENTINEL }),
      "UNKNOWN_TELEMETRY_SCHEMA",
    ],
  ]
) {
  test(`fails closed on ${name}`, () => {
    assertInvalid(
      capture(
        envelope(telemetry),
        envelope(comparison({ surface: "agent" })),
      ),
      code,
    );
  });
}

test("fails closed on an unknown Attention read telemetry event", () => {
  const unknown = envelope(comparison());
  unknown.logs[0].message[0].event = "operator_attention_read_v2";
  assertInvalid(
    capture(unknown, envelope(comparison({ surface: "agent" }))),
    "UNKNOWN_ATTENTION_TELEMETRY",
  );
});

test("rejects string-encoded telemetry instead of parsing arbitrary logs", () => {
  const stringEncoded = envelope(comparison());
  stringEncoded.logs[0].message = [
    `{"event":"operator_attention_read_comparison","secret":"${SECRET_SENTINEL}"}`,
  ];
  assertInvalid(
    capture(
      stringEncoded,
      envelope(comparison({ surface: "agent" })),
    ),
    "STRING_ENCODED_TELEMETRY",
  );
});

test("rejects unsuccessful, exceptional, or truncated comparison traces", () => {
  for (const overrides of [
    { outcome: "exception" },
    { exceptions: [{ message: SECRET_SENTINEL }] },
    { truncated: true },
  ]) {
    assertInvalid(
      capture(
        envelope(comparison(), overrides),
        envelope(comparison({ surface: "agent" })),
      ),
      "UNHEALTHY_TRACE",
    );
  }
});

test("enforces capture byte, event, and telemetry bounds", () => {
  const valid = capture(
    envelope(comparison()),
    envelope(comparison({ surface: "agent" })),
  );
  assertInvalid(valid, "INPUT_TOO_LARGE", options({ maxInputBytes: 10 }));
  assertInvalid(valid, "TOO_MANY_EVENTS", options({ maxTailEvents: 1 }));
  assertInvalid(
    valid,
    "IMPOSSIBLE_SAMPLE_BOUND",
    options({ maxTelemetrySamples: 1 }),
  );
});

for (const malformed of [
  "not json",
  '{"logs":[]',
  "[]",
  `${JSON.stringify({ logs: [] })}\nnot-json`,
]) {
  test("fails closed on malformed Wrangler stream input", () => {
    assertInvalid(malformed, "MALFORMED_STREAM");
  });
}

test("CLI emits only sanitized JSON and succeeds on stdin", () => {
  const input = capture(
    envelope(comparison()),
    envelope(comparison({ surface: "agent" })),
  );
  const result = spawnSync(
    process.execPath,
    [
      new URL("./verify-attention-shadow-evidence.mjs", import.meta.url)
        .pathname,
      "--expected-worker",
      WORKER,
      "--expected-version-id",
      VERSION_ID,
      "--expected-version-tag",
      VERSION_TAG,
    ],
    {
      encoding: "utf8",
      input,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(SECRET_SENTINEL), false);
  assert.equal(JSON.parse(result.stdout).verified, true);
});

test("CLI failure output never echoes captured secrets", () => {
  const result = spawnSync(
    process.execPath,
    [
      new URL("./verify-attention-shadow-evidence.mjs", import.meta.url)
        .pathname,
      "--expected-worker",
      WORKER,
      "--expected-version-id",
      VERSION_ID,
      "--expected-version-tag",
      VERSION_TAG,
    ],
    {
      encoding: "utf8",
      input: `not-json-${SECRET_SENTINEL}`,
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes(SECRET_SENTINEL), false);
  assert.match(result.stderr, /MALFORMED_STREAM/u);
});
