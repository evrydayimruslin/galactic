import {
  type LaunchOperatorRoutineRunDetail,
  type LaunchOperatorRoutineRunLogExcerpt,
  OPERATOR_DIAGNOSTIC_CONTRACT_VERSION,
} from "../../shared/contracts/launch.ts";
import { getEnv } from "../lib/env.ts";
import { readRunEffectEvents } from "./effect-event-store.ts";
import {
  CallLogForbidden,
  CallLogNotFound,
  readCallLogsByReceipt,
} from "./call-log-store.ts";
import {
  readOperatorDiagnostic,
  redactOperatorDiagnosticText,
  redactOperatorLogEntries,
} from "./operator-diagnostics.ts";

const MAX_RUN_STEPS = 200;
const MAX_LOG_RECEIPTS = 100;

interface OperatorRunInspectionDeps {
  fetchFn?: typeof fetch;
  readCallLogsFn?: typeof readCallLogsByReceipt;
  now?: () => Date;
}

interface RoutineRunRow {
  id: string;
  routine_id: string;
  user_id: string;
  status: string;
  trigger: string;
  trace_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  total_light: number | null;
  summary: string | null;
  error: unknown;
}

interface RoutineRow {
  id: string;
  name: string;
  status: string;
}

interface RoutineStepRow {
  id: string;
  run_id: string;
  step_index: number;
  function_name: string;
  status: string;
  duration_ms: number | null;
  cost_light: number | null;
  receipt_id: string | null;
  error: unknown;
  started_at: string | null;
  completed_at: string | null;
}

interface CallReceiptRow {
  id: string;
  function_name: string;
  created_at: string;
  log_object_key: string | null;
}

export class OperatorRunInspectionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "OperatorRunInspectionError";
  }
}

function supabaseHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!key || !getEnv("SUPABASE_URL")) {
    throw new OperatorRunInspectionError(
      "Run diagnostics are temporarily unavailable.",
      503,
      "operator_run_store_unavailable",
    );
  }
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function rows<T>(
  pathAndQuery: string,
  fetchFn: typeof fetch,
): Promise<T[]> {
  const response = await fetchFn(
    `${getEnv("SUPABASE_URL")}/rest/v1/${pathAndQuery}`,
    { headers: supabaseHeaders() },
  );
  if (!response.ok) {
    throw new OperatorRunInspectionError(
      "Run diagnostics are temporarily unavailable.",
      503,
      "operator_run_query_failed",
    );
  }
  const value = await response.json();
  return Array.isArray(value) ? value as T[] : [];
}

function uuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(value)
  ) {
    throw new OperatorRunInspectionError(
      "Routine run not found.",
      404,
      "routine_run_not_found",
    );
  }
  return value;
}

async function loadOwnedRun(params: {
  userId: string;
  agentId: string;
  runId: string;
  fetchFn: typeof fetch;
}): Promise<{ run: RoutineRunRow; routine: RoutineRow }> {
  const runId = uuid(params.runId);
  const runs = await rows<RoutineRunRow>(
    `routine_runs?id=eq.${encodeURIComponent(runId)}` +
      `&user_id=eq.${encodeURIComponent(params.userId)}` +
      "&select=id,routine_id,user_id,status,trigger,trace_id,started_at,completed_at,duration_ms,total_light,summary,error&limit=1",
    params.fetchFn,
  );
  const run = runs[0];
  if (!run) {
    throw new OperatorRunInspectionError(
      "Routine run not found.",
      404,
      "routine_run_not_found",
    );
  }
  const routines = await rows<RoutineRow>(
    `user_routines?id=eq.${encodeURIComponent(run.routine_id)}` +
      `&user_id=eq.${encodeURIComponent(params.userId)}` +
      `&composer_app_id=eq.${encodeURIComponent(params.agentId)}` +
      "&deleted_at=is.null&select=id,name,status&limit=1",
    params.fetchFn,
  );
  const routine = routines[0];
  if (!routine) {
    throw new OperatorRunInspectionError(
      "Routine run not found.",
      404,
      "routine_run_not_found",
    );
  }
  return { run, routine };
}

async function loadRunReceipts(params: {
  userId: string;
  agentId: string;
  runId: string;
  fetchFn: typeof fetch;
}): Promise<CallReceiptRow[]> {
  return await rows<CallReceiptRow>(
    `mcp_call_logs?routine_run_id=eq.${encodeURIComponent(params.runId)}` +
      `&user_id=eq.${encodeURIComponent(params.userId)}` +
      `&app_id=eq.${encodeURIComponent(params.agentId)}` +
      "&select=id,function_name,created_at,log_object_key" +
      `&order=created_at.asc&limit=${MAX_LOG_RECEIPTS}`,
    params.fetchFn,
  );
}

export async function readOperatorRoutineRunDetail(
  params: {
    userId: string;
    agent: { id: string; slug: string; name: string };
    runId: string;
    knownSecrets?: readonly string[];
  },
  deps: OperatorRunInspectionDeps = {},
): Promise<LaunchOperatorRoutineRunDetail> {
  const fetchFn = deps.fetchFn ?? fetch;
  const { run, routine } = await loadOwnedRun({
    userId: params.userId,
    agentId: params.agent.id,
    runId: params.runId,
    fetchFn,
  });
  const [steps, receipts] = await Promise.all([
    rows<RoutineStepRow>(
      `routine_run_steps?run_id=eq.${encodeURIComponent(run.id)}` +
        `&user_id=eq.${encodeURIComponent(params.userId)}` +
        `&routine_id=eq.${encodeURIComponent(routine.id)}` +
        "&select=id,run_id,step_index,function_name,status,duration_ms,cost_light,receipt_id,error,started_at,completed_at" +
        `&order=step_index.asc&limit=${MAX_RUN_STEPS}`,
      fetchFn,
    ),
    loadRunReceipts({
      userId: params.userId,
      agentId: params.agent.id,
      runId: run.id,
      fetchFn,
    }),
  ]);

  // Pillar P0: the run's witnessed effect stream (attested/observed/
  // app_claimed). Best-effort — a witness read failure never breaks run
  // inspection.
  let effects: Awaited<
    ReturnType<typeof readRunEffectEvents>
  > = [];
  try {
    effects = await readRunEffectEvents(
      params.userId,
      params.agent.id,
      run.id,
    );
  } catch (err) {
    console.error("[WITNESS] run effects read failed:", err);
  }

  const summary = run.summary
    ? redactOperatorDiagnosticText(
      run.summary,
      params.knownSecrets,
      500,
    ).text
    : null;

  return {
    contractVersion: OPERATOR_DIAGNOSTIC_CONTRACT_VERSION,
    agent: params.agent,
    routine: {
      id: routine.id,
      name: routine.name,
      status: routine.status,
    },
    run: {
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      traceId: run.trace_id,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      durationMs: run.duration_ms,
      usage: Math.max(0, run.total_light ?? 0),
      summary,
    },
    diagnostic: readOperatorDiagnostic(run.error, params.knownSecrets),
    steps: steps.map((step) => ({
      id: step.id,
      stepIndex: step.step_index,
      functionName: step.function_name,
      status: step.status,
      durationMs: step.duration_ms,
      usage: Math.max(0, step.cost_light ?? 0),
      receiptId: step.receipt_id,
      diagnostic: readOperatorDiagnostic(step.error, params.knownSecrets),
      startedAt: step.started_at,
      completedAt: step.completed_at,
    })),
    logReceipts: receipts.map((receipt) => ({
      receiptId: receipt.id,
      functionName: receipt.function_name,
      createdAt: receipt.created_at,
      logsAvailable: receipt.log_object_key !== null,
    })),
    effects,
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
}

export async function readOperatorRoutineRunLogExcerpt(
  params: {
    userId: string;
    agentId: string;
    runId: string;
    receiptId: string;
    knownSecrets?: readonly string[];
  },
  deps: OperatorRunInspectionDeps = {},
): Promise<LaunchOperatorRoutineRunLogExcerpt> {
  const fetchFn = deps.fetchFn ?? fetch;
  const { run } = await loadOwnedRun({
    userId: params.userId,
    agentId: params.agentId,
    runId: params.runId,
    fetchFn,
  });
  const receipts = await loadRunReceipts({
    userId: params.userId,
    agentId: params.agentId,
    runId: run.id,
    fetchFn,
  });
  if (!receipts.some((receipt) => receipt.id === params.receiptId)) {
    throw new OperatorRunInspectionError(
      "Run logs not found.",
      404,
      "routine_run_logs_not_found",
    );
  }

  try {
    const raw = await (deps.readCallLogsFn ?? readCallLogsByReceipt)({
      callerUserId: params.userId,
      receiptId: params.receiptId,
    });
    const safe = redactOperatorLogEntries(raw.logs, params.knownSecrets);
    return {
      contractVersion: OPERATOR_DIAGNOSTIC_CONTRACT_VERSION,
      runId: run.id,
      receiptId: raw.receipt_id,
      functionName: raw.function_name,
      error: raw.error_message
        ? redactOperatorDiagnosticText(
          raw.error_message,
          params.knownSecrets,
        ).text
        : null,
      truncated: raw.truncated || safe.droppedEntries > 0,
      droppedEntries: raw.dropped_entries + safe.droppedEntries,
      redactedEntries: safe.redactedEntries,
      logs: safe.logs,
      generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    };
  } catch (error) {
    if (error instanceof CallLogForbidden) {
      throw new OperatorRunInspectionError(
        "Run logs not found.",
        404,
        "routine_run_logs_not_found",
      );
    }
    if (error instanceof CallLogNotFound) {
      throw new OperatorRunInspectionError(
        error.message,
        404,
        "routine_run_logs_unavailable",
      );
    }
    throw error;
  }
}
