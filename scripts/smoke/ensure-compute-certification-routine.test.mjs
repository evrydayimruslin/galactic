import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  callComputeCertificationRoutineTool,
  COMPUTE_CERTIFICATION_ROUTINE_FUNCTION,
  COMPUTE_CERTIFICATION_ROUTINE_NAME,
  COMPUTE_CERTIFICATION_ROUTINE_POLICY,
  COMPUTE_CERTIFICATION_ROUTINE_PREFLIGHT_KIND,
  COMPUTE_CERTIFICATION_ROUTINE_TEMPLATE_ID,
  computeCertificationRoutineConfigFromCli,
  computeCertificationRoutineOutputPath,
  computeCertificationRoutinePreflightEvidence,
  ensureComputeCertificationRoutine,
  writeComputeCertificationRoutinePreflightEvidence,
} from "./ensure-compute-certification-routine.mjs";
import {
  PRODUCTION_API_BASE,
  STAGING_API_BASE,
} from "./with-staging-owner-session.mjs";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROUTINE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_ROUTINE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REQUEST_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OWNER_TOKEN = "owner-token-that-must-never-escape";
const OUTPUT_PATH = join(tmpdir(), "compute-certification-routine.json");

function jsonResponse(
  body,
  { status = 200, cacheControl = "private, no-store" } = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    },
  });
}

function launchRoutine(overrides = {}) {
  return {
    id: ROUTINE_ID,
    name: COMPUTE_CERTIFICATION_ROUTINE_NAME,
    status: "paused",
    activeRunCount: 0,
    recentRuns: [],
    blockers: [],
    actions: {
      canApproveCapabilities: false,
      canActivate: true,
      canPause: false,
      canRunNow: false,
    },
    ...overrides,
  };
}

function routineProjection(routines = [launchRoutine()], revision = "ah1:agent:7") {
  return {
    revision,
    agent: { id: AGENT_ID, slug: "compute-certification", name: "Compute" },
    primaryRoutineId: routines[0]?.id ?? null,
    routines,
    aggregate: {
      total: routines.length,
      active: 0,
      paused: routines.length,
      failing: 0,
      running: 0,
      nextRunAt: null,
      lastRunAt: null,
    },
    generatedAt: "2026-08-04T12:00:00.000Z",
  };
}

function storedRoutine(overrides = {}) {
  return {
    id: ROUTINE_ID,
    composer_app_id: AGENT_ID,
    composer_app_slug: "compute-certification",
    template_id: COMPUTE_CERTIFICATION_ROUTINE_TEMPLATE_ID,
    template_version: "release-1",
    name: COMPUTE_CERTIFICATION_ROUTINE_NAME,
    description: "Fixed probe",
    intent: null,
    handler_function: COMPUTE_CERTIFICATION_ROUTINE_FUNCTION,
    status: "paused",
    schedule: { type: "interval", every_seconds: 3600 },
    config: {},
    budget_policy: {},
    approval_policy: {},
    max_concurrency: 1,
    metadata: {
      source: "ul.routine",
      launch_managed: true,
      launch_role: "primary",
    },
    capabilities: [],
    dashboard_bindings: [],
    ...overrides,
  };
}

function policyProjection(policy = COMPUTE_CERTIFICATION_ROUTINE_POLICY) {
  return {
    policies: [{
      functionName: COMPUTE_CERTIFICATION_ROUTINE_FUNCTION,
      policy,
      revision: "default:declaration-hash",
      declaredReleaseId: "release-1",
      declarationHash: "declaration-hash",
    }],
  };
}

function fetchForProjections(projections, policy = policyProjection(), calls = []) {
  let routineRead = 0;
  return async (input, init = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    calls.push({ url, method, authorization: init.headers?.Authorization });
    if (url.endsWith(`/agents/${AGENT_ID}/routines`) && method === "GET") {
      const body = projections[Math.min(routineRead, projections.length - 1)];
      routineRead += 1;
      return jsonResponse(body);
    }
    if (url.endsWith(`/agents/${AGENT_ID}/policies`) && method === "GET") {
      return jsonResponse(policy);
    }
    throw new Error(`Unexpected request ${method} ${url} ${OWNER_TOKEN}`);
  };
}

function routineTool({
  detail = storedRoutine(),
  createError = null,
  calls = [],
} = {}) {
  return async (input) => {
    calls.push(input);
    if (input.args.action === "create") {
      if (createError) throw createError;
      return { routine: detail };
    }
    if (input.args.action === "get") return { routine: detail };
    throw new Error(`Unexpected tool action ${OWNER_TOKEN}`);
  };
}

async function runExisting({
  launch = launchRoutine(),
  detail = storedRoutine(),
  policy = policyProjection(),
  revisions = ["ah1:agent:7", "ah1:agent:7"],
  writeEvidence = async () => undefined,
} = {}) {
  const projections = revisions.map((revision) =>
    routineProjection([launch], revision)
  );
  return await ensureComputeCertificationRoutine(
    {
      target: "staging",
      ownerAccessToken: OWNER_TOKEN,
      agentId: AGENT_ID,
      outputPath: OUTPUT_PATH,
    },
    {
      fetchImpl: fetchForProjections(projections, policy),
      callRoutineTool: routineTool({ detail }),
      writeEvidence,
      convergenceAttempts: 2,
      convergenceDelayMs: 0,
      sleep: async () => undefined,
    },
  );
}

test("reuses an exact paused routine and publishes bounded evidence", async () => {
  const fetchCalls = [];
  const toolCalls = [];
  let written = null;
  const evidence = await ensureComputeCertificationRoutine(
    {
      target: "production",
      ownerAccessToken: OWNER_TOKEN,
      agentId: AGENT_ID.toUpperCase(),
      outputPath: OUTPUT_PATH,
    },
    {
      fetchImpl: fetchForProjections(
        [routineProjection(), routineProjection()],
        policyProjection(),
        fetchCalls,
      ),
      callRoutineTool: routineTool({ calls: toolCalls }),
      writeEvidence: async (path, value) => {
        written = { path, value };
      },
    },
  );

  assert.deepEqual(evidence, {
    schema_version: 1,
    kind: COMPUTE_CERTIFICATION_ROUTINE_PREFLIGHT_KIND,
    verified: true,
    target: "production",
    agent_id: AGENT_ID,
    routine_id: ROUTINE_ID,
    template_id: COMPUTE_CERTIFICATION_ROUTINE_TEMPLATE_ID,
    function_name: COMPUTE_CERTIFICATION_ROUTINE_FUNCTION,
    name: COMPUTE_CERTIFICATION_ROUTINE_NAME,
    status: "paused",
    active_run_count: 0,
    function_policy: COMPUTE_CERTIFICATION_ROUTINE_POLICY,
    created: false,
  });
  assert.deepEqual(written, { path: OUTPUT_PATH, value: evidence });
  assert.deepEqual(toolCalls.map((call) => call.args), [{
    action: "get",
    routine_id: ROUTINE_ID,
  }]);
  assert.ok(fetchCalls.every((call) => call.url.startsWith(PRODUCTION_API_BASE)));
  assert.ok(fetchCalls.every((call) =>
    call.authorization === `Bearer ${OWNER_TOKEN}`
  ));
});

test("creates the missing routine once, waits for convergence, then verifies it", async () => {
  const toolCalls = [];
  let sleeps = 0;
  const evidence = await ensureComputeCertificationRoutine(
    {
      target: "staging",
      ownerAccessToken: OWNER_TOKEN,
      agentId: AGENT_ID,
      outputPath: OUTPUT_PATH,
    },
    {
      fetchImpl: fetchForProjections([
        routineProjection([], "ah1:agent:6"),
        routineProjection([], "ah1:agent:6"),
        routineProjection([launchRoutine()], "ah1:agent:7"),
        routineProjection([launchRoutine()], "ah1:agent:7"),
      ]),
      callRoutineTool: routineTool({ calls: toolCalls }),
      writeEvidence: async () => undefined,
      convergenceAttempts: 3,
      convergenceDelayMs: 1,
      sleep: async () => {
        sleeps += 1;
      },
    },
  );

  assert.equal(evidence.created, true);
  assert.equal(sleeps, 1);
  assert.deepEqual(toolCalls.map((call) => call.args), [
    {
      action: "create",
      app_id: AGENT_ID,
      template_id: COMPUTE_CERTIFICATION_ROUTINE_TEMPLATE_ID,
      name: COMPUTE_CERTIFICATION_ROUTINE_NAME,
      activate: false,
    },
    { action: "get", routine_id: ROUTINE_ID },
  ]);
  assert.ok(toolCalls.every((call) => call.apiBase === STAGING_API_BASE));
});

test("reconciles an ambiguous create failure without retrying create", async () => {
  const toolCalls = [];
  const evidence = await ensureComputeCertificationRoutine(
    {
      target: "staging",
      ownerAccessToken: OWNER_TOKEN,
      agentId: AGENT_ID,
      outputPath: OUTPUT_PATH,
    },
    {
      fetchImpl: fetchForProjections([
        routineProjection([], "ah1:agent:6"),
        routineProjection([launchRoutine()], "ah1:agent:7"),
        routineProjection([launchRoutine()], "ah1:agent:7"),
      ]),
      callRoutineTool: routineTool({
        calls: toolCalls,
        createError: new Error(`response lost ${OWNER_TOKEN}`),
      }),
      writeEvidence: async () => undefined,
      convergenceAttempts: 2,
      convergenceDelayMs: 0,
      sleep: async () => undefined,
    },
  );
  assert.equal(evidence.created, true);
  assert.equal(
    toolCalls.filter((call) => call.args.action === "create").length,
    1,
  );
});

test("fails closed on duplicate exact-name routines before platform mutation", async () => {
  let platformCalls = 0;
  await assert.rejects(
    ensureComputeCertificationRoutine(
      {
        target: "staging",
        ownerAccessToken: OWNER_TOKEN,
        agentId: AGENT_ID,
        outputPath: OUTPUT_PATH,
      },
      {
        fetchImpl: fetchForProjections([routineProjection([
          launchRoutine(),
          launchRoutine({ id: OTHER_ROUTINE_ID }),
        ])]),
        callRoutineTool: async () => {
          platformCalls += 1;
        },
        writeEvidence: async () => undefined,
      },
    ),
    /Multiple Compute certification routines exist/u,
  );
  assert.equal(platformCalls, 0);
});

test("fails closed when a missing routine never converges after create", async () => {
  await assert.rejects(
    ensureComputeCertificationRoutine(
      {
        target: "staging",
        ownerAccessToken: OWNER_TOKEN,
        agentId: AGENT_ID,
        outputPath: OUTPUT_PATH,
      },
      {
        fetchImpl: fetchForProjections([routineProjection([])]),
        callRoutineTool: routineTool({
          createError: new Error(`create failed ${OWNER_TOKEN}`),
        }),
        writeEvidence: async () => undefined,
        convergenceAttempts: 2,
        convergenceDelayMs: 0,
        sleep: async () => undefined,
      },
    ),
    (error) => {
      assert.equal(
        error.message,
        "Compute certification routine creation did not converge.",
      );
      assert.equal(error.message.includes(OWNER_TOKEN), false);
      return true;
    },
  );
});

test("fails closed on every stored routine identity or safety drift", async (t) => {
  const cases = [
    ["Agent", { composer_app_id: OTHER_AGENT_ID }],
    ["template", { template_id: "other_template" }],
    ["name", { name: "Other probe" }],
    ["handler", { handler_function: "other_handler" }],
    ["status", { status: "active" }],
    ["concurrency", { max_concurrency: 2 }],
    ["managed metadata", { metadata: { launch_managed: false } }],
    ["capabilities", { capabilities: [{ approved: false }] }],
  ];
  for (const [label, overrides] of cases) {
    await t.test(label, async () => {
      await assert.rejects(
        runExisting({ detail: storedRoutine(overrides) }),
        /detail has drifted/u,
      );
    });
  }
});

test("fails closed on every launch lifecycle drift", async (t) => {
  const cases = [
    [
      "active status",
      { status: "active", actions: { canActivate: false } },
      /not paused/u,
    ],
    ["active count", { activeRunCount: 1 }, /active run count/u],
    ["visible active run", {
      recentRuns: [{ id: OTHER_ROUTINE_ID, status: "queued" }],
    }, /visible active run/u],
    ["malformed recent history", {
      recentRuns: [{ id: "not-a-run-id", status: "succeeded" }],
    }, /recent run history is invalid/u],
    [
      "blocker",
      { blockers: [{ code: "subscription_required", message: OWNER_TOKEN }] },
      /activation blockers: subscription_required/u,
    ],
    [
      "malformed blocker",
      { blockers: [{ code: `unsafe-${OWNER_TOKEN}` }] },
      /blocker projection is invalid/u,
    ],
    [
      "not activatable",
      { actions: { canActivate: false } },
      /cannot be activated/u,
    ],
  ];
  for (const [label, overrides, expected] of cases) {
    await t.test(label, async () => {
      await assert.rejects(
        runExisting({ launch: launchRoutine(overrides) }),
        (error) => {
          assert.match(error.message, expected);
          assert.equal(error.message.includes(OWNER_TOKEN), false);
          return true;
        },
      );
    });
  }
});

test("requires exactly one free Policy Pillar declaration", async (t) => {
  await t.test("off policy", async () => {
    await assert.rejects(
      runExisting({ policy: policyProjection("off") }),
      /not at the free baseline/u,
    );
  });
  await t.test("missing declaration", async () => {
    await assert.rejects(
      runExisting({ policy: { policies: [] } }),
      /function is missing or duplicated/u,
    );
  });
  await t.test("duplicate declaration", async () => {
    const one = policyProjection().policies[0];
    await assert.rejects(
      runExisting({ policy: { policies: [one, { ...one }] } }),
      /function is missing or duplicated/u,
    );
  });
});

test("rejects a routine revision change during the final fence", async () => {
  await assert.rejects(
    runExisting({ revisions: ["ah1:agent:7", "ah1:agent:8"] }),
    /changed during preflight/u,
  );
});

test("calls gx.routine over the pinned MCP wire contract", async () => {
  let captured = null;
  const result = await callComputeCertificationRoutineTool({
    apiBase: STAGING_API_BASE,
    ownerAccessToken: OWNER_TOKEN,
    args: { action: "get", routine_id: ROUTINE_ID },
    randomUuidImpl: () => REQUEST_ID,
    fetchImpl: async (input, init) => {
      captured = { url: String(input), init };
      return jsonResponse({
        jsonrpc: "2.0",
        id: REQUEST_ID,
        result: { structuredContent: { routine: storedRoutine() } },
      });
    },
  });
  assert.deepEqual(result, { routine: storedRoutine() });
  assert.equal(captured.url, `${STAGING_API_BASE}/mcp/platform`);
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, `Bearer ${OWNER_TOKEN}`);
  assert.deepEqual(JSON.parse(captured.init.body), {
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "tools/call",
    params: {
      name: "gx.routine",
      arguments: { action: "get", routine_id: ROUTINE_ID },
    },
  });
});

test("decodes a text MCP result and sanitizes platform failures", async () => {
  const textResult = await callComputeCertificationRoutineTool({
    apiBase: STAGING_API_BASE,
    ownerAccessToken: OWNER_TOKEN,
    args: { action: "get", routine_id: ROUTINE_ID },
    randomUuidImpl: () => REQUEST_ID,
    fetchImpl: async () => jsonResponse({
      result: {
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      },
    }),
  });
  assert.deepEqual(textResult, { ok: true });

  await assert.rejects(
    callComputeCertificationRoutineTool({
      apiBase: STAGING_API_BASE,
      ownerAccessToken: OWNER_TOKEN,
      args: { action: "get", routine_id: ROUTINE_ID },
      randomUuidImpl: () => REQUEST_ID,
      fetchImpl: async () => jsonResponse({
        error: { message: `upstream echoed ${OWNER_TOKEN}` },
      }),
    }),
    (error) => {
      assert.equal(
        error.message,
        "Compute certification routine platform action failed.",
      );
      assert.equal(error.message.includes(OWNER_TOKEN), false);
      return true;
    },
  );
});

test("rejects non-private owner projections", async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith("/routines")) {
      return jsonResponse(routineProjection(), { cacheControl: "public" });
    }
    return jsonResponse(policyProjection());
  };
  await assert.rejects(
    ensureComputeCertificationRoutine(
      {
        target: "staging",
        ownerAccessToken: OWNER_TOKEN,
        agentId: AGENT_ID,
        outputPath: OUTPUT_PATH,
      },
      {
        fetchImpl,
        callRoutineTool: routineTool(),
        writeEvidence: async () => undefined,
      },
    ),
    /not private and no-store/u,
  );
});

test("writes exact secret-free evidence atomically with mode 0600", async () => {
  const directory = await mkdtemp(join(tmpdir(), "galactic-routine-preflight-"));
  const outputPath = join(directory, "routine.json");
  const evidence = computeCertificationRoutinePreflightEvidence({
    target: "staging",
    agentId: AGENT_ID,
    routineId: ROUTINE_ID,
    created: true,
  });
  try {
    await writeComputeCertificationRoutinePreflightEvidence(outputPath, evidence);
    const bytes = await readFile(outputPath, "utf8");
    assert.equal(bytes.endsWith("\n"), true);
    assert.deepEqual(JSON.parse(bytes), evidence);
    assert.equal(bytes.includes(OWNER_TOKEN), false);
    assert.equal((await lstat(outputPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleans a temporary evidence file after publication failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "galactic-routine-failure-"));
  const outputPath = join(directory, "routine.json");
  const evidence = computeCertificationRoutinePreflightEvidence({
    target: "staging",
    agentId: AGENT_ID,
    routineId: ROUTINE_ID,
    created: false,
  });
  let cleaned = null;
  try {
    await assert.rejects(
      writeComputeCertificationRoutinePreflightEvidence(outputPath, evidence, {
        randomUuidImpl: () => REQUEST_ID,
        renameImpl: async () => {
          throw new Error(`rename leaked ${OWNER_TOKEN}`);
        },
        unlinkImpl: async (path) => {
          cleaned = path;
          await rm(path, { force: true });
        },
      }),
      (error) => {
        assert.equal(
          error.message,
          "Compute certification routine evidence could not be written.",
        );
        assert.equal(error.message.includes(OWNER_TOKEN), false);
        return true;
      },
    );
    assert.equal(
      cleaned,
      join(directory, `.routine.json.${REQUEST_ID}.tmp`),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects hostile output and temporary paths before filesystem writes", async () => {
  for (const invalid of [
    "relative.json",
    `${OUTPUT_PATH}\n${OWNER_TOKEN}`,
    `${tmpdir()}/nested/../routine.json`,
    "/",
  ]) {
    assert.throws(
      () => computeCertificationRoutineOutputPath(invalid),
      (error) => {
        assert.equal(error.message.includes(OWNER_TOKEN), false);
        return true;
      },
    );
  }

  let writes = 0;
  await assert.rejects(
    writeComputeCertificationRoutinePreflightEvidence(
      OUTPUT_PATH,
      computeCertificationRoutinePreflightEvidence({
        target: "staging",
        agentId: AGENT_ID,
        routineId: ROUTINE_ID,
        created: false,
      }),
      {
        randomUuidImpl: () => `../${OWNER_TOKEN}`,
        writeFileImpl: async () => {
          writes += 1;
        },
      },
    ),
    (error) => {
      assert.equal(error.message.includes(OWNER_TOKEN), false);
      return true;
    },
  );
  assert.equal(writes, 0);
});

test("CLI derives only the pinned target and env-held credentials", () => {
  assert.deepEqual(
    computeCertificationRoutineConfigFromCli(
      ["--output", OUTPUT_PATH],
      {
        GALACTIC_SMOKE_TARGET: "production",
        GALACTIC_OWNER_ACCESS_TOKEN: OWNER_TOKEN,
        GALACTIC_SMOKE_APP_ID: AGENT_ID.toUpperCase(),
      },
    ),
    {
      target: "production",
      ownerAccessToken: OWNER_TOKEN,
      agentId: AGENT_ID,
      outputPath: OUTPUT_PATH,
    },
  );
  assert.throws(
    () => computeCertificationRoutineConfigFromCli(
      ["--output", OUTPUT_PATH, OWNER_TOKEN],
      {
        GALACTIC_SMOKE_TARGET: "production",
        GALACTIC_OWNER_ACCESS_TOKEN: OWNER_TOKEN,
        GALACTIC_SMOKE_APP_ID: AGENT_ID,
      },
    ),
    (error) => {
      assert.equal(error.message.includes(OWNER_TOKEN), false);
      return true;
    },
  );
});

test("writer rejects evidence schema drift before touching the destination", async () => {
  const evidence = {
    ...computeCertificationRoutinePreflightEvidence({
      target: "staging",
      agentId: AGENT_ID,
      routineId: ROUTINE_ID,
      created: false,
    }),
    unexpected: OWNER_TOKEN,
  };
  let writes = 0;
  await assert.rejects(
    writeComputeCertificationRoutinePreflightEvidence(OUTPUT_PATH, evidence, {
      writeFileImpl: async () => {
        writes += 1;
      },
    }),
    (error) => {
      assert.equal(error.message, "Compute certification routine evidence is invalid.");
      assert.equal(error.message.includes(OWNER_TOKEN), false);
      return true;
    },
  );
  assert.equal(writes, 0);
});
