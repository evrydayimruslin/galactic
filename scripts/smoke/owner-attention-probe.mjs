#!/usr/bin/env node
// Secret-safe, read-only owner-session probe for the two Attention surfaces.
//
// This script is intentionally separate from with-staging-owner-session.mjs:
// that helper mints and passes a short-lived owner JWT in memory, while this
// probe consumes it without decoding, printing, or persisting it.
//
// Required env:
//   ULTRALIGHT_TOKEN                 connected staging API token
//   GALACTIC_OWNER_ACCESS_TOKEN      short-lived Supabase owner access JWT
//   GALACTIC_SMOKE_APP_ID            fixed private Agent UUID
//
// Usage:
//   node scripts/smoke/owner-attention-probe.mjs \
//     --expected-read-source legacy \
//     --repeats 2 \
//     --output /path/to/owner-attention-evidence.json

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const STAGING_API_BASE =
  "https://ultralight-api-staging.rgn4jz429m.workers.dev";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const READ_SOURCES = new Set(["legacy", "canonical"]);
const DEFAULT_REPEATS = 2;
const MAX_REPEATS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_ATTEMPTS = 12;
const DEFAULT_POLL_DELAY_MS = 500;
const MAX_POLL_ATTEMPTS = 20;
const MAX_POLL_DELAY_MS = 5_000;
const OPERATOR_ISSUE_CONTRACT_VERSION = "2026-07-24.operator-issues.1";
const PRIMARY_ROUTINE_REQUIREMENT_ID = "routine:primary";
const PRIMARY_ROUTINE_DIAGNOSIS_CODE = "AGENT_PRIMARY_ROUTINE_MISSING";
const PRIMARY_ROUTINE_DIAGNOSIS_SUMMARY = "Create a primary routine";

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function isRecord(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length &&
    actual.every((key, index) => key === keys[index]);
}

function safeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} returned an invalid count.`);
  }
  return value;
}

function safeTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} returned an invalid timestamp.`);
  }
  return value;
}

function privateNoStore(response) {
  const directives = String(response?.headers?.get("cache-control") || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return directives.includes("private") && directives.includes("no-store") &&
    !directives.includes("public");
}

function assertPrivateNoStore(response, label) {
  if (!privateNoStore(response)) {
    throw new Error(`${label} was not private and no-store.`);
  }
}

async function fetchBounded(fetchImpl, url, init, label, timeoutMs) {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: init?.signal || AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // A fetch implementation may include the URL or request headers in its
    // original error. Replace it with a fixed, non-sensitive diagnostic.
    throw new Error(`${label} request failed.`);
  }
}

async function responseJson(response, label) {
  try {
    return await response.json();
  } catch {
    // Never copy a malformed or adversarial response body into logs.
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function projectionResult(body, expectedReadSource, label) {
  if (!isRecord(body)) {
    throw new Error(`${label} returned an invalid response.`);
  }
  if (body.readSource !== expectedReadSource) {
    throw new Error(`${label} selected an unexpected read source.`);
  }
  if (body.available !== true || body.unavailableReason !== null) {
    throw new Error(`${label} is unavailable.`);
  }

  const canonical = body.operatorItems;
  if (
    !isRecord(canonical) ||
    canonical.contractVersion !== OPERATOR_ISSUE_CONTRACT_VERSION ||
    !Array.isArray(canonical.items) ||
    !Array.isArray(canonical.agentCounts) ||
    canonical.available !== true ||
    canonical.unavailableReason !== null ||
    !(
      canonical.nextCursor === null ||
      typeof canonical.nextCursor === "string"
    )
  ) {
    throw new Error(`${label} lacks a valid canonical projection.`);
  }

  const legacyOpenCount = safeCount(body.openCount, `${label} legacy open`);
  const legacyDecisionCount = safeCount(
    body.requiresDecisionCount,
    `${label} legacy decision`,
  );
  const canonicalOpenCount = safeCount(
    canonical.openCount,
    `${label} canonical open`,
  );
  const canonicalDecisionCount = safeCount(
    canonical.requiresDecisionCount,
    `${label} canonical decision`,
  );
  const canonicalBlockingCount = safeCount(
    canonical.blockingCount,
    `${label} canonical blocking`,
  );
  if (
    legacyDecisionCount > legacyOpenCount ||
    canonicalDecisionCount > canonicalOpenCount ||
    canonicalBlockingCount > canonicalOpenCount ||
    canonical.items.length > canonicalOpenCount
  ) {
    throw new Error(`${label} returned inconsistent counts.`);
  }

  for (const entry of canonical.agentCounts) {
    if (!isRecord(entry)) {
      throw new Error(`${label} returned invalid canonical Agent counts.`);
    }
    const openCount = safeCount(
      entry.openCount,
      `${label} canonical Agent open`,
    );
    const decisionCount = safeCount(
      entry.requiresDecisionCount,
      `${label} canonical Agent decision`,
    );
    const blockingCount = safeCount(
      entry.blockingCount,
      `${label} canonical Agent blocking`,
    );
    if (decisionCount > openCount || blockingCount > openCount) {
      throw new Error(`${label} returned inconsistent canonical Agent counts.`);
    }
  }

  // This is a new object composed exclusively from allowlisted, aggregate
  // fields. No raw item, Agent metadata, body text, URL, header, or identifier
  // can flow into the evidence artifact.
  return {
    canonical,
    evidence: {
      status: 200,
      read_source: expectedReadSource,
      private_no_store: true,
      available: true,
      canonical_projection_present: true,
      canonical_available: true,
      legacy_open_count: legacyOpenCount,
      legacy_requires_decision_count: legacyDecisionCount,
      canonical_open_count: canonicalOpenCount,
      canonical_requires_decision_count: canonicalDecisionCount,
      canonical_blocking_count: canonicalBlockingCount,
      canonical_item_count: canonical.items.length,
      canonical_agent_count: canonical.agentCounts.length,
      generated_at: safeTimestamp(
        canonical.generatedAt,
        `${label} canonical projection`,
      ),
    },
  };
}

async function probeOwnerSurface({
  fetchImpl,
  url,
  ownerAccessToken,
  expectedReadSource,
  label,
  timeoutMs,
}) {
  const response = await fetchBounded(
    fetchImpl,
    url,
    {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${ownerAccessToken}`,
        Accept: "application/json",
        "Cache-Control": "no-store",
      },
    },
    label,
    timeoutMs,
  );
  if (response?.status !== 200) {
    throw new Error(
      `${label} failed (HTTP ${Number(response?.status) || 0}).`,
    );
  }
  assertPrivateNoStore(response, label);
  return projectionResult(
    await responseJson(response, label),
    expectedReadSource,
    label,
  );
}

function expectedPrimaryRoutineConditionKey(agentId) {
  return `agent:${agentId}:requirement:${PRIMARY_ROUTINE_REQUIREMENT_ID}`;
}

function primaryRoutineBlocker(canonical, agentId, label) {
  const conditionKey = expectedPrimaryRoutineConditionKey(agentId);
  const matches = canonical.items.filter((entry) =>
    isRecord(entry) && isRecord(entry.item) &&
    entry.item.conditionKey === conditionKey
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error(`${label} returned duplicate primary-routine blockers.`);
  }

  const countMatches = canonical.agentCounts.filter((entry) =>
    isRecord(entry) && isRecord(entry.agent) &&
    entry.agent.id === agentId
  );
  if (
    countMatches.length !== 1 ||
    safeCount(countMatches[0].openCount, `${label} Agent open`) < 1 ||
    safeCount(countMatches[0].blockingCount, `${label} Agent blocking`) < 1
  ) {
    throw new Error(
      `${label} does not contain the exact affected-Agent count projection.`,
    );
  }

  const item = matches[0].item;
  if (
    typeof item.id !== "string" ||
    !UUID_RE.test(item.id) ||
    !hasExactKeys(item.scope, ["kind", "agentId"]) ||
    item.scope.kind !== "agent" ||
    item.scope.agentId !== agentId ||
    !hasExactKeys(item.diagnosis, [
      "code",
      "causeCode",
      "summary",
      "detail",
      "provenance",
      "evidence",
    ]) ||
    item.diagnosis.code !== PRIMARY_ROUTINE_DIAGNOSIS_CODE ||
    item.diagnosis.causeCode !== null ||
    item.diagnosis.summary !== PRIMARY_ROUTINE_DIAGNOSIS_SUMMARY ||
    typeof item.diagnosis.detail !== "string" ||
    item.diagnosis.detail.length === 0 ||
    item.diagnosis.provenance !== "platform" ||
    !Array.isArray(item.diagnosis.evidence) ||
    item.diagnosis.evidence.length !== 0 ||
    !Array.isArray(item.affectedAgents) ||
    item.affectedAgents.length !== 1 ||
    !hasExactKeys(item.affectedAgents[0], ["agentId", "blocking"]) ||
    item.affectedAgents[0].agentId !== agentId ||
    item.affectedAgents[0].blocking !== true ||
    !Array.isArray(item.remediations) ||
    item.remediations.length !== 1
  ) {
    throw new Error(`${label} primary-routine blocker does not match.`);
  }

  const remediation = item.remediations[0];
  if (
    !hasExactKeys(remediation, [
      "id",
      "key",
      "label",
      "description",
      "presentation",
      "requiredAuthority",
      "sideEffect",
      "target",
    ]) ||
    remediation.id !==
      `${conditionKey}:remediation:configure_routine` ||
    remediation.key !== "configure_routine" ||
    remediation.label !== "Create routine" ||
    remediation.presentation !== "inline" ||
    remediation.requiredAuthority !== "account_session" ||
    remediation.sideEffect !== "configuration_write" ||
    !hasExactKeys(remediation.target, [
      "kind",
      "agentId",
      "requirementId",
    ]) ||
    remediation.target.kind !== "agent_setup_requirement" ||
    remediation.target.agentId !== agentId ||
    remediation.target.requirementId !== PRIMARY_ROUTINE_REQUIREMENT_ID
  ) {
    throw new Error(
      `${label} primary-routine remediation does not match.`,
    );
  }

  return { itemId: item.id };
}

async function pollOwnerAttentionSample({
  fetchImpl,
  accountUrl,
  agentUrl,
  ownerAccessToken,
  smokeAgentId,
  expectedReadSource,
  sampleNumber,
  timeoutMs,
  pollAttempts,
  pollDelayMs,
  sleep,
}) {
  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const account = await probeOwnerSurface({
      fetchImpl,
      url: accountUrl,
      ownerAccessToken,
      expectedReadSource,
      label: `Owner account Attention sample ${sampleNumber}`,
      timeoutMs,
    });
    const agent = await probeOwnerSurface({
      fetchImpl,
      url: agentUrl,
      ownerAccessToken,
      expectedReadSource,
      label: `Owner Agent Attention sample ${sampleNumber}`,
      timeoutMs,
    });
    const accountBlocker = primaryRoutineBlocker(
      account.canonical,
      smokeAgentId,
      "Owner account Attention",
    );
    const agentBlocker = primaryRoutineBlocker(
      agent.canonical,
      smokeAgentId,
      "Owner Agent Attention",
    );

    if (accountBlocker && agentBlocker) {
      if (accountBlocker.itemId !== agentBlocker.itemId) {
        throw new Error(
          "Attention surfaces selected different primary-routine items.",
        );
      }
      return {
        accountEvidence: account.evidence,
        agentEvidence: agent.evidence,
        pollAttempts: attempt,
      };
    }
    if (attempt < pollAttempts) await sleep(pollDelayMs);
  }
  throw new Error(
    "The primary-routine blocker did not appear on both Attention surfaces within bounded polling.",
  );
}

export async function runOwnerAttentionProbe({
  connectedToken,
  ownerAccessToken,
  smokeAgentId,
  expectedReadSource,
  repeats = DEFAULT_REPEATS,
  apiBase = STAGING_API_BASE,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date(),
  pollAttempts = DEFAULT_POLL_ATTEMPTS,
  pollDelayMs = DEFAULT_POLL_DELAY_MS,
  sleep = (delayMs) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)),
}) {
  const apiToken = requiredString(connectedToken, "ULTRALIGHT_TOKEN");
  const ownerToken = requiredString(
    ownerAccessToken,
    "GALACTIC_OWNER_ACCESS_TOKEN",
  );
  const agentId = requiredString(smokeAgentId, "GALACTIC_SMOKE_APP_ID");
  const source = requiredString(
    expectedReadSource,
    "--expected-read-source",
  );
  if (!UUID_RE.test(agentId)) {
    throw new Error("GALACTIC_SMOKE_APP_ID must be a UUID.");
  }
  if (!READ_SOURCES.has(source)) {
    throw new Error("--expected-read-source must be legacy or canonical.");
  }
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) {
    throw new Error("--repeats must be an integer from 1 through 5.");
  }
  if (apiBase !== STAGING_API_BASE) {
    throw new Error("Owner Attention probing is restricted to staging.");
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw new Error("The request timeout is invalid.");
  }
  if (
    !Number.isSafeInteger(pollAttempts) ||
    pollAttempts < 1 ||
    pollAttempts > MAX_POLL_ATTEMPTS
  ) {
    throw new Error("The Attention poll-attempt bound is invalid.");
  }
  if (
    !Number.isSafeInteger(pollDelayMs) ||
    pollDelayMs < 0 ||
    pollDelayMs > MAX_POLL_DELAY_MS
  ) {
    throw new Error("The Attention poll delay is invalid.");
  }
  if (typeof sleep !== "function") {
    throw new Error("The Attention poll scheduler is invalid.");
  }

  const accountUrl = `${apiBase}/api/launch/attention?limit=200`;
  const agentUrl =
    `${apiBase}/api/launch/agents/${encodeURIComponent(agentId)}/attention?limit=200`;
  const homeUrl =
    `${apiBase}/api/launch/agents/${encodeURIComponent(agentId)}/home`;

  // This negative authorization check must happen first. It proves a connected
  // Agent token cannot exercise the account-session-only surface.
  const connectedResponse = await fetchBounded(
    fetchImpl,
    accountUrl,
    {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json",
        "Cache-Control": "no-store",
      },
    },
    "Connected token account Attention boundary",
    timeoutMs,
  );
  if (connectedResponse?.status !== 403) {
    throw new Error(
      "Connected token account Attention boundary did not return HTTP 403.",
    );
  }
  assertPrivateNoStore(
    connectedResponse,
    "Connected token account Attention boundary",
  );
  await connectedResponse.body?.cancel().catch(() => {});

  // Reading the exact owner-private Home snapshot is the trusted setup
  // producer. It schedules persistence of the fixture's missing-primary-routine
  // condition with waitUntil, so Attention is polled only after this succeeds.
  const homeResponse = await fetchBounded(
    fetchImpl,
    homeUrl,
    {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        Accept: "application/json",
        "Cache-Control": "no-store",
      },
    },
    "Owner Agent Home reconciliation",
    timeoutMs,
  );
  if (homeResponse?.status !== 200) {
    throw new Error(
      `Owner Agent Home reconciliation failed (HTTP ${
        Number(homeResponse?.status) || 0
      }).`,
    );
  }
  assertPrivateNoStore(homeResponse, "Owner Agent Home reconciliation");
  // The private snapshot is deliberately not parsed or copied; the successful
  // exact UUID-scoped response is sufficient to trigger reconciliation.
  await homeResponse.body?.cancel().catch(() => {});

  const accountSamples = [];
  const agentSamples = [];
  const pollAttemptCounts = [];
  for (let index = 0; index < repeats; index += 1) {
    const sample = await pollOwnerAttentionSample({
      fetchImpl,
      accountUrl,
      agentUrl,
      ownerAccessToken: ownerToken,
      smokeAgentId: agentId,
      expectedReadSource: source,
      sampleNumber: index + 1,
      timeoutMs,
      pollAttempts,
      pollDelayMs,
      sleep,
    });
    accountSamples.push(sample.accountEvidence);
    agentSamples.push(sample.agentEvidence);
    pollAttemptCounts.push(sample.pollAttempts);
  }

  const generatedAt = now();
  if (!(generatedAt instanceof Date) || !Number.isFinite(generatedAt.getTime())) {
    throw new Error("The evidence timestamp is invalid.");
  }

  return {
    verified: true,
    generated_at: generatedAt.toISOString(),
    expected_read_source: source,
    repeats,
    connected_token_account: {
      status: 403,
      rejected: true,
      private_no_store: true,
    },
    owner_home_reconciliation: {
      status: 200,
      private_no_store: true,
      triggered: true,
    },
    primary_routine_blocker: {
      condition_verified: true,
      diagnosis_verified: true,
      same_canonical_item_verified: true,
      exact_affected_agent_verified: true,
      server_owned_remediation_verified: true,
      poll_attempt_counts: pollAttemptCounts,
    },
    owner_account: {
      samples: accountSamples,
    },
    owner_agent: {
      exact_ownership_verified: true,
      samples: agentSamples,
    },
  };
}

export function parseOwnerAttentionProbeArgs(argv) {
  let expectedReadSource = "";
  let repeats = DEFAULT_REPEATS;
  let output = "";
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (
      !["--expected-read-source", "--repeats", "--output"].includes(flag) ||
      seen.has(flag)
    ) {
      throw new Error(cliUsage());
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(cliUsage());
    }
    seen.add(flag);
    index += 1;
    if (flag === "--expected-read-source") {
      expectedReadSource = value;
    } else if (flag === "--repeats") {
      if (!/^\d+$/u.test(value)) {
        throw new Error("--repeats must be an integer from 1 through 5.");
      }
      repeats = Number(value);
    } else {
      output = value;
    }
  }

  if (!READ_SOURCES.has(expectedReadSource) || !output) {
    throw new Error(cliUsage());
  }
  if (repeats < 1 || repeats > MAX_REPEATS) {
    throw new Error("--repeats must be an integer from 1 through 5.");
  }
  return { expectedReadSource, repeats, output };
}

function cliUsage() {
  return (
    "Usage: owner-attention-probe.mjs " +
    "--expected-read-source legacy|canonical " +
    "[--repeats 1..5] --output <path>\n" +
    "Required env: ULTRALIGHT_TOKEN, GALACTIC_OWNER_ACCESS_TOKEN, " +
    "GALACTIC_SMOKE_APP_ID"
  );
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  dependencies = {},
) {
  const args = parseOwnerAttentionProbeArgs(argv);
  const evidence = await runOwnerAttentionProbe({
    connectedToken: env.ULTRALIGHT_TOKEN,
    ownerAccessToken: env.GALACTIC_OWNER_ACCESS_TOKEN,
    smokeAgentId: env.GALACTIC_SMOKE_APP_ID,
    expectedReadSource: args.expectedReadSource,
    repeats: args.repeats,
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: dependencies.timeoutMs,
    now: dependencies.now,
    pollAttempts: dependencies.pollAttempts,
    pollDelayMs: dependencies.pollDelayMs,
    sleep: dependencies.sleep,
  });
  const outputPath = resolve(args.output);
  try {
    await (dependencies.mkdirImpl || mkdir)(dirname(outputPath), {
      recursive: true,
    });
    await (dependencies.writeFileImpl || writeFile)(
      outputPath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
  } catch {
    // Do not echo a caller-provided output path if filesystem persistence
    // fails; paths are not part of the release evidence contract.
    throw new Error("Could not write owner Attention evidence.");
  }
  (dependencies.log || console.log)("Owner Attention probe passed.");
  return evidence;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Probe failed.");
    process.exitCode = 1;
  }
}
