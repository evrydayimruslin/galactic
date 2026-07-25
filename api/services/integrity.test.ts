import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { runSafetyScan } from "./integrity.ts";

Deno.test("safety scan accepts the direct Compute smoke echo command", () => {
  const result = runSafetyScan([{
    name: "index.ts",
    content: 'await galactic.compute({ argv: ["cat"], stdin: marker });',
  }]);

  assertEquals(result, {
    passed: true,
    issues: [],
    summary: { errors: 0, warnings: 0, info: 0 },
  });
});

Deno.test("safety scan rejects the filesystem-based Compute smoke echo command", () => {
  const result = runSafetyScan([{
    name: "index.ts",
    content:
      "const fs=require('node:fs');process.stdout.write(fs.readFileSync(0,'utf8'));",
  }]);

  assertEquals(result.passed, false);
  assertEquals(result.issues.map((issue) => issue.rule), [
    "dangerous-file-system",
  ]);
});
