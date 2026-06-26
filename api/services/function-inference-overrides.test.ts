import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";
import {
  clearFunctionInferenceOverride,
  resolveFunctionInferenceOverride,
  setFunctionInferenceOverride,
} from "./function-inference-overrides.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

let testQueue = Promise.resolve();
async function runSerial(fn: () => Promise<void>): Promise<void> {
  const run = testQueue.then(fn, fn);
  testQueue = run.catch(() => {});
  await run;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withMockedEnvAndFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const g = globalThis as typeof globalThis & { __env?: Record<string, unknown> };
  const prevEnv = g.__env;
  const prevFetch = globalThis.fetch;
  g.__env = { ...(prevEnv || {}), ...TEST_ENV };
  globalThis.fetch = handler as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = prevFetch;
    g.__env = prevEnv;
  }
}

Deno.test("function inference overrides: a light row maps to a credits selection", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(async () =>
      jsonResponse([{
        app_id: "app-1",
        function_name: "summarize",
        billing_mode: "light",
        provider: null,
        model: "openai/gpt-4o-mini",
      }]), async () => {
      const selection = await resolveFunctionInferenceOverride({
        userId: "user-1",
        appId: "app-1",
        functionName: "summarize",
      });
      assertEquals(selection, {
        billingMode: "light",
        provider: undefined,
        model: "openai/gpt-4o-mini",
      });
    });
  });
});

Deno.test("function inference overrides: a byok row maps to a provider selection", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(async () =>
      jsonResponse([{
        app_id: "app-1",
        function_name: "summarize",
        billing_mode: "byok",
        provider: "openai",
        model: "gpt-4o",
      }]), async () => {
      const selection = await resolveFunctionInferenceOverride({
        userId: "user-1",
        appId: "app-1",
        functionName: "summarize",
      });
      assertEquals(selection, {
        billingMode: "byok",
        provider: "openai",
        model: "gpt-4o",
      });
    });
  });
});

Deno.test("function inference overrides: no row resolves to null (default chain)", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(async () => jsonResponse([]), async () => {
      const selection = await resolveFunctionInferenceOverride({
        userId: "user-1",
        appId: "app-1",
        functionName: "summarize",
      });
      assertEquals(selection, null);
    });
  });
});

Deno.test("function inference overrides: a storage error fails open to null", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async () => new Response("boom", { status: 500 }),
      async () => {
        const selection = await resolveFunctionInferenceOverride({
          userId: "user-1",
          appId: "app-1",
          functionName: "summarize",
        });
        assertEquals(selection, null);
      },
    );
  });
});

Deno.test("function inference overrides: set persists a byok override and clears the plaintext provider for light", async () => {
  await runSerial(async () => {
    const writes: Array<Record<string, unknown>> = [];
    await withMockedEnvAndFetch(async (_input, init) => {
      if ((init?.method || "GET") === "POST") {
        writes.push(JSON.parse(String(init?.body))[0]);
        return new Response(null, { status: 204 });
      }
      return jsonResponse([]);
    }, async () => {
      await setFunctionInferenceOverride({
        userId: "user-1",
        appId: "app-1",
        functionName: "summarize",
        billingMode: "light",
        provider: "openai", // ignored for light
        model: "deepseek/deepseek-v4-flash",
        allowedFunctionNames: ["summarize"],
      });
      await setFunctionInferenceOverride({
        userId: "user-1",
        appId: "app-1",
        functionName: "summarize",
        billingMode: "byok",
        provider: "openai",
        model: "gpt-4o",
        allowedFunctionNames: ["summarize"],
      });
    });
    assertEquals(writes[0].billing_mode, "light");
    assertEquals(writes[0].provider, null);
    assertEquals(writes[1].billing_mode, "byok");
    assertEquals(writes[1].provider, "openai");
  });
});

Deno.test("function inference overrides: set rejects an unknown function and a byok override without a valid provider", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(async () => new Response(null, { status: 204 }), async () => {
      await assertRejects(() =>
        setFunctionInferenceOverride({
          userId: "user-1",
          appId: "app-1",
          functionName: "not-a-function",
          billingMode: "light",
          provider: null,
          model: "deepseek/deepseek-v4-flash",
          allowedFunctionNames: ["summarize"],
        }), Error, "Unknown function");
      await assertRejects(() =>
        setFunctionInferenceOverride({
          userId: "user-1",
          appId: "app-1",
          functionName: "summarize",
          billingMode: "byok",
          provider: "not-a-provider",
          model: "gpt-4o",
          allowedFunctionNames: ["summarize"],
        }), Error, "valid BYOK provider");
    });
  });
});

Deno.test("function inference overrides: clear issues a scoped DELETE", async () => {
  await runSerial(async () => {
    let deleteUrl = "";
    await withMockedEnvAndFetch(async (input, init) => {
      if ((init?.method || "GET") === "DELETE") {
        deleteUrl = String(input);
        return new Response(null, { status: 204 });
      }
      return jsonResponse([]);
    }, async () => {
      await clearFunctionInferenceOverride({
        userId: "user-1",
        appId: "app-1",
        functionName: "summarize",
      });
    });
    assertEquals(deleteUrl.includes("user_id=eq.user-1"), true);
    assertEquals(deleteUrl.includes("app_id=eq.app-1"), true);
    assertEquals(deleteUrl.includes("function_name=eq.summarize"), true);
  });
});
