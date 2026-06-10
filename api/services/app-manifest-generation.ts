import type {
  AppManifest,
  ManifestFunction,
  ManifestParameter,
  ManifestReturn,
  ManifestSkill,
} from '../../shared/contracts/manifest.ts';
import { validateManifest } from '../../shared/contracts/manifest.ts';
import type { ParseResult } from './parser.ts';
import { parseTypeScript } from './parser.ts';
import { parseAppManifest } from './app-settings.ts';

interface ManifestAppIdentity {
  name?: string | null;
  slug: string;
  description?: string | null;
}

type ManifestHydrationSource = 'uploaded' | 'merged' | 'generated';

interface ManifestHydrationResult {
  manifest: AppManifest;
  parseResult: ParseResult;
  source: ManifestHydrationSource;
}

interface StoredManifestCoverageResult {
  manifest: AppManifest | null;
  manifestJson: string | null;
  source: 'stored' | ManifestHydrationSource | 'none';
}

function jsonSchemaToManifestType(schema: Record<string, unknown>): ManifestParameter['type'] {
  const type = schema.type as string;
  if (
    type === 'string' ||
    type === 'number' ||
    type === 'boolean' ||
    type === 'object' ||
    type === 'array'
  ) {
    return type;
  }
  return 'object';
}

function hasRichManifestDescriptions(manifest: AppManifest): boolean {
  if (!manifest.functions) {
    return false;
  }

  return Object.values(manifest.functions).some((fn) =>
    typeof fn.description === 'string' &&
    fn.description.trim().length > 0 &&
    !fn.description.startsWith('Function ')
  );
}

function hasManifestFunctionContracts(
  manifest: AppManifest | null | undefined,
): boolean {
  return !!manifest?.functions && Object.keys(manifest.functions).length > 0;
}

function buildDefaultManifestSkill(
  app: ManifestAppIdentity,
  functionNames: string[],
): ManifestSkill {
  const appName = app.name || app.slug;
  const functionSummary = functionNames.length > 0
    ? `Functions: ${functionNames.slice(0, 12).join(', ')}.`
    : undefined;
  return {
    name: `${appName} context`,
    description: `Full usage context and examples for ${appName}.`,
    semantic_description: [app.description, functionSummary]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join(' '),
    resource: 'skills.md',
    format: 'markdown',
  };
}

function withDefaultManifestSkill(
  manifest: AppManifest,
  app: ManifestAppIdentity,
): AppManifest {
  const functionNames = manifest.functions ? Object.keys(manifest.functions) : [];
  const defaultSkill = buildDefaultManifestSkill(app, functionNames);
  return {
    ...manifest,
    skills: {
      context: defaultSkill,
      ...(manifest.skills || {}),
    },
  };
}

export function generateManifestFromParseResult(
  app: ManifestAppIdentity,
  parseResult: ParseResult,
  version: string,
  options: { entryFileName?: string } = {},
): AppManifest {
  const functions: Record<string, ManifestFunction> = {};

  for (const fn of parseResult.functions) {
    const parameters: Record<string, ManifestParameter> = {};
    for (const param of fn.parameters) {
      parameters[param.name] = {
        type: jsonSchemaToManifestType(param.schema as Record<string, unknown>),
        description: param.description || undefined,
        required: param.required !== false,
        ...(param.default !== undefined ? { default: param.default } : {}),
        ...(param.schema && (param.schema as Record<string, unknown>).properties
          ? {
            properties: (param.schema as Record<string, unknown>).properties as Record<
              string,
              ManifestParameter
            >,
          }
          : {}),
      };
    }

    functions[fn.name] = {
      description: fn.description || `Function ${fn.name}`,
      parameters: Object.keys(parameters).length > 0 ? parameters : undefined,
      returns: fn.returns?.type
        ? ({
          type: jsonSchemaToManifestType({
            type: fn.returns.type.replace(/^Promise<(.+)>$/, '$1'),
          } as Record<string, unknown>),
          description: fn.returns.description || undefined,
        } as ManifestReturn)
        : undefined,
      examples: fn.examples.length > 0 ? fn.examples : undefined,
    };
  }

  return {
    name: app.name || app.slug,
    version,
    description: app.description || undefined,
    type: 'mcp',
    entry: { functions: options.entryFileName || 'index.ts' },
    functions: Object.keys(functions).length > 0 ? functions : undefined,
    skills: {
      context: buildDefaultManifestSkill(
        app,
        parseResult.functions.map((fn) => fn.name),
      ),
    },
    permissions: parseResult.permissions.length > 0 ? parseResult.permissions : undefined,
  };
}

// Regenerated manifests must not silently drop the publisher's declared
// cross-Agent dependencies — external_functions is an authorization-bearing
// declaration, not derivable from source parsing.
function carryForwardExternalFunctions(
  existing: AppManifest | null,
  generated: AppManifest,
): AppManifest {
  if (!existing || existing.external_functions === undefined) return generated;
  return { ...generated, external_functions: existing.external_functions };
}

export function mergeManifestWithParseResult(
  app: ManifestAppIdentity,
  existingManifest: AppManifest | null,
  parseResult: ParseResult,
  version: string,
  options: { entryFileName?: string } = {},
): ManifestHydrationResult {
  const autoManifest = generateManifestFromParseResult(app, parseResult, version, options);

  if (existingManifest?.type === 'mcp' && hasManifestFunctionContracts(existingManifest)) {
    if (!hasRichManifestDescriptions(existingManifest)) {
      return {
        manifest: carryForwardExternalFunctions(existingManifest, autoManifest),
        parseResult,
        source: 'generated',
      };
    }

    const mergedManifest: AppManifest = {
      ...existingManifest,
      version,
      entry: {
        ...existingManifest.entry,
        functions: existingManifest.entry?.functions || options.entryFileName || 'index.ts',
      },
      permissions: existingManifest.permissions ?? autoManifest.permissions,
      functions: { ...(existingManifest.functions || {}) },
      skills: {
        ...(autoManifest.skills || {}),
        ...(existingManifest.skills || {}),
      },
    };

    if (autoManifest.functions) {
      for (const [fnName, fnDef] of Object.entries(autoManifest.functions)) {
        if (!mergedManifest.functions?.[fnName]) {
          mergedManifest.functions![fnName] = fnDef;
        }
      }
    }

    return {
      manifest: mergedManifest,
      parseResult,
      source: 'merged',
    };
  }

  return {
    manifest: carryForwardExternalFunctions(existingManifest, autoManifest),
    parseResult,
    source: 'generated',
  };
}

export async function hydrateManifestForSource(input: {
  app: ManifestAppIdentity;
  existingManifest?: AppManifest | string | null;
  sourceCode: string;
  filename?: string;
  version: string;
}): Promise<ManifestHydrationResult> {
  const existingManifest = parseAppManifest(input.existingManifest);
  const parseResult = await parseTypeScript(input.sourceCode, input.filename || 'index.ts');

  if (existingManifest?.type === 'mcp' && hasManifestFunctionContracts(existingManifest)) {
    return mergeManifestWithParseResult(
      input.app,
      existingManifest,
      parseResult,
      input.version,
      { entryFileName: input.filename || 'index.ts' },
    );
  }

  return {
    manifest: carryForwardExternalFunctions(
      existingManifest,
      generateManifestFromParseResult(
        input.app,
        parseResult,
        input.version,
        { entryFileName: input.filename || 'index.ts' },
      ),
    ),
    parseResult,
    source: existingManifest ? 'merged' : 'generated',
  };
}

function isManifestFileName(filename: string): boolean {
  return (filename.split('/').pop() || filename) === 'manifest.json';
}

async function fetchStoredManifest(
  fetchTextFile: (path: string) => Promise<string>,
  storageKey: string,
): Promise<AppManifest | null> {
  try {
    const manifestContent = await fetchTextFile(`${storageKey}manifest.json`);
    const parsed = JSON.parse(manifestContent);
    const validation = validateManifest(parsed);
    return validation.valid ? validation.manifest || null : null;
  } catch {
    return null;
  }
}

async function fetchStoredSource(
  fetchTextFile: (path: string) => Promise<string>,
  storageKey: string,
): Promise<{ code: string; filename: string } | null> {
  const candidates = [
    '_source_index.ts',
    '_source_index.tsx',
    '_source_index.jsx',
    '_source_index.js',
    'index.ts',
    'index.tsx',
    'index.jsx',
    'index.js',
  ];

  for (const candidate of candidates) {
    try {
      const code = await fetchTextFile(`${storageKey}${candidate}`);
      const filename = candidate.startsWith('_source_')
        ? candidate.replace('_source_', '')
        : candidate;
      return { code, filename };
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

export async function resolveStoredManifestCoverage(input: {
  app: ManifestAppIdentity;
  fetchTextFile: (path: string) => Promise<string>;
  storageKey: string;
  version: string;
  existingManifest?: AppManifest | string | null;
}): Promise<StoredManifestCoverageResult> {
  const storedManifest = await fetchStoredManifest(input.fetchTextFile, input.storageKey);
  if (hasManifestFunctionContracts(storedManifest)) {
    const manifest = withDefaultManifestSkill(storedManifest!, input.app);
    return {
      manifest,
      manifestJson: JSON.stringify(manifest, null, 2),
      source: 'stored',
    };
  }

  const sourceFile = await fetchStoredSource(input.fetchTextFile, input.storageKey);
  if (!sourceFile) {
    const manifest = parseAppManifest(storedManifest || input.existingManifest);
    return {
      manifest,
      manifestJson: manifest ? JSON.stringify(manifest, null, 2) : null,
      source: manifest ? 'merged' : 'none',
    };
  }

  const hydrated = await hydrateManifestForSource({
    app: input.app,
    existingManifest: storedManifest || input.existingManifest,
    sourceCode: sourceFile.code,
    filename: sourceFile.filename,
    version: input.version,
  });

  return {
    manifest: hydrated.manifest,
    manifestJson: JSON.stringify(hydrated.manifest, null, 2),
    source: hydrated.source,
  };
}

export function upsertManifestUploadFile<T extends { name: string } & Record<string, unknown>>(
  files: T[],
  manifest: AppManifest | null,
  buildFile: (manifestJson: string) => T,
): T[] {
  const withoutManifest = files.filter((file) => !isManifestFileName(file.name));
  if (!manifest) {
    return withoutManifest;
  }
  return [...withoutManifest, buildFile(JSON.stringify(manifest, null, 2))];
}
