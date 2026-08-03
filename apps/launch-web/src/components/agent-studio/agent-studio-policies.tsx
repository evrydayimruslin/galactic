import { type ReactElement, useEffect, useState } from "react";

import type {
  LaunchAgentFunctionPoliciesResponse,
  LaunchAgentFunctionPolicyUpdateResponse,
  LaunchAutonomousFunctionPolicy,
  LaunchAutonomousFunctionPolicyProjection,
  LaunchAutonomousFunctionPolicyUpdateRequest,
  LaunchFunctionConsequenceGroup,
} from "../../../../../shared/contracts/launch.ts";
import { launchApi } from "../../lib/api";

// Pillar P2: per-function autonomous authority (Off | Free), grouped by what
// the function can do to the world. This governs the Agent's OWN wakes —
// scheduled runs, run-now, retries. What connected Agents may call is a
// separate plane (the functions list below this panel). 'Ask' becomes a
// choice when approvals ship (P3); an 'ask' row stored today runs free and
// says so rather than pretending to hold.

interface AgentStudioPoliciesApi {
  load: (locator: string) => Promise<LaunchAgentFunctionPoliciesResponse>;
  set: (
    locator: string,
    functionName: string,
    request: LaunchAutonomousFunctionPolicyUpdateRequest,
  ) => Promise<LaunchAgentFunctionPolicyUpdateResponse>;
}

const defaultPoliciesApi: AgentStudioPoliciesApi = {
  load: (locator) => launchApi.agentFunctionPolicies(locator),
  set: (locator, functionName, request) =>
    launchApi.setAgentFunctionPolicy(locator, functionName, request),
};

/** The write asserts everything the owner SAW; the server 409s on drift. */
export function policyUpdateRequestFor(
  projection: LaunchAutonomousFunctionPolicyProjection,
  policy: LaunchAutonomousFunctionPolicy,
): LaunchAutonomousFunctionPolicyUpdateRequest {
  return {
    policy,
    expectedRevision: projection.revision,
    expectedReleaseId: projection.declaredReleaseId,
    expectedDeclarationHash: projection.declarationHash,
    idempotencyKey: crypto.randomUUID(),
  };
}

/** Riskiest first — the order the owner should read them in. */
const CONSEQUENCE_ORDER: LaunchFunctionConsequenceGroup[] = [
  "spend",
  "external_side_effect",
  "internal_write",
  "read",
];

const CONSEQUENCE_LABELS: Record<LaunchFunctionConsequenceGroup, string> = {
  spend: "Spends money",
  external_side_effect: "Leaves Galactic",
  internal_write: "Changes a fact",
  read: "Read-only",
};

export function groupPoliciesByConsequence(
  policies: LaunchAutonomousFunctionPolicyProjection[],
): Array<{
  consequence: LaunchFunctionConsequenceGroup;
  label: string;
  policies: LaunchAutonomousFunctionPolicyProjection[];
}> {
  return CONSEQUENCE_ORDER.map((consequence) => ({
    consequence,
    label: CONSEQUENCE_LABELS[consequence],
    policies: policies.filter((p) => p.consequence === consequence),
  })).filter((group) => group.policies.length > 0);
}

function auditLine(projection: LaunchAutonomousFunctionPolicyProjection): string {
  if (projection.updatedBy.kind === "user") {
    const date = new Date(projection.updatedAt);
    return Number.isNaN(date.getTime())
      ? "set by you"
      : `set by you · ${date.toLocaleDateString()}`;
  }
  return "release default";
}

export function AgentStudioPolicies({
  agentLocator,
  api = defaultPoliciesApi,
  initialResponse = null,
}: {
  agentLocator: string;
  /** DI seams for tests. */
  api?: AgentStudioPoliciesApi;
  initialResponse?: LaunchAgentFunctionPoliciesResponse | null;
}): ReactElement {
  const [response, setResponse] = useState<
    LaunchAgentFunctionPoliciesResponse | null
  >(initialResponse);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyFunction, setBusyFunction] = useState<string | null>(null);

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
            : "Autonomous policies are unavailable right now.",
        ),
    );
  };

  useEffect(() => {
    if (!initialResponse) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentLocator]);

  const setPolicy = (
    projection: LaunchAutonomousFunctionPolicyProjection,
    policy: LaunchAutonomousFunctionPolicy,
  ) => {
    if (projection.policy === policy || busyFunction) return;
    setBusyFunction(projection.functionName);
    setNotice("");
    api
      .set(
        agentLocator,
        projection.functionName,
        policyUpdateRequestFor(projection, policy),
      )
      .then(
        (updated) => {
          setResponse((current) =>
            current
              ? {
                ...current,
                policies: current.policies.map((p) =>
                  p.functionName === updated.policy.functionName
                    ? updated.policy
                    : p
                ),
              }
              : current
          );
          setNotice(
            policy === "off"
              ? `${projection.functionName} is Off for autonomous runs — the agent records a non-action instead of calling it.`
              : `${projection.functionName} runs freely during autonomous runs.`,
          );
        },
        (reason) => {
          // A 409 means the release, declaration, or policy moved under us;
          // reload so the switches show what is actually live.
          setNotice(
            reason instanceof Error
              ? `${reason.message} — reloaded the live state.`
              : "The policy changed elsewhere — reloaded the live state.",
          );
          reload();
        },
      )
      .finally(() => setBusyFunction(null));
  };

  if (error) {
    return (
      <div className="agent-studio-policies">
        <p className="agent-studio-policies-error">{error}</p>
      </div>
    );
  }
  if (!response) {
    return (
      <div className="agent-studio-policies">
        <p className="agent-studio-policies-empty">
          Loading autonomous policies…
        </p>
      </div>
    );
  }

  const groups = groupPoliciesByConsequence(response.policies);

  return (
    <div className="agent-studio-policies">
      <header className="agent-studio-policies-header">
        <h3>When this Agent acts on its own</h3>
        <p>
          These switches govern the Agent&rsquo;s own wakes — scheduled runs,
          run-now, retries. <strong>Off</strong>{" "}
          records a deliberate non-action instead of calling the function.
          {" "}
          <strong>Free</strong>{" "}
          lets it run without asking. Asking you first arrives with approvals.
          What <em>connected</em>{" "}
          Agents may call is the separate list below.
        </p>
      </header>
      {notice ? (
        <p className="agent-studio-policies-notice" role="status">{notice}</p>
      ) : null}
      {response.currentRelease === null ? (
        <p className="agent-studio-policies-empty">
          Publish a release first — autonomous policy binds to declared
          functions.
        </p>
      ) : groups.length === 0 ? (
        <p className="agent-studio-policies-empty">
          The current release declares no functions.
        </p>
      ) : (
        groups.map((group) => (
          <section
            className="agent-studio-policies-group"
            key={group.consequence}
          >
            <h4>{group.label}</h4>
            <ul>
              {group.policies.map((projection) => (
                <li key={projection.functionName}>
                  <div className="agent-studio-policies-fn">
                    <code>{projection.functionName}</code>
                    <span className="agent-studio-policies-audit">
                      {auditLine(projection)}
                    </span>
                    {projection.policy === "ask" ? (
                      <span className="agent-studio-policies-ask-note">
                        set to Ask — runs free until approvals ship
                      </span>
                    ) : null}
                  </div>
                  <div
                    aria-label={`Autonomous policy for ${projection.functionName}`}
                    className="agent-studio-policies-toggle"
                    role="group"
                  >
                    <button
                      aria-pressed={projection.policy === "off"}
                      disabled={busyFunction !== null}
                      onClick={() => setPolicy(projection, "off")}
                      type="button"
                    >
                      Off
                    </button>
                    <button
                      aria-pressed={projection.policy !== "off"}
                      disabled={busyFunction !== null}
                      onClick={() => setPolicy(projection, "free")}
                      type="button"
                    >
                      Free
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
