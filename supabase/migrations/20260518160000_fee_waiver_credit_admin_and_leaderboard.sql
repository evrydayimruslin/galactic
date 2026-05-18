-- Admin/reward tooling for publisher fee-waiver credit and waived-fee
-- leaderboard queries.

CREATE OR REPLACE FUNCTION public.grant_publisher_fee_credit(
  p_publisher_user_id uuid,
  p_amount_light double precision,
  p_reason text DEFAULT 'admin_reward'::text,
  p_created_by_user_id uuid DEFAULT NULL::uuid,
  p_reference_table text DEFAULT NULL::text,
  p_reference_id uuid DEFAULT NULL::uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE(
  publisher_user_id uuid,
  balance_light double precision,
  lifetime_granted_light double precision,
  lifetime_spent_light double precision,
  ledger_id uuid,
  amount_light double precision,
  reason text,
  created_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
DECLARE
  v_account public.publisher_fee_credit_accounts%ROWTYPE;
  v_ledger public.publisher_fee_credit_ledger%ROWTYPE;
  v_reason text;
BEGIN
  IF p_publisher_user_id IS NULL THEN
    RAISE EXCEPTION 'Publisher user id is required';
  END IF;

  IF p_amount_light IS NULL OR p_amount_light <= 0 THEN
    RAISE EXCEPTION 'Fee-waiver credit amount must be positive';
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Fee-waiver credit reason is required';
  END IF;

  PERFORM 1
  FROM public.users
  WHERE id = p_publisher_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publisher not found';
  END IF;

  INSERT INTO public.publisher_fee_credit_accounts (
    publisher_user_id,
    balance_light,
    lifetime_granted_light,
    lifetime_spent_light
  )
  VALUES (
    p_publisher_user_id,
    p_amount_light,
    p_amount_light,
    0
  )
  ON CONFLICT (publisher_user_id) DO UPDATE
  SET balance_light = public.publisher_fee_credit_accounts.balance_light + EXCLUDED.balance_light,
      lifetime_granted_light = public.publisher_fee_credit_accounts.lifetime_granted_light + EXCLUDED.lifetime_granted_light,
      updated_at = now()
  RETURNING * INTO v_account;

  INSERT INTO public.publisher_fee_credit_ledger (
    publisher_user_id,
    amount_light,
    balance_after_light,
    kind,
    reason,
    reference_table,
    reference_id,
    created_by_user_id,
    metadata
  )
  VALUES (
    p_publisher_user_id,
    p_amount_light,
    v_account.balance_light,
    'grant',
    v_reason,
    NULLIF(btrim(COALESCE(p_reference_table, '')), ''),
    p_reference_id,
    p_created_by_user_id,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING * INTO v_ledger;

  RETURN QUERY SELECT
    v_account.publisher_user_id,
    v_account.balance_light,
    v_account.lifetime_granted_light,
    v_account.lifetime_spent_light,
    v_ledger.id,
    v_ledger.amount_light,
    v_ledger.reason,
    v_ledger.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_fee_waiver_leaderboard(
  p_since timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_limit integer DEFAULT 50
) RETURNS TABLE(
  rank bigint,
  publisher_user_id uuid,
  display_name text,
  avatar_url text,
  profile_slug text,
  fee_waived_light double precision,
  event_count bigint,
  referral_waived_light double precision,
  fee_credit_waived_light double precision,
  marketplace_waived_light double precision,
  tool_call_waived_light double precision,
  gpu_developer_fee_waived_light double precision,
  first_waived_at timestamp with time zone,
  last_waived_at timestamp with time zone
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public, extensions'
AS $$
  WITH publisher_totals AS (
    SELECT
      e.publisher_user_id,
      SUM(e.fee_waived_light)::double precision AS fee_waived_light,
      COUNT(*)::bigint AS event_count,
      SUM(CASE WHEN e.waiver_source = 'referral_grant' THEN e.fee_waived_light ELSE 0 END)::double precision
        AS referral_waived_light,
      SUM(CASE WHEN e.waiver_source = 'publisher_fee_credit' THEN e.fee_waived_light ELSE 0 END)::double precision
        AS fee_credit_waived_light,
      SUM(CASE WHEN e.transaction_kind = 'marketplace_sale' THEN e.fee_waived_light ELSE 0 END)::double precision
        AS marketplace_waived_light,
      SUM(CASE WHEN e.transaction_kind = 'tool_call' THEN e.fee_waived_light ELSE 0 END)::double precision
        AS tool_call_waived_light,
      SUM(CASE WHEN e.transaction_kind = 'gpu_developer_fee' THEN e.fee_waived_light ELSE 0 END)::double precision
        AS gpu_developer_fee_waived_light,
      MIN(e.created_at) AS first_waived_at,
      MAX(e.created_at) AS last_waived_at
    FROM public.platform_fee_waiver_events e
    WHERE e.fee_waived_light > 0
      AND (p_since IS NULL OR e.created_at >= p_since)
    GROUP BY e.publisher_user_id
  )
  SELECT
    row_number() OVER (
      ORDER BY pt.fee_waived_light DESC, pt.publisher_user_id ASC
    )::bigint AS rank,
    pt.publisher_user_id,
    u.display_name,
    u.avatar_url,
    u.profile_slug,
    pt.fee_waived_light,
    pt.event_count,
    pt.referral_waived_light,
    pt.fee_credit_waived_light,
    pt.marketplace_waived_light,
    pt.tool_call_waived_light,
    pt.gpu_developer_fee_waived_light,
    pt.first_waived_at,
    pt.last_waived_at
  FROM publisher_totals pt
  LEFT JOIN public.users u
    ON u.id = pt.publisher_user_id
  ORDER BY pt.fee_waived_light DESC, pt.publisher_user_id ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 100));
$$;

REVOKE ALL ON FUNCTION public.grant_publisher_fee_credit(
  uuid,
  double precision,
  text,
  uuid,
  text,
  uuid,
  jsonb
) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.grant_publisher_fee_credit(
  uuid,
  double precision,
  text,
  uuid,
  text,
  uuid,
  jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.get_fee_waiver_leaderboard(timestamp with time zone, integer)
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.get_fee_waiver_leaderboard(timestamp with time zone, integer)
  TO service_role;

COMMENT ON FUNCTION public.grant_publisher_fee_credit(
  uuid,
  double precision,
  text,
  uuid,
  text,
  uuid,
  jsonb
) IS
  'Atomically grants publisher fee-waiver credit and records the grant ledger row.';
COMMENT ON FUNCTION public.get_fee_waiver_leaderboard(timestamp with time zone, integer) IS
  'Ranks publishers only by platform fees actually waived in platform_fee_waiver_events.';
