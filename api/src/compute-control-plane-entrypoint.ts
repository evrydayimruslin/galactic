import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../lib/env.ts";
import {
  handleComputePrivateGatewayRequest,
  handleTrustedComputeLifecycleRequest,
} from "../services/compute-private-gateway.ts";
import {
  notifyComputeInfrastructureFailure,
  notifyComputeSettlementPending,
} from "../services/compute/alerts.ts";
import { getComputeRunByIdInternal } from "../services/compute/runs.ts";

/**
 * Private API control plane exported only as a named WorkerEntrypoint.
 *
 * Do not route this class from the default HTTP fetch handler. The dedicated
 * Compute Worker reaches it through a Cloudflare service binding: lifecycle
 * calls use /internal/compute/runs/* and body calls use /v1/* after the Sandbox
 * proxy has replaced every caller-supplied identity header.
 */
export class ComputeControlPlane extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    globalThis.__env = this.env;
    globalThis.__ctx = this.ctx;

    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/internal/compute/runs/")) {
      return await handleTrustedComputeLifecycleRequest(request, {
        onWorkerFailure: async (event) => {
          if (event.outcome === "cancelled") return;
          await notifyComputeInfrastructureFailure(event, {
            code: event.code,
            message: "The disposable Compute body did not complete normally.",
            retryable: [
              "image_unavailable",
              "artifact_error",
              "internal_error",
            ].includes(event.code),
          });
        },
        onSettlementPending: async ({ runId }) => {
          const run = await getComputeRunByIdInternal(runId);
          if (run) {
            await notifyComputeSettlementPending({
              runId: run.id,
              userId: run.userId,
              agentId: run.agentId,
              callerFunction: run.callerFunction,
            });
          }
        },
      });
    }
    if (pathname.startsWith("/v1/")) {
      return await handleComputePrivateGatewayRequest(request, {
        artifactBucket: this.env.COMPUTE_ARTIFACTS,
      });
    }
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
}
