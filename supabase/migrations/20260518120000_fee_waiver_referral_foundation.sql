-- Fee waiver referral foundation.
--
-- This migration is intentionally behavior-free. It creates the durable data
-- model used by later PRs to claim referral landings, spend developer fee
-- waiver credit, and record waived platform fees.

CREATE TABLE IF NOT EXISTS public.publisher_referral_links (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  publisher_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  slug text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  disabled_at timestamp with time zone,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT publisher_referral_links_status_check
    CHECK (status IN ('active', 'disabled')),
  CONSTRAINT publisher_referral_links_slug_check
    CHECK (slug ~ '^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$'),
  CONSTRAINT publisher_referral_links_disabled_at_check
    CHECK ((status = 'active' AND disabled_at IS NULL) OR status = 'disabled')
);

CREATE UNIQUE INDEX IF NOT EXISTS publisher_referral_links_slug_key
  ON public.publisher_referral_links(slug);

CREATE UNIQUE INDEX IF NOT EXISTS publisher_referral_links_one_active_per_app_idx
  ON public.publisher_referral_links(app_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS publisher_referral_links_publisher_created_idx
  ON public.publisher_referral_links(publisher_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.publisher_referral_landings (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  referral_link_id uuid NOT NULL REFERENCES public.publisher_referral_links(id),
  publisher_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  app_id uuid REFERENCES public.apps(id) ON DELETE SET NULL,
  anonymous_visitor_id uuid,
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  landed_at timestamp with time zone NOT NULL DEFAULT now(),
  claimed_at timestamp with time zone,
  ip_hash text,
  user_agent_hash text,
  landing_url text,
  referrer_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT publisher_referral_landings_identity_check
    CHECK (anonymous_visitor_id IS NOT NULL OR user_id IS NOT NULL),
  CONSTRAINT publisher_referral_landings_self_referral_check
    CHECK (user_id IS NULL OR user_id <> publisher_user_id),
  CONSTRAINT publisher_referral_landings_claimed_at_check
    CHECK (claimed_at IS NULL OR claimed_at >= landed_at)
);

CREATE INDEX IF NOT EXISTS publisher_referral_landings_link_landed_idx
  ON public.publisher_referral_landings(referral_link_id, landed_at DESC);

CREATE INDEX IF NOT EXISTS publisher_referral_landings_publisher_landed_idx
  ON public.publisher_referral_landings(publisher_user_id, landed_at DESC);

CREATE INDEX IF NOT EXISTS publisher_referral_landings_visitor_unclaimed_idx
  ON public.publisher_referral_landings(anonymous_visitor_id, landed_at ASC)
  WHERE anonymous_visitor_id IS NOT NULL AND user_id IS NULL;

CREATE INDEX IF NOT EXISTS publisher_referral_landings_user_landed_idx
  ON public.publisher_referral_landings(user_id, landed_at DESC)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.publisher_fee_waiver_grants (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  publisher_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'referral',
  source_landing_id uuid REFERENCES public.publisher_referral_landings(id),
  starts_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT publisher_fee_waiver_grants_source_check
    CHECK (source IN ('referral')),
  CONSTRAINT publisher_fee_waiver_grants_referral_source_check
    CHECK (source <> 'referral' OR source_landing_id IS NOT NULL),
  CONSTRAINT publisher_fee_waiver_grants_self_check
    CHECK (user_id <> publisher_user_id),
  CONSTRAINT publisher_fee_waiver_grants_window_check
    CHECK (expires_at > starts_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS publisher_fee_waiver_grants_referral_once_idx
  ON public.publisher_fee_waiver_grants(user_id, publisher_user_id)
  WHERE source = 'referral';

CREATE UNIQUE INDEX IF NOT EXISTS publisher_fee_waiver_grants_source_landing_key
  ON public.publisher_fee_waiver_grants(source_landing_id)
  WHERE source_landing_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS publisher_fee_waiver_grants_active_lookup_idx
  ON public.publisher_fee_waiver_grants(user_id, publisher_user_id, expires_at)
  WHERE source = 'referral';

CREATE INDEX IF NOT EXISTS publisher_fee_waiver_grants_publisher_created_idx
  ON public.publisher_fee_waiver_grants(publisher_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.publisher_fee_credit_accounts (
  publisher_user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  balance_light double precision NOT NULL DEFAULT 0,
  lifetime_granted_light double precision NOT NULL DEFAULT 0,
  lifetime_spent_light double precision NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT publisher_fee_credit_accounts_nonnegative_check
    CHECK (
      balance_light >= 0
      AND lifetime_granted_light >= 0
      AND lifetime_spent_light >= 0
    )
);

CREATE TABLE IF NOT EXISTS public.publisher_fee_credit_ledger (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  publisher_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  amount_light double precision NOT NULL,
  balance_after_light double precision NOT NULL,
  kind text NOT NULL,
  reason text NOT NULL,
  reference_table text,
  reference_id uuid,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT publisher_fee_credit_ledger_kind_check
    CHECK (kind IN ('grant', 'spend', 'adjustment')),
  CONSTRAINT publisher_fee_credit_ledger_amount_nonzero_check
    CHECK (amount_light <> 0),
  CONSTRAINT publisher_fee_credit_ledger_balance_after_check
    CHECK (balance_after_light >= 0),
  CONSTRAINT publisher_fee_credit_ledger_direction_check
    CHECK (
      (kind = 'grant' AND amount_light > 0)
      OR (kind = 'spend' AND amount_light < 0)
      OR (kind = 'adjustment' AND amount_light <> 0)
    )
);

CREATE INDEX IF NOT EXISTS publisher_fee_credit_ledger_publisher_created_idx
  ON public.publisher_fee_credit_ledger(publisher_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS publisher_fee_credit_ledger_reference_idx
  ON public.publisher_fee_credit_ledger(reference_table, reference_id)
  WHERE reference_table IS NOT NULL AND reference_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.platform_fee_waiver_events (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  payer_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  publisher_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  app_id uuid REFERENCES public.apps(id) ON DELETE SET NULL,
  transaction_kind text NOT NULL,
  transaction_reference_table text NOT NULL,
  transaction_reference_id uuid,
  gross_light double precision NOT NULL,
  fee_rate double precision NOT NULL,
  fee_would_have_been_light double precision NOT NULL,
  fee_waived_light double precision NOT NULL,
  platform_fee_charged_light double precision NOT NULL,
  waiver_source text NOT NULL,
  waiver_grant_id uuid REFERENCES public.publisher_fee_waiver_grants(id),
  fee_credit_ledger_id uuid REFERENCES public.publisher_fee_credit_ledger(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT platform_fee_waiver_events_transaction_kind_check
    CHECK (transaction_kind IN ('tool_call', 'gpu_developer_fee', 'marketplace_sale')),
  CONSTRAINT platform_fee_waiver_events_reference_table_check
    CHECK (transaction_reference_table IN ('transfers', 'app_sales')),
  CONSTRAINT platform_fee_waiver_events_waiver_source_check
    CHECK (waiver_source IN ('referral_grant', 'publisher_fee_credit')),
  CONSTRAINT platform_fee_waiver_events_self_check
    CHECK (payer_user_id <> publisher_user_id),
  CONSTRAINT platform_fee_waiver_events_nonnegative_check
    CHECK (
      gross_light > 0
      AND fee_rate >= 0
      AND fee_rate < 1
      AND fee_would_have_been_light >= 0
      AND fee_waived_light > 0
      AND platform_fee_charged_light >= 0
    ),
  CONSTRAINT platform_fee_waiver_events_fee_math_check
    CHECK (abs(fee_would_have_been_light - fee_waived_light - platform_fee_charged_light) < 0.000001),
  CONSTRAINT platform_fee_waiver_events_source_reference_check
    CHECK (
      (
        waiver_source = 'referral_grant'
        AND waiver_grant_id IS NOT NULL
        AND fee_credit_ledger_id IS NULL
      )
      OR (
        waiver_source = 'publisher_fee_credit'
        AND waiver_grant_id IS NULL
        AND fee_credit_ledger_id IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_fee_waiver_events_transaction_key
  ON public.platform_fee_waiver_events(transaction_reference_table, transaction_reference_id)
  WHERE transaction_reference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_fee_waiver_events_leaderboard_idx
  ON public.platform_fee_waiver_events(created_at DESC, publisher_user_id);

CREATE INDEX IF NOT EXISTS platform_fee_waiver_events_publisher_created_idx
  ON public.platform_fee_waiver_events(publisher_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS platform_fee_waiver_events_payer_publisher_idx
  ON public.platform_fee_waiver_events(payer_user_id, publisher_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.touch_fee_waiver_foundation_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS touch_publisher_referral_links_updated_at
  ON public.publisher_referral_links;
CREATE TRIGGER touch_publisher_referral_links_updated_at
BEFORE UPDATE ON public.publisher_referral_links
FOR EACH ROW EXECUTE FUNCTION public.touch_fee_waiver_foundation_updated_at();

DROP TRIGGER IF EXISTS touch_publisher_fee_credit_accounts_updated_at
  ON public.publisher_fee_credit_accounts;
CREATE TRIGGER touch_publisher_fee_credit_accounts_updated_at
BEFORE UPDATE ON public.publisher_fee_credit_accounts
FOR EACH ROW EXECUTE FUNCTION public.touch_fee_waiver_foundation_updated_at();

ALTER TABLE public.publisher_referral_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publisher_referral_landings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publisher_fee_waiver_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publisher_fee_credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publisher_fee_credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_fee_waiver_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.publisher_referral_links FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.publisher_referral_landings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.publisher_fee_waiver_grants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.publisher_fee_credit_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.publisher_fee_credit_ledger FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.platform_fee_waiver_events FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.publisher_referral_links TO service_role;
GRANT ALL ON TABLE public.publisher_referral_landings TO service_role;
GRANT ALL ON TABLE public.publisher_fee_waiver_grants TO service_role;
GRANT ALL ON TABLE public.publisher_fee_credit_accounts TO service_role;
GRANT ALL ON TABLE public.publisher_fee_credit_ledger TO service_role;
GRANT ALL ON TABLE public.platform_fee_waiver_events TO service_role;

REVOKE ALL ON FUNCTION public.touch_fee_waiver_foundation_updated_at()
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.touch_fee_waiver_foundation_updated_at()
  TO service_role;

COMMENT ON TABLE public.publisher_referral_links IS
  'Per-listing referral URLs controlled by the publisher. Links create landing records; grants are publisher-scoped.';
COMMENT ON TABLE public.publisher_referral_landings IS
  'Referral URL landings, including anonymous landings that can be claimed after sign-in.';
COMMENT ON TABLE public.publisher_fee_waiver_grants IS
  'Immutable user-to-publisher referral grants. The first referral grant per user/publisher wins and later clicks do not extend it.';
COMMENT ON TABLE public.publisher_fee_credit_accounts IS
  'Publisher scrip balance used only to cover Ultralight internal platform fees on creator revenue.';
COMMENT ON TABLE public.publisher_fee_credit_ledger IS
  'Signed ledger for publisher fee-waiver credit grants, spends, and adjustments.';
COMMENT ON TABLE public.platform_fee_waiver_events IS
  'Immutable audit/event ledger of platform fees that would have been charged but were waived.';

COMMENT ON COLUMN public.platform_fee_waiver_events.fee_would_have_been_light IS
  'The platform fee that would have applied before referral or fee-credit waiver logic.';
COMMENT ON COLUMN public.platform_fee_waiver_events.fee_waived_light IS
  'The portion of the would-have-been platform fee waived for this transaction.';
COMMENT ON COLUMN public.platform_fee_waiver_events.platform_fee_charged_light IS
  'The remaining platform fee actually charged after waiver logic.';
