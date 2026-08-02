-- WO-5 (docs/AGENT_STUDIO_LAUNCH_WORK_ORDERS.md): Knowledge-lite platform
-- store. Facts are owner-taught (or agent-learned) reference statements an
-- agent may state; questions are gaps the agent (or owner) surfaced. Both
-- are probabilistic guidance, deliberately NOT the future adapter contract:
-- no citations, no contradiction machinery — those are pillar territory.
-- Service-role only; the API's explicit owner filter is the authorization.

CREATE TABLE public.agent_knowledge_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$'),
  title text CHECK (title IS NULL OR char_length(title) <= 120),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  source text NOT NULL DEFAULT 'owner' CHECK (source IN ('owner', 'agent')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, slug)
);

CREATE INDEX agent_knowledge_facts_app_status_idx
  ON public.agent_knowledge_facts (app_id, status, updated_at DESC);

CREATE TABLE public.agent_knowledge_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 500),
  context text CHECK (context IS NULL OR char_length(context) <= 1000),
  -- sha256 of the normalized question; the idempotency key for agent asks.
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'answered', 'dismissed')),
  ask_count integer NOT NULL DEFAULT 1 CHECK (ask_count >= 1),
  blocking boolean NOT NULL DEFAULT false,
  first_asked_at timestamptz NOT NULL DEFAULT now(),
  last_asked_at timestamptz NOT NULL DEFAULT now(),
  answered_fact_id uuid REFERENCES public.agent_knowledge_facts(id),
  UNIQUE (app_id, content_hash)
);

CREATE INDEX agent_knowledge_questions_app_status_idx
  ON public.agent_knowledge_questions (app_id, status, last_asked_at DESC);

ALTER TABLE public.agent_knowledge_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_knowledge_questions ENABLE ROW LEVEL SECURITY;
