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
}

export interface D1TestFixtureConfig {
  responses: D1FixtureResponse[];
}

interface D1FixtureRequest {
  method: D1FixtureMethod;
  table?: string;
  op: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function resolveD1TestFixtureConfig(
  input: unknown,
): D1TestFixtureConfig | null {
  if (input === undefined || input === null) return null;
  if (!isRecord(input)) {
    throw new Error("d1_fixtures must be an object");
  }

  const responsesValue = input.responses;
  if (!Array.isArray(responsesValue)) {
    throw new Error("d1_fixtures.responses must be an array");
  }

  const responses = responsesValue.map((response, index) =>
    normalizeD1FixtureResponse(response, index)
  );
  return { responses };
}

function normalizeD1FixtureResponse(
  input: unknown,
  index: number,
): D1FixtureResponse {
  if (!isRecord(input)) {
    throw new Error(`d1_fixtures.responses[${index}] must be an object`);
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

  return {
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
