import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  ComputeCertificationError,
  getComputeCertificationSnapshot,
} from "./compute-certification.ts";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID = "44444444-4444-4444-8444-444444444444";
const SINCE = "2026-08-04T11:00:00.000Z";
const NOW = new Date("2026-08-04T12:30:00.000Z");

function snapshotRow(): Record<string, unknown> {
  return {
    schema_version: 1,
    generated_at: "2026-08-04T12:00:00+00:00",
    owner_id: OWNER_ID,
    agent_id: AGENT_ID,
    since: "2026-08-04T11:00:00+00:00",
    latch_state: "clear",
    requested_run_count: 1,
    selected_run_count: 1,
    runs: [{
      run_id: RUN_ID,
      receipt_id: RECEIPT_ID,
      owner_id: OWNER_ID,
      agent_id: AGENT_ID,
      caller_function: "run_compute_smoke",
      state: "succeeded",
      state_version: "5",
      billing_mode: "wallet",
      capacity_agent_id: AGENT_ID,
      environment_digest: `sha256:${"a".repeat(64)}`,
      directive_hash: "b".repeat(64),
      request_hash: "c".repeat(64),
      created_at: "2026-08-04T11:30:00+00:00",
      updated_at: "2026-08-04T11:31:00+00:00",
      expires_at: "2026-08-04T12:30:00+00:00",
      started_at: "2026-08-04T11:30:10+00:00",
      finished_at: "2026-08-04T11:31:00+00:00",
      cardinality: {
        budget_rows: 1,
        receipt_rows: 1,
        token_rows: 1,
        artifact_rows: 0,
        input_artifact_rows: 0,
        output_artifact_rows: 0,
        projected_artifact_rows: 0,
      },
      backing: {
        run_capacity_reservation: false,
        budget_hold: true,
        budget_capacity_reservation: false,
        receipt_hold: true,
        receipt_capacity_reservation: false,
        receipt_cloud_usage_event: true,
        budget_matches_run_capacity: true,
        receipt_matches_run_capacity: true,
        receipt_matches_budget_hold: true,
        budget_owner_match: true,
        budget_capacity_agent_match: true,
        receipt_principal_match: true,
        receipt_capacity_agent_match: true,
      },
      budget: {
        status: "settled",
        billing_mode: "wallet",
        rate_version: "compute-rate-v1",
        rate_light_per_ms: "0.000002056000",
        actual_wall_ms: "1000",
        reserved_wall_ms: "211000",
        teardown_allowance_ms: "15000",
        reserved_light: "0.433816000000",
        actual_light: "0.002056000000",
        released_light: "0.431760000000",
        expires_at: "2026-08-04T12:30:00+00:00",
        settled_at: "2026-08-04T11:31:00+00:00",
      },
      receipt: {
        id: RECEIPT_ID,
        outcome: "succeeded",
        billing_mode: "wallet",
        rate_version: "compute-rate-v1",
        capacity_settlement_status: "not_applicable",
        reserved_light: "0.433816000000",
        actual_light: "0.002056000000",
        released_light: "0.431760000000",
        worker_wall_ms: "1000",
        teardown_allowance_ms: "15000",
        billed_wall_ms: "1000",
        created_at: "2026-08-04T11:31:00+00:00",
      },
      terminal_active_token_count: 0,
      artifacts: [],
      violations: [],
    }],
    health: {
      stale_nonterminal_runs: 0,
      old_settlement_pending: 0,
      terminal_reserved_budgets: 0,
      receipt_mismatches: 0,
      terminal_active_tokens: 0,
      dlq_fenced_runs: 0,
      stale_pending_artifacts: 0,
      unreconciled_deleted_outputs: 0,
      terminal_input_aliases: 0,
      violations: [],
    },
    violations: [],
  };
}

function selectedRun(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return (payload.runs as Record<string, unknown>[])[0];
}

function convertToSubscription(
  run: Record<string, unknown>,
  settlement: "pending" | "settled" = "settled",
): void {
  run.billing_mode = "subscription_capacity";
  Object.assign(run.backing as Record<string, unknown>, {
    run_capacity_reservation: settlement === "settled",
    budget_hold: false,
    budget_capacity_reservation: settlement === "settled",
    receipt_hold: false,
    receipt_capacity_reservation: settlement === "settled",
    receipt_cloud_usage_event: false,
  });
  Object.assign(run.budget as Record<string, unknown>, {
    billing_mode: "subscription_capacity",
    status: settlement === "pending" ? "settlement_pending" : "settled",
    settled_at: settlement === "pending" ? null : "2026-08-04T11:31:00+00:00",
  });
  Object.assign(run.receipt as Record<string, unknown>, {
    billing_mode: "subscription_capacity",
    capacity_settlement_status: settlement,
  });
  run.violations = settlement === "pending" ? ["BILLING_BACKING_INVALID"] : [];
}

function convertToPreBody(
  run: Record<string, unknown>,
  withBudget: boolean,
): void {
  run.state = "cancelled";
  run.started_at = null;
  const cardinality = run.cardinality as Record<string, unknown>;
  const backing = run.backing as Record<string, unknown>;
  const receipt = run.receipt as Record<string, unknown>;
  receipt.outcome = "cancelled";
  receipt.worker_wall_ms = null;
  receipt.billed_wall_ms = "0";
  receipt.actual_light = "0.000000000000";
  backing.receipt_cloud_usage_event = false;
  if (withBudget) {
    Object.assign(run.budget as Record<string, unknown>, {
      status: "released",
      actual_wall_ms: null,
      actual_light: "0.000000000000",
      released_light: "0.433816000000",
    });
    receipt.actual_light = "0.000000000000";
    receipt.released_light = "0.433816000000";
  } else {
    cardinality.budget_rows = 0;
    cardinality.token_rows = 0;
    run.budget = null;
    Object.assign(backing, {
      budget_hold: false,
      budget_capacity_reservation: false,
      receipt_hold: false,
    });
    Object.assign(receipt, {
      teardown_allowance_ms: "0",
      reserved_light: "0.000000000000",
      released_light: "0.000000000000",
    });
  }
}

function input() {
  return {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runIds: [RUN_ID],
    since: SINCE,
  };
}

function fetchReturning(
  payload: unknown,
  inspect?: (request: Request) => Promise<void>,
): typeof fetch {
  return (async (request: RequestInfo | URL, init?: RequestInit) => {
    const normalized = new Request(request, init);
    await inspect?.(normalized);
    return Response.json(payload);
  }) as typeof fetch;
}

async function assertInvalidResponse(payload: unknown): Promise<void> {
  const error = await assertRejects(
    () =>
      getComputeCertificationSnapshot(input(), {
        fetchFn: fetchReturning(payload),
        supabaseUrl: "https://database.example",
        serviceRoleKey: "service-role",
        now: NOW,
      }),
    ComputeCertificationError,
  );
  assertEquals(error.code, "COMPUTE_CERTIFICATION_INVALID_RESPONSE");
  assertEquals(error.status, 503);
}

Deno.test("Compute certification calls the bounded RPC and strictly maps schema v1", async () => {
  let inspected = false;
  const snapshot = await getComputeCertificationSnapshot(input(), {
    fetchFn: fetchReturning(snapshotRow(), async (request) => {
      inspected = true;
      assertEquals(
        request.url,
        "https://database.example/rest/v1/rpc/get_compute_certification_snapshot",
      );
      assertEquals(request.method, "POST");
      assertEquals(request.headers.get("apikey"), "service-role");
      assertEquals(request.headers.get("Authorization"), "Bearer service-role");
      assertEquals(await request.json(), {
        p_owner_id: OWNER_ID,
        p_agent_id: AGENT_ID,
        p_run_ids: [RUN_ID],
        p_since: SINCE,
      });
    }),
    supabaseUrl: "https://database.example/",
    serviceRoleKey: "service-role",
    now: NOW,
  });

  assertEquals(inspected, true);
  assertEquals(snapshot.schemaVersion, 1);
  assertEquals(snapshot.ownerId, OWNER_ID);
  assertEquals(snapshot.agentId, AGENT_ID);
  assertEquals(snapshot.latchState, "clear");
  assertEquals(snapshot.requestedRunCount, 1);
  assertEquals(snapshot.selectedRunCount, 1);
  assertEquals(snapshot.runs[0].runId, RUN_ID);
  assertEquals(snapshot.runs[0].receipt?.id, RECEIPT_ID);
  assertEquals(snapshot.runs[0].billingMode, "wallet");
  assertEquals(snapshot.runs[0].cardinality.artifactRows, 0);
  assertEquals(snapshot.runs[0].backing.receiptCloudUsageEvent, true);
  assertEquals(snapshot.health.violations, []);
});

Deno.test("Compute certification maps closed latch, token, health, and safe artifact evidence", async () => {
  const payload = snapshotRow();
  payload.latch_state = "active";
  payload.violations = ["EMERGENCY_STOP_LATCH_SET"];
  const run = (payload.runs as Record<string, unknown>[])[0];
  run.terminal_active_token_count = 1;
  run.violations = ["TERMINAL_ACTIVE_TOKEN"];
  run.artifacts = [{
    artifact_id: "55555555-5555-4555-8555-555555555555",
    direction: "output",
    state: "ready",
    state_version: "2",
    sha256: "d".repeat(64),
    size_bytes: "3",
    expires_at: "2026-09-03T11:31:00+00:00",
    object_deleted: false,
  }];
  Object.assign(run.cardinality as Record<string, unknown>, {
    artifact_rows: 1,
    output_artifact_rows: 1,
    projected_artifact_rows: 1,
  });
  Object.assign(payload.health as Record<string, unknown>, {
    receipt_mismatches: 1,
    terminal_active_tokens: 1,
    violations: ["RECEIPT_MISMATCHES", "TERMINAL_ACTIVE_TOKENS"],
  });

  const snapshot = await getComputeCertificationSnapshot(input(), {
    fetchFn: fetchReturning(payload),
    supabaseUrl: "https://database.example",
    serviceRoleKey: "service-role",
    now: NOW,
  });
  assertEquals(snapshot.latchState, "active");
  assertEquals(snapshot.violations, ["EMERGENCY_STOP_LATCH_SET"]);
  assertEquals(snapshot.runs[0].violations, ["TERMINAL_ACTIVE_TOKEN"]);
  assertEquals(snapshot.runs[0].artifacts[0].sizeBytes, "3");
  assertEquals(snapshot.health.receiptMismatches, 1);
  assertEquals(snapshot.health.violations, [
    "RECEIPT_MISMATCHES",
    "TERMINAL_ACTIVE_TOKENS",
  ]);
});

Deno.test("Compute certification accepts conserved subscription-capacity settlement", async () => {
  const payload = snapshotRow();
  const run = selectedRun(payload);
  convertToSubscription(run);

  const snapshot = await getComputeCertificationSnapshot(input(), {
    fetchFn: fetchReturning(payload),
    supabaseUrl: "https://database.example",
    serviceRoleKey: "service-role",
    now: NOW,
  });
  assertEquals(snapshot.runs[0].billingMode, "subscription_capacity");
  assertEquals(snapshot.runs[0].receipt?.capacitySettlementStatus, "settled");
  assertEquals(snapshot.runs[0].violations, []);
});

Deno.test("Compute certification mirrors wallet clamping and subscription overrun billing", async () => {
  const wallet = snapshotRow();
  const walletRun = selectedRun(wallet);
  Object.assign(walletRun.budget as Record<string, unknown>, {
    actual_wall_ms: "300000",
    actual_light: "0.433816000000",
    released_light: "0.000000000000",
  });
  Object.assign(walletRun.receipt as Record<string, unknown>, {
    worker_wall_ms: "300000",
    billed_wall_ms: "211000",
    actual_light: "0.433816000000",
    released_light: "0.000000000000",
  });
  const walletSnapshot = await getComputeCertificationSnapshot(input(), {
    fetchFn: fetchReturning(wallet),
    supabaseUrl: "https://database.example",
    serviceRoleKey: "service-role",
    now: NOW,
  });
  assertEquals(walletSnapshot.runs[0].receipt?.billedWallMs, "211000");

  const subscription = snapshotRow();
  const subscriptionRun = selectedRun(subscription);
  convertToSubscription(subscriptionRun);
  Object.assign(subscriptionRun.budget as Record<string, unknown>, {
    actual_wall_ms: "300000",
    actual_light: "0.616800000000",
    released_light: "0.000000000000",
  });
  Object.assign(subscriptionRun.receipt as Record<string, unknown>, {
    worker_wall_ms: "300000",
    billed_wall_ms: "300000",
    actual_light: "0.616800000000",
    released_light: "0.000000000000",
  });
  const subscriptionSnapshot = await getComputeCertificationSnapshot(
    input(),
    {
      fetchFn: fetchReturning(subscription),
      supabaseUrl: "https://database.example",
      serviceRoleKey: "service-role",
      now: NOW,
    },
  );
  assertEquals(
    subscriptionSnapshot.runs[0].receipt?.billedWallMs,
    "300000",
  );
});

Deno.test("Compute certification accepts exact pre-body zero ledgers with or without a lease", async () => {
  for (const withBudget of [false, true]) {
    const payload = snapshotRow();
    convertToPreBody(selectedRun(payload), withBudget);
    const snapshot = await getComputeCertificationSnapshot(input(), {
      fetchFn: fetchReturning(payload),
      supabaseUrl: "https://database.example",
      serviceRoleKey: "service-role",
      now: NOW,
    });
    assertEquals(snapshot.runs[0].startedAt, null);
    assertEquals(snapshot.runs[0].receipt?.workerWallMs, null);
    assertEquals(snapshot.runs[0].cardinality.budgetRows, withBudget ? 1 : 0);
    assertEquals(snapshot.runs[0].violations, []);
  }
});

Deno.test("Compute certification preserves aligned pending ledgers but certifies only settled capacity backing", async () => {
  const pending = snapshotRow();
  convertToSubscription(selectedRun(pending), "pending");
  const snapshot = await getComputeCertificationSnapshot(input(), {
    fetchFn: fetchReturning(pending),
    supabaseUrl: "https://database.example",
    serviceRoleKey: "service-role",
    now: NOW,
  });
  assertEquals(snapshot.runs[0].budget?.status, "settlement_pending");
  assertEquals(snapshot.runs[0].receipt?.capacitySettlementStatus, "pending");
  assertEquals(snapshot.runs[0].violations, ["BILLING_BACKING_INVALID"]);

  const mismatched = snapshotRow();
  convertToSubscription(selectedRun(mismatched), "pending");
  (selectedRun(mismatched).receipt as Record<string, unknown>)
    .capacity_settlement_status = "settled";
  await assertInvalidResponse(mismatched);
});

Deno.test("Compute certification rejects scalar schema drift at every nesting boundary", async () => {
  const arrayWrapped = [snapshotRow()];
  await assertInvalidResponse(arrayWrapped);

  const extraTop = snapshotRow();
  extraTop.internal = "must-not-pass";
  await assertInvalidResponse(extraTop);

  const extraBacking = snapshotRow();
  const backing = (extraBacking.runs as Record<string, unknown>[])[0]
    .backing as Record<string, unknown>;
  backing.capacity_reservation_id = "must-not-pass";
  await assertInvalidResponse(extraBacking);

  const extraReceipt = snapshotRow();
  const receipt = (extraReceipt.runs as Record<string, unknown>[])[0]
    .receipt as Record<string, unknown>;
  receipt.hold_id = "must-not-pass";
  await assertInvalidResponse(extraReceipt);
});

Deno.test("Compute certification rejects malformed identities, digests, hashes, and timestamps", async () => {
  const invalidOwner = snapshotRow();
  invalidOwner.owner_id = "not-a-uuid";
  await assertInvalidResponse(invalidOwner);

  const invalidDigest = snapshotRow();
  (invalidDigest.runs as Record<string, unknown>[])[0].environment_digest =
    `sha256:${"A".repeat(64)}`;
  await assertInvalidResponse(invalidDigest);

  const invalidHash = snapshotRow();
  (invalidHash.runs as Record<string, unknown>[])[0].request_hash = "f".repeat(
    63,
  );
  await assertInvalidResponse(invalidHash);

  const invalidTimestamp = snapshotRow();
  (invalidTimestamp.runs as Record<string, unknown>[])[0].finished_at =
    "2026-08-04 11:31:00";
  await assertInvalidResponse(invalidTimestamp);

  const invalidCalendarDate = snapshotRow();
  invalidCalendarDate.generated_at = "2026-02-30T12:00:00+00:00";
  await assertInvalidResponse(invalidCalendarDate);

  const beforeWindow = snapshotRow();
  selectedRun(beforeWindow).created_at = "2026-08-04T10:59:59+00:00";
  await assertInvalidResponse(beforeWindow);

  const afterObservation = snapshotRow();
  selectedRun(afterObservation).created_at = "2026-08-04T12:00:01+00:00";
  selectedRun(afterObservation).updated_at = "2026-08-04T12:00:01+00:00";
  selectedRun(afterObservation).started_at = "2026-08-04T12:00:01+00:00";
  selectedRun(afterObservation).finished_at = "2026-08-04T12:00:01+00:00";
  await assertInvalidResponse(afterObservation);
});

Deno.test("Compute certification rejects unknown, unordered, or inconsistent violation codes", async () => {
  const unknown = snapshotRow();
  (unknown.health as Record<string, unknown>).violations = ["UNKNOWN_DRIFT"];
  await assertInvalidResponse(unknown);

  const omitted = snapshotRow();
  (omitted.health as Record<string, unknown>).terminal_active_tokens = 1;
  await assertInvalidResponse(omitted);

  const unordered = snapshotRow();
  (unordered.health as Record<string, unknown>).violations = [
    "TERMINAL_ACTIVE_TOKENS",
    "DLQ_FENCED_RUNS",
  ];
  await assertInvalidResponse(unordered);

  const latch = snapshotRow();
  latch.latch_state = "completed";
  await assertInvalidResponse(latch);
});

Deno.test("Compute certification rejects accounting and cardinality contradictions", async () => {
  const missingWalletEvent = snapshotRow();
  const missingWalletBacking = (missingWalletEvent.runs as Record<
    string,
    unknown
  >[])[0].backing as Record<string, unknown>;
  missingWalletBacking.receipt_cloud_usage_event = false;
  await assertInvalidResponse(missingWalletEvent);

  const missingBudget = snapshotRow();
  const missingBudgetRun = (missingBudget.runs as Record<string, unknown>[])[0];
  missingBudgetRun.budget = null;
  (missingBudgetRun.cardinality as Record<string, unknown>).budget_rows = 0;
  await assertInvalidResponse(missingBudget);

  const terminalReserved = snapshotRow();
  const terminalBudget = (terminalReserved.runs as Record<string, unknown>[])[0]
    .budget as Record<string, unknown>;
  terminalBudget.status = "reserved";
  terminalBudget.reserved_light = "0.000000000000";
  terminalBudget.actual_light = "0.000000000000";
  terminalBudget.released_light = "0.000000000000";
  terminalBudget.settled_at = null;
  const terminalReceipt =
    (terminalReserved.runs as Record<string, unknown>[])[0]
      .receipt as Record<string, unknown>;
  terminalReceipt.reserved_light = "0.000000000000";
  terminalReceipt.actual_light = "0.000000000000";
  terminalReceipt.released_light = "0.000000000000";
  await assertInvalidResponse(terminalReserved);

  const badConservation = snapshotRow();
  const run = (badConservation.runs as Record<string, unknown>[])[0];
  (run.receipt as Record<string, unknown>).released_light = "0.700000000000";
  await assertInvalidResponse(badConservation);

  const badReceiptId = snapshotRow();
  const otherReceipt = "55555555-5555-4555-8555-555555555555";
  ((badReceiptId.runs as Record<string, unknown>[])[0]
    .receipt as Record<string, unknown>).id = otherReceipt;
  await assertInvalidResponse(badReceiptId);

  const badTokenCount = snapshotRow();
  (badTokenCount.runs as Record<string, unknown>[])[0]
    .terminal_active_token_count = 2;
  await assertInvalidResponse(badTokenCount);

  const badArtifactCount = snapshotRow();
  const artifactRun = (badArtifactCount.runs as Record<string, unknown>[])[0];
  (artifactRun.cardinality as Record<string, unknown>).artifact_rows = 1;
  await assertInvalidResponse(badArtifactCount);

  const impossibleTariff = snapshotRow();
  const tariffRun = selectedRun(impossibleTariff);
  Object.assign(tariffRun.budget as Record<string, unknown>, {
    actual_light: "0.032896000000",
    released_light: "0.400920000000",
  });
  Object.assign(tariffRun.receipt as Record<string, unknown>, {
    billed_wall_ms: "16000",
    actual_light: "0.032896000000",
    released_light: "0.400920000000",
  });
  await assertInvalidResponse(impossibleTariff);

  const wrongRate = snapshotRow();
  (selectedRun(wrongRate).budget as Record<string, unknown>)
    .rate_light_per_ms = "0.000002057000";
  await assertInvalidResponse(wrongRate);

  const missingToken = snapshotRow();
  (selectedRun(missingToken).cardinality as Record<string, unknown>)
    .token_rows = 0;
  await assertInvalidResponse(missingToken);

  const bodyWithoutBudget = snapshotRow();
  const bodyWithoutBudgetRun = selectedRun(bodyWithoutBudget);
  bodyWithoutBudgetRun.budget = null;
  (bodyWithoutBudgetRun.cardinality as Record<string, unknown>).budget_rows = 0;
  Object.assign(bodyWithoutBudgetRun.backing as Record<string, unknown>, {
    budget_hold: false,
    receipt_hold: false,
    receipt_cloud_usage_event: false,
  });
  await assertInvalidResponse(bodyWithoutBudget);

  const preBodyUsageEvent = snapshotRow();
  convertToPreBody(selectedRun(preBodyUsageEvent), false);
  (selectedRun(preBodyUsageEvent).backing as Record<string, unknown>)
    .receipt_cloud_usage_event = true;
  await assertInvalidResponse(preBodyUsageEvent);
});

Deno.test("Compute certification validates and normalizes request bounds before database access", async () => {
  let calls = 0;
  const deps = {
    fetchFn: fetchReturning(snapshotRow(), () => {
      calls += 1;
      return Promise.resolve();
    }),
    supabaseUrl: "https://database.example",
    serviceRoleKey: "service-role",
    now: NOW,
  };

  for (
    const invalid of [
      { ...input(), ownerId: "no" },
      { ...input(), runIds: [] },
      { ...input(), runIds: [RUN_ID, RUN_ID] },
      {
        ...input(),
        runIds: Array.from(
          { length: 21 },
          (_, index) =>
            `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        ),
      },
      { ...input(), since: "2026-08-04T13:00:00.000Z" },
      { ...input(), since: "2026-08-03T12:29:59.999Z" },
    ]
  ) {
    const error = await assertRejects(
      () => getComputeCertificationSnapshot(invalid, deps),
      ComputeCertificationError,
    );
    assertEquals(error.code, "COMPUTE_CERTIFICATION_INVALID");
    assertEquals(error.status, 400);
  }
  assertEquals(calls, 0);
});

Deno.test("Compute certification maps database failures to its sealed service error", async () => {
  const error = await assertRejects(
    () =>
      getComputeCertificationSnapshot(input(), {
        fetchFn: (() =>
          Promise.reject(new Error("database detail"))) as typeof fetch,
        supabaseUrl: "https://database.example",
        serviceRoleKey: "service-role",
        now: NOW,
      }),
    ComputeCertificationError,
  );
  assertInstanceOf(error, ComputeCertificationError);
  assertEquals(error.code, "COMPUTE_CERTIFICATION_UNAVAILABLE");
  assertEquals(error.status, 503);
  assertEquals(error.message.includes("database detail"), false);
});
