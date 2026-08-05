import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import { authenticateComputeCertification } from "./compute-certification-auth.ts";

const CERTIFICATION_TOKEN = "certification-token-0123456789abcdef";
const EMERGENCY_TOKEN = "emergency-stop-token-0123456789abcdef";
const SERVICE_ROLE_TOKEN = "service-role-token-0123456789abcdef";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL = `${OWNER_ID}/${AGENT_ID}`;

function request(token?: string): Request {
  return new Request("https://api.example/api/admin/compute/certification", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

Deno.test("Compute certification auth accepts only its dedicated bearer", async () => {
  const authorized = await authenticateComputeCertification(
    request(CERTIFICATION_TOKEN),
    {
      COMPUTE_CERTIFICATION_TOKEN: CERTIFICATION_TOKEN,
      COMPUTE_EMERGENCY_STOP_TOKEN: EMERGENCY_TOKEN,
      COMPUTE_CERTIFICATION_PRINCIPAL: PRINCIPAL,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_TOKEN,
    },
  );
  assertEquals(authorized.status, "authorized");
  if (authorized.status !== "authorized") return;
  assertMatch(
    authorized.credentialReference,
    /^compute-certification:sha256:[0-9a-f]{64}$/u,
  );
  assertFalse(authorized.credentialReference.includes(CERTIFICATION_TOKEN));
  assertMatch(
    authorized.rateLimitKey,
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assertEquals(authorized.principal, {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    entry: PRINCIPAL,
  });

  assertEquals(
    await authenticateComputeCertification(request(EMERGENCY_TOKEN), {
      COMPUTE_CERTIFICATION_TOKEN: CERTIFICATION_TOKEN,
      COMPUTE_EMERGENCY_STOP_TOKEN: EMERGENCY_TOKEN,
      COMPUTE_CERTIFICATION_PRINCIPAL: PRINCIPAL,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_TOKEN,
    }),
    { status: "unauthorized" },
  );
});

Deno.test("Compute certification auth fails closed when configuration is absent or malformed", async () => {
  assertEquals(
    await authenticateComputeCertification(request(CERTIFICATION_TOKEN), {}),
    { status: "unavailable" },
  );
  assertEquals(
    await authenticateComputeCertification(request(CERTIFICATION_TOKEN), {
      COMPUTE_CERTIFICATION_TOKEN: "too-short",
      COMPUTE_CERTIFICATION_PRINCIPAL: PRINCIPAL,
    }),
    { status: "unavailable" },
  );
  assertEquals(
    await authenticateComputeCertification(request(CERTIFICATION_TOKEN), {
      COMPUTE_CERTIFICATION_TOKEN: CERTIFICATION_TOKEN,
      COMPUTE_CERTIFICATION_PRINCIPAL: "malformed",
    }),
    { status: "unavailable" },
  );
});

Deno.test("Compute certification auth rejects missing, malformed, and mismatched bearers", async () => {
  const env = {
    COMPUTE_CERTIFICATION_TOKEN: CERTIFICATION_TOKEN,
    COMPUTE_CERTIFICATION_PRINCIPAL: PRINCIPAL,
  };
  for (
    const candidate of [
      request(),
      request("wrong-token-that-is-long-enough-0123456789"),
      new Request("https://api.example/api/admin/compute/certification", {
        method: "POST",
        headers: { Authorization: `Basic ${CERTIFICATION_TOKEN}` },
      }),
      new Request("https://api.example/api/admin/compute/certification", {
        method: "POST",
        headers: { Authorization: `Bearer ${CERTIFICATION_TOKEN} extra` },
      }),
    ]
  ) {
    assertEquals(
      await authenticateComputeCertification(candidate, env),
      { status: "unauthorized" },
    );
  }
  assert(true);
});

Deno.test("Compute certification auth rejects any privileged credential collision", async () => {
  for (
    const collision of [
      { COMPUTE_EMERGENCY_STOP_TOKEN: CERTIFICATION_TOKEN },
      { SUPABASE_SERVICE_ROLE_KEY: CERTIFICATION_TOKEN },
      { COMPUTE_JOB_TOKEN_PEPPER: CERTIFICATION_TOKEN },
    ]
  ) {
    assertEquals(
      await authenticateComputeCertification(request(CERTIFICATION_TOKEN), {
        COMPUTE_CERTIFICATION_TOKEN: CERTIFICATION_TOKEN,
        COMPUTE_CERTIFICATION_PRINCIPAL: PRINCIPAL,
        ...collision,
      }),
      { status: "unavailable" },
    );
  }
});
