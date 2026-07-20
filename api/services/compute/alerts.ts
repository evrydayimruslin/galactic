import { createNotification } from "../notifications.ts";

const COMPUTE_ALERT_KIND = "compute_run_attention";

export interface ComputeAlertRun {
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
}

export interface ComputeAlertDeps {
  createNotificationFn?: typeof createNotification;
}

function actionUrl(agentId: string): string {
  return `/admin/agents/${encodeURIComponent(agentId)}?pane=compute`;
}

/** Best-effort owner alert for a terminal infrastructure failure. */
export async function notifyComputeInfrastructureFailure(
  run: ComputeAlertRun,
  failure: { code: string; message: string; retryable: boolean },
  deps: ComputeAlertDeps = {},
): Promise<void> {
  const notify = deps.createNotificationFn ?? createNotification;
  await notify({
    userId: run.userId,
    agentId: run.agentId,
    kind: COMPUTE_ALERT_KIND,
    severity: failure.retryable ? "warning" : "critical",
    title: `Compute run failed in ${run.callerFunction}`.slice(0, 140),
    body: `${failure.code}: ${failure.message}`.slice(0, 2_000),
    entityType: "compute_run",
    entityId: run.runId,
    actionUrl: actionUrl(run.agentId),
    dedupeKey: `compute:failure:${run.runId}:${failure.code}`,
  });
}

/** A durable debit needs operator attention; never silently hide it in logs. */
export async function notifyComputeSettlementPending(
  run: ComputeAlertRun,
  deps: ComputeAlertDeps = {},
): Promise<void> {
  const notify = deps.createNotificationFn ?? createNotification;
  await notify({
    userId: run.userId,
    agentId: run.agentId,
    kind: COMPUTE_ALERT_KIND,
    severity: "critical",
    title: `Compute usage settlement needs attention`,
    body:
      `Run ${run.runId} finished, but its reserved usage has not settled. ` +
      `The reservation remains conserved while the control plane retries.`,
    entityType: "compute_run",
    entityId: run.runId,
    actionUrl: actionUrl(run.agentId),
    dedupeKey: `compute:settlement-pending:${run.runId}`,
  });
}

/** Called when Queue retries are exhausted or the reconciler finds an orphan. */
export async function notifyComputeDispatchDeadLetter(
  run: ComputeAlertRun,
  deps: ComputeAlertDeps = {},
): Promise<void> {
  const notify = deps.createNotificationFn ?? createNotification;
  await notify({
    userId: run.userId,
    agentId: run.agentId,
    kind: COMPUTE_ALERT_KIND,
    severity: "critical",
    title: `Compute run could not be dispatched`,
    body:
      `Run ${run.runId} exhausted its durable dispatch attempts. ` +
      `No body should remain active; the reservation will be reconciled.`,
    entityType: "compute_run",
    entityId: run.runId,
    actionUrl: actionUrl(run.agentId),
    dedupeKey: `compute:dispatch-dead-letter:${run.runId}`,
  });
}
