// Story Builder v3 — Galactic MCP App
// 7 tools: create_world, add, read, update, delete, get_context, generate
// All lookups by name (unique per world). No UUIDs needed by the caller.
// Storage: Galactic D1 (scoped structured API) | Permissions: ai:call

const galactic = (globalThis as any).galactic;

type EntityTable = 'characters' | 'locations' | 'themes' | 'arcs' | 'factions' | 'lore' | 'rules' | 'scenes';
type SqlValue = string | number | null;
type MutationResultValue = string | boolean | string[];

interface MutationResultEntry {
  [key: string]: MutationResultValue;
}

type MutationBuckets = Record<string, MutationResultEntry[]>;

interface WorldRow {
  id: string;
  name: string;
  genre: string;
  description: string;
}

interface CharacterRow {
  id: string;
  name: string;
  role: string;
  traits: string | null;
  backstory: string;
}

interface CharacterNameRow {
  id: string;
  name: string;
}

interface LocationRow {
  id: string;
  name: string;
  description: string;
}

interface ThemeRow {
  id: string;
  name: string;
  description: string;
}

interface RelationshipLookupRow {
  id: string;
  type: string;
  description: string;
  a_name: string;
  b_name: string;
}

interface RelationshipRow {
  id: string;
  type: string;
  description: string;
  character_a: string;
  character_b: string;
}

interface ArcRow {
  id: string;
  name: string;
  type: string;
  description: string;
  season: string;
  episode_range: string;
  character_ids: string | null;
  arc_order: number;
}

interface FactionRow {
  id: string;
  name: string;
  description: string;
  member_ids: string | null;
}

interface TypedDescriptionRow {
  id: string;
  name: string;
  type: string;
  description: string;
}

interface SceneRow {
  id: string;
  title: string;
  type: string;
  content: string;
  character_ids: string | null;
  setting_id: string | null;
  scene_order: number;
  created_at: string;
}

interface ResolvedEntityRow {
  id: string;
  name: string;
  description?: string;
  type?: string;
  member_ids?: string | null;
  character_ids?: string | null;
  season?: string;
  episode_range?: string;
  title?: string;
  content?: string;
  setting_id?: string | null;
  scene_order?: number;
}

interface StoryWorldSummary {
  id: string;
  name: string;
  genre: string;
  description: string;
}

interface StoryCharacterSummary {
  id: string;
  name: string;
  role: string;
  traits: string[];
  backstory: string;
}

interface StoryCharacterRelationship {
  with: string;
  type: string;
  description: string;
}

interface StoryCharacterScene {
  id: string;
  title: string;
  type: string;
  scene_order: number;
  content_preview: string;
}

interface StoryCharacterFaction {
  name: string;
  description: string;
}

interface StoryArcSummary {
  id: string;
  name: string;
  type: string;
  description: string;
  season: string;
  episode_range: string;
  arc_order: number;
  characters: string[];
}

interface StoryFactionSummary {
  id: string;
  name: string;
  description: string;
  members: string[];
}

interface StorySceneSummary {
  id: string;
  title: string;
  type: string;
  scene_order: number;
  characters: string[];
  setting: string | null;
  content: string;
  created_at: string;
}

interface StoryScenePage {
  total: number;
  offset: number;
  limit: number;
  items: StorySceneSummary[];
}

interface StoryReadSuccess {
  success: true;
  world: StoryWorldSummary;
  character?: StoryCharacterSummary & {
    relationships: StoryCharacterRelationship[];
    scenes: StoryCharacterScene[];
    factions: StoryCharacterFaction[];
  };
  characters?: StoryCharacterSummary[];
  settings?: LocationRow[];
  themes?: ThemeRow[];
  relationships?: RelationshipRow[];
  arcs?: StoryArcSummary[];
  factions?: StoryFactionSummary[];
  lore?: TypedDescriptionRow[];
  rules?: TypedDescriptionRow[];
  scenes?: StoryScenePage;
}

interface StoryReadFailure {
  success: false;
  error: string;
}

type StoryReadResult = StoryReadSuccess | StoryReadFailure;

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function uuid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }

// Explicit allowlist: entity kind → fixed table name. Exactly the entity tables
// this app's own migrations create (worlds/relationships are handled by their
// own dedicated code paths, never through the generic lookup).
const ENTITY_TABLES: Record<EntityTable, EntityTable> = {
  characters: 'characters',
  locations: 'locations',
  themes: 'themes',
  arcs: 'arcs',
  factions: 'factions',
  lore: 'lore',
  rules: 'rules',
  scenes: 'scenes',
};

function entityTable(kind: string): EntityTable {
  const table = (ENTITY_TABLES as Record<string, EntityTable | undefined>)[kind];
  if (!table) {
    throw new Error(
      'Unknown entity kind: ' + kind + '. Expected one of: ' + Object.keys(ENTITY_TABLES).join(', ')
    );
  }
  return table;
}

async function getWorld(world_id_or_name: string): Promise<WorldRow | null> {
  // Try by ID first, then by name
  return (
    await galactic.db.first('worlds', {
      columns: ['id', 'name', 'genre', 'description'],
      where: { id: world_id_or_name },
    })
  ) || (
    await galactic.db.first('worlds', {
      columns: ['id', 'name', 'genre', 'description'],
      where: { name: world_id_or_name },
    })
  );
}

// Resolve a character by name or ID within a world
async function resolveChar(world_id: string, name_or_id: string): Promise<CharacterRow | null> {
  return galactic.db.first('characters', {
    where: { world_id, _or: [{ id: name_or_id }, { name: name_or_id }] },
  });
}

// Resolve any entity by name or ID (allowlisted table dispatch)
async function resolveEntity(table: EntityTable, world_id: string, name_or_id: string): Promise<ResolvedEntityRow | null> {
  return galactic.db.first(entityTable(table), {
    where: { world_id, _or: [{ id: name_or_id }, { name: name_or_id }] },
  });
}

// Build a name→id map for characters in a world
async function charNameMap(world_id: string): Promise<Map<string, string>> {
  const chars: CharacterNameRow[] = await galactic.db.select('characters', {
    columns: ['id', 'name'],
    where: { world_id },
  });
  return new Map(chars.map((char) => [char.name, char.id]));
}

async function fetchCharacterIdToName(world_id: string): Promise<Map<string, string>> {
  const chars: CharacterNameRow[] = await galactic.db.select('characters', {
    columns: ['id', 'name'],
    where: { world_id },
  });
  return new Map(chars.map((char) => [char.id, char.name]));
}

async function fetchLocationIdToName(world_id: string): Promise<Map<string, string>> {
  const locations: Pick<LocationRow, 'id' | 'name'>[] = await galactic.db.select('locations', {
    columns: ['id', 'name'],
    where: { world_id },
  });
  return new Map(locations.map((location) => [location.id, location.name]));
}

// ── CREATE WORLD ──

export async function create_world(args: {
  name: string;
  genre: string;
  description?: string;
}): Promise<unknown> {
  const { name, genre, description } = args;
  const id = uuid();
  const ts = now();

  await galactic.db.insert('worlds', {
    id,
    name,
    genre,
    description: description || '',
    created_at: ts,
    updated_at: ts,
  });

  return { success: true, world_id: id, name, genre };
}

// ── ADD (batch create any combination of entities) ──

export async function add(args: {
  world_id: string;
  characters?: Array<{ name: string; role?: string; traits?: string[]; backstory?: string }>;
  settings?: Array<{ name: string; description: string }>;
  themes?: Array<{ name: string; description: string }>;
  relationships?: Array<{ character_a: string; character_b: string; type: string; description?: string }>;
  arcs?: Array<{ name: string; type?: string; description: string; season?: string; episode_range?: string; characters?: string[] }>;
  factions?: Array<{ name: string; description: string; members?: string[] }>;
  lore?: Array<{ name: string; type?: string; description: string }>;
  rules?: Array<{ name: string; type?: string; description: string }>;
  scenes?: Array<{ title: string; content: string; type?: string; character_names?: string[]; setting_name?: string }>;
}): Promise<unknown> {
  const world = await getWorld(args.world_id);
  if (!world) return { success: false, error: 'World not found: ' + args.world_id };
  const world_id = world.id; // resolved ID (accepts name or ID)

  const ts = now();
  const created: MutationBuckets = {};

  // Characters first (so relationships/factions can reference them by name)
  if (args.characters && args.characters.length > 0) {
    created.characters = [];
    for (const c of args.characters) {
      const id = uuid();
      await galactic.db.insert('characters', {
        id,
        world_id,
        name: c.name,
        traits: JSON.stringify(c.traits || []),
        backstory: c.backstory || '',
        role: c.role || '',
        relationships: '[]',
        created_at: ts,
        updated_at: ts,
      });
      created.characters.push({ id, name: c.name });
    }
  }

  // Build name map after characters are created
  const nameMap = await charNameMap(world_id);

  // Settings
  if (args.settings && args.settings.length > 0) {
    created.settings = [];
    for (const s of args.settings) {
      const id = uuid();
      await galactic.db.insert('locations', {
        id,
        world_id,
        name: s.name,
        description: s.description,
        created_at: ts,
        updated_at: ts,
      });
      created.settings.push({ id, name: s.name });
    }
  }

  // Themes
  if (args.themes && args.themes.length > 0) {
    created.themes = [];
    for (const t of args.themes) {
      const id = uuid();
      await galactic.db.insert('themes', {
        id,
        world_id,
        name: t.name,
        description: t.description,
        created_at: ts,
        updated_at: ts,
      });
      created.themes.push({ id, name: t.name });
    }
  }

  // Relationships (by character name)
  if (args.relationships && args.relationships.length > 0) {
    created.relationships = [];
    for (const r of args.relationships) {
      const aId = nameMap.get(r.character_a);
      const bId = nameMap.get(r.character_b);
      if (!aId) { created.relationships.push({ error: 'Character not found: ' + r.character_a }); continue; }
      if (!bId) { created.relationships.push({ error: 'Character not found: ' + r.character_b }); continue; }
      const id = uuid();
      await galactic.db.insert('relationships', {
        id,
        world_id,
        character_a_id: aId,
        character_b_id: bId,
        type: r.type,
        description: r.description || '',
        created_at: ts,
        updated_at: ts,
      });
      created.relationships.push({ id, between: [r.character_a, r.character_b], type: r.type });
    }
  }

  // Arcs (character names resolved to IDs)
  if (args.arcs && args.arcs.length > 0) {
    created.arcs = [];
    const arcCount = (await galactic.db.count('arcs', { where: { world_id } })) || 0;
    let order = arcCount;
    for (const a of args.arcs) {
      const id = uuid();
      const charIds = (a.characters || []).map(n => nameMap.get(n)).filter(Boolean);
      await galactic.db.insert('arcs', {
        id,
        world_id,
        name: a.name,
        type: a.type || 'narrative',
        description: a.description,
        season: a.season || '',
        episode_range: a.episode_range || '',
        character_ids: JSON.stringify(charIds),
        arc_order: order++,
        created_at: ts,
        updated_at: ts,
      });
      created.arcs.push({ id, name: a.name });
    }
  }

  // Factions (member names resolved to IDs)
  if (args.factions && args.factions.length > 0) {
    created.factions = [];
    for (const f of args.factions) {
      const id = uuid();
      const memberIds = (f.members || []).map(n => nameMap.get(n)).filter(Boolean);
      await galactic.db.insert('factions', {
        id,
        world_id,
        name: f.name,
        description: f.description,
        member_ids: JSON.stringify(memberIds),
        created_at: ts,
        updated_at: ts,
      });
      created.factions.push({ id, name: f.name });
    }
  }

  // Lore
  if (args.lore && args.lore.length > 0) {
    created.lore = [];
    for (const l of args.lore) {
      const id = uuid();
      await galactic.db.insert('lore', {
        id,
        world_id,
        name: l.name,
        type: l.type || 'institution',
        description: l.description,
        created_at: ts,
        updated_at: ts,
      });
      created.lore.push({ id, name: l.name });
    }
  }

  // Rules
  if (args.rules && args.rules.length > 0) {
    created.rules = [];
    for (const r of args.rules) {
      const id = uuid();
      await galactic.db.insert('rules', {
        id,
        world_id,
        name: r.name,
        type: r.type || 'constraint',
        description: r.description,
        created_at: ts,
        updated_at: ts,
      });
      created.rules.push({ id, name: r.name });
    }
  }

  // Scenes
  if (args.scenes && args.scenes.length > 0) {
    created.scenes = [];
    const sceneCount = (await galactic.db.count('scenes', { where: { world_id } })) || 0;
    let order = sceneCount;
    for (const s of args.scenes) {
      const id = uuid();
      const charIds = (s.character_names || []).map(n => nameMap.get(n)).filter(Boolean);
      const settingRow = s.setting_name ? await resolveEntity('locations', world_id, s.setting_name) : null;
      await galactic.db.insert('scenes', {
        id,
        world_id,
        title: s.title,
        content: s.content,
        type: s.type || 'scene',
        character_ids: JSON.stringify(charIds),
        setting_id: settingRow?.id || null,
        scene_order: order++,
        created_at: ts,
        updated_at: ts,
      });
      created.scenes.push({ id, title: s.title });
    }
  }

  return { success: true, world: world.name, created };
}

// ── READ (query any combination of dimensions) ──

export async function read(args: {
  world_id: string;
  include?: string[];
  character_name?: string;
  scene_limit?: number;
  scene_offset?: number;
}): Promise<StoryReadResult> {
  const world = await getWorld(args.world_id);
  if (!world) return { success: false, error: 'World not found: ' + args.world_id };
  const world_id = world.id; // resolved ID (accepts name or ID)

  const include = args.include || ['characters', 'settings', 'themes', 'relationships', 'arcs', 'factions', 'lore', 'rules', 'scenes'];
  const includeSet = new Set(include);
  const result: StoryReadSuccess = {
    success: true,
    world: { id: world.id, name: world.name, genre: world.genre, description: world.description },
  };

  // If zooming into a single character
  if (args.character_name) {
    const char = await resolveChar(world_id, args.character_name);
    if (!char) return { success: false, error: 'Character not found: ' + args.character_name };

    result.character = {
      id: char.id, name: char.name, role: char.role,
      traits: parseStringArray(char.traits),
      backstory: char.backstory,
      relationships: [],
      scenes: [],
      factions: [],
    };

    // Their relationships
    const rels: RelationshipLookupRow[] = await galactic.db.select('relationships', {
      columns: [
        'id', 'type', 'description',
        { table: 'a', column: 'name', as: 'a_name' },
        { table: 'b', column: 'name', as: 'b_name' },
      ],
      joins: [
        { table: 'characters', as: 'a', type: 'inner', on: { fromColumn: 'character_a_id', foreignColumn: 'id' } },
        { table: 'characters', as: 'b', type: 'inner', on: { fromColumn: 'character_b_id', foreignColumn: 'id' } },
      ],
      where: { world_id, _or: [{ character_a_id: char.id }, { character_b_id: char.id }] },
    });
    result.character.relationships = rels.map((relationship) => ({
      with: relationship.a_name === char.name ? relationship.b_name : relationship.a_name,
      type: relationship.type,
      description: relationship.description,
    }));

    // Scenes they appear in
    const scenes: Pick<SceneRow, 'id' | 'title' | 'type' | 'content' | 'scene_order'>[] = await galactic.db.select('scenes', {
      columns: ['id', 'title', 'type', 'content', 'scene_order', 'created_at'],
      where: { world_id, character_ids: { like: '%' + char.id + '%' } },
      orderBy: { column: 'scene_order', dir: 'asc' },
    });
    result.character.scenes = scenes.map((scene) => ({
      id: scene.id, title: scene.title, type: scene.type, scene_order: scene.scene_order,
      content_preview: scene.content.slice(0, 300),
    }));

    // Factions they belong to
    const factions: Pick<FactionRow, 'id' | 'name' | 'description'>[] = await galactic.db.select('factions', {
      columns: ['id', 'name', 'description', 'member_ids'],
      where: { world_id, member_ids: { like: '%' + char.id + '%' } },
    });
    result.character.factions = factions.map((faction) => ({ name: faction.name, description: faction.description }));

    return result;
  }

  // Full world read with include filter
  if (includeSet.has('characters')) {
    const chars: CharacterRow[] = await galactic.db.select('characters', {
      columns: ['id', 'name', 'role', 'traits', 'backstory'],
      where: { world_id },
    });
    result.characters = chars.map((character) => ({
      id: character.id, name: character.name, role: character.role,
      traits: parseStringArray(character.traits),
      backstory: character.backstory,
    }));
  }

  if (includeSet.has('settings')) {
    result.settings = await galactic.db.select('locations', {
      columns: ['id', 'name', 'description'],
      where: { world_id },
    });
  }

  if (includeSet.has('themes')) {
    result.themes = await galactic.db.select('themes', {
      columns: ['id', 'name', 'description'],
      where: { world_id },
    });
  }

  if (includeSet.has('relationships')) {
    const rels: RelationshipRow[] = await galactic.db.select('relationships', {
      columns: [
        'id', 'type', 'description',
        { table: 'a', column: 'name', as: 'character_a' },
        { table: 'b', column: 'name', as: 'character_b' },
      ],
      joins: [
        { table: 'characters', as: 'a', type: 'inner', on: { fromColumn: 'character_a_id', foreignColumn: 'id' } },
        { table: 'characters', as: 'b', type: 'inner', on: { fromColumn: 'character_b_id', foreignColumn: 'id' } },
      ],
      where: { world_id },
    });
    result.relationships = rels;
  }

  if (includeSet.has('arcs')) {
    const arcs: ArcRow[] = await galactic.db.select('arcs', {
      columns: ['id', 'name', 'type', 'description', 'season', 'episode_range', 'character_ids', 'arc_order'],
      where: { world_id },
      orderBy: { column: 'arc_order', dir: 'asc' },
    });
    const idToName = result.characters
      ? new Map(result.characters.map((character) => [character.id, character.name]))
      : await fetchCharacterIdToName(world_id);
    result.arcs = arcs.map((arc) => ({
      id: arc.id, name: arc.name, type: arc.type, description: arc.description,
      season: arc.season, episode_range: arc.episode_range, arc_order: arc.arc_order,
      characters: parseStringArray(arc.character_ids).map((id) => idToName.get(id) || id),
    }));
  }

  if (includeSet.has('factions')) {
    const factions: FactionRow[] = await galactic.db.select('factions', {
      columns: ['id', 'name', 'description', 'member_ids'],
      where: { world_id },
    });
    const idToName = result.characters
      ? new Map(result.characters.map((character) => [character.id, character.name]))
      : await fetchCharacterIdToName(world_id);
    result.factions = factions.map((faction) => ({
      id: faction.id, name: faction.name, description: faction.description,
      members: parseStringArray(faction.member_ids).map((id) => idToName.get(id) || id),
    }));
  }

  if (includeSet.has('lore')) {
    result.lore = await galactic.db.select('lore', {
      columns: ['id', 'name', 'type', 'description'],
      where: { world_id },
    });
  }

  if (includeSet.has('rules')) {
    result.rules = await galactic.db.select('rules', {
      columns: ['id', 'name', 'type', 'description'],
      where: { world_id },
    });
  }

  if (includeSet.has('scenes')) {
    const limit = args.scene_limit || 10;
    const offset = args.scene_offset || 0;
    const scenes: SceneRow[] = await galactic.db.select('scenes', {
      columns: ['id', 'title', 'type', 'content', 'character_ids', 'setting_id', 'scene_order', 'created_at'],
      where: { world_id },
      orderBy: { column: 'scene_order', dir: 'asc' },
      limit,
      offset,
    });
    const idToName = result.characters
      ? new Map(result.characters.map((character) => [character.id, character.name]))
      : await fetchCharacterIdToName(world_id);
    const settingsMap = result.settings
      ? new Map(result.settings.map((setting) => [setting.id, setting.name]))
      : await fetchLocationIdToName(world_id);
    const totalScenes = (await galactic.db.count('scenes', { where: { world_id } })) || 0;
    result.scenes = {
      total: totalScenes,
      offset,
      limit,
      items: scenes.map((scene) => ({
        id: scene.id, title: scene.title, type: scene.type, scene_order: scene.scene_order,
        characters: parseStringArray(scene.character_ids).map((id) => idToName.get(id) || id),
        setting: scene.setting_id ? settingsMap.get(scene.setting_id) || scene.setting_id : null,
        content: scene.content,
        created_at: scene.created_at,
      })),
    };
  }

  return result;
}

// ── UPDATE (batch update entities by name or ID) ──

export async function update(args: {
  world_id: string;
  world?: { name?: string; genre?: string; description?: string };
  characters?: Array<{ name_or_id: string; name?: string; role?: string; traits?: string[]; backstory?: string; merge_traits?: boolean }>;
  settings?: Array<{ name_or_id: string; name?: string; description?: string }>;
  themes?: Array<{ name_or_id: string; name?: string; description?: string }>;
  relationships?: Array<{ between: string[]; type?: string; description?: string }>;
  arcs?: Array<{ name_or_id: string; name?: string; type?: string; description?: string; season?: string; episode_range?: string; characters?: string[] }>;
  factions?: Array<{ name_or_id: string; name?: string; description?: string; add_members?: string[]; remove_members?: string[] }>;
  lore?: Array<{ name_or_id: string; name?: string; type?: string; description?: string }>;
  rules?: Array<{ name_or_id: string; name?: string; type?: string; description?: string }>;
}): Promise<unknown> {
  const world = await getWorld(args.world_id);
  if (!world) return { success: false, error: 'World not found: ' + args.world_id };
  const world_id = world.id; // resolved ID (accepts name or ID)

  const ts = now();
  const updated: MutationBuckets = {};

  // World metadata
  if (args.world) {
    const set: Record<string, SqlValue> = {};
    if (args.world.name !== undefined) set.name = args.world.name;
    if (args.world.genre !== undefined) set.genre = args.world.genre;
    if (args.world.description !== undefined) set.description = args.world.description;
    if (Object.keys(set).length > 0) {
      set.updated_at = ts;
      await galactic.db.update('worlds', { set, where: { id: world_id } });
      updated.world = [{ success: true }];
    }
  }

  // Characters
  if (args.characters && args.characters.length > 0) {
    updated.characters = [];
    for (const c of args.characters) {
      const existing = await resolveChar(world_id, c.name_or_id);
      if (!existing) { updated.characters.push({ error: 'Not found: ' + c.name_or_id }); continue; }

      const set: Record<string, SqlValue> = {};
      if (c.name !== undefined) set.name = c.name;
      if (c.role !== undefined) set.role = c.role;
      if (c.backstory !== undefined) set.backstory = c.backstory;
      if (c.traits !== undefined) {
        if (c.merge_traits) {
          const existingTraits = parseStringArray(existing.traits);
          const merged = [...new Set([...existingTraits, ...c.traits])];
          set.traits = JSON.stringify(merged);
        } else {
          set.traits = JSON.stringify(c.traits);
        }
      }
      if (Object.keys(set).length > 0) {
        set.updated_at = ts;
        await galactic.db.update('characters', { set, where: { id: existing.id } });
        updated.characters.push({ name: c.name || existing.name, success: true });
      }
    }
  }

  // Settings
  if (args.settings && args.settings.length > 0) {
    updated.settings = [];
    for (const s of args.settings) {
      const existing = await resolveEntity('locations', world_id, s.name_or_id);
      if (!existing) { updated.settings.push({ error: 'Not found: ' + s.name_or_id }); continue; }
      const set: Record<string, SqlValue> = {};
      if (s.name !== undefined) set.name = s.name;
      if (s.description !== undefined) set.description = s.description;
      if (Object.keys(set).length > 0) {
        set.updated_at = ts;
        await galactic.db.update('locations', { set, where: { id: existing.id } });
        updated.settings.push({ name: s.name || existing.name, success: true });
      }
    }
  }

  // Themes
  if (args.themes && args.themes.length > 0) {
    updated.themes = [];
    for (const t of args.themes) {
      const existing = await resolveEntity('themes', world_id, t.name_or_id);
      if (!existing) { updated.themes.push({ error: 'Not found: ' + t.name_or_id }); continue; }
      const set: Record<string, SqlValue> = {};
      if (t.name !== undefined) set.name = t.name;
      if (t.description !== undefined) set.description = t.description;
      if (Object.keys(set).length > 0) {
        set.updated_at = ts;
        await galactic.db.update('themes', { set, where: { id: existing.id } });
        updated.themes.push({ name: t.name || existing.name, success: true });
      }
    }
  }

  // Relationships (by name pair)
  if (args.relationships && args.relationships.length > 0) {
    updated.relationships = [];
    const nameMapData = await charNameMap(world_id);
    for (const r of args.relationships) {
      if (!r.between || r.between.length !== 2) { updated.relationships.push({ error: 'between must be [charA, charB]' }); continue; }
      const aId = nameMapData.get(r.between[0]);
      const bId = nameMapData.get(r.between[1]);
      if (!aId || !bId) { updated.relationships.push({ error: 'Character not found in pair: ' + r.between.join(', ') }); continue; }

      // Find relationship in either direction
      const existing = await galactic.db.first('relationships', {
        columns: ['id'],
        where: {
          world_id,
          _or: [
            { character_a_id: aId, character_b_id: bId },
            { character_a_id: bId, character_b_id: aId },
          ],
        },
      }) as Pick<RelationshipRow, 'id'> | null;
      if (!existing) { updated.relationships.push({ error: 'No relationship between: ' + r.between.join(', ') }); continue; }

      const set: Record<string, SqlValue> = {};
      if (r.type !== undefined) set.type = r.type;
      if (r.description !== undefined) set.description = r.description;
      if (Object.keys(set).length > 0) {
        set.updated_at = ts;
        await galactic.db.update('relationships', { set, where: { id: existing.id } });
        updated.relationships.push({ between: r.between, success: true });
      }
    }
  }

  // Arcs
  if (args.arcs && args.arcs.length > 0) {
    updated.arcs = [];
    const nameMapData = await charNameMap(world_id);
    for (const a of args.arcs) {
      const existing = await resolveEntity('arcs', world_id, a.name_or_id);
      if (!existing) { updated.arcs.push({ error: 'Not found: ' + a.name_or_id }); continue; }
      const set: Record<string, SqlValue> = {};
      if (a.name !== undefined) set.name = a.name;
      if (a.type !== undefined) set.type = a.type;
      if (a.description !== undefined) set.description = a.description;
      if (a.season !== undefined) set.season = a.season;
      if (a.episode_range !== undefined) set.episode_range = a.episode_range;
      if (a.characters !== undefined) {
        const charIds = a.characters.map(n => nameMapData.get(n)).filter(Boolean);
        set.character_ids = JSON.stringify(charIds);
      }
      if (Object.keys(set).length > 0) {
        set.updated_at = ts;
        await galactic.db.update('arcs', { set, where: { id: existing.id } });
        updated.arcs.push({ name: a.name || existing.name, success: true });
      }
    }
  }

  // Factions (with add/remove members)
  if (args.factions && args.factions.length > 0) {
    updated.factions = [];
    const nameMapData = await charNameMap(world_id);
    for (const f of args.factions) {
      const existing = await resolveEntity('factions', world_id, f.name_or_id);
      if (!existing) { updated.factions.push({ error: 'Not found: ' + f.name_or_id }); continue; }
      const set: Record<string, SqlValue> = {};
      if (f.name !== undefined) set.name = f.name;
      if (f.description !== undefined) set.description = f.description;

      // Member management
      if (f.add_members || f.remove_members) {
        let currentMembers: string[] = parseStringArray(existing.member_ids);
        if (f.add_members) {
          const newIds = f.add_members.map(n => nameMapData.get(n)).filter(Boolean) as string[];
          currentMembers = [...new Set([...currentMembers, ...newIds])];
        }
        if (f.remove_members) {
          const removeIds = new Set(f.remove_members.map(n => nameMapData.get(n)).filter(Boolean));
          currentMembers = currentMembers.filter(id => !removeIds.has(id));
        }
        set.member_ids = JSON.stringify(currentMembers);
      }

      if (Object.keys(set).length > 0) {
        set.updated_at = ts;
        await galactic.db.update('factions', { set, where: { id: existing.id } });
        updated.factions.push({ name: f.name || existing.name, success: true });
      }
    }
  }

  // Lore
  if (args.lore && args.lore.length > 0) {
    updated.lore = [];
    for (const l of args.lore) {
      const existing = await resolveEntity('lore', world_id, l.name_or_id);
      if (!existing) { updated.lore.push({ error: 'Not found: ' + l.name_or_id }); continue; }
      const set: Record<string, SqlValue> = {};
      if (l.name !== undefined) set.name = l.name;
      if (l.type !== undefined) set.type = l.type;
      if (l.description !== undefined) set.description = l.description;
      if (Object.keys(set).length > 0) {
        set.updated_at = ts;
        await galactic.db.update('lore', { set, where: { id: existing.id } });
        updated.lore.push({ name: l.name || existing.name, success: true });
      }
    }
  }

  // Rules
  if (args.rules && args.rules.length > 0) {
    updated.rules = [];
    for (const r of args.rules) {
      const existing = await resolveEntity('rules', world_id, r.name_or_id);
      if (!existing) { updated.rules.push({ error: 'Not found: ' + r.name_or_id }); continue; }
      const set: Record<string, SqlValue> = {};
      if (r.name !== undefined) set.name = r.name;
      if (r.type !== undefined) set.type = r.type;
      if (r.description !== undefined) set.description = r.description;
      if (Object.keys(set).length > 0) {
        set.updated_at = ts;
        await galactic.db.update('rules', { set, where: { id: existing.id } });
        updated.rules.push({ name: r.name || existing.name, success: true });
      }
    }
  }

  return { success: true, world: world.name, updated };
}

// ── DELETE (batch delete entities by name or ID) ──

export async function remove(args: {
  world_id: string;
  characters?: string[];
  settings?: string[];
  themes?: string[];
  relationships?: string[];
  arcs?: string[];
  factions?: string[];
  lore?: string[];
  rules?: string[];
  scenes?: string[];
}): Promise<unknown> {
  const world = await getWorld(args.world_id);
  if (!world) return { success: false, error: 'World not found: ' + args.world_id };
  const world_id = world.id; // resolved ID (accepts name or ID)

  const deleted: MutationBuckets = {};

  // Helper: delete from an allowlisted entity table by name or ID
  async function deleteEntities(table: EntityTable, items: string[], label: string) {
    const results: MutationResultEntry[] = [];
    for (const nameOrId of items) {
      const entity = await resolveEntity(table, world_id, nameOrId);
      if (!entity) { results.push({ error: 'Not found: ' + nameOrId }); continue; }
      await galactic.db.delete(entityTable(table), { where: { id: entity.id } });
      results.push({ name: entity.name || nameOrId, success: true });
    }
    deleted[label] = results;
  }

  if (args.characters) {
    // Also delete their relationships
    for (const nameOrId of args.characters) {
      const char = await resolveChar(world_id, nameOrId);
      if (char) {
        await galactic.db.delete('relationships', {
          where: { _or: [{ character_a_id: char.id }, { character_b_id: char.id }] },
        });
      }
    }
    await deleteEntities('characters', args.characters, 'characters');
  }
  if (args.settings) await deleteEntities('locations', args.settings, 'settings');
  if (args.themes) await deleteEntities('themes', args.themes, 'themes');
  if (args.arcs) await deleteEntities('arcs', args.arcs, 'arcs');
  if (args.factions) await deleteEntities('factions', args.factions, 'factions');
  if (args.lore) await deleteEntities('lore', args.lore, 'lore');
  if (args.rules) await deleteEntities('rules', args.rules, 'rules');
  if (args.scenes) await deleteEntities('scenes', args.scenes, 'scenes');

  // Relationships by name pair ("Cash Bo / Blazer Sith") or ID
  if (args.relationships) {
    deleted.relationships = [];
    const nameMapData = await charNameMap(world_id);
    for (const item of args.relationships) {
      if (item.includes(' / ')) {
        const [nameA, nameB] = item.split(' / ').map(s => s.trim());
        const aId = nameMapData.get(nameA);
        const bId = nameMapData.get(nameB);
        if (!aId || !bId) { deleted.relationships.push({ error: 'Characters not found: ' + item }); continue; }
        const rel = await galactic.db.first('relationships', {
          columns: ['id'],
          where: {
            world_id,
            _or: [
              { character_a_id: aId, character_b_id: bId },
              { character_a_id: bId, character_b_id: aId },
            ],
          },
        }) as Pick<RelationshipRow, 'id'> | null;
        if (!rel) { deleted.relationships.push({ error: 'No relationship: ' + item }); continue; }
        await galactic.db.delete('relationships', { where: { id: rel.id } });
        deleted.relationships.push({ between: item, success: true });
      } else {
        // By ID
        const rel = await galactic.db.first('relationships', {
          columns: ['id'],
          where: { id: item },
        }) as Pick<RelationshipRow, 'id'> | null;
        if (!rel) { deleted.relationships.push({ error: 'Not found: ' + item }); continue; }
        await galactic.db.delete('relationships', { where: { id: item } });
        deleted.relationships.push({ id: item, success: true });
      }
    }
  }

  return { success: true, world: world.name, deleted };
}

// ── GET CONTEXT (full world dump for agent handoff) ──

export async function get_context(args: {
  world_id: string;
  format?: string;
}): Promise<unknown> {
  const world = await getWorld(args.world_id);
  if (!world) return { success: false, error: 'World not found: ' + args.world_id };
  const world_id = world.id; // resolved ID (accepts name or ID)

  // Get everything
  const fullRead = await read({ world_id, scene_limit: 100 });
  if (!fullRead.success) return fullRead;

  if (args.format === 'narrative') {
    // AI-generated handoff brief
    let context = `World: ${world.name} (${world.genre})\n`;
    if (world.description) context += world.description + '\n';

    if (fullRead.characters?.length) {
      context += `\n${fullRead.characters.length} Characters:\n`;
      for (const c of fullRead.characters) {
        context += `- ${c.name}${c.role ? ' (' + c.role + ')' : ''}`;
        if (c.traits?.length) context += ': ' + c.traits.join(', ');
        if (c.backstory) context += '. ' + c.backstory;
        context += '\n';
      }
    }

    if (fullRead.relationships?.length) {
      context += `\n${fullRead.relationships.length} Relationships:\n`;
      for (const r of fullRead.relationships) {
        context += `- ${r.character_a} ↔ ${r.character_b} [${r.type}]${r.description ? ': ' + r.description : ''}\n`;
      }
    }

    if (fullRead.factions?.length) {
      context += `\n${fullRead.factions.length} Factions:\n`;
      for (const f of fullRead.factions) {
        context += `- ${f.name}: ${f.description}${f.members?.length ? ' [' + f.members.join(', ') + ']' : ''}\n`;
      }
    }

    if (fullRead.arcs?.length) {
      context += `\nNarrative Arcs:\n`;
      for (const a of fullRead.arcs) {
        context += `- ${a.name} [${a.type}]`;
        if (a.season) context += ` (S${a.season}${a.episode_range ? ' E' + a.episode_range : ''})`;
        context += `: ${a.description}`;
        if (a.characters?.length) context += ` [${a.characters.join(', ')}]`;
        context += '\n';
      }
    }

    if (fullRead.lore?.length) {
      context += `\nLore & Institutions:\n`;
      for (const l of fullRead.lore) {
        context += `- ${l.name} [${l.type}]: ${l.description}\n`;
      }
    }

    if (fullRead.rules?.length) {
      context += `\nWorld Rules & Constraints:\n`;
      for (const r of fullRead.rules) {
        context += `- ${r.name} [${r.type}]: ${r.description}\n`;
      }
    }

    if (fullRead.settings?.length) {
      context += `\nSettings:\n`;
      for (const s of fullRead.settings) {
        context += `- ${s.name}: ${s.description}\n`;
      }
    }

    if (fullRead.themes?.length) {
      context += `\nThemes:\n`;
      for (const t of fullRead.themes) {
        context += `- ${t.name}: ${t.description}\n`;
      }
    }

    if (fullRead.scenes?.items?.length) {
      context += `\n${fullRead.scenes.total} Scenes (timeline):\n`;
      for (const s of fullRead.scenes.items) {
        context += `--- [${s.scene_order}] ${s.title} (${s.type})`;
        if (s.characters?.length) context += ` — ${s.characters.join(', ')}`;
        if (s.setting) context += ` @ ${s.setting}`;
        context += ` ---\n${s.content.slice(0, 500)}\n\n`;
      }
    }

    try {
      const response = await galactic.ai({
        model: 'openai/gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a story bible summarizer. Given the full structured data of a fictional world, produce a concise but comprehensive handoff brief. Cover: premise, key characters and their dynamics, political landscape, active narrative arcs and where they stand, world rules, and what has happened so far in generated scenes. Be specific — use character names, relationship types, faction allegiances. The brief should let a new writer pick up exactly where the last one left off.' },
          { role: 'user', content: context },
        ],
        max_tokens: 2000,
      });
      return { success: true, world: world.name, format: 'narrative', brief: response.content };
    } catch {
      // Fallback to structured if AI fails
      return { ...fullRead, format: 'structured' };
    }
  }

  // Default: structured
  return { ...fullRead, format: 'structured' };
}

// ── GENERATE (AI) ──

export async function generate(args: {
  world_id: string;
  type?: string;
  prompt?: string;
  character_names?: string[];
  setting_name?: string;
  save?: boolean;
}): Promise<unknown> {
  const { world_id, type, prompt, character_names, setting_name, save } = args;

  const world = await getWorld(world_id);
  if (!world) return { success: false, error: 'World not found: ' + world_id };

  // Build context directly from structured data (single AI call, no narrative pre-summary)
  const fullRead = await read({ world_id, scene_limit: 3 });
  if (!fullRead.success) {
    return fullRead;
  }
  let context = 'WORLD: ' + world.name + ' (' + world.genre + ')\n';
  if (world.description) context += world.description + '\n';

  if (fullRead.characters?.length) {
    context += '\nCHARACTERS:\n';
    for (const c of fullRead.characters) {
      context += '- ' + c.name;
      if (c.role) context += ' (' + c.role + ')';
      if (c.traits?.length) context += ': ' + c.traits.join(', ');
      if (c.backstory) context += '. ' + c.backstory;
      context += '\n';
    }
  }

  if (fullRead.relationships?.length) {
    context += '\nRELATIONSHIPS:\n';
    for (const r of fullRead.relationships) {
      context += '- ' + r.character_a + ' ↔ ' + r.character_b + ' [' + r.type + ']';
      if (r.description) context += ': ' + r.description;
      context += '\n';
    }
  }

  if (fullRead.factions?.length) {
    context += '\nFACTIONS:\n';
    for (const f of fullRead.factions) {
      context += '- ' + f.name + ': ' + f.description;
      if (f.members?.length) context += ' [' + f.members.join(', ') + ']';
      context += '\n';
    }
  }
  if (fullRead.arcs?.length) {
    context += '\nNARRATIVE ARCS:\n';
    for (const a of fullRead.arcs) {
      context += '- ' + a.name + ' [' + a.type + ']';
      if (a.season) context += ' (S' + a.season + (a.episode_range ? ' E' + a.episode_range : '') + ')';
      context += ': ' + a.description;
      if (a.characters?.length) context += ' [' + a.characters.join(', ') + ']';
      context += '\n';
    }
  }
  if (fullRead.lore?.length) {
    context += '\nLORE & INSTITUTIONS:\n';
    for (const l of fullRead.lore) context += '- ' + l.name + ' [' + l.type + ']: ' + l.description + '\n';
  }
  if (fullRead.rules?.length) {
    context += '\nWORLD RULES & CONSTRAINTS:\n';
    for (const r of fullRead.rules) context += '- ' + r.name + ' [' + r.type + ']: ' + r.description + '\n';
  }
  if (fullRead.settings?.length) {
    context += '\nSETTINGS:\n';
    for (const s of fullRead.settings) context += '- ' + s.name + ': ' + s.description + '\n';
  }
  if (fullRead.themes?.length) {
    context += '\nTHEMES:\n';
    for (const t of fullRead.themes) context += '- ' + t.name + ': ' + t.description + '\n';
  }
  if (fullRead.scenes?.items?.length) {
    context += '\nRECENT SCENES:\n';
    for (const s of fullRead.scenes.items) context += '--- ' + s.title + ' ---\n' + s.content.slice(0, 500) + '\n\n';
  }

  // Focus characters
  if (character_names && character_names.length > 0) {
    context += '\nFOCUS CHARACTERS: ' + character_names.join(', ') + '\n';
  }

  // Setting
  if (setting_name) {
    const setting = await resolveEntity('locations', world_id, setting_name);
    if (setting) {
      context += '\nSCENE LOCATION: ' + setting.name + ' — ' + setting.description + '\n';
    }
  }

  const genType = type || 'scene';
  const userPrompt = prompt || 'Write the next ' + genType + ' in this story.';

  const sceneCount = (await galactic.db.count('scenes', { where: { world_id } })) || 0;

  try {
    const response = await galactic.ai({
      model: 'openai/gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a creative writing assistant. Using the provided world context — including characters, relationships, factions, narrative arcs, lore, and world rules — generate compelling ' + genType + ' content that is consistent with all established dimensions. Respect world rules and craft constraints. Write in a vivid, engaging style appropriate for the genre.',
        },
        { role: 'user', content: context + '\n\nREQUEST: ' + userPrompt },
      ],
      max_tokens: 2000,
    });

    const content = response.content;

    // Save scene with character and setting linkage
    let sceneId = null;
    if (save !== false) {
      sceneId = uuid();
      const ts = now();
      const nameMapData = await charNameMap(world_id);
      const charIds = (character_names || []).map(n => nameMapData.get(n)).filter(Boolean);
      const settingRow = setting_name ? await resolveEntity('locations', world_id, setting_name) : null;

      await galactic.db.insert('scenes', {
        id: sceneId,
        world_id,
        title: genType + ' — ' + ts.split('T')[0],
        content,
        type: genType,
        character_ids: JSON.stringify(charIds),
        setting_id: settingRow?.id || null,
        scene_order: sceneCount,
        created_at: ts,
        updated_at: ts,
      });
    }

    return {
      type: genType,
      content,
      scene_id: sceneId,
      saved: save !== false,
      world: world.name,
      scene_order: sceneCount,
    };
  } catch (e) {
    return { success: false, error: 'Generation failed. Try a simpler prompt or fewer context elements.' };
  }
}
