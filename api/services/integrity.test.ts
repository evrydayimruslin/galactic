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

Deno.test("safety scan never returns credential fragments", () => {
  const secret = "ghp_" + "z".repeat(36);
  const result = runSafetyScan([{
    name: "index.ts",
    content: `export const token = "${secret}";`,
  }]);

  assertEquals(result.passed, false);
  assertEquals(result.issues[0]?.rule, "secret-github-token");
  assertEquals(result.issues[0]?.file, "index.ts");
  assertEquals(result.issues[0]?.match, undefined);
  assertEquals(JSON.stringify(result).includes(secret), false);
});

Deno.test("safety scan catches quoted structured secrets but permits placeholders", () => {
  const secret = "GOCSPX-" + "q".repeat(32);
  const rejected = runSafetyScan([{
    name: "oauth.json",
    content: JSON.stringify({ client_secret: secret }),
  }]);
  assertEquals(rejected.passed, false);
  assertEquals(rejected.issues[0]?.rule, "secret-structured-credential");
  assertEquals(rejected.issues[0]?.match, undefined);
  assertEquals(JSON.stringify(rejected).includes(secret), false);

  const accepted = runSafetyScan([{
    name: "oauth.example.json",
    content: JSON.stringify({
      api_key: "your-api-key-here",
      client_secret: "replace-me",
      private_key: "example-placeholder",
    }),
  }]);
  assertEquals(accepted.passed, true);
});

Deno.test("fixed Compute certification fixture passes the upload safety scan", async () => {
  const fixtureUrl = new URL(
    "../../examples/compute-certification/",
    import.meta.url,
  );
  const files = await Promise.all(
    ["index.ts", "manifest.json"].map(async (name) => ({
      name,
      content: await Deno.readTextFile(new URL(name, fixtureUrl)),
    })),
  );

  const result = runSafetyScan(files);

  assertEquals(result.passed, true);
  assertEquals(result.summary.errors, 0);
});
