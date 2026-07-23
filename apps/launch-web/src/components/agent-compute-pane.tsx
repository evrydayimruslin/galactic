import {
  type ChangeEvent,
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { LaunchAgentSummary } from "../../../../shared/contracts/launch.ts";
import { launchApi, launchApiOrigin } from "../lib/api";
import {
  COMPUTE_PROFILE,
  COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS,
  COMPUTE_V1_MAX_ARTIFACT_BYTES,
  computeRunDuration,
  type ComputeSettingsDraft,
  computeSettingsDraft,
  computeSettingsRequest,
  isComputeEndpointUnavailable,
  isComputeRunActive,
  type LaunchComputeAuthorityRule,
  type LaunchComputeRunSummary,
  type LaunchComputeSecretBindingSummary,
  type LaunchComputeSettingsResponse,
  mergeComputeRunHistory,
  safeComputeLink,
} from "../lib/compute";

type ComputeFeatureState = "loading" | "ready" | "unavailable" | "error";
export type ComputeRunTargetState =
  | "none"
  | "loading"
  | "found"
  | "stale"
  | "invalid";

const COMPUTE_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_COMPUTE_TARGET_PAGES = 10;

interface ComputeRunPage {
  runs: LaunchComputeRunSummary[];
  next_cursor?: string | null;
}

export interface ComputeRunTargetLoadResult {
  nextCursor: string | null;
  runs: LaunchComputeRunSummary[];
  targetRunId: string | null;
  targetState: Exclude<ComputeRunTargetState, "loading">;
}

/**
 * A route item is allowed to target only a Compute UUID. It is never
 * interpolated into a selector or request URL.
 */
export function normalizeComputeRunTarget(
  itemId: string | null | undefined,
): string | null {
  const normalized = itemId?.trim();
  return normalized && COMPUTE_RUN_ID_PATTERN.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

/**
 * Resolve a direct Compute-run link through the owner-scoped run ledger.
 * Pagination is deliberately bounded so a guessed UUID cannot trigger an
 * unbounded scan. Invalid route items load the ordinary first page but are
 * never used as a cursor, selector, or network path.
 */
export async function loadComputeRunsForTarget(
  loadPage: (cursor?: string) => Promise<ComputeRunPage>,
  itemId: string | null | undefined,
  maxTargetPages = MAX_COMPUTE_TARGET_PAGES,
): Promise<ComputeRunTargetLoadResult> {
  const requestedItem = itemId?.trim() ?? "";
  const targetRunId = normalizeComputeRunTarget(itemId);
  const firstPage = await loadPage();
  let runs = mergeComputeRunHistory([], firstPage.runs);
  let nextCursor = firstPage.next_cursor ?? null;

  if (!requestedItem) {
    return { runs, nextCursor, targetRunId: null, targetState: "none" };
  }
  if (!targetRunId) {
    return { runs, nextCursor, targetRunId: null, targetState: "invalid" };
  }

  const containsTarget = () =>
    runs.some((run) => run.runId.toLowerCase() === targetRunId);
  if (containsTarget()) {
    return { runs, nextCursor, targetRunId, targetState: "found" };
  }

  const pageLimit = Math.max(1, Math.floor(maxTargetPages));
  let loadedPages = 1;
  while (nextCursor && loadedPages < pageLimit) {
    const page = await loadPage(nextCursor);
    runs = mergeComputeRunHistory(runs, page.runs);
    nextCursor = page.next_cursor ?? null;
    loadedPages += 1;
    if (containsTarget()) {
      return { runs, nextCursor, targetRunId, targetState: "found" };
    }
  }

  return { runs, nextCursor, targetRunId, targetState: "stale" };
}

function agentLocator(agent: LaunchAgentSummary): string {
  return agent.slug || agent.id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let amount = value;
  let index = 0;
  while (amount >= 1000 && index < units.length - 1) {
    amount /= 1000;
    index += 1;
  }
  const precision = amount < 10 && index > 0 ? 1 : 0;
  return `${amount.toFixed(precision)} ${units[index]}`;
}

function formatDuration(value: number | null): string {
  if (value === null) return "in progress";
  if (value < 1000) return `${value} ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}

function computeLinkHref(value: string | null): string | null {
  const safe = safeComputeLink(value);
  if (!safe || !safe.startsWith("/")) return safe;
  return new URL(safe, `${launchApiOrigin()}/`).toString();
}

function humanizeTool(tool: string): string {
  return tool.replaceAll(/[._-]+/gu, " ").replaceAll(
    /\b\w/gu,
    (value) => value.toUpperCase(),
  );
}

function defaultSecretDelivery(name: string): {
  kind: "env";
  envName: string;
} {
  return { kind: "env", envName: name };
}

function isValidSettingsResponse(
  response: LaunchComputeSettingsResponse,
): boolean {
  return Boolean(
    response && typeof response.revision === "string" && response.revision &&
      response.settings && response.settings.profile === COMPUTE_PROFILE &&
      Array.isArray(response.settings.allowedTools) &&
      Array.isArray(response.settings.secretBindings) &&
      Array.isArray(response.settings.authorityRules) &&
      response.settings.manifestCeiling &&
      Array.isArray(response.settings.manifestCeiling.tools) &&
      Array.isArray(response.settings.manifestCeiling.secrets),
  );
}

export function AgentComputePane({
  agent,
  itemId,
  onClearItem,
}: {
  agent: LaunchAgentSummary;
  itemId?: string;
  onClearItem?: () => void;
}): ReactElement {
  const locator = agentLocator(agent);
  const [featureState, setFeatureState] = useState<ComputeFeatureState>(
    "loading",
  );
  const [loadedLocator, setLoadedLocator] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<
    LaunchComputeSettingsResponse | null
  >(null);
  const [draft, setDraft] = useState<ComputeSettingsDraft | null>(null);
  const [runs, setRuns] = useState<LaunchComputeRunSummary[]>([]);
  const [nextRunCursor, setNextRunCursor] = useState<string | null>(null);
  const [runTargetState, setRunTargetState] = useState<ComputeRunTargetState>(
    itemId ? "loading" : "none",
  );
  const [targetRunId, setTargetRunId] = useState<string | null>(
    normalizeComputeRunTarget(itemId),
  );
  const targetRunRef = useRef<HTMLElement | null>(null);
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const loadRuns = useCallback(async () => {
    const response = await launchApi.agentComputeRuns(locator, { limit: 50 });
    setRuns((current) => mergeComputeRunHistory(current, response.runs));
    if (
      targetRunId &&
      response.runs.some((run) => run.runId.toLowerCase() === targetRunId)
    ) {
      setRunTargetState("found");
    }
    setNextRunCursor(response.next_cursor ?? null);
  }, [locator, targetRunId]);

  const loadMoreRuns = async () => {
    if (!nextRunCursor || loadingMoreRuns) return;
    setLoadingMoreRuns(true);
    setError("");
    try {
      const response = await launchApi.agentComputeRuns(locator, {
        limit: 50,
        cursor: nextRunCursor,
      });
      setRuns((current) => mergeComputeRunHistory(current, response.runs));
      if (
        targetRunId &&
        response.runs.some((run) => run.runId.toLowerCase() === targetRunId)
      ) {
        setRunTargetState("found");
      }
      setNextRunCursor(response.next_cursor ?? null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoadingMoreRuns(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    setFeatureState("loading");
    setLoadedLocator(null);
    setSnapshot(null);
    setDraft(null);
    setError("");
    setSaved("");
    setConfirmed(false);
    void (async () => {
      try {
        const response = await launchApi.agentComputeSettings(locator);
        if (!isValidSettingsResponse(response)) {
          throw new Error(
            "Compute settings returned an invalid authority view.",
          );
        }
        if (!mounted) return;
        setSnapshot(response);
        setDraft(computeSettingsDraft(response.settings));
        setLoadedLocator(locator);
        setFeatureState("ready");
      } catch (reason) {
        if (!mounted) return;
        setFeatureState(
          isComputeEndpointUnavailable(reason) ? "unavailable" : "error",
        );
        if (!isComputeEndpointUnavailable(reason)) {
          setError(errorMessage(reason));
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [locator]);

  useEffect(() => {
    if (featureState !== "ready" || loadedLocator !== locator) return;
    let mounted = true;
    setRuns([]);
    setNextRunCursor(null);
    setLoadingMoreRuns(false);
    setTargetRunId(normalizeComputeRunTarget(itemId));
    setRunTargetState(itemId ? "loading" : "none");
    setError("");
    void (async () => {
      try {
        const result = await loadComputeRunsForTarget(
          (cursor) =>
            launchApi.agentComputeRuns(locator, {
              limit: 50,
              ...(cursor ? { cursor } : {}),
            }),
          itemId,
        );
        if (!mounted) return;
        setRuns(result.runs);
        setNextRunCursor(result.nextCursor);
        setTargetRunId(result.targetRunId);
        setRunTargetState(result.targetState);
      } catch (reason) {
        if (!mounted) return;
        setRunTargetState(itemId ? "stale" : "none");
        setError(`Run history is unavailable: ${errorMessage(reason)}`);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [featureState, itemId, loadedLocator, locator]);

  useEffect(() => {
    if (runTargetState !== "found" || !targetRunId) return;
    const frame = window.requestAnimationFrame(() => {
      targetRunRef.current?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
      targetRunRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [runTargetState, targetRunId]);

  const hasActiveRuns = runs.some((run) => isComputeRunActive(run.status));
  useEffect(() => {
    if (featureState !== "ready" || !hasActiveRuns) return;
    const interval = window.setInterval(() => {
      void loadRuns().catch(() => undefined);
    }, 8_000);
    return () => window.clearInterval(interval);
  }, [featureState, hasActiveRuns, loadRuns]);

  const validation = useMemo(() => {
    if (!draft || !snapshot) return { request: null, errors: [] as string[] };
    return computeSettingsRequest(
      draft,
      snapshot.settings.manifestCeiling,
      snapshot.revision,
    );
  }, [draft, snapshot]);

  const updateDraft = (next: ComputeSettingsDraft) => {
    setDraft(next);
    setConfirmed(false);
    setSaved("");
  };

  const toggleTool = (tool: string) => {
    if (!draft) return;
    const selected = draft.allowedTools.includes(tool);
    updateDraft({
      ...draft,
      allowedTools: selected
        ? draft.allowedTools.filter((candidate) => candidate !== tool)
        : [...draft.allowedTools, tool],
    });
  };

  const bindingSummary = (
    name: string,
  ): LaunchComputeSecretBindingSummary | undefined =>
    snapshot?.settings.secretBindings.find((binding) => binding.name === name);

  const toggleSecret = (name: string) => {
    if (!draft) return;
    const selected = draft.secretBindings.some((binding) =>
      binding.name === name
    );
    updateDraft({
      ...draft,
      secretBindings: selected
        ? draft.secretBindings.filter((binding) => binding.name !== name)
        : [...draft.secretBindings, {
          name,
          delivery: bindingSummary(name)?.delivery ??
            defaultSecretDelivery(name),
        }],
    });
  };

  const updateSecretDelivery = (
    name: string,
    delivery: ComputeSettingsDraft["secretBindings"][number]["delivery"],
  ) => {
    if (!draft) return;
    updateDraft({
      ...draft,
      secretBindings: draft.secretBindings.map((binding) =>
        binding.name === name ? { ...binding, delivery } : binding
      ),
    });
  };

  const updateLimit = (
    key:
      | "maxTimeoutMs"
      | "maxConcurrency"
      | "maxArtifactBytes"
      | "maxArtifacts",
  ) =>
  (event: ChangeEvent<HTMLInputElement>) => {
    if (!draft) return;
    updateDraft({ ...draft, [key]: event.currentTarget.value });
  };

  const addAuthorityRule = () => {
    if (!draft) return;
    updateDraft({
      ...draft,
      authorityRules: [...draft.authorityRules, {
        callerFunction: "main",
        decision: "always",
        action: "platform.call",
        target: { functionName: "gx.upload" },
      }],
    });
  };

  const updateAuthorityRule = (
    index: number,
    next: LaunchComputeAuthorityRule,
  ) => {
    if (!draft) return;
    updateDraft({
      ...draft,
      authorityRules: draft.authorityRules.map((rule, candidateIndex) =>
        candidateIndex === index ? next : rule
      ),
    });
  };

  const removeAuthorityRule = (index: number) => {
    if (!draft) return;
    updateDraft({
      ...draft,
      authorityRules: draft.authorityRules.filter((_, candidateIndex) =>
        candidateIndex !== index
      ),
    });
  };

  const save = async () => {
    if (!validation.request || !confirmed || saving) return;
    setSaving(true);
    setError("");
    setSaved("");
    try {
      const response = await launchApi.updateAgentComputeSettings(
        locator,
        validation.request,
      );
      if (!isValidSettingsResponse(response)) {
        throw new Error(
          "Compute settings update returned an invalid authority view.",
        );
      }
      setSnapshot(response);
      setDraft(computeSettingsDraft(response.settings));
      setConfirmed(false);
      setSaved("Compute authority saved.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const cancel = async (run: LaunchComputeRunSummary) => {
    if (!run.cancellable || cancelling) return;
    if (
      !window.confirm(
        `Cancel Compute run ${run.runId}? The disposable body will be stopped.`,
      )
    ) {
      return;
    }
    setCancelling(run.runId);
    setError("");
    try {
      const next = await launchApi.cancelAgentComputeRun(locator, run.runId);
      setRuns((current) =>
        current.map((candidate) =>
          candidate.runId === run.runId ? next : candidate
        )
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setCancelling(null);
    }
  };

  if (featureState === "loading") {
    return (
      <section className="neb-modal-pane active">
        <h2 className="neb-modal-h">Compute</h2>
        <p className="neb-ov-note">
          Loading the owner-authorized Compute boundary…
        </p>
      </section>
    );
  }

  if (featureState === "unavailable") {
    return (
      <section className="neb-modal-pane active">
        <h2 className="neb-modal-h">Compute</h2>
        <div className="neb-compute-gate" role="status">
          <strong>Compute is not available in this environment.</strong>
          <p>
            The control-plane endpoint is absent, so no Compute controls or
            cancellation actions are enabled.
          </p>
        </div>
      </section>
    );
  }

  if (featureState === "error" || !snapshot || !draft) {
    return (
      <section className="neb-modal-pane active">
        <h2 className="neb-modal-h">Compute</h2>
        <p className="neb-error-note" role="alert">
          Compute is fail-closed:{" "}
          {error || "its authority view could not be loaded."}
        </p>
      </section>
    );
  }

  const ceiling = snapshot.settings.manifestCeiling;
  const declaredSecrets = ceiling.secrets;
  return (
    <section className="neb-modal-pane active">
      <h2 className="neb-modal-h">Compute</h2>
      <p className="neb-ov-note top-note">
        Disposable Linux bodies for this Agent. These owner settings can only
        narrow the currently live release; the control plane enforces the final
        boundary on every run.
      </p>
      {error ? <p className="neb-error-note" role="alert">{error}</p> : null}
      {saved
        ? <p className="neb-release-success" role="status">{saved}</p>
        : null}

      <section className="neb-ov-section">
        <div className="neb-ov-label">Authority</div>
        {!ceiling.enabled
          ? (
            <div className="neb-compute-gate">
              <strong>
                The live release does not declare galactic.compute().
              </strong>
              <p>
                Add <code>compute:exec</code> and a{" "}
                <code>{COMPUTE_PROFILE}</code>{" "}
                manifest ceiling in a reviewed release before it can be enabled
                here.
              </p>
            </div>
          )
          : null}
        <label className="neb-compute-check primary">
          <input
            checked={draft.enabled}
            disabled={!ceiling.enabled}
            onChange={(event) =>
              updateDraft({ ...draft, enabled: event.currentTarget.checked })}
            type="checkbox"
          />
          <span>
            <strong>Enable Compute</strong>
            <small>
              Allow this Agent's approved functions to start one-shot bodies.
            </small>
          </span>
        </label>
        <div className="neb-ov-row">
          <span className="neb-ov-row-key">Profile</span>
          <span className="neb-ov-row-val">{COMPUTE_PROFILE}</span>
        </div>
      </section>

      <section className="neb-ov-section">
        <div className="neb-ov-label">Declared Compute dependencies</div>
        <p className="neb-ov-note">
          These labels disclose the environment capabilities this release
          expects for dependency resolution and audit. They neither install
          packages nor enforce which binaries a Linux body may execute.
        </p>
        <div className="neb-compute-tool-grid">
          {ceiling.tools.map((tool) => (
            <label className="neb-compute-check" key={tool}>
              <input
                checked={draft.allowedTools.includes(tool)}
                disabled={!draft.enabled}
                onChange={() =>
                  toggleTool(tool)}
                type="checkbox"
              />
              <span>
                <strong>{humanizeTool(tool)}</strong>
                <small>{tool}</small>
              </span>
            </label>
          ))}
        </div>
        {ceiling.tools.length === 0
          ? (
            <p className="neb-ov-note">
              The live release declares no Compute dependencies.
            </p>
          )
          : null}
      </section>

      <section className="neb-ov-section">
        <div className="neb-ov-label">Secret delivery</div>
        <p className="neb-ov-note">
          Map only secret names declared by this release. Values are managed
          write-only in Variables and are never returned here.
        </p>
        {declaredSecrets.map((name) => {
          const binding = draft.secretBindings.find((candidate) =>
            candidate.name === name
          );
          const summary = bindingSummary(name);
          return (
            <div className="neb-compute-secret" key={name}>
              <label className="neb-compute-check">
                <input
                  checked={Boolean(binding)}
                  disabled={!draft.enabled}
                  onChange={() => toggleSecret(name)}
                  type="checkbox"
                />
                <span>
                  <strong>{name}</strong>
                  <small className={summary?.configured ? "configured" : ""}>
                    {summary?.configured
                      ? "value configured"
                      : "value not configured"}
                  </small>
                </span>
              </label>
              {binding
                ? (
                  <div className="neb-compute-secret-destination">
                    <select
                      aria-label={`${name} delivery kind`}
                      className="neb-edit-input"
                      disabled={!draft.enabled}
                      onChange={(event) => {
                        const kind = event.currentTarget.value;
                        updateSecretDelivery(
                          name,
                          kind === "file"
                            ? {
                              kind: "file",
                              path: `/run/galactic/secrets/${name}`,
                            }
                            : defaultSecretDelivery(name),
                        );
                      }}
                      value={binding.delivery.kind}
                    >
                      <option value="env">Environment</option>
                      <option value="file">Protected file</option>
                    </select>
                    <input
                      aria-label={`${name} destination`}
                      className="neb-edit-input"
                      disabled={!draft.enabled}
                      onChange={(event) =>
                        updateSecretDelivery(
                          name,
                          binding.delivery.kind === "env"
                            ? {
                              kind: "env",
                              envName: event.currentTarget.value,
                            }
                            : { kind: "file", path: event.currentTarget.value },
                        )}
                      spellCheck={false}
                      value={binding.delivery.kind === "env"
                        ? binding.delivery.envName
                        : binding.delivery.path}
                    />
                  </div>
                )
                : null}
            </div>
          );
        })}
        {declaredSecrets.length === 0
          ? (
            <p className="neb-ov-note">
              The live release declares no Compute-eligible secret names.
            </p>
          )
          : null}
      </section>

      <section className="neb-ov-section">
        <div className="neb-compute-section-head">
          <div className="neb-ov-label">Platform authority by caller</div>
          <button
            className="neb-btn-sm"
            disabled={!draft.enabled || draft.authorityRules.length >= 200}
            onClick={addAuthorityRule}
            type="button"
          >
            Add exact rule
          </button>
        </div>
        <p className="neb-ov-note">
          Choose one exact Galactic function, or one exact Agent and function,
          for each calling function. No wildcard grant exists.
        </p>
        <div className="neb-compute-authority-list">
          {draft.authorityRules.map((rule, index) => (
            <div className="neb-compute-authority-rule" key={index}>
              <label>
                <span>Caller function</span>
                <input
                  aria-label={`Authority rule ${index + 1} caller function`}
                  className="neb-edit-input"
                  disabled={!draft.enabled}
                  onChange={(event) =>
                    updateAuthorityRule(index, {
                      ...rule,
                      callerFunction: event.currentTarget.value,
                    })}
                  spellCheck={false}
                  value={rule.callerFunction}
                />
              </label>
              <label>
                <span>Decision</span>
                <select
                  aria-label={`Authority rule ${index + 1} decision`}
                  className="neb-edit-input"
                  disabled={!draft.enabled}
                  onChange={(event) =>
                    updateAuthorityRule(index, {
                      ...rule,
                      decision: event.currentTarget.value as "always" | "never",
                    })}
                  value={rule.decision}
                >
                  <option value="always">Always</option>
                  <option value="never">Never</option>
                </select>
              </label>
              <label>
                <span>Action</span>
                <select
                  aria-label={`Authority rule ${index + 1} action`}
                  className="neb-edit-input"
                  disabled={!draft.enabled}
                  onChange={(event) =>
                    updateAuthorityRule(
                      index,
                      event.currentTarget.value === "agents.call"
                        ? {
                          callerFunction: rule.callerFunction,
                          decision: rule.decision,
                          action: "agents.call",
                          target: { agentId: "", functionName: "" },
                        }
                        : {
                          callerFunction: rule.callerFunction,
                          decision: rule.decision,
                          action: "platform.call",
                          target: { functionName: "gx.upload" },
                        },
                    )}
                  value={rule.action}
                >
                  <option value="platform.call">
                    Galactic platform function
                  </option>
                  <option value="agents.call">Agent function</option>
                </select>
              </label>
              {rule.action === "agents.call"
                ? (
                  <label>
                    <span>Target Agent UUID</span>
                    <input
                      aria-label={`Authority rule ${
                        index + 1
                      } target Agent UUID`}
                      className="neb-edit-input"
                      disabled={!draft.enabled}
                      onChange={(event) =>
                        updateAuthorityRule(index, {
                          ...rule,
                          target: {
                            ...rule.target,
                            agentId: event.currentTarget.value,
                          },
                        })}
                      spellCheck={false}
                      value={rule.target.agentId}
                    />
                  </label>
                )
                : null}
              <label>
                <span>Exact target function</span>
                <input
                  aria-label={`Authority rule ${index + 1} target function`}
                  className="neb-edit-input"
                  disabled={!draft.enabled}
                  onChange={(event) =>
                    updateAuthorityRule(index, {
                      ...rule,
                      target: rule.action === "platform.call"
                        ? { functionName: event.currentTarget.value }
                        : {
                          agentId: rule.target.agentId,
                          functionName: event.currentTarget.value,
                        },
                    } as LaunchComputeAuthorityRule)}
                  placeholder={rule.action === "platform.call"
                    ? "gx.upload"
                    : "functionName"}
                  spellCheck={false}
                  value={rule.target.functionName}
                />
              </label>
              <button
                className="neb-btn-sm danger"
                disabled={!draft.enabled}
                onClick={() => removeAuthorityRule(index)}
                type="button"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        {draft.authorityRules.length === 0
          ? (
            <p className="neb-ov-note">
              No Compute caller can reach Galactic platform or Agent functions.
            </p>
          )
          : null}
      </section>

      <section className="neb-ov-section">
        <div className="neb-ov-label">Run ceilings</div>
        <div className="neb-compute-limit-grid">
          <label>
            <span>Timeout (ms, max 8 min)</span>
            <input
              className="neb-edit-input"
              max={COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS}
              min="1000"
              onChange={updateLimit("maxTimeoutMs")}
              type="number"
              value={draft.maxTimeoutMs}
            />
          </label>
          <label>
            <span>Concurrent runs</span>
            <input
              className="neb-edit-input"
              min="1"
              onChange={updateLimit("maxConcurrency")}
              type="number"
              value={draft.maxConcurrency}
            />
          </label>
          <label>
            <span>Input + output bytes / run (max 1 GiB)</span>
            <input
              className="neb-edit-input"
              max={COMPUTE_V1_MAX_ARTIFACT_BYTES}
              min="1"
              onChange={updateLimit("maxArtifactBytes")}
              type="number"
              value={draft.maxArtifactBytes}
            />
          </label>
          <label>
            <span>Input + output artifacts / run</span>
            <input
              className="neb-edit-input"
              min="1"
              onChange={updateLimit("maxArtifacts")}
              type="number"
              value={draft.maxArtifacts}
            />
          </label>
        </div>
      </section>

      <section
        className="neb-compute-confirm"
        aria-label="Confirm Compute authority"
      >
        {validation.errors.length > 0
          ? (
            <ul>
              {validation.errors.map((item) => <li key={item}>{item}</li>)}
            </ul>
          )
          : null}
        <label className="neb-compute-check">
          <input
            checked={confirmed}
            disabled={!validation.request}
            onChange={(event) => setConfirmed(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>
            <strong>I confirm this authority</strong>
            <small>
              Compute bodies may browse the internet, receive the mapped
              secrets, and exercise only the exact platform or Agent rules shown
              above.
            </small>
          </span>
        </label>
        <button
          className="neb-btn"
          disabled={!confirmed || !validation.request || saving}
          onClick={() => void save()}
          type="button"
        >
          {saving ? "Saving…" : "Save Compute authority"}
        </button>
      </section>

      <section className="neb-ov-section neb-compute-runs">
        <div className="neb-compute-section-head">
          <div className="neb-ov-label">Recent runs</div>
          <button
            className="neb-btn-sm"
            onClick={() =>
              void loadRuns().catch((reason) => setError(errorMessage(reason)))}
            type="button"
          >
            Refresh
          </button>
        </div>
        {runTargetState === "invalid"
          ? (
            <ComputeRunStaleTarget
              message="This Compute run link is invalid and was not used."
              onClear={onClearItem}
            />
          )
          : null}
        {runTargetState === "stale"
          ? (
            <ComputeRunStaleTarget
              message="This Compute run is no longer available in the safely bounded run history."
              onClear={onClearItem}
            />
          )
          : null}
        {runTargetState === "loading"
          ? (
            <p className="neb-ov-note" role="status">
              Locating this Compute run…
            </p>
          )
          : null}
        {runs.map((run) => (
          <ComputeRunRow
            cancelling={cancelling === run.runId}
            deepLinked={runTargetState === "found" &&
              run.runId.toLowerCase() === targetRunId}
            key={run.runId}
            onCancel={() => void cancel(run)}
            run={run}
            targetRef={targetRunRef}
          />
        ))}
        {runs.length === 0 && runTargetState !== "loading"
          ? <p className="neb-ov-note">No Compute runs yet.</p>
          : null}
        {nextRunCursor
          ? (
            <button
              className="neb-btn-sm"
              disabled={loadingMoreRuns}
              onClick={() => void loadMoreRuns()}
              type="button"
            >
              {loadingMoreRuns ? "Loading…" : "Load more runs"}
            </button>
          )
          : null}
        <p className="neb-ov-note">
          Infrastructure failures and settlement reconciliation also appear in
          this Agent's Alerts.
        </p>
      </section>
    </section>
  );
}

function ComputeRunStaleTarget({
  message,
  onClear,
}: {
  message: string;
  onClear?: () => void;
}): ReactElement {
  return (
    <div className="neb-stale-item" role="status">
      <p className="neb-ov-note">{message}</p>
      {onClear
        ? (
          <button className="neb-btn-sm" onClick={onClear} type="button">
            Return to Compute
          </button>
        )
        : null}
    </div>
  );
}

function ComputeRunRow({
  cancelling,
  deepLinked,
  onCancel,
  run,
  targetRef,
}: {
  cancelling: boolean;
  deepLinked: boolean;
  onCancel: () => void;
  run: LaunchComputeRunSummary;
  targetRef: RefObject<HTMLElement | null>;
}): ReactElement {
  const duration = computeRunDuration(run);
  const receiptUrl = computeLinkHref(run.receiptUrl);
  return (
    <article
      className={[
        `neb-compute-run status-${run.status}`,
        deepLinked ? "neb-deep-link-target" : "",
      ].filter(Boolean).join(" ")}
      ref={deepLinked ? targetRef : undefined}
      tabIndex={deepLinked ? -1 : undefined}
    >
      <div className="neb-compute-run-head">
        <div>
          <strong>{run.functionName}</strong>
          <span>{run.agentName} · {run.runId}</span>
        </div>
        <span className="neb-compute-run-status">
          {run.status.replaceAll("_", " ")}
        </span>
      </div>
      <div className="neb-compute-run-grid">
        <span>
          <small>Created</small>
          {formatTimestamp(run.createdAt)}
        </span>
        <span>
          <small>Duration</small>
          {formatDuration(duration)}
        </span>
        <span>
          <small>Reserved</small>
          {run.usage.reserved} {run.usage.unit}
        </span>
        <span>
          <small>Actual</small>
          {run.usage.actual === null
            ? "pending"
            : `${run.usage.actual} ${run.usage.unit}`}
        </span>
        <span>
          <small>True-up</small>
          {run.usage.trueUp === null
            ? "pending"
            : `${
              run.usage.trueUp >= 0 ? "+" : ""
            }${run.usage.trueUp} ${run.usage.unit}`}
        </span>
        <span>
          <small>Backed by</small>
          {run.billingMode === "subscription_capacity"
            ? "Subscription capacity"
            : "Wallet hold"}
        </span>
        <span>
          <small>Exit</small>
          {run.exitCode ?? (isComputeRunActive(run.status) ? "running" : "—")}
        </span>
      </div>
      {run.infraFailure
        ? (
          <div className="neb-compute-failure" role="alert">
            <strong>{run.infraFailure.code}</strong> {run.infraFailure.message}
            {run.infraFailure.retryable ? <span>retryable</span> : null}
          </div>
        )
        : null}
      <div className="neb-compute-run-links">
        {run.receiptId
          ? receiptUrl
            ? (
              <a href={receiptUrl} rel="noreferrer" target="_blank">
                Receipt {run.receiptId}
              </a>
            )
            : <span>Receipt {run.receiptId}</span>
          : <span>Receipt pending</span>}
        {run.artifacts.map((artifact) => {
          const url = computeLinkHref(artifact.url);
          return url
            ? (
              <a href={url} key={artifact.id} rel="noreferrer" target="_blank">
                {artifact.name} · {formatBytes(artifact.sizeBytes)}{" "}
                · available until {formatTimestamp(artifact.expiresAt)}
              </a>
            )
            : (
              <span key={artifact.id}>
                {artifact.name} · {formatBytes(artifact.sizeBytes)}{" "}
                · available until {formatTimestamp(artifact.expiresAt)}
              </span>
            );
        })}
        {run.cancellable
          ? (
            <button
              className="neb-btn-sm danger"
              disabled={cancelling}
              onClick={onCancel}
              type="button"
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )
          : null}
      </div>
    </article>
  );
}
