-- Operator-grade Agent Home: durable, owner-scoped presentation preferences.
--
-- The browser is not the source of truth for Fleet numbering or Interface
-- favorites. Preferences survive devices and are mutated only through
-- revision-checked service-role RPCs. An initialized Agent with zero favorite
-- rows means "the owner explicitly chose none"; NULL initialized_at means the
-- first stable manifest-ordered Interface may still be selected once.

CREATE OR REPLACE FUNCTION public.is_valid_agent_shortcut_map(
  p_shortcut_map jsonb
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_shortcut_map) <> 'object' THEN false
    ELSE
      octet_length(p_shortcut_map::text) <= 4096
      AND (
        SELECT count(*) <= 15
        FROM jsonb_object_keys(p_shortcut_map)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_each(p_shortcut_map) AS shortcut(action, key_value)
        WHERE shortcut.action <> ALL (ARRAY[
          'search', 'alerts', 'settings',
          'agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5',
          'agent-6', 'agent-7', 'agent-8', 'agent-9', 'agent-10',
          'help', 'dismiss'
        ])
           OR (
             jsonb_typeof(shortcut.key_value) <> 'null'
             AND (
               jsonb_typeof(shortcut.key_value) <> 'string'
               OR (
                 shortcut.key_value #>> '{}' <> 'Escape'
                 AND (
                   char_length(shortcut.key_value #>> '{}') <> 1
                   OR shortcut.key_value #>> '{}' ~ '[[:space:][:cntrl:]]'
                   OR shortcut.key_value #>> '{}' = '+'
                   OR shortcut.key_value #>> '{}' ~ '^[A-Z]$'
                 )
               )
             )
           )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM (
          SELECT shortcut.key_value #>> '{}' AS shortcut_key
          FROM jsonb_each(
            '{
              "search":"k",
              "alerts":"a",
              "settings":"s",
              "agent-1":"1",
              "agent-2":"2",
              "agent-3":"3",
              "agent-4":"4",
              "agent-5":"5",
              "agent-6":"6",
              "agent-7":"7",
              "agent-8":"8",
              "agent-9":"9",
              "agent-10":"0",
              "help":"?",
              "dismiss":"Escape"
            }'::jsonb || p_shortcut_map
          ) AS shortcut(action, key_value)
          WHERE jsonb_typeof(shortcut.key_value) = 'string'
          GROUP BY shortcut.key_value #>> '{}'
          HAVING count(*) > 1
        ) AS duplicate_keys
      )
  END;
$$;

CREATE TABLE public.user_fleet_preferences (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1,
  shortcuts_enabled boolean NOT NULL DEFAULT true,
  shortcut_map jsonb NOT NULL DEFAULT
    '{
      "search":"k",
      "alerts":"a",
      "settings":"s",
      "agent-1":"1",
      "agent-2":"2",
      "agent-3":"3",
      "agent-4":"4",
      "agent-5":"5",
      "agent-6":"6",
      "agent-7":"7",
      "agent-8":"8",
      "agent-9":"9",
      "agent-10":"0",
      "help":"?",
      "dismiss":"Escape"
    }'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_fleet_preferences_revision_check CHECK (revision >= 1),
  CONSTRAINT user_fleet_preferences_shortcut_map_check CHECK (
    public.is_valid_agent_shortcut_map(shortcut_map)
  )
);

-- This key lets the database prove that a preference's user owns its Agent,
-- rather than trusting two independent foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS apps_owner_id_id_uidx
  ON public.apps (owner_id, id);

CREATE TABLE public.user_agent_preferences (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  fleet_position integer,
  revision bigint NOT NULL DEFAULT 1,
  favorites_initialized_at timestamptz,
  -- False is the automatic first-Interface onboarding default. True means an
  -- owner (including the one-time legacy migration) explicitly chose the list,
  -- including an intentional empty list.
  favorites_explicit boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_agent_preferences_pkey PRIMARY KEY (user_id, agent_id),
  CONSTRAINT user_agent_preferences_agent_fkey
    FOREIGN KEY (agent_id) REFERENCES public.apps(id) ON DELETE CASCADE,
  CONSTRAINT user_agent_preferences_position_check CHECK (
    fleet_position IS NULL OR fleet_position >= 0
  ),
  CONSTRAINT user_agent_preferences_revision_check CHECK (revision >= 1),
  CONSTRAINT user_agent_preferences_user_position_key
    UNIQUE (user_id, fleet_position)
    DEFERRABLE INITIALLY IMMEDIATE
);

CREATE TABLE public.user_agent_interface_preferences (
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  interface_id text NOT NULL,
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_agent_interface_preferences_pkey
    PRIMARY KEY (user_id, agent_id, interface_id),
  CONSTRAINT user_agent_interface_preferences_agent_fkey
    FOREIGN KEY (user_id, agent_id)
    REFERENCES public.user_agent_preferences(user_id, agent_id)
    ON DELETE CASCADE,
  CONSTRAINT user_agent_interface_preferences_position_check
    CHECK (position >= 0),
  CONSTRAINT user_agent_interface_preferences_id_check CHECK (
    char_length(interface_id) BETWEEN 1 AND 160
    AND interface_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT user_agent_interface_preferences_user_agent_position_key
    UNIQUE (user_id, agent_id, position)
    DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX user_agent_preferences_fleet_order_idx
  ON public.user_agent_preferences (user_id, fleet_position, agent_id)
  WHERE fleet_position IS NOT NULL;

CREATE INDEX user_agent_interface_preferences_order_idx
  ON public.user_agent_interface_preferences
    (user_id, agent_id, position, interface_id);

ALTER TABLE public.user_fleet_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_agent_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_agent_interface_preferences ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.user_fleet_preferences
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.user_agent_preferences
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.user_agent_interface_preferences
  FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.user_fleet_preferences TO service_role;
GRANT ALL ON TABLE public.user_agent_preferences TO service_role;
GRANT ALL ON TABLE public.user_agent_interface_preferences TO service_role;

CREATE OR REPLACE FUNCTION public.touch_agent_operator_preference_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER touch_user_fleet_preferences_updated_at
BEFORE UPDATE ON public.user_fleet_preferences
FOR EACH ROW EXECUTE FUNCTION public.touch_agent_operator_preference_updated_at();

CREATE TRIGGER touch_user_agent_preferences_updated_at
BEFORE UPDATE ON public.user_agent_preferences
FOR EACH ROW EXECUTE FUNCTION public.touch_agent_operator_preference_updated_at();

CREATE TRIGGER touch_user_agent_interface_preferences_updated_at
BEFORE UPDATE ON public.user_agent_interface_preferences
FOR EACH ROW EXECUTE FUNCTION public.touch_agent_operator_preference_updated_at();

CREATE OR REPLACE FUNCTION public.validate_user_agent_preference_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.apps
    WHERE id = NEW.agent_id AND owner_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'user_agent_preference_owner_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_user_agent_preference_ownership
BEFORE INSERT OR UPDATE OF user_id, agent_id ON public.user_agent_preferences
FOR EACH ROW EXECUTE FUNCTION public.validate_user_agent_preference_ownership();

-- Deterministic legacy backfill. Fleet order before this migration was exactly
-- private, non-deleted Apps ordered by created_at then id.
INSERT INTO public.user_fleet_preferences (user_id)
SELECT DISTINCT apps.owner_id
FROM public.apps
WHERE apps.owner_id IS NOT NULL
  AND apps.visibility = 'private'
  AND apps.deleted_at IS NULL
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.user_agent_preferences (
  user_id,
  agent_id,
  fleet_position
)
SELECT
  ranked.owner_id,
  ranked.id,
  ranked.fleet_position
FROM (
  SELECT
    apps.owner_id,
    apps.id,
    row_number() OVER (
      PARTITION BY apps.owner_id
      ORDER BY apps.created_at, apps.id
    )::integer - 1 AS fleet_position
  FROM public.apps
  WHERE apps.owner_id IS NOT NULL
    AND apps.visibility = 'private'
    AND apps.deleted_at IS NULL
) AS ranked
ON CONFLICT (user_id, agent_id) DO UPDATE
SET fleet_position = EXCLUDED.fleet_position;

-- Keep newly created/restored/soft-deleted private Agents in a valid compact
-- order. Favorites remain when an Agent is soft-deleted; its position becomes
-- NULL and restoration appends it.
CREATE OR REPLACE FUNCTION public.sync_agent_operator_fleet_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_member boolean := false;
  v_new_member boolean := false;
  v_next_position integer;
  v_owner uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_member := OLD.owner_id IS NOT NULL
      AND OLD.visibility = 'private'
      AND OLD.deleted_at IS NULL;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new_member := NEW.owner_id IS NOT NULL
      AND NEW.visibility = 'private'
      AND NEW.deleted_at IS NULL;
  END IF;

  IF v_old_member AND (
    TG_OP = 'DELETE'
    OR NOT v_new_member
    OR (TG_OP = 'UPDATE' AND OLD.owner_id IS DISTINCT FROM NEW.owner_id)
  ) THEN
    v_owner := OLD.owner_id;
    PERFORM pg_advisory_xact_lock(
      hashtextextended('galactic:fleet:' || v_owner::text, 0)
    );
    IF TG_OP = 'UPDATE'
       AND v_new_member
       AND OLD.owner_id IS DISTINCT FROM NEW.owner_id THEN
      -- Favorites are private user state and must not cross an ownership
      -- transfer. Hard deletion is handled by the Agent foreign key.
      DELETE FROM public.user_agent_preferences
      WHERE user_id = v_owner AND agent_id = OLD.id;
    ELSE
      UPDATE public.user_agent_preferences
      SET fleet_position = NULL
      WHERE user_id = v_owner AND agent_id = OLD.id;
    END IF;

    SET CONSTRAINTS user_agent_preferences_user_position_key DEFERRED;
    WITH compact AS (
      SELECT
        preferences.agent_id,
        row_number() OVER (
          ORDER BY preferences.fleet_position, apps.created_at, apps.id
        )::integer - 1 AS next_position
      FROM public.user_agent_preferences AS preferences
      JOIN public.apps AS apps
        ON apps.owner_id = preferences.user_id
       AND apps.id = preferences.agent_id
      WHERE preferences.user_id = v_owner
        AND preferences.fleet_position IS NOT NULL
        AND apps.visibility = 'private'
        AND apps.deleted_at IS NULL
    )
    UPDATE public.user_agent_preferences AS preferences
    SET fleet_position = compact.next_position
    FROM compact
    WHERE preferences.user_id = v_owner
      AND preferences.agent_id = compact.agent_id
      AND preferences.fleet_position IS DISTINCT FROM compact.next_position;

    -- The implicit empty Fleet is revision 1, so even an owner without a
    -- materialized preference row advances to revision 2 on first membership
    -- change. Keep the revision update under the same owner advisory lock as
    -- the rows it certifies.
    INSERT INTO public.user_fleet_preferences AS fleet (user_id, revision)
    VALUES (v_owner, 2)
    ON CONFLICT (user_id) DO UPDATE
    SET revision = fleet.revision + 1;
  END IF;

  IF v_new_member AND (
    TG_OP = 'INSERT'
    OR NOT v_old_member
    OR (TG_OP = 'UPDATE' AND OLD.owner_id IS DISTINCT FROM NEW.owner_id)
  ) THEN
    v_owner := NEW.owner_id;
    PERFORM pg_advisory_xact_lock(
      hashtextextended('galactic:fleet:' || v_owner::text, 0)
    );

    SELECT coalesce(max(fleet_position), -1) + 1
    INTO v_next_position
    FROM public.user_agent_preferences
    WHERE user_id = v_owner
      AND fleet_position IS NOT NULL;

    INSERT INTO public.user_agent_preferences (
      user_id,
      agent_id,
      fleet_position
    ) VALUES (
      v_owner,
      NEW.id,
      v_next_position
    )
    ON CONFLICT (user_id, agent_id) DO UPDATE
    SET fleet_position = EXCLUDED.fleet_position;

    INSERT INTO public.user_fleet_preferences AS fleet (user_id, revision)
    VALUES (v_owner, 2)
    ON CONFLICT (user_id) DO UPDATE
    SET revision = fleet.revision + 1;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sync_agent_operator_fleet_membership
AFTER INSERT OR UPDATE OF owner_id, visibility, deleted_at ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.sync_agent_operator_fleet_membership();

CREATE TRIGGER sync_agent_operator_fleet_membership_on_delete
AFTER DELETE ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.sync_agent_operator_fleet_membership();

CREATE OR REPLACE FUNCTION public.replace_user_fleet_order(
  p_user_id uuid,
  p_agent_ids uuid[],
  p_expected_revision bigint
) RETURNS TABLE (
  new_revision bigint,
  ordered_agent_ids uuid[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_revision bigint;
  v_owned_count integer;
  v_requested_count integer;
BEGIN
  IF p_user_id IS NULL OR p_agent_ids IS NULL
     OR cardinality(p_agent_ids) > 1000
     OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_fleet_preference_mutation';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('galactic:fleet:' || p_user_id::text, 0)
  );
  INSERT INTO public.user_fleet_preferences (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT revision INTO v_current_revision
  FROM public.user_fleet_preferences
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_current_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'fleet_preference_revision_conflict',
      DETAIL = jsonb_build_object(
        'expectedRevision', p_expected_revision,
        'currentRevision', v_current_revision
      )::text;
  END IF;

  SELECT count(*)::integer INTO v_owned_count
  FROM public.apps
  WHERE owner_id = p_user_id
    AND visibility = 'private'
    AND deleted_at IS NULL;

  SELECT count(DISTINCT requested.agent_id)::integer
  INTO v_requested_count
  FROM unnest(p_agent_ids) AS requested(agent_id);

  IF cardinality(p_agent_ids) <> v_owned_count
     OR v_requested_count <> v_owned_count
     OR EXISTS (
       SELECT 1
       FROM unnest(p_agent_ids) AS requested(agent_id)
       LEFT JOIN public.apps AS apps
         ON apps.id = requested.agent_id
        AND apps.owner_id = p_user_id
        AND apps.visibility = 'private'
        AND apps.deleted_at IS NULL
       WHERE apps.id IS NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'fleet_preference_agent_set_mismatch';
  END IF;

  INSERT INTO public.user_agent_preferences (
    user_id,
    agent_id,
    fleet_position
  )
  SELECT p_user_id, requested.agent_id, requested.position::integer - 1
  FROM unnest(p_agent_ids) WITH ORDINALITY AS requested(agent_id, position)
  ON CONFLICT (user_id, agent_id) DO NOTHING;

  SET CONSTRAINTS user_agent_preferences_user_position_key DEFERRED;
  UPDATE public.user_agent_preferences AS preferences
  SET fleet_position = requested.position::integer - 1
  FROM unnest(p_agent_ids) WITH ORDINALITY AS requested(agent_id, position)
  WHERE preferences.user_id = p_user_id
    AND preferences.agent_id = requested.agent_id;

  UPDATE public.user_fleet_preferences
  SET revision = revision + 1
  WHERE user_id = p_user_id
  RETURNING revision INTO v_current_revision;

  RETURN QUERY SELECT v_current_revision, p_agent_ids;
END;
$$;

CREATE OR REPLACE FUNCTION public.replace_user_agent_interface_favorites(
  p_user_id uuid,
  p_agent_id uuid,
  p_interface_ids text[],
  p_expected_revision bigint
) RETURNS TABLE (
  new_revision bigint,
  favorite_interface_ids text[],
  initialized_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_revision bigint;
  v_initialized_at timestamptz;
  v_requested_count integer;
BEGIN
  IF p_user_id IS NULL OR p_agent_id IS NULL OR p_interface_ids IS NULL
     OR cardinality(p_interface_ids) > 100
     OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_interface_favorite_mutation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.apps
    WHERE id = p_agent_id
      AND owner_id = p_user_id
      AND visibility = 'private'
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_not_found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(p_interface_ids) AS requested(interface_id)
    WHERE char_length(requested.interface_id) NOT BETWEEN 1 AND 160
       OR requested.interface_id ~ '[[:cntrl:]]'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_interface_favorite_id';
  END IF;

  SELECT count(DISTINCT requested.interface_id)::integer
  INTO v_requested_count
  FROM unnest(p_interface_ids) AS requested(interface_id);
  IF v_requested_count <> cardinality(p_interface_ids) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'duplicate_interface_favorite_id';
  END IF;

  INSERT INTO public.user_agent_preferences (user_id, agent_id)
  VALUES (p_user_id, p_agent_id)
  ON CONFLICT (user_id, agent_id) DO NOTHING;

  SELECT revision INTO v_current_revision
  FROM public.user_agent_preferences
  WHERE user_id = p_user_id AND agent_id = p_agent_id
  FOR UPDATE;

  IF v_current_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_preference_revision_conflict',
      DETAIL = jsonb_build_object(
        'expectedRevision', p_expected_revision,
        'currentRevision', v_current_revision
      )::text;
  END IF;

  DELETE FROM public.user_agent_interface_preferences
  WHERE user_id = p_user_id AND agent_id = p_agent_id;

  INSERT INTO public.user_agent_interface_preferences (
    user_id,
    agent_id,
    interface_id,
    position
  )
  SELECT
    p_user_id,
    p_agent_id,
    requested.interface_id,
    requested.position::integer - 1
  FROM unnest(p_interface_ids) WITH ORDINALITY
    AS requested(interface_id, position);

  UPDATE public.user_agent_preferences
  SET
    revision = revision + 1,
    favorites_initialized_at = coalesce(favorites_initialized_at, now()),
    favorites_explicit = true
  WHERE user_id = p_user_id AND agent_id = p_agent_id
  RETURNING revision, favorites_initialized_at
  INTO v_current_revision, v_initialized_at;

  RETURN QUERY
  SELECT v_current_revision, p_interface_ids, v_initialized_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.replace_user_fleet_shortcuts(
  p_user_id uuid,
  p_shortcuts_enabled boolean,
  p_shortcut_map jsonb,
  p_expected_revision bigint
) RETURNS TABLE (
  new_revision bigint,
  shortcuts_enabled boolean,
  shortcut_map jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_revision bigint;
BEGIN
  IF p_user_id IS NULL
     OR p_shortcuts_enabled IS NULL
     OR p_shortcut_map IS NULL
     OR NOT public.is_valid_agent_shortcut_map(p_shortcut_map)
     OR p_expected_revision IS NULL
     OR p_expected_revision < 1
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_fleet_shortcut_mutation';
  END IF;

  INSERT INTO public.user_fleet_preferences (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT preferences.revision INTO v_current_revision
  FROM public.user_fleet_preferences AS preferences
  WHERE preferences.user_id = p_user_id
  FOR UPDATE;

  IF v_current_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'fleet_preference_revision_conflict',
      DETAIL = jsonb_build_object(
        'expectedRevision', p_expected_revision,
        'currentRevision', v_current_revision
      )::text;
  END IF;

  RETURN QUERY
  UPDATE public.user_fleet_preferences AS preferences
  SET
    revision = preferences.revision + 1,
    shortcuts_enabled = p_shortcuts_enabled,
    shortcut_map = p_shortcut_map
  WHERE preferences.user_id = p_user_id
  RETURNING
    preferences.revision,
    preferences.shortcuts_enabled,
    preferences.shortcut_map;
END;
$$;

-- Atomic first-contact initializer. The trusted API passes only stable,
-- hash-stamped Interface IDs in manifest order. It selects exactly the first
-- once; an explicitly initialized empty preference is never repopulated.
CREATE OR REPLACE FUNCTION public.initialize_user_agent_interface_favorites(
  p_user_id uuid,
  p_agent_id uuid,
  p_manifest_interface_ids text[]
) RETURNS TABLE (
  revision bigint,
  favorite_interface_ids text[],
  initialized_at timestamptz,
  explicit_choice boolean,
  initialized_now boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_preference public.user_agent_preferences%ROWTYPE;
  v_first_interface text;
  v_existing text[];
BEGIN
  IF p_user_id IS NULL OR p_agent_id IS NULL
     OR p_manifest_interface_ids IS NULL
     OR cardinality(p_manifest_interface_ids) > 100 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_interface_favorite_initialization';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.apps
    WHERE id = p_agent_id
      AND owner_id = p_user_id
      AND visibility = 'private'
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_not_found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_manifest_interface_ids) AS requested(interface_id)
    WHERE char_length(requested.interface_id) NOT BETWEEN 1 AND 160
       OR requested.interface_id ~ '[[:cntrl:]]'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_interface_favorite_id';
  END IF;

  INSERT INTO public.user_agent_preferences (user_id, agent_id)
  VALUES (p_user_id, p_agent_id)
  ON CONFLICT (user_id, agent_id) DO NOTHING;

  SELECT * INTO v_preference
  FROM public.user_agent_preferences
  WHERE user_id = p_user_id AND agent_id = p_agent_id
  FOR UPDATE;

  IF v_preference.favorites_initialized_at IS NULL THEN
    v_first_interface := p_manifest_interface_ids[1];
    IF v_first_interface IS NOT NULL THEN
      INSERT INTO public.user_agent_interface_preferences (
        user_id,
        agent_id,
        interface_id,
        position
      ) VALUES (
        p_user_id,
        p_agent_id,
        v_first_interface,
        0
      )
      ON CONFLICT (user_id, agent_id, interface_id) DO NOTHING;
    END IF;

    UPDATE public.user_agent_preferences AS preferences
    SET
      revision = preferences.revision + 1,
      favorites_initialized_at = now(),
      favorites_explicit = false
    WHERE preferences.user_id = p_user_id
      AND preferences.agent_id = p_agent_id
    RETURNING preferences.* INTO v_preference;

    initialized_now := true;
  ELSE
    initialized_now := false;
  END IF;

  SELECT coalesce(
    array_agg(interface_id ORDER BY position),
    ARRAY[]::text[]
  )
  INTO v_existing
  FROM public.user_agent_interface_preferences
  WHERE user_id = p_user_id AND agent_id = p_agent_id;

  revision := v_preference.revision;
  favorite_interface_ids := v_existing;
  initialized_at := v_preference.favorites_initialized_at;
  explicit_choice := v_preference.favorites_explicit;
  RETURN NEXT;
END;
$$;

-- Return each revision token and the exact preference rows it certifies from
-- one database statement. Reading these values through independent REST
-- requests can pair a stale ordered list with a newer revision and allow the
-- next compare-and-swap write to overwrite a concurrent owner change.
CREATE OR REPLACE FUNCTION public.get_user_agent_interface_favorites_snapshot(
  p_user_id uuid,
  p_agent_id uuid
) RETURNS TABLE (
  revision bigint,
  favorite_interface_ids text[],
  favorites_initialized_at timestamptz,
  favorites_explicit boolean,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL OR p_agent_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_interface_favorite_snapshot';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.apps
    WHERE id = p_agent_id
      AND owner_id = p_user_id
      AND visibility = 'private'
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'agent_not_found';
  END IF;

  RETURN QUERY
  SELECT
    coalesce(preferences.revision, 1::bigint),
    coalesce(
      array_agg(
        interfaces.interface_id
        ORDER BY interfaces.position, interfaces.interface_id
      ) FILTER (WHERE interfaces.interface_id IS NOT NULL),
      ARRAY[]::text[]
    ),
    preferences.favorites_initialized_at,
    coalesce(preferences.favorites_explicit, false),
    preferences.updated_at
  FROM (SELECT p_agent_id AS agent_id) AS owned_agent
  LEFT JOIN public.user_agent_preferences AS preferences
    ON preferences.user_id = p_user_id
   AND preferences.agent_id = owned_agent.agent_id
  LEFT JOIN public.user_agent_interface_preferences AS interfaces
    ON interfaces.user_id = p_user_id
   AND interfaces.agent_id = owned_agent.agent_id
  GROUP BY
    preferences.revision,
    preferences.favorites_initialized_at,
    preferences.favorites_explicit,
    preferences.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_fleet_preferences_snapshot(
  p_user_id uuid
) RETURNS TABLE (
  revision bigint,
  shortcuts_enabled boolean,
  shortcut_map jsonb,
  updated_at timestamptz,
  ordered_agent_ids uuid[],
  ordered_fleet_positions integer[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'invalid_fleet_preference_snapshot';
  END IF;

  RETURN QUERY
  SELECT
    coalesce(fleet.revision, 1::bigint),
    coalesce(fleet.shortcuts_enabled, true),
    coalesce(fleet.shortcut_map, '{}'::jsonb),
    fleet.updated_at,
    coalesce(
      array_agg(
        positions.agent_id
        ORDER BY positions.fleet_position, positions.agent_id
      ) FILTER (WHERE positions.agent_id IS NOT NULL),
      ARRAY[]::uuid[]
    ),
    coalesce(
      array_agg(
        positions.fleet_position
        ORDER BY positions.fleet_position, positions.agent_id
      ) FILTER (WHERE positions.agent_id IS NOT NULL),
      ARRAY[]::integer[]
    )
  FROM (SELECT p_user_id AS user_id) AS owner
  LEFT JOIN public.user_fleet_preferences AS fleet
    ON fleet.user_id = owner.user_id
  LEFT JOIN (
    SELECT preferences.agent_id, preferences.fleet_position
    FROM public.user_agent_preferences AS preferences
    JOIN public.apps AS apps
      ON apps.id = preferences.agent_id
     AND apps.owner_id = preferences.user_id
     AND apps.visibility = 'private'
     AND apps.deleted_at IS NULL
    WHERE preferences.user_id = p_user_id
      AND preferences.fleet_position IS NOT NULL
  ) AS positions ON true
  GROUP BY
    fleet.revision,
    fleet.shortcuts_enabled,
    fleet.shortcut_map,
    fleet.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_agent_operator_preference_updated_at()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_valid_agent_shortcut_map(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_user_agent_preference_ownership()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_agent_operator_fleet_membership()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.replace_user_fleet_order(uuid, uuid[], bigint)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.replace_user_agent_interface_favorites(
  uuid, uuid, text[], bigint
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.replace_user_fleet_shortcuts(
  uuid, boolean, jsonb, bigint
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.initialize_user_agent_interface_favorites(
  uuid, uuid, text[]
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_user_agent_interface_favorites_snapshot(
  uuid, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_user_fleet_preferences_snapshot(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.replace_user_fleet_order(
  uuid, uuid[], bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.replace_user_agent_interface_favorites(
  uuid, uuid, text[], bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.replace_user_fleet_shortcuts(
  uuid, boolean, jsonb, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_valid_agent_shortcut_map(jsonb)
TO service_role;
GRANT EXECUTE ON FUNCTION public.initialize_user_agent_interface_favorites(
  uuid, uuid, text[]
) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_user_agent_interface_favorites_snapshot(
  uuid, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_user_fleet_preferences_snapshot(uuid)
TO service_role;
