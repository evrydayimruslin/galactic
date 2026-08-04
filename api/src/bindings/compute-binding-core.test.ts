import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import type {
  ComputeResult,
  ComputeRun,
} from "../../../shared/contracts/compute.ts";
import {
  COMPUTE_ADMISSION_DISABLED_ACTION,
  COMPUTE_ADMISSION_DISABLED_CODE,
  COMPUTE_ADMISSION_DISABLED_HINT,
  COMPUTE_ADMISSION_DISABLED_MESSAGE,
  normalizeComputePublicError,
} from "../../../shared/contracts/compute.ts";
import {
  captureComputeBindingRpc,
  type ComputeBindingProps,
  createComputeAdmissionDisabledProof,
  createComputeBindingOperations,
  deriveComputeIdempotencyKey,
  markComputeBindingCapacity,
} from "./compute-binding-core.ts";
import {
  type ComputeAdmissionInput,
  type ComputeControlPlaneAdapter,
  type ComputeRunLookupInput,
  PublicComputeControlPlaneError,
} from "./compute-control-plane-adapter.ts";

const PROPS: ComputeBindingProps = {
  userId: "00000000-0000-4000-8000-000000000001",
  agentId: "00000000-0000-4000-8000-000000000002",
  callerFunction: "build_report",
  executionId: "00000000-0000-4000-8000-000000000003",
  executionDeadlineAtMs: Date.now() + 300_000,
  billingMode: "wallet",
  capacityAgentId: "00000000-0000-4000-8000-000000000002",
  capacityReceiptId: null,
  admissionDisabledProofKey: "a".repeat(64),
};

function publicRun(status: ComputeRun["status"] = "completed"): ComputeRun {
  return {
    run_id: "00000000-0000-4000-8000-000000000004",
    receipt_id: "00000000-0000-4000-8000-000000000005",
    status,
    profile: "developer-v1",
    tools: ["cli.duckdb"],
    created_at: "2026-07-19T00:00:00.000Z",
    ...(status === "completed"
      ? {
        started_at: "2026-07-19T00:00:01.000Z",
        finished_at: "2026-07-19T00:00:02.000Z",
        exit_code: 0,
        stdout: "ok\n",
        stderr: "",
        artifacts: [{
          artifact_id: "00000000-0000-4000-8000-000000000006",
          path: "out/report.csv",
          size_bytes: 12,
          sha256: "a".repeat(64),
          expires_at: "2099-07-19T00:00:00.000Z",
        }],
      }
      : {}),
  };
}

function passingAdapter(
  overrides: Partial<ComputeControlPlaneAdapter> = {},
): ComputeControlPlaneAdapter {
  return {
    admitComputeRun: () => Promise.resolve({ ...publicRun(), async: false }),
    getComputeRunForAgent: () => Promise.resolve(publicRun()),
    cancelComputeRunForAgent: () => Promise.resolve(publicRun("cancelled")),
    ...overrides,
  };
}

Deno.test("compute binding: admission idempotency is stable per parent call index", async () => {
  const first = await deriveComputeIdempotencyKey(PROPS.executionId, 1);
  assertEquals(
    await deriveComputeIdempotencyKey(PROPS.executionId, 1),
    first,
  );
  assert(first !== await deriveComputeIdempotencyKey(PROPS.executionId, 2));
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(first),
  );
});

Deno.test("compute binding: trusted props authorize admission and private fields are stripped", async () => {
  let admission: ComputeAdmissionInput | null = null;
  const adapter = passingAdapter({
    admitComputeRun: (input) => {
      admission = input;
      return Promise.resolve({
        ...publicRun(),
        async: false,
        lease_token: "gxc_private_lease_token",
        platform_key: "must-not-enter-body",
      } as unknown as ComputeResult);
    },
  });
  const result = await createComputeBindingOperations(PROPS, adapter).call(
    {
      argv: ["duckdb", "-c", "select 1"],
      profile: "developer-v1",
      tools: ["cli.duckdb"],
      secrets: ["WAREHOUSE"],
      mode: "sync",
      cwd: "/workspace",
      timeout_ms: 5_000,
      input_artifacts: [{
        artifact_id: "00000000-0000-4000-8000-000000000007",
        mount_path: "input/data.csv",
      }],
      capture_paths: ["out/report.csv"],
    },
    1,
  );

  const captured = admission as ComputeAdmissionInput | null;
  assert(captured, "admission adapter was not invoked");
  assertEquals(captured.userId, PROPS.userId);
  assertEquals(captured.agentId, PROPS.agentId);
  assertEquals(captured.callerFunction, PROPS.callerFunction);
  assertEquals(captured.executionId, PROPS.executionId);
  assertEquals(captured.billingMode, "wallet");
  assertEquals(captured.capacityAgentId, PROPS.agentId);
  assertEquals(
    captured.executionDeadlineAtMs,
    Math.floor(PROPS.executionDeadlineAtMs),
  );
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(captured.idempotencyKey),
  );
  assertEquals(captured.request, {
    argv: ["duckdb", "-c", "select 1"],
    tools: ["cli.duckdb"],
    profile: "developer-v1",
    mode: "sync",
    cwd: "/workspace",
    timeout_ms: 5_000,
    secrets: ["WAREHOUSE"],
    capture_paths: ["out/report.csv"],
    input_artifacts: [{
      artifact_id: "00000000-0000-4000-8000-000000000007",
      mount_path: "input/data.csv",
    }],
  });
  assertEquals(result, { ...publicRun(), async: false });
  assertEquals("lease_token" in result, false);
  assertEquals("platform_key" in result, false);
});

Deno.test("compute binding: subscription capacity preserves trusted root Agent attribution", async () => {
  let admission: ComputeAdmissionInput | null = null;
  const rootAgentId = "00000000-0000-4000-8000-000000000099";
  const adapter = passingAdapter({
    admitComputeRun: (input) => {
      admission = input;
      return Promise.resolve({ ...publicRun(), async: true });
    },
  });
  await createComputeBindingOperations({
    ...PROPS,
    billingMode: "subscription_capacity",
    capacityAgentId: rootAgentId,
    capacityReceiptId: "00000000-0000-4000-8000-000000000098",
  }, adapter).call({ argv: ["true"], tools: [] }, 1);
  const captured = admission as ComputeAdmissionInput | null;
  assert(captured);
  assertEquals(captured.billingMode, "subscription_capacity");
  assertEquals(captured.capacityAgentId, rootAgentId);
});

Deno.test("compute binding: unsupported request and artifact fields fail closed", async () => {
  const binding = createComputeBindingOperations(PROPS, passingAdapter());
  await assertRejects(
    () =>
      binding.call({
        argv: ["true"],
        tools: ["shell"],
        raw_provider_key: "sk-provider",
      }, 1),
    PublicComputeControlPlaneError,
    "control plane is unavailable",
  );
  await assertRejects(
    () =>
      binding.call({
        argv: ["true"],
        tools: ["shell"],
        input_artifacts: [{
          artifact_id: "00000000-0000-4000-8000-000000000007",
          mount_path: "input/data.csv",
          storage_key: "private/r2/key",
        }],
      }, 2),
    PublicComputeControlPlaneError,
    "control plane is unavailable",
  );
});

Deno.test("compute binding: get/cancel use the exact trusted Agent actor", async () => {
  const lookups: Array<{ method: string; input: ComputeRunLookupInput }> = [];
  const adapter = passingAdapter({
    getComputeRunForAgent: (input) => {
      lookups.push({ method: "get", input });
      return Promise.resolve(publicRun("running"));
    },
    cancelComputeRunForAgent: (input) => {
      lookups.push({ method: "cancel", input });
      return Promise.resolve(publicRun("cancelled"));
    },
  });
  const binding = createComputeBindingOperations(PROPS, adapter);
  await binding.get("run-a");
  await binding.cancel("run-a");
  assertEquals(lookups, [
    {
      method: "get",
      input: {
        userId: PROPS.userId,
        agentId: PROPS.agentId,
        callerFunction: PROPS.callerFunction,
        executionId: PROPS.executionId,
        runId: "run-a",
      },
    },
    {
      method: "cancel",
      input: {
        userId: PROPS.userId,
        agentId: PROPS.agentId,
        callerFunction: PROPS.callerFunction,
        executionId: PROPS.executionId,
        runId: "run-a",
      },
    },
  ]);
});

Deno.test("compute binding: malformed, expired, and cross-attributed props fail closed", async () => {
  const invalidProps: ComputeBindingProps[] = [
    { ...PROPS, callerFunction: "" },
    { ...PROPS, executionId: "not-a-uuid" },
    { ...PROPS, admissionDisabledProofKey: "not-a-proof-key" },
    { ...PROPS, executionDeadlineAtMs: Date.now() - 1 },
    {
      ...PROPS,
      capacityAgentId: "00000000-0000-4000-8000-000000000099",
    },
    {
      ...PROPS,
      billingMode: "subscription_capacity",
      capacityAgentId: "not-a-uuid",
      capacityReceiptId: "00000000-0000-4000-8000-000000000098",
    },
    {
      ...PROPS,
      capacityReceiptId: "00000000-0000-4000-8000-000000000098",
    },
    {
      ...PROPS,
      billingMode: "subscription_capacity",
      capacityAgentId: "00000000-0000-4000-8000-000000000099",
      capacityReceiptId: null,
    },
  ];
  for (const props of invalidProps) {
    await assertRejects(
      () =>
        createComputeBindingOperations(props, passingAdapter()).call(
          { argv: ["true"], tools: [] },
          1,
        ),
      PublicComputeControlPlaneError,
      "control plane is unavailable",
    );
  }
});

Deno.test("compute binding: capacity marker is exact and emitted only for subscription RPCs", () => {
  const original = console.log;
  const messages: string[] = [];
  console.log = (...values: unknown[]) => {
    messages.push(values.map(String).join(" "));
  };
  try {
    markComputeBindingCapacity(PROPS);
    markComputeBindingCapacity({
      ...PROPS,
      billingMode: "subscription_capacity",
      capacityAgentId: "00000000-0000-4000-8000-000000000099",
      capacityReceiptId: "00000000-0000-4000-8000-000000000098",
    });
  } finally {
    console.log = original;
  }
  assertEquals(messages, [
    'GALACTIC_CAPACITY_EXECUTION_V1 {"receipt_id":"00000000-0000-4000-8000-000000000098"}',
  ]);
});

Deno.test("compute binding: RPC envelope preserves public codes and redacts private errors", async () => {
  const publicResult = await captureComputeBindingRpc(async () => {
    throw new PublicComputeControlPlaneError(
      "COMPUTE_PERMISSION_DENIED",
      "Compute permission was denied.",
    );
  });
  assertEquals(publicResult, {
    ok: false,
    error: {
      code: "COMPUTE_PERMISSION_DENIED",
      message: "Compute permission was denied.",
    },
  });

  const privateResult = await captureComputeBindingRpc(async () => {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY=private-value");
  });
  assertEquals(privateResult, {
    ok: false,
    error: {
      code: "COMPUTE_CONTROL_PLANE_UNAVAILABLE",
      message: "Galactic Compute control plane is unavailable.",
    },
  });
  assertEquals(JSON.stringify(privateResult).includes("private-value"), false);
});

Deno.test("compute binding: admission-disabled guidance crosses as one exact closed envelope", async () => {
  const result = await captureComputeBindingRpc(() =>
    Promise.reject(new PublicComputeControlPlaneError(
      COMPUTE_ADMISSION_DISABLED_CODE,
      COMPUTE_ADMISSION_DISABLED_MESSAGE,
      {
        hint: COMPUTE_ADMISSION_DISABLED_HINT,
        action: COMPUTE_ADMISSION_DISABLED_ACTION,
      },
    ))
  );
  assertEquals(result, {
    ok: false,
    error: {
      code: COMPUTE_ADMISSION_DISABLED_CODE,
      message: COMPUTE_ADMISSION_DISABLED_MESSAGE,
      hint: COMPUTE_ADMISSION_DISABLED_HINT,
      action: COMPUTE_ADMISSION_DISABLED_ACTION,
    },
  });
});

Deno.test("compute binding: OFF proof is exact, per-call, and never added to generic errors", async () => {
  const proofKey = "b".repeat(64);
  const disabledError = () =>
    Promise.reject(new PublicComputeControlPlaneError(
      COMPUTE_ADMISSION_DISABLED_CODE,
      COMPUTE_ADMISSION_DISABLED_MESSAGE,
      {
        hint: COMPUTE_ADMISSION_DISABLED_HINT,
        action: COMPUTE_ADMISSION_DISABLED_ACTION,
      },
    ));
  const first = await captureComputeBindingRpc(disabledError, {
    admissionDisabledProofKey: proofKey,
    admissionCallIndex: 1,
  });
  const second = await captureComputeBindingRpc(disabledError, {
    admissionDisabledProofKey: proofKey,
    admissionCallIndex: 2,
  });
  const firstProof = first.ok ? null : first.error.proof;
  const secondProof = second.ok ? null : second.error.proof;
  assertEquals(
    firstProof,
    await createComputeAdmissionDisabledProof(proofKey, 1),
  );
  assertEquals(
    secondProof,
    await createComputeAdmissionDisabledProof(proofKey, 2),
  );
  assert(typeof firstProof === "string" && firstProof.length === 43);
  assert(firstProof !== secondProof);
  assertEquals(JSON.stringify(first).includes(proofKey), false);

  const generic = await captureComputeBindingRpc(() =>
    Promise.reject(new PublicComputeControlPlaneError(
      "COMPUTE_PERMISSION_DENIED",
      "Compute permission was denied.",
    )), {
    admissionDisabledProofKey: proofKey,
    admissionCallIndex: 1,
  });
  assertEquals(generic.ok ? undefined : generic.error.proof, undefined);
});

Deno.test("compute binding: admission guidance is rejected unless every literal is exact", async () => {
  for (
    const guidance of [
      {},
      {
        hint: "operator stop row 123 is active",
        action: COMPUTE_ADMISSION_DISABLED_ACTION,
      },
      {
        hint: COMPUTE_ADMISSION_DISABLED_HINT,
        action: "setup_home_node",
      },
    ]
  ) {
    const result = await captureComputeBindingRpc(() =>
      Promise.reject(new PublicComputeControlPlaneError(
        COMPUTE_ADMISSION_DISABLED_CODE,
        COMPUTE_ADMISSION_DISABLED_MESSAGE,
        guidance as ConstructorParameters<
          typeof PublicComputeControlPlaneError
        >[2],
      ))
    );
    assertEquals(result, {
      ok: false,
      error: {
        code: "COMPUTE_CONTROL_PLANE_UNAVAILABLE",
        message: "Galactic Compute control plane is unavailable.",
      },
    });
  }
  assertEquals(normalizeComputePublicError({
    code: COMPUTE_ADMISSION_DISABLED_CODE,
    message: COMPUTE_ADMISSION_DISABLED_MESSAGE,
    hint: COMPUTE_ADMISSION_DISABLED_HINT,
    action: COMPUTE_ADMISSION_DISABLED_ACTION,
    internal_operation_id: "must-not-cross",
  }), null);
});

Deno.test("compute binding: invalid public errors are downgraded to the generic envelope", async () => {
  const result = await captureComputeBindingRpc(async () => {
    throw new PublicComputeControlPlaneError(
      "NOT_ALLOWLISTED",
      "SUPABASE_SERVICE_ROLE_KEY=private-value",
    );
  });
  assertEquals(result, {
    ok: false,
    error: {
      code: "COMPUTE_CONTROL_PLANE_UNAVAILABLE",
      message: "Galactic Compute control plane is unavailable.",
    },
  });
});
