import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { registerComputeArtifact } from "./artifacts.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const IDEMPOTENCY_ID = "44444444-4444-4444-8444-444444444444";
const FIRST_ID = "55555555-5555-4555-8555-555555555555";
const SECOND_ID = "66666666-6666-4666-8666-666666666666";
const DIGEST = "a".repeat(64);

function row(artifactId: string, storageKey: string) {
  return {
    id: artifactId,
    run_id: RUN_ID,
    user_id: USER_ID,
    source_artifact_id: null,
    direction: "output",
    mount_path: null,
    logical_name: "report.pdf",
    media_type: "application/pdf",
    storage_key: storageKey,
    sha256: DIGEST,
    size_bytes: "3",
    state: "pending",
    state_version: "1",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    replayed: false,
  };
}

Deno.test("artifact retry hash excludes fresh server placement proposals", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const invoke = async (artifactId: string) => {
    const storageKey =
      `compute-v1/${USER_ID}/${AGENT_ID}/${RUN_ID}/outputs/gx-${artifactId}`;
    await registerComputeArtifact({
      artifactId,
      idempotencyKey: IDEMPOTENCY_ID,
      runId: RUN_ID,
      userId: USER_ID,
      agentId: AGENT_ID,
      callerFunction: "develop",
      storageKey,
      direction: "output",
      logicalName: "report.pdf",
      mediaType: "application/pdf",
      sha256: DIGEST,
      sizeBytes: 3,
    }, {
      supabaseUrl: "https://supabase.example",
      serviceRoleKey: "service-role",
      fetchFn: ((_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(new Response(JSON.stringify(row(artifactId, storageKey))));
      }) as typeof fetch,
    });
  };

  await invoke(FIRST_ID);
  await invoke(SECOND_ID);
  assertNotEquals(bodies[0].p_artifact_id, bodies[1].p_artifact_id);
  assertNotEquals(bodies[0].p_storage_key, bodies[1].p_storage_key);
  assertEquals(bodies[0].p_request_hash, bodies[1].p_request_hash);
});
