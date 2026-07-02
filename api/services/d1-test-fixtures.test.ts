import { assertEquals, assertThrows } from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  buildD1FixtureMissMessage,
  buildD1FixtureWriteResult,
  findD1TestFixtureResponse,
  resolveD1TestFixtureConfig,
} from "./d1-test-fixtures.ts";

Deno.test("d1 test fixtures: validates and normalizes the structured config", () => {
  const fixtures = resolveD1TestFixtureConfig({
    responses: [
      { method: "select", table: "items", result: [{ id: "item-1" }] },
      {
        method: "first",
        table: "items",
        when: { where: { id: "item-1" } },
        result: { id: "item-1" },
      },
    ],
  });

  assertEquals(fixtures, {
    responses: [
      { method: "select", table: "items", when: undefined, result: [{ id: "item-1" }] },
      {
        method: "first",
        table: "items",
        when: { where: { id: "item-1" } },
        result: { id: "item-1" },
      },
    ],
  });
});

Deno.test("d1 test fixtures: matches by method + table + optional when subset", () => {
  const fixtures = resolveD1TestFixtureConfig({
    responses: [
      {
        method: "select",
        table: "items",
        when: { where: { status: "done" } },
        result: [{ id: "a" }],
      },
      { method: "select", table: "items", result: [{ id: "fallback" }] },
      { method: "insert", table: "items", result: { meta: { changes: 1 } } },
    ],
  });

  // Specific `when` wins (declared first).
  assertEquals(
    findD1TestFixtureResponse(fixtures, {
      method: "select",
      table: "items",
      op: { table: "items", where: { status: "done" } },
    }),
    fixtures?.responses[0] ?? null,
  );

  // Falls through to the catch-all when `when` does not match.
  assertEquals(
    findD1TestFixtureResponse(fixtures, {
      method: "select",
      table: "items",
      op: { table: "items", where: { status: "open" } },
    }),
    fixtures?.responses[1] ?? null,
  );

  // Method + table must both match.
  assertEquals(
    findD1TestFixtureResponse(fixtures, {
      method: "insert",
      table: "other",
      op: { table: "other" },
    }),
    null,
  );
});

Deno.test("d1 test fixtures: shapes write results and miss messages", () => {
  assertEquals(buildD1FixtureWriteResult(undefined), {
    success: true,
    meta: {
      changes: 0,
      last_row_id: 0,
      duration: 0,
      rows_read: 0,
      rows_written: 0,
    },
  });

  assertEquals(buildD1FixtureWriteResult({ meta: { changes: 1, last_row_id: 7 } }, true), {
    success: true,
    id: 7,
    meta: {
      changes: 1,
      last_row_id: 7,
      duration: 0,
      rows_read: 0,
      rows_written: 0,
    },
  });

  assertEquals(
    buildD1FixtureMissMessage({
      method: "insert",
      table: "items",
      op: { table: "items" },
    }),
    `No D1 fixture matched galactic.db.insert() on "items". Add a d1_fixtures.responses ` +
      `entry with method:"insert", table:"items".`,
  );
});

Deno.test("d1 test fixtures: rejects malformed configs", () => {
  assertThrows(
    () => resolveD1TestFixtureConfig({ responses: [{ method: "bogus" }] }),
    Error,
    "method must be one of",
  );
  assertThrows(
    () => resolveD1TestFixtureConfig({ responses: [{ method: "select", table: 5 }] }),
    Error,
    "table must be a string",
  );
});
