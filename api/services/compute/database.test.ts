import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { callComputeRpc, ComputeControlPlaneError } from "./database.ts";

for (const postgresCode of ["55P03", "40001"]) {
  Deno.test(`Compute maps ${postgresCode} lifecycle contention to retryable conflict`, async () => {
    const failure = await assertRejects(
      () =>
        callComputeRpc("test_rpc", {}, {
          supabaseUrl: "https://database.example",
          serviceRoleKey: "test-service-role",
          fetchFn: () =>
            Promise.resolve(Response.json({
              code: postgresCode,
              message: "raw database lock detail",
            }, { status: 500 })),
        }),
      ComputeControlPlaneError,
    );
    assertEquals(failure.code, "COMPUTE_CONCURRENT_LIFECYCLE");
    assertEquals(failure.status, 409);
    assertEquals(failure.message.includes("raw database"), false);
    assertEquals(failure.details, { postgresCode });
  });
}
