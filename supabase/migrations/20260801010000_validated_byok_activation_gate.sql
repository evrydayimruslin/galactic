-- Persist a tested BYOK credential atomically and make that durable proof a
-- hard prerequisite when a newly deployed inference Agent crosses from
-- setup_required to ready.

CREATE OR REPLACE FUNCTION public.save_validated_launch_byok_provider(
  p_user_id uuid,
  p_provider text,
  p_encrypted_key text,
  p_model text,
  p_validation jsonb,
  p_set_primary boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_keys jsonb;
  v_added_at timestamptz := now();
BEGIN
  IF p_user_id IS NULL
    OR p_provider NOT IN (
      'openrouter', 'openai', 'deepseek', 'nvidia', 'google', 'xai',
      'moonshot', 'zai'
    )
    OR p_encrypted_key IS NULL
    OR p_encrypted_key = ''
    OR jsonb_typeof(COALESCE(p_validation, 'null'::jsonb)) <> 'object'
    OR p_validation->>'policy_version' <> 'launch-byok-v1'
    OR p_validation->>'provider' <> p_provider
    OR NULLIF(p_validation->>'key_version', '') IS NULL
    OR NULLIF(p_validation->>'validated_at', '') IS NULL
    OR jsonb_typeof(p_validation->'operations') <> 'array'
    OR jsonb_array_length(p_validation->'operations') = 0
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(p_validation->'operations') AS operation
      WHERE operation NOT IN ('generate', 'embed')
    )
    OR (p_model IS NULL) <> (p_validation->>'model' IS NULL)
    OR (p_model IS NOT NULL AND p_validation->>'model' IS DISTINCT FROM p_model)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_validated_byok_provider';
  END IF;

  SELECT users.* INTO v_user
  FROM public.users
  WHERE users.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'user_not_found';
  END IF;

  v_keys := COALESCE(v_user.byok_keys, '{}'::jsonb);
  IF jsonb_typeof(v_keys) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_byok_state';
  END IF;
  v_keys := jsonb_set(
    v_keys,
    ARRAY[p_provider],
    jsonb_strip_nulls(jsonb_build_object(
      'encrypted_key', p_encrypted_key,
      'model', p_model,
      'added_at', v_added_at,
      'validation', p_validation
    )),
    true
  );

  UPDATE public.users AS users
  SET byok_keys = v_keys,
      byok_enabled = true,
      byok_provider = CASE
        WHEN p_set_primary OR users.byok_provider IS NULL THEN p_provider
        ELSE users.byok_provider
      END,
      updated_at = v_added_at
  WHERE users.id = p_user_id;

  RETURN jsonb_build_object(
    'provider', p_provider,
    'primary', p_set_primary OR v_user.byok_provider IS NULL,
    'added_at', v_added_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_new_agent_inference_readiness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_manifest jsonb;
  v_requires_generate boolean := false;
  v_requires_embed boolean := false;
  v_user public.users%ROWTYPE;
  v_config jsonb;
  v_validation jsonb;
BEGIN
  IF OLD.deployment_state IS DISTINCT FROM 'setup_required'
    OR NEW.deployment_state IS DISTINCT FROM 'ready' THEN
    RETURN NEW;
  END IF;

  v_manifest := public.try_parse_agent_home_jsonb(NEW.manifest);
  IF jsonb_typeof(v_manifest) <> 'object' THEN
    RETURN NEW;
  END IF;
  v_requires_generate := COALESCE(v_manifest->'permissions', '[]'::jsonb)
      ? 'ai:call'
    OR EXISTS (
      SELECT 1 FROM jsonb_each(COALESCE(v_manifest->'functions', '{}'::jsonb)) AS fn
      WHERE jsonb_typeof(fn.value->'authority'->'effects') = 'object'
        AND (fn.value->'authority'->'effects') ? 'inference.generate'
    );
  v_requires_embed := COALESCE(v_manifest->'permissions', '[]'::jsonb)
      ? 'ai:embed'
    OR EXISTS (
      SELECT 1 FROM jsonb_each(COALESCE(v_manifest->'functions', '{}'::jsonb)) AS fn
      WHERE jsonb_typeof(fn.value->'authority'->'effects') = 'object'
        AND (fn.value->'authority'->'effects') ? 'inference.embed'
    );
  IF NOT v_requires_generate AND NOT v_requires_embed THEN
    RETURN NEW;
  END IF;

  SELECT users.* INTO v_user
  FROM public.users
  WHERE users.id = NEW.owner_id
  FOR SHARE;
  IF NOT FOUND
    OR NOT COALESCE(v_user.byok_enabled, false)
    OR v_user.byok_provider IS NULL
    OR jsonb_typeof(COALESCE(v_user.byok_keys, '{}'::jsonb)) <> 'object'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_home_byok_required',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"inference","reason":"validated_byok_required"}';
  END IF;

  v_config := v_user.byok_keys->v_user.byok_provider;
  v_validation := v_config->'validation';
  IF jsonb_typeof(v_config) <> 'object'
    OR NULLIF(v_config->>'encrypted_key', '') IS NULL
    OR jsonb_typeof(v_validation) <> 'object'
    OR v_validation->>'policy_version' <> 'launch-byok-v1'
    OR v_validation->>'provider' <> v_user.byok_provider
    OR NULLIF(v_validation->>'key_version', '') IS NULL
    OR NULLIF(v_validation->>'validated_at', '') IS NULL
    OR jsonb_typeof(v_validation->'operations') <> 'array'
    OR (v_requires_generate AND NOT (v_validation->'operations' ? 'generate'))
    OR (v_requires_embed AND NOT (v_validation->'operations' ? 'embed'))
    OR (v_requires_embed AND v_user.byok_provider <> 'openrouter')
    OR (
      v_requires_generate
      AND COALESCE(v_config->>'model', '') IS DISTINCT FROM
        COALESCE(v_validation->>'model', '')
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_home_byok_validation_required',
      DETAIL = '{"code":"AGENT_HOME_INVALID_MUTATION","field":"inference","reason":"validated_byok_required"}';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS apps_new_agent_inference_readiness ON public.apps;
CREATE TRIGGER apps_new_agent_inference_readiness
BEFORE UPDATE OF deployment_state ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.enforce_new_agent_inference_readiness();

REVOKE ALL ON FUNCTION public.save_validated_launch_byok_provider(
  uuid, text, text, text, jsonb, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_new_agent_inference_readiness()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_validated_launch_byok_provider(
  uuid, text, text, text, jsonb, boolean
) TO service_role;

COMMENT ON FUNCTION public.save_validated_launch_byok_provider(
  uuid, text, text, text, jsonb, boolean
) IS 'Atomically stores one encrypted provider key and its exact launch validation proof.';
