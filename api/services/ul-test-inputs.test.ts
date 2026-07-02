import { assertEquals, assertThrows } from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  extractUlTestExports,
  resolveUlTestD1Fixtures,
  resolveUlTestEnvVars,
  resolveUlTestInvocation,
} from "./ul-test-inputs.ts";

Deno.test("ul test inputs: extracts exported functions from entry code", () => {
  const exports = extractUlTestExports(`
    export async function search() {}
    export const summarize = () => {};
    export function search() {}
  `);

  assertEquals(exports, ["search", "summarize"]);
});

Deno.test("ul test inputs: uses single test fixture entry when function name is omitted", () => {
  const resolution = resolveUlTestInvocation([
    {
      path: "index.ts",
      content: "export async function search(input) { return input; }",
    },
    {
      path: "test_fixture.json",
      content: JSON.stringify({
        search: { query: "coffee" },
      }),
    },
  ]);

  assertEquals(resolution.functionName, "search");
  assertEquals(resolution.testArgs, { query: "coffee" });
  assertEquals(resolution.fixtureEnvVars, {});
  assertEquals(resolution.d1Fixtures, null);
});

Deno.test("ul test inputs: explicit test args override test fixture defaults", () => {
  const resolution = resolveUlTestInvocation(
    [
      {
        path: "index.ts",
        content: "export async function search(input) { return input; }",
      },
      {
        path: "test_fixture.json",
        content: JSON.stringify({
          search: { query: "fixture" },
        }),
      },
    ],
    "search",
    { query: "manual" },
  );

  assertEquals(resolution.testArgs, { query: "manual" });
});

Deno.test("ul test inputs: supports extended fixture envelopes with env vars and D1 fixtures", () => {
  const resolution = resolveUlTestInvocation([
    {
      path: "index.ts",
      content: "export async function search(input) { return input; }",
    },
    {
      path: "test_fixture.json",
      content: JSON.stringify({
        search: {
          args: { query: "fixture" },
          env_vars: { API_KEY: "secret" },
          d1_fixtures: {
            responses: [
              {
                method: "select",
                table: "items",
                result: [{ id: "item-1" }],
              },
            ],
          },
        },
      }),
    },
  ]);

  assertEquals(resolution.testArgs, { query: "fixture" });
  assertEquals(resolution.fixtureEnvVars, { API_KEY: "secret" });
  assertEquals(resolution.d1Fixtures, {
    responses: [
      {
        method: "select",
        table: "items",
        when: undefined,
        result: [{ id: "item-1" }],
      },
    ],
  });
});

Deno.test("ul test inputs: rejects env vars with non-string values", () => {
  assertThrows(
    () => resolveUlTestEnvVars({ API_KEY: 123 }),
    Error,
    "env_vars.API_KEY must be a string",
  );
});

Deno.test("ul test inputs: validates explicit D1 fixture config", () => {
  assertEquals(
    resolveUlTestD1Fixtures({
      responses: [
        {
          method: "insert",
          table: "items",
          result: { meta: { changes: 1 } },
        },
      ],
    }),
    {
      responses: [
        {
          method: "insert",
          table: "items",
          when: undefined,
          result: { meta: { changes: 1 } },
        },
      ],
    },
  );
});
