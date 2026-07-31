-- Durable, single-candidate Builder handoffs for membership onboarding.
--
-- A handoff credential is deliberately not authorized by its scope strings.
-- This service-role-only session is the authoritative mapping from one
-- short-lived user_api_tokens row to one candidate set, one reserved Agent ID,
-- and one immutable staged/tested/uploaded lineage.

CREATE TABLE public.builder_handoff_sessions (
  id uuid PRIMARY KEY,
  token_id uuid NOT NULL UNIQUE,
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  candidate_set_id uuid NOT NULL UNIQUE,
  intent text NOT NULL,
  target_app_id uuid,
  base_version text,
  base_source_hash text,
  base_release_digest text,
  base_state_digest text,
  status text NOT NULL DEFAULT 'created',
  status_version bigint NOT NULL DEFAULT 0,
  lineage_revision integer NOT NULL DEFAULT 0,
  description_sha256 text NOT NULL,
  bundle_id text,
  source_hash text,
  attestation_id text,
  attestation_digest text,
  document_digest text,
  report_digest text,
  release_digest text,
  candidate_archive_digest text,
  candidate_archive_bytes bigint,
  candidate_archive_objects integer,
  uploaded_app_id uuid,
  uploaded_version text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  connected_at timestamptz,
  staged_at timestamptz,
  tested_at timestamptz,
  uploaded_at timestamptz,
  promoted_at timestamptz,
  credential_revoked_at timestamptz,
  terminal_at timestamptz,
  CONSTRAINT builder_handoff_session_token_identity_check CHECK (
    id = token_id
  ),
  CONSTRAINT builder_handoff_session_distinct_identity_check CHECK (
    id <> candidate_set_id
    AND (target_app_id IS NULL OR id <> target_app_id)
    AND (target_app_id IS NULL OR candidate_set_id <> target_app_id)
  ),
  CONSTRAINT builder_handoff_session_intent_check CHECK (
    intent IN ('agent', 'interface', 'function', 'routine', 'connect')
  ),
  CONSTRAINT builder_handoff_session_intent_target_check CHECK (
    (intent = 'connect' AND target_app_id IS NULL)
    OR (
      intent IN ('agent', 'interface', 'function', 'routine')
      AND target_app_id IS NOT NULL
    )
  ),
  CONSTRAINT builder_handoff_session_base_lineage_check CHECK (
    (
      intent IN ('interface', 'function', 'routine')
      AND base_version IS NOT NULL
      AND base_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
      AND (
        base_source_hash IS NULL
        OR base_source_hash ~ '^[0-9a-f]{64}$'
      )
      AND (
        base_release_digest IS NULL
        OR base_release_digest ~ '^[0-9a-f]{64}$'
      )
      AND base_state_digest IS NOT NULL
      AND base_state_digest ~ '^[0-9a-f]{64}$'
    )
    OR (
      intent IN ('agent', 'connect')
      AND base_version IS NULL
      AND base_source_hash IS NULL
      AND base_release_digest IS NULL
      AND base_state_digest IS NULL
    )
  ),
  CONSTRAINT builder_handoff_session_status_check CHECK (
    status IN (
      'created',
      'connected',
      'staged',
      'tested',
      'uploaded',
      'promoted',
      'cancelled',
      'rejected',
      'revoked',
      'expired'
    )
  ),
  CONSTRAINT builder_handoff_session_exact_ttl_check CHECK (
    expires_at = created_at + interval '3600 seconds'
  ),
  CONSTRAINT builder_handoff_session_time_order_check CHECK (
    updated_at >= created_at
    AND expires_at > created_at
    AND (connected_at IS NULL OR connected_at >= created_at)
    AND (staged_at IS NULL OR staged_at >= created_at)
    AND (tested_at IS NULL OR tested_at >= created_at)
    AND (uploaded_at IS NULL OR uploaded_at >= created_at)
    AND (promoted_at IS NULL OR promoted_at >= created_at)
    AND (credential_revoked_at IS NULL OR credential_revoked_at >= created_at)
    AND (terminal_at IS NULL OR terminal_at >= created_at)
  ),
  CONSTRAINT builder_handoff_session_version_check CHECK (
    status_version >= 0 AND lineage_revision >= 0
  ),
  CONSTRAINT builder_handoff_session_description_digest_check CHECK (
    description_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT builder_handoff_session_bundle_check CHECK (
    bundle_id IS NULL OR bundle_id ~ '^gxb1_[0-9a-f]{64}$'
  ),
  CONSTRAINT builder_handoff_session_source_hash_check CHECK (
    source_hash IS NULL OR source_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT builder_handoff_session_attestation_id_check CHECK (
    attestation_id IS NULL OR (
      length(attestation_id) BETWEEN 1 AND 128
      AND attestation_id = btrim(attestation_id)
      AND attestation_id !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT builder_handoff_session_attestation_digest_check CHECK (
    attestation_digest IS NULL OR attestation_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT builder_handoff_session_document_digest_check CHECK (
    document_digest IS NULL OR document_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT builder_handoff_session_report_digest_check CHECK (
    report_digest IS NULL OR report_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT builder_handoff_session_release_digest_check CHECK (
    release_digest IS NULL OR release_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT builder_handoff_session_archive_shape_check CHECK (
    (
      candidate_archive_digest IS NULL
      AND candidate_archive_bytes IS NULL
      AND candidate_archive_objects IS NULL
    )
    OR (
      candidate_archive_digest IS NOT NULL
      AND candidate_archive_digest ~ '^[0-9a-f]{64}$'
      AND candidate_archive_bytes IS NOT NULL
      AND candidate_archive_bytes BETWEEN 1 AND 104857600
      AND candidate_archive_objects IS NOT NULL
      AND candidate_archive_objects BETWEEN 1 AND 256
    )
  ),
  CONSTRAINT builder_handoff_session_uploaded_version_check CHECK (
    uploaded_version IS NULL OR (
      uploaded_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    )
  ),
  CONSTRAINT builder_handoff_session_target_check CHECK (
    uploaded_app_id IS NULL OR uploaded_app_id = target_app_id
  ),
  CONSTRAINT builder_handoff_session_terminal_shape_check CHECK (
    (
      status IN ('cancelled', 'rejected', 'revoked', 'expired')
      AND terminal_at IS NOT NULL
      AND credential_revoked_at IS NOT NULL
    )
    OR (
      status NOT IN ('cancelled', 'rejected', 'revoked', 'expired')
      AND terminal_at IS NULL
    )
  ),
  CONSTRAINT builder_handoff_session_lineage_shape_check CHECK (
    status IN ('cancelled', 'rejected', 'revoked', 'expired')
    OR (
      status IN ('created', 'connected')
      AND lineage_revision = 0
      AND bundle_id IS NULL
      AND source_hash IS NULL
      AND attestation_id IS NULL
      AND attestation_digest IS NULL
      AND document_digest IS NULL
      AND report_digest IS NULL
      AND release_digest IS NULL
      AND candidate_archive_digest IS NULL
      AND candidate_archive_bytes IS NULL
      AND candidate_archive_objects IS NULL
      AND uploaded_app_id IS NULL
      AND uploaded_version IS NULL
      AND staged_at IS NULL
      AND tested_at IS NULL
      AND uploaded_at IS NULL
      AND promoted_at IS NULL
      AND credential_revoked_at IS NULL
    )
    OR (
      status = 'staged'
      AND lineage_revision >= 1
      AND bundle_id IS NOT NULL
      AND source_hash IS NOT NULL
      AND attestation_id IS NULL
      AND attestation_digest IS NULL
      AND document_digest IS NULL
      AND report_digest IS NULL
      AND release_digest IS NULL
      AND candidate_archive_digest IS NULL
      AND candidate_archive_bytes IS NULL
      AND candidate_archive_objects IS NULL
      AND uploaded_app_id IS NULL
      AND uploaded_version IS NULL
      AND staged_at IS NOT NULL
      AND tested_at IS NULL
      AND uploaded_at IS NULL
      AND promoted_at IS NULL
      AND credential_revoked_at IS NULL
    )
    OR (
      status = 'tested'
      AND lineage_revision >= 1
      AND bundle_id IS NOT NULL
      AND source_hash IS NOT NULL
      AND attestation_id IS NOT NULL
      AND attestation_digest IS NOT NULL
      AND document_digest IS NOT NULL
      AND report_digest IS NOT NULL
      AND release_digest IS NOT NULL
      AND candidate_archive_digest IS NULL
      AND candidate_archive_bytes IS NULL
      AND candidate_archive_objects IS NULL
      AND uploaded_app_id IS NULL
      AND uploaded_version IS NULL
      AND staged_at IS NOT NULL
      AND tested_at IS NOT NULL
      AND uploaded_at IS NULL
      AND promoted_at IS NULL
      AND credential_revoked_at IS NULL
    )
    OR (
      status IN ('uploaded', 'promoted')
      AND lineage_revision >= 1
      AND bundle_id IS NOT NULL
      AND source_hash IS NOT NULL
      AND attestation_id IS NOT NULL
      AND attestation_digest IS NOT NULL
      AND document_digest IS NOT NULL
      AND report_digest IS NOT NULL
      AND release_digest IS NOT NULL
      AND candidate_archive_digest IS NOT NULL
      AND candidate_archive_bytes IS NOT NULL
      AND candidate_archive_objects IS NOT NULL
      AND uploaded_app_id = target_app_id
      AND uploaded_version IS NOT NULL
      AND staged_at IS NOT NULL
      AND tested_at IS NOT NULL
      AND uploaded_at IS NOT NULL
      AND credential_revoked_at IS NOT NULL
      AND (
        (status = 'uploaded' AND promoted_at IS NULL)
        OR (status = 'promoted' AND promoted_at IS NOT NULL)
      )
    )
  )
);

CREATE INDEX builder_handoff_sessions_owner_created_idx
  ON public.builder_handoff_sessions (owner_id, created_at DESC);
CREATE UNIQUE INDEX builder_handoff_sessions_reserved_agent_idx
  ON public.builder_handoff_sessions (target_app_id)
  WHERE intent = 'agent';
CREATE INDEX builder_handoff_sessions_active_expiry_idx
  ON public.builder_handoff_sessions (expires_at)
  WHERE status IN ('created', 'connected', 'staged', 'tested');
CREATE INDEX builder_handoff_sessions_pending_archive_owner_idx
  ON public.builder_handoff_sessions (owner_id, uploaded_at DESC)
  WHERE status = 'uploaded';

CREATE TABLE public.builder_handoff_session_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL
    REFERENCES public.builder_handoff_sessions(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event text NOT NULL,
  status text NOT NULL,
  status_version bigint NOT NULL,
  lineage_revision integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (session_id, status_version),
  CONSTRAINT builder_handoff_session_event_check CHECK (
    event IN (
      'created',
      'connected',
      'staged',
      'restaged',
      'tested',
      'retested',
      'uploaded',
      'promoted',
      'cancelled',
      'rejected',
      'revoked',
      'expired'
    )
  ),
  CONSTRAINT builder_handoff_session_event_status_check CHECK (
    status IN (
      'created',
      'connected',
      'staged',
      'tested',
      'uploaded',
      'promoted',
      'cancelled',
      'rejected',
      'revoked',
      'expired'
    )
  ),
  CONSTRAINT builder_handoff_session_event_version_check CHECK (
    status_version >= 0 AND lineage_revision >= 0
  )
);

CREATE INDEX builder_handoff_session_events_owner_time_idx
  ON public.builder_handoff_session_events (owner_id, occurred_at DESC);

ALTER TABLE public.builder_handoff_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_handoff_session_events ENABLE ROW LEVEL SECURITY;

-- Scope strings are descriptive, not authoritative. This helper is used only
-- after the caller has resolved the service-role-only session mapping.
CREATE OR REPLACE FUNCTION public.builder_handoff_scope_set_is_exact(
  p_scopes text[],
  p_intent text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT
    p_scopes IS NOT NULL
    AND p_intent IN ('agent', 'interface', 'function', 'routine', 'connect')
    AND cardinality(p_scopes) = 3
    AND p_scopes @> ARRAY[
      'apps:read',
      'agents:build',
      'handoff:' || p_intent
    ]::text[]
    AND p_scopes <@ ARRAY[
      'apps:read',
      'agents:build',
      'handoff:' || p_intent
    ]::text[];
$$;

CREATE OR REPLACE FUNCTION public.create_builder_handoff_session(
  p_owner_id uuid,
  p_session_id uuid,
  p_candidate_set_id uuid,
  p_intent text,
  p_target_app_id uuid,
  p_base_version text,
  p_base_source_hash text,
  p_base_release_digest text,
  p_base_state_digest text,
  p_token_prefix text,
  p_token_hash text,
  p_token_salt text,
  p_description_sha256 text,
  p_now timestamptz
) RETURNS SETOF public.builder_handoff_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expires_at timestamptz;
  v_session public.builder_handoff_sessions%ROWTYPE;
  v_token public.user_api_tokens%ROWTYPE;
  v_token_found boolean;
  v_pending_count integer;
BEGIN
  IF p_owner_id IS NULL
     OR p_session_id IS NULL
     OR p_candidate_set_id IS NULL
     OR p_intent IS NULL
     OR p_intent NOT IN ('agent', 'interface', 'function', 'routine', 'connect')
     OR p_now IS NULL
     OR p_session_id = p_candidate_set_id
     OR (p_target_app_id IS NOT NULL AND p_session_id = p_target_app_id)
     OR (
       p_target_app_id IS NOT NULL
       AND p_candidate_set_id = p_target_app_id
     )
     OR (p_intent = 'connect' AND p_target_app_id IS NOT NULL)
     OR (
       p_intent IN ('agent', 'interface', 'function', 'routine')
       AND p_target_app_id IS NULL
     )
     OR (
       p_intent IN ('interface', 'function', 'routine')
       AND (
         p_base_version IS NULL
         OR p_base_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
         OR (
           p_base_source_hash IS NOT NULL
           AND p_base_source_hash !~ '^[0-9a-f]{64}$'
         )
         OR (
           p_base_release_digest IS NOT NULL
           AND p_base_release_digest !~ '^[0-9a-f]{64}$'
         )
         OR p_base_state_digest IS NULL
         OR p_base_state_digest !~ '^[0-9a-f]{64}$'
       )
     )
     OR (
       p_intent IN ('agent', 'connect')
       AND (
         p_base_version IS NOT NULL
         OR p_base_source_hash IS NOT NULL
         OR p_base_release_digest IS NOT NULL
         OR p_base_state_digest IS NOT NULL
       )
     )
     OR p_token_prefix IS NULL
     OR p_token_prefix !~ '^gx_[0-9a-f]{5}$'
     OR p_token_hash IS NULL
     OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_token_salt IS NULL
     OR p_token_salt !~ '^[0-9a-f]{32}$'
     OR p_description_sha256 IS NULL
     OR p_description_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_CREATE_INVALID',
      'message', 'Builder handoff creation parameters are invalid.'
    )::text;
  END IF;
  v_expires_at := p_now + interval '3600 seconds';

  -- Serialize creation with other owner-scoped onboarding mutations.
  PERFORM 1
  FROM public.users AS owner
  WHERE owner.id = p_owner_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_OWNER_NOT_FOUND',
      'message', 'Builder handoff owner was not found.'
    )::text;
  END IF;

  SELECT session.*
  INTO v_session
  FROM public.builder_handoff_sessions AS session
  WHERE session.id = p_session_id
  FOR UPDATE;
  IF FOUND THEN
    SELECT token.*
    INTO v_token
    FROM public.user_api_tokens AS token
    WHERE token.id = p_session_id
    FOR UPDATE;
    v_token_found := FOUND;

    IF v_session.token_id IS DISTINCT FROM p_session_id
       OR v_session.owner_id IS DISTINCT FROM p_owner_id
       OR v_session.candidate_set_id IS DISTINCT FROM p_candidate_set_id
       OR v_session.intent IS DISTINCT FROM p_intent
       OR v_session.target_app_id IS DISTINCT FROM p_target_app_id
       OR v_session.base_version IS DISTINCT FROM p_base_version
       OR v_session.base_source_hash IS DISTINCT FROM p_base_source_hash
       OR v_session.base_release_digest IS DISTINCT FROM p_base_release_digest
       OR v_session.base_state_digest IS DISTINCT FROM p_base_state_digest
       OR v_session.description_sha256 IS DISTINCT FROM p_description_sha256
       OR v_session.created_at IS DISTINCT FROM p_now
       OR v_session.expires_at IS DISTINCT FROM v_expires_at
       OR v_session.status IS DISTINCT FROM 'created'
       OR NOT v_token_found
       OR v_token.user_id IS DISTINCT FROM p_owner_id
       OR v_token.token_prefix IS DISTINCT FROM p_token_prefix
       OR v_token.token_hash IS DISTINCT FROM p_token_hash
       OR v_token.token_salt IS DISTINCT FROM p_token_salt
       OR v_token.plaintext_token IS NOT NULL
       OR NOT public.builder_handoff_scope_set_is_exact(
         v_token.scopes,
         p_intent
       )
       OR v_token.app_ids IS DISTINCT FROM (CASE
         WHEN p_intent = 'connect' THEN NULL
         ELSE to_jsonb(ARRAY[p_target_app_id]::uuid[])
       END)
       OR v_token.function_names IS NOT NULL
       OR v_token.created_at IS DISTINCT FROM p_now
       OR v_token.expires_at IS DISTINCT FROM v_expires_at THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_CREATE_CONFLICT',
        'message', 'Builder handoff creation token was reused.'
      )::text;
    END IF;

    RETURN NEXT v_session;
    RETURN;
  END IF;

  SELECT count(*)::integer
  INTO v_pending_count
  FROM public.builder_handoff_sessions AS session
  WHERE session.owner_id = p_owner_id
    AND (
      session.status = 'uploaded'
      OR (
        session.status IN ('created', 'connected', 'staged', 'tested')
        AND session.expires_at > p_now
      )
    );
  IF v_pending_count >= 10 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_SESSION_LIMIT',
      'message', 'At most 10 active or pending Builder handoffs are allowed.'
    )::text;
  END IF;

  IF p_intent = 'agent' AND EXISTS (
    SELECT 1
    FROM public.apps AS app
    WHERE app.id = p_target_app_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_TARGET_CONFLICT',
      'message', 'The reserved Agent identity is already in use.'
    )::text;
  END IF;
  IF p_intent IN ('interface', 'function', 'routine') AND NOT EXISTS (
    SELECT 1
    FROM public.apps AS app
    WHERE app.id = p_target_app_id
      AND app.owner_id = p_owner_id
      AND app.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_TARGET_NOT_FOUND',
      'message', 'The target Agent was not found for this owner.'
    )::text;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.user_api_tokens AS token
    WHERE token.id = p_session_id
       OR token.token_prefix = p_token_prefix
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_TOKEN_CONFLICT',
      'message', 'The Builder handoff credential identity is already in use.'
    )::text;
  END IF;

  INSERT INTO public.user_api_tokens (
    id,
    user_id,
    name,
    token_prefix,
    token_hash,
    token_salt,
    plaintext_token,
    scopes,
    app_ids,
    function_names,
    expires_at,
    created_at
  ) VALUES (
    p_session_id,
    p_owner_id,
    'Builder handoff ' || p_session_id::text,
    p_token_prefix,
    p_token_hash,
    p_token_salt,
    NULL,
    ARRAY['apps:read', 'agents:build', 'handoff:' || p_intent]::text[],
    CASE
      WHEN p_intent = 'connect' THEN NULL
      ELSE to_jsonb(ARRAY[p_target_app_id]::uuid[])
    END,
    NULL,
    v_expires_at,
    p_now
  );

  INSERT INTO public.builder_handoff_sessions (
    id,
    token_id,
    owner_id,
    candidate_set_id,
    intent,
    target_app_id,
    base_version,
    base_source_hash,
    base_release_digest,
    base_state_digest,
    status,
    status_version,
    lineage_revision,
    description_sha256,
    created_at,
    expires_at,
    updated_at
  ) VALUES (
    p_session_id,
    p_session_id,
    p_owner_id,
    p_candidate_set_id,
    p_intent,
    p_target_app_id,
    p_base_version,
    p_base_source_hash,
    p_base_release_digest,
    p_base_state_digest,
    'created',
    0,
    0,
    p_description_sha256,
    p_now,
    v_expires_at,
    p_now
  )
  RETURNING * INTO v_session;

  INSERT INTO public.builder_handoff_session_events (
    session_id,
    owner_id,
    event,
    status,
    status_version,
    lineage_revision,
    occurred_at
  ) VALUES (
    v_session.id,
    v_session.owner_id,
    'created',
    v_session.status,
    v_session.status_version,
    v_session.lineage_revision,
    p_now
  );

  RETURN NEXT v_session;
END;
$$;

CREATE OR REPLACE FUNCTION public.authenticate_builder_handoff_session(
  p_owner_id uuid,
  p_token_id uuid,
  p_scopes text[],
  p_now timestamptz
) RETURNS SETOF public.builder_handoff_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.builder_handoff_sessions%ROWTYPE;
  v_token public.user_api_tokens%ROWTYPE;
  v_token_found boolean;
BEGIN
  IF p_owner_id IS NULL OR p_token_id IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_AUTH_INVALID',
      'message', 'Builder handoff authentication parameters are invalid.'
    )::text;
  END IF;
  SELECT session.*
  INTO v_session
  FROM public.builder_handoff_sessions AS session
  WHERE session.id = p_token_id
    AND session.token_id = p_token_id
    AND session.owner_id = p_owner_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF NOT public.builder_handoff_scope_set_is_exact(
    p_scopes,
    v_session.intent
  ) THEN
    RETURN;
  END IF;

  IF v_session.status NOT IN ('created', 'connected', 'staged', 'tested') THEN
    RETURN NEXT v_session;
    RETURN;
  END IF;
  IF p_now < v_session.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_CLOCK_INVALID',
      'message', 'Builder handoff authentication clock is invalid.'
    )::text;
  END IF;

  IF v_session.expires_at <= p_now THEN
    UPDATE public.builder_handoff_sessions AS session
    SET status = 'expired',
        status_version = session.status_version + 1,
        updated_at = p_now,
        credential_revoked_at = p_now,
        terminal_at = p_now
    WHERE session.id = v_session.id
    RETURNING * INTO v_session;

    DELETE FROM public.user_api_tokens AS token
    WHERE token.id = v_session.token_id;

    INSERT INTO public.builder_handoff_session_events (
      session_id, owner_id, event, status, status_version,
      lineage_revision, occurred_at
    ) VALUES (
      v_session.id, v_session.owner_id, 'expired', v_session.status,
      v_session.status_version, v_session.lineage_revision, p_now
    );
    RETURN NEXT v_session;
    RETURN;
  END IF;

  SELECT token.*
  INTO v_token
  FROM public.user_api_tokens AS token
  WHERE token.id = v_session.token_id
  FOR UPDATE;
  v_token_found := FOUND;
  IF NOT v_token_found
     OR v_token.user_id IS DISTINCT FROM v_session.owner_id
     OR v_token.plaintext_token IS NOT NULL
     OR v_token.token_salt !~ '^[0-9a-f]{32}$'
     OR v_token.token_hash !~ '^[0-9a-f]{64}$'
     OR NOT public.builder_handoff_scope_set_is_exact(
       v_token.scopes,
       v_session.intent
     )
     OR v_token.app_ids IS DISTINCT FROM (CASE
       WHEN v_session.intent = 'connect' THEN NULL
       ELSE to_jsonb(ARRAY[v_session.target_app_id]::uuid[])
     END)
     OR v_token.function_names IS NOT NULL
     OR v_token.expires_at IS DISTINCT FROM v_session.expires_at THEN
    UPDATE public.builder_handoff_sessions AS session
    SET status = 'revoked',
        status_version = session.status_version + 1,
        updated_at = p_now,
        credential_revoked_at = p_now,
        terminal_at = p_now
    WHERE session.id = v_session.id
    RETURNING * INTO v_session;

    DELETE FROM public.user_api_tokens AS token
    WHERE token.id = v_session.token_id;

    INSERT INTO public.builder_handoff_session_events (
      session_id, owner_id, event, status, status_version,
      lineage_revision, occurred_at
    ) VALUES (
      v_session.id, v_session.owner_id, 'revoked', v_session.status,
      v_session.status_version, v_session.lineage_revision, p_now
    );
    RETURN NEXT v_session;
    RETURN;
  END IF;

  IF v_session.status = 'created' THEN
    UPDATE public.builder_handoff_sessions AS session
    SET status = 'connected',
        status_version = session.status_version + 1,
        updated_at = p_now,
        connected_at = p_now
    WHERE session.id = v_session.id
    RETURNING * INTO v_session;

    INSERT INTO public.builder_handoff_session_events (
      session_id, owner_id, event, status, status_version,
      lineage_revision, occurred_at
    ) VALUES (
      v_session.id, v_session.owner_id, 'connected', v_session.status,
      v_session.status_version, v_session.lineage_revision, p_now
    );
  END IF;

  UPDATE public.user_api_tokens AS token
  SET last_used_at = p_now
  WHERE token.id = v_session.token_id;

  RETURN NEXT v_session;
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_builder_handoff_session(
  p_owner_id uuid,
  p_token_id uuid,
  p_event text,
  p_bundle_id text,
  p_source_hash text,
  p_attestation_id text,
  p_attestation_digest text,
  p_document_digest text,
  p_report_digest text,
  p_release_digest text,
  p_archive_digest text,
  p_archive_bytes bigint,
  p_archive_objects integer,
  p_app_id uuid,
  p_version text,
  p_now timestamptz
) RETURNS SETOF public.builder_handoff_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.builder_handoff_sessions%ROWTYPE;
  v_token public.user_api_tokens%ROWTYPE;
  v_token_found boolean;
  v_event text;
  v_pending_archive_bytes bigint;
  v_pending_archive_count integer;
BEGIN
  IF p_owner_id IS NULL
     OR p_token_id IS NULL
     OR p_event IS NULL
     OR p_event NOT IN ('stage', 'test', 'upload', 'promote')
     OR p_now IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_ADVANCE_INVALID',
      'message', 'Builder handoff transition parameters are invalid.'
    )::text;
  END IF;

  -- Use one owner-scoped lock order for creation and candidate submission so
  -- per-owner session and archive quotas cannot be raced.
  PERFORM 1
  FROM public.users AS owner
  WHERE owner.id = p_owner_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT session.*
  INTO v_session
  FROM public.builder_handoff_sessions AS session
  WHERE session.id = p_token_id
    AND session.token_id = p_token_id
    AND session.owner_id = p_owner_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF p_now < v_session.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_CLOCK_INVALID',
      'message', 'Builder handoff transition clock is invalid.'
    )::text;
  END IF;

  -- Promotion is deliberately outside bearer-token authority. Upload has
  -- already consumed the credential, while an owner session may later promote
  -- the exact uploaded release.
  IF p_event = 'promote' THEN
    IF p_bundle_id IS NOT NULL
       OR p_source_hash IS NOT NULL
       OR p_attestation_id IS NOT NULL
       OR p_attestation_digest IS NOT NULL
       OR p_document_digest IS NOT NULL
       OR p_report_digest IS NOT NULL
       OR p_archive_digest IS NOT NULL
       OR p_archive_bytes IS NOT NULL
       OR p_archive_objects IS NOT NULL
       OR p_app_id IS NULL
       OR p_release_digest IS NULL
       OR p_version IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_PROMOTE_INVALID',
        'message', 'Builder handoff promotion parameters are invalid.'
      )::text;
    END IF;
    IF v_session.status NOT IN ('uploaded', 'promoted')
       OR p_app_id IS DISTINCT FROM v_session.uploaded_app_id
       OR p_release_digest IS DISTINCT FROM v_session.release_digest
       OR p_version IS DISTINCT FROM v_session.uploaded_version THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_TRANSITION_CONFLICT',
        'message', 'Builder handoff promotion does not match its uploaded release.'
      )::text;
    END IF;
    IF v_session.status = 'promoted' THEN
      RETURN NEXT v_session;
      RETURN;
    END IF;

    UPDATE public.builder_handoff_sessions AS session
    SET status = 'promoted',
        status_version = session.status_version + 1,
        updated_at = p_now,
        promoted_at = p_now
    WHERE session.id = v_session.id
    RETURNING * INTO v_session;

    DELETE FROM public.user_api_tokens AS token
    WHERE token.id = v_session.token_id;

    INSERT INTO public.builder_handoff_session_events (
      session_id, owner_id, event, status, status_version,
      lineage_revision, occurred_at
    ) VALUES (
      v_session.id, v_session.owner_id, 'promoted', v_session.status,
      v_session.status_version, v_session.lineage_revision, p_now
    );
    RETURN NEXT v_session;
    RETURN;
  END IF;

  IF v_session.intent = 'connect' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_TRANSITION_CONFLICT',
      'message', 'A Connect handoff has no candidate release lineage.'
    )::text;
  END IF;

  IF v_session.status NOT IN ('created', 'connected', 'staged', 'tested', 'uploaded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_TERMINAL',
      'message', 'Builder handoff is terminal.'
    )::text;
  END IF;

  IF v_session.status IN ('created', 'connected', 'staged', 'tested')
     AND v_session.expires_at <= p_now THEN
    UPDATE public.builder_handoff_sessions AS session
    SET status = 'expired',
        status_version = session.status_version + 1,
        updated_at = p_now,
        credential_revoked_at = p_now,
        terminal_at = p_now
    WHERE session.id = v_session.id
    RETURNING * INTO v_session;

    DELETE FROM public.user_api_tokens AS token
    WHERE token.id = v_session.token_id;

    INSERT INTO public.builder_handoff_session_events (
      session_id, owner_id, event, status, status_version,
      lineage_revision, occurred_at
    ) VALUES (
      v_session.id, v_session.owner_id, 'expired', v_session.status,
      v_session.status_version, v_session.lineage_revision, p_now
    );
    RETURN NEXT v_session;
    RETURN;
  END IF;

  IF v_session.status IN ('created', 'connected', 'staged', 'tested') THEN
    SELECT token.*
    INTO v_token
    FROM public.user_api_tokens AS token
    WHERE token.id = v_session.token_id
    FOR UPDATE;
    v_token_found := FOUND;
    IF NOT v_token_found
       OR v_token.user_id IS DISTINCT FROM v_session.owner_id
       OR v_token.plaintext_token IS NOT NULL
       OR NOT public.builder_handoff_scope_set_is_exact(
         v_token.scopes,
         v_session.intent
       )
       OR v_token.app_ids IS DISTINCT FROM (CASE
         WHEN v_session.intent = 'connect' THEN NULL
         ELSE to_jsonb(ARRAY[v_session.target_app_id]::uuid[])
       END)
       OR v_token.expires_at IS DISTINCT FROM v_session.expires_at THEN
      UPDATE public.builder_handoff_sessions AS session
      SET status = 'revoked',
          status_version = session.status_version + 1,
          updated_at = p_now,
          credential_revoked_at = p_now,
          terminal_at = p_now
      WHERE session.id = v_session.id
      RETURNING * INTO v_session;

      DELETE FROM public.user_api_tokens AS token
      WHERE token.id = v_session.token_id;

      INSERT INTO public.builder_handoff_session_events (
        session_id, owner_id, event, status, status_version,
        lineage_revision, occurred_at
      ) VALUES (
        v_session.id, v_session.owner_id, 'revoked', v_session.status,
        v_session.status_version, v_session.lineage_revision, p_now
      );
      RETURN NEXT v_session;
      RETURN;
    END IF;
  END IF;

  IF p_event = 'stage' THEN
    IF p_bundle_id IS NULL
       OR p_bundle_id !~ '^gxb1_[0-9a-f]{64}$'
       OR p_source_hash IS NULL
       OR p_source_hash !~ '^[0-9a-f]{64}$'
       OR p_attestation_id IS NOT NULL
       OR p_attestation_digest IS NOT NULL
       OR p_document_digest IS NOT NULL
       OR p_report_digest IS NOT NULL
       OR p_release_digest IS NOT NULL
       OR p_archive_digest IS NOT NULL
       OR p_archive_bytes IS NOT NULL
       OR p_archive_objects IS NOT NULL
       OR p_app_id IS NOT NULL
       OR p_version IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_STAGE_INVALID',
        'message', 'Builder handoff stage parameters are invalid.'
      )::text;
    END IF;
    IF v_session.status NOT IN ('connected', 'staged') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_TRANSITION_CONFLICT',
        'message', 'Builder handoff cannot stage from its current status.'
      )::text;
    END IF;
    IF v_session.status = 'staged'
       AND v_session.bundle_id = p_bundle_id
       AND v_session.source_hash = p_source_hash THEN
      RETURN NEXT v_session;
      RETURN;
    END IF;

    v_event := CASE WHEN v_session.status = 'staged'
      THEN 'restaged' ELSE 'staged' END;
    UPDATE public.builder_handoff_sessions AS session
    SET status = 'staged',
        status_version = session.status_version + 1,
        lineage_revision = session.lineage_revision + 1,
        bundle_id = p_bundle_id,
        source_hash = p_source_hash,
        attestation_id = NULL,
        attestation_digest = NULL,
        document_digest = NULL,
        report_digest = NULL,
        release_digest = NULL,
        candidate_archive_digest = NULL,
        candidate_archive_bytes = NULL,
        candidate_archive_objects = NULL,
        uploaded_app_id = NULL,
        uploaded_version = NULL,
        updated_at = p_now,
        staged_at = p_now,
        tested_at = NULL,
        uploaded_at = NULL,
        promoted_at = NULL
    WHERE session.id = v_session.id
    RETURNING * INTO v_session;

  ELSIF p_event = 'test' THEN
    IF p_bundle_id IS NULL
       OR p_bundle_id !~ '^gxb1_[0-9a-f]{64}$'
       OR p_source_hash IS NULL
       OR p_source_hash !~ '^[0-9a-f]{64}$'
       OR p_attestation_id IS NULL
       OR length(p_attestation_id) NOT BETWEEN 1 AND 128
       OR p_attestation_id <> btrim(p_attestation_id)
       OR p_attestation_id ~ '[[:cntrl:]]'
       OR p_attestation_digest IS NULL
       OR p_attestation_digest !~ '^[0-9a-f]{64}$'
       OR p_document_digest IS NULL
       OR p_document_digest !~ '^[0-9a-f]{64}$'
       OR p_report_digest IS NULL
       OR p_report_digest !~ '^[0-9a-f]{64}$'
       OR p_release_digest IS NULL
       OR p_release_digest !~ '^[0-9a-f]{64}$'
       OR p_archive_digest IS NOT NULL
       OR p_archive_bytes IS NOT NULL
       OR p_archive_objects IS NOT NULL
       OR p_app_id IS NOT NULL
       OR p_version IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_TEST_INVALID',
        'message', 'Builder handoff test parameters are invalid.'
      )::text;
    END IF;
    IF v_session.status NOT IN ('staged', 'tested')
       OR v_session.bundle_id IS DISTINCT FROM p_bundle_id
       OR v_session.source_hash IS DISTINCT FROM p_source_hash THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_LINEAGE_CONFLICT',
        'message', 'Builder handoff test does not match its staged bundle.'
      )::text;
    END IF;
    IF v_session.status = 'tested' THEN
      IF v_session.attestation_id = p_attestation_id
         AND v_session.attestation_digest = p_attestation_digest
         AND v_session.document_digest = p_document_digest
         AND v_session.report_digest = p_report_digest
         AND v_session.release_digest = p_release_digest THEN
        RETURN NEXT v_session;
        RETURN;
      END IF;
      IF v_session.document_digest IS DISTINCT FROM p_document_digest
         OR v_session.report_digest IS DISTINCT FROM p_report_digest
         OR v_session.release_digest IS DISTINCT FROM p_release_digest THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
          'code', 'BUILDER_HANDOFF_LINEAGE_CONFLICT',
          'message', 'Builder handoff retest changed the qualified release.'
        )::text;
      END IF;
      v_event := 'retested';
    ELSE
      v_event := 'tested';
    END IF;

    UPDATE public.builder_handoff_sessions AS session
    SET status = 'tested',
        status_version = session.status_version + 1,
        attestation_id = p_attestation_id,
        attestation_digest = p_attestation_digest,
        document_digest = p_document_digest,
        report_digest = p_report_digest,
        release_digest = p_release_digest,
        updated_at = p_now,
        tested_at = p_now
    WHERE session.id = v_session.id
    RETURNING * INTO v_session;

  ELSE
    IF p_bundle_id IS NULL
       OR p_bundle_id !~ '^gxb1_[0-9a-f]{64}$'
       OR p_source_hash IS NULL
       OR p_source_hash !~ '^[0-9a-f]{64}$'
       OR p_attestation_id IS NULL
       OR p_attestation_digest IS NULL
       OR p_attestation_digest !~ '^[0-9a-f]{64}$'
       OR p_document_digest IS NULL
       OR p_document_digest !~ '^[0-9a-f]{64}$'
       OR p_report_digest IS NULL
       OR p_report_digest !~ '^[0-9a-f]{64}$'
       OR p_release_digest IS NULL
       OR p_release_digest !~ '^[0-9a-f]{64}$'
       OR p_archive_digest IS NULL
       OR p_archive_digest !~ '^[0-9a-f]{64}$'
       OR p_archive_bytes IS NULL
       OR p_archive_bytes NOT BETWEEN 1 AND 104857600
       OR p_archive_objects IS NULL
       OR p_archive_objects NOT BETWEEN 1 AND 256
       OR p_app_id IS NULL
       OR p_version IS NULL
       OR p_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_UPLOAD_INVALID',
        'message', 'Builder handoff upload parameters are invalid.'
      )::text;
    END IF;
    IF v_session.status NOT IN ('tested', 'uploaded')
       OR v_session.bundle_id IS DISTINCT FROM p_bundle_id
       OR v_session.source_hash IS DISTINCT FROM p_source_hash
       OR v_session.attestation_id IS DISTINCT FROM p_attestation_id
       OR v_session.attestation_digest IS DISTINCT FROM p_attestation_digest
       OR v_session.document_digest IS DISTINCT FROM p_document_digest
       OR v_session.report_digest IS DISTINCT FROM p_report_digest
       OR v_session.release_digest IS DISTINCT FROM p_release_digest
       OR v_session.target_app_id IS DISTINCT FROM p_app_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_LINEAGE_CONFLICT',
        'message', 'Builder handoff upload does not match its tested release.'
      )::text;
    END IF;
    IF v_session.intent = 'agent' AND EXISTS (
      SELECT 1
      FROM public.apps AS app
      WHERE app.id = v_session.target_app_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_TARGET_CONFLICT',
        'message', 'The reserved candidate Agent identity is already in use.'
      )::text;
    END IF;
    IF v_session.intent IN ('interface', 'function', 'routine')
       AND NOT EXISTS (
      SELECT 1
      FROM public.apps AS app
      WHERE app.id = v_session.target_app_id
        AND app.owner_id = v_session.owner_id
        AND app.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_TARGET_NOT_FOUND',
        'message', 'The target Agent was not found for this owner.'
      )::text;
    END IF;
    IF v_session.status = 'uploaded' THEN
      IF v_session.uploaded_app_id = p_app_id
         AND v_session.uploaded_version = p_version
         AND v_session.candidate_archive_digest = p_archive_digest
         AND v_session.candidate_archive_bytes = p_archive_bytes
         AND v_session.candidate_archive_objects = p_archive_objects THEN
        DELETE FROM public.user_api_tokens AS token
        WHERE token.id = v_session.token_id;
        RETURN NEXT v_session;
        RETURN;
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_LINEAGE_CONFLICT',
        'message', 'Builder handoff uploaded release is immutable.'
      )::text;
    END IF;

    SELECT
      COALESCE(sum(session.candidate_archive_bytes), 0)::bigint,
      count(*)::integer
    INTO v_pending_archive_bytes, v_pending_archive_count
    FROM public.builder_handoff_sessions AS session
    WHERE session.owner_id = v_session.owner_id
      AND session.status = 'uploaded'
      AND session.id <> v_session.id;
    IF v_pending_archive_count >= 10
       OR v_pending_archive_bytes + p_archive_bytes > 104857600 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_ARCHIVE_QUOTA_EXCEEDED',
        'message', 'Pending Builder handoff candidate archive quota exceeded.'
      )::text;
    END IF;

    v_event := 'uploaded';
    UPDATE public.builder_handoff_sessions AS session
    SET status = 'uploaded',
        status_version = session.status_version + 1,
        candidate_archive_digest = p_archive_digest,
        candidate_archive_bytes = p_archive_bytes,
        candidate_archive_objects = p_archive_objects,
        uploaded_app_id = p_app_id,
        uploaded_version = p_version,
        updated_at = p_now,
        uploaded_at = p_now,
        credential_revoked_at = p_now
    WHERE session.id = v_session.id
    RETURNING * INTO v_session;

    -- Successful submit is single-use. Promotion is a later owner-session
    -- action and never restores this credential.
    DELETE FROM public.user_api_tokens AS token
    WHERE token.id = v_session.token_id;
  END IF;

  INSERT INTO public.builder_handoff_session_events (
    session_id,
    owner_id,
    event,
    status,
    status_version,
    lineage_revision,
    occurred_at
  ) VALUES (
    v_session.id,
    v_session.owner_id,
    v_event,
    v_session.status,
    v_session.status_version,
    v_session.lineage_revision,
    p_now
  );

  RETURN NEXT v_session;
END;
$$;

CREATE OR REPLACE FUNCTION public.terminate_builder_handoff_session(
  p_owner_id uuid,
  p_token_id uuid,
  p_status text,
  p_now timestamptz
) RETURNS SETOF public.builder_handoff_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.builder_handoff_sessions%ROWTYPE;
  v_terminal_status text;
BEGIN
  IF p_owner_id IS NULL
     OR p_token_id IS NULL
     OR p_status IS NULL
     OR p_status NOT IN ('cancelled', 'rejected', 'revoked', 'expired')
     OR p_now IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_TERMINATE_INVALID',
      'message', 'Builder handoff termination parameters are invalid.'
    )::text;
  END IF;

  SELECT session.*
  INTO v_session
  FROM public.builder_handoff_sessions AS session
  WHERE session.id = p_token_id
    AND session.token_id = p_token_id
    AND session.owner_id = p_owner_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF p_now < v_session.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_CLOCK_INVALID',
      'message', 'Builder handoff termination clock is invalid.'
    )::text;
  END IF;

  IF v_session.status IN ('cancelled', 'rejected', 'revoked', 'expired') THEN
    IF v_session.status IS DISTINCT FROM p_status THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
        'code', 'BUILDER_HANDOFF_TERMINAL_CONFLICT',
        'message', 'Builder handoff already reached a different terminal status.'
      )::text;
    END IF;
    DELETE FROM public.user_api_tokens AS token
    WHERE token.id = v_session.token_id;
    RETURN NEXT v_session;
    RETURN;
  END IF;
  IF v_session.status IN ('uploaded', 'promoted') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_COMPLETED',
      'message', 'A submitted Builder handoff cannot be terminated.'
    )::text;
  END IF;

  v_terminal_status := CASE
    WHEN v_session.expires_at <= p_now THEN 'expired'
    ELSE p_status
  END;
  IF v_terminal_status = 'expired' AND v_session.expires_at > p_now THEN
    RAISE EXCEPTION USING ERRCODE = '22023', DETAIL = jsonb_build_object(
      'code', 'BUILDER_HANDOFF_EXPIRY_INVALID',
      'message', 'Builder handoff cannot expire before its exact expiry.'
    )::text;
  END IF;

  UPDATE public.builder_handoff_sessions AS session
  SET status = v_terminal_status,
      status_version = session.status_version + 1,
      updated_at = p_now,
      credential_revoked_at = p_now,
      terminal_at = p_now
  WHERE session.id = v_session.id
  RETURNING * INTO v_session;

  DELETE FROM public.user_api_tokens AS token
  WHERE token.id = v_session.token_id;

  INSERT INTO public.builder_handoff_session_events (
    session_id,
    owner_id,
    event,
    status,
    status_version,
    lineage_revision,
    occurred_at
  ) VALUES (
    v_session.id,
    v_session.owner_id,
    v_terminal_status,
    v_session.status,
    v_session.status_version,
    v_session.lineage_revision,
    p_now
  );

  RETURN NEXT v_session;
END;
$$;

-- Prevent authenticated clients from self-minting a token that merely looks
-- like a Builder handoff. Only the atomic service-role RPC above may create
-- handoff-marked user_api_tokens rows.
DROP POLICY IF EXISTS "Users can create own tokens"
  ON public.user_api_tokens;
CREATE POLICY "Users can create own tokens"
  ON public.user_api_tokens
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(COALESCE(scopes, ARRAY[]::text[])) AS scope(value)
      WHERE scope.value LIKE 'handoff:%'
    )
  );

REVOKE ALL ON TABLE public.builder_handoff_sessions
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.builder_handoff_session_events
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.builder_handoff_sessions TO service_role;
GRANT SELECT ON TABLE public.builder_handoff_session_events TO service_role;

REVOKE ALL ON FUNCTION public.builder_handoff_scope_set_is_exact(text[], text)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_builder_handoff_session(
  uuid, uuid, uuid, text, uuid, text, text, text, text, text, text, text, text,
  timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_builder_handoff_session(
  uuid, uuid, uuid, text, uuid, text, text, text, text, text, text, text, text,
  timestamptz
) TO service_role;

REVOKE ALL ON FUNCTION public.authenticate_builder_handoff_session(
  uuid, uuid, text[], timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.authenticate_builder_handoff_session(
  uuid, uuid, text[], timestamptz
) TO service_role;

REVOKE ALL ON FUNCTION public.advance_builder_handoff_session(
  uuid, uuid, text, text, text, text, text, text, text, text, text, bigint,
  integer, uuid, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.advance_builder_handoff_session(
  uuid, uuid, text, text, text, text, text, text, text, text, text, bigint,
  integer, uuid, text, timestamptz
) TO service_role;

REVOKE ALL ON FUNCTION public.terminate_builder_handoff_session(
  uuid, uuid, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.terminate_builder_handoff_session(
  uuid, uuid, text, timestamptz
) TO service_role;
