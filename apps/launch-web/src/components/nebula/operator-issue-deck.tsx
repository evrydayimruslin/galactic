import {
  type FormEvent,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  LaunchAgentHomeResponse,
  LaunchByokProviderOption,
  LaunchOperatorAttentionAction,
  LaunchOperatorAttentionEntry,
  LaunchOperatorAttentionProjection,
  LaunchOperatorRemediation,
  LaunchOperatorRoutineRunDetail,
} from "../../../../../shared/contracts/launch.ts";
import {
  operatorAttentionAgentMap,
  operatorAttentionEntryMatches,
  operatorRemediationHref,
  type OperatorAttentionAgent,
  resolveOperatorAttentionEntry,
} from "../../lib/operator-attention";
import { launchApi, LaunchApiRequestError } from "../../lib/api";
import type { LaunchNavigate } from "../../lib/navigation";
import { Glyph } from "./glyph";

const SNOOZE_DURATION_MS = 60 * 60 * 1_000;

export interface OperatorIssueDeckProps {
  projection: LaunchOperatorAttentionProjection;
  compact?: boolean;
  itemId?: string | null;
  onChanged?: () => Promise<void> | void;
  onClearItem?: () => void;
  onCountChange?: (count: number) => void;
  onNavigate: LaunchNavigate;
  query?: string;
  showAffectedAgents?: boolean;
}

interface RemediationProps {
  agents: ReadonlyMap<string, OperatorAttentionAgent>;
  itemId: string;
  onChanged?: () => Promise<void> | void;
  onNavigate: LaunchNavigate;
  remediation: LaunchOperatorRemediation;
}

function readableTime(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function issueKind(entry: LaunchOperatorAttentionEntry): string {
  const code = entry.item.diagnosis.code;
  if (code.startsWith("AGENT_") || code === "ACCOUNT_BYOK_MISSING") {
    return "Setup required";
  }
  if (code.endsWith("USAGE_EXHAUSTED")) return "Usage";
  return entry.item.itemClass === "report" ? "Report" : "Incident";
}

function agentForTarget(
  remediation: LaunchOperatorRemediation,
  agents: ReadonlyMap<string, OperatorAttentionAgent>,
): OperatorAttentionAgent | null {
  const target = remediation.target;
  return "agentId" in target ? agents.get(target.agentId) ?? null : null;
}

async function finishRemediation(
  onChanged: (() => Promise<void> | void) | undefined,
): Promise<void> {
  await onChanged?.();
}

function InlineProviderRemediation({
  onChanged,
  remediation,
}: RemediationProps): ReactElement {
  const target = remediation.target.kind === "account_provider"
    ? remediation.target
    : null;
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<LaunchByokProviderOption[]>([]);
  const [providerId, setProviderId] = useState(target?.provider ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const expand = async () => {
    if (open) {
      setOpen(false);
      setApiKey("");
      return;
    }
    setOpen(true);
    setSaved(false);
    if (providers.length > 0) return;
    setLoading(true);
    setError("");
    try {
      const response = await launchApi.byok();
      setProviders(response.providers);
      const preferred = target?.provider
        ? response.providers.find(({ id }) => id === target.provider)
        : response.providers.find(({ configured }) => !configured) ??
          response.providers[0];
      if (preferred) {
        setProviderId(preferred.id);
        setModel(preferred.model ?? preferred.defaultModel ?? "");
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Inference providers could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  };

  const selected = providers.find(({ id }) => id === providerId) ?? null;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!providerId || !apiKey.trim() || busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await launchApi.upsertByokProvider(providerId, {
        apiKey: apiKey.trim(),
        model: model.trim() || undefined,
        validate: true,
      });
      setApiKey("");
      setSaved(true);
      await finishRemediation(onChanged);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The provider could not be configured.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="neb-operator-remediation-inline">
      <button
        className="neb-btn-sm primary"
        onClick={() => void expand()}
        type="button"
      >
        {remediation.label}
      </button>
      {open
        ? (
          <form className="neb-operator-inline-form" onSubmit={save}>
            {loading
              ? <span className="neb-ov-note">Loading providers…</span>
              : providers.length === 0
              ? (
                <span className="neb-error-note">
                  No supported inference providers are available.
                </span>
              )
              : (
                <>
                  <label>
                    Provider
                    <select
                      className="neb-edit-input"
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        setProviderId(next);
                        const option = providers.find(({ id }) => id === next);
                        setModel(option?.model ?? option?.defaultModel ?? "");
                      }}
                      value={providerId}
                    >
                      {providers.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    API key
                    <input
                      autoComplete="off"
                      className="neb-edit-input"
                      onChange={(event) => setApiKey(event.currentTarget.value)}
                      placeholder={selected
                        ? `${selected.name} API key`
                        : "Provider API key"}
                      type="password"
                      value={apiKey}
                    />
                  </label>
                  <label>
                    Model
                    <input
                      className="neb-edit-input"
                      onChange={(event) => setModel(event.currentTarget.value)}
                      placeholder={selected?.defaultModel ?? "Default model"}
                      value={model}
                    />
                  </label>
                  <button
                    className="neb-btn-sm primary"
                    disabled={busy || !providerId || !apiKey.trim()}
                    type="submit"
                  >
                    {busy ? "Validating…" : "Save and recheck"}
                  </button>
                </>
              )}
            <span className="neb-operator-write-only">
              The key is write-only and is cleared from this form after saving.
            </span>
            {saved
              ? <span className="neb-success-note">Provider configured.</span>
              : null}
            {error ? <span className="neb-error-note">{error}</span> : null}
          </form>
        )
        : null}
    </div>
  );
}

function findSettingRequirement(
  home: LaunchAgentHomeResponse,
  remediation: LaunchOperatorRemediation,
) {
  const target = remediation.target;
  if (target.kind !== "agent_setting") return null;
  return home.setup.requirements.find((requirement) =>
    requirement.kind === "setting" &&
    requirement.settingKey === target.settingKey &&
    requirement.settingScope === target.settingScope
  ) ?? null;
}

function InlineSettingRemediation({
  agents,
  onChanged,
  remediation,
}: RemediationProps): ReactElement {
  const target = remediation.target.kind === "agent_setting"
    ? remediation.target
    : null;
  const agent = agentForTarget(remediation, agents);
  const [open, setOpen] = useState(false);
  const [home, setHome] = useState<LaunchAgentHomeResponse | null>(null);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const expand = async () => {
    if (open) {
      setOpen(false);
      setValue("");
      return;
    }
    setOpen(true);
    setSaved(false);
    if (!agent || home) return;
    setLoading(true);
    setError("");
    try {
      setHome(await launchApi.agentHome(agent.slug));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The setting definition could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  };
  const requirement = home && target
    ? findSettingRequirement(home, remediation)
    : null;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!agent || !home || !target || !requirement || !value || busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const next = await launchApi.updateAgentHomeSettings(agent.slug, {
        expectedRevision: home.revision,
        values: { [target.settingKey]: value },
      });
      setValue("");
      setHome(next);
      setSaved(true);
      await finishRemediation(onChanged);
    } catch (reason) {
      setValue("");
      setError(
        reason instanceof Error
          ? reason.message
          : "The setting could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="neb-operator-remediation-inline">
      <button
        className="neb-btn-sm primary"
        disabled={!agent}
        onClick={() => void expand()}
        type="button"
      >
        {remediation.label}
      </button>
      {open
        ? (
          <form className="neb-operator-inline-form" onSubmit={save}>
            {loading
              ? <span className="neb-ov-note">Loading setting…</span>
              : requirement
              ? (
                <>
                  <label>
                    {requirement.label}
                    <input
                      autoComplete="off"
                      className="neb-edit-input"
                      onChange={(event) => setValue(event.currentTarget.value)}
                      placeholder={requirement.placeholder ?? undefined}
                      type={requirement.secret ? "password" : "text"}
                      value={value}
                    />
                  </label>
                  {requirement.description || requirement.help
                    ? (
                      <span className="neb-ov-note">
                        {requirement.description ?? requirement.help}
                      </span>
                    )
                    : null}
                  <button
                    className="neb-btn-sm primary"
                    disabled={busy || !value}
                    type="submit"
                  >
                    {busy ? "Saving…" : "Save and recheck"}
                  </button>
                </>
              )
              : (
                <span className="neb-error-note">
                  This setting is no longer required by the live Agent.
                </span>
              )}
            <span className="neb-operator-write-only">
              Existing values are never returned. This form clears the value
              after every submission.
            </span>
            {saved
              ? <span className="neb-success-note">Setting configured.</span>
              : null}
            {error ? <span className="neb-error-note">{error}</span> : null}
          </form>
        )
        : null}
    </div>
  );
}

function InlineApprovalRemediation({
  agents,
  onChanged,
  remediation,
}: RemediationProps): ReactElement {
  const agent = agentForTarget(remediation, agents);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const approve = async () => {
    if (
      !agent ||
      remediation.target.kind !== "agent_access_item" ||
      busy
    ) return;
    setBusy(true);
    setError("");
    try {
      if (remediation.key === "approve_grant") {
        const grantId = remediation.target.itemId.startsWith("grant:")
          ? remediation.target.itemId.slice("grant:".length)
          : "";
        if (!grantId) throw new Error("The grant is no longer available.");
        await launchApi.approveGrant(grantId);
        await launchApi.agentHome(agent.slug);
      } else if (remediation.key === "approve_capability") {
        const capabilityId = remediation.target.itemId.startsWith(
            "capability:",
          )
          ? remediation.target.itemId.slice("capability:".length)
          : "";
        const home = await launchApi.agentHome(agent.slug);
        const requirement = home.setup.requirements.find((item) =>
          item.kind === "capability" &&
          item.actionId === capabilityId &&
          item.actions.includes("approve")
        );
        if (!requirement) {
          throw new Error("The capability is no longer awaiting approval.");
        }
        await launchApi.actOnAgentHome(agent.slug, {
          action: "approve_capabilities",
          capabilityIds: [capabilityId],
          expectedRevision: home.revision,
          idempotencyKey: crypto.randomUUID(),
        });
      } else {
        throw new Error("This approval is not supported here.");
      }
      setConfirming(false);
      await finishRemediation(onChanged);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The approval could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="neb-operator-remediation-inline">
      {!confirming
        ? (
          <button
            className="neb-btn-sm primary"
            disabled={!agent}
            onClick={() => setConfirming(true)}
            type="button"
          >
            {remediation.label}
          </button>
        )
        : (
          <div className="neb-operator-inline-confirm" role="group">
            <span>
              {remediation.description ??
                "Approve only the bounded access described by this card."}
            </span>
            <button
              className="neb-btn-sm primary"
              disabled={busy}
              onClick={() => void approve()}
              type="button"
            >
              {busy ? "Approving…" : "Confirm approval"}
            </button>
            <button
              className="neb-btn-sm secondary"
              disabled={busy}
              onClick={() => setConfirming(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        )}
      {error ? <span className="neb-error-note">{error}</span> : null}
    </div>
  );
}

const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);

export function runOnceFailureMessage(
  detail: LaunchOperatorRoutineRunDetail,
): string {
  const safeDetail = detail.diagnostic?.summary?.trim() ||
    detail.run.summary?.trim();
  if (safeDetail) return safeDetail;
  if (detail.run.status === "cancelled") {
    return "The verification run was cancelled.";
  }
  if (detail.run.status === "skipped") {
    return "The verification run did not start because its conditions changed.";
  }
  return "The verification run failed. Review the failed run for diagnostics.";
}

function waitForRunPoll(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 1_500));
}

function RunOnceRemediation({
  agents,
  itemId,
  onChanged,
  onNavigate,
  remediation,
}: RemediationProps): ReactElement {
  const agent = agentForTarget(remediation, agents);
  const [confirming, setConfirming] = useState(false);
  const [phase, setPhase] = useState<
    "idle" | "queueing" | "running" | "succeeded" | "failed" | "resuming"
  >("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [routineStatus, setRoutineStatus] = useState<string | null>(null);
  const [error, setError] = useState("");
  const idempotencyKey = useRef<string | null>(null);
  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);

  const inspectHref = agent && runId
    ? `/agents/${encodeURIComponent(agent.slug)}?pane=routines&item=${
      encodeURIComponent(`run:${runId}`)
    }`
    : null;

  const monitor = async (nextRunId: string) => {
    if (!agent) return;
    setPhase("running");
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const detail = await launchApi.operatorRoutineRun(
        agent.slug,
        nextRunId,
      );
      if (disposed.current) return;
      if (
        detail.agent.id !== agent.id ||
        remediation.target.kind !== "routine" ||
        detail.routine.id !== remediation.target.routineId ||
        detail.run.id !== nextRunId
      ) {
        throw new Error("The run status did not match this remediation.");
      }
      setRunStatus(detail.run.status);
      setRoutineStatus(detail.routine.status);
      if (TERMINAL_RUN_STATUSES.has(detail.run.status)) {
        if (detail.run.status === "succeeded") {
          setError("");
          setPhase("succeeded");
        } else {
          setError(runOnceFailureMessage(detail));
          setPhase("failed");
        }
        return;
      }
      await waitForRunPoll();
      if (disposed.current) return;
    }
    setPhase("failed");
    setError("The run is still in progress. Open it to continue monitoring.");
  };

  const runOnce = async () => {
    if (
      !agent ||
      remediation.key !== "run_once" ||
      remediation.target.kind !== "routine" ||
      phase === "queueing" ||
      phase === "running"
    ) return;
    setPhase("queueing");
    setError("");
    let actionMayHaveQueued = false;
    try {
      if (runId) {
        await monitor(runId);
        return;
      }
      const home = await launchApi.agentHome(agent.slug);
      idempotencyKey.current ??= crypto.randomUUID();
      const queued = await launchApi.executeOperatorItemRemediation(itemId, {
        remediationId: remediation.id,
        expectedRevision: home.revision,
        idempotencyKey: idempotencyKey.current,
      });
      actionMayHaveQueued = true;
      if (
        queued.itemId !== itemId ||
        queued.remediationId !== remediation.id ||
        queued.action !== "run_once" ||
        queued.scheduleState !== "paused"
      ) {
        throw new Error("The remediation returned an unexpected run.");
      }
      setConfirming(false);
      setRunId(queued.runId);
      setRunStatus("queued");
      await monitor(queued.runId);
    } catch (reason) {
      if (
        !runId && !actionMayHaveQueued &&
        !(reason instanceof LaunchApiRequestError &&
          reason.code === "STATUS_UNKNOWN")
      ) {
        idempotencyKey.current = null;
      }
      setPhase("failed");
      setError(
        reason instanceof Error
          ? reason.message
          : "The verification run could not be completed.",
      );
    }
  };

  const resume = async () => {
    if (!agent || phase !== "succeeded" || routineStatus !== "paused") return;
    setPhase("resuming");
    setError("");
    try {
      const home = await launchApi.agentHome(agent.slug);
      await launchApi.actOnAgentHome(agent.slug, {
        action: "activate",
        expectedRevision: home.revision,
        idempotencyKey: crypto.randomUUID(),
      });
      await finishRemediation(onChanged);
    } catch (reason) {
      setPhase("succeeded");
      setError(
        reason instanceof Error
          ? reason.message
          : "Scheduled runs could not be resumed.",
      );
    }
  };

  const prepareAnotherRun = () => {
    idempotencyKey.current = null;
    setRunId(null);
    setRunStatus(null);
    setRoutineStatus(null);
    setError("");
    setPhase("idle");
    setConfirming(true);
  };

  return (
    <div className="neb-operator-remediation-inline">
      {phase === "idle" && !confirming
        ? (
          <button
            className="neb-btn-sm primary"
            disabled={!agent}
            onClick={() => setConfirming(true)}
            type="button"
          >
            {remediation.label}
          </button>
        )
        : null}
      {confirming && phase === "idle"
        ? (
          <div className="neb-operator-inline-confirm" role="group">
            <span>
              This performs a real routine run. It can use usage and create
              external side effects. Scheduled runs stay paused.
            </span>
            <button
              className="neb-btn-sm primary"
              onClick={() => void runOnce()}
              type="button"
            >
              Run once
            </button>
            <button
              className="neb-btn-sm secondary"
              onClick={() => setConfirming(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        )
        : null}
      {phase === "queueing" || phase === "running"
        ? (
          <span className="neb-ov-note" role="status">
            {phase === "queueing" ? "Queueing run…" : "Running once…"}{" "}
            Scheduled runs remain paused.
          </span>
        )
        : null}
      {phase === "succeeded" || phase === "resuming"
        ? (
          <div className="neb-operator-inline-confirm" role="group">
            <span className="neb-success-note">
              {routineStatus === "paused"
                ? "Run succeeded. Scheduled runs are still paused."
                : routineStatus === "active"
                ? "Run succeeded. Scheduled runs are already active."
                : `Run succeeded. The routine is ${routineStatus ?? "not active"}.`}
            </span>
            {routineStatus === "paused"
              ? (
                <button
                  className="neb-btn-sm primary"
                  disabled={phase === "resuming"}
                  onClick={() => void resume()}
                  type="button"
                >
                  {phase === "resuming"
                    ? "Resuming…"
                    : "Resume scheduled runs"}
                </button>
              )
              : null}
            {inspectHref
              ? (
                <a
                  className="neb-btn-sm secondary"
                  href={inspectHref}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(inspectHref, { scroll: "preserve" });
                  }}
                >
                  View run
                </a>
              )
              : null}
          </div>
        )
        : null}
      {phase === "failed" && inspectHref
        ? (
          <a
            className="neb-btn-sm secondary"
            href={inspectHref}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(inspectHref, { scroll: "preserve" });
            }}
          >
            View this failed run
          </a>
        )
        : null}
      {phase === "failed"
        ? (
          <button
            className="neb-btn-sm secondary"
            onClick={() => {
              if (runStatus && TERMINAL_RUN_STATUSES.has(runStatus)) {
                prepareAnotherRun();
              } else {
                void runOnce();
              }
            }}
            type="button"
          >
            {runStatus && TERMINAL_RUN_STATUSES.has(runStatus)
              ? "Run again"
              : runId
              ? "Check run status"
              : "Try again"}
          </button>
        )
        : null}
      {error
        ? <span className="neb-error-note" role="alert">{error}</span>
        : null}
    </div>
  );
}

function RemediationControl(props: RemediationProps): ReactElement | null {
  const { agents, onNavigate, remediation } = props;
  if (remediation.key === "configure_provider") {
    return <InlineProviderRemediation {...props} />;
  }
  if (
    remediation.key === "configure_secret" ||
    remediation.key === "configure_setting"
  ) {
    return <InlineSettingRemediation {...props} />;
  }
  if (
    remediation.key === "approve_capability" ||
    remediation.key === "approve_grant"
  ) {
    return <InlineApprovalRemediation {...props} />;
  }
  if (remediation.key === "run_once") {
    return <RunOnceRemediation {...props} />;
  }
  const href = operatorRemediationHref(remediation, agents);
  if (!href || remediation.presentation === "execute") return null;
  return (
    <a
      className={`neb-btn-sm ${
        remediation.presentation === "navigate" ? "secondary" : "primary"
      }`}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(href, { scroll: "preserve" });
      }}
    >
      {remediation.label}
    </a>
  );
}

function OperatorIssueCard({
  agents,
  compact,
  deepLinked,
  entry,
  onAttentionAction,
  onChanged,
  onNavigate,
  read,
  showAffectedAgents,
  targetRef,
}: {
  agents: ReadonlyMap<string, OperatorAttentionAgent>;
  compact: boolean;
  deepLinked: boolean;
  entry: LaunchOperatorAttentionEntry;
  onAttentionAction: (
    entry: LaunchOperatorAttentionEntry,
    action: LaunchOperatorAttentionAction,
  ) => Promise<void>;
  onChanged?: () => Promise<void> | void;
  onNavigate: LaunchNavigate;
  read: boolean;
  showAffectedAgents: boolean;
  targetRef: { current: HTMLElement | null };
}): ReactElement {
  const item = entry.item;
  const diagnosisSource = item.diagnosis.provenance === "developer"
    ? "Developer-provided diagnosis"
    : item.diagnosis.provenance === "provider"
    ? "Provider diagnosis"
    : item.diagnosis.provenance === "combined"
    ? "Platform condition · External diagnosis"
    : item.diagnosis.provenance === "unknown"
    ? "Cause not verified"
    : null;
  const detectedAt = readableTime(item.detectedAt);
  const affected = item.affectedAgents.flatMap(({ agentId, blocking }) => {
    const agent = agents.get(agentId);
    return agent ? [{ ...agent, blocking }] : [];
  });
  const blockingCount = affected.filter(({ blocking }) => blocking).length;
  const [busy, setBusy] = useState<LaunchOperatorAttentionAction | null>(null);
  const [error, setError] = useState("");
  const act = async (action: LaunchOperatorAttentionAction) => {
    setBusy(action);
    setError("");
    try {
      await onAttentionAction(entry, action);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The Attention state could not be updated.",
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <article
      aria-label={`${issueKind(entry)}: ${item.diagnosis.summary}`}
      className={[
        "neb-operator-issue-card",
        item.itemClass,
        item.severity,
        read ? "read" : "unread",
        compact ? "compact" : "",
        deepLinked ? "neb-deep-link-target" : "",
      ].filter(Boolean).join(" ")}
      id={`operator-item-${item.id}`}
      ref={deepLinked ? targetRef : undefined}
      tabIndex={deepLinked ? -1 : undefined}
    >
      <header className="neb-operator-issue-head">
        <span className={`neb-operator-issue-kind ${item.itemClass}`}>
          <Glyph name={item.itemClass === "issue" ? "alert" : "spark"} />
          {issueKind(entry)}
        </span>
        <span className="neb-agent-attention-meta">
          {blockingCount > 0
            ? `${blockingCount} blocked`
            : item.requiresDecision
            ? "Decision needed"
            : "Open"}
          {detectedAt ? <time dateTime={item.detectedAt}>{detectedAt}</time> : null}
        </span>
      </header>
      <div className="neb-operator-issue-copy">
        <h3>{item.diagnosis.summary}</h3>
        {item.diagnosis.detail ? <p>{item.diagnosis.detail}</p> : null}
        {diagnosisSource
          ? (
            <div className="neb-operator-diagnostic-source">
              {diagnosisSource}
            </div>
          )
          : null}
        {item.diagnosis.causeCode
          ? (
            <div className="neb-operator-diagnostic-code">
              <span>Diagnostic</span>
              <code>{item.diagnosis.causeCode}</code>
            </div>
          )
          : null}
      </div>
      {showAffectedAgents && affected.length > 0
        ? (
          <div className="neb-operator-affected">
            <span>Affects</span>
            <div>
              {affected.map((agent) => (
                <a
                  href={`/agents/${encodeURIComponent(agent.slug)}?pane=alerts&item=${
                    encodeURIComponent(item.id)
                  }`}
                  key={agent.id}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(
                      `/agents/${encodeURIComponent(agent.slug)}?pane=alerts&item=${
                        encodeURIComponent(item.id)
                      }`,
                      { scroll: "preserve" },
                    );
                  }}
                >
                  {agent.name}{agent.blocking ? " · blocked" : ""}
                </a>
              ))}
            </div>
          </div>
        )
        : null}
      {!compact && item.diagnosis.evidence.length > 0
        ? (
          <div className="neb-agent-attention-evidence">
            <span>Evidence</span>
            <div>
              {item.diagnosis.evidence.map((evidence) => (
                <span key={`${evidence.kind}:${evidence.sourceId}`}>
                  {evidence.label}
                  {readableTime(evidence.observedAt)
                    ? ` · ${readableTime(evidence.observedAt)}`
                    : ""}
                </span>
              ))}
            </div>
          </div>
        )
        : null}
      <footer className="neb-operator-issue-actions">
        <div className="neb-operator-remediations">
          {item.remediations.map((remediation) => (
            <RemediationControl
              agents={agents}
              itemId={item.id}
              key={remediation.id}
              onChanged={onChanged}
              onNavigate={onNavigate}
              remediation={remediation}
            />
          ))}
        </div>
        {!compact
          ? (
            <div className="neb-operator-presentation-actions">
              {!read
                ? (
                  <button
                    aria-label="Mark resolved; hide this card without claiming the underlying condition is fixed"
                    className="neb-btn-sm secondary"
                    disabled={busy !== null}
                    onClick={() => void act("mark_read")}
                    type="button"
                  >
                    {busy === "mark_read" ? "Updating…" : "Mark read"}
                  </button>
                )
                : null}
              <button
                className="neb-btn-sm secondary"
                disabled={busy !== null}
                onClick={() => void act("snooze")}
                type="button"
              >
                {busy === "snooze" ? "Snoozing…" : "Snooze 1h"}
              </button>
              {item.itemClass === "issue"
                ? (
                  <button
                    className="neb-btn-sm secondary"
                    disabled={busy !== null}
                    onClick={() => void act("dismiss")}
                    title="Hide this card without claiming the underlying condition is fixed."
                    type="button"
                  >
                    {busy === "dismiss" ? "Updating…" : "Mark resolved"}
                  </button>
                )
                : null}
            </div>
          )
          : null}
      </footer>
      {error ? <p className="neb-error-note" role="alert">{error}</p> : null}
    </article>
  );
}

export function OperatorIssueDeck({
  compact = false,
  itemId,
  onChanged,
  onClearItem,
  onCountChange,
  onNavigate,
  projection,
  query = "",
  showAffectedAgents = false,
}: OperatorIssueDeckProps): ReactElement {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set());
  const targetRef = useRef<HTMLElement | null>(null);
  const agents = useMemo(
    () => operatorAttentionAgentMap(projection),
    [projection],
  );
  useEffect(() => {
    setHiddenIds((current) => {
      const available = new Set(projection.items.map(({ item }) => item.id));
      return new Set([...current].filter((id) => available.has(id)));
    });
  }, [projection.items]);
  const entries = projection.items.filter(({ item }) => !hiddenIds.has(item.id));
  const deepLinked = resolveOperatorAttentionEntry(entries, itemId);
  useEffect(() => {
    if (!deepLinked || !targetRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      targetRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      targetRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [deepLinked?.item.id]);
  const visible = entries.filter((entry) =>
    operatorAttentionEntryMatches(entry, query, agents)
  );
  const staleDeepLink = Boolean(
    itemId?.trim() && !deepLinked && !projection.nextCursor,
  );
  const exactCount = Math.max(0, projection.openCount - hiddenIds.size);
  useEffect(() => onCountChange?.(exactCount), [exactCount, onCountChange]);

  const act = async (
    entry: LaunchOperatorAttentionEntry,
    action: LaunchOperatorAttentionAction,
  ) => {
    const response = await launchApi.actOnOperatorItemAttention(entry.item.id, {
      action,
      ...(action === "snooze"
        ? {
          snoozedUntil: new Date(
            Date.now() + SNOOZE_DURATION_MS,
          ).toISOString(),
        }
        : {}),
    });
    if (response.itemId !== entry.item.id) {
      throw new Error("The Attention action returned the wrong item.");
    }
    if (action === "mark_read") {
      setReadIds((current) => new Set(current).add(entry.item.id));
    } else if (
      response.attention.state === "snoozed" ||
      response.attention.state === "dismissed"
    ) {
      setHiddenIds((current) => new Set(current).add(entry.item.id));
    }
    await onChanged?.();
  };

  return (
    <div className={`neb-operator-issue-deck${compact ? " compact" : ""}`}>
      {staleDeepLink
        ? (
          <div className="neb-agent-attention-stale">
            <Glyph name="alert" />
            <strong>This item is no longer active.</strong>
            <span>
              It may have recovered, been dismissed, or belonged to an earlier
              issue episode.
            </span>
            {onClearItem
              ? (
                <button
                  className="neb-btn-sm secondary"
                  onClick={onClearItem}
                  type="button"
                >
                  Return to Attention
                </button>
              )
              : null}
          </div>
        )
        : visible.map((entry) => (
        <OperatorIssueCard
          agents={agents}
          compact={compact}
          deepLinked={deepLinked?.item.id === entry.item.id}
          entry={entry}
          key={entry.item.id}
          onAttentionAction={act}
          onChanged={onChanged}
          onNavigate={onNavigate}
          read={Boolean(entry.attention.readAt) || readIds.has(entry.item.id)}
          showAffectedAgents={showAffectedAgents}
          targetRef={targetRef}
        />
        ))}
      {!staleDeepLink && visible.length === 0
        ? (
          <div className="neb-agent-attention-empty">
            <Glyph name="check" />
            <strong>
              {query.trim()
                ? "No attention items match."
                : "Nothing needs your attention."}
            </strong>
          </div>
        )
        : null}
    </div>
  );
}
