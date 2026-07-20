// TypeScript Parser Service
// Parses TypeScript/JavaScript code to extract exported functions with full type information
// Uses the TypeScript compiler API for accurate AST parsing

import type * as tsTypes from 'typescript';
import type { ParsedSkills } from '../../shared/types/index.ts';
import { COMPUTE_EXEC_PERMISSION } from '../../shared/contracts/compute.ts';

// TypeScript compiler — dynamically imported to avoid __filename crash at module init.
// The TS compiler uses Node.js APIs (fs, path, __filename) not available in Workers global scope.
// We lazy-load it only when parseTypeScript() is actually called.
type TSModule = typeof import('typescript');
type TSLazyModule = TSModule & { default?: TSModule };

let _ts: TSModule | null = null;

async function loadTs(): Promise<TSModule> {
  if (_ts) return _ts;
  // The TS compiler references Node globals (__filename/__dirname) at import
  // time; they don't exist in the Workers runtime. Polyfill before importing so
  // a parse that runs before the bundler doesn't crash with
  // "__filename is not defined" (mirrors the polyfill in bundler.ts).
  const g = globalThis as unknown as { __filename?: string; __dirname?: string };
  if (typeof g.__filename === "undefined") g.__filename = "/worker.js";
  if (typeof g.__dirname === "undefined") g.__dirname = "/";
  const module = await import('typescript') as TSLazyModule;
  _ts = module.default ?? module;
  return _ts;
}

function getLoadedTs(): TSModule {
  if (!_ts) {
    throw new Error('TypeScript compiler has not been loaded');
  }

  return _ts;
}

// ============================================
// TYPES
// ============================================

export interface ParsedParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: unknown;
  schema: JsonSchema;
}

export interface ParsedReturn {
  type: string;
  description: string;
  schema: JsonSchema;
}

export interface ParsedFunction {
  name: string;
  description: string;
  parameters: ParsedParameter[];
  returns: ParsedReturn;
  isAsync: boolean;
  examples: string[];
  permissions: string[];
  /** True when this exported function (transitively) reaches galactic.ai() /
   *  ultralight.ai(). Conservative: true when uncertain. See FREE_MODE_DESIGN. */
  usesInference?: boolean;
  /** True when this exported function (transitively) starts galactic.compute(). */
  usesCompute?: boolean;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  required?: string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  $ref?: string;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export interface ParseResult {
  functions: ParsedFunction[];
  types: Record<string, JsonSchema>; // Exported type definitions for $ref resolution
  permissions: string[];
  description?: string; // File-level JSDoc description
  parseErrors: string[];
  parseWarnings: string[];
}

export interface JSDocInfo {
  description: string;
  params: Map<string, string>;
  returns: string;
  examples: string[];
  permissions: string[];
}

// ============================================
// MAIN PARSER
// ============================================

/**
 * Parse TypeScript/JavaScript code and extract exported functions
 */
export async function parseTypeScript(code: string, filename = 'index.ts'): Promise<ParseResult> {
  // Lazy-load TypeScript compiler (can't load at module init in CF Workers)
  const ts = await loadTs();

  const functions: ParsedFunction[] = [];
  const types: Record<string, JsonSchema> = {};
  const parseErrors: string[] = [];
  const parseWarnings: string[] = [];
  let fileDescription: string | undefined;

  try {
    // Create source file from code
    const sourceFile = ts.createSourceFile(
      filename,
      code,
      ts.ScriptTarget.Latest,
      true, // setParentNodes - needed for JSDoc extraction
      filename.endsWith('.tsx') || filename.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    // Extract file-level JSDoc (first comment block)
    const firstStatement = sourceFile.statements[0];
    if (firstStatement) {
      const fileJsDoc = getJSDocComment(firstStatement, sourceFile);
      if (fileJsDoc && !fileJsDoc.description.includes('@')) {
        fileDescription = fileJsDoc.description;
      }
    }

    // Walk the AST to find exports
    ts.forEachChild(sourceFile, (node: tsTypes.Node) => {
      try {
        // Export function declarations: export function foo() {}
        if (ts.isFunctionDeclaration(node) && isExported(node) && node.name) {
          const parsed = parseFunctionDeclaration(node, sourceFile);
          if (parsed) functions.push(parsed);
        }

        // Export variable statements: export const foo = () => {}
        if (ts.isVariableStatement(node) && isExported(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.initializer) {
              // Arrow function or function expression
              if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                const parsed = parseVariableFunction(decl, node, sourceFile);
                if (parsed) functions.push(parsed);
              }
            }
          }
        }

        // Export type/interface declarations for schema resolution
        if (ts.isInterfaceDeclaration(node) && isExported(node)) {
          const schema = parseInterfaceDeclaration(node, sourceFile);
          if (schema && node.name) {
            types[node.name.text] = schema;
          }
        }

        if (ts.isTypeAliasDeclaration(node) && isExported(node)) {
          const schema = parseTypeAlias(node, sourceFile);
          if (schema && node.name) {
            types[node.name.text] = schema;
          }
        }
      } catch (nodeErr) {
        parseWarnings.push(`Failed to parse node: ${nodeErr instanceof Error ? nodeErr.message : String(nodeErr)}`);
      }
    });

    // Also check for named exports: export { foo, bar }
    ts.forEachChild(sourceFile, (node: tsTypes.Node) => {
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const localName = element.propertyName?.text || element.name.text;
          // Find the original declaration
          const originalDecl = findDeclaration(sourceFile, localName);
          if (originalDecl && !functions.some(f => f.name === element.name.text)) {
            if (ts.isFunctionDeclaration(originalDecl) && originalDecl.name) {
              const parsed = parseFunctionDeclaration(originalDecl, sourceFile);
              if (parsed) {
                parsed.name = element.name.text; // Use exported name
                functions.push(parsed);
              }
            }
          }
        }
      }
    });

    // Per-function inference detection (Free Mode signal). Conservative — a
    // failure here marks every function by the cheap whole-code regex.
    try {
      const inference = analyzeInferenceUsage(ts, sourceFile, code);
      for (const fn of functions) {
        fn.usesInference = !inference.hasAi
          ? false
          : inference.allInference
          ? true
          : inference.byFunction.get(fn.name) ?? true;
      }
    } catch (infErr) {
      parseWarnings.push(
        `Inference analysis failed: ${infErr instanceof Error ? infErr.message : String(infErr)}`,
      );
      const hasAi = new RegExp(`${SDK}\\.ai\\s*\\(`).test(code);
      for (const fn of functions) fn.usesInference = hasAi;
    }

    // Per-function compute detection. This is an upload-derived admission and
    // accounting signal, not a developer-authored permission assertion.
    try {
      const compute = analyzeComputeUsage(ts, sourceFile, code);
      for (const fn of functions) {
        fn.usesCompute = !compute.hasCompute
          ? false
          : compute.allCompute
          ? true
          : compute.byFunction.get(fn.name) ?? true;
      }
    } catch (computeErr) {
      parseWarnings.push(
        `Compute analysis failed: ${
          computeErr instanceof Error ? computeErr.message : String(computeErr)
        }`,
      );
      const hasCompute = new RegExp(`${SDK}\\.compute\\s*\\(`).test(code);
      for (const fn of functions) fn.usesCompute = hasCompute;
    }
  } catch (err) {
    parseErrors.push(`Parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Infer permissions from code patterns
  const permissions = inferPermissions(code);

  return {
    functions,
    types,
    permissions,
    description: fileDescription,
    parseErrors,
    parseWarnings,
  };
}

// ============================================
// AST HELPERS
// ============================================

/**
 * Check if a node has export modifier
 */
function isExported(node: tsTypes.Node): boolean {
  const ts = getLoadedTs();
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((m: tsTypes.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Find a declaration by name in the source file
 */
function findDeclaration(sourceFile: tsTypes.SourceFile, name: string): tsTypes.Declaration | undefined {
  const ts = getLoadedTs();
  let found: tsTypes.Declaration | undefined;

  ts.forEachChild(sourceFile, (node: tsTypes.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) {
          found = decl;
        }
      }
    }
  });

  return found;
}

/**
 * Parse a function declaration into ParsedFunction
 */
function parseFunctionDeclaration(node: tsTypes.FunctionDeclaration, sourceFile: tsTypes.SourceFile): ParsedFunction | null {
  const ts = getLoadedTs();
  if (!node.name) return null;

  const name = node.name.text;
  const jsDoc = getJSDocComment(node, sourceFile);
  const isAsync = node.modifiers?.some((m: tsTypes.ModifierLike) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

  // Parse parameters
  const parameters = node.parameters.map(param => parseParameter(param, jsDoc, sourceFile));

  // Parse return type
  const returnType = node.type ? node.type.getText(sourceFile) : (isAsync ? 'Promise<void>' : 'void');
  const returnSchema = typeNodeToJsonSchema(node.type, sourceFile);

  return {
    name,
    description: jsDoc?.description || '',
    parameters,
    returns: {
      type: returnType,
      description: jsDoc?.returns || '',
      schema: returnSchema,
    },
    isAsync,
    examples: jsDoc?.examples || [],
    permissions: jsDoc?.permissions || [],
  };
}

/**
 * Parse a variable declaration with function initializer
 */
function parseVariableFunction(
  decl: tsTypes.VariableDeclaration,
  statement: tsTypes.VariableStatement,
  sourceFile: tsTypes.SourceFile
): ParsedFunction | null {
  const ts = getLoadedTs();
  if (!ts.isIdentifier(decl.name)) return null;
  if (!decl.initializer) return null;
  if (!ts.isArrowFunction(decl.initializer) && !ts.isFunctionExpression(decl.initializer)) return null;

  const fn = decl.initializer;
  const name = decl.name.text;
  const jsDoc = getJSDocComment(statement, sourceFile);
  const isAsync = fn.modifiers?.some((m: tsTypes.ModifierLike) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

  // Parse parameters
  const parameters = fn.parameters.map(param => parseParameter(param, jsDoc, sourceFile));

  // Parse return type - check variable type annotation first, then function return type
  let returnType = 'void';
  let returnTypeNode: tsTypes.TypeNode | undefined;

  if (decl.type && ts.isFunctionTypeNode(decl.type)) {
    returnTypeNode = decl.type.type;
    returnType = returnTypeNode?.getText(sourceFile) || 'void';
  } else if (fn.type) {
    returnTypeNode = fn.type;
    returnType = fn.type.getText(sourceFile);
  } else if (isAsync) {
    returnType = 'Promise<void>';
  }

  const returnSchema = typeNodeToJsonSchema(returnTypeNode, sourceFile);

  return {
    name,
    description: jsDoc?.description || '',
    parameters,
    returns: {
      type: returnType,
      description: jsDoc?.returns || '',
      schema: returnSchema,
    },
    isAsync,
    examples: jsDoc?.examples || [],
    permissions: jsDoc?.permissions || [],
  };
}

/**
 * Parse a parameter node
 */
function parseParameter(param: tsTypes.ParameterDeclaration, jsDoc: JSDocInfo | null, sourceFile: tsTypes.SourceFile): ParsedParameter {
  const name = param.name.getText(sourceFile);
  const type = param.type ? param.type.getText(sourceFile) : 'unknown';
  const required = !param.questionToken && !param.initializer;
  const schema = typeNodeToJsonSchema(param.type, sourceFile);

  // Get default value if present
  let defaultValue: unknown;
  if (param.initializer) {
    try {
      const initText = param.initializer.getText(sourceFile);
      // Try to parse as JSON for simple values
      if (initText === 'true') defaultValue = true;
      else if (initText === 'false') defaultValue = false;
      else if (initText === 'null') defaultValue = null;
      else if (/^-?\d+$/.test(initText)) defaultValue = parseInt(initText, 10);
      else if (/^-?\d+\.\d+$/.test(initText)) defaultValue = parseFloat(initText);
      else if (initText.startsWith("'") || initText.startsWith('"')) {
        defaultValue = initText.slice(1, -1);
      }
    } catch {
      // Ignore complex defaults
    }
  }

  return {
    name,
    type,
    description: jsDoc?.params.get(name) || '',
    required,
    default: defaultValue,
    schema,
  };
}

/**
 * Parse an interface declaration to JSON Schema
 */
function parseInterfaceDeclaration(node: tsTypes.InterfaceDeclaration, sourceFile: tsTypes.SourceFile): JsonSchema {
  const ts = getLoadedTs();
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const member of node.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const propName = member.name.getText(sourceFile);
      properties[propName] = typeNodeToJsonSchema(member.type, sourceFile);

      // Get JSDoc for property
      const jsDoc = getJSDocComment(member, sourceFile);
      if (jsDoc?.description) {
        properties[propName].description = jsDoc.description;
      }

      if (!member.questionToken) {
        required.push(propName);
      }
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/**
 * Parse a type alias to JSON Schema
 */
function parseTypeAlias(node: tsTypes.TypeAliasDeclaration, sourceFile: tsTypes.SourceFile): JsonSchema {
  return typeNodeToJsonSchema(node.type, sourceFile);
}

// ============================================
// TYPE TO JSON SCHEMA CONVERSION
// ============================================

/**
 * Convert a TypeScript type node to JSON Schema
 */
function typeNodeToJsonSchema(typeNode: tsTypes.TypeNode | undefined, sourceFile: tsTypes.SourceFile): JsonSchema {
  const ts = getLoadedTs();
  if (!typeNode) {
    return { type: 'any' };
  }

  // Keyword types: string, number, boolean, etc.
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText(sourceFile);

    // Built-in types
    if (typeName === 'string') return { type: 'string' };
    if (typeName === 'number') return { type: 'number' };
    if (typeName === 'boolean') return { type: 'boolean' };
    if (typeName === 'null') return { type: 'null' };
    if (typeName === 'undefined') return { type: 'null' };
    if (typeName === 'void') return { type: 'null' };
    if (typeName === 'any' || typeName === 'unknown') return {};

    // Promise<T> - unwrap
    if (typeName === 'Promise' && typeNode.typeArguments?.[0]) {
      return typeNodeToJsonSchema(typeNode.typeArguments[0], sourceFile);
    }

    // Array<T>
    if (typeName === 'Array' && typeNode.typeArguments?.[0]) {
      return {
        type: 'array',
        items: typeNodeToJsonSchema(typeNode.typeArguments[0], sourceFile),
      };
    }

    // Record<K, V>
    if (typeName === 'Record' && typeNode.typeArguments?.length === 2) {
      return {
        type: 'object',
        additionalProperties: typeNodeToJsonSchema(typeNode.typeArguments[1], sourceFile),
      };
    }

    // Date
    if (typeName === 'Date') {
      return { type: 'string', format: 'date-time' };
    }

    // Custom type reference
    return { $ref: `#/definitions/${typeName}` };
  }

  // Literal types: 'foo', 123, true
  if (ts.isLiteralTypeNode(typeNode)) {
    const literal = typeNode.literal;
    if (ts.isStringLiteral(literal)) {
      return { type: 'string', enum: [literal.text] };
    }
    if (ts.isNumericLiteral(literal)) {
      return { type: 'number', enum: [parseFloat(literal.text)] };
    }
    if (literal.kind === ts.SyntaxKind.TrueKeyword) {
      return { type: 'boolean', enum: [true] };
    }
    if (literal.kind === ts.SyntaxKind.FalseKeyword) {
      return { type: 'boolean', enum: [false] };
    }
    if (literal.kind === ts.SyntaxKind.NullKeyword) {
      return { type: 'null' };
    }
  }

  // String keyword
  if (typeNode.kind === ts.SyntaxKind.StringKeyword) {
    return { type: 'string' };
  }

  // Number keyword
  if (typeNode.kind === ts.SyntaxKind.NumberKeyword) {
    return { type: 'number' };
  }

  // Boolean keyword
  if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) {
    return { type: 'boolean' };
  }

  // Null keyword
  if (typeNode.kind === ts.SyntaxKind.NullKeyword) {
    return { type: 'null' };
  }

  // Undefined keyword
  if (typeNode.kind === ts.SyntaxKind.UndefinedKeyword) {
    return { type: 'null' };
  }

  // Void keyword
  if (typeNode.kind === ts.SyntaxKind.VoidKeyword) {
    return { type: 'null' };
  }

  // Any/unknown keyword
  if (typeNode.kind === ts.SyntaxKind.AnyKeyword || typeNode.kind === ts.SyntaxKind.UnknownKeyword) {
    return {};
  }

  // Array type: T[]
  if (ts.isArrayTypeNode(typeNode)) {
    return {
      type: 'array',
      items: typeNodeToJsonSchema(typeNode.elementType, sourceFile),
    };
  }

  // Tuple type: [string, number]
  if (ts.isTupleTypeNode(typeNode)) {
    return {
      type: 'array',
      items: typeNode.elements.map((el: tsTypes.TypeNode) => typeNodeToJsonSchema(el, sourceFile)),
    };
  }

  // Object literal type: { foo: string, bar: number }
  if (ts.isTypeLiteralNode(typeNode)) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const member of typeNode.members) {
      if (ts.isPropertySignature(member) && member.name) {
        const propName = member.name.getText(sourceFile);
        properties[propName] = typeNodeToJsonSchema(member.type, sourceFile);
        if (!member.questionToken) {
          required.push(propName);
        }
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  // Union type: string | number
  if (ts.isUnionTypeNode(typeNode)) {
    const types = typeNode.types.map(t => typeNodeToJsonSchema(t, sourceFile));

    // Check if it's a simple enum union: 'a' | 'b' | 'c'
    const allLiterals = types.every(t => t.enum && t.enum.length === 1);
    if (allLiterals) {
      const enumValues = types.flatMap(t => t.enum || []);
      const firstType = types[0]?.type;
      if (types.every(t => t.type === firstType)) {
        return { type: firstType, enum: enumValues };
      }
    }

    // Check for nullable: string | null
    const nonNullTypes = types.filter(t => t.type !== 'null');
    const hasNull = types.some(t => t.type === 'null');
    if (hasNull && nonNullTypes.length === 1) {
      return { ...nonNullTypes[0], nullable: true };
    }

    return { oneOf: types };
  }

  // Intersection type: A & B
  if (ts.isIntersectionTypeNode(typeNode)) {
    const types = typeNode.types.map(t => typeNodeToJsonSchema(t, sourceFile));
    return { allOf: types };
  }

  // Fallback
  return { type: 'any' };
}

// ============================================
// JSDOC EXTRACTION
// ============================================

/**
 * Extract JSDoc comment from a node
 */
function getJSDocComment(node: tsTypes.Node, sourceFile: tsTypes.SourceFile): JSDocInfo | null {
  const ts = getLoadedTs();
  // Get leading comment ranges
  const text = sourceFile.getFullText();
  const commentRanges = ts.getLeadingCommentRanges(text, node.getFullStart());

  if (!commentRanges || commentRanges.length === 0) {
    return null;
  }

  // Find JSDoc comment (starts with /**)
  for (const range of commentRanges) {
    const comment = text.slice(range.pos, range.end);
    if (comment.startsWith('/**')) {
      return parseJSDocComment(comment);
    }
  }

  return null;
}

/**
 * Parse a JSDoc comment string into structured info
 */
function parseJSDocComment(comment: string): JSDocInfo {
  // Remove comment markers and normalize
  const lines = comment
    .replace(/^\/\*\*\s*/, '')
    .replace(/\s*\*\/$/, '')
    .split('\n')
    .map(line => line.replace(/^\s*\*\s?/, '').trim());

  const result: JSDocInfo = {
    description: '',
    params: new Map(),
    returns: '',
    examples: [],
    permissions: [],
  };

  let currentSection: 'description' | 'param' | 'returns' | 'example' | 'permission' = 'description';
  let currentParamName = '';
  let currentExample = '';

  for (const line of lines) {
    // @param tag
    const paramMatch = line.match(/^@param\s+(?:\{[^}]+\}\s+)?(\w+)\s*(.*)/);
    if (paramMatch) {
      currentSection = 'param';
      currentParamName = paramMatch[1];
      result.params.set(currentParamName, paramMatch[2] || '');
      continue;
    }

    // @returns or @return tag
    const returnsMatch = line.match(/^@returns?\s+(.*)/);
    if (returnsMatch) {
      currentSection = 'returns';
      result.returns = returnsMatch[1] || '';
      continue;
    }

    // @example tag
    if (line.startsWith('@example')) {
      if (currentExample) {
        result.examples.push(currentExample.trim());
      }
      currentSection = 'example';
      currentExample = line.replace('@example', '').trim();
      continue;
    }

    // @permission tag (custom)
    const permMatch = line.match(/^@permission\s+(.*)/);
    if (permMatch) {
      result.permissions.push(permMatch[1]);
      continue;
    }

    // Skip other tags
    if (line.startsWith('@')) {
      currentSection = 'description';
      continue;
    }

    // Append to current section
    switch (currentSection) {
      case 'description':
        result.description += (result.description ? ' ' : '') + line;
        break;
      case 'param':
        if (currentParamName) {
          const existing = result.params.get(currentParamName) || '';
          result.params.set(currentParamName, existing + ' ' + line);
        }
        break;
      case 'returns':
        result.returns += ' ' + line;
        break;
      case 'example':
        currentExample += '\n' + line;
        break;
    }
  }

  // Save last example
  if (currentExample) {
    result.examples.push(currentExample.trim());
  }

  // Trim all values
  result.description = result.description.trim();
  result.returns = result.returns.trim();
  for (const [key, value] of result.params) {
    result.params.set(key, value.trim());
  }

  return result;
}

// ============================================
// PERMISSION INFERENCE
// ============================================

/**
 * Infer permissions from code patterns
 */
// The in-sandbox SDK is reachable as both `galactic.*` (rebranded, primary) and
// `ultralight.*` (permanent alias). Permission inference must match either.
const SDK = '(?:ultralight|galactic)';

function inferPermissions(code: string): string[] {
  const permissions: string[] = [];

  // Storage operations
  if (new RegExp(`${SDK}\\.(store|batchStore)`).test(code)) {
    permissions.push('storage:write');
  }
  if (new RegExp(`${SDK}\\.(load|list|query|batchLoad)`).test(code)) {
    permissions.push('storage:read');
  }
  if (new RegExp(`${SDK}\\.(remove|batchRemove)`).test(code)) {
    permissions.push('storage:delete');
  }

  // Memory operations
  if (new RegExp(`${SDK}\\.remember`).test(code)) {
    permissions.push('memory:write');
  }
  if (new RegExp(`${SDK}\\.recall`).test(code)) {
    permissions.push('memory:read');
  }

  // AI operations
  if (new RegExp(`${SDK}\\.ai`).test(code)) {
    permissions.push('ai:call');
  }
  if (new RegExp(`${SDK}\\.embed`).test(code)) {
    permissions.push('ai:embed');
  }

  // Galactic Compute is one strict capability. Starting, polling, and
  // cancelling all require the same server-enforced permission.
  if (
    new RegExp(`${SDK}\\.compute\\b`).test(code) ||
    new RegExp(
      `(?:const|let|var)\\s*\\{[^}]*\\bcompute\\b[^}]*\\}\\s*=\\s*${SDK}\\b`,
    ).test(code)
  ) {
    permissions.push(COMPUTE_EXEC_PERMISSION);
  }

  // Network operations
  if (/\bfetch\s*\(/.test(code)) {
    permissions.push('net:fetch');
  }

  return [...new Set(permissions)];
}

/**
 * Per-function inference detection (Free Mode signal — docs/FREE_MODE_DESIGN.md).
 *
 * Builds a call graph over the entry file's AST and marks each function that
 * transitively reaches galactic.ai()/embed() or ultralight.ai()/embed(). Conservative by design:
 * when inference is present but can't be attributed precisely — multi-file
 * helpers (relative imports), a destructured `ai` binding, module-scope ai, or
 * an unresolved callee — every function is marked true (fail-safe toward
 * blocking). Apps with no inference at all yield all-false (no over-blocking).
 */
function analyzeInferenceUsage(
  ts: TSModule,
  sourceFile: tsTypes.SourceFile,
  code: string,
): { hasAi: boolean; allInference: boolean; byFunction: Map<string, boolean> } {
  if (!new RegExp(`${SDK}\\.(?:ai|embed)\\s*\\(`).test(code)) {
    return { hasAi: false, allInference: false, byFunction: new Map() };
  }

  // Collect every named function-like (exported or local helper): name -> body.
  const bodies = new Map<string, tsTypes.Node>();
  const addBody = (name: string | undefined, body: tsTypes.Node | undefined) => {
    if (name && body) bodies.set(name, body);
  };
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      addBody(stmt.name.text, stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) && decl.initializer &&
          (ts.isArrowFunction(decl.initializer) ||
            ts.isFunctionExpression(decl.initializer))
        ) {
          addBody(decl.name.text, decl.initializer.body);
        }
      }
    }
  }
  const known = new Set(bodies.keys());

  const isAiCall = (node: tsTypes.Node): boolean =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    (node.expression.name.text === 'ai' ||
      node.expression.name.text === 'embed') &&
    ts.isIdentifier(node.expression.expression) &&
    (node.expression.expression.text === 'ultralight' ||
      node.expression.expression.text === 'galactic');

  const directAi = new Set<string>();
  const edges = new Map<string, Set<string>>();
  for (const [name, body] of bodies) {
    const callees = new Set<string>();
    const walk = (node: tsTypes.Node) => {
      if (isAiCall(node)) directAi.add(name);
      if (
        ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        known.has(node.expression.text)
      ) {
        callees.add(node.expression.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(body);
    edges.set(name, callees);
  }

  // Transitive reachability with a cycle guard.
  const reaches = new Map<string, boolean>();
  const resolve = (name: string, stack: Set<string>): boolean => {
    const cached = reaches.get(name);
    if (cached !== undefined) return cached;
    if (stack.has(name)) return false;
    stack.add(name);
    let r = directAi.has(name);
    if (!r) {
      for (const callee of edges.get(name) ?? []) {
        if (resolve(callee, stack)) {
          r = true;
          break;
        }
      }
    }
    stack.delete(name);
    reaches.set(name, r);
    return r;
  };
  for (const name of bodies.keys()) resolve(name, new Set());

  const multiFile = /\bfrom\s+['"]\.\.?\//.test(code);
  const destructuredAi = new RegExp(
    `(?:const|let|var)\\s*\\{[^}]*\\bai\\b[^}]*\\}\\s*=\\s*${SDK}\\b`,
  ).test(code);
  const anyAttributed = [...reaches.values()].some(Boolean);
  const allInference = multiFile || destructuredAi || !anyAttributed;

  return { hasAi: true, allInference, byFunction: reaches };
}

/**
 * Per-function compute-start detection. Mirrors inference's conservative call
 * graph without changing its established behavior. Status/cancel calls require
 * compute:exec but do not mark uses_compute because they do not start a body.
 */
function analyzeComputeUsage(
  ts: TSModule,
  sourceFile: tsTypes.SourceFile,
  code: string,
): {
  hasCompute: boolean;
  allCompute: boolean;
  byFunction: Map<string, boolean>;
} {
  const directCompute = new RegExp(`${SDK}\\.compute\\s*\\(`).test(code);
  const destructuredCompute = new RegExp(
    `(?:const|let|var)\\s*\\{[^}]*\\bcompute\\b[^}]*\\}\\s*=\\s*${SDK}\\b`,
  ).test(code);
  const aliasedCompute = new RegExp(
    `(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*=\\s*${SDK}\\.compute\\b`,
  ).test(code);
  if (!directCompute && !destructuredCompute && !aliasedCompute) {
    return { hasCompute: false, allCompute: false, byFunction: new Map() };
  }

  const bodies = new Map<string, tsTypes.Node>();
  const addBody = (name: string | undefined, body: tsTypes.Node | undefined) => {
    if (name && body) bodies.set(name, body);
  };
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      addBody(stmt.name.text, stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) && decl.initializer &&
          (ts.isArrowFunction(decl.initializer) ||
            ts.isFunctionExpression(decl.initializer))
        ) {
          addBody(decl.name.text, decl.initializer.body);
        }
      }
    }
  }
  const known = new Set(bodies.keys());

  const isComputeStart = (node: tsTypes.Node): boolean =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'compute' &&
    ts.isIdentifier(node.expression.expression) &&
    (node.expression.expression.text === 'ultralight' ||
      node.expression.expression.text === 'galactic');

  const directStarts = new Set<string>();
  const edges = new Map<string, Set<string>>();
  for (const [name, body] of bodies) {
    const callees = new Set<string>();
    const walk = (node: tsTypes.Node) => {
      if (isComputeStart(node)) directStarts.add(name);
      if (
        ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        known.has(node.expression.text)
      ) {
        callees.add(node.expression.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(body);
    edges.set(name, callees);
  }

  const reaches = new Map<string, boolean>();
  const resolve = (name: string, stack: Set<string>): boolean => {
    const cached = reaches.get(name);
    if (cached !== undefined) return cached;
    if (stack.has(name)) return false;
    stack.add(name);
    let result = directStarts.has(name);
    if (!result) {
      for (const callee of edges.get(name) ?? []) {
        if (resolve(callee, stack)) {
          result = true;
          break;
        }
      }
    }
    stack.delete(name);
    reaches.set(name, result);
    return result;
  };
  for (const name of bodies.keys()) resolve(name, new Set());

  const multiFile = /\bfrom\s+['"]\.\.?\//.test(code);
  const anyAttributed = [...reaches.values()].some(Boolean);
  return {
    hasCompute: true,
    allCompute: multiFile || destructuredCompute || aliasedCompute ||
      !anyAttributed,
    byFunction: reaches,
  };
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Convert ParseResult to ParsedSkills format (for database storage)
 */
export function toSkillsParsed(result: ParseResult): ParsedSkills {
  return {
    functions: result.functions.map(fn => ({
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters.reduce((acc, p) => {
        acc[p.name] = p.schema;
        if (p.description) {
          (acc[p.name] as JsonSchema).description = p.description;
        }
        return acc;
      }, {} as Record<string, unknown>),
      returns: fn.returns.schema,
      examples: fn.examples,
    })),
    permissions: result.permissions.map(p => ({
      permission: p,
      required: true,
    })),
    description: result.description,
  };
}

/**
 * Convert ParsedSkills back to ParseResult (for round-trip from markdown)
 */
export function fromSkillsParsed(skills: ParsedSkills): ParseResult {
  return {
    functions: skills.functions.map(fn => ({
      name: fn.name,
      description: fn.description,
      parameters: Object.entries(fn.parameters as Record<string, JsonSchema>).map(([name, schema]) => ({
        name,
        type: schemaToTypeString(schema),
        description: schema.description || '',
        required: true, // Assume required when parsing from skills
        schema,
      })),
      returns: {
        type: schemaToTypeString(fn.returns as JsonSchema),
        description: '',
        schema: fn.returns as JsonSchema,
      },
      isAsync: false, // Can't determine from skills
      examples: fn.examples || [],
      permissions: [],
    })),
    types: {},
    permissions: skills.permissions.map(p => p.permission),
    description: skills.description,
    parseErrors: [],
    parseWarnings: [],
  };
}

/**
 * Convert JSON Schema to TypeScript type string (for display)
 */
function schemaToTypeString(schema: JsonSchema): string {
  if (!schema) return 'unknown';

  if (schema.$ref) {
    return schema.$ref.replace('#/definitions/', '');
  }

  if (schema.oneOf) {
    return (schema.oneOf as JsonSchema[]).map(s => schemaToTypeString(s)).join(' | ');
  }

  if (schema.allOf) {
    return (schema.allOf as JsonSchema[]).map(s => schemaToTypeString(s)).join(' & ');
  }

  if (schema.enum && schema.enum.length === 1) {
    return JSON.stringify(schema.enum[0]);
  }

  if (schema.type === 'array') {
    if (schema.items) {
      if (Array.isArray(schema.items)) {
        return `[${schema.items.map(i => schemaToTypeString(i)).join(', ')}]`;
      }
      return `${schemaToTypeString(schema.items)}[]`;
    }
    return 'unknown[]';
  }

  if (schema.type === 'object') {
    if (schema.properties) {
      const props = Object.entries(schema.properties)
        .map(([k, v]) => `${k}: ${schemaToTypeString(v as JsonSchema)}`)
        .join('; ');
      return `{ ${props} }`;
    }
    if (schema.additionalProperties) {
      return `Record<string, ${schemaToTypeString(schema.additionalProperties as JsonSchema)}>`;
    }
    return 'object';
  }

  if (schema.type) {
    return schema.type as string;
  }

  return 'unknown';
}
