// Parent-isolate RPC binding for galactic.compute(). The body receives this
// narrow capability but never receives a human/Agent bearer, platform key,
// control-plane credential, or compute-worker job token.

import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
  ComputeRequest,
  ComputeResult,
  ComputeRun,
} from '../../../shared/contracts/compute.ts';
import {
  type ComputeBindingProps,
  createComputeBindingOperations,
} from './compute-binding-core.ts';

export class ComputeBinding extends WorkerEntrypoint<unknown, ComputeBindingProps> {
  async call(
    request: ComputeRequest,
    execCtxHandle?: string,
    callIndex?: number,
  ): Promise<ComputeResult> {
    return await createComputeBindingOperations(this.ctx.props).call(
      request,
      execCtxHandle,
      callIndex,
    );
  }

  async get(runId: string, execCtxHandle?: string): Promise<ComputeRun> {
    return await createComputeBindingOperations(this.ctx.props).get(
      runId,
      execCtxHandle,
    );
  }

  async cancel(runId: string, execCtxHandle?: string): Promise<ComputeRun> {
    return await createComputeBindingOperations(this.ctx.props).cancel(
      runId,
      execCtxHandle,
    );
  }
}
