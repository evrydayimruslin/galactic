// db-inspect capability — an owner's read-only window into their app's D1 data.
//
// Built ENTIRELY from safe primitives so it cannot re-open the dev-sees-user-data
// isolation the platform enforces:
//   - owner-only: resolves the app and requires owner_id === caller (mirrors
//     resolveApp); the caller's userId is server-derived and actor tokens can't
//     reach the platform endpoint.
//   - SELECT-only: schema/counts are fixed templates over validated identifiers;
//     row reads go through buildSelect, which injects `user_id = <caller>` by
//     construction — so an owner sees only THEIR OWN rows, never other users'.
//   - NO raw owner SQL: the unscoped createD1DataService.all is used only with
//     fixed, identifier-guarded templates and scoped-builder output.
//
// Full cross-user read (for support) is intentionally NOT here — that is a
// separate, disclosed + audited owner opt-in (tracked for a later PR).

import { CapabilityError } from "../../../shared/contracts/capabilities.ts";
import type { App } from "../../../shared/types/index.ts";
import { createAppsService } from "../apps.ts";
import { getD1DatabaseId } from "../d1-provisioning.ts";
import { createD1DataService } from "../d1-data.ts";
import { buildSelect } from "../../src/bindings/scoped-query.ts";

// SQLite identifier guard for table names we interpolate into fixed templates.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Resolve an app the caller OWNS (mirrors platform-mcp's resolveApp gate). */
async function resolveOwnedApp(userId: string, appIdOrSlug: string): Promise<App> {
  const apps = createAppsService();
  let app = await apps.findById(appIdOrSlug) as App | null;
  if (!app) app = await apps.findBySlug(userId, appIdOrSlug);
  if (!app) {
    throw new CapabilityError("not_found", `App not found: ${appIdOrSlug}`);
  }
  if (app.owner_id !== userId) {
    throw new CapabilityError("forbidden", "You do not own this app");
  }
  return app;
}

/** List the app's own (non-system) tables. */
async function listUserTables(
  d1: ReturnType<typeof createD1DataService>,
): Promise<string[]> {
  const rows = await d1.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' " +
      "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' " +
      "ORDER BY name",
  );
  // Drop platform system tables (_migrations, _usage, …). IDENT-guard the rest
  // before any is interpolated into a template.
  return rows
    .map((r) => r.name)
    .filter((n) => !n.startsWith("_") && IDENT.test(n));
}

/**
 * Inspect an owned app's D1 database. action:
 *   "schema" (default) — tables + columns.
 *   "counts"          — total row count per table.
 *   "rows"            — the caller's OWN rows for one table (user_id scoped).
 */
export async function inspectAppDatabase(
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const appRef = typeof args.app_id === "string" ? args.app_id.trim() : "";
  if (!appRef) throw new CapabilityError("invalid_input", "app_id is required");
  const action = typeof args.action === "string" ? args.action.trim() : "schema";

  const app = await resolveOwnedApp(userId, appRef);
  const databaseId = await getD1DatabaseId(app.id);
  if (!databaseId) {
    return {
      provisioned: false,
      message: "This app has no D1 database yet (nothing has written to galactic.db).",
    };
  }
  const d1 = createD1DataService(app.id, databaseId);
  const tables = await listUserTables(d1);

  if (action === "schema") {
    const out = [];
    for (const t of tables) {
      const cols = await d1.all<
        { name: string; type: string; notnull: number; pk: number }
      >(`PRAGMA table_info("${t}")`);
      out.push({
        name: t,
        columns: cols.map((c) => ({
          name: c.name,
          type: c.type,
          notnull: !!c.notnull,
          primary_key: !!c.pk,
        })),
      });
    }
    return { provisioned: true, tables: out };
  }

  if (action === "counts") {
    const out = [];
    for (const t of tables) {
      const row = await d1.first<{ count: number }>(
        `SELECT COUNT(*) AS count FROM "${t}"`,
      );
      out.push({ table: t, rows: Number(row?.count ?? 0) });
    }
    return { provisioned: true, counts: out };
  }

  if (action === "rows") {
    const table = typeof args.table === "string" ? args.table.trim() : "";
    if (!table) {
      throw new CapabilityError("invalid_input", 'action "rows" requires a table');
    }
    if (!tables.includes(table)) {
      throw new CapabilityError("not_found", `Table not found: ${table}`);
    }
    const limit = Math.min(Math.max(Number(args.limit ?? 50) || 50, 1), 200);
    // Owner-own-rows: buildSelect injects `WHERE user_id = <caller>` and is
    // SELECT-only by construction. Only the caller's own rows are returned.
    let rows: Record<string, unknown>[];
    try {
      const built = buildSelect({ table, limit }, userId);
      rows = await d1.all(built.sql, built.params);
    } catch (err) {
      // Most likely a legacy table without a user_id column (new tables are
      // required to have one). Surface it rather than leaking anything.
      throw new CapabilityError(
        "invalid_input",
        `Cannot read "${table}" as owner-scoped rows: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return {
      provisioned: true,
      table,
      scope: "own_rows",
      note:
        "Shows only YOUR rows (user_id = you). Reading other users' rows for " +
        "support is a separate, disclosed opt-in.",
      rows,
    };
  }

  throw new CapabilityError(
    "invalid_input",
    `Invalid action: ${action}. Use schema | counts | rows.`,
  );
}
