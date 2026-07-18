/**
 * Free Mode — Phase 0 signal tests (docs/FREE_MODE_DESIGN.md).
 *
 * Covers the unified threshold, per-function inference detection, the
 * caller economic state, and the manifest `uses_inference` flag.
 */

import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";

import { parseTypeScript, type ParsedFunction } from "./parser.ts";
import { deriveCallerEconomicState } from "./request-caller-context.ts";
import { generateManifestFromParseResult } from "./app-manifest-generation.ts";
import {
  CHAT_MIN_BALANCE_LIGHT,
  FREE_MODE_BALANCE_LIGHT,
} from "../../shared/contracts/ai.ts";

const usesInference = (
  functions: ParsedFunction[],
  name: string,
): boolean | undefined => functions.find((f) => f.name === name)?.usesInference;

// ── Threshold ────────────────────────────────────────────────────────

Deno.test("free mode: threshold is unified at 25 Light ($0.25)", () => {
  assertEquals(FREE_MODE_BALANCE_LIGHT, 25);
  assertEquals(CHAT_MIN_BALANCE_LIGHT, FREE_MODE_BALANCE_LIGHT);
});

// ── Per-function inference detection ──────────────────────────────────

Deno.test("free mode: detects a direct galactic.ai() call per function", async () => {
  const result = await parseTypeScript(`
    export async function summarize(text: string) {
      const res = await galactic.ai({ messages: [{ role: "user", content: text }] });
      return res.content;
    }
    export async function echo(text: string) { return text; }
  `);
  assertEquals(usesInference(result.functions, "summarize"), true);
  assertEquals(usesInference(result.functions, "echo"), false);
  assert(result.permissions.includes("ai:call"));
});

Deno.test("free mode: detects the ultralight.ai() alias", async () => {
  const result = await parseTypeScript(`
    export async function ask(q: string) {
      return (await ultralight.ai({ messages: [{ role: "user", content: q }] })).content;
    }
  `);
  assertEquals(usesInference(result.functions, "ask"), true);
});

Deno.test("free mode: detects a direct galactic.embed() call per function", async () => {
  const result = await parseTypeScript(`
    export async function semanticIndex(text: string) {
      return await galactic.embed({ input: text });
    }
    export async function echo(text: string) { return text; }
  `);
  assertEquals(usesInference(result.functions, "semanticIndex"), true);
  assertEquals(usesInference(result.functions, "echo"), false);
  assert(result.permissions.includes("ai:embed"));
});

Deno.test("free mode: detects inference reached transitively through a local helper", async () => {
  const result = await parseTypeScript(`
    async function callModel(q: string) {
      return (await galactic.ai({ messages: [{ role: "user", content: q }] })).content;
    }
    export async function chat(q: string) { return callModel(q); }
    export async function ping() { return "pong"; }
  `);
  assertEquals(usesInference(result.functions, "chat"), true);
  assertEquals(usesInference(result.functions, "ping"), false);
});

Deno.test("free mode: an app with no inference yields all-false", async () => {
  const result = await parseTypeScript(`
    export async function add(a: number, b: number) { return a + b; }
  `);
  assertEquals(usesInference(result.functions, "add"), false);
  assert(!result.permissions.includes("ai:call"));
});

Deno.test("free mode: multi-file entry with AI is conservative (marks all)", async () => {
  // Relative imports hide helpers, so once any ai() is present in the entry we
  // can't tell which exported functions reach it — mark all (fail-safe).
  const result = await parseTypeScript(`
    import { fmt } from "./helpers.ts";
    export async function chat(q: string) {
      return fmt((await galactic.ai({ messages: [{ role: "user", content: q }] })).content);
    }
    export async function plain() { return fmt("x"); }
  `);
  assertEquals(usesInference(result.functions, "chat"), true);
  assertEquals(usesInference(result.functions, "plain"), true);
});

Deno.test("free mode: galactic.* permission inference (rebrand regression)", async () => {
  const result = await parseTypeScript(`
    export async function f() {
      await galactic.store("k", 1);
      await galactic.ai({ messages: [] });
      return galactic.recall("k");
    }
  `);
  assert(result.permissions.includes("ai:call"));
  assert(result.permissions.includes("storage:write"));
  assert(result.permissions.includes("memory:read"));
});

// ── Caller economic state ─────────────────────────────────────────────

Deno.test("free mode: deriveCallerEconomicState — below threshold is free mode", () => {
  const state = deriveCallerEconomicState({
    balance_light: 10,
    byok_enabled: false,
    byok_provider: null,
  });
  assertEquals(state.freeMode, true);
  assertEquals(state.balanceLight, 10);
  assertEquals(state.byokPresent, false);
});

Deno.test("free mode: deriveCallerEconomicState — at/above threshold is not free mode", () => {
  const at = deriveCallerEconomicState({
    balance_light: 25,
    byok_enabled: false,
    byok_provider: null,
  });
  const above = deriveCallerEconomicState({
    balance_light: 100,
    byok_enabled: false,
    byok_provider: null,
  });
  assertEquals(at.freeMode, false);
  assertEquals(above.freeMode, false);
});

Deno.test("free mode: deriveCallerEconomicState — null profile fails open", () => {
  const state = deriveCallerEconomicState(null);
  assertEquals(state.freeMode, false);
  assertEquals(state.balanceLight, null);
  assertEquals(state.byokPresent, false);
});

Deno.test("free mode: deriveCallerEconomicState — reports BYOK presence", () => {
  const state = deriveCallerEconomicState({
    balance_light: 5,
    byok_enabled: true,
    byok_provider: "openai",
  });
  assertEquals(state.byokPresent, true);
  assertEquals(state.freeMode, true);
});

// ── Manifest flag ─────────────────────────────────────────────────────

Deno.test("free mode: AI apps record uses_inference explicitly per function", async () => {
  const result = await parseTypeScript(`
    export async function summarize(text: string) {
      return (await galactic.ai({ messages: [{ role: "user", content: text }] })).content;
    }
    export async function echo(text: string) { return text; }
  `);
  const manifest = generateManifestFromParseResult(
    { name: "App", slug: "app" },
    result,
    "1.0.0",
  );
  // The app declares ai:call, so every function gets an explicit flag — this is
  // what lets the Phase 1 gate tell "analyzed, no AI" from "old manifest".
  assertEquals(manifest.functions?.summarize?.uses_inference, true);
  assertEquals(manifest.functions?.echo?.uses_inference, false);
});

Deno.test("free mode: embedding apps record uses_inference explicitly per function", async () => {
  const result = await parseTypeScript(`
    export async function vectorize(text: string) {
      return await galactic.embed({ input: text });
    }
    export async function echo(text: string) { return text; }
  `);
  const manifest = generateManifestFromParseResult(
    { name: "Embed App", slug: "embed-app" },
    result,
    "1.0.0",
  );
  assertEquals(manifest.functions?.vectorize?.uses_inference, true);
  assertEquals(manifest.functions?.echo?.uses_inference, false);
});

Deno.test("free mode: non-AI apps omit the uses_inference flag", async () => {
  const result = await parseTypeScript(`
    export async function add(a: number, b: number) { return a + b; }
  `);
  const manifest = generateManifestFromParseResult(
    { name: "App", slug: "app" },
    result,
    "1.0.0",
  );
  assertEquals(manifest.functions?.add?.uses_inference, undefined);
});
