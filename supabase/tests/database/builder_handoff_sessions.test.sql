BEGIN;

SELECT plan(45);

CREATE OR REPLACE FUNCTION pg_temp.builder_handoff_error(p_sql text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_state text;
  v_detail text;
  v_code text;
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION
  WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_state = RETURNED_SQLSTATE,
      v_detail = PG_EXCEPTION_DETAIL;
    IF v_detail LIKE '{%' THEN
      BEGIN
        v_code := v_detail::jsonb ->> 'code';
      EXCEPTION
        WHEN OTHERS THEN
          v_code := NULL;
      END;
    END IF;
    RETURN v_state || ':' || COALESCE(v_code, '');
END;
$$;

CREATE TEMP TABLE builder_handoff_session_sink (
  LIKE public.builder_handoff_sessions
);

INSERT INTO auth.users (id, email)
VALUES
  (
    '00000000-0000-0000-0000-00000000b601',
    'builder-handoff-owner@example.test'
  ),
  (
    '00000000-0000-0000-0000-00000000b602',
    'builder-handoff-other@example.test'
  );

INSERT INTO public.users (id, email, display_name)
VALUES
  (
    '00000000-0000-0000-0000-00000000b601',
    'builder-handoff-owner@example.test',
    'Builder Handoff Owner'
  ),
  (
    '00000000-0000-0000-0000-00000000b602',
    'builder-handoff-other@example.test',
    'Builder Handoff Other'
  );

INSERT INTO public.apps (
  id,
  owner_id,
  slug,
  name,
  storage_key,
  visibility,
  had_external_db
) VALUES (
  '00000000-0000-0000-0000-00000000b701',
  '00000000-0000-0000-0000-00000000b601',
  'builder-handoff-existing-agent',
  'Builder Handoff Existing Agent',
  'apps/builder-handoff-existing-agent.zip',
  'private',
  false
);

SELECT ok(
  public.builder_handoff_scope_set_is_exact(
    ARRAY['apps:read', 'agents:build', 'handoff:agent']::text[],
    'agent'
  ),
  'the exact three-scope Agent handoff set is accepted'
);

SELECT ok(
  NOT public.builder_handoff_scope_set_is_exact(
    ARRAY[
      'apps:read',
      'agents:build',
      'handoff:agent',
      'apps:write'
    ]::text[],
    'agent'
  ),
  'an additional scope invalidates a handoff credential'
);

SELECT ok(
  NOT public.builder_handoff_scope_set_is_exact(
    ARRAY['apps:read', 'agents:build', 'handoff:agent']::text[],
    'routine'
  ),
  'the handoff scope must match the session intent'
);

SELECT is(
  (
    SELECT status
    FROM public.create_builder_handoff_session(
      p_owner_id => '00000000-0000-0000-0000-00000000b601',
      p_session_id => '00000000-0000-0000-0000-00000000b801',
      p_candidate_set_id => '00000000-0000-0000-0000-00000000b901',
      p_intent => 'agent',
      p_target_app_id => '00000000-0000-0000-0000-00000000b711',
      p_base_version => NULL,
      p_base_source_hash => NULL,
      p_base_release_digest => NULL,
      p_base_state_digest => NULL,
      p_token_prefix => 'gx_b6001',
      p_token_hash => repeat('a', 64),
      p_token_salt => repeat('b', 32),
      p_description_sha256 => repeat('c', 64),
      p_now => '2026-07-30T12:00:00Z'
    )
  ),
  'created',
  'creation atomically returns a created Agent handoff'
);

SELECT is(
  (
    SELECT extract(epoch FROM expires_at - created_at)::integer
    FROM public.builder_handoff_sessions
    WHERE id = '00000000-0000-0000-0000-00000000b801'
  ),
  3600,
  'a handoff has an exact 60-minute lifetime'
);

SELECT is(
  (
    SELECT scopes
    FROM public.user_api_tokens
    WHERE id = '00000000-0000-0000-0000-00000000b801'
  ),
  ARRAY['apps:read', 'agents:build', 'handoff:agent']::text[],
  'the durable bearer stores only the exact handoff scopes'
);

SELECT is(
  (
    SELECT app_ids
    FROM public.user_api_tokens
    WHERE id = '00000000-0000-0000-0000-00000000b801'
  ),
  to_jsonb(
    ARRAY['00000000-0000-0000-0000-00000000b711'::uuid]
  ),
  'the Agent bearer is bound to its reserved Agent identity'
);

SELECT ok(
  (
    SELECT plaintext_token IS NULL
      AND function_names IS NULL
    FROM public.user_api_tokens
    WHERE id = '00000000-0000-0000-0000-00000000b801'
  ),
  'the database stores no reusable plaintext bearer or function wildcard'
);

SELECT is(
  (
    SELECT
      intent || ':' ||
      target_app_id::text || ':' ||
      (base_version IS NULL)::text || ':' ||
      (base_state_digest IS NULL)::text
    FROM public.builder_handoff_sessions
    WHERE id = '00000000-0000-0000-0000-00000000b801'
  ),
  'agent:00000000-0000-0000-0000-00000000b711:true:true',
  'a new-Agent handoff binds its target and carries no base lineage'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.apps
    WHERE id = '00000000-0000-0000-0000-00000000b711'
  ),
  0,
  'reserving a new Agent identity does not materialize an Agent'
);

SELECT is(
  pg_temp.builder_handoff_error(
    $request$
      SELECT *
      FROM public.create_builder_handoff_session(
        '00000000-0000-0000-0000-00000000b601',
        '00000000-0000-0000-0000-00000000b806',
        '00000000-0000-0000-0000-00000000b906',
        'function',
        '00000000-0000-0000-0000-00000000b701',
        NULL, NULL, NULL, NULL,
        'gx_b6006', repeat('6', 64), repeat('6', 32),
        repeat('6', 64), '2026-07-30T12:00:00Z'
      )
    $request$
  ),
  '22023:BUILDER_HANDOFF_CREATE_INVALID',
  'an extension handoff without base lineage is rejected'
);

SELECT is(
  pg_temp.builder_handoff_error(
    $request$
      SELECT *
      FROM public.create_builder_handoff_session(
        '00000000-0000-0000-0000-00000000b601',
        '00000000-0000-0000-0000-00000000b807',
        '00000000-0000-0000-0000-00000000b907',
        'connect',
        '00000000-0000-0000-0000-00000000b701',
        NULL, NULL, NULL, NULL,
        'gx_b6007', repeat('7', 64), repeat('7', 32),
        repeat('7', 64), '2026-07-30T12:00:00Z'
      )
    $request$
  ),
  '22023:BUILDER_HANDOFF_CREATE_INVALID',
  'a Connect handoff cannot bind a target Agent'
);

SELECT is(
  pg_temp.builder_handoff_error(
    $request$
      SELECT *
      FROM public.create_builder_handoff_session(
        '00000000-0000-0000-0000-00000000b601',
        '00000000-0000-0000-0000-00000000b808',
        '00000000-0000-0000-0000-00000000b908',
        'agent',
        '00000000-0000-0000-0000-00000000b718',
        '1.0.0', repeat('8', 64), repeat('8', 64), repeat('8', 64),
        'gx_b6008', repeat('8', 64), repeat('8', 32),
        repeat('8', 64), '2026-07-30T12:00:00Z'
      )
    $request$
  ),
  '22023:BUILDER_HANDOFF_CREATE_INVALID',
  'a new-Agent handoff cannot spoof extension base lineage'
);

SELECT is(
  (
    SELECT status
    FROM public.create_builder_handoff_session(
      p_owner_id => '00000000-0000-0000-0000-00000000b601',
      p_session_id => '00000000-0000-0000-0000-00000000b802',
      p_candidate_set_id => '00000000-0000-0000-0000-00000000b902',
      p_intent => 'function',
      p_target_app_id => '00000000-0000-0000-0000-00000000b701',
      p_base_version => '2.3.4',
      p_base_source_hash => repeat('5', 64),
      p_base_release_digest => repeat('6', 64),
      p_base_state_digest => repeat('7', 64),
      p_token_prefix => 'gx_b6002',
      p_token_hash => repeat('d', 64),
      p_token_salt => repeat('e', 32),
      p_description_sha256 => repeat('f', 64),
      p_now => '2026-07-30T12:00:00Z'
    )
  ),
  'created',
  'an owned extension target with complete base lineage is accepted'
);

SELECT is(
  (
    SELECT
      base_version || ':' ||
      base_source_hash || ':' ||
      base_release_digest || ':' ||
      base_state_digest
    FROM public.builder_handoff_sessions
    WHERE id = '00000000-0000-0000-0000-00000000b802'
  ),
  '2.3.4:' || repeat('5', 64) || ':' ||
    repeat('6', 64) || ':' || repeat('7', 64),
  'the extension session durably binds all base-lineage evidence'
);

SELECT is(
  pg_temp.builder_handoff_error(
    $request$
      SELECT *
      FROM public.create_builder_handoff_session(
        '00000000-0000-0000-0000-00000000b602',
        '00000000-0000-0000-0000-00000000b809',
        '00000000-0000-0000-0000-00000000b909',
        'routine',
        '00000000-0000-0000-0000-00000000b701',
        '2.3.4', repeat('5', 64), repeat('6', 64), repeat('7', 64),
        'gx_b6009', repeat('9', 64), repeat('9', 32),
        repeat('9', 64), '2026-07-30T12:00:00Z'
      )
    $request$
  ),
  'P0002:BUILDER_HANDOFF_TARGET_NOT_FOUND',
  'an extension target owned by another account is rejected'
);

SELECT is(
  (
    SELECT status
    FROM public.terminate_builder_handoff_session(
      '00000000-0000-0000-0000-00000000b601',
      '00000000-0000-0000-0000-00000000b802',
      'cancelled',
      '2026-07-30T12:01:00Z'
    )
  ),
  'cancelled',
  'an unused extension handoff can be terminally cancelled'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.user_api_tokens
    WHERE id = '00000000-0000-0000-0000-00000000b802'
  ),
  0,
  'cancelling a handoff deletes its bearer'
);

SELECT is(
  (
    SELECT status
    FROM public.authenticate_builder_handoff_session(
      '00000000-0000-0000-0000-00000000b601',
      '00000000-0000-0000-0000-00000000b801',
      ARRAY['apps:read', 'agents:build', 'handoff:agent']::text[],
      '2026-07-30T12:01:00Z'
    )
  ),
  'connected',
  'first successful authentication connects the durable handoff'
);

SELECT is(
  (
    SELECT last_used_at
    FROM public.user_api_tokens
    WHERE id = '00000000-0000-0000-0000-00000000b801'
  ),
  '2026-07-30T12:01:00Z'::timestamptz,
  'successful authentication records bearer use'
);

SELECT is(
  (
    SELECT status
    FROM public.advance_builder_handoff_session(
      '00000000-0000-0000-0000-00000000b601',
      '00000000-0000-0000-0000-00000000b801',
      'stage',
      'gxb1_' || repeat('b', 64),
      repeat('c', 64),
      NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL,
      '2026-07-30T12:02:00Z'
    )
  ),
  'staged',
  'the connected handoff stages one exact source bundle'
);

SELECT is(
  (
    SELECT
      lineage_revision::text || ':' ||
      bundle_id || ':' ||
      source_hash
    FROM public.builder_handoff_sessions
    WHERE id = '00000000-0000-0000-0000-00000000b801'
  ),
  '1:gxb1_' || repeat('b', 64) || ':' || repeat('c', 64),
  'staging increments lineage and binds bundle plus source hashes'
);

SELECT is(
  (
    SELECT status
    FROM public.advance_builder_handoff_session(
      '00000000-0000-0000-0000-00000000b601',
      '00000000-0000-0000-0000-00000000b801',
      'test',
      'gxb1_' || repeat('b', 64),
      repeat('c', 64),
      'attestation-initial',
      repeat('d', 64),
      repeat('e', 64),
      repeat('f', 64),
      repeat('1', 64),
      NULL, NULL, NULL, NULL, NULL,
      '2026-07-30T12:03:00Z'
    )
  ),
  'tested',
  'the staged source accepts its first qualification evidence'
);

SELECT is(
  (
    SELECT
      attestation_id || ':' ||
      attestation_digest || ':' ||
      document_digest || ':' ||
      report_digest || ':' ||
      release_digest
    FROM public.builder_handoff_sessions
    WHERE id = '00000000-0000-0000-0000-00000000b801'
  ),
  'attestation-initial:' || repeat('d', 64) || ':' ||
    repeat('e', 64) || ':' || repeat('f', 64) || ':' || repeat('1', 64),
  'qualification binds the complete release-evidence tuple'
);

SELECT is(
  (
    SELECT status
    FROM public.advance_builder_handoff_session(
      '00000000-0000-0000-0000-00000000b601',
      '00000000-0000-0000-0000-00000000b801',
      'test',
      'gxb1_' || repeat('b', 64),
      repeat('c', 64),
      'attestation-retry',
      repeat('2', 64),
      repeat('e', 64),
      repeat('f', 64),
      repeat('1', 64),
      NULL, NULL, NULL, NULL, NULL,
      '2026-07-30T12:04:00Z'
    )
  ),
  'tested',
  'a retry may refresh attestation evidence for the same release'
);

SELECT is(
  (
    SELECT
      status_version::text || ':' ||
      attestation_id || ':' ||
      attestation_digest || ':' ||
      document_digest || ':' ||
      report_digest || ':' ||
      release_digest
    FROM public.builder_handoff_sessions
    WHERE id = '00000000-0000-0000-0000-00000000b801'
  ),
  '4:attestation-retry:' || repeat('2', 64) || ':' ||
    repeat('e', 64) || ':' || repeat('f', 64) || ':' || repeat('1', 64),
  'retest replaces only attestation evidence and advances status version'
);

SELECT is(
  (
    SELECT string_agg(event, ',' ORDER BY status_version)
    FROM public.builder_handoff_session_events
    WHERE session_id = '00000000-0000-0000-0000-00000000b801'
  ),
  'created,connected,staged,tested,retested',
  'the event journal distinguishes the initial test from a retest'
);

SELECT is(
  pg_temp.builder_handoff_error(
    $request$
      SELECT *
      FROM public.advance_builder_handoff_session(
        '00000000-0000-0000-0000-00000000b601',
        '00000000-0000-0000-0000-00000000b801',
        'test',
        'gxb1_' || repeat('b', 64),
        repeat('c', 64),
        'attestation-mutated-release',
        repeat('3', 64),
        repeat('e', 64),
        repeat('f', 64),
        repeat('9', 64),
        NULL, NULL, NULL, NULL, NULL,
        '2026-07-30T12:05:00Z'
      )
    $request$
  ),
  'P0001:BUILDER_HANDOFF_LINEAGE_CONFLICT',
  'a retest cannot replace the qualified release digest'
);

SELECT is(
  pg_temp.builder_handoff_error(
    $request$
      SELECT *
      FROM public.advance_builder_handoff_session(
        '00000000-0000-0000-0000-00000000b601',
        '00000000-0000-0000-0000-00000000b801',
        'upload',
        'gxb1_' || repeat('b', 64),
        repeat('c', 64),
        'attestation-retry',
        repeat('0', 64),
        repeat('e', 64),
        repeat('f', 64),
        repeat('1', 64),
        repeat('3', 64), 4096, 7,
        '00000000-0000-0000-0000-00000000b711',
        '1.0.0',
        '2026-07-30T12:05:00Z'
      )
    $request$
  ),
  'P0001:BUILDER_HANDOFF_LINEAGE_CONFLICT',
  'candidate submission cannot substitute different test evidence'
);

SELECT is(
  (
    SELECT status
    FROM public.advance_builder_handoff_session(
      '00000000-0000-0000-0000-00000000b601',
      '00000000-0000-0000-0000-00000000b801',
      'upload',
      'gxb1_' || repeat('b', 64),
      repeat('c', 64),
      'attestation-retry',
      repeat('2', 64),
      repeat('e', 64),
      repeat('f', 64),
      repeat('1', 64),
      repeat('3', 64),
      4096,
      7,
      '00000000-0000-0000-0000-00000000b711',
      '1.0.0',
      '2026-07-30T12:06:00Z'
    )
  ),
  'uploaded',
  'the exact qualified candidate can be submitted'
);

SELECT is(
  (
    SELECT
      candidate_archive_digest || ':' ||
      candidate_archive_bytes::text || ':' ||
      candidate_archive_objects::text || ':' ||
      uploaded_app_id::text || ':' ||
      uploaded_version
    FROM public.builder_handoff_sessions
    WHERE id = '00000000-0000-0000-0000-00000000b801'
  ),
  repeat('3', 64) ||
    ':4096:7:00000000-0000-0000-0000-00000000b711:1.0.0',
  'submission binds archive digest, byte/object counts, target, and version'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.user_api_tokens
    WHERE id = '00000000-0000-0000-0000-00000000b801'
  ),
  0,
  'successful candidate submission consumes the bearer'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.apps
    WHERE id = '00000000-0000-0000-0000-00000000b711'
  ),
  0,
  'submitting an Agent candidate still does not deploy or materialize it'
);

SELECT is(
  pg_temp.builder_handoff_error(
    $request$
      SELECT *
      FROM public.advance_builder_handoff_session(
        '00000000-0000-0000-0000-00000000b601',
        '00000000-0000-0000-0000-00000000b801',
        'upload',
        'gxb1_' || repeat('b', 64),
        repeat('c', 64),
        'attestation-retry',
        repeat('2', 64),
        repeat('e', 64),
        repeat('f', 64),
        repeat('1', 64),
        repeat('4', 64), 4096, 7,
        '00000000-0000-0000-0000-00000000b711',
        '1.0.0',
        '2026-07-30T12:07:00Z'
      )
    $request$
  ),
  'P0001:BUILDER_HANDOFF_LINEAGE_CONFLICT',
  'an uploaded candidate archive is immutable'
);

SELECT is(
  (
    SELECT event
    FROM public.builder_handoff_session_events
    WHERE session_id = '00000000-0000-0000-0000-00000000b801'
    ORDER BY status_version DESC
    LIMIT 1
  ),
  'uploaded',
  'candidate submission is durably journaled'
);

-- Prepare a second same-owner candidate through testing, then verify that its
-- maximum-sized archive cannot exceed the owner's remaining pending quota.
INSERT INTO builder_handoff_session_sink
SELECT *
FROM public.create_builder_handoff_session(
  '00000000-0000-0000-0000-00000000b601',
  '00000000-0000-0000-0000-00000000b803',
  '00000000-0000-0000-0000-00000000b903',
  'agent',
  '00000000-0000-0000-0000-00000000b712',
  NULL, NULL, NULL, NULL,
  'gx_b6003', repeat('3', 64), repeat('3', 32),
  repeat('3', 64), '2026-07-30T12:00:00Z'
);

INSERT INTO builder_handoff_session_sink
SELECT *
FROM public.authenticate_builder_handoff_session(
  '00000000-0000-0000-0000-00000000b601',
  '00000000-0000-0000-0000-00000000b803',
  ARRAY['apps:read', 'agents:build', 'handoff:agent']::text[],
  '2026-07-30T12:01:00Z'
);

INSERT INTO builder_handoff_session_sink
SELECT *
FROM public.advance_builder_handoff_session(
  '00000000-0000-0000-0000-00000000b601',
  '00000000-0000-0000-0000-00000000b803',
  'stage',
  'gxb1_' || repeat('4', 64),
  repeat('5', 64),
  NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL,
  '2026-07-30T12:02:00Z'
);

INSERT INTO builder_handoff_session_sink
SELECT *
FROM public.advance_builder_handoff_session(
  '00000000-0000-0000-0000-00000000b601',
  '00000000-0000-0000-0000-00000000b803',
  'test',
  'gxb1_' || repeat('4', 64),
  repeat('5', 64),
  'quota-attestation',
  repeat('6', 64),
  repeat('7', 64),
  repeat('8', 64),
  repeat('9', 64),
  NULL, NULL, NULL, NULL, NULL,
  '2026-07-30T12:03:00Z'
);

SELECT is(
  pg_temp.builder_handoff_error(
    $request$
      SELECT *
      FROM public.advance_builder_handoff_session(
        '00000000-0000-0000-0000-00000000b601',
        '00000000-0000-0000-0000-00000000b803',
        'upload',
        'gxb1_' || repeat('4', 64),
        repeat('5', 64),
        'quota-attestation',
        repeat('6', 64),
        repeat('7', 64),
        repeat('8', 64),
        repeat('9', 64),
        repeat('a', 64), 104857600, 8,
        '00000000-0000-0000-0000-00000000b712',
        '1.0.0',
        '2026-07-30T12:04:00Z'
      )
    $request$
  ),
  'P0001:BUILDER_HANDOFF_ARCHIVE_QUOTA_EXCEEDED',
  'pending candidate archives cannot exceed the per-owner byte quota'
);

SELECT is(
  (
    SELECT
      status || ':' ||
      (candidate_archive_digest IS NULL)::text || ':' ||
      (
        EXISTS (
          SELECT 1
          FROM public.user_api_tokens
          WHERE id = '00000000-0000-0000-0000-00000000b803'
        )
      )::text
    FROM public.builder_handoff_sessions
    WHERE id = '00000000-0000-0000-0000-00000000b803'
  ),
  'tested:true:true',
  'a quota rejection preserves tested state and its retryable bearer'
);

SELECT is(
  (
    SELECT
      status || ':' ||
      (target_app_id IS NULL)::text || ':' ||
      (base_state_digest IS NULL)::text
    FROM public.create_builder_handoff_session(
      '00000000-0000-0000-0000-00000000b601',
      '00000000-0000-0000-0000-00000000b804',
      '00000000-0000-0000-0000-00000000b904',
      'connect',
      NULL,
      NULL, NULL, NULL, NULL,
      'gx_b6004', repeat('4', 64), repeat('4', 32),
      repeat('4', 64), '2026-07-30T12:10:00Z'
    )
  ),
  'created:true:true',
  'a Connect handoff is inspection-only with no target or base lineage'
);

UPDATE public.user_api_tokens
SET scopes = ARRAY[
  'apps:read',
  'agents:build',
  'handoff:connect',
  'apps:write'
]::text[]
WHERE id = '00000000-0000-0000-0000-00000000b804';

SELECT is(
  (
    SELECT status
    FROM public.authenticate_builder_handoff_session(
      '00000000-0000-0000-0000-00000000b601',
      '00000000-0000-0000-0000-00000000b804',
      ARRAY['apps:read', 'agents:build', 'handoff:connect']::text[],
      '2026-07-30T12:11:00Z'
    )
  ),
  'revoked',
  'tampering with durable bearer authority terminally revokes the handoff'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.user_api_tokens
    WHERE id = '00000000-0000-0000-0000-00000000b804'
  ),
  0,
  'revocation deletes the tampered bearer'
);

SELECT is(
  (
    SELECT event || ':' || status
    FROM public.builder_handoff_session_events
    WHERE session_id = '00000000-0000-0000-0000-00000000b804'
    ORDER BY status_version DESC
    LIMIT 1
  ),
  'revoked:revoked',
  'terminal revocation is recorded in the event journal'
);

SET LOCAL request.jwt.claim.sub =
  '00000000-0000-0000-0000-00000000b601';
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $request$
    INSERT INTO public.user_api_tokens (
      id,
      user_id,
      name,
      token_prefix,
      token_hash,
      token_salt,
      plaintext_token,
      scopes,
      created_at,
      expires_at
    ) VALUES (
      '00000000-0000-0000-0000-00000000b805',
      '00000000-0000-0000-0000-00000000b601',
      'Ordinary self-minted API token',
      'gx_b6005',
      repeat('5', 64),
      repeat('5', 32),
      NULL,
      ARRAY['apps:read']::text[],
      '2026-07-30T12:00:00Z',
      '2026-07-30T13:00:00Z'
    )
  $request$,
  'the existing policy still permits an owner to create an ordinary token'
);

SELECT throws_ok(
  $request$
    INSERT INTO public.user_api_tokens (
      id,
      user_id,
      name,
      token_prefix,
      token_hash,
      token_salt,
      plaintext_token,
      scopes,
      created_at,
      expires_at
    ) VALUES (
      '00000000-0000-0000-0000-00000000b806',
      '00000000-0000-0000-0000-00000000b601',
      'Forged Builder handoff token',
      'gx_b6006',
      repeat('6', 64),
      repeat('6', 32),
      NULL,
      ARRAY['apps:read', 'agents:build', 'handoff:agent']::text[],
      '2026-07-30T12:00:00Z',
      '2026-07-30T13:00:00Z'
    )
  $request$,
  '42501',
  'new row violates row-level security policy for table "user_api_tokens"',
  'an authenticated owner cannot self-mint a handoff-marked bearer'
);

RESET ROLE;

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.create_builder_handoff_session(uuid,uuid,uuid,text,uuid,text,text,text,text,text,text,text,text,timestamptz)',
    'EXECUTE'
  ),
  'authenticated clients cannot invoke the atomic handoff minting RPC'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.create_builder_handoff_session(uuid,uuid,uuid,text,uuid,text,text,text,text,bigint,text,text,text,text,timestamptz)',
    'EXECUTE'
  ),
  'the service role can invoke the generation-aware handoff minting RPC'
);

SELECT * FROM finish();

ROLLBACK;
