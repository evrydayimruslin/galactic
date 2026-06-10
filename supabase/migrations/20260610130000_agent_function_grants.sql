-- Cross-Agent function grants (Phase 4a / P5).
--
-- Authoritative store for "may caller Agent A (optionally only while function
-- G runs) call function F on target Agent B, on behalf of user U." Generalizes
-- the run-scoped routine_capabilities into a persistent, user-managed grant.
--
-- Safety invariant (enforced at creation in api/services/agent-grants.ts):
-- a grant DELEGATES a subset of the user's OWN access to one of their caller
-- Agents; it never EXPANDS it. The user may wire caller A -> target F only if
-- the user could call F themselves (owns target, target public, or holds a
-- user_app_permission).
--
-- mode/selector are reserved so pub/sub (mode='subscribe', selector=topic)
-- slots in later (Phase 4.5) with no schema churn.

CREATE TABLE IF NOT EXISTS public.agent_function_grants (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  -- The Agent that makes the call.
  caller_app_id uuid NOT NULL,
  -- Narrow the grant to a single function of the caller; NULL = any function.
  caller_function text,
  -- Logical port name from the caller manifest's imports; NULL = raw grant.
  slot text,
  -- The Agent whose function is being called.
  target_app_id uuid NOT NULL,
  target_function text NOT NULL,
  -- 'call' = request/response (Phase 4a). 'subscribe' reserved for pub/sub.
  mode text DEFAULT 'call' NOT NULL,
  -- 'active' = honored at runtime. 'pending' = auto-created from a denied call,
  -- awaiting user approval (the inbox). 'revoked' = soft-deleted, kept for audit.
  status text DEFAULT 'active' NOT NULL,
  -- Credit-denominated monthly cap; NULL = uncapped. Spend resets when
  -- period_start rolls over a calendar month (lazy, in the service).
  monthly_cap_credits numeric,
  spent_credits_period numeric DEFAULT 0 NOT NULL,
  period_start timestamptz DEFAULT now() NOT NULL,
  -- Per-grant runtime constraints (arg allowlists, etc.), mirrors
  -- user_app_permissions.constraints shape.
  constraints jsonb DEFAULT '{}'::jsonb NOT NULL,
  -- How the row originated: 'user' (explicit), 'agent' (ul.grants tool),
  -- 'developer_hint' (manifest import prepopulated), 'auto_request' (denied call).
  created_by text DEFAULT 'user' NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT agent_function_grants_pkey PRIMARY KEY (id),
  CONSTRAINT agent_function_grants_mode_check
    CHECK (mode = ANY (ARRAY['call'::text, 'subscribe'::text])),
  CONSTRAINT agent_function_grants_status_check
    CHECK (status = ANY (ARRAY['active'::text, 'pending'::text, 'revoked'::text])),
  CONSTRAINT agent_function_grants_created_by_check
    CHECK (created_by = ANY (ARRAY['user'::text, 'agent'::text, 'developer_hint'::text, 'auto_request'::text])),
  CONSTRAINT agent_function_grants_caller_app_id_fkey
    FOREIGN KEY (caller_app_id) REFERENCES public.apps(id) ON DELETE CASCADE,
  CONSTRAINT agent_function_grants_target_app_id_fkey
    FOREIGN KEY (target_app_id) REFERENCES public.apps(id) ON DELETE CASCADE,
  CONSTRAINT agent_function_grants_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

ALTER TABLE public.agent_function_grants OWNER TO postgres;

-- One row per (user, caller, caller_function, slot, target, target_function, mode).
-- COALESCE the nullable narrowing columns so NULL and '' collapse to one key.
CREATE UNIQUE INDEX IF NOT EXISTS agent_function_grants_unique
  ON public.agent_function_grants (
    user_id,
    caller_app_id,
    COALESCE(caller_function, ''),
    COALESCE(slot, ''),
    target_app_id,
    target_function,
    mode
  );

-- Runtime enforcement lookup: resolve a (user, caller, target, fn) call.
CREATE INDEX IF NOT EXISTS agent_function_grants_resolve_idx
  ON public.agent_function_grants (
    user_id, caller_app_id, target_app_id, target_function, status
  );

-- Inbox / outbound-wiring views.
CREATE INDEX IF NOT EXISTS agent_function_grants_caller_idx
  ON public.agent_function_grants (user_id, caller_app_id, status);
CREATE INDEX IF NOT EXISTS agent_function_grants_target_idx
  ON public.agent_function_grants (user_id, target_app_id, status);

ALTER TABLE public.agent_function_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_function_grants FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.agent_function_grants TO service_role;
