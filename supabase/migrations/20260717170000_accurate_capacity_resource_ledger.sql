-- Accurate subscription-capacity metering.
--
-- Economic capacity is settled only from attributable resource facts. A
-- timeout is a safety ceiling, never a charge or reservation estimate. Active
-- zero-Light reservations provide the durable distributed concurrency lease;
-- observed Cloudflare CPU is correlated later by receipt and applied to the
-- execution's original account + Agent windows.

ALTER TABLE public.platform_billing_config
  ADD COLUMN IF NOT EXISTS worker_request_light_per_invocation
    double precision NOT NULL DEFAULT 0.00003;

ALTER TABLE public.platform_billing_config
  DROP CONSTRAINT IF EXISTS platform_billing_config_worker_request_rate_valid;
ALTER TABLE public.platform_billing_config
  ADD CONSTRAINT platform_billing_config_worker_request_rate_valid CHECK (
    worker_request_light_per_invocation >= 0
    AND worker_request_light_per_invocation < 'Infinity'::double precision
  );

-- Persist the launch rate through the normal config trigger so every resource
-- settlement pins a config version that includes the request dimension.
UPDATE public.platform_billing_config
SET worker_request_light_per_invocation = 0.00003
WHERE id = 'singleton';

CREATE TABLE IF NOT EXISTS public.capacity_execution_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL UNIQUE
    REFERENCES public.account_capacity_reservations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  capacity_agent_id uuid REFERENCES public.apps(id) ON DELETE SET NULL,
  receipt_id text NOT NULL UNIQUE,
  execution_id text,
  executed_at timestamp with time zone NOT NULL,
  status text NOT NULL DEFAULT 'pending_cpu',
  operation_light double precision NOT NULL DEFAULT 0,
  worker_request_count double precision NOT NULL DEFAULT 0,
  worker_request_light double precision NOT NULL DEFAULT 0,
  worker_load_mode text NOT NULL,
  worker_identity_hash text,
  dynamic_worker_invoked boolean NOT NULL DEFAULT false,
  dynamic_worker_light double precision NOT NULL DEFAULT 0,
  expected_cpu_sources text[] NOT NULL DEFAULT
    ARRAY['cloudflare_tail_parent']::text[],
  observed_cpu_sources text[] NOT NULL DEFAULT '{}'::text[],
  observed_cpu_ms double precision NOT NULL DEFAULT 0,
  observed_wall_time_ms double precision,
  cpu_light double precision NOT NULL DEFAULT 0,
  total_light double precision NOT NULL DEFAULT 0,
  -- Amount already reflected in call receipts and routine accounting. NULL
  -- means attribution has not yet been reconciled against those sinks.
  attributed_light double precision,
  billing_config_version integer NOT NULL,
  worker_ms_per_cloud_unit integer NOT NULL,
  cloud_unit_light_per_1k double precision NOT NULL,
  worker_request_light_per_invocation double precision NOT NULL,
  worker_load_light double precision NOT NULL,
  resource_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  cpu_observed_at timestamp with time zone,
  finalized_at timestamp with time zone,
  duplicate_observations bigint NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT capacity_execution_settlement_status_check CHECK (
    status IN ('pending_cpu', 'observed', 'final')
  ),
  CONSTRAINT capacity_execution_worker_load_mode_check CHECK (
    worker_load_mode IN ('reuse', 'load', 'none')
  ),
  CONSTRAINT capacity_execution_cpu_sources_check CHECK (
    cardinality(expected_cpu_sources) >= 1
    AND expected_cpu_sources @> ARRAY['cloudflare_tail_parent']::text[]
    AND expected_cpu_sources <@ ARRAY[
      'cloudflare_tail_parent', 'cloudflare_dynamic_tail'
    ]::text[]
    AND observed_cpu_sources <@ expected_cpu_sources
  ),
  CONSTRAINT capacity_execution_cpu_status_check CHECK (
    (status = 'pending_cpu' AND cardinality(observed_cpu_sources) = 0)
    OR (
      status = 'observed'
      AND cardinality(observed_cpu_sources) > 0
      AND NOT (expected_cpu_sources <@ observed_cpu_sources)
    )
    OR (status = 'final' AND expected_cpu_sources <@ observed_cpu_sources)
  ),
  CONSTRAINT capacity_execution_amount_check CHECK (
    isfinite(executed_at)
    AND operation_light >= 0
    AND operation_light < 'Infinity'::double precision
    AND worker_request_count >= 0
    AND worker_request_count < 'Infinity'::double precision
    AND worker_request_count = floor(worker_request_count)
    AND worker_request_light >= 0
    AND worker_request_light < 'Infinity'::double precision
    AND dynamic_worker_light >= 0
    AND dynamic_worker_light < 'Infinity'::double precision
    AND observed_cpu_ms >= 0
    AND observed_cpu_ms < 'Infinity'::double precision
    AND (
      observed_wall_time_ms IS NULL
      OR (
        observed_wall_time_ms >= 0
        AND observed_wall_time_ms < 'Infinity'::double precision
      )
    )
    AND cpu_light >= 0
    AND cpu_light < 'Infinity'::double precision
    AND total_light >= 0
    AND total_light < 'Infinity'::double precision
    AND (
      attributed_light IS NULL
      OR (
        attributed_light >= 0
        AND attributed_light < 'Infinity'::double precision
      )
    )
    AND worker_ms_per_cloud_unit > 0
    AND cloud_unit_light_per_1k > 0
    AND cloud_unit_light_per_1k < 'Infinity'::double precision
    AND worker_request_light_per_invocation >= 0
    AND worker_request_light_per_invocation < 'Infinity'::double precision
    AND worker_load_light >= 0
    AND worker_load_light < 'Infinity'::double precision
    AND duplicate_observations >= 0
    AND jsonb_typeof(resource_facts) = 'array'
    AND jsonb_typeof(metadata) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS idx_capacity_execution_settlements_pending
  ON public.capacity_execution_settlements(status, created_at)
  WHERE status <> 'final';
CREATE INDEX IF NOT EXISTS idx_capacity_execution_settlements_user_time
  ON public.capacity_execution_settlements(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.capacity_resource_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL
    REFERENCES public.capacity_execution_settlements(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL
    REFERENCES public.account_capacity_reservations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  capacity_agent_id uuid REFERENCES public.apps(id) ON DELETE SET NULL,
  event_key text NOT NULL UNIQUE,
  resource text NOT NULL,
  units double precision NOT NULL DEFAULT 0,
  cloud_units double precision NOT NULL DEFAULT 0,
  amount_light double precision NOT NULL DEFAULT 0,
  billing_config_version integer NOT NULL,
  source text NOT NULL,
  observed_at timestamp with time zone NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT capacity_resource_event_resource_check CHECK (
    resource IN (
      'worker_cpu', 'worker_request', 'dynamic_worker_identity',
      'r2_operation', 'kv_operation', 'd1_read', 'd1_write',
      'widget_pull', 'queue_operation', 'other'
    )
  ),
  CONSTRAINT capacity_resource_event_amount_check CHECK (
    units >= 0 AND units < 'Infinity'::double precision
    AND cloud_units >= 0 AND cloud_units < 'Infinity'::double precision
    AND amount_light >= 0 AND amount_light < 'Infinity'::double precision
  )
);

CREATE INDEX IF NOT EXISTS idx_capacity_resource_events_settlement
  ON public.capacity_resource_events(settlement_id, created_at);
CREATE INDEX IF NOT EXISTS idx_capacity_resource_events_resource_time
  ON public.capacity_resource_events(resource, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_capacity_resource_events_cpu_source
  ON public.capacity_resource_events(settlement_id, source)
  WHERE resource = 'worker_cpu';

-- One row is one Cloudflare-billable Dynamic Worker identity on one UTC day.
-- Stable loader.get reuse shares the row; loader.load has no stable identity
-- and is deliberately charged on every execution instead.
CREATE TABLE IF NOT EXISTS public.capacity_dynamic_worker_identities (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  worker_identity_key text NOT NULL,
  usage_day date NOT NULL,
  first_settlement_id uuid NOT NULL
    REFERENCES public.capacity_execution_settlements(id) ON DELETE CASCADE,
  capacity_agent_id uuid REFERENCES public.apps(id) ON DELETE SET NULL,
  amount_light double precision NOT NULL,
  billing_config_version integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, worker_identity_key, usage_day),
  CONSTRAINT capacity_dynamic_worker_identity_amount_check CHECK (
    amount_light >= 0
    AND amount_light < 'Infinity'::double precision
  )
);

CREATE INDEX IF NOT EXISTS idx_capacity_dynamic_worker_identities_day
  ON public.capacity_dynamic_worker_identities(usage_day, user_id);

-- Tail observations can arrive before the request path creates its settlement.
-- Persist first, then reconcile: queue retention is transport durability, not
-- the economic ledger's durability boundary.
CREATE TABLE IF NOT EXISTS public.capacity_cpu_observation_inbox (
  observation_id text PRIMARY KEY,
  receipt_id text NOT NULL,
  cpu_time_ms double precision NOT NULL,
  wall_time_ms double precision,
  observed_at timestamp with time zone NOT NULL,
  source text NOT NULL,
  final boolean NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
  settlement_id uuid REFERENCES public.capacity_execution_settlements(id)
    ON DELETE SET NULL,
  event_id uuid REFERENCES public.capacity_resource_events(id)
    ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT capacity_cpu_observation_status_check CHECK (
    status IN ('pending', 'applied')
  ),
  -- Cloudflare Tail emits one terminal trace per Worker source. Partial CPU
  -- observations cannot be priced safely because an observation/source pair
  -- is economically idempotent; accepting one would permanently discard the
  -- later terminal total. Keep the inbox terminal-only and fail closed.
  CONSTRAINT capacity_cpu_observation_final_check CHECK (final),
  CONSTRAINT capacity_cpu_observation_timing_check CHECK (
    cpu_time_ms >= 0
    AND cpu_time_ms < 'Infinity'::double precision
    AND (
      wall_time_ms IS NULL
      OR (
        wall_time_ms >= 0
        AND wall_time_ms < 'Infinity'::double precision
      )
    )
    AND attempts >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_capacity_cpu_observation_inbox_due
  ON public.capacity_cpu_observation_inbox(next_attempt_at, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_capacity_cpu_observation_inbox_receipt
  ON public.capacity_cpu_observation_inbox(receipt_id, created_at);

DROP TRIGGER IF EXISTS touch_capacity_execution_settlements_updated_at
  ON public.capacity_execution_settlements;
CREATE TRIGGER touch_capacity_execution_settlements_updated_at
BEFORE UPDATE ON public.capacity_execution_settlements
FOR EACH ROW EXECUTE FUNCTION public.touch_p21_updated_at();

ALTER TABLE public.capacity_execution_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacity_resource_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacity_dynamic_worker_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacity_cpu_observation_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.capacity_execution_settlements
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.capacity_resource_events
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.capacity_dynamic_worker_identities
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.capacity_cpu_observation_inbox
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.capacity_execution_settlements TO service_role;
GRANT ALL ON TABLE public.capacity_resource_events TO service_role;
GRANT ALL ON TABLE public.capacity_dynamic_worker_identities TO service_role;
GRANT ALL ON TABLE public.capacity_cpu_observation_inbox TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_account_capacity_v3(
  p_user_id uuid,
  p_capacity_agent_id uuid,
  p_idempotency_key text,
  p_reserve_light double precision,
  p_expires_at timestamp with time zone,
  p_uses_inference boolean DEFAULT false,
  p_routine_id uuid DEFAULT NULL,
  p_routine_run_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_now timestamp with time zone DEFAULT now(),
  p_account_concurrency_limit integer DEFAULT 4,
  p_agent_concurrency_limit integer DEFAULT 2,
  p_ai_concurrency_limit integer DEFAULT 2,
  p_routine_concurrency_limit integer DEFAULT 1
)
RETURNS TABLE (
  allowed boolean,
  code text,
  reservation_id uuid,
  plan_code text,
  capacity_state text,
  burst_state text,
  weekly_state text,
  burst_resets_at timestamp with time zone,
  weekly_resets_at timestamp with time zone,
  next_eligible_at timestamp with time zone,
  burst_remaining_light double precision,
  weekly_remaining_light double precision,
  capacity_agent_id uuid,
  agent_cap_basis_points integer,
  binding_constraint text,
  agent_burst_remaining_light double precision,
  agent_weekly_remaining_light double precision,
  concurrency_scope text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.account_capacity_reservations;
  v_account_count integer;
  v_agent_count integer;
  v_ai_count integer;
  v_routine_count integer;
  v_scope text;
  v_retry_at timestamp with time zone;
  v_account_status record;
  v_agent_status record;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('account_capacity:' || p_user_id::text, 0)
  );
  IF p_account_concurrency_limit <= 0 OR p_agent_concurrency_limit <= 0
    OR p_ai_concurrency_limit <= 0 OR p_routine_concurrency_limit <= 0 THEN
    RAISE EXCEPTION 'Concurrency limits must be positive';
  END IF;

  PERFORM public.reap_expired_account_capacity(p_user_id, p_now);

  -- Idempotent retries return the durable reservation decision and do not
  -- count their own active lease against concurrency a second time.
  SELECT reservations.* INTO v_existing
  FROM public.account_capacity_reservations AS reservations
  WHERE reservations.user_id = p_user_id
    AND reservations.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF v_existing.id IS NOT NULL THEN
    RETURN QUERY
    SELECT decisions.*, NULL::text
    FROM public.reserve_account_capacity_v2(
      p_user_id, p_capacity_agent_id, p_idempotency_key, p_reserve_light,
      p_expires_at,
      COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'uses_inference', COALESCE(p_uses_inference, false),
        'routine_id', p_routine_id,
        'routine_run_id', p_routine_run_id
      ),
      p_now
    ) AS decisions;
    RETURN;
  END IF;

  SELECT count(*)::integer INTO v_account_count
  FROM public.account_capacity_reservations AS reservations
  WHERE reservations.user_id = p_user_id
    AND reservations.status = 'reserved'
    AND reservations.expires_at > p_now;
  SELECT count(*)::integer INTO v_agent_count
  FROM public.account_capacity_reservations AS reservations
  WHERE reservations.user_id = p_user_id
    AND reservations.capacity_agent_id = p_capacity_agent_id
    AND reservations.status = 'reserved'
    AND reservations.expires_at > p_now;
  SELECT count(*)::integer INTO v_ai_count
  FROM public.account_capacity_reservations AS reservations
  WHERE reservations.user_id = p_user_id
    AND reservations.status = 'reserved'
    AND reservations.expires_at > p_now
    AND COALESCE(reservations.metadata->>'uses_inference', 'false') = 'true';
  -- One routine wake owns one concurrency lease. Nested galactic.call
  -- executions in the same run remain admissible; a different run waits.
  -- Without a run id every reservation is treated as a distinct wake.
  SELECT count(DISTINCT COALESCE(
    reservations.metadata->>'routine_run_id', reservations.id::text
  ))::integer INTO v_routine_count
  FROM public.account_capacity_reservations AS reservations
  WHERE reservations.user_id = p_user_id
    AND reservations.status = 'reserved'
    AND reservations.expires_at > p_now
    AND p_routine_id IS NOT NULL
    AND reservations.metadata->>'routine_id' = p_routine_id::text
    AND (
      p_routine_run_id IS NULL
      OR reservations.metadata->>'routine_run_id' IS DISTINCT FROM
        p_routine_run_id::text
    );

  -- Prefer the most actionable/specific binding constraint.
  IF p_routine_id IS NOT NULL
    AND v_routine_count >= p_routine_concurrency_limit THEN
    v_scope := 'routine';
  ELSIF COALESCE(p_uses_inference, false)
    AND v_ai_count >= p_ai_concurrency_limit THEN
    v_scope := 'ai';
  ELSIF v_agent_count >= p_agent_concurrency_limit THEN
    v_scope := 'agent';
  ELSIF v_account_count >= p_account_concurrency_limit THEN
    v_scope := 'account';
  END IF;

  IF v_scope IS NOT NULL THEN
    SELECT min(reservations.expires_at) INTO v_retry_at
    FROM public.account_capacity_reservations AS reservations
    WHERE reservations.user_id = p_user_id
      AND reservations.status = 'reserved'
      AND reservations.expires_at > p_now
      AND CASE v_scope
        WHEN 'routine' THEN
          reservations.metadata->>'routine_id' = p_routine_id::text
          AND (
            p_routine_run_id IS NULL
            OR reservations.metadata->>'routine_run_id' IS DISTINCT FROM
              p_routine_run_id::text
          )
        WHEN 'ai' THEN
          COALESCE(reservations.metadata->>'uses_inference', 'false') = 'true'
        WHEN 'agent' THEN
          reservations.capacity_agent_id = p_capacity_agent_id
        ELSE true
      END;

    SELECT statuses.* INTO v_account_status
    FROM public.get_account_capacity_status(p_user_id, p_now) AS statuses;
    SELECT statuses.* INTO v_agent_status
    FROM public.get_agent_capacity_status(
      p_user_id, p_capacity_agent_id, p_now
    ) AS statuses;

    v_retry_at := LEAST(v_retry_at, p_now + interval '15 seconds');

    RETURN QUERY SELECT
      false, 'concurrency_waiting'::text, NULL::uuid,
      v_account_status.plan_code, v_account_status.capacity_state,
      v_account_status.burst_state, v_account_status.weekly_state,
      v_account_status.burst_resets_at, v_account_status.weekly_resets_at,
      v_retry_at,
      GREATEST(0, v_account_status.burst_limit_light -
        v_account_status.burst_used_light),
      GREATEST(0, v_account_status.weekly_limit_light -
        v_account_status.weekly_used_light),
      p_capacity_agent_id, v_agent_status.agent_cap_basis_points,
      NULL::text,
      GREATEST(0, v_agent_status.agent_burst_limit_light -
        v_agent_status.agent_burst_used_light),
      GREATEST(0, v_agent_status.agent_weekly_limit_light -
        v_agent_status.agent_weekly_used_light),
      v_scope;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT decisions.*, NULL::text
  FROM public.reserve_account_capacity_v2(
    p_user_id, p_capacity_agent_id, p_idempotency_key, p_reserve_light,
    p_expires_at,
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'uses_inference', COALESCE(p_uses_inference, false),
      'routine_id', p_routine_id,
      'routine_run_id', p_routine_run_id
    ),
    p_now
  ) AS decisions;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_account_capacity_resources(
  p_reservation_id uuid,
  p_user_id uuid,
  p_receipt_id text,
  p_execution_id text,
  p_operation_light double precision,
  p_worker_request_count double precision,
  p_worker_identity_hash text,
  p_worker_load_mode text,
  p_worker_request_light_per_invocation double precision,
  p_worker_load_light double precision,
  p_worker_ms_per_cloud_unit integer,
  p_cloud_unit_light_per_1k double precision,
  p_billing_config_version integer,
  p_executed_at timestamp with time zone,
  p_dynamic_worker_invoked boolean,
  p_expected_cpu_sources text[],
  p_resource_facts jsonb DEFAULT '[]'::jsonb,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  settlement_id uuid,
  status text,
  immediate_light double precision,
  operation_light double precision,
  worker_request_light double precision,
  dynamic_worker_light double precision,
  cpu_light double precision,
  total_light double precision,
  dynamic_worker_charged boolean,
  billing_config_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res public.account_capacity_reservations;
  v_existing public.capacity_execution_settlements;
  v_settlement_id uuid;
  v_request_light double precision;
  v_dynamic_light double precision := 0;
  v_immediate double precision;
  v_identity_key text;
  v_identity_inserted boolean := false;
  v_fact jsonb;
  v_canonical_facts jsonb := '[]'::jsonb;
  v_fact_index integer := 0;
  v_fact_sum double precision := 0;
  v_fact_units double precision;
  v_fact_cloud_units double precision;
  v_fact_amount_light double precision;
  v_event_resource text;
  v_expected_cpu_sources text[];
  v_reserved_release double precision := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('account_capacity:' || p_user_id::text, 0)
  );
  IF COALESCE(btrim(p_receipt_id), '') = '' THEN
    RAISE EXCEPTION 'Receipt id is required';
  END IF;
  IF p_worker_load_mode NOT IN ('reuse', 'load', 'none') THEN
    RAISE EXCEPTION 'Worker load mode must be reuse, load, or none';
  END IF;
  IF p_worker_load_mode = 'reuse'
    AND COALESCE(btrim(p_worker_identity_hash), '') = '' THEN
    RAISE EXCEPTION 'Stable worker identity is required for reuse';
  END IF;
  IF p_worker_load_mode <> 'reuse'
    AND COALESCE(btrim(p_worker_identity_hash), '') <> '' THEN
    RAISE EXCEPTION 'Stable worker identity is only valid for reuse';
  END IF;
  IF COALESCE(p_dynamic_worker_invoked, false)
      AND p_worker_load_mode = 'none' THEN
    RAISE EXCEPTION 'Dynamic Worker request requires a created identity';
  END IF;
  v_expected_cpu_sources := CASE
    WHEN COALESCE(p_dynamic_worker_invoked, false) THEN ARRAY[
      'cloudflare_tail_parent', 'cloudflare_dynamic_tail'
    ]::text[]
    ELSE ARRAY['cloudflare_tail_parent']::text[]
  END;
  IF p_expected_cpu_sources IS DISTINCT FROM v_expected_cpu_sources THEN
    RAISE EXCEPTION 'Expected CPU sources do not match execution shape';
  END IF;
  IF p_operation_light IS NULL OR p_worker_request_count IS NULL
    OR p_worker_request_light_per_invocation IS NULL
    OR p_worker_load_light IS NULL OR p_worker_ms_per_cloud_unit IS NULL
    OR p_cloud_unit_light_per_1k IS NULL
    OR p_billing_config_version IS NULL
    OR p_operation_light < 0 OR p_worker_request_count < 0
    OR p_worker_request_count <> floor(p_worker_request_count)
    OR p_worker_request_light_per_invocation < 0 OR p_worker_load_light < 0
    OR p_worker_ms_per_cloud_unit <= 0 OR p_cloud_unit_light_per_1k <= 0
    OR p_billing_config_version <= 0
    OR p_operation_light IN (
      'NaN'::double precision, 'Infinity'::double precision,
      '-Infinity'::double precision
    )
    OR p_worker_request_count IN (
      'NaN'::double precision, 'Infinity'::double precision,
      '-Infinity'::double precision
    )
    OR p_worker_request_light_per_invocation IN (
      'NaN'::double precision, 'Infinity'::double precision,
      '-Infinity'::double precision
    )
    OR p_worker_load_light IN (
      'NaN'::double precision, 'Infinity'::double precision,
      '-Infinity'::double precision
    )
    OR p_cloud_unit_light_per_1k IN (
      'NaN'::double precision, 'Infinity'::double precision,
      '-Infinity'::double precision
    ) THEN
    RAISE EXCEPTION 'Capacity resource amounts must be finite and non-negative';
  END IF;
  IF p_executed_at IS NULL OR NOT isfinite(p_executed_at) THEN
    RAISE EXCEPTION 'Capacity execution timestamp must be finite';
  END IF;
  IF jsonb_typeof(COALESCE(p_resource_facts, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Resource facts must be a JSON array';
  END IF;
  IF jsonb_typeof(COALESCE(p_metadata, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'Capacity settlement metadata must be a JSON object';
  END IF;
  IF jsonb_array_length(COALESCE(p_resource_facts, '[]'::jsonb)) > 1024
    OR octet_length(COALESCE(p_resource_facts, '[]'::jsonb)::text) > 16384 THEN
    RAISE EXCEPTION 'Resource facts exceed the bounded settlement payload';
  END IF;

  -- The service role is the only caller, but these facts are economic input.
  -- Validate the raw JSON before any ledger mutation, normalize numbers to the
  -- database's pinned double-precision representation, and sort repeated
  -- resource tuples deterministically so replay compares canonical facts.
  FOR v_fact IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_resource_facts, '[]'::jsonb))
  LOOP
    IF jsonb_typeof(v_fact) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_fact->'resource') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_fact->'units') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_fact->'cloudUnits') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_fact->'amountLight') IS DISTINCT FROM 'number'
      OR (
        v_fact ? 'metadata'
        AND jsonb_typeof(v_fact->'metadata') IS DISTINCT FROM 'object'
      ) THEN
      RAISE EXCEPTION 'Capacity operation resource facts have invalid fields';
    END IF;
    v_event_resource := v_fact->>'resource';
    IF v_event_resource NOT IN (
      'r2_operation', 'kv_operation', 'd1_read', 'd1_write',
      'widget_pull', 'queue_operation', 'other'
    ) THEN
      RAISE EXCEPTION 'Invalid capacity operation resource fact';
    END IF;
    v_fact_units := (v_fact->>'units')::double precision;
    v_fact_cloud_units := (v_fact->>'cloudUnits')::double precision;
    v_fact_amount_light := (v_fact->>'amountLight')::double precision;
    IF v_fact_units < 0 OR v_fact_cloud_units < 0 OR v_fact_amount_light < 0
      OR v_fact_units IN (
        'NaN'::double precision, 'Infinity'::double precision,
        '-Infinity'::double precision
      )
      OR v_fact_cloud_units IN (
        'NaN'::double precision, 'Infinity'::double precision,
        '-Infinity'::double precision
      )
      OR v_fact_amount_light IN (
        'NaN'::double precision, 'Infinity'::double precision,
        '-Infinity'::double precision
      ) THEN
      RAISE EXCEPTION 'Capacity operation resource facts must be finite and non-negative';
    END IF;
    v_fact_sum := v_fact_sum + v_fact_amount_light;
    IF v_fact_sum IN (
      'NaN'::double precision, 'Infinity'::double precision,
      '-Infinity'::double precision
    ) THEN
      RAISE EXCEPTION 'Capacity operation resource fact total must be finite';
    END IF;
  END LOOP;
  IF v_fact_sum > p_operation_light THEN
    RAISE EXCEPTION 'Capacity operation resource facts exceed operation Light';
  END IF;
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'resource', facts.value->>'resource',
      'units', (facts.value->>'units')::double precision,
      'cloudUnits', (facts.value->>'cloudUnits')::double precision,
      'amountLight', (facts.value->>'amountLight')::double precision
    ) || CASE
      WHEN facts.value ? 'metadata'
        THEN jsonb_build_object('metadata', facts.value->'metadata')
      ELSE '{}'::jsonb
    END
    ORDER BY
      facts.value->>'resource',
      (facts.value->>'units')::double precision,
      (facts.value->>'cloudUnits')::double precision,
      (facts.value->>'amountLight')::double precision,
      COALESCE(facts.value->'metadata', '{}'::jsonb)::text
  ), '[]'::jsonb)
  INTO v_canonical_facts
  FROM jsonb_array_elements(
    COALESCE(p_resource_facts, '[]'::jsonb)
  ) AS facts(value);

  SELECT reservations.* INTO v_res
  FROM public.account_capacity_reservations AS reservations
  WHERE reservations.id = p_reservation_id
    AND reservations.user_id = p_user_id
  FOR UPDATE;
  IF v_res.id IS NULL THEN RAISE EXCEPTION 'Capacity reservation not found'; END IF;

  SELECT settlements.* INTO v_existing
  FROM public.capacity_execution_settlements AS settlements
  WHERE settlements.reservation_id = p_reservation_id
  FOR UPDATE;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.receipt_id <> p_receipt_id THEN
      RAISE EXCEPTION 'Capacity settlement receipt attribution mismatch';
    END IF;
    IF v_existing.execution_id IS DISTINCT FROM
        NULLIF(btrim(p_execution_id), '')
      OR v_existing.executed_at IS DISTINCT FROM p_executed_at
      OR v_existing.operation_light IS DISTINCT FROM p_operation_light
      OR v_existing.worker_request_count IS DISTINCT FROM
        p_worker_request_count
      OR v_existing.dynamic_worker_invoked IS DISTINCT FROM
        COALESCE(p_dynamic_worker_invoked, false)
      OR v_existing.worker_load_mode IS DISTINCT FROM p_worker_load_mode
      OR v_existing.worker_identity_hash IS DISTINCT FROM
        NULLIF(btrim(p_worker_identity_hash), '')
      OR v_existing.expected_cpu_sources IS DISTINCT FROM
        v_expected_cpu_sources
      OR v_existing.billing_config_version IS DISTINCT FROM
        p_billing_config_version
      OR v_existing.worker_ms_per_cloud_unit IS DISTINCT FROM
        p_worker_ms_per_cloud_unit
      OR v_existing.cloud_unit_light_per_1k IS DISTINCT FROM
        p_cloud_unit_light_per_1k
      OR v_existing.worker_request_light_per_invocation IS DISTINCT FROM
        p_worker_request_light_per_invocation
      OR v_existing.worker_load_light IS DISTINCT FROM p_worker_load_light
      OR v_existing.resource_facts IS DISTINCT FROM v_canonical_facts THEN
      RAISE EXCEPTION 'Capacity settlement pinned economic input mismatch';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.status,
      v_existing.operation_light + v_existing.worker_request_light +
        v_existing.dynamic_worker_light,
      v_existing.operation_light, v_existing.worker_request_light,
      v_existing.dynamic_worker_light, v_existing.cpu_light,
      v_existing.total_light, v_existing.dynamic_worker_light > 0,
      v_existing.billing_config_version;
    RETURN;
  END IF;
  -- A durable post-execution settlement intent may be replayed after its
  -- concurrency lease expires. `expired` proves the reservation was reaped,
  -- not that tenant work did not run; service-only settlement must still
  -- recover its attributable cost exactly once. Explicitly released leases
  -- remain ineligible because those are pre-execution cancellations.
  IF v_res.status NOT IN ('reserved', 'expired') THEN
    RAISE EXCEPTION 'Capacity reservation is not settleable';
  END IF;

  v_request_light := p_worker_request_count *
    p_worker_request_light_per_invocation;
  IF v_request_light < 0 OR v_request_light IN (
    'NaN'::double precision, 'Infinity'::double precision,
    '-Infinity'::double precision
  ) THEN
    RAISE EXCEPTION 'Worker request Light total must be finite';
  END IF;

  INSERT INTO public.capacity_execution_settlements (
    reservation_id, user_id, capacity_agent_id, receipt_id, execution_id,
    executed_at,
    status, operation_light, worker_request_count, worker_request_light,
    worker_load_mode, worker_identity_hash, dynamic_worker_light,
    dynamic_worker_invoked, expected_cpu_sources, observed_cpu_sources,
    billing_config_version, worker_ms_per_cloud_unit,
    cloud_unit_light_per_1k, worker_request_light_per_invocation,
    worker_load_light, resource_facts, metadata
  ) VALUES (
    p_reservation_id, p_user_id, v_res.capacity_agent_id, p_receipt_id,
    NULLIF(btrim(p_execution_id), ''), p_executed_at,
    'pending_cpu', p_operation_light,
    p_worker_request_count, v_request_light, p_worker_load_mode,
    NULLIF(btrim(p_worker_identity_hash), ''), 0,
    COALESCE(p_dynamic_worker_invoked, false), v_expected_cpu_sources,
    '{}'::text[],
    p_billing_config_version, p_worker_ms_per_cloud_unit,
    p_cloud_unit_light_per_1k, p_worker_request_light_per_invocation,
    p_worker_load_light, v_canonical_facts,
    COALESCE(p_metadata, '{}'::jsonb)
  ) RETURNING id INTO v_settlement_id;

  IF p_worker_load_mode = 'reuse' THEN
    v_identity_key := COALESCE(
      NULLIF(v_res.metadata->>'app_id', ''),
      v_res.capacity_agent_id::text,
      'unattributed'
    ) || ':' || p_worker_identity_hash;
    INSERT INTO public.capacity_dynamic_worker_identities (
      user_id, worker_identity_key, usage_day, first_settlement_id,
      capacity_agent_id, amount_light, billing_config_version
    ) VALUES (
      p_user_id, v_identity_key,
      (p_executed_at AT TIME ZONE 'UTC')::date,
      v_settlement_id, v_res.capacity_agent_id, p_worker_load_light,
      p_billing_config_version
    ) ON CONFLICT (user_id, worker_identity_key, usage_day) DO NOTHING;
    GET DIAGNOSTICS v_fact_index = ROW_COUNT;
    v_identity_inserted := v_fact_index = 1;
  ELSIF p_worker_load_mode = 'load' THEN
    v_identity_inserted := true;
  END IF;
  IF v_identity_inserted THEN v_dynamic_light := p_worker_load_light; END IF;

  v_immediate := p_operation_light + v_request_light + v_dynamic_light;
  IF v_immediate < 0 OR v_immediate IN (
    'NaN'::double precision, 'Infinity'::double precision,
    '-Infinity'::double precision
  ) THEN
    RAISE EXCEPTION 'Immediate capacity Light total must be finite';
  END IF;
  -- Expiry/reaping already returned this lease's reservation to both windows.
  -- Subtract only a still-active lease; otherwise a delayed durable settlement
  -- would silently release another execution's reserved exposure.
  v_reserved_release := CASE
    WHEN v_res.status = 'reserved' THEN v_res.reserved_light
    ELSE 0
  END;

  UPDATE public.account_capacity_windows AS windows
  SET reserved_light = GREATEST(0, windows.reserved_light - v_reserved_release),
      used_light = windows.used_light + v_immediate
  WHERE windows.user_id = p_user_id
    AND (
      (windows.window_kind = 'burst'
        AND windows.window_started_at = v_res.burst_window_started_at)
      OR (windows.window_kind = 'weekly'
        AND windows.window_started_at = v_res.weekly_window_started_at)
    );
  IF v_res.capacity_agent_id IS NOT NULL THEN
    UPDATE public.agent_capacity_windows AS windows
    SET reserved_light = GREATEST(0, windows.reserved_light - v_reserved_release),
        used_light = windows.used_light + v_immediate
    WHERE windows.user_id = p_user_id
      AND windows.capacity_agent_id = v_res.capacity_agent_id
      AND (
        (windows.window_kind = 'burst'
          AND windows.window_started_at = v_res.burst_window_started_at)
        OR (windows.window_kind = 'weekly'
          AND windows.window_started_at = v_res.weekly_window_started_at)
      );
  END IF;
  UPDATE public.account_capacity_reservations AS reservations
  SET status = 'settled', actual_light = v_immediate, settled_at = now(),
      metadata = COALESCE(reservations.metadata, '{}'::jsonb) ||
        jsonb_build_object(
          'capacity_meter', 'resource_ledger_v1',
          'receipt_id', p_receipt_id,
          'cpu_pending', true,
          'recovered_after_expiry', v_res.status = 'expired',
          'expected_cpu_sources', to_jsonb(v_expected_cpu_sources)
        )
  WHERE reservations.id = p_reservation_id;
  UPDATE public.capacity_execution_settlements AS settlements
  SET dynamic_worker_light = v_dynamic_light,
      total_light = v_immediate
  WHERE settlements.id = v_settlement_id;

  IF p_worker_request_count > 0 OR v_request_light > 0 THEN
    INSERT INTO public.capacity_resource_events (
      settlement_id, reservation_id, user_id, capacity_agent_id, event_key,
      resource, units, cloud_units, amount_light, billing_config_version,
      source, observed_at, metadata
    ) VALUES (
      v_settlement_id, p_reservation_id, p_user_id, v_res.capacity_agent_id,
      'capacity:' || v_settlement_id || ':worker_request',
      'worker_request', p_worker_request_count, p_worker_request_count,
      v_request_light, p_billing_config_version, 'runtime_settlement',
      p_executed_at,
      jsonb_build_object(
        'light_per_request', p_worker_request_light_per_invocation
      )
    );
  END IF;
  IF v_dynamic_light > 0 THEN
    INSERT INTO public.capacity_resource_events (
      settlement_id, reservation_id, user_id, capacity_agent_id, event_key,
      resource, units, cloud_units, amount_light, billing_config_version,
      source, observed_at, metadata
    ) VALUES (
      v_settlement_id, p_reservation_id, p_user_id, v_res.capacity_agent_id,
      'capacity:' || v_settlement_id || ':dynamic_worker',
      'dynamic_worker_identity', 1, 1, v_dynamic_light,
      p_billing_config_version, 'runtime_settlement',
      p_executed_at,
      jsonb_build_object(
        'load_mode', p_worker_load_mode,
        'identity_hash', p_worker_identity_hash,
        'daily_identity_first', v_identity_inserted
      )
    );
  END IF;

  v_fact_index := 0;
  FOR v_fact IN
    SELECT value FROM jsonb_array_elements(
      v_canonical_facts
    )
  LOOP
    v_fact_index := v_fact_index + 1;
    v_event_resource := v_fact->>'resource';
    INSERT INTO public.capacity_resource_events (
      settlement_id, reservation_id, user_id, capacity_agent_id, event_key,
      resource, units, cloud_units, amount_light, billing_config_version,
      source, observed_at, metadata
    ) VALUES (
      v_settlement_id, p_reservation_id, p_user_id, v_res.capacity_agent_id,
      'capacity:' || v_settlement_id || ':fact:' || v_fact_index,
      v_event_resource,
      COALESCE((v_fact->>'units')::double precision, 0),
      COALESCE((v_fact->>'cloudUnits')::double precision, 0),
      COALESCE((v_fact->>'amountLight')::double precision, 0),
      p_billing_config_version, 'runtime_operation',
      p_executed_at,
      COALESCE(v_fact->'metadata', '{}'::jsonb)
    );
  END LOOP;
  IF p_operation_light > v_fact_sum THEN
    INSERT INTO public.capacity_resource_events (
      settlement_id, reservation_id, user_id, capacity_agent_id, event_key,
      resource, units, cloud_units, amount_light, billing_config_version,
      source, observed_at, metadata
    ) VALUES (
      v_settlement_id, p_reservation_id, p_user_id, v_res.capacity_agent_id,
      'capacity:' || v_settlement_id || ':operation_remainder',
      'other', 0, 0, p_operation_light - v_fact_sum,
      p_billing_config_version, 'runtime_operation',
      p_executed_at,
      jsonb_build_object('reason', 'legacy_aggregate')
    );
  END IF;

  RETURN QUERY SELECT v_settlement_id, 'pending_cpu'::text, v_immediate,
    p_operation_light, v_request_light, v_dynamic_light, 0::double precision,
    v_immediate, v_identity_inserted, p_billing_config_version;
END;
$$;

-- Reconcile the authoritative capacity settlement into the user-facing call
-- receipt and routine accounting. This is deliberately separate from the
-- economic settlement: a degraded database response can force the exact
-- resource intent through Queues while receipt/step logging continues on the
-- request path. The settlement row is the idempotency lock and
-- attributed_light is the per-sink delta watermark.
CREATE OR REPLACE FUNCTION public.reconcile_capacity_settlement_attribution(
  p_receipt_id text,
  p_user_id uuid
)
RETURNS TABLE (
  reconciled boolean,
  total_light double precision,
  delta_light double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settlement public.capacity_execution_settlements%ROWTYPE;
  v_reservation public.account_capacity_reservations%ROWTYPE;
  v_log_user_id uuid;
  v_log_run_id uuid;
  v_routine_run_id uuid;
  v_metadata_run_id_text text;
  v_step_id uuid;
  v_step_light double precision;
  v_step_found boolean := false;
  v_budget_status text;
  v_budget_light double precision;
  v_budget_found boolean := false;
  v_current_light double precision := 0;
  v_delta_light double precision := 0;
BEGIN
  IF COALESCE(btrim(p_receipt_id), '') = '' OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'Capacity attribution requires receipt and user ids';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('capacity_attribution:' || p_receipt_id, 0)
  );
  SELECT settlements.* INTO v_settlement
  FROM public.capacity_execution_settlements AS settlements
  WHERE settlements.receipt_id = p_receipt_id
    AND settlements.user_id = p_user_id
  FOR UPDATE;
  IF v_settlement.id IS NULL THEN
    RAISE EXCEPTION 'Capacity settlement is not ready for attribution';
  END IF;

  SELECT logs.user_id, logs.routine_run_id
    INTO v_log_user_id, v_log_run_id
  FROM public.mcp_call_logs AS logs
  WHERE logs.id::text = p_receipt_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, v_settlement.total_light,
      0::double precision;
    RETURN;
  END IF;
  IF v_log_user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Capacity receipt user attribution mismatch';
  END IF;

  SELECT reservations.* INTO v_reservation
  FROM public.account_capacity_reservations AS reservations
  WHERE reservations.id = v_settlement.reservation_id
    AND reservations.user_id = p_user_id;
  v_metadata_run_id_text := NULLIF(
    btrim(v_reservation.metadata->>'routine_run_id'), ''
  );
  -- The typed call-log relation is authoritative once the receipt exists.
  -- Reservation metadata is only a compatibility fallback and must be
  -- validated before casting: one malformed legacy value must remain an
  -- observable pending attribution, not abort a bounded reconciliation batch.
  IF v_log_run_id IS NOT NULL THEN
    v_routine_run_id := v_log_run_id;
  ELSIF v_metadata_run_id_text IS NULL THEN
    v_routine_run_id := NULL;
  ELSIF v_metadata_run_id_text ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    v_routine_run_id := v_metadata_run_id_text::uuid;
  ELSE
    RETURN QUERY SELECT false, v_settlement.total_light,
      0::double precision;
    RETURN;
  END IF;

  IF v_routine_run_id IS NOT NULL THEN
    SELECT steps.id, steps.cost_light INTO v_step_id, v_step_light
    FROM public.routine_run_steps AS steps
    WHERE steps.run_id = v_routine_run_id
      AND steps.user_id = p_user_id
      AND steps.receipt_id = p_receipt_id
    ORDER BY steps.step_index ASC
    LIMIT 1
    FOR UPDATE;
    v_step_found := FOUND;

    SELECT reservations.status, reservations.actual_light
      INTO v_budget_status, v_budget_light
    FROM public.routine_run_budget_reservations AS reservations
    WHERE reservations.routine_run_id = v_routine_run_id
      AND reservations.user_id = p_user_id
      AND reservations.reservation_key = 'app:' || p_receipt_id
    FOR UPDATE;
    v_budget_found := FOUND;

    -- Receipt insertion can race the awaited routine contribution. Do not
    -- apply a run delta until either its step exists or the budget fallback
    -- has terminally settled; a Queue/scheduler retry will converge later.
    IF NOT v_step_found
      AND NOT (
        v_budget_found AND v_budget_status IN ('settled', 'released')
      ) THEN
      RETURN QUERY SELECT false, v_settlement.total_light,
        0::double precision;
      RETURN;
    END IF;
  END IF;

  IF v_settlement.attributed_light IS NOT NULL THEN
    v_current_light := v_settlement.attributed_light;
  ELSIF v_step_found THEN
    v_current_light := GREATEST(COALESCE(v_step_light, 0), 0);
  ELSIF v_budget_found THEN
    v_current_light := GREATEST(COALESCE(v_budget_light, 0), 0);
  END IF;
  IF v_current_light > v_settlement.total_light THEN
    RAISE EXCEPTION 'Capacity attribution exceeds authoritative settlement';
  END IF;
  v_delta_light := v_settlement.total_light - v_current_light;

  UPDATE public.mcp_call_logs AS logs
  SET infra_charge_light = v_settlement.total_light,
      cloud_charge_light = v_settlement.total_light,
      billing_config_version = COALESCE(
        logs.billing_config_version, v_settlement.billing_config_version
      )
  WHERE logs.id::text = p_receipt_id
    AND logs.user_id = p_user_id;

  IF v_routine_run_id IS NOT NULL THEN
    UPDATE public.routine_runs AS runs
    SET total_light = runs.total_light + v_delta_light,
        metadata = COALESCE(runs.metadata, '{}'::jsonb) || jsonb_build_object(
          'last_capacity_receipt_id', p_receipt_id,
          'last_capacity_reconciled_at', now()
        )
    WHERE runs.id = v_routine_run_id
      AND runs.user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Routine run is not ready for capacity attribution';
    END IF;

    IF v_step_found THEN
      UPDATE public.routine_run_steps AS steps
      SET cost_light = GREATEST(steps.cost_light, v_settlement.total_light),
          metadata = COALESCE(steps.metadata, '{}'::jsonb) ||
            jsonb_build_object(
              'capacity_resource_light', v_settlement.total_light,
              'capacity_reconciled_at', now()
            )
      WHERE steps.id = v_step_id;
    END IF;
    IF v_budget_found THEN
      UPDATE public.routine_run_budget_reservations AS reservations
      SET status = 'settled',
          actual_light = GREATEST(
            COALESCE(reservations.actual_light, 0),
            v_settlement.total_light
          ),
          settled_at = COALESCE(reservations.settled_at, now()),
          updated_at = now()
      WHERE reservations.routine_run_id = v_routine_run_id
        AND reservations.user_id = p_user_id
        AND reservations.reservation_key = 'app:' || p_receipt_id;
    END IF;
  END IF;

  UPDATE public.capacity_execution_settlements AS settlements
  SET attributed_light = v_settlement.total_light,
      updated_at = now()
  WHERE settlements.id = v_settlement.id;

  RETURN QUERY SELECT true, v_settlement.total_light, v_delta_light;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_observed_capacity_cpu(
  p_receipt_id text,
  p_observation_id text,
  p_cpu_time_ms double precision,
  p_wall_time_ms double precision,
  p_observed_at timestamp with time zone,
  p_source text,
  p_final boolean DEFAULT false,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  settlement_id uuid,
  event_id uuid,
  inserted boolean,
  status text,
  cpu_time_ms double precision,
  wall_time_ms double precision,
  cpu_light double precision,
  total_light double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settlement public.capacity_execution_settlements;
  v_event public.capacity_resource_events;
  v_inserted boolean := false;
  v_cpu_light double precision;
  v_status text;
  v_observed_cpu_sources text[];
BEGIN
  IF COALESCE(btrim(p_receipt_id), '') = ''
    OR COALESCE(btrim(p_observation_id), '') = ''
    OR COALESCE(btrim(p_source), '') = '' THEN
    RAISE EXCEPTION 'CPU observation attribution is required';
  END IF;
  IF p_final IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CPU observation must be final';
  END IF;
  IF p_cpu_time_ms < 0 OR (p_wall_time_ms IS NOT NULL AND p_wall_time_ms < 0)
    OR p_cpu_time_ms IN ('NaN'::double precision, 'Infinity'::double precision)
    OR p_wall_time_ms IN ('NaN'::double precision, 'Infinity'::double precision) THEN
    RAISE EXCEPTION 'Observed timing must be finite and non-negative';
  END IF;

  SELECT settlements.* INTO v_settlement
  FROM public.capacity_execution_settlements AS settlements
  WHERE settlements.receipt_id = p_receipt_id;
  IF v_settlement.id IS NULL THEN
    RAISE EXCEPTION 'Capacity settlement is not ready for CPU observation';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('account_capacity:' || v_settlement.user_id::text, 0)
  );
  SELECT settlements.* INTO v_settlement
  FROM public.capacity_execution_settlements AS settlements
  WHERE settlements.receipt_id = p_receipt_id
  FOR UPDATE;
  IF NOT (p_source = ANY(v_settlement.expected_cpu_sources)) THEN
    RAISE EXCEPTION 'Unexpected CPU observation source for execution';
  END IF;

  SELECT events.* INTO v_event
  FROM public.capacity_resource_events AS events
  WHERE events.event_key = 'cpu:' || p_observation_id
  FOR UPDATE;
  IF v_event.id IS NOT NULL THEN
    IF v_event.settlement_id <> v_settlement.id
      OR v_event.resource <> 'worker_cpu'
      OR v_event.source <> p_source THEN
      RAISE EXCEPTION 'CPU observation id attribution mismatch';
    END IF;
    UPDATE public.capacity_execution_settlements AS settlements
    SET duplicate_observations = settlements.duplicate_observations + 1
    WHERE settlements.id = v_settlement.id
    RETURNING * INTO v_settlement;
    RETURN QUERY SELECT v_settlement.id, v_event.id, false,
      v_settlement.status, v_event.units,
      CASE WHEN v_event.metadata->>'wall_time_ms' IS NULL THEN NULL
        ELSE (v_event.metadata->>'wall_time_ms')::double precision END,
      v_settlement.cpu_light, v_settlement.total_light;
    RETURN;
  END IF;

  -- Observation ids are transport-idempotent. The execution/source pair is
  -- independently economic-idempotent so a retried Tail delivery carrying a
  -- new message id can never double-charge the same Worker component.
  SELECT events.* INTO v_event
  FROM public.capacity_resource_events AS events
  WHERE events.settlement_id = v_settlement.id
    AND events.resource = 'worker_cpu'
    AND events.source = p_source
  FOR UPDATE;
  IF v_event.id IS NOT NULL THEN
    UPDATE public.capacity_execution_settlements AS settlements
    SET duplicate_observations = settlements.duplicate_observations + 1
    WHERE settlements.id = v_settlement.id
    RETURNING * INTO v_settlement;
    RETURN QUERY SELECT v_settlement.id, v_event.id, false,
      v_settlement.status, v_event.units,
      CASE WHEN v_event.metadata->>'wall_time_ms' IS NULL THEN NULL
        ELSE (v_event.metadata->>'wall_time_ms')::double precision END,
      v_settlement.cpu_light, v_settlement.total_light;
    RETURN;
  END IF;

  -- Continuous CPU units: no per-invocation rounding and no wall time. The
  -- pinned rate currently retains the existing conservative ~2x CPU buffer.
  v_cpu_light := (p_cpu_time_ms / v_settlement.worker_ms_per_cloud_unit) *
    (v_settlement.cloud_unit_light_per_1k / 1000.0);
  v_observed_cpu_sources := array_append(
    v_settlement.observed_cpu_sources,
    p_source
  );
  v_status := CASE
    WHEN v_settlement.expected_cpu_sources <@ v_observed_cpu_sources
      THEN 'final'
    ELSE 'observed'
  END;

  INSERT INTO public.capacity_resource_events (
    settlement_id, reservation_id, user_id, capacity_agent_id, event_key,
    resource, units, cloud_units, amount_light, billing_config_version,
    source, observed_at, metadata
  ) VALUES (
    v_settlement.id, v_settlement.reservation_id, v_settlement.user_id,
    v_settlement.capacity_agent_id, 'cpu:' || p_observation_id,
    'worker_cpu', p_cpu_time_ms,
    p_cpu_time_ms / v_settlement.worker_ms_per_cloud_unit,
    v_cpu_light, v_settlement.billing_config_version, p_source,
    COALESCE(p_observed_at, now()),
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'wall_time_ms', p_wall_time_ms,
      'source_final', true,
      'worker_ms_per_cloud_unit', v_settlement.worker_ms_per_cloud_unit,
      'cloud_unit_light_per_1k', v_settlement.cloud_unit_light_per_1k
    )
  ) RETURNING * INTO v_event;
  v_inserted := true;

  UPDATE public.account_capacity_windows AS windows
  SET used_light = windows.used_light + v_cpu_light
  WHERE windows.user_id = v_settlement.user_id
    AND (
      (windows.window_kind = 'burst' AND windows.window_started_at = (
        SELECT reservations.burst_window_started_at
        FROM public.account_capacity_reservations AS reservations
        WHERE reservations.id = v_settlement.reservation_id
      ))
      OR (windows.window_kind = 'weekly' AND windows.window_started_at = (
        SELECT reservations.weekly_window_started_at
        FROM public.account_capacity_reservations AS reservations
        WHERE reservations.id = v_settlement.reservation_id
      ))
    );
  IF v_settlement.capacity_agent_id IS NOT NULL THEN
    UPDATE public.agent_capacity_windows AS windows
    SET used_light = windows.used_light + v_cpu_light
    WHERE windows.user_id = v_settlement.user_id
      AND windows.capacity_agent_id = v_settlement.capacity_agent_id
      AND (
        (windows.window_kind = 'burst' AND windows.window_started_at = (
          SELECT reservations.burst_window_started_at
          FROM public.account_capacity_reservations AS reservations
          WHERE reservations.id = v_settlement.reservation_id
        ))
        OR (windows.window_kind = 'weekly' AND windows.window_started_at = (
          SELECT reservations.weekly_window_started_at
          FROM public.account_capacity_reservations AS reservations
          WHERE reservations.id = v_settlement.reservation_id
        ))
      );
  END IF;
  UPDATE public.account_capacity_reservations AS reservations
  SET actual_light = COALESCE(reservations.actual_light, 0) + v_cpu_light,
      metadata = COALESCE(reservations.metadata, '{}'::jsonb) ||
        jsonb_build_object(
          'cpu_pending', v_status <> 'final',
          'observed_cpu_sources', to_jsonb(v_observed_cpu_sources)
        )
  WHERE reservations.id = v_settlement.reservation_id;

  UPDATE public.capacity_execution_settlements AS settlements
  SET status = v_status,
      observed_cpu_sources = v_observed_cpu_sources,
      observed_cpu_ms = settlements.observed_cpu_ms + p_cpu_time_ms,
      observed_wall_time_ms = CASE
        WHEN p_wall_time_ms IS NULL THEN settlements.observed_wall_time_ms
        ELSE GREATEST(
          COALESCE(settlements.observed_wall_time_ms, 0), p_wall_time_ms
        )
      END,
      cpu_light = settlements.cpu_light + v_cpu_light,
      total_light = settlements.total_light + v_cpu_light,
      cpu_observed_at = GREATEST(
        COALESCE(settlements.cpu_observed_at, '-infinity'::timestamptz),
        COALESCE(p_observed_at, now())
      ),
      finalized_at = CASE
        WHEN v_status = 'final' THEN now()
        ELSE settlements.finalized_at
      END
  WHERE settlements.id = v_settlement.id
  RETURNING * INTO v_settlement;

  RETURN QUERY SELECT v_settlement.id, v_event.id, v_inserted,
    v_settlement.status, p_cpu_time_ms, p_wall_time_ms,
    v_settlement.cpu_light, v_settlement.total_light;
END;
$$;

CREATE OR REPLACE FUNCTION public.ingest_capacity_cpu_observation(
  p_receipt_id text,
  p_observation_id text,
  p_cpu_time_ms double precision,
  p_wall_time_ms double precision,
  p_observed_at timestamp with time zone,
  p_source text,
  p_final boolean DEFAULT false,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  observation_id text,
  application_status text,
  settlement_id uuid,
  event_id uuid,
  inserted boolean,
  settlement_status text,
  cpu_time_ms double precision,
  wall_time_ms double precision,
  cpu_light double precision,
  total_light double precision,
  attempts integer,
  next_attempt_at timestamp with time zone,
  last_error text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inbox public.capacity_cpu_observation_inbox;
  v_apply record;
  v_attribution record;
  v_inserted boolean := false;
  v_row_count integer;
  v_settlement public.capacity_execution_settlements;
  v_backoff interval;
BEGIN
  IF COALESCE(btrim(p_receipt_id), '') = ''
    OR COALESCE(btrim(p_observation_id), '') = ''
    OR COALESCE(btrim(p_source), '') = '' THEN
    RAISE EXCEPTION 'CPU observation attribution is required';
  END IF;
  IF p_final IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CPU observation must be final';
  END IF;
  IF p_cpu_time_ms < 0 OR (p_wall_time_ms IS NOT NULL AND p_wall_time_ms < 0)
    OR p_cpu_time_ms IN ('NaN'::double precision, 'Infinity'::double precision)
    OR p_wall_time_ms IN ('NaN'::double precision, 'Infinity'::double precision) THEN
    RAISE EXCEPTION 'Observed timing must be finite and non-negative';
  END IF;

  INSERT INTO public.capacity_cpu_observation_inbox (
    observation_id, receipt_id, cpu_time_ms, wall_time_ms, observed_at,
    source, final, metadata
  ) VALUES (
    p_observation_id, p_receipt_id, p_cpu_time_ms, p_wall_time_ms,
    COALESCE(p_observed_at, now()), p_source, p_final,
    COALESCE(p_metadata, '{}'::jsonb)
  ) ON CONFLICT (observation_id) DO NOTHING;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  v_inserted := v_row_count = 1;

  SELECT inbox.* INTO v_inbox
  FROM public.capacity_cpu_observation_inbox AS inbox
  WHERE inbox.observation_id = p_observation_id
  FOR UPDATE;
  IF v_inbox.receipt_id <> p_receipt_id
    OR v_inbox.cpu_time_ms <> p_cpu_time_ms
    OR v_inbox.wall_time_ms IS DISTINCT FROM p_wall_time_ms
    OR v_inbox.source <> p_source
    OR v_inbox.final IS DISTINCT FROM p_final THEN
    RAISE EXCEPTION 'CPU observation id attribution mismatch';
  END IF;

  IF v_inbox.status = 'applied' THEN
    IF NOT v_inserted AND v_inbox.settlement_id IS NOT NULL THEN
      UPDATE public.capacity_execution_settlements AS settlements
      SET duplicate_observations = settlements.duplicate_observations + 1
      WHERE settlements.id = v_inbox.settlement_id;
    END IF;
    SELECT settlements.* INTO v_settlement
    FROM public.capacity_execution_settlements AS settlements
    WHERE settlements.id = v_inbox.settlement_id;
    RETURN QUERY SELECT v_inbox.observation_id, 'applied'::text,
      v_inbox.settlement_id, v_inbox.event_id, v_inserted,
      v_settlement.status, v_inbox.cpu_time_ms, v_inbox.wall_time_ms,
      COALESCE(v_settlement.cpu_light, 0),
      COALESCE(v_settlement.total_light, 0), v_inbox.attempts,
      NULL::timestamp with time zone, v_inbox.last_error;
    RETURN;
  END IF;

  SELECT settlements.* INTO v_settlement
  FROM public.capacity_execution_settlements AS settlements
  WHERE settlements.receipt_id = v_inbox.receipt_id;
  IF v_settlement.id IS NULL THEN
    v_backoff := LEAST(
      interval '1 hour',
      interval '5 seconds' * power(2, LEAST(v_inbox.attempts, 10))
    );
    UPDATE public.capacity_cpu_observation_inbox AS inbox
    SET attempts = inbox.attempts + 1,
        last_error = 'settlement_not_ready',
        next_attempt_at = now() + v_backoff
    WHERE inbox.observation_id = v_inbox.observation_id
    RETURNING * INTO v_inbox;
    RETURN QUERY SELECT v_inbox.observation_id, 'pending'::text,
      NULL::uuid, NULL::uuid, v_inserted, NULL::text,
      v_inbox.cpu_time_ms, v_inbox.wall_time_ms, 0::double precision,
      0::double precision, v_inbox.attempts, v_inbox.next_attempt_at,
      v_inbox.last_error;
    RETURN;
  END IF;

  BEGIN
    SELECT applied.* INTO v_apply
    FROM public.record_observed_capacity_cpu(
      v_inbox.receipt_id, v_inbox.observation_id, v_inbox.cpu_time_ms,
      v_inbox.wall_time_ms, v_inbox.observed_at, v_inbox.source,
      v_inbox.final, v_inbox.metadata
    ) AS applied;
    SELECT attribution.* INTO v_attribution
    FROM public.reconcile_capacity_settlement_attribution(
      v_inbox.receipt_id, v_settlement.user_id
    ) AS attribution;
    IF NOT COALESCE(v_attribution.reconciled, false) THEN
      v_backoff := LEAST(
        interval '1 hour',
        interval '5 seconds' * power(2, LEAST(v_inbox.attempts, 10))
      );
      UPDATE public.capacity_cpu_observation_inbox AS inbox
      SET status = 'pending', attempts = inbox.attempts + 1,
          last_error = 'attribution_not_ready',
          next_attempt_at = now() + v_backoff,
          settlement_id = v_apply.settlement_id,
          event_id = v_apply.event_id
      WHERE inbox.observation_id = v_inbox.observation_id
      RETURNING * INTO v_inbox;
      RETURN QUERY SELECT v_inbox.observation_id, 'pending'::text,
        v_apply.settlement_id, v_apply.event_id, v_inserted,
        v_apply.status, v_inbox.cpu_time_ms, v_inbox.wall_time_ms,
        v_apply.cpu_light, v_apply.total_light, v_inbox.attempts,
        v_inbox.next_attempt_at, v_inbox.last_error;
      RETURN;
    END IF;
    UPDATE public.capacity_cpu_observation_inbox AS inbox
    SET status = 'applied', attempts = inbox.attempts + 1,
        last_error = NULL, next_attempt_at = now(),
        settlement_id = v_apply.settlement_id,
        event_id = v_apply.event_id, applied_at = now()
    WHERE inbox.observation_id = v_inbox.observation_id
    RETURNING * INTO v_inbox;
    RETURN QUERY SELECT v_inbox.observation_id, 'applied'::text,
      v_apply.settlement_id, v_apply.event_id, v_inserted,
      v_apply.status, v_inbox.cpu_time_ms, v_inbox.wall_time_ms,
      v_apply.cpu_light, v_apply.total_light, v_inbox.attempts,
      NULL::timestamp with time zone, NULL::text;
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    v_backoff := LEAST(
      interval '1 hour',
      interval '5 seconds' * power(2, LEAST(v_inbox.attempts, 10))
    );
    UPDATE public.capacity_cpu_observation_inbox AS inbox
    SET attempts = inbox.attempts + 1,
        last_error = left(SQLSTATE || ': ' || SQLERRM, 2000),
        next_attempt_at = now() + v_backoff
    WHERE inbox.observation_id = v_inbox.observation_id
    RETURNING * INTO v_inbox;
    RETURN QUERY SELECT v_inbox.observation_id, 'pending'::text,
      v_settlement.id, NULL::uuid, v_inserted, v_settlement.status,
      v_inbox.cpu_time_ms, v_inbox.wall_time_ms,
      v_settlement.cpu_light, v_settlement.total_light, v_inbox.attempts,
      v_inbox.next_attempt_at, v_inbox.last_error;
    RETURN;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_capacity_cpu_observations(
  p_limit integer DEFAULT 100,
  p_now timestamp with time zone DEFAULT now()
)
RETURNS TABLE (
  processed integer,
  applied integer,
  pending integer,
  errors integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_observation public.capacity_cpu_observation_inbox;
  v_settlement public.capacity_execution_settlements;
  v_outcome record;
  v_attribution record;
  v_processed integer := 0;
  v_applied integer := 0;
  v_pending integer := 0;
  v_errors integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'Reconciliation limit must be between 1 and 1000';
  END IF;
  FOR v_observation IN
    SELECT inbox.*
    FROM public.capacity_cpu_observation_inbox AS inbox
    WHERE inbox.status = 'pending'
      AND inbox.next_attempt_at <= p_now
    ORDER BY inbox.next_attempt_at, inbox.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT outcomes.* INTO v_outcome
    FROM public.ingest_capacity_cpu_observation(
      v_observation.receipt_id, v_observation.observation_id,
      v_observation.cpu_time_ms, v_observation.wall_time_ms,
      v_observation.observed_at, v_observation.source,
      v_observation.final, v_observation.metadata
    ) AS outcomes;
    v_processed := v_processed + 1;
    IF v_outcome.application_status = 'applied' THEN
      v_applied := v_applied + 1;
    ELSE
      v_pending := v_pending + 1;
      IF v_outcome.last_error IS NOT NULL
        AND v_outcome.last_error NOT IN (
          'settlement_not_ready', 'attribution_not_ready'
        ) THEN
        v_errors := v_errors + 1;
      END IF;
    END IF;
  END LOOP;

  -- Attribution is independently sweepable from the Tail inbox. This covers
  -- direct immediate settlements when Tail never arrives, as well as the
  -- short race where Queue recovery settles before the request path persists
  -- its receipt/routine step. Missing receipts remain pending and become a
  -- stale-attribution alarm rather than silently leaving a zero receipt.
  FOR v_settlement IN
    SELECT settlements.*
    FROM public.capacity_execution_settlements AS settlements
    WHERE (
      settlements.attributed_light IS NULL
      OR settlements.attributed_light < settlements.total_light
    )
      AND settlements.created_at <= p_now
      -- Do not let permanently missing receipt telemetry monopolize this
      -- bounded hot-path batch. Those rows remain visible in the stale
      -- attribution summary/alarm, while ready rows behind them continue to
      -- converge. Routine attribution is ready only once the contribution
      -- step exists or its fallback budget reservation is terminal.
      AND EXISTS (
        SELECT 1
        FROM public.mcp_call_logs AS logs
        JOIN public.account_capacity_reservations AS capacity_reservations
          ON capacity_reservations.id = settlements.reservation_id
         AND capacity_reservations.user_id = settlements.user_id
        CROSS JOIN LATERAL (
          SELECT NULLIF(
            btrim(capacity_reservations.metadata->>'routine_run_id'), ''
          ) AS metadata_run_id_text
        ) AS reservation_context
        CROSS JOIN LATERAL (
          SELECT
            COALESCE(
              logs.routine_run_id,
              CASE
                WHEN reservation_context.metadata_run_id_text ~*
                  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN reservation_context.metadata_run_id_text::uuid
                ELSE NULL
              END
            ) AS routine_run_id,
            (
              logs.routine_run_id IS NOT NULL
              OR reservation_context.metadata_run_id_text IS NULL
              OR reservation_context.metadata_run_id_text ~*
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            ) AS routine_run_id_valid
        ) AS attribution_context
        WHERE logs.id::text = settlements.receipt_id
          AND logs.user_id = settlements.user_id
          -- Invalid metadata without an authoritative typed run id remains in
          -- the stale-attribution alarm instead of consuming every hot sweep.
          AND attribution_context.routine_run_id_valid
          AND (
            attribution_context.routine_run_id IS NULL
            OR EXISTS (
              SELECT 1
              FROM public.routine_run_steps AS steps
              WHERE steps.run_id = attribution_context.routine_run_id
                AND steps.user_id = settlements.user_id
                AND steps.receipt_id = settlements.receipt_id
            )
            OR EXISTS (
              SELECT 1
              FROM public.routine_run_budget_reservations AS budgets
              WHERE budgets.routine_run_id =
                  attribution_context.routine_run_id
                AND budgets.user_id = settlements.user_id
                AND budgets.reservation_key =
                  'app:' || settlements.receipt_id
                AND budgets.status IN ('settled', 'released')
            )
          )
      )
    ORDER BY settlements.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    v_processed := v_processed + 1;
    BEGIN
      SELECT attribution.* INTO v_attribution
      FROM public.reconcile_capacity_settlement_attribution(
        v_settlement.receipt_id, v_settlement.user_id
      ) AS attribution;
      IF COALESCE(v_attribution.reconciled, false) THEN
        v_applied := v_applied + 1;
      ELSE
        v_pending := v_pending + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_pending := v_pending + 1;
      v_errors := v_errors + 1;
    END;
  END LOOP;
  RETURN QUERY SELECT v_processed, v_applied, v_pending, v_errors;
END;
$$;

-- Routine limits are explicit user policy, but their admission amount must
-- still be truthful. A zero-Light reservation atomically consumes the call
-- slot; actual resource settlement may cross the Light boundary once, and the
-- next call is denied by reserve_routine_run_budget.
CREATE OR REPLACE FUNCTION public.settle_routine_run_budget_reservation(
  p_reservation_id uuid,
  p_user_id uuid,
  p_actual_light double precision DEFAULT 0,
  p_apply_spend boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_row public.routine_run_budget_reservations%ROWTYPE;
  v_routine_id uuid;
BEGIN
  IF p_actual_light IS NULL OR p_actual_light < 0 OR
     p_actual_light::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Actual Light must be finite and non-negative';
  END IF;
  SELECT reservations.routine_id INTO v_routine_id
  FROM public.routine_run_budget_reservations AS reservations
  WHERE reservations.id = p_reservation_id
    AND reservations.user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Routine budget reservation not found'; END IF;

  PERFORM 1 FROM public.user_routines AS routines
  WHERE routines.id = v_routine_id AND routines.user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Routine not found for user'; END IF;

  SELECT reservations.* INTO v_row
  FROM public.routine_run_budget_reservations AS reservations
  WHERE reservations.id = p_reservation_id
    AND reservations.user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Routine budget reservation not found'; END IF;
  IF v_row.status = 'settled' THEN RETURN true; END IF;
  IF v_row.status <> 'reserved' THEN
    RAISE EXCEPTION 'Routine budget reservation is not active';
  END IF;
  IF p_apply_spend AND p_actual_light > 0 THEN
    UPDATE public.routine_runs AS runs
    SET total_light = runs.total_light + p_actual_light
    WHERE runs.id = v_row.routine_run_id
      AND runs.routine_id = v_row.routine_id
      AND runs.user_id = p_user_id;
  END IF;
  UPDATE public.routine_run_budget_reservations AS reservations
  SET status = 'settled', actual_light = p_actual_light,
      settled_at = now(), updated_at = now()
  WHERE reservations.id = p_reservation_id;
  RETURN true;
END;
$$;

-- Read-only service-role economics/reconciliation projection. `missing_tail`
-- is intentionally age-based: a fresh pending row is normal telemetry lag.
CREATE OR REPLACE FUNCTION public.get_capacity_reconciliation_summary(
  p_since timestamp with time zone DEFAULT (now() - interval '7 days'),
  p_pending_age interval DEFAULT interval '5 minutes'
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH settlements AS (
    SELECT * FROM public.capacity_execution_settlements
    WHERE created_at >= p_since
  ), status_counts AS (
    SELECT status, count(*) AS count
    FROM settlements GROUP BY status
  ), resources AS (
    SELECT events.resource,
      sum(events.units) AS units,
      sum(events.amount_light) AS amount_light,
      count(*) AS events
    FROM public.capacity_resource_events AS events
    JOIN settlements ON settlements.id = events.settlement_id
    GROUP BY events.resource
  ), missing_sources AS (
    SELECT missing.source, count(*) AS count
    FROM settlements
    CROSS JOIN LATERAL unnest(settlements.expected_cpu_sources) AS missing(source)
    WHERE NOT (missing.source = ANY(settlements.observed_cpu_sources))
    GROUP BY missing.source
  )
  SELECT jsonb_build_object(
    'since', p_since,
    'generated_at', now(),
    'settlements', COALESCE((
      SELECT jsonb_object_agg(status, count) FROM status_counts
    ), '{}'::jsonb),
    'resource_light', COALESCE((
      SELECT jsonb_object_agg(resource, jsonb_build_object(
        'units', units, 'amount_light', amount_light, 'events', events
      )) FROM resources
    ), '{}'::jsonb),
    'pending_old_count', (
      SELECT count(*) FROM settlements
      WHERE status <> 'final' AND created_at < now() - p_pending_age
    ),
    'oldest_pending_at', (
      SELECT min(created_at) FROM settlements WHERE status <> 'final'
    ),
    'partial_cpu_count', (
      SELECT count(*) FROM settlements WHERE status = 'observed'
    ),
    'missing_cpu_sources', COALESCE((
      SELECT jsonb_object_agg(source, count) FROM missing_sources
    ), '{}'::jsonb),
    'expected_cpu_observations', (
      SELECT COALESCE(sum(cardinality(expected_cpu_sources)), 0)
      FROM settlements
    ),
    'observed_cpu_observations', (
      SELECT COALESCE(sum(cardinality(observed_cpu_sources)), 0)
      FROM settlements
    ),
    'duplicate_observations', (
      SELECT COALESCE(sum(duplicate_observations), 0) FROM settlements
    ),
    'observed_cpu_ms', (
      SELECT COALESCE(sum(observed_cpu_ms), 0) FROM settlements
    ),
    'observed_wall_time_ms', (
      SELECT COALESCE(sum(observed_wall_time_ms), 0) FROM settlements
    ),
    'total_light', (
      SELECT COALESCE(sum(total_light), 0) FROM settlements
    ),
    'attribution_pending_count', (
      SELECT count(*) FROM settlements
      WHERE (attributed_light IS NULL OR attributed_light < total_light)
        AND created_at < now() - p_pending_age
    ),
    'attribution_oldest_pending_at', (
      SELECT min(created_at) FROM settlements
      WHERE attributed_light IS NULL OR attributed_light < total_light
    ),
    'dynamic_worker_daily_identities', (
      SELECT count(*) FROM public.capacity_dynamic_worker_identities
      WHERE created_at >= p_since
    ),
    'inbox_pending_count', (
      SELECT count(*) FROM public.capacity_cpu_observation_inbox
      WHERE status = 'pending'
    ),
    'inbox_oldest_pending_at', (
      SELECT min(created_at) FROM public.capacity_cpu_observation_inbox
      WHERE status = 'pending'
    ),
    'inbox_error_count', (
      SELECT count(*) FROM public.capacity_cpu_observation_inbox
      WHERE status = 'pending'
        AND last_error IS NOT NULL
        AND last_error NOT IN (
          'settlement_not_ready', 'attribution_not_ready'
        )
    ),
    'inbox_attempts', (
      SELECT COALESCE(sum(attempts), 0)
      FROM public.capacity_cpu_observation_inbox
    ),
    'inbox_pending_over_age', (
      SELECT count(*) FROM public.capacity_cpu_observation_inbox
      WHERE status = 'pending' AND created_at < now() - p_pending_age
    )
  )
$$;

REVOKE ALL ON FUNCTION public.reserve_account_capacity_v3(
  uuid, uuid, text, double precision, timestamp with time zone, boolean, uuid,
  uuid, jsonb, timestamp with time zone, integer, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_account_capacity_resources(
  uuid, uuid, text, text, double precision, double precision, text, text,
  double precision, double precision, integer, double precision, integer,
  timestamp with time zone, boolean, text[], jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_capacity_settlement_attribution(
  text, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_observed_capacity_cpu(
  text, text, double precision, double precision, timestamp with time zone,
  text, boolean, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingest_capacity_cpu_observation(
  text, text, double precision, double precision, timestamp with time zone,
  text, boolean, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_capacity_cpu_observations(
  integer, timestamp with time zone
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_capacity_reconciliation_summary(
  timestamp with time zone, interval
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_account_capacity_v3(
  uuid, uuid, text, double precision, timestamp with time zone, boolean, uuid,
  uuid, jsonb, timestamp with time zone, integer, integer, integer, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_account_capacity_resources(
  uuid, uuid, text, text, double precision, double precision, text, text,
  double precision, double precision, integer, double precision, integer,
  timestamp with time zone, boolean, text[], jsonb, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_capacity_settlement_attribution(
  text, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_observed_capacity_cpu(
  text, text, double precision, double precision, timestamp with time zone,
  text, boolean, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_capacity_cpu_observation(
  text, text, double precision, double precision, timestamp with time zone,
  text, boolean, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_capacity_cpu_observations(
  integer, timestamp with time zone
) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_capacity_reconciliation_summary(
  timestamp with time zone, interval
) TO service_role;
