// Host-only RPC bindings for gx.test. Dynamic test isolates receive these in
// place of production AI/embed/notification bindings, so validation can execute
// realistic code without provider requests, Light billing, or inbox writes.

import { WorkerEntrypoint } from "cloudflare:workers";
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
