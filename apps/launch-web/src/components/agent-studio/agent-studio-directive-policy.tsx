import { type ReactElement, useEffect, useState } from "react";

import type {
  LaunchAgentPolicySetsResponse,
  LaunchPolicyAttributionResponse,
  LaunchPolicyCompileRequest,
  LaunchPolicyCompileResponse,
  LaunchPolicyDryRunRequest,
  LaunchPolicyDryRunResponse,
  LaunchPolicySetApproveRequest,
  LaunchPolicySetApproveResponse,
} from "../../../../../shared/contracts/launch.ts";
import { launchApi } from "../../lib/api";

// Pillar P4: the Directive tab's compiled-policy surface. The owner writes
// plain language; THEIR model compiles it; the readback shown here is
// rendered from the compiled artifact by code templates — approving means
// approving what will execute, not what was typed. Versions are immutable
// history; rollback is approving a prior artifact as a new version.

interface AgentStudioDirectivePolicyApi {
  load: (locator: string) => Promise<LaunchAgentPolicySetsResponse>;
  compile: (
    locator: string,
    request: LaunchPolicyCompileRequest,
  ) => Promise<LaunchPolicyCompileResponse>;
  approve: (
    locator: string,
    request: LaunchPolicySetApproveRequest & { compileModel?: string },
  ) => Promise<LaunchPolicySetApproveResponse>;
  /** P6 seams. */
  attribution: (locator: string) => Promise<LaunchPolicyAttributionResponse>;
  dryRun: (
    locator: string,
    request: LaunchPolicyDryRunRequest,
  ) => Promise<LaunchPolicyDryRunResponse>;
}

const defaultApi: AgentStudioDirectivePolicyApi = {
  load: (locator) => launchApi.agentPolicySets(locator),
  compile: (locator, request) => launchApi.compileAgentPolicy(locator, request),
  approve: (locator, request) =>
    launchApi.approveAgentPolicySet(locator, request),
  attribution: (locator) => launchApi.agentPolicyAttribution(locator),
  dryRun: (locator, request) => launchApi.dryRunAgentPolicy(locator, request),
};

/** "held 4 this week · 2 waiting now" — from the envelope ledger. */
export function attributionLabel(
  entry: { heldLast7d: number; pendingNow: number },
): string {
  const held = `held ${entry.heldLast7d} this week`;
  return entry.pendingNow > 0
    ? `${held} · ${entry.pendingNow} waiting now`
    : held;
}

export function AgentStudioDirectivePolicy({
  agentLocator,
  api = defaultApi,
  initialResponse = null,
  initialAttribution = null,
  onOpenApprovals,
}: {
  agentLocator: string;
  /** DI seams for tests. */
  api?: AgentStudioDirectivePolicyApi;
  initialResponse?: LaunchAgentPolicySetsResponse | null;
  initialAttribution?: LaunchPolicyAttributionResponse | null;
  /** "See them →" navigation into the Approvals pane. */
  onOpenApprovals?: () => void;
}): ReactElement {
  const [response, setResponse] = useState<
    LaunchAgentPolicySetsResponse | null
  >(initialResponse);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [text, setText] = useState("");
  const [compiled, setCompiled] = useState<LaunchPolicyCompileResponse | null>(
    null,
  );
  const [attribution, setAttribution] = useState<
    LaunchPolicyAttributionResponse | null
  >(initialAttribution);
  const [dryRun, setDryRun] = useState<LaunchPolicyDryRunResponse | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

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
            : "Compiled policy is unavailable right now.",
        ),
    );
  };

  useEffect(() => {
    if (!initialResponse) reload();
    if (!initialAttribution) {
      api.attribution(agentLocator).then(
        (loaded) => setAttribution(loaded),
        () => undefined, // counters are additive; their absence is not an error
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentLocator]);

  const compile = () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setNotice("");
    setCompiled(null);
    setDryRun(null);
    api.compile(agentLocator, { text: text.trim() }).then(
      (result) => setCompiled(result),
      (reason) =>
        setNotice(
          reason instanceof Error
            ? reason.message
            : "Compilation failed — nothing was saved.",
        ),
    ).finally(() => setBusy(false));
  };

  const runDryRun = () => {
    if (busy || !compiled) return;
    setBusy(true);
    api.dryRun(agentLocator, { artifact: compiled.artifact }).then(
      (result) => setDryRun(result),
      (reason) =>
        setNotice(
          reason instanceof Error
            ? reason.message
            : "Dry-run failed — nothing was saved.",
        ),
    ).finally(() => setBusy(false));
  };

  const approve = () => {
    if (busy || !compiled) return;
    setBusy(true);
    setNotice("");
    setDryRun(null);
    api.approve(agentLocator, {
      artifact: compiled.artifact,
      source: compiled.source,
      compileModel: compiled.compileModel,
      expectedHeadVersion: response?.head?.version ?? 0,
    }).then(
      (result) => {
        setCompiled(null);
        setText("");
        setNotice(
          `Version ${result.policySet.version} is live — the gate enforces it from the next autonomous call.`,
        );
        reload();
      },
      (reason) => {
        setNotice(
          reason instanceof Error
            ? `${reason.message}`
            : "Approval failed — reload and re-read the readback.",
        );
        reload();
      },
    ).finally(() => setBusy(false));
  };

  return (
    <section className="agent-studio-directive-policy">
      <header>
        <h3>Compiled policy</h3>
        <p>
          Write policy in plain language. Your own model compiles it into
          deterministic rules; you approve the readback below — the exact
          words of what will execute. Rules can only narrow: hold for your
          approval, or never run.
        </p>
      </header>
      {error ? (
        <p className="agent-studio-directive-policy-error">{error}</p>
      ) : null}
      {notice ? (
        <p className="agent-studio-directive-policy-notice" role="status">
          {notice}
        </p>
      ) : null}

      {response?.head ? (
        <div className="agent-studio-directive-policy-head">
          <h4>
            Version {response.head.version} · compiled by{" "}
            {response.head.compileModel}
          </h4>
          <ul>
            {response.head.readback.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {attribution && attribution.rules.length > 0 ? (
            <div className="agent-studio-directive-policy-counters">
              {attribution.rules.map((entry) => (
                <p key={`v${entry.policyVersion}:${entry.ruleId}`}>
                  <strong>
                    {entry.ruleId} (v{entry.policyVersion})
                  </strong>{" "}
                  — {attributionLabel(entry)}
                  {onOpenApprovals ? (
                    <button onClick={onOpenApprovals} type="button">
                      See them →
                    </button>
                  ) : null}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="agent-studio-directive-policy-empty">
          No compiled policy yet — the Capabilities switches and the release
          ceiling govern alone.
        </p>
      )}

      <div className="agent-studio-directive-policy-compose">
        <textarea
          aria-label="Policy text"
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          placeholder="Never issue refunds over 50 without asking me."
          rows={3}
          value={text}
        />
        <button disabled={busy || !text.trim()} onClick={compile} type="button">
          Compile
        </button>
      </div>

      {compiled ? (
        <div className="agent-studio-directive-policy-readback">
          <h4>Readback — approve exactly this</h4>
          <ul>
            {compiled.readback.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p className="agent-studio-directive-policy-meta">
            compiled by {compiled.compileModel} · nothing is saved until you
            approve
          </p>
          <div className="agent-studio-directive-policy-actions">
            <button disabled={busy} onClick={approve} type="button">
              Approve as version {(response?.head?.version ?? 0) + 1}
            </button>
            <button disabled={busy} onClick={runDryRun} type="button">
              Test against recent runs
            </button>
            <button
              disabled={busy}
              onClick={() => setCompiled(null)}
              type="button"
            >
              Discard
            </button>
          </div>
          {dryRun ? (
            <div className="agent-studio-directive-policy-dryrun">
              <p>
                Replayed <strong>{dryRun.replayed}</strong> recorded runs
                through the production evaluator:{" "}
                <strong>{dryRun.summary.newlyHeld}</strong> newly held,{" "}
                <strong>{dryRun.summary.newlyDenied}</strong> newly denied,{" "}
                <strong>{dryRun.summary.newlyAllowed}</strong> newly allowed
                {dryRun.summary.wouldConsultJudge > 0
                  ? (
                    <>
                      {" "}· {dryRun.summary.wouldConsultJudge}{" "}
                      in a semantic rule&rsquo;s scope (the judge decides
                      live)
                    </>
                  )
                  : null}.
              </p>
              {dryRun.changed.length > 0 ? (
                <ul>
                  {dryRun.changed.slice(0, 8).map((row) => (
                    <li key={row.jobId}>
                      <code>{row.functionName}</code> {row.current} →{" "}
                      {row.proposed}
                      {row.proposedRuleId ? ` (${row.proposedRuleId})` : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No recorded run changes verdict under this proposal.</p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {response && response.versions.length > 0 ? (
        <div className="agent-studio-directive-policy-history">
          <h4>History</h4>
          <ul>
            {response.versions.map((version) => (
              <li key={version.version}>
                <span>v{version.version}</span>
                <span>
                  {version.ruleCount}{" "}
                  {version.ruleCount === 1 ? "rule" : "rules"}
                </span>
                <span>{version.compileModel}</span>
                <span>
                  {new Date(version.createdAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
