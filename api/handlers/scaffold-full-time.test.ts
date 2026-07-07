// The full-time scaffold's whole value is that it emits a DEPLOYABLE loop in
// one command: tick() runs the goal → journal → observe → reason → act →
// record cycle as-is, the manifest ships a routine template with budget
// defaults and flight_recorder on, and the journal migration follows the
// per-user D1 conventions. These pin that contract.

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { executeScaffold } from "./platform-mcp.ts";
import { validateManifest } from "../../shared/contracts/manifest.ts";

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
  // The failure path journals too (outcome = "error"), so a broken wake is
  // still visible to the next wake.
  assert(index.includes('outcome = "error"'), "journals reasoning failures");
  // Extension points are marked for the developer.
  assertEquals(index.split("EXTENSION POINT").length, 3, "two extension points");
});

Deno.test("full-time scaffold: manifest passes the real validator with routine template + flight recorder", () => {
  const manifest = JSON.parse(file(scaffold(true), "manifest.json"));

  assertEquals(manifest.flight_recorder, true);
  assertEquals(manifest.permissions, ["ai:call"]);
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

Deno.test("full-time scaffold: journal migration follows the per-user D1 conventions", () => {
  const sql = file(scaffold(true), "migrations/001_journal.sql");
  assert(sql.includes("CREATE TABLE journal"), "creates the journal table");
  assert(sql.includes("user_id TEXT NOT NULL"), "user_id column (scoped D1)");
  assert(sql.includes("created_at"), "created_at column");
  assert(sql.includes("updated_at"), "updated_at column");
  // `trigger` is a SQLite keyword — the column must be wake_trigger.
  assert(sql.includes("wake_trigger"), "avoids the reserved column name");
  assert(sql.includes("idx_journal_user"), "user index");
});

Deno.test("full-time scaffold: next steps teach the activation path", () => {
  const result = scaffold(true);
  const steps = result.next_steps.join("\n");
  assert(steps.includes("gx.test"), "test a wake first");
  assert(steps.includes("_routine"), "shows how to simulate a wake");
  assert(steps.includes("gx.upload"), "deploy");
  assert(steps.includes("intent"), "mission goes in the routine intent");
  assert(steps.includes("resume"), "routines are created paused");
});
