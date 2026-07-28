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
} from "../../../../../shared/contracts/launch.ts";
import type { AgentStudioPane } from "../../lib/agent-studio-route";
import { launchApi } from "../../lib/api";
import { StudioPageHeader } from "./agent-studio-overview";

export function AgentStudioActivity({
  activity,
  canRunNow = false,
  loading,
  newAgent = false,
  onLoadMore,
  hasMore,
  onRunNow,
}: {
  activity: LaunchAgentActivityPreview | null;
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
    capacity?.capPercent === null || capacity?.capPercent === undefined
      ? ""
      : String(capacity.capPercent),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setCurrent(capacity);
    setCap(
      capacity?.capPercent === null || capacity?.capPercent === undefined
        ? ""
        : String(capacity.capPercent),
    );
    setError("");
  }, [agentIdOrSlug, capacity?.generatedAt]);

  const hasAgentCeiling = Boolean(current && current.capPercent !== null);
  const burstUse = hasAgentCeiling
    ? current?.burst.capUsedPercent ?? null
    : current?.burst.shareUsedPercent ?? null;
  const weeklyUse = hasAgentCeiling
    ? current?.weekly.capUsedPercent ?? null
    : current?.weekly.shareUsedPercent ?? null;
  const capValue = Number(cap);
  const capValid = Number.isFinite(capValue) &&
    capValue >= 0.01 &&
    capValue <= 100;
  const saveCap = async (event: FormEvent) => {
    event.preventDefault();
    if (!current || current.capPercent === null || !capValid || busy) return;
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
        description="Two independent ceilings: Galactic capacity and inference billed to your own provider key."
        title="Limits"
      />
      <div className="agent-studio-limit-stack">
        <StudioLimit
          description={!current
            ? "Galactic capacity is not available for this Agent right now."
            : current.capPercent === null
            ? "Usage is shown as this Agent’s share of the account pool; this plan has no owner-set Agent ceiling."
            : `Usage is shown against this Agent’s ${current.capPercent}% ceiling in each shared window.`}
          label="Galactic pool"
          primary={burstUse}
          secondary={weeklyUse}
          secondaryLabel="weekly"
          state={current?.state ?? "unavailable"}
        />
        {current?.capPercent !== null && current
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
              <small>
                The same percentage applies to both Galactic capacity windows.
              </small>
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

export function AgentStudioCapabilitiesIntro(): ReactElement {
  return (
    <div className="agent-studio-capabilities-intro">
      <strong>Autonomous controls are not available for this Agent.</strong>
      <p>
        The published functions below manage which connected Agents may call
        this Agent. They do not grant this Agent permission to act during its
        own wakes.
      </p>
    </div>
  );
}

function StudioActivityRun({
  expanded,
  item,
  onToggle,
}: {
  expanded: boolean;
  item: LaunchAgentActivityItem;
  onToggle: () => void;
}): ReactElement {
  const occurredAt = item.occurredAt ?? item.scheduledAt;
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
  secondary: number | null;
  secondaryLabel: string;
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
        <span>
          {secondary === null
            ? `No ${secondaryLabel} projection`
            : `${Math.round(secondary)}% ${secondaryLabel}`}
        </span>
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
