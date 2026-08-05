-- Bounded, service-only persistence evidence for a deployed Compute canary.
--
-- This projection deliberately emits only invariant-bearing identifiers,
-- state, accounting, aggregate token facts, and sanitized artifact metadata.
-- It is not an execution-log or internal worker-debugging endpoint.

CREATE OR REPLACE FUNCTION public.get_compute_certification_snapshot(
  p_owner_id uuid,
  p_agent_id uuid,
  p_run_ids uuid[],
  p_since timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_cutoff timestamptz := statement_timestamp() - interval '5 minutes';
  v_latch_state text := 'clear';
  v_runs jsonb := '[]'::jsonb;
  v_run record;

  v_budget_rows integer;
  v_budget jsonb;
  v_budget_hold boolean;
  v_budget_hold_present boolean;
  v_budget_capacity_reservation boolean;
  v_budget_capacity_reservation_present boolean;
  v_budget_matches_run_capacity boolean;
  v_budget_owner_match boolean;
  v_budget_capacity_agent_match boolean;
  v_budget_mode_match boolean;
  v_budget_accounting_valid boolean;
  v_run_capacity_reservation boolean;

  v_receipt_rows integer;
  v_receipt jsonb;
  v_receipt_hold boolean;
  v_receipt_hold_present boolean;
  v_receipt_capacity_reservation boolean;
  v_receipt_capacity_reservation_present boolean;
  v_receipt_cloud_usage_event boolean;
  v_receipt_cloud_usage_event_present boolean;
  v_receipt_matches_run_capacity boolean;
  v_receipt_matches_budget_hold boolean;
  v_receipt_principal_match boolean;
  v_receipt_capacity_agent_match boolean;
  v_receipt_mode_match boolean;
  v_receipt_accounting_valid boolean;

  v_token_rows integer;
  v_active_token_rows integer;
  v_artifact_rows integer;
  v_input_artifact_rows integer;
  v_output_artifact_rows integer;
  v_projected_artifact_rows integer;
  v_artifacts jsonb;
  v_artifact_integrity_valid boolean;
  v_accounting_valid boolean;
  v_backing_valid boolean;
  v_timestamp_valid boolean;
  v_run_violations text[];

  v_stale_nonterminal_runs integer;
  v_old_settlement_pending integer;
  v_terminal_reserved_budgets integer;
  v_receipt_mismatches integer;
  v_terminal_active_tokens integer;
  v_dlq_fenced_runs integer;
  v_stale_pending_artifacts integer;
  v_unreconciled_deleted_outputs integer;
  v_terminal_input_aliases integer;
  v_health_violations text[] := ARRAY[]::text[];
  v_top_violations text[] := ARRAY[]::text[];
  v_selected_run_count integer;
BEGIN
  IF p_owner_id IS NULL OR p_agent_id IS NULL OR p_run_ids IS NULL
     OR p_since IS NULL OR cardinality(p_run_ids) < 1
     OR cardinality(p_run_ids) > 20 OR p_since > v_now
     OR p_since < v_now - interval '24 hours'
     OR EXISTS (SELECT 1 FROM unnest(p_run_ids) AS requested(id) WHERE id IS NULL)
     OR EXISTS (
       SELECT 1
       FROM unnest(p_run_ids) AS requested(id)
       GROUP BY requested.id
       HAVING count(*) > 1
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'Invalid bounded Compute certification snapshot input.';
  END IF;

  SELECT operation.status
  INTO v_latch_state
  FROM public.compute_emergency_stop_operations AS operation
  WHERE operation.status IN ('active', 'completed')
  LIMIT 1;
  v_latch_state := COALESCE(v_latch_state, 'clear');

  FOR v_run IN
    SELECT requested.ordinality, run.*
    FROM unnest(p_run_ids) WITH ORDINALITY AS requested(run_id, ordinality)
    JOIN public.compute_runs AS run ON run.id = requested.run_id
    WHERE run.user_id = p_owner_id AND run.agent_id = p_agent_id
      AND run.created_at >= p_since AND run.created_at <= v_now
    ORDER BY requested.ordinality
  LOOP
    SELECT count(*)::integer,
      CASE WHEN count(*) = 1 THEN
        (jsonb_agg(jsonb_build_object(
          'status', budget.status,
          'billing_mode', budget.billing_mode,
          'rate_version', budget.rate_version,
          'rate_light_per_ms', budget.rate_light_per_ms::text,
          'actual_wall_ms', budget.actual_wall_ms::text,
          'reserved_wall_ms', budget.reserved_wall_ms::text,
          'teardown_allowance_ms', budget.teardown_allowance_ms::text,
          'reserved_light', budget.reserved_light::text,
          'actual_light', budget.actual_light::text,
          'released_light', budget.released_light::text,
          'expires_at', budget.expires_at,
          'settled_at', budget.settled_at
        ) ORDER BY budget.id) -> 0)
      ELSE NULL END,
      COALESCE(bool_or(EXISTS (
        SELECT 1
        FROM public.cloud_usage_holds AS hold
        WHERE hold.id = budget.hold_id
          AND budget.billing_mode = 'wallet'
          AND hold.payer_user_id = v_run.user_id
          AND hold.caller_user_id = v_run.user_id
          AND hold.owner_user_id = v_run.user_id
          AND hold.app_id = v_run.agent_id
          AND hold.function_name = v_run.caller_function
          AND hold.receipt_id = 'compute-run:' || v_run.id::text
          AND hold.source = 'galactic_compute'
          AND hold.resource = 'worker_execution'
          AND hold.metadata->>'run_id' = v_run.id::text
          AND hold.expected_units::numeric(28,12) =
            budget.reserved_wall_ms::numeric(28,12)
          AND hold.expected_cloud_units::numeric(28,12) =
            budget.reserved_wall_ms::numeric(28,12)
          AND hold.expected_amount_light::numeric(28,12) =
            budget.reserved_light
          AND hold.held_amount_light::numeric(28,12) =
            budget.reserved_light
          AND (
            (budget.status = 'reserved' AND hold.status = 'held')
            OR (
              budget.status = 'released'
              AND hold.status = 'released'
              AND hold.settlement_event_id IS NULL
              AND hold.settled_amount_light::numeric(28,12) = 0
              AND hold.released_amount_light::numeric(28,12) =
                budget.released_light
            )
            OR (
              budget.status = 'settled'
              AND hold.status = 'settled'
              AND hold.settlement_event_id IS NOT NULL
              AND hold.settled_amount_light::numeric(28,12) =
                budget.actual_light
              AND hold.released_amount_light::numeric(28,12) =
                budget.released_light
            )
          )
      )), false),
      COALESCE(bool_or(budget.hold_id IS NOT NULL), false),
      COALESCE(bool_or(EXISTS (
        SELECT 1
        FROM public.account_capacity_reservations AS reservation
        WHERE reservation.id = budget.capacity_reservation_id
          AND budget.billing_mode = 'subscription_capacity'
          AND reservation.user_id = v_run.user_id
          AND reservation.capacity_agent_id = v_run.capacity_agent_id
          AND reservation.metadata->>'compute_run_id' = v_run.id::text
          AND reservation.reserved_light::numeric(28,12) =
            budget.reserved_light
          AND (
            (
              budget.status = 'reserved'
              AND reservation.status = 'reserved'
              AND reservation.actual_light IS NULL
            )
            OR (
              budget.status = 'settled'
              AND reservation.status = 'settled'
              AND reservation.actual_light::numeric(28,12) =
                budget.actual_light
            )
          )
      )), false),
      COALESCE(bool_or(
        budget.capacity_reservation_id IS NOT NULL
      ), false),
      COALESCE(bool_and(
        budget.capacity_reservation_id IS NOT DISTINCT FROM
          v_run.capacity_reservation_id
      ), true),
      COALESCE(bool_and(budget.user_id = v_run.user_id), true),
      COALESCE(bool_and(
        budget.capacity_agent_id = v_run.capacity_agent_id
      ), true),
      COALESCE(bool_and(budget.billing_mode = v_run.billing_mode), true),
      COALESCE(bool_and(
        budget.released_light <= budget.reserved_light
        AND (
          (
            budget.billing_mode = 'wallet'
            AND budget.status <> 'settlement_pending'
            AND budget.actual_light <= budget.reserved_light
            AND (
              budget.status = 'reserved'
              OR budget.actual_light + budget.released_light =
                budget.reserved_light
            )
          )
          OR (
            budget.billing_mode = 'subscription_capacity'
            AND (
              (
                budget.status = 'reserved'
                AND budget.actual_light = 0
                AND budget.released_light = 0
              )
              OR (
                budget.status <> 'reserved'
                AND budget.released_light = GREATEST(
                  budget.reserved_light - budget.actual_light,
                  0
                )
              )
            )
          )
        )
      ), true)
    INTO v_budget_rows, v_budget, v_budget_hold, v_budget_hold_present,
      v_budget_capacity_reservation,
      v_budget_capacity_reservation_present, v_budget_matches_run_capacity,
      v_budget_owner_match, v_budget_capacity_agent_match,
      v_budget_mode_match, v_budget_accounting_valid
    FROM public.compute_run_budget_reservations AS budget
    WHERE budget.run_id = v_run.id;

    SELECT count(*)::integer,
      CASE WHEN count(*) = 1 THEN
        (jsonb_agg(jsonb_build_object(
          'id', receipt.id,
          'outcome', receipt.outcome,
          'billing_mode', receipt.billing_mode,
          'rate_version', receipt.rate_version,
          'capacity_settlement_status', receipt.capacity_settlement_status,
          'reserved_light', receipt.reserved_light::text,
          'actual_light', receipt.actual_light::text,
          'released_light', receipt.released_light::text,
          'worker_wall_ms', receipt.worker_wall_ms::text,
          'teardown_allowance_ms', receipt.teardown_allowance_ms::text,
          'billed_wall_ms', receipt.billed_wall_ms::text,
          'created_at', receipt.created_at
        ) ORDER BY receipt.id) -> 0)
      ELSE NULL END,
      COALESCE(bool_or(EXISTS (
        SELECT 1
        FROM public.cloud_usage_holds AS hold
        LEFT JOIN public.compute_run_budget_reservations AS budget
          ON budget.run_id = receipt.run_id
        WHERE hold.id = receipt.hold_id
          AND receipt.billing_mode = 'wallet'
          AND budget.hold_id = hold.id
          AND hold.payer_user_id = receipt.user_id
          AND hold.caller_user_id = receipt.user_id
          AND hold.owner_user_id = receipt.user_id
          AND hold.app_id = receipt.agent_id
          AND hold.function_name = v_run.caller_function
          AND hold.receipt_id = 'compute-run:' || receipt.run_id::text
          AND hold.source = 'galactic_compute'
          AND hold.resource = 'worker_execution'
          AND hold.metadata->>'run_id' = receipt.run_id::text
          AND (
            (
              receipt.worker_wall_ms IS NULL
              AND hold.status = 'released'
              AND hold.settlement_event_id IS NULL
              AND hold.settled_amount_light::numeric(28,12) = 0
              AND hold.released_amount_light::numeric(28,12) =
                receipt.released_light
            )
            OR (
              receipt.worker_wall_ms IS NOT NULL
              AND hold.status = 'settled'
              AND hold.settlement_event_id = receipt.cloud_usage_event_id
              AND hold.settled_amount_light::numeric(28,12) =
                receipt.actual_light
              AND hold.released_amount_light::numeric(28,12) =
                receipt.released_light
            )
          )
      )), false),
      COALESCE(bool_or(receipt.hold_id IS NOT NULL), false),
      COALESCE(bool_or(EXISTS (
        SELECT 1
        FROM public.account_capacity_reservations AS reservation
        JOIN public.compute_run_budget_reservations AS budget
          ON budget.run_id = receipt.run_id
        WHERE reservation.id = receipt.capacity_reservation_id
          AND receipt.billing_mode = 'subscription_capacity'
          AND budget.capacity_reservation_id = reservation.id
          AND reservation.user_id = receipt.user_id
          AND reservation.capacity_agent_id = receipt.capacity_agent_id
          AND reservation.metadata->>'compute_run_id' = receipt.run_id::text
          AND reservation.status = 'settled'
          AND budget.status = 'settled'
          AND receipt.capacity_settlement_status = 'settled'
          AND reservation.reserved_light::numeric(28,12) =
            receipt.reserved_light
          AND reservation.actual_light::numeric(28,12) =
            receipt.actual_light
      )), false),
      COALESCE(bool_or(
        receipt.capacity_reservation_id IS NOT NULL
      ), false),
      COALESCE(bool_or(EXISTS (
        SELECT 1
        FROM public.cloud_usage_events AS event
        JOIN public.cloud_usage_holds AS hold ON hold.id = event.hold_id
        WHERE event.id = receipt.cloud_usage_event_id
          AND receipt.billing_mode = 'wallet'
          AND receipt.worker_wall_ms IS NOT NULL
          AND event.hold_id = receipt.hold_id
          AND hold.settlement_event_id = event.id
          AND hold.status = 'settled'
          AND event.payer_user_id = receipt.user_id
          AND event.caller_user_id = receipt.user_id
          AND event.owner_user_id = receipt.user_id
          AND event.app_id = receipt.agent_id
          AND event.function_name = v_run.caller_function
          AND event.receipt_id = 'compute-run:' || receipt.run_id::text
          AND event.source = 'galactic_compute'
          AND event.resource = 'worker_execution'
          AND event.metadata->>'run_id' = receipt.run_id::text
          AND event.units::numeric(28,12) =
            receipt.billed_wall_ms::numeric(28,12)
          AND event.cloud_units::numeric(28,12) =
            receipt.billed_wall_ms::numeric(28,12)
          AND event.amount_light::numeric(28,12) = receipt.actual_light
      )), false),
      COALESCE(bool_or(receipt.cloud_usage_event_id IS NOT NULL), false),
      COALESCE(bool_and(
        receipt.capacity_reservation_id IS NOT DISTINCT FROM
          v_run.capacity_reservation_id
      ), true),
      COALESCE(bool_and(
        receipt.user_id = v_run.user_id
        AND receipt.agent_id = v_run.agent_id
      ), true),
      COALESCE(bool_and(
        receipt.capacity_agent_id = v_run.capacity_agent_id
      ), true),
      COALESCE(bool_and(receipt.billing_mode = v_run.billing_mode), true),
      COALESCE(bool_and(
        receipt.released_light <= receipt.reserved_light
        AND (
          (
            receipt.billing_mode = 'wallet'
            AND receipt.actual_light <= receipt.reserved_light
            AND receipt.actual_light + receipt.released_light =
              receipt.reserved_light
          )
          OR (
            receipt.billing_mode = 'subscription_capacity'
            AND receipt.released_light = GREATEST(
              receipt.reserved_light - receipt.actual_light,
              0
            )
          )
        )
      ), true)
    INTO v_receipt_rows, v_receipt, v_receipt_hold, v_receipt_hold_present,
      v_receipt_capacity_reservation,
      v_receipt_capacity_reservation_present,
      v_receipt_cloud_usage_event, v_receipt_cloud_usage_event_present,
      v_receipt_matches_run_capacity, v_receipt_principal_match,
      v_receipt_capacity_agent_match, v_receipt_mode_match,
      v_receipt_accounting_valid
    FROM public.compute_run_receipts AS receipt
    WHERE receipt.run_id = v_run.id;

    v_run_capacity_reservation := v_run.capacity_reservation_id IS NOT NULL
      AND v_budget_capacity_reservation;

    SELECT NOT EXISTS (
      SELECT 1
      FROM public.compute_run_receipts AS receipt
      LEFT JOIN public.compute_run_budget_reservations AS budget
        ON budget.run_id = receipt.run_id
      WHERE receipt.run_id = v_run.id
        AND receipt.hold_id IS DISTINCT FROM budget.hold_id
    ) INTO v_receipt_matches_budget_hold;

    SELECT count(*)::integer,
      count(*) FILTER (WHERE token.status = 'active')::integer
    INTO v_token_rows, v_active_token_rows
    FROM public.compute_job_tokens AS token
    WHERE token.run_id = v_run.id;

    SELECT count(*)::integer,
      count(*) FILTER (WHERE artifact.direction = 'input')::integer,
      count(*) FILTER (WHERE artifact.direction = 'output')::integer,
      COALESCE(bool_and(
        (artifact.sha256 IS NULL) = (artifact.size_bytes IS NULL)
        AND (
          artifact.state <> 'ready'
          OR (
            artifact.sha256 IS NOT NULL
            AND artifact.size_bytes IS NOT NULL
            AND artifact.expires_at IS NOT NULL
            AND artifact.object_deleted_at IS NULL
          )
        )
        AND (
          artifact.object_deleted_at IS NULL
          OR (
            artifact.direction = 'output'
            AND artifact.state = 'deleted'
          )
        )
        AND (artifact.direction <> 'input' OR artifact.state <> 'pending')
        AND (artifact.direction <> 'input' OR artifact.object_deleted_at IS NULL)
        AND (artifact.state <> 'pending' OR artifact.object_deleted_at IS NULL)
      ), true)
    INTO v_artifact_rows, v_input_artifact_rows,
      v_output_artifact_rows, v_artifact_integrity_valid
    FROM public.compute_artifacts AS artifact
    WHERE artifact.run_id = v_run.id;

    SELECT COALESCE(jsonb_agg(projected.item
        ORDER BY projected.direction, projected.artifact_id), '[]'::jsonb)
    INTO v_artifacts
    FROM (
      SELECT artifact.direction, artifact.id AS artifact_id,
        jsonb_build_object(
          'artifact_id', artifact.id,
          'direction', artifact.direction,
          'state', artifact.state,
          'state_version', artifact.state_version::text,
          'sha256', artifact.sha256,
          'size_bytes', artifact.size_bytes::text,
          'expires_at', artifact.expires_at,
          'object_deleted', artifact.object_deleted_at IS NOT NULL
        ) AS item
      FROM public.compute_artifacts AS artifact
      WHERE artifact.run_id = v_run.id
      ORDER BY artifact.direction, artifact.id
      LIMIT 100
    ) AS projected;
    v_projected_artifact_rows := jsonb_array_length(v_artifacts);

    v_accounting_valid := v_budget_accounting_valid
      AND v_receipt_accounting_valid
      AND (
        v_budget_rows <> 1
        OR (
          v_budget->>'rate_version' = 'compute-rate-v1'
          AND (v_budget->>'rate_light_per_ms')::numeric = 0.000002056
          AND (v_budget->>'teardown_allowance_ms')::bigint = 15000
          AND (v_budget->>'reserved_wall_ms')::bigint > 0
          AND (v_budget->>'reserved_light')::numeric = (
            (v_budget->>'reserved_wall_ms')::bigint *
              (v_budget->>'rate_light_per_ms')::numeric
          )::numeric(28,12)
          AND (
            v_budget->>'status' <> 'reserved'
            OR (
              v_budget->>'actual_wall_ms' IS NULL
              AND (v_budget->>'actual_light')::numeric = 0
              AND (v_budget->>'released_light')::numeric = 0
            )
          )
        )
      )
      AND (
        v_receipt_rows <> 1
        OR v_receipt->>'rate_version' = 'compute-rate-v1'
      )
      AND (
        v_receipt_rows = 1 OR v_budget_rows <> 1
        OR v_budget->>'status' = 'reserved'
      )
      AND (
        v_receipt_rows <> 1
        OR (
          (
            v_receipt->>'worker_wall_ms' IS NULL
            AND v_run.started_at IS NULL
            AND (v_receipt->>'billed_wall_ms')::bigint = 0
            AND (v_receipt->>'actual_light')::numeric = 0
            AND (
              (
                v_budget_rows = 0
                AND (v_receipt->>'teardown_allowance_ms')::bigint = 0
                AND (v_receipt->>'reserved_light')::numeric = 0
                AND (v_receipt->>'released_light')::numeric = 0
              )
              OR (
                v_budget_rows = 1
                AND v_budget->>'actual_wall_ms' IS NULL
                AND (v_budget->>'actual_light')::numeric = 0
                AND v_budget->>'reserved_light' =
                  v_budget->>'released_light'
                AND v_receipt->>'teardown_allowance_ms' =
                  v_budget->>'teardown_allowance_ms'
              )
            )
          )
          OR (
            v_receipt->>'worker_wall_ms' IS NOT NULL
            AND v_run.started_at IS NOT NULL
            AND v_budget_rows = 1
            AND v_budget->>'actual_wall_ms' =
              v_receipt->>'worker_wall_ms'
            AND v_receipt->>'teardown_allowance_ms' =
              v_budget->>'teardown_allowance_ms'
            AND (v_receipt->>'billed_wall_ms')::bigint = CASE
              WHEN v_run.billing_mode = 'wallet' THEN LEAST(
                (v_receipt->>'worker_wall_ms')::bigint,
                (v_budget->>'reserved_wall_ms')::bigint
              )
              ELSE (v_receipt->>'worker_wall_ms')::bigint
            END
            AND (v_receipt->>'actual_light')::numeric = (
              (v_receipt->>'billed_wall_ms')::bigint *
                (v_budget->>'rate_light_per_ms')::numeric
            )::numeric(28,12)
          )
        )
      )
      AND (
        v_budget_rows <> 1 OR v_receipt_rows <> 1
        OR (
          v_budget->>'reserved_light' = v_receipt->>'reserved_light'
          AND v_budget->>'actual_light' = v_receipt->>'actual_light'
          AND v_budget->>'released_light' = v_receipt->>'released_light'
        )
      )
      AND (
        v_receipt_rows <> 1
        OR (
          v_run.billing_mode = 'wallet'
          AND (
            (
              v_receipt->>'worker_wall_ms' IS NULL
              AND (
                (v_budget_rows = 0)
                OR v_budget->>'status' = 'released'
              )
            )
            OR (
              v_receipt->>'worker_wall_ms' IS NOT NULL
              AND v_budget_rows = 1
              AND v_budget->>'status' = 'settled'
            )
          )
        )
        OR (
          v_run.billing_mode = 'subscription_capacity'
          AND (
            (
              v_budget_rows = 0
              AND v_receipt->>'capacity_settlement_status' =
                'not_applicable'
            )
            OR (
              v_budget_rows = 1
              AND (
                (
                  v_budget->>'status' = 'settlement_pending'
                  AND v_receipt->>'capacity_settlement_status' = 'pending'
                )
                OR (
                  v_budget->>'status' = 'settled'
                  AND v_receipt->>'capacity_settlement_status' = 'settled'
                )
              )
            )
          )
        )
      );

    v_backing_valid :=
      (v_run.billing_mode <> 'wallet'
        OR v_run.capacity_reservation_id IS NULL)
      AND (
        v_run.billing_mode <> 'subscription_capacity'
        OR (
          v_budget_rows = 0
          AND v_run.capacity_reservation_id IS NULL
        )
        OR (v_budget_rows = 1 AND v_run_capacity_reservation)
      )
      AND (
        (v_run.started_at IS NULL AND v_run.state <> 'succeeded')
        OR (v_budget_rows = 1 AND v_token_rows >= 1)
      )
      AND (
        v_budget_rows <> 1
        OR (
          v_budget_owner_match
          AND v_budget_capacity_agent_match
          AND v_budget_matches_run_capacity
          AND (
            (
              v_run.billing_mode = 'wallet'
              AND v_budget_hold_present
              AND v_budget_hold
              AND NOT v_budget_capacity_reservation_present
              AND NOT v_budget_capacity_reservation
            )
            OR (
              v_run.billing_mode = 'subscription_capacity'
              AND NOT v_budget_hold_present
              AND NOT v_budget_hold
              AND v_budget_capacity_reservation_present
              AND v_budget_capacity_reservation
              AND v_run.capacity_reservation_id IS NOT NULL
            )
          )
        )
      )
      AND (
        v_receipt_rows <> 1
        OR (
          v_receipt_principal_match
          AND v_receipt_capacity_agent_match
          AND v_receipt_matches_run_capacity
          AND v_receipt_matches_budget_hold
          AND (
            (
              v_run.billing_mode = 'wallet'
              AND v_receipt_hold_present = (v_budget_rows = 1)
              AND v_receipt_hold = (v_budget_rows = 1)
              AND v_receipt_cloud_usage_event_present =
                (v_receipt->>'worker_wall_ms' IS NOT NULL)
              AND v_receipt_cloud_usage_event =
                (v_receipt->>'worker_wall_ms' IS NOT NULL)
              AND NOT v_receipt_capacity_reservation_present
              AND NOT v_receipt_capacity_reservation
              AND v_receipt->>'capacity_settlement_status' = 'not_applicable'
            )
            OR (
              v_run.billing_mode = 'subscription_capacity'
              AND NOT v_receipt_hold_present
              AND NOT v_receipt_hold
              AND NOT v_receipt_cloud_usage_event_present
              AND NOT v_receipt_cloud_usage_event
              AND (
                (
                  v_receipt_capacity_reservation_present
                  AND v_receipt_capacity_reservation
                  AND v_receipt->>'capacity_settlement_status' = 'settled'
                )
                OR (
                  NOT v_receipt_capacity_reservation_present
                  AND NOT v_receipt_capacity_reservation
                  AND v_receipt->>'capacity_settlement_status' =
                    'not_applicable'
                )
              )
            )
          )
        )
      );

    v_timestamp_valid :=
      v_run.created_at <= v_run.updated_at
      AND v_run.expires_at > v_run.created_at
      AND (
        v_run.started_at IS NULL
        OR (
          v_run.started_at >= v_run.created_at
          AND v_run.started_at <= v_run.updated_at
        )
      )
      AND (
        (v_run.state IN (
          'succeeded', 'failed', 'cancelled', 'expired', 'revoked'
        )) = (v_run.finished_at IS NOT NULL)
      )
      AND (v_run.state <> 'succeeded' OR v_run.started_at IS NOT NULL)
      AND (
        v_run.finished_at IS NULL
        OR (
          v_run.finished_at >= v_run.created_at
          AND v_run.finished_at <= v_run.updated_at
          AND (
            v_run.started_at IS NULL
            OR v_run.finished_at >= v_run.started_at
          )
        )
      );

    v_run_violations := ARRAY[]::text[];
    IF NOT v_accounting_valid THEN
      v_run_violations := array_append(
        v_run_violations, 'ACCOUNTING_CONSERVATION_INVALID'
      );
    END IF;
    IF v_artifact_rows <> v_input_artifact_rows + v_output_artifact_rows
       OR v_projected_artifact_rows > v_artifact_rows THEN
      v_run_violations := array_append(
        v_run_violations, 'ARTIFACT_CARDINALITY_INVALID'
      );
    END IF;
    IF NOT v_artifact_integrity_valid THEN
      v_run_violations := array_append(
        v_run_violations, 'ARTIFACT_INTEGRITY_INVALID'
      );
    END IF;
    IF v_projected_artifact_rows < v_artifact_rows THEN
      v_run_violations := array_append(
        v_run_violations, 'ARTIFACT_PROJECTION_TRUNCATED'
      );
    END IF;
    IF NOT v_backing_valid THEN
      v_run_violations := array_append(
        v_run_violations, 'BILLING_BACKING_INVALID'
      );
    END IF;
    IF NOT v_budget_mode_match OR NOT v_receipt_mode_match THEN
      v_run_violations := array_append(
        v_run_violations, 'BILLING_MODE_MISMATCH'
      );
    END IF;
    IF v_budget_rows > 1 OR (
      (v_run.started_at IS NOT NULL OR v_run.state = 'succeeded')
      AND v_budget_rows <> 1
    ) THEN
      v_run_violations := array_append(
        v_run_violations, 'BUDGET_CARDINALITY_INVALID'
      );
    END IF;
    IF (
      v_run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
      AND v_receipt_rows <> 1
    ) OR (
      v_run.state NOT IN (
        'succeeded', 'failed', 'cancelled', 'expired', 'revoked'
      ) AND v_receipt_rows <> 0
    ) THEN
      v_run_violations := array_append(
        v_run_violations, 'RECEIPT_CARDINALITY_INVALID'
      );
    END IF;
    IF v_receipt_rows = 1
       AND (v_receipt->>'id')::uuid IS DISTINCT FROM v_run.receipt_id THEN
      v_run_violations := array_append(
        v_run_violations, 'RECEIPT_ID_MISMATCH'
      );
    END IF;
    IF v_receipt_rows = 1
       AND v_receipt->>'outcome' IS DISTINCT FROM v_run.state THEN
      v_run_violations := array_append(
        v_run_violations, 'RECEIPT_OUTCOME_MISMATCH'
      );
    END IF;
    IF v_run.state IN (
      'succeeded', 'failed', 'cancelled', 'expired', 'revoked'
    ) AND v_active_token_rows > 0 THEN
      v_run_violations := array_append(
        v_run_violations, 'TERMINAL_ACTIVE_TOKEN'
      );
    END IF;
    IF NOT v_timestamp_valid THEN
      v_run_violations := array_append(
        v_run_violations, 'TERMINAL_TIMESTAMP_INVALID'
      );
    END IF;

    v_runs := v_runs || jsonb_build_array(jsonb_build_object(
      'run_id', v_run.id,
      'receipt_id', v_run.receipt_id,
      'owner_id', v_run.user_id,
      'agent_id', v_run.agent_id,
      'caller_function', v_run.caller_function,
      'state', v_run.state,
      'state_version', v_run.state_version::text,
      'billing_mode', v_run.billing_mode,
      'capacity_agent_id', v_run.capacity_agent_id,
      'environment_digest', v_run.environment_digest,
      'directive_hash', v_run.directive_hash,
      'request_hash', v_run.request_hash,
      'created_at', v_run.created_at,
      'updated_at', v_run.updated_at,
      'expires_at', v_run.expires_at,
      'started_at', v_run.started_at,
      'finished_at', v_run.finished_at,
      'cardinality', jsonb_build_object(
        'budget_rows', v_budget_rows,
        'receipt_rows', v_receipt_rows,
        'token_rows', v_token_rows,
        'artifact_rows', v_artifact_rows,
        'input_artifact_rows', v_input_artifact_rows,
        'output_artifact_rows', v_output_artifact_rows,
        'projected_artifact_rows', v_projected_artifact_rows
      ),
      'backing', jsonb_build_object(
        'run_capacity_reservation',
          v_run_capacity_reservation,
        'budget_hold', v_budget_hold,
        'budget_capacity_reservation', v_budget_capacity_reservation,
        'receipt_hold', v_receipt_hold,
        'receipt_capacity_reservation', v_receipt_capacity_reservation,
        'receipt_cloud_usage_event', v_receipt_cloud_usage_event,
        'budget_matches_run_capacity', v_budget_matches_run_capacity,
        'receipt_matches_run_capacity', v_receipt_matches_run_capacity,
        'receipt_matches_budget_hold', v_receipt_matches_budget_hold,
        'budget_owner_match', v_budget_owner_match,
        'budget_capacity_agent_match', v_budget_capacity_agent_match,
        'receipt_principal_match', v_receipt_principal_match,
        'receipt_capacity_agent_match', v_receipt_capacity_agent_match
      ),
      'budget', v_budget,
      'receipt', v_receipt,
      'terminal_active_token_count', v_active_token_rows,
      'artifacts', v_artifacts,
      'violations', to_jsonb(v_run_violations)
    ));
  END LOOP;

  SELECT count(*)::integer
  INTO v_stale_nonterminal_runs
  FROM public.compute_runs AS run
  WHERE run.user_id = p_owner_id AND run.agent_id = p_agent_id
    AND run.created_at >= p_since
    AND (
      (
        run.state IN ('admitted', 'queued')
        AND run.expires_at <= v_now
      )
      OR (
        run.state IN ('provisioning', 'running')
        AND (
          run.claim_expires_at <= v_now
          OR run.expires_at <= v_now
        )
      )
    );

  SELECT count(*)::integer
  INTO v_old_settlement_pending
  FROM public.compute_runs AS run
  WHERE run.user_id = p_owner_id AND run.agent_id = p_agent_id
    AND run.created_at >= p_since
    AND (
      EXISTS (
        SELECT 1
        FROM public.compute_run_receipts AS receipt
        WHERE receipt.run_id = run.id
          AND receipt.capacity_settlement_status = 'pending'
          AND receipt.created_at <= v_cutoff
      )
      OR EXISTS (
        SELECT 1
        FROM public.compute_run_budget_reservations AS budget
        WHERE budget.run_id = run.id
          AND budget.status = 'settlement_pending'
          AND budget.updated_at <= v_cutoff
      )
    );

  SELECT count(*)::integer
  INTO v_terminal_reserved_budgets
  FROM public.compute_run_budget_reservations AS budget
  JOIN public.compute_runs AS run ON run.id = budget.run_id
  WHERE run.user_id = p_owner_id AND run.agent_id = p_agent_id
    AND run.created_at >= p_since
    AND run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
    AND budget.status = 'reserved';

  -- Terminal runs require their exact canonical receipt. Any receipt on a
  -- nonterminal run is itself corruption and must be visible to certification.
  SELECT count(*)::integer
  INTO v_receipt_mismatches
  FROM public.compute_runs AS run
  LEFT JOIN public.compute_run_receipts AS receipt ON receipt.run_id = run.id
  WHERE run.user_id = p_owner_id AND run.agent_id = p_agent_id
    AND run.created_at >= p_since
    AND (
      (
        run.state IN (
          'succeeded', 'failed', 'cancelled', 'expired', 'revoked'
        )
        AND (
          receipt.id IS NULL
      OR receipt.id IS DISTINCT FROM run.receipt_id
      OR receipt.user_id IS DISTINCT FROM run.user_id
      OR receipt.agent_id IS DISTINCT FROM run.agent_id
      OR receipt.outcome IS DISTINCT FROM run.state
      OR receipt.billing_mode IS DISTINCT FROM run.billing_mode
      OR receipt.capacity_agent_id IS DISTINCT FROM run.capacity_agent_id
      OR receipt.capacity_reservation_id IS DISTINCT FROM
        run.capacity_reservation_id
      OR receipt.rate_version IS DISTINCT FROM 'compute-rate-v1'
      OR (receipt.worker_wall_ms IS NULL) IS DISTINCT FROM
        (run.started_at IS NULL)
      OR receipt.hold_id IS DISTINCT FROM (
        SELECT budget.hold_id
        FROM public.compute_run_budget_reservations AS budget
        WHERE budget.run_id = run.id
      )
      OR EXISTS (
        SELECT 1
        FROM public.compute_run_budget_reservations AS budget
        WHERE budget.run_id = run.id
          AND (
            budget.billing_mode IS DISTINCT FROM receipt.billing_mode
            OR budget.rate_version IS DISTINCT FROM 'compute-rate-v1'
            OR budget.rate_light_per_ms IS DISTINCT FROM 0.000002056
            OR budget.teardown_allowance_ms IS DISTINCT FROM 15000
            OR budget.reserved_light IS DISTINCT FROM
              (budget.reserved_wall_ms * budget.rate_light_per_ms)::numeric(28,12)
            OR budget.reserved_light IS DISTINCT FROM receipt.reserved_light
            OR budget.actual_light IS DISTINCT FROM receipt.actual_light
            OR budget.released_light IS DISTINCT FROM receipt.released_light
            OR budget.actual_wall_ms IS DISTINCT FROM receipt.worker_wall_ms
            OR budget.teardown_allowance_ms IS DISTINCT FROM
              receipt.teardown_allowance_ms
            OR (
              receipt.worker_wall_ms IS NULL
              AND (
                budget.actual_light <> 0
                OR budget.released_light <> budget.reserved_light
              )
            )
            OR (
              receipt.worker_wall_ms IS NOT NULL
              AND (
                receipt.billed_wall_ms IS DISTINCT FROM CASE
                  WHEN run.billing_mode = 'wallet' THEN LEAST(
                    receipt.worker_wall_ms,
                    budget.reserved_wall_ms
                  )
                  ELSE receipt.worker_wall_ms
                END
                OR receipt.actual_light IS DISTINCT FROM
                  (receipt.billed_wall_ms * budget.rate_light_per_ms)::numeric(28,12)
              )
            )
            OR (
              run.billing_mode = 'wallet'
              AND budget.status IS DISTINCT FROM CASE
                WHEN receipt.worker_wall_ms IS NULL THEN 'released'
                ELSE 'settled'
              END
            )
            OR (
              run.billing_mode = 'subscription_capacity'
              AND NOT (
                (budget.status = 'settlement_pending'
                  AND receipt.capacity_settlement_status = 'pending')
                OR (budget.status = 'settled'
                  AND receipt.capacity_settlement_status = 'settled')
              )
            )
          )
      )
      OR (
        NOT EXISTS (
          SELECT 1
          FROM public.compute_run_budget_reservations AS budget
          WHERE budget.run_id = run.id
        )
        AND (
          run.started_at IS NOT NULL
          OR run.state = 'succeeded'
          OR receipt.worker_wall_ms IS NOT NULL
          OR receipt.teardown_allowance_ms <> 0
          OR receipt.billed_wall_ms <> 0
          OR receipt.reserved_light <> 0
          OR receipt.actual_light <> 0
          OR receipt.released_light <> 0
        )
      )
      OR receipt.released_light > receipt.reserved_light
      OR (
        receipt.billing_mode = 'wallet'
        AND (
          receipt.actual_light > receipt.reserved_light
          OR receipt.actual_light + receipt.released_light <>
            receipt.reserved_light
        )
      )
      OR (
        receipt.billing_mode = 'subscription_capacity'
        AND receipt.released_light <> GREATEST(
          receipt.reserved_light - receipt.actual_light,
          0
        )
      )
      OR (
        run.billing_mode = 'wallet'
        AND (
          receipt.capacity_reservation_id IS NOT NULL
          OR receipt.capacity_settlement_status IS DISTINCT FROM
            'not_applicable'
          OR (receipt.hold_id IS NOT NULL) IS DISTINCT FROM (
            EXISTS (
              SELECT 1
              FROM public.compute_run_budget_reservations AS budget
              WHERE budget.run_id = run.id
            )
          )
          OR (receipt.cloud_usage_event_id IS NOT NULL) IS DISTINCT FROM
            (receipt.worker_wall_ms IS NOT NULL)
          OR (
            EXISTS (
              SELECT 1
              FROM public.compute_run_budget_reservations AS budget
              WHERE budget.run_id = run.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.compute_run_budget_reservations AS budget
              JOIN public.cloud_usage_holds AS hold
                ON hold.id = budget.hold_id
              LEFT JOIN public.cloud_usage_events AS event
                ON event.id = receipt.cloud_usage_event_id
              WHERE budget.run_id = run.id
                AND hold.payer_user_id = run.user_id
                AND hold.caller_user_id = run.user_id
                AND hold.owner_user_id = run.user_id
                AND hold.app_id = run.agent_id
                AND hold.function_name = run.caller_function
                AND hold.receipt_id = 'compute-run:' || run.id::text
                AND hold.source = 'galactic_compute'
                AND hold.resource = 'worker_execution'
                AND hold.metadata->>'run_id' = run.id::text
                AND hold.expected_units::numeric(28,12) =
                  budget.reserved_wall_ms::numeric(28,12)
                AND hold.held_amount_light::numeric(28,12) =
                  budget.reserved_light
                AND (
                  (
                    receipt.worker_wall_ms IS NULL
                    AND hold.status = 'released'
                    AND hold.settlement_event_id IS NULL
                    AND hold.settled_amount_light::numeric(28,12) = 0
                    AND hold.released_amount_light::numeric(28,12) =
                      receipt.released_light
                  )
                  OR (
                    receipt.worker_wall_ms IS NOT NULL
                    AND hold.status = 'settled'
                    AND hold.settlement_event_id = event.id
                    AND event.id = receipt.cloud_usage_event_id
                    AND event.hold_id = hold.id
                    AND event.payer_user_id = run.user_id
                    AND event.caller_user_id = run.user_id
                    AND event.owner_user_id = run.user_id
                    AND event.app_id = run.agent_id
                    AND event.function_name = run.caller_function
                    AND event.receipt_id = 'compute-run:' || run.id::text
                    AND event.source = 'galactic_compute'
                    AND event.resource = 'worker_execution'
                    AND event.metadata->>'run_id' = run.id::text
                    AND event.units::numeric(28,12) =
                      receipt.billed_wall_ms::numeric(28,12)
                    AND event.cloud_units::numeric(28,12) =
                      receipt.billed_wall_ms::numeric(28,12)
                    AND event.amount_light::numeric(28,12) =
                      receipt.actual_light
                  )
                )
            )
          )
        )
      )
      OR (
        run.billing_mode = 'subscription_capacity'
        AND (
          receipt.hold_id IS NOT NULL
          OR receipt.cloud_usage_event_id IS NOT NULL
          OR (
            receipt.capacity_reservation_id IS NULL
            AND receipt.capacity_settlement_status IS DISTINCT FROM
              'not_applicable'
          )
          OR (
            receipt.capacity_reservation_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM public.compute_run_budget_reservations AS budget
              WHERE budget.run_id = run.id
                AND (
                  (budget.status = 'settlement_pending'
                    AND receipt.capacity_settlement_status = 'pending')
                  OR (budget.status = 'settled'
                    AND receipt.capacity_settlement_status = 'settled')
                )
            )
          )
          OR (
            receipt.capacity_reservation_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM public.account_capacity_reservations AS reservation
              JOIN public.compute_run_budget_reservations AS budget
                ON budget.capacity_reservation_id = reservation.id
              WHERE reservation.id = receipt.capacity_reservation_id
                AND budget.run_id = run.id
                AND reservation.user_id = run.user_id
                AND reservation.capacity_agent_id = run.capacity_agent_id
                AND reservation.metadata->>'compute_run_id' = run.id::text
                AND reservation.reserved_light::numeric(28,12) =
                  receipt.reserved_light
                AND (
                  (
                    reservation.status = 'settled'
                    AND budget.status = 'settled'
                    AND receipt.capacity_settlement_status = 'settled'
                    AND reservation.actual_light::numeric(28,12) =
                      receipt.actual_light
                  )
                  OR (
                    reservation.status IN ('reserved', 'expired')
                    AND reservation.actual_light IS NULL
                    AND budget.status = 'settlement_pending'
                    AND receipt.capacity_settlement_status = 'pending'
                  )
                )
            )
          )
        )
      )
      )
      )
      OR (
        run.state NOT IN (
          'succeeded', 'failed', 'cancelled', 'expired', 'revoked'
        )
        AND receipt.id IS NOT NULL
      )
    );

  SELECT count(*)::integer
  INTO v_terminal_active_tokens
  FROM public.compute_job_tokens AS token
  JOIN public.compute_runs AS run ON run.id = token.run_id
  WHERE run.user_id = p_owner_id AND run.agent_id = p_agent_id
    AND run.created_at >= p_since
    AND run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
    AND token.status = 'active';

  SELECT count(*)::integer
  INTO v_dlq_fenced_runs
  FROM public.compute_runs AS run
  WHERE run.user_id = p_owner_id AND run.agent_id = p_agent_id
    AND run.created_at >= p_since
    AND run.stop_fence_owner = 'dispatch_dlq';

  SELECT count(*)::integer
  INTO v_stale_pending_artifacts
  FROM public.compute_artifacts AS artifact
  JOIN public.compute_runs AS run ON run.id = artifact.run_id
  WHERE run.user_id = p_owner_id AND run.agent_id = p_agent_id
    AND run.created_at >= p_since
    AND artifact.direction = 'output'
    AND artifact.state = 'pending'
    AND artifact.updated_at <= v_cutoff
    AND (
      run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
      OR run.stop_requested_at IS NOT NULL
    );

  SELECT count(*)::integer
  INTO v_unreconciled_deleted_outputs
  FROM public.compute_artifacts AS artifact
  JOIN public.compute_runs AS run ON run.id = artifact.run_id
  WHERE run.user_id = p_owner_id AND run.agent_id = p_agent_id
    AND run.created_at >= p_since
    AND artifact.direction = 'output'
    AND artifact.state = 'deleted'
    AND artifact.object_deleted_at IS NULL
    AND artifact.updated_at <= v_cutoff
    AND NOT EXISTS (
      SELECT 1
      FROM public.compute_artifacts AS input_alias
      WHERE input_alias.source_artifact_id = artifact.id
        AND input_alias.direction = 'input'
        AND input_alias.state = 'ready'
    );

  SELECT count(*)::integer
  INTO v_terminal_input_aliases
  FROM public.compute_artifacts AS artifact
  JOIN public.compute_runs AS run ON run.id = artifact.run_id
  WHERE run.user_id = p_owner_id AND run.agent_id = p_agent_id
    AND run.created_at >= p_since
    AND artifact.direction = 'input'
    AND artifact.state = 'ready'
    AND run.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'revoked')
    AND COALESCE(run.finished_at, run.updated_at) <= v_cutoff;

  IF v_dlq_fenced_runs > 0 THEN
    v_health_violations := array_append(
      v_health_violations, 'DLQ_FENCED_RUNS'
    );
  END IF;
  IF v_old_settlement_pending > 0 THEN
    v_health_violations := array_append(
      v_health_violations, 'OLD_SETTLEMENT_PENDING'
    );
  END IF;
  IF v_receipt_mismatches > 0 THEN
    v_health_violations := array_append(
      v_health_violations, 'RECEIPT_MISMATCHES'
    );
  END IF;
  IF v_stale_nonterminal_runs > 0 THEN
    v_health_violations := array_append(
      v_health_violations, 'STALE_NONTERMINAL_RUNS'
    );
  END IF;
  IF v_stale_pending_artifacts > 0 THEN
    v_health_violations := array_append(
      v_health_violations, 'STALE_PENDING_ARTIFACTS'
    );
  END IF;
  IF v_terminal_active_tokens > 0 THEN
    v_health_violations := array_append(
      v_health_violations, 'TERMINAL_ACTIVE_TOKENS'
    );
  END IF;
  IF v_terminal_input_aliases > 0 THEN
    v_health_violations := array_append(
      v_health_violations, 'TERMINAL_INPUT_ALIASES'
    );
  END IF;
  IF v_terminal_reserved_budgets > 0 THEN
    v_health_violations := array_append(
      v_health_violations, 'TERMINAL_RESERVED_BUDGETS'
    );
  END IF;
  IF v_unreconciled_deleted_outputs > 0 THEN
    v_health_violations := array_append(
      v_health_violations, 'UNRECONCILED_DELETED_OUTPUTS'
    );
  END IF;

  v_selected_run_count := jsonb_array_length(v_runs);
  IF v_latch_state <> 'clear' THEN
    v_top_violations := array_append(
      v_top_violations, 'EMERGENCY_STOP_LATCH_SET'
    );
  END IF;
  IF v_selected_run_count <> cardinality(p_run_ids) THEN
    v_top_violations := array_append(
      v_top_violations, 'SELECTED_RUN_CARDINALITY_MISMATCH'
    );
  END IF;

  RETURN jsonb_build_object(
    'schema_version', 1,
    'generated_at', v_now,
    'owner_id', p_owner_id,
    'agent_id', p_agent_id,
    'since', p_since,
    'latch_state', v_latch_state,
    'requested_run_count', cardinality(p_run_ids),
    'selected_run_count', v_selected_run_count,
    'runs', v_runs,
    'health', jsonb_build_object(
      'stale_nonterminal_runs', v_stale_nonterminal_runs,
      'old_settlement_pending', v_old_settlement_pending,
      'terminal_reserved_budgets', v_terminal_reserved_budgets,
      'receipt_mismatches', v_receipt_mismatches,
      'terminal_active_tokens', v_terminal_active_tokens,
      'dlq_fenced_runs', v_dlq_fenced_runs,
      'stale_pending_artifacts', v_stale_pending_artifacts,
      'unreconciled_deleted_outputs', v_unreconciled_deleted_outputs,
      'terminal_input_aliases', v_terminal_input_aliases,
      'violations', to_jsonb(v_health_violations)
    ),
    'violations', to_jsonb(v_top_violations)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_compute_certification_snapshot(
  uuid, uuid, uuid[], timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_compute_certification_snapshot(
  uuid, uuid, uuid[], timestamptz
) TO service_role;

COMMENT ON FUNCTION public.get_compute_certification_snapshot(
  uuid, uuid, uuid[], timestamptz
) IS 'Returns a bounded, sanitized Compute persistence certification snapshot.';

NOTIFY pgrst, 'reload schema';
