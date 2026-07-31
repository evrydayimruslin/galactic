import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import { resolveHttpTestFixtureConfig } from "../services/http-test-fixtures.ts";
import { TestRuntimeStateStore } from "../services/test-state-store.ts";
import { resolveHttpTestRuntimeResponse } from "../src/bindings/http-test-runtime.ts";

function fixtures() {
  return resolveHttpTestFixtureConfig([
    {
      id: "raw-list",
      kind: "raw",
      request: {
        method: "GET",
        url: "https://api.example.com/items?limit=1",
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body_text: '{"items":[]}',
      },
    },
    {
      id: "credential-create",
      kind: "credential",
      credential_key: "API_TOKEN",
      request: {
        method: "POST",
        url: "https://api.example.com/items",
      },
      response: {
        status: 201,
        body_text: '{"id":"fixture-item"}',
      },
    },
  ])!;
}

Deno.test("gx.test HTTP runtime returns exact raw fixtures and records network.http", async () => {
  const recorder = new TestRuntimeStateStore();
  const response = await resolveHttpTestRuntimeResponse({
    kind: "raw",
    request: new Request("https://api.example.com/items?limit=1"),
    fixtures: fixtures(),
    allowedDestinations: ["api.example.com"],
    recorder,
  });

  assertEquals(response.status, 200);
  assertEquals(await response.text(), '{"items":[]}');
  assertEquals(recorder.observedEffects(), ["network.http"]);
  assertEquals(recorder.blockedEffects(), []);
});

Deno.test("gx.test HTTP runtime matches credential key and destination without a secret", async () => {
  const recorder = new TestRuntimeStateStore();
  const response = await resolveHttpTestRuntimeResponse({
    kind: "credential",
    credentialKey: "API_TOKEN",
    request: new Request("https://api.example.com/items", {
      method: "POST",
      body: "{}",
    }),
    fixtures: fixtures(),
    allowedDestinations: ["api.example.com"],
    credentialDestinations: { API_TOKEN: "api.example.com" },
    recorder,
  });

  assertEquals(response.status, 201);
  assertEquals(await response.text(), '{"id":"fixture-item"}');
  assertEquals(recorder.observedEffects(), ["credential.http"]);
  assertEquals(recorder.blockedEffects(), []);
});

Deno.test("gx.test HTTP runtime latches an unmatched request even when the Agent catches it", async () => {
  const recorder = new TestRuntimeStateStore();
  await assertRejects(
    () =>
      resolveHttpTestRuntimeResponse({
        kind: "raw",
        request: new Request("https://api.example.com/items?limit=2"),
        fixtures: fixtures(),
        allowedDestinations: ["api.example.com"],
        recorder,
      }),
    Error,
    "external effects require a declared test fixture",
  );

  assertEquals(recorder.observedEffects(), ["network.http"]);
  assertEquals(recorder.blockedEffects(), ["outbound_http"]);
});

Deno.test("gx.test HTTP runtime reserves exchange bytes only after a complete match", async () => {
  class CountingRecorder extends TestRuntimeStateStore {
    reservations = 0;

    override reserveHttpFixtureExchangeBytes(
      requestBytes: number,
      responseBytes: number,
    ): void {
      this.reservations += 1;
      super.reserveHttpFixtureExchangeBytes(requestBytes, responseBytes);
    }
  }

  const recorder = new CountingRecorder();
  await assertRejects(
    () =>
      resolveHttpTestRuntimeResponse({
        kind: "raw",
        request: new Request("https://api.example.com/items?missing=1"),
        fixtures: fixtures(),
        allowedDestinations: ["api.example.com"],
        recorder,
      }),
    Error,
    "external effects require a declared test fixture",
  );
  assertEquals(recorder.reservations, 0);

  const response = await resolveHttpTestRuntimeResponse({
    kind: "raw",
    request: new Request("https://api.example.com/items?limit=1"),
    fixtures: fixtures(),
    allowedDestinations: ["api.example.com"],
    recorder,
  });
  assertEquals(response.status, 200);
  assertEquals(recorder.reservations, 1);
});

Deno.test("gx.test HTTP runtime never cross-matches raw and credential fixtures", async () => {
  const recorder = new TestRuntimeStateStore();
  await assertRejects(
    () =>
      resolveHttpTestRuntimeResponse({
        kind: "raw",
        request: new Request("https://api.example.com/items", {
          method: "POST",
        }),
        fixtures: fixtures(),
        allowedDestinations: ["api.example.com"],
        recorder,
      }),
    Error,
    "external effects require a declared test fixture",
  );
  assertEquals(recorder.blockedEffects(), ["outbound_http"]);
});

Deno.test("gx.test HTTP runtime rejects undeclared destinations and credential keys", async () => {
  const rawRecorder = new TestRuntimeStateStore();
  await assertRejects(
    () =>
      resolveHttpTestRuntimeResponse({
        kind: "raw",
        request: new Request("https://api.example.com/items?limit=1"),
        fixtures: fixtures(),
        allowedDestinations: [],
        recorder: rawRecorder,
      }),
    Error,
  );
  assertEquals(rawRecorder.blockedEffects(), ["outbound_http"]);

  const credentialRecorder = new TestRuntimeStateStore();
  await assertRejects(
    () =>
      resolveHttpTestRuntimeResponse({
        kind: "credential",
        credentialKey: "OTHER_TOKEN",
        request: new Request("https://api.example.com/items", {
          method: "POST",
        }),
        fixtures: fixtures(),
        allowedDestinations: ["api.example.com"],
        credentialDestinations: { API_TOKEN: "api.example.com" },
        recorder: credentialRecorder,
      }),
    Error,
  );
  assertEquals(
    credentialRecorder.blockedEffects(),
    ["credentialed_http"],
  );
});

Deno.test("gx.test credential HTTP remains HTTPS-only", async () => {
  const recorder = new TestRuntimeStateStore();
  await assertRejects(
    () =>
      resolveHttpTestRuntimeResponse({
        kind: "credential",
        credentialKey: "API_TOKEN",
        request: new Request("http://api.example.com/items", {
          method: "POST",
        }),
        fixtures: fixtures(),
        allowedDestinations: ["api.example.com"],
        credentialDestinations: { API_TOKEN: "api.example.com" },
        recorder,
      }),
    Error,
  );
  assertEquals(recorder.blockedEffects(), ["credentialed_http"]);
});

Deno.test("gx.test HTTP runtime latches an invocation-budget overflow", async () => {
  const recorder = new TestRuntimeStateStore();
  for (let index = 0; index < 32; index += 1) {
    const response = await resolveHttpTestRuntimeResponse({
      kind: "raw",
      request: new Request("https://api.example.com/items?limit=1"),
      fixtures: fixtures(),
      allowedDestinations: ["api.example.com"],
      recorder,
    });
    assertEquals(response.status, 200);
  }

  await assertRejects(
    () =>
      resolveHttpTestRuntimeResponse({
        kind: "raw",
        request: new Request("https://api.example.com/items?limit=1"),
        fixtures: fixtures(),
        allowedDestinations: ["api.example.com"],
        recorder,
      }),
    Error,
    "external effects require a declared test fixture",
  );
  assertEquals(recorder.blockedEffects(), ["outbound_http"]);
});

Deno.test("gx.test HTTP runtime reserves response bytes before materialization", async () => {
  const recorder = new TestRuntimeStateStore();
  const largeFixtures = resolveHttpTestFixtureConfig([
    {
      id: "large-raw-response",
      kind: "raw",
      request: {
        method: "GET",
        url: "https://api.example.com/large",
      },
      response: {
        status: 200,
        body_text: "x".repeat(1024 * 1024),
      },
    },
  ])!;

  for (let index = 0; index < 8; index += 1) {
    const response = await resolveHttpTestRuntimeResponse({
      kind: "raw",
      request: new Request("https://api.example.com/large"),
      fixtures: largeFixtures,
      allowedDestinations: ["api.example.com"],
      recorder,
    });
    assertEquals(response.status, 200);
  }

  await assertRejects(
    () =>
      resolveHttpTestRuntimeResponse({
        kind: "raw",
        request: new Request("https://api.example.com/large"),
        fixtures: largeFixtures,
        allowedDestinations: ["api.example.com"],
        recorder,
      }),
    Error,
    "external effects require a declared test fixture",
  );
  assertEquals(recorder.blockedEffects(), ["outbound_http"]);
});

Deno.test("gx.test HTTP fixture misses consume the shared attempt budget", async () => {
  const recorder = new TestRuntimeStateStore();
  for (let index = 0; index < 32; index += 1) {
    await assertRejects(
      () =>
        resolveHttpTestRuntimeResponse({
          kind: "raw",
          request: new Request(
            `https://api.example.com/items?unmatched=${index}`,
          ),
          fixtures: fixtures(),
          allowedDestinations: ["api.example.com"],
          recorder,
        }),
      Error,
      "external effects require a declared test fixture",
    );
  }

  // Even an otherwise exact match is denied before body inspection once caught
  // misses consume the invocation's bounded attempt allowance.
  await assertRejects(
    () =>
      resolveHttpTestRuntimeResponse({
        kind: "raw",
        request: new Request("https://api.example.com/items?limit=1"),
        fixtures: fixtures(),
        allowedDestinations: ["api.example.com"],
        recorder,
      }),
    Error,
    "external effects require a declared test fixture",
  );
  assertEquals(recorder.blockedEffects(), ["outbound_http"]);
});
