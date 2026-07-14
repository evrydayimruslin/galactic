import type { R2Service } from "./storage.ts";
import {
  type MigrationFile,
  parseMigrationFiles,
  validateMigrationSchema,
} from "./d1-migrations.ts";

export interface StagedMigrationValidation {
  migrations: MigrationFile[];
  errors: string[];
  warnings: string[];
}

type SqlTokenKind = "word" | "quoted_identifier" | "string" | "symbol";

interface SqlToken {
  kind: SqlTokenKind;
  value: string;
}

interface SqlAnalysis {
  statements: SqlToken[][];
  errors: string[];
}

const STRICT_ADDITIVE_STATEMENTS =
  "CREATE TABLE, CREATE [UNIQUE] INDEX, or ALTER TABLE ... ADD [COLUMN]";

/**
 * Reload migrations from version-addressed R2 source and validate them again
 * immediately before promotion. Listing the entire version supports uploads
 * whose migration directory was nested under a non-common source root.
 */
export async function loadAndValidateStagedMigrations(
  r2: Pick<R2Service, "listFiles" | "fetchTextFile">,
  storageKey: string,
): Promise<StagedMigrationValidation> {
  const keys = await r2.listFiles(storageKey);
  const migrationSources: Record<string, string> = {};
  for (const key of keys) {
    const relative = key.startsWith(storageKey)
      ? key.slice(storageKey.length)
      : key;
    const parts = relative.split("/");
    const migrationIndex = parts.indexOf("migrations");
    if (migrationIndex < 0 || migrationIndex === parts.length - 1) continue;
    const filename = parts.slice(migrationIndex + 1).join("/");
    if (!filename.endsWith(".sql")) continue;
    if (migrationSources[filename] !== undefined) {
      throw new Error(`Duplicate staged migration filename: ${filename}`);
    }
    migrationSources[filename] = await r2.fetchTextFile(key);
  }

  const migrations = parseMigrationFiles(migrationSources);
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const migration of migrations) {
    const result = validateMigrationSchema(migration.sql);
    errors.push(
      ...result.errors.map((error) => `${migration.filename}: ${error}`),
    );
    warnings.push(
      ...result.warnings.map((warning) => `${migration.filename}: ${warning}`),
    );
  }
  return { migrations, errors, warnings };
}

export function strictAdditiveMigrationErrors(
  validation: StagedMigrationValidation,
): string[] {
  // This gate is deliberately separate from loadAndValidateStagedMigrations:
  // connected builders call it before autonomous promotion, while an owner
  // account session may still explicitly review and accept legacy warnings.
  const migrationPrefixes = validation.migrations.map((migration) =>
    `${migration.filename}: `
  );
  // Per-file strict results are computed below. Preserve only any future
  // validation errors that are not associated with an individual file.
  const errors = new Set(
    [...validation.errors, ...validation.warnings].filter((message) =>
      !migrationPrefixes.some((prefix) => message.startsWith(prefix))
    ),
  );

  for (const migration of validation.migrations) {
    const filePrefix = `${migration.filename}: `;
    const generalErrors = [...validation.errors, ...validation.warnings]
      .filter((message) => message.startsWith(filePrefix))
      .filter(strictGeneralValidationIssue);
    for (const error of generalErrors) errors.add(error);
    // Avoid lexing an oversized attacker-controlled file after the general
    // validator has already rejected it on its cheap leading size guard.
    if (generalErrors.length > 0) continue;

    const analysis = analyzeSql(migration.sql);
    for (const error of analysis.errors) {
      errors.add(`${migration.filename}: ${error}`);
    }

    if (analysis.errors.length > 0) continue;

    for (const issue of strictTenantConventionIssues(analysis.statements)) {
      errors.add(`${migration.filename}: ${issue}`);
    }

    analysis.statements.forEach((tokens, index) => {
      const error = validateStrictAdditiveStatement(tokens);
      if (error) {
        errors.add(
          `${migration.filename}: statement ${index + 1} ${error}`,
        );
      }
    });
  }

  return [...errors];
}

/**
 * Remove SQL comments without joining the tokens on either side, then split
 * and tokenize statements while respecting SQL strings and quoted
 * identifiers. A small fail-closed lexer is safer here than regex matching:
 * the SQL is attacker-controlled and comments may appear between keywords.
 */
function analyzeSql(sql: string): SqlAnalysis {
  const normalized: string[] = [];
  const errors: string[] = [];
  let quote: "'" | '"' | "`" | "]" | null = null;

  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    if (char === "\0") {
      errors.push("NUL bytes are not allowed in migrations");
      normalized.push(" ");
      continue;
    }

    if (quote) {
      normalized.push(char);
      if (char === quote) {
        // SQLite quotes escape their closing delimiter by doubling it.
        if (quote !== "]" && sql[index + 1] === quote) {
          normalized.push(sql[index + 1]);
          index++;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      normalized.push(char);
      continue;
    }
    if (char === "[") {
      quote = "]";
      normalized.push(char);
      continue;
    }

    if (char === "-" && sql[index + 1] === "-") {
      normalized.push(" ", " ");
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") {
        normalized.push(" ");
        index++;
      }
      if (index < sql.length) normalized.push(" ");
      continue;
    }

    if (char === "/" && sql[index + 1] === "*") {
      normalized.push(" ", " ");
      index += 2;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === "*" && sql[index + 1] === "/") {
          normalized.push(" ", " ");
          index++;
          closed = true;
          break;
        }
        normalized.push(" ");
        index++;
      }
      if (!closed) errors.push("unterminated block comment");
      continue;
    }

    // Outside a quoted value, every SQL newline is interchangeable with a
    // space. Canonicalizing it also prevents the legacy convention validator's
    // single-line index regex from falsely rejecting a multiline CREATE INDEX.
    normalized.push(char === "\n" || char === "\r" ? " " : char);
  }

  if (quote) {
    const label = quote === "]" ? "bracketed identifier" : "quoted value";
    errors.push(`unterminated ${label}`);
  }

  const normalizedSql = normalized.join("");
  if (errors.length > 0) {
    return { statements: [], errors };
  }

  return {
    statements: splitAndTokenizeSql(normalizedSql),
    errors,
  };
}

function splitAndTokenizeSql(sql: string): SqlToken[][] {
  const statements: SqlToken[][] = [];
  let current = "";
  let quote: "'" | '"' | "`" | "]" | null = null;

  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    if (quote) {
      current += char;
      if (char === quote) {
        if (quote !== "]" && sql[index + 1] === quote) {
          current += sql[index + 1];
          index++;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[") {
      quote = "]";
      current += char;
      continue;
    }
    if (char === ";") {
      const tokens = tokenizeSqlStatement(current);
      if (tokens.length > 0) statements.push(tokens);
      current = "";
      continue;
    }
    current += char;
  }

  const tokens = tokenizeSqlStatement(current);
  if (tokens.length > 0) statements.push(tokens);
  return statements;
}

function tokenizeSqlStatement(statement: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const symbols = new Set(["(", ")", ",", "."]);

  for (let index = 0; index < statement.length;) {
    const char = statement[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }

    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const closing = char === "[" ? "]" : char;
      const kind: SqlTokenKind = char === "'" ? "string" : "quoted_identifier";
      let value = char;
      index++;
      while (index < statement.length) {
        value += statement[index];
        if (statement[index] === closing) {
          if (closing !== "]" && statement[index + 1] === closing) {
            value += statement[index + 1];
            index += 2;
            continue;
          }
          index++;
          break;
        }
        index++;
      }
      tokens.push({ kind, value });
      continue;
    }

    if (symbols.has(char)) {
      tokens.push({ kind: "symbol", value: char });
      index++;
      continue;
    }

    const start = index;
    while (
      index < statement.length &&
      !/\s/.test(statement[index]) &&
      !symbols.has(statement[index]) &&
      statement[index] !== "'" &&
      statement[index] !== '"' &&
      statement[index] !== "`" &&
      statement[index] !== "["
    ) {
      index++;
    }
    tokens.push({
      kind: "word",
      value: statement.slice(start, index),
    });
  }

  return tokens;
}

function validateStrictAdditiveStatement(tokens: SqlToken[]): string | null {
  if (keyword(tokens[0], "CREATE")) {
    if (keyword(tokens[1], "TABLE")) return validateCreateTable(tokens);
    if (keyword(tokens[1], "INDEX")) return validateCreateIndex(tokens, 2);
    if (keyword(tokens[1], "UNIQUE") && keyword(tokens[2], "INDEX")) {
      return validateCreateIndex(tokens, 3);
    }
  }
  if (keyword(tokens[0], "ALTER") && keyword(tokens[1], "TABLE")) {
    return validateAlterTableAddColumn(tokens);
  }

  return `(${
    statementPreview(tokens)
  }) is not allowed; connected builders may only use ${STRICT_ADDITIVE_STATEMENTS}`;
}

function validateCreateTable(tokens: SqlToken[]): string | null {
  let index = consumeIfNotExists(tokens, 2);
  index = consumeQualifiedIdentifier(tokens, index);
  if (index < 0) return "has an invalid or missing CREATE TABLE name";
  if (!symbol(tokens[index], "(")) {
    return "must declare explicit parenthesized columns; CREATE TABLE AS SELECT is not allowed";
  }

  const closing = matchingClosingParen(tokens, index);
  if (closing < 0 || closing === index + 1) {
    return "has an empty or unbalanced CREATE TABLE column list";
  }

  index = closing + 1;
  if (index === tokens.length) return null;

  // SQLite's only additive table options are STRICT and WITHOUT ROWID. They
  // may be comma-separated and appear in either order.
  const seen = new Set<string>();
  while (index < tokens.length) {
    if (seen.size > 0) {
      if (!symbol(tokens[index], ",")) {
        return "has unsupported CREATE TABLE trailing syntax";
      }
      index++;
    }
    if (keyword(tokens[index], "STRICT") && !seen.has("STRICT")) {
      seen.add("STRICT");
      index++;
      continue;
    }
    if (
      keyword(tokens[index], "WITHOUT") &&
      keyword(tokens[index + 1], "ROWID") &&
      !seen.has("WITHOUT ROWID")
    ) {
      seen.add("WITHOUT ROWID");
      index += 2;
      continue;
    }
    return "has unsupported CREATE TABLE trailing syntax";
  }
  return null;
}

function validateCreateIndex(tokens: SqlToken[], start: number): string | null {
  let index = consumeIfNotExists(tokens, start);
  index = consumeQualifiedIdentifier(tokens, index);
  if (index < 0) return "has an invalid or missing CREATE INDEX name";
  if (!keyword(tokens[index], "ON")) {
    return "must specify CREATE INDEX ... ON a table";
  }
  index = consumeQualifiedIdentifier(tokens, index + 1);
  if (index < 0 || !symbol(tokens[index], "(")) {
    return "has an invalid CREATE INDEX table or column list";
  }

  const closing = matchingClosingParen(tokens, index);
  if (closing < 0 || closing === index + 1) {
    return "has an empty or unbalanced CREATE INDEX column list";
  }
  index = closing + 1;
  if (index === tokens.length) return null;

  if (!keyword(tokens[index], "WHERE") || index + 1 >= tokens.length) {
    return "has unsupported CREATE INDEX trailing syntax";
  }
  if (!parenthesesAreBalanced(tokens.slice(index + 1))) {
    return "has an unbalanced CREATE INDEX WHERE expression";
  }
  return null;
}

function validateAlterTableAddColumn(tokens: SqlToken[]): string | null {
  let index = consumeQualifiedIdentifier(tokens, 2);
  if (index < 0 || !keyword(tokens[index], "ADD")) {
    return `(${
      statementPreview(tokens)
    }) is not an allowed ALTER TABLE operation; only ADD [COLUMN] is permitted`;
  }
  index++;
  if (keyword(tokens[index], "COLUMN")) index++;
  if (!identifier(tokens[index])) {
    return "has an invalid or missing added column name";
  }
  index++;

  let depth = 0;
  const forbiddenAtTopLevel = new Set([
    "ADD",
    "ALTER",
    "ATTACH",
    "CREATE",
    "DELETE",
    "DETACH",
    "DROP",
    "INSERT",
    "PRAGMA",
    "REINDEX",
    "RENAME",
    "REPLACE",
    "UPDATE",
    "VACUUM",
  ]);
  for (; index < tokens.length; index++) {
    if (symbol(tokens[index], "(")) {
      depth++;
      continue;
    }
    if (symbol(tokens[index], ")")) {
      depth--;
      if (depth < 0) {
        return "has unbalanced parentheses in its added column definition";
      }
      continue;
    }
    if (depth === 0 && symbol(tokens[index], ",")) {
      return "may add only one column per ALTER TABLE statement";
    }
    if (
      depth === 0 && tokens[index]?.kind === "word" &&
      forbiddenAtTopLevel.has(tokens[index].value.toUpperCase())
    ) {
      return `contains unsupported ALTER TABLE syntax (${tokens[index].value})`;
    }
  }
  if (depth !== 0) {
    return "has unbalanced parentheses in its added column definition";
  }
  return null;
}

function consumeIfNotExists(tokens: SqlToken[], start: number): number {
  if (
    keyword(tokens[start], "IF") && keyword(tokens[start + 1], "NOT") &&
    keyword(tokens[start + 2], "EXISTS")
  ) {
    return start + 3;
  }
  return start;
}

function consumeQualifiedIdentifier(tokens: SqlToken[], start: number): number {
  return readQualifiedIdentifier(tokens, start)?.next ?? -1;
}

function matchingClosingParen(tokens: SqlToken[], opening: number): number {
  let depth = 0;
  for (let index = opening; index < tokens.length; index++) {
    if (symbol(tokens[index], "(")) depth++;
    if (symbol(tokens[index], ")")) {
      depth--;
      if (depth === 0) return index;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function parenthesesAreBalanced(tokens: SqlToken[]): boolean {
  let depth = 0;
  for (const token of tokens) {
    if (symbol(token, "(")) depth++;
    if (symbol(token, ")")) depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function keyword(token: SqlToken | undefined, value: string): boolean {
  return token?.kind === "word" && token.value.toUpperCase() === value;
}

function symbol(token: SqlToken | undefined, value: string): boolean {
  return token?.kind === "symbol" && token.value === value;
}

function identifier(token: SqlToken | undefined): boolean {
  return token?.kind === "word" || token?.kind === "quoted_identifier";
}

function statementPreview(tokens: SqlToken[]): string {
  const words = tokens
    .filter((token) => token.kind === "word")
    .slice(0, 6)
    .map((token) => token.value.toUpperCase());
  return words.join(" ") || "unrecognized statement";
}

function strictGeneralValidationIssue(message: string): boolean {
  return message.includes("Migration file is too large");
}

/**
 * Supplement the legacy regex validator with token-aware convention checks.
 * Its CREATE TABLE matcher does not understand bracketed or schema-qualified
 * names, which must not become a connected-builder escape from tenant data
 * isolation.
 */
function strictTenantConventionIssues(statements: SqlToken[][]): string[] {
  const tables = new Map<
    string,
    { displayName: string; hasUserId: boolean }
  >();
  const userIdIndexes = new Set<string>();

  for (const tokens of statements) {
    if (keyword(tokens[0], "CREATE") && keyword(tokens[1], "TABLE")) {
      let index = consumeIfNotExists(tokens, 2);
      const table = readQualifiedIdentifier(tokens, index);
      if (!table) continue;
      index = table.next;
      if (!symbol(tokens[index], "(")) continue;
      const closing = matchingClosingParen(tokens, index);
      if (closing < 0) continue;

      const columns = splitTopLevelTokenLists(tokens, index + 1, closing);
      const hasUserId = columns.some((column) =>
        normalizedIdentifier(column[0]) === "user_id"
      );
      tables.set(table.canonical, {
        displayName: table.displayName,
        hasUserId,
      });
      continue;
    }

    let indexStart = -1;
    if (keyword(tokens[0], "CREATE") && keyword(tokens[1], "INDEX")) {
      indexStart = 2;
    } else if (
      keyword(tokens[0], "CREATE") && keyword(tokens[1], "UNIQUE") &&
      keyword(tokens[2], "INDEX")
    ) {
      indexStart = 3;
    }
    if (indexStart < 0) continue;

    const index = consumeIfNotExists(tokens, indexStart);
    const indexName = readQualifiedIdentifier(tokens, index);
    if (!indexName || !keyword(tokens[indexName.next], "ON")) continue;
    const table = readQualifiedIdentifier(tokens, indexName.next + 1);
    if (!table || !symbol(tokens[table.next], "(")) continue;
    const closing = matchingClosingParen(tokens, table.next);
    if (closing < 0) continue;
    const indexedColumns = splitTopLevelTokenLists(
      tokens,
      table.next + 1,
      closing,
    );
    if (normalizedIdentifier(indexedColumns[0]?.[0]) === "user_id") {
      userIdIndexes.add(table.canonical);
    }
  }

  const issues: string[] = [];
  for (const [canonical, table] of tables) {
    if (table.displayName.startsWith("_")) continue;
    if (!table.hasUserId) {
      issues.push(
        `Table "${table.displayName}" must include a "user_id TEXT NOT NULL" column. All tables must support per-user data isolation.`,
      );
    }
    if (!userIdIndexes.has(canonical)) {
      issues.push(
        `Table "${table.displayName}" should have an index on user_id: CREATE INDEX idx_${table.displayName}_user ON ${table.displayName}(user_id);`,
      );
    }
  }
  return issues;
}

function readQualifiedIdentifier(
  tokens: SqlToken[],
  start: number,
): { next: number; canonical: string; displayName: string } | null {
  const first = decodedIdentifier(tokens[start]);
  if (first === null) return null;
  let index = start + 1;
  let last = first;
  if (symbol(tokens[index], ".")) {
    const second = decodedIdentifier(tokens[index + 1]);
    if (second === null) return null;
    last = second;
    index += 2;
  }
  return {
    next: index,
    canonical: last.toLowerCase(),
    displayName: last,
  };
}

function decodedIdentifier(token: SqlToken | undefined): string | null {
  if (!token || !identifier(token)) return null;
  if (token.kind === "word") return token.value;
  const opening = token.value[0];
  const closing = opening === "[" ? "]" : opening;
  const inner = token.value.slice(1, -1);
  return closing === "]" ? inner : inner.split(closing + closing).join(closing);
}

function normalizedIdentifier(token: SqlToken | undefined): string | null {
  return decodedIdentifier(token)?.toLowerCase() ?? null;
}

function splitTopLevelTokenLists(
  tokens: SqlToken[],
  start: number,
  end: number,
): SqlToken[][] {
  const lists: SqlToken[][] = [];
  let current: SqlToken[] = [];
  let depth = 0;
  for (let index = start; index < end; index++) {
    const token = tokens[index];
    if (symbol(token, "(")) depth++;
    if (symbol(token, ")")) depth--;
    if (depth === 0 && symbol(token, ",")) {
      if (current.length > 0) lists.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) lists.push(current);
  return lists;
}
