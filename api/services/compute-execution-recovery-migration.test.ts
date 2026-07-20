function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
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
    "../../supabase/migrations/20260720125000_compute_execution_recovery.sql",
    import.meta.url,
  ),
);
const ownershipMigration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260720121000_compute_agent_ownership_lifecycle.sql",
    import.meta.url,
  ),
);

Deno.test("live claim recovery is bounded, private, and reconstructs exact inputs", () => {
  assertStringIncludes(
    ownershipMigration,
    "ALTER FUNCTION public.claim_compute_run(uuid)\nRENAME TO claim_compute_run_lifecycle_impl",
  );
  for (
    const fragment of [
      "v_result := public.claim_compute_run_lifecycle_impl(p_run_id)",
      "v_result->>'reason' IS DISTINCT FROM 'already_claimed'",
      "v_run.state NOT IN ('provisioning', 'running')",
      "v_run.stop_requested_at IS NOT NULL",
      "v_run.claim_expires_at <= now()",
      "v_run.expires_at <= now()",
      "v_ready_inputs IS DISTINCT FROM v_expected_inputs",
      "SET status = 'revoked'",
      "claim_id = gen_random_uuid()",
      "claim_expires_at = LEAST(now() + interval '5 minutes', run.expires_at)",
      "'claimed', true",
      "'recovered', true",
      "FOR SHARE OF app",
      "FOR KEY SHARE OF owner NOWAIT",
    ]
  ) assertStringIncludes(migration, fragment);

  assertStringIncludes(
    migration,
    "REVOKE ALL ON FUNCTION public.claim_compute_run(uuid)\n  FROM PUBLIC, anon, authenticated",
  );
  assertStringIncludes(
    migration,
    "GRANT EXECUTE ON FUNCTION public.claim_compute_run(uuid) TO service_role",
  );
  assert(
    !migration.includes(
      "GRANT EXECUTE ON FUNCTION public.claim_compute_run(uuid) TO authenticated",
    ),
  );
});
