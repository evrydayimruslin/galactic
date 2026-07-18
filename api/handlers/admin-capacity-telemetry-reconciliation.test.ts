import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleAdmin } from "./admin.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

Deno.test("admin capacity telemetry reconciliation is authenticated and read-only", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  } as typeof globalThis.__env;
  const rpcBodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    assertEquals(
      url.pathname,
      "/rest/v1/rpc/get_capacity_reconciliation_summary",
    );
    const requestInit = init as {
      method?: string;
      body?: BodyInit | null;
    } | undefined;
    assertEquals(requestInit?.method, "POST");
    const rpcBody = JSON.parse(String(requestInit?.body)) as Record<
      string,
      unknown
    >;
    rpcBodies.push(rpcBody);
    return Response.json({
      since: rpcBody.p_since,
      generated_at: new Date().toISOString(),
      settlements: {},
      resource_light: {},
      pending_old_count: 0,
      oldest_pending_at: null,
      duplicate_observations: 0,
      observed_cpu_ms: 0,
      observed_wall_time_ms: 0,
      total_light: 0,
      dynamic_worker_daily_identities: 0,
      inbox_pending_count: 0,
      inbox_oldest_pending_at: null,
      inbox_error_count: 0,
      inbox_attempts: 0,
    });
  }) as typeof fetch;

  try {
    const unauthorized = await handleAdmin(
      new Request(
        "https://example.com/api/admin/capacity-telemetry/reconciliation",
      ),
    );
    assertEquals(unauthorized.status, 401);

    const response = await handleAdmin(
      new Request(
        "https://example.com/api/admin/capacity-telemetry/reconciliation?days=3&pending_age_minutes=8",
        { headers: { Authorization: "Bearer service-role-key" } },
      ),
    );
    assertEquals(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assertEquals(body.success, true);
    assertEquals(body.period_days, 3);
    assertEquals(body.pending_age_minutes, 8);
    assertEquals(rpcBodies[0]?.p_pending_age, "8 minutes");
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});
