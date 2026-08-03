import { type ReactElement, useEffect, useState } from "react";

import type {
  LaunchAgentPolicySetsResponse,
  LaunchPolicyCompileRequest,
  LaunchPolicyCompileResponse,
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
}

const defaultApi: AgentStudioDirectivePolicyApi = {
  load: (locator) => launchApi.agentPolicySets(locator),
  compile: (locator, request) => launchApi.compileAgentPolicy(locator, request),
  approve: (locator, request) =>
    launchApi.approveAgentPolicySet(locator, request),
};

export function AgentStudioDirectivePolicy({
  agentLocator,
  api = defaultApi,
  initialResponse = null,
}: {
  agentLocator: string;
  /** DI seams for tests. */
  api?: AgentStudioDirectivePolicyApi;
  initialResponse?: LaunchAgentPolicySetsResponse | null;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentLocator]);

  const compile = () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setNotice("");
    setCompiled(null);
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

  const approve = () => {
    if (busy || !compiled) return;
    setBusy(true);
    setNotice("");
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
            <button
              disabled={busy}
              onClick={() => setCompiled(null)}
              type="button"
            >
              Discard
            </button>
          </div>
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
