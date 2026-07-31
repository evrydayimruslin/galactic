import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import { containmentProbeFiles } from "../../scripts/smoke/gx-test-containment-smoke.mjs";
import {
  countTopLevelFunctionParameters,
  executeLint,
} from "./platform-mcp.ts";

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

Deno.test("staging containment probe satisfies the exact strict gx.test lint contract", () => {
  const result = executeLint({
    files: containmentProbeFiles(),
    strict: true,
  }) as {
    valid: boolean;
    issues: Array<{ severity: string; rule: string; message: string }>;
  };
  const errors = result.issues.filter((issue) => issue.severity === "error");
  assert(
    result.valid,
    `Containment probe strict lint errors: ${
      errors.map((issue) => `${issue.rule}: ${issue.message}`).join("; ")
    }`,
  );
  assertEquals(errors, []);
});
