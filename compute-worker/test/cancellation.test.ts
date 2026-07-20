import { describe, expect, it, vi } from "vitest";
import { coordinateComputeCancellation } from "../src/cancellation";

describe("per-run cancellation coordination", () => {
  it("aborts, destroys early, waits for unwind, then confirms final destroy", async () => {
    const events: string[] = [];
    const abort = new AbortController();
    abort.signal.addEventListener("abort", () => events.push("abort"));
    const completion = Promise.resolve().then(() => events.push("unwind"));
    await coordinateComputeCancellation({
      active: { abort, completion },
      destroy: vi.fn(async () => {
        events.push("destroy");
      }),
    });
    expect(events).toEqual(["abort", "destroy", "unwind", "destroy"]);
  });

  it("does not acknowledge a body when executor unwind times out", async () => {
    const destroy = vi.fn(() => Promise.resolve());
    await expect(coordinateComputeCancellation({
      active: {
        abort: new AbortController(),
        completion: new Promise(() => undefined),
      },
      destroy,
      unwindTimeoutMs: 5,
    })).rejects.toThrow("compute cancellation unwind timed out");
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("requires the final bounded destroy even if the early attempt failed", async () => {
    const destroy = vi.fn()
      .mockRejectedValueOnce(new Error("early failure"))
      .mockResolvedValueOnce(undefined);
    await coordinateComputeCancellation({
      active: {
        abort: new AbortController(),
        completion: Promise.resolve(),
      },
      destroy,
    });
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("surfaces final destroy failure", async () => {
    const destroy = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("final destroy failed"));
    await expect(coordinateComputeCancellation({
      active: {
        abort: new AbortController(),
        completion: Promise.resolve(),
      },
      destroy,
    })).rejects.toThrow("final destroy failed");
  });
});
