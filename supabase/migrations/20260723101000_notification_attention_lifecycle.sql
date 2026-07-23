-- Operator-grade Agent Home: explicit Attention lifecycle and a durable,
-- BYOK-ready projection outbox.
--
-- Raw notifications remain the immutable system/Agent-authored evidence.
-- Reports use read/archive semantics. Incidents use independent
-- open/snoozed/resolved semantics; reading an incident never resolves it.

ALTER TABLE public.user_notifications
  ADD COLUMN IF NOT EXISTS item_class text,
  ADD COLUMN IF NOT EXISTS requires_action boolean,
  ADD COLUMN IF NOT EXISTS lifecycle_state text,
  ADD COLUMN IF NOT EXISTS state_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_reason text,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Notification rows are retained as immutable evidence. Agent deletion is a
-- soft-delete product operation; a hard delete must not rewrite historical
-- attribution through the legacy ON DELETE SET NULL relationship.
ALTER TABLE public.user_notifications
  DROP CONSTRAINT IF EXISTS user_notifications_agent_id_fkey;
ALTER TABLE public.user_notifications
  ADD CONSTRAINT user_notifications_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES public.apps(id)
  ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.user_notifications
  VALIDATE CONSTRAINT user_notifications_agent_id_fkey;

UPDATE public.user_notifications
SET
  item_class = CASE
    WHEN kind IN ('agent_report', 'routine_report', 'routine_summary')
      THEN 'report'
    ELSE 'incident'
  END,
  requires_action = kind NOT IN (
    'agent_report',
    'routine_report',
    'routine_summary'
  ),
  lifecycle_state = 'open',
  state_changed_at = coalesce(state_changed_at, created_at, now())
WHERE item_class IS NULL
   OR requires_action IS NULL
   OR lifecycle_state IS NULL
   OR state_changed_at IS NULL;

CREATE OR REPLACE FUNCTION public.classify_user_notification_attention()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Classification is server-canonical. Callers cannot accidentally turn a
  -- budget wall or unknown operational condition into a dismissible report.
  NEW.item_class := CASE
    WHEN NEW.kind IN ('agent_report', 'routine_report', 'routine_summary')
      THEN 'report'
    ELSE 'incident'
  END;
  NEW.requires_action := NEW.item_class = 'incident';
  IF NEW.lifecycle_state IS NULL THEN
    NEW.lifecycle_state := 'open';
  END IF;
  IF NEW.state_changed_at IS NULL THEN
    NEW.state_changed_at := coalesce(NEW.created_at, now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER classify_user_notification_attention
BEFORE INSERT ON public.user_notifications
FOR EACH ROW EXECUTE FUNCTION public.classify_user_notification_attention();

-- A stable dedupe key identifies the currently active episode of a condition,
-- not all historical episodes forever. Terminal rows retain the original key
-- and immutable evidence; at most one open/snoozed episode may own that key.
ALTER TABLE public.user_notifications
  DROP CONSTRAINT IF EXISTS user_notifications_user_dedupe_key;

CREATE UNIQUE INDEX user_notifications_user_report_dedupe_key
  ON public.user_notifications (user_id, dedupe_key)
  WHERE item_class = 'report';

CREATE UNIQUE INDEX user_notifications_user_active_incident_dedupe_key
  ON public.user_notifications (user_id, dedupe_key)
  WHERE item_class = 'incident'
    AND lifecycle_state IN ('open', 'snoozed');

ALTER TABLE public.user_notifications
  ALTER COLUMN item_class SET NOT NULL,
  ALTER COLUMN requires_action SET NOT NULL,
  ALTER COLUMN lifecycle_state SET NOT NULL,
  ALTER COLUMN state_changed_at SET NOT NULL;

ALTER TABLE public.user_notifications
  ADD CONSTRAINT user_notifications_item_class_check CHECK (
    item_class IN ('report', 'incident')
  ),
  ADD CONSTRAINT user_notifications_lifecycle_state_check CHECK (
    lifecycle_state IN ('open', 'snoozed', 'resolved', 'archived')
  ),
  ADD CONSTRAINT user_notifications_lifecycle_shape_check CHECK (
    (
      item_class = 'report'
      AND requires_action = false
      AND lifecycle_state IN ('open', 'archived')
      AND snoozed_until IS NULL
      AND resolved_at IS NULL
      AND resolution_reason IS NULL
      AND (
        (lifecycle_state = 'open' AND archived_at IS NULL)
        OR (lifecycle_state = 'archived' AND archived_at IS NOT NULL)
      )
    )
    OR
    (
      item_class = 'incident'
      AND requires_action = true
      AND lifecycle_state IN ('open', 'snoozed', 'resolved')
      AND archived_at IS NULL
      AND (
        (
          lifecycle_state = 'open'
          AND snoozed_until IS NULL
          AND resolved_at IS NULL
          AND resolution_reason IS NULL
        )
        OR
        (
          lifecycle_state = 'snoozed'
          AND snoozed_until IS NOT NULL
          AND resolved_at IS NULL
          AND resolution_reason IS NULL
        )
        OR
        (
          lifecycle_state = 'resolved'
          AND snoozed_until IS NULL
          AND resolved_at IS NOT NULL
        )
      )
    )
  ),
  ADD CONSTRAINT user_notifications_resolution_reason_check CHECK (
    resolution_reason IS NULL
    OR (
      char_length(resolution_reason) BETWEEN 1 AND 500
      AND resolution_reason !~ '[[:cntrl:]]'
    )
  );

COMMENT ON COLUMN public.user_notifications.item_class IS
  'report = informational Agent-authored output; incident = a condition requiring an owner decision or recovery.';
COMMENT ON COLUMN public.user_notifications.lifecycle_state IS
  'Independent from read_at: reading an incident never resolves it.';

-- Atomically insert one notification episode. A duplicate active episode is a
-- delivery retry and returns no row. A recurrence after resolution/archive
-- creates a fresh immutable row. Snoozed incidents remain active so a retry
-- cannot bypass the owner's snooze. The advisory lock and partial unique
-- indexes make this behavior safe for concurrent writers.
CREATE OR REPLACE FUNCTION public.create_user_notification_episode(
  p_user_id uuid,
  p_agent_id uuid,
  p_kind text,
  p_severity text,
  p_title text,
  p_body text,
  p_entity_type text,
  p_entity_id text,
  p_action_url text,
  p_dedupe_key text
) RETURNS SETOF public.user_notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.user_notifications%ROWTYPE;
  v_inserted public.user_notifications%ROWTYPE;
  v_item_class text := CASE
    WHEN p_kind IN ('agent_report', 'routine_report', 'routine_summary')
      THEN 'report'
    ELSE 'incident'
  END;
BEGIN
  IF p_user_id IS NULL
     OR nullif(btrim(p_kind), '') IS NULL
     OR nullif(btrim(p_title), '') IS NULL
     OR nullif(btrim(p_dedupe_key), '') IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_notification_episode';
  END IF;

  -- Attribution is an owner boundary, not just a foreign-key relationship.
  -- Keep a key-share lock through episode creation so an Agent transfer cannot
  -- race this check and leave fresh evidence owned by the previous operator.
  IF p_agent_id IS NOT NULL THEN
    PERFORM 1
    FROM public.apps AS apps
    WHERE apps.id = p_agent_id
      AND apps.owner_id = p_user_id
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'notification_agent_owner_mismatch';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_user_id::text || E'\x1f' || btrim(p_dedupe_key),
      0
    )
  );

  SELECT * INTO v_existing
  FROM public.user_notifications
  WHERE user_id = p_user_id
    AND dedupe_key = btrim(p_dedupe_key)
    AND (
      (
        v_item_class = 'report'
        AND (
          item_class = 'report'
          OR lifecycle_state IN ('open', 'snoozed')
        )
      )
      OR (
        v_item_class = 'incident'
        AND lifecycle_state IN ('open', 'snoozed')
      )
    )
  ORDER BY
    (lifecycle_state IN ('open', 'snoozed')) DESC,
    created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    -- Open and snoozed incidents are both the same active delivery episode.
    -- Never bypass an owner's snooze merely because a worker re-detected the
    -- condition. A report also remains globally idempotent under its key.
    IF v_existing.item_class = v_item_class
       OR v_existing.item_class = 'incident' THEN
      RETURN;
    END IF;

    -- A newly actionable classification may supersede an active report while
    -- preserving that informational row as immutable archived history.
    IF v_item_class = 'incident'
       AND v_existing.item_class = 'report' THEN
      UPDATE public.user_notifications
      SET
        lifecycle_state = 'archived',
        archived_at = now(),
        read_at = coalesce(read_at, now()),
        state_changed_at = now()
      WHERE id = v_existing.id;
    ELSE
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.user_notifications (
    user_id,
    agent_id,
    kind,
    severity,
    title,
    body,
    entity_type,
    entity_id,
    action_url,
    dedupe_key
  ) VALUES (
    p_user_id,
    p_agent_id,
    btrim(p_kind),
    coalesce(nullif(btrim(p_severity), ''), 'info'),
    btrim(p_title),
    p_body,
    p_entity_type,
    p_entity_id,
    p_action_url,
    btrim(p_dedupe_key)
  )
  RETURNING * INTO v_inserted;

  RETURN NEXT v_inserted;
END;
$$;

CREATE INDEX idx_user_notifications_attention
  ON public.user_notifications
    (user_id, lifecycle_state, item_class, created_at DESC);

CREATE INDEX idx_user_notifications_agent_attention
  ON public.user_notifications
    (user_id, agent_id, lifecycle_state, item_class, created_at DESC)
  WHERE agent_id IS NOT NULL;

CREATE INDEX idx_user_notifications_snoozed_due
  ON public.user_notifications (snoozed_until, user_id, agent_id)
  WHERE lifecycle_state = 'snoozed';

-- Enrichment is a versioned projection. The original title/body/action_url
-- remain on user_notifications and are never overwritten by model output.
CREATE TABLE public.notification_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL
    REFERENCES public.user_notifications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES public.apps(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  source_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  provider text,
  model text,
  headline text,
  impact text,
  recommended_action text,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence double precision,
  action_key text,
  action_parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  generated_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_briefs_notification_revision_key
    UNIQUE (notification_id, revision),
  CONSTRAINT notification_briefs_revision_check CHECK (revision >= 1),
  CONSTRAINT notification_briefs_source_hash_check CHECK (
    source_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT notification_briefs_status_check CHECK (
    status IN ('pending', 'ready', 'failed', 'disabled')
  ),
  CONSTRAINT notification_briefs_provider_check CHECK (
    provider IS NULL OR (
      char_length(provider) BETWEEN 1 AND 80
      AND provider !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT notification_briefs_model_check CHECK (
    model IS NULL OR (
      char_length(model) BETWEEN 1 AND 160
      AND model !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT notification_briefs_content_check CHECK (
    (headline IS NULL OR char_length(headline) <= 240)
    AND (impact IS NULL OR char_length(impact) <= 2000)
    AND (
      recommended_action IS NULL
      OR char_length(recommended_action) <= 1000
    )
  ),
  CONSTRAINT notification_briefs_evidence_check CHECK (
    jsonb_typeof(evidence) = 'array'
  ),
  CONSTRAINT notification_briefs_confidence_check CHECK (
    confidence IS NULL OR confidence BETWEEN 0 AND 1
  ),
  CONSTRAINT notification_briefs_action_key_check CHECK (
    action_key IS NULL
    OR action_key IN (
      'open_access_setting',
      'open_release_review',
      'open_routine',
      'approve_grant',
      'resume_agent'
    )
  ),
  CONSTRAINT notification_briefs_action_parameters_check CHECK (
    jsonb_typeof(action_parameters) = 'object'
  ),
  CONSTRAINT notification_briefs_attempt_count_check CHECK (
    attempt_count >= 0
  ),
  CONSTRAINT notification_briefs_error_code_check CHECK (
    last_error_code IS NULL
    OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'
  ),
  CONSTRAINT notification_briefs_ready_shape_check CHECK (
    status <> 'ready'
    OR (
      headline IS NOT NULL
      AND generated_at IS NOT NULL
      AND provider IS NOT NULL
      AND model IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX notification_briefs_current_uidx
  ON public.notification_briefs (notification_id)
  WHERE superseded_at IS NULL;

CREATE INDEX notification_briefs_owner_notification_idx
  ON public.notification_briefs
    (user_id, notification_id, revision DESC);

CREATE INDEX notification_briefs_agent_ready_idx
  ON public.notification_briefs
    (user_id, agent_id, generated_at DESC)
  WHERE status = 'ready' AND superseded_at IS NULL;

CREATE OR REPLACE FUNCTION public.validate_notification_brief_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_notifications AS notifications
    WHERE notifications.id = NEW.notification_id
      AND notifications.user_id = NEW.user_id
      AND notifications.agent_id IS NOT DISTINCT FROM NEW.agent_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'notification_brief_owner_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_notification_brief_ownership
BEFORE INSERT OR UPDATE OF notification_id, user_id, agent_id
ON public.notification_briefs
FOR EACH ROW EXECUTE FUNCTION public.validate_notification_brief_ownership();

ALTER TABLE public.notification_briefs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_briefs
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.notification_briefs TO service_role;

CREATE TRIGGER touch_notification_briefs_updated_at
BEFORE UPDATE ON public.notification_briefs
FOR EACH ROW EXECUTE FUNCTION public.touch_agent_operator_preference_updated_at();

-- Generic durable outbox. Jobs carry references and version hashes, not
-- notification bodies, third-party content, credentials, or ciphertexts.
CREATE SEQUENCE public.operator_projection_event_generation_seq
  AS bigint
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

CREATE TABLE public.operator_projection_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES public.apps(id) ON DELETE CASCADE,
  job_kind text NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  source_version text NOT NULL,
  enqueue_generation bigint NOT NULL DEFAULT
    nextval('public.operator_projection_event_generation_seq'),
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT operator_projection_jobs_dedupe
    UNIQUE (job_kind, source_type, source_id, source_version),
  CONSTRAINT operator_projection_jobs_kind_check CHECK (
    job_kind IN (
      'notification_brief',
      'search_document',
      'attention_reconcile'
    )
  ),
  CONSTRAINT operator_projection_jobs_source_type_check CHECK (
    source_type IN (
      'notification',
      'notification_brief',
      'agent',
      'routine',
      'release'
    )
  ),
  CONSTRAINT operator_projection_jobs_source_version_check CHECK (
    char_length(source_version) BETWEEN 1 AND 160
    AND source_version !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operator_projection_jobs_enqueue_generation_check CHECK (
    enqueue_generation >= 1
  ),
  CONSTRAINT operator_projection_jobs_status_check CHECK (
    status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT operator_projection_jobs_attempt_count_check CHECK (
    attempt_count >= 0 AND attempt_count <= 100
  ),
  CONSTRAINT operator_projection_jobs_lease_shape_check CHECK (
    (
      status = 'processing'
      AND lease_token IS NOT NULL
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR
    (
      status <> 'processing'
      AND lease_token IS NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT operator_projection_jobs_completion_shape_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  ),
  CONSTRAINT operator_projection_jobs_lease_owner_check CHECK (
    lease_owner IS NULL
    OR (
      char_length(lease_owner) BETWEEN 1 AND 160
      AND lease_owner !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT operator_projection_jobs_error_code_check CHECK (
    last_error_code IS NULL
    OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'
  )
);

CREATE INDEX operator_projection_jobs_claim_idx
  ON public.operator_projection_jobs
    (next_attempt_at, created_at, id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX operator_projection_jobs_owner_source_idx
  ON public.operator_projection_jobs
    (user_id, agent_id, source_type, source_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.validate_operator_projection_job_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.source_type = 'notification' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_notifications AS notifications
      WHERE notifications.id = NEW.source_id
        AND notifications.user_id = NEW.user_id
        AND notifications.agent_id IS NOT DISTINCT FROM NEW.agent_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'operator_projection_source_owner_mismatch';
    END IF;
  ELSIF NEW.source_type = 'notification_brief' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.notification_briefs AS briefs
      WHERE briefs.id = NEW.source_id
        AND briefs.user_id = NEW.user_id
        AND briefs.agent_id IS NOT DISTINCT FROM NEW.agent_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'operator_projection_source_owner_mismatch';
    END IF;
  ELSIF NEW.source_type IN ('agent', 'release') THEN
    IF NEW.agent_id IS DISTINCT FROM NEW.source_id OR NOT EXISTS (
      SELECT 1 FROM public.apps AS apps
      WHERE apps.id = NEW.source_id
        AND apps.owner_id = NEW.user_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'operator_projection_source_owner_mismatch';
    END IF;
  ELSIF NEW.source_type = 'routine' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_routines AS routines
      WHERE routines.id = NEW.source_id
        AND routines.user_id = NEW.user_id
        AND routines.composer_app_id IS NOT DISTINCT FROM NEW.agent_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'operator_projection_source_owner_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operator_projection_job_ownership
BEFORE INSERT OR UPDATE OF user_id, agent_id, source_type, source_id
ON public.operator_projection_jobs
FOR EACH ROW EXECUTE FUNCTION public.validate_operator_projection_job_ownership();

ALTER TABLE public.operator_projection_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.operator_projection_jobs
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.operator_projection_jobs TO service_role;
REVOKE ALL ON SEQUENCE public.operator_projection_event_generation_seq
  FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE
  public.operator_projection_event_generation_seq TO service_role;

CREATE TRIGGER touch_operator_projection_jobs_updated_at
BEFORE UPDATE ON public.operator_projection_jobs
FOR EACH ROW EXECUTE FUNCTION public.touch_agent_operator_preference_updated_at();

-- Prevent enrichment or lifecycle code from rewriting the evidence it is
-- supposed to explain. Read/lifecycle/delivery fields remain mutable.
CREATE OR REPLACE FUNCTION public.guard_user_notification_raw_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF ROW(
    OLD.user_id,
    OLD.agent_id,
    OLD.kind,
    OLD.severity,
    OLD.title,
    OLD.body,
    OLD.entity_type,
    OLD.entity_id,
    OLD.action_url,
    OLD.dedupe_key,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.user_id,
    NEW.agent_id,
    NEW.kind,
    NEW.severity,
    NEW.title,
    NEW.body,
    NEW.entity_type,
    NEW.entity_id,
    NEW.action_url,
    NEW.dedupe_key,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'notification_raw_evidence_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_user_notification_raw_evidence
BEFORE UPDATE ON public.user_notifications
FOR EACH ROW EXECUTE FUNCTION public.guard_user_notification_raw_evidence();

CREATE OR REPLACE FUNCTION public.enqueue_user_notification_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_source_version text;
BEGIN
  v_source_version := encode(
    extensions.digest(
      concat_ws(
        E'\x1f',
        NEW.id::text,
        NEW.kind,
        NEW.severity,
        NEW.title,
        coalesce(NEW.body, ''),
        coalesce(NEW.entity_type, ''),
        coalesce(NEW.entity_id, ''),
        coalesce(NEW.action_url, '')
      ),
      'sha256'
    ),
    'hex'
  );

  INSERT INTO public.operator_projection_jobs (
    user_id,
    agent_id,
    job_kind,
    source_type,
    source_id,
    source_version
  ) VALUES (
    NEW.user_id,
    NEW.agent_id,
    'notification_brief',
    'notification',
    NEW.id,
    v_source_version
  )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enqueue_user_notification_projection
AFTER INSERT ON public.user_notifications
FOR EACH ROW EXECUTE FUNCTION public.enqueue_user_notification_projection();

-- Existing rows also need one projection attempt. Consumers fail open to the
-- raw notification when the owner has no BYOK provider.
INSERT INTO public.operator_projection_jobs (
  user_id,
  agent_id,
  job_kind,
  source_type,
  source_id,
  source_version
)
SELECT
  notifications.user_id,
  notifications.agent_id,
  'notification_brief',
  'notification',
  notifications.id,
  encode(
    extensions.digest(
      concat_ws(
        E'\x1f',
        notifications.id::text,
        notifications.kind,
        notifications.severity,
        notifications.title,
        coalesce(notifications.body, ''),
        coalesce(notifications.entity_type, ''),
        coalesce(notifications.entity_id, ''),
        coalesce(notifications.action_url, '')
      ),
      'sha256'
    ),
    'hex'
  )
FROM public.user_notifications AS notifications
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.claim_operator_projection_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 25,
  p_lease_seconds integer DEFAULT 120,
  p_job_kinds text[] DEFAULT NULL
) RETURNS SETOF public.operator_projection_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_worker_id IS NULL
     OR char_length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_worker_id ~ '[[:cntrl:]]'
     OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_seconds NOT BETWEEN 15 AND 900
     OR (
       p_job_kinds IS NOT NULL
       AND NOT p_job_kinds <@ ARRAY[
         'notification_brief',
         'search_document',
         'attention_reconcile'
       ]::text[]
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_operator_projection_claim';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT jobs.id
    FROM public.operator_projection_jobs AS jobs
    WHERE (
      jobs.status = 'pending'
      OR (
        jobs.status = 'processing'
        AND jobs.lease_expires_at <= now()
      )
    )
      AND jobs.next_attempt_at <= now()
      AND jobs.attempt_count < 100
      AND (p_job_kinds IS NULL OR jobs.job_kind = ANY(p_job_kinds))
    ORDER BY jobs.next_attempt_at, jobs.created_at, jobs.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.operator_projection_jobs AS jobs
  SET
    status = 'processing',
    attempt_count = jobs.attempt_count + 1,
    lease_token = gen_random_uuid(),
    lease_owner = btrim(p_worker_id),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    last_error_code = NULL
  FROM candidates
  WHERE jobs.id = candidates.id
  RETURNING jobs.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_operator_projection_job(
  p_job_id uuid,
  p_lease_token uuid
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH completed AS (
    UPDATE public.operator_projection_jobs
    SET
      status = 'completed',
      completed_at = now(),
      lease_token = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = NULL
    WHERE id = p_job_id
      AND status = 'processing'
      AND lease_token = p_lease_token
      AND lease_expires_at > now()
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM completed);
$$;

CREATE OR REPLACE FUNCTION public.retry_operator_projection_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_retry_at timestamptz,
  p_terminal boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated boolean;
BEGIN
  IF p_error_code IS NULL
     OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,79}$'
     OR (NOT p_terminal AND (p_retry_at IS NULL OR p_retry_at <= now())) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_operator_projection_retry';
  END IF;

  WITH retried AS (
    UPDATE public.operator_projection_jobs
    SET
      status = CASE WHEN p_terminal THEN 'failed' ELSE 'pending' END,
      next_attempt_at = CASE
        WHEN p_terminal THEN next_attempt_at
        ELSE p_retry_at
      END,
      lease_token = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error_code = p_error_code
    WHERE id = p_job_id
      AND status = 'processing'
      AND lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM retried) INTO v_updated;
  RETURN v_updated;
END;
$$;

-- Source high-water marks (added by the search producer migration) make
-- terminal job rows dispensable after a conservative audit window. Keep this
-- bounded so the scheduled worker never turns maintenance into a long lock.
CREATE OR REPLACE FUNCTION public.prune_operator_projection_jobs(
  p_retention_days integer DEFAULT 30,
  p_limit integer DEFAULT 1000
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_retention_days NOT BETWEEN 30 AND 3650
     OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_operator_projection_prune';
  END IF;

  WITH candidates AS (
    SELECT jobs.id
    FROM public.operator_projection_jobs AS jobs
    WHERE jobs.status IN ('completed', 'failed', 'cancelled')
      AND coalesce(jobs.completed_at, jobs.updated_at, jobs.created_at)
        < now() - make_interval(days => p_retention_days)
    ORDER BY
      coalesce(jobs.completed_at, jobs.updated_at, jobs.created_at),
      jobs.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.operator_projection_jobs AS jobs
    USING candidates
    WHERE jobs.id = candidates.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_deleted FROM deleted;

  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_user_notification(
  p_user_id uuid,
  p_notification_id uuid,
  p_action text,
  p_snoozed_until timestamptz DEFAULT NULL,
  p_resolution_reason text DEFAULT NULL
) RETURNS TABLE (
  notification_id uuid,
  item_class text,
  lifecycle_state text,
  read_at timestamptz,
  snoozed_until timestamptz,
  resolved_at timestamptz,
  archived_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.user_notifications%ROWTYPE;
  v_action text := lower(coalesce(btrim(p_action), ''));
BEGIN
  SELECT * INTO v_row
  FROM public.user_notifications
  WHERE id = p_notification_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'notification_not_found';
  END IF;

  IF v_action = 'read' THEN
    UPDATE public.user_notifications AS notifications
    SET read_at = coalesce(notifications.read_at, now())
    WHERE notifications.id = v_row.id;
  ELSIF v_action = 'archive' AND v_row.item_class = 'report' THEN
    UPDATE public.user_notifications AS notifications
    SET
      lifecycle_state = 'archived',
      archived_at = now(),
      read_at = coalesce(notifications.read_at, now()),
      state_changed_at = now()
    WHERE notifications.id = v_row.id;
  ELSIF v_action = 'snooze'
        AND v_row.item_class = 'incident'
        AND p_snoozed_until > now() THEN
    UPDATE public.user_notifications AS notifications
    SET
      lifecycle_state = 'snoozed',
      snoozed_until = p_snoozed_until,
      resolved_at = NULL,
      resolution_reason = NULL,
      state_changed_at = now()
    WHERE notifications.id = v_row.id;
  ELSIF v_action = 'resolve' AND v_row.item_class = 'incident' THEN
    UPDATE public.user_notifications AS notifications
    SET
      lifecycle_state = 'resolved',
      snoozed_until = NULL,
      resolved_at = now(),
      resolution_reason = nullif(btrim(p_resolution_reason), ''),
      state_changed_at = now()
    WHERE notifications.id = v_row.id;
  ELSIF v_action = 'reopen' AND v_row.item_class = 'incident' THEN
    UPDATE public.user_notifications AS notifications
    SET
      lifecycle_state = 'open',
      snoozed_until = NULL,
      resolved_at = NULL,
      resolution_reason = NULL,
      state_changed_at = now()
    WHERE notifications.id = v_row.id;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_notification_transition';
  END IF;

  RETURN QUERY
  SELECT
    notifications.id,
    notifications.item_class,
    notifications.lifecycle_state,
    notifications.read_at,
    notifications.snoozed_until,
    notifications.resolved_at,
    notifications.archived_at
  FROM public.user_notifications AS notifications
  WHERE notifications.id = v_row.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_notification_incident_by_dedupe(
  p_user_id uuid,
  p_dedupe_key text,
  p_resolution_reason text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_user_id IS NULL OR nullif(btrim(p_dedupe_key), '') IS NULL
     OR nullif(btrim(p_resolution_reason), '') IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_incident_resolution';
  END IF;

  UPDATE public.user_notifications
  SET
    lifecycle_state = 'resolved',
    snoozed_until = NULL,
    resolved_at = now(),
    resolution_reason = left(btrim(p_resolution_reason), 500),
    state_changed_at = now()
  WHERE user_id = p_user_id
    AND dedupe_key = p_dedupe_key
    AND item_class = 'incident'
    AND lifecycle_state IN ('open', 'snoozed');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.classify_user_notification_attention()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_user_notification_episode(
  uuid, uuid, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_notification_brief_ownership()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_operator_projection_job_ownership()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_user_notification_raw_evidence()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_user_notification_projection()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_operator_projection_jobs(
  text, integer, integer, text[]
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_operator_projection_job(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retry_operator_projection_job(
  uuid, uuid, text, timestamptz, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_operator_projection_jobs(integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_user_notification(
  uuid, uuid, text, timestamptz, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_notification_incident_by_dedupe(
  uuid, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_operator_projection_jobs(
  text, integer, integer, text[]
) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_user_notification_episode(
  uuid, uuid, text, text, text, text, text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_operator_projection_job(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.retry_operator_projection_job(
  uuid, uuid, text, timestamptz, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_operator_projection_jobs(
  integer, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_user_notification(
  uuid, uuid, text, timestamptz, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_notification_incident_by_dedupe(
  uuid, text, text
) TO service_role;
