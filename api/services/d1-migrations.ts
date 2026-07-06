// D1 Migration Service
// Parses numbered SQL migration files from app bundles and applies them to the app's D1 database.
// Tracks applied migrations in the _migrations system table.
// Validates schemas (user_id requirement) at deploy time.

import { getEnv } from '../lib/env.ts';
import { executeD1Sql, type D1QueryResponse } from './d1-provisioning.ts';

// ============================================
// TYPES
// ============================================

export interface MigrationFile {
  version: number;
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: number;
  skipped: number;
  errors: string[];
  lastVersion: number;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ============================================
// MIGRATION PARSING
// ============================================

/**
 * Parse migration files from a filename → content map.
 * Expects filenames like "001_initial.sql", "002_add_category.sql".
 * Returns sorted list by version number.
 */
export function parseMigrationFiles(
  files: Record<string, string>
): MigrationFile[] {
  const migrations: MigrationFile[] = [];

  for (const [filename, content] of Object.entries(files)) {
    // Extract version number from filename: "001_initial.sql" → 1
    const match = filename.match(/^(\d+)[_\-].*\.sql$/);
    if (!match) {
      console.warn(`[D1-MIGRATIONS] Skipping non-migration file: ${filename}`);
      continue;
    }

    const version = parseInt(match[1], 10);
    if (isNaN(version) || version <= 0) {
      console.warn(`[D1-MIGRATIONS] Invalid version number in: ${filename}`);
      continue;
    }

    const checksum = computeChecksum(content);
    migrations.push({ version, filename, sql: content.trim(), checksum });
  }

  // Sort by version number
  migrations.sort((a, b) => a.version - b.version);

  // Check for duplicate versions
  const versions = new Set<number>();
  for (const m of migrations) {
    if (versions.has(m.version)) {
      throw new Error(`Duplicate migration version ${m.version}: ${m.filename}`);
    }
    versions.add(m.version);
  }

  return migrations;
}

/**
 * Simple checksum for migration content.
 * Uses FNV-1a hash for speed (not cryptographic — just for drift detection).
 */
function computeChecksum(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ============================================
// MIGRATION RUNNER
// ============================================

/**
 * Run pending migrations against an app's D1 database.
 *
 * Flow:
 * 1. Query _migrations for last applied version
 * 2. Filter to unapplied migrations
 * 3. Check checksums for already-applied migrations (detect tampering)
 * 4. Apply each new migration in order
 * 5. Record in _migrations table
 */
export async function runMigrations(
  databaseId: string,
  migrations: MigrationFile[],
): Promise<MigrationResult> {
  const cfAccountId = getEnv('CF_ACCOUNT_ID');
  const cfApiToken = getEnv('CF_API_TOKEN');

  if (!cfAccountId || !cfApiToken) {
    return { applied: 0, skipped: 0, errors: ['Missing CF_ACCOUNT_ID or CF_API_TOKEN'], lastVersion: 0 };
  }

  if (migrations.length === 0) {
    return { applied: 0, skipped: 0, errors: [], lastVersion: 0 };
  }

  // 1. Get already-applied migrations
  let appliedMigrations: Array<{ version: number; checksum: string }> = [];
  try {
    const result = await executeD1Sql(
      cfAccountId, cfApiToken, databaseId,
      'SELECT version, checksum FROM _migrations ORDER BY version',
    );
    appliedMigrations = (result.result?.[0]?.results ?? []) as unknown as Array<{ version: number; checksum: string }>;
  } catch {
    // _migrations table might not exist yet (first deploy)
    appliedMigrations = [];
  }

  const appliedVersions = new Map(appliedMigrations.map(m => [m.version, m.checksum]));
  const result: MigrationResult = { applied: 0, skipped: 0, errors: [], lastVersion: 0 };

  // 2. Process each migration
  for (const migration of migrations) {
    const existingChecksum = appliedVersions.get(migration.version);

    if (existingChecksum) {
      // Already applied — warn on checksum mismatch but continue processing
      if (existingChecksum !== migration.checksum) {
        console.warn(
          `[D1-MIGRATIONS] Checksum drift: ${migration.filename} (v${migration.version}) ` +
          `expected ${existingChecksum}, got ${migration.checksum}. Skipping (already applied).`
        );
      }
      result.skipped++;
      result.lastVersion = migration.version;
      continue;
    }

    // 3. Apply new migration
    try {
      await executeD1Sql(cfAccountId, cfApiToken, databaseId, migration.sql);

      // Record in _migrations
      await executeD1Sql(
        cfAccountId, cfApiToken, databaseId,
        'INSERT INTO _migrations (version, filename, checksum) VALUES (?, ?, ?)',
        [migration.version, migration.filename, migration.checksum],
      );

      result.applied++;
      result.lastVersion = migration.version;
      console.log(`[D1-MIGRATIONS] Applied: ${migration.filename} (v${migration.version})`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Migration ${migration.filename} failed: ${errMsg}`);
      console.error(`[D1-MIGRATIONS] Failed: ${migration.filename}:`, errMsg);
      break; // Stop on first error
    }
  }

  return result;
}

// ============================================
// SCHEMA VALIDATION
// ============================================

/**
 * Maximum size of a single migration .sql file accepted by the validator.
 * The validator runs several regexes synchronously over attacker-supplied SQL
 * at upload time (a mandatory gate). The only upstream cap is the 50MB TOTAL
 * upload budget, which is far too large for a single file to scan safely — a
 * multi-megabyte file can burn seconds of CPU. Cap per file well below that.
 */
export const MAX_MIGRATION_FILE_BYTES = 256 * 1024; // 256KB per .sql file

/**
 * Reserved (system) tables are prefixed with `_`. App migrations may never
 * write to them: forging rows in e.g. `_usage` / `_migrations` would corrupt
 * cross-user usage/quota attribution and migration bookkeeping.
 */
function isReservedTable(name: string): boolean {
  return name.startsWith('_');
}

/**
 * Split SQL into individual statements on `;`, ignoring semicolons that appear
 * inside string literals. Comments are assumed already stripped by the caller.
 * This is a pragmatic tokenizer (no full SQL grammar) sufficient to bound each
 * validation regex to a single statement — which both defuses the O(N^2) ReDoS
 * of cross-statement `[\s\S]*?` scanning and lets us inspect DML per-target.
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: string | null = null; // active string delimiter: ' " or `
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      current += ch;
      if (ch === quote) {
        // Handle SQL-style doubled-quote escape ('' inside a '...' literal)
        if (sql[i + 1] === quote) {
          current += sql[i + 1];
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current);
  return statements;
}

/**
 * Split a CREATE TABLE column block on top-level commas, ignoring commas nested
 * inside parentheses (e.g. `DECIMAL(10, 2)`, `CHECK (x IN (1, 2))`) or string
 * literals. Used to isolate individual column definitions for validation.
 */
function splitTopLevel(columns: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < columns.length; i++) {
    const ch = columns[i];
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (columns[i + 1] === quote) { current += columns[i + 1]; i++; }
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { if (depth > 0) depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Validate migration SQL for Galactic conventions.
 * Called at deploy time (upload handler) before storing migrations.
 *
 * Rules:
 * - Every CREATE TABLE (except system tables starting with _) must have user_id TEXT NOT NULL
 * - No DROP TABLE; no ALTER TABLE ... DROP COLUMN (destructive, breaks rollback compatibility)
 * - No PRAGMA / ATTACH DATABASE (security risk)
 * - No INSERT/UPDATE/DELETE targeting a reserved `_`-prefixed system table
 * - DROP INDEX, RENAME, and DELETE FROM are warned (non-additive / mutate data at deploy)
 */
export function validateMigrationSchema(sql: string): SchemaValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Size guard FIRST — before any regex runs — so an oversized file cannot be
  // used as a ReDoS / CPU-exhaustion vector against the upload gate.
  const byteLength = new TextEncoder().encode(sql).length;
  if (byteLength > MAX_MIGRATION_FILE_BYTES) {
    return {
      valid: false,
      errors: [
        `Migration file is too large (${byteLength} bytes). ` +
        `Each .sql file must be at most ${MAX_MIGRATION_FILE_BYTES} bytes ` +
        `(${MAX_MIGRATION_FILE_BYTES / 1024}KB). Split large migrations into ` +
        `separate numbered files.`,
      ],
      warnings: [],
    };
  }

  const normalized = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); // Strip comments

  // Tokenize into statements once, up front. Every subsequent statement-level
  // check runs per-statement so no regex can scan across statement boundaries.
  const statements = splitSqlStatements(normalized);

  // Check every CREATE TABLE for user_id
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([\s\S]*?)\)/gi;
  let match;
  while ((match = createTableRegex.exec(normalized)) !== null) {
    const tableName = match[1];
    const columns = match[2];

    // Skip system tables
    if (isReservedTable(tableName)) continue;

    // Require a real column literally named user_id — not a substring match
    // (which `not_user_id`, a DEFAULT value, or a CHECK expression could
    // satisfy). Split the column block on top-level commas and look for a
    // definition whose first identifier token is exactly `user_id`.
    const hasUserIdColumn = splitTopLevel(columns).some((def) =>
      /^\s*["`]?user_id["`]?\s/i.test(def)
    );
    if (!hasUserIdColumn) {
      errors.push(
        `Table "${tableName}" must include a "user_id TEXT NOT NULL" column. ` +
        `All tables must support per-user data isolation.`
      );
    }

    // Check for user_id index
    const indexRegex = new RegExp(
      `CREATE\\s+INDEX.*ON\\s+["\`]?${tableName}["\`]?\\s*\\(\\s*user_id`,
      'i'
    );
    if (!indexRegex.test(normalized)) {
      warnings.push(
        `Table "${tableName}" should have an index on user_id: ` +
        `CREATE INDEX idx_${tableName}_user ON ${tableName}(user_id);`
      );
    }
  }

  // Check for destructive operations
  if (/DROP\s+TABLE/i.test(normalized)) {
    errors.push('DROP TABLE is not allowed in migrations. Remove the statement and create a new migration if restructuring.');
  }

  // Non-additive schema changes break rollback compatibility: an older code
  // version promoted via gx.set may still reference a column a later migration
  // removed or renamed. Keep migrations additive. Check per-statement so the
  // regex is bounded to a single ALTER TABLE (no cross-statement backtracking).
  for (const stmt of statements) {
    if (/\bALTER\s+TABLE\b[^;]*?\bDROP\s+COLUMN\b/i.test(stmt)) {
      errors.push('ALTER TABLE ... DROP COLUMN is not allowed in migrations. Dropping a column breaks older code versions if they are rolled back to. Keep migrations additive.');
      break;
    }
  }

  // Reject any DML (INSERT/UPDATE/DELETE) that targets a reserved `_`-prefixed
  // system table (e.g. _usage, _migrations). A migration writing to _usage can
  // forge cross-user usage/quota attribution; writing to _migrations corrupts
  // bookkeeping. These statements are never legitimate in an app migration.
  for (const stmt of statements) {
    const target =
      stmt.match(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`]?(\w+)["`]?/i) ??
      stmt.match(/\bUPDATE\s+["`]?(\w+)["`]?/i) ??
      stmt.match(/\bDELETE\s+FROM\s+["`]?(\w+)["`]?/i);
    if (target && isReservedTable(target[1])) {
      errors.push(
        `Writing to reserved system table "${target[1]}" is not allowed in migrations. ` +
        `Tables prefixed with "_" are managed by the platform.`
      );
    }
  }
  if (/DROP\s+INDEX/i.test(normalized)) {
    warnings.push('DROP INDEX in a migration is irreversible at the schema level — prefer leaving indexes in place or replacing them within the same migration.');
  }
  if (/\bRENAME\b/i.test(normalized)) {
    warnings.push('RENAME (TABLE/COLUMN) is a non-additive change; older code rolled back via gx.set will reference the old name. Prefer add-new + backfill + (later) remove.');
  }
  if (/DELETE\s+FROM/i.test(normalized)) {
    warnings.push('DELETE FROM in a migration mutates user data at deploy time and cannot be undone by a code rollback. Confirm this is intentional.');
  }

  // Check for PRAGMA
  if (/PRAGMA/i.test(normalized)) {
    errors.push('PRAGMA statements are not allowed in migrations (security restriction).');
  }

  // Check for ATTACH DATABASE
  if (/ATTACH\s+DATABASE/i.test(normalized)) {
    errors.push('ATTACH DATABASE is not allowed in migrations (security restriction).');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Update the last migration version in Supabase apps table.
 */
export async function updateMigrationVersion(
  appId: string,
  lastVersion: number,
): Promise<void> {
  const supabaseUrl = getEnv('SUPABASE_URL');
  const supabaseKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseKey) return;

  try {
    await fetch(
      `${supabaseUrl}/rest/v1/apps?id=eq.${appId}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ d1_last_migration_version: lastVersion }),
      }
    );
  } catch (err) {
    console.error(`[D1-MIGRATIONS] Failed to update migration version for ${appId}:`, err);
  }
}
