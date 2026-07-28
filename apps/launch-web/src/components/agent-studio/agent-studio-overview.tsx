import { type ReactElement, useState } from "react";

import type {
  LaunchAgentActivityItem,
  LaunchAgentAttentionItem,
  LaunchAgentHomeResponse,
  LaunchInterfaceSummary,
} from "../../../../../shared/contracts/launch.ts";
import type { AgentStudioPane } from "../../lib/agent-studio-route";
import { shouldShowAgentSetup } from "../../lib/agent-studio-state";
import type { LaunchNavigate } from "../../lib/navigation";
import { safeAttentionDestinationHref } from "../nebula/operator-agent-alerts";

interface AgentStudioOverviewProps {
  endpoint: string | null;
  favoriteInterfaceIds: readonly string[];
  home: LaunchAgentHomeResponse;
  interfaces: readonly LaunchInterfaceSummary[];
  onNavigate: LaunchNavigate;
  onOpenPane: (pane: AgentStudioPane, item?: string | null) => void;
}

export function AgentStudioOverview({
  endpoint,
  favoriteInterfaceIds,
  home,
  interfaces,
  onNavigate,
  onOpenPane,
}: AgentStudioOverviewProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const [interfacePage, setInterfacePage] = useState(0);
  const favoriteIds = new Set(favoriteInterfaceIds);
  const pinned = interfaces.filter((item) => favoriteIds.has(item.id));
  const interfacePageCount = Math.ceil(pinned.length / 2);
  const visibleInterfacePage = Math.min(
    interfacePage,
    Math.max(0, interfacePageCount - 1),
  );
  const visiblePinned = pinned.slice(
    visibleInterfacePage * 2,
    visibleInterfacePage * 2 + 2,
  );
  const attention = home.attention?.items ?? [];
  const operating = home.operatingSummary;
  const activity = home.activity?.recent.slice(0, 5) ?? [];
  const candidate = home.release.candidate;
  const candidatePresentation = candidate
    ? candidateSignal(candidate)
    : null;
  const showSetup = shouldShowAgentSetup(home);
  const agentCapacityNeedsReview = home.agentCapacity?.state === "low" ||
    home.agentCapacity?.state === "waiting";
  const accountCapacityNeedsReview = home.capacity?.state === "low" ||
    home.capacity?.state === "waiting";
  const needCount = (home.attention?.openCount ?? attention.length) +
    (candidate ? 1 : 0) +
    (agentCapacityNeedsReview ? 1 : 0) +
    (accountCapacityNeedsReview ? 1 : 0);
  const hasNeeds = attention.length > 0 ||
    Boolean(candidate) ||
    agentCapacityNeedsReview ||
    accountCapacityNeedsReview;
  const matureDescription = needCount === 0
    ? `What ${home.agent.name} is doing right now, and whether it needs anything from you.`
    : needCount === 1
    ? `What ${home.agent.name} is doing right now, and the thing it needs from you.`
    : needCount === 2
    ? `What ${home.agent.name} is doing right now, and the two things it needs from you.`
    : `What ${home.agent.name} is doing right now, and the ${needCount} things it needs from you.`;

  const copyEndpoint = async () => {
    if (!endpoint || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="agent-studio-screen agent-studio-overview">
      <StudioPageHeader
        description={showSetup
          ? "Four steps until this agent can work without you. It cannot reach anyone outside Galactic until they are done."
          : matureDescription}
        title={showSetup ? `Set up ${home.agent.name}` : "Overview"}
      />
      {!showSetup
        ? (
          <>
            <div className="agent-studio-status-plate">
              <section className="agent-studio-plate-cell interfaces">
                <div className="agent-studio-interface-heading">
                  <div className="agent-studio-cell-label">Interfaces</div>
                  {interfacePageCount > 1
                    ? (
                      <span>
                        <button
                          aria-label="Previous favorite Interfaces"
                          disabled={visibleInterfacePage === 0}
                          onClick={() =>
                            setInterfacePage((page) => Math.max(0, page - 1))}
                          type="button"
                        >
                          ↑
                        </button>
                        <button
                          aria-label="Next favorite Interfaces"
                          disabled={visibleInterfacePage >=
                            interfacePageCount - 1}
                          onClick={() =>
                            setInterfacePage((page) =>
                              Math.min(interfacePageCount - 1, page + 1)
                            )}
                          type="button"
                        >
                          ↓
                        </button>
                      </span>
                    )
                    : null}
                </div>
                <div className="agent-studio-interface-stack">
                  {visiblePinned.map((item) => (
                    <button
                      className="agent-studio-interface-tile"
                      key={item.id}
                      onClick={() => onOpenPane("interfaces", item.id)}
                      type="button"
                    >
                      <span>
                        <strong>{item.label}</strong>
                        <small>
                          {item.functions.length} function{
                            item.functions.length === 1 ? "" : "s"
                          }
                        </small>
                      </span>
                      <em>
                        {item.description ??
                          "Open this release-declared interface."}
                      </em>
                    </button>
                  ))}
                  {pinned.length === 0
                    ? (
                      <button
                        className="agent-studio-empty-tile"
                        onClick={() => onOpenPane("interfaces")}
                        type="button"
                      >
                        Pin an interface to keep it here.
                      </button>
                    )
                    : null}
                </div>
              </section>
              <section className="agent-studio-plate-cell now">
                <div className="agent-studio-cell-label">Right now</div>
                <div className="agent-studio-now-state">
                  <span
                    className={`agent-studio-dot${
                      operating?.readiness.working ? "" : " waiting"
                    }`}
                  />
                  <strong>{operating?.label ?? "Loading state"}</strong>
                </div>
                {operating?.detail
                  ? <p>{operating.detail}</p>
                  : null}
                <strong className="agent-studio-run-count">
                  {home.recentRuns.length} recent run{
                    home.recentRuns.length === 1 ? "" : "s"
                  }
                </strong>
                <p>
                  {home.state.nextRunAt
                    ? `Next event ${relativeTime(home.state.nextRunAt)}`
                    : "Waiting for the next declared event"}
                </p>
              </section>
              <section className="agent-studio-plate-cell consuming">
                <div className="agent-studio-cell-label">
                  What it is consuming
                </div>
                <ConsumptionMeter
                  capNote={galacticCapNote(home)}
                  label="Galactic pool"
                  percent={galacticUsagePercent(home)}
                  value={galacticUsageLabel(home)}
                />
                <ConsumptionMeter
                  capNote="Estimated inference cost is not available yet"
                  label="Inference, your key"
                  percent={null}
                  value="—"
                />
              </section>
            </div>

            {hasNeeds
              ? (
                <section className="agent-studio-overview-section">
                  <div className="agent-studio-section-label">Needs you</div>
                  <div className="agent-studio-needs-list">
                    {attention.slice(0, 3).map((item) => (
                      <AttentionRow
                        item={item}
                        key={item.id}
                        agent={home.agent}
                        onNavigate={onNavigate}
                        onOpenAlerts={() =>
                          onOpenPane("alerts", item.id)}
                      />
                    ))}
                    {candidate
                      ? (
                        <StudioSignalRow
                          action="Review"
                          detail={candidatePresentation?.detail ?? ""}
                          onOpen={() =>
                            onOpenPane(
                              "settings",
                              `release:${candidate.version}`,
                            )}
                          title={candidatePresentation?.title ?? ""}
                        />
                      )
                      : null}
                    {agentCapacityNeedsReview
                      ? (
                        <StudioSignalRow
                          action="Review"
                          detail="This Agent is close to, or waiting on, its Galactic capacity ceiling."
                          onOpen={() => onOpenPane("limits")}
                          title="Galactic capacity needs review"
                        />
                      )
                      : null}
                    {accountCapacityNeedsReview
                      ? (
                        <StudioSignalRow
                          action="Review"
                          detail="The shared Galactic account pool is close to, or waiting on, its current window."
                          onOpen={() => onOpenPane("limits")}
                          title="Shared Galactic pool needs review"
                        />
                      )
                      : null}
                  </div>
                </section>
              )
              : null}

            <section className="agent-studio-overview-section">
              <div className="agent-studio-section-head">
                <span className="agent-studio-section-label">
                  Latest actions
                </span>
                <button
                  className="agent-studio-text-action"
                  onClick={() => onOpenPane("activity")}
                  type="button"
                >
                  See all activity →
                </button>
              </div>
              <div className="agent-studio-ruled-list">
                {activity.map((item) => (
                  <ActivityRow item={item} key={item.id} />
                ))}
                {activity.length === 0
                  ? (
                    <div className="agent-studio-list-empty">
                      No completed work has been recorded yet.
                    </div>
                  )
                  : null}
              </div>
            </section>

            <section className="agent-studio-mission-card">
              <div className="agent-studio-section-head">
                <span className="agent-studio-section-label">Mission</span>
                <button
                  className="agent-studio-text-action"
                onClick={() => onOpenPane("directive")}
                type="button"
              >
                  Open source
                </button>
              </div>
              <p>
                {home.directive?.mission ||
                  home.responsibility.mission ||
                  "Define what this Agent should own."}
              </p>
              <button
                className="agent-studio-mission-meta"
                onClick={() => onOpenPane("directive")}
                type="button"
              >
                {home.directive?.source === "primary_routine"
                  ? "Defined by its primary routine →"
                  : "Derived from its managed routines →"}
              </button>
            </section>

            {endpoint
              ? (
                <section className="agent-studio-endpoint-card">
                  <div>
                    <div className="agent-studio-section-label">
                      Reachable by other systems at
                    </div>
                    <code>{endpoint}</code>
                  </div>
                  <button onClick={() => void copyEndpoint()} type="button">
                    {copied ? "Copied" : "Copy"}
                  </button>
                </section>
              )
              : null}
          </>
        )
        : (
          <AgentSetupPath
            home={home}
            onOpenPane={onOpenPane}
          />
        )}
    </section>
  );
}

export function StudioPageHeader({
  aside,
  description,
  title,
}: {
  aside?: ReactElement | null;
  description: string;
  title: string;
}): ReactElement {
  return (
    <header className="agent-studio-page-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {aside ?? null}
    </header>
  );
}

function ConsumptionMeter({
  capNote,
  label,
  percent,
  value,
}: {
  capNote: string;
  label: string;
  percent: number | null;
  value: string;
}): ReactElement {
  return (
    <div className="agent-studio-consumption">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div className="agent-studio-meter" aria-hidden="true">
        <span style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} />
      </div>
      <small>{capNote}</small>
    </div>
  );
}

function AttentionRow({
  agent,
  item,
  onNavigate,
  onOpenAlerts,
}: {
  agent: LaunchAgentHomeResponse["agent"];
  item: LaunchAgentAttentionItem;
  onNavigate: LaunchNavigate;
  onOpenAlerts: () => void;
}): ReactElement {
  const action = item.actions
    .map((candidate) => ({
      candidate,
      href: safeAttentionDestinationHref(candidate.destination, agent),
    }))
    .find(({ href }) => Boolean(href));
  const act = () => {
    if (action?.href) {
      onNavigate(action.href, { scroll: "preserve" });
    } else {
      onOpenAlerts();
    }
  };
  return (
    <article className="agent-studio-needs-row">
      <span aria-hidden="true" />
      <div>
        <strong>{item.brief.headline}</strong>
        <p>
          {item.brief.impact ??
            item.brief.context ??
            "Open this item to review what the Agent needs."}
        </p>
      </div>
      <button onClick={act} type="button">
        {action?.candidate.label ??
          (item.brief.requiresDecision ? "Review" : "Open")}
      </button>
    </article>
  );
}

function StudioSignalRow({
  action,
  detail,
  onOpen,
  title,
}: {
  action: string;
  detail: string;
  onOpen: () => void;
  title: string;
}): ReactElement {
  return (
    <article className="agent-studio-needs-row">
      <span aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      <button onClick={onOpen} type="button">{action}</button>
    </article>
  );
}

function ActivityRow({
  item,
}: {
  item: LaunchAgentActivityItem;
}): ReactElement {
  const date = item.occurredAt ?? item.scheduledAt;
  return (
    <div className="agent-studio-activity-summary-row">
      <time dateTime={date ?? undefined}>{shortTime(date)}</time>
      <span>
        <strong>{item.title}</strong>
        {item.summary ? <small>{item.summary}</small> : null}
      </span>
      <em data-status={item.status}>{item.status}</em>
    </div>
  );
}

function AgentSetupPath({
  home,
  onOpenPane,
}: {
  home: LaunchAgentHomeResponse;
  onOpenPane: (pane: AgentStudioPane, item?: string | null) => void;
}): ReactElement {
  const blockingSetting = home.setup.requirements.find((item) =>
    item.blocking && item.kind === "setting" && item.settingKey
  );
  const steps = [
    {
      complete: Boolean(home.release.live),
      description:
        "A tested release defines the Agent's functions, interfaces, and routines.",
      label: "Publish a live release",
      item: home.release.candidate
        ? `release:${home.release.candidate.version}`
        : null,
      pane: "settings" as const,
    },
    {
      complete: !home.setup.requirements.some((item) =>
        item.blocking && item.kind === "setting"
      ),
      description:
        "Set the credentials and destinations its release declares.",
      label: "Connect what it needs",
      item: blockingSetting?.settingKey
        ? `setting:${blockingSetting.settingKey}`
        : null,
      pane: "connections" as const,
    },
    {
      complete: Boolean(home.routines?.aggregate.total),
      description:
        "Give the Agent recurring work or an event it can respond to.",
      label: "Configure a routine",
      item: null,
      pane: "routines" as const,
    },
    {
      complete: home.setup.ready,
      description:
        "Review remaining authority and activate the Agent when it is ready.",
      label: "Review and activate",
      item: null,
      pane: "routines" as const,
    },
  ];
  const activeIndex = Math.max(
    0,
    steps.findIndex((step) => !step.complete),
  );
  return (
    <div className="agent-studio-setup">
      {steps.map((step, index) => {
        const active = index === activeIndex && !step.complete;
        return (
          <div className="agent-studio-setup-step" key={step.label}>
            <div className="agent-studio-setup-marker">
              <span className={step.complete ? "complete" : active ? "active" : ""}>
                {step.complete ? "✓" : index + 1}
              </span>
              {index < steps.length - 1 ? <i /> : null}
            </div>
            <div className={active ? "active" : ""}>
              <header>
                <strong>{step.label}</strong>
                <em>{step.complete ? "Complete" : active ? "Next" : "Waiting"}</em>
              </header>
              {active
                ? (
                  <>
                    <p>{step.description}</p>
                    <button
                      onClick={() => onOpenPane(step.pane, step.item)}
                      type="button"
                    >
                      Continue
                    </button>
                  </>
                )
                : null}
            </div>
          </div>
        );
      })}
      <p className="agent-studio-setup-note">
        Until setup is complete, the Agent only runs within its effective
        release and granted authority.
      </p>
    </div>
  );
}

export function galacticUsagePercent(
  home: LaunchAgentHomeResponse,
): number | null {
  const capacity = home.agentCapacity;
  if (!capacity) return null;
  return capacity.capPercent === null
    ? capacity.weekly.shareUsedPercent ?? null
    : capacity.weekly.capUsedPercent ?? null;
}

function galacticUsageLabel(home: LaunchAgentHomeResponse): string {
  const usage = galacticUsagePercent(home);
  return usage === null ? home.agentCapacity?.state ?? "—" : `${Math.round(usage)}%`;
}

function galacticCapNote(home: LaunchAgentHomeResponse): string {
  if (!home.agentCapacity) return "Capacity projection unavailable";
  const cap = home.agentCapacity?.capPercent;
  return cap === null
    ? "of the shared weekly Galactic pool"
    : `of this Agent's ${cap}% weekly ceiling`;
}

export function candidateSignal(
  candidate: NonNullable<LaunchAgentHomeResponse["release"]["candidate"]>,
): { detail: string; title: string } {
  if (candidate.reviewStatus === "unavailable") {
    return {
      detail:
        `Version ${candidate.version} is staged, but its review state is unavailable. Open Settings for diagnostics.`,
      title: "A staged release needs attention",
    };
  }
  if (!candidate.testedAt) {
    return {
      detail:
        `Version ${candidate.version} is staged without an available test timestamp. Review it before promotion.`,
      title: "A staged release needs review",
    };
  }
  if (
    candidate.reviewStatus === "owner_review_required" ||
    !candidate.canPromote
  ) {
    return {
      detail:
        `Version ${candidate.version} was tested and is waiting for owner review.`,
      title: "A staged release needs owner review",
    };
  }
  return {
    detail:
      `Version ${candidate.version} was tested and is ready for owner review.`,
    title: "A staged release is ready",
  };
}

function shortTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "at its scheduled time";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 90) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 90) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}
