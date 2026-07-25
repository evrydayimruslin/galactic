// Parent-isolate RPC binding for galactic.compute(). The body receives this
// narrow capability but never receives a human/Agent bearer, platform key,
// control-plane credential, or compute-worker job token.

import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ComputeRequest,
  ComputeResult,
  ComputeRun,
} from "../../../shared/contracts/compute.ts";
import type { Env } from "../../lib/env.ts";
import { createComputeControlPlaneAdapter } from "../../services/compute-orchestrator.ts";
import {
  captureComputeBindingRpc,
  type ComputeBindingProps,
  type ComputeBindingRpcResult,
  createComputeBindingOperations,
  markComputeBindingCapacity,
} from "./compute-binding-core.ts";

export class ComputeBinding extends WorkerEntrypoint<Env, ComputeBindingProps> {
  async call(
    request: ComputeRequest,
    callIndex?: number,
  ): Promise<ComputeBindingRpcResult<ComputeResult>> {
    return await captureComputeBindingRpc(async () => {
      markComputeBindingCapacity(this.ctx.props);
      globalThis.__env = this.env;
      globalThis.__ctx = this.ctx;
      return await createComputeBindingOperations(
        this.ctx.props,
        createComputeControlPlaneAdapter({ env: this.env }),
      ).call(request, callIndex);
    });
  }

  async get(runId: string): Promise<ComputeBindingRpcResult<ComputeRun>> {
    return await captureComputeBindingRpc(async () => {
      markComputeBindingCapacity(this.ctx.props);
      globalThis.__env = this.env;
      globalThis.__ctx = this.ctx;
      return await createComputeBindingOperations(
        this.ctx.props,
        createComputeControlPlaneAdapter({ env: this.env }),
      ).get(runId);
    });
  }

  async cancel(runId: string): Promise<ComputeBindingRpcResult<ComputeRun>> {
    return await captureComputeBindingRpc(async () => {
      markComputeBindingCapacity(this.ctx.props);
      globalThis.__env = this.env;
      globalThis.__ctx = this.ctx;
      return await createComputeBindingOperations(
        this.ctx.props,
        createComputeControlPlaneAdapter({ env: this.env }),
      ).cancel(runId);
    });
  }
}
