import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";

import { countTopLevelFunctionParameters } from "./platform-mcp.ts";

Deno.test("gx.test lint treats a formatted trailing comma as one parameter", () => {
  assertEquals(
    countTopLevelFunctionParameters(`
      args: {
        debug?: boolean;
        config_only?: boolean;
      },
    `),
    1,
  );
});

Deno.test("gx.test lint still detects genuine positional parameters", () => {
  assertEquals(
    countTopLevelFunctionParameters(
      "first: string, second: number, third?: boolean",
    ),
    3,
  );
});

Deno.test("gx.test lint ignores nested and quoted commas", () => {
  assertEquals(
    countTopLevelFunctionParameters(
      `args: Record<string, number>, options: [string, number], label = "a,b"`,
    ),
    3,
  );
  assertEquals(
    countTopLevelFunctionParameters(
      `args: { callback: (left: string, right: string) => void; tuple: [string, number] },`,
    ),
    1,
  );
});

Deno.test("gx.test lint accepts empty parameter lists", () => {
  assertEquals(countTopLevelFunctionParameters(""), 0);
  assertEquals(countTopLevelFunctionParameters("   "), 0);
});
