import {
  type FormEvent,
  type ReactElement,
  useEffect,
  useState,
} from "react";

import type {
  LaunchAgentActivityItem,
  LaunchAgentActivityPreview,
  LaunchAgentCapacityResponse,
  LaunchAgentHomeResponse,
  LaunchOperatorRoutineRunDetail,
  LaunchRunEffectEvent,
} from "../../../../../shared/contracts/launch.ts";
import type { AgentStudioPane } from "../../lib/agent-studio-route";
import { launchApi } from "../../lib/api";
import { StudioPageHeader } from "./agent-studio-overview";

export function AgentStudioActivity({
  activity,
  agentLocator,
  canRunNow = false,
  loading,
  newAgent = false,
  onLoadMore,
  hasMore,
  onRunNow,
}: {
  activity: LaunchAgentActivityPreview | null;
  /** Agent id/slug for lazy run-detail fetches; detail is hidden without it. */
  agentLocator?: string;
  canRunNow?: boolean;
  hasMore: boolean;
  loading: boolean;
  newAgent?: boolean;
  onLoadMore: () => void;
  onRunNow?: () => void;
}): ReactElement {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const items = activity?.items?.length
    ? activity.items
    : [
      ...(activity?.upNext ? [activity.upNext] : []),
      ...(activity?.now ?? []),
      ...(activity?.recent ?? []),
    ];
  const visibleItems = items.filter((item) =>
    matchesActivityFilter(item, filter)
  );
  const filters: readonly { id: ActivityFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "needed_you", label: "Needed you" },
    { id: "changed", label: "Changed something" },
    { id: "failed", label: "Failed" },
  ];
  return (
    <section className="agent-studio-screen">
      <StudioPageHeader
        description="Every time this Agent woke up, what happened, and the evidence Galactic can safely show."
        title="Activity"
      />
      <div className="agent-studio-filter-row" aria-label="Activity filters">
        {filters.map(({ id, label }) => {
          const count = items.filter((item) =>
            matchesActivityFilter(item, id)
          ).length;
          return (
            <button
              aria-pressed={filter === id}
              className={filter === id ? "active" : ""}
              key={id}
              onClick={() => {
                setFilter(id);
                setExpanded(null);
              }}
              type="button"
            >
              {label} <em>{count}</em>
            </button>
          );
        })}
      </div>
      <div className="agent-studio-activity-list">
        {visibleItems.map((item) => (
          <StudioActivityRun
            agentLocator={agentLocator}
            expanded={expanded === item.id}
            item={item}
            key={item.id}
            onToggle={() =>
              setExpanded((current) => current === item.id ? null : item.id)}
          />
        ))}
        {!loading && visibleItems.length === 0
          ? (
            <div className="agent-studio-empty-state">
              <strong>
                {items.length === 0
                  ? "No activity yet."
                  : `No ${filter} activity in this page.`}
              </strong>
              <p>
                {items.length === 0
                  ? "The first scheduled or manual run will appear here."
                  : "Choose another filter or load older activity."}
              </p>
              {items.length === 0 && newAgent
                ? (
                  <>
                    <div
                      aria-hidden="true"
                      className="agent-studio-activity-ghost"
                    >
                      <span>—:—</span>
                      <span>The first run will leave a receipt here.</span>
                      <span>waiting</span>
                    </div>
                    <button
                      disabled={!canRunNow}
                      onClick={onRunNow}
                      type="button"
                    >
                      Run now
                    </button>
                  </>
                )
                : null}
            </div>
          )
          : null}
      </div>
      {hasMore
        ? (
          <button
            className="agent-studio-load-more"
            disabled={loading}
            onClick={onLoadMore}
            type="button"
          >
            {loading ? "Loading…" : "Load older activity"}
          </button>
        )
        : null}
      <div className="agent-studio-contract-note">
        Detailed function receipts, resulting changes, and deliberate
        non-actions will appear here as they become available.
      </div>
    </section>
  );
}

type ActivityFilter = "all" | "needed_you" | "changed" | "failed";

export function matchesActivityFilter(
  item: LaunchAgentActivityItem,
  filter: ActivityFilter,
): boolean {
  if (filter === "all") return true;
  const status = item.status.toLowerCase();
  if (filter === "needed_you") {
    return status.includes("held") ||
      status.includes("blocked") ||
      status.includes("approval");
  }
  if (filter === "changed") {
    return item.kind === "release";
  }
  return status.includes("fail") || status.includes("error");
}

export function AgentStudioDirective({
  home,
  onOpenPane,
}: {
  home: LaunchAgentHomeResponse;
  onOpenPane: (pane: AgentStudioPane, item?: string | null) => void;
}): ReactElement {
  const directive = home.directive;
  return (
    <section className="agent-studio-screen">
      <StudioPageHeader
        description="The responsibility this Agent carries into every managed routine."
        title="Directive"
      />
      <section className="agent-studio-directive-card">
        <div className="agent-studio-section-head">
          <span className="agent-studio-section-label">Mission</span>
          <button
            className="agent-studio-text-action"
            disabled={!home.actions.canEditRoutine}
            onClick={() =>
              onOpenPane("routines", directive?.sourceRoutineId ?? null)}
            type="button"
          >
            Edit source routine
          </button>
        </div>
        <blockquote>
          {directive?.mission ||
            home.responsibility.mission ||
            "No mission has been defined yet."}
        </blockquote>
        <dl>
          <div>
            <dt>Source</dt>
            <dd>
              {directive?.source === "primary_routine"
                ? "Primary routine"
                : "Managed routines"}
            </dd>
          </div>
          <div>
            <dt>Cadence</dt>
            <dd>{directive?.cadence?.label ?? "Event-driven or manual"}</dd>
          </div>
          <div>
            <dt>Reporting</dt>
            <dd>
              {directive?.reporting.configured
                ? directive.reporting.label
                : "Not configured"}
            </dd>
          </div>
        </dl>
      </section>
      <section className="agent-studio-policies-card">
        <div className="agent-studio-section-label">Policies</div>
        <div className="agent-studio-empty-state compact">
          <strong>Policies are not editable in Studio yet.</strong>
          <p>
            This Agent currently follows the mission and rules in its
            published routines.
          </p>
        </div>
      </section>
    </section>
  );
}

export function AgentStudioLimits({
  agentIdOrSlug,
  capacity,
  onSaved,
}: {
  agentIdOrSlug: string;
  capacity: LaunchAgentCapacityResponse | null | undefined;
  onSaved: () => void;
}): ReactElement {
  const [current, setCurrent] = useState(capacity);
  const [cap, setCap] = useState(
    capacity?.capPercent === undefined
      ? ""
      : String(capacity.capPercent),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setCurrent(capacity);
    setCap(
      capacity?.capPercent === undefined
        ? ""
        : String(capacity.capPercent),
    );
    setError("");
  }, [agentIdOrSlug, capacity?.generatedAt]);

  const weeklyUse = current?.weekly.capUsedPercent ?? null;
  const capValue = Number(cap);
  const capValid = Number.isFinite(capValue) &&
    capValue >= 0.01 &&
    capValue <= 100;
  const saveCap = async (event: FormEvent) => {
    event.preventDefault();
    if (!current || !capValid || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await launchApi.updateAgentCapacity(agentIdOrSlug, {
        capPercent: capValue,
      });
      setCurrent(next);
      setCap(String(next.capPercent ?? capValue));
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="agent-studio-screen">
      <StudioPageHeader
        description="Weekly Galactic capacity and inference billed to your own provider key."
        title="Limits"
      />
      <div className="agent-studio-limit-stack">
        <StudioLimit
          description={!current
            ? "Galactic capacity is not available for this Agent right now."
            : `Usage is shown against this Agent’s ${current.capPercent}% weekly ceiling.`}
          label="Galactic pool"
          primary={weeklyUse}
          state={current?.state ?? "unavailable"}
        />
        {current
          ? (
            <form
              className="agent-studio-limit-editor"
              onSubmit={(event) => void saveCap(event)}
            >
              <label htmlFor="agent-studio-cap">
                <span>Cap this Agent at</span>
                <span>
                  <input
                    aria-describedby={error
                      ? "agent-studio-cap-error"
                      : undefined}
                    id="agent-studio-cap"
                    max="100"
                    min="0.01"
                    onChange={(event) => setCap(event.currentTarget.value)}
                    step="0.01"
                    type="number"
                    value={cap}
                  />
                  <em>%</em>
                </span>
              </label>
              <button disabled={!capValid || busy} type="submit">
                {busy ? "Saving…" : "Save ceiling"}
              </button>
              {error
                ? (
                  <p id="agent-studio-cap-error" role="alert">
                    {error}
                  </p>
                )
                : null}
              <small>This percentage applies to the shared weekly limit.</small>
            </form>
          )
          : null}
        <StudioLimit
          description="Provider/model token events exist, but Agent Studio does not yet receive a priced per-Agent rollup or enforce a dollar ceiling."
          label="Inference, your key"
          primary={null}
          secondary={null}
          secondaryLabel="billing period"
          state="projection unavailable"
        />
      </div>
    </section>
  );
}

export function AgentStudioContractBoundary({
  body,
  description,
  details,
  eyebrow,
  heading,
  title,
}: {
  body: string;
  description: string;
  details: readonly string[];
  eyebrow: string;
  heading: string;
  title: string;
}): ReactElement {
  return (
    <section className="agent-studio-screen">
      <StudioPageHeader description={description} title={title} />
      <div className="agent-studio-boundary-card">
        <span className="agent-studio-section-label">{eyebrow}</span>
        <h2>{heading}</h2>
        <p>{body}</p>
        {details.length
          ? (
            <ul>
              {details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )
          : null}
      </div>
    </section>
  );
}

/** Activity items derived from routine runs carry a `run:{uuid}` id. */
function activityRunId(item: LaunchAgentActivityItem): string | null {
  if (typeof item.id === "string" && item.id.startsWith("run:")) {
    return item.id.slice("run:".length) || null;
  }
  return null;
}

function formatStepDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return "—";
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

/**
 * Pure renderer for one run's owner-safe step table (WO-3 thin slice):
 * ordered calls, status, duration, Light cost. Argument/result contents are
 * deliberately absent — the API's owner-safe projection never returns them.
 */
export function StudioRunSteps({
  detail,
}: {
  detail: LaunchOperatorRoutineRunDetail;
}): ReactElement {
  return (
    <div className="agent-studio-run-steps">
      <div className="agent-studio-section-label">
        What it called, in order
      </div>
      {detail.steps.length
        ? (
          <ol className="agent-studio-run-step-list">
            {detail.steps.map((step) => (
              <li data-status={step.status} key={step.id}>
                <code>
                  {step.functionName === "galactic.ai"
                    ? "ai.call"
                    : step.functionName}
                </code>
                <em>{step.status}</em>
                <span>{formatStepDuration(step.durationMs)}</span>
                <small>{step.usage > 0 ? `Usage ${step.usage}` : ""}</small>
                {step.diagnostic
                  ? (
                    <p className="agent-studio-run-step-error">
                      {step.diagnostic.summary}
                    </p>
                  )
                  : null}
              </li>
            ))}
          </ol>
        )
        : <p>No function calls were recorded for this run.</p>}
      <StudioRunEffects effects={detail.effects ?? []} />
      <p className="agent-studio-run-steps-footer">
        {detail.run.summary ? `${detail.run.summary} · ` : ""}
        Usage {detail.run.usage}
        {detail.logReceipts.length > 0
          ? ` · ${detail.logReceipts.length} log receipt${
            detail.logReceipts.length === 1 ? "" : "s"
          }`
          : ""}
      </p>
    </div>
  );
}

/** Pillar P0: the run's witnessed effect stream, grouped by honesty grade.
 * Attested/observed = the platform's own account of what changed in the
 * world; non_action = what it deliberately did not do; app_claimed =
 * evidence the app attached (labeled as its own account). */
export function StudioRunEffects({
  effects,
}: {
  effects: LaunchRunEffectEvent[];
}): ReactElement | null {
  if (!effects || effects.length === 0) return null;
  const changed = effects.filter(
    (e) =>
      (e.attestation === "attested" || e.attestation === "observed") &&
      e.kind !== "non_action" &&
      !e.kind.startsWith("function_"),
  );
  const nonActions = effects.filter((e) => e.kind === "non_action");
  const claimed = effects.filter((e) => e.attestation === "app_claimed");
  return (
    <div className="agent-studio-run-effects">
      {changed.length > 0
        ? (
          <>
            <div className="agent-studio-section-label">
              What changed in the world
            </div>
            <ul>
              {changed.map((event) => (
                <li key={`${event.executionId}:${event.seq}`}>
                  <code>{event.channel ?? event.kind}</code>
                  <span>{event.outcome ?? event.kind}</span>
                  <em data-attestation={event.attestation}>
                    {event.attestation}
                  </em>
                </li>
              ))}
            </ul>
          </>
        )
        : null}
      {nonActions.length > 0
        ? (
          <>
            <div className="agent-studio-section-label">
              What it decided not to do
            </div>
            <ul>
              {nonActions.map((event) => (
                <li key={`${event.executionId}:${event.seq}`}>
                  <span>{event.outcome ?? "no action"}</span>
                </li>
              ))}
            </ul>
          </>
        )
        : null}
      {claimed.length > 0
        ? (
          <>
            <div className="agent-studio-section-label">
              Evidence (the agent's own account)
            </div>
            <ul>
              {claimed.map((event) => (
                <li key={`${event.executionId}:${event.seq}`}>
                  <span>{event.outcome ?? "evidence"}</span>
                  {event.targetDigest
                    ? <small>{event.targetDigest}</small>
                    : null}
                </li>
              ))}
            </ul>
          </>
        )
        : null}
    </div>
  );
}

/** Lazy fetch wrapper: loads the owner-safe run detail when first expanded.
 * `fetchRunDetail` is a DI seam for tests; production uses launchApi. */
export function StudioRunStepsDetail({
  agentLocator,
  fetchRunDetail,
  runId,
}: {
  agentLocator: string;
  fetchRunDetail?: (
    agentLocator: string,
    runId: string,
  ) => Promise<LaunchOperatorRoutineRunDetail>;
  runId: string;
}): ReactElement {
  const [detail, setDetail] = useState<LaunchOperatorRoutineRunDetail | null>(
    null,
  );
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const fetcher = fetchRunDetail ??
      ((locator: string, id: string) =>
        launchApi.operatorRoutineRun(locator, id));
    fetcher(agentLocator, runId).then(
      (loaded) => {
        if (!cancelled) setDetail(loaded);
      },
      (reason) => {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Run detail is unavailable right now.",
          );
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentLocator, runId, fetchRunDetail]);
  if (error) {
    return <p className="agent-studio-run-steps-error">{error}</p>;
  }
  if (!detail) {
    return <p className="agent-studio-run-steps-loading">Loading steps…</p>;
  }
  return <StudioRunSteps detail={detail} />;
}

function StudioActivityRun({
  agentLocator,
  expanded,
  item,
  onToggle,
}: {
  agentLocator?: string;
  expanded: boolean;
  item: LaunchAgentActivityItem;
  onToggle: () => void;
}): ReactElement {
  const occurredAt = item.occurredAt ?? item.scheduledAt;
  const runId = activityRunId(item);
  return (
    <article className={`agent-studio-activity-run${expanded ? " open" : ""}`}>
      <button
        aria-expanded={expanded}
        className="agent-studio-activity-run-summary"
        onClick={onToggle}
        type="button"
      >
        <time dateTime={occurredAt ?? undefined}>{formatDateTime(occurredAt)}</time>
        <span>
          <strong>{item.title}</strong>
          <small>{item.summary ?? item.kind.replaceAll("_", " ")}</small>
        </span>
        <em>{item.status}</em>
        <i aria-hidden="true">{expanded ? "−" : "+"}</i>
      </button>
      {expanded
        ? (
          <div className="agent-studio-activity-run-detail">
            {runId && agentLocator
              ? (
                <StudioRunStepsDetail
                  agentLocator={agentLocator}
                  runId={runId}
                />
              )
              : null}
            <div className="agent-studio-section-label">
              Owner-safe evidence
            </div>
            {item.evidence.length
              ? (
                <ol>
                  {item.evidence.map((evidence) => (
                    <li key={`${evidence.kind}:${evidence.sourceId}`}>
                      <span>{evidence.kind.replaceAll("_", " ")}</span>
                      <strong>{evidence.label}</strong>
                      <time dateTime={evidence.observedAt ?? undefined}>
                        {formatDateTime(evidence.observedAt)}
                      </time>
                    </li>
                  ))}
                </ol>
              )
              : (
                <p>
                  No additional owner-safe evidence was attached to this item.
                </p>
              )}
          </div>
        )
        : null}
    </article>
  );
}

function StudioLimit({
  description,
  label,
  primary,
  secondary,
  secondaryLabel,
  state,
}: {
  description: string;
  label: string;
  primary: number | null;
  secondary?: number | null;
  secondaryLabel?: string;
  state: string;
}): ReactElement {
  return (
    <article className="agent-studio-limit-card">
      <header>
        <span className="agent-studio-section-label">{label}</span>
        <strong>{primary === null ? "—" : `${Math.round(primary)}%`}</strong>
      </header>
      <div className="agent-studio-limit-track">
        <span style={{ width: `${Math.max(0, Math.min(100, primary ?? 0))}%` }} />
      </div>
      <div className="agent-studio-limit-meta">
        <span>{state}</span>
        {secondaryLabel
          ? (
            <span>
              {secondary === null || secondary === undefined
                ? `No ${secondaryLabel} projection`
                : `${Math.round(secondary)}% ${secondaryLabel}`}
            </span>
          )
          : null}
      </div>
      <p>{description}</p>
    </article>
  );
}

function formatDateTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not timestamped";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
