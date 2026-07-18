import { describe, expect, it } from "vitest";

import { LaunchApiRequestError } from "./api";
import {
  normalizeInterfaceBridgeError,
  postInterfaceBridgeResult,
  runInterfaceFunctionDurably,
} from "./interface-bridge";
import type {
  LaunchFunctionRunResponse,
  LaunchJobStatusResponse,
} from "../../../../shared/contracts/launch.ts";

const agent = { id: "agent-1", slug: "agent-1", name: "Agent One" };

function dispatch(result: unknown): LaunchFunctionRunResponse {
  return {
    success: true,
    agent,
    tool: agent,
    functionName: "save",
    result,
    receiptId: null,
    warnings: [],
    error: null,
    generatedAt: "2026-07-17T00:00:00.000Z",
  };
}

function job(
  status: LaunchJobStatusResponse["status"],
  overrides: Partial<LaunchJobStatusResponse> = {},
): LaunchJobStatusResponse {
  return {
    jobId: "7f1e6f0a-2b3c-4d5e-8f90-123456789abc",
    status,
    result: null,
    error: null,
    durationMs: null,
    aiCostCredits: 0,
    admissionWait: null,
    executionId: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    completedAt: null,
    generatedAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeInterfaceBridgeError", () => {
  it("preserves capacity scope and retry metadata from Launch API errors", () => {
    const retryAt = "2026-07-18T01:50:58.499584+00:00";
    const error = new LaunchApiRequestError(
      `Account capacity is waiting. Work can resume at ${retryAt}.`,
      429,
      "capacity_waiting",
      {
        retry_at: retryAt,
        binding_constraint: "account",
        burst_resets_at: retryAt,
      },
    );

    expect(normalizeInterfaceBridgeError(error)).toEqual({
      type: "capacity_waiting",
      code: "capacity_waiting",
      message: `Account capacity is waiting. Work can resume at ${retryAt}.`,
      status: 429,
      details: {
        retry_at: retryAt,
        binding_constraint: "account",
        burst_resets_at: retryAt,
      },
      retryAt,
      retryable: true,
      scope: "account",
    });
  });

  it("keeps structured function errors instead of collapsing them", () => {
    expect(normalizeInterfaceBridgeError({
      type: "MISSING_SECRETS",
      message: "Mailbox credentials are missing.",
      details: { missing: ["IMAP_PASS"] },
    })).toMatchObject({
      type: "MISSING_SECRETS",
      code: "MISSING_SECRETS",
      message: "Mailbox credentials are missing.",
      details: { missing: ["IMAP_PASS"] },
    });
  });

  it("treats nested concurrency saturation as a retryable capacity wait", () => {
    const retryAt = "2026-07-18T02:00:00.000Z";
    expect(normalizeInterfaceBridgeError({
      type: "ConcurrencyWaitingError",
      message: "Too many AI calls are already in progress.",
      details: {
        type: "concurrency_waiting",
        retry_at: retryAt,
        binding_constraint: "account",
        concurrency_scope: "ai",
      },
    })).toMatchObject({
      type: "ConcurrencyWaitingError",
      code: "ConcurrencyWaitingError",
      retryAt,
      retryable: true,
      scope: "ai",
    });
  });

  it("makes a cap-too-low error owner-actionable instead of auto-resumable", () => {
    expect(normalizeInterfaceBridgeError({
      type: "agent_cap_too_low_for_request",
      message: "This Agent's cap cannot admit one execution.",
      retryAt: "2026-07-18T02:00:00.000Z",
    })).toMatchObject({
      type: "agent_cap_too_low_for_request",
      retryable: false,
      autoResumes: false,
      ownerActionRequired: true,
    });
  });
});

describe("postInterfaceBridgeResult", () => {
  it("settles the caller with a clone-safe error when a result cannot be cloned", () => {
    const delivered: unknown[] = [];
    const port = {
      postMessage(message: unknown) {
        structuredClone(message);
        delivered.push(message);
      },
    };

    postInterfaceBridgeResult(port, "call-1", {
      success: true,
      result: { addLight() {} },
    });

    expect(delivered).toEqual([{
      type: "result",
      id: "call-1",
      success: false,
      error: {
        type: "UNSERIALIZABLE_RESULT",
        message:
          "The Agent returned a result the Interface could not safely receive.",
      },
    }]);
  });
});

describe("runInterfaceFunctionDurably", () => {
  it("queues once, follows a capacity-deferred job, and returns its result", async () => {
    const runCalls: unknown[] = [];
    const statuses = [
      job("queued", {
        admissionWait: {
          code: "capacity_waiting",
          retryAt: "2026-07-18T02:00:00.000Z",
          nextAttemptAt: "2026-07-18T02:00:00.000Z",
          scope: "account",
          message: "Capacity will resume automatically.",
        },
      }),
      job("completed", { result: { saved: true } }),
    ];
    const slept: number[] = [];
    const result = await runInterfaceFunctionDurably({
      client: {
        runAgentFunction: async (...args) => {
          runCalls.push(args);
          return dispatch({
            _async: true,
            job_id: statuses[0].jobId,
            status: "queued",
          });
        },
        launchJob: async () => statuses.shift()!,
      },
      agentId: agent.id,
      functionName: "save",
      args: { value: 42 },
      sleep: async (milliseconds) => {
        slept.push(milliseconds);
      },
    });

    expect(result).toEqual({
      success: true,
      result: { saved: true },
      error: null,
    });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toEqual([
      agent.id,
      "save",
      { args: { value: 42, _async: true } },
    ]);
    expect(slept).toHaveLength(1);
  });

  it("does not claim that a rejected pre-queue write will auto-resume", async () => {
    const result = await runInterfaceFunctionDurably({
      client: {
        runAgentFunction: async () => {
          throw new LaunchApiRequestError(
            "Account capacity is waiting.",
            429,
            "capacity_waiting",
            { retry_at: "2026-07-18T02:00:00.000Z" },
          );
        },
        launchJob: async () => {
          throw new Error("must not poll");
        },
      },
      agentId: agent.id,
      functionName: "save",
      args: {},
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        type: "capacity_waiting",
        executionMode: "sync",
        autoResumes: false,
      },
    });
  });

  it("surfaces a terminal cap policy failure without replaying the job", async () => {
    let polls = 0;
    const result = await runInterfaceFunctionDurably({
      client: {
        runAgentFunction: async () =>
          dispatch({
            _async: true,
            job_id: "7f1e6f0a-2b3c-4d5e-8f90-123456789abc",
            status: "queued",
          }),
        launchJob: async () => {
          polls += 1;
          return job("failed", {
            error: {
              type: "agent_cap_too_low_for_request",
              message: "Raise this Agent's capacity cap.",
            },
          });
        },
      },
      agentId: agent.id,
      functionName: "save",
      args: {},
    });

    expect(polls).toBe(1);
    expect(result).toMatchObject({
      success: false,
      error: {
        type: "agent_cap_too_low_for_request",
        executionMode: "durable_async",
        autoResumes: false,
        ownerActionRequired: true,
        jobId: "7f1e6f0a-2b3c-4d5e-8f90-123456789abc",
      },
    });
  });

  it("marks non-retryable status loss as unknown without re-dispatching", async () => {
    let dispatches = 0;
    const result = await runInterfaceFunctionDurably({
      client: {
        runAgentFunction: async () => {
          dispatches += 1;
          return dispatch({
            _async: true,
            job_id: "7f1e6f0a-2b3c-4d5e-8f90-123456789abc",
            status: "queued",
          });
        },
        launchJob: async () => {
          throw new LaunchApiRequestError("Job status forbidden.", 403);
        },
      },
      agentId: agent.id,
      functionName: "save",
      args: {},
    });

    expect(dispatches).toBe(1);
    expect(result).toMatchObject({
      success: false,
      error: {
        type: "JOB_STATUS_UNAVAILABLE",
        executionMode: "durable_async",
        autoResumes: false,
        completionUnknown: true,
      },
    });
  });
});
