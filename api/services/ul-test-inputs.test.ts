import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  extractUlTestExports,
  resolveUlTestD1Fixtures,
  resolveUlTestEnvVars,
  resolveUlTestHttpFixtures,
  resolveUlTestInvocation,
} from "./ul-test-inputs.ts";
import {
  blockUlTestEffect,
  createUlTestAiResponse,
  createUlTestAppDataService,
  createUlTestEmbedResponse,
  createUlTestMemoryAdapter,
  createUlTestNotifyResponse,
  createUlTestRunsResponse,
  UL_TEST_BLOCKED_EFFECTS,
} from "./ul-test-runtime.ts";
import { TestRuntimeStateStore } from "./test-state-store.ts";

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
  assertEquals(resolution.httpFixtures, null);
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

Deno.test("ul test inputs: supports extended fixture envelopes with env, D1, and HTTP fixtures", () => {
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
          http_fixtures: [
            {
              id: "search-api",
              kind: "raw",
              request: {
                method: "get",
                url: "HTTPS://API.EXAMPLE.COM:443/v1/search?q=fixture",
              },
              response: {
                status: 200,
                headers: { "Content-Type": "application/json" },
                body_text: '{"results":[]}',
              },
            },
          ],
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
  assertEquals(resolution.httpFixtures, [
    {
      id: "search-api",
      kind: "raw",
      request: {
        method: "GET",
        url: "https://api.example.com/v1/search?q=fixture",
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body_text: '{"results":[]}',
      },
    },
  ]);
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

Deno.test("ul test inputs: validates and normalizes explicit HTTP fixtures", () => {
  assertEquals(
    resolveUlTestHttpFixtures([
      {
        id: "crm-lookup",
        kind: "credential",
        credential_key: "CRM_TOKEN",
        request: {
          method: "post",
          url: "HTTPS://CRM.EXAMPLE.COM:443/v1/lookup",
          body_sha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        response: {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body_text: '{"customer":null}',
        },
      },
    ]),
    [
      {
        id: "crm-lookup",
        kind: "credential",
        credential_key: "CRM_TOKEN",
        request: {
          method: "POST",
          url: "https://crm.example.com/v1/lookup",
          body_sha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          body_text: '{"customer":null}',
        },
      },
    ],
  );
  assertEquals(resolveUlTestHttpFixtures(undefined), null);
});

Deno.test("ul test runtime: host stubs are deterministic and side-effect free", () => {
  const ai = createUlTestAiResponse();
  assertEquals(JSON.parse(ai.content), {
    assessment: "gx.test deterministic AI response",
    actions: [],
  });
  assertEquals(ai.usage.cost_light, 0);
  assertEquals(createUlTestEmbedResponse(), {
    embedding: [0, 0, 0, 0],
    model: "gx-test-embedding-stub",
    dimensions: 4,
    usage: { input_tokens: 0, total_tokens: 0, cost_light: 0 },
  });
  assertEquals(createUlTestNotifyResponse(), {
    created: false,
    reason: "test_mode",
  });
  assertEquals(createUlTestRunsResponse(), { runs: [] });
});

Deno.test("ul test runtime: memory is invocation-local and starts empty", async () => {
  const first = createUlTestMemoryAdapter();
  assertEquals(await first.recall("mission"), null);
  await first.remember("mission", { state: "working" });
  assertEquals(await first.recall("mission"), { state: "working" });

  const nextInvocation = createUlTestMemoryAdapter();
  assertEquals(await nextInvocation.recall("mission"), null);
});

Deno.test("ul test runtime: legacy app data adapter is in-memory and isolated", async () => {
  const first = createUlTestAppDataService();
  const stored = { status: "ready", nested: { count: 1 } };
  await first.store("state/current", stored);
  stored.nested.count = 99;

  assertEquals(await first.load("state/current"), {
    status: "ready",
    nested: { count: 1 },
  });
  assertEquals(await first.list("state/"), ["state/current"]);

  const nextInvocation = createUlTestAppDataService();
  assertEquals(await nextInvocation.load("state/current"), null);
});

Deno.test("ul test runtime: every external-effect core latches before failing", async () => {
  const state = new TestRuntimeStateStore();
  for (const effect of Object.values(UL_TEST_BLOCKED_EFFECTS)) {
    await assertRejects(
      () => blockUlTestEffect(state, effect),
      Error,
      "gx.test blocked",
    );
  }
  assertEquals(
    state.blockedEffects(),
    Object.values(UL_TEST_BLOCKED_EFFECTS).sort(),
  );
});
