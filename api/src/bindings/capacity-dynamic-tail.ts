import { WorkerEntrypoint } from "cloudflare:workers";
import {
  buildDynamicCapacityObservations,
  type DynamicTailItemLike,
} from "../../services/capacity-tail-observation.ts";

interface QueueBinding {
  send(body: unknown, options?: { delaySeconds?: number }): Promise<void>;
}

interface CapacityDynamicTailEnv {
  CAPACITY_TELEMETRY_QUEUE: QueueBinding;
}

/**
 * Loopback Tail entrypoint attached through WorkerCode.tails. Dynamic Workers
 * are separate from the loader Worker, so the loader's configured Tail Worker
 * cannot observe their startup/execution CPU.
 */
export class CapacityDynamicTail
  extends WorkerEntrypoint<CapacityDynamicTailEnv, Record<string, never>> {
  override async tail(items: TraceItem[]): Promise<void> {
    const observations = buildDynamicCapacityObservations(
      items as DynamicTailItemLike[],
    );
    await Promise.all(
      observations.map((observation) =>
        // The child trace can arrive before the loader Worker has committed its
        // settlement row. A short queue delay avoids a predictable retry race;
        // SQL idempotency and the durable observation inbox are the backstop.
        this.env.CAPACITY_TELEMETRY_QUEUE.send(observation, {
          delaySeconds: 2,
        })
      ),
    );
  }
}
