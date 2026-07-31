// Host-only RPC bindings for gx.test. Dynamic test isolates receive these in
// place of production AI/embed/notification bindings, so validation can execute
// realistic code without provider requests, Light billing, or inbox writes.

import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ComputeRequest,
  ComputeResult,
  ComputeRun,
} from "../../../shared/contracts/compute.ts";
import type { ComputeBindingRpcResult } from "./compute-binding-core.ts";
import {
  blockUlTestEffect,
  createUlTestAiResponse,
  createUlTestEmbedResponse,
  createUlTestNotifyResponse,
  createUlTestRunsResponse,
  UL_TEST_BLOCKED_EFFECTS,
  UL_TEST_OBSERVED_EFFECTS,
  type UlTestObservedEffect,
} from "../../services/ul-test-runtime.ts";
import type { HttpTestFixtureConfig } from "../../services/http-test-fixtures.ts";
import { type MemoryScope, normalizeMemoryScope } from "./memory-scope.ts";
import type { CredentialRequestInit } from "./credential-inject.ts";
import { resolveHttpTestRuntimeResponse } from "./http-test-runtime.ts";

/**
 * Shape of the invocation-owned Durable Object stub received by the stateless
 * Test* WorkerEntrypoints. Every call is asynchronous at the RPC boundary.
 */
interface TestRuntimeSessionRpc {
  storeAppData(key: string, value: unknown): Promise<void>;
  loadAppData(key: string): Promise<unknown>;
  removeAppData(key: string): Promise<void>;
  listAppData(prefix?: string): Promise<string[]>;
  rememberMemory(
    scope: "agent" | "user",
    key: string,
    value: unknown,
  ): Promise<void>;
  recallMemory(scope: "agent" | "user", key: string): Promise<unknown>;
  beginHttpFixtureAttempt(): Promise<void>;
  reserveHttpFixtureExchangeBytes(
    requestBytes: number,
    responseBytes: number,
  ): Promise<void>;
  recordBlockedEffect(
    effect: typeof UL_TEST_BLOCKED_EFFECTS[
      keyof typeof UL_TEST_BLOCKED_EFFECTS
    ],
  ): Promise<void>;
  recordObservedEffect(effect: UlTestObservedEffect): Promise<void>;
  sealAndSnapshot(): Promise<{
    blockedEffects: string[];
    observedEffects: string[];
  }>;
  close(): Promise<void>;
}

interface TestSessionBindingProps {
  session: TestRuntimeSessionRpc;
}

interface TestHttpBindingProps extends TestSessionBindingProps {
  fixtures: HttpTestFixtureConfig;
  allowedDestinations: string[];
}

interface TestCredentialBindingProps extends TestHttpBindingProps {
  credentialDestinations: Record<string, string>;
}

/**
 * Invocation-local replacement for R2-backed Agent data.
 */
export class TestAppDataBinding extends WorkerEntrypoint<
  unknown,
  TestSessionBindingProps
> {
  async store(
    key: string,
    value: unknown,
    _execCtxHandle?: string,
  ): Promise<void> {
    await this.ctx.props.session.recordObservedEffect(
      UL_TEST_OBSERVED_EFFECTS.storageWrite,
    );
    await this.ctx.props.session.storeAppData(key, value);
  }

  async load(key: string, _execCtxHandle?: string): Promise<unknown> {
    await this.ctx.props.session.recordObservedEffect(
      UL_TEST_OBSERVED_EFFECTS.storageRead,
    );
    return await this.ctx.props.session.loadAppData(key);
  }

  async remove(key: string, _execCtxHandle?: string): Promise<void> {
    await this.ctx.props.session.recordObservedEffect(
      UL_TEST_OBSERVED_EFFECTS.storageDelete,
    );
    await this.ctx.props.session.removeAppData(key);
  }

  async list(
    prefix?: string,
    _execCtxHandle?: string,
  ): Promise<string[]> {
    await this.ctx.props.session.recordObservedEffect(
      UL_TEST_OBSERVED_EFFECTS.storageRead,
    );
    return await this.ctx.props.session.listAppData(prefix);
  }
}

/** Invocation-local replacement for both Agent- and user-scoped Memory.md. */
export class TestMemoryBinding extends WorkerEntrypoint<
  unknown,
  TestSessionBindingProps
> {
  async remember(
    key: string,
    value: unknown,
    scope?: MemoryScope,
    _execCtxHandle?: string,
  ): Promise<void> {
    await this.ctx.props.session.recordObservedEffect(
      UL_TEST_OBSERVED_EFFECTS.memoryWrite,
    );
    await this.ctx.props.session.rememberMemory(
      normalizeMemoryScope(scope),
      key,
      value,
    );
  }

  async recall(
    key: string,
    scope?: MemoryScope,
    _execCtxHandle?: string,
  ): Promise<unknown> {
    await this.ctx.props.session.recordObservedEffect(
      UL_TEST_OBSERVED_EFFECTS.memoryRead,
    );
    return await this.ctx.props.session.recallMemory(
      normalizeMemoryScope(scope),
      key,
    );
  }
}

/** Routine history is persistent production state; gx.test starts empty. */
export class TestRunsBinding extends WorkerEntrypoint<
  unknown,
  TestSessionBindingProps
> {
  async recent(
    _limit?: number,
    _execCtxHandle?: string,
  ): Promise<{ runs: unknown[] }> {
    await this.ctx.props.session.recordObservedEffect(
      UL_TEST_OBSERVED_EFFECTS.routineRead,
    );
    return createUlTestRunsResponse();
  }
}

/**
 * Exact, canned raw HTTP. A match returns a fresh synthetic Response; a miss,
 * invalid destination, or unreadable request latches containment failure.
 * There is deliberately no live fetch implementation in this binding.
 */
export class TestOutboundBinding extends WorkerEntrypoint<
  unknown,
  TestHttpBindingProps
> {
  override async fetch(request: Request): Promise<Response> {
    return await resolveHttpTestRuntimeResponse({
      kind: "raw",
      request,
      fixtures: this.ctx.props.fixtures,
      allowedDestinations: this.ctx.props.allowedDestinations,
      recorder: this.ctx.props.session,
    });
  }

  override async connect(_socket: Socket): Promise<void> {
    return await blockUlTestEffect(
      this.ctx.props.session,
      UL_TEST_BLOCKED_EFFECTS.outboundTcp,
    );
  }
}

/**
 * Exact, canned credentialed HTTP. Only the credential declaration (key and
 * destination) enters this host binding; no credential value is materialized,
 * injected, logged, or returned.
 */
export class TestCredentialBinding extends WorkerEntrypoint<
  unknown,
  TestCredentialBindingProps
> {
  async authenticatedFetch(
    credentialKey: string,
    url: string,
    init?: CredentialRequestInit,
  ): Promise<Response> {
    let request: Request;
    try {
      const method = (init?.method ?? "GET").toUpperCase();
      request = new Request(url, {
        method,
        headers: init?.headers,
        body: method === "GET" || method === "HEAD" ? null : init?.body ?? null,
        redirect: "manual",
      });
    } catch {
      await this.ctx.props.session.recordObservedEffect(
        UL_TEST_OBSERVED_EFFECTS.credentialHttp,
      );
      return await blockUlTestEffect(
        this.ctx.props.session,
        UL_TEST_BLOCKED_EFFECTS.credentialedHttp,
      );
    }
    return await resolveHttpTestRuntimeResponse({
      kind: "credential",
      credentialKey,
      request,
      fixtures: this.ctx.props.fixtures,
      allowedDestinations: this.ctx.props.allowedDestinations,
      credentialDestinations: this.ctx.props.credentialDestinations,
      recorder: this.ctx.props.session,
    });
  }
}

/** IMAP/SMTP sockets are unavailable until a protocol fixture is declared. */
export class TestNetworkBinding extends WorkerEntrypoint<
  unknown,
  TestSessionBindingProps
> {
  async imapFetchUnseen(..._args: unknown[]): Promise<never> {
    return await blockUlTestEffect(
      this.ctx.props.session,
      UL_TEST_BLOCKED_EFFECTS.imap,
    );
  }

  async smtpSend(..._args: unknown[]): Promise<never> {
    return await blockUlTestEffect(
      this.ctx.props.session,
      UL_TEST_BLOCKED_EFFECTS.smtp,
    );
  }
}

/** Publishing an event would mutate the live event bus, so tests reject it. */
export class TestEventsBinding extends WorkerEntrypoint<
  unknown,
  TestSessionBindingProps
> {
  async emit(
    _topic: unknown,
    _payload: unknown,
    _execCtxHandle?: string,
  ): Promise<never> {
    return await blockUlTestEffect(
      this.ctx.props.session,
      UL_TEST_BLOCKED_EFFECTS.eventPublish,
    );
  }
}

/** Cross-Agent calls must never reach the live internal SELF service. */
export class TestAppCallBinding extends WorkerEntrypoint<
  unknown,
  TestSessionBindingProps
> {
  override async fetch(_request: Request): Promise<Response> {
    return await blockUlTestEffect(
      this.ctx.props.session,
      UL_TEST_BLOCKED_EFFECTS.agentCall,
    );
  }
}

export class TestAIBinding extends WorkerEntrypoint<
  unknown,
  TestSessionBindingProps
> {
  async call(_request: unknown, _execCtxHandle?: string) {
    await this.ctx.props.session.recordObservedEffect(
      UL_TEST_OBSERVED_EFFECTS.inferenceGenerate,
    );
    return createUlTestAiResponse();
  }
}

export class TestEmbedBinding extends WorkerEntrypoint<
  unknown,
  TestSessionBindingProps
> {
  async embed(_request: unknown, _execCtxHandle?: string) {
    await this.ctx.props.session.recordObservedEffect(
      UL_TEST_OBSERVED_EFFECTS.inferenceEmbed,
    );
    return createUlTestEmbedResponse();
  }
}

export class TestNotifyBinding extends WorkerEntrypoint<
  unknown,
  TestSessionBindingProps
> {
  async notifyOwner(_request: unknown, _execCtxHandle?: string) {
    await this.ctx.props.session.recordObservedEffect(
      UL_TEST_OBSERVED_EFFECTS.notificationOwnerWrite,
    );
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
  TestSessionBindingProps
> {
  async call(
    request: ComputeRequest,
  ): Promise<ComputeBindingRpcResult<ComputeResult>> {
    await this.ctx.props.session.recordObservedEffect(
      UL_TEST_OBSERVED_EFFECTS.computeExecute,
    );
    const isAsync = request?.mode === "async";
    return {
      ok: true,
      value: {
        ...testComputeRun(
          "test-compute-run",
          isAsync ? "queued" : "completed",
          request,
        ),
        async: isAsync,
      } as ComputeResult,
    };
  }

  async get(
    runId: string,
  ): Promise<ComputeBindingRpcResult<ComputeRun>> {
    await this.ctx.props.session.recordObservedEffect(
      UL_TEST_OBSERVED_EFFECTS.computeExecute,
    );
    return {
      ok: true,
      value: testComputeRun(runId || "test-compute-run", "completed"),
    };
  }

  async cancel(
    runId: string,
  ): Promise<ComputeBindingRpcResult<ComputeRun>> {
    await this.ctx.props.session.recordObservedEffect(
      UL_TEST_OBSERVED_EFFECTS.computeExecute,
    );
    return {
      ok: true,
      value: testComputeRun(runId || "test-compute-run", "cancelled"),
    };
  }
}
