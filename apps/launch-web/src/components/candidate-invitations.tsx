import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import type {
  LaunchCandidateDeployResponse,
  LaunchCandidateInvitation,
  LaunchCandidateListResponse,
  LaunchSubscriptionCheckoutAttemptStatus,
  LaunchSubscriptionResponse,
} from "../../../../shared/contracts/launch.ts";
import {
  candidateDeployButtonLabel,
  clearCandidateDeploymentKey,
  clearMembershipCheckoutKey,
  getOrCreateCandidateDeploymentKey,
  getOrCreateMembershipCheckoutKey,
  hasActiveDeploymentMembership,
  isCandidateDeploymentEligible,
  needsCandidateDeploymentReconciliation,
  persistMembershipCandidateSelection,
  restoreMembershipCandidateSelection,
  retainMembershipCheckoutKeyAfterFailure,
  shouldReloadAfterCandidateDeployment,
} from "../lib/candidate-deployment";
import { markExternalReturnRevalidation } from "../lib/external-navigation";
import type { LaunchNavigate } from "../lib/navigation";
import { launchApi } from "../lib/api";

import "./candidate-invitations.css";

export const MEMBERSHIP_ATTEMPT_STORAGE_KEY =
  "galactic:membership-checkout-attempt";

const TERMINAL_CHECKOUT_STATUSES = new Set<
  LaunchSubscriptionCheckoutAttemptStatus
>(["active", "cancelled", "failed", "expired"]);

const DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS = 1_500;
const DEPLOYMENT_RECONCILIATION_POLL_LIMIT = 12;

export interface CandidateManifestRow {
  label:
    | "Routines"
    | "Database"
    | "Interfaces"
    | "Functions"
    | "Virtual machine"
    | "Inference";
  value: string;
}

interface CandidateResult {
  message: string;
  response?: LaunchCandidateDeployResponse;
  state: "deploying" | "pending" | "completed" | "failed";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function listValue(values: string[], empty = "Not requested"): string {
  const items = unique(values);
  return items.length > 0 ? items.join(", ") : empty;
}

function isInferenceDeclaration(value: string): boolean {
  return /inference|model|llm|^ai:(?:call|embed)$/iu.test(value);
}

export function candidateManifestRows(
  candidate: LaunchCandidateInvitation,
): CandidateManifestRow[] {
  const { release } = candidate;
  const inferenceDeclarations = unique([
    ...release.permissions.filter(isInferenceDeclaration),
    ...release.functions.flatMap((fn) =>
      fn.effects
        .map((effect) => effect.id)
        .filter(isInferenceDeclaration)
    ),
  ]);

  return [
    {
      label: "Routines",
      value: listValue(
        release.routines.map((routine) =>
          `${routine.label} (${
            routine.hasDefaultSchedule
              ? "default cadence declared"
              : "cadence set in setup"
          })`
        ),
      ),
    },
    {
      label: "Database",
      // Function authority cannot prove that a release declares a database.
      // Keep this row honest until the invitation contract projects storage.
      value: "Not declared in this release summary",
    },
    {
      label: "Interfaces",
      value: listValue(
        release.interfaces.map((item) =>
          `${item.label} · ${item.functions.length} ${
            item.functions.length === 1 ? "function" : "functions"
          }`
        ),
      ),
    },
    {
      label: "Functions",
      value: listValue(release.functions.map((fn) => fn.name)),
    },
    {
      label: "Virtual machine",
      value: release.compute
        ? `Requested · ${
          listValue(
            [
              release.compute.profile,
              ...release.compute.tools,
              ...(release.compute.secretNames.length > 0
                ? [`${release.compute.secretNames.length} setup variables`]
                : []),
            ],
            release.compute.profile,
          )
        }`
        : "Not requested",
    },
    {
      label: "Inference",
      value: listValue(inferenceDeclarations),
    },
  ];
}

export function checkoutAttemptFromReturn(
  search: string,
  storage: Pick<Storage, "getItem"> | null,
): string | null {
  const fromQuery = new URLSearchParams(search).get("subscription_attempt");
  if (fromQuery) return fromQuery;
  try {
    return storage?.getItem(MEMBERSHIP_ATTEMPT_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function checkoutReturnRequestsCancellation(search: string): boolean {
  return new URLSearchParams(search).get("subscription") === "cancelled";
}

function browserSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function rememberCheckoutAttempt(attemptId: string): void {
  try {
    browserSessionStorage()?.setItem(
      MEMBERSHIP_ATTEMPT_STORAGE_KEY,
      attemptId,
    );
  } catch {
    // The opaque query parameter remains a reconciliation fallback.
  }
}

function forgetCheckoutAttempt(): void {
  try {
    const storage = browserSessionStorage();
    storage?.removeItem(MEMBERSHIP_ATTEMPT_STORAGE_KEY);
    clearMembershipCheckoutKey(storage);
  } catch {
    // The server-side attempt is already terminal.
  }
}

export function checkoutReturnClearedHref(location: {
  pathname: string;
  search: string;
}): string {
  const search = new URLSearchParams(location.search);
  search.delete("subscription");
  search.delete("subscription_attempt");
  const query = search.toString();
  return `${location.pathname}${query ? `?${query}` : ""}`;
}

function qualificationCopy(candidate: LaunchCandidateInvitation): string {
  const coverage = candidate.evidence.qualification;
  if (
    coverage.cases.declared < 1 ||
    coverage.cases.passed < 1 ||
    coverage.cases.passed > coverage.cases.declared
  ) {
    return "Qualification evidence unavailable · deployment blocked";
  }
  return `Galactic test passed · ${coverage.cases.passed} ${
    coverage.cases.passed === 1 ? "case" : "cases"
  } · ${coverage.functions.exercised} of ${coverage.functions.declared} ${
    coverage.functions.declared === 1 ? "function" : "functions"
  } exercised`;
}

function extensionCopy(candidate: LaunchCandidateInvitation): string {
  if (candidate.target.kind === "new_agent") return "New private Agent";
  const current = candidate.target.currentVersion
    ? ` · current ${candidate.target.currentVersion}`
    : "";
  return `Extends ${candidate.target.agentName} from ${candidate.target.baseLineage.version}${current}`;
}

function statusCopy(candidate: LaunchCandidateInvitation): string {
  if (
    candidate.target.kind === "extension" &&
    candidate.target.lineageStatus === "stale"
  ) {
    return "Base release changed — rebuild and test this extension";
  }
  if (candidate.blocker) return candidate.blocker.message;
  switch (candidate.status) {
    case "ready":
      return candidate.deploymentReady
        ? "Ready for owner review"
        : "Test evidence must be refreshed";
    case "deploying":
      return "Deployment in progress";
    case "deployed":
      return "Deployed";
    case "stale":
      return "Base release changed — rebuild and test this candidate";
    case "blocked":
      return "Not ready to deploy";
  }
}

export function CandidateInvitations({
  checkoutReturnPath,
  error,
  location,
  navigate,
  onReload,
  response,
  variant = "fleet",
}: {
  checkoutReturnPath?: string;
  error?: string;
  location: { pathname: string; search: string };
  navigate: LaunchNavigate;
  onReload: () => void | Promise<void>;
  response?: LaunchCandidateListResponse;
  variant?: "fleet" | "funnel";
}): ReactElement | null {
  const allCandidates = response?.candidates ?? [];
  const candidates = allCandidates.filter((candidate) =>
    candidate.status !== "deployed"
  );
  const deployedCandidates = allCandidates.filter((candidate) =>
    candidate.status === "deployed" && candidate.deployment !== null
  );
  const deployedSignature = deployedCandidates.map((candidate) =>
    `${candidate.id}:${candidate.deployment?.deploymentId ?? ""}`
  ).join("|");
  const eligibleSignature = candidates
    .filter(isCandidateDeploymentEligible)
    .map((candidate) => `${candidate.id}:${candidate.reviewRevision}`)
    .join("|");
  const resumableSignature = candidates
    .filter((candidate) =>
      candidate.status === "deploying" &&
      isCandidateDeploymentEligible(candidate)
    )
    .map((candidate) => candidate.id)
    .join("|");
  const eligibleIds = useMemo(
    () =>
      new Set(
        candidates.filter(isCandidateDeploymentEligible).map((item) => item.id),
      ),
    [eligibleSignature],
  );
  const resumableIds = useMemo(
    () => new Set(resumableSignature ? resumableSignature.split("|") : []),
    [resumableSignature],
  );
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      restoreMembershipCandidateSelection(
        browserSessionStorage(),
        eligibleSignature,
        eligibleIds,
        resumableIds,
      ) ?? new Set(eligibleIds),
  );
  const [subscription, setSubscription] = useState<
    LaunchSubscriptionResponse | undefined
  >(response?.subscription);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutMessage, setCheckoutMessage] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [results, setResults] = useState<Record<string, CandidateResult>>({});
  const [
    deploymentReconciliationRevision,
    setDeploymentReconciliationRevision,
  ] = useState(0);

  useEffect(() => {
    setSelected(
      restoreMembershipCandidateSelection(
        browserSessionStorage(),
        eligibleSignature,
        eligibleIds,
        resumableIds,
      ) ?? new Set(eligibleIds),
    );
  }, [eligibleSignature, resumableSignature]);

  useEffect(() => {
    setSubscription(response?.subscription);
  }, [response?.subscription]);

  useEffect(() => {
    const storage = browserSessionStorage();
    for (const candidate of deployedCandidates) {
      clearCandidateDeploymentKey(storage, candidate);
    }
  }, [deployedSignature]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const attemptId = checkoutAttemptFromReturn(
      location.search,
      browserSessionStorage(),
    );
    if (!attemptId) return;

    let cancelled = false;
    let timer: number | undefined;
    let reads = 0;
    let shouldCancel = checkoutReturnRequestsCancellation(location.search);
    const reconcile = async () => {
      reads += 1;
      setCheckoutMessage(
        shouldCancel ? "Cancelling checkout…" : "Confirming membership…",
      );
      try {
        const attempt = shouldCancel
          ? await launchApi.cancelSubscriptionCheckoutAttempt(attemptId)
          : await launchApi.subscriptionCheckoutAttempt(attemptId);
        if (cancelled) return;
        shouldCancel = false;
        setSubscription(attempt.subscription);
        if (attempt.status === "active") {
          cancelled = true;
          setCheckoutMessage(
            "Membership active. Review your selected Agents, then deploy manually.",
          );
          forgetCheckoutAttempt();
          navigate(checkoutReturnClearedHref(location), {
            replace: true,
            scroll: "preserve",
          });
          onReload();
          return;
        }
        if (TERMINAL_CHECKOUT_STATUSES.has(attempt.status)) {
          cancelled = true;
          setCheckoutMessage(
            attempt.status === "cancelled"
              ? "Checkout was cancelled. Nothing was deployed."
              : "Membership was not activated. Nothing was deployed.",
          );
          forgetCheckoutAttempt();
          navigate(checkoutReturnClearedHref(location), {
            replace: true,
            scroll: "preserve",
          });
          return;
        }
        if (reads < 12) {
          timer = window.setTimeout(reconcile, 1_500);
        } else {
          setCheckoutMessage(
            "Payment is still processing. Nothing will deploy automatically; refresh to check again.",
          );
        }
      } catch (reason) {
        if (cancelled) return;
        if (reads < 4) {
          timer = window.setTimeout(reconcile, 1_500);
          return;
        }
        setCheckoutMessage(
          reason instanceof Error
            ? reason.message
            : "Membership status could not be confirmed.",
        );
      }
    };
    void reconcile();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [location.pathname, location.search, navigate, onReload]);

  const membershipActive = hasActiveDeploymentMembership(subscription);
  const selectedCandidates = candidates.filter((candidate) =>
    selected.has(candidate.id) && isCandidateDeploymentEligible(candidate)
  );
  const selectedNeedsReconciliation = selectedCandidates.some((candidate) =>
    needsCandidateDeploymentReconciliation(
      candidate,
      results[candidate.id]?.state,
    )
  );
  const deploymentReconciliationSignature = candidates
    .filter((candidate) =>
      needsCandidateDeploymentReconciliation(
        candidate,
        results[candidate.id]?.state,
      )
    )
    .map((candidate) => `${candidate.id}:${candidate.evidence.releaseDigest}`)
    .join("|");
  const funnel = variant === "funnel";

  useEffect(() => {
    if (!deploymentReconciliationSignature || typeof window === "undefined") {
      return;
    }

    let cancelled = false;
    let reads = 0;
    let timer: number | undefined;
    const schedule = () => {
      if (cancelled || reads >= DEPLOYMENT_RECONCILIATION_POLL_LIMIT) return;
      timer = window.setTimeout(async () => {
        reads += 1;
        try {
          await onReload();
        } catch {
          // The parent renders its load error; keep the bounded recovery poll
          // alive in case the failure was transient.
        } finally {
          schedule();
        }
      }, DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    deploymentReconciliationRevision,
    deploymentReconciliationSignature,
    onReload,
  ]);

  const toggle = (candidateId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  };

  const startMembership = async () => {
    if (checkoutBusy) return;
    setCheckoutBusy(true);
    setCheckoutMessage("");
    persistMembershipCandidateSelection(
      browserSessionStorage(),
      eligibleSignature,
      selected,
    );
    try {
      const returnUrl = new URL(
        checkoutReturnPath ?? "/",
        window.location.origin,
      );
      if (!checkoutReturnPath) {
        returnUrl.searchParams.set("panel", "candidates");
      }
      returnUrl.searchParams.set("subscription", "return");
      const checkout = await launchApi.createSubscriptionCheckout(
        returnUrl.href,
        getOrCreateMembershipCheckoutKey(
          browserSessionStorage(),
          () => crypto.randomUUID(),
        ),
      );
      rememberCheckoutAttempt(checkout.attemptId);
      markExternalReturnRevalidation();
      window.location.assign(checkout.url);
    } catch (reason) {
      if (!retainMembershipCheckoutKeyAfterFailure(reason)) {
        clearMembershipCheckoutKey(browserSessionStorage());
      }
      setCheckoutMessage(
        reason instanceof Error ? reason.message : String(reason),
      );
      setCheckoutBusy(false);
    }
  };

  const deploySelected = async () => {
    if (
      deploying ||
      !membershipActive ||
      selectedCandidates.length === 0
    ) return;
    setDeploying(true);
    persistMembershipCandidateSelection(
      browserSessionStorage(),
      eligibleSignature,
      new Set(selectedCandidates.map((candidate) => candidate.id)),
    );
    setResults((current) => {
      const next = { ...current };
      for (const candidate of selectedCandidates) {
        next[candidate.id] = {
          message: candidate.status === "deploying"
            ? "Reconciling the existing private deployment…"
            : "Starting private deployment…",
          state: "deploying",
        };
      }
      return next;
    });
    const storage = browserSessionStorage();
    const outcomes = await Promise.all(selectedCandidates.map(
      async (candidate): Promise<{
        candidate: LaunchCandidateInvitation;
        result: CandidateResult;
      }> => {
        try {
          const response = await launchApi.deployCandidate(candidate.id, {
            archiveDigest: candidate.archive.digest,
            idempotencyKey: getOrCreateCandidateDeploymentKey(
              storage,
              candidate,
              () => crypto.randomUUID(),
            ),
            releaseDigest: candidate.evidence.releaseDigest,
            reviewRevision: candidate.reviewRevision,
          });
          if (response.status === "completed") {
            clearCandidateDeploymentKey(storage, candidate);
          }
          const result: CandidateResult = {
            message: response.message,
            response,
            state: response.status,
          };
          setResults((current) => ({
            ...current,
            [candidate.id]: result,
          }));
          return {
            candidate,
            result,
          };
        } catch (reason) {
          const result: CandidateResult = {
            message: reason instanceof Error ? reason.message : String(reason),
            state: "failed",
          };
          setResults((current) => ({
            ...current,
            [candidate.id]: result,
          }));
          return {
            candidate,
            result,
          };
        }
      },
    ));
    setResults((current) => {
      const next = { ...current };
      for (const outcome of outcomes) {
        next[outcome.candidate.id] = outcome.result;
      }
      return next;
    });
    setDeploying(false);

    const completed = outcomes.filter((outcome) =>
      outcome.result.state === "completed" &&
      outcome.result.response?.agent?.setupRequired === true
    );
    if (
      shouldReloadAfterCandidateDeployment(
        outcomes.map((outcome) => outcome.result.state),
      )
    ) {
      onReload();
    }
    if (outcomes.some((outcome) => outcome.result.state === "pending")) {
      setDeploymentReconciliationRevision((current) => current + 1);
    }
    if (outcomes.length === 1 && completed.length === 1) {
      const agent = completed[0]?.result.response?.agent;
      if (agent) {
        navigate(
          `/agents/${encodeURIComponent(agent.slug)}`,
        );
      }
    }
  };

  if (candidates.length === 0 && deployedCandidates.length > 0) {
    return (
      <section
        aria-labelledby="candidate-invitations-heading"
        className={`neb-candidate-invitations ${
          funnel ? "neb-candidate-invitations-funnel" : ""
        }`}
      >
        <div className="neb-candidate-intro">
          <div>
            <p className="neb-candidate-kicker">Deployment complete</p>
            <h2 id="candidate-invitations-heading">
              {deployedCandidates.length === 1
                ? "Your Agent is deployed. Setup is next."
                : `${deployedCandidates.length} Agents are deployed. Setup is next.`}
            </h2>
            <p>
              Each release is private and inactive until you finish its
              requirements and explicitly activate it.
            </p>
          </div>
        </div>
        <DeploymentReceipts
          candidates={deployedCandidates}
          navigate={navigate}
        />
      </section>
    );
  }
  if (candidates.length === 0 && !error) {
    if (!funnel) return null;
    return (
      <section
        aria-labelledby="candidate-invitations-heading"
        className="neb-candidate-invitations neb-candidate-invitations-funnel"
      >
        <div className="neb-candidate-intro">
          <div>
            <p className="neb-candidate-kicker">Tested candidates</p>
            <h2 id="candidate-invitations-heading">
              No tested Agent has arrived yet
            </h2>
            <p>
              Return to the hand-off, let your coding Agent finish gx.test and
              submit the exact release, then check again.
            </p>
          </div>
        </div>
        <div className="neb-candidate-error-actions">
          <button onClick={onReload} type="button">Check again</button>
        </div>
      </section>
    );
  }
  if (candidates.length === 0) {
    return (
      <section
        aria-labelledby="candidate-invitations-heading"
        className={`neb-candidate-invitations ${
          funnel ? "neb-candidate-invitations-funnel" : ""
        }`}
      >
        <div className="neb-candidate-intro">
          <div>
            <p className="neb-candidate-kicker">Tested candidates</p>
            <h2 id="candidate-invitations-heading">
              Built Agents could not be loaded
            </h2>
            <p>
              Deployment is unavailable until Galactic can verify the exact
              candidate list and membership state.
            </p>
          </div>
        </div>
        <p className="neb-candidate-error" role="alert">{error}</p>
        <div className="neb-candidate-error-actions">
          <button onClick={onReload} type="button">Try again</button>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="candidate-invitations-heading"
      className={`neb-candidate-invitations ${
        funnel ? "neb-candidate-invitations-funnel" : ""
      }`}
    >
      <div className="neb-candidate-intro">
        <div>
          <p className="neb-candidate-kicker">
            {funnel ? "Galactic membership · $20 a month" : "Tested candidates"}
          </p>
          <h2 id="candidate-invitations-heading">
            {funnel
              ? candidates.length === 1
                ? "1 Agent is built, not deployed"
                : `${candidates.length} Agents are built, not deployed`
              : "Review what your coding Agent built"}
          </h2>
          <p>
            {funnel
              ? "Review the exact-tested release below. Membership unlocks deployment. Nothing is deployed until you confirm."
              : "These exact releases are frozen. Membership unlocks a manual Deploy; payment never deploys them."}
          </p>
        </div>
        <div className="neb-candidate-selection-count">
          {selectedCandidates.length} of {eligibleIds.size} selected
        </div>
      </div>

      {error
        ? <p className="neb-candidate-error" role="alert">{error}</p>
        : null}

      {deployedCandidates.length > 0
        ? (
          <DeploymentReceipts
            candidates={deployedCandidates}
            navigate={navigate}
          />
        )
        : null}

      <div className="neb-candidate-list">
        {candidates.map((candidate) => {
          const eligible = isCandidateDeploymentEligible(candidate);
          const result = results[candidate.id];
          const needsReconciliation = needsCandidateDeploymentReconciliation(
            candidate,
            result?.state,
          );
          return (
            <article className="neb-candidate-card" key={candidate.id}>
              <div className="neb-candidate-card-head">
                <label className="neb-candidate-select">
                  <input
                    checked={selected.has(candidate.id) && eligible}
                    disabled={!eligible || deploying || needsReconciliation}
                    onChange={() => toggle(candidate.id)}
                    type="checkbox"
                  />
                  <span className="neb-candidate-check" />
                  <span className="sr-only">
                    Select {candidate.release.name} for deployment
                  </span>
                </label>
                <div className="neb-candidate-title">
                  <p>{extensionCopy(candidate)}</p>
                  <h3>{candidate.release.name}</h3>
                  <span>release {candidate.release.version}</span>
                </div>
                <span
                  className={`neb-candidate-status ${
                    needsReconciliation
                      ? "deploying"
                      : eligible
                      ? "ready"
                      : "blocked"
                  }`}
                >
                  {needsReconciliation
                    ? "Deployment in progress"
                    : statusCopy(candidate)}
                </span>
              </div>

              {candidate.release.description
                ? (
                  <p className="neb-candidate-description">
                    {candidate.release.description}
                  </p>
                )
                : null}

              <dl className="neb-candidate-manifest">
                {candidateManifestRows(candidate).map((row) => (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>

              <div className="neb-candidate-disclosures">
                <ManifestDisclosure
                  empty="No function authority declared"
                  label="Authority"
                  values={candidate.release.functions.map((fn) => {
                    const effects = fn.effects.length > 0
                      ? ` · ${
                        fn.effects.map((effect) =>
                          `${effect.id} (${effect.policy})`
                        ).join(", ")
                      }`
                      : "";
                    return `${fn.name}: ${
                      fn.authorityLevel?.replace("_", " ") ?? "not declared"
                    }${effects}${fn.description ? ` · ${fn.description}` : ""}`;
                  })}
                />
                <ManifestDisclosure
                  empty="No external endpoints requested"
                  label="Endpoints"
                  values={candidate.release.network.map((endpoint) =>
                    `${
                      endpoint.label
                        ? `${endpoint.label} · ${endpoint.host}`
                        : endpoint.host
                    }${
                      endpoint.description ? ` · ${endpoint.description}` : ""
                    }`
                  )}
                />
                <ManifestDisclosure
                  empty="No setup variables requested"
                  label="Setup variables"
                  values={candidate.release.settings.map((setting) =>
                    `${
                      setting.label
                        ? `${setting.label} (${setting.key})`
                        : setting.key
                    }${setting.required ? " · required" : " · optional"} · ${
                      setting.scope.replace("_", " ")
                    }${setting.secret ? " · secret" : ""}${
                      setting.destination ? ` · ${setting.destination}` : ""
                    }${setting.description ? ` · ${setting.description}` : ""}`
                  )}
                />
                <ManifestDisclosure
                  empty="No additional runtime permissions declared"
                  label="Permissions"
                  values={candidate.release.permissions}
                />
                <ManifestDisclosure
                  empty="No virtual-machine setup inputs requested"
                  label="Compute setup"
                  values={candidate.release.compute
                    ? [
                      `Profile: ${candidate.release.compute.profile}`,
                      ...candidate.release.compute.tools.map((tool) =>
                        `Tool: ${tool}`
                      ),
                      ...candidate.release.compute.secretNames.map((name) =>
                        `Variable: ${name}`
                      ),
                    ]
                    : []}
                />
                <ManifestDisclosure
                  empty="No interface bindings declared"
                  label="Interface bindings"
                  values={candidate.release.interfaces.map((item) =>
                    `${item.label}: ${
                      item.functions.join(", ") || "no callable functions"
                    }${item.description ? ` · ${item.description}` : ""}`
                  )}
                />
              </div>

              <div className="neb-candidate-evidence">
                <span>{qualificationCopy(candidate)}</span>
                <code>
                  release {candidate.evidence.releaseDigest.slice(0, 12)}…
                </code>
              </div>

              {result
                ? (
                  <div
                    className={`neb-candidate-result ${result.state}`}
                    role={result.state === "failed" ? "alert" : "status"}
                  >
                    <span>{result.message}</span>
                    {result.state === "completed" && result.response?.agent
                      ? (
                        <button
                          onClick={() =>
                            navigate(
                              `/agents/${
                                encodeURIComponent(
                                  result.response!.agent!.slug,
                                )
                              }`,
                            )}
                          type="button"
                        >
                          Continue setup
                        </button>
                      )
                      : null}
                  </div>
                )
                : null}
            </article>
          );
        })}
      </div>

      {funnel ? <MembershipFacts candidates={candidates} /> : null}

      <div className="neb-candidate-deploy-bar">
        <div>
          <strong>
            {membershipActive ? "Membership active" : "Membership required"}
          </strong>
          <p>
            Deploy creates a private, setup-required Agent. Routines stay paused
            until credentials, authority, cadence, and budget are reviewed and
            you explicitly activate them.
          </p>
          {checkoutMessage
            ? <p className="neb-candidate-checkout-status">{checkoutMessage}</p>
            : null}
        </div>
        <button
          className="neb-candidate-primary"
          disabled={membershipActive
            ? deploying || selectedCandidates.length === 0
            : checkoutBusy}
          onClick={() =>
            void (membershipActive ? deploySelected() : startMembership())}
          type="button"
        >
          {membershipActive
            ? deploying
              ? "Deploying selected Agents…"
              : selectedNeedsReconciliation
              ? `Resume ${
                selectedCandidates.length === 1
                  ? "Agent deployment"
                  : "selected deployments"
              }`
              : selectedCandidates.length > 0
              ? candidateDeployButtonLabel(selectedCandidates.length)
              : "Select an Agent to deploy"
            : checkoutBusy
            ? "Opening checkout…"
            : "Start membership — $20/month"}
        </button>
      </div>
    </section>
  );
}

function DeploymentReceipts({
  candidates,
  navigate,
}: {
  candidates: LaunchCandidateInvitation[];
  navigate: LaunchNavigate;
}): ReactElement {
  return (
    <div
      aria-label="Recently deployed Agents"
      className="neb-candidate-receipts"
    >
      {candidates.map((candidate) => {
        const receipt = candidate.deployment!;
        return (
          <article key={receipt.deploymentId}>
            <div>
              <span>Private deployment complete</span>
              <h3>{receipt.agent.name}</h3>
              <p>
                release {receipt.agent.version} · setup required · deployed{" "}
                <time dateTime={receipt.completedAt}>
                  {deploymentTime(receipt.completedAt)}
                </time>
              </p>
            </div>
            <button
              onClick={() =>
                navigate(
                  `/agents/${encodeURIComponent(receipt.agent.slug)}`,
                )}
              type="button"
            >
              Continue setup
            </button>
          </article>
        );
      })}
    </div>
  );
}

function deploymentTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "recently";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function MembershipFacts({
  candidates,
}: {
  candidates: LaunchCandidateInvitation[];
}): ReactElement {
  const agentLabel = candidates.length === 1
    ? candidates[0]?.release.name ?? "this Agent"
    : `${candidates.length} selected Agents`;
  return (
    <div
      aria-label="What Galactic membership includes"
      className="neb-membership-facts"
    >
      <div>
        <h3>Membership includes</h3>
        <p>
          Run {agentLabel}{" "}
          and the other Agents you build on one shared weekly capacity pool.
        </p>
      </div>
      <div>
        <h3>Exact-tested releases</h3>
        <p>
          Deployment materializes the frozen source and artifacts whose
          fingerprints you reviewed here.
        </p>
      </div>
      <div>
        <h3>Private until you decide</h3>
        <p>
          Each Agent deploys privately with setup required and routines paused.
          Payment itself never starts one.
        </p>
      </div>
      <div>
        <h3>Leaving is straightforward</h3>
        <p>
          Cancel any time. A lapsed membership stops Agent execution while the
          retained release remains tied to your account.
        </p>
      </div>
    </div>
  );
}

function ManifestDisclosure({
  empty,
  label,
  values,
}: {
  empty: string;
  label: string;
  values: string[];
}): ReactElement {
  return (
    <div>
      <h4>{label}</h4>
      {values.length > 0
        ? (
          <ul>
            {values.map((value) => <li key={value}>{value}</li>)}
          </ul>
        )
        : <p>{empty}</p>}
    </div>
  );
}
