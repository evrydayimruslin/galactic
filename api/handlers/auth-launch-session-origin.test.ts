import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { handleAuth } from "./auth.ts";

for (
  const testCase of [
    {
      path: "/auth/launch/refresh",
      body: undefined,
      error: "Origin is not allowed to refresh launch sessions",
    },
    {
      path: "/auth/signout",
      body: JSON.stringify({ scope: "local" }),
      error: "Origin is not allowed to sign out launch sessions",
    },
  ] as const
) {
  Deno.test(
    `launch session origin: rejects a foreign browser origin for ${testCase.path}`,
    async () => {
      const originalEnv = globalThis.__env;
      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.__env = {
        ...(originalEnv || {}),
        CORS_ALLOWED_ORIGINS: "https://launch.test",
      } as typeof globalThis.__env;
      globalThis.fetch = (() => {
        fetchCalls += 1;
        return Promise.reject(new Error("Upstream fetch must not run"));
      }) as typeof fetch;

      try {
        const response = await handleAuth(
          new Request(`https://api.test${testCase.path}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Origin": "https://attacker.test",
            },
            body: testCase.body,
          }),
        );

        assertEquals(response.status, 403);
        assertEquals(await response.json(), { error: testCase.error });
        assertEquals(fetchCalls, 0);
      } finally {
        globalThis.fetch = originalFetch;
        globalThis.__env = originalEnv;
      }
    },
  );
}
