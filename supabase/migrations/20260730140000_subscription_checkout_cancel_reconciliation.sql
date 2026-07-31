-- Milestone 8: reconcile an authenticated owner's Stripe Checkout cancel
-- return without trusting browser state to mutate subscription entitlement.
--
-- This is deliberately a narrow compare-and-set:
--   * the attempt must belong to the authenticated owner supplied by the API;
--   * only creating/pending attempts may become cancelled;
--   * expired attempts become expired;
--   * terminal attempts are immutable and replay their current state.
-- The function is service-role-only. For a bound pending attempt, its trusted
-- caller must first retrieve the owner-bound Stripe Checkout Session and
-- confirm that Stripe has expired it. The API service enforces that external
-- precondition; browser roles cannot invoke this state transition directly.
CREATE OR REPLACE FUNCTION public.cancel_subscription_checkout_attempt(
  p_request jsonb,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid;
  v_attempt_id uuid;
  v_attempt public.subscription_checkout_attempts%ROWTYPE;
BEGIN
  BEGIN
    v_owner_id := (p_request->>'owner_id')::uuid;
    v_attempt_id := (p_request->>'attempt_id')::uuid;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        DETAIL = '{"code":"CHECKOUT_ATTEMPT_INVALID"}';
  END;

  IF p_now IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      DETAIL = '{"code":"CHECKOUT_ATTEMPT_INVALID"}';
  END IF;

  SELECT attempt.*
    INTO v_attempt
  FROM public.subscription_checkout_attempts AS attempt
  WHERE attempt.id = v_attempt_id
    AND attempt.owner_id = v_owner_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'checkout_attempt_not_found');
  END IF;

  IF v_attempt.status NOT IN ('creating', 'pending') THEN
    RETURN public.subscription_checkout_attempt_result(
      v_attempt, v_attempt.status, true
    );
  END IF;

  IF v_attempt.expires_at <= p_now THEN
    UPDATE public.subscription_checkout_attempts AS attempt
    SET status = 'expired',
        error_code = 'checkout_attempt_expired',
        completed_at = p_now,
        updated_at = p_now
    WHERE attempt.id = v_attempt.id
      AND attempt.owner_id = v_owner_id
      AND attempt.status IN ('creating', 'pending')
    RETURNING attempt.* INTO v_attempt;

    RETURN public.subscription_checkout_attempt_result(
      v_attempt, 'expired', false
    );
  END IF;

  UPDATE public.subscription_checkout_attempts AS attempt
  SET status = 'cancelled',
      error_code = NULL,
      completed_at = p_now,
      updated_at = p_now
  WHERE attempt.id = v_attempt.id
    AND attempt.owner_id = v_owner_id
    AND attempt.status IN ('creating', 'pending')
  RETURNING attempt.* INTO v_attempt;

  RETURN public.subscription_checkout_attempt_result(
    v_attempt, 'cancelled', false
  );
END;
$$;

REVOKE ALL ON FUNCTION
  public.cancel_subscription_checkout_attempt(jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.cancel_subscription_checkout_attempt(jsonb, timestamptz)
  TO service_role;

COMMENT ON FUNCTION
  public.cancel_subscription_checkout_attempt(jsonb, timestamptz) IS
  'Owner-scoped idempotent reconciliation for a Stripe Checkout cancel return; only live attempts transition to cancelled.';
