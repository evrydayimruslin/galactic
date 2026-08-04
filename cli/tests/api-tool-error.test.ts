import assert from "node:assert/strict";
import { ApiClient, ApiToolError, decodeApiToolErrorDetails } from "../api.ts";
import { formatCliError } from "../mod.ts";
import {
  COMPUTE_ADMISSION_DISABLED_ACTION,
  COMPUTE_ADMISSION_DISABLED_CODE,
  COMPUTE_ADMISSION_DISABLED_HINT,
  COMPUTE_ADMISSION_DISABLED_MESSAGE,
} from "../../shared/contracts/compute.ts";

const DETAILS = {
  code: COMPUTE_ADMISSION_DISABLED_CODE,
  hint: COMPUTE_ADMISSION_DISABLED_HINT,
  action: COMPUTE_ADMISSION_DISABLED_ACTION,
} as const;

function client(): ApiClient {
  return new ApiClient({
    api_url: "https://api.example.test",
    auth: { token: "gx_test", is_api_token: true },
  });
}

function toolErrorResponse(
  details: unknown = DETAILS,
  structuredMessage: unknown = COMPUTE_ADMISSION_DISABLED_MESSAGE,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        content: [{
          type: "text",
          text:
            `Error: ${COMPUTE_ADMISSION_DISABLED_MESSAGE} ${COMPUTE_ADMISSION_DISABLED_HINT}`,
        }],
        structuredContent: {
          error: structuredMessage,
          error_type: "GalacticComputeError",
          error_details: details,
        },
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof Error);
    return error;
  }
  throw new Error("Expected the operation to reject");
}

Deno.test("ApiClient preserves the closed admission-disabled tool error", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(toolErrorResponse());
  }) as typeof fetch;

  try {
    const platformError = await captureError(() =>
      client().callTool("gx.call", {})
    );
    const appError = await captureError(() =>
      client().callAppTool("agent-1", "agent-1_run", {})
    );

    for (const error of [platformError, appError]) {
      assert(error instanceof ApiToolError);
      assert.equal(error.message, COMPUTE_ADMISSION_DISABLED_MESSAGE);
      assert.equal(error.code, DETAILS.code);
      assert.equal(error.hint, DETAILS.hint);
      assert.equal(error.action, DETAILS.action);
    }
    assert.deepEqual(urls, [
      "https://api.example.test/mcp/platform",
      "https://api.example.test/mcp/agent-1",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("ApiClient keeps unrecognized tool errors generic", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(toolErrorResponse({
      code: "COMPUTE_ADMISSION_DISABLED",
      hint: DETAILS.hint,
      action: "setup_home_node",
    }))) as typeof fetch;

  try {
    const error = await captureError(() => client().callTool("gx.call", {}));
    assert.equal(error.constructor, Error);
    assert.equal(
      error.message,
      `Error: ${COMPUTE_ADMISSION_DISABLED_MESSAGE} ${COMPUTE_ADMISSION_DISABLED_HINT}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("admission-disabled decoder pins the packaged CLI to the canonical contract", () => {
  assert.deepEqual(
    decodeApiToolErrorDetails({
      error: COMPUTE_ADMISSION_DISABLED_MESSAGE,
      error_details: DETAILS,
    }),
    DETAILS,
  );

  for (
    const errorDetails of [
      { ...DETAILS, code: "COMPUTE_ROLLOUT_DENIED" },
      { ...DETAILS, action: "setup_home_node" },
      { ...DETAILS, hint: `${COMPUTE_ADMISSION_DISABLED_HINT} ` },
      { ...DETAILS, extra: true },
    ]
  ) {
    assert.equal(
      decodeApiToolErrorDetails({
        error: COMPUTE_ADMISSION_DISABLED_MESSAGE,
        error_details: errorDetails,
      }),
      null,
    );
  }

  assert.equal(
    decodeApiToolErrorDetails({
      error: `${COMPUTE_ADMISSION_DISABLED_MESSAGE} `,
      error_details: DETAILS,
    }),
    null,
  );
});

Deno.test("ApiClient requires the exact structured primary message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(toolErrorResponse(
      DETAILS,
      "Compute admission is unavailable.",
    ))) as typeof fetch;

  try {
    const error = await captureError(() => client().callTool("gx.call", {}));
    assert.equal(error.constructor, Error);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("CLI prints safe admission Code and Hint only in human output", () => {
  const error = new ApiToolError(COMPUTE_ADMISSION_DISABLED_MESSAGE, DETAILS);

  assert.deepEqual(formatCliError(error), [
    `Error: ${COMPUTE_ADMISSION_DISABLED_MESSAGE}`,
    "Code: COMPUTE_ADMISSION_DISABLED",
    `Hint: ${DETAILS.hint}`,
  ]);
  assert.deepEqual(formatCliError(error, true), [
    `Error: ${COMPUTE_ADMISSION_DISABLED_MESSAGE}`,
  ]);
  assert.deepEqual(formatCliError(new Error("ordinary")), [
    "Error: ordinary",
  ]);
  assert.deepEqual(formatCliError("ordinary"), [
    "An unexpected error occurred",
  ]);
});
