#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EVIDENCE_EVENT = "operator_attention_read_comparison";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const API_VERSION_TAG = /^api-([0-9a-f]{40})$/u;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TAIL_EVENTS = 1_000;
const DEFAULT_MAX_TELEMETRY_SAMPLES = 200;

const TELEMETRY_KEYS = [
  "canonical",
  "canonicalFailureStage",
  "event",
  "fallbackReason",
  "legacy",
  "mode",
  "reasons",
  "source",
  "status",
  "surface",
];
const CANONICAL_FAILURE_STAGES = new Set([
  "reader_not_configured",
  "request_invalid",
  "rpc_read_failed",
  "rpc_response_invalid",
  "entry_shape_invalid",
  "item_identity_invalid",
  "item_class_invalid",
  "item_severity_invalid",
  "item_fanout_invalid",
  "item_scope_invalid",
  "item_diagnosis_invalid",
  "item_evidence_invalid",
  "item_remediation_invalid",
  "item_ordering_invalid",
  "item_recovery_invalid",
  "item_attention_state_invalid",
  "cursor_invalid",
  "agent_counts_invalid",
  "aggregate_counts_invalid",
  "unknown",
]);
const LEGACY_KEYS = [
  "mappedConditions",
  "openCount",
  "requiresDecisionCount",
  "unmappedConditions",
];
const CANONICAL_KEYS = [
  "canonicalOnlyConditions",
  "mappedConditionProjections",
  "openCount",
  "requiresDecisionCount",
];
const ALLOWED_REASONS = new Set([
  "aggregate_count_difference",
  "canonical_only_expected",
  "decision_semantics_expected",
  "legacy_unmapped_expected",
]);
const REJECTED_REASONS = new Set([
  "canonical_unavailable",
  "legacy_unavailable",
  "mapped_condition_missing_canonical",
  "mapped_condition_missing_legacy",
  "page_item_comparison_skipped",
]);

const REASON_OUTPUT_KEYS = {
  aggregate_count_difference: "aggregate_count_difference",
  canonical_only_expected: "canonical_only_expected",
  decision_semantics_expected: "decision_semantics_expected",
  legacy_unmapped_expected: "legacy_unmapped_expected",
};

export class AttentionShadowEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AttentionShadowEvidenceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new AttentionShadowEvidenceError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function boundedPositiveInteger(value, fallback, code) {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > 50_000_000
  ) {
    fail(code, "A verifier bound is invalid.");
  }
  return candidate;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function addCount(current, addition) {
  const result = current + addition;
  if (!Number.isSafeInteger(result)) {
    fail("COUNT_OVERFLOW", "Telemetry counters exceed the safe evidence range.");
  }
  return result;
}

function decodeInput(input, maxInputBytes) {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > maxInputBytes) {
      fail("INPUT_TOO_LARGE", "The tail capture exceeds the input bound.");
    }
    return input;
  }
  if (!(input instanceof Uint8Array)) {
    fail("INVALID_INPUT", "The tail capture must be UTF-8 text.");
  }
  if (input.byteLength > maxInputBytes) {
    fail("INPUT_TOO_LARGE", "The tail capture exceeds the input bound.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    fail("INVALID_UTF8", "The tail capture is not valid UTF-8.");
  }
}

/**
 * Wrangler 4 JSON tail output is a whitespace-separated sequence of
 * pretty-printed JSON objects, not NDJSON. Decode that bounded sequence
 * without ever echoing raw input into an error or evidence artifact.
 */
function parseJsonObjectSequence(text, maxTailEvents) {
  const values = [];
  let cursor = 0;

  while (cursor < text.length) {
    while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
    if (cursor === text.length) break;
    if (text[cursor] !== "{") {
      fail(
        "MALFORMED_STREAM",
        "The tail capture is not a Wrangler JSON object sequence.",
      );
    }

    const start = cursor;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{" || character === "[") {
        depth += 1;
      } else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth < 0) {
          fail("MALFORMED_STREAM", "The tail capture has invalid JSON.");
        }
        if (depth === 0) {
          cursor += 1;
          break;
        }
      }
    }
    if (inString || depth !== 0) {
      fail("MALFORMED_STREAM", "The tail capture has incomplete JSON.");
    }

    let value;
    try {
      value = JSON.parse(text.slice(start, cursor));
    } catch {
      fail("MALFORMED_STREAM", "The tail capture has invalid JSON.");
    }
    if (!isRecord(value)) {
      fail("MALFORMED_ENVELOPE", "A tail event is not a JSON object.");
    }
    values.push(value);
    if (values.length > maxTailEvents) {
      fail("TOO_MANY_EVENTS", "The tail capture exceeds the event bound.");
    }
  }
  return values;
}

function candidateMessage(log) {
  if (!isRecord(log) || !Array.isArray(log.message)) return null;
  for (const value of log.message) {
    if (
      typeof value === "string" &&
      value.includes(EVIDENCE_EVENT)
    ) {
      fail(
        "STRING_ENCODED_TELEMETRY",
        "Comparison telemetry must be emitted as one structured object.",
      );
    }
    if (!isRecord(value) || !Object.hasOwn(value, "event")) continue;
    if (value.event === EVIDENCE_EVENT) {
      if (
        log.level !== "info" ||
        log.message.length !== 1 ||
        log.message[0] !== value
      ) {
        fail(
          "MALFORMED_TELEMETRY_LOG",
          "Comparison telemetry must be one structured info argument.",
        );
      }
      return value;
    }
    if (
      typeof value.event === "string" &&
      value.event.startsWith("operator_attention_read_")
    ) {
      fail(
        "UNKNOWN_ATTENTION_TELEMETRY",
        "The capture contains an unknown Attention read telemetry event.",
      );
    }
  }
  return null;
}

function validateDeploymentFence(
  envelope,
  expectedWorker,
  expectedVersionId,
  expectedVersionTag,
) {
  if (
    envelope.scriptName !== expectedWorker ||
    !isRecord(envelope.scriptVersion) ||
    typeof envelope.scriptVersion.id !== "string" ||
    envelope.scriptVersion.id.toLowerCase() !== expectedVersionId ||
    envelope.scriptVersion.tag !== expectedVersionTag
  ) {
    fail(
      "DEPLOYMENT_FENCE_MISMATCH",
      "Comparison telemetry did not originate from the fenced deployment.",
    );
  }
  if (
    envelope.outcome !== "ok" ||
    envelope.truncated !== false ||
    !Array.isArray(envelope.exceptions) ||
    envelope.exceptions.length !== 0 ||
    !nonNegativeInteger(envelope.eventTimestamp)
  ) {
    fail(
      "UNHEALTHY_TRACE",
      "Comparison telemetry came from an incomplete or unsuccessful trace.",
    );
  }
  return envelope.eventTimestamp;
}

function validateComparison(value) {
  if (!hasExactKeys(value, TELEMETRY_KEYS)) {
    fail(
      "UNKNOWN_TELEMETRY_SCHEMA",
      "Comparison telemetry does not match the allowlisted schema.",
    );
  }
  if (
    value.surface !== "account" &&
    value.surface !== "agent"
  ) {
    fail("UNKNOWN_SURFACE", "Comparison telemetry has an unknown surface.");
  }
  if (value.mode !== "shadow" || value.source !== "legacy") {
    fail(
      "UNSAFE_READ_SELECTION",
      "Comparison telemetry is not a shadow read served by legacy.",
    );
  }
  if (
    value.canonicalFailureStage !== null &&
    !CANONICAL_FAILURE_STAGES.has(value.canonicalFailureStage)
  ) {
    fail(
      "UNKNOWN_CANONICAL_FAILURE_STAGE",
      "Comparison telemetry has an unknown canonical failure stage.",
    );
  }
  if (value.fallbackReason !== null) {
    fail(
      "READ_FALLBACK",
      value.canonicalFailureStage === null
        ? "Comparison telemetry reports a read fallback."
        : `Comparison telemetry reports a read fallback at the allowlisted ${value.canonicalFailureStage} stage.`,
    );
  }
  if (value.canonicalFailureStage !== null) {
    fail(
      "UNEXPECTED_CANONICAL_FAILURE_STAGE",
      "Healthy comparison telemetry cannot contain a canonical failure stage.",
    );
  }
  if (value.status !== "match" && value.status !== "expected_difference") {
    if (value.status === "drift" || value.status === "unavailable") {
      fail(
        "UNHEALTHY_COMPARISON",
        "Comparison telemetry reports drift or unavailable data.",
      );
    }
    fail(
      "UNKNOWN_COMPARISON_STATUS",
      "Comparison telemetry has an unknown status.",
    );
  }
  if (!Array.isArray(value.reasons)) {
    fail("UNKNOWN_REASON", "Comparison reasons are not an allowlisted array.");
  }
  const reasons = new Set();
  for (const reason of value.reasons) {
    if (typeof reason !== "string") {
      fail("UNKNOWN_REASON", "Comparison telemetry has an unknown reason.");
    }
    if (REJECTED_REASONS.has(reason)) {
      fail(
        "UNPROVEN_PARITY",
        "Comparison telemetry does not prove mapped-condition parity.",
      );
    }
    if (!ALLOWED_REASONS.has(reason)) {
      fail("UNKNOWN_REASON", "Comparison telemetry has an unknown reason.");
    }
    if (reasons.has(reason)) {
      fail("DUPLICATE_REASON", "Comparison telemetry repeats a reason.");
    }
    reasons.add(reason);
  }
  if (
    (value.status === "match" && reasons.size !== 0) ||
    (value.status === "expected_difference" && reasons.size === 0)
  ) {
    fail(
      "INCONSISTENT_STATUS",
      "Comparison status and reasons are inconsistent.",
    );
  }

  if (
    !hasExactKeys(value.legacy, LEGACY_KEYS) ||
    !hasExactKeys(value.canonical, CANONICAL_KEYS)
  ) {
    fail(
      "UNKNOWN_COUNTER_SCHEMA",
      "Comparison counters do not match the allowlisted schema.",
    );
  }
  for (const count of [
    ...Object.values(value.legacy),
    ...Object.values(value.canonical),
  ]) {
    if (!nonNegativeInteger(count)) {
      fail(
        "INVALID_COUNTER",
        "Comparison telemetry has an invalid counter.",
      );
    }
  }
  if (
    value.legacy.mappedConditions !==
      value.canonical.mappedConditionProjections
  ) {
    fail(
      "MAPPED_COUNT_MISMATCH",
      "Mapped-condition projection totals do not match.",
    );
  }

  return {
    surface: value.surface,
    status: value.status,
    reasons,
    legacy: value.legacy,
    canonical: value.canonical,
  };
}

function emptySurface() {
  return {
    sample_count: 0,
    statuses: {
      match: 0,
      expected_difference: 0,
    },
    reasons: {
      canonical_only_expected: 0,
      legacy_unmapped_expected: 0,
      aggregate_count_difference: 0,
      decision_semantics_expected: 0,
    },
    aggregate_counts: {
      legacy_open: 0,
      canonical_open: 0,
      legacy_requires_decision: 0,
      canonical_requires_decision: 0,
      legacy_mapped_conditions: 0,
      canonical_mapped_condition_projections: 0,
      legacy_unmapped_conditions: 0,
      canonical_only_conditions: 0,
    },
  };
}

function addComparison(surface, comparison) {
  surface.sample_count = addCount(surface.sample_count, 1);
  surface.statuses[comparison.status] = addCount(
    surface.statuses[comparison.status],
    1,
  );
  for (const reason of comparison.reasons) {
    const outputKey = REASON_OUTPUT_KEYS[reason];
    surface.reasons[outputKey] = addCount(surface.reasons[outputKey], 1);
  }
  const totals = surface.aggregate_counts;
  totals.legacy_open = addCount(
    totals.legacy_open,
    comparison.legacy.openCount,
  );
  totals.canonical_open = addCount(
    totals.canonical_open,
    comparison.canonical.openCount,
  );
  totals.legacy_requires_decision = addCount(
    totals.legacy_requires_decision,
    comparison.legacy.requiresDecisionCount,
  );
  totals.canonical_requires_decision = addCount(
    totals.canonical_requires_decision,
    comparison.canonical.requiresDecisionCount,
  );
  totals.legacy_mapped_conditions = addCount(
    totals.legacy_mapped_conditions,
    comparison.legacy.mappedConditions,
  );
  totals.canonical_mapped_condition_projections = addCount(
    totals.canonical_mapped_condition_projections,
    comparison.canonical.mappedConditionProjections,
  );
  totals.legacy_unmapped_conditions = addCount(
    totals.legacy_unmapped_conditions,
    comparison.legacy.unmappedConditions,
  );
  totals.canonical_only_conditions = addCount(
    totals.canonical_only_conditions,
    comparison.canonical.canonicalOnlyConditions,
  );
}

/**
 * Verifies and sanitizes a bounded Wrangler JSON tail capture.
 *
 * Only comparison aggregates, deployment-fence identifiers, and timestamps
 * survive. Request URLs, account/Agent identifiers, arbitrary logs, exception
 * bodies, and raw telemetry are never copied into the returned evidence.
 */
export function verifyAttentionShadowEvidence(input, options) {
  if (!isRecord(options)) {
    fail("INVALID_OPTIONS", "Verifier options are required.");
  }
  const {
    expectedWorker,
    expectedVersionId: rawExpectedVersionId,
    expectedVersionTag,
  } = options;
  if (
    typeof expectedWorker !== "string" ||
    !WORKER_NAME.test(expectedWorker) ||
    typeof rawExpectedVersionId !== "string" ||
    !UUID.test(rawExpectedVersionId) ||
    typeof expectedVersionTag !== "string" ||
    !API_VERSION_TAG.test(expectedVersionTag)
  ) {
    fail(
      "INVALID_DEPLOYMENT_FENCE",
      "The expected deployment fence is invalid.",
    );
  }
  const expectedVersionId = rawExpectedVersionId.toLowerCase();
  const minSamplesPerSurface = boundedPositiveInteger(
    options.minSamplesPerSurface,
    1,
    "INVALID_MINIMUM",
  );
  const maxInputBytes = boundedPositiveInteger(
    options.maxInputBytes,
    DEFAULT_MAX_INPUT_BYTES,
    "INVALID_INPUT_BOUND",
  );
  const maxTailEvents = boundedPositiveInteger(
    options.maxTailEvents,
    DEFAULT_MAX_TAIL_EVENTS,
    "INVALID_EVENT_BOUND",
  );
  const maxTelemetrySamples = boundedPositiveInteger(
    options.maxTelemetrySamples,
    DEFAULT_MAX_TELEMETRY_SAMPLES,
    "INVALID_SAMPLE_BOUND",
  );
  if (minSamplesPerSurface * 2 > maxTelemetrySamples) {
    fail(
      "IMPOSSIBLE_SAMPLE_BOUND",
      "The sample minimum exceeds the telemetry bound.",
    );
  }

  const text = decodeInput(input, maxInputBytes);
  const envelopes = parseJsonObjectSequence(text, maxTailEvents);
  const surfaces = {
    account: emptySurface(),
    agent: emptySurface(),
  };
  let telemetrySamples = 0;
  let firstEventTimestamp = null;
  let lastEventTimestamp = null;

  for (const envelope of envelopes) {
    if (!Array.isArray(envelope.logs)) {
      fail("MALFORMED_ENVELOPE", "A tail event is missing structured logs.");
    }
    for (const log of envelope.logs) {
      const candidate = candidateMessage(log);
      if (!candidate) continue;
      telemetrySamples += 1;
      if (telemetrySamples > maxTelemetrySamples) {
        fail(
          "TOO_MANY_SAMPLES",
          "The capture exceeds the telemetry sample bound.",
        );
      }
      const timestamp = validateDeploymentFence(
        envelope,
        expectedWorker,
        expectedVersionId,
        expectedVersionTag,
      );
      const comparison = validateComparison(candidate);
      addComparison(surfaces[comparison.surface], comparison);
      firstEventTimestamp = firstEventTimestamp === null
        ? timestamp
        : Math.min(firstEventTimestamp, timestamp);
      lastEventTimestamp = lastEventTimestamp === null
        ? timestamp
        : Math.max(lastEventTimestamp, timestamp);
    }
  }

  if (
    surfaces.account.sample_count < minSamplesPerSurface ||
    surfaces.agent.sample_count < minSamplesPerSurface
  ) {
    fail(
      "INSUFFICIENT_SURFACE_COVERAGE",
      "Both account and Agent surfaces need enough comparison samples.",
    );
  }

  const versionTagMatch = API_VERSION_TAG.exec(expectedVersionTag);
  return {
    schema_version: 1,
    evidence_type: "operator_attention_shadow_parity",
    verified: true,
    deployment: {
      worker: expectedWorker,
      version_id: expectedVersionId,
      version_tag: expectedVersionTag,
      git_sha: versionTagMatch[1],
    },
    bounds: {
      input_bytes: Buffer.byteLength(text, "utf8"),
      tail_events_examined: envelopes.length,
      telemetry_samples_examined: telemetrySamples,
      min_samples_per_surface: minSamplesPerSurface,
    },
    window: {
      first_event_timestamp: firstEventTimestamp,
      last_event_timestamp: lastEventTimestamp,
    },
    surfaces,
  };
}

function positiveCliInteger(raw) {
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    fail("INVALID_CLI_ARGUMENT", "A numeric CLI argument is invalid.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    fail("INVALID_CLI_ARGUMENT", "A numeric CLI argument is invalid.");
  }
  return value;
}

function parseCliArgs(argv) {
  const parsed = {};
  const known = new Set([
    "--expected-version-id",
    "--expected-version-tag",
    "--expected-worker",
    "--input",
    "--min-samples-per-surface",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !known.has(key) ||
      value === undefined ||
      Object.hasOwn(parsed, key)
    ) {
      fail("INVALID_CLI_ARGUMENT", "CLI arguments are invalid.");
    }
    parsed[key] = value;
  }
  if (
    !parsed["--expected-worker"] ||
    !parsed["--expected-version-id"] ||
    !parsed["--expected-version-tag"]
  ) {
    fail("MISSING_CLI_ARGUMENT", "The deployment fence is required.");
  }
  return {
    inputPath: parsed["--input"] ?? "-",
    expectedWorker: parsed["--expected-worker"],
    expectedVersionId: parsed["--expected-version-id"],
    expectedVersionTag: parsed["--expected-version-tag"],
    minSamplesPerSurface: parsed["--min-samples-per-surface"]
      ? positiveCliInteger(parsed["--min-samples-per-surface"])
      : 1,
  };
}

function main(argv) {
  const options = parseCliArgs(argv);
  let input;
  try {
    input = readFileSync(options.inputPath === "-" ? 0 : resolve(options.inputPath));
  } catch {
    fail("INPUT_READ_FAILED", "The tail capture could not be read.");
  }
  const evidence = verifyAttentionShadowEvidence(input, options);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof AttentionShadowEvidenceError) {
      console.error(
        `Attention shadow evidence is invalid [${error.code}]: ${error.message}`,
      );
    } else {
      console.error("Attention shadow evidence verification failed.");
    }
    process.exitCode = 1;
  }
}
