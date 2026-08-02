-- WO-6 PR A (docs/AGENT_STUDIO_LAUNCH_WORK_ORDERS.md): concept graph v1.
-- Concepts are per-agent domain entities created by writing (declared via
-- manifest `concept:` keys, mentioned via [[slug]] prose, or authored).
-- Mentions are DERIVED — a pure function of each surface's current text,
-- recomputed on write (delete + insert per surface). Embeddings live inline
-- on the concept row with provider/model/hash recorded (precedent:
-- agent_search_documents). Service-role only; the API's owner filter is
-- the authorization.

CREATE TABLE public.agent_concepts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$'),
  title text CHECK (title IS NULL OR char_length(title) <= 120),
  description text
    CHECK (description IS NULL OR char_length(description) <= 4000),
  status text NOT NULL DEFAULT 'provisional'
    CHECK (status IN ('provisional', 'active', 'retired')),
  created_by text NOT NULL DEFAULT 'mention'
    CHECK (created_by IN ('owner', 'agent', 'schema', 'mention')),
  aliases text[] NOT NULL DEFAULT ARRAY[]::text[],
  embedding public.vector(1536),
  embedding_status text NOT NULL DEFAULT 'none'
    CHECK (embedding_status IN ('none', 'pending', 'ready')),
  embedding_provider text,
  embedding_model text,
  embedding_text_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, slug)
);

CREATE INDEX agent_concepts_app_status_idx
  ON public.agent_concepts (app_id, status, updated_at DESC);

CREATE TABLE public.agent_concept_mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  concept_id uuid NOT NULL
    REFERENCES public.agent_concepts(id) ON DELETE CASCADE,
  surface_type text NOT NULL CHECK (surface_type IN (
    'fact', 'question', 'mission', 'memory', 'activity_summary',
    'function_description', 'schema_field', 'concept_page', 'd1'
  )),
  surface_id text NOT NULL
    CHECK (char_length(surface_id) BETWEEN 1 AND 240),
  block_id text NOT NULL CHECK (char_length(block_id) BETWEEN 1 AND 240),
  block_text text NOT NULL CHECK (char_length(block_text) <= 2000),
  -- Identity edges (manifest `concept:` declarations) vs prose mentions.
  identity boolean NOT NULL DEFAULT false,
  -- Schema-origin provenance: which release asserted this, which arg path.
  release_id uuid,
  field_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, concept_id, surface_type, surface_id, block_id)
);

CREATE INDEX agent_concept_mentions_surface_idx
  ON public.agent_concept_mentions (app_id, surface_type, surface_id);
CREATE INDEX agent_concept_mentions_concept_idx
  ON public.agent_concept_mentions (app_id, concept_id, created_at DESC);

ALTER TABLE public.agent_concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_concept_mentions ENABLE ROW LEVEL SECURITY;

-- Semantic candidates for suggest(): similarity within ONE model space only
-- (the caller resolves the query embedding with the same BYOK route that
-- embedded the concepts; rows embedded under another model never compare).
CREATE OR REPLACE FUNCTION public.suggest_agent_concepts(
  p_app_id uuid,
  p_user_id uuid,
  p_query_embedding public.vector,
  p_model text,
  p_limit integer DEFAULT 8
) RETURNS TABLE (slug text, title text, similarity double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.slug,
    c.title,
    1 - (c.embedding OPERATOR(public.<=>) p_query_embedding) AS similarity
  FROM public.agent_concepts c
  WHERE c.app_id = p_app_id
    AND c.user_id = p_user_id
    AND c.status <> 'retired'
    AND c.embedding IS NOT NULL
    AND c.embedding_status = 'ready'
    AND c.embedding_model = p_model
  ORDER BY c.embedding OPERATOR(public.<=>) p_query_embedding
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 8), 1), 25);
$$;

REVOKE ALL ON FUNCTION public.suggest_agent_concepts(
  uuid, uuid, public.vector, text, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.suggest_agent_concepts(
  uuid, uuid, public.vector, text, integer
) TO service_role;
