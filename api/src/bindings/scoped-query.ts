// Scoped D1 query builder — Phase 5 per-user data isolation.
//
// PURE module (no cloudflare:workers import) so it is unit-testable under plain
// Deno, mirroring outbound-policy.ts / credential-inject.ts.
//
// THE INVARIANT this module exists to guarantee:
//   Every statement it emits touches ONLY rows where user_id = <the caller>.
//
// App code supplies table / column / value / filter through a STRUCTURED op — it
// never supplies raw SQL and never supplies user_id. The platform builds the SQL
// here, host-side, and injects `user_id = ?` on every table the query touches.
// Because the app cannot express a query that omits or widens that predicate,
// per-user isolation holds by construction — no SQL parser sits on the boundary.
//
// Every identifier is validated (IDENT_RE) and double-quoted; every value is
// parameterized. A value never appears in the SQL string.

const USER_ID_COLUMN = "user_id";

// SQLite identifiers we accept from app code: a leading letter/underscore then
// word chars. This is deliberately strict — it rejects dotted names, spaces,
// quotes, semicolons, and anything else that could smuggle SQL.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const COMPARISON_OPS: Record<string, string> = {
  eq: "=",
  ne: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
};

const AGGREGATE_FNS = new Set(["count", "sum", "avg", "min", "max"]);
const SCALAR_FNS = new Set(["date", "lower", "upper", "length"]);
const UPDATE_EXPR_OPS = new Set(["increment", "max", "min"]);

export type SqlValue = string | number | boolean | null;

export interface BuiltQuery {
  sql: string;
  params: SqlValue[];
}

// ── Structured op shapes (developer-facing) ──

export type WhereCondition =
  | SqlValue
  | {
    eq?: SqlValue;
    ne?: SqlValue;
    gt?: SqlValue;
    gte?: SqlValue;
    lt?: SqlValue;
    lte?: SqlValue;
    like?: string;
    in?: SqlValue[];
    notIn?: SqlValue[];
    isNull?: boolean;
  };

export interface WhereClause {
  [column: string]: WhereCondition | WhereClause[] | undefined;
  _or?: WhereClause[];
  _and?: WhereClause[];
}

export interface ColumnSpec {
  table?: string;
  column?: string;
  fn?: string;
  as?: string;
  distinct?: boolean;
}

export type ColumnSelector = string | ColumnSpec;

export interface JoinSpec {
  table: string;
  as?: string;
  type?: "inner" | "left";
  on: {
    from?: string;
    fromColumn?: string;
    column?: string;
    foreignColumn: string;
  };
}

export interface OrderSpec {
  column?: string;
  as?: string;
  dir?: "asc" | "desc";
}

export type OrderSelector = string | OrderSpec;

export interface SelectOp {
  table: string;
  columns?: ColumnSelector[];
  where?: WhereClause;
  joins?: JoinSpec[];
  groupBy?: string[];
  having?: WhereClause;
  orderBy?: OrderSelector | OrderSelector[];
  limit?: number;
  offset?: number;
}

export interface CountOp {
  table: string;
  where?: WhereClause;
  joins?: JoinSpec[];
  column?: string;
  distinct?: boolean;
}

export type UpdateValue = SqlValue | { op: string; value: number };

export interface InsertOp {
  table: string;
  values: Record<string, SqlValue> | Record<string, SqlValue>[];
}

export interface UpdateOp {
  table: string;
  set: Record<string, UpdateValue>;
  where?: WhereClause;
}

export interface DeleteOp {
  table: string;
  where?: WhereClause;
}

export interface UpsertOp {
  table: string;
  values: Record<string, SqlValue>;
  onConflict: string[];
  set?: Record<string, UpdateValue>;
}

// ── Identifier / value guards ──

export class ScopedQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopedQueryError";
  }
}

function ident(name: unknown, kind = "name"): string {
  if (typeof name !== "string" || !IDENT_RE.test(name)) {
    throw new ScopedQueryError(
      `Invalid ${kind} ${JSON.stringify(name)}. galactic.db uses a structured ` +
        `API — pass a plain table/column identifier, not raw SQL.`,
    );
  }
  return `"${name}"`;
}

function assertTable(table: unknown): string {
  if (typeof table !== "string" || !IDENT_RE.test(table)) {
    throw new ScopedQueryError(
      `Invalid table name ${JSON.stringify(table)}. galactic.db no longer ` +
        `accepts raw SQL — call galactic.db.select(table, {...}) with a plain ` +
        `table name.`,
    );
  }
  if (table.startsWith("_")) {
    throw new ScopedQueryError(
      `Table "${table}" is reserved for the platform and is not accessible.`,
    );
  }
  return table;
}

function assertValue(value: unknown, ctx: string): SqlValue {
  if (value === null || typeof value === "string") return value;
  // SQLite has no boolean type and the D1 REST bind layer rejects a JSON boolean.
  // Coerce to 1/0 at the bind boundary while keeping the developer-facing boolean.
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ScopedQueryError(`${ctx}: numbers must be finite.`);
    }
    return value;
  }
  throw new ScopedQueryError(
    `${ctx}: values must be a string, number, boolean, or null (got ${typeof value}).`,
  );
}

function assertInteger(value: unknown, ctx: string): number {
  // Upper-bounded so LIMIT/OFFSET (the only inlined values) can never stringify
  // in scientific notation (e.g. 1e21 -> "1e+21"), which D1 rejects.
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new ScopedQueryError(
      `${ctx} must be an integer between 0 and ${Number.MAX_SAFE_INTEGER}.`,
    );
  }
  return value;
}

// ── Column reference resolution (alias-qualified for SELECT/COUNT) ──

interface AliasMap {
  // ref (join `as`, join table name, or "base") -> alias token like "t0"
  byRef: Map<string, string>;
  base: string;
}

// Resolve a possibly-dotted column reference ("col" or "joinRef.col") to a
// quoted, alias-qualified column: "t0"."col".
function qualifyColumn(ref: string, aliases: AliasMap): string {
  const dot = ref.indexOf(".");
  if (dot === -1) {
    return `${aliases.base}.${ident(ref, "column")}`;
  }
  const tableRef = ref.slice(0, dot);
  const column = ref.slice(dot + 1);
  const alias = resolveAlias(tableRef, aliases);
  return `${alias}.${ident(column, "column")}`;
}

function resolveAlias(ref: string, aliases: AliasMap): string {
  if (ref === "base") return aliases.base;
  const alias = aliases.byRef.get(ref);
  if (!alias) {
    throw new ScopedQueryError(
      `Unknown table reference "${ref}" in query. Reference the base table or a ` +
        `declared join by its table name or "as" alias.`,
    );
  }
  return alias;
}

// ── WHERE construction ──

// Build an AND-joined condition list from an app WhereClause. Values are pushed
// onto `params` in emission order. `resolveCol` maps a bare/dotted key to a
// quoted column expression (alias-qualified for SELECT/COUNT, plain otherwise).
function buildConditions(
  where: WhereClause | undefined,
  params: SqlValue[],
  resolveCol: (key: string) => string,
): string {
  if (!where) return "";
  const parts: string[] = [];

  for (const [key, raw] of Object.entries(where)) {
    if (raw === undefined) continue;

    if (key === "_or" || key === "_and") {
      if (!Array.isArray(raw)) {
        throw new ScopedQueryError(`${key} must be an array of clauses.`);
      }
      const sub = raw
        .map((clause) => buildConditions(clause, params, resolveCol))
        .filter((s) => s.length > 0);
      if (sub.length === 0) continue;
      const joiner = key === "_or" ? " OR " : " AND ";
      parts.push(`(${sub.map((s) => `(${s})`).join(joiner)})`);
      continue;
    }

    // Guard the user_id column in bare AND qualified ("base.user_id",
    // "join.user_id") forms — the app must never filter on it.
    if (key === USER_ID_COLUMN || key.split(".").pop() === USER_ID_COLUMN) {
      throw new ScopedQueryError(
        `"user_id" is managed by the platform and cannot appear in a filter.`,
      );
    }

    const col = resolveCol(key);
    parts.push(buildCondition(col, raw as WhereCondition, params, key));
  }

  return parts.join(" AND ");
}

function buildCondition(
  col: string,
  cond: WhereCondition,
  params: SqlValue[],
  key: string,
): string {
  // Primitive shorthand: { col: value } -> equality (or IS NULL).
  if (
    cond === null || typeof cond === "string" || typeof cond === "number" ||
    typeof cond === "boolean"
  ) {
    if (cond === null) return `${col} IS NULL`;
    params.push(assertValue(cond, `where.${key}`));
    return `${col} = ?`;
  }

  if (typeof cond !== "object" || Array.isArray(cond)) {
    throw new ScopedQueryError(`where.${key}: unsupported condition.`);
  }

  const clauses: string[] = [];
  for (const [op, val] of Object.entries(cond)) {
    if (val === undefined) continue;

    if (op === "isNull") {
      clauses.push(val ? `${col} IS NULL` : `${col} IS NOT NULL`);
      continue;
    }

    if (op === "in" || op === "notIn") {
      if (!Array.isArray(val) || val.length === 0) {
        throw new ScopedQueryError(
          `where.${key}.${op} must be a non-empty array.`,
        );
      }
      const placeholders = val
        .map((v) => {
          params.push(assertValue(v, `where.${key}.${op}`));
          return "?";
        })
        .join(", ");
      clauses.push(`${col} ${op === "in" ? "IN" : "NOT IN"} (${placeholders})`);
      continue;
    }

    const sqlOp = COMPARISON_OPS[op];
    if (!sqlOp) {
      throw new ScopedQueryError(`where.${key}: unknown operator "${op}".`);
    }
    params.push(assertValue(val as SqlValue, `where.${key}.${op}`));
    clauses.push(`${col} ${sqlOp} ?`);
  }

  if (clauses.length === 0) {
    throw new ScopedQueryError(`where.${key}: empty condition.`);
  }
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" AND ")})`;
}

// Compose the WHERE for SELECT/COUNT: app conditions first, then the mandatory
// per-user predicate for the BASE table. Joined tables are scoped in their ON
// clause (see buildAliases) so a LEFT JOIN keeps its outer-join semantics.
// Order matters: this runs AFTER buildAliases has pushed the join scope params,
// so the params array matches placeholder order (JOIN ... ON ? , then WHERE ?).
function composeScopedWhere(
  where: WhereClause | undefined,
  aliases: AliasMap,
  userId: string,
  params: SqlValue[],
): string {
  const appClause = buildConditions(
    where,
    params,
    (key) => qualifyColumn(key, aliases),
  );
  params.push(userId);
  const baseClause = `${aliases.base}.${ident(USER_ID_COLUMN)} = ?`;
  return appClause ? `${appClause} AND ${baseClause}` : baseClause;
}

// ── Column / order rendering ──

function renderColumn(spec: ColumnSelector, aliases: AliasMap): string {
  if (typeof spec === "string") {
    if (spec === "*") return `${aliases.base}.*`;
    return qualifyColumn(spec, aliases);
  }
  if (!spec || typeof spec !== "object") {
    throw new ScopedQueryError("Invalid column selector.");
  }

  const alias = spec.as ? ` AS ${ident(spec.as, "alias")}` : "";

  if (spec.fn) {
    const fn = spec.fn.toLowerCase();
    if (AGGREGATE_FNS.has(fn)) {
      const inner = spec.column === "*" || spec.column === undefined
        ? "*"
        : columnRef(spec, aliases);
      const distinct = spec.distinct && inner !== "*" ? "DISTINCT " : "";
      return `${fn.toUpperCase()}(${distinct}${inner})${alias}`;
    }
    if (SCALAR_FNS.has(fn)) {
      if (spec.column === undefined) {
        throw new ScopedQueryError(`${fn}() requires a column.`);
      }
      return `${fn.toUpperCase()}(${columnRef(spec, aliases)})${alias}`;
    }
    throw new ScopedQueryError(`Unsupported function "${spec.fn}".`);
  }

  if (spec.column === undefined) {
    throw new ScopedQueryError("Column selector needs a column or fn.");
  }
  return `${columnRef(spec, aliases)}${alias}`;
}

function columnRef(spec: ColumnSpec, aliases: AliasMap): string {
  const table = spec.table ?? "base";
  const alias = resolveAlias(table, aliases);
  return `${alias}.${ident(spec.column as string, "column")}`;
}

function renderOrder(spec: OrderSelector, aliases: AliasMap): string {
  if (typeof spec === "string") {
    return qualifyColumn(spec, aliases);
  }
  const dir = spec.dir === "desc" ? " DESC" : " ASC";
  // ORDER BY may reference a SELECT alias (e.g. an aggregate `as`) OR a column.
  if (spec.as) return `${ident(spec.as, "alias")}${dir}`;
  if (spec.column) return `${qualifyColumn(spec.column, aliases)}${dir}`;
  throw new ScopedQueryError("orderBy entry needs a column or alias.");
}

// ── JOIN + alias assembly ──

// Builds the FROM ... JOIN clause AND pushes one user_id scope param per join.
// Each joined table's `AND "tN"."user_id" = ?` goes in its ON clause (not the
// WHERE) so that a LEFT JOIN still returns unmatched base rows while any matched
// joined row is guaranteed to belong to the caller. The join scope params are
// pushed here, before the caller composes the WHERE, so param order is stable.
function buildAliases(
  table: string,
  joins: JoinSpec[] | undefined,
  userId: string,
  params: SqlValue[],
): {
  aliases: AliasMap;
  fromSql: string;
} {
  const base = `"t0"`;
  const byRef = new Map<string, string>();
  byRef.set("base", base);
  byRef.set(table, base);

  let fromSql = `${ident(table, "table")} AS ${base}`;

  (joins ?? []).forEach((join, index) => {
    const jTable = assertTable(join.table);
    const aliasToken = `"t${index + 1}"`;
    if (join.as) {
      const name = join.as;
      if (!IDENT_RE.test(name)) {
        throw new ScopedQueryError(`Invalid join alias ${JSON.stringify(name)}.`);
      }
      byRef.set(name, aliasToken);
    }
    byRef.set(jTable, aliasToken);

    const aliases: AliasMap = { byRef, base };
    const fromRef = join.on.from ?? "base";
    const fromCol = join.on.fromColumn ?? join.on.column;
    if (!fromCol) {
      throw new ScopedQueryError(
        `join on ${jTable}: needs "column" (base side) or "fromColumn".`,
      );
    }
    const left = `${resolveAlias(fromRef, aliases)}.${ident(fromCol, "column")}`;
    const right = `${aliasToken}.${ident(join.on.foreignColumn, "column")}`;
    const type = join.type === "left" ? "LEFT JOIN" : "JOIN";
    // Scope the joined table in the ON clause — preserves LEFT JOIN semantics.
    params.push(userId);
    fromSql += ` ${type} ${ident(jTable, "table")} AS ${aliasToken} ` +
      `ON ${left} = ${right} AND ${aliasToken}.${ident(USER_ID_COLUMN)} = ?`;
  });

  return { aliases: { byRef, base }, fromSql };
}

// ── Public builders ──

export function buildSelect(op: SelectOp, userId: string): BuiltQuery {
  assertTable(op.table);
  (op.joins ?? []).forEach((j) => assertTable(j.table));
  // params is built in placeholder order: JOIN ON scopes first, then WHERE, then
  // HAVING. buildAliases pushes the join scope params, so it must run first.
  const params: SqlValue[] = [];
  const { aliases, fromSql } = buildAliases(op.table, op.joins, userId, params);

  const columns = op.columns && op.columns.length > 0
    ? op.columns.map((c) => renderColumn(c, aliases)).join(", ")
    : `${aliases.base}.*`;

  const whereSql = composeScopedWhere(op.where, aliases, userId, params);

  let sql = `SELECT ${columns} FROM ${fromSql} WHERE ${whereSql}`;

  if (op.groupBy && op.groupBy.length > 0) {
    sql += ` GROUP BY ${op.groupBy.map((c) => qualifyColumn(c, aliases)).join(", ")}`;
  }
  if (op.having) {
    // HAVING may reference a SELECT-list output alias (e.g. an aggregate `as`)
    // or a column. Resolve a bare key that matches a declared alias to that
    // alias; otherwise qualify it as a column.
    const declaredAliases = new Set<string>();
    for (const c of op.columns ?? []) {
      if (c && typeof c === "object" && c.as) declaredAliases.add(c.as);
    }
    const havingSql = buildConditions(
      op.having,
      params,
      (key) =>
        !key.includes(".") && declaredAliases.has(key)
          ? ident(key, "alias")
          : qualifyColumn(key, aliases),
    );
    if (havingSql) sql += ` HAVING ${havingSql}`;
  }
  if (op.orderBy !== undefined) {
    const list = Array.isArray(op.orderBy) ? op.orderBy : [op.orderBy];
    if (list.length > 0) {
      sql += ` ORDER BY ${list.map((o) => renderOrder(o, aliases)).join(", ")}`;
    }
  }
  if (op.limit !== undefined) {
    sql += ` LIMIT ${assertInteger(op.limit, "limit")}`;
    if (op.offset !== undefined) {
      sql += ` OFFSET ${assertInteger(op.offset, "offset")}`;
    }
  } else if (op.offset !== undefined) {
    // SQLite requires LIMIT before OFFSET; use the max sentinel like SQLite docs.
    sql += ` LIMIT -1 OFFSET ${assertInteger(op.offset, "offset")}`;
  }

  return { sql, params };
}

export function buildCount(op: CountOp, userId: string): BuiltQuery {
  assertTable(op.table);
  (op.joins ?? []).forEach((j) => assertTable(j.table));
  const params: SqlValue[] = [];
  const { aliases, fromSql } = buildAliases(op.table, op.joins, userId, params);

  const inner = op.column && op.column !== "*"
    ? `${op.distinct ? "DISTINCT " : ""}${qualifyColumn(op.column, aliases)}`
    : "*";

  const whereSql = composeScopedWhere(op.where, aliases, userId, params);

  return {
    sql: `SELECT COUNT(${inner}) AS count FROM ${fromSql} WHERE ${whereSql}`,
    params,
  };
}

export function buildInsert(op: InsertOp, userId: string): BuiltQuery {
  const table = assertTable(op.table);
  const rows = Array.isArray(op.values) ? op.values : [op.values];
  if (rows.length === 0) {
    throw new ScopedQueryError("insert requires at least one row.");
  }

  // Column set from the first row; every row must match it. user_id is always
  // appended and always the caller's — an app-supplied user_id is ignored.
  const appColumns = Object.keys(rows[0]).filter((c) => c !== USER_ID_COLUMN);
  for (const c of appColumns) ident(c, "column");

  const columns = [...appColumns, USER_ID_COLUMN];
  const params: SqlValue[] = [];
  const tuples: string[] = [];

  for (const row of rows) {
    const keys = Object.keys(row).filter((c) => c !== USER_ID_COLUMN);
    if (
      keys.length !== appColumns.length ||
      !appColumns.every((c) => Object.prototype.hasOwnProperty.call(row, c))
    ) {
      throw new ScopedQueryError(
        "insert rows must all have the same columns.",
      );
    }
    for (const c of appColumns) {
      params.push(assertValue(row[c], `insert.${c}`));
    }
    params.push(userId);
    tuples.push(`(${columns.map(() => "?").join(", ")})`);
  }

  const cols = columns.map((c) => ident(c, "column")).join(", ");
  return {
    sql: `INSERT INTO ${ident(table)} (${cols}) VALUES ${tuples.join(", ")}`,
    params,
  };
}

// Render an UPDATE assignment. Plain value -> `col = ?`; expression object ->
// `col = col + ?` / `col = MAX(col, ?)` / `col = MIN(col, ?)`.
function renderAssignment(
  column: string,
  value: UpdateValue,
  params: SqlValue[],
): string {
  const col = ident(column, "column");
  if (value !== null && typeof value === "object") {
    const op = String(value.op);
    if (!UPDATE_EXPR_OPS.has(op)) {
      throw new ScopedQueryError(`set.${column}: unknown op "${value.op}".`);
    }
    const n = value.value;
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new ScopedQueryError(`set.${column}: op value must be a number.`);
    }
    params.push(n);
    if (op === "increment") return `${col} = ${col} + ?`;
    return `${col} = ${op.toUpperCase()}(${col}, ?)`;
  }
  params.push(assertValue(value, `set.${column}`));
  return `${col} = ?`;
}

function buildSetClause(
  set: Record<string, UpdateValue>,
  params: SqlValue[],
): string {
  const keys = Object.keys(set);
  if (keys.length === 0) {
    throw new ScopedQueryError("update requires at least one column in `set`.");
  }
  if (Object.prototype.hasOwnProperty.call(set, USER_ID_COLUMN)) {
    throw new ScopedQueryError(
      `"user_id" cannot be changed — it is owned by the platform.`,
    );
  }
  return keys.map((k) => renderAssignment(k, set[k], params)).join(", ");
}

// WHERE for single-table writes: app conditions + the mandatory user_id, no alias.
function buildWriteWhere(
  where: WhereClause | undefined,
  userId: string,
  params: SqlValue[],
): string {
  const appClause = buildConditions(
    where,
    params,
    (key) => {
      if (key.includes(".")) {
        throw new ScopedQueryError(
          `Qualified column "${key}" is not allowed in a write filter.`,
        );
      }
      return ident(key, "column");
    },
  );
  params.push(userId);
  const userClause = `${ident(USER_ID_COLUMN)} = ?`;
  return appClause ? `${appClause} AND ${userClause}` : userClause;
}

export function buildUpdate(op: UpdateOp, userId: string): BuiltQuery {
  const table = assertTable(op.table);
  const params: SqlValue[] = [];
  const setSql = buildSetClause(op.set, params);
  const whereSql = buildWriteWhere(op.where, userId, params);
  return {
    sql: `UPDATE ${ident(table)} SET ${setSql} WHERE ${whereSql}`,
    params,
  };
}

export function buildDelete(op: DeleteOp, userId: string): BuiltQuery {
  const table = assertTable(op.table);
  const params: SqlValue[] = [];
  const whereSql = buildWriteWhere(op.where, userId, params);
  return { sql: `DELETE FROM ${ident(table)} WHERE ${whereSql}`, params };
}

export function buildUpsert(op: UpsertOp, userId: string): BuiltQuery {
  const table = assertTable(op.table);
  if (!Array.isArray(op.onConflict) || op.onConflict.length === 0) {
    throw new ScopedQueryError("upsert requires a non-empty onConflict[].");
  }

  // INSERT part (user_id injected, app user_id ignored).
  const insert = buildInsert({ table, values: op.values }, userId);

  // Conflict target always includes user_id so a conflict can only ever be with
  // one of the caller's own rows.
  const conflictCols = op.onConflict.filter((c) => c !== USER_ID_COLUMN);
  for (const c of conflictCols) ident(c, "column");
  const conflictTarget = [...conflictCols, USER_ID_COLUMN]
    .map((c) => ident(c, "column"))
    .join(", ");

  // DO UPDATE SET: explicit `set`, else every provided value column except the
  // conflict keys. user_id can never be in the set.
  const params = [...insert.params];
  let setSql: string;
  if (op.set) {
    setSql = buildSetClause(op.set, params);
  } else {
    const updatable = Object.keys(op.values).filter(
      (c) => c !== USER_ID_COLUMN && !op.onConflict.includes(c),
    );
    if (updatable.length === 0) {
      throw new ScopedQueryError(
        "upsert needs at least one non-conflict column to update (or pass `set`).",
      );
    }
    setSql = updatable
      .map((c) => `${ident(c, "column")} = excluded.${ident(c, "column")}`)
      .join(", ");
  }

  return {
    sql: `${insert.sql} ON CONFLICT (${conflictTarget}) DO UPDATE SET ${setSql}`,
    params,
  };
}
