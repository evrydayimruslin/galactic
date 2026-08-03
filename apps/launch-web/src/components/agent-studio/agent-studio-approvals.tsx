import { type ReactElement, useEffect, useState } from "react";

import type {
  LaunchAgentApprovalActionResponse,
  LaunchAgentApprovalsResponse,
  LaunchApprovalActionRequest,
  LaunchApprovalEnvelope,
} from "../../../../../shared/contracts/launch.ts";
import { launchApi } from "../../lib/api";

// Pillar P3: the Approvals tab, live. Work the Agent deliberately stopped
// before changing the world — each card is an owner-safe envelope (sanitized
// proposal, never raw arguments or secrets). Approve resumes the EXACT held
// run through the durable queue; Reject records an attested non-action.
// Edit & approve appears only when the preview is provably lossless —
// round-tripping a redacted preview would clobber hidden values.

interface AgentStudioApprovalsApi {
  load: (locator: string) => Promise<LaunchAgentApprovalsResponse>;
  resolve: (
    locator: string,
    approvalId: string,
    request: LaunchApprovalActionRequest,
  ) => Promise<LaunchAgentApprovalActionResponse>;
}

const defaultApprovalsApi: AgentStudioApprovalsApi = {
  load: (locator) => launchApi.agentApprovals(locator),
  resolve: (locator, approvalId, request) =>
    launchApi.resolveAgentApproval(locator, approvalId, request),
};

const CONSEQUENCE_EYEBROWS: Record<string, string> = {
  spend: "Spends money",
  external_side_effect: "Leaves Galactic",
  internal_write: "Changes a fact",
  read: "Read-only",
};

export function formatWaiting(createdAt: string, now = Date.now()): string {
  const ms = now - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `waiting ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `waiting ${hours}h`;
  return `waiting ${Math.floor(hours / 24)}d`;
}

export function formatExpiry(expiresAt: string, now = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  const hours = Math.ceil(ms / 3_600_000);
  if (hours < 48) return `expires in ${hours}h`;
  return `expires in ${Math.ceil(hours / 24)}d`;
}

function previewEntries(
  envelope: LaunchApprovalEnvelope,
): Array<[string, string]> {
  const preview = envelope.proposal?.preview;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
    return [];
  }
  return Object.entries(preview as Record<string, unknown>).map((
    [key, value],
  ) => [
    key,
    typeof value === "string" ? value : JSON.stringify(value),
  ]);
}

function isLossless(envelope: LaunchApprovalEnvelope): boolean {
  return envelope.proposal?.lossless === true;
}

const RESOLVED_LABELS: Record<string, string> = {
  approved: "approved",
  resuming: "approved — running",
  completed: "approved — done",
  failed: "approved — run failed",
  rejected: "rejected",
  expired: "expired unanswered",
};

export function AgentStudioApprovals({
  agentLocator,
  api = defaultApprovalsApi,
  initialResponse = null,
  now,
}: {
  agentLocator: string;
  /** DI seams for tests. */
  api?: AgentStudioApprovalsApi;
  initialResponse?: LaunchAgentApprovalsResponse | null;
  /** Test seam: freeze relative times. */
  now?: number;
}): ReactElement {
  const [response, setResponse] = useState<
    LaunchAgentApprovalsResponse | null
  >(initialResponse);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [stopAskingIds, setStopAskingIds] = useState<Set<string>>(new Set());

  const reload = () => {
    api.load(agentLocator).then(
      (loaded) => {
        setResponse(loaded);
        setError("");
      },
      (reason) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Approvals are unavailable right now.",
        ),
    );
  };

  useEffect(() => {
    if (!initialResponse) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentLocator]);

  const act = (
    envelope: LaunchApprovalEnvelope,
    request: LaunchApprovalActionRequest,
  ) => {
    if (busyId) return;
    setBusyId(envelope.id);
    setNotice("");
    api.resolve(agentLocator, envelope.id, request).then(
      (resolved) => {
        setResponse((current) =>
          current
            ? {
              ...current,
              approvals: current.approvals.map((a) =>
                a.id === resolved.approval.id ? resolved.approval : a
              ),
            }
            : current
        );
        setEditingId(null);
        setNotice(
          request.action === "reject"
            ? `Rejected — ${envelope.functionName} will not run; the agent's record shows a deliberate non-action.`
            : `Approved — the exact held run of ${envelope.functionName} is resuming.`,
        );
      },
      (reason) => {
        setNotice(
          reason instanceof Error
            ? `${reason.message} — reloaded the live state.`
            : "This approval changed elsewhere — reloaded the live state.",
        );
        reload();
      },
    ).finally(() => setBusyId(null));
  };

  const baseRequest = (
    envelope: LaunchApprovalEnvelope,
  ): { expectedRevision: string; idempotencyKey: string; stopAsking?: boolean } => ({
    expectedRevision: envelope.revision,
    idempotencyKey: crypto.randomUUID(),
    ...(stopAskingIds.has(envelope.id) ? { stopAsking: true } : {}),
  });

  if (error) {
    return (
      <section className="agent-studio-screen agent-studio-approvals">
        <p className="agent-studio-approvals-error">{error}</p>
      </section>
    );
  }
  if (!response) {
    return (
      <section className="agent-studio-screen agent-studio-approvals">
        <p className="agent-studio-approvals-empty">Loading held work…</p>
      </section>
    );
  }

  const pending = response.approvals.filter((a) => a.status === "pending");
  const resolved = response.approvals.filter((a) => a.status !== "pending");

  return (
    <section className="agent-studio-screen agent-studio-approvals">
      <header className="agent-studio-approvals-header">
        <h3>Approvals</h3>
        <p>
          Work the Agent deliberately stopped before changing the world.
          Approving resumes the exact held run; rejecting records a
          deliberate non-action on the run&rsquo;s record.
        </p>
      </header>
      {notice ? (
        <p className="agent-studio-approvals-notice" role="status">
          {notice}
        </p>
      ) : null}
      {pending.length === 0 ? (
        <p className="agent-studio-approvals-empty">
          Nothing is waiting on you. Functions set to <strong>Ask</strong>{" "}
          in Capabilities will hold their runs here.
        </p>
      ) : (
        <ul className="agent-studio-approvals-pending">
          {pending.map((envelope) => (
            <li className="agent-studio-approval-card" key={envelope.id}>
              <div className="agent-studio-approval-eyebrow">
                <span>
                  {CONSEQUENCE_EYEBROWS[envelope.consequence] ??
                    envelope.consequence}
                </span>
                <span>{formatWaiting(envelope.createdAt, now)}</span>
              </div>
              <h4>
                <code>{envelope.functionName}</code>
              </h4>
              {previewEntries(envelope).length > 0 ? (
                <dl className="agent-studio-approval-proposal">
                  {previewEntries(envelope).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="agent-studio-approvals-empty">
                  This call takes no input.
                </p>
              )}
              {editingId === envelope.id ? (
                <div className="agent-studio-approval-edit">
                  <textarea
                    aria-label="Revised input (JSON)"
                    onChange={(event) => setEditText(event.target.value)}
                    rows={5}
                    value={editText}
                  />
                  <div className="agent-studio-approval-actions">
                    <button
                      disabled={busyId !== null}
                      onClick={() => {
                        try {
                          const revisedInput = JSON.parse(editText) as Record<
                            string,
                            unknown
                          >;
                          act(envelope, {
                            action: "revise",
                            revisedInput,
                            ...baseRequest(envelope),
                          });
                        } catch {
                          setNotice("The revised input must be valid JSON.");
                        }
                      }}
                      type="button"
                    >
                      Approve with edits
                    </button>
                    <button
                      disabled={busyId !== null}
                      onClick={() => setEditingId(null)}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="agent-studio-approval-actions">
                  <button
                    className="agent-studio-approval-approve"
                    disabled={busyId !== null}
                    onClick={() =>
                      act(envelope, {
                        action: "approve",
                        ...baseRequest(envelope),
                      })}
                    type="button"
                  >
                    Approve
                  </button>
                  {isLossless(envelope) ? (
                    <button
                      disabled={busyId !== null}
                      onClick={() => {
                        setEditingId(envelope.id);
                        setEditText(
                          JSON.stringify(
                            envelope.proposal?.preview ?? {},
                            null,
                            2,
                          ),
                        );
                      }}
                      type="button"
                    >
                      Edit
                    </button>
                  ) : null}
                  <button
                    className="agent-studio-approval-reject"
                    disabled={busyId !== null}
                    onClick={() =>
                      act(envelope, {
                        action: "reject",
                        ...baseRequest(envelope),
                      })}
                    type="button"
                  >
                    Reject
                  </button>
                  <label className="agent-studio-approval-stop-asking">
                    <input
                      checked={stopAskingIds.has(envelope.id)}
                      onChange={(event) => {
                        setStopAskingIds((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(envelope.id);
                          else next.delete(envelope.id);
                          return next;
                        });
                      }}
                      type="checkbox"
                    />
                    stop asking for this function
                  </label>
                </div>
              )}
              <p className="agent-studio-approval-expiry">
                {formatExpiry(envelope.expiresAt, now)} · unanswered holds
                expire and never run
              </p>
            </li>
          ))}
        </ul>
      )}
      {resolved.length > 0 ? (
        <section className="agent-studio-approvals-resolved">
          <h4>Resolved</h4>
          <ul>
            {resolved.map((envelope) => (
              <li key={envelope.id}>
                <code>{envelope.functionName}</code>
                <span>
                  {RESOLVED_LABELS[envelope.status] ?? envelope.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
