// The full-time scaffold's whole value is that it emits a DEPLOYABLE loop in
// one command: tick() runs the goal → journal → observe → reason → act →
// record cycle as-is, the manifest ships a routine template with budget
// defaults and flight_recorder on, and the journal migration follows the
// per-user D1 conventions. These pin that contract.

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";
import ts from "typescript";
import {
  executeScaffold,
  resolveUlTestRuntimeManifest,
} from "./platform-mcp.ts";
import { validateManifest } from "../../shared/contracts/manifest.ts";
import {
  buildD1FixtureWriteResult,
  findD1TestFixtureResponse,
  resolveD1TestFixtureConfig,
} from "../services/d1-test-fixtures.ts";
import {
  createUlTestAiResponse,
  createUlTestNotifyResponse,
} from "../services/ul-test-runtime.ts";

type ScaffoldResult = {
  files: Array<{ path: string; content: string }>;
  next_steps: string[];
  tip: string;
};

function scaffold(fullTime: boolean): ScaffoldResult {
  return executeScaffold({
    name: "Inbox Keeper",
    description: "Keeps my inbox triaged.",
    full_time: fullTime,
  }) as ScaffoldResult;
}

function file(result: ScaffoldResult, path: string): string {
  const found = result.files.find((f) => f.path === path);
  assert(found, `${path} is emitted`);
  return found!.content;
}

Deno.test("full-time scaffold: opt-in — the generic scaffold is unchanged without the flag", () => {
  const generic = scaffold(false);
  const index = file(generic, "index.ts");
  assert(index.includes("scaffoldResponse"), "generic scaffold keeps placeholders");
  assert(!index.includes("galactic.runs.recent"), "no loop code unless requested");
  const manifest = JSON.parse(file(generic, "manifest.json"));
  assertEquals(manifest.flight_recorder, undefined);
  assertEquals(manifest.routines, undefined);
});

Deno.test("full-time scaffold: emits the complete file set", () => {
  const paths = scaffold(true).files.map((f) => f.path).sort();
  assertEquals(paths, [
    ".ultralightrc.json",
    "index.ts",
    "manifest.json",
    "migrations/001_journal.sql",
  ]);
});

Deno.test("full-time scaffold: tick() implements the whole loop, for real", () => {
  const index = file(scaffold(true), "index.ts");
  // Exports.
  assert(index.includes("export async function tick("), "exports tick");
  assert(index.includes("export async function status("), "exports status");
  assert(!index.includes("scaffoldResponse"), "no placeholder responses");
  // Goal: routine intent → config.goal → universal env var.
  assert(index.includes("wake.intent"), "reads args._routine.intent");
  assert(index.includes("galactic.env.GOAL"), "env-var goal fallback");
  // Review: own journal + platform flight-recorder read-back.
  assert(index.includes('galactic.db.select("journal"'), "re-reads the journal");
  assert(index.includes("galactic.runs.recent"), "reads recorded run truth");
  // Reason + record.
  assert(index.includes("galactic.ai("), "reasons with ai()");
  assert(index.includes('galactic.db.insert("journal"'), "journals every wake");
  assert(index.includes("galactic.notify("), "reports anomalies and milestones");
  // The failure path journals, reports, and then throws. A broken wake remains
  // visible while the durable executor truthfully retries/trips its breaker.
  assert(index.includes('outcome = "error"'), "journals reasoning failures");
  assert(index.includes("throw failure"), "surfaces failure to the executor");
  // Extension points are marked for the developer.
  assertEquals(index.split("EXTENSION POINT").length, 3, "two extension points");
});

Deno.test("full-time scaffold: manifest passes the real validator with routine template + flight recorder", () => {
  const manifest = JSON.parse(file(scaffold(true), "manifest.json"));

  assertEquals(manifest.flight_recorder, true);
  assertEquals(manifest.permissions, ["ai:call", "notify:owner"]);
  // Functions match the exports.
  assert(manifest.functions.tick, "tick declared");
  assert(manifest.functions.status, "status declared");

  // The routine template: handler wired to tick, schedule + budgets prefilled.
  assertEquals(manifest.routines.length, 1);
  const routine = manifest.routines[0];
  assertEquals(routine.id, "main_loop");
  assertEquals(routine.handler, "tick");
  assertEquals(routine.default_schedule, { every_minutes: 30 });
  assertEquals(routine.budget_defaults, {
    max_light_per_run: 10,
    max_light_per_day: 100,
    max_light_per_month: 1000,
    max_calls_per_run: 10,
  });
  assert(routine.config_schema.goal, "goal declared in config schema");

  const result = validateManifest(manifest);
  assertEquals(
    result.errors,
    [],
    "generated manifest must pass the real validator",
  );
  assertEquals(result.valid, true);
});

Deno.test("full-time scaffold: gx.test derives only declared runtime authority", () => {
  const generated = scaffold(true);
  assertEquals(resolveUlTestRuntimeManifest(generated.files), {
    permissions: ["ai:call", "notify:owner"],
    allowedDestinations: [],
  });
  assertEquals(
    resolveUlTestRuntimeManifest([
      { path: "manifest.json", content: "{not valid json" },
    ]),
    { permissions: [], allowedDestinations: [] },
    "malformed manifests stay default-deny",
  );
  assertEquals(resolveUlTestRuntimeManifest([]), {
    permissions: [],
    allowedDestinations: [],
  });
});

Deno.test("full-time scaffold: journal migration follows the per-user D1 conventions", () => {
  const sql = file(scaffold(true), "migrations/001_journal.sql");
  assert(sql.includes("CREATE TABLE journal"), "creates the journal table");
  assert(sql.includes("user_id TEXT NOT NULL"), "user_id column (scoped D1)");
  assert(sql.includes("created_at"), "created_at column");
  assert(sql.includes("updated_at"), "updated_at column");
  assert(sql.includes("planned_actions"), "separates plans from completed actions");
  // `trigger` is a SQLite keyword — the column must be wake_trigger.
  assert(sql.includes("wake_trigger"), "avoids the reserved column name");
  assert(sql.includes("idx_journal_user"), "user index");
});

Deno.test("full-time scaffold: next steps teach the activation path", () => {
  const result = scaffold(true);
  const steps = result.next_steps.join("\n");
  assert(steps.includes("gx.test"), "test a wake first");
  assert(steps.includes("_routine"), "shows how to simulate a wake");
  assert(steps.includes("d1_fixtures"), "stubs journal D1 before deploy");
  assert(steps.includes('method: "select"'), "stubs journal reads");
  assert(steps.includes('method: "insert"'), "stubs journal writes");
  assert(steps.includes("gx.upload"), "deploy");
  assert(
    steps.includes("test_attestation: tested.test_attestation"),
    "carries successful test proof into the exact upload",
  );
  assert(steps.includes("intent"), "mission goes in the routine intent");
  assert(steps.includes("paused"), "routines are created paused");
  assert(steps.includes("owner"), "owner must approve and activate");
});

Deno.test("full-time scaffold: one gx.test-style wake executes DB + AI and can report safely", async () => {
  const generated = scaffold(true);
  const javascript = ts.transpileModule(file(generated, "index.ts"), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const fixtures = resolveD1TestFixtureConfig({
    responses: [
      { method: "select", table: "journal", result: [] },
      {
        method: "insert",
        table: "journal",
        result: { success: true, meta: { changes: 1 } },
      },
    ],
  });
  assert(fixtures);

  const calls = { select: 0, insert: 0, ai: 0, notify: 0 };
  let failAi = false;
  const testGalactic = {
    env: {},
    runs: { recent: async () => ({ runs: [] }) },
    db: {
      select: async (table: string, query: Record<string, unknown>) => {
        calls.select++;
        const op = { table, ...(query || {}) };
        const fixture = findD1TestFixtureResponse(fixtures, {
          method: "select",
          table,
          op,
        });
        if (!fixture) throw new Error("missing select fixture");
        return Array.isArray(fixture.result) ? fixture.result : [];
      },
      insert: async (table: string, values: Record<string, unknown>) => {
        calls.insert++;
        const op = { table, values };
        const fixture = findD1TestFixtureResponse(fixtures, {
          method: "insert",
          table,
          op,
        });
        if (!fixture) throw new Error("missing insert fixture");
        return buildD1FixtureWriteResult(fixture.result, true);
      },
    },
    ai: async () => {
      calls.ai++;
      if (failAi) throw new Error("forced gx.test AI failure");
      return createUlTestAiResponse();
    },
    notify: async () => {
      calls.notify++;
      return createUlTestNotifyResponse();
    },
  };
  const testGlobal = globalThis as typeof globalThis & {
    galactic?: typeof testGalactic;
  };
  const previousGalactic = testGlobal.galactic;
  testGlobal.galactic = testGalactic;

  try {
    const moduleUrl = "data:text/javascript;charset=utf-8," +
      encodeURIComponent(javascript) + "#" + crypto.randomUUID();
    const agent = await import(moduleUrl) as {
      tick: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const wake = {
      _routine: {
        routine_id: "routine-1",
        routine_run_id: "run-1",
        trace_id: "trace-1",
        trigger: "manual",
        attempt: 1,
        scheduled_at: new Date(0).toISOString(),
        intent: "Keep the inbox triaged.",
      },
    };

    const result = await agent.tick(wake);
    assertEquals(result.ok, true);
    assertEquals(calls, { select: 1, insert: 1, ai: 1, notify: 0 });

    // The generated failure path journals, invokes the same no-op test notify
    // capability, and then rethrows so production retry semantics stay honest.
    failAi = true;
    await assertRejects(
      () => agent.tick(wake),
      Error,
      "forced gx.test AI failure",
    );
    assertEquals(calls, { select: 2, insert: 2, ai: 2, notify: 1 });
  } finally {
    if (previousGalactic === undefined) delete testGlobal.galactic;
    else testGlobal.galactic = previousGalactic;
  }
});
