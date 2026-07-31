// gx.test D1 fixtures — Phase 5 (structured, scoped data API).
//
// The runtime db surface is now structured (galactic.db.select/insert/update/...
// — no raw SQL), so fixtures match on the STRUCTURED OP, not on SQL text.
//
// A fixture pins a method (+ optional table + optional `when` subset of the op)
// to a canned `result`. First matching fixture wins, so put specific fixtures
// (with `when`) before catch-alls.

export type D1FixtureMethod =
  | "select"
  | "first"
  | "count"
  | "insert"
  | "update"
  | "delete"
  | "upsert"
  | "batch";

const FIXTURE_METHODS: ReadonlySet<string> = new Set([
  "select",
  "first",
  "count",
  "insert",
  "update",
  "delete",
  "upsert",
  "batch",
]);

export interface D1FixtureResponse {
  method: D1FixtureMethod;
  // Table the op targets. Omit to match any table for that method (e.g. batch).
  table?: string;
  // Optional deep-subset match against the op: every key here must deep-equal
  // the same key in the actual op.
  when?: Record<string, unknown>;
  // Canned result: rows[] for select, a row|null for first, a number for count,
  // { meta?, id? } for writes, or an array of those for batch.
  result?: unknown;
  [extension: `x-${string}`]: unknown;
}

export interface D1TestFixtureConfig {
  responses: D1FixtureResponse[];
  [extension: `x-${string}`]: unknown;
}

export interface D1TestFixtureResolutionOptions {
  /**
   * Reject misspelled/unrecognized request fields. Legacy gx.test fixture
   * payloads remain permissive; galactic.yaml opts into this closed schema.
   */
  strictUnknownKeys?: boolean;
}

interface D1FixtureRequest {
  method: D1FixtureMethod;
  table?: string;
  op: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const CONFIG_KEYS = new Set(["responses"]);
const RESPONSE_KEYS = new Set(["method", "table", "when", "result"]);
const SELECT_KEYS = new Set([
  "table",
  "columns",
  "where",
  "joins",
  "groupBy",
  "having",
  "orderBy",
  "limit",
  "offset",
]);
const COUNT_KEYS = new Set([
  "table",
  "where",
  "joins",
  "column",
  "distinct",
]);
const INSERT_KEYS = new Set(["table", "values"]);
const UPDATE_KEYS = new Set(["table", "set", "where"]);
const DELETE_KEYS = new Set(["table", "where"]);
const UPSERT_KEYS = new Set(["table", "values", "onConflict", "set"]);
const BATCH_KEYS = new Set(["ops"]);
const COLUMN_KEYS = new Set(["table", "column", "fn", "as", "distinct"]);
const JOIN_KEYS = new Set(["table", "as", "type", "on"]);
const JOIN_ON_KEYS = new Set([
  "from",
  "fromColumn",
  "column",
  "foreignColumn",
]);
const ORDER_KEYS = new Set(["column", "as", "dir"]);
const UPDATE_EXPRESSION_KEYS = new Set(["op", "value"]);
const WHERE_CONDITION_KEYS = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "in",
  "notIn",
  "isNull",
]);
const BATCH_METHOD_KEYS: Record<string, ReadonlySet<string>> = {
  insert: new Set(["op", ...INSERT_KEYS]),
  update: new Set(["op", ...UPDATE_KEYS]),
  delete: new Set(["op", ...DELETE_KEYS]),
  upsert: new Set(["op", ...UPSERT_KEYS]),
};

function isExtensionKey(key: string): boolean {
  return key.startsWith("x-") && key.length > 2;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) && !isExtensionKey(key)) {
      throw new Error(`${path}.${key} is not supported`);
    }
  }
}

function extensionFields(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => isExtensionKey(key)),
  );
}

function assertRecordArrayKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    if (isRecord(entry)) assertKnownKeys(entry, allowed, `${path}[${index}]`);
  });
}

function assertWhereKeys(value: unknown, path: string): void {
  if (!isRecord(value)) return;
  for (const [column, condition] of Object.entries(value)) {
    if (column === "_or" || column === "_and") {
      if (Array.isArray(condition)) {
        condition.forEach((clause, index) =>
          assertWhereKeys(clause, `${path}.${column}[${index}]`)
        );
      }
      continue;
    }
    if (isRecord(condition)) {
      assertKnownKeys(condition, WHERE_CONDITION_KEYS, `${path}.${column}`);
    }
  }
}

function assertUpdateExpressionKeys(value: unknown, path: string): void {
  if (!isRecord(value)) return;
  for (const [column, expression] of Object.entries(value)) {
    if (isRecord(expression)) {
      assertKnownKeys(
        expression,
        UPDATE_EXPRESSION_KEYS,
        `${path}.${column}`,
      );
    }
  }
}

function assertSelectShape(
  value: Record<string, unknown>,
  path: string,
): void {
  assertRecordArrayKeys(value.columns, COLUMN_KEYS, `${path}.columns`);
  assertWhereKeys(value.where, `${path}.where`);
  assertWhereKeys(value.having, `${path}.having`);
  if (Array.isArray(value.joins)) {
    value.joins.forEach((join, index) => {
      if (!isRecord(join)) return;
      const joinPath = `${path}.joins[${index}]`;
      assertKnownKeys(join, JOIN_KEYS, joinPath);
      if (isRecord(join.on)) {
        assertKnownKeys(join.on, JOIN_ON_KEYS, `${joinPath}.on`);
      }
    });
  }
  const orderBy = Array.isArray(value.orderBy)
    ? value.orderBy
    : [value.orderBy];
  orderBy.forEach((order, index) => {
    if (isRecord(order)) {
      assertKnownKeys(
        order,
        ORDER_KEYS,
        Array.isArray(value.orderBy)
          ? `${path}.orderBy[${index}]`
          : `${path}.orderBy`,
      );
    }
  });
}

function assertBatchShape(value: Record<string, unknown>, path: string): void {
  if (!Array.isArray(value.ops)) return;
  value.ops.forEach((operation, index) => {
    if (!isRecord(operation)) return;
    const operationPath = `${path}.ops[${index}]`;
    const op = operation.op;
    const allowed = typeof op === "string" ? BATCH_METHOD_KEYS[op] : undefined;
    if (!allowed) {
      throw new Error(
        `${operationPath}.op must be one of insert, update, delete, upsert`,
      );
    }
    assertKnownKeys(operation, allowed, operationPath);
    if (op === "update") {
      assertUpdateExpressionKeys(operation.set, `${operationPath}.set`);
      assertWhereKeys(operation.where, `${operationPath}.where`);
    } else if (op === "delete") {
      assertWhereKeys(operation.where, `${operationPath}.where`);
    } else if (op === "upsert") {
      assertUpdateExpressionKeys(operation.set, `${operationPath}.set`);
    }
  });
}

function assertD1WhenShape(
  method: D1FixtureMethod,
  value: Record<string, unknown>,
  path: string,
): void {
  const allowed = method === "select" || method === "first"
    ? SELECT_KEYS
    : method === "count"
    ? COUNT_KEYS
    : method === "insert"
    ? INSERT_KEYS
    : method === "update"
    ? UPDATE_KEYS
    : method === "delete"
    ? DELETE_KEYS
    : method === "upsert"
    ? UPSERT_KEYS
    : BATCH_KEYS;
  assertKnownKeys(value, allowed, path);

  if (method === "select" || method === "first") {
    assertSelectShape(value, path);
  } else if (method === "count") {
    assertWhereKeys(value.where, `${path}.where`);
    if (Array.isArray(value.joins)) {
      value.joins.forEach((join, index) => {
        if (!isRecord(join)) return;
        const joinPath = `${path}.joins[${index}]`;
        assertKnownKeys(join, JOIN_KEYS, joinPath);
        if (isRecord(join.on)) {
          assertKnownKeys(join.on, JOIN_ON_KEYS, `${joinPath}.on`);
        }
      });
    }
  } else if (method === "update") {
    assertUpdateExpressionKeys(value.set, `${path}.set`);
    assertWhereKeys(value.where, `${path}.where`);
  } else if (method === "delete") {
    assertWhereKeys(value.where, `${path}.where`);
  } else if (method === "upsert") {
    assertUpdateExpressionKeys(value.set, `${path}.set`);
  } else if (method === "batch") {
    assertBatchShape(value, path);
  }
}

export function resolveD1TestFixtureConfig(
  input: unknown,
  options: D1TestFixtureResolutionOptions = {},
): D1TestFixtureConfig | null {
  if (input === undefined || input === null) return null;
  if (!isRecord(input)) {
    throw new Error("d1_fixtures must be an object");
  }
  if (options.strictUnknownKeys) {
    assertKnownKeys(input, CONFIG_KEYS, "d1_fixtures");
  }

  const responsesValue = input.responses;
  if (!Array.isArray(responsesValue)) {
    throw new Error("d1_fixtures.responses must be an array");
  }

  const responses = responsesValue.map((response, index) =>
    normalizeD1FixtureResponse(response, index, options)
  );
  return { ...extensionFields(input), responses };
}

function normalizeD1FixtureResponse(
  input: unknown,
  index: number,
  options: D1TestFixtureResolutionOptions,
): D1FixtureResponse {
  if (!isRecord(input)) {
    throw new Error(`d1_fixtures.responses[${index}] must be an object`);
  }
  const path = `d1_fixtures.responses[${index}]`;
  if (options.strictUnknownKeys) {
    assertKnownKeys(input, RESPONSE_KEYS, path);
  }

  const method = input.method;
  if (typeof method !== "string" || !FIXTURE_METHODS.has(method)) {
    throw new Error(
      `d1_fixtures.responses[${index}].method must be one of ${
        [...FIXTURE_METHODS].join(", ")
      }`,
    );
  }

  if (input.table !== undefined && typeof input.table !== "string") {
    throw new Error(`d1_fixtures.responses[${index}].table must be a string`);
  }
  if (input.when !== undefined && !isRecord(input.when)) {
    throw new Error(`d1_fixtures.responses[${index}].when must be an object`);
  }
  if (options.strictUnknownKeys && isRecord(input.when)) {
    assertD1WhenShape(
      method as D1FixtureMethod,
      input.when,
      `${path}.when`,
    );
  }

  return {
    ...extensionFields(input),
    method: method as D1FixtureMethod,
    table: input.table as string | undefined,
    when: input.when as Record<string, unknown> | undefined,
    result: input.result,
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// Every key in `when` must deep-equal the same key in `op`. `op` may carry extra
// keys (e.g. platform-added fields) — those are ignored.
function matchesWhen(
  when: Record<string, unknown> | undefined,
  op: Record<string, unknown>,
): boolean {
  if (!when) return true;
  return Object.keys(when).every((k) => deepEqual(when[k], op[k]));
}

export function findD1TestFixtureResponse(
  fixtures: D1TestFixtureConfig | null | undefined,
  request: D1FixtureRequest,
): D1FixtureResponse | null {
  if (!fixtures) return null;
  return (
    fixtures.responses.find((response) => {
      if (response.method !== request.method) return false;
      if (response.table !== undefined && response.table !== request.table) {
        return false;
      }
      return matchesWhen(response.when, request.op);
    }) ?? null
  );
}

export function buildD1FixtureMissMessage(request: D1FixtureRequest): string {
  const target = request.table ? ` on "${request.table}"` : "";
  return `No D1 fixture matched galactic.db.${request.method}()${target}. Add a ` +
    `d1_fixtures.responses entry with method:"${request.method}"${
      request.table ? `, table:"${request.table}"` : ""
    }.`;
}

// ── Result shaping (parity with DatabaseBinding return shapes) ──

interface D1FixtureWriteResult {
  success: boolean;
  id?: number;
  meta: {
    changes: number;
    last_row_id: number;
    duration: number;
    rows_read: number;
    rows_written: number;
  };
}

export function buildD1FixtureWriteResult(
  result: unknown,
  withId = false,
): D1FixtureWriteResult {
  const record = isRecord(result) ? result : {};
  const meta = isRecord(record.meta) ? record.meta : {};
  const shaped: D1FixtureWriteResult = {
    success: typeof record.success === "boolean" ? record.success : true,
    meta: {
      changes: Number(meta.changes ?? 0),
      last_row_id: Number(meta.last_row_id ?? record.id ?? 0),
      duration: Number(meta.duration ?? 0),
      rows_read: Number(meta.rows_read ?? 0),
      rows_written: Number(meta.rows_written ?? 0),
    },
  };
  if (withId) shaped.id = shaped.meta.last_row_id;
  return shaped;
}
