import {
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = async (name: string) =>
  await Deno.readTextFile(
    new URL(
      `../../../supabase/migrations/${name}`,
      import.meta.url,
    ),
  );

const schema = await migration(
  "20260719120000_compute_control_plane_schema.sql",
);
const policy = await migration("20260719121000_compute_policy_secret_rpcs.sql");
const lifecycle = await migration(
  "20260719122000_compute_run_lifecycle_rpcs.sql",
);
const gateway = await migration(
  "20260719123000_compute_gateway_artifact_rpcs.sql",
);

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`missing SQL function: ${name}`);
  const next = sql.indexOf("\nCREATE OR REPLACE FUNCTION public.", start + 1);
  return sql.slice(start, next < 0 ? sql.length : next);
}

Deno.test("Compute token and container identity checks fail closed on SQL NULL", () => {
  assertStringIncludes(schema, "token_digest text NOT NULL");
  assertStringIncludes(schema, "audience text NOT NULL");

  const introspect = functionBody(gateway, "introspect_compute_job_token");
  assertStringIncludes(introspect, "p_token_digest IS NULL");
  assertStringIncludes(introspect, "p_audience IS NULL");
  assertStringIncludes(introspect, "p_container_id IS NULL");
  assertStringIncludes(
    introspect,
    "v_token.token_digest IS DISTINCT FROM p_token_digest",
  );
  assertStringIncludes(
    introspect,
    "v_token.audience IS DISTINCT FROM p_audience",
  );
  assertStringIncludes(
    introspect,
    "v_run.container_id IS DISTINCT FROM p_container_id",
  );
  assertStringIncludes(introspect, "v_run.claim_expires_at IS NULL");
  assertStringIncludes(introspect, "v_run.claim_expires_at <= now()");

  const descriptors = functionBody(
    lifecycle,
    "get_compute_run_secret_descriptors",
  );
  assertStringIncludes(descriptors, "p_container_id IS NULL");
  assertStringIncludes(
    descriptors,
    "v_run.container_id IS DISTINCT FROM btrim(p_container_id)",
  );

  const prepare = functionBody(lifecycle, "prepare_compute_run_lease");
  for (
    const guard of [
      "p_container_id IS NULL",
      "p_token_digest IS NULL",
      "p_token_audience IS NULL",
      "p_replace_existing_token IS NULL",
    ]
  ) assertStringIncludes(prepare, guard);
  assertStringIncludes(
    prepare,
    "v_run.container_id IS NOT DISTINCT FROM btrim(p_container_id)",
  );
});

Deno.test("Compute mutation CAS predicates are NULL-safe", () => {
  for (
    const [sql, name, predicate] of [
      [
        policy,
        "put_compute_agent_policy_settings",
        "v_policy.revision IS DISTINCT FROM p_expected_revision",
      ],
      [
        policy,
        "set_compute_agent_policy_state",
        "v_policy.authority_epoch IS DISTINCT FROM p_expected_authority_epoch",
      ],
      [
        policy,
        "revoke_compute_agent_secret_binding",
        "v_binding.binding_version IS DISTINCT FROM p_expected_binding_version",
      ],
      [
        lifecycle,
        "transition_compute_run",
        "v_run.state_version IS DISTINCT FROM p_expected_state_version",
      ],
      [
        gateway,
        "transition_compute_artifact",
        "v_artifact.state_version IS DISTINCT FROM p_expected_state_version",
      ],
      [
        gateway,
        "terminalize_compute_run_cancellation",
        "v_run.state_version IS DISTINCT FROM p_expected_state_version",
      ],
      [
        gateway,
        "fence_stale_compute_run",
        "v_run.state_version IS DISTINCT FROM p_expected_state_version",
      ],
      [
        gateway,
        "terminalize_stale_compute_run",
        "v_run.state_version IS DISTINCT FROM p_expected_state_version",
      ],
      [
        gateway,
        "terminalize_compute_dlq_run",
        "v_run.state_version IS DISTINCT FROM p_expected_state_version",
      ],
    ] as const
  ) {
    assertStringIncludes(functionBody(sql, name), predicate, name);
  }
});

Deno.test("Compute reconciliation requires time and affirmative body destruction", () => {
  assertStringIncludes(
    functionBody(gateway, "list_stale_compute_runs"),
    "p_now IS NULL",
  );
  for (
    const name of [
      "fence_stale_compute_run",
      "terminalize_stale_compute_run",
    ]
  ) {
    assertStringIncludes(functionBody(gateway, name), "p_now IS NULL", name);
  }
  for (
    const name of [
      "terminalize_compute_run_cancellation",
      "terminalize_stale_compute_run",
      "terminalize_compute_dlq_run",
    ]
  ) {
    const body = functionBody(gateway, name);
    assertStringIncludes(body, "p_body_destroyed IS DISTINCT FROM true", name);
    assertFalse(body.includes("AND NOT p_body_destroyed"), name);
  }
});

Deno.test("a running body cannot release its full reservation without wall time", () => {
  const transition = functionBody(lifecycle, "transition_compute_run");
  assertStringIncludes(
    transition,
    "v_run.state = 'running' AND p_worker_wall_ms IS NULL",
  );
  const guard = transition.indexOf(
    "v_run.state = 'running' AND p_worker_wall_ms IS NULL",
  );
  const release = transition.indexOf("IF p_worker_wall_ms IS NULL THEN");
  assertEquals(guard >= 0 && release >= 0 && guard < release, true);

  const finalize = functionBody(lifecycle, "finalize_compute_worker_run");
  assertStringIncludes(finalize, "p_worker_wall_ms IS NULL");
  assertStringIncludes(
    finalize,
    "v_run.lease_id IS DISTINCT FROM p_lease_id",
  );
});

Deno.test("unknown running metrics settle the entire reserved wall hold", () => {
  const terminalize = functionBody(gateway, "terminalize_compute_internal");
  assertStringIncludes(
    terminalize,
    "v_wall_ms := v_budget.reserved_wall_ms;",
  );
  assertFalse(
    terminalize.includes("reserved_wall_ms - v_run.teardown_allowance_ms"),
  );
});

Deno.test("database admission and reservations enforce the Queue-safe v1 ceiling", () => {
  assertStringIncludes(schema, "max_timeout_ms BETWEEN 1000 AND 480000");
  assertStringIncludes(
    schema,
    "requested_timeout_ms BETWEEN 1000 AND 480000",
  );
  assertStringIncludes(
    schema,
    "teardown_allowance_ms = 15000",
  );
  assertStringIncludes(policy, "p_max_timeout_ms NOT BETWEEN 1000 AND 480000");
  assertStringIncludes(
    lifecycle,
    "(p_manifest_ceiling->>'maxTimeoutMs')::bigint NOT BETWEEN 1000 AND 480000",
  );
  assertStringIncludes(
    lifecycle,
    "v_timeout_ms + 195000 + 15000",
  );
  assertStringIncludes(
    schema,
    "max_artifact_bytes BETWEEN 1 AND 1073741824",
  );
  assertStringIncludes(
    policy,
    "p_max_artifact_bytes NOT BETWEEN 1 AND 1073741824",
  );
  assertStringIncludes(
    lifecycle,
    "jsonb_array_length(p_execution_request->'inputArtifacts')\n        + jsonb_array_length(p_execution_request->'capturePaths')",
  );
  const completion = functionBody(lifecycle, "transition_compute_run");
  const completionArtifacts = completion.slice(
    completion.indexOf("IF p_to_state = 'succeeded' THEN"),
    completion.indexOf("UPDATE public.compute_job_tokens"),
  );
  assertStringIncludes(
    completionArtifacts,
    "WHERE artifact.run_id = v_run.id\n      AND artifact.state <> 'deleted'",
  );
  assertFalse(completionArtifacts.includes("artifact.direction = 'output'"));
  assertStringIncludes(
    completionArtifacts,
    "Aggregate input/output artifacts exceed the owner-confirmed limits.",
  );
});

Deno.test("Compute admission transactionally bounds unpaid work before insert", () => {
  const admission = functionBody(lifecycle, "admit_compute_run");
  const replay = admission.indexOf(
    "RETURN to_jsonb(v_existing) || jsonb_build_object('replayed', true)",
  );
  const agentLock = admission.indexOf(
    "'compute-agent:' || p_user_id::text || ':' || p_agent_id::text",
  );
  const executionGuard = admission.indexOf("COMPUTE_EXECUTION_CALL_LIMIT");
  const backlogGuard = admission.indexOf("COMPUTE_ADMISSION_BACKLOG_LIMIT");
  const rateGuard = admission.indexOf("COMPUTE_ADMISSION_RATE_LIMIT");
  const insert = admission.indexOf("INSERT INTO public.compute_runs (");

  assertEquals(
    replay >= 0 && agentLock > replay && executionGuard > agentLock &&
      backlogGuard > executionGuard && rateGuard > backlogGuard &&
      insert > rateGuard,
    true,
  );
  assertStringIncludes(
    admission,
    "c_max_runs_per_execution constant integer := 16",
  );
  assertStringIncludes(
    admission,
    "c_max_pending_runs_per_agent constant integer := 64",
  );
  assertStringIncludes(
    admission,
    "c_max_admissions_per_agent_minute constant integer := 60",
  );
  assertStringIncludes(admission, "IF p_execution_id IS NOT NULL THEN");
  assertStringIncludes(admission, "run.execution_id = p_execution_id");
  assertStringIncludes(
    admission,
    "run.user_id = p_user_id AND run.agent_id = p_agent_id",
  );
  assertStringIncludes(admission, "run.state IN ('admitted', 'queued')");
  assertStringIncludes(
    admission,
    "run.created_at >= now() - interval '1 minute'",
  );

  assertStringIncludes(
    schema,
    "CREATE INDEX compute_runs_execution_admission_idx",
  );
  assertStringIncludes(schema, "WHERE execution_id IS NOT NULL");
  assertStringIncludes(
    schema,
    "CREATE INDEX compute_runs_agent_pending_admission_idx",
  );
  assertStringIncludes(schema, "WHERE state IN ('admitted', 'queued')");
  assertStringIncludes(
    schema,
    "CREATE INDEX compute_runs_agent_created_at_idx",
  );
});

Deno.test("Compute history cannot cascade-delete and provisional owners cannot run", () => {
  for (
    const foreignKey of [
      "user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT",
      "agent_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE RESTRICT",
    ]
  ) {
    assertStringIncludes(schema, foreignKey);
  }
  const runs = schema.slice(
    schema.indexOf("CREATE TABLE public.compute_runs ("),
  );
  assertFalse(
    runs.includes(
      "user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE",
    ),
  );
  assertStringIncludes(policy, "COMPUTE_ACCOUNT_NOT_ELIGIBLE");
  assertStringIncludes(
    lifecycle,
    "owner.provisional IS NOT DISTINCT FROM false",
  );
});
