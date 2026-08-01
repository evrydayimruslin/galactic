import {
  assert,
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260730120000_builder_handoff_sessions.sql",
    import.meta.url,
  ),
);
const postgrestSchemaReloadMigration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260801000000_postgrest_schema_cache_reload.sql",
    import.meta.url,
  ),
);

function functionBody(name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = migration.indexOf(marker);
  if (start < 0) throw new Error(`missing SQL function: ${name}`);
  const next = migration.indexOf(
    "\nCREATE OR REPLACE FUNCTION public.",
    start + marker.length,
  );
  return migration.slice(start, next < 0 ? migration.length : next);
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function assertOrdered(
  value: string,
  first: string,
  second: string,
  message: string,
): void {
  const firstIndex = value.indexOf(first);
  const secondIndex = value.indexOf(second);
  assert(
    firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex,
    message,
  );
}

Deno.test("builder handoff migration fixes identity, purpose, base lineage, and exact TTL in the schema", () => {
  const sql = compact(migration);
  for (
    const column of [
      "token_id uuid NOT NULL UNIQUE",
      "candidate_set_id uuid NOT NULL UNIQUE",
      "target_app_id uuid",
      "base_version text",
      "base_source_hash text",
      "base_release_digest text",
      "base_state_digest text",
      "candidate_archive_digest text",
      "candidate_archive_bytes bigint",
      "candidate_archive_objects integer",
    ]
  ) {
    assertStringIncludes(sql, column);
  }
  assertStringIncludes(sql, "id = token_id");
  assertStringIncludes(sql, "id <> candidate_set_id");
  assertStringIncludes(
    sql,
    "intent IN ('agent', 'interface', 'function', 'routine', 'connect')",
  );
  assertStringIncludes(sql, "intent = 'connect' AND target_app_id IS NULL");
  assertStringIncludes(
    sql,
    "intent IN ('agent', 'interface', 'function', 'routine') AND target_app_id IS NOT NULL",
  );
  assertStringIncludes(
    sql,
    "intent IN ('interface', 'function', 'routine') AND base_version IS NOT NULL AND base_version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'",
  );
  assertStringIncludes(
    sql,
    "intent IN ('agent', 'connect') AND base_version IS NULL AND base_source_hash IS NULL AND base_release_digest IS NULL AND base_state_digest IS NULL",
  );
  assertStringIncludes(
    sql,
    "expires_at = created_at + interval '3600 seconds'",
  );
});

Deno.test("builder handoff schema additions explicitly reload PostgREST", () => {
  assertStringIncludes(
    compact(postgrestSchemaReloadMigration),
    "NOTIFY pgrst, 'reload schema';",
  );
});

Deno.test("builder handoff migration admits only the exact derived scope and target set", () => {
  const scope = compact(functionBody("builder_handoff_scope_set_is_exact"));
  assertStringIncludes(scope, "cardinality(p_scopes) = 3");
  assertStringIncludes(
    scope,
    "p_scopes @> ARRAY[ 'apps:read', 'agents:build', 'handoff:' || p_intent ]::text[]",
  );
  assertStringIncludes(
    scope,
    "p_scopes <@ ARRAY[ 'apps:read', 'agents:build', 'handoff:' || p_intent ]::text[]",
  );

  const create = compact(functionBody("create_builder_handoff_session"));
  assertStringIncludes(
    create,
    "ARRAY['apps:read', 'agents:build', 'handoff:' || p_intent]::text[]",
  );
  assertStringIncludes(
    create,
    "WHEN p_intent = 'connect' THEN NULL ELSE to_jsonb(ARRAY[p_target_app_id]::uuid[])",
  );
  assertStringIncludes(create, "plaintext_token");
  assertStringIncludes(
    create,
    "p_token_salt, NULL, ARRAY['apps:read'",
  );
});

Deno.test("builder handoff creation serializes and caps active or pending sessions per owner", () => {
  const create = functionBody("create_builder_handoff_session");
  const sql = compact(create);
  assertOrdered(
    create,
    "FOR NO KEY UPDATE",
    "SELECT count(*)::integer",
    "the owner lock must precede session-cap projection",
  );
  assertStringIncludes(sql, "session.owner_id = p_owner_id");
  assertStringIncludes(
    sql,
    "session.status = 'uploaded' OR ( session.status IN ('created', 'connected', 'staged', 'tested') AND session.expires_at > p_now )",
  );
  assertStringIncludes(sql, "IF v_pending_count >= 10 THEN");
  assertStringIncludes(sql, "'code', 'BUILDER_HANDOFF_SESSION_LIMIT'");
  assertOrdered(
    create,
    "IF v_pending_count >= 10 THEN",
    "INSERT INTO public.user_api_tokens",
    "session-cap denial must happen before token or session creation",
  );
  assertOrdered(
    create,
    "INSERT INTO public.user_api_tokens",
    "INSERT INTO public.builder_handoff_sessions",
    "the credential and durable session must be created in one RPC transaction",
  );
});

Deno.test("builder handoff authentication is fresh, expiring, and fail-closed on token drift", () => {
  const auth = compact(
    functionBody("authenticate_builder_handoff_session"),
  );
  assertStringIncludes(
    auth,
    "session.id = p_token_id AND session.token_id = p_token_id AND session.owner_id = p_owner_id FOR UPDATE",
  );
  assertStringIncludes(
    auth,
    "public.builder_handoff_scope_set_is_exact( p_scopes, v_session.intent )",
  );
  assertStringIncludes(auth, "v_session.expires_at <= p_now");
  assertStringIncludes(
    auth,
    "v_token.app_ids IS DISTINCT FROM (CASE WHEN v_session.intent = 'connect' THEN NULL ELSE to_jsonb(ARRAY[v_session.target_app_id]::uuid[]) END)",
  );
  assertStringIncludes(auth, "v_token.function_names IS NOT NULL");
  assertStringIncludes(
    auth,
    "v_token.expires_at IS DISTINCT FROM v_session.expires_at",
  );
  assertStringIncludes(auth, "SET status = 'revoked'");
  assertStringIncludes(
    auth,
    "DELETE FROM public.user_api_tokens AS token WHERE token.id = v_session.token_id",
  );
});

Deno.test("builder handoff transitions are ordered and same-release retesting is recoverable", () => {
  const advance = functionBody("advance_builder_handoff_session");
  const sql = compact(advance);
  assertOrdered(
    advance,
    "FOR NO KEY UPDATE",
    "FROM public.builder_handoff_sessions AS session",
    "every transition must take the owner quota lock before the session lock",
  );
  assertStringIncludes(
    sql,
    "p_event NOT IN ('stage', 'test', 'upload', 'promote')",
  );
  assertStringIncludes(
    sql,
    "v_session.intent = 'connect'",
  );
  assertStringIncludes(
    sql,
    "v_session.status NOT IN ('connected', 'staged')",
  );
  assertStringIncludes(
    sql,
    "v_session.status NOT IN ('staged', 'tested')",
  );

  const exactReplay = compact(advance.slice(
    advance.indexOf("IF v_session.status = 'tested' THEN"),
    advance.indexOf(
        "ELSIF",
        advance.indexOf("IF v_session.status = 'tested' THEN"),
      ) >= 0
      ? advance.indexOf(
        "ELSIF",
        advance.indexOf("IF v_session.status = 'tested' THEN"),
      )
      : advance.length,
  ));
  assertStringIncludes(
    exactReplay,
    "v_session.attestation_id = p_attestation_id AND v_session.attestation_digest = p_attestation_digest",
  );
  assertStringIncludes(exactReplay, "RETURN NEXT v_session; RETURN;");
  assertStringIncludes(
    exactReplay,
    "v_session.document_digest IS DISTINCT FROM p_document_digest OR v_session.report_digest IS DISTINCT FROM p_report_digest OR v_session.release_digest IS DISTINCT FROM p_release_digest",
  );
  assertStringIncludes(
    exactReplay,
    "'message', 'Builder handoff retest changed the qualified release.'",
  );
  assertStringIncludes(exactReplay, "v_event := 'retested'");
  assertStringIncludes(sql, "attestation_id = p_attestation_id");
  assertStringIncludes(sql, "attestation_digest = p_attestation_digest");
});

Deno.test("builder handoff upload atomically binds exact archive evidence under owner quota", () => {
  const advance = functionBody("advance_builder_handoff_session");
  const sql = compact(advance);
  for (
    const parameter of [
      "p_archive_digest text",
      "p_archive_bytes bigint",
      "p_archive_objects integer",
    ]
  ) {
    assertStringIncludes(sql, parameter);
  }
  assertStringIncludes(
    sql,
    "p_archive_digest !~ '^[0-9a-f]{64}$'",
  );
  assertStringIncludes(
    sql,
    "p_archive_bytes NOT BETWEEN 1 AND 104857600",
  );
  assertStringIncludes(sql, "p_archive_objects NOT BETWEEN 1 AND 256");
  assertStringIncludes(
    sql,
    "v_session.attestation_digest IS DISTINCT FROM p_attestation_digest",
  );
  assertStringIncludes(
    sql,
    "v_session.target_app_id IS DISTINCT FROM p_app_id",
  );
  assertStringIncludes(
    sql,
    "v_session.candidate_archive_digest = p_archive_digest AND v_session.candidate_archive_bytes = p_archive_bytes AND v_session.candidate_archive_objects = p_archive_objects",
  );
  assertStringIncludes(
    sql,
    "COALESCE(sum(session.candidate_archive_bytes), 0)::bigint",
  );
  assertStringIncludes(
    sql,
    "session.owner_id = v_session.owner_id AND session.status = 'uploaded' AND session.id <> v_session.id",
  );
  assertStringIncludes(
    sql,
    "v_pending_archive_count >= 10 OR v_pending_archive_bytes + p_archive_bytes > 104857600",
  );
  assertStringIncludes(
    sql,
    "'code', 'BUILDER_HANDOFF_ARCHIVE_QUOTA_EXCEEDED'",
  );
  assertOrdered(
    advance,
    "IF v_pending_archive_count >= 10",
    "SET status = 'uploaded',",
    "archive quota must be admitted before the session binds retained objects",
  );
  assertStringIncludes(sql, "candidate_archive_bytes = p_archive_bytes");
  assertStringIncludes(sql, "candidate_archive_objects = p_archive_objects");
  const uploadCommit = advance.slice(advance.indexOf("v_event := 'uploaded'"));
  assertOrdered(
    uploadCommit,
    "candidate_archive_objects = p_archive_objects",
    "DELETE FROM public.user_api_tokens AS token",
    "single-use token deletion must follow the atomic upload transition",
  );
});

Deno.test("builder handoff terminal and submitted transitions durably revoke the bearer", () => {
  const terminate = compact(
    functionBody("terminate_builder_handoff_session"),
  );
  assertStringIncludes(
    terminate,
    "p_status NOT IN ('cancelled', 'rejected', 'revoked', 'expired')",
  );
  assertStringIncludes(
    terminate,
    "SET status = v_terminal_status, status_version = session.status_version + 1, updated_at = p_now, credential_revoked_at = p_now, terminal_at = p_now",
  );
  assertStringIncludes(
    terminate,
    "DELETE FROM public.user_api_tokens AS token WHERE token.id = v_session.token_id",
  );

  const advance = compact(functionBody("advance_builder_handoff_session"));
  assertStringIncludes(
    advance,
    "SET status = 'uploaded', status_version = session.status_version + 1",
  );
  assertStringIncludes(
    advance,
    "uploaded_at = p_now, credential_revoked_at = p_now",
  );
  assertStringIncludes(
    advance,
    "SET status = 'promoted', status_version = session.status_version + 1",
  );
});

Deno.test("builder handoff persistence and mutation stay service-role only", () => {
  const sql = compact(migration);
  assertStringIncludes(
    sql,
    "ALTER TABLE public.builder_handoff_sessions ENABLE ROW LEVEL SECURITY",
  );
  assertStringIncludes(
    sql,
    "ALTER TABLE public.builder_handoff_session_events ENABLE ROW LEVEL SECURITY",
  );
  assertStringIncludes(
    sql,
    "REVOKE ALL ON TABLE public.builder_handoff_sessions FROM PUBLIC, anon, authenticated, service_role",
  );
  assertStringIncludes(
    sql,
    "GRANT SELECT ON TABLE public.builder_handoff_sessions TO service_role",
  );
  assertStringIncludes(
    sql,
    "WHERE scope.value LIKE 'handoff:%'",
  );
  for (
    const name of [
      "create_builder_handoff_session",
      "authenticate_builder_handoff_session",
      "advance_builder_handoff_session",
      "terminate_builder_handoff_session",
    ]
  ) {
    assertStringIncludes(
      sql,
      `REVOKE ALL ON FUNCTION public.${name}(`,
    );
    const revoke = sql.indexOf(`REVOKE ALL ON FUNCTION public.${name}(`);
    const grant = sql.indexOf(
      `GRANT EXECUTE ON FUNCTION public.${name}(`,
      revoke,
    );
    assert(
      revoke >= 0 && grant > revoke,
      `${name} must be re-granted narrowly`,
    );
    const grantEnd = sql.indexOf(";", grant);
    assertStringIncludes(sql.slice(grant, grantEnd), "TO service_role");
  }
  assertFalse(
    /GRANT\s+(?:ALL|INSERT|UPDATE|DELETE)\s+ON\s+TABLE\s+public\.builder_handoff_sessions/i
      .test(migration),
    "no role may mutate handoff lifecycle rows outside the RPCs",
  );
});
