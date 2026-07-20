import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyRuntimeExecution,
  INTERACTIVE_COMPUTE_TIMEOUT_MS,
  INTERACTIVE_FUNCTION_TIMEOUT_MS,
  INTERACTIVE_INFERENCE_TIMEOUT_MS,
} from "./execution-classification.ts";

const MIXED_MANIFEST = {
  permissions: ["ai:call"],
  functions: {
    summarize: { uses_inference: true },
    inbox_overview: { uses_inference: false },
  },
};

Deno.test("execution classification: AI permission does not give a read function the AI timeout", () => {
  assertEquals(
    classifyRuntimeExecution({
      manifest: MIXED_MANIFEST,
      functionName: "inbox_overview",
    }),
    {
      usesInference: false,
      timeoutMs: INTERACTIVE_FUNCTION_TIMEOUT_MS,
    },
  );
});

Deno.test("execution classification: upload-derived inference function receives the interactive AI timeout", () => {
  assertEquals(
    classifyRuntimeExecution({
      manifest: MIXED_MANIFEST,
      functionName: "summarize",
    }),
    {
      usesInference: true,
      timeoutMs: INTERACTIVE_INFERENCE_TIMEOUT_MS,
    },
  );
});

Deno.test("execution classification: a Compute caller keeps the parent alive for the bounded sync lane", () => {
  assertEquals(
    classifyRuntimeExecution({
      manifest: {
        permissions: ["compute:exec"],
        functions: {
          build: { uses_compute: true },
          status: { uses_compute: false },
        },
      },
      functionName: "build",
    }),
    {
      usesInference: false,
      timeoutMs: INTERACTIVE_COMPUTE_TIMEOUT_MS,
    },
  );
  assertEquals(
    classifyRuntimeExecution({
      manifest: {
        permissions: ["compute:exec"],
        functions: { build: { uses_compute: false } },
      },
      functionName: "build",
    }).timeoutMs,
    INTERACTIVE_FUNCTION_TIMEOUT_MS,
  );
});

Deno.test("execution classification: legacy AI manifests fail safe as inference", () => {
  assertEquals(
    classifyRuntimeExecution({
      manifest: {
        permissions: ["ai:call"],
        functions: { legacy: {} },
      },
      functionName: "legacy",
    }).usesInference,
    true,
  );
});

Deno.test("execution classification: queue budget overrides interactive class and is capped", () => {
  assertEquals(
    classifyRuntimeExecution({
      manifest: MIXED_MANIFEST,
      functionName: "inbox_overview",
      executionTimeoutMs: 600_000,
      maxExecutionTimeoutMs: 300_000,
    }),
    { usesInference: false, timeoutMs: 300_000 },
  );
});
