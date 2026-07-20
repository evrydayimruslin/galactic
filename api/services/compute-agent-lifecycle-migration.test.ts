function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertFalse(condition: unknown, message = "expected false"): void {
  if (condition) throw new Error(message);
}

function assertStringIncludes(
  actual: string,
  expected: string,
  message = `expected SQL to include ${expected}`,
): void {
  if (!actual.includes(expected)) throw new Error(message);
}

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260720121000_compute_agent_ownership_lifecycle.sql",
    import.meta.url,
  ),
);

function functionBody(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`missing SQL function: ${name}`);
  const next = migration.indexOf(
    "\nCREATE OR REPLACE FUNCTION public.",
    start + 1,
  );
  return migration.slice(start, next < 0 ? migration.length : next);
}

Deno.test("Compute Agent transfer shares admission lock order and blocks live work", () => {
  for (
    const name of [
      "admit_compute_run",
      "put_compute_agent_policy_settings",
      "put_compute_agent_authority_rule",
      "set_compute_agent_policy_state",
      "put_compute_agent_secret_binding",
      "revoke_compute_agent_secret_binding",
      "replace_compute_agent_configuration",
      "claim_compute_run",
      "prepare_compute_run_lease",
    ]
  ) {
    const body = functionBody(name);
    assertStringIncludes(body, "FOR SHARE", name);
    assertStringIncludes(body, "public.users AS owner", name);
    assertStringIncludes(body, "FOR KEY SHARE", name);
    const appLock = body.indexOf("FOR SHARE");
    const ownerLookup = body.indexOf("public.users AS owner");
    const ownerLock = body.indexOf("FOR KEY SHARE", ownerLookup);
    const ownerNoWait = body.indexOf("NOWAIT", ownerLock);
    const implementation = body.indexOf(`${name}_lifecycle_impl`);
    assert(
      appLock < ownerLookup && ownerLookup < ownerLock &&
        ownerLock < ownerNoWait && ownerNoWait < implementation,
      `${name} must lock its app then owner before its advisory-taking implementation`,
    );
    assert(
      appLock < implementation,
      `${name} must lock its app before its advisory-taking implementation`,
    );
    if (
      [
        "admit_compute_run",
        "put_compute_agent_authority_rule",
        "replace_compute_agent_configuration",
      ].includes(name)
    ) {
      const targetLock = body.indexOf(
        "FOR KEY SHARE",
        body.indexOf("FROM public.apps AS target"),
      );
      assert(
        appLock < targetLock && targetLock < ownerLookup,
        `${name} must lock source and target apps before its owner`,
      );
    }
  }

  const lifecycle = functionBody("guard_compute_agent_app_update");
  assertStringIncludes(
    lifecycle,
    "'compute-agent:' || OLD.owner_id::text || ':' || OLD.id::text",
  );
  assertStringIncludes(
    lifecycle,
    "run.state IN ('admitted', 'queued', 'provisioning', 'running')",
  );
  assertStringIncludes(lifecycle, "budget.status = 'reserved'");
  assertStringIncludes(lifecycle, "token.status = 'active'");
  assertStringIncludes(
    migration,
    "BEFORE UPDATE OF owner_id, deleted_at ON public.apps",
  );
});

Deno.test("transfer and soft delete revoke old and incoming configuration without broad fencing", () => {
  const cleanup = functionBody(
    "revoke_compute_agent_lifecycle_configuration",
  );
  assertStringIncludes(cleanup, "rule.action = 'agents.call'");
  assertStringIncludes(cleanup, "rule.target_agent_id = p_agent_id");
  assertStringIncludes(cleanup, "rule.status = 'active'");
  assertStringIncludes(cleanup, "SET revision = policy.revision + 1");
  assertStringIncludes(cleanup, "ORDER BY policy.agent_id, policy.user_id");
  assertStringIncludes(cleanup, "ORDER BY rule.id");
  assertStringIncludes(
    cleanup,
    "binding_version = binding.binding_version + 1",
  );
  assertStringIncludes(cleanup, "DELETE FROM public.compute_agent_policies");
  assertStringIncludes(cleanup, "state = 'revoked'");

  const incoming = cleanup.slice(
    cleanup.indexOf("WITH revoked_incoming"),
    cleanup.indexOf("UPDATE public.compute_agent_secret_bindings"),
  );
  assertFalse(incoming.includes("authority_epoch"));

  const lifecycle = functionBody("guard_compute_agent_app_update");
  assertStringIncludes(
    lifecycle,
    "OLD.owner_id, OLD.id, v_owner_transfer",
  );
});

Deno.test("agents.call target validation serializes with transfer and authorizes live ownership only", () => {
  for (
    const name of [
      "admit_compute_run",
      "put_compute_agent_authority_rule",
      "replace_compute_agent_configuration",
    ]
  ) {
    const body = functionBody(name);
    assertStringIncludes(body, "FROM public.apps AS target", name);
    assertStringIncludes(body, "target.owner_id = p_user_id", name);
    assertStringIncludes(body, "target.deleted_at IS NULL", name);
    assertStringIncludes(body, "FOR KEY SHARE", name);
    const targetLookup = body.indexOf("FROM public.apps AS target");
    const targetLock = body.indexOf("FOR KEY SHARE", targetLookup);
    assert(
      targetLookup < targetLock &&
        targetLock < body.indexOf(`${name}_lifecycle_impl`),
      `${name} must lock targets before its advisory-taking implementation`,
    );
  }

  const admission = functionBody("admit_compute_run");
  assertStringIncludes(admission, "jsonb_array_elements(p_authorities)");
  assertStringIncludes(admission, "SELECT DISTINCT");
  assertStringIncludes(admission, "ORDER BY 1");
  assertStringIncludes(admission, "COMPUTE_INVALID_AUTHORITY");
  assertStringIncludes(admission, "COMPUTE_TARGET_NOT_OWNED");

  const authorize = functionBody("authorize_compute_job_token");
  assertStringIncludes(authorize, "p_action = 'agents.call'");
  assertStringIncludes(authorize, "target.id = p_target_agent_id");
  assertStringIncludes(
    authorize,
    "target.owner_id = v_principal.user_id",
  );
  assertStringIncludes(authorize, "target.deleted_at IS NULL");
  assertStringIncludes(authorize, "target_agent_not_active");
});

Deno.test("soft and hard deletion preserve Compute destruction and history walls", () => {
  const lifecycle = functionBody("guard_compute_agent_app_update");
  assertStringIncludes(
    lifecycle,
    "OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL",
  );
  assertStringIncludes(lifecycle, "COMPUTE_AGENT_LIFECYCLE_BLOCKED");

  const hardDelete = functionBody("guard_compute_agent_app_hard_delete");
  assertStringIncludes(hardDelete, "FROM public.compute_runs AS run");
  assertStringIncludes(
    hardDelete,
    "FROM public.compute_run_authorities AS authority",
  );
  assertStringIncludes(hardDelete, "authority.target_agent_id = OLD.id");
  assertStringIncludes(
    hardDelete,
    "FROM public.compute_agent_authority_rules AS rule",
  );
  assertStringIncludes(hardDelete, "rule.target_agent_id = OLD.id");
  assertStringIncludes(hardDelete, "COMPUTE_AGENT_HISTORY_RETAINED");
  assertStringIncludes(migration, "BEFORE DELETE ON public.apps");
});

Deno.test("heartbeat fences orphaned bodies and lifecycle RPCs stay service-role-only", () => {
  const heartbeat = functionBody("heartbeat_compute_run");
  assertStringIncludes(heartbeat, "app.id = v_run.agent_id");
  assertStringIncludes(heartbeat, "app.owner_id = v_run.user_id");
  assertStringIncludes(heartbeat, "app.deleted_at IS NULL");
  assertStringIncludes(heartbeat, "stop_reason = 'agent_not_active'");
  assertStringIncludes(heartbeat, "state_version = run.state_version + 1");
  assertStringIncludes(heartbeat, "token.status = 'active'");

  assertStringIncludes(
    migration,
    "FROM PUBLIC, anon, authenticated, service_role",
  );
  assertStringIncludes(
    migration,
    "GRANT EXECUTE ON FUNCTION public.authorize_compute_job_token",
  );
  assertStringIncludes(
    migration,
    "GRANT EXECUTE ON FUNCTION public.heartbeat_compute_run(uuid, uuid)",
  );
});
