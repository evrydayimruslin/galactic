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
 * Validate migration SQL for Galactic conventions.
 * Called at deploy time (upload handler) before storing migrations.
 *
 * Rules:
 * - Every CREATE TABLE (except system tables starting with _) must have user_id TEXT NOT NULL
 * - No DROP TABLE; no ALTER TABLE ... DROP COLUMN (destructive, breaks rollback compatibility)
 * - No PRAGMA / ATTACH DATABASE (security risk)
 * - DROP INDEX, RENAME, and DELETE FROM are warned (non-additive / mutate data at deploy)
 */
export function validateMigrationSchema(sql: string): SchemaValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const normalized = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); // Strip comments

  // Check every CREATE TABLE for user_id
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([\s\S]*?)\)/gi;
  let match;
  while ((match = createTableRegex.exec(normalized)) !== null) {
    const tableName = match[1];
    const columns = match[2];

    // Skip system tables
    if (tableName.startsWith('_')) continue;

    if (!/user_id/i.test(columns)) {
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
  // removed or renamed. Keep migrations additive.
  if (/ALTER\s+TABLE[\s\S]*?DROP\s+COLUMN/i.test(normalized)) {
    errors.push('ALTER TABLE ... DROP COLUMN is not allowed in migrations. Dropping a column breaks older code versions if they are rolled back to. Keep migrations additive.');
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
