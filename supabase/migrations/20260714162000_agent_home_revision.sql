-- Launch P1 (2026-07-14): durable optimistic concurrency for Agent Home.
--
-- agent_home_revision changes only when owner-editable configuration,
-- executable authority, lifecycle state, or staged release state changes. Run
-- progress, spend rollups, health counters, and analytics deliberately do not
-- invalidate an owner's open edit form.

ALTER TABLE public.apps
  ADD COLUMN IF NOT EXISTS agent_home_revision bigint DEFAULT 1 NOT NULL;

ALTER TABLE public.apps
  ADD COLUMN IF NOT EXISTS current_version_promoted_at timestamp with time zone;

ALTER TABLE public.apps
  DROP CONSTRAINT IF EXISTS apps_agent_home_revision_positive;
ALTER TABLE public.apps
  ADD CONSTRAINT apps_agent_home_revision_positive
  CHECK (agent_home_revision >= 1);

COMMENT ON COLUMN public.apps.agent_home_revision IS
  'Monotonic config/authority revision for the owner-only Agent Home contract; excludes volatile run and usage state.';

COMMENT ON COLUMN public.apps.current_version_promoted_at IS
  'Time the current version was explicitly promoted. Legacy rows remain NULL until their next promotion.';

-- apps.manifest is legacy TEXT. Parse defensively so one malformed historical
-- row cannot abort the migration or a settings transaction.
CREATE OR REPLACE FUNCTION public.try_parse_agent_home_jsonb(p_value text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path TO public, extensions
AS $$
BEGIN
  RETURN p_value::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.try_parse_agent_home_jsonb(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_parse_agent_home_jsonb(text)
  TO service_role;

-- Normalize only the authority fact needed by CAS. This mirrors the TypeScript
-- parser: scalar entries are ignored and only exact `per_user` remains
-- per-user; every other/missing scope is universal.
CREATE OR REPLACE FUNCTION public.normalize_agent_home_env_schema(p_schema jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path TO public, extensions
AS $$
  SELECT COALESCE(
    jsonb_object_agg(
      entries.key,
      jsonb_build_object(
        'scope', CASE
          WHEN COALESCE(entries.value->>'scope', entries.value->>'type') =
            'per_user' THEN 'per_user'
          ELSE 'universal'
        END
      )
    ),
    '{}'::jsonb
  )
  FROM jsonb_each(
    CASE WHEN jsonb_typeof(p_schema) = 'object'
      THEN p_schema ELSE '{}'::jsonb END
  ) AS entries(key, value)
  WHERE jsonb_typeof(entries.value) = 'object';
$$;

REVOKE ALL ON FUNCTION public.normalize_agent_home_env_schema(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_agent_home_env_schema(jsonb)
  TO service_role;

-- Canonicalize an unambiguous legacy ul.routine row so Agent Home and the
-- executor share the same launch-primary marker. Ambiguous historical Agents
-- remain unmarked and fail closed instead of exposing an arbitrary routine.
WITH legacy_launch_routines AS (
  SELECT
    routines.id,
    count(*) OVER (
      PARTITION BY routines.user_id, routines.composer_app_id
    ) AS candidate_count
  FROM public.user_routines AS routines
  WHERE routines.deleted_at IS NULL
    AND routines.composer_app_id IS NOT NULL
    AND routines.metadata->>'source' = 'ul.routine'
    AND routines.metadata->>'launch_primary' IS DISTINCT FROM 'true'
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_routines AS marked
      WHERE marked.user_id = routines.user_id
        AND marked.composer_app_id = routines.composer_app_id
        AND marked.deleted_at IS NULL
        AND marked.metadata->>'launch_primary' = 'true'
    )
)
UPDATE public.user_routines AS routines
SET metadata = COALESCE(routines.metadata, '{}'::jsonb) ||
    '{"launch_primary":true}'::jsonb,
    updated_at = now()
FROM legacy_launch_routines AS legacy
WHERE routines.id = legacy.id
  AND legacy.candidate_count = 1;

CREATE OR REPLACE FUNCTION public.touch_app_agent_home_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions
AS $$
BEGIN
  IF OLD.current_version IS DISTINCT FROM NEW.current_version THEN
    NEW.current_version_promoted_at := now();
  ELSE
    -- Promotion provenance is derived from the live pointer, not an
    -- independently editable timestamp or generic apps.updated_at.
    NEW.current_version_promoted_at := OLD.current_version_promoted_at;
  END IF;

  IF ROW(
    OLD.owner_id,
    OLD.deleted_at,
    OLD.slug,
    OLD.name,
    OLD.description,
    OLD.visibility,
    OLD.download_access,
    OLD.current_version,
    OLD.versions,
    OLD.version_metadata,
    OLD.storage_key,
    OLD.exports,
    OLD.manifest,
    OLD.declared_permissions,
    OLD.env_schema,
    OLD.env_vars,
    OLD.runtime,
    OLD.hosting_suspended,
    OLD.rate_limit_config,
    OLD.http_enabled,
    OLD.http_rate_limit,
    OLD.supabase_enabled,
    OLD.supabase_config_id,
    OLD.supabase_url,
    OLD.supabase_anon_key_encrypted,
    OLD.supabase_service_key_encrypted,
    OLD.d1_database_id,
    OLD.d1_status,
    OLD.gpu_type,
    OLD.gpu_status,
    OLD.gpu_config
  ) IS DISTINCT FROM ROW(
    NEW.owner_id,
    NEW.deleted_at,
    NEW.slug,
    NEW.name,
    NEW.description,
    NEW.visibility,
    NEW.download_access,
    NEW.current_version,
    NEW.versions,
    NEW.version_metadata,
    NEW.storage_key,
    NEW.exports,
    NEW.manifest,
    NEW.declared_permissions,
    NEW.env_schema,
    NEW.env_vars,
    NEW.runtime,
    NEW.hosting_suspended,
    NEW.rate_limit_config,
    NEW.http_enabled,
    NEW.http_rate_limit,
    NEW.supabase_enabled,
    NEW.supabase_config_id,
    NEW.supabase_url,
    NEW.supabase_anon_key_encrypted,
    NEW.supabase_service_key_encrypted,
    NEW.d1_database_id,
    NEW.d1_status,
    NEW.gpu_type,
    NEW.gpu_status,
    NEW.gpu_config
  ) THEN
    NEW.agent_home_revision := OLD.agent_home_revision + 1;
  ELSIF NEW.agent_home_revision IS DISTINCT FROM OLD.agent_home_revision THEN
    -- The baseline grants owners broad UPDATE on apps. Revision itself is not
    -- owner-editable: only the internal bump function may request exactly +1.
    IF current_setting('galactic.agent_home_revision_bump', true) IS DISTINCT FROM
        OLD.id::text OR
       NEW.agent_home_revision IS DISTINCT FROM OLD.agent_home_revision + 1 THEN
      NEW.agent_home_revision := OLD.agent_home_revision;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS touch_apps_agent_home_revision ON public.apps;
CREATE TRIGGER touch_apps_agent_home_revision
  BEFORE UPDATE ON public.apps
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_app_agent_home_revision();

-- Dependent configuration tables bump the owning app without touching
-- apps.updated_at. The optional owner predicate prevents another legacy
-- installer's per-user setting from invalidating an owner's private Home.
CREATE OR REPLACE FUNCTION public.bump_agent_home_revision(
  p_app_id uuid,
  p_owner_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
BEGIN
  IF p_app_id IS NULL THEN RETURN; END IF;
  PERFORM set_config(
    'galactic.agent_home_revision_bump', p_app_id::text, true
  );
  UPDATE public.apps
  SET agent_home_revision = agent_home_revision + 1
  WHERE id = p_app_id
    AND deleted_at IS NULL
    AND (p_owner_id IS NULL OR owner_id = p_owner_id);
  PERFORM set_config('galactic.agent_home_revision_bump', '', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.bump_agent_home_revision_from_routine()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_old_metadata jsonb;
  v_new_metadata jsonb;
  v_changed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.bump_agent_home_revision(NEW.composer_app_id, NEW.user_id);
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM public.bump_agent_home_revision(OLD.composer_app_id, OLD.user_id);
    RETURN NULL;
  END IF;

  -- Runtime-owned bookkeeping is observable on Home but is not edit
  -- concurrency. Status is included separately, so an automatic pause still
  -- invalidates lifecycle actions even though auto_pause itself is stripped.
  v_old_metadata := COALESCE(OLD.metadata, '{}'::jsonb)
    - 'budget_spend' - 'auto_pause';
  v_new_metadata := COALESCE(NEW.metadata, '{}'::jsonb)
    - 'budget_spend' - 'auto_pause';
  v_changed := ROW(
    OLD.user_id,
    OLD.composer_app_id,
    OLD.composer_app_slug,
    OLD.template_id,
    OLD.template_version,
    OLD.name,
    OLD.description,
    OLD.intent,
    OLD.handler_function,
    OLD.status,
    OLD.schedule,
    OLD.config,
    OLD.budget_policy,
    OLD.approval_policy,
    OLD.max_concurrency,
    OLD.deleted_at,
    v_old_metadata
  ) IS DISTINCT FROM ROW(
    NEW.user_id,
    NEW.composer_app_id,
    NEW.composer_app_slug,
    NEW.template_id,
    NEW.template_version,
    NEW.name,
    NEW.description,
    NEW.intent,
    NEW.handler_function,
    NEW.status,
    NEW.schedule,
    NEW.config,
    NEW.budget_policy,
    NEW.approval_policy,
    NEW.max_concurrency,
    NEW.deleted_at,
    v_new_metadata
  );
  IF NOT v_changed THEN RETURN NULL; END IF;

  PERFORM public.bump_agent_home_revision(OLD.composer_app_id, OLD.user_id);
  IF NEW.composer_app_id IS DISTINCT FROM OLD.composer_app_id OR
     NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    PERFORM public.bump_agent_home_revision(NEW.composer_app_id, NEW.user_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS bump_agent_home_revision_on_routine_insert_delete
  ON public.user_routines;
CREATE TRIGGER bump_agent_home_revision_on_routine_insert_delete
  AFTER INSERT OR DELETE ON public.user_routines
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_agent_home_revision_from_routine();

DROP TRIGGER IF EXISTS bump_agent_home_revision_on_routine_update
  ON public.user_routines;
CREATE TRIGGER bump_agent_home_revision_on_routine_update
  AFTER UPDATE OF
    user_id, composer_app_id, composer_app_slug, template_id, template_version,
    name, description, intent, handler_function, status, schedule, config,
    budget_policy, approval_policy, max_concurrency, metadata, deleted_at
  ON public.user_routines
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_agent_home_revision_from_routine();

CREATE OR REPLACE FUNCTION public.bump_agent_home_revision_from_capability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_old_app_id uuid;
  v_new_app_id uuid;
  v_old_user_id uuid;
  v_new_user_id uuid;
  v_changed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT composer_app_id, user_id INTO v_old_app_id, v_old_user_id
    FROM public.user_routines WHERE id = OLD.routine_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT composer_app_id, user_id INTO v_new_app_id, v_new_user_id
    FROM public.user_routines WHERE id = NEW.routine_id;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_changed := ROW(
      OLD.routine_id, OLD.user_id, OLD.app_id, OLD.app_ref,
      OLD.function_name, OLD.access, OLD.required, OLD.purpose,
      OLD.approved, OLD.approved_at, OLD.approved_by_user_id,
      OLD.pricing_snapshot, OLD.constraints, OLD.metadata
    ) IS DISTINCT FROM ROW(
      NEW.routine_id, NEW.user_id, NEW.app_id, NEW.app_ref,
      NEW.function_name, NEW.access, NEW.required, NEW.purpose,
      NEW.approved, NEW.approved_at, NEW.approved_by_user_id,
      NEW.pricing_snapshot, NEW.constraints, NEW.metadata
    );
    IF NOT v_changed THEN RETURN NULL; END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM public.bump_agent_home_revision(v_new_app_id, v_new_user_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.bump_agent_home_revision(v_old_app_id, v_old_user_id);
  ELSIF v_new_app_id IS NOT DISTINCT FROM v_old_app_id AND
        v_new_user_id IS NOT DISTINCT FROM v_old_user_id THEN
    PERFORM public.bump_agent_home_revision(v_new_app_id, v_new_user_id);
  ELSE
    PERFORM public.bump_agent_home_revision(v_old_app_id, v_old_user_id);
    PERFORM public.bump_agent_home_revision(v_new_app_id, v_new_user_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS bump_agent_home_revision_on_capability_insert_delete
  ON public.routine_capabilities;
CREATE TRIGGER bump_agent_home_revision_on_capability_insert_delete
  AFTER INSERT OR DELETE ON public.routine_capabilities
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_agent_home_revision_from_capability();

DROP TRIGGER IF EXISTS bump_agent_home_revision_on_capability_update
  ON public.routine_capabilities;
CREATE TRIGGER bump_agent_home_revision_on_capability_update
  AFTER UPDATE OF
    routine_id, user_id, app_id, app_ref, function_name, access, required,
    purpose, approved, approved_at, approved_by_user_id, pricing_snapshot,
    constraints, metadata
  ON public.routine_capabilities
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_agent_home_revision_from_capability();

CREATE OR REPLACE FUNCTION public.bump_agent_home_revision_from_user_setting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
    OLD.user_id, OLD.app_id, OLD.key, OLD.value_encrypted
  ) IS NOT DISTINCT FROM ROW(
    NEW.user_id, NEW.app_id, NEW.key, NEW.value_encrypted
  ) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM public.bump_agent_home_revision(NEW.app_id, NEW.user_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.bump_agent_home_revision(OLD.app_id, OLD.user_id);
  ELSIF NEW.app_id IS NOT DISTINCT FROM OLD.app_id AND
        NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN
    PERFORM public.bump_agent_home_revision(NEW.app_id, NEW.user_id);
  ELSE
    PERFORM public.bump_agent_home_revision(OLD.app_id, OLD.user_id);
    PERFORM public.bump_agent_home_revision(NEW.app_id, NEW.user_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS bump_agent_home_revision_on_user_setting_insert_delete
  ON public.user_app_secrets;
CREATE TRIGGER bump_agent_home_revision_on_user_setting_insert_delete
  AFTER INSERT OR DELETE ON public.user_app_secrets
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_agent_home_revision_from_user_setting();

DROP TRIGGER IF EXISTS bump_agent_home_revision_on_user_setting_update
  ON public.user_app_secrets;
CREATE TRIGGER bump_agent_home_revision_on_user_setting_update
  AFTER UPDATE OF user_id, app_id, key, value_encrypted
  ON public.user_app_secrets
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_agent_home_revision_from_user_setting();

CREATE OR REPLACE FUNCTION public.bump_agent_home_revision_from_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_changed boolean := false;
  v_target record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_changed := ROW(
      OLD.user_id, OLD.caller_app_id, OLD.caller_function, OLD.slot,
      OLD.target_app_id, OLD.target_function, OLD.topic, OLD.mode, OLD.status,
      OLD.monthly_cap_credits, OLD.constraints
    ) IS DISTINCT FROM ROW(
      NEW.user_id, NEW.caller_app_id, NEW.caller_function, NEW.slot,
      NEW.target_app_id, NEW.target_function, NEW.topic, NEW.mode, NEW.status,
      NEW.monthly_cap_credits, NEW.constraints
    );
    IF NOT v_changed THEN RETURN NULL; END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM public.bump_agent_home_revision(NEW.caller_app_id, NEW.user_id);
    IF NEW.target_app_id IS DISTINCT FROM NEW.caller_app_id THEN
      PERFORM public.bump_agent_home_revision(NEW.target_app_id, NEW.user_id);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.bump_agent_home_revision(OLD.caller_app_id, OLD.user_id);
    IF OLD.target_app_id IS DISTINCT FROM OLD.caller_app_id THEN
      PERFORM public.bump_agent_home_revision(OLD.target_app_id, OLD.user_id);
    END IF;
  ELSE
    FOR v_target IN
      SELECT DISTINCT app_id, owner_id
      FROM (VALUES
        (OLD.caller_app_id, OLD.user_id),
        (OLD.target_app_id, OLD.user_id),
        (NEW.caller_app_id, NEW.user_id),
        (NEW.target_app_id, NEW.user_id)
      ) AS affected(app_id, owner_id)
      WHERE app_id IS NOT NULL AND owner_id IS NOT NULL
    LOOP
      PERFORM public.bump_agent_home_revision(
        v_target.app_id, v_target.owner_id
      );
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS bump_agent_home_revision_on_grant_insert_delete
  ON public.agent_function_grants;
CREATE TRIGGER bump_agent_home_revision_on_grant_insert_delete
  AFTER INSERT OR DELETE ON public.agent_function_grants
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_agent_home_revision_from_grant();

DROP TRIGGER IF EXISTS bump_agent_home_revision_on_grant_update
  ON public.agent_function_grants;
CREATE TRIGGER bump_agent_home_revision_on_grant_update
  AFTER UPDATE OF
    user_id, caller_app_id, caller_function, slot, target_app_id,
    target_function, topic, mode, status, monthly_cap_credits, constraints
  ON public.agent_function_grants
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_agent_home_revision_from_grant();

-- Lock and verify the aggregate config revision. All CAS mutations call this
-- first; FOR UPDATE holds the Agent row until the RPC transaction commits.
CREATE OR REPLACE FUNCTION public.assert_agent_home_revision(
  p_app_id uuid,
  p_user_id uuid,
  p_expected_revision bigint
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_revision bigint;
  v_visibility text;
BEGIN
  IF p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_home_invalid_revision',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_HOME_INVALID_REVISION'
      )::text;
  END IF;

  SELECT agent_home_revision, visibility
    INTO v_revision, v_visibility
  FROM public.apps
  WHERE id = p_app_id
    AND owner_id = p_user_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_home_not_found',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_HOME_NOT_FOUND'
      )::text;
  END IF;
  IF v_visibility IS DISTINCT FROM 'private' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_home_private_required',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_HOME_PRIVATE_REQUIRED'
      )::text;
  END IF;
  IF v_revision <> p_expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_home_revision_conflict',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_HOME_REVISION_CONFLICT',
        'expectedRevision', p_expected_revision::text,
        'actualRevision', v_revision::text
      )::text;
  END IF;
  RETURN v_revision;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_agent_home_revision(
  p_app_id uuid,
  p_user_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_revision bigint;
  v_visibility text;
BEGIN
  SELECT agent_home_revision, visibility
    INTO v_revision, v_visibility
  FROM public.apps
  WHERE id = p_app_id
    AND owner_id = p_user_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_not_found',
      DETAIL = '{"code":"AGENT_HOME_NOT_FOUND"}';
  END IF;
  IF v_visibility IS DISTINCT FROM 'private' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_private_required',
      DETAIL = '{"code":"AGENT_HOME_PRIVATE_REQUIRED"}';
  END IF;
  RETURN v_revision::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_agent_home_identity(
  p_app_id uuid,
  p_user_id uuid,
  p_expected_revision bigint,
  p_set_name boolean DEFAULT false,
  p_name text DEFAULT NULL,
  p_set_description boolean DEFAULT false,
  p_description text DEFAULT NULL
) RETURNS TABLE (new_revision text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
BEGIN
  PERFORM public.assert_agent_home_revision(
    p_app_id, p_user_id, p_expected_revision
  );
  PERFORM public.assert_no_started_agent_home_promotion(p_app_id, p_user_id);
  IF NOT COALESCE(p_set_name, false) AND
     NOT COALESCE(p_set_description, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_no_identity_fields',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION"}';
  END IF;
  IF COALESCE(p_set_name, false) AND
     (p_name IS NULL OR btrim(p_name) = '' OR char_length(btrim(p_name)) > 200) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_name',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"name"}';
  END IF;
  IF COALESCE(p_set_description, false) AND p_description IS NOT NULL AND
     char_length(p_description) > 5000 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_description',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"description"}';
  END IF;

  UPDATE public.apps
  SET name = CASE WHEN p_set_name THEN btrim(p_name) ELSE name END,
      description = CASE
        WHEN p_set_description THEN NULLIF(btrim(p_description), '')
        ELSE description
      END,
      updated_at = now()
  WHERE id = p_app_id AND owner_id = p_user_id AND deleted_at IS NULL;

  RETURN QUERY SELECT agent_home_revision::text
  FROM public.apps WHERE id = p_app_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_agent_home_routine(
  p_app_id uuid,
  p_user_id uuid,
  p_routine_id uuid,
  p_expected_revision bigint,
  p_set_mission boolean DEFAULT false,
  p_mission text DEFAULT NULL,
  p_set_interval boolean DEFAULT false,
  p_interval_seconds bigint DEFAULT NULL,
  p_set_budget boolean DEFAULT false,
  p_budget_policy jsonb DEFAULT NULL
) RETURNS TABLE (new_revision text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_routine public.user_routines%ROWTYPE;
  v_run double precision;
  v_day double precision;
  v_month double precision;
  v_calls double precision;
BEGIN
  PERFORM public.assert_agent_home_revision(
    p_app_id, p_user_id, p_expected_revision
  );
  PERFORM public.assert_no_started_agent_home_promotion(p_app_id, p_user_id);
  SELECT * INTO v_routine
  FROM public.user_routines
  WHERE id = p_routine_id
    AND user_id = p_user_id
    AND composer_app_id = p_app_id
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_routine_not_found',
      DETAIL = '{"code":"AGENT_HOME_ROUTINE_NOT_FOUND"}';
  END IF;
  IF NOT COALESCE(p_set_mission, false) AND
     NOT COALESCE(p_set_interval, false) AND
     NOT COALESCE(p_set_budget, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_no_routine_fields',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION"}';
  END IF;
  IF COALESCE(p_set_mission, false) AND p_mission IS NOT NULL AND
     char_length(btrim(p_mission)) > 1000 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_mission',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"mission"}';
  END IF;
  IF COALESCE(p_set_interval, false) AND
     (p_interval_seconds IS NULL OR p_interval_seconds < 60) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_interval',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"intervalSeconds"}';
  END IF;

  IF COALESCE(p_set_budget, false) THEN
    IF p_budget_policy IS NULL OR jsonb_typeof(p_budget_policy) <> 'object' OR
       NOT (p_budget_policy ?& ARRAY[
         'max_light_per_run', 'max_light_per_day',
         'max_light_per_month', 'max_calls_per_run'
       ]) OR
       (SELECT count(*) FROM jsonb_object_keys(p_budget_policy)) <> 4 OR
       EXISTS (
         SELECT 1 FROM jsonb_each(p_budget_policy) AS entry
         WHERE jsonb_typeof(entry.value) <> 'number'
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_budget',
        DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"budgets"}';
    END IF;
    v_run := (p_budget_policy->>'max_light_per_run')::double precision;
    v_day := (p_budget_policy->>'max_light_per_day')::double precision;
    v_month := (p_budget_policy->>'max_light_per_month')::double precision;
    v_calls := (p_budget_policy->>'max_calls_per_run')::double precision;
    IF v_run < 0 OR v_day < v_run OR v_month < v_day OR v_calls < 1 OR
       v_calls <> trunc(v_calls) OR
       v_run::text IN ('NaN', 'Infinity', '-Infinity') OR
       v_day::text IN ('NaN', 'Infinity', '-Infinity') OR
       v_month::text IN ('NaN', 'Infinity', '-Infinity') OR
       v_calls::text IN ('NaN', 'Infinity', '-Infinity') THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_budget',
        DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"budgets"}';
    END IF;
  END IF;

  UPDATE public.user_routines
  SET intent = CASE
        WHEN p_set_mission THEN NULLIF(btrim(p_mission), '') ELSE intent END,
      schedule = CASE
        WHEN p_set_interval THEN jsonb_build_object(
          'type', 'interval', 'every_seconds', p_interval_seconds
        ) ELSE schedule END,
      next_run_at = CASE
        WHEN p_set_interval AND status = 'active'
          THEN now() + make_interval(secs => p_interval_seconds::double precision)
        ELSE next_run_at END,
      budget_policy = CASE
        WHEN p_set_budget THEN p_budget_policy ELSE budget_policy END,
      updated_at = now()
  WHERE id = p_routine_id
    AND user_id = p_user_id
    AND composer_app_id = p_app_id
    AND deleted_at IS NULL;

  RETURN QUERY SELECT agent_home_revision::text
  FROM public.apps WHERE id = p_app_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_agent_home_settings(
  p_app_id uuid,
  p_user_id uuid,
  p_expected_revision bigint,
  p_agent_ciphertexts jsonb DEFAULT '{}'::jsonb,
  p_per_user_ciphertexts jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (new_revision text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_schema jsonb;
  v_manifest jsonb;
  v_env_vars jsonb;
  v_key text;
  v_value jsonb;
  v_entry jsonb;
  v_scope text;
  v_count integer;
BEGIN
  PERFORM public.assert_agent_home_revision(
    p_app_id, p_user_id, p_expected_revision
  );
  PERFORM public.assert_no_started_agent_home_promotion(p_app_id, p_user_id);
  -- Ciphertexts are produced by the trusted API encryption boundary before
  -- this RPC is called. Browser-provided plaintext is never accepted here.
  IF jsonb_typeof(COALESCE(p_agent_ciphertexts, '{}'::jsonb)) <> 'object' OR
     jsonb_typeof(COALESCE(p_per_user_ciphertexts, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_settings',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"values"}';
  END IF;
  SELECT count(*) INTO v_count FROM (
    SELECT agent_key.key
    FROM jsonb_object_keys(
      COALESCE(p_agent_ciphertexts, '{}'::jsonb)
    ) AS agent_key(key)
    UNION ALL
    SELECT user_key.key
    FROM jsonb_object_keys(
      COALESCE(p_per_user_ciphertexts, '{}'::jsonb)
    ) AS user_key(key)
  ) AS all_keys;
  IF v_count < 1 OR v_count > 50 OR EXISTS (
    SELECT 1
    FROM jsonb_object_keys(
      COALESCE(p_agent_ciphertexts, '{}'::jsonb)
    ) AS agent_key(key)
    JOIN jsonb_object_keys(
      COALESCE(p_per_user_ciphertexts, '{}'::jsonb)
    ) AS user_key(key)
      ON agent_key.key = user_key.key
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_settings',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"values"}';
  END IF;

  SELECT COALESCE(env_schema, '{}'::jsonb), COALESCE(env_vars, '{}'::jsonb),
         public.try_parse_agent_home_jsonb(manifest)
    INTO v_schema, v_env_vars, v_manifest
  FROM public.apps WHERE id = p_app_id;
  v_schema := public.normalize_agent_home_env_schema(v_schema);
  IF v_schema = '{}'::jsonb AND jsonb_typeof(v_manifest) = 'object' THEN
    -- Normalize aliases separately so an invalid current entry cannot erase a
    -- valid legacy declaration; valid env_vars entries override env entries.
    v_schema := public.normalize_agent_home_env_schema(
      COALESCE(v_manifest->'env', '{}'::jsonb)
    ) || public.normalize_agent_home_env_schema(
      COALESCE(v_manifest->'env_vars', '{}'::jsonb)
    );
  END IF;
  IF jsonb_typeof(v_schema) <> 'object' OR
     jsonb_typeof(v_env_vars) <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_settings_state_invalid',
      DETAIL = '{"code":"AGENT_HOME_SERVICE_UNAVAILABLE"}';
  END IF;

  FOR v_key, v_value IN
    SELECT key, value FROM jsonb_each(COALESCE(p_agent_ciphertexts, '{}'::jsonb))
  LOOP
    v_entry := v_schema -> v_key;
    v_scope := v_entry->>'scope';
    IF v_entry IS NULL OR jsonb_typeof(v_entry) <> 'object' OR
       v_scope IS DISTINCT FROM 'universal' OR
       jsonb_typeof(v_value) NOT IN ('string', 'null') OR
       (jsonb_typeof(v_value) = 'string' AND
        (v_value #>> '{}') = '') THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_agent_setting',
        DETAIL = jsonb_build_object(
          'code', 'AGENT_HOME_INVALID_MUTATION', 'field', v_key
        )::text;
    END IF;
    IF jsonb_typeof(v_value) = 'null' THEN
      v_env_vars := v_env_vars - v_key;
    ELSE
      v_env_vars := jsonb_set(v_env_vars, ARRAY[v_key], v_value, true);
    END IF;
  END LOOP;

  IF COALESCE(p_agent_ciphertexts, '{}'::jsonb) <> '{}'::jsonb THEN
    UPDATE public.apps
    SET env_vars = v_env_vars, updated_at = now()
    WHERE id = p_app_id AND owner_id = p_user_id AND deleted_at IS NULL;
  END IF;

  FOR v_key, v_value IN
    SELECT key, value FROM jsonb_each(COALESCE(p_per_user_ciphertexts, '{}'::jsonb))
  LOOP
    v_entry := v_schema -> v_key;
    v_scope := v_entry->>'scope';
    IF v_entry IS NULL OR jsonb_typeof(v_entry) <> 'object' OR
       v_scope IS DISTINCT FROM 'per_user' OR
       jsonb_typeof(v_value) NOT IN ('string', 'null') OR
       (jsonb_typeof(v_value) = 'string' AND
        (v_value #>> '{}') = '') THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_user_setting',
        DETAIL = jsonb_build_object(
          'code', 'AGENT_HOME_INVALID_MUTATION', 'field', v_key
        )::text;
    END IF;
    IF jsonb_typeof(v_value) = 'null' THEN
      DELETE FROM public.user_app_secrets
      WHERE user_id = p_user_id AND app_id = p_app_id AND key = v_key;
    ELSE
      INSERT INTO public.user_app_secrets (
        user_id, app_id, key, value_encrypted, updated_at
      ) VALUES (
        p_user_id, p_app_id, v_key, v_value #>> '{}', now()
      )
      ON CONFLICT (user_id, app_id, key) DO UPDATE
      SET value_encrypted = EXCLUDED.value_encrypted,
          updated_at = EXCLUDED.updated_at;
    END IF;
  END LOOP;

  RETURN QUERY SELECT agent_home_revision::text
  FROM public.apps WHERE id = p_app_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_agent_home_routine_status(
  p_app_id uuid,
  p_user_id uuid,
  p_routine_id uuid,
  p_expected_revision bigint,
  p_status text,
  p_next_run_at timestamp with time zone DEFAULT NULL
) RETURNS TABLE (new_revision text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
BEGIN
  PERFORM public.assert_agent_home_revision(
    p_app_id, p_user_id, p_expected_revision
  );
  IF p_status IS NULL OR p_status NOT IN ('active', 'paused') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_routine_status',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"status"}';
  END IF;

  PERFORM 1
  FROM public.user_routines
  WHERE id = p_routine_id
    AND user_id = p_user_id
    AND composer_app_id = p_app_id
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_routine_not_found',
      DETAIL = '{"code":"AGENT_HOME_ROUTINE_NOT_FOUND"}';
  END IF;

  UPDATE public.user_routines
  SET status = p_status,
      next_run_at = CASE
        WHEN p_status = 'active' THEN COALESCE(p_next_run_at, now())
        ELSE NULL
      END,
      updated_at = now()
  WHERE id = p_routine_id
    AND user_id = p_user_id
    AND composer_app_id = p_app_id
    AND deleted_at IS NULL;

  RETURN QUERY SELECT agent_home_revision::text
  FROM public.apps
  WHERE id = p_app_id AND owner_id = p_user_id AND deleted_at IS NULL;
END;
$$;

-- Safety-only stop lane. It intentionally has no expected revision or action
-- lease: one transaction locks the owned private Agent, resolves the current
-- canonical routine, refuses a concurrently-disabled routine, and pauses it
-- idempotently. This remains available during promotion repair/outages.
CREATE OR REPLACE FUNCTION public.pause_agent_home_routine_emergency(
  p_app_id uuid,
  p_user_id uuid
) RETURNS TABLE (
  routine_id uuid,
  routine_status text,
  new_revision text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_routine public.user_routines%ROWTYPE;
BEGIN
  PERFORM 1
  FROM public.apps
  WHERE id = p_app_id
    AND owner_id = p_user_id
    AND visibility = 'private'
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_not_found',
      DETAIL = '{"code":"AGENT_HOME_NOT_FOUND"}';
  END IF;

  SELECT * INTO v_routine
  FROM public.user_routines
  WHERE user_id = p_user_id
    AND composer_app_id = p_app_id
    AND deleted_at IS NULL
    AND metadata->>'launch_primary' = 'true'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_routine_not_found',
      DETAIL = '{"code":"AGENT_HOME_ROUTINE_NOT_FOUND"}';
  END IF;
  IF v_routine.status = 'disabled' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_routine_disabled',
      DETAIL = '{"code":"AGENT_HOME_ROUTINE_DISABLED"}';
  END IF;

  IF v_routine.status <> 'paused' THEN
    UPDATE public.user_routines
    SET status = 'paused', next_run_at = NULL, updated_at = now()
    WHERE id = v_routine.id
      AND user_id = p_user_id
      AND composer_app_id = p_app_id
      AND deleted_at IS NULL
      AND status <> 'disabled';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_routine_disabled',
        DETAIL = '{"code":"AGENT_HOME_ROUTINE_DISABLED"}';
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_routine.id, 'paused'::text, apps.agent_home_revision::text
  FROM public.apps AS apps WHERE apps.id = p_app_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_agent_home_capabilities(
  p_app_id uuid,
  p_user_id uuid,
  p_routine_id uuid,
  p_expected_revision bigint,
  p_capability_ids uuid[]
) RETURNS TABLE (new_revision text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_requested integer;
  v_found integer;
BEGIN
  PERFORM public.assert_agent_home_revision(
    p_app_id, p_user_id, p_expected_revision
  );
  IF p_capability_ids IS NULL OR cardinality(p_capability_ids) < 1 OR
     cardinality(p_capability_ids) > 100 OR
     array_position(p_capability_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_capabilities',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"capabilityIds"}';
  END IF;

  PERFORM 1
  FROM public.user_routines
  WHERE id = p_routine_id
    AND user_id = p_user_id
    AND composer_app_id = p_app_id
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_routine_not_found',
      DETAIL = '{"code":"AGENT_HOME_ROUTINE_NOT_FOUND"}';
  END IF;

  SELECT count(DISTINCT requested_id)::integer INTO v_requested
  FROM unnest(p_capability_ids) AS requested(requested_id);
  SELECT count(DISTINCT capabilities.id)::integer INTO v_found
  FROM public.routine_capabilities AS capabilities
  WHERE capabilities.id = ANY(p_capability_ids)
    AND capabilities.routine_id = p_routine_id
    AND capabilities.user_id = p_user_id;
  IF v_found <> v_requested THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_capability_not_found',
      DETAIL = '{"code":"AGENT_HOME_CAPABILITY_NOT_FOUND"}';
  END IF;

  UPDATE public.routine_capabilities
  SET approved = true,
      approved_at = now(),
      approved_by_user_id = p_user_id,
      updated_at = now()
  WHERE id = ANY(p_capability_ids)
    AND routine_id = p_routine_id
    AND user_id = p_user_id;

  RETURN QUERY SELECT agent_home_revision::text
  FROM public.apps
  WHERE id = p_app_id AND owner_id = p_user_id AND deleted_at IS NULL;
END;
$$;

-- A durable request claim is the idempotency boundary for user-triggered
-- operations that cross the database/runtime boundary (currently run-now and
-- candidate promotion). The first claim applies revision CAS; later requests
-- with the same key replay only when their full canonical payload matches,
-- even if the browser refreshed to a newer revision in the meantime.
CREATE TABLE IF NOT EXISTS public.agent_home_action_requests (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  action text NOT NULL,
  request_payload jsonb NOT NULL,
  request_fingerprint text NOT NULL,
  expected_revision bigint NOT NULL,
  status text DEFAULT 'in_progress'::text NOT NULL,
  response jsonb DEFAULT '{}'::jsonb NOT NULL,
  attempt_count integer DEFAULT 1 NOT NULL,
  lease_token uuid DEFAULT gen_random_uuid() NOT NULL,
  lease_expires_at timestamp with time zone DEFAULT
    (now() + interval '30 minutes') NOT NULL,
  side_effect_started_at timestamp with time zone,
  side_effect_phase text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  CONSTRAINT agent_home_action_key_length
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT agent_home_action_name_length
    CHECK (char_length(action) BETWEEN 1 AND 80),
  CONSTRAINT agent_home_action_fingerprint_length
    CHECK (char_length(request_fingerprint) = 64),
  CONSTRAINT agent_home_action_expected_revision_positive
    CHECK (expected_revision >= 1),
  CONSTRAINT agent_home_action_attempt_count_positive
    CHECK (attempt_count >= 1),
  CONSTRAINT agent_home_action_status_check
    CHECK (status IN ('in_progress', 'completed', 'failed')),
  CONSTRAINT agent_home_action_phase_check
    CHECK (side_effect_phase IS NULL OR side_effect_phase IN (
      'd1', 'live_bundle', 'app_record', 'storage_accounting'
    )),
  CONSTRAINT agent_home_action_request_unique
    UNIQUE (user_id, app_id, idempotency_key)
);

ALTER TABLE public.agent_home_action_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_home_action_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.agent_home_action_requests TO service_role;

CREATE OR REPLACE FUNCTION public.assert_no_started_agent_home_promotion(
  p_app_id uuid,
  p_user_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.agent_home_action_requests
    WHERE app_id = p_app_id
      AND user_id = p_user_id
      AND action = 'promote_candidate'
      AND status = 'in_progress'
      AND side_effect_started_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_promotion_in_progress',
      DETAIL = '{"code":"AGENT_HOME_ACTION_IN_PROGRESS"}';
  END IF;
END;
$$;

-- Every client key that has ever claimed a durable request remains bound to
-- that request. This lets a replacement browser key recover an expired lease
-- without making a late retry from either browser capable of duplicating the
-- side effect.
CREATE TABLE IF NOT EXISTS public.agent_home_action_request_keys (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_id uuid NOT NULL
    REFERENCES public.agent_home_action_requests(id) ON DELETE CASCADE,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT agent_home_action_alias_key_length
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT agent_home_action_alias_unique
    UNIQUE (user_id, app_id, idempotency_key)
);

ALTER TABLE public.agent_home_action_request_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_home_action_request_keys
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.agent_home_action_request_keys TO service_role;

-- Safe for a resumed/partially-applied migration as well as a fresh install.
INSERT INTO public.agent_home_action_request_keys (
  user_id, app_id, idempotency_key, request_id
)
SELECT user_id, app_id, idempotency_key, id
FROM public.agent_home_action_requests
ON CONFLICT (user_id, app_id, idempotency_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_agent_home_action_requests_in_progress
  ON public.agent_home_action_requests (lease_expires_at)
  WHERE status = 'in_progress';

-- One durable owner action may mutate an Agent at a time. App-row locking in
-- the claim RPC gives friendly errors; this index is the race-proof backstop.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_home_one_action_in_progress
  ON public.agent_home_action_requests (app_id)
  WHERE status = 'in_progress';

ALTER TABLE public.routine_runs
  ADD COLUMN IF NOT EXISTS agent_home_action_request_id uuid
  REFERENCES public.agent_home_action_requests(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_runs_agent_home_action_request
  ON public.routine_runs (agent_home_action_request_id)
  WHERE agent_home_action_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_agent_home_action(
  p_app_id uuid,
  p_user_id uuid,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_action text,
  p_request_payload jsonb
) RETURNS TABLE (
  request_id uuid,
  is_new boolean,
  request_status text,
  request_response jsonb,
  request_fingerprint text,
  request_lease_token uuid,
  current_revision text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_revision bigint;
  v_visibility text;
  v_existing public.agent_home_action_requests%ROWTYPE;
  v_request_id uuid;
  v_lease_token uuid;
  v_fingerprint text;
BEGIN
  IF p_expected_revision IS NULL OR p_expected_revision < 1 OR
     p_idempotency_key IS NULL OR
     char_length(btrim(p_idempotency_key)) NOT BETWEEN 1 AND 200 OR
     p_action IS NULL OR char_length(btrim(p_action)) NOT BETWEEN 1 AND 80 OR
     p_request_payload IS NULL OR jsonb_typeof(p_request_payload) <> 'object' OR
     p_request_payload->>'action' IS DISTINCT FROM btrim(p_action) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_action_claim',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION"}';
  END IF;
  v_fingerprint := encode(
    extensions.digest(convert_to(p_request_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );

  -- Serialize claims per Agent. An existing matching request replays even if
  -- the successfully-started action has since advanced the Agent revision.
  SELECT agent_home_revision, visibility
    INTO v_revision, v_visibility
  FROM public.apps
  WHERE id = p_app_id
    AND owner_id = p_user_id
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_not_found',
      DETAIL = '{"code":"AGENT_HOME_NOT_FOUND"}';
  END IF;
  IF v_visibility IS DISTINCT FROM 'private' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_private_required',
      DETAIL = '{"code":"AGENT_HOME_PRIVATE_REQUIRED"}';
  END IF;

  SELECT requests.* INTO v_existing
  FROM public.agent_home_action_requests AS requests
  WHERE requests.user_id = p_user_id
    AND requests.app_id = p_app_id
    AND (
      requests.idempotency_key = btrim(p_idempotency_key) OR
      EXISTS (
        SELECT 1
        FROM public.agent_home_action_request_keys AS keys
        WHERE keys.user_id = p_user_id
          AND keys.app_id = p_app_id
          AND keys.idempotency_key = btrim(p_idempotency_key)
          AND keys.request_id = requests.id
      )
    )
  FOR UPDATE OF requests;
  IF FOUND THEN
    IF v_existing.action IS DISTINCT FROM btrim(p_action) OR
       v_existing.request_payload IS DISTINCT FROM p_request_payload OR
       v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_idempotency_mismatch',
        DETAIL = '{"code":"AGENT_HOME_IDEMPOTENCY_MISMATCH"}';
    END IF;
    IF v_existing.status = 'in_progress' AND
       v_existing.lease_expires_at <= now() THEN
      UPDATE public.agent_home_action_requests
      SET attempt_count = attempt_count + 1,
          lease_token = gen_random_uuid(),
          lease_expires_at = now() + interval '30 minutes',
          updated_at = now()
      WHERE id = v_existing.id;
      SELECT * INTO v_existing
      FROM public.agent_home_action_requests
      WHERE id = v_existing.id;
      RETURN QUERY SELECT
        v_existing.id, true, v_existing.status, v_existing.response,
        v_existing.request_fingerprint, v_existing.lease_token,
        v_revision::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT
      v_existing.id, false, v_existing.status, v_existing.response,
      v_existing.request_fingerprint, v_existing.lease_token,
      v_revision::text;
    RETURN;
  END IF;

  -- A browser may lose sessionStorage after the API crossed an external
  -- boundary. Once the lease expires, a fresh key for the exact canonical
  -- payload takes over the same request and is durably aliased to it. A
  -- different payload must first reconcile the prior request; returning the
  -- owner-only recovery data makes that operation actionable without ever
  -- guessing whether the old side effect committed.
  SELECT * INTO v_existing
  FROM public.agent_home_action_requests
  WHERE user_id = p_user_id
    AND app_id = p_app_id
    AND status = 'in_progress'
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.lease_expires_at > now() THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_action_in_progress',
        DETAIL = '{"code":"AGENT_HOME_ACTION_IN_PROGRESS"}';
    END IF;
    IF v_existing.action IS DISTINCT FROM btrim(p_action) OR
       v_existing.request_payload IS DISTINCT FROM p_request_payload OR
       v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_action_recovery_required',
        DETAIL = jsonb_build_object(
          'code', 'AGENT_HOME_ACTION_RECOVERY_REQUIRED',
          'requestId', v_existing.id,
          'idempotencyKey', v_existing.idempotency_key,
          'action', v_existing.action,
          'requestPayload', v_existing.request_payload
        )::text;
    END IF;

    INSERT INTO public.agent_home_action_request_keys (
      user_id, app_id, idempotency_key, request_id
    ) VALUES (
      p_user_id, p_app_id, btrim(p_idempotency_key), v_existing.id
    ) ON CONFLICT (user_id, app_id, idempotency_key) DO NOTHING;
    IF NOT EXISTS (
      SELECT 1 FROM public.agent_home_action_request_keys
      WHERE user_id = p_user_id
        AND app_id = p_app_id
        AND idempotency_key = btrim(p_idempotency_key)
        AND request_id = v_existing.id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'agent_home_idempotency_mismatch',
        DETAIL = '{"code":"AGENT_HOME_IDEMPOTENCY_MISMATCH"}';
    END IF;

    UPDATE public.agent_home_action_requests
    SET attempt_count = attempt_count + 1,
        lease_token = gen_random_uuid(),
        lease_expires_at = now() + interval '30 minutes',
        updated_at = now()
    WHERE id = v_existing.id;
    SELECT * INTO v_existing
    FROM public.agent_home_action_requests
    WHERE id = v_existing.id;
    RETURN QUERY SELECT
      v_existing.id, true, v_existing.status, v_existing.response,
      v_existing.request_fingerprint, v_existing.lease_token,
      v_revision::text;
    RETURN;
  END IF;

  IF v_revision <> p_expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_revision_conflict',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_HOME_REVISION_CONFLICT',
        'expectedRevision', p_expected_revision::text,
        'actualRevision', v_revision::text
      )::text;
  END IF;


  INSERT INTO public.agent_home_action_requests (
    user_id, app_id, idempotency_key, action, request_payload,
    request_fingerprint, expected_revision
  ) VALUES (
    p_user_id, p_app_id, btrim(p_idempotency_key), btrim(p_action),
    p_request_payload, v_fingerprint, p_expected_revision
  ) RETURNING id, lease_token INTO v_request_id, v_lease_token;

  INSERT INTO public.agent_home_action_request_keys (
    user_id, app_id, idempotency_key, request_id
  ) VALUES (
    p_user_id, p_app_id, btrim(p_idempotency_key), v_request_id
  );

  RETURN QUERY SELECT
    v_request_id, true, 'in_progress'::text, '{}'::jsonb,
    v_fingerprint, v_lease_token,
    v_revision::text;
END;
$$;

-- Linearize the first irreversible promotion phase against the exact Home
-- revision that the owner reviewed. Once started, the durable saga token—not
-- the original revision—fences later phases and repair retries, because the
-- promotion's own app-record commit legitimately advances that revision.
CREATE OR REPLACE FUNCTION public.fence_agent_home_promotion_step(
  p_request_id uuid,
  p_app_id uuid,
  p_user_id uuid,
  p_lease_token uuid,
  p_step text
) RETURNS TABLE (
  lease_expires_at timestamp with time zone,
  current_revision text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_existing public.agent_home_action_requests%ROWTYPE;
  v_revision bigint;
  v_visibility text;
  v_expires_at timestamp with time zone;
  v_old_rank integer;
  v_new_rank integer;
BEGIN
  IF p_lease_token IS NULL OR p_step NOT IN (
    'd1', 'live_bundle', 'app_record', 'storage_accounting'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_promotion_fence',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION"}';
  END IF;

  SELECT agent_home_revision, visibility
    INTO v_revision, v_visibility
  FROM public.apps
  WHERE id = p_app_id
    AND owner_id = p_user_id
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_not_found',
      DETAIL = '{"code":"AGENT_HOME_NOT_FOUND"}';
  END IF;
  IF v_visibility IS DISTINCT FROM 'private' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_private_required',
      DETAIL = '{"code":"AGENT_HOME_PRIVATE_REQUIRED"}';
  END IF;

  SELECT * INTO v_existing
  FROM public.agent_home_action_requests
  WHERE id = p_request_id
    AND user_id = p_user_id
    AND app_id = p_app_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_action_not_found',
      DETAIL = '{"code":"AGENT_HOME_ACTION_NOT_FOUND"}';
  END IF;
  IF v_existing.status <> 'in_progress' OR
     v_existing.action <> 'promote_candidate' OR
     v_existing.lease_token IS DISTINCT FROM p_lease_token OR
     v_existing.lease_expires_at <= now() THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_promotion_fence_lost',
      DETAIL = '{"code":"AGENT_HOME_ACTION_IN_PROGRESS"}';
  END IF;

  IF v_existing.side_effect_started_at IS NULL AND
     v_revision <> v_existing.expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_revision_conflict',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_HOME_REVISION_CONFLICT',
        'expectedRevision', v_existing.expected_revision::text,
        'actualRevision', v_revision::text
      )::text;
  END IF;

  v_old_rank := CASE v_existing.side_effect_phase
    WHEN 'd1' THEN 1 WHEN 'live_bundle' THEN 2
    WHEN 'app_record' THEN 3 WHEN 'storage_accounting' THEN 4 ELSE 0 END;
  v_new_rank := CASE p_step
    WHEN 'd1' THEN 1 WHEN 'live_bundle' THEN 2
    WHEN 'app_record' THEN 3 WHEN 'storage_accounting' THEN 4 ELSE 0 END;
  v_expires_at := now() + interval '30 minutes';
  UPDATE public.agent_home_action_requests
  SET side_effect_started_at = COALESCE(side_effect_started_at, now()),
      side_effect_phase = CASE
        WHEN v_new_rank > v_old_rank THEN p_step ELSE side_effect_phase END,
      lease_expires_at = v_expires_at,
      updated_at = now()
  WHERE id = p_request_id;

  RETURN QUERY SELECT v_expires_at, v_revision::text;
END;
$$;

-- Reject competing release-pointer/schema writes after the saga starts.
-- The action-owned app-record RPC sets a transaction-local request id which
-- this trigger verifies against the live fenced request.
CREATE OR REPLACE FUNCTION public.guard_agent_home_promotion_release_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_request_id uuid;
  v_authorized text;
BEGIN
  IF ROW(
    OLD.current_version, OLD.versions, OLD.version_metadata,
    OLD.storage_key, OLD.exports, OLD.manifest, OLD.env_schema
  ) IS NOT DISTINCT FROM ROW(
    NEW.current_version, NEW.versions, NEW.version_metadata,
    NEW.storage_key, NEW.exports, NEW.manifest, NEW.env_schema
  ) THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_request_id
  FROM public.agent_home_action_requests
  WHERE app_id = OLD.id
    AND action = 'promote_candidate'
    AND status = 'in_progress'
    AND side_effect_started_at IS NOT NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;

  v_authorized := current_setting(
    'galactic.agent_home_promotion_request', true
  );
  IF v_authorized IS DISTINCT FROM v_request_id::text THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_promotion_release_locked',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_HOME_ACTION_IN_PROGRESS',
        'requestId', v_request_id
      )::text;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_agent_home_promotion_release_write ON public.apps;
CREATE TRIGGER guard_agent_home_promotion_release_write
  BEFORE UPDATE OF
    current_version, versions, version_metadata, storage_key, exports,
    manifest, env_schema
  ON public.apps
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_agent_home_promotion_release_write();

CREATE OR REPLACE FUNCTION public.commit_agent_home_promotion_app_record(
  p_request_id uuid,
  p_app_id uuid,
  p_user_id uuid,
  p_lease_token uuid,
  p_version text,
  p_storage_key text,
  p_exports jsonb,
  p_set_manifest boolean,
  p_manifest text DEFAULT NULL,
  p_env_schema jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (new_revision text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_existing public.agent_home_action_requests%ROWTYPE;
BEGIN
  IF p_lease_token IS NULL OR p_version IS NULL OR btrim(p_version) = '' OR
     p_storage_key IS NULL OR btrim(p_storage_key) = '' OR
     jsonb_typeof(p_exports) <> 'array' OR
     p_set_manifest IS NULL OR
     (p_set_manifest AND (
       p_manifest IS NULL OR jsonb_typeof(p_env_schema) <> 'object'
     )) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_promotion_record',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION"}';
  END IF;

  PERFORM 1
  FROM public.apps
  WHERE id = p_app_id
    AND owner_id = p_user_id
    AND visibility = 'private'
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_not_found',
      DETAIL = '{"code":"AGENT_HOME_NOT_FOUND"}';
  END IF;

  SELECT * INTO v_existing
  FROM public.agent_home_action_requests
  WHERE id = p_request_id
    AND user_id = p_user_id
    AND app_id = p_app_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_action_not_found',
      DETAIL = '{"code":"AGENT_HOME_ACTION_NOT_FOUND"}';
  END IF;
  IF v_existing.status <> 'in_progress' OR
     v_existing.action <> 'promote_candidate' OR
     v_existing.request_payload->>'version' IS DISTINCT FROM p_version OR
     v_existing.side_effect_started_at IS NULL OR
     v_existing.lease_token IS DISTINCT FROM p_lease_token OR
     v_existing.lease_expires_at <= now() THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_promotion_fence_lost',
      DETAIL = '{"code":"AGENT_HOME_ACTION_IN_PROGRESS"}';
  END IF;

  PERFORM set_config(
    'galactic.agent_home_promotion_request', v_existing.id::text, true
  );
  UPDATE public.apps
  SET current_version = p_version,
      storage_key = p_storage_key,
      exports = p_exports,
      manifest = CASE WHEN p_set_manifest THEN p_manifest ELSE manifest END,
      env_schema = CASE
        WHEN p_set_manifest THEN p_env_schema ELSE env_schema END,
      updated_at = now()
  WHERE id = p_app_id
    AND owner_id = p_user_id
    AND deleted_at IS NULL;

  RETURN QUERY SELECT agent_home_revision::text
  FROM public.apps WHERE id = p_app_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_agent_home_action_lease(
  p_request_id uuid,
  p_app_id uuid,
  p_user_id uuid,
  p_lease_token uuid
) RETURNS timestamp with time zone
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_existing public.agent_home_action_requests%ROWTYPE;
  v_expires_at timestamp with time zone;
BEGIN
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_action_lease',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION"}';
  END IF;

  PERFORM 1
  FROM public.apps
  WHERE id = p_app_id
    AND owner_id = p_user_id
    AND visibility = 'private'
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_not_found',
      DETAIL = '{"code":"AGENT_HOME_NOT_FOUND"}';
  END IF;

  SELECT * INTO v_existing
  FROM public.agent_home_action_requests
  WHERE id = p_request_id
    AND user_id = p_user_id
    AND app_id = p_app_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_action_not_found',
      DETAIL = '{"code":"AGENT_HOME_ACTION_NOT_FOUND"}';
  END IF;
  IF v_existing.status <> 'in_progress' OR
     v_existing.lease_token IS DISTINCT FROM p_lease_token OR
     v_existing.lease_expires_at <= now() THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_action_lease_lost',
      DETAIL = '{"code":"AGENT_HOME_ACTION_IN_PROGRESS"}';
  END IF;

  v_expires_at := now() + interval '30 minutes';
  UPDATE public.agent_home_action_requests
  SET lease_expires_at = v_expires_at,
      updated_at = now()
  WHERE id = p_request_id;
  RETURN v_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_agent_home_action(
  p_request_id uuid,
  p_app_id uuid,
  p_user_id uuid,
  p_lease_token uuid,
  p_status text,
  p_response jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (
  request_id uuid,
  request_status text,
  request_response jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_existing public.agent_home_action_requests%ROWTYPE;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('completed', 'failed') OR
     p_lease_token IS NULL OR
     p_response IS NULL OR jsonb_typeof(p_response) <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_action_completion',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION"}';
  END IF;

  PERFORM 1
  FROM public.apps
  WHERE id = p_app_id
    AND owner_id = p_user_id
    AND visibility = 'private'
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_not_found',
      DETAIL = '{"code":"AGENT_HOME_NOT_FOUND"}';
  END IF;

  SELECT * INTO v_existing
  FROM public.agent_home_action_requests
  WHERE id = p_request_id
    AND user_id = p_user_id
    AND app_id = p_app_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_action_not_found',
      DETAIL = '{"code":"AGENT_HOME_ACTION_NOT_FOUND"}';
  END IF;
  IF v_existing.status <> 'in_progress' THEN
    IF v_existing.status = p_status AND v_existing.response = p_response THEN
      RETURN QUERY SELECT
        v_existing.id, v_existing.status, v_existing.response;
      RETURN;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_action_already_completed',
      DETAIL = '{"code":"AGENT_HOME_IDEMPOTENCY_MISMATCH"}';
  END IF;
  IF v_existing.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_action_lease_lost',
      DETAIL = '{"code":"AGENT_HOME_ACTION_IN_PROGRESS"}';
  END IF;

  UPDATE public.agent_home_action_requests
  SET status = p_status,
      response = p_response,
      lease_expires_at = now(),
      completed_at = now(),
      updated_at = now()
  WHERE id = p_request_id
    AND user_id = p_user_id
    AND app_id = p_app_id;

  RETURN QUERY SELECT p_request_id, p_status, p_response;
END;
$$;

-- Run-now crosses from a config decision into the executor queue. Keep the
-- lease, revision, active canonical routine, and idempotent run insert inside
-- one database transaction so no stale worker can enqueue after a config edit.
CREATE OR REPLACE FUNCTION public.queue_agent_home_routine_run(
  p_request_id uuid,
  p_app_id uuid,
  p_user_id uuid,
  p_routine_id uuid,
  p_lease_token uuid,
  p_expected_revision bigint
) RETURNS TABLE (
  run_id uuid,
  is_new boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_revision bigint;
  v_existing public.agent_home_action_requests%ROWTYPE;
  v_run_id uuid;
  v_max_concurrency integer;
  v_active_runs integer;
BEGIN
  SELECT agent_home_revision INTO v_revision
  FROM public.apps
  WHERE id = p_app_id
    AND owner_id = p_user_id
    AND visibility = 'private'
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_not_found',
      DETAIL = '{"code":"AGENT_HOME_NOT_FOUND"}';
  END IF;

  SELECT * INTO v_existing
  FROM public.agent_home_action_requests
  WHERE id = p_request_id
    AND user_id = p_user_id
    AND app_id = p_app_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_action_not_found',
      DETAIL = '{"code":"AGENT_HOME_ACTION_NOT_FOUND"}';
  END IF;
  IF v_existing.status <> 'in_progress' OR
     v_existing.action <> 'run_now' OR
     v_existing.expected_revision <> p_expected_revision OR
     v_existing.lease_token IS DISTINCT FROM p_lease_token OR
     v_existing.lease_expires_at <= now() THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_action_lease_lost',
      DETAIL = '{"code":"AGENT_HOME_ACTION_IN_PROGRESS"}';
  END IF;

  SELECT runs.id INTO v_run_id
  FROM public.routine_runs AS runs
  WHERE runs.agent_home_action_request_id = p_request_id
    AND runs.user_id = p_user_id
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_run_id, false;
    RETURN;
  END IF;

  IF v_revision <> p_expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_revision_conflict',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_HOME_REVISION_CONFLICT',
        'expectedRevision', p_expected_revision::text,
        'actualRevision', v_revision::text
      )::text;
  END IF;

  SELECT max_concurrency INTO v_max_concurrency
  FROM public.user_routines
  WHERE id = p_routine_id
    AND user_id = p_user_id
    AND composer_app_id = p_app_id
    AND deleted_at IS NULL
    AND status = 'active'
    AND metadata->>'launch_primary' = 'true'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_routine_not_found',
      DETAIL = '{"code":"AGENT_HOME_ROUTINE_NOT_FOUND"}';
  END IF;

  SELECT count(*)::integer INTO v_active_runs
  FROM public.routine_runs
  WHERE routine_id = p_routine_id
    AND user_id = p_user_id
    AND status IN ('queued', 'running');
  IF v_active_runs >= v_max_concurrency THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_run_concurrency_limit',
      DETAIL = jsonb_build_object(
        'code', 'AGENT_HOME_RUN_CONCURRENCY_LIMIT',
        'activeRuns', v_active_runs,
        'maxConcurrency', v_max_concurrency
      )::text;
  END IF;

  INSERT INTO public.routine_runs (
    routine_id,
    user_id,
    status,
    trigger,
    trace_id,
    run_config,
    metadata,
    agent_home_action_request_id
  ) VALUES (
    p_routine_id,
    p_user_id,
    'queued',
    'manual',
    gen_random_uuid(),
    '{}'::jsonb,
    '{"source":"command_monitor.run_now"}'::jsonb,
    p_request_id
  ) RETURNING id INTO v_run_id;

  UPDATE public.agent_home_action_requests
  SET lease_expires_at = now() + interval '30 minutes',
      updated_at = now()
  WHERE id = p_request_id;

  RETURN QUERY SELECT v_run_id, true;
END;
$$;

-- The queue consumer's queued -> running PATCH is the last concurrency gate.
-- Serialize that transition on the parent routine so Cloudflare Queue
-- autoscaling cannot execute two runs for a max_concurrency=1 Agent. A denied
-- transition rolls back, leaves the row queued, and the minute dispatcher can
-- safely retry it after the active run finishes.
CREATE OR REPLACE FUNCTION public.enforce_routine_run_max_concurrency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_max_concurrency integer;
  v_running integer;
BEGIN
  IF NEW.status IS DISTINCT FROM 'running' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'running' THEN
    RETURN NEW;
  END IF;

  SELECT max_concurrency INTO v_max_concurrency
  FROM public.user_routines
  WHERE id = NEW.routine_id
    AND user_id = NEW.user_id
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'routine_run_parent_not_found',
      DETAIL = '{"code":"ROUTINE_RUN_PARENT_NOT_FOUND"}';
  END IF;

  SELECT count(*)::integer INTO v_running
  FROM public.routine_runs
  WHERE routine_id = NEW.routine_id
    AND user_id = NEW.user_id
    AND status = 'running'
    AND id IS DISTINCT FROM NEW.id;
  IF v_running >= v_max_concurrency THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'routine_run_concurrency_limit',
      DETAIL = jsonb_build_object(
        'code', 'ROUTINE_RUN_CONCURRENCY_LIMIT',
        'running', v_running,
        'maxConcurrency', v_max_concurrency
      )::text;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_routine_run_max_concurrency
  ON public.routine_runs;
CREATE TRIGGER enforce_routine_run_max_concurrency
  BEFORE INSERT OR UPDATE OF status ON public.routine_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_routine_run_max_concurrency();

-- Exact owner-facing budget usage. Monetary totals use the same authoritative
-- run ledger and still-active reservation semantics as hard admission. Action
-- counts include every admitted reservation, including released failures and
-- zero-Light/BYOK attempts, because each permanently consumes a call slot.
CREATE OR REPLACE FUNCTION public.get_agent_home_budget_usage(
  p_user_id uuid,
  p_routine_id uuid,
  p_recent_run_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_now timestamp with time zone DEFAULT now()
) RETURNS TABLE (
  day_started_at timestamp with time zone,
  month_started_at timestamp with time zone,
  day_settled_light double precision,
  day_reserved_light double precision,
  day_total_light double precision,
  month_settled_light double precision,
  month_reserved_light double precision,
  month_total_light double precision,
  last_run_id uuid,
  last_run_settled_light double precision,
  last_run_reserved_light double precision,
  last_run_total_light double precision,
  last_run_calls integer,
  calls_by_run jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_now timestamp with time zone := COALESCE(p_now, now());
  v_day_start timestamp with time zone;
  v_month_start timestamp with time zone;
  v_day_settled double precision := 0;
  v_month_settled double precision := 0;
  v_reserved double precision := 0;
  v_last_run_id uuid;
  v_last_settled double precision := 0;
  v_last_reserved double precision := 0;
  v_last_calls integer := 0;
  v_calls_by_run jsonb := '{}'::jsonb;
BEGIN
  IF p_recent_run_ids IS NULL OR cardinality(p_recent_run_ids) > 50 OR
     array_position(p_recent_run_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_invalid_recent_runs',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"recentRunIds"}';
  END IF;

  PERFORM 1
  FROM public.user_routines AS routines
  JOIN public.apps AS apps ON apps.id = routines.composer_app_id
  WHERE routines.id = p_routine_id
    AND routines.user_id = p_user_id
    AND routines.deleted_at IS NULL
    AND apps.owner_id = p_user_id
    AND apps.visibility = 'private'
    AND apps.deleted_at IS NULL
  FOR UPDATE OF routines;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'agent_home_routine_not_found',
      DETAIL = '{"code":"AGENT_HOME_ROUTINE_NOT_FOUND"}';
  END IF;

  v_day_start := date_trunc('day', timezone('UTC', v_now)) AT TIME ZONE 'UTC';
  v_month_start := date_trunc('month', timezone('UTC', v_now)) AT TIME ZONE 'UTC';

  SELECT
    COALESCE(sum(runs.total_light) FILTER (
      WHERE runs.created_at >= v_day_start
    ), 0),
    COALESCE(sum(runs.total_light), 0)
    INTO v_day_settled, v_month_settled
  FROM public.routine_runs AS runs
  WHERE runs.routine_id = p_routine_id
    AND runs.user_id = p_user_id
    AND runs.created_at >= v_month_start;

  -- Admission counts every unresolved reservation against both UTC windows,
  -- regardless of age. Expiry is ambiguity, not evidence of zero spend.
  SELECT COALESCE(sum(reservations.reserved_light), 0)
    INTO v_reserved
  FROM public.routine_run_budget_reservations AS reservations
  WHERE reservations.routine_id = p_routine_id
    AND reservations.user_id = p_user_id
    AND reservations.status = 'reserved';

  SELECT runs.id, runs.total_light
    INTO v_last_run_id, v_last_settled
  FROM public.routine_runs AS runs
  WHERE runs.routine_id = p_routine_id
    AND runs.user_id = p_user_id
  ORDER BY runs.created_at DESC, runs.id DESC
  LIMIT 1;
  IF FOUND THEN
    SELECT
      count(*)::integer,
      COALESCE(sum(reservations.reserved_light) FILTER (
        WHERE reservations.status = 'reserved'
      ), 0)
      INTO v_last_calls, v_last_reserved
    FROM public.routine_run_budget_reservations AS reservations
    WHERE reservations.routine_run_id = v_last_run_id
      AND reservations.routine_id = p_routine_id
      AND reservations.user_id = p_user_id;
  ELSE
    v_last_run_id := NULL;
    v_last_settled := 0;
  END IF;

  WITH requested AS (
    SELECT DISTINCT requested_id
    FROM unnest(p_recent_run_ids) AS input(requested_id)
  ), exact_counts AS (
    SELECT runs.id,
           count(reservations.id)::integer AS action_count
    FROM requested
    JOIN public.routine_runs AS runs
      ON runs.id = requested.requested_id
     AND runs.routine_id = p_routine_id
     AND runs.user_id = p_user_id
    LEFT JOIN public.routine_run_budget_reservations AS reservations
      ON reservations.routine_run_id = runs.id
     AND reservations.routine_id = p_routine_id
     AND reservations.user_id = p_user_id
    GROUP BY runs.id
  )
  SELECT COALESCE(
    jsonb_object_agg(exact_counts.id::text, exact_counts.action_count),
    '{}'::jsonb
  ) INTO v_calls_by_run
  FROM exact_counts;

  IF v_day_settled::text IN ('NaN', 'Infinity', '-Infinity') OR
     v_month_settled::text IN ('NaN', 'Infinity', '-Infinity') OR
     v_reserved::text IN ('NaN', 'Infinity', '-Infinity') OR
     v_last_settled::text IN ('NaN', 'Infinity', '-Infinity') OR
     v_last_reserved::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Routine spend ledger contains a non-finite value';
  END IF;

  RETURN QUERY SELECT
    v_day_start,
    v_month_start,
    v_day_settled,
    v_reserved,
    v_day_settled + v_reserved,
    v_month_settled,
    v_reserved,
    v_month_settled + v_reserved,
    v_last_run_id,
    v_last_settled,
    v_last_reserved,
    v_last_settled + v_last_reserved,
    v_last_calls,
    v_calls_by_run;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_app_agent_home_revision() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merge_routine_user_metadata(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_agent_home_revision(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_agent_home_revision_from_routine() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_agent_home_revision_from_capability() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_agent_home_revision_from_user_setting() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_agent_home_revision_from_grant() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_agent_home_revision(uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_agent_home_revision(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_agent_home_identity(uuid, uuid, bigint, boolean, text, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_agent_home_routine(uuid, uuid, uuid, bigint, boolean, text, boolean, bigint, boolean, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_agent_home_settings(uuid, uuid, bigint, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_agent_home_routine_status(uuid, uuid, uuid, bigint, text, timestamp with time zone) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pause_agent_home_routine_emergency(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_agent_home_capabilities(uuid, uuid, uuid, bigint, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_agent_home_action(uuid, uuid, bigint, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_no_started_agent_home_promotion(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fence_agent_home_promotion_step(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_agent_home_promotion_release_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_agent_home_promotion_app_record(uuid, uuid, uuid, uuid, text, text, jsonb, boolean, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_agent_home_action_lease(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_agent_home_action(uuid, uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.queue_agent_home_routine_run(uuid, uuid, uuid, uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_routine_run_max_concurrency() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_agent_home_budget_usage(uuid, uuid, uuid[], timestamp with time zone) FROM PUBLIC, anon, authenticated;

-- PostgreSQL grants function EXECUTE to PUBLIC by default. These older
-- SECURITY DEFINER RPCs mutate the authoritative routine budget ledger, so
-- repeat their launch boundary here for databases that already applied the
-- historical migrations with only explicit anon/authenticated revokes.
REVOKE ALL ON FUNCTION public.reserve_routine_run_budget(
  uuid, uuid, uuid, text, text, double precision, timestamp with time zone
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_routine_run_budget_reservation(
  uuid, uuid, double precision, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_routine_run_budget_reservation(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_routine_call_contribution(
  uuid, uuid, uuid, uuid, text, text, text, uuid, text, integer,
  double precision, jsonb, jsonb, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.assert_agent_home_revision(uuid, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.merge_routine_user_metadata(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_agent_home_revision(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_agent_home_identity(uuid, uuid, bigint, boolean, text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_agent_home_routine(uuid, uuid, uuid, bigint, boolean, text, boolean, bigint, boolean, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_agent_home_settings(uuid, uuid, bigint, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_agent_home_routine_status(uuid, uuid, uuid, bigint, text, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.pause_agent_home_routine_emergency(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_agent_home_capabilities(uuid, uuid, uuid, bigint, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_agent_home_action(uuid, uuid, bigint, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.assert_no_started_agent_home_promotion(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fence_agent_home_promotion_step(uuid, uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_agent_home_promotion_app_record(uuid, uuid, uuid, uuid, text, text, jsonb, boolean, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_agent_home_action_lease(uuid, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_agent_home_action(uuid, uuid, uuid, uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.queue_agent_home_routine_run(uuid, uuid, uuid, uuid, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_agent_home_budget_usage(uuid, uuid, uuid[], timestamp with time zone) TO service_role;
