import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";
import {
  ByokValidationError,
  validateByokCredential,
  verifyByokValidationReceipt,
} from "./byok-validation.ts";

const INPUT = {
  userId: "user-1",
  provider: "openrouter" as const,
  apiKey: "sk-or-secret",
  model: "openai/gpt-4o-mini",
  operations: ["generate", "embed"] as const,
};

Deno.test("BYOK validation checks each operation and binds a short-lived receipt", async () => {
  const calls: string[] = [];
  const result = await validateByokCredential(
    { ...INPUT, operations: [...INPUT.operations] },
    {
      now: () => 1_000,
      signingSecret: "test-signing-secret",
      fetchImpl: ((url: string | URL | Request) => {
        calls.push(String(url));
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    },
  );

  assertEquals(calls.map((url) => new URL(url).pathname), [
    "/api/v1/chat/completions",
    "/api/v1/embeddings",
  ]);
  assertEquals(result.operations, ["generate", "embed"]);
  assertEquals(
    await verifyByokValidationReceipt(
      result.validationReceipt,
      { ...INPUT, operations: [...INPUT.operations] },
      { now: () => 2_000, signingSecret: "test-signing-secret" },
    ),
    {
      policyVersion: "launch-byok-v1",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      operations: ["generate", "embed"],
      validatedAt: new Date(1_000).toISOString(),
    },
  );
});

Deno.test("BYOK receipt cannot be used with a different key", async () => {
  const result = await validateByokCredential(
    { ...INPUT, operations: [...INPUT.operations] },
    {
      now: () => 1_000,
      signingSecret: "test-signing-secret",
      fetchImpl:
        (() =>
          Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch,
    },
  );
  await assertRejects(
    () =>
      verifyByokValidationReceipt(
        result.validationReceipt,
        { ...INPUT, apiKey: "different", operations: [...INPUT.operations] },
        { now: () => 2_000, signingSecret: "test-signing-secret" },
      ),
    ByokValidationError,
    "no longer matches",
  );
});

Deno.test("BYOK validation surfaces typed auth failure", async () => {
  const error = await assertRejects(
    () =>
      validateByokCredential(
        { ...INPUT, operations: ["generate"] },
        {
          signingSecret: "test-signing-secret",
          fetchImpl: (() =>
            Promise.resolve(new Response("", { status: 401 }))) as typeof fetch,
        },
      ),
    ByokValidationError,
  );
  assertEquals(error.code, "invalid_key");
});

Deno.test("BYOK validation rejects providers without required capability", async () => {
  const error = await assertRejects(
    () =>
      validateByokCredential({
        ...INPUT,
        provider: "openai",
        operations: ["embed"],
      }, { signingSecret: "test-signing-secret" }),
    ByokValidationError,
  );
  assertEquals(error.code, "unsupported_operation");
});
