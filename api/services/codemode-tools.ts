// Codemode Tools — builds typed tool definitions from user's app library manifests.
// Converts ManifestFunction parameters to JSON Schema, generates TypeScript type
// declarations, and creates executor-compatible function bindings.
//
// Inspired by @cloudflare/codemode but inlined for Deno compatibility.

import type { ManifestFunction, ManifestParameter } from '../../shared/contracts/manifest.ts';
import type {
  CommandCardDeclaration,
  WidgetDeclaration,
  WidgetDependencyDeclaration,
} from '../../shared/contracts/widget.ts';

// ── Types ──

export interface JsonSchemaToolDescriptor {
  description: string;
  inputSchema?: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface AppForCodemode {
  id: string;
  name: string;
  slug: string;
  manifest: {
    functions?: Record<string, ManifestFunction>;
    widgets?: WidgetDeclaration[];
  };
}

export interface ToolMapping {
  appId: string;
  appName: string;
  appSlug: string;
  fnName: string;
}

export interface WidgetCardIndexEntry {
  id: string;
  label: string;
  description?: string;
  size: string;
  render: 'native';
  kind?: string;
  dataView?: string;
  dataFunction?: string;
  refreshIntervalS?: number;
  dependencies?: WidgetDependencyDeclaration[];
}

export interface WidgetIndexEntry {
  name: string;
  label: string;
  description?: string;
  appId: string;
  appSlug: string;
  appName: string;
  uiFunction: string;
  dataFunction: string;
  dependencies?: WidgetDependencyDeclaration[];
  cards: WidgetCardIndexEntry[];
}

interface RpcToolCallEnvelope {
  result?: {
    content?: Array<{ type: string; text?: string }>;
  };
  error?: {
    message?: string;
  };
}

function normalizeToolArgs(args: unknown[]): Record<string, unknown> {
  const firstArg = args[0];
  return typeof firstArg === 'object' && firstArg !== null && !Array.isArray(firstArg)
    ? firstArg as Record<string, unknown>
    : {};
}

function widgetUiFunction(widget: Pick<WidgetDeclaration, 'id' | 'ui_function'>): string {
  return widget.ui_function || `widget_${widget.id}_ui`;
}

function widgetDataFunction(
  widget: Pick<WidgetDeclaration, 'id' | 'data_function' | 'data_tool'>,
): string {
  return widget.data_function || widget.data_tool || `widget_${widget.id}_data`;
}

function normalizeWidgetCard(
  _widget: WidgetDeclaration,
  card: CommandCardDeclaration,
): WidgetCardIndexEntry {
  return {
    id: card.id,
    label: card.label,
    ...(card.description ? { description: card.description } : {}),
    size: card.size,
    render: 'native',
    ...(card.kind ? { kind: card.kind } : {}),
    ...(card.data_view ? { dataView: card.data_view } : {}),
    ...(card.data_function ? { dataFunction: card.data_function } : {}),
    ...(typeof card.refresh_interval_s === 'number'
      ? { refreshIntervalS: card.refresh_interval_s }
      : {}),
    ...(card.dependencies?.length ? { dependencies: card.dependencies } : {}),
  };
}

export function buildWidgetIndexForApp(app: AppForCodemode): WidgetIndexEntry[] {
  const widgets: WidgetIndexEntry[] = [];

  for (const widget of app.manifest.widgets || []) {
    if (!widget?.id || !widget.label) continue;
    widgets.push({
      name: widget.id,
      label: widget.label,
      ...(widget.description ? { description: widget.description } : {}),
      appId: app.id,
      appSlug: app.slug,
      appName: app.name,
      uiFunction: widgetUiFunction(widget),
      dataFunction: widgetDataFunction(widget),
      ...(widget.dependencies?.length ? { dependencies: widget.dependencies } : {}),
      cards: (widget.cards || []).map((card) => normalizeWidgetCard(widget, card)),
    });
  }

  for (const fnName of Object.keys(app.manifest.functions || {})) {
    if (!fnName.startsWith('widget_') || !fnName.endsWith('_ui')) continue;
    const widgetName = fnName.replace('widget_', '').replace('_ui', '');
    if (widgets.some((w) => w.name === widgetName && w.appId === app.id)) continue;
    const fn = app.manifest.functions?.[fnName];
    widgets.push({
      name: widgetName,
      label: fn?.description?.replace(/DO NOT call.*$/i, '').trim() || widgetName,
      appId: app.id,
      appSlug: app.slug,
      appName: app.name,
      uiFunction: fnName,
      dataFunction: `widget_${widgetName}_data`,
      cards: [],
    });
  }

  return widgets;
}

// ── Tool Name Sanitization ──

const JS_RESERVED = new Set([
  'break',
  'case',
  'catch',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'finally',
  'for',
  'function',
  'if',
  'in',
  'instanceof',
  'new',
  'return',
  'switch',
  'this',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'class',
  'const',
  'enum',
  'export',
  'extends',
  'import',
  'super',
  'implements',
  'interface',
  'let',
  'package',
  'private',
  'protected',
  'public',
  'static',
  'yield',
  'await',
  'async',
]);

/** Sanitize a tool name to a valid JavaScript identifier */
export function sanitizeToolName(name: string): string {
  let sanitized = name.replace(/[-.\s]/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
  if (/^\d/.test(sanitized)) sanitized = '_' + sanitized;
  if (JS_RESERVED.has(sanitized)) sanitized += '_';
  return sanitized;
}

// ── ManifestParameter → JSON Schema ──

function manifestParamToJsonSchema(param: ManifestParameter): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: param.type };
  if (param.description) schema.description = param.description;
  if (param.enum) schema.enum = param.enum;
  if (param.default !== undefined) schema.default = param.default;
  if (param.type === 'array' && param.items) {
    schema.items = manifestParamToJsonSchema(param.items);
  }
  if (param.type === 'object' && param.properties) {
    const props: Record<string, unknown> = {};
    const req: string[] = [];
    for (const [k, v] of Object.entries(param.properties)) {
      props[k] = manifestParamToJsonSchema(v);
      if (v.required !== false) req.push(k);
    }
    schema.properties = props;
    if (req.length > 0) schema.required = req;
  }
  return schema;
}

function convertManifestToJsonSchema(
  params?: Record<string, ManifestParameter>,
): { type: 'object'; properties: Record<string, unknown>; required?: string[] } | undefined {
  if (!params || Object.keys(params).length === 0) return undefined;

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, param] of Object.entries(params)) {
    properties[name] = manifestParamToJsonSchema(param);
    if (param.required !== false) required.push(name);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

// ── Build Descriptors + Tool Map ──

/**
 * Build JSON Schema tool descriptors and a mapping from sanitized names
 * back to app IDs and function names.
 */
export function buildJsonSchemaDescriptors(apps: AppForCodemode[]): {
  descriptors: Record<string, JsonSchemaToolDescriptor>;
  toolMap: Record<string, ToolMapping>;
  widgets: WidgetIndexEntry[];
} {
  const descriptors: Record<string, JsonSchemaToolDescriptor> = {};
  const toolMap: Record<string, ToolMapping> = {};
  const widgets: WidgetIndexEntry[] = [];

  for (const app of apps) {
    if (!app.manifest) continue;
    const manifestFunctions = app.manifest.functions || {};

    // Normalize params that might be in array format
    for (const [fnName, fn] of Object.entries(manifestFunctions)) {
      // Skip widget internal functions
      if (fnName.startsWith('widget_') && (fnName.endsWith('_ui') || fnName.endsWith('_data'))) {
        continue;
      }
      if (fnName === 'widget_approval_queue') continue;

      const sanitized = sanitizeToolName(`${app.slug}_${fnName}`);
      const inputSchema = convertManifestToJsonSchema(
        fn.parameters as Record<string, ManifestParameter> | undefined,
      );

      descriptors[sanitized] = {
        description: `[${app.name}] ${fn.description || fnName}`,
        ...(inputSchema ? { inputSchema } : {}),
      };

      toolMap[sanitized] = {
        appId: app.id,
        appName: app.name,
        appSlug: app.slug,
        fnName,
      };
    }

    widgets.push(...buildWidgetIndexForApp(app));
  }

  // Add discovery tools
  descriptors['discover_library'] = {
    description: 'Search your app library for tools. Returns matching apps with their functions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g., "email", "billing")' },
      },
    },
  };

  descriptors['discover_appstore'] = {
    description: 'Search the app marketplace for published tools.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  };

  return { descriptors, toolMap, widgets };
}

// ── Generate TypeScript Types ──

/**
 * Generate TypeScript type declarations from JSON Schema tool descriptors.
 * Output format: declare const codemode: { fn1: (input: {...}) => Promise<unknown>; ... };
 *
 * Inlined from @cloudflare/codemode's generateTypesFromJsonSchema for Deno compat.
 */
export function generateTypes(
  descriptors: Record<string, JsonSchemaToolDescriptor>,
  returnTypes?: Record<string, string>, // sanitizedName → return type string
): string {
  const entries: string[] = [];

  for (const [name, desc] of Object.entries(descriptors)) {
    const jsdoc = desc.description ? `  /** ${desc.description} */\n` : '';

    let inputType = '{}';
    if (desc.inputSchema?.properties) {
      const props: string[] = [];
      const required = new Set(desc.inputSchema.required || []);

      for (const [pName, pSchema] of Object.entries(desc.inputSchema.properties)) {
        const schema = pSchema as Record<string, unknown>;
        const tsType = jsonSchemaTypeToTs(schema);
        const opt = required.has(pName) ? '' : '?';
        const pDesc = schema.description ? ` // ${schema.description}` : '';
        props.push(`    ${pName}${opt}: ${tsType};${pDesc}`);
      }

      inputType = props.length > 0 ? `{\n${props.join('\n')}\n  }` : '{}';
    }

    const returnType = returnTypes?.[name] || 'unknown';
    entries.push(`${jsdoc}  ${name}: (input: ${inputType}) => Promise<${returnType}>;`);
  }

  return `declare const codemode: {\n${entries.join('\n\n')}\n};`;
}

function jsonSchemaTypeToTs(schema: Record<string, unknown>): string {
  const type = schema.type as string;
  if (schema.enum) {
    return (schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(' | ');
  }
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      return items ? `${jsonSchemaTypeToTs(items)}[]` : 'unknown[]';
    }
    case 'object': {
      const props = schema.properties as Record<string, unknown> | undefined;
      if (!props) return 'Record<string, unknown>';
      const entries = Object.entries(props).map(([k, v]) => {
        const req = (schema.required as string[] | undefined)?.includes(k) ? '' : '?';
        return `${k}${req}: ${jsonSchemaTypeToTs(v as Record<string, unknown>)}`;
      });
      return `{ ${entries.join('; ')} }`;
    }
    default:
      return 'unknown';
  }
}

// ── Build Executor Functions ──

/**
 * Create async functions for each tool that route to MCP endpoints.
 * These are passed to the executor as the `codemode` namespace object.
 */
export function buildToolFunctions(
  toolMap: Record<string, ToolMapping>,
  baseUrl: string,
  authToken: string,
  discoverLibrary: (args: Record<string, unknown>) => Promise<unknown>,
  discoverAppstore: (args: Record<string, unknown>) => Promise<unknown>,
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  for (const [sanitizedName, mapping] of Object.entries(toolMap)) {
    fns[sanitizedName] = async (...incomingArgs: unknown[]): Promise<unknown> => {
      const args = normalizeToolArgs(incomingArgs);
      const rpcPayload = {
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tools/call',
        params: { name: mapping.fnName, arguments: args || {} },
      };

      const resp = await fetch(`${baseUrl}/mcp/${mapping.appId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify(rpcPayload),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`${mapping.fnName} failed (${resp.status}): ${errText}`);
      }

      const rpcResp = await resp.json() as RpcToolCallEnvelope;
      if (rpcResp.error) {
        throw new Error(rpcResp.error.message || JSON.stringify(rpcResp.error));
      }

      // Unwrap MCP result
      const result = rpcResp.result;
      if (result?.content && Array.isArray(result.content)) {
        const textBlock = result.content.find((c: { type: string }) => c.type === 'text');
        if (textBlock?.text) {
          try {
            return JSON.parse(textBlock.text);
          } catch {
            return textBlock.text;
          }
        }
      }
      return result;
    };
  }

  // Discovery functions
  fns['discover_library'] = async (...incomingArgs: unknown[]) => {
    return await discoverLibrary(normalizeToolArgs(incomingArgs));
  };

  fns['discover_appstore'] = async (...incomingArgs: unknown[]) => {
    return await discoverAppstore(normalizeToolArgs(incomingArgs));
  };

  return fns;
}
