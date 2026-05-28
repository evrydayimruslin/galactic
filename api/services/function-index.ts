// Function Index — per-user index of all available app functions.
// Built on app upload/version change, stored in KV (primary) + R2 (fallback), cached on desktop.
// Enables typed codemode recipes without a discovery call.

import { getEnv } from '../lib/env.ts';
import { createR2Service } from './storage.ts';
import { createAppsService } from './apps.ts';
import { buildJsonSchemaDescriptors, generateTypes, sanitizeToolName } from './codemode-tools.ts';
import type {
  AppForCodemode,
  ContextSourceIndexEntry,
  RoutineIndexEntry,
  WidgetIndexEntry,
} from './codemode-tools.ts';
import type { WidgetGenerationHints } from '../../shared/contracts/widget.ts';
import { createD1DataService } from './d1-data.ts';
import { parseStoredSkillsParsed } from './app-contracts.ts';

// ── Types ──

export interface FunctionIndex {
  functions: Record<string, {
    appId: string;
    appSlug: string;
    fnName: string;
    description: string;
    params: Record<string, { type: string; required?: boolean; description?: string }>;
    returns: string;
    conventions: string[];
    dependsOn: string[];
    generationHints?: WidgetGenerationHints;
  }>;
  widgets: WidgetIndexEntry[];
  contextSources: ContextSourceIndexEntry[];
  routines: RoutineIndexEntry[];
  types: string;
  updatedAt: string;
}

type IndexedApp = AppForCodemode & {
  skills_parsed: unknown;
  d1_database_id: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Build Index ──

/**
 * Rebuild the function index for a user.
 * Fetches all owned + saved apps, extracts function metadata,
 * generates TypeScript type declarations, and stores in R2.
 */
export async function rebuildFunctionIndex(userId: string): Promise<FunctionIndex> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  const headers = {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  // Fetch owned apps
  const ownedRes = await fetch(
    `${SUPABASE_URL}/rest/v1/apps?owner_id=eq.${userId}&deleted_at=is.null&select=id,name,slug,manifest,skills_parsed,d1_database_id`,
    { headers },
  );
  const ownedApps = ownedRes.ok
    ? await ownedRes.json() as Array<
      {
        id: string;
        name: string;
        slug: string;
        manifest: string | null;
        skills_parsed: unknown;
        d1_database_id: string | null;
      }
    >
    : [];

  // Fetch saved apps
  const savedRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_app_library?user_id=eq.${userId}&select=app_id`,
    { headers },
  );
  const savedIds = savedRes.ok
    ? (await savedRes.json() as Array<{ app_id: string }>).map((l) => l.app_id)
    : [];

  let savedApps: typeof ownedApps = [];
  if (savedIds.length > 0) {
    const likedAppsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/apps?id=in.(${
        savedIds.join(',')
      })&deleted_at=is.null&select=id,name,slug,manifest,skills_parsed,d1_database_id`,
      { headers },
    );
    savedApps = likedAppsRes.ok ? await likedAppsRes.json() as typeof ownedApps : [];
  }

  // Deduplicate and parse manifests
  const allAppsMap = new Map<string, IndexedApp>();
  for (const app of [...ownedApps, ...savedApps]) {
    if (!allAppsMap.has(app.id) && app.manifest) {
      const manifest = typeof app.manifest === 'string' ? JSON.parse(app.manifest) : app.manifest;
      const skillsParsed = parseStoredSkillsParsed(app.skills_parsed);
      allAppsMap.set(app.id, {
        id: app.id,
        name: app.name,
        slug: app.slug,
        manifest: isRecord(manifest) ? manifest as AppForCodemode['manifest'] : {},
        skills_parsed: skillsParsed,
        d1_database_id: app.d1_database_id,
      });
    }
  }
  const apps = Array.from(allAppsMap.values());

  // ── Fetch skill apps (owned + saved) — .md context files ──
  const skillOwnedRes = await fetch(
    `${SUPABASE_URL}/rest/v1/apps?owner_id=eq.${userId}&app_type=eq.skill&deleted_at=is.null&select=id,name,slug,description,storage_key`,
    { headers },
  );
  const skillOwned = skillOwnedRes.ok
    ? await skillOwnedRes.json() as Array<
      { id: string; name: string; slug: string; description: string | null; storage_key: string }
    >
    : [];

  let skillLiked: typeof skillOwned = [];
  if (savedIds.length > 0) {
    const skillLikedRes = await fetch(
      `${SUPABASE_URL}/rest/v1/apps?id=in.(${
        savedIds.join(',')
      })&app_type=eq.skill&deleted_at=is.null&select=id,name,slug,description,storage_key`,
      { headers },
    );
    skillLiked = skillLikedRes.ok ? await skillLikedRes.json() as typeof skillOwned : [];
  }

  const skillApps = new Map<string, typeof skillOwned[0]>();
  for (const s of [...skillOwned, ...skillLiked]) {
    if (!skillApps.has(s.id)) skillApps.set(s.id, s);
  }

  // Build descriptors and types
  const { descriptors, toolMap, widgets, contextSources, routines } = buildJsonSchemaDescriptors(apps);

  // ── Enrichment pass: extract return types, conventions, dependency hints ──

  // 1. Extract return types from skills_parsed for each app
  const returnTypesMap: Record<string, string> = {}; // sanitizedName → return type string
  const appReturnTypes = new Map<string, Map<string, string>>(); // appId → (fnName → returnType)

  for (const app of apps) {
    const sp = parseStoredSkillsParsed(app.skills_parsed);
    if (!sp?.functions) continue;

    const fnReturns = new Map<string, string>();
    for (const fn of sp.functions) {
      const retSchema = fn.returns as Record<string, unknown> | undefined;
      if (retSchema) {
        fnReturns.set(fn.name, schemaToReturnType(retSchema));
      }
    }
    appReturnTypes.set(app.id, fnReturns);

    // Map to sanitized tool names
    for (const [fnName, retType] of fnReturns) {
      const sanitized = sanitizeToolName(`${app.slug}_${fnName}`);
      if (toolMap[sanitized]) {
        returnTypesMap[sanitized] = retType;
      }
    }
  }

  // 2. For apps with d1_database_id, try to query conventions table
  const appConventions = new Map<string, string[]>(); // appId → conventions[]
  for (const app of apps) {
    if (!app.d1_database_id) continue;
    try {
      const d1 = createD1DataService(app.id, app.d1_database_id);
      const rows = await d1.all<{ key: string; value: string }>(
        `SELECT key, value FROM conventions ORDER BY rowid DESC LIMIT 50`,
      );
      if (rows.length > 0) {
        appConventions.set(app.id, rows.map((r) => `${r.key}: ${r.value}`));
      }
    } catch {
      // conventions table may not exist — that's fine, skip
    }
  }

  // Generate types with return type info
  const types = generateTypes(descriptors, returnTypesMap);

  // Build function entries
  const functions: FunctionIndex['functions'] = {};
  for (const [sanitizedName, mapping] of Object.entries(toolMap)) {
    const desc = descriptors[sanitizedName];
    const params: Record<string, { type: string; required?: boolean; description?: string }> = {};

    if (desc?.inputSchema?.properties) {
      const required = new Set(desc.inputSchema.required || []);
      for (const [pName, pSchema] of Object.entries(desc.inputSchema.properties)) {
        const schema = pSchema as Record<string, unknown>;
        params[pName] = {
          type: (schema.type as string) || 'unknown',
          required: required.has(pName),
          description: schema.description as string | undefined,
        };
      }
    }

    // 3. Infer dependency hints: params ending in _id → match to other functions' return types
    const dependsOn: string[] = [];
    for (const pName of Object.keys(params)) {
      if (pName.endsWith('_id')) {
        const entityName = pName.replace(/_id$/, '');
        // Look for functions that might produce this entity
        for (const [otherName, otherMapping] of Object.entries(toolMap)) {
          if (otherName === sanitizedName) continue;
          const otherReturn = returnTypesMap[otherName];
          if (
            otherReturn &&
            (otherReturn.toLowerCase().includes(entityName) ||
              otherMapping.fnName.toLowerCase().includes(`create_${entityName}`) ||
              otherMapping.fnName.toLowerCase().includes(`get_${entityName}`))
          ) {
            dependsOn.push(otherName);
          }
        }
      }
    }

    functions[sanitizedName] = {
      appId: mapping.appId,
      appSlug: mapping.appSlug,
      fnName: mapping.fnName,
      description: desc?.description || mapping.fnName,
      params,
      returns: returnTypesMap[sanitizedName] || 'unknown',
      conventions: appConventions.get(mapping.appId) || [],
      dependsOn: [...new Set(dependsOn)], // deduplicate
      ...(mapping.generationHints ? { generationHints: mapping.generationHints } : {}),
    };
  }

  // ── Add skill entries as context-only sources ──
  for (const [, skill] of skillApps) {
    const key = `skill__${skill.slug}`;
    functions[key] = {
      appId: skill.id,
      appSlug: skill.slug,
      fnName: '__context',
      description: `[${skill.name}] ${skill.description || 'Skill context'}`,
      params: {},
      returns: 'context',
      conventions: [],
      dependsOn: [],
    };
  }

  const index: FunctionIndex = {
    functions,
    widgets,
    contextSources,
    routines,
    types,
    updatedAt: new Date().toISOString(),
  };

  // Store in KV (primary), fall back to R2
  const kv = (globalThis as any).__env?.FN_INDEX;
  if (kv) {
    try {
      await kv.put(`user:${userId}`, JSON.stringify(index));
    } catch (err) {
      console.error(`KV write failed for ${userId}, falling back to R2:`, err);
      try {
        const r2 = createR2Service();
        const content = new TextEncoder().encode(JSON.stringify(index));
        await r2.uploadFile(`users/${userId}/function-index.json`, {
          name: 'function-index.json',
          content,
          contentType: 'application/json',
        });
      } catch (r2Err) {
        console.error(`R2 fallback write also failed for ${userId}:`, r2Err);
      }
    }
  } else {
    // KV not available — use R2 directly
    try {
      const r2 = createR2Service();
      const content = new TextEncoder().encode(JSON.stringify(index));
      await r2.uploadFile(`users/${userId}/function-index.json`, {
        name: 'function-index.json',
        content,
        contentType: 'application/json',
      });
    } catch (err) {
      console.error(`Failed to store function index for ${userId}:`, err);
    }
  }

  return index;
}

// ── Read Index ──

/**
 * Get the function index for a user.
 * Reads from KV (primary), falls back to R2. Returns null if not yet built.
 */
export async function getFunctionIndex(userId: string): Promise<FunctionIndex | null> {
  // Try KV first
  const kv = (globalThis as any).__env?.FN_INDEX;
  if (kv) {
    try {
      const data = await kv.get(`user:${userId}`, 'json');
      if (data) return data as FunctionIndex;
    } catch {
      // KV read failed, fall through to R2
    }
  }

  // Fall back to R2
  try {
    const r2 = createR2Service();
    const text = await r2.fetchTextFile(`users/${userId}/function-index.json`);
    return JSON.parse(text) as FunctionIndex;
  } catch {
    return null;
  }
}

/**
 * Return the cached function index when available, rebuilding on demand when the
 * user has not generated one yet. Command, Flash, and codemode all need the
 * same "catalog or build" behavior.
 */
export async function getOrRebuildFunctionIndex(userId: string): Promise<FunctionIndex> {
  const cached = await getFunctionIndex(userId);
  return cached ?? await rebuildFunctionIndex(userId);
}

// ── Supabase Env Helper ──

function getSupabaseEnv(): { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string } {
  return {
    SUPABASE_URL: getEnv('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: getEnv('SUPABASE_SERVICE_ROLE_KEY'),
  };
}

// ── Schema → TypeScript Return Type ──

/**
 * Convert a JSON Schema return type definition to a TypeScript type string.
 * Used to extract return types from skills_parsed for the function index.
 */
function schemaToReturnType(schema: Record<string, unknown>): string {
  if (!schema) return 'unknown';

  if (schema.$ref) {
    return (schema.$ref as string).replace('#/definitions/', '');
  }

  if (schema.oneOf) {
    return (schema.oneOf as Record<string, unknown>[]).map((s) => schemaToReturnType(s)).join(
      ' | ',
    );
  }

  const type = schema.type as string;
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'void':
      return 'void';
    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      return items ? `${schemaToReturnType(items)}[]` : 'unknown[]';
    }
    case 'object': {
      const props = schema.properties as Record<string, unknown> | undefined;
      if (!props) return 'Record<string, unknown>';
      const entries = Object.entries(props).map(([k, v]) => {
        return `${k}: ${schemaToReturnType(v as Record<string, unknown>)}`;
      });
      return `{ ${entries.join('; ')} }`;
    }
    default:
      return 'unknown';
  }
}
