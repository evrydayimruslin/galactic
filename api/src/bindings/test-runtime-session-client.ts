import {
  UL_TEST_BLOCKED_EFFECTS,
  type UlTestObservedEffect,
} from "../../services/ul-test-runtime.ts";

/**
 * Narrow RPC surface of the invocation-owned gx.test Durable Object.
 *
 * Test WorkerEntrypoint props carry only `sessionName`, never a nested RPC
 * capability. Each binding resolves the same Durable Object namespace from its
 * own trusted host context after crossing Worker Loader.
 */
export interface TestRuntimeSessionRpc {
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

export interface TestRuntimeSessionBindingProps {
  sessionName: string;
}

interface TestRuntimeSessionNamespace {
  getByName(name: string): TestRuntimeSessionRpc;
}

export function resolveTestRuntimeSession<
  Props extends TestRuntimeSessionBindingProps,
>(
  ctx: ExecutionContext<Props>,
): TestRuntimeSessionRpc {
  const sessionName = ctx.props.sessionName;
  if (
    typeof sessionName !== "string" ||
    !sessionName.startsWith("gx-test-") ||
    sessionName.length > 128
  ) {
    throw new Error("gx.test state session name is invalid");
  }

  const namespace = (
    ctx as unknown as {
      exports?: {
        GxTestSession?: TestRuntimeSessionNamespace;
      };
    }
  ).exports?.GxTestSession;
  if (!namespace || typeof namespace.getByName !== "function") {
    throw new Error(
      "gx.test runtime is unavailable: missing host export GxTestSession",
    );
  }
  return namespace.getByName(sessionName);
}
