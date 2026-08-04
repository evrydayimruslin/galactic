import assert from "node:assert/strict";
import { test } from "node:test";
import {
  main,
  parseOwnerAttentionProbeArgs,
  runOwnerAttentionProbe,
  STAGING_API_BASE,
} from "./owner-attention-probe.mjs";

const AGENT_ID = "da122721-e66b-4d3e-b107-b9841c7f7162";
const CONNECTED_TOKEN = "connected-secret-never-serialize";
const OWNER_TOKEN = "owner-secret-never-serialize";
const PRIVATE_SENTINEL = "private-body-never-serialize";
const NOW = new Date("2026-07-25T05:00:00.000Z");
const ITEM_ID = "c139f785-4977-4eed-adc6-7d68d0e787bb";
const UNRELATED_ITEM_ID = "da092fe1-b667-4703-b639-75207e09f937";
const CONDITION_KEY = `agent:${AGENT_ID}:requirement:routine%3Aprimary`;

function privateJson(body, status = 200, cacheControl = "private, no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    },
  });
}

function primaryRoutineEntry(overrides = {}) {
  return {
    item: {
      id: ITEM_ID,
      itemClass: "issue",
      conditionKey: CONDITION_KEY,
      scope: { kind: "agent", agentId: AGENT_ID },
      diagnosis: {
        code: "AGENT_PRIMARY_ROUTINE_MISSING",
        causeCode: null,
        summary: "Create a primary routine",
        detail: PRIVATE_SENTINEL,
        provenance: "platform",
        evidence: [],
      },
      affectedAgents: [{ agentId: AGENT_ID, blocking: true }],
      remediations: [{
        id: `${CONDITION_KEY}:remediation:configure_routine`,
        key: "configure_routine",
        label: "Create routine",
        description: PRIVATE_SENTINEL,
        presentation: "inline",
        requiredAuthority: "account_session",
        sideEffect: "configuration_write",
        target: {
          kind: "agent_setup_requirement",
          agentId: AGENT_ID,
          requirementId: "routine:primary",
        },
      }],
      ...overrides,
    },
    attention: {
      state: "open",
      readAt: null,
      snoozedUntil: null,
      dismissedAt: null,
    },
  };
}

function unrelatedEntry() {
  return {
    item: {
      id: UNRELATED_ITEM_ID,
      itemClass: "issue",
      conditionKey: "account:byok",
      diagnosis: {
        code: "ACCOUNT_BYOK_MISSING",
        summary: PRIVATE_SENTINEL,
      },
    },
    attention: {
      state: "open",
      readAt: null,
      snoozedUntil: null,
      dismissedAt: null,
    },
  };
}

function attentionBody(
  readSource = "legacy",
  overrides = {},
  canonicalOverrides = {},
) {
  return {
    available: true,
    unavailableReason: null,
    entries: [],
    items: [],
    openCount: 1,
    requiresDecisionCount: 0,
    readSource,
    operatorItems: {
      contractVersion: "2026-07-24.operator-issues.1",
      items: [unrelatedEntry()],
      agentCounts: [{
        agent: {
          id: AGENT_ID,
          slug: "private-agent-slug",
          name: PRIVATE_SENTINEL,
        },
        openCount: 1,
        requiresDecisionCount: 0,
        blockingCount: 1,
      }],
      openCount: 1,
      requiresDecisionCount: 0,
      blockingCount: 1,
      nextCursor: null,
      available: true,
      unavailableReason: null,
      generatedAt: "2026-07-25T04:59:59.000Z",
      ...canonicalOverrides,
    },
    ...overrides,
  };
}

function successfulFetch(readSource = "legacy") {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const call = {
      url: String(input),
      authorization: new Headers(init.headers).get("authorization"),
    };
    calls.push(call);
    if (calls.length === 1) {
      return privateJson({ error: PRIVATE_SENTINEL }, 403);
    }
    if (call.url.endsWith(`/api/launch/agents/${AGENT_ID}/home`)) {
      return privateJson({ private: PRIVATE_SENTINEL });
    }
    return privateJson(attentionBody(readSource));
  };
  return { calls, fetchImpl };
}

function probeOptions(overrides = {}) {
  return {
    connectedToken: CONNECTED_TOKEN,
    ownerAccessToken: OWNER_TOKEN,
    smokeAgentId: AGENT_ID,
    expectedReadSource: "legacy",
    repeats: 2,
    now: () => NOW,
    pollDelayMs: 0,
    sleep: async () => {},
    ...overrides,
  };
}

function assertSafeEvidenceValues(value) {
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeEvidenceValues(entry);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) assertSafeEvidenceValues(entry);
    return;
  }
  assert.equal(
    typeof value === "boolean" ||
      (typeof value === "number" && Number.isSafeInteger(value) &&
        value >= 0) ||
      (typeof value === "string" &&
        (
          value === "legacy" ||
          value === "canonical" ||
          (
            Number.isFinite(Date.parse(value)) &&
            new Date(value).toISOString() === value
          )
        )),
    true,
    `unsafe evidence value type: ${typeof value}`,
  );
}

test("reconciles Home and verifies the retired routine blocker is absent", async () => {
  const { calls, fetchImpl } = successfulFetch();
  const evidence = await runOwnerAttentionProbe({
    ...probeOptions(),
    fetchImpl,
  });

  assert.equal(calls.length, 6);
  assert.equal(
    calls[0].url,
    `${STAGING_API_BASE}/api/launch/attention?limit=200`,
  );
  assert.equal(calls[0].authorization, `Bearer ${CONNECTED_TOKEN}`);
  assert.equal(
    calls[1].url,
    `${STAGING_API_BASE}/api/launch/agents/${AGENT_ID}/home`,
  );
  assert.equal(calls[1].authorization, `Bearer ${OWNER_TOKEN}`);
  assert.equal(
    calls[2].url,
    `${STAGING_API_BASE}/api/launch/attention?limit=200`,
  );
  assert.equal(
    calls[3].url,
    `${STAGING_API_BASE}/api/launch/agents/${AGENT_ID}/attention?limit=200`,
  );
  assert.equal(calls[2].authorization, `Bearer ${OWNER_TOKEN}`);
  assert.equal(calls[3].authorization, `Bearer ${OWNER_TOKEN}`);
  assert.equal(calls[4].url, calls[2].url);
  assert.equal(calls[5].url, calls[3].url);

  assert.deepEqual(evidence.connected_token_account, {
    status: 403,
    rejected: true,
    private_no_store: true,
  });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.expected_read_source, "legacy");
  assert.equal(evidence.repeats, 2);
  assert.equal(evidence.generated_at, NOW.toISOString());
  assert.equal(evidence.owner_account.samples.length, 2);
  assert.equal(evidence.owner_agent.samples.length, 2);
  assert.equal(evidence.owner_agent.exact_ownership_verified, true);
  assert.deepEqual(evidence.owner_home_reconciliation, {
    status: 200,
    private_no_store: true,
    triggered: true,
  });
  assert.deepEqual(evidence.primary_routine_retirement, {
    absent_from_account_attention: true,
    absent_from_agent_attention: true,
    poll_attempt_counts: [1, 1],
  });
  assert.deepEqual(evidence.owner_account.samples[0], {
    status: 200,
    read_source: "legacy",
    private_no_store: true,
    available: true,
    canonical_projection_present: true,
    canonical_available: true,
    legacy_open_count: 1,
    legacy_requires_decision_count: 0,
    canonical_open_count: 1,
    canonical_requires_decision_count: 0,
    canonical_blocking_count: 1,
    canonical_item_count: 1,
    canonical_agent_count: 1,
    generated_at: "2026-07-25T04:59:59.000Z",
  });

  const serialized = JSON.stringify(evidence);
  assertSafeEvidenceValues(evidence);
  for (
    const forbidden of [
      AGENT_ID,
      CONNECTED_TOKEN,
      OWNER_TOKEN,
      PRIVATE_SENTINEL,
      "private-agent-slug",
      ITEM_ID,
      UNRELATED_ITEM_ID,
      CONDITION_KEY,
      "authorization",
      STAGING_API_BASE,
      "/api/launch",
      "headers",
      "summary",
    ]
  ) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("stops before owner requests unless the connected token receives HTTP 403", async () => {
  let calls = 0;
  await assert.rejects(
    runOwnerAttentionProbe({
      ...probeOptions(),
      fetchImpl: async () => {
        calls += 1;
        return privateJson(attentionBody(), 200);
      },
    }),
    /did not return HTTP 403/u,
  );
  assert.equal(calls, 1);
});

test("requires private, no-store responses at the boundary, Home, and both Attention surfaces", async () => {
  for (const failingCall of [1, 2, 3, 4]) {
    let calls = 0;
    await assert.rejects(
      runOwnerAttentionProbe({
        ...probeOptions({ repeats: 1 }),
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) {
            return privateJson(
              { error: PRIVATE_SENTINEL },
              403,
              failingCall === 1 ? "no-store" : "private, no-store",
            );
          }
          return privateJson(
            attentionBody(),
            200,
            calls === failingCall ? "public, no-store" : "private, no-store",
          );
        },
      }),
      /not private and no-store/u,
    );
  }
});

test("polls boundedly while reconciliation retires a stale blocker", async () => {
  const calls = [];
  const sleepCalls = [];
  const stale = attentionBody(
    "legacy",
    { openCount: 1, requiresDecisionCount: 0 },
    {
      items: [primaryRoutineEntry()],
      agentCounts: [{
        agent: {
          id: AGENT_ID,
          slug: "private-agent-slug",
          name: PRIVATE_SENTINEL,
        },
        openCount: 1,
        requiresDecisionCount: 0,
        blockingCount: 1,
      }],
      openCount: 1,
      requiresDecisionCount: 0,
      blockingCount: 1,
    },
  );
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({
      url,
      authorization: new Headers(init.headers).get("authorization"),
    });
    if (calls.length === 1) {
      return privateJson({ error: PRIVATE_SENTINEL }, 403);
    }
    if (url.endsWith(`/api/launch/agents/${AGENT_ID}/home`)) {
      return privateJson({ private: PRIVATE_SENTINEL });
    }
    return privateJson(calls.length <= 4 ? stale : attentionBody());
  };

  const evidence = await runOwnerAttentionProbe({
    ...probeOptions({
      repeats: 1,
      pollAttempts: 3,
      pollDelayMs: 25,
      sleep: async (delayMs) => sleepCalls.push(delayMs),
    }),
    fetchImpl,
  });

  assert.equal(calls.length, 6);
  assert.deepEqual(sleepCalls, [25]);
  assert.deepEqual(
    evidence.primary_routine_retirement.poll_attempt_counts,
    [2],
  );
  assert.equal(
    evidence.primary_routine_retirement.absent_from_account_attention,
    true,
  );
});

test("fails after the bounded poll window when a stale blocker remains", async () => {
  const stale = attentionBody(
    "legacy",
    { openCount: 1, requiresDecisionCount: 0 },
    {
      items: [primaryRoutineEntry()],
      agentCounts: [{
        agent: {
          id: AGENT_ID,
          slug: "private-agent-slug",
          name: PRIVATE_SENTINEL,
        },
        openCount: 1,
        requiresDecisionCount: 0,
        blockingCount: 1,
      }],
      openCount: 1,
      requiresDecisionCount: 0,
      blockingCount: 1,
    },
  );
  let calls = 0;
  let sleeps = 0;
  await assert.rejects(
    runOwnerAttentionProbe({
      ...probeOptions({
        repeats: 1,
        pollAttempts: 3,
        pollDelayMs: 0,
        sleep: async () => {
          sleeps += 1;
        },
      }),
      fetchImpl: async (input) => {
        calls += 1;
        if (calls === 1) {
          return privateJson({ error: PRIVATE_SENTINEL }, 403);
        }
        if (String(input).endsWith(`/api/launch/agents/${AGENT_ID}/home`)) {
          return privateJson({ private: PRIVATE_SENTINEL });
        }
        return privateJson(stale);
      },
    }),
    /remained on an Attention surface after bounded reconciliation/u,
  );
  assert.equal(calls, 8);
  assert.equal(sleeps, 2);
});

test("fails closed on source fallback, unavailable data, and malformed canonical projections", async () => {
  const cases = [
    {
      name: "canonical-read fallback",
      expectedReadSource: "canonical",
      body: attentionBody("legacy"),
      pattern: /unexpected read source/u,
    },
    {
      name: "unexpected canonical cutover",
      expectedReadSource: "legacy",
      body: attentionBody("canonical"),
      pattern: /unexpected read source/u,
    },
    {
      name: "legacy unavailable",
      body: attentionBody("legacy", { available: false }),
      pattern: /is unavailable/u,
    },
    {
      name: "canonical unavailable",
      body: attentionBody("legacy", {
        operatorItems: {
          ...attentionBody().operatorItems,
          available: false,
        },
      }),
      pattern: /lacks a valid canonical projection/u,
    },
    {
      name: "missing canonical",
      body: attentionBody("legacy", { operatorItems: undefined }),
      pattern: /lacks a valid canonical projection/u,
    },
    {
      name: "wrong canonical contract version",
      body: attentionBody("legacy", {}, {
        contractVersion: "2026-07-23.operator.1",
      }),
      pattern: /lacks a valid canonical projection/u,
    },
    {
      name: "invalid counts",
      body: attentionBody("legacy", {
        operatorItems: {
          ...attentionBody().operatorItems,
          blockingCount: 3,
        },
      }),
      pattern: /inconsistent counts/u,
    },
  ];

  for (const scenario of cases) {
    let calls = 0;
    await assert.rejects(
      runOwnerAttentionProbe({
        ...probeOptions({
          repeats: 1,
          expectedReadSource: scenario.expectedReadSource || "legacy",
        }),
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? privateJson({ error: PRIVATE_SENTINEL }, 403)
            : privateJson(scenario.body);
        },
      }),
      scenario.pattern,
      scenario.name,
    );
  }
});

test("does not surface response bodies or fetch diagnostics in errors", async () => {
  let calls = 0;
  await assert.rejects(
    runOwnerAttentionProbe({
      ...probeOptions({ repeats: 1 }),
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return privateJson({ error: PRIVATE_SENTINEL }, 403);
        }
        return new Response(PRIVATE_SENTINEL, {
          status: 200,
          headers: { "Cache-Control": "private, no-store" },
        });
      },
    }),
    (error) =>
      error instanceof Error &&
      /returned invalid JSON/u.test(error.message) &&
      !error.message.includes(PRIVATE_SENTINEL),
  );

  await assert.rejects(
    runOwnerAttentionProbe({
      ...probeOptions({ repeats: 1 }),
      fetchImpl: async () => {
        throw new Error(
          `${PRIVATE_SENTINEL} ${OWNER_TOKEN} ${STAGING_API_BASE}`,
        );
      },
    }),
    (error) =>
      error instanceof Error &&
      error.message ===
        "Connected token account Attention boundary request failed.",
  );
});

test("parses only the bounded CLI contract and rejects non-staging targets", async () => {
  assert.deepEqual(
    parseOwnerAttentionProbeArgs([
      "--expected-read-source",
      "canonical",
      "--repeats",
      "5",
      "--output",
      "evidence.json",
    ]),
    {
      expectedReadSource: "canonical",
      repeats: 5,
      output: "evidence.json",
    },
  );
  assert.equal(
    parseOwnerAttentionProbeArgs([
      "--output",
      "evidence.json",
      "--expected-read-source",
      "legacy",
    ]).repeats,
    2,
  );
  for (const repeats of ["0", "6", "1.5", "-1"]) {
    assert.throws(
      () =>
        parseOwnerAttentionProbeArgs([
          "--expected-read-source",
          "legacy",
          "--repeats",
          repeats,
          "--output",
          "evidence.json",
        ]),
      /repeats/u,
    );
  }
  assert.throws(
    () =>
      parseOwnerAttentionProbeArgs([
        "--expected-read-source",
        "shadow",
        "--output",
        "evidence.json",
      ]),
    /Usage/u,
  );
  await assert.rejects(
    runOwnerAttentionProbe({
      ...probeOptions({ apiBase: "https://api.connectgalactic.com" }),
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    }),
    /restricted to staging/u,
  );
});

test("main writes only sanitized evidence and prints no identifiers or secrets", async () => {
  const { fetchImpl } = successfulFetch("canonical");
  let output = "";
  const logs = [];
  await main(
    [
      "--expected-read-source",
      "canonical",
      "--repeats",
      "1",
      "--output",
      "ignored.json",
    ],
    {
      ULTRALIGHT_TOKEN: CONNECTED_TOKEN,
      GALACTIC_OWNER_ACCESS_TOKEN: OWNER_TOKEN,
      GALACTIC_SMOKE_APP_ID: AGENT_ID,
    },
    {
      fetchImpl,
      now: () => NOW,
      mkdirImpl: async () => {},
      writeFileImpl: async (_path, contents) => {
        output = contents;
      },
      log: (message) => logs.push(message),
    },
  );

  const evidence = JSON.parse(output);
  assert.equal(evidence.expected_read_source, "canonical");
  assert.deepEqual(logs, ["Owner Attention probe passed."]);
  const transcript = `${output}\n${logs.join("\n")}`;
  for (
    const forbidden of [
      AGENT_ID,
      CONNECTED_TOKEN,
      OWNER_TOKEN,
      PRIVATE_SENTINEL,
      STAGING_API_BASE,
    ]
  ) {
    assert.equal(transcript.includes(forbidden), false, forbidden);
  }
});
