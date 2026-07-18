import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { LoggerLike } from "./logging.ts";
import {
  getCapacityTelemetryReconciliationSummary,
  reconcileCapacityCpuObservations,
  runCapacityTelemetryReconciliationCycle,
} from "./capacity-telemetry-reconciliation.ts";

const NOW = new Date("2026-07-18T03:00:00.000Z");

function withTestEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = globalThis.__env;
  globalThis.__env = {
    ...(previous ?? {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  } as typeof globalThis.__env;
  return run().finally(() => {
    globalThis.__env = previous;
  });
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    since: "2026-07-11T03:00:00.000Z",
    generated_at: NOW.toISOString(),
    settlements: { final: 2 },
    resource_light: {},
    pending_old_count: 0,
    oldest_pending_at: null,
    duplicate_observations: 0,
    observed_cpu_ms: 4,
    observed_wall_time_ms: 100,
    total_light: 0.1,
    attribution_pending_count: 0,
    attribution_oldest_pending_at: null,
    dynamic_worker_daily_identities: 1,
    inbox_pending_count: 0,
    inbox_oldest_pending_at: null,
    inbox_error_count: 0,
    inbox_attempts: 0,
    ...overrides,
  };
}

Deno.test("capacity telemetry reconciliation calls bounded service-role RPC", async () => {
  await withTestEnv(async () => {
    let requestBody: Record<string, unknown> | null = null;
    const result = await reconcileCapacityCpuObservations({
      limit: 10_000,
      now: NOW.toISOString(),
    }, {
      fetchFn: async (input, init) => {
        assertEquals(
          new URL(String(input)).pathname,
          "/rest/v1/rpc/reconcile_capacity_cpu_observations",
        );
        requestBody = JSON.parse(String(
          (init as { body?: BodyInit | null } | undefined)?.body,
        ));
        return Response.json([{
          processed: 3,
          applied: 2,
          pending: 1,
          errors: 0,
        }]);
      },
    });
    assertEquals(requestBody, { p_limit: 500, p_now: NOW.toISOString() });
    assertEquals(result, { processed: 3, applied: 2, pending: 1, errors: 0 });
  });
});

Deno.test("capacity telemetry summary passes an age-qualified monitor window", async () => {
  await withTestEnv(async () => {
    let requestBody: Record<string, unknown> | null = null;
    const result = await getCapacityTelemetryReconciliationSummary({
      pendingAgeMinutes: 8,
    }, {
      now: () => NOW,
      fetchFn: async (_input, init) => {
        requestBody = JSON.parse(String(
          (init as { body?: BodyInit | null } | undefined)?.body,
        ));
        return Response.json(summary());
      },
    });
    assertEquals(requestBody, {
      p_since: "2026-07-11T03:00:00.000Z",
      p_pending_age: "8 minutes",
    });
    assertEquals(result.inbox_pending_count, 0);
    assertEquals(result.observed_cpu_ms, 4);
  });
});

Deno.test("capacity telemetry cycle emits the dedicated alarm for stale inbox work", async () => {
  await withTestEnv(async () => {
    const errors: Array<
      { message: string; context?: Record<string, unknown> }
    > = [];
    const logger: LoggerLike = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message, context) => errors.push({ message, context }),
    };
    const fetchFn: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/reconcile_capacity_cpu_observations")) {
        return Response.json([{
          processed: 1,
          applied: 0,
          pending: 1,
          errors: 0,
        }]);
      }
      if (path.endsWith("/get_capacity_reconciliation_summary")) {
        return Response.json(summary({
          inbox_pending_count: 1,
          inbox_oldest_pending_at: "2026-07-18T02:50:00.000Z",
          inbox_attempts: 2,
        }));
      }
      throw new Error(`Unexpected RPC: ${path}`);
    };
    const result = await runCapacityTelemetryReconciliationCycle({}, {
      fetchFn,
      logger,
      now: () => NOW,
    });
    assertEquals(result.alarmed, true);
    assertEquals(errors.length, 1);
    assertEquals(
      errors[0].message,
      "Capacity telemetry reconciliation is degraded",
    );
    assertEquals(errors[0].context?.inbox_pending, 1);
  });
});

Deno.test("capacity telemetry cycle alarms on stale receipt attribution", async () => {
  await withTestEnv(async () => {
    const errors: Array<
      { message: string; context?: Record<string, unknown> }
    > = [];
    const logger: LoggerLike = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message, context) => errors.push({ message, context }),
    };
    const fetchFn: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith("/reconcile_capacity_cpu_observations")
        ? Response.json([{ processed: 0, applied: 0, pending: 0, errors: 0 }])
        : Response.json(summary({
          attribution_pending_count: 2,
          attribution_oldest_pending_at: "2026-07-18T02:40:00.000Z",
        }));
    };
    const result = await runCapacityTelemetryReconciliationCycle({}, {
      fetchFn,
      logger,
      now: () => NOW,
    });
    assertEquals(result.alarmed, true);
    assertEquals(errors.length, 1);
    assertEquals(errors[0].context?.attribution_pending, 2);
    assertEquals(
      errors[0].context?.attribution_oldest_pending_at,
      "2026-07-18T02:40:00.000Z",
    );
  });
});

Deno.test("capacity telemetry cycle stays quiet while fresh observations wait", async () => {
  await withTestEnv(async () => {
    let alarmed = false;
    const logger: LoggerLike = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {
        alarmed = true;
      },
    };
    const fetchFn: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith("/reconcile_capacity_cpu_observations")
        ? Response.json([{ processed: 1, applied: 0, pending: 1, errors: 0 }])
        : Response.json(summary({
          inbox_pending_count: 1,
          inbox_oldest_pending_at: "2026-07-18T02:59:00.000Z",
        }));
    };
    const result = await runCapacityTelemetryReconciliationCycle({}, {
      fetchFn,
      logger,
      now: () => NOW,
    });
    assertEquals(result.alarmed, false);
    assertEquals(alarmed, false);
  });
});
