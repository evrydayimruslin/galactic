-- Complete the owner-private Agent search projection source graph.
--
-- App jobs reconcile manifest-derived Interfaces, Functions and fields,
-- release metadata, setting schema metadata and Access authorities. Run jobs
-- expose only identifiers, lifecycle state and timestamps: raw arguments,
-- results, output, errors and secret values never enter the outbox or index.

ALTER TABLE public.operator_projection_jobs
  DROP CONSTRAINT operator_projection_jobs_source_type_check;
ALTER TABLE public.operator_projection_jobs
  ADD CONSTRAINT operator_projection_jobs_source_type_check CHECK (
    source_type IN (
      'notification',
      'notification_brief',
      'agent',
      'routine',
      'release',
      'routine_run',
      'compute_run'
    )
  );

-- Content hashes are useful projection inputs, but they are not event
-- identities: A -> B -> A would otherwise collide. Every enqueue already owns
-- a database-monotonic generation from the outbox sequence. Use it as the
-- durable event identity and retain source_version as the safe content hash.
ALTER TABLE public.operator_projection_jobs
  DROP CONSTRAINT operator_projection_jobs_dedupe;
ALTER TABLE public.operator_projection_jobs
  ADD CONSTRAINT operator_projection_jobs_generation_key
  UNIQUE (enqueue_generation);

-- The ledger is deliberately separate from the searchable document. A
-- tombstone therefore survives even when no document exists and prevents an
-- older in-flight worker from resurrecting a deleted subject.
CREATE TABLE public.agent_search_subject_revisions (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  enqueue_generation bigint NOT NULL,
  source_revision text NOT NULL,
  is_deleted boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agent_id, subject_type, subject_id),
  CONSTRAINT agent_search_subject_revisions_owner_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES public.apps(owner_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_search_subject_revisions_generation_check CHECK (
    enqueue_generation >= 1
  ),
  CONSTRAINT agent_search_subject_revisions_subject_id_check CHECK (
    char_length(subject_id) BETWEEN 1 AND 240
    AND subject_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT agent_search_subject_revisions_source_revision_check CHECK (
    char_length(source_revision) BETWEEN 1 AND 160
    AND source_revision !~ '[[:cntrl:]]'
  )
);

ALTER TABLE public.agent_search_subject_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_search_subject_revisions
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.agent_search_subject_revisions TO service_role;

-- Source high-water marks close a different race than subject tombstones. A
-- newer Agent reconciliation may observe that a never-materialized Interface
-- is absent while an older reconciliation is already in flight. Recording the
-- newest source generation at enqueue time lets every later write reject that
-- old worker even though no subject row or tombstone existed yet.
CREATE TABLE public.agent_search_source_revisions (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  enqueue_generation bigint NOT NULL,
  source_version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agent_id, source_type, source_id),
  CONSTRAINT agent_search_source_revisions_owner_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES public.apps(owner_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_search_source_revisions_generation_check CHECK (
    enqueue_generation >= 1
  ),
  CONSTRAINT agent_search_source_revisions_source_version_check CHECK (
    char_length(source_version) BETWEEN 1 AND 160
    AND source_version !~ '[[:cntrl:]]'
  )
);

ALTER TABLE public.agent_search_source_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_search_source_revisions
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.agent_search_source_revisions TO service_role;

CREATE OR REPLACE FUNCTION public.record_agent_search_source_generation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.job_kind = 'search_document' AND NEW.agent_id IS NOT NULL THEN
    INSERT INTO public.agent_search_source_revisions (
      user_id,
      agent_id,
      source_type,
      source_id,
      enqueue_generation,
      source_version
    ) VALUES (
      NEW.user_id,
      NEW.agent_id,
      NEW.source_type,
      NEW.source_id,
      NEW.enqueue_generation,
      NEW.source_version
    )
    ON CONFLICT (user_id, agent_id, source_type, source_id) DO UPDATE
    SET
      enqueue_generation = EXCLUDED.enqueue_generation,
      source_version = EXCLUDED.source_version,
      updated_at = now()
    WHERE agent_search_source_revisions.enqueue_generation <
      EXCLUDED.enqueue_generation;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER record_agent_search_source_generation
AFTER INSERT ON public.operator_projection_jobs
FOR EACH ROW EXECUTE FUNCTION public.record_agent_search_source_generation();

-- Jobs seeded by preceding migrations predate this trigger.
INSERT INTO public.agent_search_source_revisions (
  user_id,
  agent_id,
  source_type,
  source_id,
  enqueue_generation,
  source_version
)
SELECT DISTINCT ON (
  jobs.user_id,
  jobs.agent_id,
  jobs.source_type,
  jobs.source_id
)
  jobs.user_id,
  jobs.agent_id,
  jobs.source_type,
  jobs.source_id,
  jobs.enqueue_generation,
  jobs.source_version
FROM public.operator_projection_jobs AS jobs
WHERE jobs.job_kind = 'search_document'
  AND jobs.agent_id IS NOT NULL
ORDER BY
  jobs.user_id,
  jobs.agent_id,
  jobs.source_type,
  jobs.source_id,
  jobs.enqueue_generation DESC;

DROP FUNCTION public.upsert_agent_search_document(
  uuid, uuid, text, text, text, text, text, text, text[], text,
  timestamptz, boolean
);

CREATE FUNCTION public.upsert_agent_search_document(
  p_user_id uuid,
  p_agent_id uuid,
  p_subject_type text,
  p_subject_id text,
  p_title text,
  p_breadcrumb text,
  p_snippet text,
  p_route text,
  p_safe_tags text[],
  p_source_revision text,
  p_source_type text,
  p_source_id uuid,
  p_enqueue_generation bigint,
  p_source_updated_at timestamptz DEFAULT NULL,
  p_request_embedding boolean DEFAULT false
) RETURNS public.agent_search_documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_document public.agent_search_documents%ROWTYPE;
  v_claimed_generation bigint;
BEGIN
  IF p_enqueue_generation IS NULL OR p_enqueue_generation < 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_search_projection_generation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.apps
    WHERE id = p_agent_id
      AND owner_id = p_user_id
      AND visibility = 'private'
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_not_found';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.agent_search_source_revisions AS sources
    WHERE sources.user_id = p_user_id
      AND sources.agent_id = p_agent_id
      AND sources.source_type = p_source_type
      AND sources.source_id = p_source_id
      AND sources.enqueue_generation = p_enqueue_generation
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.agent_search_subject_revisions (
    user_id,
    agent_id,
    subject_type,
    subject_id,
    enqueue_generation,
    source_revision,
    is_deleted
  ) VALUES (
    p_user_id,
    p_agent_id,
    p_subject_type,
    p_subject_id,
    p_enqueue_generation,
    p_source_revision,
    false
  )
  ON CONFLICT (user_id, agent_id, subject_type, subject_id) DO UPDATE
  SET
    enqueue_generation = EXCLUDED.enqueue_generation,
    source_revision = EXCLUDED.source_revision,
    is_deleted = false,
    updated_at = now()
  WHERE agent_search_subject_revisions.enqueue_generation <
    EXCLUDED.enqueue_generation
  RETURNING enqueue_generation INTO v_claimed_generation;

  -- A newer enqueue or tombstone already owns this subject.
  IF v_claimed_generation IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.agent_search_documents (
    user_id,
    agent_id,
    subject_type,
    subject_id,
    title,
    breadcrumb,
    snippet,
    route,
    safe_tags,
    embedding_status,
    source_revision,
    source_updated_at,
    deleted_at
  ) VALUES (
    p_user_id,
    p_agent_id,
    p_subject_type,
    p_subject_id,
    btrim(p_title),
    btrim(p_breadcrumb),
    p_snippet,
    p_route,
    coalesce(p_safe_tags, ARRAY[]::text[]),
    CASE WHEN p_request_embedding THEN 'pending' ELSE 'none' END,
    p_source_revision,
    p_source_updated_at,
    NULL
  )
  ON CONFLICT (user_id, agent_id, subject_type, subject_id) DO UPDATE
  SET
    title = EXCLUDED.title,
    breadcrumb = EXCLUDED.breadcrumb,
    snippet = EXCLUDED.snippet,
    route = EXCLUDED.route,
    safe_tags = EXCLUDED.safe_tags,
    embedding = CASE
      WHEN agent_search_documents.source_revision =
           EXCLUDED.source_revision
        AND NOT (
          p_request_embedding
          AND agent_search_documents.embedding_status <> 'ready'
        )
        THEN agent_search_documents.embedding
      ELSE NULL
    END,
    embedding_status = CASE
      WHEN agent_search_documents.source_revision =
           EXCLUDED.source_revision
        AND p_request_embedding
        AND agent_search_documents.embedding_status <> 'ready'
        THEN 'pending'
      WHEN agent_search_documents.source_revision =
           EXCLUDED.source_revision
        THEN agent_search_documents.embedding_status
      WHEN p_request_embedding THEN 'pending'
      ELSE 'none'
    END,
    embedding_provider = CASE
      WHEN agent_search_documents.source_revision =
           EXCLUDED.source_revision
        AND NOT (
          p_request_embedding
          AND agent_search_documents.embedding_status <> 'ready'
        )
        THEN agent_search_documents.embedding_provider
      ELSE NULL
    END,
    embedding_model = CASE
      WHEN agent_search_documents.source_revision =
           EXCLUDED.source_revision
        AND NOT (
          p_request_embedding
          AND agent_search_documents.embedding_status <> 'ready'
        )
        THEN agent_search_documents.embedding_model
      ELSE NULL
    END,
    embedding_text_hash = CASE
      WHEN agent_search_documents.source_revision =
           EXCLUDED.source_revision
        AND NOT (
          p_request_embedding
          AND agent_search_documents.embedding_status <> 'ready'
        )
        THEN agent_search_documents.embedding_text_hash
      ELSE NULL
    END,
    source_revision = EXCLUDED.source_revision,
    source_updated_at = EXCLUDED.source_updated_at,
    deleted_at = NULL
  RETURNING * INTO v_document;

  RETURN v_document;
END;
$$;

DROP FUNCTION public.tombstone_agent_search_document(
  uuid, uuid, text, text
);

CREATE FUNCTION public.tombstone_agent_search_document(
  p_user_id uuid,
  p_agent_id uuid,
  p_subject_type text,
  p_subject_id text,
  p_source_revision text,
  p_source_type text,
  p_source_id uuid,
  p_enqueue_generation bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed_generation bigint;
  v_tombstoned boolean;
BEGIN
  IF p_enqueue_generation IS NULL OR p_enqueue_generation < 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_search_projection_generation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.agent_search_source_revisions AS sources
    WHERE sources.user_id = p_user_id
      AND sources.agent_id = p_agent_id
      AND sources.source_type = p_source_type
      AND sources.source_id = p_source_id
      AND sources.enqueue_generation = p_enqueue_generation
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.agent_search_subject_revisions (
    user_id,
    agent_id,
    subject_type,
    subject_id,
    enqueue_generation,
    source_revision,
    is_deleted
  ) VALUES (
    p_user_id,
    p_agent_id,
    p_subject_type,
    p_subject_id,
    p_enqueue_generation,
    p_source_revision,
    true
  )
  ON CONFLICT (user_id, agent_id, subject_type, subject_id) DO UPDATE
  SET
    enqueue_generation = EXCLUDED.enqueue_generation,
    source_revision = EXCLUDED.source_revision,
    is_deleted = true,
    updated_at = now()
  WHERE agent_search_subject_revisions.enqueue_generation <
    EXCLUDED.enqueue_generation
  RETURNING enqueue_generation INTO v_claimed_generation;

  IF v_claimed_generation IS NULL THEN
    RETURN false;
  END IF;

  WITH tombstoned AS (
    UPDATE public.agent_search_documents
    SET
      source_revision = p_source_revision,
      deleted_at = now(),
      embedding = NULL,
      embedding_status = 'disabled',
      embedding_provider = NULL,
      embedding_model = NULL,
      embedding_text_hash = NULL
    WHERE user_id = p_user_id
      AND agent_id = p_agent_id
      AND subject_type = p_subject_type
      AND subject_id = p_subject_id
      AND deleted_at IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM tombstoned) INTO v_tombstoned;
  RETURN v_tombstoned;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_agent_search_document(
  uuid, uuid, text, text, text, text, text, text, text[], text, text, uuid,
  bigint, timestamptz, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_agent_search_document(
  uuid, uuid, text, text, text, text, text, text, text[], text, text, uuid,
  bigint, timestamptz, boolean
) TO service_role;
REVOKE ALL ON FUNCTION public.tombstone_agent_search_document(
  uuid, uuid, text, text, text, text, uuid, bigint
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tombstone_agent_search_document(
  uuid, uuid, text, text, text, text, uuid, bigint
) TO service_role;

CREATE OR REPLACE FUNCTION public.validate_operator_projection_job_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Every Agent-scoped outbox row must belong to the Agent's current owner.
  -- Source rows such as immutable notification evidence and economic run
  -- history intentionally retain their original user_id after a transfer.
  IF NEW.agent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.apps AS apps
    WHERE apps.id = NEW.agent_id
      AND apps.owner_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'operator_projection_agent_owner_mismatch';
  END IF;

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
  ELSIF NEW.source_type = 'routine_run' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.routine_runs AS runs
      JOIN public.user_routines AS routines
        ON routines.id = runs.routine_id
       AND routines.user_id = runs.user_id
      WHERE runs.id = NEW.source_id
        AND runs.user_id = NEW.user_id
        AND routines.composer_app_id IS NOT DISTINCT FROM NEW.agent_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'operator_projection_source_owner_mismatch';
    END IF;
  ELSIF NEW.source_type = 'compute_run' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.compute_runs AS runs
      WHERE runs.id = NEW.source_id
        AND runs.user_id = NEW.user_id
        AND runs.agent_id IS NOT DISTINCT FROM NEW.agent_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'operator_projection_source_owner_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Operator projections are private to the owner who produced them. An Agent
-- ownership transfer must not carry the previous owner's Attention briefs,
-- run navigation, or derived search snippets to the next owner. Clear every
-- rebuildable projection before the parent ownership key changes; the normal
-- app projection trigger below then seeds a fresh owner-scoped reconciliation.
CREATE OR REPLACE FUNCTION public.clear_agent_operator_projections_on_owner_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.owner_id IS DISTINCT FROM NEW.owner_id THEN
    DELETE FROM public.notification_briefs
    WHERE agent_id = OLD.id;

    DELETE FROM public.agent_search_documents
    WHERE agent_id = OLD.id;

    DELETE FROM public.agent_search_subject_revisions
    WHERE agent_id = OLD.id;

    DELETE FROM public.agent_search_source_revisions
    WHERE agent_id = OLD.id;

    -- Brief deletion can enqueue an Attention tombstone for the old owner.
    -- Clear the outbox last so no transfer-triggered residue crosses owners.
    DELETE FROM public.operator_projection_jobs
    WHERE agent_id = OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER clear_agent_operator_projections_on_owner_change
BEFORE UPDATE OF owner_id ON public.apps
FOR EACH ROW
WHEN (OLD.owner_id IS DISTINCT FROM NEW.owner_id)
EXECUTE FUNCTION public.clear_agent_operator_projections_on_owner_change();

-- A notification or its current brief owns exactly one Attention subject,
-- keyed by notification id. Capture the tombstone before either source row is
-- removed so cleanup can never leave a searchable orphan.
CREATE OR REPLACE FUNCTION public.enqueue_attention_search_tombstone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_notification_id uuid;
  v_user_id uuid;
  v_agent_id uuid;
  v_source_version text;
BEGIN
  IF TG_TABLE_NAME = 'user_notifications' THEN
    v_notification_id := OLD.id;
    v_user_id := OLD.user_id;
    v_agent_id := OLD.agent_id;
  ELSE
    v_notification_id := OLD.notification_id;
    v_user_id := OLD.user_id;
    v_agent_id := OLD.agent_id;
    -- During a notification cascade the parent row may already be invisible
    -- to ownership validation. Its own BEFORE DELETE trigger has captured the
    -- same subject tombstone, so the child safely skips a redundant enqueue.
    IF NOT EXISTS (
      SELECT 1
      FROM public.user_notifications AS notifications
      WHERE notifications.id = OLD.notification_id
        AND notifications.user_id = OLD.user_id
        AND notifications.agent_id IS NOT DISTINCT FROM OLD.agent_id
    ) THEN
      RETURN OLD;
    END IF;
  END IF;

  IF v_agent_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.apps AS apps
    WHERE apps.id = v_agent_id
      AND apps.owner_id = v_user_id
  ) THEN
    v_source_version := encode(extensions.digest(
      concat_ws(
        E'\x1f',
        v_notification_id::text,
        TG_TABLE_NAME,
        OLD.id::text,
        'deleted'
      ),
      'sha256'
    ), 'hex');

    INSERT INTO public.operator_projection_jobs (
      user_id,
      agent_id,
      job_kind,
      source_type,
      source_id,
      source_version
    ) VALUES (
      v_user_id,
      v_agent_id,
      'search_document',
      'notification',
      v_notification_id,
      v_source_version
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER enqueue_attention_search_tombstone_on_notification_delete
BEFORE DELETE ON public.user_notifications
FOR EACH ROW EXECUTE FUNCTION public.enqueue_attention_search_tombstone();

CREATE TRIGGER enqueue_attention_search_tombstone_on_current_brief_delete
BEFORE DELETE ON public.notification_briefs
FOR EACH ROW
WHEN (OLD.superseded_at IS NULL)
EXECUTE FUNCTION public.enqueue_attention_search_tombstone();

-- Attention search is a projection of *active* Attention, not notification
-- history. Reading a report, resolving/archiving an item, or reopening a
-- recurring incident must therefore reconcile the same search subject.
CREATE OR REPLACE FUNCTION public.enqueue_attention_search_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_source_version text;
BEGIN
  IF NEW.agent_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.apps AS apps
    WHERE apps.id = NEW.agent_id
      AND apps.owner_id = NEW.user_id
  ) THEN
    RETURN NEW;
  END IF;

  v_source_version := encode(extensions.digest(
    concat_ws(
      E'\x1f',
      NEW.id::text,
      NEW.item_class,
      NEW.lifecycle_state,
      coalesce(NEW.read_at::text, ''),
      coalesce(NEW.snoozed_until::text, ''),
      NEW.state_changed_at::text
    ),
    'sha256'
  ), 'hex');

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
    'search_document',
    'notification',
    NEW.id,
    v_source_version
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enqueue_attention_search_reconciliation
AFTER UPDATE OF item_class, lifecycle_state, read_at, snoozed_until
ON public.user_notifications
FOR EACH ROW
WHEN (
  OLD.item_class IS DISTINCT FROM NEW.item_class
  OR OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state
  OR OLD.read_at IS DISTINCT FROM NEW.read_at
  OR OLD.snoozed_until IS DISTINCT FROM NEW.snoozed_until
)
EXECUTE FUNCTION public.enqueue_attention_search_reconciliation();

-- App source revisions include every safe metadata surface the worker reads.
-- env_vars is intentionally absent: values are not searchable and a value-only
-- change must not enqueue a metadata projection.
CREATE OR REPLACE FUNCTION public.enqueue_agent_search_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user_id uuid;
  v_agent_id uuid;
  v_source_type text;
  v_source_id uuid;
  v_source_version text;
BEGIN
  IF TG_TABLE_NAME = 'apps' THEN
    v_user_id := NEW.owner_id;
    v_agent_id := NEW.id;
    v_source_type := 'agent';
    v_source_id := NEW.id;
    v_source_version := encode(extensions.digest(
      concat_ws(
        E'\x1f',
        NEW.id::text,
        coalesce(NEW.owner_id::text, ''),
        coalesce(NEW.name, ''),
        coalesce(NEW.slug, ''),
        coalesce(NEW.description, ''),
        coalesce(NEW.current_version, ''),
        coalesce(NEW.current_version_promoted_at::text, ''),
        coalesce(NEW.manifest, ''),
        coalesce(NEW.env_schema, '{}'::jsonb)::text,
        coalesce(NEW.declared_permissions, '[]'::jsonb)::text,
        coalesce(NEW.visibility, ''),
        coalesce(NEW.deleted_at::text, '')
      ),
      'sha256'
    ), 'hex');
  ELSIF TG_TABLE_NAME = 'user_routines' THEN
    v_user_id := NEW.user_id;
    v_agent_id := NEW.composer_app_id;
    v_source_type := 'routine';
    v_source_id := NEW.id;
    v_source_version := encode(extensions.digest(
      concat_ws(
        E'\x1f',
        NEW.id::text,
        coalesce(NEW.name, ''),
        coalesce(NEW.description, ''),
        coalesce(NEW.intent, ''),
        coalesce(NEW.status, ''),
        coalesce(NEW.metadata, '{}'::jsonb)::text,
        coalesce(NEW.deleted_at::text, ''),
        coalesce(NEW.updated_at::text, '')
      ),
      'sha256'
    ), 'hex');
  ELSE
    v_user_id := NEW.user_id;
    v_agent_id := NEW.agent_id;
    v_source_type := 'notification_brief';
    v_source_id := NEW.id;
    v_source_version := encode(extensions.digest(
      concat_ws(
        E'\x1f',
        NEW.id::text,
        NEW.revision::text,
        NEW.source_hash,
        NEW.status,
        coalesce(NEW.updated_at::text, '')
      ),
      'sha256'
    ), 'hex');
  END IF;

  IF v_user_id IS NOT NULL
     AND v_agent_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.apps AS apps
       WHERE apps.id = v_agent_id
         AND apps.owner_id = v_user_id
     ) THEN
    INSERT INTO public.operator_projection_jobs (
      user_id,
      agent_id,
      job_kind,
      source_type,
      source_id,
      source_version
    ) VALUES (
      v_user_id,
      v_agent_id,
      'search_document',
      v_source_type,
      v_source_id,
      v_source_version
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enqueue_agent_search_projection_on_app
  ON public.apps;
CREATE TRIGGER enqueue_agent_search_projection_on_app
AFTER INSERT OR UPDATE OF
  owner_id,
  name,
  slug,
  description,
  current_version,
  current_version_promoted_at,
  manifest,
  env_schema,
  declared_permissions,
  visibility,
  deleted_at
ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.enqueue_agent_search_projection();

DROP TRIGGER IF EXISTS enqueue_agent_search_projection_on_routine
  ON public.user_routines;
CREATE TRIGGER enqueue_agent_search_projection_on_routine
AFTER INSERT OR UPDATE OF
  name,
  description,
  intent,
  status,
  metadata,
  deleted_at,
  updated_at
ON public.user_routines
FOR EACH ROW EXECUTE FUNCTION public.enqueue_agent_search_projection();

-- Deleting or soft-deleting a Routine removes both its navigation subject and
-- every run subject that depended on it. Parent cascades are not trusted to
-- retain enough ownership context, so capture all tombstones at the Routine.
CREATE OR REPLACE FUNCTION public.enqueue_routine_search_tombstones()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_source_version text;
BEGIN
  IF OLD.composer_app_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.apps AS apps
    WHERE apps.id = OLD.composer_app_id
      AND apps.owner_id = OLD.user_id
  ) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- The ordinary AFTER UPDATE projection already owns the Routine tombstone
  -- for soft deletion. Hard deletion needs an explicit pre-delete event.
  IF TG_OP = 'DELETE' THEN
    v_source_version := encode(extensions.digest(
      concat_ws(E'\x1f', OLD.id::text, 'routine', 'deleted'),
      'sha256'
    ), 'hex');
    INSERT INTO public.operator_projection_jobs (
      user_id,
      agent_id,
      job_kind,
      source_type,
      source_id,
      source_version
    ) VALUES (
      OLD.user_id,
      OLD.composer_app_id,
      'search_document',
      'routine',
      OLD.id,
      v_source_version
    )
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.operator_projection_jobs (
    user_id,
    agent_id,
    job_kind,
    source_type,
    source_id,
    source_version
  )
  SELECT
    OLD.user_id,
    OLD.composer_app_id,
    'search_document',
    'routine_run',
    runs.id,
    encode(extensions.digest(
      concat_ws(E'\x1f', runs.id::text, OLD.id::text, 'routine_deleted'),
      'sha256'
    ), 'hex')
  FROM public.routine_runs AS runs
  WHERE runs.routine_id = OLD.id
    AND runs.user_id = OLD.user_id
  ON CONFLICT DO NOTHING;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enqueue_routine_search_tombstones_before_delete
BEFORE DELETE ON public.user_routines
FOR EACH ROW EXECUTE FUNCTION public.enqueue_routine_search_tombstones();

CREATE TRIGGER enqueue_routine_search_tombstones_after_soft_delete
AFTER UPDATE OF deleted_at ON public.user_routines
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION public.enqueue_routine_search_tombstones();

CREATE OR REPLACE FUNCTION public.enqueue_agent_search_run_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user_id uuid;
  v_agent_id uuid;
  v_source_type text;
  v_source_id uuid;
  v_source_version text;
  v_routine_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'routine_runs' THEN
    IF TG_OP = 'DELETE' THEN
      v_user_id := OLD.user_id;
      v_source_id := OLD.id;
      v_routine_id := OLD.routine_id;
      v_source_version := encode(extensions.digest(
        concat_ws(
          E'\x1f',
          OLD.id::text,
          OLD.routine_id::text,
          coalesce(OLD.status, ''),
          coalesce(OLD.started_at::text, ''),
          coalesce(OLD.completed_at::text, ''),
          coalesce(OLD.created_at::text, ''),
          'deleted'
        ),
        'sha256'
      ), 'hex');
    ELSE
      v_user_id := NEW.user_id;
      v_source_id := NEW.id;
      v_routine_id := NEW.routine_id;
      v_source_version := encode(extensions.digest(
        concat_ws(
          E'\x1f',
          NEW.id::text,
          NEW.routine_id::text,
          coalesce(NEW.status, ''),
          coalesce(NEW.started_at::text, ''),
          coalesce(NEW.completed_at::text, ''),
          coalesce(NEW.created_at::text, '')
        ),
        'sha256'
      ), 'hex');
    END IF;
    SELECT routines.composer_app_id INTO v_agent_id
    FROM public.user_routines AS routines
    WHERE routines.id = v_routine_id
      AND routines.user_id = v_user_id;
    v_source_type := 'routine_run';
  ELSE
    IF TG_OP = 'DELETE' THEN
      v_user_id := OLD.user_id;
      v_agent_id := OLD.agent_id;
      v_source_id := OLD.id;
      v_source_version := encode(extensions.digest(
        concat_ws(
          E'\x1f',
          OLD.id::text,
          OLD.agent_id::text,
          OLD.caller_function,
          OLD.state,
          OLD.state_version::text,
          coalesce(OLD.started_at::text, ''),
          coalesce(OLD.finished_at::text, ''),
          coalesce(OLD.updated_at::text, ''),
          'deleted'
        ),
        'sha256'
      ), 'hex');
    ELSE
      v_user_id := NEW.user_id;
      v_agent_id := NEW.agent_id;
      v_source_id := NEW.id;
      v_source_version := encode(extensions.digest(
        concat_ws(
          E'\x1f',
          NEW.id::text,
          NEW.agent_id::text,
          NEW.caller_function,
          NEW.state,
          NEW.state_version::text,
          coalesce(NEW.started_at::text, ''),
          coalesce(NEW.finished_at::text, ''),
          coalesce(NEW.updated_at::text, '')
        ),
        'sha256'
      ), 'hex');
    END IF;
    v_source_type := 'compute_run';
  END IF;

  IF v_user_id IS NOT NULL
     AND v_agent_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.apps AS apps
       WHERE apps.id = v_agent_id
         AND apps.owner_id = v_user_id
     ) THEN
    INSERT INTO public.operator_projection_jobs (
      user_id,
      agent_id,
      job_kind,
      source_type,
      source_id,
      source_version
    ) VALUES (
      v_user_id,
      v_agent_id,
      'search_document',
      v_source_type,
      v_source_id,
      v_source_version
    )
    ON CONFLICT DO NOTHING;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enqueue_agent_search_projection_on_routine_run
AFTER INSERT OR UPDATE OF status, started_at, completed_at
ON public.routine_runs
FOR EACH ROW EXECUTE FUNCTION public.enqueue_agent_search_run_projection();

-- A direct run deletion can enqueue its tombstone while the ownership source
-- still exists. Parent cascades may already hide the routine; in that case the
-- function safely skips the redundant job and Agent deletion remains the
-- authoritative cascade for search documents.
CREATE TRIGGER enqueue_agent_search_projection_before_routine_run_delete
BEFORE DELETE ON public.routine_runs
FOR EACH ROW EXECUTE FUNCTION public.enqueue_agent_search_run_projection();

CREATE TRIGGER enqueue_agent_search_projection_on_compute_run
AFTER INSERT OR UPDATE OF
  state,
  state_version,
  started_at,
  finished_at,
  updated_at
ON public.compute_runs
FOR EACH ROW EXECUTE FUNCTION public.enqueue_agent_search_run_projection();

CREATE TRIGGER enqueue_agent_search_projection_before_compute_run_delete
BEFORE DELETE ON public.compute_runs
FOR EACH ROW EXECUTE FUNCTION public.enqueue_agent_search_run_projection();

-- Reconcile every current private Agent against the richer static source hash.
INSERT INTO public.operator_projection_jobs (
  user_id,
  agent_id,
  job_kind,
  source_type,
  source_id,
  source_version
)
SELECT
  apps.owner_id,
  apps.id,
  'search_document',
  'agent',
  apps.id,
  encode(extensions.digest(
    concat_ws(
      E'\x1f',
      apps.id::text,
      coalesce(apps.name, ''),
      coalesce(apps.slug, ''),
      coalesce(apps.description, ''),
      coalesce(apps.current_version, ''),
      coalesce(apps.current_version_promoted_at::text, ''),
      coalesce(apps.manifest, ''),
      coalesce(apps.env_schema, '{}'::jsonb)::text,
      coalesce(apps.declared_permissions, '[]'::jsonb)::text,
      coalesce(apps.visibility, ''),
      coalesce(apps.deleted_at::text, '')
    ),
    'sha256'
  ), 'hex')
FROM public.apps AS apps
WHERE apps.owner_id IS NOT NULL
  AND apps.visibility = 'private'
  AND apps.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- Bound migration backlog to the 50 most recent runs of each execution class
-- per Agent. Triggers keep all future lifecycle changes current.
WITH ranked_routine_runs AS (
  SELECT
    runs.*,
    routines.composer_app_id,
    row_number() OVER (
      PARTITION BY routines.composer_app_id
      ORDER BY runs.created_at DESC, runs.id DESC
    ) AS source_rank
  FROM public.routine_runs AS runs
  JOIN public.user_routines AS routines
    ON routines.id = runs.routine_id
   AND routines.user_id = runs.user_id
  JOIN public.apps AS apps
    ON apps.id = routines.composer_app_id
   AND apps.owner_id = runs.user_id
   AND apps.visibility = 'private'
   AND apps.deleted_at IS NULL
  WHERE routines.composer_app_id IS NOT NULL
)
INSERT INTO public.operator_projection_jobs (
  user_id,
  agent_id,
  job_kind,
  source_type,
  source_id,
  source_version
)
SELECT
  runs.user_id,
  runs.composer_app_id,
  'search_document',
  'routine_run',
  runs.id,
  encode(extensions.digest(
    concat_ws(
      E'\x1f',
      runs.id::text,
      runs.routine_id::text,
      coalesce(runs.status, ''),
      coalesce(runs.started_at::text, ''),
      coalesce(runs.completed_at::text, ''),
      coalesce(runs.created_at::text, '')
    ),
    'sha256'
  ), 'hex')
FROM ranked_routine_runs AS runs
WHERE runs.source_rank <= 50
ON CONFLICT DO NOTHING;

WITH ranked_compute_runs AS (
  SELECT
    runs.*,
    row_number() OVER (
      PARTITION BY runs.agent_id
      ORDER BY runs.created_at DESC, runs.id DESC
    ) AS source_rank
  FROM public.compute_runs AS runs
  JOIN public.apps AS apps
    ON apps.id = runs.agent_id
   AND apps.owner_id = runs.user_id
   AND apps.visibility = 'private'
   AND apps.deleted_at IS NULL
)
INSERT INTO public.operator_projection_jobs (
  user_id,
  agent_id,
  job_kind,
  source_type,
  source_id,
  source_version
)
SELECT
  runs.user_id,
  runs.agent_id,
  'search_document',
  'compute_run',
  runs.id,
  encode(extensions.digest(
    concat_ws(
      E'\x1f',
      runs.id::text,
      runs.agent_id::text,
      runs.caller_function,
      runs.state,
      runs.state_version::text,
      coalesce(runs.started_at::text, ''),
      coalesce(runs.finished_at::text, ''),
      coalesce(runs.updated_at::text, '')
    ),
    'sha256'
  ), 'hex')
FROM ranked_compute_runs AS runs
WHERE runs.source_rank <= 50
ON CONFLICT DO NOTHING;

REVOKE ALL ON FUNCTION public.validate_operator_projection_job_ownership()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_agent_search_source_generation()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_agent_operator_projections_on_owner_change()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_attention_search_tombstone()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_attention_search_reconciliation()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_agent_search_projection()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_routine_search_tombstones()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_agent_search_run_projection()
  FROM PUBLIC, anon, authenticated;
