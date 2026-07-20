import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  getCloudUsageReconciliationReport,
  releaseExpiredCloudUsageHolds,
} from "./cloud-usage-reconciliation.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

const HOLD_EXPIRED = "00000000-0000-4000-8000-000000000101";
const HOLD_SETTLED_MISSING_EVENT = "00000000-0000-4000-8000-000000000102";
const HOLD_RELEASED = "00000000-0000-4000-8000-000000000103";
const HOLD_RACED = "00000000-0000-4000-8000-000000000104";
const HOLD_MISSING = "00000000-0000-4000-8000-000000000199";
const EVENT_MISSING_HOLD = "00000000-0000-4000-8000-000000000201";
const EVENT_DIRECT = "00000000-0000-4000-8000-000000000202";
const EVENT_FROM_HOLD = "00000000-0000-4000-8000-000000000203";
const RECEIPT_GOOD = "00000000-0000-4000-8000-000000000301";
const RECEIPT_MISSING = "00000000-0000-4000-8000-000000000302";

function holdRow(overrides: Record<string, unknown>) {
  return {
    id: HOLD_EXPIRED,
    created_at: "2026-06-08T11:00:00Z",
    updated_at: "2026-06-08T11:00:00Z",
    expires_at: "2026-06-08T11:05:00Z",
    status: "held",
    payer_user_id: "00000000-0000-4000-8000-000000000001",
    sponsor_user_id: null,
    caller_user_id: "00000000-0000-4000-8000-000000000001",
    owner_user_id: "00000000-0000-4000-8000-000000000002",
    app_id: "00000000-0000-4000-8000-000000000003",
    function_name: "run",
    receipt_id: RECEIPT_GOOD,
    source: "tools/call",
    resource: "worker_execution",
    expected_units: 1000,
    expected_cloud_units: 4,
    expected_amount_light: 0.04,
    held_amount_light: 0.04,
    settled_amount_light: 0,
    released_amount_light: 0,
    settlement_event_id: null,
    billing_config_version: 25,
    ...overrides,
  };
}

Deno.test("cloud usage reconciliation: releases expired held holds with idempotency", async () => {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  } as typeof globalThis.__env;
  const releaseBodies: Record<string, unknown>[] = [];

  const fetchFn = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/cloud_usage_holds") {
      assertEquals(url.searchParams.get("status"), "eq.held");
      assertEquals(url.searchParams.getAll("expires_at"), [
        "not.is.null",
        "lte.2026-06-08T12:00:00.000Z",
      ]);
      assertEquals(url.searchParams.get("source"), "neq.galactic_compute");
      return Response.json([
        holdRow({ id: HOLD_EXPIRED }),
        holdRow({ id: HOLD_RACED }),
      ]);
    }

    if (url.pathname === "/rest/v1/rpc/release_cloud_usage_hold") {
      const body = JSON.parse(
        String((init as { body?: BodyInit } | undefined)?.body || "{}"),
      );
      releaseBodies.push(body);
      if (body.p_hold_id === HOLD_RACED) {
        return new Response("Cloud usage hold is not active", { status: 409 });
      }
      return Response.json([{
        hold_id: body.p_hold_id,
        released_amount_light: 0.04,
      }]);
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  }) as typeof fetch;

  try {
    const result = await releaseExpiredCloudUsageHolds({
      now: "2026-06-08T12:00:00Z",
      limit: 50,
      fetchFn,
    });

    assertEquals(result.candidate_count, 2);
    assertEquals(result.released_count, 1);
    assertEquals(result.skipped_count, 1);
    assertEquals(result.failed_count, 0);
    assertEquals(result.released_amount_light, 0.04);
    assertEquals(result.released_hold_ids, [HOLD_EXPIRED]);
    assertEquals(
      releaseBodies[0].p_idempotency_key,
      `expired_cloud_hold_release:${HOLD_EXPIRED}`,
    );
    assertEquals(
      (releaseBodies[0].p_metadata as Record<string, unknown>).release_reason,
      "expired",
    );
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("cloud usage reconciliation: reports stale holds and cross-table drift", async () => {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  } as typeof globalThis.__env;

  const fetchFn = (async (input) => {
    const url = new URL(String(input));
    if (
      url.pathname === "/rest/v1/cloud_usage_holds" &&
      url.searchParams.get("status") === "eq.held"
    ) {
      return Response.json([holdRow({ id: HOLD_EXPIRED })]);
    }
    if (
      url.pathname === "/rest/v1/cloud_usage_holds" &&
      url.searchParams.get("created_at")?.startsWith("gte.")
    ) {
      return Response.json([
        holdRow({ id: HOLD_EXPIRED }),
        holdRow({
          id: HOLD_SETTLED_MISSING_EVENT,
          status: "settled",
          held_amount_light: 0.01,
          settled_amount_light: 0.02,
          settlement_event_id: null,
        }),
        holdRow({
          id: HOLD_RELEASED,
          status: "released",
          held_amount_light: 0.02,
          released_amount_light: 0.02,
        }),
      ]);
    }
    if (
      url.pathname === "/rest/v1/cloud_usage_holds" &&
      url.searchParams.get("id")?.startsWith("in.")
    ) {
      return Response.json([holdRow({ id: HOLD_RELEASED })]);
    }
    if (url.pathname === "/rest/v1/cloud_usage_events") {
      return Response.json([
        {
          id: EVENT_MISSING_HOLD,
          created_at: "2026-06-08T11:30:00Z",
          payer_user_id: "00000000-0000-4000-8000-000000000001",
          app_id: "00000000-0000-4000-8000-000000000003",
          function_name: "run",
          receipt_id: RECEIPT_MISSING,
          source: "tools/call",
          resource: "worker_execution",
          units: 200,
          cloud_units: 1,
          amount_light: 0.003,
          billing_config_version: 25,
          hold_id: HOLD_MISSING,
        },
        {
          id: EVENT_DIRECT,
          created_at: "2026-06-08T11:31:00Z",
          payer_user_id: "00000000-0000-4000-8000-000000000001",
          app_id: "00000000-0000-4000-8000-000000000003",
          function_name: "direct",
          receipt_id: RECEIPT_GOOD,
          source: "storage",
          resource: "r2_operation",
          units: 1,
          cloud_units: 1,
          amount_light: 0.005,
          billing_config_version: 25,
          hold_id: null,
        },
        {
          id: EVENT_FROM_HOLD,
          created_at: "2026-06-08T11:32:00Z",
          payer_user_id: "00000000-0000-4000-8000-000000000001",
          app_id: "00000000-0000-4000-8000-000000000003",
          function_name: "run",
          receipt_id: RECEIPT_GOOD,
          source: "tools/call",
          resource: "worker_execution",
          units: 400,
          cloud_units: 2,
          amount_light: 0.004,
          billing_config_version: 25,
          hold_id: HOLD_RELEASED,
        },
      ]);
    }
    if (url.pathname === "/rest/v1/mcp_call_logs") {
      return Response.json([{
        id: RECEIPT_GOOD,
        created_at: "2026-06-08T11:31:30Z",
        app_id: "00000000-0000-4000-8000-000000000003",
        app_name: "Cloud App",
        method: "tools/call",
        source: "direct",
        success: true,
        infra_charge_light: 0.006,
        cloud_charge_light: 0.006,
        cloud_units: 3,
      }]);
    }
    if (url.pathname === "/rest/v1/light_ledger_entries") {
      const referenceTable = url.searchParams.get("reference_table");
      if (referenceTable === "eq.cloud_usage_holds") {
        return Response.json([
          {
            id: "ledger-hold-expired",
            reference_table: "cloud_usage_holds",
            reference_id: HOLD_EXPIRED,
            amount_light: -0.04,
          },
          {
            id: "ledger-hold-released",
            reference_table: "cloud_usage_holds",
            reference_id: HOLD_RELEASED,
            amount_light: -0.02,
          },
        ]);
      }
      return Response.json([]);
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  }) as typeof fetch;

  try {
    const report = await getCloudUsageReconciliationReport({
      now: "2026-06-08T12:00:00Z",
      since: "2026-06-08T00:00:00Z",
      limit: 10,
      scanLimit: 100,
      fetchFn,
    });

    assertEquals(report.metrics.holds_created, 3);
    assertEquals(report.metrics.holds_past_expiry, 1);
    assertEquals(report.stale_holds.amount_light, 0.04);
    assertEquals(report.metrics.settled_holds_missing_event, 1);
    assertEquals(report.metrics.settlement_overdraw_rows, 1);
    assertEquals(report.metrics.settlement_events_missing_hold, 1);
    assertEquals(report.metrics.events_missing_receipt, 1);
    assertEquals(report.metrics.holds_missing_ledger_entries, 1);
    assertEquals(report.metrics.direct_events_missing_ledger_entries, 1);
    assertEquals(report.metrics.receipt_infra_mismatches, 1);
    assertEquals(
      report.anomalies.settled_holds_missing_event[0].id,
      HOLD_SETTLED_MISSING_EVENT,
    );
    assertEquals(
      report.anomalies.settlement_events_missing_hold[0].id,
      EVENT_MISSING_HOLD,
    );
  } finally {
    globalThis.__env = previousEnv;
  }
});
