import type {
  AIOutputSchema,
  AIResponse,
  AIStructuredOutputErrorCode,
} from '../../shared/contracts/ai.ts';

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_DEPTH = 64;
const MAX_VALIDATION_STEPS = 50_000;
// Canonical JSON is used for const/enum/uniqueItems equality. A step limit
// alone is insufficient: one large output compared across many composition
// branches can otherwise trigger gigabytes of repeated serialization. Cache
// each value and cap the cumulative bytes canonicalized in one validation.
const MAX_CANONICALIZATION_BYTES = 16 * 1024 * 1024;
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const STRUCTURED_OUTPUT_PROVIDER_STATUSES = new Set([400, 404, 415, 422]);
const STRUCTURED_OUTPUT_PROVIDER_DETAIL =
  /(?:response[\s_-]*format|json[\s_-]*schema|structured[\s_-]*outputs?)/i;

const JSON_SCHEMA_TYPES = new Set([
  'null',
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
]);

/**
 * Galactic intentionally implements a bounded JSON Schema subset. Every
 * accepted assertion keyword is enforced locally; anything else is rejected
 * before a provider call instead of being silently ignored.
 */
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$anchor',
  '$comment',
  '$defs',
  'definitions',
  '$ref',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'type',
  'const',
  'enum',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'prefixItems',
  'items',
  'minProperties',
  'maxProperties',
  'required',
  'properties',
  'additionalProperties',
]);

export class StructuredOutputError extends Error {
  constructor(
    public readonly code: AIStructuredOutputErrorCode,
    message: string,
    public readonly path = '$',
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

class ValidationLimitError extends StructuredOutputError {
  constructor(message: string, path: string) {
    super('structured_output_schema_mismatch', message, path);
    this.name = 'ValidationLimitError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'undefined';
}

function schemaError(message: string, path = '$'): never {
  throw new StructuredOutputError('invalid_output_schema', message, path);
}

function outputJsonError(message: string, path = '$'): never {
  throw new StructuredOutputError(
    'structured_output_invalid_json',
    message,
    path,
  );
}

interface JsonTraversalFrame {
  value: unknown;
  depth: number;
  path: string;
  exiting?: boolean;
}

/**
 * Reject values JSON cannot faithfully represent and bound depth without
 * recursive traversal. The active set detects cycles while still allowing a
 * shared object to appear in multiple independent branches.
 */
function assertJsonValue(
  value: unknown,
  maxDepth: number,
  error: (message: string, path?: string) => never,
  visit?: (path: string) => void,
): void {
  const active = new Set<object>();
  const stack: JsonTraversalFrame[] = [{ value, depth: 0, path: '$' }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exiting) {
      active.delete(frame.value as object);
      continue;
    }

    visit?.(frame.path);
    if (frame.depth > maxDepth) {
      error(`Value exceeds the maximum depth of ${maxDepth}`, frame.path);
    }

    const current = frame.value;
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean'
    ) {
      continue;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        error('Value contains a non-finite number', frame.path);
      }
      continue;
    }
    if (
      typeof current === 'undefined' ||
      typeof current === 'bigint' ||
      typeof current === 'function' ||
      typeof current === 'symbol'
    ) {
      error(`Value contains a non-JSON ${typeof current}`, frame.path);
    }
    if (!Array.isArray(current) && !isPlainRecord(current)) {
      error('Value contains a non-JSON object', frame.path);
    }
    if (active.has(current as object)) {
      error('Value contains a cyclic object reference', frame.path);
    }

    active.add(current as object);
    stack.push({ ...frame, exiting: true });
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--) {
        stack.push({
          value: current[index],
          depth: frame.depth + 1,
          path: `${frame.path}[${index}]`,
        });
      }
    } else {
      const entries = Object.entries(current as Record<string, unknown>);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, child] = entries[index];
        stack.push({
          value: child,
          depth: frame.depth + 1,
          path: `${frame.path}[${JSON.stringify(key)}]`,
        });
      }
    }
  }
}

function jsonBytes(
  value: unknown,
  error: (message: string, path?: string) => never,
): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    error('Value cannot be serialized as JSON');
  }
  if (serialized === undefined) {
    error('Value cannot be serialized as JSON');
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function decodePointerPart(part: string, ref: string): string {
  if (/~(?:[^01]|$)/.test(part)) {
    schemaError(`Invalid JSON Schema reference: ${ref}`);
  }
  return part.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveRef(
  root: Record<string, unknown> | boolean,
  ref: string,
): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) {
    schemaError(`Only local JSON Schema references are supported: ${ref}`);
  }

  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    schemaError(`Invalid JSON Schema reference: ${ref}`);
  }

  let current: unknown = root;
  for (const rawPart of pointer.slice(1).split('/')) {
    const part = decodePointerPart(rawPart, ref);
    if (Array.isArray(current)) {
      if (
        !/^(?:0|[1-9]\d*)$/.test(part) ||
        !Object.hasOwn(current, Number(part))
      ) {
        schemaError(`Unresolvable JSON Schema reference: ${ref}`);
      }
      current = current[Number(part)];
    } else if (isPlainRecord(current) && Object.hasOwn(current, part)) {
      current = current[part];
    } else {
      schemaError(`Unresolvable JSON Schema reference: ${ref}`);
    }
  }
  return current;
}

function assertStringKeyword(
  schema: Record<string, unknown>,
  keyword: string,
  path: string,
): void {
  if (
    Object.hasOwn(schema, keyword) && typeof schema[keyword] !== 'string'
  ) {
    schemaError(`${keyword} must be a string`, path);
  }
}

function assertBooleanKeyword(
  schema: Record<string, unknown>,
  keyword: string,
  path: string,
): void {
  if (
    Object.hasOwn(schema, keyword) && typeof schema[keyword] !== 'boolean'
  ) {
    schemaError(`${keyword} must be a boolean`, path);
  }
}

function assertNonNegativeIntegerKeyword(
  schema: Record<string, unknown>,
  keyword: string,
  path: string,
): void {
  if (
    Object.hasOwn(schema, keyword) &&
    (!Number.isSafeInteger(schema[keyword]) ||
      (schema[keyword] as number) < 0)
  ) {
    schemaError(`${keyword} must be a non-negative safe integer`, path);
  }
}

function assertFiniteNumberKeyword(
  schema: Record<string, unknown>,
  keyword: string,
  path: string,
): void {
  if (
    Object.hasOwn(schema, keyword) &&
    (typeof schema[keyword] !== 'number' ||
      !Number.isFinite(schema[keyword]))
  ) {
    schemaError(`${keyword} must be a finite number`, path);
  }
}

interface SchemaAdmissionState {
  root: Record<string, unknown> | boolean;
  visiting: Set<Record<string, unknown>>;
  complete: Set<Record<string, unknown>>;
}

function assertSchemaArray(
  value: unknown,
  keyword: string,
  path: string,
  state: SchemaAdmissionState,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    schemaError(`${keyword} must be a non-empty array of schemas`, path);
  }
  value.forEach((child, index) => assertSchemaNode(child, `${path}.${keyword}[${index}]`, state));
}

function assertSchemaMap(
  value: unknown,
  keyword: string,
  path: string,
  state: SchemaAdmissionState,
): void {
  if (!isPlainRecord(value)) {
    schemaError(`${keyword} must be an object of schemas`, path);
  }
  for (const [key, child] of Object.entries(value)) {
    assertSchemaNode(
      child,
      `${path}.${keyword}[${JSON.stringify(key)}]`,
      state,
    );
  }
}

function assertSchemaNode(
  value: unknown,
  path: string,
  state: SchemaAdmissionState,
): void {
  if (typeof value === 'boolean') return;
  if (!isPlainRecord(value)) {
    schemaError('JSON Schema nodes must be objects or booleans', path);
  }
  if (state.complete.has(value)) return;
  if (state.visiting.has(value)) {
    schemaError('Cyclic JSON Schema references are not supported', path);
  }
  state.visiting.add(value);

  try {
    for (const keyword of Object.keys(value)) {
      if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
        schemaError(
          `Unsupported JSON Schema keyword "${keyword}"`,
          `${path}.${keyword}`,
        );
      }
    }

    for (
      const keyword of [
        '$schema',
        '$id',
        '$anchor',
        '$comment',
        'title',
        'description',
      ]
    ) {
      assertStringKeyword(value, keyword, path);
    }
    for (const keyword of ['deprecated', 'readOnly', 'writeOnly']) {
      assertBooleanKeyword(value, keyword, path);
    }
    if (
      Object.hasOwn(value, 'examples') && !Array.isArray(value.examples)
    ) {
      schemaError('examples must be an array', path);
    }

    if (Object.hasOwn(value, 'type')) {
      const declared = typeof value.type === 'string'
        ? [value.type]
        : Array.isArray(value.type)
        ? value.type
        : null;
      if (
        !declared ||
        declared.length === 0 ||
        declared.some((type) => typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type)) ||
        new Set(declared).size !== declared.length
      ) {
        schemaError(
          'type must be a supported type or a non-empty array of unique supported types',
          path,
        );
      }
    }
    if (
      Object.hasOwn(value, 'enum') &&
      (!Array.isArray(value.enum) || value.enum.length === 0)
    ) {
      schemaError('enum must be a non-empty array', path);
    }
    if (
      Array.isArray(value.enum) &&
      new Set(value.enum.map(canonicalJson)).size !== value.enum.length
    ) {
      schemaError('enum values must be unique', path);
    }

    for (
      const keyword of [
        'minLength',
        'maxLength',
        'minItems',
        'maxItems',
        'minProperties',
        'maxProperties',
      ]
    ) {
      assertNonNegativeIntegerKeyword(value, keyword, path);
    }
    for (
      const keyword of [
        'minimum',
        'maximum',
        'exclusiveMinimum',
        'exclusiveMaximum',
        'multipleOf',
      ]
    ) {
      assertFiniteNumberKeyword(value, keyword, path);
    }
    if (
      Object.hasOwn(value, 'multipleOf') &&
      (value.multipleOf as number) <= 0
    ) {
      schemaError('multipleOf must be greater than zero', path);
    }
    for (
      const [minimum, maximum] of [
        ['minLength', 'maxLength'],
        ['minItems', 'maxItems'],
        ['minProperties', 'maxProperties'],
      ] as const
    ) {
      if (
        typeof value[minimum] === 'number' &&
        typeof value[maximum] === 'number' &&
        value[minimum] > value[maximum]
      ) {
        schemaError(`${minimum} cannot exceed ${maximum}`, path);
      }
    }
    assertBooleanKeyword(value, 'uniqueItems', path);

    if (Object.hasOwn(value, 'required')) {
      if (
        !Array.isArray(value.required) ||
        value.required.some((key) => typeof key !== 'string') ||
        new Set(value.required).size !== value.required.length
      ) {
        schemaError('required must be an array of unique strings', path);
      }
    }

    if (Object.hasOwn(value, '$ref')) {
      if (typeof value.$ref !== 'string') {
        schemaError('$ref must be a string', path);
      }
      assertSchemaNode(
        resolveRef(state.root, value.$ref),
        `${path}.$ref(${value.$ref})`,
        state,
      );
    }
    if (Object.hasOwn(value, '$defs')) {
      assertSchemaMap(value.$defs, '$defs', path, state);
    }
    if (Object.hasOwn(value, 'definitions')) {
      assertSchemaMap(value.definitions, 'definitions', path, state);
    }
    if (Object.hasOwn(value, 'properties')) {
      assertSchemaMap(value.properties, 'properties', path, state);
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      if (Object.hasOwn(value, keyword)) {
        assertSchemaArray(value[keyword], keyword, path, state);
      }
    }
    if (Object.hasOwn(value, 'prefixItems')) {
      if (!Array.isArray(value.prefixItems)) {
        schemaError('prefixItems must be an array of schemas', path);
      }
      value.prefixItems.forEach((child, index) =>
        assertSchemaNode(child, `${path}.prefixItems[${index}]`, state)
      );
    }
    for (const keyword of ['not', 'items', 'additionalProperties']) {
      if (Object.hasOwn(value, keyword)) {
        assertSchemaNode(value[keyword], `${path}.${keyword}`, state);
      }
    }
  } finally {
    state.visiting.delete(value);
  }
  state.complete.add(value);
}

function assertSupportedSchema(
  schema: Record<string, unknown> | boolean,
): void {
  const state: SchemaAdmissionState = {
    root: schema,
    visiting: new Set(),
    complete: new Set(),
  };
  assertSchemaNode(schema, '$', state);
}

export function normalizeOutputSchema(
  value: AIOutputSchema,
): Required<AIOutputSchema> {
  if (!isPlainRecord(value)) {
    schemaError('output_schema must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!['name', 'schema', 'strict'].includes(key)) {
      schemaError(`Unsupported output_schema field "${key}"`);
    }
  }

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!SCHEMA_NAME.test(name)) {
    schemaError(
      'output_schema.name must begin with a letter or underscore and contain at most 64 letters, numbers, underscores, or hyphens',
    );
  }
  if (!isPlainRecord(value.schema) && typeof value.schema !== 'boolean') {
    schemaError('output_schema.schema must be a JSON Schema object or boolean');
  }
  const strict = (value as { strict?: unknown }).strict;
  if (strict !== undefined && strict !== true) {
    schemaError(
      'Galactic structured output is always strict; omit strict or set it to true',
    );
  }

  assertJsonValue(value.schema, MAX_SCHEMA_DEPTH, schemaError);
  if (jsonBytes(value.schema, schemaError) > MAX_SCHEMA_BYTES) {
    schemaError(`output_schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  }
  assertSupportedSchema(value.schema);
  return { name, schema: value.schema, strict: true };
}

export function structuredOutputResponseFormat(
  value: AIOutputSchema,
): Record<string, unknown> {
  const normalized = normalizeOutputSchema(value);
  return {
    type: 'json_schema',
    json_schema: {
      name: normalized.name,
      schema: normalized.schema,
      strict: true,
    },
  };
}

function typeMatches(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'null':
      return value === null;
    case 'object':
      return isPlainRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

function schemaFailure(message: string, path: string): never {
  throw new StructuredOutputError(
    'structured_output_schema_mismatch',
    `${message} at ${path}`,
    path,
  );
}

interface ValidationState {
  steps: number;
  canonicalBytes: number;
  canonicalCache: Map<unknown, string>;
  constCache: WeakMap<Record<string, unknown>, string>;
  enumCache: WeakMap<Record<string, unknown>, Set<string>>;
}

function incrementValidationStep(state: ValidationState, path: string): void {
  state.steps += 1;
  if (state.steps > MAX_VALIDATION_STEPS) {
    throw new ValidationLimitError(
      `Structured output validation exceeds ${MAX_VALIDATION_STEPS} steps`,
      path,
    );
  }
}

function canonicalJsonForValidation(
  value: unknown,
  state: ValidationState,
  path: string,
): string {
  const cached = state.canonicalCache.get(value);
  if (cached !== undefined) return cached;

  const serialized = canonicalJson(value);
  state.canonicalBytes += new TextEncoder().encode(serialized).byteLength;
  if (state.canonicalBytes > MAX_CANONICALIZATION_BYTES) {
    throw new ValidationLimitError(
      `Structured output validation exceeds ${MAX_CANONICALIZATION_BYTES} canonical bytes`,
      path,
    );
  }
  state.canonicalCache.set(value, serialized);
  return serialized;
}

function isCandidateMismatch(error: unknown): boolean {
  return error instanceof StructuredOutputError &&
    !(error instanceof ValidationLimitError) &&
    error.code === 'structured_output_schema_mismatch';
}

function validateValue(
  value: unknown,
  schema: unknown,
  root: Record<string, unknown> | boolean,
  path: string,
  state: ValidationState,
): void {
  incrementValidationStep(state, path);
  if (schema === true) return;
  if (schema === false) schemaFailure('Value is forbidden by schema', path);
  if (!isPlainRecord(schema)) {
    schemaError(`Invalid JSON Schema node used at ${path}`, path);
  }

  if (typeof schema.$ref === 'string') {
    validateValue(value, resolveRef(root, schema.$ref), root, path, state);
  }
  if (Object.hasOwn(schema, 'const')) {
    let expected = state.constCache.get(schema);
    if (expected === undefined) {
      expected = canonicalJsonForValidation(schema.const, state, path);
      state.constCache.set(schema, expected);
    }
    if (canonicalJsonForValidation(value, state, path) !== expected) {
      schemaFailure('Value does not match const', path);
    }
  }
  if (Array.isArray(schema.enum)) {
    let allowed = state.enumCache.get(schema);
    if (!allowed) {
      allowed = new Set(
        schema.enum.map((item) => canonicalJsonForValidation(item, state, path)),
      );
      state.enumCache.set(schema, allowed);
    }
    if (!allowed.has(canonicalJsonForValidation(value, state, path))) {
      schemaFailure('Value is not in enum', path);
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const candidate of schema.allOf) {
      validateValue(value, candidate, root, path, state);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    let valid = false;
    for (const candidate of schema.anyOf) {
      try {
        validateValue(value, candidate, root, path, state);
        valid = true;
        break;
      } catch (error) {
        if (!isCandidateMismatch(error)) throw error;
      }
    }
    if (!valid) schemaFailure('Value does not match anyOf', path);
  }
  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const candidate of schema.oneOf) {
      try {
        validateValue(value, candidate, root, path, state);
        matches += 1;
      } catch (error) {
        if (!isCandidateMismatch(error)) throw error;
      }
    }
    if (matches !== 1) {
      schemaFailure('Value does not match exactly one oneOf', path);
    }
  }
  if (Object.hasOwn(schema, 'not')) {
    let matched = false;
    try {
      validateValue(value, schema.not, root, path, state);
      matched = true;
    } catch (error) {
      if (!isCandidateMismatch(error)) throw error;
    }
    if (matched) schemaFailure('Value matches forbidden not schema', path);
  }

  const declaredTypes = typeof schema.type === 'string'
    ? [schema.type]
    : Array.isArray(schema.type)
    ? schema.type as string[]
    : [];
  if (
    declaredTypes.length > 0 &&
    !declaredTypes.some((expected) => typeMatches(value, expected))
  ) {
    schemaFailure(`Expected ${declaredTypes.join(' or ')}`, path);
  }

  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      schemaFailure(`String is shorter than ${schema.minLength}`, path);
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      schemaFailure(`String is longer than ${schema.maxLength}`, path);
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      schemaFailure(`Number is below minimum ${schema.minimum}`, path);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      schemaFailure(`Number is above maximum ${schema.maximum}`, path);
    }
    if (
      typeof schema.exclusiveMinimum === 'number' &&
      value <= schema.exclusiveMinimum
    ) {
      schemaFailure(`Number must exceed ${schema.exclusiveMinimum}`, path);
    }
    if (
      typeof schema.exclusiveMaximum === 'number' &&
      value >= schema.exclusiveMaximum
    ) {
      schemaFailure(`Number must be below ${schema.exclusiveMaximum}`, path);
    }
    if (
      typeof schema.multipleOf === 'number' &&
      Math.abs(
          value / schema.multipleOf - Math.round(value / schema.multipleOf),
        ) >
        Number.EPSILON * 10
    ) {
      schemaFailure(`Number is not a multiple of ${schema.multipleOf}`, path);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      schemaFailure(`Array has fewer than ${schema.minItems} items`, path);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      schemaFailure(`Array has more than ${schema.maxItems} items`, path);
    }
    if (
      schema.uniqueItems === true &&
      new Set(
          value.map((item, index) => canonicalJsonForValidation(item, state, `${path}[${index}]`)),
        ).size !== value.length
    ) {
      schemaFailure('Array items are not unique', path);
    }
    if (Array.isArray(schema.prefixItems)) {
      for (let index = 0; index < schema.prefixItems.length; index++) {
        if (index < value.length) {
          validateValue(
            value[index],
            schema.prefixItems[index],
            root,
            `${path}[${index}]`,
            state,
          );
        }
      }
    }
    if (Object.hasOwn(schema, 'items')) {
      const start = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
      for (let index = start; index < value.length; index++) {
        validateValue(
          value[index],
          schema.items,
          root,
          `${path}[${index}]`,
          state,
        );
      }
    }
  }

  if (isPlainRecord(value)) {
    const keys = Object.keys(value);
    if (
      typeof schema.minProperties === 'number' &&
      keys.length < schema.minProperties
    ) {
      schemaFailure(
        `Object has fewer than ${schema.minProperties} properties`,
        path,
      );
    }
    if (
      typeof schema.maxProperties === 'number' &&
      keys.length > schema.maxProperties
    ) {
      schemaFailure(
        `Object has more than ${schema.maxProperties} properties`,
        path,
      );
    }
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) {
        schemaFailure(`Missing required property "${key}"`, path);
      }
    }
    const properties = isPlainRecord(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        validateValue(
          child,
          properties[key],
          root,
          `${path}[${JSON.stringify(key)}]`,
          state,
        );
      } else if (schema.additionalProperties === false) {
        schemaFailure(`Unexpected property "${key}"`, path);
      } else if (
        isPlainRecord(schema.additionalProperties) ||
        typeof schema.additionalProperties === 'boolean'
      ) {
        validateValue(
          child,
          schema.additionalProperties,
          root,
          `${path}[${JSON.stringify(key)}]`,
          state,
        );
      }
    }
  }
}

function assertOutputValue(value: unknown, state: ValidationState): number {
  assertJsonValue(
    value,
    MAX_OUTPUT_DEPTH,
    outputJsonError,
    (path) => incrementValidationStep(state, path),
  );
  return jsonBytes(value, outputJsonError);
}

export function parseStructuredOutput(
  content: string,
  schema: AIOutputSchema,
  providerParsed?: unknown,
): unknown {
  const normalized = normalizeOutputSchema(schema);
  let output = providerParsed;

  if (output === undefined) {
    if (new TextEncoder().encode(content).byteLength > MAX_OUTPUT_BYTES) {
      outputJsonError(`Structured output exceeds ${MAX_OUTPUT_BYTES} bytes`);
    }
    try {
      output = JSON.parse(content);
    } catch {
      outputJsonError('Provider returned invalid JSON for structured output');
    }
  }

  const validationState: ValidationState = {
    steps: 0,
    canonicalBytes: 0,
    canonicalCache: new Map(),
    constCache: new WeakMap(),
    enumCache: new WeakMap(),
  };
  if (assertOutputValue(output, validationState) > MAX_OUTPUT_BYTES) {
    outputJsonError(`Structured output exceeds ${MAX_OUTPUT_BYTES} bytes`);
  }
  validateValue(
    output,
    normalized.schema,
    normalized.schema,
    '$',
    validationState,
  );
  return output;
}

export function applyStructuredOutput(
  response: AIResponse,
  schema?: AIOutputSchema,
): AIResponse {
  if (!schema) {
    const { output: _unvalidated, ...withoutOutput } = response;
    return withoutOutput;
  }
  if (response.error) return { ...response, output: undefined };

  try {
    return {
      ...response,
      output: parseStructuredOutput(response.content, schema, response.output),
    };
  } catch (error) {
    const structured = error instanceof StructuredOutputError ? error : new StructuredOutputError(
      'structured_output_schema_mismatch',
      error instanceof Error ? error.message : String(error),
    );
    return {
      ...response,
      output: undefined,
      error: structured.message,
      error_code: structured.code,
    };
  }
}

function providerErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Providers use many error shapes. Only map the narrow native-structured-
 * output rejection statuses when their details actually name that feature.
 */
export function isStructuredOutputUnsupportedProviderError(
  error: unknown,
  status?: number,
): boolean {
  const inferredStatus = status ??
    (isRecord(error) && typeof error.status === 'number' ? error.status : undefined);
  return inferredStatus !== undefined &&
    STRUCTURED_OUTPUT_PROVIDER_STATUSES.has(inferredStatus) &&
    STRUCTURED_OUTPUT_PROVIDER_DETAIL.test(providerErrorText(error));
}

export function structuredOutputErrorResponse(
  model: string,
  error: unknown,
  usage: AIResponse['usage'] = {
    input_tokens: 0,
    output_tokens: 0,
    cost_light: 0,
  },
): AIResponse {
  const structured = error instanceof StructuredOutputError ? error : new StructuredOutputError(
    'structured_output_unsupported',
    error instanceof Error ? error.message : String(error),
  );
  return {
    content: '',
    model,
    usage,
    error: structured.message,
    error_code: structured.code,
  };
}
