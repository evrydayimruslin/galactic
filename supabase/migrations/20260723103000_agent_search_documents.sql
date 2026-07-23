-- Operator-grade Agent Home: owner-private navigation search.
--
-- Documents contain only explicitly selected labels, safe summaries and
-- canonical destinations. Secret values, encrypted settings, run arguments,
-- run results and raw third-party content have no column in this table.

CREATE TABLE public.agent_search_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  title text NOT NULL,
  breadcrumb text NOT NULL,
  snippet text,
  route text NOT NULL,
  safe_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  search_vector tsvector NOT NULL DEFAULT ''::tsvector,
  embedding public.vector(1536),
  embedding_status text NOT NULL DEFAULT 'none',
  embedding_provider text,
  embedding_model text,
  embedding_text_hash text,
  source_revision text NOT NULL,
  source_updated_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_search_documents_owner_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES public.apps(owner_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_search_documents_subject_key
    UNIQUE (user_id, agent_id, subject_type, subject_id),
  CONSTRAINT agent_search_documents_subject_type_check CHECK (
    subject_type IN (
      'agent',
      'directive',
      'interface',
      'routine',
      'function',
      'function_field',
      'attention',
      'run',
      'release',
      'setting',
      'authority'
    )
  ),
  CONSTRAINT agent_search_documents_subject_id_check CHECK (
    char_length(subject_id) BETWEEN 1 AND 240
    AND subject_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT agent_search_documents_title_check CHECK (
    char_length(title) BETWEEN 1 AND 240
    AND title !~ '[[:cntrl:]]'
  ),
  CONSTRAINT agent_search_documents_breadcrumb_check CHECK (
    char_length(breadcrumb) BETWEEN 1 AND 500
    AND breadcrumb !~ '[[:cntrl:]]'
  ),
  CONSTRAINT agent_search_documents_snippet_check CHECK (
    snippet IS NULL OR char_length(snippet) <= 4000
  ),
  CONSTRAINT agent_search_documents_route_check CHECK (
    char_length(route) BETWEEN 9 AND 1200
    AND route LIKE '/agents/%'
    AND route !~ '[[:cntrl:]]'
    AND route !~ '(^|/)\.\.?(/|$)'
  ),
  CONSTRAINT agent_search_documents_safe_tags_check CHECK (
    cardinality(safe_tags) <= 50
  ),
  CONSTRAINT agent_search_documents_embedding_status_check CHECK (
    embedding_status IN ('none', 'pending', 'ready', 'failed', 'disabled')
  ),
  CONSTRAINT agent_search_documents_embedding_shape_check CHECK (
    (
      embedding_status = 'ready'
      AND embedding IS NOT NULL
      AND embedding_provider IS NOT NULL
      AND embedding_model IS NOT NULL
      AND embedding_text_hash ~ '^[0-9a-f]{64}$'
    )
    OR
    (
      embedding_status <> 'ready'
      AND embedding IS NULL
    )
  ),
  CONSTRAINT agent_search_documents_embedding_provider_check CHECK (
    embedding_provider IS NULL OR (
      char_length(embedding_provider) BETWEEN 1 AND 80
      AND embedding_provider !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT agent_search_documents_embedding_model_check CHECK (
    embedding_model IS NULL OR (
      char_length(embedding_model) BETWEEN 1 AND 160
      AND embedding_model !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT agent_search_documents_source_revision_check CHECK (
    char_length(source_revision) BETWEEN 1 AND 160
    AND source_revision !~ '[[:cntrl:]]'
  )
);

CREATE INDEX agent_search_documents_owner_agent_idx
  ON public.agent_search_documents
    (user_id, agent_id, subject_type, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX agent_search_documents_lexical_idx
  ON public.agent_search_documents USING gin (search_vector)
  WHERE deleted_at IS NULL;

CREATE INDEX agent_search_documents_title_idx
  ON public.agent_search_documents
    (user_id, lower(title) text_pattern_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX agent_search_documents_embedding_idx
  ON public.agent_search_documents
  USING ivfflat (embedding public.vector_cosine_ops)
  WITH (lists = 100)
  WHERE embedding_status = 'ready' AND deleted_at IS NULL;

ALTER TABLE public.agent_search_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_search_documents
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.agent_search_documents TO service_role;

CREATE OR REPLACE FUNCTION public.prepare_agent_search_document()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.apps
    WHERE id = NEW.agent_id AND owner_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'agent_search_document_owner_mismatch';
  END IF;

  NEW.search_vector := setweight(
    to_tsvector('simple', coalesce(NEW.title, '')),
    'A'
  ) || setweight(
    to_tsvector('simple', coalesce(NEW.breadcrumb, '')),
    'B'
  ) || setweight(
    to_tsvector('simple', coalesce(NEW.snippet, '')),
    'C'
  ) || setweight(
    to_tsvector('simple', array_to_string(coalesce(
      NEW.safe_tags,
      ARRAY[]::text[]
    ), ' ')),
    'B'
  );
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER prepare_agent_search_document
BEFORE INSERT OR UPDATE ON public.agent_search_documents
FOR EACH ROW EXECUTE FUNCTION public.prepare_agent_search_document();

CREATE OR REPLACE FUNCTION public.upsert_agent_search_document(
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
  p_source_updated_at timestamptz DEFAULT NULL,
  p_request_embedding boolean DEFAULT false
) RETURNS public.agent_search_documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_document public.agent_search_documents%ROWTYPE;
BEGIN
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

CREATE OR REPLACE FUNCTION public.set_agent_search_document_embedding(
  p_user_id uuid,
  p_document_id uuid,
  p_source_revision text,
  p_embedding public.vector,
  p_provider text,
  p_model text,
  p_embedding_text_hash text
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH updated AS (
    UPDATE public.agent_search_documents
    SET
      embedding = p_embedding,
      embedding_status = 'ready',
      embedding_provider = p_provider,
      embedding_model = p_model,
      embedding_text_hash = p_embedding_text_hash
    WHERE id = p_document_id
      AND user_id = p_user_id
      AND source_revision = p_source_revision
      AND deleted_at IS NULL
      AND p_embedding IS NOT NULL
      AND nullif(btrim(p_provider), '') IS NOT NULL
      AND nullif(btrim(p_model), '') IS NOT NULL
      AND p_embedding_text_hash ~ '^[0-9a-f]{64}$'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$$;

CREATE OR REPLACE FUNCTION public.tombstone_agent_search_document(
  p_user_id uuid,
  p_agent_id uuid,
  p_subject_type text,
  p_subject_id text
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH tombstoned AS (
    UPDATE public.agent_search_documents
    SET
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
  SELECT EXISTS (SELECT 1 FROM tombstoned);
$$;

CREATE OR REPLACE FUNCTION public.search_agent_documents(
  p_user_id uuid,
  p_query text,
  p_limit integer DEFAULT 20,
  p_agent_id uuid DEFAULT NULL,
  p_subject_types text[] DEFAULT NULL
) RETURNS TABLE (
  document_id uuid,
  agent_id uuid,
  agent_slug text,
  subject_type text,
  subject_id text,
  title text,
  breadcrumb text,
  snippet text,
  route text,
  rank double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_query text := lower(coalesce(btrim(p_query), ''));
  v_tsquery tsquery;
BEGIN
  IF char_length(v_query) NOT BETWEEN 1 AND 300
     OR p_limit NOT BETWEEN 1 AND 100
     OR (
       p_subject_types IS NOT NULL
       AND NOT p_subject_types <@ ARRAY[
         'agent', 'directive', 'interface', 'routine', 'function',
         'function_field', 'attention', 'run', 'release', 'setting',
         'authority'
       ]::text[]
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_agent_search_query';
  END IF;

  v_tsquery := websearch_to_tsquery('simple', v_query);

  RETURN QUERY
  SELECT
    documents.id,
    documents.agent_id,
    apps.slug,
    documents.subject_type,
    documents.subject_id,
    documents.title,
    documents.breadcrumb,
    documents.snippet,
    documents.route,
    (
      CASE WHEN lower(documents.title) = v_query THEN 8.0 ELSE 0.0 END
      + CASE WHEN strpos(lower(documents.title), v_query) = 1
        THEN 4.0 ELSE 0.0 END
      + CASE WHEN strpos(lower(documents.title), v_query) > 0
        THEN 1.5 ELSE 0.0 END
      + ts_rank_cd(documents.search_vector, v_tsquery, 32)::double precision
    ) AS rank
  FROM public.agent_search_documents AS documents
  JOIN public.apps AS apps
    ON apps.id = documents.agent_id
   AND apps.owner_id = p_user_id
   AND apps.visibility = 'private'
   AND apps.deleted_at IS NULL
  WHERE documents.user_id = p_user_id
    AND documents.deleted_at IS NULL
    AND (p_agent_id IS NULL OR documents.agent_id = p_agent_id)
    AND (
      p_subject_types IS NULL
      OR documents.subject_type = ANY(p_subject_types)
    )
    AND (
      documents.search_vector @@ v_tsquery
      OR strpos(lower(documents.title), v_query) > 0
      OR strpos(lower(documents.breadcrumb), v_query) > 0
    )
  ORDER BY 10 DESC, lower(documents.title), documents.id
  LIMIT p_limit;
END;
$$;

-- Optional BYOK vector input augments lexical rank but never broadens owner
-- scope. Callers without an embedding use search_agent_documents above.
CREATE OR REPLACE FUNCTION public.search_agent_documents_hybrid(
  p_user_id uuid,
  p_query text,
  p_query_embedding public.vector,
  p_limit integer DEFAULT 20,
  p_agent_id uuid DEFAULT NULL,
  p_subject_types text[] DEFAULT NULL,
  p_min_similarity double precision DEFAULT 0.25
) RETURNS TABLE (
  document_id uuid,
  agent_id uuid,
  agent_slug text,
  subject_type text,
  subject_id text,
  title text,
  breadcrumb text,
  snippet text,
  route text,
  lexical_rank double precision,
  similarity double precision,
  combined_rank double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_query text := lower(coalesce(btrim(p_query), ''));
  v_tsquery tsquery;
BEGIN
  IF char_length(v_query) NOT BETWEEN 1 AND 300
     OR p_query_embedding IS NULL
     OR p_limit NOT BETWEEN 1 AND 100
     OR p_min_similarity NOT BETWEEN -1 AND 1
     OR (
       p_subject_types IS NOT NULL
       AND NOT p_subject_types <@ ARRAY[
         'agent', 'directive', 'interface', 'routine', 'function',
         'function_field', 'attention', 'run', 'release', 'setting',
         'authority'
       ]::text[]
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_agent_search_query';
  END IF;

  v_tsquery := websearch_to_tsquery('simple', v_query);

  RETURN QUERY
  WITH scored AS (
    SELECT
      documents.*,
      apps.slug AS agent_slug,
      (
        CASE WHEN lower(documents.title) = v_query THEN 8.0 ELSE 0.0 END
        + CASE WHEN strpos(lower(documents.title), v_query) = 1
          THEN 4.0 ELSE 0.0 END
        + CASE WHEN strpos(lower(documents.title), v_query) > 0
          THEN 1.5 ELSE 0.0 END
        + ts_rank_cd(
          documents.search_vector,
          v_tsquery,
          32
        )::double precision
      ) AS lexical_rank,
      CASE
        WHEN documents.embedding_status = 'ready'
          THEN 1 - (
            documents.embedding OPERATOR(public.<=>) p_query_embedding
          )
        ELSE NULL
      END AS similarity
    FROM public.agent_search_documents AS documents
    JOIN public.apps AS apps
      ON apps.id = documents.agent_id
     AND apps.owner_id = p_user_id
     AND apps.visibility = 'private'
     AND apps.deleted_at IS NULL
    WHERE documents.user_id = p_user_id
      AND documents.deleted_at IS NULL
      AND (p_agent_id IS NULL OR documents.agent_id = p_agent_id)
      AND (
        p_subject_types IS NULL
        OR documents.subject_type = ANY(p_subject_types)
      )
  )
  SELECT
    scored.id,
    scored.agent_id,
    scored.agent_slug,
    scored.subject_type,
    scored.subject_id,
    scored.title,
    scored.breadcrumb,
    scored.snippet,
    scored.route,
    scored.lexical_rank,
    scored.similarity,
    scored.lexical_rank + coalesce(scored.similarity, 0) * 3.0
      AS combined_rank
  FROM scored
  WHERE scored.lexical_rank > 0
     OR coalesce(scored.similarity, -1) >= p_min_similarity
  ORDER BY 12 DESC, lower(scored.title), scored.id
  LIMIT p_limit;
END;
$$;

-- Change capture for the asynchronous safe-document builder.
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
        coalesce(NEW.name, ''),
        coalesce(NEW.slug, ''),
        coalesce(NEW.description, ''),
        coalesce(NEW.current_version, ''),
        coalesce(NEW.updated_at::text, '')
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

  IF v_user_id IS NOT NULL AND v_agent_id IS NOT NULL THEN
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
    ON CONFLICT (job_kind, source_type, source_id, source_version)
    DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enqueue_agent_search_projection_on_app
AFTER INSERT OR UPDATE OF name, slug, description, current_version, updated_at
ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.enqueue_agent_search_projection();

CREATE TRIGGER enqueue_agent_search_projection_on_routine
AFTER INSERT OR UPDATE OF name, description, intent, status, updated_at
ON public.user_routines
FOR EACH ROW EXECUTE FUNCTION public.enqueue_agent_search_projection();

CREATE TRIGGER enqueue_agent_search_projection_on_brief
AFTER INSERT OR UPDATE OF status, headline, impact, recommended_action,
  updated_at
ON public.notification_briefs
FOR EACH ROW EXECUTE FUNCTION public.enqueue_agent_search_projection();

-- Seed immediately useful, safe lexical navigation. Richer subjects are
-- populated by the projection worker from canonical manifests/contracts.
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
  source_revision,
  source_updated_at
)
SELECT
  apps.owner_id,
  apps.id,
  'agent',
  apps.id::text,
  apps.name,
  apps.name,
  apps.description,
  '/agents/' || apps.slug || '?pane=overview',
  ARRAY['agent']::text[],
  coalesce(apps.agent_home_revision::text, '1'),
  apps.updated_at
FROM public.apps AS apps
WHERE apps.owner_id IS NOT NULL
  AND apps.visibility = 'private'
  AND apps.deleted_at IS NULL
ON CONFLICT (user_id, agent_id, subject_type, subject_id) DO NOTHING;

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
  source_revision,
  source_updated_at
)
SELECT
  routines.user_id,
  routines.composer_app_id,
  CASE
    WHEN routines.metadata->>'launch_primary' = 'true'
      THEN 'directive'
    ELSE 'routine'
  END,
  routines.id::text,
  routines.name,
  apps.name || ' / ' || CASE
    WHEN routines.metadata->>'launch_primary' = 'true'
      THEN 'Directive'
    ELSE 'Routines'
  END,
  coalesce(routines.intent, routines.description),
  '/agents/' || apps.slug || '?pane=' || CASE
    WHEN routines.metadata->>'launch_primary' = 'true'
      THEN 'overview'
    ELSE 'routines&item=' || routines.id::text
  END,
  ARRAY[
    CASE
      WHEN routines.metadata->>'launch_primary' = 'true'
        THEN 'directive'
      ELSE 'routine'
    END
  ]::text[],
  coalesce(routines.updated_at::text, routines.id::text),
  routines.updated_at
FROM public.user_routines AS routines
JOIN public.apps AS apps
  ON apps.id = routines.composer_app_id
 AND apps.owner_id = routines.user_id
WHERE routines.composer_app_id IS NOT NULL
  AND routines.deleted_at IS NULL
  AND apps.visibility = 'private'
  AND apps.deleted_at IS NULL
  AND (
    routines.metadata->>'launch_managed' = 'true'
    OR routines.metadata->>'launch_primary' = 'true'
  )
ON CONFLICT (user_id, agent_id, subject_type, subject_id) DO NOTHING;

-- Queue source projections for every current Agent and managed routine.
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
      coalesce(apps.updated_at::text, '')
    ),
    'sha256'
  ), 'hex')
FROM public.apps AS apps
WHERE apps.owner_id IS NOT NULL
  AND apps.visibility = 'private'
  AND apps.deleted_at IS NULL
ON CONFLICT (job_kind, source_type, source_id, source_version) DO NOTHING;

INSERT INTO public.operator_projection_jobs (
  user_id,
  agent_id,
  job_kind,
  source_type,
  source_id,
  source_version
)
SELECT
  routines.user_id,
  routines.composer_app_id,
  'search_document',
  'routine',
  routines.id,
  encode(extensions.digest(
    concat_ws(
      E'\x1f',
      routines.id::text,
      coalesce(routines.name, ''),
      coalesce(routines.description, ''),
      coalesce(routines.intent, ''),
      coalesce(routines.updated_at::text, '')
    ),
    'sha256'
  ), 'hex')
FROM public.user_routines AS routines
JOIN public.apps AS apps
  ON apps.id = routines.composer_app_id
 AND apps.owner_id = routines.user_id
WHERE routines.composer_app_id IS NOT NULL
  AND routines.deleted_at IS NULL
  AND apps.visibility = 'private'
  AND apps.deleted_at IS NULL
  AND (
    routines.metadata->>'launch_managed' = 'true'
    OR routines.metadata->>'launch_primary' = 'true'
  )
ON CONFLICT (job_kind, source_type, source_id, source_version) DO NOTHING;

REVOKE ALL ON FUNCTION public.prepare_agent_search_document()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_agent_search_document(
  uuid, uuid, text, text, text, text, text, text, text[], text,
  timestamptz, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_agent_search_document_embedding(
  uuid, uuid, text, public.vector, text, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tombstone_agent_search_document(
  uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_agent_documents(
  uuid, text, integer, uuid, text[]
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_agent_documents_hybrid(
  uuid, text, public.vector, integer, uuid, text[], double precision
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_agent_search_projection()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.upsert_agent_search_document(
  uuid, uuid, text, text, text, text, text, text, text[], text,
  timestamptz, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_agent_search_document_embedding(
  uuid, uuid, text, public.vector, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.tombstone_agent_search_document(
  uuid, uuid, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_agent_documents(
  uuid, text, integer, uuid, text[]
) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_agent_documents_hybrid(
  uuid, text, public.vector, integer, uuid, text[], double precision
) TO service_role;
