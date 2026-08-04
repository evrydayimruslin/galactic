-- WO-F1 PR A: anonymous claimable funnel sessions.
--
-- A stranger can mint a coding-agent handoff with no account: the mint
-- creates a flagged *provisional* users row (owner_id stays NOT NULL
-- everywhere), and a funnel_sessions row binds a stable, unlisted pairing
-- code to the CURRENT builder handoff session (re-mints swap the session,
-- the pairing code survives). Claim re-parents everything the provisional
-- owner accumulated — handoff sessions/events, credential tokens, reserved
-- Agents — onto a real account in one transaction. Unclaimed sessions are
-- reaped after the 7-day return window.
--
-- The 60-minute handoff TTL, the membership deployment boundary, and every
-- authenticated handoff behavior are deliberately untouched.

-- 1) Provisional discriminator on users. 'member' is every pre-existing row.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS account_kind text NOT NULL DEFAULT 'member'
    CHECK (account_kind IN ('member', 'provisional'));

CREATE INDEX IF NOT EXISTS users_provisional_created_idx
  ON public.users (created_at)
  WHERE account_kind = 'provisional';

-- 2) Funnel sessions: pairing code -> current handoff session.
CREATE TABLE public.funnel_sessions (
  pairing_code text PRIMARY KEY
    CHECK (pairing_code ~ '^[a-z0-9]{16,64}$'),
  provisional_owner_id uuid NOT NULL
    REFERENCES public.users(id) ON DELETE CASCADE,
  handoff_session_id uuid NOT NULL UNIQUE
    REFERENCES public.builder_handoff_sessions(id) ON DELETE CASCADE,
  surface text NOT NULL DEFAULT 'cli'
    CHECK (surface IN ('cli', 'web')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The human return window (pairing link, unclaimed agent). Distinct from
  -- the 60-minute build credential and pinned like the handoff TTL CHECK.
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  claimed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT funnel_sessions_return_window_check
    CHECK (expires_at = created_at + interval '7 days'),
  CONSTRAINT funnel_sessions_claim_pair_check
    CHECK ((claimed_at IS NULL) = (claimed_by IS NULL))
);

ALTER TABLE public.funnel_sessions ENABLE ROW LEVEL SECURITY;
-- Service-role only: reads go through the sanitized pairing route, never
-- PostgREST. No policies are created on purpose.

CREATE INDEX funnel_sessions_owner_idx
  ON public.funnel_sessions (provisional_owner_id);
CREATE INDEX funnel_sessions_reap_idx
  ON public.funnel_sessions (expires_at)
  WHERE claimed_at IS NULL;

-- 3) Claim: re-parent the provisional owner's world onto a real account.
CREATE OR REPLACE FUNCTION public.claim_funnel_session(
  p_pairing_code text,
  p_claimed_by uuid,
  p_now timestamptz
) RETURNS public.funnel_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_funnel public.funnel_sessions%ROWTYPE;
  v_claimer public.users%ROWTYPE;
BEGIN
  IF p_pairing_code IS NULL OR p_claimed_by IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'claim_funnel_session: null argument'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_claimer FROM public.users WHERE id = p_claimed_by;
  IF NOT FOUND OR v_claimer.account_kind <> 'member' THEN
    RAISE EXCEPTION 'claim_funnel_session: claimer must be a member account'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_funnel
    FROM public.funnel_sessions
    WHERE pairing_code = p_pairing_code
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'claim_funnel_session: unknown pairing code'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_funnel.claimed_at IS NOT NULL THEN
    -- Idempotent for the same claimer; a conflict for anyone else.
    IF v_funnel.claimed_by = p_claimed_by THEN
      RETURN v_funnel;
    END IF;
    RAISE EXCEPTION 'claim_funnel_session: already claimed'
      USING ERRCODE = 'P0003';
  END IF;
  IF v_funnel.expires_at <= p_now THEN
    RAISE EXCEPTION 'claim_funnel_session: return window elapsed'
      USING ERRCODE = 'P0004';
  END IF;

  -- Re-parent every child the provisional owner accumulated. Additive lanes
  -- that arrive later (trial envelopes and their receipts already reference
  -- these same owner columns) ride the same statements or extend them here.
  UPDATE public.user_api_tokens
    SET user_id = p_claimed_by
    WHERE user_id = v_funnel.provisional_owner_id;
  UPDATE public.builder_handoff_sessions
    SET owner_id = p_claimed_by
    WHERE owner_id = v_funnel.provisional_owner_id;
  UPDATE public.builder_handoff_session_events
    SET owner_id = p_claimed_by
    WHERE owner_id = v_funnel.provisional_owner_id;
  UPDATE public.apps
    SET owner_id = p_claimed_by
    WHERE owner_id = v_funnel.provisional_owner_id;

  UPDATE public.funnel_sessions
    SET claimed_at = p_now,
        claimed_by = p_claimed_by,
        updated_at = p_now
    WHERE pairing_code = v_funnel.pairing_code
    RETURNING * INTO v_funnel;

  -- The provisional shell is spent; nothing references it after the
  -- re-parent except this funnel row's provenance column.
  UPDATE public.users
    SET updated_at = p_now
    WHERE id = v_funnel.provisional_owner_id;

  RETURN v_funnel;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_funnel_session(text, uuid, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_funnel_session(text, uuid, timestamptz)
  TO service_role;

-- 4) Reaper: delete unclaimed, expired funnel worlds. Deleting the
-- provisional users row cascades through funnel_sessions and
-- builder_handoff_sessions (both ON DELETE CASCADE on their owner columns);
-- reserved Agents are deleted explicitly because apps.owner_id does not
-- cascade. Claimed rows are never touched: their provisional owner no
-- longer parents anything.
CREATE OR REPLACE FUNCTION public.reap_expired_funnel_sessions(
  p_now timestamptz,
  p_limit integer DEFAULT 100
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_ids uuid[];
  v_count integer;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'reap_expired_funnel_sessions: null argument'
      USING ERRCODE = '22004';
  END IF;

  SELECT array_agg(owner_id) INTO v_owner_ids FROM (
    SELECT DISTINCT fs.provisional_owner_id AS owner_id
      FROM public.funnel_sessions fs
      JOIN public.users u ON u.id = fs.provisional_owner_id
      WHERE fs.claimed_at IS NULL
        AND fs.expires_at <= p_now
        AND u.account_kind = 'provisional'
      LIMIT GREATEST(p_limit, 0)
  ) reapable;

  IF v_owner_ids IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM public.apps
    WHERE owner_id = ANY (v_owner_ids);
  DELETE FROM public.users
    WHERE id = ANY (v_owner_ids)
      AND account_kind = 'provisional';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.reap_expired_funnel_sessions(timestamptz, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reap_expired_funnel_sessions(timestamptz, integer)
  TO service_role;
