// Tests for parseManifestCallRateLimit — the app-level (MCP) rate-limit field that
// composes with gx.set's rate_limit_config. Defensive: only positive finite ints.

import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import { parseManifestCallRateLimit } from "../../shared/contracts/manifest.ts";

const wrap = (rl: unknown) => JSON.stringify({ name: "x", version: "1", type: "mcp", entry: {}, rate_limit: rl });

Deno.test("manifest rate_limit: both fields", () => {
  assertEquals(parseManifestCallRateLimit(wrap({ calls_per_minute: 60, calls_per_day: 1000 })), {
    calls_per_minute: 60,
    calls_per_day: 1000,
  });
});

Deno.test("manifest rate_limit: only one field", () => {
  assertEquals(parseManifestCallRateLimit(wrap({ calls_per_minute: 30 })), { calls_per_minute: 30 });
  assertEquals(parseManifestCallRateLimit(wrap({ calls_per_day: 500 })), { calls_per_day: 500 });
});

Deno.test("manifest rate_limit: fractional floored", () => {
  assertEquals(parseManifestCallRateLimit(wrap({ calls_per_minute: 12.9 })), { calls_per_minute: 12 });
});

Deno.test("manifest rate_limit: non-positive / non-number ignored", () => {
  assertEquals(parseManifestCallRateLimit(wrap({ calls_per_minute: 0, calls_per_day: -5 })), null);
  assertEquals(parseManifestCallRateLimit(wrap({ calls_per_minute: "60", calls_per_day: null })), null);
  assertEquals(parseManifestCallRateLimit(wrap({ calls_per_minute: Number.NaN })), null);
});

Deno.test("manifest rate_limit: absent / malformed / empty => null", () => {
  assertEquals(parseManifestCallRateLimit(JSON.stringify({ name: "x", version: "1" })), null);
  assertEquals(parseManifestCallRateLimit("{not json"), null);
  assertEquals(parseManifestCallRateLimit(null), null);
  assertEquals(parseManifestCallRateLimit(undefined), null);
  assertEquals(parseManifestCallRateLimit(wrap({})), null);
});

Deno.test("manifest rate_limit: accepts an already-parsed manifest object", () => {
  // deno-lint-ignore no-explicit-any
  const obj: any = { name: "x", version: "1", type: "mcp", entry: {}, rate_limit: { calls_per_day: 250 } };
  assertEquals(parseManifestCallRateLimit(obj), { calls_per_day: 250 });
});
