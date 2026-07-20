// Host-only RPC bindings for gx.test. Dynamic test isolates receive these in
// place of production AI/embed/notification bindings, so validation can execute
// realistic code without provider requests, Light billing, or inbox writes.

import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ComputeRequest,
  ComputeResult,
  ComputeRun,
} from "../../../shared/contracts/compute.ts";
import {
  createUlTestAiResponse,
  createUlTestEmbedResponse,
  createUlTestNotifyResponse,
} from "../../services/ul-test-runtime.ts";

export class TestAIBinding extends WorkerEntrypoint<
  unknown,
  Record<string, never>
> {
  async call(_request: unknown, _execCtxHandle?: string) {
    return createUlTestAiResponse();
  }
}

export class TestEmbedBinding extends WorkerEntrypoint<
  unknown,
  Record<string, never>
> {
  async embed(_request: unknown, _execCtxHandle?: string) {
    return createUlTestEmbedResponse();
  }
}

export class TestNotifyBinding extends WorkerEntrypoint<
  unknown,
  Record<string, never>
> {
  async notifyOwner(_request: unknown, _execCtxHandle?: string) {
    return createUlTestNotifyResponse();
  }
}

const TEST_COMPUTE_TIME = "2000-01-01T00:00:00.000Z";

function testComputeRun(
  runId: string,
  status: ComputeRun["status"],
  request?: Partial<ComputeRequest>,
): ComputeRun {
  return {
    run_id: runId,
    receipt_id: `test-receipt-${runId}`,
    status,
    profile: request?.profile || "developer-v1",
    tools: Array.isArray(request?.tools) ? [...request.tools] : [],
    created_at: TEST_COMPUTE_TIME,
    ...(status === "completed"
      ? {
        started_at: TEST_COMPUTE_TIME,
        finished_at: TEST_COMPUTE_TIME,
        exit_code: 0,
        stdout: "",
        stderr: "",
        artifacts: [],
      }
      : {}),
  };
}

/** Host-only, no-side-effect gx.test replacement for Galactic Compute. */
export class TestComputeBinding extends WorkerEntrypoint<
  unknown,
  Record<string, never>
> {
  async call(request: ComputeRequest): Promise<ComputeResult> {
    const isAsync = request?.mode === "async";
    return {
      ...testComputeRun(
        "test-compute-run",
        isAsync ? "queued" : "completed",
        request,
      ),
      async: isAsync,
    } as ComputeResult;
  }

  async get(runId: string): Promise<ComputeRun> {
    return testComputeRun(runId || "test-compute-run", "completed");
  }

  async cancel(runId: string): Promise<ComputeRun> {
    return testComputeRun(runId || "test-compute-run", "cancelled");
  }
}
