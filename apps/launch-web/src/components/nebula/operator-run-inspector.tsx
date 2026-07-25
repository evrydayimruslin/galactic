import {
  type ReactElement,
  useEffect,
  useState,
} from "react";

import type {
  LaunchOperatorRoutineRunDetail,
  LaunchOperatorRoutineRunLogExcerpt,
} from "../../../../../shared/contracts/launch.ts";
import { launchApi } from "../../lib/api";

export interface OperatorRunInspectorProps {
  agentSlug: string;
  autoOpenLogs?: boolean;
  onClose: () => void;
  runId: string;
}

function readableTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function OperatorRunInspector({
  agentSlug,
  autoOpenLogs = false,
  onClose,
  runId,
}: OperatorRunInspectorProps): ReactElement {
  const [detail, setDetail] = useState<LaunchOperatorRoutineRunDetail | null>(
    null,
  );
  const [logs, setLogs] = useState<LaunchOperatorRoutineRunLogExcerpt | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [loadingReceipt, setLoadingReceipt] = useState<string | null>(null);
  const [error, setError] = useState("");

  const openReceipt = async (receiptId: string) => {
    if (!detail || loadingReceipt) return;
    const receipt = detail.logReceipts.find((item) =>
      item.receiptId === receiptId && item.logsAvailable
    );
    if (!receipt) return;
    setLoadingReceipt(receiptId);
    setError("");
    try {
      const response = await launchApi.operatorRoutineRunLogs(
        agentSlug,
        runId,
        receiptId,
      );
      if (response.runId !== runId || response.receiptId !== receiptId) {
        throw new Error("The log response did not match this run.");
      }
      setLogs(response);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Redacted logs could not be loaded.",
      );
    } finally {
      setLoadingReceipt(null);
    }
  };

  useEffect(() => {
    let mounted = true;
    const openReceiptWithDetail = async (
      response: LaunchOperatorRoutineRunDetail,
      receiptId: string,
    ) => {
      setLoadingReceipt(receiptId);
      try {
        const excerpt = await launchApi.operatorRoutineRunLogs(
          agentSlug,
          runId,
          receiptId,
        );
        if (
          mounted &&
          response.run.id === excerpt.runId &&
          excerpt.receiptId === receiptId
        ) {
          setLogs(excerpt);
        }
      } catch (reason) {
        if (mounted) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Redacted logs could not be loaded.",
          );
        }
      } finally {
        if (mounted) setLoadingReceipt(null);
      }
    };
    setLoading(true);
    setError("");
    setDetail(null);
    setLogs(null);
    launchApi.operatorRoutineRun(agentSlug, runId)
      .then((response) => {
        if (!mounted) return;
        if (response.run.id !== runId) {
          throw new Error("The run response did not match the requested run.");
        }
        setDetail(response);
        const first = autoOpenLogs
          ? response.logReceipts.find(({ logsAvailable }) => logsAvailable)
          : null;
        if (first) {
          queueMicrotask(() => {
            if (mounted) void openReceiptWithDetail(response, first.receiptId);
          });
        }
      })
      .catch((reason) => {
        if (mounted) {
          setError(
            reason instanceof Error
              ? reason.message
              : "The failed run could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [agentSlug, autoOpenLogs, runId]);

  return (
    <section
      aria-label="Failed run diagnostics"
      className="neb-operator-run-inspector"
    >
      <div className="neb-overview-section-head">
        <div>
          <span className="neb-ov-label">Run diagnostics</span>
          <h3>{detail?.routine.name ?? "Loading failed run…"}</h3>
        </div>
        <button className="neb-btn-sm secondary" onClick={onClose} type="button">
          Back to routines
        </button>
      </div>
      {loading ? <p className="neb-ov-note">Loading safe diagnostics…</p> : null}
      {detail
        ? (
          <>
            <div className="neb-operator-run-summary">
              <span>
                <strong>{detail.run.status}</strong>
                <small>{readableTime(detail.run.startedAt)}</small>
              </span>
              <span>
                <strong>{detail.run.usage}</strong>
                <small>usage</small>
              </span>
              <span>
                <strong>
                  {detail.run.durationMs === null
                    ? "—"
                    : `${Math.round(detail.run.durationMs / 1_000)}s`}
                </strong>
                <small>duration</small>
              </span>
            </div>
            {detail.diagnostic
              ? (
                <div className="neb-operator-run-diagnostic">
                  <span>Diagnosis</span>
                  <strong>{detail.diagnostic.summary}</strong>
                  {detail.diagnostic.detail
                    ? <p>{detail.diagnostic.detail}</p>
                    : null}
                  <code>
                    {detail.diagnostic.causeCode ?? detail.diagnostic.code}
                  </code>
                </div>
              )
              : (
                <p className="neb-ov-note">
                  Galactic could not determine the cause from the available
                  diagnostic data.
                </p>
              )}
            {detail.steps.length > 0
              ? (
                <div className="neb-operator-run-steps">
                  <span className="neb-ov-label">Steps</span>
                  {detail.steps.map((step) => (
                    <div key={step.id}>
                      <span>
                        <strong>{step.functionName}</strong>
                        <small>{step.status}</small>
                      </span>
                      {step.diagnostic
                        ? <p>{step.diagnostic.summary}</p>
                        : null}
                    </div>
                  ))}
                </div>
              )
              : null}
            {detail.logReceipts.length > 0
              ? (
                <div className="neb-operator-log-receipts">
                  <span className="neb-ov-label">Redacted logs</span>
                  <div>
                    {detail.logReceipts.map((receipt) => (
                      <button
                        className="neb-btn-sm secondary"
                        disabled={!receipt.logsAvailable ||
                          loadingReceipt !== null}
                        key={receipt.receiptId}
                        onClick={() => void openReceipt(receipt.receiptId)}
                        type="button"
                      >
                        {loadingReceipt === receipt.receiptId
                          ? "Loading…"
                          : receipt.functionName}
                      </button>
                    ))}
                  </div>
                </div>
              )
              : null}
          </>
        )
        : null}
      {logs
        ? (
          <div className="neb-operator-log-excerpt">
            <div className="neb-overview-section-head compact">
              <span className="neb-ov-label">{logs.functionName}</span>
              <button
                className="neb-btn-sm secondary"
                onClick={() => setLogs(null)}
                type="button"
              >
                Close logs
              </button>
            </div>
            {logs.error ? <p>{logs.error}</p> : null}
            <pre>
              {logs.logs.map((entry) =>
                `${readableTime(entry.time)}  ${entry.level.toUpperCase()}  ${entry.message}`
              ).join("\n") || "No retained log lines."}
            </pre>
            {logs.truncated ||
                logs.droppedEntries > 0 ||
                logs.redactedEntries > 0
              ? (
                <small>
                  This safe excerpt is bounded. {logs.droppedEntries} entries
                  were omitted and {logs.redactedEntries} were redacted.
                </small>
              )
              : null}
          </div>
        )
        : null}
      {error ? <p className="neb-error-note" role="alert">{error}</p> : null}
    </section>
  );
}
