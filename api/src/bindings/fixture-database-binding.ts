import { WorkerEntrypoint } from "cloudflare:workers";

import {
  buildD1FixtureMissMessage,
  buildD1FixtureWriteResult,
  type D1FixtureMethod,
  findD1TestFixtureResponse,
  type D1TestFixtureConfig,
} from "../../services/d1-test-fixtures.ts";
import {
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
import type { ScopedBatchOp } from "./database-binding.ts";

interface FixtureDatabaseBindingProps {
  appId: string;
  userId: string;
  fixtures: D1TestFixtureConfig;
}

// A fixed scope for validation only — gx.test never touches a real DB, but we
// run every op through the same builder so invalid tables/columns fail in test
// exactly as they would in production.
const TEST_SCOPE = "gx-test-user";

export class FixtureDatabaseBinding extends WorkerEntrypoint<
  unknown,
  FixtureDatabaseBindingProps
> {
  private lookup(
    method: D1FixtureMethod,
    op: Record<string, unknown>,
  ) {
    const table = typeof op.table === "string" ? op.table : undefined;
    const response = findD1TestFixtureResponse(this.ctx.props.fixtures, {
      method,
      table,
      op,
    });
    if (!response) {
      throw new Error(buildD1FixtureMissMessage({ method, table, op }));
    }
    return response;
  }

  async select(op: SelectOp): Promise<Record<string, unknown>[]> {
    buildSelect(op, TEST_SCOPE); // validate op (throws on bad table/column)
    const r = this.lookup("select", op as unknown as Record<string, unknown>);
    return Array.isArray(r.result)
      ? (r.result as Record<string, unknown>[])
      : [];
  }

  async first(op: SelectOp): Promise<Record<string, unknown> | null> {
    buildSelect({ ...op, limit: 1 }, TEST_SCOPE);
    const r = this.lookup("first", op as unknown as Record<string, unknown>);
    return (r.result as Record<string, unknown> | null) ?? null;
  }

  async count(op: CountOp): Promise<number> {
    buildCount(op, TEST_SCOPE);
    const r = this.lookup("count", op as unknown as Record<string, unknown>);
    return Number(r.result ?? 0);
  }

  async insert(op: InsertOp) {
    buildInsert(op, TEST_SCOPE);
    const r = this.lookup("insert", op as unknown as Record<string, unknown>);
    return buildD1FixtureWriteResult(r.result, true);
  }

  async update(op: UpdateOp) {
    buildUpdate(op, TEST_SCOPE);
    const r = this.lookup("update", op as unknown as Record<string, unknown>);
    return buildD1FixtureWriteResult(r.result);
  }

  async delete(op: DeleteOp) {
    buildDelete(op, TEST_SCOPE);
    const r = this.lookup("delete", op as unknown as Record<string, unknown>);
    return buildD1FixtureWriteResult(r.result);
  }

  async upsert(op: UpsertOp) {
    buildUpsert(op, TEST_SCOPE);
    const r = this.lookup("upsert", op as unknown as Record<string, unknown>);
    return buildD1FixtureWriteResult(r.result);
  }

  async batch(ops: ScopedBatchOp[]) {
    if (!Array.isArray(ops)) {
      throw new Error("galactic.db.batch expects an array of write operations.");
    }
    // Validate each op through the builder for prod parity.
    for (const op of ops) validateBatchOp(op);
    const response = this.lookup("batch", { ops } as Record<string, unknown>);
    const canned = Array.isArray(response.result) ? response.result : [];
    return ops.map((_, i) => buildD1FixtureWriteResult(canned[i]));
  }
}

function validateBatchOp(op: ScopedBatchOp): void {
  switch (op?.op) {
    case "insert":
      buildInsert(op, TEST_SCOPE);
      return;
    case "update":
      buildUpdate(op, TEST_SCOPE);
      return;
    case "delete":
      buildDelete(op, TEST_SCOPE);
      return;
    case "upsert":
      buildUpsert(op, TEST_SCOPE);
      return;
    default:
      throw new Error(
        `galactic.db.batch: each operation needs op: "insert" | "update" | ` +
          `"delete" | "upsert".`,
      );
  }
}
