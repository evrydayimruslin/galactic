import assert from "node:assert/strict";
import { test } from "node:test";
import { runCanonicalAttentionDbProbe } from "./canonical-attention-db-probe.mjs";

const SECRET = "never-print-this-secret";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function env() {
  return {
    ULTRALIGHT_TOKEN: SECRET,
    GALACTIC_SMOKE_APP_ID: AGENT_ID,
    SUPABASE_ACCESS_TOKEN: SECRET,
    SUPABASE_STAGING_PROJECT_ID: "mtekfhozmsboxizxxxyn",
  };
}

function dependencies(readOperatorAttentionPage) {
  const keys = {
    supabaseUrl: "https://mtekfhozmsboxizxxxyn.supabase.co",
    anonKey: SECRET,
    serviceRoleKey: SECRET,
  };
  return {
    keys,
    resolveOwner: async () => ({
      id: OWNER_ID,
      smokeAgentId: AGENT_ID,
    }),
    fetchProjectKeys: async () => keys,
    loadReader: async () => ({
      readOperatorAttentionPage,
      operatorItemReadFailureStage: () => "item_diagnosis_invalid",
    }),
  };
}

test("accepts a valid projection without returning private data", async () => {
  const deps = dependencies(async () => ({
    contractVersion: "2026-07-24.operator-issues.1",
    available: true,
    unavailableReason: null,
    items: [],
    agentCounts: [],
  }));
  assert.deepEqual(
    await runCanonicalAttentionDbProbe({ env: env(), ...deps }),
    { valid: true },
  );
  assert.equal(deps.keys.anonKey, "");
  assert.equal(deps.keys.serviceRoleKey, "");
});

test("reports only an allowlisted reader stage and scrubs keys", async () => {
  const deps = dependencies(async () => {
    throw new Error(`private body ${SECRET}`);
  });
  await assert.rejects(
    () => runCanonicalAttentionDbProbe({ env: env(), ...deps }),
    (error) =>
      error instanceof Error &&
      error.message ===
        "Canonical Agent Attention reader failed at the allowlisted item_diagnosis_invalid stage." &&
      !error.message.includes(SECRET),
  );
  assert.equal(deps.keys.anonKey, "");
  assert.equal(deps.keys.serviceRoleKey, "");
});

test("collapses arbitrary diagnostics to the unknown stage", async () => {
  const deps = dependencies(async () => {
    throw new Error(SECRET);
  });
  deps.loadReader = async () => ({
    readOperatorAttentionPage: async () => {
      throw new Error(SECRET);
    },
    operatorItemReadFailureStage: () => `arbitrary-${SECRET}`,
  });
  await assert.rejects(
    () => runCanonicalAttentionDbProbe({ env: env(), ...deps }),
    /allowlisted unknown stage/u,
  );
});
