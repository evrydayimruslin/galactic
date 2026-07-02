// RPC Database Binding for Dynamic Workers
// Wraps D1 HTTP API calls behind a WorkerEntrypoint.
// The Dynamic Worker sees env.DB.select()/insert()/... but never sees CF
// credentials AND never runs raw SQL.
//
// Two security boundaries live here:
//  1. Credentials (CF_ACCOUNT_ID, CF_API_TOKEN) stay in the parent Worker; the
//     Dynamic Worker only reaches the structured methods exposed below.
//  2. Per-user isolation: the app passes a STRUCTURED op (table/columns/where);
//     the SQL is built HOST-SIDE by scoped-query.ts with `user_id = ?` injected
//     from ctx.props.userId on every table. App code cannot supply raw SQL or
//     user_id, so it can never read or write another user's rows. (Phase 5.)

import { WorkerEntrypoint } from "cloudflare:workers";
import { getEnv } from "../../lib/env.ts";
import type { BillingConfig } from "../../services/billing-config.ts";
import {
  type CloudOperationMeteringContext,
  debitD1Usage,
} from "../../services/cloud-usage.ts";
import {
  type BuiltQuery,
  buildCount,
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
  buildUpsert,
  type CountOp,
  type DeleteOp,
  type InsertOp,
  type SelectOp,
  type UpdateOp,
  type UpsertOp,
} from "./scoped-query.ts";

export type ScopedBatchOp =
  | ({ op: "insert" } & InsertOp)
  | ({ op: "update" } & UpdateOp)
  | ({ op: "delete" } & DeleteOp)
  | ({ op: "upsert" } & UpsertOp);

// ============================================
// TYPES
// ============================================

interface DatabaseBindingProps {
  databaseId: string;
  appId: string;
  userId: string;
  operationMetering?: CloudOperationMeteringContext | null;
  operationBillingConfig?:
    | Pick<
      BillingConfig,
      | "version"
      | "cloudUnitLightPer1k"
      | "d1ReadRowsPerCloudUnit"
      | "d1WriteRowsPerCloudUnit"
    >
    | null;
}

interface D1QueryResult {
  success: boolean;
  results: Record<string, unknown>[];
  meta: {
    changes: number;
    last_row_id: number;
    duration: number;
    rows_read: number;
    rows_written: number;
  };
}

// ============================================
// RPC BINDING
// ============================================

export class DatabaseBinding
  extends WorkerEntrypoint<unknown, DatabaseBindingProps> {
  private async meterD1Result(
    sql: string,
    meta: D1QueryResult["meta"] | undefined,
  ): Promise<void> {
    const metering = this.ctx.props.operationMetering;
    if (!metering || !meta) {
      return;
    }

    await debitD1Usage({
      ...metering,
      operation: classifyD1Operation(sql),
      rowsRead: meta.rows_read ?? 0,
      rowsWritten: meta.rows_written ?? 0,
      billingConfig: this.ctx.props.operationBillingConfig ?? undefined,
      metadata: {
        ...(metering.metadata ?? {}),
        binding: "DatabaseBinding",
        sql_operation: classifyD1Operation(sql),
      },
    });
  }

  /**
   * Execute a D1 query via the Cloudflare HTTP API.
   * Credentials (CF_ACCOUNT_ID, CF_API_TOKEN) are read from the parent Worker's env,
   * never exposed to the Dynamic Worker.
   */
  private async queryD1(
    sql: string,
    params: unknown[] = [],
  ): Promise<D1QueryResult> {
    const cfAccountId = getEnv("CF_ACCOUNT_ID");
    const cfApiToken = getEnv("CF_API_TOKEN");
    const { databaseId } = this.ctx.props;

    if (!cfAccountId || !cfApiToken) {
      throw new Error(
        "D1 not configured: missing CF_ACCOUNT_ID or CF_API_TOKEN",
      );
    }

    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/d1/database/${databaseId}/query`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${cfApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql, params }),
      },
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`D1 query failed (${res.status}): ${errText}`);
    }

    const data = await res.json() as {
      success: boolean;
      errors: Array<{ message: string }>;
      result: D1QueryResult[];
    };

    if (!data.success) {
      const errMsg = data.errors?.[0]?.message || "Unknown D1 error";
      throw new Error(`D1 query error: ${errMsg}`);
    }

    const result = data.result?.[0] || {
      success: true,
      results: [],
      meta: {
        changes: 0,
        last_row_id: 0,
        duration: 0,
        rows_read: 0,
        rows_written: 0,
      },
    };

    await this.meterD1Result(sql, result.meta);
    return result;
  }

  // ── Scoped structured API (galactic.db.*) ──
  // Every method builds SQL host-side via scoped-query.ts, injecting the caller's
  // user_id from ctx.props. Raw SQL never crosses this boundary.

  private get scopeUserId(): string {
    return this.ctx.props.userId;
  }

  private shapeMeta(meta: D1QueryResult["meta"] | undefined) {
    return {
      changes: meta?.changes ?? 0,
      last_row_id: meta?.last_row_id ?? 0,
      duration: meta?.duration ?? 0,
      rows_read: meta?.rows_read ?? 0,
      rows_written: meta?.rows_written ?? 0,
    };
  }

  private async runBuilt(built: BuiltQuery): Promise<D1QueryResult> {
    return await this.queryD1(built.sql, built.params);
  }

  async select(op: SelectOp): Promise<Record<string, unknown>[]> {
    const r = await this.runBuilt(buildSelect(op, this.scopeUserId));
    return r.results ?? [];
  }

  async first(op: SelectOp): Promise<Record<string, unknown> | null> {
    const r = await this.runBuilt(
      buildSelect({ ...op, limit: 1 }, this.scopeUserId),
    );
    return r.results?.[0] ?? null;
  }

  async count(op: CountOp): Promise<number> {
    const r = await this.runBuilt(buildCount(op, this.scopeUserId));
    const row = r.results?.[0] as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  async insert(op: InsertOp) {
    const r = await this.runBuilt(buildInsert(op, this.scopeUserId));
    return {
      success: r.success,
      id: r.meta?.last_row_id ?? 0,
      meta: this.shapeMeta(r.meta),
    };
  }

  async update(op: UpdateOp) {
    const r = await this.runBuilt(buildUpdate(op, this.scopeUserId));
    return { success: r.success, meta: this.shapeMeta(r.meta) };
  }

  async delete(op: DeleteOp) {
    const r = await this.runBuilt(buildDelete(op, this.scopeUserId));
    return { success: r.success, meta: this.shapeMeta(r.meta) };
  }

  async upsert(op: UpsertOp) {
    const r = await this.runBuilt(buildUpsert(op, this.scopeUserId));
    return { success: r.success, meta: this.shapeMeta(r.meta) };
  }

  async batch(ops: ScopedBatchOp[]) {
    if (!Array.isArray(ops)) {
      throw new Error("galactic.db.batch expects an array of write operations.");
    }
    // Sequential, non-transactional — the D1 REST API has no batch transaction.
    const results = [];
    for (const op of ops) {
      results.push(await this.dispatchWrite(op));
    }
    return results;
  }

  private async dispatchWrite(op: ScopedBatchOp) {
    switch (op?.op) {
      case "insert":
        return await this.insert(op);
      case "update":
        return await this.update(op);
      case "delete":
        return await this.delete(op);
      case "upsert":
        return await this.upsert(op);
      default:
        throw new Error(
          `galactic.db.batch: each operation needs op: "insert" | "update" | ` +
            `"delete" | "upsert" (got ${JSON.stringify((op as { op?: unknown })?.op)}).`,
        );
    }
  }
}

function classifyD1Operation(sql: string): string {
  return sql.trim().split(/\s+/, 1)[0]?.toLowerCase() || "query";
}
