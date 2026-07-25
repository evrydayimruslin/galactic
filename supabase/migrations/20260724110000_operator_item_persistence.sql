-- Canonical operator item persistence (M3).
--
-- Notifications remain immutable evidence. These tables own the currently
-- observed condition and its recovery, while operator_item_attention_states
-- owns only per-user presentation state. All writes flow through bounded,
-- service-role RPCs; browser and connected-Agent credentials have no direct
-- table access.

CREATE OR REPLACE FUNCTION public.is_valid_operator_condition_key(
  p_value text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT char_length(p_value) BETWEEN 1 AND 600
    AND p_value !~ '[[:cntrl:]]';
$$;

CREATE OR REPLACE FUNCTION public.is_valid_operator_diagnosis(
  p_value jsonb
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public
AS $$
DECLARE
  v_evidence jsonb;
  v_destination jsonb;
BEGIN
  IF jsonb_typeof(p_value) <> 'object'
     OR NOT p_value ?& ARRAY[
       'code', 'causeCode', 'summary', 'detail', 'provenance', 'evidence'
     ]
     OR p_value - ARRAY[
       'code', 'causeCode', 'summary', 'detail', 'provenance', 'evidence'
     ] <> '{}'::jsonb
     OR p_value->>'code' NOT IN (
       'ACCOUNT_BYOK_MISSING',
       'ACCOUNT_USAGE_EXHAUSTED',
       'AGENT_CAPABILITY_APPROVAL_REQUIRED',
       'AGENT_GRANT_REQUIRED',
       'AGENT_PRIMARY_ROUTINE_MISSING',
       'AGENT_RELEASE_REVIEW_REQUIRED',
       'AGENT_REPORTING_NOT_CONFIGURED',
       'AGENT_SECRET_MISSING',
       'AGENT_SETTING_MISSING',
       'ROUTINE_PAUSED_AFTER_FAILURES',
       'ROUTINE_USAGE_EXHAUSTED'
     )
     OR jsonb_typeof(p_value->'summary') <> 'string'
     OR char_length(p_value->>'summary') NOT BETWEEN 1 AND 240
     OR p_value->>'summary' ~ '[[:cntrl:]]'
     OR (
       p_value->'detail' <> 'null'::jsonb
       AND (
         jsonb_typeof(p_value->'detail') <> 'string'
         OR char_length(p_value->>'detail') NOT BETWEEN 1 AND 2000
         OR p_value->>'detail' ~ '[[:cntrl:]]'
       )
     )
     OR (
       p_value->'causeCode' <> 'null'::jsonb
       AND (
         jsonb_typeof(p_value->'causeCode') <> 'string'
         OR p_value->>'causeCode' !~ '^[A-Z][A-Z0-9_]{0,79}$'
       )
     )
     OR p_value->>'provenance' NOT IN (
       'platform', 'provider', 'developer', 'combined', 'unknown'
     )
     OR jsonb_typeof(p_value->'evidence') <> 'array'
     OR jsonb_array_length(p_value->'evidence') > 100
     OR octet_length(p_value::text) > 65536 THEN
    RETURN false;
  END IF;

  FOR v_evidence IN
    SELECT value FROM jsonb_array_elements(p_value->'evidence')
  LOOP
    IF jsonb_typeof(v_evidence) <> 'object'
       OR NOT v_evidence ?& ARRAY[
         'kind', 'sourceId', 'label', 'observedAt'
       ]
       OR v_evidence - ARRAY[
         'kind', 'sourceId', 'label', 'observedAt', 'destination'
       ] <> '{}'::jsonb
       OR v_evidence->>'kind' NOT IN (
         'routine', 'run', 'schedule', 'notification',
         'setting', 'authority', 'release', 'compute'
       )
       OR jsonb_typeof(v_evidence->'sourceId') <> 'string'
       OR char_length(v_evidence->>'sourceId') NOT BETWEEN 1 AND 240
       OR v_evidence->>'sourceId' ~ '[[:cntrl:]]'
       OR jsonb_typeof(v_evidence->'label') <> 'string'
       OR char_length(v_evidence->>'label') NOT BETWEEN 1 AND 160
       OR v_evidence->>'label' ~ '[[:cntrl:]]'
       OR (
         v_evidence->'observedAt' <> 'null'::jsonb
         AND jsonb_typeof(v_evidence->'observedAt') <> 'string'
       ) THEN
      RETURN false;
    END IF;

    v_destination := v_evidence->'destination';
    IF v_destination IS NOT NULL
       AND v_destination <> 'null'::jsonb
       AND (
         jsonb_typeof(v_destination) <> 'object'
         OR NOT v_destination ? 'href'
         OR v_destination - ARRAY['href', 'agentId', 'pane', 'itemId']
           <> '{}'::jsonb
         OR jsonb_typeof(v_destination->'href') <> 'string'
         OR left(v_destination->>'href', 1) <> '/'
         OR left(v_destination->>'href', 2) = '//'
         OR char_length(v_destination->>'href') > 500
         OR v_destination->>'href' ~ '[[:cntrl:]]'
       ) THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_valid_operator_remediations(
  p_condition_key text,
  p_value jsonb
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public
AS $$
DECLARE
  v_remediation jsonb;
  v_key text;
  v_target jsonb;
  v_target_kind text;
  v_expected_presentation text;
  v_expected_authority text;
  v_expected_side_effect text;
  v_expected_target_kind text;
BEGIN
  IF jsonb_typeof(p_value) <> 'array'
     OR jsonb_array_length(p_value) > 20
     OR octet_length(p_value::text) > 65536 THEN
    RETURN false;
  END IF;

  FOR v_remediation IN SELECT value FROM jsonb_array_elements(p_value)
  LOOP
    IF jsonb_typeof(v_remediation) <> 'object'
       OR NOT v_remediation ?& ARRAY[
         'id', 'key', 'label', 'description', 'presentation',
         'requiredAuthority', 'sideEffect', 'target'
       ]
       OR v_remediation - ARRAY[
         'id', 'key', 'label', 'description', 'presentation',
         'requiredAuthority', 'sideEffect', 'target'
       ] <> '{}'::jsonb THEN
      RETURN false;
    END IF;

    v_key := v_remediation->>'key';
    SELECT
      policy.presentation,
      policy.authority,
      policy.side_effect,
      policy.target_kind
    INTO
      v_expected_presentation,
      v_expected_authority,
      v_expected_side_effect,
      v_expected_target_kind
    FROM (
      VALUES
        ('adjust_capacity', 'inline', 'account_session',
          'configuration_write', 'routine'),
        ('approve_capability', 'inline', 'account_session',
          'bounded_approval', 'agent_access_item'),
        ('approve_grant', 'inline', 'account_session',
          'bounded_approval', 'agent_access_item'),
        ('configure_provider', 'inline', 'account_session',
          'configuration_write', 'account_provider'),
        ('configure_routine', 'inline', 'account_session',
          'configuration_write', 'agent_setup_requirement'),
        ('configure_secret', 'inline', 'account_session',
          'configuration_write', 'agent_setting'),
        ('configure_setting', 'inline', 'account_session',
          'configuration_write', 'agent_setting'),
        ('enable_routine', 'execute', 'agent_operate',
          'schedule_change', 'routine'),
        ('inspect_run', 'navigate', 'agent_operate',
          'none', 'routine_run'),
        ('open_logs', 'navigate', 'agent_operate',
          'none', 'routine_logs'),
        ('open_routine', 'navigate', 'agent_operate',
          'none', 'routine'),
        ('review_access', 'navigate', 'account_session',
          'none', 'agent_access_item'),
        ('review_release', 'navigate', 'account_session',
          'none', 'agent_release'),
        ('resume_routine', 'execute', 'agent_operate',
          'schedule_change', 'routine'),
        ('run_once', 'execute', 'agent_operate',
          'routine_execution', 'routine'),
        ('verify_connection', 'execute', 'agent_operate',
          'none', 'routine')
    ) AS policy(
      key, presentation, authority, side_effect, target_kind
    )
    WHERE policy.key = v_key;

    v_target := v_remediation->'target';
    v_target_kind := v_target->>'kind';
    IF v_expected_presentation IS NULL
       OR v_remediation->>'id' <>
         p_condition_key || ':remediation:' || v_key
       OR char_length(v_remediation->>'id') > 800
       OR jsonb_typeof(v_remediation->'label') <> 'string'
       OR char_length(v_remediation->>'label') NOT BETWEEN 1 AND 160
       OR v_remediation->>'label' ~ '[[:cntrl:]]'
       OR (
         v_remediation->'description' <> 'null'::jsonb
         AND (
           jsonb_typeof(v_remediation->'description') <> 'string'
           OR char_length(v_remediation->>'description') NOT BETWEEN 1 AND 500
           OR v_remediation->>'description' ~ '[[:cntrl:]]'
         )
       )
       OR v_remediation->>'presentation' <> v_expected_presentation
       OR v_remediation->>'requiredAuthority' <> v_expected_authority
       OR v_remediation->>'sideEffect' <> v_expected_side_effect
       OR jsonb_typeof(v_target) <> 'object'
       OR v_target_kind <> v_expected_target_kind
       OR v_target ?| ARRAY['url', 'href', 'actionUrl'] THEN
      RETURN false;
    END IF;

    IF (
      v_target_kind = 'account_provider'
      AND (
        v_target - ARRAY['kind', 'provider'] <> '{}'::jsonb
        OR NOT v_target ?& ARRAY['kind', 'provider']
      )
    ) OR (
      v_target_kind = 'agent_setup_requirement'
      AND (
        v_target - ARRAY['kind', 'agentId', 'requirementId'] <> '{}'::jsonb
        OR NOT v_target ?& ARRAY['kind', 'agentId', 'requirementId']
      )
    ) OR (
      v_target_kind = 'agent_setting'
      AND (
        v_target - ARRAY[
          'kind', 'agentId', 'settingKey', 'settingScope'
        ] <> '{}'::jsonb
        OR NOT v_target ?& ARRAY[
          'kind', 'agentId', 'settingKey', 'settingScope'
        ]
        OR v_target->>'settingScope' NOT IN ('agent', 'per_user')
      )
    ) OR (
      v_target_kind = 'agent_access_item'
      AND (
        v_target - ARRAY['kind', 'agentId', 'itemId'] <> '{}'::jsonb
        OR NOT v_target ?& ARRAY['kind', 'agentId', 'itemId']
      )
    ) OR (
      v_target_kind = 'agent_release'
      AND (
        v_target - ARRAY['kind', 'agentId', 'releaseId'] <> '{}'::jsonb
        OR NOT v_target ?& ARRAY['kind', 'agentId', 'releaseId']
      )
    ) OR (
      v_target_kind = 'routine'
      AND (
        v_target - ARRAY['kind', 'agentId', 'routineId'] <> '{}'::jsonb
        OR NOT v_target ?& ARRAY['kind', 'agentId', 'routineId']
      )
    ) OR (
      v_target_kind IN ('routine_run', 'routine_logs')
      AND (
        v_target - ARRAY[
          'kind', 'agentId', 'routineId', 'runId'
        ] <> '{}'::jsonb
        OR NOT v_target ?& ARRAY[
          'kind', 'agentId', 'routineId', 'runId'
        ]
        OR (
          v_target_kind = 'routine_run'
          AND v_target->'runId' = 'null'::jsonb
        )
      )
    ) THEN
      RETURN false;
    END IF;

    IF (
      v_target ? 'agentId'
      AND (
        jsonb_typeof(v_target->'agentId') <> 'string'
        OR v_target->>'agentId' !~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      )
    ) OR (
      v_target ? 'routineId'
      AND (
        jsonb_typeof(v_target->'routineId') <> 'string'
        OR v_target->>'routineId' !~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      )
    ) OR (
      v_target ? 'runId'
      AND v_target->'runId' <> 'null'::jsonb
      AND (
        jsonb_typeof(v_target->'runId') <> 'string'
        OR v_target->>'runId' !~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      )
    ) OR (
      v_target ? 'provider'
      AND v_target->'provider' <> 'null'::jsonb
      AND (
        jsonb_typeof(v_target->'provider') <> 'string'
        OR v_target->>'provider' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      )
    ) OR (
      v_target ? 'releaseId'
      AND v_target->'releaseId' <> 'null'::jsonb
      AND (
        jsonb_typeof(v_target->'releaseId') <> 'string'
        OR v_target->>'releaseId' !~
          '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      )
    ) OR (
      v_target ? 'requirementId'
      AND (
        jsonb_typeof(v_target->'requirementId') <> 'string'
        OR v_target->>'requirementId' !~
          '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      )
    ) OR (
      v_target ? 'settingKey'
      AND (
        jsonb_typeof(v_target->'settingKey') <> 'string'
        OR v_target->>'settingKey' !~
          '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      )
    ) OR (
      v_target ? 'itemId'
      AND (
        jsonb_typeof(v_target->'itemId') <> 'string'
        OR v_target->>'itemId' !~
          '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      )
    ) THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_valid_operator_recovery(
  p_value jsonb
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT jsonb_typeof(p_value) = 'object'
    AND p_value ?& ARRAY[
      'mode', 'mayRecoverAutomatically', 'resumesScheduledWork'
    ]
    AND p_value - ARRAY[
      'mode', 'mayRecoverAutomatically', 'resumesScheduledWork'
    ] = '{}'::jsonb
    AND p_value->>'mode' IN (
      'automatic_reset', 'revalidate_condition', 'successful_verification'
    )
    AND p_value->'mayRecoverAutomatically' = 'true'::jsonb
    AND p_value->'resumesScheduledWork' = 'false'::jsonb;
$$;

CREATE OR REPLACE FUNCTION public.is_valid_operator_dependencies(
  p_condition_key text,
  p_values text[]
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT cardinality(p_values) <= 100
    AND NOT p_condition_key = ANY(p_values)
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(p_values) AS dependency(value)
      WHERE NOT public.is_valid_operator_condition_key(dependency.value)
    )
    AND cardinality(p_values) = (
      SELECT count(DISTINCT dependency.value)
      FROM unnest(p_values) AS dependency(value)
    );
$$;

CREATE TABLE public.operator_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  contract_version text NOT NULL,
  condition_key text NOT NULL,
  item_class text NOT NULL,
  lifecycle_state text NOT NULL DEFAULT 'active',
  scope_kind text NOT NULL,
  scope_agent_id uuid,
  scope_routine_id uuid,
  scope_run_id uuid,
  severity text NOT NULL,
  diagnosis jsonb NOT NULL,
  remediations jsonb NOT NULL DEFAULT '[]'::jsonb,
  requires_action boolean NOT NULL,
  requires_decision boolean NOT NULL,
  source_ordinal integer NOT NULL,
  depends_on_condition_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
  recovery_mode text NOT NULL,
  recovery_may_automatic boolean NOT NULL,
  definition_hash text NOT NULL,
  detected_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  recovered_at timestamptz,
  recovery_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_items_user_id_id_key UNIQUE (user_id, id),
  CONSTRAINT operator_items_source_key_check CHECK (
    source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
  ),
  CONSTRAINT operator_items_contract_version_check CHECK (
    contract_version = '2026-07-24.operator-issues.1'
  ),
  CONSTRAINT operator_items_condition_key_check CHECK (
    public.is_valid_operator_condition_key(condition_key)
  ),
  CONSTRAINT operator_items_class_check CHECK (
    item_class IN ('issue', 'report')
  ),
  CONSTRAINT operator_items_lifecycle_check CHECK (
    lifecycle_state IN ('active', 'recovered')
  ),
  CONSTRAINT operator_items_scope_check CHECK (
    (
      scope_kind = 'account'
      AND scope_agent_id IS NULL
      AND scope_routine_id IS NULL
      AND scope_run_id IS NULL
    )
    OR (
      scope_kind = 'agent'
      AND scope_agent_id IS NOT NULL
      AND scope_routine_id IS NULL
      AND scope_run_id IS NULL
    )
    OR (
      scope_kind = 'routine'
      AND scope_agent_id IS NOT NULL
      AND scope_routine_id IS NOT NULL
      AND scope_run_id IS NULL
    )
    OR (
      scope_kind = 'run'
      AND scope_agent_id IS NOT NULL
      AND scope_routine_id IS NOT NULL
      AND scope_run_id IS NOT NULL
    )
  ),
  CONSTRAINT operator_items_severity_check CHECK (
    severity IN ('info', 'warning', 'critical')
  ),
  CONSTRAINT operator_items_diagnosis_check CHECK (
    public.is_valid_operator_diagnosis(diagnosis)
  ),
  CONSTRAINT operator_items_remediations_check CHECK (
    public.is_valid_operator_remediations(condition_key, remediations)
  ),
  CONSTRAINT operator_items_class_shape_check CHECK (
    (
      item_class = 'issue'
      AND requires_action
      AND jsonb_array_length(remediations) >= 1
    )
    OR (
      item_class = 'report'
      AND NOT requires_action
      AND NOT requires_decision
      AND remediations = '[]'::jsonb
    )
  ),
  CONSTRAINT operator_items_source_ordinal_check CHECK (source_ordinal >= 0),
  CONSTRAINT operator_items_dependencies_check CHECK (
    public.is_valid_operator_dependencies(
      condition_key,
      depends_on_condition_keys
    )
  ),
  CONSTRAINT operator_items_recovery_check CHECK (
    recovery_mode IN (
      'automatic_reset', 'revalidate_condition', 'successful_verification'
    )
    AND recovery_may_automatic
  ),
  CONSTRAINT operator_items_definition_hash_check CHECK (
    definition_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT operator_items_observation_order_check CHECK (
    detected_at <= last_observed_at
  ),
  CONSTRAINT operator_items_recovery_shape_check CHECK (
    (
      lifecycle_state = 'active'
      AND recovered_at IS NULL
      AND recovery_reason IS NULL
    )
    OR (
      lifecycle_state = 'recovered'
      AND recovered_at IS NOT NULL
      AND recovery_reason IS NOT NULL
      AND char_length(recovery_reason) BETWEEN 1 AND 160
      AND recovery_reason !~ '[[:cntrl:]]'
    )
  )
);

CREATE UNIQUE INDEX operator_items_one_active_condition
  ON public.operator_items (user_id, condition_key)
  WHERE lifecycle_state = 'active';

CREATE INDEX operator_items_owner_active_order
  ON public.operator_items
    (user_id, lifecycle_state, source_ordinal, detected_at, id);

CREATE INDEX operator_items_owner_source_active
  ON public.operator_items (user_id, source_key, last_observed_at, id)
  WHERE lifecycle_state = 'active';

CREATE TABLE public.operator_item_affected_agents (
  item_id uuid NOT NULL,
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE RESTRICT,
  blocking boolean NOT NULL,
  source_ordinal integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_item_affected_agents_pkey
    PRIMARY KEY (item_id, agent_id),
  CONSTRAINT operator_item_affected_agents_item_owner_fkey
    FOREIGN KEY (user_id, item_id)
    REFERENCES public.operator_items(user_id, id)
    ON DELETE CASCADE,
  CONSTRAINT operator_item_affected_agents_ordinal_check
    CHECK (source_ordinal >= 0),
  CONSTRAINT operator_item_affected_agents_order_key
    UNIQUE (item_id, source_ordinal)
);

CREATE INDEX operator_item_affected_agents_owner_agent
  ON public.operator_item_affected_agents
    (user_id, agent_id, blocking, item_id);

CREATE TABLE public.operator_item_attention_states (
  item_id uuid NOT NULL,
  user_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'open',
  read_at timestamptz,
  snoozed_until timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_item_attention_states_pkey
    PRIMARY KEY (item_id, user_id),
  CONSTRAINT operator_item_attention_states_item_owner_fkey
    FOREIGN KEY (user_id, item_id)
    REFERENCES public.operator_items(user_id, id)
    ON DELETE CASCADE,
  CONSTRAINT operator_item_attention_states_state_check CHECK (
    state IN ('open', 'snoozed', 'dismissed')
  ),
  CONSTRAINT operator_item_attention_states_shape_check CHECK (
    (
      state = 'open'
      AND snoozed_until IS NULL
      AND dismissed_at IS NULL
    )
    OR (
      state = 'snoozed'
      AND snoozed_until IS NOT NULL
      AND dismissed_at IS NULL
    )
    OR (
      state = 'dismissed'
      AND snoozed_until IS NULL
      AND dismissed_at IS NOT NULL
    )
  )
);

CREATE INDEX operator_item_attention_states_due
  ON public.operator_item_attention_states
    (snoozed_until, user_id, item_id)
  WHERE state = 'snoozed';

-- A source cursor rejects out-of-order complete snapshots before they can
-- resurrect an already recovered episode or recover a newer observation.
CREATE TABLE public.operator_item_source_cursors (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  last_observed_at timestamptz NOT NULL,
  last_snapshot_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_item_source_cursors_pkey
    PRIMARY KEY (user_id, source_key),
  CONSTRAINT operator_item_source_cursors_source_key_check CHECK (
    source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
  ),
  CONSTRAINT operator_item_source_cursors_snapshot_hash_check CHECK (
    last_snapshot_hash ~ '^[0-9a-f]{64}$'
  )
);

ALTER TABLE public.operator_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_item_affected_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_item_attention_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_item_source_cursors ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.operator_items
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.operator_item_affected_agents
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.operator_item_attention_states
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.operator_item_source_cursors
  FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.operator_items TO service_role;
GRANT ALL ON TABLE public.operator_item_affected_agents TO service_role;
GRANT ALL ON TABLE public.operator_item_attention_states TO service_role;
GRANT ALL ON TABLE public.operator_item_source_cursors TO service_role;

CREATE OR REPLACE FUNCTION public.touch_operator_item_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER touch_operator_items_updated_at
BEFORE UPDATE ON public.operator_items
FOR EACH ROW EXECUTE FUNCTION public.touch_operator_item_updated_at();

CREATE TRIGGER touch_operator_item_affected_agents_updated_at
BEFORE UPDATE ON public.operator_item_affected_agents
FOR EACH ROW EXECUTE FUNCTION public.touch_operator_item_updated_at();

CREATE TRIGGER touch_operator_item_attention_states_updated_at
BEFORE UPDATE ON public.operator_item_attention_states
FOR EACH ROW EXECUTE FUNCTION public.touch_operator_item_updated_at();

CREATE TRIGGER touch_operator_item_source_cursors_updated_at
BEFORE UPDATE ON public.operator_item_source_cursors
FOR EACH ROW EXECUTE FUNCTION public.touch_operator_item_updated_at();

CREATE OR REPLACE FUNCTION public.validate_operator_item_affected_agent_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.apps AS apps
    WHERE apps.id = NEW.agent_id
      AND apps.owner_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'operator_item_affected_agent_owner_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operator_item_affected_agent_owner
BEFORE INSERT OR UPDATE OF user_id, agent_id
ON public.operator_item_affected_agents
FOR EACH ROW EXECUTE FUNCTION
  public.validate_operator_item_affected_agent_owner();

CREATE OR REPLACE FUNCTION public.reconcile_operator_items(
  p_user_id uuid,
  p_source_key text,
  p_items jsonb,
  p_observed_at timestamptz,
  p_complete_snapshot boolean,
  p_snapshot_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_scope jsonb;
  v_condition_key text;
  v_seen_keys text[] := ARRAY[]::text[];
  v_existing public.operator_items%ROWTYPE;
  v_item_id uuid;
  v_agent_id uuid;
  v_scope_agent_id uuid;
  v_scope_routine_id uuid;
  v_scope_run_id uuid;
  v_created boolean;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_recovered integer := 0;
  v_results jsonb := '[]'::jsonb;
  v_cursor_at timestamptz;
  v_cursor_hash text;
  v_affected jsonb;
  v_ordinal integer;
  v_target jsonb;
BEGIN
  IF p_user_id IS NULL
     OR p_source_key IS NULL
     OR p_source_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR p_observed_at IS NULL
     OR p_snapshot_hash IS NULL
     OR p_snapshot_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) > 500
     OR octet_length(p_items::text) > 1000000 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_operator_item_reconciliation';
  END IF;

  PERFORM 1 FROM public.users WHERE id = p_user_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'operator_item_owner_not_found';
  END IF;

  -- Serialize every operator-item writer for one owner. This also gives all
  -- producers one lock order before they lock Agents/routines below.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('operator-items' || E'\x1f' || p_user_id::text, 0)
  );

  SELECT
    cursors.last_observed_at,
    cursors.last_snapshot_hash
  INTO
    v_cursor_at,
    v_cursor_hash
  FROM public.operator_item_source_cursors AS cursors
  WHERE cursors.user_id = p_user_id
    AND cursors.source_key = p_source_key
  FOR UPDATE;

  IF v_cursor_at IS NOT NULL AND p_observed_at < v_cursor_at THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'stale_operator_item_observation';
  END IF;
  IF v_cursor_at = p_observed_at
     AND v_cursor_hash IS DISTINCT FROM p_snapshot_hash THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'conflicting_operator_item_observation';
  END IF;

  -- Validate the entire payload before the first mutation. Any later ownership
  -- failure still rolls the transaction back, but this keeps malformed batches
  -- from acquiring entity locks.
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR NOT v_item ?& ARRAY[
         'contractVersion', 'conditionKey', 'itemClass', 'scope', 'severity',
         'diagnosis', 'affectedAgents', 'remediations', 'requiresAction',
         'requiresDecision', 'ordering', 'recovery', 'detectedAt',
         'definitionHash'
       ]
       OR v_item - ARRAY[
         'contractVersion', 'conditionKey', 'itemClass', 'scope', 'severity',
         'diagnosis', 'affectedAgents', 'remediations', 'requiresAction',
         'requiresDecision', 'ordering', 'recovery', 'detectedAt',
         'definitionHash'
       ] <> '{}'::jsonb
       OR v_item->>'contractVersion' <>
         '2026-07-24.operator-issues.1'
       OR NOT public.is_valid_operator_condition_key(
         v_item->>'conditionKey'
       )
       OR v_item->>'itemClass' NOT IN ('issue', 'report')
       OR v_item->>'severity' NOT IN ('info', 'warning', 'critical')
       OR NOT public.is_valid_operator_diagnosis(v_item->'diagnosis')
       OR NOT public.is_valid_operator_remediations(
         v_item->>'conditionKey',
         v_item->'remediations'
       )
       OR NOT public.is_valid_operator_recovery(v_item->'recovery')
       OR v_item->>'definitionHash' !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(v_item->'affectedAgents') <> 'array'
       OR jsonb_array_length(v_item->'affectedAgents') NOT BETWEEN 1 AND 500
       OR jsonb_typeof(v_item->'ordering') <> 'object'
       OR NOT (v_item->'ordering') ?& ARRAY[
         'sourceOrdinal', 'dependsOnConditionKeys'
       ]
       OR (v_item->'ordering') - ARRAY[
         'sourceOrdinal', 'dependsOnConditionKeys'
       ] <> '{}'::jsonb
       OR jsonb_typeof(v_item->'ordering'->'sourceOrdinal') <> 'number'
       OR v_item->'ordering'->>'sourceOrdinal' !~ '^[0-9]+$'
       OR jsonb_typeof(
         v_item->'ordering'->'dependsOnConditionKeys'
       ) <> 'array'
       OR jsonb_array_length(
         v_item->'ordering'->'dependsOnConditionKeys'
       ) > 100
       OR jsonb_typeof(v_item->'requiresAction') <> 'boolean'
       OR jsonb_typeof(v_item->'requiresDecision') <> 'boolean'
       OR (
         v_item->>'itemClass' = 'issue'
         AND (
           v_item->'requiresAction' <> 'true'::jsonb
           OR jsonb_array_length(v_item->'remediations') = 0
         )
       )
       OR (
         v_item->>'itemClass' = 'report'
         AND (
           v_item->'requiresAction' <> 'false'::jsonb
           OR v_item->'requiresDecision' <> 'false'::jsonb
           OR v_item->'remediations' <> '[]'::jsonb
         )
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'invalid_operator_item_payload';
    END IF;

    v_condition_key := v_item->>'conditionKey';
    IF v_condition_key = ANY(v_seen_keys) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'duplicate_operator_item_condition';
    END IF;
    v_seen_keys := array_append(v_seen_keys, v_condition_key);

    v_scope := v_item->'scope';
    IF jsonb_typeof(v_scope) <> 'object'
       OR v_scope->>'kind' NOT IN ('account', 'agent', 'routine', 'run')
       OR (
         v_scope->>'kind' = 'account'
         AND (
           v_scope <> '{"kind":"account"}'::jsonb
         )
       )
       OR (
         v_scope->>'kind' = 'agent'
         AND (
           NOT v_scope ?& ARRAY['kind', 'agentId']
           OR v_scope - ARRAY['kind', 'agentId'] <> '{}'::jsonb
           OR v_scope->>'agentId' !~
             '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         )
       )
       OR (
         v_scope->>'kind' = 'routine'
         AND (
           NOT v_scope ?& ARRAY['kind', 'agentId', 'routineId']
           OR v_scope - ARRAY['kind', 'agentId', 'routineId'] <> '{}'::jsonb
           OR v_scope->>'agentId' !~
             '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           OR v_scope->>'routineId' !~
             '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         )
       )
       OR (
         v_scope->>'kind' = 'run'
         AND (
           NOT v_scope ?& ARRAY[
             'kind', 'agentId', 'routineId', 'runId'
           ]
           OR v_scope - ARRAY[
             'kind', 'agentId', 'routineId', 'runId'
           ] <> '{}'::jsonb
           OR v_scope->>'agentId' !~
             '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           OR v_scope->>'routineId' !~
             '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           OR v_scope->>'runId' !~
             '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         )
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'invalid_operator_item_scope';
    END IF;
  END LOOP;

  -- Lock all affected Agents in stable order and prove current ownership.
  FOR v_agent_id IN
    SELECT DISTINCT (affected.value->>'agentId')::uuid
    FROM jsonb_array_elements(p_items) AS item(value)
    CROSS JOIN LATERAL
      jsonb_array_elements(item.value->'affectedAgents') AS affected(value)
    ORDER BY 1
  LOOP
    PERFORM 1
    FROM public.apps AS apps
    WHERE apps.id = v_agent_id
      AND apps.owner_id = p_user_id
      AND apps.visibility = 'private'
      AND apps.deleted_at IS NULL
    FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'operator_item_agent_owner_mismatch';
    END IF;
  END LOOP;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_condition_key := v_item->>'conditionKey';
    v_scope := v_item->'scope';
    v_scope_agent_id := CASE
      WHEN v_scope ? 'agentId' THEN (v_scope->>'agentId')::uuid
      ELSE NULL
    END;
    v_scope_routine_id := CASE
      WHEN v_scope ? 'routineId' THEN (v_scope->>'routineId')::uuid
      ELSE NULL
    END;
    v_scope_run_id := CASE
      WHEN v_scope ? 'runId' THEN (v_scope->>'runId')::uuid
      ELSE NULL
    END;

    IF v_scope_agent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_item->'affectedAgents') AS affected(value)
      WHERE (affected.value->>'agentId')::uuid = v_scope_agent_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'operator_item_scope_not_affected';
    END IF;

    IF v_scope_routine_id IS NOT NULL THEN
      PERFORM 1
      FROM public.user_routines AS routines
      WHERE routines.id = v_scope_routine_id
        AND routines.user_id = p_user_id
        AND routines.composer_app_id = v_scope_agent_id
        AND routines.deleted_at IS NULL
      FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '23503',
          MESSAGE = 'operator_item_routine_owner_mismatch';
      END IF;
    END IF;

    IF v_scope_run_id IS NOT NULL THEN
      PERFORM 1
      FROM public.routine_runs AS runs
      WHERE runs.id = v_scope_run_id
        AND runs.user_id = p_user_id
        AND runs.routine_id = v_scope_routine_id
      FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '23503',
          MESSAGE = 'operator_item_run_owner_mismatch';
      END IF;
    END IF;

    FOR v_target IN
      SELECT remediation.value->'target'
      FROM jsonb_array_elements(v_item->'remediations')
        AS remediation(value)
      WHERE remediation.value->'target' ? 'agentId'
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_item->'affectedAgents') AS affected(value)
        WHERE (affected.value->>'agentId')::uuid =
          (v_target->>'agentId')::uuid
      ) OR (
        v_scope_agent_id IS NOT NULL
        AND (v_target->>'agentId')::uuid <> v_scope_agent_id
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'operator_item_remediation_scope_mismatch';
      END IF;
    END LOOP;

    SELECT * INTO v_existing
    FROM public.operator_items AS items
    WHERE items.user_id = p_user_id
      AND items.condition_key = v_condition_key
      AND items.lifecycle_state = 'active'
    FOR UPDATE;

    IF FOUND THEN
      IF v_existing.source_key <> p_source_key
         OR v_existing.item_class <> v_item->>'itemClass'
         OR v_existing.scope_kind <> v_scope->>'kind'
         OR v_existing.scope_agent_id IS DISTINCT FROM v_scope_agent_id
         OR v_existing.scope_routine_id IS DISTINCT FROM v_scope_routine_id
         OR v_existing.scope_run_id IS DISTINCT FROM v_scope_run_id
         OR v_existing.diagnosis->>'code' <>
           v_item->'diagnosis'->>'code'
         OR v_existing.recovery_mode <> v_item->'recovery'->>'mode' THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'conflicting_operator_item_definition';
      END IF;

      UPDATE public.operator_items AS items
      SET
        contract_version = v_item->>'contractVersion',
        severity = v_item->>'severity',
        diagnosis = v_item->'diagnosis',
        remediations = v_item->'remediations',
        requires_action = (v_item->>'requiresAction')::boolean,
        requires_decision = (v_item->>'requiresDecision')::boolean,
        source_ordinal =
          (v_item->'ordering'->>'sourceOrdinal')::integer,
        depends_on_condition_keys = ARRAY(
          SELECT jsonb_array_elements_text(
            v_item->'ordering'->'dependsOnConditionKeys'
          )
        ),
        recovery_may_automatic =
          (v_item->'recovery'->>'mayRecoverAutomatically')::boolean,
        definition_hash = v_item->>'definitionHash',
        detected_at = LEAST(
          items.detected_at,
          (v_item->>'detectedAt')::timestamptz
        ),
        last_observed_at = GREATEST(items.last_observed_at, p_observed_at)
      WHERE items.id = v_existing.id
      RETURNING items.id INTO v_item_id;
      v_created := false;
      v_updated := v_updated + 1;
    ELSE
      INSERT INTO public.operator_items (
        user_id,
        source_key,
        contract_version,
        condition_key,
        item_class,
        scope_kind,
        scope_agent_id,
        scope_routine_id,
        scope_run_id,
        severity,
        diagnosis,
        remediations,
        requires_action,
        requires_decision,
        source_ordinal,
        depends_on_condition_keys,
        recovery_mode,
        recovery_may_automatic,
        definition_hash,
        detected_at,
        last_observed_at
      ) VALUES (
        p_user_id,
        p_source_key,
        v_item->>'contractVersion',
        v_condition_key,
        v_item->>'itemClass',
        v_scope->>'kind',
        v_scope_agent_id,
        v_scope_routine_id,
        v_scope_run_id,
        v_item->>'severity',
        v_item->'diagnosis',
        v_item->'remediations',
        (v_item->>'requiresAction')::boolean,
        (v_item->>'requiresDecision')::boolean,
        (v_item->'ordering'->>'sourceOrdinal')::integer,
        ARRAY(
          SELECT jsonb_array_elements_text(
            v_item->'ordering'->'dependsOnConditionKeys'
          )
        ),
        v_item->'recovery'->>'mode',
        (v_item->'recovery'->>'mayRecoverAutomatically')::boolean,
        v_item->>'definitionHash',
        (v_item->>'detectedAt')::timestamptz,
        p_observed_at
      )
      RETURNING id INTO v_item_id;
      v_created := true;
      v_inserted := v_inserted + 1;

      INSERT INTO public.operator_item_attention_states (
        item_id,
        user_id
      ) VALUES (
        v_item_id,
        p_user_id
      );
    END IF;

    DELETE FROM public.operator_item_affected_agents
    WHERE item_id = v_item_id
      AND user_id = p_user_id;

    v_ordinal := 0;
    FOR v_affected IN
      SELECT value FROM jsonb_array_elements(v_item->'affectedAgents')
    LOOP
      IF jsonb_typeof(v_affected) <> 'object'
         OR v_affected - ARRAY['agentId', 'blocking'] <> '{}'::jsonb
         OR NOT v_affected ?& ARRAY['agentId', 'blocking']
         OR v_affected->>'agentId' !~
           '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         OR jsonb_typeof(v_affected->'blocking') <> 'boolean' THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'invalid_operator_item_affected_agent';
      END IF;
      INSERT INTO public.operator_item_affected_agents (
        item_id,
        user_id,
        agent_id,
        blocking,
        source_ordinal
      ) VALUES (
        v_item_id,
        p_user_id,
        (v_affected->>'agentId')::uuid,
        (v_affected->>'blocking')::boolean,
        v_ordinal
      );
      v_ordinal := v_ordinal + 1;
    END LOOP;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'id', v_item_id,
      'conditionKey', v_condition_key,
      'created', v_created
    ));
  END LOOP;

  IF p_complete_snapshot THEN
    WITH recovered AS (
      UPDATE public.operator_items AS items
      SET
        lifecycle_state = 'recovered',
        recovered_at = p_observed_at,
        recovery_reason = 'condition_not_observed'
      WHERE items.user_id = p_user_id
        AND items.source_key = p_source_key
        AND items.lifecycle_state = 'active'
        AND NOT items.condition_key = ANY(v_seen_keys)
        AND items.last_observed_at <= p_observed_at
      RETURNING 1
    )
    SELECT count(*)::integer INTO v_recovered FROM recovered;
  END IF;

  INSERT INTO public.operator_item_source_cursors (
    user_id,
    source_key,
    last_observed_at,
    last_snapshot_hash
  ) VALUES (
    p_user_id,
    p_source_key,
    p_observed_at,
    p_snapshot_hash
  )
  ON CONFLICT (user_id, source_key) DO UPDATE
  SET
    last_observed_at = EXCLUDED.last_observed_at,
    last_snapshot_hash = EXCLUDED.last_snapshot_hash;

  RETURN jsonb_build_object(
    'observedCount', jsonb_array_length(p_items),
    'insertedCount', v_inserted,
    'updatedCount', v_updated,
    'recoveredCount', v_recovered,
    'items', v_results
  );
END;
$$;

-- Presentation state is intentionally independent: dismissing an item never
-- mutates the observed condition or records recovery.
CREATE OR REPLACE FUNCTION public.apply_operator_item_attention_action(
  p_user_id uuid,
  p_item_id uuid,
  p_action text,
  p_snoozed_until timestamptz DEFAULT NULL
) RETURNS SETOF public.operator_item_attention_states
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL
     OR p_item_id IS NULL
     OR p_action NOT IN (
       'mark_read', 'mark_unread', 'snooze', 'reopen', 'dismiss'
     )
     OR (
       p_action = 'snooze'
       AND (p_snoozed_until IS NULL OR p_snoozed_until <= now())
     )
     OR (
       p_action <> 'snooze'
       AND p_snoozed_until IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_operator_item_attention_action';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'operator-item-attention' || E'\x1f' ||
      p_user_id::text || E'\x1f' || p_item_id::text,
      0
    )
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.operator_items AS items
    WHERE items.id = p_item_id
      AND items.user_id = p_user_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.operator_item_attention_states (
    item_id,
    user_id
  ) VALUES (
    p_item_id,
    p_user_id
  )
  ON CONFLICT (item_id, user_id) DO NOTHING;

  IF p_action = 'mark_read' THEN
    UPDATE public.operator_item_attention_states
    SET read_at = now()
    WHERE item_id = p_item_id AND user_id = p_user_id;
  ELSIF p_action = 'mark_unread' THEN
    UPDATE public.operator_item_attention_states
    SET read_at = NULL
    WHERE item_id = p_item_id AND user_id = p_user_id;
  ELSIF p_action = 'snooze' THEN
    UPDATE public.operator_item_attention_states
    SET
      state = 'snoozed',
      snoozed_until = p_snoozed_until,
      dismissed_at = NULL
    WHERE item_id = p_item_id AND user_id = p_user_id;
  ELSIF p_action = 'reopen' THEN
    UPDATE public.operator_item_attention_states
    SET
      state = 'open',
      snoozed_until = NULL,
      dismissed_at = NULL
    WHERE item_id = p_item_id AND user_id = p_user_id;
  ELSE
    UPDATE public.operator_item_attention_states
    SET
      state = 'dismissed',
      snoozed_until = NULL,
      dismissed_at = now()
    WHERE item_id = p_item_id AND user_id = p_user_id;
  END IF;

  RETURN QUERY
  SELECT states.*
  FROM public.operator_item_attention_states AS states
  WHERE states.item_id = p_item_id
    AND states.user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_operator_items(
  uuid, text, jsonb, timestamptz, boolean, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_operator_items(
  uuid, text, jsonb, timestamptz, boolean, text
) TO service_role;

REVOKE ALL ON FUNCTION public.apply_operator_item_attention_action(
  uuid, uuid, text, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_operator_item_attention_action(
  uuid, uuid, text, timestamptz
) TO service_role;

COMMENT ON TABLE public.operator_items IS
  'Canonical current-condition episodes. Recovery is trusted observation and never a presentation action.';
COMMENT ON TABLE public.operator_item_attention_states IS
  'Per-user read, snooze, and dismiss state. Dismissal does not recover the underlying operator item.';
