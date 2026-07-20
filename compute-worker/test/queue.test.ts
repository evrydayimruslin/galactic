import { describe, expect, it } from "vitest";
import type { Env } from "../src/contracts";
import { ComputeRunBusyError } from "../src/errors";
import { processComputeQueueDelivery } from "../src/queue";

const env = {} as Env;
const message = {
  version: 1,
  run_id: "00000000-0000-4000-8000-000000000010",
};

describe("Compute queue delivery classification", () => {
  it("ACKs success and defers a healthy concurrency miss to dispatch recovery", async () => {
    await expect(processComputeQueueDelivery(
      env,
      message,
      async () => null,
    )).resolves.toBe("ack");
    await expect(processComputeQueueDelivery(
      env,
      message,
      async () => {
        throw new ComputeRunBusyError();
      },
    )).resolves.toBe("deferred");
  });

  it("defers a busy error after Durable Object RPC strips its prototype", async () => {
    await expect(processComputeQueueDelivery(
      env,
      message,
      async () => {
        const serialized = new Error("compute concurrency slot is busy");
        serialized.name = "ComputeRunBusyError";
        throw serialized;
      },
    )).resolves.toBe("deferred");
  });

  it("throws real failures so Queue retry and DLQ policy still apply", async () => {
    await expect(processComputeQueueDelivery(
      env,
      message,
      async () => {
        throw new Error("container failed");
      },
    )).rejects.toThrow("container failed");
  });
});
