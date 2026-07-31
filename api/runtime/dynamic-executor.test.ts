import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  buildDynamicCodemodeFunctionBindings,
  DYNAMIC_CODEMODE_INVOCATION_MODULE,
} from "./dynamic-executor.ts";

Deno.test("dynamic codemode builds explicit authority bindings per function", () => {
  const databaseProps: Array<Record<string, unknown>> = [];
  const dataProps: Array<Record<string, unknown>> = [];
  const built = buildDynamicCodemodeFunctionBindings({
    toolMap: {
      inspect: { appId: "app-1", fnName: "inspect" },
      mutate: { appId: "app-1", fnName: "mutate" },
    },
    authorities: {
      inspect: {
        databaseRead: true,
        databaseWrite: false,
        storageRead: true,
        storageWrite: false,
        storageDelete: false,
      },
      mutate: {
        databaseRead: false,
        databaseWrite: true,
        storageRead: false,
        storageWrite: true,
        storageDelete: true,
      },
    },
    databaseIds: { "app-1": "database-1" },
    userId: "user-1",
    factories: {
      DatabaseBinding: ({ props }) => {
        databaseProps.push(props);
        return { kind: "database", props };
      },
      AppDataBinding: ({ props }) => {
        dataProps.push(props);
        return { kind: "data", props };
      },
    },
  });

  assertEquals(databaseProps, [
    {
      databaseId: "database-1",
      appId: "app-1",
      userId: "user-1",
      allowRead: true,
      allowWrite: false,
    },
    {
      databaseId: "database-1",
      appId: "app-1",
      userId: "user-1",
      allowRead: false,
      allowWrite: true,
    },
  ]);
  assertEquals(dataProps, [
    {
      appId: "app-1",
      userId: "user-1",
      allowRead: true,
      allowWrite: false,
      allowDelete: false,
    },
    {
      appId: "app-1",
      userId: "user-1",
      allowRead: false,
      allowWrite: true,
      allowDelete: true,
    },
  ]);
  assert(
    built.functionBindingNames.inspect.database !==
      built.functionBindingNames.mutate.database,
  );
  assert(
    built.functionBindingNames.inspect.data !==
      built.functionBindingNames.mutate.data,
  );
});

interface InvocationRuntime {
  createSerializedFunctionInvoker(): (
    rpcEnv: Record<string, unknown>,
    fn: (args: unknown) => Promise<unknown>,
    args: unknown,
  ) => Promise<unknown>;
  resetRpcEnv(): void;
}

async function loadInvocationRuntime(): Promise<InvocationRuntime> {
  const encoded = btoa(DYNAMIC_CODEMODE_INVOCATION_MODULE);
  return await import(
    `data:text/javascript;base64,${encoded}#${crypto.randomUUID()}`
  ) as InvocationRuntime;
}

function rpcGlobal(): typeof globalThis & {
  __rpcEnv?: Record<string, unknown>;
} {
  return globalThis as typeof globalThis & {
    __rpcEnv?: Record<string, unknown>;
  };
}

Deno.test("dynamic codemode clears binding access before returning to recipe", async () => {
  const runtime = await loadInvocationRuntime();
  const invoke = runtime.createSerializedFunctionInvoker();
  const global = rpcGlobal();
  const previous = global.__rpcEnv;
  const sdkRemove = async (): Promise<unknown> => {
    const data = global.__rpcEnv?.DATA as
      | { remove?: () => unknown }
      | undefined;
    if (!data?.remove) throw new Error("Data not available");
    return await data.remove();
  };

  try {
    const inside = await invoke(
      { DATA: { remove: () => "removed" } },
      async () => await sdkRemove(),
      {},
    );
    assertEquals(inside, "removed");
    assertEquals(Object.keys(global.__rpcEnv ?? {}), []);
    await assertRejects(
      async () => await sdkRemove(),
      Error,
      "Data not available",
    );
  } finally {
    global.__rpcEnv = previous;
  }
});

Deno.test("dynamic codemode serializes concurrent cross-Agent binding ownership", async () => {
  const runtime = await loadInvocationRuntime();
  const invoke = runtime.createSerializedFunctionInvoker();
  const global = rpcGlobal();
  const previous = global.__rpcEnv;
  const events: string[] = [];
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const activeDataId = (): string =>
    String(
      (global.__rpcEnv?.DATA as { id?: unknown } | undefined)?.id ??
        "missing",
    );

  try {
    const first = invoke(
      { DATA: { id: "agent-a" } },
      async () => {
        events.push(`a:start:${activeDataId()}`);
        markFirstStarted();
        await firstGate;
        events.push(`a:end:${activeDataId()}`);
        return "a";
      },
      {},
    );
    await firstStarted;

    const second = invoke(
      { DATA: { id: "agent-b" } },
      async () => {
        events.push(`b:start:${activeDataId()}`);
        await Promise.resolve();
        events.push(`b:end:${activeDataId()}`);
        return "b";
      },
      {},
    );
    await Promise.resolve();
    assertEquals(events, ["a:start:agent-a"]);

    releaseFirst();
    assertEquals(await Promise.all([first, second]), ["a", "b"]);
    assertEquals(events, [
      "a:start:agent-a",
      "a:end:agent-a",
      "b:start:agent-b",
      "b:end:agent-b",
    ]);
    assertEquals(Object.keys(global.__rpcEnv ?? {}), []);
  } finally {
    global.__rpcEnv = previous;
  }
});
