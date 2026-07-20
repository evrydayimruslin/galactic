import { WorkerEntrypoint } from "cloudflare:workers";
import { ContainerProxy, Sandbox } from "@cloudflare/sandbox";
import type {
  ComputeCoordinatorStub,
  ComputeRunReceipt,
  Env,
} from "./contracts";
import {
  cancelComputeSandbox,
  executeComputeRun,
  parseDispatchMessage,
  sandboxIdForRun,
} from "./executor";
import { processComputeQueueDelivery } from "./queue";
import { proxyComputeGateway } from "./security";
import {
  forwardComputePublicHttp,
  HTTP_INTERCEPT_DENIED_HOST_PATTERNS,
} from "./egress";
import { coordinateComputeCancellation } from "./cancellation";

export { ContainerProxy };

const PRIVATE_GATEWAY_HOST = "galactic.internal";

function coordinatorForRun(env: Env, input: unknown): {
  dispatch: ReturnType<typeof parseDispatchMessage>;
  stub: ComputeCoordinatorStub;
} {
  const dispatch = parseDispatchMessage(input);
  const id = env.COMPUTE_STANDARD.idFromName(sandboxIdForRun(dispatch.run_id));
  return {
    dispatch,
    stub: env.COMPUTE_STANDARD.get(id) as unknown as ComputeCoordinatorStub,
  };
}

async function executeCoordinated(env: Env, input: unknown) {
  return await coordinatorForRun(env, input).stub.executeCoordinated(input);
}

/**
 * One disposable Linux body per compute run. The class contains no ambient
 * database, provider, account, or platform credentials. Explicit
 * developer-configured secrets are written only after the control plane has
 * claimed and prepared a lease.
 */
export class ComputeStandard extends Sandbox<Env> {
  sleepAfter = "1m";
  // With the base switch off, Cloudflare denies non-80/443 transport and
  // arbitrary DNS destinations. HTTP(S) is enabled only by the registered
  // outbound Worker below, so handler loss fails closed instead of falling
  // through to direct fetch; galactic.internal takes the private handler.
  enableInternet = false;
  interceptHttps = true;
  deniedHosts = [...HTTP_INTERCEPT_DENIED_HOST_PATTERNS];

  #active: {
    runId: string;
    abort: AbortController;
    promise: Promise<ComputeRunReceipt | null>;
  } | null = null;

  /** Serialize execution and cancellation in the deterministic per-run DO. */
  async executeCoordinated(message: unknown): Promise<ComputeRunReceipt | null> {
    const dispatch = parseDispatchMessage(message);
    if (this.#active) {
      if (this.#active.runId !== dispatch.run_id) {
        throw new Error("Compute coordinator is already bound to another run");
      }
      return await this.#active.promise;
    }
    const abort = new AbortController();
    const promise = executeComputeRun(this.env, message, {
      sandboxForRun: () => this,
      externalAbortSignal: abort.signal,
    });
    this.#active = { runId: dispatch.run_id, abort, promise };
    try {
      return await promise;
    } finally {
      if (this.#active?.promise === promise) this.#active = null;
    }
  }

  /** Abort, await unwind, then destroy again so no late SDK call can revive it. */
  async cancelCoordinated(message: unknown): Promise<{ destroyed: true }> {
    const dispatch = parseDispatchMessage(message);
    const active = this.#active;
    await coordinateComputeCancellation({
      ...(active && active.runId === dispatch.run_id
        ? { active: { abort: active.abort, completion: active.promise } }
        : {}),
      // Reuse the executor's bounded, three-attempt whole-body destroy. The
      // deterministic coordinator itself is the exact Sandbox for this run.
      destroy: () =>
        cancelComputeSandbox(this.env, dispatch.run_id, {
          sandboxForRun: () => this,
        }),
    });
    return { destroyed: true };
  }
}

// These must be assignments after class definition. @cloudflare/containers
// registers handlers in inherited static setters; ES class fields named
// `outbound`/`outboundByHost` would shadow those setters and silently fall
// through to an unregistered/fail-closed egress configuration.
ComputeStandard.outboundByHost = {
  [PRIVATE_GATEWAY_HOST]: async (
    request: Request,
    env: Env,
    context: { containerId: string; className: string },
  ): Promise<Response> =>
    await proxyComputeGateway(request, env.CONTROL_PLANE, context),
};
ComputeStandard.outbound = async (request: Request): Promise<Response> =>
  await forwardComputePublicHttp(request);

/** Private RPC entrypoint bound only from the Galactic API Worker. */
export class ComputePlane extends WorkerEntrypoint<Env> {
  async runtimeIdentity(): Promise<{
    profile: "developer-v1";
    environmentDigest: string;
  }> {
    return {
      profile: "developer-v1",
      environmentDigest: this.env.COMPUTE_ENVIRONMENT_DIGEST,
    };
  }

  async executeRun(message: unknown): Promise<ComputeRunReceipt | null> {
    return await executeCoordinated(this.env, message);
  }

  async cancelRun(input: unknown): Promise<{ destroyed: true }> {
    return await coordinatorForRun(this.env, input).stub.cancelCoordinated(input);
  }
}

export default {
  fetch(): Response {
    return new Response("not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        // A malformed, version-skewed dispatch is deterministic poison. It must
        // be observable, but retrying it can never make it valid.
        parseDispatchMessage(message.body);
      } catch (error) {
        console.error(JSON.stringify({
          event: "compute.dispatch_rejected",
          message_id: message.id,
          error: error instanceof Error ? error.message.slice(0, 500) : "invalid dispatch",
        }));
        message.ack();
        continue;
      }
      try {
        const outcome = await processComputeQueueDelivery(
          env,
          message.body,
          executeCoordinated,
        );
        if (outcome === "deferred") {
          console.info(JSON.stringify({
            event: "compute.delivery_deferred_for_concurrency",
            message_id: message.id,
          }));
        }
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          event: "compute.delivery_failed",
          message_id: message.id,
          error: error instanceof Error ? error.message.slice(0, 500) : "unknown failure",
        }));
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
